// Functional tests for the pure-Node core modules (no Electron required).
// Run with: node test/core.test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = await import(path.join(root, 'src/main/files.js')).then((m) => m.default || m);
const utils = await import(path.join(root, 'src/main/serverUtils.js')).then((m) => m.default || m);
const downloader = await import(path.join(root, 'src/main/downloader.js')).then((m) => m.default || m);
const network = await import(path.join(root, 'src/main/network.js')).then((m) => m.default || m);
const modrinth = await import(path.join(root, 'src/main/modrinth.js')).then((m) => m.default || m);
const scheduler = await import(path.join(root, 'src/main/scheduler.js')).then((m) => m.default || m);
const gamesMod = await import(path.join(root, 'src/main/games.js')).then((m) => m.default || m);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-'));
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL', name); }
}

// --- files: path traversal protection ---
try { files.safeResolve(tmp, '../../etc/passwd'); ok('blocks ../ traversal', false); }
catch { ok('blocks ../ traversal', true); }
ok('resolves normal path', files.safeResolve(tmp, 'a/b').startsWith(tmp));

// --- files: create/list/read/write ---
await files.createDir(tmp, 'plugins');
await files.writeFileText(tmp, 'server.properties', 'motd=Hi\nmax-players=10\n#comment\nbad\n');
const txt = await files.readFileText(tmp, 'server.properties');
ok('write/read roundtrip', txt.includes('motd=Hi'));
const listing = await files.listDir(tmp, '.');
ok('listDir shows dir first', listing[0].isDir && listing[0].name === 'plugins');
ok('listDir flags textual', listing.find((e) => e.name === 'server.properties').textual === true);

// binary detection
fs.writeFileSync(path.join(tmp, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
try { await files.readFileText(tmp, 'bin.dat'); ok('rejects binary edit', false); }
catch { ok('rejects binary edit', true); }

// rename + remove
await files.rename(tmp, 'bin.dat', 'renamed.dat');
ok('rename works', fs.existsSync(path.join(tmp, 'renamed.dat')));
await files.remove(tmp, 'renamed.dat');
ok('remove works', !fs.existsSync(path.join(tmp, 'renamed.dat')));
try { await files.remove(tmp, '.'); ok('refuses to delete root', false); }
catch { ok('refuses to delete root', true); }

// --- files: deleteDir (permanent server-folder wipe) ---
const delDir = path.join(tmp, 'to-delete');
await files.createDir(delDir, 'world');
fs.writeFileSync(path.join(delDir, 'world', 'level.dat'), 'x');
await files.deleteDir(delDir);
ok('deleteDir removes the whole folder', !fs.existsSync(delDir));
ok('deleteDir on a missing path is a no-op', await files.deleteDir(path.join(tmp, 'gone')) === true);
for (const unsafe of ['/', os.homedir(), path.dirname(os.homedir()), '/usr', '/etc']) {
  let blocked = false;
  try { await files.deleteDir(unsafe); } catch { blocked = true; }
  ok(`deleteDir refuses unsafe path ${unsafe}`, blocked && fs.existsSync(unsafe));
}

// listJars
fs.writeFileSync(path.join(tmp, 'server.jar'), 'x');
fs.writeFileSync(path.join(tmp, 'paper.jar'), 'x');
const jars = await files.listJars(tmp);
ok('listJars finds jars', jars.length === 2 && jars.includes('paper.jar'));

// --- serverUtils: properties parse + write preserving comments ---
const props = await utils.readProperties(tmp);
ok('props parsed', props.exists && props.entries.find((e) => e.key === 'motd').value === 'Hi');
ok('props skips comment+invalid', !props.entries.find((e) => e.key === 'bad'));
await utils.writeProperties(tmp, { motd: 'Welcome', 'new-key': '42' });
const raw = fs.readFileSync(path.join(tmp, 'server.properties'), 'utf8');
ok('props update value', raw.includes('motd=Welcome'));
ok('props preserves comment', raw.includes('#comment'));
ok('props appends new key', raw.includes('new-key=42'));

// --- eula ---
ok('eula default false', await utils.getEula(tmp) === false);
await utils.setEula(tmp, true);
ok('eula set true', await utils.getEula(tmp) === true);

// --- ops.json (operator list) ---
ok('readOps empty when missing', (await utils.readOps(tmp)).length === 0);
fs.writeFileSync(path.join(tmp, 'ops.json'), JSON.stringify([
  { uuid: 'x', name: 'Alice', level: 4 },
  { uuid: 'y', name: 'Bob', level: 4 }
]));
const ops = await utils.readOps(tmp);
ok('readOps lists operator names', ops.includes('Alice') && ops.includes('Bob') && ops.length === 2);
fs.writeFileSync(path.join(tmp, 'ops.json'), 'not valid json');
ok('readOps tolerates bad json', (await utils.readOps(tmp)).length === 0);

// --- content folder logic ---
ok('paper -> plugins', utils.contentFolder('paper').dir === 'plugins');
ok('forge -> mods', utils.contentFolder('forge').dir === 'mods');
ok('vanilla flagged', utils.contentFolder('vanilla').vanilla === true);

// content add/list/toggle/remove
const fakeJar = path.join(tmp, 'mymod.jar');
fs.writeFileSync(fakeJar, 'x');
await utils.addContent(tmp, 'forge', fakeJar);
let c = await utils.listContent(tmp, 'forge');
ok('content listed', !!c.items.find((i) => i.name === 'mymod.jar' && i.enabled));
await utils.toggleContent(tmp, 'forge', 'mymod.jar', false);
c = await utils.listContent(tmp, 'forge');
ok('content disabled (.disabled)', !!c.items.find((i) => i.displayName === 'mymod.jar' && !i.enabled));
await utils.toggleContent(tmp, 'forge', 'mymod.jar.disabled', true);
c = await utils.listContent(tmp, 'forge');
ok('content re-enabled', !!c.items.find((i) => i.name === 'mymod.jar' && i.enabled));

// --- server folder scaffolding ---
ok('sanitizeFolderName cleans input', files.sanitizeFolderName('My Server! @#$') === 'My-Server');
ok('sanitizeFolderName falls back', files.sanitizeFolderName('!!!') === 'server');

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-root-'));
const srcJar = path.join(tmp, 'paper.jar'); // created in the listJars test above
const setup1 = await files.setupServerFolder(parent, 'Survival World', srcJar, 'plugins');
ok('setup created folder', fs.existsSync(setup1.directory) && /Survival-World$/.test(setup1.directory));
ok('setup copied jar', setup1.jar === 'paper.jar' && fs.existsSync(path.join(setup1.directory, 'paper.jar')));
ok('setup made content dir', fs.existsSync(path.join(setup1.directory, 'plugins')));
// same name again → unique suffix, no collision
const setup2 = await files.setupServerFolder(parent, 'Survival World', '', null);
ok('setup avoids collision', setup2.directory !== setup1.directory && /Survival-World-2$/.test(setup2.directory));
ok('setup without jar leaves jar empty', setup2.jar === '');
// missing source jar should throw
let threw = false;
try { await files.setupServerFolder(parent, 'X', '/no/such/file.jar', null); } catch { threw = true; }
ok('setup rejects missing jar source', threw);
fs.rmSync(parent, { recursive: true, force: true });

// --- jar downloader (offline-safe parts only) ---
ok('downloader auto types', downloader.AUTO_TYPES.join(',') === 'vanilla,paper,purpur,fabric');
ok('canAutoDownload paper', downloader.canAutoDownload('paper') === true);
ok('canAutoDownload forge=false', downloader.canAutoDownload('forge') === false);
ok('meta exposes pages', !!downloader.meta().pages.paper && !!downloader.meta().pages.forge);
const purpurDl = await downloader.resolveDownload('purpur', '1.21.4'); // pure URL build, no network
ok('purpur resolve url', purpurDl.url === 'https://api.purpurmc.org/v2/purpur/1.21.4/latest/download');
ok('purpur resolve filename', purpurDl.filename === 'purpur-1.21.4.jar');
let dlThrew = false;
try { await downloader.resolveDownload('forge', '1.21'); } catch { dlThrew = true; }
ok('resolve rejects non-auto type', dlThrew);

// --- network helpers (offline-safe) ---
ok('gateway from a LAN ip', network.likelyGateway('192.168.1.23') === '192.168.1.1');
ok('gateway handles other range', network.likelyGateway('10.0.0.42') === '10.0.0.1');
ok('gateway null on empty', network.likelyGateway('') === null);
ok('localIPv4s returns array', Array.isArray(network.localIPv4s()));
ok('primaryLocalIPv4 string-or-null', network.primaryLocalIPv4() === null || typeof network.primaryLocalIPv4() === 'string');

// --- modrinth target mapping (offline-safe) ---
ok('modrinth paper -> plugin', modrinth.targetFor('paper').projectType === 'plugin');
ok('modrinth paper runs spigot+bukkit plugins',
  ['paper', 'spigot', 'bukkit'].every((l) => modrinth.targetFor('paper').loaders.includes(l)));
ok('modrinth purpur runs paper plugins too', modrinth.targetFor('purpur').loaders.includes('paper'));
ok('modrinth fabric -> mod/fabric', modrinth.targetFor('fabric').projectType === 'mod' && modrinth.targetFor('fabric').loaders.includes('fabric'));
ok('modrinth quilt runs fabric mods too', modrinth.targetFor('quilt').loaders.includes('fabric'));
ok('modrinth neoforge -> mod', modrinth.targetFor('neoforge').projectType === 'mod');
ok('modrinth vanilla unsupported', modrinth.targetFor('vanilla') === null);
ok('mc version from paper jar', modrinth.detectGameVersion('paper-1.21.4-232.jar') === '1.21.4');
ok('mc version from purpur jar', modrinth.detectGameVersion('purpur-26.1.2.jar') === '26.1.2');
ok('mc version from vanilla jar', modrinth.detectGameVersion('minecraft_server.1.21.jar') === '1.21');
ok('mc version from fabric jar', modrinth.detectGameVersion('fabric-server-mc.1.21-loader.0.16.9-launcher.1.0.1.jar') === '1.21');
ok('mc version none when absent', modrinth.detectGameVersion('server.jar') === null);

// --- scheduler: due-time matching ---
const sched = { id: 's', scheduledRestart: true, scheduledRestartTime: '04:00' };
ok('scheduler fires at the configured time', scheduler.isDue(sched, '04:00'));
ok('scheduler ignores a different time', !scheduler.isDue(sched, '04:01'));
ok('scheduler off when disabled', !scheduler.isDue({ ...sched, scheduledRestart: false }, '04:00'));
ok('scheduler off with malformed time', !scheduler.isDue({ ...sched, scheduledRestartTime: '4:0' }, '4:0'));
ok('scheduler off with bad hour', !scheduler.isDue({ ...sched, scheduledRestartTime: '25:00' }, '25:00'));
ok('scheduler hhmmNow zero-pads', scheduler.hhmmNow(new Date(2026, 0, 1, 4, 5)) === '04:05');
ok('scheduler hhmmNow handles noon+', scheduler.hhmmNow(new Date(2026, 0, 1, 23, 59)) === '23:59');

// --- games: registry, capabilities, launch, stop, parse ---
ok('games catalog has 3 games', gamesMod.catalog().map((g) => g.id).sort().join(',') === 'minecraft,terraria,valheim');
ok('unknown game falls back to minecraft', gamesMod.get('nope').id === 'minecraft');

const mcSrv = { game: 'minecraft', directory: '/tmp/x', jar: 'paper.jar', minRamMb: 1024, maxRamMb: 2048, javaArgs: '-XX:+UseG1GC', serverArgs: 'nogui' };
const mcL = gamesMod.get('minecraft').launch(mcSrv, { resolvedJava: '/usr/bin/java', platform: 'linux' });
ok('mc launch uses java + heap + jar', mcL.command === '/usr/bin/java' && mcL.args.includes('-Xms1024M') && mcL.args.includes('-Xmx2048M') && mcL.args.includes('-jar') && mcL.args.includes('paper.jar'));
ok('mc launch passes java + server args', mcL.args.includes('-XX:+UseG1GC') && mcL.args.includes('nogui'));

const tSrv = { game: 'terraria', directory: '/tmp/tw', gameConfig: { port: 7779 } };
const tL = gamesMod.get('terraria').launch(tSrv, { platform: 'linux' });
ok('terraria launch points at binary', tL.command.endsWith('TerrariaServer.bin.x86_64'));
ok('terraria launch uses -config + -noupnp', tL.args.includes('-config') && tL.args.includes('-noupnp'));

const vSrv = { game: 'valheim', directory: '/tmp/vw', gameConfig: { serverName: 'S', worldName: 'W', password: 'secret', port: 2456, public: true, crossplay: true } };
const vL = gamesMod.get('valheim').launch(vSrv, { platform: 'linux' });
ok('valheim launch sets name/port/world/password', vL.args.includes('-name') && vL.args.includes('S') && vL.args.includes('-port') && vL.args.includes('2456') && vL.args.includes('-password') && vL.args.includes('secret'));
ok('valheim launch public + crossplay', vL.args.includes('-public') && vL.args[vL.args.indexOf('-public') + 1] === '1' && vL.args.includes('-crossplay'));
ok('valheim launch sets steam env', vL.env.SteamAppId === '892970' && /linux64/.test(vL.env.LD_LIBRARY_PATH));

ok('mc stop = stdin stop', JSON.stringify(gamesMod.get('minecraft').stopSpec()) === '{"type":"stdin","command":"stop"}');
ok('terraria stop = stdin exit', JSON.stringify(gamesMod.get('terraria').stopSpec()) === '{"type":"stdin","command":"exit"}');
ok('valheim stop = signal SIGINT', JSON.stringify(gamesMod.get('valheim').stopSpec()) === '{"type":"signal","signal":"SIGINT"}');

ok('mc capabilities', gamesMod.get('minecraft').capabilities.ram && gamesMod.get('minecraft').capabilities.players);
ok('terraria caps: players yes, ram no', gamesMod.get('terraria').capabilities.players && !gamesMod.get('terraria').capabilities.ram);
ok('valheim caps: no stdin, no players', !gamesMod.get('valheim').capabilities.stdinCommands && !gamesMod.get('valheim').capabilities.players);

const mcReady = gamesMod.get('minecraft').parse.ready.some((re) => re.test('[12:00:01] [Server thread/INFO]: Done (1.2s)! For help, type "help"'));
ok('mc ready regex matches Done line', mcReady);
ok('terraria ready regex matches', gamesMod.get('terraria').parse.ready.some((re) => re.test('Server started')));
ok('terraria join captures name', 'Alice'.match(gamesMod.get('terraria').parse.join) === null && 'Alice has joined.'.match(gamesMod.get('terraria').parse.join)[1] === 'Alice');
ok('valheim ready regex matches', gamesMod.get('valheim').parse.ready.some((re) => re.test('Game server connected')));

const tcf = gamesMod.get('terraria').configFile({ game: 'terraria', directory: '/tmp/tw', gameConfig: { worldName: 'Hub', worldSize: '2', maxPlayers: 6, port: 7779 } });
ok('terraria configFile has world + autocreate + port', /world=/.test(tcf.contents) && /autocreate=2/.test(tcf.contents) && /port=7779/.test(tcf.contents) && /worldname=Hub/.test(tcf.contents));

// java detect (shape only; may or may not be installed)
const j = await utils.detectJava();
ok('java detect returns shape', typeof j.ok === 'boolean');
console.log('  (java detected:', j.ok, (j.version || j.error || '').slice(0, 60), ')');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
