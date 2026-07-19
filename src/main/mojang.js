'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

/**
 * The vanilla Minecraft *client* pipeline for the singleplayer launcher.
 *
 * A real launcher needs far more than a server jar: for a given version it must
 * download the client jar, every library (honoring per-OS rules), the native
 * libraries (which are jars that get *extracted* next to the process), and the
 * asset objects, then assemble a JVM classpath + argument list from the
 * version's JSON. This module does all of that.
 *
 * Layout (a shared "launcher home", so multiple instances dedupe big files):
 *   <home>/versions/<id>/<id>.json     version manifest detail
 *   <home>/versions/<id>/<id>.jar      client jar
 *   <home>/libraries/<maven path>.jar  libraries (shared)
 *   <home>/assets/indexes/<id>.json    asset index
 *   <home>/assets/objects/<xx>/<hash>  asset objects (shared, content-addressed)
 *   <home>/natives/<id>/               extracted native libs for a version
 *
 * Per-instance save data (worlds, mods, config) lives elsewhere — see
 * launcherManager — and is passed to the client as --gameDir.
 *
 * The functions above `// ---- IO ----` are pure (no network / disk) so the
 * classpath + argument assembly can be unit-tested against captured JSON.
 */

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES = 'https://resources.download.minecraft.net';
const UA = { 'User-Agent': 'VoxelDeck/1.0 (Minecraft launcher)' };

// -------------------------------------------------------------------------
// Pure helpers (no IO) — safe to unit-test.
// -------------------------------------------------------------------------

/** Mojang's OS name for the current (or a given) platform. */
function osName(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'osx';
  return 'linux';
}

/** Mojang's arch token used in native classifiers ("${arch}" → 32/64). */
function osArchBits(arch = process.arch) {
  return arch === 'ia32' || arch === 'x86' ? '32' : '64';
}

/**
 * Evaluate a Mojang `rules` array. Rules are applied in order; the last one
 * that matches wins. No rules → allowed. `features` (demo, custom resolution)
 * are all treated as false, so feature-gated arguments are skipped.
 */
function rulesAllow(rules, { platform = process.platform, arch = process.arch, features = {} } = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!ruleMatches(rule, { platform, arch, features })) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

function ruleMatches(rule, { platform, arch, features }) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== osName(platform)) return false;
    if (rule.os.arch) {
      const want = rule.os.arch;
      const have = arch === 'arm64' ? 'arm64' : (arch === 'ia32' ? 'x86' : 'x86_64');
      if (want !== have && !(want === 'x86' && arch === 'ia32')) return false;
    }
    // rule.os.version (a regex on the OS version) is ignored — treated as match.
  }
  if (rule.features) {
    for (const [k, v] of Object.entries(rule.features)) {
      if (Boolean(features[k]) !== Boolean(v)) return false;
    }
  }
  return true;
}

/** Convert a maven coordinate (group:artifact:version[:classifier][@ext]) to a repo path. */
function mavenToPath(name) {
  let ext = 'jar';
  let coord = name;
  const at = coord.indexOf('@');
  if (at !== -1) { ext = coord.slice(at + 1); coord = coord.slice(0, at); }
  const parts = coord.split(':');
  const [group, artifact, version] = parts;
  const classifier = parts[3];
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

/** The "group:artifact" identity of a maven coord (used to dedupe the classpath). */
function mavenKey(name) {
  const p = name.split(':');
  return `${p[0]}:${p[1]}`;
}

/** True if a library entry is a native (extracted, not put on the classpath). */
function isNativeLibrary(lib, platform = process.platform) {
  if (lib.natives && lib.natives[osName(platform)]) return true;
  const cls = (lib.name || '').split(':')[3] || '';
  return cls.startsWith('natives-');
}

/**
 * Resolve which libraries apply for this platform, split into classpath jars
 * and native jars (to extract). Each entry: { name, path, url?, sha1?, size?, extractExclude? }.
 * `opts` carries platform/arch for testability.
 */
function resolveLibraries(libraries, opts = {}) {
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const classpath = [];
  const natives = [];
  const seen = new Set();
  for (const lib of libraries || []) {
    if (!rulesAllow(lib.rules, { platform, arch })) continue;

    // Old-style natives: a `natives` map choosing a classifier from `classifiers`.
    if (lib.natives && lib.natives[osName(platform)]) {
      const classifier = lib.natives[osName(platform)].replace('${arch}', osArchBits(arch));
      const art = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[classifier];
      if (art) {
        natives.push({ name: lib.name, path: art.path || mavenToPath(`${lib.name}:${classifier}`), url: art.url, sha1: art.sha1, size: art.size, extractExclude: (lib.extract && lib.extract.exclude) || ['META-INF/'] });
      }
      continue;
    }

    // New-style: a single downloads.artifact, or a bare maven name+url (loaders).
    const art = lib.downloads && lib.downloads.artifact;
    const p = (art && art.path) || (lib.name ? mavenToPath(lib.name) : null);
    if (!p) continue;
    const entry = {
      name: lib.name,
      path: p,
      url: (art && art.url) || (lib.url ? lib.url.replace(/\/?$/, '/') + p : null),
      sha1: art && art.sha1,
      size: art && art.size
    };
    if (isNativeLibrary(lib, platform)) {
      entry.extractExclude = (lib.extract && lib.extract.exclude) || ['META-INF/'];
      natives.push(entry);
    } else {
      const key = mavenKey(lib.name || p);
      if (seen.has(key)) continue; // first wins (loader libs are prepended by caller)
      seen.add(key);
      classpath.push(entry);
    }
  }
  return { classpath, natives };
}

/** Substitute ${...} placeholders in a launch argument. */
function substitute(arg, vars) {
  return arg.replace(/\$\{([^}]+)\}/g, (m, key) => (key in vars ? vars[key] : m));
}

/** Flatten a 1.13+ arguments array (strings + rule-gated objects) into strings. */
function flattenArgs(list, ctx) {
  const out = [];
  for (const a of list || []) {
    if (typeof a === 'string') { out.push(a); continue; }
    if (a && rulesAllow(a.rules, ctx)) {
      const val = Array.isArray(a.value) ? a.value : [a.value];
      out.push(...val);
    }
  }
  return out;
}

/**
 * Build the full spawn spec (jvm args → mainClass → game args) for a version.
 * Pure: everything comes from `merged` (the version JSON, already merged with any
 * loader profile) + the caller-supplied paths/account. Returns { args, mainClass }.
 *
 * `paths`: { clientJar, librariesDir, nativesDir, assetsDir, gameDir, libraries[] }
 * `account`: { name, uuid, accessToken, xuid?, userType? }
 * `opts`: { platform, arch, minRamMb, maxRamMb, extraJvmArgs[] }
 */
function buildLaunchSpec(merged, paths, account, opts = {}) {
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const ctx = { platform, arch, features: {} };

  const sep = platform === 'win32' ? ';' : ':';
  const cpEntries = [...paths.libraries.map((l) => path.join(paths.librariesDir, l.path)), paths.clientJar];
  const classpath = cpEntries.join(sep);

  const assetIndexId = (merged.assetIndex && merged.assetIndex.id) || merged.assets || 'legacy';
  const vars = {
    natives_directory: paths.nativesDir,
    launcher_name: 'VoxelDeck',
    launcher_version: opts.launcherVersion || '1.0',
    classpath,
    classpath_separator: sep,
    library_directory: paths.librariesDir,
    auth_player_name: account.name || 'Player',
    version_name: merged.id,
    game_directory: paths.gameDir,
    assets_root: paths.assetsDir,
    game_assets: paths.assetsDir,
    assets_index_name: assetIndexId,
    auth_uuid: account.uuid || '0'.repeat(32),
    auth_access_token: account.accessToken || '0',
    auth_session: account.accessToken || '0',
    auth_xuid: account.xuid || '',
    clientid: opts.clientId || '',
    user_type: account.userType || 'msa',
    version_type: merged.type || 'release',
    user_properties: '{}'
  };

  const args = [];
  // Memory + a stable natives path even for legacy versions.
  args.push(`-Xms${opts.minRamMb || 1024}M`, `-Xmx${opts.maxRamMb || 2048}M`);

  if (merged.arguments && Array.isArray(merged.arguments.jvm)) {
    args.push(...flattenArgs(merged.arguments.jvm, ctx).map((a) => substitute(a, vars)));
  } else {
    // Pre-1.13 versions have no jvm arguments block.
    args.push(`-Djava.library.path=${paths.nativesDir}`, '-cp', classpath);
  }
  for (const extra of opts.extraJvmArgs || []) args.push(extra);

  args.push(merged.mainClass);

  if (merged.arguments && Array.isArray(merged.arguments.game)) {
    args.push(...flattenArgs(merged.arguments.game, ctx).map((a) => substitute(a, vars)));
  } else if (typeof merged.minecraftArguments === 'string') {
    args.push(...merged.minecraftArguments.split(/\s+/).map((a) => substitute(a, vars)));
  }

  return { args, mainClass: merged.mainClass, classpath };
}

/**
 * Merge a loader profile (Fabric/Quilt) over a vanilla version JSON:
 * override mainClass, prepend loader libraries, append loader arguments.
 * `vanilla` and `loaderProfile` are both raw JSON objects.
 */
function mergeLoaderProfile(vanilla, loaderProfile) {
  if (!loaderProfile) return vanilla;
  const merged = { ...vanilla };
  merged.mainClass = loaderProfile.mainClass || vanilla.mainClass;
  // Loader libraries go first so their versions win in the dedupe.
  merged.libraries = [...(loaderProfile.libraries || []), ...(vanilla.libraries || [])];
  if (loaderProfile.arguments || vanilla.arguments) {
    merged.arguments = {
      jvm: [...((vanilla.arguments && vanilla.arguments.jvm) || []), ...((loaderProfile.arguments && loaderProfile.arguments.jvm) || [])],
      game: [...((vanilla.arguments && vanilla.arguments.game) || []), ...((loaderProfile.arguments && loaderProfile.arguments.game) || [])]
    };
  }
  return merged;
}

// -------------------------------------------------------------------------
// ---- IO ---- (network + disk)
// -------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

/** List downloadable Minecraft versions (releases first, then snapshots). */
async function listVersions() {
  const d = await fetchJson(MANIFEST_URL);
  const releases = d.versions.filter((v) => v.type === 'release').map((v) => ({ id: v.id, type: 'release' }));
  const snapshots = d.versions.filter((v) => v.type === 'snapshot').map((v) => ({ id: v.id, type: 'snapshot' }));
  return { latest: d.latest, releases, snapshots };
}

/** Fetch (and cache) a version's detail JSON into <home>/versions/<id>/<id>.json. */
async function ensureVersionJson(home, versionId) {
  const dir = path.join(home, 'versions', versionId);
  const file = path.join(dir, `${versionId}.json`);
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { /* fetch below */ }
  const manifest = await fetchJson(MANIFEST_URL);
  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`Minecraft version ${versionId} not found`);
  const detail = await fetchJson(entry.url);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, JSON.stringify(detail), 'utf8');
  return detail;
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Download a URL to dest (atomic via .part). Skips when a matching file exists. */
async function downloadTo(url, dest, { sha1, size } = {}) {
  if (!url) throw new Error(`No download URL for ${dest}`);
  try {
    const st = await fsp.stat(dest);
    if (sha1) { if ((await sha1File(dest)) === sha1) return false; }
    else if (!size || st.size === size) return false; // size match (or unknown) → trust it
  } catch { /* missing → download */ }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${url}`);
  const out = fs.createWriteStream(tmp);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await fsp.rename(tmp, dest);
  return true;
}

/** Run async tasks with bounded concurrency, reporting completed/total. */
async function pool(items, limit, worker, onTick) {
  let done = 0;
  const total = items.length;
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const my = idx++;
      await worker(items[my], my);
      done++;
      if (onTick) onTick(done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * Ensure every file needed to launch `merged` (a vanilla-or-loader-merged JSON)
 * is present under `home`, then extract natives. Returns the resolved paths +
 * library list used to build the classpath. onProgress gets { phase, done, total }.
 */
async function ensureFiles(home, merged, onProgress) {
  const librariesDir = path.join(home, 'libraries');
  const nativesDir = path.join(home, 'natives', merged.id);
  const assetsDir = path.join(home, 'assets');
  const clientJar = path.join(home, 'versions', merged.id, `${merged.id}.jar`);
  const report = (phase, done, total) => onProgress && onProgress({ phase, done, total });

  // 1) Client jar.
  report('client', 0, 1);
  if (merged.downloads && merged.downloads.client) {
    await downloadTo(merged.downloads.client.url, clientJar, { sha1: merged.downloads.client.sha1, size: merged.downloads.client.size });
  }
  report('client', 1, 1);

  // 2) Libraries + natives.
  const { classpath, natives } = resolveLibraries(merged.libraries);
  await fsp.mkdir(nativesDir, { recursive: true });
  const libTasks = [...classpath, ...natives];
  await pool(libTasks, 8, async (lib) => {
    const dest = path.join(librariesDir, lib.path);
    await downloadTo(lib.url, dest, { sha1: lib.sha1, size: lib.size });
  }, (d, t) => report('libraries', d, t));

  // Extract natives next to where the JVM will look (java.library.path).
  for (const nat of natives) {
    const jar = path.join(librariesDir, nat.path);
    try { extractNatives(jar, nativesDir, nat.extractExclude || ['META-INF/']); } catch { /* skip bad native jar */ }
  }

  // 3) Assets.
  if (merged.assetIndex) {
    const indexFile = path.join(assetsDir, 'indexes', `${merged.assetIndex.id}.json`);
    await downloadTo(merged.assetIndex.url, indexFile, { sha1: merged.assetIndex.sha1 });
    const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
    const objects = Object.values(index.objects || {});
    await pool(objects, 12, async (obj) => {
      const sub = obj.hash.slice(0, 2);
      const dest = path.join(assetsDir, 'objects', sub, obj.hash);
      await downloadTo(`${RESOURCES}/${sub}/${obj.hash}`, dest, { size: obj.size });
    }, (d, t) => report('assets', d, t));
  }

  return { clientJar, librariesDir, nativesDir, assetsDir, libraries: classpath };
}

/** Extract .so/.dll/.dylib (etc.) from a native jar into destDir, honoring excludes. */
function extractNatives(jarPath, destDir, exclude) {
  const zip = new AdmZip(jarPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if ((exclude || []).some((ex) => name.startsWith(ex))) continue;
    const out = path.join(destDir, path.basename(name));
    fs.writeFileSync(out, entry.getData());
  }
}

module.exports = {
  // pure
  osName, osArchBits, rulesAllow, mavenToPath, mavenKey, isNativeLibrary,
  resolveLibraries, substitute, flattenArgs, buildLaunchSpec, mergeLoaderProfile,
  // io
  listVersions, ensureVersionJson, ensureFiles, downloadTo,
  MANIFEST_URL
};
