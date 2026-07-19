'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

/**
 * Downloads a Java runtime (Eclipse Temurin / Adoptium) into the app's data
 * folder and returns the path to its `java` binary, so a server can use it
 * without a system-wide install. Used by the "Get latest Java" button.
 */

const UA = { 'User-Agent': 'VoxelDeck' };

/** Map Node's platform/arch to Adoptium's identifiers + archive type. */
function platformInfo() {
  const osMap = { linux: 'linux', win32: 'windows', darwin: 'mac' };
  const archMap = { x64: 'x64', arm64: 'aarch64', ia32: 'x86', ppc64: 'ppc64le' };
  return {
    os: osMap[process.platform] || null,
    arch: archMap[process.arch] || 'x64',
    ext: process.platform === 'win32' ? 'zip' : 'tar.gz',
    exe: process.platform === 'win32' ? 'java.exe' : 'java'
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

/** Newest feature release + newest LTS available from Adoptium. */
async function latestInfo() {
  const d = await fetchJson('https://api.adoptium.net/v3/info/available_releases');
  return {
    latest: d.most_recent_feature_release,
    lts: d.most_recent_lts,
    available: d.available_releases || []
  };
}

function runtimesDir() {
  return path.join(app.getPath('userData'), 'runtimes');
}

function binaryUrl(feature, os, arch) {
  return `https://api.adoptium.net/v3/binary/latest/${feature}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`;
}

/**
 * Download + extract the newest Java JRE for this OS/arch. Returns
 * { path, feature }. onProgress receives { phase:'download', received, total }
 * then { phase:'extract' }.
 */
/**
 * Download + extract a Java JRE. `wanted` is a feature number (e.g. 21) or
 * null/undefined for the newest. Multiple versions can coexist (handy for old
 * modpacks that need a specific Java). Returns { path, feature }.
 */
async function downloadVersion(wanted, onProgress) {
  const { os, arch, ext } = platformInfo();
  if (!os) throw new Error(`Automatic Java download isn’t supported on this platform (${process.platform}).`);

  const info = await latestInfo();
  // A specific request tries only that version; "newest" falls back to LTS.
  const candidates = wanted
    ? [parseInt(wanted, 10)]
    : [...new Set([info.latest, info.lts].filter(Boolean))];

  const dir = runtimesDir();
  await fsp.mkdir(dir, { recursive: true });
  const archive = path.join(dir, `jre-dl.${ext}`);

  let feature = null;
  let res = null;
  for (const f of candidates) {
    const r = await fetch(binaryUrl(f, os, arch), { headers: UA, redirect: 'follow' });
    if (r.ok && r.body) { res = r; feature = f; break; }
  }
  if (!res) throw new Error(`No Java ${wanted || ''} build is available for this system from Adoptium.`);

  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(archive);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress({ phase: 'download', received, total });
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(archive, { force: true });
    throw err;
  }

  if (onProgress) onProgress({ phase: 'extract' });
  await extract(archive, dir);
  await fsp.rm(archive, { force: true });

  // Prefer the runtime folder matching the version we just fetched.
  const javaPath = (await findJava(dir, feature)) || (await findJava(dir));
  if (!javaPath) throw new Error('Java downloaded, but the runtime couldn’t be located after extracting.');
  return { path: javaPath, feature };
}

/** Extract a .tar.gz or .zip with the system tar (GNU tar / bsdtar both work). */
function extract(archive, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xf', archive, '-C', dest], { stdio: 'ignore' });
    p.on('error', (e) => reject(new Error(`Could not run tar to unpack Java: ${e.message}`)));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking Java failed (tar exit ${code}).`))));
  });
}

/** Locate the java executable inside the extracted runtime folder(s).
 *  If `feature` is given, only consider folders for that version (jdk-<feature>…). */
async function findJava(dir, feature) {
  const { exe } = platformInfo();
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
  const featureRe = feature ? new RegExp(`^jdk-${feature}[.+]`) : null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (featureRe && !featureRe.test(e.name)) continue;
    const base = path.join(dir, e.name);
    for (const c of [path.join(base, 'bin', exe), path.join(base, 'Contents', 'Home', 'bin', exe)]) {
      if (fs.existsSync(c)) {
        if (process.platform !== 'win32') { try { fs.chmodSync(c, 0o755); } catch { /* ignore */ } }
        return c;
      }
    }
  }
  return null;
}

/**
 * Return a path to a `java` binary for the given feature version, reusing a
 * previously-downloaded runtime when one exists and only downloading if not.
 * Used by the singleplayer launcher so each Play doesn't re-fetch the JRE.
 */
async function ensureRuntime(feature, onProgress) {
  const existing = await findJava(runtimesDir(), feature);
  if (existing) return { path: existing, feature };
  return downloadVersion(feature, onProgress);
}

module.exports = { platformInfo, latestInfo, downloadVersion, binaryUrl, ensureRuntime };
