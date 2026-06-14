'use strict';

// Daily scheduled-restart engine. Ticks on a timer; when a server's configured
// local time arrives and it's currently running, it warns players in chat, then
// performs a graceful stop → start. `store` is lazy-required (it pulls in
// electron) so this module's pure helpers stay unit-testable under plain Node.

const serverManager = require('./serverManager');

function pad2(n) { return String(n).padStart(2, '0'); }

/** Local "HH:MM" for a Date (24h). */
function hhmmNow(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Pure: is this server configured to restart at the given HH:MM? */
function isDue(server, hhmm) {
  return !!(
    server &&
    server.scheduledRestart &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(server.scheduledRestartTime || '') &&
    server.scheduledRestartTime === hhmm
  );
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// One trigger per server per (day + time) so a >1-minute restart sequence can't
// re-fire within the same matching minute.
const lastFired = new Map();
let timer = null;

async function waitForStopped(id, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (serverManager.getState(id) === 'stopped') return true;
    await delay(500);
  }
  return serverManager.getState(id) === 'stopped';
}

/** Warn players, stop, wait for exit, then start the server again. */
async function restartServer(server, javaPath) {
  const id = server.id;
  serverManager.systemLog(id, '⟳ Scheduled restart starting…');
  try { serverManager.sendCommand(id, 'say Scheduled restart in 10 seconds…'); } catch { /* not running */ }
  await delay(5000);
  try { serverManager.sendCommand(id, 'say Scheduled restart in 5 seconds — see you in a moment!'); } catch { /* ignore */ }
  await delay(5000);

  try { await serverManager.stop(id); } catch { /* ignore */ }
  if (!(await waitForStopped(id, 60000))) {
    serverManager.systemLog(id, '⟳ Scheduled restart: server did not stop in time — leaving it as-is.');
    return;
  }
  await delay(1500); // let ports/files settle
  try {
    await serverManager.start(server, javaPath);
    serverManager.systemLog(id, '⟳ Scheduled restart complete.');
  } catch (e) {
    serverManager.systemLog(id, `⟳ Scheduled restart could not relaunch the server: ${e.message}`);
  }
}

function tick(now = new Date()) {
  const store = require('./store'); // lazy — only the running app touches disk
  let data;
  try { data = store.readData(); } catch { return; }
  const hhmm = hhmmNow(now);
  const dayKey = `${now.toDateString()} ${hhmm}`;
  for (const server of data.servers || []) {
    if (!isDue(server, hhmm)) continue;
    if (lastFired.get(server.id) === dayKey) continue;
    // Only restart a server that's actually up-and-running (not mid start/stop).
    if (serverManager.getState(server.id) !== 'running') continue;
    lastFired.set(server.id, dayKey);
    restartServer(server, (data.settings || {}).javaPath);
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => tick(), 20000); // 20s cadence → minute-accurate
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, isDue, hhmmNow, restartServer };
