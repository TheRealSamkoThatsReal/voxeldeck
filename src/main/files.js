'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * File operations scoped to a server's root directory. Every path coming from
 * the renderer is resolved against the server root and validated so the UI can
 * never escape the server folder (defends against `../` traversal).
 */

const TEXT_EXTENSIONS = new Set([
  '.txt', '.properties', '.json', '.json5', '.yml', '.yaml', '.toml', '.cfg',
  '.conf', '.config', '.ini', '.log', '.md', '.sh', '.bat', '.csv', '.xml',
  '.html', '.css', '.js', '.mcmeta', '.lang', '.snbt', '.gitignore', '.env'
]);

const MAX_TEXT_BYTES = 5 * 1024 * 1024; // 5 MB editor cap

/** Resolve `relative` inside `root`, throwing if it escapes the root. */
function safeResolve(root, relative) {
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, relative || '.');
  const rel = path.relative(normalizedRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes server directory');
  }
  return target;
}

function looksTextual(name) {
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // Files with no extension that are commonly text.
  if (!ext && /^(eula|readme|license|dockerfile|makefile)$/i.test(name)) return true;
  return false;
}

async function listDir(root, relative) {
  const dir = safeResolve(root, relative);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let size = 0;
    let mtime = 0;
    try {
      const st = await fsp.stat(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch { /* dangling symlink etc. */ }
    result.push({
      name: entry.name,
      isDir: entry.isDirectory(),
      size,
      mtime,
      textual: entry.isFile() && looksTextual(entry.name)
    });
  }
  // Directories first, then alphabetical (case-insensitive).
  result.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return result;
}

async function readFileText(root, relative) {
  const file = safeResolve(root, relative);
  const st = await fsp.stat(file);
  if (st.size > MAX_TEXT_BYTES) {
    throw new Error(`File is too large to edit (${(st.size / 1048576).toFixed(1)} MB)`);
  }
  const buf = await fsp.readFile(file);
  if (isProbablyBinary(buf)) {
    throw new Error('File appears to be binary and cannot be edited as text');
  }
  return buf.toString('utf8');
}

async function writeFileText(root, relative, content) {
  const file = safeResolve(root, relative);
  await fsp.writeFile(file, content, 'utf8');
  return true;
}

async function createDir(root, relative) {
  const dir = safeResolve(root, relative);
  await fsp.mkdir(dir, { recursive: true });
  return true;
}

async function createFile(root, relative) {
  const file = safeResolve(root, relative);
  const handle = await fsp.open(file, 'wx'); // fail if exists
  await handle.close();
  return true;
}

async function remove(root, relative) {
  const target = safeResolve(root, relative);
  if (path.resolve(target) === path.resolve(root)) {
    throw new Error('Refusing to delete the server root directory');
  }
  await fsp.rm(target, { recursive: true, force: true });
  return true;
}

async function rename(root, relative, newName) {
  if (!newName || /[\\/]/.test(newName)) throw new Error('Invalid name');
  const src = safeResolve(root, relative);
  const dst = path.join(path.dirname(src), newName);
  safeResolve(root, path.relative(root, dst)); // validate destination
  await fsp.rename(src, dst);
  return true;
}

/** Copy an external file (absolute path) into the server tree at relDir. */
async function importFile(root, relDir, sourceAbsPath) {
  const destDir = safeResolve(root, relDir);
  await fsp.mkdir(destDir, { recursive: true });
  const base = path.basename(sourceAbsPath);
  const dest = path.join(destDir, base);
  await fsp.copyFile(sourceAbsPath, dest);
  return base;
}

function isProbablyBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true; // NUL byte ⇒ binary
  }
  return false;
}

/** Turn a server display name into a safe folder name. */
function sanitizeFolderName(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, '')  // drop characters that are awkward in paths
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return cleaned || 'server';
}

/** Find a non-colliding directory: base, then base-2, base-3, … */
function uniqueDir(parent, base) {
  let dir = path.join(parent, base);
  let i = 2;
  while (fs.existsSync(dir)) {
    dir = path.join(parent, `${base}-${i}`);
    i++;
  }
  return dir;
}

/**
 * Create and scaffold a new server folder under `parentDir`:
 *  - makes a uniquely-named folder from `name`
 *  - copies in the jar at `jarSource` (if given)
 *  - pre-creates the content folder (plugins/ or mods/) for the server type
 * Returns { directory, jar }.
 */
async function setupServerFolder(parentDir, name, jarSource, contentDir) {
  if (!parentDir) throw new Error('No location chosen for the new server folder');
  const absParent = path.resolve(parentDir);
  await fsp.mkdir(absParent, { recursive: true });
  const dir = uniqueDir(absParent, sanitizeFolderName(name));
  await fsp.mkdir(dir, { recursive: true });

  let jar = '';
  if (jarSource) {
    if (!fs.existsSync(jarSource)) throw new Error('Selected jar no longer exists');
    const base = path.basename(jarSource);
    await fsp.copyFile(jarSource, path.join(dir, base));
    jar = base;
  }
  if (contentDir) {
    await fsp.mkdir(path.join(dir, contentDir), { recursive: true });
  }
  return { directory: dir, jar };
}

/** List jar files in a directory (for jar/software pickers). */
async function listJars(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.jar'))
      .map((e) => e.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch {
    return [];
  }
}

module.exports = {
  safeResolve,
  listDir,
  readFileText,
  writeFileText,
  createDir,
  createFile,
  remove,
  rename,
  importFile,
  setupServerFolder,
  sanitizeFolderName,
  listJars,
  looksTextual,
  existsSync: (p) => fs.existsSync(p)
};
