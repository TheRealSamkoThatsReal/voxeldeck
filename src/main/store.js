'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

/**
 * Lightweight JSON-file persistence for app settings and the list of
 * configured servers. Stored in Electron's per-user data directory so it
 * survives reinstalls and never lives inside a server folder.
 */

function configPath() {
  return path.join(app.getPath('userData'), 'servers.json');
}

const DEFAULT_DATA = {
  version: 1,
  settings: {
    // Optional global fallback path to a `java` binary. Per-server java
    // paths take precedence when set.
    javaPath: '',
    // UI accent color (hex). Drives all accent-colored elements.
    accentColor: '#3a88f7',
    // Parent directory under which new server folders are created. Empty =
    // use the runtime default (~/MinecraftServers).
    serversRoot: '',
    // Whether the first-run guided tour has been seen/dismissed.
    tourSeen: false
  },
  servers: []
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function readData() {
  const file = configPath();

  // 1) Read the raw bytes. Missing file = genuine first run (no warning).
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[store] Could not read config:', err.message);
    return clone(DEFAULT_DATA);
  }

  // 2) Parse. If the file exists but is corrupt, preserve it as a timestamped
  //    backup instead of silently discarding it — otherwise the next write
  //    would overwrite a file the user might still recover their servers from.
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_DATA, ...parsed, settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) } };
  } catch (err) {
    try {
      const backup = `${file}.corrupt-${Date.now()}`;
      // Move (not copy) so repeated reads during startup don't each spawn a
      // new backup — afterwards the live file is simply absent (clean default).
      fs.renameSync(file, backup);
      console.error(`[store] Config was unreadable (${err.message}). Moved it to:\n  ${backup}`);
    } catch (e) {
      console.error('[store] Config was unreadable and the backup also failed:', e.message);
    }
    return clone(DEFAULT_DATA);
  }
}

function writeData(data) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic-ish write: write to temp then rename to avoid truncation on crash.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Normalize a server config, filling defaults for any missing fields. */
function normalizeServer(server) {
  return {
    id: server.id || crypto.randomUUID(),
    name: server.name || 'New Server',
    directory: server.directory || '',
    jar: server.jar || '',
    // Server "software" type — informational + drives mods vs plugins folder.
    type: server.type || 'vanilla', // vanilla | paper | spigot | bukkit | purpur | forge | neoforge | fabric | quilt | other
    minRamMb: clampInt(server.minRamMb, 512, 1024),
    maxRamMb: clampInt(server.maxRamMb, 512, 2048),
    javaPath: server.javaPath || '',
    javaArgs: typeof server.javaArgs === 'string' ? server.javaArgs : '',
    // Extra args passed to the jar (after `-jar file`). `nogui` by default.
    serverArgs: typeof server.serverArgs === 'string' ? server.serverArgs : 'nogui',
    autoRestart: !!server.autoRestart,
    // Scheduled daily restart at a local-time HH:MM (24h). Only fires while the
    // server is running; players are warned in chat first.
    scheduledRestart: !!server.scheduledRestart,
    scheduledRestartTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(server.scheduledRestartTime)
      ? server.scheduledRestartTime
      : '04:00',
    createdAt: server.createdAt || Date.now()
  };
}

function clampInt(value, min, fallback) {
  const n = parseInt(value, 10);
  if (Number.isFinite(n) && n >= min) return n;
  return fallback;
}

module.exports = {
  configPath,
  readData,
  writeData,
  normalizeServer,
  newId: () => crypto.randomUUID()
};
