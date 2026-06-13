'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

/** Server types that load Bukkit-style plugins vs. Forge/Fabric-style mods. */
const PLUGIN_TYPES = new Set(['paper', 'spigot', 'bukkit', 'purpur']);
const MOD_TYPES = new Set(['forge', 'neoforge', 'fabric', 'quilt']);

/** Which content folder a server type uses, and the label to show. */
function contentFolder(type) {
  if (PLUGIN_TYPES.has(type)) return { dir: 'plugins', label: 'Plugins' };
  if (MOD_TYPES.has(type)) return { dir: 'mods', label: 'Mods' };
  // Vanilla / unknown: vanilla has no mod system, but show mods/ as a default.
  return { dir: 'mods', label: 'Mods', vanilla: true };
}

/** Detect a Java install and its version string. */
function detectJava(javaPath) {
  const bin = javaPath && javaPath.trim() ? javaPath.trim() : 'java';
  return new Promise((resolve) => {
    execFile(bin, ['-version'], (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, path: bin, version: null, error: err.message });
        return;
      }
      // `java -version` prints to stderr.
      const first = (stderr || '').split('\n')[0] || '';
      resolve({ ok: true, path: bin, version: first.trim() });
    });
  });
}

// ---- server.properties -----------------------------------------------------

function propsPath(serverDir) {
  return path.join(serverDir, 'server.properties');
}

async function readProperties(serverDir) {
  const file = propsPath(serverDir);
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, entries: [] };
    throw err;
  }
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    entries.push({ key: line.slice(0, idx).trim(), value: line.slice(idx + 1) });
  }
  return { exists: true, entries };
}

/**
 * Update keys in server.properties, preserving comments / order. Adds any
 * new keys at the end. `updates` is a plain object of key→value.
 */
async function writeProperties(serverDir, updates) {
  const file = propsPath(serverDir);
  let lines = [];
  try {
    lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const remaining = { ...updates };
  const out = lines.map((line) => {
    const idx = line.indexOf('=');
    if (!line || line.startsWith('#') || idx === -1) return line;
    const key = line.slice(0, idx).trim();
    if (Object.prototype.hasOwnProperty.call(remaining, key)) {
      const v = remaining[key];
      delete remaining[key];
      return `${key}=${v}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(remaining)) {
    out.push(`${key}=${value}`);
  }
  // Trim trailing blank lines, keep one newline at EOF.
  while (out.length && out[out.length - 1] === '') out.pop();
  await fsp.writeFile(file, out.join('\n') + '\n', 'utf8');
  return true;
}

// ---- EULA -------------------------------------------------------------------

function eulaPath(serverDir) {
  return path.join(serverDir, 'eula.txt');
}

async function getEula(serverDir) {
  try {
    const text = await fsp.readFile(eulaPath(serverDir), 'utf8');
    return /eula\s*=\s*true/i.test(text);
  } catch {
    return false;
  }
}

async function setEula(serverDir, accepted) {
  const content =
    `# Accepted via VoxelDeck.\n` +
    `# By setting this to true you agree to the Minecraft EULA (https://aka.ms/MinecraftEULA).\n` +
    `eula=${accepted ? 'true' : 'false'}\n`;
  await fsp.writeFile(eulaPath(serverDir), content, 'utf8');
  return accepted;
}

// ---- operators (ops.json) ---------------------------------------------------

/** Read the operator names from ops.json (returns lowercase-comparable names). */
async function readOps(serverDir) {
  try {
    const txt = await fsp.readFile(path.join(serverDir, 'ops.json'), 'utf8');
    const arr = JSON.parse(txt);
    if (Array.isArray(arr)) {
      return arr.map((o) => (o && typeof o.name === 'string' ? o.name : null)).filter(Boolean);
    }
  } catch { /* missing or unreadable ⇒ no ops */ }
  return [];
}

// ---- mods / plugins ---------------------------------------------------------

/** List entries in the content folder, treating `.disabled` as toggled off. */
async function listContent(serverDir, type) {
  const { dir, label, vanilla } = contentFolder(type);
  const full = path.join(serverDir, dir);
  let items = [];
  try {
    const entries = await fsp.readdir(full, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      const isJar = lower.endsWith('.jar');
      const isDisabled = lower.endsWith('.jar.disabled') || lower.endsWith('.disabled');
      if (!isJar && !isDisabled) continue;
      let size = 0, mtime = 0;
      try {
        const st = await fsp.stat(path.join(full, e.name));
        size = st.size; mtime = st.mtimeMs;
      } catch { /* ignore */ }
      items.push({
        name: e.name,
        displayName: e.name.replace(/\.disabled$/i, ''),
        enabled: !isDisabled,
        size,
        mtime
      });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  items.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
  return { dir, label, vanilla: !!vanilla, exists: fs.existsSync(full), items };
}

async function toggleContent(serverDir, type, name, enable) {
  const { dir } = contentFolder(type);
  const full = path.join(serverDir, dir, name);
  if (!fs.existsSync(full)) throw new Error('File not found');
  let target;
  if (enable) {
    target = full.replace(/\.disabled$/i, '');
  } else {
    target = full.endsWith('.disabled') ? full : full + '.disabled';
  }
  if (target !== full) await fsp.rename(full, target);
  return path.basename(target);
}

async function addContent(serverDir, type, sourceAbsPath) {
  const { dir } = contentFolder(type);
  const destDir = path.join(serverDir, dir);
  await fsp.mkdir(destDir, { recursive: true });
  const base = path.basename(sourceAbsPath);
  await fsp.copyFile(sourceAbsPath, path.join(destDir, base));
  return base;
}

async function removeContent(serverDir, type, name) {
  const { dir } = contentFolder(type);
  const full = path.join(serverDir, dir, name);
  await fsp.rm(full, { force: true });
  return true;
}

module.exports = {
  detectJava,
  readProperties,
  writeProperties,
  getEula,
  setEula,
  readOps,
  contentFolder,
  listContent,
  toggleContent,
  addContent,
  removeContent
};
