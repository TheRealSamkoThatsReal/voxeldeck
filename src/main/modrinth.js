'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Search and download mods/plugins from Modrinth (https://modrinth.com) — a
 * free, open, no-API-key content host. (CurseForge would require a per-app API
 * key and has redistribution restrictions, so it isn't included.)
 */

const API = 'https://api.modrinth.com/v2';
const UA = { 'User-Agent': 'VoxelDeck/1.0 (Minecraft server dashboard)' };

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (res.status === 429) throw new Error('Modrinth is rate-limiting — wait a moment and try again.');
  if (!res.ok) throw new Error(`Modrinth request failed (HTTP ${res.status}).`);
  return res.json();
}

/**
 * Map a server type to a Modrinth project type + every loader it can actually
 * run (compatibility families). e.g. a Paper server also runs Spigot/Bukkit
 * plugins, Purpur runs Paper's, and Quilt runs Fabric mods. null = unsupported.
 */
function targetFor(type) {
  const families = {
    bukkit: { projectType: 'plugin', loaders: ['bukkit'], label: 'plugins' },
    spigot: { projectType: 'plugin', loaders: ['spigot', 'bukkit'], label: 'plugins' },
    paper: { projectType: 'plugin', loaders: ['paper', 'spigot', 'bukkit'], label: 'plugins' },
    purpur: { projectType: 'plugin', loaders: ['purpur', 'paper', 'spigot', 'bukkit'], label: 'plugins' },
    fabric: { projectType: 'mod', loaders: ['fabric'], label: 'mods' },
    quilt: { projectType: 'mod', loaders: ['quilt', 'fabric'], label: 'mods' },
    forge: { projectType: 'mod', loaders: ['forge'], label: 'mods' },
    neoforge: { projectType: 'mod', loaders: ['neoforge'], label: 'mods' }
  };
  return families[type] || null;
}

/** Best-effort Minecraft version from a server jar name (paper-1.21.4-232.jar → 1.21.4). */
function detectGameVersion(jar) {
  if (!jar) return null;
  const m = String(jar).match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/**
 * Search Modrinth, scoped to the server's loader (+ optionally a game version).
 * `clientSide` biases results to mods that run on the client (for the client
 * mod profile browser) by excluding server-only projects.
 */
async function search({ query = '', type, gameVersion = null, clientSide = false, limit = 24 }) {
  const target = targetFor(type);
  if (!target) throw new Error('Browsing isn’t available for this server type — switch to Paper, Fabric, Forge, etc.');
  // project_type:X  AND  (categories:loader1 OR loader2 OR …)  [AND versions:gv]
  const facets = [[`project_type:${target.projectType}`], target.loaders.map((l) => `categories:${l}`)];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  // client_side ∈ {required, optional} ⇒ the mod runs client-side (drops server-only mods).
  if (clientSide) facets.push(['client_side:required', 'client_side:optional']);
  const params = new URLSearchParams();
  if (query.trim()) params.set('query', query.trim());
  params.set('limit', String(limit));
  params.set('facets', JSON.stringify(facets));
  const data = await getJson(`${API}/search?${params.toString()}`);
  return {
    label: target.label,
    hits: (data.hits || []).map((h) => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      icon: h.icon_url || '',
      versions: h.versions ? h.versions.slice(-3) : []
    }))
  };
}

/** Find the newest file for a project compatible with the server's loader. */
async function bestFile(projectId, type, gameVersion = null) {
  const target = targetFor(type);
  if (!target) throw new Error('Unsupported server type.');
  const params = new URLSearchParams();
  params.set('loaders', JSON.stringify(target.loaders));
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
  let versions = await getJson(`${API}/project/${projectId}/version?${params.toString()}`);
  if (!versions.length) {
    throw new Error(gameVersion
      ? `No build for Minecraft ${gameVersion} — turn off the version filter to see other builds.`
      : 'No build of this is available for your server type yet.');
  }
  versions.sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
  const v = versions[0];
  const file = v.files.find((f) => f.primary) || v.files[0];
  if (!file) throw new Error('That version has no downloadable file.');
  return { url: file.url, filename: file.filename, versionNumber: v.version_number, gameVersions: v.game_versions || [] };
}

/** Download a file into destDir, streaming with progress. */
async function downloadFile(url, filename, destDir, onProgress) {
  await fsp.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, filename);
  const tmp = `${dest}.part`;
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
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
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await fsp.rename(tmp, dest);
  return filename;
}

module.exports = { targetFor, detectGameVersion, search, bestFile, downloadFile };
