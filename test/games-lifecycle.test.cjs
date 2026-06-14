// Integration test: drive the REAL serverManager through the game abstraction
// for Terraria (stdin 'exit' stop, "X has joined." player parse) and Valheim
// (no stdin — SIGINT stop), using fake native "binaries" (shell scripts) placed
// at each game's expected executable path inside the server folder.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sm = require(path.join(__dirname, '..', 'src', 'main', 'serverManager.js'));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL', name); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 5000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (fn()) return true; await wait(40); } return false; }

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-games-')); }

(async () => {
  // ---------------- Terraria ----------------
  {
    const dir = mkdir();
    const bin = path.join(dir, 'TerrariaServer.bin.x86_64');
    // Fake Terraria: prints startup, "Server started", a join line; echoes
    // stdin; exits when it receives "exit".
    fs.writeFileSync(bin, `#!/bin/sh
echo "Terraria Server v1.4.4.9"
echo "Server started"
echo "Alice has joined."
while IFS= read -r line; do
  if [ "$line" = "exit" ]; then echo "Saving world... exiting"; exit 0; fi
  echo "issued: $line"
done
`);
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(path.join(dir, 'serverconfig.txt'), 'maxplayers=8\nport=7777\n');

    const server = { id: 'terraria-1', name: 'T', game: 'terraria', gameConfig: { port: 7777 }, directory: dir, type: 'vanilla' };
    const logs = [];
    sm.on('log', (e) => { if (e.id === 'terraria-1') logs.push(e.line); });

    await sm.start(server, '');
    ok('terraria reaches running (ready regex)', await waitFor(() => sm.getState('terraria-1') === 'running'));
    ok('terraria logged the launch command (native binary)', logs.some((l) => /TerrariaServer\.bin\.x86_64/.test(l)));
    ok('terraria parses "Alice has joined."', await waitFor(() => sm.getPlayerNames('terraria-1').includes('Alice')));

    await sm.stop('terraria-1', {});
    ok('terraria stops via stdin "exit"', await waitFor(() => sm.getState('terraria-1') === 'stopped', 6000));
    ok('terraria saw the exit/save line', logs.some((l) => /Saving world/.test(l)));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------------- Valheim ----------------
  {
    const dir = mkdir();
    const bin = path.join(dir, 'valheim_server.x86_64');
    // Fake Valheim: prints "Game server connected", IGNORES stdin, and only
    // exits when it receives SIGINT (proving signal-based stop).
    fs.writeFileSync(bin, `#!/bin/sh
trap 'echo "Net scene destroyed"; echo "OnApplicationQuit"; exit 0' INT
echo "Valheim dedicated server starting"
echo "Game server connected"
while true; do sleep 0.2; done
`);
    fs.chmodSync(bin, 0o755);

    const server = { id: 'valheim-1', name: 'V', game: 'valheim', gameConfig: { serverName: 'S', worldName: 'W', password: 'secret', port: 2456 }, directory: dir, type: 'vanilla' };
    const logs = [];
    sm.on('log', (e) => { if (e.id === 'valheim-1') logs.push(e.line); });

    await sm.start(server, '');
    ok('valheim reaches running (ready regex)', await waitFor(() => sm.getState('valheim-1') === 'running'));
    ok('valheim logged steam/native launch', logs.some((l) => /valheim_server\.x86_64/.test(l)));

    await sm.stop('valheim-1', {});
    ok('valheim stops via SIGINT (no stdin)', await waitFor(() => sm.getState('valheim-1') === 'stopped', 6000));
    ok('valheim ran its SIGINT save handler', logs.some((l) => /OnApplicationQuit/.test(l)));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
