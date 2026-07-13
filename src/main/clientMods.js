'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const modrinth = require('./modrinth');
const files = require('./files');

/**
 * Client-side mod profiles.
 *
 * VoxelDeck manages a *server's* mods (in the server folder). This module manages
 * the mods a *player* needs on their own machine to actually join that modded
 * server — a per-server "client mod profile" — and installs it into the local
 * Minecraft.
 *
 * Flow (mirrors the server Mods tab: adding downloads immediately):
 *   - add:    download the mod into a per-server cache in userData, record it in
 *             the server's `clientMods` list.
 *   - apply:  copy the cached jars into a target Minecraft `mods` folder. Because
 *             everything is already cached, applying is offline and repeatable.
 *
 * Two apply targets:
 *   - 'isolated' (default, non-destructive): its own game directory under
 *     <minecraft>/voxeldeck-profiles/<name>/mods that VoxelDeck fully owns and
 *     keeps in exact sync with the profile. Point a launcher profile at it.
 *   - 'main': the real <minecraft>/mods. Anything already there is moved aside to
 *     a timestamped backup folder first, so it's a clean, reversible swap.
 */

/** The standard Minecraft install directory for this OS. */
function defaultMinecraftDir(platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, '.minecraft');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'minecraft');
  }
  return path.join(home, '.minecraft');
}

/** Where a server's downloaded client mods are cached (survives Apply). */
function cacheDir(userDataDir, serverId) {
  return path.join(userDataDir, 'client-profiles', String(serverId));
}

/** The two possible Minecraft `mods` folders a profile can be applied into. */
function targetDirs(minecraftDir, serverName) {
  const slug = files.sanitizeFolderName(serverName);
  return {
    isolated: path.join(minecraftDir, 'voxeldeck-profiles', slug, 'mods'),
    main: path.join(minecraftDir, 'mods')
  };
}

/** .jar files currently in a cache dir. */
async function cacheFiles(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && /\.jar$/i.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Download a Modrinth project's best client build into the cache. */
async function addFromModrinth(dir, projectId, type, gameVersion, onProgress) {
  const file = await modrinth.bestFile(projectId, type, gameVersion);
  await modrinth.downloadFile(file.url, file.filename, dir, onProgress);
  const size = await statSize(path.join(dir, file.filename));
  return {
    source: 'modrinth',
    filename: file.filename,
    projectId,
    versionNumber: file.versionNumber,
    gameVersions: file.gameVersions,
    size
  };
}

/** Copy a local .jar off disk into the cache. */
async function addLocal(dir, sourceAbsPath) {
  if (!/\.jar$/i.test(sourceAbsPath)) throw new Error('Only .jar files can be added.');
  if (!fs.existsSync(sourceAbsPath)) throw new Error('That file no longer exists.');
  await fsp.mkdir(dir, { recursive: true });
  const filename = path.basename(sourceAbsPath);
  await fsp.copyFile(sourceAbsPath, path.join(dir, filename));
  const size = await statSize(path.join(dir, filename));
  return { source: 'local', filename, size };
}

/** Remove a cached mod file (the caller drops it from the server's list). */
async function removeCached(dir, filename) {
  const base = path.basename(filename); // never let a name escape the cache
  await fsp.rm(path.join(dir, base), { force: true });
  return true;
}

/**
 * Make `targetModsDir` reflect the profile (a list of cached filenames).
 *
 *   own=true  → VoxelDeck owns the folder: any .jar not in the profile is
 *               removed, so the folder ends up exactly matching the profile.
 *   own=false → the user's own folder: if it already has .jars and a backup
 *               label is given, move them all aside first (clean swap).
 *
 * Returns a summary of what changed.
 */
async function applyProfile(dir, filenames, targetModsDir, { own = true, backupLabel = null } = {}) {
  // Verify the cache actually has everything before touching the target folder.
  for (const name of filenames) {
    if (!fs.existsSync(path.join(dir, name))) {
      throw new Error(`"${name}" isn’t downloaded anymore — remove and re-add it in the Client Mods tab.`);
    }
  }
  await fsp.mkdir(targetModsDir, { recursive: true });
  const wanted = new Set(filenames);
  const existing = (await fsp.readdir(targetModsDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.jar$/i.test(e.name))
    .map((e) => e.name);

  const result = { installed: [], removed: [], backedUp: [], backupDir: null, modsDir: targetModsDir };

  if (own) {
    for (const name of existing) {
      if (!wanted.has(name)) {
        await fsp.rm(path.join(targetModsDir, name), { force: true });
        result.removed.push(name);
      }
    }
  } else if (backupLabel && existing.length) {
    const backupDir = `${targetModsDir} (backup ${backupLabel})`;
    await fsp.mkdir(backupDir, { recursive: true });
    for (const name of existing) {
      await fsp.rename(path.join(targetModsDir, name), path.join(backupDir, name));
      result.backedUp.push(name);
    }
    result.backupDir = backupDir;
  }

  for (const name of filenames) {
    await fsp.copyFile(path.join(dir, name), path.join(targetModsDir, name));
    result.installed.push(name);
  }
  return result;
}

async function statSize(p) {
  try { return (await fsp.stat(p)).size; } catch { return 0; }
}

module.exports = {
  defaultMinecraftDir,
  cacheDir,
  targetDirs,
  cacheFiles,
  addFromModrinth,
  addLocal,
  removeCached,
  applyProfile
};
