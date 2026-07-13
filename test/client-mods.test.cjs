// Unit tests for the client-side mod profile logic (clientMods.js). Exercises
// the pure filesystem parts — default Minecraft dir, add/remove in the cache,
// and applyProfile's two modes (own=sync vs. main=backup-then-install) — without
// any network or Electron.
const fs = require('fs');
const os = require('os');
const path = require('path');

const cm = require(path.join(__dirname, '..', 'src', 'main', 'clientMods.js'));
const modrinth = require(path.join(__dirname, '..', 'src', 'main', 'modrinth.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-clientmods-'));
const cacheDir = path.join(tmp, 'cache');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL', name); } }
const jars = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jar')).sort() : []);

(async () => {
  // --- default Minecraft dir per OS ---
  ok('linux default is ~/.minecraft',
    cm.defaultMinecraftDir('linux', '/home/x') === path.join('/home/x', '.minecraft'));
  ok('macos default is Application Support/minecraft',
    cm.defaultMinecraftDir('darwin', '/Users/x') === path.join('/Users/x', 'Library', 'Application Support', 'minecraft'));
  ok('windows default lands under .minecraft',
    /\.minecraft$/.test(cm.defaultMinecraftDir('win32', 'C:\\Users\\x')));

  // --- client loader selection is independent of the server's software ---
  ok('mod-loader servers default to their own loader', modrinth.defaultClientLoader('quilt') === 'quilt');
  ok('vanilla/Paper servers default to Fabric (dominant client loader)',
    modrinth.defaultClientLoader('vanilla') === 'fabric' && modrinth.defaultClientLoader('paper') === 'fabric');
  ok('Quilt client loader also accepts Fabric mods',
    modrinth.CLIENT_LOADERS.quilt.loaders.includes('fabric'));

  // --- target dirs derive from the server name ---
  const targets = cm.targetDirs('/mc', 'My Cool Server!');
  ok('main target is <mc>/mods', targets.main === path.join('/mc', 'mods'));
  ok('isolated target is name-scoped under voxeldeck-profiles',
    targets.isolated === path.join('/mc', 'voxeldeck-profiles', 'My-Cool-Server', 'mods'));

  // --- add local jars into the cache ---
  const srcA = path.join(tmp, 'sodium.jar'); fs.writeFileSync(srcA, 'A');
  const srcB = path.join(tmp, 'iris.jar'); fs.writeFileSync(srcB, 'BB');
  const eA = await cm.addLocal(cacheDir, srcA);
  await cm.addLocal(cacheDir, srcB);
  ok('addLocal records filename + size', eA.filename === 'sodium.jar' && eA.size === 1 && eA.source === 'local');
  ok('cache holds both jars', jars(cacheDir).join(',') === 'iris.jar,sodium.jar');
  ok('cacheFiles lists them', (await cm.cacheFiles(cacheDir)).length === 2);

  let threw = false;
  try { await cm.addLocal(cacheDir, path.join(tmp, 'notes.txt')); } catch { threw = true; }
  ok('addLocal rejects non-.jar', threw);

  // --- apply into an isolated folder we own: syncs exactly to the profile ---
  const iso = path.join(tmp, 'iso', 'mods');
  fs.mkdirSync(iso, { recursive: true });
  fs.writeFileSync(path.join(iso, 'stale.jar'), 'old'); // must be pruned (not in profile)
  const r1 = await cm.applyProfile(cacheDir, ['sodium.jar', 'iris.jar'], iso, { own: true });
  ok('own-apply installs the profile', jars(iso).join(',') === 'iris.jar,sodium.jar');
  ok('own-apply prunes non-profile jars', r1.removed.includes('stale.jar') && !jars(iso).includes('stale.jar'));
  ok('own-apply makes no backup', r1.backupDir === null);

  // --- apply into the "main" folder: existing jars are backed up, not deleted ---
  const main = path.join(tmp, 'main', 'mods');
  fs.mkdirSync(main, { recursive: true });
  fs.writeFileSync(path.join(main, 'mymod.jar'), 'mine');
  const r2 = await cm.applyProfile(cacheDir, ['sodium.jar'], main, { own: false, backupLabel: 'T1' });
  ok('main-apply installs the profile', jars(main).join(',') === 'sodium.jar');
  ok('main-apply backed the old jar up', r2.backupDir && fs.existsSync(path.join(r2.backupDir, 'mymod.jar')));

  // --- apply refuses if a cached file vanished ---
  await cm.removeCached(cacheDir, 'iris.jar');
  ok('removeCached deletes from cache', !jars(cacheDir).includes('iris.jar'));
  let applyThrew = false;
  try { await cm.applyProfile(cacheDir, ['iris.jar'], iso, { own: true }); } catch { applyThrew = true; }
  ok('apply throws when a cached mod is missing', applyThrew);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
