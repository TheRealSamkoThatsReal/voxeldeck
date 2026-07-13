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
    tourSeen: false,
    // Client Minecraft install used by the client-mod installer. Empty = use the
    // OS default (~/.minecraft, %APPDATA%\.minecraft, …), resolved at runtime.
    minecraftDir: '',
    // Where server backups are stored. Empty = <userData>/backups, resolved at
    // runtime. Kept outside server folders so backups survive deleting a server.
    backupsRoot: ''
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
const KNOWN_GAMES = new Set(['minecraft', 'terraria', 'valheim']);

function normalizeServer(server) {
  return {
    id: server.id || crypto.randomUUID(),
    name: server.name || 'New Server',
    // Which game this server runs. Existing servers (no `game`) are Minecraft.
    game: KNOWN_GAMES.has(server.game) ? server.game : 'minecraft',
    // Free-form per-game config (Terraria serverconfig fields, Valheim launch
    // args, …). Minecraft uses the dedicated fields below instead.
    gameConfig: (server.gameConfig && typeof server.gameConfig === 'object') ? server.gameConfig : {},
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
    // Scheduled daily backup (opt-in), at a local-time HH:MM. Independent of run
    // state — it snapshots the folder whether the server is up or not.
    scheduledBackup: !!server.scheduledBackup,
    scheduledBackupTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(server.scheduledBackupTime)
      ? server.scheduledBackupTime
      : '04:30',
    // How many automatic backups to keep (0 = keep all). Manual backups are
    // never auto-deleted.
    backupRetention: clampInt(server.backupRetention, 0, 10),
    // Client-side mod profile — the mods a player needs locally to join this
    // server. Each entry: { source:'modrinth'|'local', filename, title?, projectId?, versionNumber?, size? }.
    clientMods: normalizeClientMods(server.clientMods),
    createdAt: server.createdAt || Date.now()
  };
}

/** Keep only well-formed client-mod entries (each must at least name a file). */
function normalizeClientMods(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e || typeof e.filename !== 'string' || !e.filename) continue;
    if (seen.has(e.filename)) continue; // a mods folder can't hold two identically-named jars
    seen.add(e.filename);
    out.push({
      source: e.source === 'local' ? 'local' : 'modrinth',
      filename: e.filename,
      title: typeof e.title === 'string' ? e.title : e.filename,
      projectId: e.projectId || null,
      versionNumber: e.versionNumber || null,
      size: Number.isFinite(e.size) ? e.size : 0
    });
  }
  return out;
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
