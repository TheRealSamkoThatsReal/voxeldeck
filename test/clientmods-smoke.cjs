// Renderer smoke test for the Client Mods feature: boots the real index.html +
// preload, seeds a Fabric server in a throwaway userData, then drives the
// Client Mods tab, the Modrinth "Add" browser and the Apply modal — failing if
// the renderer logs any error or the process crashes.
// Usage: electron test/clientmods-smoke.cjs
const { app, BrowserWindow, nativeTheme, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate from the real config: point userData at a temp dir and seed a server.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-cm-smoke-'));
app.setPath('userData', tmp);
const srvDir = path.join(tmp, 'fabric-srv');
fs.mkdirSync(path.join(srvDir, 'mods'), { recursive: true });
fs.writeFileSync(path.join(srvDir, 'fabric-server-1.21.4.jar'), 'x');
fs.writeFileSync(path.join(tmp, 'servers.json'), JSON.stringify({
  version: 1, settings: {}, servers: [{
    id: 'cm1', name: 'Fabric Test', game: 'minecraft', type: 'fabric',
    directory: srvDir, jar: 'fabric-server-1.21.4.jar',
    clientMods: [{ source: 'modrinth', filename: 'sodium-0.6.jar', title: 'Sodium', versionNumber: '0.6', size: 1200 }]
  }]
}));

const games = require('../src/main/games');
const clientMods = require('../src/main/clientMods');

const wrap = (h) => async (_e, ...a) => { try { return { ok: true, data: await h(...a) }; } catch (err) { return { ok: false, error: err.message }; } };

function registerIpc() {
  ipcMain.handle('app:info', wrap(async () => ({ totalRamMb: 16000, freeRamMb: 8000, platform: process.platform, appVersion: 'test', userData: tmp, homeDir: os.homedir(), defaultServersRoot: tmp })));
  ipcMain.handle('app:detectJava', wrap(async () => ({ ok: true, version: 'Java 21' })));
  ipcMain.handle('app:openPath', wrap(async () => true));
  ipcMain.handle('app:openExternal', wrap(async () => true));
  ipcMain.handle('settings:get', wrap(async () => ({ accentColor: '#3a88f7', minecraftDir: path.join(tmp, 'mc') })));
  ipcMain.handle('settings:set', wrap(async (p) => p));
  ipcMain.handle('games:catalog', wrap(async () => games.catalog()));
  ipcMain.handle('servers:list', wrap(async () => JSON.parse(fs.readFileSync(path.join(tmp, 'servers.json'))).servers.map((s) => ({ ...s, state: 'stopped', stats: { players: 0, maxPlayers: 0 } }))));
  ipcMain.handle('servers:state', wrap(async () => ({ state: 'stopped', stats: {} })));
  ipcMain.handle('servers:logBuffer', wrap(async () => []));
  ipcMain.handle('update:supported', wrap(async () => false));

  // The feature under test — backed by the real clientMods module.
  const mcDir = path.join(tmp, 'mc');
  const cache = clientMods.cacheDir(tmp, 'cm1');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'sodium-0.6.jar'), 'jar');
  ipcMain.handle('clientmods:list', wrap(async () => ({
    entries: [{ source: 'modrinth', filename: 'sodium-0.6.jar', title: 'Sodium', versionNumber: '0.6', size: 1200, cached: true }],
    minecraftDir: mcDir, minecraftExists: false, targets: clientMods.targetDirs(mcDir, 'Fabric Test')
  })));
  ipcMain.handle('clientmods:search', wrap(async () => ({ label: 'mods', gameVersion: '1.21.4', hits: [
    { projectId: 'AANobbMI', slug: 'sodium', title: 'Sodium', description: 'Fast rendering', author: 'jellysquid3', downloads: 9000000, icon: '', versions: [] }
  ] })));
  ipcMain.handle('clientmods:add', wrap(async () => ({ filename: 'sodium-0.6.jar', versionNumber: '0.6' })));
  ipcMain.handle('clientmods:apply', wrap(async (_id, target) => clientMods.applyProfile(cache, ['sodium-0.6.jar'],
    target === 'main' ? clientMods.targetDirs(mcDir, 'Fabric Test').main : clientMods.targetDirs(mcDir, 'Fabric Test').isolated,
    { own: target !== 'main', backupLabel: target === 'main' ? 'T' : null })));
}

const errors = [];
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  registerIpc();
  const win = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: {
    preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) { errors.push(message); console.log('  [renderer]', message); } });
  win.webContents.on('render-process-gone', (_e, d) => { errors.push('render gone: ' + d.reason); });
  const killer = setTimeout(() => { console.log('  TIMEOUT'); app.exit(2); }, 40000);

  const run = async (code) => { try { return await win.webContents.executeJavaScript(code + '; true'); } catch (e) { errors.push('JS: ' + e.message); } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await wait(1200);

  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL', name); } };

  await run("selectServer('cm1')");
  await wait(300);
  // The Client Mods tab must be visible for a Fabric (mod-loader) Minecraft server.
  ok('Client Mods tab is visible for a Fabric server',
    await win.webContents.executeJavaScript("getComputedStyle(document.getElementById('clientModsTab')).display !== 'none'"));

  await run("switchTab('clientmods')");
  await wait(400);
  ok('Client Mods pane rendered the profile entry',
    await win.webContents.executeJavaScript("document.querySelectorAll('#clientModsList .content-row').length === 1"));
  ok('Apply button enabled (profile has mods)',
    await win.webContents.executeJavaScript("document.getElementById('applyClientModsBtn').disabled === false"));

  // Open the browser modal.
  await run("openClientModsBrowser()");
  await wait(500);
  ok('Browse modal shows a Modrinth result with an Add button',
    await win.webContents.executeJavaScript("!!document.querySelector('.modal .mr-row .primary-btn')"));
  await run("document.querySelector('#modalHost').innerHTML=''; document.querySelector('#modalHost').classList.add('hidden')");

  // Open the Apply modal and apply into the isolated folder.
  await run("openApplyClientModsModal()");
  await wait(400);
  ok('Apply modal offers both targets',
    await win.webContents.executeJavaScript("document.querySelectorAll(\"input[name='cmTarget']\").length === 2"));
  await run("[...document.querySelectorAll('.modal-actions button')].find(b=>b.textContent==='Apply').click()");
  await wait(500);
  const applied = fs.existsSync(path.join(clientMods.targetDirs(path.join(tmp, 'mc'), 'Fabric Test').isolated, 'sodium-0.6.jar'));
  ok('Apply installed the mod into the isolated .minecraft profile folder', applied);

  ok('no renderer errors were logged', errors.length === 0);

  clearTimeout(killer);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  app.exit(fail ? 1 : 0);
});
