'use strict';

const { app } = require('electron');

/**
 * Auto-update via electron-updater + the GitHub releases we publish.
 *
 * Works for: Windows (NSIS installer) and Linux AppImage.
 * No-ops for: dev runs (not packaged), and platforms electron-updater can't
 * self-update (unsigned macOS, .deb) — those just report "unsupported".
 *
 * Emits 'update:status' to the renderer with { state, ... }:
 *   checking | available | none | downloading(percent) | ready(version) | error(message) | unsupported
 */

let mainWindow = null;
let autoUpdater = null;
let manualCheck = false;

function send(state, extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', { state, manual: manualCheck, ...extra });
  }
}

/** True only where electron-updater can actually replace the running app. */
function isSupported() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return true;
  // Linux: only the AppImage format self-updates (run via the AppImage launcher).
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  // macOS auto-update needs code signing, which our builds don't have.
  return false;
}

function init(win) {
  mainWindow = win;
  if (!isSupported()) return;

  // Lazy-require so dev/unpackaged runs never load it.
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = true;            // grab it quietly in the background
  autoUpdater.autoInstallOnAppQuit = true;    // and install on next quit if not restarted

  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => send('available', { version: info.version }));
  autoUpdater.on('update-not-available', (info) => { send('none', { version: info.version }); manualCheck = false; });
  autoUpdater.on('download-progress', (p) => send('downloading', { percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => { send('ready', { version: info.version }); manualCheck = false; });
  autoUpdater.on('error', (err) => { send('error', { message: String((err && err.message) || err) }); manualCheck = false; });

  // Quiet check shortly after launch.
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4000);
}

/** Manual "Check for updates" from the UI. Returns an immediate status. */
async function check() {
  if (!app.isPackaged) return { state: 'dev' };
  if (!isSupported()) return { state: 'unsupported' };
  manualCheck = true;
  try {
    await autoUpdater.checkForUpdates();
    return { state: 'checking' };
  } catch (e) {
    manualCheck = false;
    return { state: 'error', message: e.message };
  }
}

function quitAndInstall() {
  if (autoUpdater) {
    try { autoUpdater.quitAndInstall(); } catch { /* ignore */ }
  }
}

module.exports = { init, check, quitAndInstall, isSupported };
