// Tests ServerManager start → running-detection → console I/O → graceful stop,
// using a fake "java" that imitates a Minecraft server's stdout/stdin protocol.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sm = require(path.join(__dirname, '..', 'src', 'main', 'serverManager.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-life-'));
// fake jar (existence is checked)
fs.writeFileSync(path.join(tmp, 'server.jar'), 'fake');

// fake java: ignores JVM args, prints the "Done" line, echoes commands, exits on stop
const fakeJava = path.join(tmp, 'fakejava.js');
fs.writeFileSync(fakeJava, `
process.stdout.write('[12:00:00] [Server thread/INFO]: Starting minecraft server\\n');
setTimeout(() => {
  process.stdout.write('[12:00:01] [Server thread/INFO]: Done (1.234s)! For help, type "help"\\n');
  process.stdout.write('[12:00:02] [Server thread/INFO]: Alice joined the game\\n');
  process.stdout.write('[12:00:03] [Server thread/INFO]: Bob joined the game\\n');
}, 150);
let buf='';
process.stdin.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i+1);
    if (line.trim() === 'stop') { process.stdout.write('[INFO]: Stopping server\\n'); process.exit(0); }
    else if (line.trim() === 'list') { process.stdout.write('[INFO]: There are 2 of a max of 20 players online: Alice, Bob\\n'); }
    else if (line.trim() === 'kickbob') { process.stdout.write('[INFO]: Bob left the game\\n'); }
    else process.stdout.write('[INFO]: issued command: ' + line + '\\n');
  }
});
`);

const server = {
  id: 'test-1', name: 'Test', directory: tmp, jar: 'server.jar',
  type: 'vanilla', minRamMb: 512, maxRamMb: 1024,
  javaPath: process.execPath,           // run node...
  javaArgs: fakeJava,                    // ...with our fake-java script as a JVM arg (node sees it as the script to run)
  serverArgs: 'nogui'
};
// NOTE: serverManager builds: node -Xms.. -Xmx.. <fakeJava> -jar server.jar nogui
// node ignores -Xms/-Xmx? No — node would error on -Xms. So instead put script first via javaPath trick won't work.
// Simpler: make javaPath the node binary and rely on argv. But -Xms512M is invalid for node.
// Workaround: wrap with a shell launcher that strips JVM flags.

const launcher = path.join(tmp, 'launch.sh');
fs.writeFileSync(launcher, '#!/bin/sh\nexec ' + process.execPath + ' ' + fakeJava + '\n');
fs.chmodSync(launcher, 0o755);
server.javaPath = launcher;
server.javaArgs = '';

let pass = 0, fail = 0;
const logs = [];
sm.on('log', (e) => { if (e.id === 'test-1') logs.push(e.line); });
const states = [];
sm.on('state', (e) => { if (e.id === 'test-1') states.push(e.state); });

function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL', name); } }
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout=4000){ const t0=Date.now(); while(Date.now()-t0<timeout){ if(fn()) return true; await wait(50);} return false; }

(async () => {
  // start
  await sm.start(server, '');
  ok('state went to starting', states.includes('starting'));
  // wait for running
  const ranUp = await waitFor(() => sm.getState('test-1') === 'running');
  ok('detected "Done" -> running', ranUp);
  ok('captured startup log', logs.some(l => /Starting minecraft server/.test(l)));

  // send a command
  sm.sendCommand('test-1', 'say hello');
  await waitFor(() => logs.some(l => /issued command: say hello/.test(l)));
  ok('console command echoed back', logs.some(l => /issued command: say hello/.test(l)));

  // player tracking from join lines
  await waitFor(() => sm.getPlayerNames('test-1').length === 2);
  const names = sm.getPlayerNames('test-1').sort();
  ok('tracks joined players', names.join(',') === 'Alice,Bob');
  ok('stats count matches names', sm.getStats('test-1').players === 2);

  // `list` output syncs the roster + max players
  sm.sendCommand('test-1', 'list');
  await waitFor(() => sm.getStats('test-1').maxPlayers === 20);
  ok('list parses max players', sm.getStats('test-1').maxPlayers === 20);
  ok('list keeps roster', sm.getPlayerNames('test-1').length === 2);

  // leave line removes the player
  sm.sendCommand('test-1', 'kickbob');
  await waitFor(() => sm.getPlayerNames('test-1').length === 1);
  ok('leave removes player', sm.getPlayerNames('test-1').join(',') === 'Alice');

  // graceful stop
  await sm.stop('test-1', {});
  const stopped = await waitFor(() => sm.getState('test-1') === 'stopped', 5000);
  ok('graceful stop -> stopped', stopped);
  ok('state sequence valid', states[0]==='starting' && states.includes('running') && states[states.length-1]==='stopped');

  // error path: missing jar
  try { await sm.start({ ...server, id:'test-2', jar:'nope.jar' }, ''); ok('rejects missing jar', false); }
  catch(e){ ok('rejects missing jar', /jar not found/i.test(e.message)); }

  // error path: missing directory
  try { await sm.start({ ...server, id:'test-3', directory:'/nonexistent/xyz' }, ''); ok('rejects bad dir', false); }
  catch(e){ ok('rejects bad dir', /directory does not exist/i.test(e.message)); }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
