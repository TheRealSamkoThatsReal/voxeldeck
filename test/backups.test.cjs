// Backups: a real round-trip through the worker thread — create a backup of a
// server folder, verify the archive + metadata, mutate the folder, restore, and
// confirm the original contents come back. Also checks the retention prune keeps
// only automatic backups. No Electron/network involved.
const fs = require('fs');
const os = require('os');
const path = require('path');

const backups = require(path.join(__dirname, '..', 'src', 'main', 'backups.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-backups-'));
const root = path.join(tmp, 'backups');
const srvDir = path.join(tmp, 'server');
fs.mkdirSync(path.join(srvDir, 'world', 'region'), { recursive: true });
fs.writeFileSync(path.join(srvDir, 'server.properties'), 'level-name=world\n');
fs.writeFileSync(path.join(srvDir, 'world', 'level.dat'), 'ORIGINAL');
fs.writeFileSync(path.join(srvDir, 'world', 'region', 'r.0.0.mca'), 'REGION-DATA');
const server = { id: 'bk1', name: 'Backup Test', game: 'minecraft', directory: srvDir, backupRetention: 2 };

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL', name); } }
const read = (rel) => fs.readFileSync(path.join(srvDir, rel), 'utf8');

(async () => {
  // --- filename round-trips through parse ---
  const nm = backups.backupName(new Date(2026, 6, 13, 4, 30, 5), 'manual');
  ok('backupName/parseBackup round-trip', backups.parseBackup(nm) && backups.parseBackup(nm).type === 'manual');
  ok('parseBackup rejects foreign files', backups.parseBackup('world.zip') === null);

  // --- create ---
  const saw = new Set();
  const meta = await backups.create(server, root, { type: 'manual', onProgress: (p) => saw.add(p.phase) });
  ok('create returned a size and file count', meta.size > 0 && meta.files === 3);
  ok('create reported progress phases', saw.has('writing'));
  ok('archive exists on disk', fs.existsSync(path.join(root, 'bk1', meta.name)));

  let listed = await backups.list(root, 'bk1');
  ok('list finds the new backup', listed.length === 1 && listed[0].name === meta.name);

  // --- mutate the world, then restore ---
  fs.writeFileSync(path.join(srvDir, 'world', 'level.dat'), 'CORRUPTED');
  fs.writeFileSync(path.join(srvDir, 'world', 'junk.tmp'), 'leftover'); // a file NOT in the backup
  await backups.restore(server, root, meta.name);
  ok('restore brought back the original level.dat', read('world/level.dat') === 'ORIGINAL');
  ok('restore kept the region file', read('world/region/r.0.0.mca') === 'REGION-DATA');
  ok('restore cleared files that were not in the backup', !fs.existsSync(path.join(srvDir, 'world', 'junk.tmp')));

  // restore takes an automatic safety snapshot first → there should now be an 'auto' backup
  listed = await backups.list(root, 'bk1');
  ok('restore created an automatic safety backup', listed.some((b) => b.type === 'auto'));

  // --- retention prunes only auto backups, keeping the newest N ---
  for (let i = 0; i < 4; i++) {
    await backups.create(server, root, { type: 'auto', date: new Date(2026, 0, 1 + i, 12, 0, 0) });
  }
  const pruned = await backups.prune(root, 'bk1', 2);
  const after = await backups.list(root, 'bk1');
  ok('prune deleted the excess auto backups', pruned.length >= 1);
  ok('prune kept exactly the retention count of auto backups', after.filter((b) => b.type === 'auto').length === 2);
  ok('prune left the manual backup untouched', after.some((b) => b.type === 'manual'));

  // --- remove ---
  await backups.remove(root, 'bk1', meta.name);
  ok('remove deleted the manual backup', !(await backups.list(root, 'bk1')).some((b) => b.name === meta.name));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
