'use strict';

// Worker thread for creating/restoring backup archives. Zipping and unzipping
// are CPU-bound and synchronous (adm-zip), so they run here — off the main
// process — to keep the UI responsive. Progress is posted back as it goes.

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const post = (msg) => parentPort.postMessage(msg);

/** Collect every regular file under `dir` as paths relative to `base`. */
function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
    // symlinks and specials are skipped on purpose (avoid loops/escapes)
  }
  return out;
}

function create({ sourceDir, destFile }) {
  const files = walk(sourceDir, sourceDir, []);
  const zip = new AdmZip();
  let done = 0;
  for (const rel of files) {
    const dirInZip = path.dirname(rel) === '.' ? '' : path.dirname(rel).split(path.sep).join('/');
    try { zip.addLocalFile(path.join(sourceDir, rel), dirInZip); }
    catch { /* skip a file that's locked/unreadable rather than fail the whole backup */ }
    if (++done % 40 === 0) post({ phase: 'archiving', done, total: files.length });
  }
  post({ phase: 'writing', done: files.length, total: files.length });
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  zip.writeZip(destFile);
  post({ phase: 'done', size: fs.statSync(destFile).size, files: files.length });
}

function restore({ zipFile, destDir }) {
  const root = path.resolve(destDir);
  const entries = new AdmZip(zipFile).getEntries();
  let done = 0;
  for (const e of entries) {
    if (!e.isDirectory) {
      const outPath = path.resolve(path.join(destDir, e.entryName));
      // Guard against zip-slip: never write outside the destination directory.
      if (outPath !== root && !outPath.startsWith(root + path.sep)) continue;
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, e.getData());
    }
    if (++done % 40 === 0) post({ phase: 'restoring', done, total: entries.length });
  }
  post({ phase: 'done', files: entries.length });
}

try {
  if (workerData.op === 'create') create(workerData);
  else if (workerData.op === 'restore') restore(workerData);
  else post({ phase: 'error', message: `Unknown backup op: ${workerData.op}` });
} catch (err) {
  post({ phase: 'error', message: err.message });
}
