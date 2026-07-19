'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const store = require('./store');
const files = require('./files');
const utils = require('./serverUtils');
const serverManager = require('./serverManager');
const downloader = require('./downloader');
const network = require('./network');
const javaManager = require('./javaManager');
const modrinth = require('./modrinth');
const clientMods = require('./clientMods');
const backups = require('./backups');
const scheduler = require('./scheduler');
const games = require('./games');
const gameInstaller = require('./gameInstaller');
const updater = require('./updater');
const launcherManager = require('./launcherManager');
const mojang = require('./mojang');
const loaders = require('./loaders');
const msauth = require('./msauth');

// Pin the app name so the config folder (app.getPath('userData')) is identical
// whether the app is run from source (`npm start`) or from a packaged build —
// otherwise a packaged install could read a different folder and "lose" servers.
app.setName('voxeldeck');

/** One-time migration: carry config over from the app's previous name. */
function migrateLegacyConfig() {
  try {
    const dest = path.join(app.getPath('userData'), 'servers.json');
    if (fs.existsSync(dest)) return;
    const legacy = path.join(app.getPath('appData'), 'minecraft-server-dashboard', 'servers.json');
    if (fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(legacy, dest);
      console.log('[migrate] imported config from the previous app name');
    }
  } catch (err) {
    console.error('[migrate] could not import legacy config:', err.message);
  }
}

let mainWindow = null;

const isDev = process.argv.includes('--dev');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0e1116',
    title: 'VoxelDeck',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---- Forward serverManager events to the renderer --------------------------

function wireManagerEvents() {
  const forward = (channel) => (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  };
  serverManager.on('state', forward('server:state'));
  serverManager.on('log', forward('server:log'));
  serverManager.on('stats', forward('server:stats'));
  launcherManager.on('state', forward('launcher:state'));
  launcherManager.on('log', forward('launcher:log'));
  launcherManager.on('progress', forward('launcher:progress'));
}

// ---- Helpers ---------------------------------------------------------------

function getServerOrThrow(id) {
  const data = store.readData();
  const server = data.servers.find((s) => s.id === id);
  if (!server) throw new Error('Server not found');
  return { data, server };
}

/** Add (or replace by filename) a client-mod entry on a server and persist. */
function upsertClientMod(data, id, entry) {
  const idx = data.servers.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error('Server not found');
  const current = (data.servers[idx].clientMods || []).filter((e) => e.filename !== entry.filename);
  data.servers[idx] = store.normalizeServer({
    ...data.servers[idx], clientMods: [...current, entry], id
  });
  store.writeData(data);
  return entry;
}

function wrap(handler) {
  // Standardize IPC responses to { ok, data } | { ok:false, error }.
  return async (_event, ...args) => {
    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (err) {
      console.error('[ipc] error:', err);
      return { ok: false, error: err.message || String(err) };
    }
  };
}

// ---- IPC: app / system -----------------------------------------------------

function registerIpc() {
  ipcMain.handle('app:info', wrap(async () => ({
    totalRamMb: Math.round(os.totalmem() / 1048576),
    freeRamMb: Math.round(os.freemem() / 1048576),
    platform: process.platform,
    appVersion: app.getVersion(),
    userData: app.getPath('userData'),
    homeDir: os.homedir(),
    // Default parent folder for newly-created servers.
    defaultServersRoot: path.join(os.homedir(), 'MinecraftServers')
  })));

  ipcMain.handle('app:detectJava', wrap(async (javaPath) => utils.detectJava(javaPath)));

  // ---- Automatic Java runtime download (Adoptium / Temurin) ----
  ipcMain.handle('java:latest', wrap(async () => javaManager.latestInfo()));
  // Download a Java version (feature number, or null for newest). Returns the
  // path + detected version; the renderer decides whether it's the app default
  // or a single server's Java.
  ipcMain.handle('java:download', wrap(async (feature) => {
    const result = await javaManager.downloadVersion(feature || null, (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('java:progress', p);
    });
    const det = await utils.detectJava(result.path);
    return { path: result.path, feature: result.feature, version: det.ok ? det.version : `Java ${result.feature}` };
  }));

  // ---- Mod / plugin browser (Modrinth) ----
  ipcMain.handle('modrinth:search', wrap(async (id, query, matchVersion) => {
    const { server } = getServerOrThrow(id);
    const gameVersion = modrinth.detectGameVersion(server.jar);
    const data = await modrinth.search({ query, type: server.type, gameVersion: matchVersion ? gameVersion : null });
    return { ...data, gameVersion }; // always report the detected version for the toggle label
  }));
  ipcMain.handle('modrinth:install', wrap(async (id, projectId, matchVersion) => {
    const { server } = getServerOrThrow(id);
    if (!server.directory) throw new Error('Set a server folder first.');
    const target = modrinth.targetFor(server.type);
    if (!target) throw new Error('This server type doesn’t support mods/plugins.');
    const gameVersion = matchVersion ? modrinth.detectGameVersion(server.jar) : null;
    const file = await modrinth.bestFile(projectId, server.type, gameVersion);
    const destDir = path.join(server.directory, target.label === 'plugins' ? 'plugins' : 'mods');
    const filename = await modrinth.downloadFile(file.url, file.filename, destDir, (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('modrinth:progress', { projectId, ...p });
    });
    return { filename, versionNumber: file.versionNumber, gameVersions: file.gameVersions };
  }));

  ipcMain.handle('app:openExternal', wrap(async (url) => { await shell.openExternal(url); return true; }));

  ipcMain.handle('app:copy', wrap(async (text) => { clipboard.writeText(String(text)); return true; }));

  // ---- Auto-update ----
  ipcMain.handle('update:check', wrap(async () => updater.check()));
  ipcMain.handle('update:install', wrap(async () => { updater.quitAndInstall(); return true; }));
  ipcMain.handle('update:supported', wrap(async () => updater.isSupported()));

  // ---- Network / connection info ----
  ipcMain.handle('net:addresses', wrap(async (id) => {
    const { server } = getServerOrThrow(id);
    const game = games.get(server.game);
    let port = game.defaultPort || 25565;
    try {
      if (server.game === 'minecraft' && server.directory) {
        const props = await utils.readProperties(server.directory);
        const p = props.entries.find((e) => e.key === 'server-port');
        if (p && /^\d+$/.test(p.value.trim())) port = parseInt(p.value.trim(), 10);
      } else if (server.gameConfig && /^\d+$/.test(String(server.gameConfig.port || ''))) {
        port = parseInt(server.gameConfig.port, 10);
      }
    } catch { /* default port */ }
    const local = network.primaryLocalIPv4();
    return { local, allLocal: network.localIPv4s(), gateway: network.likelyGateway(local), port };
  }));

  ipcMain.handle('net:public', wrap(async () => network.publicIP()));

  ipcMain.handle('app:openPath', wrap(async (p) => { await shell.openPath(p); return true; }));

  // ---- Settings ----
  ipcMain.handle('settings:get', wrap(async () => store.readData().settings));
  ipcMain.handle('settings:set', wrap(async (patch) => {
    const data = store.readData();
    data.settings = { ...data.settings, ...patch };
    store.writeData(data);
    return data.settings;
  }));

  // ---- Servers CRUD ----
  ipcMain.handle('servers:list', wrap(async () => {
    const data = store.readData();
    return data.servers.map((s) => ({
      ...s,
      state: serverManager.getState(s.id),
      stats: serverManager.getStats(s.id)
    }));
  }));

  ipcMain.handle('servers:create', wrap(async (partial) => {
    const data = store.readData();
    const server = store.normalizeServer({ ...partial, id: store.newId() });
    data.servers.push(server);
    store.writeData(data);
    return server;
  }));

  // Create a server AND scaffold its folder on disk (mkdir, copy jar, make the
  // plugins/ or mods/ folder), then persist it.
  ipcMain.handle('servers:setup', wrap(async (opts) => {
    const { name, game = 'minecraft', type = 'vanilla', parentDir, jarSource, gameConfig } = opts || {};
    const data = store.readData();
    const root = parentDir || data.settings.serversRoot || path.join(os.homedir(), 'MinecraftServers');
    // For Minecraft we pre-make the plugins/ or mods/ folder and copy any jar.
    // Native games (Terraria/Valheim) get an empty folder; their installer fills it.
    let directory, jar = '';
    if (game === 'minecraft') {
      const cf = utils.contentFolder(type);
      const contentDir = cf.vanilla ? null : cf.dir;
      ({ directory, jar } = await files.setupServerFolder(root, name, jarSource || '', contentDir));
    } else {
      ({ directory } = await files.setupServerFolder(root, name, '', null));
    }
    const server = store.normalizeServer({
      id: store.newId(), name, game, type, directory, jar, gameConfig: gameConfig || {}
    });
    data.servers.push(server);
    store.writeData(data);
    return server;
  }));

  ipcMain.handle('servers:update', wrap(async (id, patch) => {
    const data = store.readData();
    const idx = data.servers.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('Server not found');
    const merged = store.normalizeServer({ ...data.servers[idx], ...patch, id });
    data.servers[idx] = merged;
    store.writeData(data);
    // Native games with a generated config file (Terraria's serverconfig.txt)
    // need it rewritten whenever their settings change.
    if (merged.directory && typeof games.get(merged.game).configFile === 'function') {
      try { await gameInstaller.writeGameConfigFile(merged); } catch { /* non-fatal */ }
    }
    return merged;
  }));

  ipcMain.handle('servers:delete', wrap(async (id, deleteFiles) => {
    if (serverManager.isRunning(id)) throw new Error('Stop the server before deleting it');
    const data = store.readData();
    const server = data.servers.find((s) => s.id === id);
    // Wipe the folder from disk FIRST (when asked) so we never drop the config
    // entry while leaving orphaned files we can no longer point a UI at.
    if (deleteFiles && server && server.directory) {
      await files.deleteDir(server.directory);
    }
    data.servers = data.servers.filter((s) => s.id !== id);
    store.writeData(data);
    return true;
  }));

  // ---- Lifecycle ----
  ipcMain.handle('servers:start', wrap(async (id) => {
    const { data, server } = getServerOrThrow(id);
    return serverManager.start(server, data.settings.javaPath);
  }));

  ipcMain.handle('servers:stop', wrap(async (id, opts) => serverManager.stop(id, opts || {})));

  ipcMain.handle('servers:command', wrap(async (id, command) => {
    serverManager.sendCommand(id, command);
    return true;
  }));

  ipcMain.handle('servers:state', wrap(async (id) => ({
    state: serverManager.getState(id),
    stats: serverManager.getStats(id)
  })));

  ipcMain.handle('servers:logBuffer', wrap(async (id) => serverManager.getLogBuffer(id)));

  // ---- File system (scoped to server dir) ----
  function dirFor(id) {
    const { server } = getServerOrThrow(id);
    if (!server.directory) throw new Error('Server has no directory set');
    return server.directory;
  }

  ipcMain.handle('files:list', wrap(async (id, rel) => files.listDir(dirFor(id), rel)));
  ipcMain.handle('files:read', wrap(async (id, rel) => files.readFileText(dirFor(id), rel)));
  ipcMain.handle('files:write', wrap(async (id, rel, content) => files.writeFileText(dirFor(id), rel, content)));
  ipcMain.handle('files:mkdir', wrap(async (id, rel) => files.createDir(dirFor(id), rel)));
  ipcMain.handle('files:touch', wrap(async (id, rel) => files.createFile(dirFor(id), rel)));
  ipcMain.handle('files:remove', wrap(async (id, rel) => files.remove(dirFor(id), rel)));
  ipcMain.handle('files:rename', wrap(async (id, rel, newName) => files.rename(dirFor(id), rel, newName)));
  ipcMain.handle('files:listJars', wrap(async (id) => files.listJars(dirFor(id))));

  ipcMain.handle('files:import', wrap(async (id, relDir) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import file(s) into server',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return [];
    const dir = dirFor(id);
    const imported = [];
    for (const src of result.filePaths) {
      imported.push(await files.importFile(dir, relDir || '.', src));
    }
    return imported;
  }));

  // ---- server.properties ----
  ipcMain.handle('props:read', wrap(async (id) => utils.readProperties(dirFor(id))));
  ipcMain.handle('props:write', wrap(async (id, updates) => utils.writeProperties(dirFor(id), updates)));

  // ---- EULA ----
  ipcMain.handle('eula:get', wrap(async (id) => utils.getEula(dirFor(id))));
  ipcMain.handle('eula:set', wrap(async (id, accepted) => utils.setEula(dirFor(id), accepted)));

  // ---- Players ----
  ipcMain.handle('players:list', wrap(async (id) => {
    const { server } = getServerOrThrow(id);
    const online = serverManager.getPlayerNames(id);
    const ops = server.directory ? await utils.readOps(server.directory) : [];
    return { online, ops, running: serverManager.getState(id) === 'running' };
  }));

  // Ask the running server to re-report its player list (parsed from output).
  ipcMain.handle('players:refresh', wrap(async (id) => {
    if (serverManager.getState(id) === 'running') serverManager.sendCommand(id, 'list');
    return true;
  }));

  // ---- mods / plugins ----
  ipcMain.handle('content:list', wrap(async (id) => {
    const { server } = getServerOrThrow(id);
    return utils.listContent(server.directory, server.type);
  }));
  ipcMain.handle('content:toggle', wrap(async (id, name, enable) => {
    const { server } = getServerOrThrow(id);
    return utils.toggleContent(server.directory, server.type, name, enable);
  }));
  ipcMain.handle('content:remove', wrap(async (id, name) => {
    const { server } = getServerOrThrow(id);
    return utils.removeContent(server.directory, server.type, name);
  }));
  ipcMain.handle('content:add', wrap(async (id) => {
    const { server } = getServerOrThrow(id);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add mods / plugins (.jar)',
      filters: [{ name: 'Java Archive', extensions: ['jar'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return [];
    const added = [];
    for (const src of result.filePaths) {
      added.push(await utils.addContent(server.directory, server.type, src));
    }
    return added;
  }));

  // ---- Client-side mod profiles ----
  // The folder where a server's client mods are cached (downloaded once, then
  // copied into a Minecraft install on "Apply").
  function clientCacheDir(id) {
    return clientMods.cacheDir(app.getPath('userData'), id);
  }
  // The client Minecraft directory (user override, else the OS default).
  function minecraftDir() {
    const custom = (store.readData().settings.minecraftDir || '').trim();
    return custom || clientMods.defaultMinecraftDir();
  }

  ipcMain.handle('clientmods:list', wrap(async (id) => {
    const { server } = getServerOrThrow(id);
    const mcDir = minecraftDir();
    const targets = clientMods.targetDirs(mcDir, server.name);
    const cached = new Set(await clientMods.cacheFiles(clientCacheDir(id)));
    // Flag any entry whose downloaded file went missing so the UI can warn.
    const entries = (server.clientMods || []).map((e) => ({ ...e, cached: cached.has(e.filename) }));
    return { entries, minecraftDir: mcDir, minecraftExists: fs.existsSync(mcDir), targets };
  }));

  ipcMain.handle('clientmods:search', wrap(async (id, query, matchVersion, loader) => {
    const { server } = getServerOrThrow(id);
    const gameVersion = modrinth.detectGameVersion(server.jar);
    const useLoader = loader || modrinth.defaultClientLoader(server.type);
    const data = await modrinth.searchClient({ query, loader: useLoader, gameVersion: matchVersion ? gameVersion : null });
    return { ...data, gameVersion };
  }));

  ipcMain.handle('clientmods:add', wrap(async (id, projectId, matchVersion, loader) => {
    const { data, server } = getServerOrThrow(id);
    const useLoader = loader || modrinth.defaultClientLoader(server.type);
    const gameVersion = matchVersion ? modrinth.detectGameVersion(server.jar) : null;
    const entry = await clientMods.addFromModrinth(clientCacheDir(id), projectId, useLoader, gameVersion, (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('clientmods:progress', { id, projectId, ...p });
    });
    return upsertClientMod(data, id, entry);
  }));

  ipcMain.handle('clientmods:addLocal', wrap(async (id) => {
    const { data } = getServerOrThrow(id);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add client mods (.jar)',
      filters: [{ name: 'Java Archive', extensions: ['jar'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return [];
    const added = [];
    for (const src of result.filePaths) {
      const entry = await clientMods.addLocal(clientCacheDir(id), src);
      upsertClientMod(data, id, entry);
      added.push(entry.filename);
    }
    return added;
  }));

  ipcMain.handle('clientmods:remove', wrap(async (id, filename) => {
    const { data, server } = getServerOrThrow(id);
    await clientMods.removeCached(clientCacheDir(id), filename);
    const idx = data.servers.findIndex((s) => s.id === id);
    data.servers[idx] = store.normalizeServer({
      ...server, clientMods: (server.clientMods || []).filter((e) => e.filename !== filename), id
    });
    store.writeData(data);
    return true;
  }));

  ipcMain.handle('clientmods:apply', wrap(async (id, target) => {
    const { server } = getServerOrThrow(id);
    const list = server.clientMods || [];
    if (!list.length) throw new Error('This server has no client mods yet — add some first.');
    const targets = clientMods.targetDirs(minecraftDir(), server.name);
    const isMain = target === 'main';
    const modsDir = isMain ? targets.main : targets.isolated;
    const backupLabel = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-');
    return clientMods.applyProfile(clientCacheDir(id), list.map((e) => e.filename), modsDir, {
      own: !isMain,               // we fully manage the isolated folder; only back up the user's real one
      backupLabel: isMain ? backupLabel : null
    });
  }));

  // ---- Backups ----
  function backupsRoot() {
    const custom = (store.readData().settings.backupsRoot || '').trim();
    return custom || backups.defaultBackupsRoot(app.getPath('userData'));
  }
  // Ask a running Minecraft server to flush its world to disk before archiving,
  // so the backup captures a consistent save.
  async function flushSaves(server) {
    if (server.game === 'minecraft' && serverManager.getState(server.id) === 'running') {
      try {
        serverManager.sendCommand(server.id, 'save-all flush');
        await new Promise((r) => setTimeout(r, 1500));
      } catch { /* not writable — archive as-is */ }
    }
  }
  const backupProgress = (id) => (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('backups:progress', { id, ...p });
  };

  ipcMain.handle('backups:list', wrap(async (id) => {
    const { server } = getServerOrThrow(id);
    const root = backupsRoot();
    return { dir: backups.serverBackupDir(root, id), entries: await backups.list(root, id), running: serverManager.isRunning(id) };
  }));

  ipcMain.handle('backups:create', wrap(async (id) => {
    const { server } = getServerOrThrow(id);
    const root = backupsRoot();
    await flushSaves(server);
    const meta = await backups.create(server, root, { type: 'manual', onProgress: backupProgress(id) });
    await backups.prune(root, id, server.backupRetention); // keep the auto-safety pile bounded
    return meta;
  }));

  ipcMain.handle('backups:restore', wrap(async (id, name) => {
    const { server } = getServerOrThrow(id);
    if (serverManager.isRunning(id)) throw new Error('Stop the server before restoring a backup.');
    const root = backupsRoot();
    await backups.restore(server, root, name, { onProgress: backupProgress(id) });
    await backups.prune(root, id, server.backupRetention);
    return true;
  }));

  ipcMain.handle('backups:remove', wrap(async (id, name) => {
    getServerOrThrow(id);
    return backups.remove(backupsRoot(), id, name);
  }));

  ipcMain.handle('backups:reveal', wrap(async (id) => {
    getServerOrThrow(id);
    const dir = backups.serverBackupDir(backupsRoot(), id);
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  }));

  // ---- Server jar download ----
  // ---- Games ----
  ipcMain.handle('games:catalog', wrap(async () => games.catalog()));

  // Install/scaffold a non-Minecraft game's server files (Terraria zip, Valheim
  // via SteamCMD), streaming progress to the renderer.
  ipcMain.handle('game:install', wrap(async (id) => {
    const { server } = getServerOrThrow(id);
    if (serverManager.isRunning(id)) throw new Error('Stop the server before reinstalling it.');
    const patch = await gameInstaller.install(server, (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('game:progress', { id, ...p });
      }
    });
    // Persist any installer-reported config (e.g. the resolved binary name).
    if (patch && Object.keys(patch).length) {
      const data = store.readData();
      const idx = data.servers.findIndex((s) => s.id === id);
      if (idx !== -1) {
        data.servers[idx] = store.normalizeServer({
          ...data.servers[idx], gameConfig: { ...data.servers[idx].gameConfig, ...patch }, id
        });
        store.writeData(data);
      }
    }
    return true;
  }));

  ipcMain.handle('jar:meta', wrap(async () => downloader.meta()));
  ipcMain.handle('jar:versions', wrap(async (type) => downloader.listVersions(type)));
  ipcMain.handle('jar:download', wrap(async (id, version) => {
    const { server } = getServerOrThrow(id);
    if (!server.directory) throw new Error('Set a server folder first (Settings).');
    if (serverManager.isRunning(id)) throw new Error('Stop the server before changing its jar.');
    const filename = await downloader.download(server.type, version, server.directory, (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('jar:progress', { id, ...p });
      }
    });
    // Point the server at the freshly-downloaded jar.
    const data = store.readData();
    const idx = data.servers.findIndex((s) => s.id === id);
    if (idx !== -1) {
      data.servers[idx] = store.normalizeServer({ ...data.servers[idx], jar: filename, id });
      store.writeData(data);
    }
    return filename;
  }));

  // ---- Singleplayer launcher (instances) --------------------------------
  // Shared "launcher home" for versions/libraries/assets (deduped across
  // instances); each instance's worlds/mods/config live in its own folder.
  function launcherHome() { return path.join(app.getPath('userData'), 'launcher'); }
  function instancesRoot() {
    const custom = (store.readData().settings.instancesRoot || '').trim();
    return custom || path.join(app.getPath('userData'), 'instances');
  }
  function getInstanceOrThrow(id) {
    const data = store.readData();
    const instance = (data.instances || []).find((i) => i.id === id);
    if (!instance) throw new Error('Instance not found');
    return { data, instance };
  }
  // Resolve the Java binary for a launch: explicit global override, else an
  // auto-downloaded Temurin JRE matched to what the version needs.
  async function ensureJavaFor(major, id) {
    const data = store.readData();
    if (data.settings.javaPath && data.settings.javaPath.trim()) return data.settings.javaPath.trim();
    const feature = major <= 8 ? 8 : (major === 16 ? 17 : major); // Adoptium has no GA 16 build
    const res = await javaManager.ensureRuntime(feature, (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launcher:progress', { id, phase: 'java', ...p });
    });
    return res.path;
  }
  function instanceModsDir(instance) {
    if (!instance.directory) throw new Error('This instance has no folder yet.');
    return path.join(instance.directory, 'mods');
  }
  // The Modrinth client-loader key for an instance (vanilla has no mods).
  function instanceLoader(instance) {
    if (instance.loader !== 'fabric' && instance.loader !== 'quilt') {
      throw new Error('This is a vanilla instance — add a Fabric or Quilt instance to install mods.');
    }
    return instance.loader;
  }

  ipcMain.handle('launcher:instances', wrap(async () => {
    const data = store.readData();
    return (data.instances || []).map((i) => ({ ...i, state: launcherManager.getState(i.id) }));
  }));

  ipcMain.handle('launcher:mcVersions', wrap(async () => mojang.listVersions()));
  ipcMain.handle('launcher:loaderVersions', wrap(async (loader, mcVersion) => loaders.loaderVersions(loader, mcVersion)));

  ipcMain.handle('launcher:createInstance', wrap(async (opts) => {
    const { name, mcVersion, loader = 'vanilla' } = opts || {};
    if (!mcVersion) throw new Error('Pick a Minecraft version.');
    let loaderVersion = '';
    if (loader === 'fabric' || loader === 'quilt') {
      loaderVersion = ((opts && opts.loaderVersion) || '').trim() || await loaders.latestLoader(loader, mcVersion);
    }
    const { directory } = await files.setupServerFolder(instancesRoot(), name || 'Instance', '', 'mods');
    const data = store.readData();
    const instance = store.normalizeInstance({ id: store.newId(), name, mcVersion, loader, loaderVersion, directory });
    data.instances = data.instances || [];
    data.instances.push(instance);
    store.writeData(data);
    return instance;
  }));

  ipcMain.handle('launcher:updateInstance', wrap(async (id, patch) => {
    const data = store.readData();
    const idx = (data.instances || []).findIndex((i) => i.id === id);
    if (idx === -1) throw new Error('Instance not found');
    data.instances[idx] = store.normalizeInstance({ ...data.instances[idx], ...patch, id });
    store.writeData(data);
    return data.instances[idx];
  }));

  ipcMain.handle('launcher:deleteInstance', wrap(async (id, deleteFiles) => {
    if (launcherManager.isRunning(id)) throw new Error('Close the game before deleting this instance.');
    const data = store.readData();
    const instance = (data.instances || []).find((i) => i.id === id);
    if (deleteFiles && instance && instance.directory) await files.deleteDir(instance.directory);
    data.instances = (data.instances || []).filter((i) => i.id !== id);
    store.writeData(data);
    return true;
  }));

  ipcMain.handle('launcher:install', wrap(async (id) => {
    const { instance } = getInstanceOrThrow(id);
    return launcherManager.install(instance, { home: launcherHome() });
  }));

  ipcMain.handle('launcher:play', wrap(async (id) => {
    const { data, instance } = getInstanceOrThrow(id);
    if (!data.account) throw new Error('Sign in to your Microsoft account first.');
    // Refresh the token if needed, and persist the refreshed one.
    const account = await msauth.ensureFresh(store.normalizeAccount(data.account));
    const d2 = store.readData();
    d2.account = store.normalizeAccount(account);
    store.writeData(d2);
    // Copy the instance's global datapacks into every world before launching.
    try { await syncGlobalDatapacks(instance); } catch { /* non-fatal */ }
    const result = await launcherManager.play(instance, account, {
      home: launcherHome(),
      launcherVersion: app.getVersion(),
      ensureJava: (major) => ensureJavaFor(major, id)
    });
    // Stamp last-played.
    const d3 = store.readData();
    const idx = (d3.instances || []).findIndex((i) => i.id === id);
    if (idx !== -1) { d3.instances[idx] = store.normalizeInstance({ ...d3.instances[idx], lastPlayed: Date.now() }); store.writeData(d3); }
    return result;
  }));

  ipcMain.handle('launcher:stop', wrap(async (id, opts) => launcherManager.stop(id, opts || {})));
  ipcMain.handle('launcher:state', wrap(async (id) => ({ state: launcherManager.getState(id) })));
  ipcMain.handle('launcher:logBuffer', wrap(async (id) => launcherManager.getLogBuffer(id)));
  ipcMain.handle('launcher:openFolder', wrap(async (id) => {
    const { instance } = getInstanceOrThrow(id);
    if (!instance.directory) throw new Error('This instance has no folder yet.');
    fs.mkdirSync(instance.directory, { recursive: true });
    await shell.openPath(instance.directory);
    return instance.directory;
  }));

  // ---- Per-instance mods (Modrinth, into <instance>/mods) ----
  ipcMain.handle('launcher:modsList', wrap(async (id) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instanceModsDir(instance);
    let names = [];
    try { names = (await fs.promises.readdir(dir)).filter((n) => /\.jar(\.disabled)?$/i.test(n)); } catch { /* no folder yet */ }
    const entries = [];
    for (const name of names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
      let size = 0;
      try { size = (await fs.promises.stat(path.join(dir, name))).size; } catch { /* ignore */ }
      entries.push({ filename: name.replace(/\.disabled$/i, ''), enabled: !/\.disabled$/i.test(name), size });
    }
    return { entries, dir, loader: instance.loader };
  }));

  ipcMain.handle('launcher:modsSearch', wrap(async (id, query, matchVersion) => {
    const { instance } = getInstanceOrThrow(id);
    const loader = instanceLoader(instance);
    const data = await modrinth.searchClient({ query, loader, gameVersion: matchVersion ? instance.mcVersion : null });
    return { ...data, gameVersion: instance.mcVersion };
  }));

  ipcMain.handle('launcher:modsAdd', wrap(async (id, projectId, matchVersion) => {
    const { instance } = getInstanceOrThrow(id);
    const loader = instanceLoader(instance);
    const file = await modrinth.bestFileClient(projectId, loader, matchVersion ? instance.mcVersion : null);
    const filename = await modrinth.downloadFile(file.url, file.filename, instanceModsDir(instance), (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launcher:modProgress', { id, projectId, ...p });
    });
    return { filename, versionNumber: file.versionNumber, gameVersions: file.gameVersions };
  }));

  ipcMain.handle('launcher:modsAddLocal', wrap(async (id) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instanceModsDir(instance);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add mods (.jar)',
      filters: [{ name: 'Java Archive', extensions: ['jar'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return [];
    await fs.promises.mkdir(dir, { recursive: true });
    const added = [];
    for (const src of result.filePaths) {
      const base = path.basename(src);
      await fs.promises.copyFile(src, path.join(dir, base));
      added.push(base);
    }
    return added;
  }));

  ipcMain.handle('launcher:modsToggle', wrap(async (id, filename, enable) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instanceModsDir(instance);
    const base = path.basename(filename).replace(/\.disabled$/i, '');
    const on = path.join(dir, base);
    const off = path.join(dir, base + '.disabled');
    if (enable) { if (fs.existsSync(off)) await fs.promises.rename(off, on); }
    else { if (fs.existsSync(on)) await fs.promises.rename(on, off); }
    return true;
  }));

  ipcMain.handle('launcher:modsRemove', wrap(async (id, filename) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instanceModsDir(instance);
    const base = path.basename(filename);
    for (const cand of [base, base + '.disabled']) {
      const p = path.join(dir, cand);
      if (fs.existsSync(p)) await fs.promises.rm(p, { force: true });
    }
    return true;
  }));

  // ---- Per-instance resource packs (Modrinth, into <instance>/resourcepacks) ----
  // Unlike mods, resource packs work on every instance (vanilla included) and are
  // enabled in-game from the Options → Resource Packs screen once installed.
  function instancePacksDir(instance) {
    if (!instance.directory) throw new Error('This instance has no folder yet.');
    return path.join(instance.directory, 'resourcepacks');
  }

  ipcMain.handle('launcher:packsList', wrap(async (id) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instancePacksDir(instance);
    let names = [];
    try { names = (await fs.promises.readdir(dir)).filter((n) => /\.zip$/i.test(n)); } catch { /* no folder yet */ }
    const entries = [];
    for (const name of names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
      let size = 0;
      try { size = (await fs.promises.stat(path.join(dir, name))).size; } catch { /* ignore */ }
      entries.push({ filename: name, size });
    }
    return { entries, dir };
  }));

  ipcMain.handle('launcher:packsSearch', wrap(async (id, query, matchVersion) => {
    const { instance } = getInstanceOrThrow(id);
    const data = await modrinth.searchResourcePacks({ query, gameVersion: matchVersion ? instance.mcVersion : null });
    return { ...data, gameVersion: instance.mcVersion };
  }));

  ipcMain.handle('launcher:packsAdd', wrap(async (id, projectId, matchVersion) => {
    const { instance } = getInstanceOrThrow(id);
    const file = await modrinth.bestFileResourcePack(projectId, matchVersion ? instance.mcVersion : null);
    const filename = await modrinth.downloadFile(file.url, file.filename, instancePacksDir(instance), (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launcher:packProgress', { id, projectId, ...p });
    });
    return { filename, versionNumber: file.versionNumber, gameVersions: file.gameVersions };
  }));

  ipcMain.handle('launcher:packsAddLocal', wrap(async (id) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instancePacksDir(instance);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add resource packs (.zip)',
      filters: [{ name: 'Resource pack', extensions: ['zip'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return [];
    await fs.promises.mkdir(dir, { recursive: true });
    const added = [];
    for (const src of result.filePaths) {
      const base = path.basename(src);
      await fs.promises.copyFile(src, path.join(dir, base));
      added.push(base);
    }
    return added;
  }));

  ipcMain.handle('launcher:packsRemove', wrap(async (id, filename) => {
    const { instance } = getInstanceOrThrow(id);
    const p = path.join(instancePacksDir(instance), path.basename(filename));
    if (fs.existsSync(p)) await fs.promises.rm(p, { force: true });
    return true;
  }));

  // ---- Per-instance shader packs (Modrinth, into <instance>/shaderpacks) ----
  // Shaders need a shader loader to render — on Fabric/Quilt that's the Iris mod
  // (install it from the Mods tab). The .zip itself is loader-agnostic.
  function instanceShadersDir(instance) {
    if (!instance.directory) throw new Error('This instance has no folder yet.');
    return path.join(instance.directory, 'shaderpacks');
  }

  ipcMain.handle('launcher:shadersList', wrap(async (id) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instanceShadersDir(instance);
    let names = [];
    try { names = (await fs.promises.readdir(dir)).filter((n) => /\.zip$/i.test(n)); } catch { /* no folder yet */ }
    const entries = [];
    for (const name of names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
      let size = 0;
      try { size = (await fs.promises.stat(path.join(dir, name))).size; } catch { /* ignore */ }
      entries.push({ filename: name, size });
    }
    return { entries, dir };
  }));

  ipcMain.handle('launcher:shadersSearch', wrap(async (id, query, matchVersion) => {
    const { instance } = getInstanceOrThrow(id);
    const data = await modrinth.searchShaders({ query, gameVersion: matchVersion ? instance.mcVersion : null });
    return { ...data, gameVersion: instance.mcVersion };
  }));

  ipcMain.handle('launcher:shadersAdd', wrap(async (id, projectId, matchVersion) => {
    const { instance } = getInstanceOrThrow(id);
    const file = await modrinth.bestFileShader(projectId, matchVersion ? instance.mcVersion : null);
    const filename = await modrinth.downloadFile(file.url, file.filename, instanceShadersDir(instance), (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launcher:shaderProgress', { id, projectId, ...p });
    });
    return { filename, versionNumber: file.versionNumber, gameVersions: file.gameVersions };
  }));

  ipcMain.handle('launcher:shadersAddLocal', wrap(async (id) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instanceShadersDir(instance);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add shader packs (.zip)',
      filters: [{ name: 'Shader pack', extensions: ['zip'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return [];
    await fs.promises.mkdir(dir, { recursive: true });
    const added = [];
    for (const src of result.filePaths) {
      const base = path.basename(src);
      await fs.promises.copyFile(src, path.join(dir, base));
      added.push(base);
    }
    return added;
  }));

  ipcMain.handle('launcher:shadersRemove', wrap(async (id, filename) => {
    const { instance } = getInstanceOrThrow(id);
    const p = path.join(instanceShadersDir(instance), path.basename(filename));
    if (fs.existsSync(p)) await fs.promises.rm(p, { force: true });
    return true;
  }));

  // ---- Per-world datapacks (Modrinth, into saves/<world>/datapacks) ----
  // Datapacks are scoped to a single world, not the whole instance, so every op
  // takes a world name. They apply after a /reload in-game (or rejoining).
  const GLOBAL_DP = '__global__';
  function instanceWorldDatapacksDir(instance, world) {
    if (!instance.directory) throw new Error('This instance has no folder yet.');
    // The instance-wide "global" datapacks VoxelDeck copies into every world on
    // launch. Kept outside saves/ so Minecraft never reads it as a world pack.
    if (world === GLOBAL_DP) return path.join(instance.directory, 'datapacks-global');
    const safe = path.basename(String(world || ''));
    if (!safe || safe === '.' || safe === '..') throw new Error('Pick a world first.');
    const dir = path.join(instance.directory, 'saves', safe);
    if (!fs.existsSync(dir)) throw new Error('That world no longer exists.');
    return path.join(dir, 'datapacks');
  }

  // Copy every global datapack into each existing world's datapacks/ folder
  // (skipping ones already present). Runs on Play. Note: this makes global packs
  // apply to worlds, but a *worldgen* pack still only affects newly-generated
  // chunks — a brand-new world must add it on the in-game Create-World screen.
  async function syncGlobalDatapacks(instance) {
    if (!instance.directory) return;
    const gdir = path.join(instance.directory, 'datapacks-global');
    let packs = [];
    try { packs = (await fs.promises.readdir(gdir)).filter((n) => /\.zip$/i.test(n)); } catch { return; }
    if (!packs.length) return;
    const savesDir = path.join(instance.directory, 'saves');
    let worlds = [];
    try {
      worlds = (await fs.promises.readdir(savesDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(savesDir, e.name, 'level.dat')))
        .map((e) => e.name);
    } catch { return; }
    for (const w of worlds) {
      const dpDir = path.join(savesDir, w, 'datapacks');
      await fs.promises.mkdir(dpDir, { recursive: true });
      for (const p of packs) {
        const dest = path.join(dpDir, p);
        if (!fs.existsSync(dest)) { try { await fs.promises.copyFile(path.join(gdir, p), dest); } catch { /* skip */ } }
      }
    }
  }

  ipcMain.handle('launcher:worldsList', wrap(async (id) => {
    const { instance } = getInstanceOrThrow(id);
    if (!instance.directory) return { worlds: [] };
    const savesDir = path.join(instance.directory, 'saves');
    let names = [];
    try { names = await fs.promises.readdir(savesDir, { withFileTypes: true }); } catch { return { worlds: [] }; }
    const worlds = [];
    for (const e of names) {
      if (!e.isDirectory()) continue;
      // A real world has a level.dat; skip stray folders.
      if (fs.existsSync(path.join(savesDir, e.name, 'level.dat'))) worlds.push(e.name);
    }
    worlds.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return { worlds };
  }));

  ipcMain.handle('launcher:datapacksList', wrap(async (id, world) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instanceWorldDatapacksDir(instance, world);
    let names = [];
    try { names = (await fs.promises.readdir(dir)).filter((n) => /\.zip$/i.test(n)); } catch { /* none yet */ }
    const entries = [];
    for (const name of names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
      let size = 0;
      try { size = (await fs.promises.stat(path.join(dir, name))).size; } catch { /* ignore */ }
      entries.push({ filename: name, size });
    }
    return { entries, dir };
  }));

  ipcMain.handle('launcher:datapacksSearch', wrap(async (id, query, matchVersion) => {
    const { instance } = getInstanceOrThrow(id);
    const data = await modrinth.searchDatapacks({ query, gameVersion: matchVersion ? instance.mcVersion : null });
    return { ...data, gameVersion: instance.mcVersion };
  }));

  ipcMain.handle('launcher:datapacksAdd', wrap(async (id, world, projectId, matchVersion) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instanceWorldDatapacksDir(instance, world);
    const file = await modrinth.bestFileDatapack(projectId, matchVersion ? instance.mcVersion : null);
    const filename = await modrinth.downloadFile(file.url, file.filename, dir, (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launcher:datapackProgress', { id, projectId, ...p });
    });
    return { filename, versionNumber: file.versionNumber, gameVersions: file.gameVersions };
  }));

  ipcMain.handle('launcher:datapacksAddLocal', wrap(async (id, world) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instanceWorldDatapacksDir(instance, world);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add datapacks (.zip)',
      filters: [{ name: 'Datapack', extensions: ['zip'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return [];
    await fs.promises.mkdir(dir, { recursive: true });
    const added = [];
    for (const src of result.filePaths) {
      const base = path.basename(src);
      await fs.promises.copyFile(src, path.join(dir, base));
      added.push(base);
    }
    return added;
  }));

  ipcMain.handle('launcher:datapacksRemove', wrap(async (id, world, filename) => {
    const { instance } = getInstanceOrThrow(id);
    const p = path.join(instanceWorldDatapacksDir(instance, world), path.basename(filename));
    if (fs.existsSync(p)) await fs.promises.rm(p, { force: true });
    return true;
  }));

  // Open the target datapacks folder in the file manager (so a worldgen .zip can
  // be dragged onto Minecraft's Create-World → Data Packs screen).
  ipcMain.handle('launcher:datapacksReveal', wrap(async (id, world) => {
    const { instance } = getInstanceOrThrow(id);
    const dir = instanceWorldDatapacksDir(instance, world);
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  }));

  // ---- Microsoft account ----
  let loginAbort = false;
  function sanitizeAccount(acc) {
    if (!acc) return null;
    return { name: acc.name, uuid: acc.uuid, updatedAt: acc.updatedAt, expiresAt: acc.expiresAt };
  }

  ipcMain.handle('account:get', wrap(async () => ({
    account: sanitizeAccount(store.readData().account),
    configured: msauth.isConfigured()
  })));

  ipcMain.handle('account:login', wrap(async () => {
    loginAbort = false;
    const account = await msauth.startDeviceLogin((info) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('account:code', info);
    }, () => loginAbort);
    const data = store.readData();
    data.account = store.normalizeAccount(account);
    store.writeData(data);
    return sanitizeAccount(data.account);
  }));

  ipcMain.handle('account:cancelLogin', wrap(async () => { loginAbort = true; return true; }));

  ipcMain.handle('account:logout', wrap(async () => {
    const data = store.readData();
    data.account = null;
    store.writeData(data);
    return true;
  }));

  // ---- Native pickers ----
  ipcMain.handle('dialog:pickDirectory', wrap(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select server folder',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  }));

  ipcMain.handle('dialog:pickJar', wrap(async (startDir) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select server jar',
      defaultPath: startDir || undefined,
      filters: [{ name: 'Java Archive', extensions: ['jar'] }],
      properties: ['openFile']
    });
    return result.canceled ? null : result.filePaths[0];
  }));
}

// ---- App lifecycle ---------------------------------------------------------

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  migrateLegacyConfig();
  registerIpc();
  wireManagerEvents();
  createWindow();
  updater.init(mainWindow);   // checks GitHub for a newer release (packaged builds only)
  scheduler.start();          // daily scheduled restarts (per-server, opt-in)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on('before-quit', async (e) => {
  const data = store.readData();
  const running = data.servers.some((s) => serverManager.isRunning(s.id))
    || (data.instances || []).some((i) => launcherManager.isRunning(i.id));
  if (running && !quitting) {
    e.preventDefault();
    quitting = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:quitting');
    }
    await Promise.all([serverManager.stopAll(), launcherManager.stopAll()]);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
