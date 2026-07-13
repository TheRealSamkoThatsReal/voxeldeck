// Renderer smoke test for Backups: boots the real index.html + preload with the
// backups IPC backed by the real backups module, then drives the Backups tab —
// create a backup, see it listed, restore it, and delete it — failing on any
// renderer error. Usage: electron test/backups-smoke.cjs
const { app, BrowserWindow, nativeTheme, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-bk-smoke-'));
app.setPath('userData', tmp);
const srvDir = path.join(tmp, 'server');
fs.mkdirSync(path.join(srvDir, 'world'), { recursive: true });
fs.writeFileSync(path.join(srvDir, 'world', 'level.dat'), 'WORLD');
fs.writeFileSync(path.join(tmp, 'servers.json'), JSON.stringify({
  version: 1, settings: {}, servers: [{
    id: 'bk1', name: 'Backup Test', game: 'minecraft', type: 'vanilla',
    directory: srvDir, jar: '', backupRetention: 5, scheduledBackup: false, scheduledBackupTime: '04:30'
  }]
}));

const games = require('../src/main/games');
const backups = require('../src/main/backups');
const root = backups.defaultBackupsRoot(tmp);
const srv = () => JSON.parse(fs.readFileSync(path.join(tmp, 'servers.json'))).servers[0];

const wrap = (h) => async (_e, ...a) => { try { return { ok: true, data: await h(...a) }; } catch (err) { return { ok: false, error: err.message }; } };

function registerIpc() {
  ipcMain.handle('app:info', wrap(async () => ({ totalRamMb: 16000, freeRamMb: 8000, platform: process.platform, appVersion: 'test', userData: tmp, homeDir: os.homedir(), defaultServersRoot: tmp })));
  ipcMain.handle('app:detectJava', wrap(async () => ({ ok: true, version: 'Java 21' })));
  ipcMain.handle('settings:get', wrap(async () => ({ accentColor: '#3a88f7' })));
  ipcMain.handle('settings:set', wrap(async (p) => p));
  ipcMain.handle('games:catalog', wrap(async () => games.catalog()));
  ipcMain.handle('servers:list', wrap(async () => [{ ...srv(), state: 'stopped', stats: { players: 0, maxPlayers: 0 } }]));
  ipcMain.handle('servers:state', wrap(async () => ({ state: 'stopped', stats: {} })));
  ipcMain.handle('servers:update', wrap(async (_id, patch) => ({ ...srv(), ...patch }))); // schedule toggles
  ipcMain.handle('servers:logBuffer', wrap(async () => []));
  ipcMain.handle('update:supported', wrap(async () => false));

  // Backups — real module, isolated temp root.
  ipcMain.handle('backups:list', wrap(async () => ({ dir: backups.serverBackupDir(root, 'bk1'), entries: await backups.list(root, 'bk1'), running: false })));
  ipcMain.handle('backups:create', wrap(async () => backups.create(srv(), root, { type: 'manual' })));
  ipcMain.handle('backups:restore', wrap(async (_id, name) => backups.restore(srv(), root, name)));
  ipcMain.handle('backups:remove', wrap(async (_id, name) => backups.remove(root, 'bk1', name)));
  ipcMain.handle('backups:reveal', wrap(async () => backups.serverBackupDir(root, 'bk1')));
}

const errors = [];
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  registerIpc();
  const win = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: {
    preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) { errors.push(message); console.log('  [renderer]', message); } });
  win.webContents.on('render-process-gone', (_e, d) => { errors.push('render gone: ' + d.reason); });
  const killer = setTimeout(() => { console.log('  TIMEOUT'); app.exit(2); }, 45000);

  const run = async (code) => { try { return await win.webContents.executeJavaScript(code + '; true'); } catch (e) { errors.push('JS: ' + e.message); } };
  const $js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (code, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await $js(code)) return true; await wait(150); } return false; };

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await wait(1200);

  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL', name); } };

  await run("selectServer('bk1')");
  await wait(300);
  ok('Backups tab is visible', await $js("getComputedStyle(document.getElementById('tabs').querySelector(\"[data-tab='backups']\")).display !== 'none'"));

  await run("switchTab('backups')");
  await wait(400);
  ok('Schedule card rendered', await $js("!!document.querySelector('#backupSchedule .sched-card input[type=checkbox]')"));
  ok('Empty state shown before any backup', await $js("!!document.querySelector('#backupsList .empty-list')"));

  // Create a backup.
  await run("onCreateBackup()");
  ok('A backup row appeared', await waitFor("document.querySelectorAll('#backupsList .content-row').length === 1"));
  const madeZip = fs.existsSync(backups.serverBackupDir(root, 'bk1')) && fs.readdirSync(backups.serverBackupDir(root, 'bk1')).some((f) => f.endsWith('-manual.zip'));
  ok('A real .zip archive was written to disk', madeZip);
  ok('Backup row is tagged "manual"', await $js("!!document.querySelector('#backupsList .bk-tag.manual')"));

  // Restore it (server is stopped) — confirm the danger modal.
  await run("document.querySelector('#backupsList .content-row .ghost-btn').click()");
  await wait(300);
  await run("[...document.querySelectorAll('.modal-actions button')].find(b=>/Restore/.test(b.textContent)).click()");
  ok('Restore completed and re-listed', await waitFor("document.querySelectorAll('#backupsList .content-row').length >= 1", 20000));
  ok('world file survived the restore', fs.readFileSync(path.join(srvDir, 'world', 'level.dat'), 'utf8') === 'WORLD');

  // Delete the (manual) backup.
  const before = fs.readdirSync(backups.serverBackupDir(root, 'bk1')).filter((f) => f.endsWith('-manual.zip')).length;
  await run("[...document.querySelectorAll('#backupsList .content-row')].map(r=>r.querySelector('.icon-btn')).filter(Boolean)[0].click()");
  await wait(300);
  await run("[...document.querySelectorAll('.modal-actions button')].find(b=>b.textContent==='Delete').click()");
  await wait(600);
  const after = fs.readdirSync(backups.serverBackupDir(root, 'bk1')).filter((f) => f.endsWith('-manual.zip')).length;
  ok('Delete removed a manual backup', after < before);

  ok('no renderer errors were logged', errors.length === 0);

  clearTimeout(killer);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  app.exit(fail ? 1 : 0);
});
