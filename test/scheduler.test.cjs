// Integration test for the scheduled-restart engine: against a fake "java"
// server, scheduler.restartServer must warn players, stop the process, then
// start it back up. Uses the same fake-java launcher trick as lifecycle.test.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sm = require(path.join(__dirname, '..', 'src', 'main', 'serverManager.js'));
const scheduler = require(path.join(__dirname, '..', 'src', 'main', 'scheduler.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-sched-'));
fs.writeFileSync(path.join(tmp, 'server.jar'), 'fake');

const fakeJava = path.join(tmp, 'fakejava.js');
fs.writeFileSync(fakeJava, `
process.stdout.write('[12:00:00] [Server thread/INFO]: Starting minecraft server\\n');
setTimeout(() => process.stdout.write('[12:00:01] [Server thread/INFO]: Done (1.0s)! For help, type "help"\\n'), 120);
let buf='';
process.stdin.on('data', d => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i+1);
    if (line === 'stop') { process.stdout.write('[INFO]: Stopping server\\n'); process.exit(0); }
    else process.stdout.write('[INFO]: issued command: ' + line + '\\n');
  }
});
`);
const launcher = path.join(tmp, 'launch.sh');
fs.writeFileSync(launcher, '#!/bin/sh\nexec ' + process.execPath + ' ' + fakeJava + '\n');
fs.chmodSync(launcher, 0o755);

const server = {
  id: 'sched-1', name: 'Sched', directory: tmp, jar: 'server.jar',
  type: 'vanilla', minRamMb: 512, maxRamMb: 1024,
  javaPath: launcher, javaArgs: '', serverArgs: 'nogui',
  scheduledRestart: true, scheduledRestartTime: '04:00'
};

let pass = 0, fail = 0;
const logs = [];
sm.on('log', (e) => { if (e.id === 'sched-1') logs.push(e.line); });
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL', name); } }
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 5000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (fn()) return true; await wait(50); } return false; }

(async () => {
  await sm.start(server, '');
  ok('server reached running', await waitFor(() => sm.getState('sched-1') === 'running'));

  // Kick off a scheduled restart; it warns (10s), stops, then starts again.
  const restart = scheduler.restartServer(server, '');

  // It must drop to 'stopped' at some point during the cycle...
  const wentDown = await waitFor(() => sm.getState('sched-1') === 'stopped', 30000);
  ok('restart stopped the server', wentDown);
  ok('warned players in chat', logs.some(l => /say Scheduled restart in 10 seconds/.test(l)));

  // ...then come back up to 'running'.
  await restart;
  ok('restart brought it back to running', await waitFor(() => sm.getState('sched-1') === 'running', 8000));
  ok('logged restart completion', logs.some(l => /Scheduled restart complete/.test(l)));

  await sm.stop('sched-1', {});
  await waitFor(() => sm.getState('sched-1') === 'stopped', 5000);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
