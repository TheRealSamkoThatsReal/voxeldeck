'use strict';

/**
 * Fabric and Quilt mod-loader support for the singleplayer launcher.
 *
 * Both loaders publish a "meta" API that hands back a ready-to-use launcher
 * *profile* JSON (extra libraries + a replacement mainClass) for a given
 * Minecraft version and loader version. That's all a launcher needs — there's
 * no installer jar to run, which is exactly why these two were chosen. The
 * profile is merged over the vanilla version JSON by mojang.mergeLoaderProfile.
 *
 * Forge / NeoForge are intentionally not here: they require running a headless
 * installer and a more involved classpath transform.
 */

const UA = { 'User-Agent': 'VoxelDeck/1.0 (Minecraft launcher)' };

const LOADERS = {
  fabric: {
    id: 'fabric',
    label: 'Fabric',
    meta: 'https://meta.fabricmc.net/v2',
    // Quilt runs Fabric mods too, but each has its own loader runtime.
  },
  quilt: {
    id: 'quilt',
    label: 'Quilt',
    meta: 'https://meta.quiltmc.org/v3'
  }
};

function isLoader(id) {
  return id === 'fabric' || id === 'quilt';
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Loader meta request failed (HTTP ${res.status}).`);
  return res.json();
}

/** Minecraft versions this loader supports (stable releases), newest first. */
async function gameVersions(loader) {
  const def = LOADERS[loader];
  if (!def) throw new Error(`Unknown loader: ${loader}`);
  const list = await fetchJson(`${def.meta}/versions/game`);
  return list.filter((v) => v.stable).map((v) => v.version);
}

/** Loader (runtime) versions available for a Minecraft version, newest first. */
async function loaderVersions(loader, mcVersion) {
  const def = LOADERS[loader];
  if (!def) throw new Error(`Unknown loader: ${loader}`);
  const list = await fetchJson(`${def.meta}/versions/loader/${encodeURIComponent(mcVersion)}`);
  return list.map((entry) => ({
    version: entry.loader.version,
    stable: entry.loader.stable !== false
  }));
}

/** The newest stable loader version for a Minecraft version. */
async function latestLoader(loader, mcVersion) {
  const versions = await loaderVersions(loader, mcVersion);
  if (!versions.length) throw new Error(`No ${LOADERS[loader].label} build is available for Minecraft ${mcVersion}.`);
  return (versions.find((v) => v.stable) || versions[0]).version;
}

/**
 * The launcher profile JSON for a (loader, mcVersion, loaderVersion). Returns a
 * normalized object: { mainClass, libraries[], arguments? } ready to merge over
 * the vanilla version JSON. Quilt occasionally hands mainClass back as an
 * object keyed by side — collapse it to the client entry.
 */
async function profile(loader, mcVersion, loaderVersion) {
  const def = LOADERS[loader];
  if (!def) throw new Error(`Unknown loader: ${loader}`);
  const raw = await fetchJson(`${def.meta}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`);
  const mainClass = typeof raw.mainClass === 'object' ? (raw.mainClass.client || raw.mainClass.server) : raw.mainClass;
  return {
    id: raw.id,
    inheritsFrom: raw.inheritsFrom,
    mainClass,
    libraries: raw.libraries || [],
    arguments: raw.arguments || null
  };
}

module.exports = { LOADERS, isLoader, gameVersions, loaderVersions, latestLoader, profile };
