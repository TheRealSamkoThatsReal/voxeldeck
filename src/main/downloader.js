'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Fetches server jars from official sources. Types with a clean public API can
 * be downloaded automatically; the rest expose an official download page link.
 *
 *   auto:  vanilla, paper, purpur, fabric
 *   link:  spigot, bukkit, forge, neoforge, quilt, other
 */

const AUTO_TYPES = ['vanilla', 'paper', 'purpur', 'fabric'];

// Official download / build pages used as a fallback (and always shown).
const DOWNLOAD_PAGES = {
  vanilla: 'https://www.minecraft.net/en-us/download/server',
  paper: 'https://papermc.io/downloads/paper',
  purpur: 'https://purpurmc.org/downloads',
  fabric: 'https://fabricmc.net/use/server/',
  spigot: 'https://www.spigotmc.org/wiki/buildtools/',
  bukkit: 'https://getbukkit.org/download/craftbukkit',
  forge: 'https://files.minecraftforge.net/net/minecraftforge/forge/',
  neoforge: 'https://neoforged.net/',
  quilt: 'https://quiltmc.org/en/install/server/',
  other: ''
};

const UA = { 'User-Agent': 'MinecraftServerDashboard/1.0 (+local)' };

function meta() {
  return { autoTypes: AUTO_TYPES, pages: DOWNLOAD_PAGES };
}

function canAutoDownload(type) {
  return AUTO_TYPES.includes(type);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

/** Available Minecraft versions for a type, newest first. */
async function listVersions(type) {
  if (type === 'paper') {
    // PaperMC's v2 API is deprecated and frozen — use the current v3 "fill" API,
    // which also lists newer Minecraft versions v2 never knew about.
    const d = await fetchJson('https://fill.papermc.io/v3/projects/paper');
    // d.versions: { "26.1": ["26.1.2","26.1.1"], "1.21": ["1.21.11", ...], ... }
    // groups and entries are both newest-first. Flatten, then hide pre-releases.
    const flat = [];
    for (const group of Object.values(d.versions || {})) for (const v of group) flat.push(v);
    return flat.filter((v) => !/-(rc|pre|snapshot|exp)/i.test(v));
  }
  if (type === 'purpur') {
    const d = await fetchJson('https://api.purpurmc.org/v2/purpur');
    return d.versions.slice().reverse();
  }
  if (type === 'fabric') {
    const d = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
    return d.filter((v) => v.stable).map((v) => v.version);
  }
  if (type === 'vanilla') {
    const d = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    return d.versions.filter((v) => v.type === 'release').map((v) => v.id);
  }
  throw new Error(`Automatic download isn’t available for “${type}”.`);
}

/** Resolve the concrete jar URL + filename for a type/version. */
async function resolveDownload(type, version) {
  if (type === 'paper') {
    const builds = await fetchJson(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds`);
    // v3 returns builds newest-first. Prefer the latest STABLE build.
    const build = builds.find((b) => String(b.channel).toUpperCase() === 'STABLE') || builds[0];
    if (!build) throw new Error(`No builds found for Paper ${version}`);
    const dl = build.downloads && build.downloads['server:default'];
    if (!dl || !dl.url) throw new Error(`No server jar published for Paper ${version} build ${build.id}`);
    return { url: dl.url, filename: dl.name };
  }
  if (type === 'purpur') {
    return {
      url: `https://api.purpurmc.org/v2/purpur/${version}/latest/download`,
      filename: `purpur-${version}.jar`
    };
  }
  if (type === 'vanilla') {
    const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const entry = manifest.versions.find((v) => v.id === version);
    if (!entry) throw new Error(`Version ${version} not found`);
    const detail = await fetchJson(entry.url);
    if (!detail.downloads || !detail.downloads.server) {
      throw new Error(`No server jar is published for ${version}`);
    }
    return { url: detail.downloads.server.url, filename: `minecraft_server.${version}.jar` };
  }
  if (type === 'fabric') {
    const loaders = await fetchJson('https://meta.fabricmc.net/v2/versions/loader');
    const loader = loaders.find((l) => l.stable) || loaders[0];
    const installers = await fetchJson('https://meta.fabricmc.net/v2/versions/installer');
    const installer = installers.find((i) => i.stable) || installers[0];
    return {
      url: `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader.version}/${installer.version}/server/jar`,
      filename: `fabric-server-mc.${version}-loader.${loader.version}-launcher.${installer.version}.jar`
    };
  }
  throw new Error(`Automatic download isn’t available for “${type}”.`);
}

/**
 * Download a server jar into destDir, streaming with progress callbacks.
 * Returns the filename written. Writes to a .part file then renames so a
 * failed/cancelled download never leaves a half-written jar in place.
 */
async function download(type, version, destDir, onProgress) {
  if (!version) throw new Error('Pick a version to download');
  const { url, filename } = await resolveDownload(type, version);

  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

  await fsp.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, filename);
  const tmp = `${dest}.part`;
  const total = Number(res.headers.get('content-length')) || 0;

  const out = fs.createWriteStream(tmp);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress({ received, total });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }

  if (received === 0) {
    await fsp.rm(tmp, { force: true });
    throw new Error('Download was empty');
  }
  await fsp.rename(tmp, dest);
  return filename;
}

module.exports = { meta, canAutoDownload, listVersions, resolveDownload, download, AUTO_TYPES, DOWNLOAD_PAGES };
