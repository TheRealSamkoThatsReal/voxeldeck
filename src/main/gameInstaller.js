'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const games = require('./games');

const UA = { 'User-Agent': 'VoxelDeck/1.x (+https://github.com/TheRealSamkoThatsReal/voxeldeck)' };

// Terraria's official dedicated-server zip is versioned in its filename. Pin a
// known-good build; the URL 404s for unknown versions, which we surface clearly.
const TERRARIA_VERSION = '1449'; // 1.4.4.9
const terrariaUrl = (v) => `https://terraria.org/api/download/pc-dedicated-server/terraria-server-${v}.zip`;

function emit(onProgress, data) { try { if (onProgress) onProgress(data); } catch { /* ignore */ } }

/** Stream a URL to a file with progress (follows redirects via fetch). */
async function downloadTo(url, dest, onProgress) {
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      emit(onProgress, { received, total });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await fsp.rename(tmp, dest);
}

/** Recursively find the platform server folder (Linux/Windows/Mac) in a tree. */
function findPlatformDir(root, platform) {
  const want = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux';
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.toLowerCase() === want) return path.join(dir, e.name);
      stack.push(path.join(dir, e.name));
    }
  }
  return null;
}

/** Write a native game's config file (e.g. Terraria serverconfig.txt). */
async function writeGameConfigFile(server) {
  const game = games.get(server.game);
  if (typeof game.configFile !== 'function') return;
  const { path: file, contents, ensureDirs } = game.configFile(server);
  for (const d of ensureDirs || []) await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(file, contents, 'utf8');
}

// ---------------------------------------------------------------------------
async function installTerraria(server, onProgress) {
  const dir = server.directory;
  await fsp.mkdir(dir, { recursive: true });
  const tmpZip = path.join(os.tmpdir(), `voxeldeck-terraria-${process.pid}-${TERRARIA_VERSION}.zip`);

  emit(onProgress, { phase: 'download', message: 'Downloading Terraria dedicated server…' });
  await downloadTo(terrariaUrl(TERRARIA_VERSION), tmpZip, (p) =>
    emit(onProgress, { phase: 'download', received: p.received, total: p.total, message: 'Downloading Terraria dedicated server…' }));

  emit(onProgress, { phase: 'extract', message: 'Extracting…' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxeldeck-terraria-x-'));
  try {
    new AdmZip(tmpZip).extractAllTo(tmpDir, true);
    const platDir = findPlatformDir(tmpDir, process.platform);
    if (!platDir) throw new Error('Couldn’t find the server files inside the Terraria download.');
    await fsp.cp(platDir, dir, { recursive: true });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.rm(tmpZip, { force: true });
  }

  const binName = process.platform === 'win32' ? 'TerrariaServer.exe' : 'TerrariaServer.bin.x86_64';
  try { fs.chmodSync(path.join(dir, binName), 0o755); } catch { /* best effort */ }

  await writeGameConfigFile(server);
  emit(onProgress, { phase: 'done', message: 'Terraria server installed.' });
  return { binary: binName };
}

// ---------------------------------------------------------------------------
function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/** Locate a SteamCMD executable, or null if it isn't installed. */
function findSteamCmd() {
  const home = os.homedir();
  const named = process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd';
  // 1) PATH
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const c = path.join(d, named);
    if (isExecutable(c)) return c;
  }
  // 2) Common install locations
  const candidates = process.platform === 'win32'
    ? ['C:/steamcmd/steamcmd.exe', path.join(home, 'steamcmd', 'steamcmd.exe')]
    : [
        '/usr/games/steamcmd', '/usr/bin/steamcmd', '/usr/local/bin/steamcmd',
        path.join(home, 'steamcmd', 'steamcmd.sh'),
        path.join(home, '.steam', 'steamcmd', 'steamcmd.sh'),
        path.join(home, 'Steam', 'steamcmd', 'steamcmd.sh')
      ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function steamcmdHelp() {
  if (process.platform === 'win32') {
    return 'Download SteamCMD from https://developer.valvesoftware.com/wiki/SteamCMD, unzip it to C:\\steamcmd, then re-run setup.';
  }
  if (process.platform === 'darwin') {
    return 'Install SteamCMD (e.g. `brew install steamcmd`) then re-run setup.';
  }
  return 'Install SteamCMD with your package manager (Debian/Ubuntu: `sudo apt install steamcmd`, Arch: `yay -S steamcmd`), then re-run setup.';
}

async function installValheim(server, onProgress) {
  const steamcmd = findSteamCmd();
  if (!steamcmd) {
    const err = new Error(`SteamCMD isn’t installed. ${steamcmdHelp()}`);
    err.code = 'NO_STEAMCMD';
    throw err;
  }
  const dir = server.directory;
  await fsp.mkdir(dir, { recursive: true });
  emit(onProgress, { phase: 'install', message: 'Installing Valheim via SteamCMD — this downloads ~1 GB and can take several minutes…' });

  await new Promise((resolve, reject) => {
    const args = ['+force_install_dir', dir, '+login', 'anonymous', '+app_update', '896660', 'validate', '+quit'];
    const proc = spawn(steamcmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t) emit(onProgress, { phase: 'install', message: t });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0
      ? resolve()
      : reject(new Error(`SteamCMD exited with code ${code}. Check the log above.`))));
  });

  try { fs.chmodSync(path.join(dir, 'valheim_server.x86_64'), 0o755); } catch { /* best effort */ }
  emit(onProgress, { phase: 'done', message: 'Valheim server installed.' });
  return {};
}

/** Dispatch install by game. Returns a patch to merge into the server's gameConfig (or {}). */
async function install(server, onProgress) {
  switch (server.game) {
    case 'terraria': return installTerraria(server, onProgress);
    case 'valheim': return installValheim(server, onProgress);
    default: return {}; // Minecraft uses the jar downloader
  }
}

module.exports = {
  install, installTerraria, installValheim,
  writeGameConfigFile, findSteamCmd, findPlatformDir,
  TERRARIA_VERSION
};
