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
const scheduler = require('./scheduler');
const updater = require('./updater');

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
}

// ---- Helpers ---------------------------------------------------------------

function getServerOrThrow(id) {
  const data = store.readData();
  const server = data.servers.find((s) => s.id === id);
  if (!server) throw new Error('Server not found');
  return { data, server };
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
    let port = 25565;
    try {
      if (server.directory) {
        const props = await utils.readProperties(server.directory);
        const p = props.entries.find((e) => e.key === 'server-port');
        if (p && /^\d+$/.test(p.value.trim())) port = parseInt(p.value.trim(), 10);
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
    const { name, type = 'vanilla', parentDir, jarSource } = opts || {};
    const data = store.readData();
    const root = parentDir || data.settings.serversRoot || path.join(os.homedir(), 'MinecraftServers');
    const cf = utils.contentFolder(type);
    const contentDir = cf.vanilla ? null : cf.dir; // don't make a misleading mods/ for vanilla
    const { directory, jar } = await files.setupServerFolder(root, name, jarSource || '', contentDir);
    const server = store.normalizeServer({ id: store.newId(), name, type, directory, jar });
    data.servers.push(server);
    store.writeData(data);
    return server;
  }));

  ipcMain.handle('servers:update', wrap(async (id, patch) => {
    const data = store.readData();
    const idx = data.servers.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('Server not found');
    data.servers[idx] = store.normalizeServer({ ...data.servers[idx], ...patch, id });
    store.writeData(data);
    return data.servers[idx];
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

  // ---- Server jar download ----
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
  const running = store.readData().servers.some((s) => serverManager.isRunning(s.id));
  if (running && !quitting) {
    e.preventDefault();
    quitting = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:quitting');
    }
    await serverManager.stopAll();
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
