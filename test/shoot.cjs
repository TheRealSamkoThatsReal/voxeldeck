// Dev-only screenshot harness: boots the real renderer (same preload + IPC as
// the app) and captures each tab to PNG via webContents.capturePage().
// Usage: electron test/shoot.cjs
const { app, BrowserWindow, nativeTheme, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Reuse the app's real IPC + manager by requiring main's pieces.
const store = require('../src/main/store');
const files = require('../src/main/files');
const utils = require('../src/main/serverUtils');
const serverManager = require('../src/main/serverManager');
const os = require('os');

// When launched as `electron test/shoot.cjs` the app name defaults to
// "Electron", so point userData at the same place the real app uses.
app.setPath('userData', path.join(os.homedir(), '.config', 'voxeldeck'));

const outDir = path.join(__dirname, 'shots');
fs.mkdirSync(outDir, { recursive: true });

function wrap(handler) {
  return async (_e, ...args) => {
    try { return { ok: true, data: await handler(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  };
}
function getServer(id) { const d = store.readData(); const s = d.servers.find((x) => x.id === id); if (!s) throw new Error('not found'); return { d, s }; }
function dirFor(id) { return getServer(id).s.directory; }

function registerIpc() {
  ipcMain.handle('app:info', wrap(async () => ({ totalRamMb: Math.round(os.totalmem()/1048576), freeRamMb: Math.round(os.freemem()/1048576), platform: process.platform, appVersion: '1.0.0', userData: app.getPath('userData'), homeDir: os.homedir(), defaultServersRoot: path.join(os.homedir(), 'MinecraftServers') })));
  ipcMain.handle('app:detectJava', wrap(async (p) => utils.detectJava(p)));
  ipcMain.handle('app:openExternal', wrap(async () => true));
  ipcMain.handle('app:openPath', wrap(async () => true));
  ipcMain.handle('settings:get', wrap(async () => store.readData().settings));
  ipcMain.handle('settings:set', wrap(async (patch) => { const d = store.readData(); d.settings = { ...d.settings, ...patch }; store.writeData(d); return d.settings; }));
  ipcMain.handle('servers:list', wrap(async () => store.readData().servers.map((s) => ({ ...s, state: serverManager.getState(s.id), stats: serverManager.getStats(s.id) }))));
  ipcMain.handle('servers:create', wrap(async (p) => { const d = store.readData(); const s = store.normalizeServer({ ...p, id: store.newId() }); d.servers.push(s); store.writeData(d); return s; }));
  ipcMain.handle('servers:setup', wrap(async (opts) => {
    const { name, type = 'vanilla', parentDir, jarSource } = opts || {};
    const d = store.readData();
    const root = parentDir || d.settings.serversRoot || require('os').tmpdir();
    const cf = utils.contentFolder(type);
    const { directory, jar } = await files.setupServerFolder(root, name, jarSource || '', cf.vanilla ? null : cf.dir);
    const s = store.normalizeServer({ id: store.newId(), name, type, directory, jar });
    d.servers.push(s); store.writeData(d); return s;
  }));
  ipcMain.handle('servers:update', wrap(async (id, patch) => { const d = store.readData(); const i = d.servers.findIndex((s) => s.id === id); d.servers[i] = store.normalizeServer({ ...d.servers[i], ...patch, id }); store.writeData(d); return d.servers[i]; }));
  ipcMain.handle('servers:delete', wrap(async (id) => { const d = store.readData(); d.servers = d.servers.filter((s) => s.id !== id); store.writeData(d); return true; }));
  ipcMain.handle('servers:start', wrap(async (id) => { const { d, s } = getServer(id); return serverManager.start(s, d.settings.javaPath); }));
  ipcMain.handle('servers:stop', wrap(async (id, o) => serverManager.stop(id, o || {})));
  ipcMain.handle('servers:command', wrap(async (id, c) => { serverManager.sendCommand(id, c); return true; }));
  ipcMain.handle('servers:state', wrap(async (id) => ({ state: serverManager.getState(id), stats: serverManager.getStats(id) })));
  ipcMain.handle('servers:logBuffer', wrap(async (id) => serverManager.getLogBuffer(id)));
  ipcMain.handle('files:list', wrap(async (id, r) => files.listDir(dirFor(id), r)));
  ipcMain.handle('files:read', wrap(async (id, r) => files.readFileText(dirFor(id), r)));
  ipcMain.handle('files:write', wrap(async (id, r, c) => files.writeFileText(dirFor(id), r, c)));
  ipcMain.handle('files:mkdir', wrap(async (id, r) => files.createDir(dirFor(id), r)));
  ipcMain.handle('files:touch', wrap(async (id, r) => files.createFile(dirFor(id), r)));
  ipcMain.handle('files:remove', wrap(async (id, r) => files.remove(dirFor(id), r)));
  ipcMain.handle('files:rename', wrap(async (id, r, n) => files.rename(dirFor(id), r, n)));
  ipcMain.handle('files:listJars', wrap(async (id) => files.listJars(dirFor(id))));
  ipcMain.handle('files:import', wrap(async () => []));
  ipcMain.handle('props:read', wrap(async (id) => utils.readProperties(dirFor(id))));
  ipcMain.handle('props:write', wrap(async (id, u) => utils.writeProperties(dirFor(id), u)));
  ipcMain.handle('eula:get', wrap(async (id) => utils.getEula(dirFor(id))));
  ipcMain.handle('eula:set', wrap(async (id, a) => utils.setEula(dirFor(id), a)));
  // Fake a populated, running player roster for the screenshot.
  ipcMain.handle('players:list', wrap(async () => ({ online: ['Alex', 'Notch', 'SteveMC', 'Herobrine'], ops: ['Alex', 'Notch'], running: true })));
  ipcMain.handle('players:refresh', wrap(async () => true));
  ipcMain.handle('net:addresses', wrap(async () => ({ local: '192.168.1.23', allLocal: [{ iface: 'wlan0', address: '192.168.1.23' }], gateway: '192.168.1.1', port: 25565 })));
  ipcMain.handle('net:public', wrap(async () => '203.0.113.45'));
  ipcMain.handle('jar:meta', wrap(async () => require('../src/main/downloader').meta()));
  ipcMain.handle('jar:versions', wrap(async () => ['1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1']));
  ipcMain.handle('content:list', wrap(async (id) => { const { s } = getServer(id); return utils.listContent(s.directory, s.type); }));
  ipcMain.handle('content:toggle', wrap(async (id, n, e) => { const { s } = getServer(id); return utils.toggleContent(s.directory, s.type, n, e); }));
  ipcMain.handle('content:remove', wrap(async (id, n) => { const { s } = getServer(id); return utils.removeContent(s.directory, s.type, n); }));
  ipcMain.handle('content:add', wrap(async () => []));
  ipcMain.handle('dialog:pickDirectory', wrap(async () => null));
  ipcMain.handle('dialog:pickJar', wrap(async () => null));
}

async function shoot(win, name) {
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
  console.log('  saved', name + '.png');
}

async function run(win, code) {
  try { await win.webContents.executeJavaScript(code + '; true'); }
  catch (e) { console.log('  JS ERROR in [' + code + ']:', e.message); }
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  registerIpc();
  const win = new BrowserWindow({
    width: 1280, height: 820, show: false, backgroundColor: '#0e1116',
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('  [renderer console]', message);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('  RENDERER GONE:', d.reason));

  // Hard safety net so we never hang the CI/headless run.
  const killer = setTimeout(() => { console.log('  TIMEOUT — quitting'); app.exit(2); }, 90000);

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1100));

  // The app lands on the home/overview page.
  await shoot(win, '0-home');
  // Fake a running server to show the green card state on the overview.
  await run(win, "state.servers[0].state='running'; state.servers[0].stats={players:3,maxPlayers:20}; renderHome()");
  await new Promise((r) => setTimeout(r, 300));
  await shoot(win, '0b-home-running');
  await run(win, "state.servers[0].state='stopped'; state.servers[0].stats={players:0,maxPlayers:0}");
  // (The interactive guided tour is verified separately by test/tour-flow.cjs.)

  // Open a server's detail and drive its tabs.
  await run(win, "selectServer(state.servers[0].id)");
  await new Promise((r) => setTimeout(r, 300));
  await shoot(win, '1-console');
  await run(win, "switchTab('connect')");
  await new Promise((r) => setTimeout(r, 500));
  await shoot(win, '1a-connect');
  await run(win, "switchTab('players')");
  await new Promise((r) => setTimeout(r, 400));
  await shoot(win, '1b-players');
  // Commands tab (fake the server running so Run buttons are enabled).
  await run(win, "state.servers[0].state='running'; switchTab('commands')");
  await new Promise((r) => setTimeout(r, 400));
  await shoot(win, '1c-commands');
  await run(win, "state.servers[0].state='stopped'; switchTab('console')");
  await run(win, "switchTab('files')");
  await new Promise((r) => setTimeout(r, 400));
  await shoot(win, '2-files');
  await run(win, "switchTab('content')");
  await new Promise((r) => setTimeout(r, 400));
  await shoot(win, '3-content');
  await run(win, "switchTab('properties')");
  await new Promise((r) => setTimeout(r, 400));
  await shoot(win, '4-properties');
  await run(win, "switchTab('settings')");
  await new Promise((r) => setTimeout(r, 700));
  await shoot(win, '5-settings');
  // Download-jar modal (Paper server → auto-download version picker).
  await run(win, "openDownloadJarModal(currentServer())");
  await new Promise((r) => setTimeout(r, 500));
  await shoot(win, '5b-download-jar');
  await run(win, "document.querySelector('.modal-host').click()");
  await run(win, "openAddServerModal()");
  await shoot(win, '6-addserver');

  // Accent color picker + applying a custom accent.
  await run(win, "document.querySelector('.modal-host').innerHTML=''; document.querySelector('.modal-host').classList.add('hidden'); openAppSettingsModal()");
  await new Promise((r) => setTimeout(r, 600));
  await shoot(win, '7-accent-picker');
  await run(win, "applyAccent('#a371f7')");           // amethyst
  await run(win, "switchTab('console')");
  await new Promise((r) => setTimeout(r, 400));
  await shoot(win, '8-accent-purple');
  await run(win, "applyAccent('#58a6ff'); switchTab('settings')");
  await new Promise((r) => setTimeout(r, 600));
  await shoot(win, '9-accent-blue');

  clearTimeout(killer);
  app.exit(0);
});
