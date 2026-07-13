'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Worker } = require('worker_threads');

/**
 * Per-server backups. A backup is a single .zip of the whole server folder
 * (world, mods, configs — everything), stored under a backups root outside any
 * server folder so it survives a "delete server & files". The heavy zip/unzip
 * work happens in backupWorker.js (a worker thread) so the UI never freezes.
 *
 * Backup filenames encode a local timestamp and a type:
 *   backup-2026-07-13_04-30-00-manual.zip   ← made by hand
 *   backup-2026-07-13_04-30-00-auto.zip      ← scheduled or pre-restore safety
 * Only 'auto' backups are pruned by the retention limit; manual ones are kept
 * until the user deletes them.
 */

/** Default backups root: inside the app's user-data dir (never in a server). */
function defaultBackupsRoot(userDataDir) {
  return path.join(userDataDir, 'backups');
}

function serverBackupDir(root, serverId) {
  return path.join(root, String(serverId));
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** Local timestamp used in filenames (sortable, filesystem-safe). */
function stamp(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `_${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`;
}

function backupName(date, type) {
  return `backup-${stamp(date)}-${type === 'auto' ? 'auto' : 'manual'}.zip`;
}

/** Parse a backup filename into { name, type, createdAt } (null if not ours). */
function parseBackup(filename) {
  const m = /^backup-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(auto|manual)\.zip$/.exec(filename);
  if (!m) return null;
  const [, Y, Mo, Da, H, Mi, S, type] = m;
  const createdAt = new Date(+Y, +Mo - 1, +Da, +H, +Mi, +S).getTime();
  return { name: filename, type, createdAt };
}

/** List a server's backups, newest first, with sizes. */
async function list(root, serverId) {
  const dir = serverBackupDir(root, serverId);
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const meta = parseBackup(name);
    if (!meta) continue;
    let size = 0;
    try { size = (await fsp.stat(path.join(dir, name))).size; } catch { /* ignore */ }
    out.push({ ...meta, size });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Run the worker for one op, forwarding progress; resolves with its result. */
function runWorker(workerData, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'backupWorker.js'), { workerData });
    let result = null;
    worker.on('message', (m) => {
      if (m.phase === 'done') result = m;
      else if (m.phase === 'error') reject(new Error(m.message));
      else if (onProgress) onProgress(m);
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (result) resolve(result);
      else if (code !== 0) reject(new Error(`Backup task stopped unexpectedly (exit ${code}) — the server may be too large to archive in memory.`));
      else reject(new Error('Backup task ended without completing.'));
    });
  });
}

/** Create a backup zip of the server's folder. Returns its metadata. */
async function create(server, root, { type = 'manual', date = null, onProgress } = {}) {
  if (!server.directory || !fs.existsSync(server.directory)) {
    throw new Error('Server folder not found — set it in Settings first.');
  }
  const when = date || new Date();
  const dir = serverBackupDir(root, server.id);
  await fsp.mkdir(dir, { recursive: true });
  const name = backupName(when, type);
  const res = await runWorker({ op: 'create', sourceDir: server.directory, destFile: path.join(dir, name) }, onProgress);
  return { name, type, createdAt: when.getTime(), size: res.size, files: res.files };
}

/** Delete everything *inside* a directory, keeping the directory itself. */
async function emptyDir(dir) {
  for (const entry of await fsp.readdir(dir)) {
    await fsp.rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Restore a backup over the server's folder. Takes an automatic safety backup of
 * the current state first, then replaces the folder contents with the archive.
 * The caller must ensure the server is stopped.
 */
async function restore(server, root, name, { onProgress } = {}) {
  if (!parseBackup(name)) throw new Error('That isn’t a VoxelDeck backup file.');
  if (!server.directory) throw new Error('Server has no folder set.');
  const dir = serverBackupDir(root, server.id);
  const zipFile = path.join(dir, name);
  if (!fs.existsSync(zipFile)) throw new Error('That backup no longer exists.');
  // Refuse if backups live inside the server folder (emptyDir would wipe them).
  const resolvedDir = path.resolve(dir);
  const resolvedSrv = path.resolve(server.directory);
  if (resolvedDir === resolvedSrv || resolvedDir.startsWith(resolvedSrv + path.sep)) {
    throw new Error('Backups are stored inside the server folder — move the backups location in App settings first.');
  }

  // Safety net: snapshot the current state before overwriting it.
  if (onProgress) onProgress({ phase: 'safety' });
  await create(server, root, { type: 'auto' });

  await emptyDir(server.directory);
  await runWorker({ op: 'restore', zipFile, destDir: server.directory }, onProgress);
  return true;
}

async function remove(root, serverId, name) {
  if (!parseBackup(name)) throw new Error('Not a backup file.');
  await fsp.rm(path.join(serverBackupDir(root, serverId), name), { force: true });
  return true;
}

/** Keep the newest `keepN` auto-backups; delete older ones. Manual are untouched. */
async function prune(root, serverId, keepN) {
  const keep = parseInt(keepN, 10);
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const autos = (await list(root, serverId)).filter((b) => b.type === 'auto'); // newest first
  const doomed = autos.slice(keep);
  for (const b of doomed) {
    await fsp.rm(path.join(serverBackupDir(root, serverId), b.name), { force: true });
  }
  return doomed.map((b) => b.name);
}

module.exports = {
  defaultBackupsRoot, serverBackupDir, stamp, backupName, parseBackup,
  list, create, restore, remove, prune
};
