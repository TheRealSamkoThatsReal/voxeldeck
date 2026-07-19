'use strict';

/* global window, document, api */
// NOTE: `api` is injected by the preload via contextBridge.exposeInMainWorld,
// which defines it as a NON-CONFIGURABLE property on the global object. A
// top-level `const api = window.api` would therefore throw
// "Identifier 'api' has already been declared" and abort this whole script,
// so we deliberately reference the global `api` (i.e. window.api) directly.

// ---- App state -------------------------------------------------------------
const state = {
  servers: [],          // [{id, name, ...config, state, stats}]
  selectedId: null,
  view: 'home',            // 'home' | 'detail' | 'empty'
  activeTab: 'console',
  sysInfo: { totalRamMb: 4096, freeRamMb: 0 },
  settings: { javaPath: '', accentColor: '#3fb950' },
  games: [],            // catalog of supported games (from main)
  // files tab
  filesCwd: '.',
  openFile: null,
  fileDirty: false,
  // console history per server
  history: {},          // id -> [commands]
  historyIdx: {},       // id -> index
  // cached log render position to avoid full re-render
  renderedLogCount: {},  // id -> number
  // singleplayer launcher
  instances: [],           // [{id, name, mcVersion, loader, ..., state}]
  selectedInstanceId: null,
  instanceTab: 'console',
  account: null,           // { name, uuid } | null
  accountConfigured: true, // whether Microsoft login is set up (Azure client id)
  renderedInstanceLogCount: {}
};

// ---- Tiny DOM helpers ------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
/** Cross-platform basename — handles both / and \ so absolute paths from the
 *  native file picker work on Windows as well as Linux/macOS. */
function baseName(p) {
  return (String(p || '').split(/[\\/]/).pop()) || '';
}

// ---- Accent color ----------------------------------------------------------
const DEFAULT_ACCENT = '#3a88f7';
const ACCENT_PRESETS = [
  { name: 'VoxelDeck Blue', hex: '#3a88f7' },
  { name: 'Creeper Green', hex: '#3fb950' },
  { name: 'Amethyst', hex: '#a371f7' },
  { name: 'Nether Pink', hex: '#db61a2' },
  { name: 'Lava Orange', hex: '#e3742f' },
  { name: 'Redstone', hex: '#f85149' },
  { name: 'Prismarine', hex: '#2dd4bf' },
  { name: 'Gold', hex: '#d9a62a' }
];

function normalizeHex(hex) {
  if (typeof hex !== 'string') return DEFAULT_ACCENT;
  let h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return DEFAULT_ACCENT;
  return '#' + h.toLowerCase();
}
function hexToRgb(hex) {
  const n = parseInt(normalizeHex(hex).slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const toHex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** Apply an accent color: derives hover/dim/text/rgb and sets CSS variables. */
function applyAccent(hex) {
  hex = normalizeHex(hex);
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const hover = hslToHex(h, s, Math.min(96, l + 7));
  const dim = hslToHex(h, s, Math.max(20, l * 0.52));
  // WCAG-ish luminance to decide dark vs. light text on the accent.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const text = lum > 0.55 ? hslToHex(h, Math.min(s, 70), 12) : '#ffffff';
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-hover', hover);
  root.setProperty('--accent-dim', dim);
  root.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
  root.setProperty('--accent-text', text);
}

// ---- API result unwrapping -------------------------------------------------
async function call(promise, { silent = false } = {}) {
  const res = await promise;
  if (!res || res.ok === false) {
    const msg = res ? res.error : 'Unknown error';
    if (!silent) toast('Error', msg, 'error');
    throw new Error(msg);
  }
  return res.data;
}

// ---- Toasts ----------------------------------------------------------------
function toast(title, msg = '', type = 'info', ttl = 4200) {
  const node = el('div', { class: `toast ${type}` },
    el('div', { class: 'toast-title' }, title),
    msg ? el('div', { class: 'toast-msg' }, msg) : null);
  $('#toastHost').appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, ttl);
}

// ---- Modal -----------------------------------------------------------------
function modal({ title, sub, body, actions, wide = false }) {
  const host = $('#modalHost');
  const card = el('div', { class: 'modal' + (wide ? ' wide' : '') });
  card.appendChild(el('h2', {}, title));
  if (sub) card.appendChild(el('div', { class: 'modal-sub' }, sub));
  if (body) card.appendChild(body);
  const actionRow = el('div', { class: 'modal-actions' });
  const close = () => { host.classList.add('hidden'); host.innerHTML = ''; };
  for (const a of actions) {
    const btn = el('button', { class: a.class || 'ghost-btn', id: a.id || null }, a.label);
    btn.addEventListener('click', async () => {
      if (a.onClick) {
        const keepOpen = await a.onClick();
        if (keepOpen === true) return;
      }
      close();
    });
    actionRow.appendChild(btn);
  }
  card.appendChild(actionRow);
  host.innerHTML = '';
  host.appendChild(card);
  host.classList.remove('hidden');
  host.onclick = (e) => { if (e.target === host) close(); };
  return { close };
}

function confirmModal(title, sub, { danger = false, confirmLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    modal({
      title, sub,
      actions: [
        { label: 'Cancel', class: 'ghost-btn', onClick: () => resolve(false) },
        { label: confirmLabel, class: danger ? 'danger-btn' : 'primary-btn', onClick: () => resolve(true) }
      ]
    });
  });
}

function promptModal(title, { label, value = '', placeholder = '', confirmLabel = 'OK' }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value, placeholder });
    const body = el('div', { class: 'field' }, label ? el('label', {}, label) : null, input);
    modal({
      title, body,
      actions: [
        { label: 'Cancel', class: 'ghost-btn', onClick: () => resolve(null) },
        { label: confirmLabel, class: 'primary-btn', onClick: () => resolve(input.value.trim() || null) }
      ]
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

// ============================================================================
// Server type metadata
// ============================================================================
const SERVER_TYPES = [
  { value: 'vanilla', label: 'Vanilla' },
  { value: 'paper', label: 'Paper' },
  { value: 'purpur', label: 'Purpur' },
  { value: 'spigot', label: 'Spigot' },
  { value: 'bukkit', label: 'CraftBukkit' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
  { value: 'other', label: 'Other / Custom' }
];
const PLUGIN_TYPES = new Set(['paper', 'spigot', 'bukkit', 'purpur']);
const MOD_TYPES = new Set(['forge', 'neoforge', 'fabric', 'quilt']);
function contentLabel(type) {
  if (PLUGIN_TYPES.has(type)) return 'Plugins';
  if (MOD_TYPES.has(type)) return 'Mods';
  return 'Mods';
}
function typeLabel(type) {
  return (SERVER_TYPES.find((t) => t.value === type) || {}).label || type;
}

// ============================================================================
// Games (multi-game support)
// ============================================================================
const GAME_BY_ID = {
  // Sensible fallback so the UI works before the catalog loads.
  minecraft: { id: 'minecraft', name: 'Minecraft', capabilities: { console: true, stdinCommands: true, ram: true, eula: true, properties: true, players: true, quickCommands: true, mods: true, jarDownload: true, minecraftSoftware: true, clientMods: true }, configSchema: [], defaultPort: 25565 }
};
function gameDef(id) { return GAME_BY_ID[id] || GAME_BY_ID.minecraft; }
function gameCaps(srv) { return gameDef((srv && srv.game) || 'minecraft').capabilities || {}; }
function gameLabel(id) { return gameDef(id).name; }

/** A one-word summary of a server's "kind" for list/home cards. */
function serverKindLabel(srv) {
  if (!srv) return '';
  if (srv.game && srv.game !== 'minecraft') return gameLabel(srv.game);
  return typeLabel(srv.type); // Minecraft: show the software (Paper, Fabric…)
}

/**
 * Render a declarative configSchema into form fields. Returns the field
 * elements plus a read() that pulls current values back out (typed).
 */
function buildSchemaFields(schema, values, onChange) {
  const inputs = {};
  const els = (schema || []).map((f) => {
    const cur = (values && values[f.key] !== undefined && values[f.key] !== '') ? values[f.key] : f.default;
    let input;
    if (f.type === 'select') {
      input = el('select', {}, ...f.options.map((o) => el('option', { value: o.value }, o.label)));
      input.value = String(cur);
    } else if (f.type === 'bool') {
      input = el('input', { type: 'checkbox' });
      input.checked = !!cur;
    } else {
      input = el('input', {
        type: f.type === 'number' ? 'number' : 'text',
        value: cur === undefined || cur === null ? '' : String(cur),
        placeholder: f.placeholder || ''
      });
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
    }
    inputs[f.key] = { input, type: f.type };
    if (onChange) input.addEventListener('change', onChange);
    if (f.type === 'bool') {
      return el('div', { class: 'field' },
        el('div', { class: 'checkbox-field' }, input, el('label', { style: 'margin:0' }, f.label)),
        f.hint ? el('div', { class: 'hint' }, f.hint) : null);
    }
    return el('div', { class: 'field' },
      el('label', {}, f.label), input,
      f.hint ? el('div', { class: 'hint' }, f.hint) : null);
  });
  const read = () => {
    const out = {};
    for (const f of (schema || [])) {
      const { input } = inputs[f.key];
      if (f.type === 'bool') out[f.key] = input.checked;
      else if (f.type === 'number') out[f.key] = input.value === '' ? '' : Number(input.value);
      else out[f.key] = input.value;
    }
    return out;
  };
  return { els, read };
}

// ============================================================================
// Bootstrap
// ============================================================================
async function init() {
  try {
    state.sysInfo = await call(api.appInfo());
  } catch { /* keep defaults */ }
  // Load settings and apply the saved accent color before first paint of data.
  try {
    state.settings = { ...state.settings, ...(await call(api.getSettings(), { silent: true })) };
  } catch { /* keep defaults */ }
  applyAccent(state.settings.accentColor);
  $('#systemRam').textContent = `${(state.sysInfo.totalRamMb / 1024).toFixed(1)} GB RAM available`;

  // Load the supported-games catalog (capabilities, config schemas).
  try {
    state.games = await call(api.gamesCatalog(), { silent: true });
    state.games.forEach((g) => { GAME_BY_ID[g.id] = g; });
  } catch { /* fall back to Minecraft-only behaviour */ }

  wireGlobalEvents();
  wireIpcEvents();
  await refreshServers();
  // Land on the overview/home page (or the empty state if there are no servers).
  if (state.servers.length) showHome();
  else showEmpty();

  // First run: kick off the guided tour once the UI has settled.
  if (!state.settings.tourSeen) setTimeout(startTour, 650);
}

function wireGlobalEvents() {
  $('#addServerBtn').addEventListener('click', openAddServerModal);
  $('#emptyAddBtn').addEventListener('click', openAddServerModal);
  $('#homeAddBtn').addEventListener('click', openAddServerModal);
  $('#homeNavBtn').addEventListener('click', showHome);
  $('#brandHome').addEventListener('click', showHome);
  $('#settingsBtn').addEventListener('click', openAppSettingsModal);

  // launcher (singleplayer)
  $('#launcherNavBtn').addEventListener('click', showLauncher);
  $('#newInstanceBtn').addEventListener('click', openNewInstanceModal);
  $('#instanceTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchInstanceTab(tab.dataset.itab);
  });
  $('#instPlayBtn').addEventListener('click', onInstancePlayToggle);
  $('#instFolderBtn').addEventListener('click', () => { const i = currentInstance(); if (i) call(api.launcherOpenFolder(i.id), { silent: true }); });
  $('#instBrowseModsBtn').addEventListener('click', openInstanceModsBrowser);
  $('#instAddModsBtn').addEventListener('click', onInstanceAddModLocal);
  $('#instBrowsePacksBtn').addEventListener('click', openInstancePacksBrowser);
  $('#instAddPacksBtn').addEventListener('click', onInstanceAddPackLocal);
  $('#instBrowseShadersBtn').addEventListener('click', openInstanceShadersBrowser);
  $('#instAddShadersBtn').addEventListener('click', onInstanceAddShaderLocal);
  $('#instBrowseDatapacksBtn').addEventListener('click', openInstanceDatapacksBrowser);
  $('#instAddDatapacksBtn').addEventListener('click', onInstanceAddDatapackLocal);
  $('#instWorldSelect').addEventListener('change', loadInstanceDatapacksList);

  // tabs
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchTab(tab.dataset.tab);
  });

  // power toggle
  $('#powerToggle').addEventListener('change', onPowerToggle);

  // console
  $('#consoleForm').addEventListener('submit', onConsoleSubmit);
  $('#consoleInput').addEventListener('keydown', onConsoleKey);

  // files toolbar
  $('#fileUpBtn').addEventListener('click', () => navigateFiles(parentPath(state.filesCwd)));
  $('#fileRefreshBtn').addEventListener('click', () => navigateFiles(state.filesCwd));
  $('#fileNewFileBtn').addEventListener('click', onNewFile);
  $('#fileNewFolderBtn').addEventListener('click', onNewFolder);
  $('#fileImportBtn').addEventListener('click', onImportFiles);
  $('#editorSave').addEventListener('click', saveOpenFile);
  $('#editorArea').addEventListener('input', () => {
    if (!state.fileDirty) { state.fileDirty = true; $('#editorSave').disabled = false; }
  });

  // players
  $('#playersRefresh').addEventListener('click', async () => {
    const srv = currentServer();
    if (srv) await api.refreshPlayers(srv.id);
    setTimeout(loadPlayers, 250); // give the `list` output a moment to parse
  });

  // content
  $('#addContentBtn').addEventListener('click', onAddContent);
  $('#browseContentBtn').addEventListener('click', openModrinthBrowser);

  // client mods
  $('#addClientModsBtn').addEventListener('click', onAddClientModLocal);
  $('#browseClientModsBtn').addEventListener('click', openClientModsBrowser);
  $('#applyClientModsBtn').addEventListener('click', openApplyClientModsModal);

  // properties
  $('#savePropsBtn').addEventListener('click', saveProperties);

  // backups
  $('#createBackupBtn').addEventListener('click', onCreateBackup);
  $('#revealBackupsBtn').addEventListener('click', () => { const s = currentServer(); if (s) call(api.backupsReveal(s.id), { silent: true }); });

  // keyboard: Ctrl+S saves the open file when on files tab
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      if (state.activeTab === 'files' && !$('#editorSave').disabled) {
        e.preventDefault(); saveOpenFile();
      }
    }
  });
}

function wireIpcEvents() {
  api.onServerState(({ id, state: st }) => {
    const srv = state.servers.find((s) => s.id === id);
    if (srv) srv.state = st;
    renderServerList();
    if (id === state.selectedId) updatePowerUI();
    if (state.view === 'home') renderHome();
    if (id === state.selectedId && state.activeTab === 'players') loadPlayers();
    if (id === state.selectedId && state.activeTab === 'commands') loadCommands();
  });

  api.onServerStats(({ id, players, maxPlayers }) => {
    const srv = state.servers.find((s) => s.id === id);
    if (srv) srv.stats = { players, maxPlayers };
    if (id === state.selectedId) updateStatsUI();
    if (state.view === 'home') renderHome();
    // Keep the Players tab + command autocomplete live as people join/leave.
    if (id === state.selectedId && state.activeTab === 'players') loadPlayers();
    if (id === state.selectedId && state.activeTab === 'commands') refreshCommandPlayers();
  });

  api.onServerLog(({ id, line, stream, ts }) => {
    if (id !== state.selectedId || state.activeTab !== 'console') return;
    appendLogLine({ line, stream, ts });
  });

  // launcher (singleplayer) events
  api.onLauncherState(({ id, state: st }) => {
    const inst = state.instances.find((i) => i.id === id);
    if (inst) inst.state = st;
    renderInstanceGrid();
    if (id === state.selectedInstanceId) { updateInstancePowerUI(); if (state.instanceTab === 'console') { /* progress cleared on stop */ if (st === 'stopped') hideInstProgress(); } }
  });
  api.onLauncherProgress(({ id, phase, done, total, received }) => {
    if (id !== state.selectedInstanceId) return;
    showInstProgress(phase, done, total, received);
  });
  api.onLauncherLog(({ id, line, stream, ts }) => {
    if (id !== state.selectedInstanceId || state.instanceTab !== 'console') return;
    appendInstanceLogLine({ line, stream, ts });
  });

  api.onUpdateStatus((s) => handleUpdateStatus(s));

  api.onQuitting(() => {
    document.body.innerHTML =
      '<div style="display:grid;place-items:center;height:100vh;color:#9aa7b4;font-family:sans-serif;">' +
      '<div style="text-align:center"><img src="assets/icon.png" style="width:52px;height:52px" alt="" />' +
      '<h2 style="margin-top:12px">Stopping servers…</h2>' +
      '<p style="margin-top:6px">Saving worlds and shutting down cleanly.</p></div></div>';
  });
}

// ============================================================================
// Server list / selection
// ============================================================================
async function refreshServers() {
  state.servers = await call(api.listServers());
  renderServerList();
}

function renderServerList() {
  const list = $('#serverList');
  list.innerHTML = '';
  if (!state.servers.length) {
    list.appendChild(el('li', { class: 'muted', style: 'padding:14px;text-align:center;' }, 'No servers yet.'));
    return;
  }
  for (const srv of state.servers) {
    const st = srv.state || 'stopped';
    const item = el('li', {
      class: 'server-item' + (srv.id === state.selectedId ? ' active' : ''),
      onclick: () => selectServer(srv.id)
    },
      el('span', { class: `status-dot ${st}` }),
      el('div', { class: 'si-info' },
        el('div', { class: 'si-name' }, srv.name),
        el('div', { class: 'si-meta' }, `${serverKindLabel(srv)} · ${stLabel(st)}`)
      )
    );
    list.appendChild(item);
  }
}

function stLabel(st) {
  return { stopped: 'Stopped', starting: 'Starting…', running: 'Running', stopping: 'Stopping…' }[st] || st;
}

function selectServer(id) {
  if (state.view === 'detail' && state.selectedId === id) return;
  state.view = 'detail';
  state.selectedId = id;
  state.filesCwd = '.';
  state.openFile = null;
  state.fileDirty = false;
  state.renderedLogCount[id] = 0;
  $('#emptyState').classList.add('hidden');
  $('#homeView').classList.add('hidden');
  $('#launcherView').classList.add('hidden');
  $('#instanceDetail').classList.add('hidden');
  $('#serverDetail').classList.remove('hidden');
  $('#homeNavBtn').classList.remove('active');
  $('#launcherNavBtn').classList.remove('active');
  renderServerList();
  renderDetail();
  switchTab('console');
}

function currentServer() {
  return state.servers.find((s) => s.id === state.selectedId);
}

// ============================================================================
// Home / overview page
// ============================================================================
function showHome() {
  if (!state.servers.length) { showEmpty(); return; }
  state.view = 'home';
  state.selectedId = null;
  $('#emptyState').classList.add('hidden');
  $('#serverDetail').classList.add('hidden');
  $('#launcherView').classList.add('hidden');
  $('#instanceDetail').classList.add('hidden');
  $('#homeView').classList.remove('hidden');
  $('#homeNavBtn').classList.add('active');
  $('#launcherNavBtn').classList.remove('active');
  renderServerList();
  renderHome();
}

function showEmpty() {
  state.view = 'empty';
  state.selectedId = null;
  $('#serverDetail').classList.add('hidden');
  $('#homeView').classList.add('hidden');
  $('#launcherView').classList.add('hidden');
  $('#instanceDetail').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
  $('#homeNavBtn').classList.remove('active');
  $('#launcherNavBtn').classList.remove('active');
  renderServerList();
}

function renderHome() {
  const grid = $('#homeGrid');
  grid.innerHTML = '';
  const total = state.servers.length;
  const running = state.servers.filter((s) => (s.state || 'stopped') !== 'stopped').length;
  $('#homeSummary').textContent = total
    ? `${total} server${total > 1 ? 's' : ''} · ${running} running`
    : 'No servers yet.';
  if (!total) {
    grid.appendChild(emptyList('🗀', 'No servers yet. Click “Add a server”.'));
    return;
  }
  for (const srv of state.servers) {
    const st = srv.state || 'stopped';
    const stats = srv.stats || { players: 0, maxPlayers: 0 };

    const toggle = el('input', { type: 'checkbox' });
    if (st === 'running') toggle.checked = true;
    else if (st === 'stopped') toggle.checked = false;
    else toggle.indeterminate = true;
    toggle.addEventListener('click', (e) => e.stopPropagation());
    toggle.addEventListener('change', (e) => {
      e.stopPropagation();
      setServerPower(srv, toggle.checked, toggle);
    });

    const card = el('div', { class: 'home-card', onclick: () => selectServer(srv.id) },
      el('div', { class: 'hc-top' },
        el('span', { class: `status-dot ${st}` }),
        el('div', { class: 'hc-name' }, srv.name),
        el('span', { class: `status-label ${st}` }, stLabel(st))
      ),
      el('div', { class: 'hc-meta' },
        el('span', {}, serverKindLabel(srv)),
        gameCaps(srv).players ? el('span', {}, `👥 ${stats.players}${stats.maxPlayers ? '/' + stats.maxPlayers : ''}`) : null,
        gameCaps(srv).ram ? el('span', {}, `🧠 ${fmtMb(srv.maxRamMb)}`) : null
      ),
      el('div', { class: 'hc-foot' },
        el('span', { class: 'hc-open' }, 'Open ›'),
        el('label', { class: 'switch', title: 'Start / stop', onclick: (e) => e.stopPropagation() },
          toggle, el('span', { class: 'slider' }))
      )
    );
    grid.appendChild(card);
  }
}

// Which capability gates each detail tab. Console/files/connect/settings are
// universal; the rest depend on the game.
const TAB_CAPABILITY = {
  console: null, connect: null, files: null, settings: null, backups: null,
  players: 'players', commands: 'quickCommands', content: 'mods', clientmods: 'clientMods', properties: 'properties'
};

function applyGameCapabilities(srv) {
  const caps = gameCaps(srv);
  $$('.tab').forEach((t) => {
    const cap = TAB_CAPABILITY[t.dataset.tab];
    const visible = !cap || caps[cap];
    t.style.display = visible ? '' : 'none';
  });
  // If the active tab is now hidden for this game, fall back to the console.
  const activeCap = TAB_CAPABILITY[state.activeTab];
  if (activeCap && !caps[activeCap]) switchTab('console');
  $('#contentTab').textContent = contentLabel(srv.type);
  $('#contentTitle').textContent = contentLabel(srv.type);
}

function renderDetail() {
  const srv = currentServer();
  if (!srv) return;
  $('#detailName').textContent = srv.name;
  applyGameCapabilities(srv);
  updatePowerUI();
  updateStatsUI();
}

function updatePowerUI() {
  const srv = currentServer();
  if (!srv) return;
  const st = srv.state || 'stopped';
  const dot = $('#detailStatusDot');
  dot.className = `status-dot ${st}`;
  $('#detailStatusLabel').textContent = stLabel(st);
  $('#detailStatusLabel').className = `status-label ${st}`;

  const toggle = $('#powerToggle');
  if (st === 'running') { toggle.indeterminate = false; toggle.checked = true; toggle.disabled = false; }
  else if (st === 'stopped') { toggle.indeterminate = false; toggle.checked = false; toggle.disabled = false; }
  else { toggle.indeterminate = true; toggle.disabled = false; } // starting/stopping

  const live = st === 'running';
  // Games without a command console (e.g. Valheim) never enable the input.
  const canType = live && gameCaps(srv).stdinCommands !== false;
  const input = $('#consoleInput');
  input.disabled = !canType;
  $('#consoleSend').disabled = !canType;
  input.placeholder = gameCaps(srv).stdinCommands === false
    ? 'This game has no server console commands'
    : 'Type a command and press Enter…';
}

function updateStatsUI() {
  const srv = currentServer();
  if (!srv) return;
  const caps = gameCaps(srv);
  const stats = srv.stats || { players: 0, maxPlayers: 0 };
  const playersChip = $('#detailPlayers');
  const ramChip = $('#detailRam');
  playersChip.style.display = caps.players ? '' : 'none';
  ramChip.style.display = caps.ram ? '' : 'none';
  if (caps.players) playersChip.textContent = `👥 ${stats.players}${stats.maxPlayers ? '/' + stats.maxPlayers : ''}`;
  if (caps.ram) ramChip.textContent = `🧠 ${(srv.maxRamMb / 1024).toFixed(srv.maxRamMb % 1024 ? 1 : 0)} GB`;
}

// ============================================================================
// Power toggle (start / stop)
// ============================================================================
// Detail-view toggle: also jump to the console when starting.
async function onPowerToggle(e) {
  const srv = currentServer();
  if (!srv) return;
  if (e.target.checked && (srv.state || 'stopped') === 'stopped') switchTab('console');
  await setServerPower(srv, e.target.checked, e.target);
}

/**
 * Shared start/stop logic for any toggle (detail header or a home card).
 * `toggleEl` is the checkbox driving it, so we can revert it on failure.
 */
async function setServerPower(srv, wantOn, toggleEl) {
  const st = srv.state || 'stopped';
  if (wantOn && st === 'stopped') {
    if (toggleEl) toggleEl.indeterminate = true;
    try {
      await call(api.startServer(srv.id));
    } catch {
      if (toggleEl) { toggleEl.checked = false; toggleEl.indeterminate = false; }
    }
  } else if (!wantOn && (st === 'running' || st === 'starting')) {
    if (toggleEl) toggleEl.indeterminate = true;
    try {
      await call(api.stopServer(srv.id, {}));
    } catch {
      if (state.view === 'home') renderHome(); else updatePowerUI();
    }
  } else {
    // Ignore clicks during a transition; re-sync the UI to true state.
    if (state.view === 'home') renderHome(); else updatePowerUI();
  }
}

// ============================================================================
// Tabs
// ============================================================================
function switchTab(tab) {
  state.activeTab = tab;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
  if (tab === 'console') loadConsole();
  else if (tab === 'connect') loadConnect();
  else if (tab === 'players') loadPlayers();
  else if (tab === 'commands') loadCommands();
  else if (tab === 'files') navigateFiles(state.filesCwd);
  else if (tab === 'content') loadContent();
  else if (tab === 'clientmods') loadClientMods();
  else if (tab === 'properties') loadProperties();
  else if (tab === 'backups') loadBackups();
  else if (tab === 'settings') renderSettings();
}

// ============================================================================
// Console
// ============================================================================
async function loadConsole() {
  const srv = currentServer();
  if (!srv) return;
  const out = $('#consoleOutput');
  out.innerHTML = '';
  state.renderedLogCount[srv.id] = 0;
  try {
    const buffer = await call(api.getLogBuffer(srv.id), { silent: true });
    for (const entry of buffer) appendLogLine(entry, false);
    state.renderedLogCount[srv.id] = buffer.length;
  } catch { /* ignore */ }
  out.scrollTop = out.scrollHeight;
  if (!srv.state || srv.state === 'stopped') {
    if (!$('#consoleOutput').children.length) {
      appendLogLine({ line: 'Server is stopped. Flip the toggle (top-right) to start it.', stream: 'sys', ts: Date.now() }, false);
    }
  }
}

function colorizeLevel(line) {
  // Highlight WARN/ERROR levels commonly found in MC logs.
  let cls = '';
  if (/\b(ERROR|SEVERE|FATAL)\b/.test(line)) cls = 'lvl-error';
  else if (/\bWARN(?:ING)?\b/.test(line)) cls = 'lvl-warn';
  return cls;
}

function appendLogLine(entry, autoscroll = true) {
  const out = $('#consoleOutput');
  const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  const cls = entry.stream === 'err' ? 'err' : entry.stream === 'sys' ? 'sys' : colorizeLevel(entry.line);
  const line = el('div', { class: `log-line ${cls}` }, entry.line);
  out.appendChild(line);
  // Trim DOM if it grows huge.
  while (out.children.length > 2200) out.removeChild(out.firstChild);
  if (autoscroll && nearBottom) out.scrollTop = out.scrollHeight;
}

async function onConsoleSubmit(e) {
  e.preventDefault();
  const srv = currentServer();
  const input = $('#consoleInput');
  const cmd = input.value.trim();
  if (!cmd || !srv) return;
  state.history[srv.id] = state.history[srv.id] || [];
  state.history[srv.id].push(cmd);
  state.historyIdx[srv.id] = state.history[srv.id].length;
  input.value = '';
  try {
    await call(api.sendCommand(srv.id, cmd));
  } catch { /* toast already shown */ }
}

function onConsoleKey(e) {
  const srv = currentServer();
  if (!srv) return;
  const hist = state.history[srv.id] || [];
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!hist.length) return;
    state.historyIdx[srv.id] = Math.max(0, (state.historyIdx[srv.id] ?? hist.length) - 1);
    e.target.value = hist[state.historyIdx[srv.id]] || '';
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!hist.length) return;
    state.historyIdx[srv.id] = Math.min(hist.length, (state.historyIdx[srv.id] ?? hist.length) + 1);
    e.target.value = hist[state.historyIdx[srv.id]] || '';
  }
}

// ============================================================================
// Players
// ============================================================================
const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];

async function loadPlayers() {
  const srv = currentServer();
  if (!srv) return;
  const list = $('#playersList');
  let data;
  try {
    data = await call(api.listPlayers(srv.id), { silent: true });
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(emptyList('⚠', err.message));
    return;
  }
  $('#playersRefresh').disabled = !data.running;
  if (!data.running) {
    $('#playersHint').textContent = 'Server is offline.';
    list.innerHTML = '';
    list.appendChild(emptyList('🛌', 'Start the server to manage online players.'));
    return;
  }
  $('#playersHint').textContent =
    `${data.online.length} online · op and gamemode changes apply instantly`;
  renderPlayers(srv, data);
}

function renderPlayers(srv, data) {
  const list = $('#playersList');
  list.innerHTML = '';
  if (!data.online.length) {
    list.appendChild(emptyList('👤', 'No players online right now.'));
    return;
  }
  const opSet = new Set(data.ops.map((n) => n.toLowerCase()));
  for (const name of data.online.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
    const isOp = opSet.has(name.toLowerCase());

    // gamemode dropdown — acts as a setter (the server doesn't report current mode)
    const gm = el('select', { class: 'player-gm', title: 'Set gamemode' },
      el('option', { value: '' }, 'Gamemode…'),
      ...GAMEMODES.map((m) => el('option', { value: m }, m[0].toUpperCase() + m.slice(1))));
    gm.addEventListener('change', async () => {
      const mode = gm.value;
      if (!mode) return;
      try {
        await call(api.sendCommand(srv.id, `gamemode ${mode} ${name}`));
        toast('Gamemode set', `${name} → ${mode}`);
      } catch { /* toast shown */ }
      gm.value = ''; // reset to placeholder; we can't read back their actual mode
    });

    // op toggle — reflects ops.json, sends op/deop
    const opToggle = el('input', { type: 'checkbox' });
    opToggle.checked = isOp;
    opToggle.addEventListener('change', async () => {
      try {
        await call(api.sendCommand(srv.id, `${opToggle.checked ? 'op' : 'deop'} ${name}`));
        toast(opToggle.checked ? 'Opped' : 'De-opped', name);
        setTimeout(loadPlayers, 500); // re-read ops.json to confirm
      } catch {
        opToggle.checked = isOp; // revert on failure
      }
    });

    const row = el('div', { class: 'content-row' },
      el('div', { class: 'cr-info' },
        el('div', { class: 'cr-name' }, name),
        el('div', { class: 'cr-meta' }, isOp ? '★ Operator' : 'Player')
      ),
      el('div', { class: 'player-controls' },
        gm,
        el('span', { class: 'op-label' }, 'OP'),
        el('label', { class: 'switch sm', title: isOp ? 'Remove operator' : 'Make operator' },
          opToggle, el('span', { class: 'slider' }))
      )
    );
    list.appendChild(row);
  }
}

// ============================================================================
// Quick commands
// ============================================================================
// A curated catalog of common admin actions. Each command has a `template`
// with {placeholders} (prefix ? = optional) filled from its labeled `fields`.
const QUICK_COMMANDS = [
  {
    category: 'Players',
    commands: [
      { icon: '✅', title: 'Whitelist a player', desc: 'Allow a player to join.', template: 'whitelist add {player}',
        fields: [{ key: 'player', label: 'Player', type: 'text', placeholder: 'Steve', required: true }] },
      { icon: '🚫', title: 'Remove from whitelist', desc: 'Revoke a player’s access.', template: 'whitelist remove {player}',
        fields: [{ key: 'player', label: 'Player', type: 'text', placeholder: 'Steve', required: true }] },
      { icon: '👢', title: 'Kick a player', desc: 'Disconnect someone (they can rejoin).', template: 'kick {player} {?reason}',
        fields: [
          { key: 'player', label: 'Player', type: 'text', placeholder: 'Steve', required: true },
          { key: 'reason', label: 'Reason (optional)', type: 'text', placeholder: 'Be nice!' }] },
      { icon: '🔨', title: 'Ban a player', desc: 'Block a player from the server.', template: 'ban {player} {?reason}',
        fields: [
          { key: 'player', label: 'Player', type: 'text', placeholder: 'Steve', required: true },
          { key: 'reason', label: 'Reason (optional)', type: 'text', placeholder: 'Griefing' }] },
      { icon: '🕊️', title: 'Unban a player', desc: 'Lift a ban.', template: 'pardon {player}',
        fields: [{ key: 'player', label: 'Player', type: 'text', placeholder: 'Steve', required: true }] },
      { icon: '📡', title: 'Teleport a player', desc: 'Send one player to another.', template: 'tp {player} {target}',
        fields: [
          { key: 'player', label: 'Player', type: 'text', placeholder: 'Steve', required: true },
          { key: 'target', label: 'To player', type: 'text', placeholder: 'Alex', required: true }] }
    ]
  },
  {
    category: 'World & weather',
    commands: [
      { icon: '🕒', title: 'Set the time', desc: 'Change the time of day.', template: 'time set {time}',
        fields: [{ key: 'time', label: 'Time', type: 'select', options: ['day', 'noon', 'night', 'midnight'], default: 'day' }] },
      { icon: '🌦️', title: 'Set the weather', desc: 'Change the weather.', template: 'weather {weather}',
        fields: [{ key: 'weather', label: 'Weather', type: 'select', options: ['clear', 'rain', 'thunder'], default: 'clear' }] },
      { icon: '⚔️', title: 'Set difficulty', desc: 'How hard the game is.', template: 'difficulty {difficulty}',
        fields: [{ key: 'difficulty', label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'], default: 'normal' }] },
      { icon: '🎮', title: 'Default gamemode', desc: 'Mode new players start in.', template: 'defaultgamemode {mode}',
        fields: [{ key: 'mode', label: 'Gamemode', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'], default: 'survival' }] },
      { icon: '📜', title: 'Whitelist on / off', desc: 'Require players to be whitelisted.', template: 'whitelist {state}',
        fields: [{ key: 'state', label: 'State', type: 'select', options: ['on', 'off'], default: 'on' }] },
      { icon: '⚙️', title: 'Set a game rule', desc: 'Toggle a world rule.', template: 'gamerule {rule} {value}',
        fields: [
          { key: 'rule', label: 'Rule', type: 'select', default: 'keepInventory',
            options: ['keepInventory', 'doDaylightCycle', 'doWeatherCycle', 'doMobSpawning', 'mobGriefing', 'doFireTick', 'doImmediateRespawn', 'announceAdvancements', 'showDeathMessages'] },
          { key: 'value', label: 'Value', type: 'select', options: ['true', 'false'], default: 'true' }] }
    ]
  },
  {
    category: 'Items & effects',
    commands: [
      { icon: '🎁', title: 'Give an item', desc: 'Give items to a player.', template: 'give {player} {item} {?count}',
        fields: [
          { key: 'player', label: 'Player', type: 'text', placeholder: 'Steve', required: true },
          { key: 'item', label: 'Item', type: 'text', placeholder: 'diamond', required: true },
          { key: 'count', label: 'Count', type: 'number', placeholder: '1' }] },
      { icon: '⭐', title: 'Give XP', desc: 'Add experience points.', template: 'xp add {player} {amount}',
        fields: [
          { key: 'player', label: 'Player', type: 'text', placeholder: 'Steve', required: true },
          { key: 'amount', label: 'Amount', type: 'number', placeholder: '100', required: true }] },
      { icon: '✨', title: 'Apply an effect', desc: 'Give a potion effect.', template: 'effect give {player} {effect} {?seconds} {?amplifier}',
        fields: [
          { key: 'player', label: 'Player', type: 'text', placeholder: 'Steve', required: true },
          { key: 'effect', label: 'Effect', type: 'text', placeholder: 'speed', required: true },
          { key: 'seconds', label: 'Seconds', type: 'number', placeholder: '30' },
          { key: 'amplifier', label: 'Level', type: 'number', placeholder: '1' }] },
      { icon: '🧹', title: 'Clear inventory', desc: 'Empty a player’s inventory.', template: 'clear {player}',
        fields: [{ key: 'player', label: 'Player', type: 'text', placeholder: 'Steve', required: true }] },
      { icon: '🪄', title: 'Enchant held item', desc: 'Enchant what a player is holding.', template: 'enchant {player} {enchantment} {?level}',
        fields: [
          { key: 'player', label: 'Player', type: 'text', placeholder: 'Steve', required: true },
          { key: 'enchantment', label: 'Enchantment', type: 'text', placeholder: 'sharpness', required: true },
          { key: 'level', label: 'Level', type: 'number', placeholder: '1' }] }
    ]
  },
  {
    category: 'Server',
    commands: [
      { icon: '📢', title: 'Broadcast a message', desc: 'Send a message to everyone.', template: 'say {message}',
        fields: [{ key: 'message', label: 'Message', type: 'text', placeholder: 'Server restarting in 5 min!', required: true }] },
      { icon: '💾', title: 'Save the world', desc: 'Force-save now.', template: 'save-all', fields: [] },
      { icon: '🏠', title: 'Set world spawn', desc: 'Make the current spot the spawn.', template: 'setworldspawn', fields: [] }
    ]
  }
];

/** Fill a template's {placeholders} from field values; {?x} are optional. */
function buildQuickCommand(template, values) {
  const filled = template.replace(/\{\??(\w+)\}/g, (_m, key) => (values[key] ?? '').toString().trim());
  return filled.replace(/\s+/g, ' ').trim();
}

// Fields that name a player get name autocomplete (via a shared <datalist>).
function isPlayerField(f) {
  return f.type !== 'select' && (f.key === 'player' || f.key === 'target');
}

function loadCommands() {
  const srv = currentServer();
  if (!srv) return;
  const running = (srv.state || 'stopped') === 'running';

  const banner = $('#commandsBanner');
  banner.innerHTML = '';
  if (!running) {
    banner.appendChild(el('div', { class: 'banner warn', style: 'margin:16px 24px 0' },
      el('span', {}, 'The server is offline. Start it to run commands — you can still fill these in to see what they’ll do.')));
  }

  const body = $('#commandsBody');
  body.innerHTML = '';
  // Shared autocomplete source for all player-name fields; filled in async.
  body.appendChild(el('datalist', { id: 'cmdPlayerList' }));
  for (const group of QUICK_COMMANDS) {
    const section = el('div', { class: 'cmd-cat' }, el('h3', {}, group.category));
    const grid = el('div', { class: 'cmd-grid' });
    for (const cmd of group.commands) grid.appendChild(buildCommandCard(srv, cmd, running));
    section.appendChild(grid);
    body.appendChild(section);
  }
  refreshCommandPlayers();
}

// Refresh ONLY the player-name suggestions (online players + operators), so the
// list stays current as people join/leave without wiping half-typed commands.
async function refreshCommandPlayers() {
  const srv = currentServer();
  const dl = document.getElementById('cmdPlayerList');
  if (!srv || !dl) return;
  try {
    const data = await call(api.listPlayers(srv.id), { silent: true });
    const names = [...new Set([...(data.online || []), ...(data.ops || [])])]
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    dl.innerHTML = '';
    for (const n of names) dl.appendChild(el('option', { value: n }));
  } catch { /* no suggestions available */ }
}

function buildCommandCard(srv, cmd, running) {
  const values = {};
  const inputs = [];

  const fieldsWrap = el('div', { class: 'cmd-fields' });
  for (const f of cmd.fields) {
    let input;
    if (f.type === 'select') {
      input = el('select', {}, ...f.options.map((o) => el('option', { value: o }, o)));
      input.value = f.default ?? f.options[0];
      values[f.key] = input.value;
    } else {
      const attrs = { type: f.type === 'number' ? 'number' : 'text', placeholder: f.placeholder || '' };
      if (isPlayerField(f)) { attrs.list = 'cmdPlayerList'; attrs.autocomplete = 'off'; }
      input = el('input', attrs);
      values[f.key] = '';
    }
    input.dataset.key = f.key;
    input.addEventListener('input', refresh);
    input.addEventListener('change', refresh);
    inputs.push({ f, input });
    fieldsWrap.appendChild(el('label', { class: 'cmd-field' }, el('span', {}, f.label), input));
  }

  const preview = el('code', { class: 'cmd-preview' });
  const runBtn = el('button', { class: 'primary-btn small', onclick: doRun }, 'Run');

  function collect() {
    for (const { f, input } of inputs) values[f.key] = input.value;
    return values;
  }
  function missingRequired() {
    return cmd.fields.some((f) => f.required && !((values[f.key] ?? '').toString().trim()));
  }
  function refresh() {
    collect();
    preview.textContent = '/' + buildQuickCommand(cmd.template, values);
    runBtn.disabled = !running || missingRequired();
  }
  async function doRun() {
    collect();
    if (missingRequired()) { toast('Fill required fields', '', 'warn'); return; }
    const command = buildQuickCommand(cmd.template, values);
    try {
      await call(api.sendCommand(srv.id, command));
      toast('Command sent', '/' + command);
    } catch { /* toast shown (e.g. not running) */ }
  }
  refresh();

  return el('div', { class: 'cmd-card' },
    el('div', { class: 'cmd-head' }, el('span', { class: 'cmd-icon' }, cmd.icon), el('span', {}, cmd.title)),
    el('div', { class: 'cmd-desc' }, cmd.desc),
    cmd.fields.length ? fieldsWrap : null,
    el('div', { class: 'cmd-foot' }, preview, runBtn)
  );
}

// ============================================================================
// Connect / share (how players join + port-forwarding help)
// ============================================================================
async function copyText(text, btn) {
  try {
    await call(api.copyText(text), { silent: true });
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1300); }
    else toast('Copied', text);
  } catch { toast('Copy failed', '', 'error'); }
}

function addressRow(addr) {
  const code = el('code', { class: 'addr' }, addr);
  const btn = el('button', { class: 'primary-btn small' }, 'Copy');
  btn.addEventListener('click', () => copyText(addr, btn));
  return el('div', { class: 'addr-slot' }, code, btn);
}

async function loadConnect() {
  const srv = currentServer();
  if (!srv) return;
  const body = $('#connectBody');
  body.innerHTML = '';
  body.appendChild(el('div', { class: 'muted', style: 'padding:20px 24px' }, 'Finding your network details…'));

  let info;
  try { info = await call(api.netAddresses(srv.id), { silent: true }); }
  catch (err) { body.innerHTML = ''; body.appendChild(emptyList('⚠', err.message)); return; }

  const port = info.port || 25565;
  const local = info.local;
  body.innerHTML = '';

  body.appendChild(el('div', { class: 'connect-head' },
    el('h2', {}, 'Share your server'),
    el('p', { class: 'muted' },
      'Send a friend one of these addresses to join. Start the server first, then pick the option that matches where your friend is.')));

  // --- same network ---
  const localCard = el('div', { class: 'connect-card' },
    el('div', { class: 'cc-head' }, el('span', { class: 'cc-icon' }, '🏠'),
      el('h3', {}, 'Friends on the same Wi‑Fi')));
  localCard.appendChild(local ? addressRow(`${local}:${port}`)
    : el('div', { class: 'muted' }, 'Couldn’t detect a local network address.'));
  localCard.appendChild(el('p', { class: 'cc-desc' },
    'The easy one: anyone connected to the same home router as this computer can use this right away — no setup needed.'));
  if (srv.game === 'minecraft' && port === 25565) {
    localCard.appendChild(el('p', { class: 'cc-note' }, 'Tip: 25565 is Minecraft’s default port, so friends can leave the “:25565” off if they like.'));
  }
  body.appendChild(localCard);

  // --- over the internet ---
  const pubCard = el('div', { class: 'connect-card' },
    el('div', { class: 'cc-head' }, el('span', { class: 'cc-icon' }, '🌍'),
      el('h3', {}, 'Friends somewhere else (over the internet)')));
  const pubSlot = el('div', { class: 'addr-slot' }, el('span', { class: 'muted' }, 'Looking up your public address…'));
  pubCard.appendChild(pubSlot);
  pubCard.appendChild(el('p', { class: 'cc-desc' },
    'For friends outside your home, share your public address. ',
    el('b', {}, 'This usually needs a one-time “port forwarding” setup on your router'),
    ' (steps below) — without it, outside friends won’t be able to connect.'));
  body.appendChild(pubCard);

  api.netPublicIp().then((r) => {
    pubSlot.innerHTML = '';
    if (r && r.ok) {
      pubSlot.appendChild(addressRow(`${r.data}:${port}`));
    } else {
      const retry = el('a', {}, 'Try again');
      retry.addEventListener('click', loadConnect);
      pubSlot.appendChild(el('div', { class: 'muted' }, '⚠ Couldn’t look up your public address — check your internet connection. ', retry));
    }
  });

  // --- port forwarding explainer ---
  body.appendChild(buildPortForwardHelp(info, port));
}

function buildPortForwardHelp(info, port) {
  const card = el('div', { class: 'connect-card pf' },
    el('div', { class: 'cc-head' }, el('span', { class: 'cc-icon' }, '🔌'),
      el('h3', {}, 'How to set up port forwarding')));
  card.appendChild(el('p', { class: 'cc-desc' },
    'Port forwarding tells your home router to send Minecraft players to this computer. It’s a one‑time setup:'));

  const gw = info.gateway;
  const routerLink = gw
    ? (() => { const a = el('a', {}, 'http://' + gw); a.addEventListener('click', () => api.openExternal('http://' + gw)); return a; })()
    : document.createTextNode('http://192.168.0.1');

  card.appendChild(el('ol', { class: 'pf-steps' },
    el('li', {}, 'Open your router’s settings in a web browser. Try ', routerLink,
      ' — the address and login are often printed on a sticker on the router.'),
    el('li', {}, 'Find the ', el('b', {}, 'Port Forwarding'), ' section (sometimes under “Advanced”, “NAT”, or “Gaming”).'),
    el('li', {}, 'Add a rule that forwards port ', el('b', {}, String(port)), ' (protocol ', el('b', {}, 'TCP'),
      ', or choose “Both”) to this computer',
      info.local ? el('span', {}, ' — local address ', el('b', {}, info.local)) : null, '.'),
    el('li', {}, 'Save / apply. Friends can now use your public address above.')));

  card.appendChild(el('div', { class: 'pf-tips' },
    el('p', {}, '💡 Your public address can change over time. If outside friends suddenly can’t connect, reopen this tab to get the new one.'),
    el('p', {}, '🛡️ Opening a port lets anyone on the internet reach your server. Keep the server updated and consider turning on the whitelist (Properties tab).'),
    (() => {
      const playit = el('a', {}, 'playit.gg');
      playit.addEventListener('click', () => api.openExternal('https://playit.gg'));
      return el('p', {}, '🚀 Don’t want to touch your router? A free tool like ', playit,
        ' gives you a shareable address without port forwarding. It’s also the fix if forwarding looks correct but still doesn’t work (some internet providers use “CGNAT”). Not affiliated.');
    })()));
  return card;
}

// ============================================================================
// Files
// ============================================================================
function parentPath(p) {
  if (!p || p === '.' || p === '') return '.';
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? parts.join('/') : '.';
}
function joinPath(a, b) {
  if (!a || a === '.') return b;
  return `${a}/${b}`;
}

async function navigateFiles(rel) {
  const srv = currentServer();
  if (!srv) return;
  if (!srv.directory) {
    $('#fileList').innerHTML = '';
    $('#fileList').appendChild(emptyList('🗀', 'No directory set. Open the Settings tab to choose a server folder.'));
    $('#breadcrumb').textContent = '';
    return;
  }
  state.filesCwd = rel || '.';
  renderBreadcrumb();
  try {
    const entries = await call(api.listFiles(srv.id, state.filesCwd));
    renderFileList(entries);
  } catch (err) {
    $('#fileList').innerHTML = '';
    $('#fileList').appendChild(emptyList('⚠', err.message));
  }
}

function renderBreadcrumb() {
  const bc = $('#breadcrumb');
  bc.innerHTML = '';
  const parts = state.filesCwd === '.' ? [] : state.filesCwd.split('/').filter(Boolean);
  bc.appendChild(el('span', { class: 'crumb', onclick: () => navigateFiles('.') }, '⌂ root'));
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const here = acc;
    bc.appendChild(document.createTextNode(' / '));
    bc.appendChild(el('span', { class: 'crumb', onclick: () => navigateFiles(here) }, part));
  }
}

function emptyList(icon, text) {
  return el('div', { class: 'empty-list' }, el('div', { class: 'el-icon' }, icon), el('div', {}, text));
}

function renderFileList(entries) {
  const list = $('#fileList');
  list.innerHTML = '';
  if (!entries.length) {
    list.appendChild(emptyList('🗀', 'This folder is empty.'));
    return;
  }
  for (const entry of entries) {
    const rel = joinPath(state.filesCwd, entry.name);
    const icon = entry.isDir ? '🗀' : entry.textual ? '🗎' : '🧱';
    const row = el('div', {
      class: 'file-row' + (state.openFile === rel ? ' selected' : ''),
      ondblclick: () => entry.isDir ? navigateFiles(rel) : (entry.textual ? openFileInEditor(rel) : null)
    },
      el('span', { class: 'fi-icon' }, icon),
      el('span', { class: 'fi-name' }, entry.name),
      !entry.isDir ? el('span', { class: 'fi-size' }, fmtSize(entry.size)) : el('span', { class: 'fi-size' }, ''),
      el('span', { class: 'fi-actions' },
        el('button', { class: 'fi-act', title: 'Rename', onclick: (e) => { e.stopPropagation(); renameEntry(rel, entry.name); } }, '✎'),
        el('button', { class: 'fi-act', title: 'Delete', onclick: (e) => { e.stopPropagation(); deleteEntry(rel, entry.name); } }, '🗑')
      )
    );
    row.addEventListener('click', () => {
      if (entry.isDir) navigateFiles(rel);
      else if (entry.textual) openFileInEditor(rel);
      else toast('Not editable', `${entry.name} looks like a binary file.`, 'warn');
    });
    list.appendChild(row);
  }
}

async function openFileInEditor(rel) {
  const srv = currentServer();
  if (state.fileDirty && !(await confirmDiscard())) return;
  try {
    const content = await call(api.readFile(srv.id, rel));
    state.openFile = rel;
    state.fileDirty = false;
    $('#editorArea').disabled = false;
    $('#editorArea').value = content;
    $('#editorPath').textContent = rel;
    $('#editorSave').disabled = true;
    renderBreadcrumb();
    // refresh selection highlight
    navigateFiles(state.filesCwd);
  } catch { /* toast shown */ }
}

async function confirmDiscard() {
  return confirmModal('Discard unsaved changes?',
    'You have unsaved edits in the current file. Switching will lose them.',
    { danger: true, confirmLabel: 'Discard' });
}

async function saveOpenFile() {
  const srv = currentServer();
  if (!srv || !state.openFile) return;
  try {
    await call(api.writeFile(srv.id, state.openFile, $('#editorArea').value));
    state.fileDirty = false;
    $('#editorSave').disabled = true;
    toast('Saved', state.openFile);
  } catch { /* toast shown */ }
}

async function onNewFile() {
  const srv = currentServer();
  if (!srv || !srv.directory) return toast('No directory', 'Set a server folder first.', 'warn');
  const name = await promptModal('New file', { label: 'File name', placeholder: 'config.yml', confirmLabel: 'Create' });
  if (!name) return;
  try {
    await call(api.touch(srv.id, joinPath(state.filesCwd, name)));
    await navigateFiles(state.filesCwd);
  } catch { /* shown */ }
}

async function onNewFolder() {
  const srv = currentServer();
  if (!srv || !srv.directory) return toast('No directory', 'Set a server folder first.', 'warn');
  const name = await promptModal('New folder', { label: 'Folder name', placeholder: 'datapacks', confirmLabel: 'Create' });
  if (!name) return;
  try {
    await call(api.mkdir(srv.id, joinPath(state.filesCwd, name)));
    await navigateFiles(state.filesCwd);
  } catch { /* shown */ }
}

async function onImportFiles() {
  const srv = currentServer();
  if (!srv || !srv.directory) return toast('No directory', 'Set a server folder first.', 'warn');
  try {
    const imported = await call(api.importFiles(srv.id, state.filesCwd));
    if (imported.length) {
      toast('Imported', `${imported.length} file(s) added to this folder.`);
      await navigateFiles(state.filesCwd);
    }
  } catch { /* shown */ }
}

async function renameEntry(rel, oldName) {
  const srv = currentServer();
  const name = await promptModal('Rename', { label: 'New name', value: oldName, confirmLabel: 'Rename' });
  if (!name || name === oldName) return;
  try {
    await call(api.renameFile(srv.id, rel, name));
    if (state.openFile === rel) { state.openFile = null; clearEditor(); }
    await navigateFiles(state.filesCwd);
  } catch { /* shown */ }
}

async function deleteEntry(rel, name) {
  const srv = currentServer();
  if (!(await confirmModal('Delete?', `Permanently delete "${name}"? This cannot be undone.`,
    { danger: true, confirmLabel: 'Delete' }))) return;
  try {
    await call(api.removeFile(srv.id, rel));
    if (state.openFile === rel) { state.openFile = null; clearEditor(); }
    await navigateFiles(state.filesCwd);
  } catch { /* shown */ }
}

function clearEditor() {
  state.fileDirty = false;
  $('#editorArea').value = '';
  $('#editorArea').disabled = true;
  $('#editorPath').textContent = 'No file open';
  $('#editorSave').disabled = true;
}

// ============================================================================
// Mods / Plugins
// ============================================================================
function browsableType(type) {
  return PLUGIN_TYPES.has(type) || MOD_TYPES.has(type);
}

async function loadContent() {
  const srv = currentServer();
  if (!srv) return;
  const list = $('#contentList');
  $('#contentTitle').textContent = contentLabel(srv.type);
  // Modrinth browsing only works for plugin/mod loaders, not vanilla.
  $('#browseContentBtn').style.display = browsableType(srv.type) ? '' : 'none';
  if (!srv.directory) {
    $('#contentHint').textContent = '';
    list.innerHTML = '';
    list.appendChild(emptyList('🗀', 'Set a server folder in Settings first.'));
    return;
  }
  try {
    const data = await call(api.listContent(srv.id));
    $('#contentHint').textContent =
      `Folder: ${data.dir}/  ·  ${data.items.length} item(s)` +
      (data.vanilla ? '  ·  Note: vanilla servers don’t load mods — switch the server type if you use Forge/Fabric/Paper.' : '');
    renderContentList(data);
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(emptyList('⚠', err.message));
  }
}

function renderContentList(data) {
  const list = $('#contentList');
  list.innerHTML = '';
  if (!data.items.length) {
    list.appendChild(emptyList('🧩', `No ${data.label.toLowerCase()} yet. Click “Add” to install .jar files.`));
    return;
  }
  for (const item of data.items) {
    const srv = currentServer();
    const sw = el('input', { type: 'checkbox' });
    sw.checked = item.enabled;
    sw.addEventListener('change', async () => {
      try {
        await call(api.toggleContent(srv.id, item.name, sw.checked));
        await loadContent();
      } catch { sw.checked = item.enabled; }
    });
    const row = el('div', { class: 'content-row' + (item.enabled ? '' : ' disabled') },
      el('div', { class: 'cr-info' },
        el('div', { class: 'cr-name' }, item.displayName),
        el('div', { class: 'cr-meta' }, `${fmtSize(item.size)}${item.enabled ? '' : '  ·  disabled'}`)
      ),
      el('label', { class: 'switch sm', title: item.enabled ? 'Disable' : 'Enable' }, sw, el('span', { class: 'slider' })),
      el('button', { class: 'icon-btn', title: 'Delete', onclick: () => deleteContent(item) }, '🗑')
    );
    list.appendChild(row);
  }
}

async function onAddContent() {
  const srv = currentServer();
  if (!srv || !srv.directory) return toast('No directory', 'Set a server folder first.', 'warn');
  try {
    const added = await call(api.addContent(srv.id));
    if (added.length) {
      toast('Added', `${added.length} file(s) installed.`);
      await loadContent();
    }
  } catch { /* shown */ }
}

async function deleteContent(item) {
  const srv = currentServer();
  if (!(await confirmModal('Delete?', `Remove "${item.displayName}"?`, { danger: true, confirmLabel: 'Delete' }))) return;
  try {
    await call(api.removeContent(srv.id, item.name));
    await loadContent();
  } catch { /* shown */ }
}

// ============================================================================
// Modrinth browser — search + one-click install of mods/plugins
// ============================================================================
function openModrinthBrowser() {
  const srv = currentServer();
  if (!srv) return;
  if (!srv.directory) { toast('No folder', 'Set a server folder first.', 'warn'); return; }

  const input = el('input', { type: 'text', placeholder: 'Search… (e.g. WorldEdit, EssentialsX, Sodium)' });
  const matchCb = el('input', { type: 'checkbox' });
  const matchLabel = el('span', {}, 'Only show builds for my Minecraft version');
  const matchWrap = el('label', { class: 'mr-vfilter' }, matchCb, matchLabel);
  const results = el('div', { class: 'mr-results' }, el('div', { class: 'muted', style: 'padding:16px' }, 'Loading…'));
  const body = el('div', {},
    el('div', { class: 'mr-search' }, input),
    matchWrap,
    results,
    el('div', { class: 'hint', style: 'margin-top:10px' }, 'Results from ',
      (() => { const a = el('a', {}, 'Modrinth'); a.addEventListener('click', () => api.openExternal('https://modrinth.com')); return a; })(),
      ' — filtered to your server’s type. Installs the newest compatible build into your ', contentLabel(srv.type).toLowerCase(), ' folder.'));

  modal({ title: `Browse ${contentLabel(srv.type).toLowerCase()}`, body, wide: true, actions: [{ label: 'Done', class: 'ghost-btn' }] });

  const getMatch = () => matchCb.checked;
  let seq = 0;
  async function doSearch() {
    const mine = ++seq;
    results.innerHTML = '';
    results.appendChild(el('div', { class: 'muted', style: 'padding:16px' }, 'Searching…'));
    try {
      const data = await call(api.modrinthSearch(srv.id, input.value, matchCb.checked), { silent: true });
      if (mine !== seq) return; // a newer search superseded this one
      // Update the toggle from the server's detected Minecraft version.
      if (data.gameVersion) {
        matchLabel.textContent = `Only show builds for Minecraft ${data.gameVersion}`;
        matchCb.disabled = false; matchWrap.classList.remove('disabled');
      } else {
        matchLabel.textContent = 'Couldn’t detect your Minecraft version — pick a server jar in Settings';
        matchCb.checked = false; matchCb.disabled = true; matchWrap.classList.add('disabled');
      }
      renderModrinthResults(srv, results, data.hits, getMatch);
    } catch (err) {
      if (mine !== seq) return;
      results.innerHTML = '';
      results.appendChild(emptyList('⚠', err.message));
    }
  }
  matchCb.addEventListener('change', doSearch);
  let t = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(doSearch, 350); });
  setTimeout(() => input.focus(), 30);
  doSearch(); // initial popular results
}

function renderModrinthResults(srv, container, hits, getMatch) {
  container.innerHTML = '';
  if (!hits.length) { container.appendChild(emptyList('🔍', 'No matches — try a different search.')); return; }
  for (const h of hits) {
    const installBtn = el('button', { class: 'primary-btn small' }, 'Install');
    installBtn.addEventListener('click', async () => {
      const orig = installBtn.textContent;
      installBtn.disabled = true; installBtn.textContent = 'Installing…';
      const unsub = api.onModrinthProgress((p) => {
        if (p.projectId === h.projectId && p.total) installBtn.textContent = `${Math.round((p.received / p.total) * 100)}%`;
      });
      try {
        const r = await call(api.modrinthInstall(srv.id, h.projectId, getMatch ? getMatch() : false));
        unsub();
        installBtn.textContent = '✓ Installed';
        toast('Installed', `${h.title} (${r.versionNumber})`);
        loadContent(); // refresh the list behind the modal
      } catch {
        unsub();
        installBtn.disabled = false; installBtn.textContent = orig;
      }
    });

    const icon = h.icon
      ? el('img', { class: 'mr-icon', src: h.icon, alt: '', loading: 'lazy' })
      : el('div', { class: 'mr-icon mr-icon-ph' }, '🧩');
    container.appendChild(el('div', { class: 'mr-row' },
      icon,
      el('div', { class: 'mr-info' },
        el('div', { class: 'mr-title' }, h.title, el('span', { class: 'mr-author' }, ` by ${h.author}`)),
        el('div', { class: 'mr-desc' }, h.description || ''),
        el('div', { class: 'mr-meta' }, `⬇ ${Number(h.downloads).toLocaleString()} downloads`)),
      installBtn));
  }
}

// ============================================================================
// Client-side mod profile — the mods a player needs locally to join this
// server, plus one-click "apply to my Minecraft".
// ============================================================================
let clientModsCache = null; // last { entries, minecraftDir, targets, … } for the Apply modal

async function loadClientMods() {
  const srv = currentServer();
  if (!srv) return;
  const list = $('#clientModsList');
  try {
    const data = await call(api.clientModsList(srv.id));
    clientModsCache = data;
    const n = data.entries.length;
    $('#clientModsHint').textContent =
      `${n} mod${n === 1 ? '' : 's'} in this server’s profile  ·  Minecraft: ${data.minecraftDir}` +
      (data.minecraftExists ? '' : '  ·  ⚠ not found — set it in ⚙ App settings');
    $('#applyClientModsBtn').disabled = n === 0;
    renderClientModsList(srv, data);
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(emptyList('⚠', err.message));
  }
}

function renderClientModsList(srv, data) {
  const list = $('#clientModsList');
  list.innerHTML = '';
  if (!data.entries.length) {
    list.appendChild(emptyList('🎒',
      'No client mods yet. Click “Browse” to find client-side mods on Modrinth (or “Add from disk”), then “Apply to my Minecraft”.'));
    return;
  }
  for (const item of data.entries) {
    const meta = [fmtSize(item.size)];
    if (item.versionNumber) meta.push(item.versionNumber);
    if (item.source === 'local') meta.push('local file');
    if (!item.cached) meta.push('⚠ download missing');
    const row = el('div', { class: 'content-row' + (item.cached ? '' : ' disabled') },
      el('div', { class: 'cr-info' },
        el('div', { class: 'cr-name' }, item.title || item.filename),
        el('div', { class: 'cr-meta' }, meta.join('  ·  '))
      ),
      el('button', { class: 'icon-btn', title: 'Remove from profile', onclick: () => removeClientMod(item) }, '🗑')
    );
    list.appendChild(row);
  }
}

async function onAddClientModLocal() {
  const srv = currentServer();
  if (!srv) return;
  try {
    const added = await call(api.clientModsAddLocal(srv.id));
    if (added.length) {
      toast('Added', `${added.length} mod(s) added to the profile.`);
      await loadClientMods();
    }
  } catch { /* shown */ }
}

async function removeClientMod(item) {
  const srv = currentServer();
  if (!(await confirmModal('Remove?', `Remove "${item.title || item.filename}" from this server’s client profile?`,
    { danger: true, confirmLabel: 'Remove' }))) return;
  try {
    await call(api.clientModsRemove(srv.id, item.filename));
    await loadClientMods();
  } catch { /* shown */ }
}

// Client loaders offered by the browser. The player picks this — it's their
// client's loader, not the server's software (Fabric mods work when joining a
// vanilla/Paper server too).
const CLIENT_LOADERS = [
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' }
];
function defaultClientLoader(type) { return MOD_TYPES.has(type) ? type : 'fabric'; }

// Browse Modrinth for *client-side* mods and add them to the profile (downloads
// now, so applying later is offline). Available for any Minecraft server.
function openClientModsBrowser() {
  const srv = currentServer();
  if (!srv) return;

  const loaderSelect = el('select', {}, ...CLIENT_LOADERS.map((l) => el('option', { value: l.value }, l.label)));
  loaderSelect.value = defaultClientLoader(srv.type);
  const loaderRow = el('label', { class: 'cm-loader' }, el('span', {}, 'Client loader'), loaderSelect);

  const input = el('input', { type: 'text', placeholder: 'Search… (e.g. Sodium, Iris, JEI, Fabric API)' });
  const matchCb = el('input', { type: 'checkbox' });
  const matchLabel = el('span', {}, 'Only show builds for my Minecraft version');
  const matchWrap = el('label', { class: 'mr-vfilter' }, matchCb, matchLabel);
  const results = el('div', { class: 'mr-results' }, el('div', { class: 'muted', style: 'padding:16px' }, 'Loading…'));
  const body = el('div', {},
    el('div', { class: 'mr-search' }, input),
    el('div', { class: 'cm-filters' }, loaderRow, matchWrap),
    results,
    el('div', { class: 'hint', style: 'margin-top:10px' }, 'Client-side mods from ',
      link('Modrinth', 'https://modrinth.com'),
      ' — only mods that run on the client are shown, for the loader you pick. Added mods go into this server’s profile; use ',
      el('b', {}, 'Apply to my Minecraft'), ' to install them.'));

  modal({ title: 'Add client mods', body, wide: true, actions: [{ label: 'Done', class: 'ghost-btn' }] });

  const getMatch = () => matchCb.checked;
  const getLoader = () => loaderSelect.value;
  let seq = 0;
  async function doSearch() {
    const mine = ++seq;
    results.innerHTML = '';
    results.appendChild(el('div', { class: 'muted', style: 'padding:16px' }, 'Searching…'));
    try {
      const data = await call(api.clientModsSearch(srv.id, input.value, matchCb.checked, getLoader()), { silent: true });
      if (mine !== seq) return;
      if (data.gameVersion) {
        matchLabel.textContent = `Only show builds for Minecraft ${data.gameVersion}`;
        matchCb.disabled = false; matchWrap.classList.remove('disabled');
      } else {
        matchLabel.textContent = 'Couldn’t detect your Minecraft version — pick a server jar in Settings';
        matchCb.checked = false; matchCb.disabled = true; matchWrap.classList.add('disabled');
      }
      renderClientModrinthResults(srv, results, data.hits, getMatch, getLoader);
    } catch (err) {
      if (mine !== seq) return;
      results.innerHTML = '';
      results.appendChild(emptyList('⚠', err.message));
    }
  }
  matchCb.addEventListener('change', doSearch);
  loaderSelect.addEventListener('change', doSearch);
  let t = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(doSearch, 350); });
  setTimeout(() => input.focus(), 30);
  doSearch();
}

function renderClientModrinthResults(srv, container, hits, getMatch, getLoader) {
  container.innerHTML = '';
  if (!hits.length) { container.appendChild(emptyList('🔍', 'No matches — try a different search.')); return; }
  for (const h of hits) {
    const addBtn = el('button', { class: 'primary-btn small' }, 'Add');
    addBtn.addEventListener('click', async () => {
      const orig = addBtn.textContent;
      addBtn.disabled = true; addBtn.textContent = 'Adding…';
      const unsub = api.onClientModsProgress((p) => {
        if (p.projectId === h.projectId && p.total) addBtn.textContent = `${Math.round((p.received / p.total) * 100)}%`;
      });
      try {
        const r = await call(api.clientModsAdd(srv.id, h.projectId, getMatch ? getMatch() : false, getLoader ? getLoader() : undefined));
        unsub();
        addBtn.textContent = '✓ Added';
        toast('Added to profile', `${h.title} (${r.versionNumber})`);
        loadClientMods(); // refresh the list behind the modal
      } catch {
        unsub();
        addBtn.disabled = false; addBtn.textContent = orig;
      }
    });

    const icon = h.icon
      ? el('img', { class: 'mr-icon', src: h.icon, alt: '', loading: 'lazy' })
      : el('div', { class: 'mr-icon mr-icon-ph' }, '🎒');
    container.appendChild(el('div', { class: 'mr-row' },
      icon,
      el('div', { class: 'mr-info' },
        el('div', { class: 'mr-title' }, h.title, el('span', { class: 'mr-author' }, ` by ${h.author}`)),
        el('div', { class: 'mr-desc' }, h.description || ''),
        el('div', { class: 'mr-meta' }, `⬇ ${Number(h.downloads).toLocaleString()} downloads`)),
      addBtn));
  }
}

// Choose a target Minecraft folder and install the profile into it.
async function openApplyClientModsModal() {
  const srv = currentServer();
  if (!srv) return;
  const data = clientModsCache || await call(api.clientModsList(srv.id)).catch(() => null);
  if (!data) return;
  if (!data.entries.length) return toast('Nothing to apply', 'Add some client mods first.', 'warn');

  // Radio: isolated (safe, default) vs the real .minecraft/mods (backs up first).
  const isoRadio = el('input', { type: 'radio', name: 'cmTarget', value: 'isolated', checked: true });
  const mainRadio = el('input', { type: 'radio', name: 'cmTarget', value: 'main' });
  const pick = (radio, title, desc) =>
    el('label', { class: 'cm-target' }, radio,
      el('div', {}, el('div', { class: 'cm-target-title' }, title), el('div', { class: 'hint' }, desc)));

  const body = el('div', {},
    el('p', { class: 'muted' }, `Install this server’s ${data.entries.length} client mod(s) into Minecraft.`),
    pick(isoRadio, 'Its own profile folder (recommended)',
      `Creates an isolated install VoxelDeck keeps in sync: ${data.targets.isolated}. In your launcher, add a profile whose game directory is that folder’s parent.`),
    pick(mainRadio, 'My main Minecraft (.minecraft/mods)',
      `Installs into ${data.targets.main}. Any mods already there are moved to a timestamped backup folder first, so it’s reversible.`),
    data.minecraftExists ? null
      : el('div', { class: 'hint', style: 'margin-top:8px' }, '⚠ That Minecraft folder doesn’t exist yet — it’ll be created. Set a different one in ⚙ App settings.'));

  modal({
    title: 'Apply to my Minecraft',
    body,
    actions: [
      { label: 'Cancel', class: 'ghost-btn' },
      { label: 'Apply', class: 'primary-btn', onClick: async () => {
        const target = mainRadio.checked ? 'main' : 'isolated';
        try {
          const r = await call(api.clientModsApply(srv.id, target));
          const extra = r.backupDir ? ` ${r.backedUp.length} existing mod(s) backed up.` : '';
          toast('Applied', `${r.installed.length} mod(s) installed to ${r.modsDir}.${extra}`);
          await call(api.openPath(r.modsDir), { silent: true }).catch(() => {});
        } catch { return true; /* keep modal open on failure */ }
      } }
    ]
  });
}

// ============================================================================
// Backups — zip the whole server folder; restore or delete past snapshots.
// ============================================================================
let backupBusy = false;

function fmtBackupDate(ts) {
  try { return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return new Date(ts).toString(); }
}

function backupPhaseText(p) {
  if (p.phase === 'safety') return 'Saving a safety copy of the current world first…';
  if (p.phase === 'archiving') return `Archiving… ${p.done}/${p.total} files`;
  if (p.phase === 'writing') return 'Writing the archive to disk…';
  if (p.phase === 'restoring') return `Restoring… ${p.done}/${p.total} files`;
  return 'Working…';
}

async function loadBackups() {
  const srv = currentServer();
  if (!srv) return;
  const list = $('#backupsList');
  $('#backupSchedule').innerHTML = '';
  if (!srv.directory) {
    $('#backupsHint').textContent = '';
    list.innerHTML = '';
    list.appendChild(emptyList('🗀', 'Set a server folder in Settings first.'));
    return;
  }
  $('#backupSchedule').appendChild(renderBackupSchedule(srv));
  try {
    const data = await call(api.backupsList(srv.id));
    const n = data.entries.length;
    $('#backupsHint').textContent =
      `${n} backup${n === 1 ? '' : 's'}  ·  ${data.dir}` +
      (data.running ? '  ·  server is running (restore is disabled until it’s stopped)' : '');
    renderBackupsList(srv, data);
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(emptyList('⚠', err.message));
  }
}

function renderBackupSchedule(srv) {
  const card = el('div', { class: 'sched-card' });

  const schedCb = el('input', { type: 'checkbox' });
  schedCb.checked = !!srv.scheduledBackup;
  const schedTime = el('input', { type: 'time', class: 'time-input', value: srv.scheduledBackupTime || '04:30' });
  schedTime.disabled = !schedCb.checked;
  schedCb.addEventListener('change', () => { schedTime.disabled = !schedCb.checked; patch(srv, { scheduledBackup: schedCb.checked }); });
  schedTime.addEventListener('change', () => {
    const v = /^([01]\d|2[0-3]):[0-5]\d$/.test(schedTime.value) ? schedTime.value : '04:30';
    schedTime.value = v; patch(srv, { scheduledBackupTime: v });
  });

  const keep = el('input', { type: 'number', min: 0, max: 99, value: srv.backupRetention, style: 'width:72px' });
  keep.addEventListener('change', () => {
    let v = parseInt(keep.value, 10); if (!Number.isFinite(v) || v < 0) v = 0; if (v > 99) v = 99;
    keep.value = v; patch(srv, { backupRetention: v });
  });

  card.appendChild(el('div', { class: 'checkbox-field' }, schedCb,
    el('label', { style: 'margin:0' }, 'Back up automatically every day at'), schedTime));
  card.appendChild(el('div', { class: 'sched-keep' },
    el('label', { style: 'margin:0' }, 'Keep the newest'), keep,
    el('label', { style: 'margin:0' }, 'automatic backups (0 = keep all; manual backups are never auto-deleted).')));
  card.appendChild(el('div', { class: 'hint' },
    'A backup is a .zip of the entire server folder (world, mods, configs). Scheduled backups run while the app is open, whether the server is up or not.'));
  return card;
}

function renderBackupsList(srv, data) {
  const list = $('#backupsList');
  list.innerHTML = '';
  if (!data.entries.length) {
    list.appendChild(emptyList('💾', 'No backups yet. Click “Back up now” to snapshot this server.'));
    return;
  }
  for (const b of data.entries) {
    const tag = b.type === 'auto' ? 'auto' : 'manual';
    const restoreBtn = el('button', { class: 'ghost-btn small', style: 'width:auto' }, '↩ Restore');
    restoreBtn.disabled = data.running || backupBusy;
    restoreBtn.title = data.running ? 'Stop the server first' : 'Replace the server folder with this backup';
    restoreBtn.addEventListener('click', () => restoreBackup(srv, b));
    const row = el('div', { class: 'content-row' },
      el('div', { class: 'cr-info' },
        el('div', { class: 'cr-name' }, fmtBackupDate(b.createdAt), el('span', { class: `bk-tag ${tag}` }, tag)),
        el('div', { class: 'cr-meta' }, fmtSize(b.size))
      ),
      restoreBtn,
      el('button', { class: 'icon-btn', title: 'Delete backup', onclick: () => deleteBackup(srv, b) }, '🗑')
    );
    list.appendChild(row);
  }
}

// Shared runner for create/restore: streams worker progress into the hint line,
// disables the backup button (showing `busyLabel`), and reloads the list when done.
async function runBackupOp(srv, busyLabel, fn) {
  if (backupBusy) return;
  backupBusy = true;
  const btn = $('#createBackupBtn');
  const origBtn = btn.textContent;
  btn.disabled = true; btn.textContent = busyLabel;
  const unsub = api.onBackupsProgress((p) => {
    if (p.id === srv.id) $('#backupsHint').textContent = backupPhaseText(p);
  });
  try {
    await fn();
  } finally {
    unsub();
    backupBusy = false;
    btn.disabled = false; btn.textContent = origBtn;
    await loadBackups();
  }
}

async function onCreateBackup() {
  const srv = currentServer();
  if (!srv || !srv.directory) return toast('No directory', 'Set a server folder first.', 'warn');
  await runBackupOp(srv, '💾 Backing up…', async () => {
    const meta = await call(api.backupsCreate(srv.id));
    if (meta) toast('Backup created', `${fmtSize(meta.size)} · ${meta.files} files`);
  });
}

async function restoreBackup(srv, b) {
  if (srv.state && srv.state !== 'stopped') return toast('Server running', 'Stop the server before restoring.', 'warn');
  const ok = await confirmModal('Restore this backup?',
    `This replaces everything in the server folder with the backup from ${fmtBackupDate(b.createdAt)}. ` +
    'Your current world is saved to an automatic safety backup first, so you can undo it.',
    { danger: true, confirmLabel: 'Restore' });
  if (!ok) return;
  await runBackupOp(srv, '↩ Restoring…', async () => {
    const r = await call(api.backupsRestore(srv.id, b.name));
    if (r) toast('Restored', `Server restored from ${fmtBackupDate(b.createdAt)}.`);
  });
}

async function deleteBackup(srv, b) {
  if (!(await confirmModal('Delete backup?', `Permanently delete the backup from ${fmtBackupDate(b.createdAt)}?`,
    { danger: true, confirmLabel: 'Delete' }))) return;
  try {
    await call(api.backupsRemove(srv.id, b.name));
    await loadBackups();
  } catch { /* shown */ }
}

// ============================================================================
// server.properties
// ============================================================================
const COMMON_PROPS = [
  { key: 'motd', label: 'MOTD (server description)', type: 'text' },
  { key: 'gamemode', label: 'Game mode', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'difficulty', label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'max-players', label: 'Max players', type: 'number' },
  { key: 'server-port', label: 'Server port', type: 'number' },
  { key: 'level-name', label: 'World name', type: 'text' },
  { key: 'level-seed', label: 'World seed', type: 'text' },
  { key: 'pvp', label: 'PvP enabled', type: 'bool' },
  { key: 'online-mode', label: 'Online mode (require Mojang auth)', type: 'bool' },
  { key: 'white-list', label: 'Whitelist enabled', type: 'bool' },
  { key: 'spawn-protection', label: 'Spawn protection radius', type: 'number' },
  { key: 'view-distance', label: 'View distance (chunks)', type: 'number' },
  { key: 'simulation-distance', label: 'Simulation distance (chunks)', type: 'number' },
  { key: 'enable-command-block', label: 'Enable command blocks', type: 'bool' },
  { key: 'allow-flight', label: 'Allow flight', type: 'bool' },
  { key: 'hardcore', label: 'Hardcore mode', type: 'bool' }
];

async function loadProperties() {
  const srv = currentServer();
  if (!srv) return;
  const form = $('#propsForm');
  form.innerHTML = '';
  if (!srv.directory) {
    form.appendChild(emptyList('🗀', 'Set a server folder in Settings first.'));
    return;
  }
  let result;
  try {
    result = await call(api.readProps(srv.id));
  } catch (err) {
    form.appendChild(emptyList('⚠', err.message));
    return;
  }
  if (!result.exists) {
    form.appendChild(el('div', { class: 'banner warn' },
      el('span', {}, 'No server.properties yet — it’s generated the first time the server starts. Start the server once, then come back here.')));
    return;
  }
  const map = {};
  for (const { key, value } of result.entries) map[key] = value;

  for (const prop of COMMON_PROPS) {
    const val = map[prop.key];
    if (val === undefined) continue; // only show keys that exist
    const field = el('div', { class: 'field' });
    field.appendChild(el('label', {}, prop.label, el('span', { class: 'muted', style: 'font-weight:400' }, `  (${prop.key})`)));
    let input;
    if (prop.type === 'bool') {
      input = el('select', {}, el('option', { value: 'true' }, 'true'), el('option', { value: 'false' }, 'false'));
      input.value = /true/i.test(val) ? 'true' : 'false';
    } else if (prop.type === 'select') {
      input = el('select', {}, ...prop.options.map((o) => el('option', { value: o }, o)));
      if (!prop.options.includes(val)) input.appendChild(el('option', { value: val }, val));
      input.value = val;
    } else {
      input = el('input', { type: prop.type === 'number' ? 'number' : 'text', value: val });
    }
    input.dataset.key = prop.key;
    input.classList.add('prop-input');
    field.appendChild(input);
    form.appendChild(field);
  }

  // Show any other keys in a collapsible raw list note
  const known = new Set(COMMON_PROPS.map((p) => p.key));
  const others = result.entries.filter((e) => !known.has(e.key));
  if (others.length) {
    form.appendChild(el('p', { class: 'muted', style: 'margin-top:10px' },
      `+ ${others.length} more setting(s). Use the Files tab → server.properties to edit everything.`));
  }
}

async function saveProperties() {
  const srv = currentServer();
  if (!srv) return;
  const updates = {};
  for (const input of $$('.prop-input')) updates[input.dataset.key] = input.value;
  if (!Object.keys(updates).length) { toast('Nothing to save', '', 'warn'); return; }
  try {
    await call(api.writeProps(srv.id, updates));
    toast('Saved', 'server.properties updated. Restart the server to apply.');
  } catch { /* shown */ }
}

// ============================================================================
// Settings tab (per-server)
// ============================================================================
async function renderSettings() {
  const srv = currentServer();
  if (!srv) return;
  const form = $('#settingsForm');
  form.innerHTML = '';

  // Non-Minecraft games use a tailored settings view (no Java/EULA/RAM/jar).
  if (srv.game && srv.game !== 'minecraft') {
    return renderNativeSettings(srv, form);
  }

  // --- Java / EULA banners ---
  // Check the effective Java this server would use (its own path, else the
  // app-wide default, else PATH).
  const effectiveJava = srv.javaPath || state.settings.javaPath || '';
  const java = await api.detectJava(effectiveJava).then((r) => r.data).catch(() => ({ ok: false }));
  if (!java || !java.ok) {
    const jStatus = el('span', { class: 'hint' });
    const jBtn = el('button', { class: 'primary-btn small' }, '⬇ Get Java automatically');
    jBtn.addEventListener('click', async () => {
      const r = await runJavaDownload(jBtn, jStatus, {
        onDone: async (res) => {
          state.settings.javaPath = res.path;
          await call(api.setSettings({ javaPath: res.path }), { silent: true });
        }
      });
      if (r) renderSettings();   // Java now available → re-render (banner clears)
    });
    form.appendChild(el('div', { class: 'banner danger', style: 'margin:0 0 18px' },
      el('div', { style: 'flex:1' },
        el('div', {}, 'Java was not found — Minecraft servers need Java to run. Get the newest version automatically, or set a path below.'),
        el('div', { style: 'margin-top:10px; display:flex; align-items:center; gap:12px; flex-wrap:wrap' }, jBtn, jStatus))));
  }
  let eulaAccepted = false;
  if (srv.directory) {
    eulaAccepted = await api.getEula(srv.id).then((r) => r.data).catch(() => false);
    if (!eulaAccepted) {
      const banner = el('div', { class: 'banner warn', style: 'margin:0 0 18px' },
        el('span', {}, 'The Minecraft ', link('EULA', 'https://aka.ms/MinecraftEULA'),
          ' has not been accepted. The server will not start until you accept it.'),
        el('span', { class: 'banner-action' },
          el('button', { class: 'primary-btn small', id: 'tourEula', onclick: async () => {
            await call(api.setEula(srv.id, true));
            toast('EULA accepted', '');
            renderSettings();
          } }, 'Accept EULA')));
      form.appendChild(banner);
    }
  }

  // --- Identity ---
  const card1 = sectionCard('General', 'Name and server software type.');
  card1.appendChild(textField('Name', srv.name, (v) => patch(srv, { name: v }), 'My Survival Server'));
  card1.appendChild(selectField('Server software', srv.type, SERVER_TYPES, (v) => patch(srv, { type: v }),
    'Determines whether the content tab manages a plugins/ or mods/ folder.'));
  form.appendChild(card1);

  // --- Location + jar ---
  const card2 = sectionCard('Files & jar', 'Where the server lives and which jar to run.');
  card2.appendChild(dirField(srv));
  card2.appendChild(await jarField(srv));
  form.appendChild(card2);

  // --- RAM ---
  const card3 = sectionCard('Memory', `Allocate RAM for the Java process. System total: ${(state.sysInfo.totalRamMb / 1024).toFixed(1)} GB.`);
  card3.appendChild(ramControl(srv));
  form.appendChild(card3);

  // --- Advanced ---
  const card4 = sectionCard('Advanced', 'Custom Java path and launch flags. Leave blank for sensible defaults.');

  // Per-server Java version picker — download a specific Java just for this
  // server (handy for older modpacks that need an older Java).
  const jvField = el('div', { class: 'field' }, el('label', {}, 'Java version for this server'));
  const jvSelect = el('select', { style: 'max-width:260px' },
    el('option', { value: '' }, 'Newest'),
    el('option', { value: '25' }, 'Java 25 (LTS)'),
    el('option', { value: '21' }, 'Java 21 (LTS)'),
    el('option', { value: '17' }, 'Java 17 (LTS) — 1.17–1.20.4'),
    el('option', { value: '11' }, 'Java 11 — older versions'),
    el('option', { value: '8' }, 'Java 8 — very old / legacy modpacks'));
  const jvStatus = el('span', { class: 'hint' });
  const jvBtn = el('button', { class: 'primary-btn small' }, '⬇ Download & use');
  jvBtn.addEventListener('click', () => runJavaDownload(jvBtn, jvStatus, {
    feature: jvSelect.value || null,
    onDone: async (r) => { await patch(srv, { javaPath: r.path }); setTimeout(renderSettings, 400); }
  }));
  jvField.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' }, jvSelect, jvBtn, jvStatus));
  jvField.appendChild(el('div', { class: 'hint' }, 'Downloads that Java just for this server and points it here automatically. Most modern servers want the newest; pick an older one only for old modpacks.'));
  card4.appendChild(jvField);

  card4.appendChild(textField('Java path (optional)', srv.javaPath, (v) => patch(srv, { javaPath: v }),
    'java', 'Absolute path to a java binary. Blank = use the app default / system PATH' + (java && java.ok && java.version ? ` (detected: ${escapeHtml(java.version)})` : '')));
  card4.appendChild(textField('Extra JVM args (optional)', srv.javaArgs, (v) => patch(srv, { javaArgs: v }),
    '-XX:+UseG1GC -XX:+ParallelRefProcEnabled', 'Added before -jar. Aikar’s flags go here.'));
  card4.appendChild(textField('Server args', srv.serverArgs, (v) => patch(srv, { serverArgs: v }),
    'nogui', 'Passed after the jar name. “nogui” disables the built-in window.'));
  appendRestartControls(card4, srv);
  form.appendChild(card4);

  // --- Danger ---
  form.appendChild(dangerCard(srv));
}

/** Auto-restart + scheduled-daily-restart controls (shared across games). */
function appendRestartControls(card, srv) {
  const autoWrap = el('div', { class: 'field' });
  const autoCb = el('input', { type: 'checkbox' });
  autoCb.checked = !!srv.autoRestart;
  autoCb.addEventListener('change', () => patch(srv, { autoRestart: autoCb.checked }));
  autoWrap.appendChild(el('div', { class: 'checkbox-field' }, autoCb, el('label', { style: 'margin:0' }, 'Auto-restart if the server crashes')));
  card.appendChild(autoWrap);

  const schedWrap = el('div', { class: 'field' });
  const schedCb = el('input', { type: 'checkbox', id: 'tourSchedRestart' });
  schedCb.checked = !!srv.scheduledRestart;
  const schedTime = el('input', { type: 'time', class: 'time-input', value: srv.scheduledRestartTime || '04:00' });
  schedTime.disabled = !schedCb.checked;
  schedCb.addEventListener('change', () => {
    schedTime.disabled = !schedCb.checked;
    patch(srv, { scheduledRestart: schedCb.checked });
  });
  schedTime.addEventListener('change', () => {
    const v = /^([01]\d|2[0-3]):[0-5]\d$/.test(schedTime.value) ? schedTime.value : '04:00';
    schedTime.value = v;
    patch(srv, { scheduledRestartTime: v });
  });
  schedWrap.appendChild(el('div', { class: 'checkbox-field' },
    schedCb,
    el('label', { style: 'margin:0' }, 'Restart automatically every day at'),
    schedTime));
  schedWrap.appendChild(el('div', { class: 'hint' },
    'Keeps a long-running server healthy. At this time (your computer’s local time) ' +
    (gameCaps(srv).stdinCommands ? 'players get a heads-up in chat, then ' : '') +
    'the server stops and starts back up. It only restarts if the server is running, and the app must be open.'));
  card.appendChild(schedWrap);
}

/** The "Danger zone" card (remove vs permanently delete) — shared across games. */
function dangerCard(srv) {
  const card = sectionCard('Danger zone', 'Remove this server. Choose carefully — one of these is permanent.');
  card.appendChild(el('div', { class: 'danger-options' },
    el('div', { class: 'danger-option' },
      el('div', { class: 'danger-option-text' },
        el('b', {}, 'Remove from dashboard'),
        el('span', {}, 'Takes it out of VoxelDeck but ', el('b', {}, 'keeps all your files on disk'), '. You can add it back later by pointing at the same folder.')),
      el('button', { class: 'danger-btn', onclick: () => deleteServer(srv) }, 'Remove from dashboard')),
    el('div', { class: 'danger-option' },
      el('div', { class: 'danger-option-text' },
        el('b', {}, 'Delete server & all files'),
        el('span', {}, 'Erases the entire server folder — world, configs, everything. ', el('b', { class: 'danger-text' }, 'This cannot be undone.'))),
      el('button', { class: 'danger-btn solid', onclick: () => deleteServerFiles(srv) }, '🗑 Delete permanently'))
  ));
  return card;
}

// ============================================================================
// Native-game settings (Terraria / Valheim)
// ============================================================================
async function renderNativeSettings(srv, form) {
  const def = gameDef(srv.game);

  // --- General ---
  const card1 = sectionCard('General', `${def.name} server settings.`);
  card1.appendChild(textField('Name', srv.name, (v) => patch(srv, { name: v }), srv.name));
  form.appendChild(card1);

  // --- Game configuration (from the game's schema) ---
  if (def.configSchema && def.configSchema.length) {
    const card2 = sectionCard(`${def.name} configuration`,
      srv.game === 'terraria'
        ? 'Written to serverconfig.txt. World-creation options only apply when the world is first made.'
        : 'Applied to the server’s launch options. Restart the server for changes to take effect.');
    const built = buildSchemaFields(def.configSchema, srv.gameConfig || {});
    const persist = () => {
      const next = { ...(srv.gameConfig || {}), ...built.read() };
      srv.gameConfig = next;
      patch(srv, { gameConfig: next });
    };
    built.els.forEach((node) => {
      node.querySelectorAll('input, select').forEach((inp) => inp.addEventListener('change', persist));
      card2.appendChild(node);
    });
    form.appendChild(card2);
  }

  // --- Files & install ---
  const card3 = sectionCard('Files & install', 'Where the server lives, and (re)installing its files.');
  const folderRow = el('div', { class: 'field' },
    el('label', {}, 'Server folder'),
    el('div', { class: 'with-btn' },
      el('input', { type: 'text', value: srv.directory || '', readonly: 'readonly' }),
      el('button', { class: 'ghost-btn', style: 'width:auto', onclick: () => srv.directory && api.openPath(srv.directory) }, 'Open')));
  card3.appendChild(folderRow);

  const installStatus = el('span', { class: 'hint' });
  const installBtn = el('button', { class: 'primary-btn small' },
    srv.game === 'terraria' ? '⬇ Re-download server files' : '⬇ Reinstall via SteamCMD');
  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    const orig = installBtn.textContent;
    const unsub = api.onGameProgress((p) => {
      if (p.id !== srv.id) return;
      if (p.phase === 'download' && p.total) installBtn.textContent = `Downloading… ${Math.round((p.received / p.total) * 100)}%`;
      else if (p.message) installStatus.textContent = p.message;
    });
    try {
      await call(api.installGame(srv.id));
      installStatus.textContent = 'Done.';
      toast('Install complete', `${def.name} server files are ready.`);
    } catch (e) {
      installStatus.textContent = e.message || 'Install failed.';
    } finally {
      unsub();
      installBtn.disabled = false;
      installBtn.textContent = orig;
    }
  });
  card3.appendChild(el('div', { class: 'field' },
    el('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' }, installBtn, installStatus),
    el('div', { class: 'hint' }, srv.game === 'valheim'
      ? 'Requires SteamCMD installed on this PC. Reinstall to repair or update the server files.'
      : 'Re-downloads the Terraria dedicated server into this folder.')));
  form.appendChild(card3);

  // --- Restarts ---
  const card4 = sectionCard('Restarts', 'Keep the server fresh automatically.');
  appendRestartControls(card4, srv);
  form.appendChild(card4);

  // --- Danger ---
  form.appendChild(dangerCard(srv));
}

function link(text, url) {
  return el('a', { onclick: () => api.openExternal(url) }, text);
}
function sectionCard(title, desc) {
  return el('div', { class: 'section-card' }, el('h3', {}, title), desc ? el('div', { class: 'sec-desc' }, desc) : null);
}
function textField(label, value, onChange, placeholder = '', hintHtml = '') {
  const input = el('input', { type: 'text', value: value || '', placeholder });
  input.addEventListener('change', () => onChange(input.value));
  const field = el('div', { class: 'field' }, el('label', {}, label), input);
  if (hintHtml) field.appendChild(el('div', { class: 'hint', html: hintHtml }));
  return field;
}
function selectField(label, value, options, onChange, hint = '') {
  const sel = el('select', {}, ...options.map((o) => el('option', { value: o.value }, o.label)));
  sel.value = value;
  sel.addEventListener('change', () => { onChange(sel.value); renderDetail(); });
  const field = el('div', { class: 'field' }, el('label', {}, label), sel);
  if (hint) field.appendChild(el('div', { class: 'hint' }, hint));
  return field;
}
function dirField(srv) {
  const input = el('input', { type: 'text', value: srv.directory || '', placeholder: '/home/you/servers/survival', readonly: 'true' });
  const browse = el('button', { class: 'ghost-btn', style: 'width:auto;white-space:nowrap', onclick: async () => {
    const dir = await call(api.pickDirectory());
    if (dir) { input.value = dir; await patch(srv, { directory: dir }); renderSettings(); }
  } }, 'Browse…');
  const open = el('button', { class: 'ghost-btn', style: 'width:auto;white-space:nowrap', onclick: () => srv.directory && api.openPath(srv.directory) }, 'Open');
  const field = el('div', { class: 'field' },
    el('label', {}, 'Server folder'),
    el('div', { class: 'with-btn' }, input, browse, open));
  field.appendChild(el('div', { class: 'hint' }, 'The folder containing your server jar and world. Provide your own server files here.'));
  return field;
}
async function jarField(srv) {
  const field = el('div', { class: 'field' }, el('label', {}, 'Server jar'));
  let jars = [];
  if (srv.directory) { try { jars = await call(api.listJars(srv.id), { silent: true }); } catch { jars = []; } }
  const sel = el('select', {});
  sel.appendChild(el('option', { value: '' }, jars.length ? '— select a jar —' : '(no .jar files found in folder)'));
  for (const j of jars) sel.appendChild(el('option', { value: j }, j));
  if (srv.jar && !jars.includes(srv.jar)) sel.appendChild(el('option', { value: srv.jar }, `${srv.jar} (missing)`));
  sel.value = srv.jar || '';
  sel.addEventListener('change', () => patch(srv, { jar: sel.value }));
  const browse = el('button', { class: 'ghost-btn', style: 'width:auto;white-space:nowrap', onclick: async () => {
    const file = await call(api.pickJar(srv.directory));
    if (file) {
      // If the picked jar is inside the server dir, store relative name; else inform user.
      const name = baseName(file);
      await patch(srv, { jar: name });
      toast('Jar selected', `${name}. Make sure it lives inside the server folder.`);
      renderSettings();
    }
  } }, 'Browse…');
  const download = el('button', { class: 'primary-btn', style: 'width:auto;white-space:nowrap', onclick: () => openDownloadJarModal(srv) }, '⬇ Download');
  field.appendChild(el('div', { class: 'with-btn' }, sel, browse, download));
  field.appendChild(el('div', { class: 'hint' }, 'Pick the .jar that runs the server, or download one automatically for the selected software type.'));
  return field;
}

// ============================================================================
// Download server jar
// ============================================================================
async function openDownloadJarModal(srv) {
  if (!srv.directory) { toast('No folder', 'Set a server folder first.', 'warn'); return; }
  const m = await api.jarMeta().then((r) => r.data).catch(() => ({ autoTypes: [], pages: {} }));
  const page = m.pages[srv.type];
  const auto = (m.autoTypes || []).includes(srv.type);

  // Non-auto types: explain + link to the official page.
  if (!auto) {
    const body = el('div', {},
      el('p', { class: 'muted', style: 'line-height:1.6; margin-bottom:16px' },
        `${typeLabel(srv.type)} ships as an installer or has to be built, so it can’t be auto-downloaded here. `,
        'Grab it from the official page, then drop the .jar in your server folder (or use “Browse…”).'),
      page ? el('button', { class: 'primary-btn', onclick: () => api.openExternal(page) },
        `Open ${typeLabel(srv.type)} downloads ↗`) : el('span', { class: 'muted' }, 'No download page on file.'));
    modal({ title: `Get a ${typeLabel(srv.type)} jar`, body, actions: [{ label: 'Close', class: 'ghost-btn' }] });
    return;
  }

  // Auto types: version picker + streamed download.
  const versionSel = el('select', {}, el('option', {}, 'Loading versions…'));
  versionSel.disabled = true;
  const status = el('div', { class: 'hint' });
  const progWrap = el('div', { class: 'dl-progress hidden' }, el('div', { class: 'dl-bar' }));
  const bar = progWrap.querySelector('.dl-bar');
  const dlBtn = el('button', { class: 'primary-btn', onclick: startDownload }, '⬇ Download & install');
  dlBtn.disabled = true;

  const body = el('div', {},
    el('div', { class: 'field' },
      el('label', {}, 'Minecraft version'),
      versionSel,
      el('div', { class: 'hint' }, 'Downloads the latest build into this server’s folder and selects it automatically.')),
    progWrap,
    status,
    el('div', { style: 'margin-top:14px' }, dlBtn),
    page ? el('div', { class: 'hint', style: 'margin-top:12px' }, 'Prefer to choose manually? ', link('Open the official downloads page ↗', page)) : null
  );

  const handle = modal({ title: `Download ${typeLabel(srv.type)} server`, body, actions: [{ label: 'Close', class: 'ghost-btn' }] });

  // Load versions.
  api.jarVersions(srv.type).then((res) => {
    versionSel.innerHTML = '';
    if (!res || res.ok === false) {
      versionSel.appendChild(el('option', {}, 'Could not load versions'));
      status.innerHTML = `<span style="color:var(--danger)">${escapeHtml(res ? res.error : 'Network error')}</span>`;
      return;
    }
    for (const v of res.data) versionSel.appendChild(el('option', { value: v }, v));
    versionSel.disabled = false;
    dlBtn.disabled = false;
  });

  async function startDownload() {
    const version = versionSel.value;
    if (!version) return;
    dlBtn.disabled = true; versionSel.disabled = true;
    progWrap.classList.remove('hidden');
    bar.style.width = '0%';
    status.textContent = 'Connecting…';

    const unsub = api.onJarProgress(({ id, received, total }) => {
      if (id !== srv.id) return;
      if (total) {
        const pct = Math.round((received / total) * 100);
        bar.style.width = pct + '%';
        status.textContent = `Downloading… ${pct}%  (${fmtSize(received)} / ${fmtSize(total)})`;
      } else {
        status.textContent = `Downloading… ${fmtSize(received)}`;
      }
    });

    try {
      const filename = await call(api.downloadJar(srv.id, version));
      unsub();
      bar.style.width = '100%';
      toast('Server jar installed', filename);
      handle.close();
      await refreshServers();
      if (state.selectedId === srv.id && state.activeTab === 'settings') renderSettings();
    } catch {
      unsub();
      progWrap.classList.add('hidden');
      status.textContent = '';
      dlBtn.disabled = false; versionSel.disabled = false;
    }
  }
}
function ramControl(srv) {
  const wrap = el('div', { class: 'ram-control' });
  const maxSys = state.sysInfo.totalRamMb;
  const step = 256;

  const minReadout = el('b', {}, fmtMb(srv.minRamMb));
  const maxReadout = el('b', {}, fmtMb(srv.maxRamMb));

  const minSlider = el('input', { type: 'range', min: 512, max: maxSys, step, value: srv.minRamMb });
  const maxSlider = el('input', { type: 'range', min: 512, max: maxSys, step, value: srv.maxRamMb });

  function sync(which) {
    let min = parseInt(minSlider.value, 10);
    let max = parseInt(maxSlider.value, 10);
    if (which === 'min' && min > max) { max = min; maxSlider.value = max; }
    if (which === 'max' && max < min) { min = max; minSlider.value = min; }
    minReadout.textContent = fmtMb(min);
    maxReadout.textContent = fmtMb(max);
  }
  function commit() {
    patch(srv, { minRamMb: parseInt(minSlider.value, 10), maxRamMb: parseInt(maxSlider.value, 10) });
    updateStatsUI();
  }
  minSlider.addEventListener('input', () => sync('min'));
  maxSlider.addEventListener('input', () => sync('max'));
  minSlider.addEventListener('change', commit);
  maxSlider.addEventListener('change', commit);

  wrap.appendChild(el('div', { class: 'field' },
    el('div', { class: 'ram-readout' }, el('span', {}, 'Minimum (-Xms)'), minReadout), minSlider));
  wrap.appendChild(el('div', { class: 'field' },
    el('div', { class: 'ram-readout' }, el('span', {}, 'Maximum (-Xmx)'), maxReadout), maxSlider));
  if (maxSys < 2048) {
    wrap.appendChild(el('div', { class: 'hint' }, 'Tip: 2–4 GB is comfortable for a small vanilla server; modded packs want more.'));
  } else {
    wrap.appendChild(el('div', { class: 'hint' }, 'Tip: don’t allocate all system RAM — leave headroom for the OS. 4–6 GB suits most servers.'));
  }
  return wrap;
}
function fmtMb(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`;
}

let patchTimer = null;
let pendingPatch = {};   // accumulates fields across debounced calls
let pendingId = null;
async function patch(srv, fields) {
  Object.assign(srv, fields);
  // Debounce writes a touch so rapid edits don't spam disk. Merge fields so
  // changing two settings in quick succession persists BOTH, not just the last.
  if (pendingId && pendingId !== srv.id) {
    // Switched servers mid-debounce — flush the previous one immediately.
    flushPatch();
  }
  pendingId = srv.id;
  Object.assign(pendingPatch, fields);
  clearTimeout(patchTimer);
  patchTimer = setTimeout(flushPatch, 120);
}

async function flushPatch() {
  clearTimeout(patchTimer);
  const id = pendingId;
  const toSend = pendingPatch;
  pendingPatch = {};
  pendingId = null;
  if (!id || !Object.keys(toSend).length) return;
  try {
    const updated = await call(api.updateServer(id, toSend), { silent: true });
    const srv = state.servers.find((s) => s.id === id);
    if (srv) Object.assign(srv, updated);
    renderServerList();
    if (state.selectedId === id && srv) { $('#detailName').textContent = srv.name; updateStatsUI(); }
  } catch (e) { toast('Save failed', e.message, 'error'); }
}

async function deleteServer(srv) {
  if (srv.state && srv.state !== 'stopped') return toast('Stop first', 'Stop the server before removing it.', 'warn');
  if (!(await confirmModal('Remove server?',
    `Remove “${srv.name}” from the dashboard? Files on disk are kept.`,
    { danger: true, confirmLabel: 'Remove' }))) return;
  try {
    await call(api.deleteServer(srv.id, false));
    state.selectedId = null;
    await refreshServers();
    if (state.servers.length) showHome();
    else showEmpty();
  } catch { /* shown */ }
}

// Permanently delete a server AND its files from disk. Irreversible, so we make
// the user (1) retype the exact server name and (2) wait out a 3-second cooldown
// before the confirm button is even clickable — and we say, loudly, that there
// is no undo.
async function deleteServerFiles(srv) {
  if (srv.state && srv.state !== 'stopped') return toast('Stop first', 'Stop the server before deleting it.', 'warn');

  const nameInput = el('input', {
    type: 'text', class: 'danger-confirm-input', placeholder: srv.name,
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false'
  });

  const body = el('div', {},
    el('div', { class: 'danger-callout' },
      el('div', { class: 'danger-callout-title' }, '⚠ This permanently deletes everything'),
      el('div', {}, 'The entire server folder — your world, configs, and all installed mods/plugins — will be erased from this computer.'),
      el('div', { class: 'danger-callout-strong' }, 'This cannot be undone. Deleting the server this way does NOT move it to a trash or backup — there is no way to restore it afterward.')
    ),
    srv.directory
      ? el('div', { class: 'danger-path' }, el('span', { class: 'danger-path-label' }, 'Folder to be erased'), el('code', {}, srv.directory))
      : null,
    el('div', { class: 'field danger-confirm-field' },
      el('label', {}, 'Type the server name to confirm: ', el('b', {}, srv.name)),
      nameInput)
  );

  let elapsed = false;
  let remaining = 3;

  const refreshBtn = () => {
    const btn = document.getElementById('confirmDeleteFilesBtn');
    if (!btn) return;
    const nameOk = nameInput.value === srv.name;
    if (!elapsed) { btn.disabled = true; btn.textContent = `Wait ${remaining}s…`; }
    else if (!nameOk) { btn.disabled = true; btn.textContent = 'Type the name to confirm'; }
    else { btn.disabled = false; btn.textContent = '🗑 Delete forever'; }
  };
  nameInput.addEventListener('input', refreshBtn);

  modal({
    title: 'Delete this server and all its files?',
    body,
    actions: [
      { label: 'Cancel', class: 'ghost-btn' },
      {
        label: 'Wait 3s…', class: 'danger-btn solid', id: 'confirmDeleteFilesBtn',
        onClick: async () => {
          if (!elapsed || nameInput.value !== srv.name) return true; // guard: keep open
          try {
            await call(api.deleteServer(srv.id, true));
            toast('Server deleted', 'The server and all of its files were permanently removed.');
            state.selectedId = null;
            await refreshServers();
            if (state.servers.length) showHome();
            else showEmpty();
          } catch { return true; }
        }
      }
    ]
  });

  // Forced 3-second cooldown: confirm stays locked even if the name is right.
  const tick = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) { clearInterval(tick); elapsed = true; }
    refreshBtn();
  }, 1000);
  refreshBtn();
  setTimeout(() => nameInput.focus(), 40);
}

// ============================================================================
// Add-server modal
// ============================================================================
/** Local mirror of the main-process folder sanitizer, for the live preview. */
function sanitizeFolderPreview(name) {
  const cleaned = String(name || '').trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return cleaned || 'server';
}

function installHint(gameId) {
  if (gameId === 'terraria') return 'VoxelDeck downloads the official Terraria dedicated server and sets it up for you.';
  if (gameId === 'valheim') return 'VoxelDeck installs the Valheim dedicated server via SteamCMD (which must be installed on this PC).';
  return '';
}

async function openAddServerModal() {
  let parentDir = state.settings.serversRoot || state.sysInfo.defaultServersRoot || '';
  const meta = await api.jarMeta().then((r) => r.data).catch(() => ({ autoTypes: [], pages: {} }));
  const autoTypes = meta.autoTypes || [];
  const pages = meta.pages || {};

  const nameInput = el('input', { type: 'text', id: 'tourAddName', placeholder: 'My Survival Server' });

  // --- Game picker ---
  const gameList = state.games.length ? state.games : [{ id: 'minecraft', name: 'Minecraft' }];
  const gameSel = el('select', { id: 'addGameSel' }, ...gameList.map((g) => el('option', { value: g.id }, g.name)));
  gameSel.value = 'minecraft';
  const gameField = el('div', { class: 'field' }, el('label', {}, 'Game'), gameSel,
    el('div', { class: 'hint', id: 'addGameHint' }, ''));

  const typeSel = el('select', { id: 'tourAddType' }, ...SERVER_TYPES.map((t) => el('option', { value: t.value }, t.label)));
  typeSel.value = 'paper'; // a sensible default that auto-downloads

  // --- Minecraft version (auto-download types) OR a note (others) ---
  const versionSel = el('select', { id: 'tourAddVersion' }, el('option', {}, 'Loading versions…'));
  const versionField = el('div', { class: 'field' },
    el('label', {}, 'Minecraft version'),
    versionSel,
    el('div', { class: 'hint' }, 'VoxelDeck downloads the matching server jar for you when you create the server.'));
  const noteField = el('div', { class: 'field', style: 'display:none' });

  let autoDownloadable = false;
  let vseq = 0;
  async function refreshVersions() {
    const type = typeSel.value;
    autoDownloadable = autoTypes.includes(type);
    if (autoDownloadable) {
      noteField.style.display = 'none';
      versionField.style.display = '';
      const mine = ++vseq;
      versionSel.disabled = true;
      versionSel.innerHTML = '';
      versionSel.appendChild(el('option', {}, 'Loading versions…'));
      try {
        const versions = await call(api.jarVersions(type), { silent: true });
        if (mine !== vseq) return;
        versionSel.innerHTML = '';
        for (const v of versions) versionSel.appendChild(el('option', { value: v }, v));
        versionSel.disabled = false;
      } catch {
        if (mine !== vseq) return;
        versionSel.innerHTML = '';
        versionSel.appendChild(el('option', { value: '' }, 'Couldn’t load versions — check your connection'));
      }
    } else {
      versionField.style.display = 'none';
      noteField.style.display = '';
      noteField.innerHTML = '';
      const page = pages[type];
      const link2 = page ? (() => { const a = el('a', {}, 'get it from the official page ↗'); a.addEventListener('click', () => api.openExternal(page)); return a; })() : null;
      noteField.appendChild(el('label', {}, 'Server jar'));
      noteField.appendChild(el('div', { class: 'hint', style: 'line-height:1.6' },
        `VoxelDeck can’t auto-download ${typeLabel(type)} (it’s installer-based or built from source). The folder is created empty — add the jar afterwards in Settings`,
        page ? ', or ' : '.', link2 || null, page ? '.' : null));
    }
  }
  typeSel.addEventListener('change', refreshVersions);

  // Minecraft-only fields (software + version) live in one block we can hide.
  const mcBlock = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Server software'), typeSel,
      el('div', { class: 'hint' }, 'Not sure? Paper is a great default — supports plugins, fast and stable.')),
    versionField,
    noteField);

  // Native-game config fields get injected here on game change.
  const nativeBlock = el('div', { style: 'display:none' });
  let nativeRead = null;

  function onGameChange() {
    const g = gameSel.value;
    const isMc = g === 'minecraft';
    mcBlock.style.display = isMc ? '' : 'none';
    nativeBlock.style.display = isMc ? 'none' : '';
    $('#addGameHint').textContent = isMc
      ? 'Java Edition. VoxelDeck downloads the server jar for you.'
      : installHint(g);
    if (isMc) {
      nativeRead = null;
      refreshVersions();
    } else {
      const def = gameDef(g);
      const built = buildSchemaFields(def.configSchema, {});
      nativeBlock.innerHTML = '';
      built.els.forEach((e) => nativeBlock.appendChild(e));
      nativeRead = built.read;
    }
  }
  gameSel.addEventListener('change', onGameChange);

  // --- location + live preview ---
  const preview = el('div', { class: 'hint', style: 'font-family:var(--mono)' });
  const updatePreview = () => { preview.textContent = `📁 Creates: ${parentDir}/${sanitizeFolderPreview(nameInput.value)}`; };
  nameInput.addEventListener('input', updatePreview);
  const changeLocBtn = el('button', { class: 'ghost-btn', style: 'width:auto;white-space:nowrap', onclick: async () => {
    const dir = await call(api.pickDirectory());
    if (dir) { parentDir = dir; updatePreview(); }
  } }, 'Change…');
  updatePreview();

  const body = el('div', {},
    gameList.length > 1 ? gameField : null,
    el('div', { class: 'field' }, el('label', {}, 'Server name'), nameInput),
    mcBlock,
    nativeBlock,
    el('div', { class: 'field' },
      el('label', {}, 'Location'),
      el('div', { style: 'display:flex;align-items:center;gap:10px' },
        changeLocBtn,
        el('span', { class: 'muted', style: 'font-size:12px' }, 'where the folder is created')),
      preview)
  );

  modal({
    title: 'Add a server',
    sub: 'VoxelDeck creates the folder and downloads the server for you.',
    body,
    actions: [
      { label: 'Cancel', class: 'ghost-btn' },
      { label: 'Create server', class: 'primary-btn', id: 'tourAddCreate', onClick: async () => {
        const name = nameInput.value.trim();
        if (!name) { toast('Name required', 'Give your server a name.', 'warn'); return true; }
        const game = gameSel.value;
        const btn = document.getElementById('tourAddCreate');

        // -------- Minecraft (jar download) --------
        if (game === 'minecraft') {
          const wantVersion = autoDownloadable ? versionSel.value : '';
          btn.disabled = true; btn.textContent = 'Creating…';
          try {
            const created = await call(api.setupServer({ name, game, type: typeSel.value, parentDir }));
            if (autoDownloadable && wantVersion) {
              btn.textContent = 'Downloading server… 0%';
              const unsub = api.onJarProgress(({ id, received, total }) => {
                if (id === created.id && total) btn.textContent = `Downloading server… ${Math.round((received / total) * 100)}%`;
              });
              try { await call(api.downloadJar(created.id, wantVersion)); } finally { unsub(); }
            }
            await refreshServers();
            selectServer(created.id);
            switchTab('settings');
            toast('Server ready', autoDownloadable && wantVersion
              ? 'Server downloaded and set up. Set RAM & accept the EULA, then flip the toggle.'
              : 'Folder created. Add a jar in Settings, then flip the toggle to start.');
            return;
          } catch {
            btn.disabled = false; btn.textContent = 'Create server';
            return true;
          }
        }

        // -------- Native games (Terraria / Valheim) --------
        const gc = nativeRead ? nativeRead() : {};
        if (game === 'valheim' && (!gc.password || String(gc.password).length < 5)) {
          toast('Password too short', 'Valheim requires a password of at least 5 characters.', 'warn');
          return true;
        }
        btn.disabled = true; btn.textContent = 'Creating…';
        let created;
        try {
          created = await call(api.setupServer({ name, game, parentDir, gameConfig: gc }));
        } catch {
          btn.disabled = false; btn.textContent = 'Create server';
          return true;
        }
        // The folder + entry now exist; run the (heavy) install with progress.
        btn.textContent = 'Installing…';
        const unsub = api.onGameProgress((p) => {
          if (p.id !== created.id) return;
          if (p.phase === 'download' && p.total) btn.textContent = `Downloading… ${Math.round((p.received / p.total) * 100)}%`;
          else if (p.message) btn.textContent = p.message.length > 42 ? p.message.slice(0, 42) + '…' : p.message;
        });
        let installError = null;
        try { await call(api.installGame(created.id), { silent: true }); }
        catch (e) { installError = e; }
        unsub();
        await refreshServers();
        selectServer(created.id);
        switchTab('settings');
        if (installError) {
          toast('Setup needs attention', installError.message || 'Couldn’t finish install — retry from Settings.', 'warn');
        } else {
          toast('Server ready', 'Installed. Review settings, then flip the toggle to start.');
        }
        return;
      } }
    ]
  });
  onGameChange();
  refreshVersions();
  setTimeout(() => nameInput.focus(), 30);
}

// ============================================================================
// App settings modal (global)
// ============================================================================
// Download the newest Java (Temurin) with progress; updates `status`/`btn` in
// place and records the new path in state. Returns the result or null.
async function runJavaDownload(btn, status, { feature = null, onDone } = {}) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Getting Java…';
  const unsub = api.onJavaProgress((p) => {
    if (p.phase === 'extract') status.textContent = '📦 Installing…';
    else if (p.total) status.textContent = `⬇ Downloading… ${Math.round((p.received / p.total) * 100)}% (${fmtSize(p.received)} / ${fmtSize(p.total)})`;
    else status.textContent = `⬇ Downloading… ${fmtSize(p.received)}`;
  });
  try {
    const r = await call(api.downloadJava(feature));
    unsub();
    status.innerHTML = `✅ Installed ${escapeHtml(r.version || ('Java ' + r.feature))}`;
    toast('Java ready', r.version || ('Java ' + r.feature));
    if (onDone) await onDone(r);
    return r;
  } catch {
    unsub();
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function openAppSettingsModal() {
  const settings = await call(api.getSettings()).catch(() => ({ ...state.settings }));
  state.settings = { ...state.settings, ...settings };
  const java = await api.detectJava(settings.javaPath).then((r) => r.data).catch(() => ({ ok: false }));

  const javaInput = el('input', { type: 'text', value: settings.javaPath || '', placeholder: 'java (uses system PATH)' });
  const status = el('div', { class: 'hint' });
  status.innerHTML = java && java.ok
    ? `✅ Detected: ${escapeHtml(java.version || 'Java')}`
    : '⚠️ Java not found on PATH. Use the button to get it automatically, or set a full path here.';
  const javaDlBtn = el('button', { class: 'primary-btn', style: 'width:auto;white-space:nowrap' }, '⬇ Get latest Java');
  javaDlBtn.addEventListener('click', () => runJavaDownload(javaDlBtn, status, {
    onDone: async (r) => {
      javaInput.value = r.path;
      state.settings.javaPath = r.path;
      await call(api.setSettings({ javaPath: r.path }), { silent: true });
    }
  }));

  // Servers folder (default parent for newly-created server folders).
  const rootInput = el('input', { type: 'text', value: settings.serversRoot || '',
    placeholder: state.sysInfo.defaultServersRoot || '~/MinecraftServers' });
  const rootBrowse = el('button', { class: 'ghost-btn', style: 'width:auto;white-space:nowrap', onclick: async () => {
    const dir = await call(api.pickDirectory());
    if (dir) rootInput.value = dir;
  } }, 'Browse…');

  // Client Minecraft folder (used by the client-mod installer). Blank = OS default.
  const mcInput = el('input', { type: 'text', value: settings.minecraftDir || '',
    placeholder: '.minecraft (auto-detected)' });
  const mcBrowse = el('button', { class: 'ghost-btn', style: 'width:auto;white-space:nowrap', onclick: async () => {
    const dir = await call(api.pickDirectory());
    if (dir) mcInput.value = dir;
  } }, 'Browse…');

  // Backups location (blank = <userData>/backups).
  const bkInput = el('input', { type: 'text', value: settings.backupsRoot || '',
    placeholder: 'default: app data folder / backups' });
  const bkBrowse = el('button', { class: 'ghost-btn', style: 'width:auto;white-space:nowrap', onclick: async () => {
    const dir = await call(api.pickDirectory());
    if (dir) bkInput.value = dir;
  } }, 'Browse…');

  const body = el('div', {},
    buildAccentField(normalizeHex(settings.accentColor || DEFAULT_ACCENT)),
    el('div', { class: 'field' },
      el('label', {}, 'Servers folder'),
      el('div', { class: 'with-btn' }, rootInput, rootBrowse),
      el('div', { class: 'hint' }, 'New servers are created here as their own subfolders. Blank = ',
        el('code', {}, escapeHtml(state.sysInfo.defaultServersRoot || '~/MinecraftServers')))),
    el('div', { class: 'field' },
      el('label', {}, 'Default Java path'),
      el('div', { class: 'with-btn' }, javaInput, javaDlBtn),
      status,
      el('div', { class: 'hint' }, 'Used when a server doesn’t specify its own Java path. The button grabs the newest Java (Eclipse Temurin) automatically — no manual install needed. ',
        link('Or get it yourself', 'https://adoptium.net/'))),
    el('div', { class: 'field' },
      el('label', {}, 'Minecraft folder (client mods)'),
      el('div', { class: 'with-btn' }, mcInput, mcBrowse),
      el('div', { class: 'hint' }, 'Where the ', el('b', {}, 'Client Mods'),
        ' tab installs mods. Blank = your OS default (', el('code', {}, '~/.minecraft'), ', ',
        el('code', {}, '%APPDATA%\\.minecraft'), ', …).')),
    el('div', { class: 'field' },
      el('label', {}, 'Backups folder'),
      el('div', { class: 'with-btn' }, bkInput, bkBrowse),
      el('div', { class: 'hint' }, 'Where server backups are stored. Blank = a ',
        el('code', {}, 'backups'), ' folder in the app’s data directory. Kept outside server folders so backups survive deleting a server.')),
    el('div', { class: 'field' },
      el('label', {}, 'Getting started'),
      el('button', { class: 'ghost-btn', style: 'width:auto', onclick: () => {
        const host = $('#modalHost'); host.classList.add('hidden'); host.innerHTML = '';
        startTour();
      } }, '↻ Replay the guided tour')),
    buildUpdateField(),
    el('div', { class: 'field' },
      el('label', {}, 'Config location'),
      el('div', { class: 'hint', style: 'user-select:text' }, escapeHtml(state.sysInfo.userData || '')))
  );

  modal({
    title: 'App settings',
    body,
    actions: [
      { label: 'Close', class: 'ghost-btn' },
      { label: 'Save', class: 'primary-btn', onClick: async () => {
        const patch = { javaPath: javaInput.value.trim(), serversRoot: rootInput.value.trim(), minecraftDir: mcInput.value.trim(), backupsRoot: bkInput.value.trim() };
        await call(api.setSettings(patch));
        state.settings = { ...state.settings, ...patch };
        toast('Settings saved', '');
      } }
    ]
  });
}

/**
 * Accent-color picker: preset swatches + a custom color input. Applies the
 * color live and persists it immediately (so it sticks even on Close).
 */
function buildAccentField(current) {
  const field = el('div', { class: 'field' }, el('label', {}, 'Accent color'));
  const row = el('div', { class: 'swatch-row' });

  async function choose(hex) {
    hex = normalizeHex(hex);
    applyAccent(hex);                 // live preview, instantly
    state.settings.accentColor = hex;
    colorInput.value = hex;
    markSelected(hex);
    try { await call(api.setSettings({ accentColor: hex }), { silent: true }); }
    catch { /* non-fatal */ }
  }

  const swatches = ACCENT_PRESETS.map((p) => {
    const sw = el('button', {
      class: 'swatch', title: p.name, style: `background:${p.hex}`,
      'data-hex': p.hex, onclick: () => choose(p.hex)
    });
    return sw;
  });

  // Custom color input (native picker) styled as a swatch.
  const colorInput = el('input', { type: 'color', class: 'swatch swatch-custom', value: current, title: 'Custom color…' });
  colorInput.addEventListener('input', () => choose(colorInput.value));

  function markSelected(hex) {
    hex = normalizeHex(hex);
    swatches.forEach((s) => s.classList.toggle('selected', normalizeHex(s.dataset.hex) === hex));
  }
  markSelected(current);

  swatches.forEach((s) => row.appendChild(s));
  row.appendChild(colorInput);
  field.appendChild(row);

  const reset = el('a', { onclick: () => choose(DEFAULT_ACCENT) }, 'Reset to default');
  field.appendChild(el('div', { class: 'hint' }, 'Pick a preset or choose your own. Changes apply instantly. ', reset));
  return field;
}

// ============================================================================
// Guided tour — interactive walkthrough
// ============================================================================
function tabsExplainerNode() {
  const items = [
    ['💬', 'Console', 'Live server output — type commands like a real terminal'],
    ['🌍', 'Connect', 'Your join addresses + how to let friends in (port forwarding)'],
    ['👥', 'Players', 'See who’s online; toggle OP and set gamemode'],
    ['⚡', 'Commands', 'One-click admin actions — no command syntax to learn'],
    ['🗂️', 'Files', 'Browse and edit your server’s files'],
    ['🧩', 'Mods / Plugins', 'Install, enable/disable and remove add-ons'],
    ['⚙️', 'Properties', 'Edit the common server.properties settings in a form'],
    ['🔧', 'Settings', 'RAM, the server jar, Java path, EULA and more']
  ];
  return el('ul', { class: 'tour-tabs' },
    ...items.map(([ic, t, d]) => el('li', {},
      el('span', { class: 'tt-ic' }, ic),
      el('span', { class: 'tt-text' }, el('b', {}, t), el('span', { class: 'tt-d' }, ` — ${d}`)))));
}

// Plain-language guide to the main server-software families, shown in the tour.
function serverSoftwareNode() {
  const items = [
    ['🟦', 'Vanilla', 'Plain Minecraft, exactly as Mojang makes it. No add-ons — simplest to run.'],
    ['🔌', 'Paper (also Purpur / Spigot)', 'Adds plugins: economy, minigames, anti-grief, and more. Fast and stable — the popular pick for multiplayer.'],
    ['🧩', 'Fabric / Quilt', 'Adds mods that change the game itself (new blocks, mobs, mechanics). Lightweight. Friends need the same mods.'],
    ['🛠️', 'Forge / NeoForge', 'Also mods — these power the big modpacks. Friends need the same modpack installed.']
  ];
  const ul = el('ul', { class: 'tour-tabs' },
    ...items.map(([ic, t, d]) => el('li', {},
      el('span', { class: 'tt-ic' }, ic),
      el('span', { class: 'tt-text' }, el('b', {}, t), el('span', { class: 'tt-d' }, ` — ${d}`)))));
  const tip = el('p', { class: 'tour-soft-tip' },
    'Not sure? ', el('b', {}, 'Paper'), ' is a great default — you can change it any time. ',
    'Then pick a Minecraft version below and VoxelDeck downloads the server for you. Press Next.');
  return el('div', {}, ul, tip);
}

function tourSteps() {
  const M = '#modalHost .modal';
  return [
    { id: 'welcome', center: true,
      title: 'Welcome — let’s make your first server 👋',
      body: 'I’ll walk you through creating a server step by step, and show you what each part of the app does. It takes about a minute. You can press “Skip tour” anytime.' },

    { id: 'click-plus', target: '#addServerBtn', interactive: true, next: false,
      hint: 'Click the + button to continue', advanceWhen: () => isModalOpen(),
      title: 'Add your first server',
      body: 'Go ahead — click the + button to open the “Add a server” window.' },

    { id: 'name', target: '#tourAddName', hole: M, interactive: true, requiresModal: true, waitFor: '#tourAddName',
      title: 'Name your server',
      body: 'Type a name for your server here — something like “My Survival Server”. You can rename it later. Then press Next.' },

    { id: 'software', target: '#tourAddType', hole: M, interactive: true, requiresModal: true, waitFor: '#tourAddType',
      title: 'Choose your server software',
      body: 'This decides what your server can do — whether it supports plugins, mods, or neither:',
      node: serverSoftwareNode() },

    { id: 'version', target: '#tourAddVersion', hole: M, interactive: true, requiresModal: true, waitFor: '#tourAddVersion',
      title: 'Pick a Minecraft version',
      body: 'Choose which Minecraft version to run (newest is at the top). VoxelDeck grabs the matching server jar automatically when you create the server — no files to download yourself.' },

    { id: 'create', target: '#tourAddCreate', hole: M, interactive: true, requiresModal: true, next: false,
      hint: 'Click “Create server” to continue', advanceWhen: () => state.view === 'detail', waitFor: '#tourAddCreate',
      title: 'Create it!',
      body: 'When you’re happy, click “Create server”. VoxelDeck makes the folder and downloads the server jar for you — give it a moment to finish.' },

    { id: 'tabs', target: '#tabs', waitFor: '#tabs',
      title: 'Your server is ready! 🎉',
      body: 'Here’s your new server. These tabs are how you manage it:', node: tabsExplainerNode() },

    { id: 'settings-tab', target: '.tab[data-tab="settings"]',
      title: 'Start here: Settings',
      body: 'You’ve landed on the Settings tab. This is where you set how much RAM to give the server, pick or ⬇ download the jar, and set your Java path — everything you need before the first start.' },

    { id: 'eula', target: '#tourEula', waitFor: '#tourEula',
      title: 'Agree to the Minecraft EULA',
      body: 'One required step: Minecraft won’t let a server run until you accept Mojang’s End User License Agreement. Click “Accept EULA” here (it just writes eula=true for you). The server can’t start until you do.' },

    { id: 'toggle', target: '#powerSwitch',
      title: 'Start your server',
      body: 'Once Settings are sorted, flip this switch to start the server. Watch it boot in the Console tab. Flip it back off to stop and save the world cleanly.' },

    { id: 'finish', center: true,
      title: 'That’s it — you’re all set! 🎉',
      body: 'You just created your first server. Explore the Commands tab for one-click admin actions, and you can replay this tour anytime from ⚙ App settings. Have fun!' }
  ];
}

const tour = { active: false, index: 0, steps: [], root: null, onResize: null, poll: null };

function isModalOpen() {
  const h = $('#modalHost');
  return !!h && !h.classList.contains('hidden') && h.children.length > 0;
}
function isVisible(elm) {
  if (!elm) return false;
  const r = elm.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && elm.offsetParent !== null;
}
function waitForEl(sel, timeout = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const e = document.querySelector(sel);
      if (e && isVisible(e)) return resolve(e);
      if (Date.now() - t0 > timeout) return resolve(null);
      setTimeout(tick, 70);
    };
    tick();
  });
}

async function startTour() {
  if (tour.active) return;
  tour.active = true;
  tour.index = 0;
  tour.steps = tourSteps();
  if (state.view === 'detail') showHome();   // start from a clean overview

  tour.root = el('div', { id: 'tourRoot' },
    el('div', { class: 'tour-mask', id: 'tmFull' }),
    el('div', { class: 'tour-mask', id: 'tmT' }),
    el('div', { class: 'tour-mask', id: 'tmB' }),
    el('div', { class: 'tour-mask', id: 'tmL' }),
    el('div', { class: 'tour-mask', id: 'tmR' }),
    el('div', { class: 'tour-block', id: 'tmBlock' }),
    el('div', { class: 'tour-ring', id: 'tourRing' }),
    el('div', { class: 'tour-pop', id: 'tourPop' }));
  document.body.appendChild(tour.root);

  tour.onResize = () => positionTour();
  window.addEventListener('resize', tour.onResize);
  window.addEventListener('keydown', tourKeydown, true);
  tour.poll = setInterval(tourTick, 200);
  await renderTourStep();
}

function tourKeydown(e) {
  if (!tour.active) return;
  if (e.key === 'Escape') { e.preventDefault(); endTour(); }
}

function stepIndex(id) { return tour.steps.findIndex((s) => s.id === id); }
function gotoStep(i) {
  if (i < 0 || i >= tour.steps.length || i === tour.index) return;
  tour.index = i;
  renderTourStep();
}

function tourTick() {
  if (!tour.active) return;
  const step = tour.steps[tour.index];
  // If a modal step's window got closed without creating, rewind to "click +".
  if (step.requiresModal && !isModalOpen() && state.view !== 'detail') {
    gotoStep(stepIndex('click-plus'));
    return;
  }
  if (step.advanceWhen && step.advanceWhen()) { tourNext(); return; }
  positionTour();   // keep aligned as the modal animates / layout shifts
}

async function renderTourStep() {
  const step = tour.steps[tour.index];
  if (step.waitFor) await waitForEl(step.waitFor, 5000);
  if (!tour.active) return;
  buildTourPop(step);
  positionTour();
}

function buildTourPop(step) {
  const pop = $('#tourPop');
  pop.innerHTML = '';
  pop.appendChild(el('div', { class: 'tour-kicker' },
    el('img', { class: 'tour-kicker-ic', src: 'assets/icon.png', alt: '' }), 'Guided tour'));
  pop.appendChild(el('h3', { class: 'tour-title' }, step.title));
  const body = el('div', { class: 'tour-body' }, step.body);
  if (step.node) body.appendChild(step.node);
  pop.appendChild(body);

  const dots = el('div', { class: 'tour-dots' });
  tour.steps.forEach((_, i) => dots.appendChild(el('span', { class: 'tour-dot' + (i === tour.index ? ' active' : '') })));
  pop.appendChild(dots);

  const isLast = tour.index === tour.steps.length - 1;
  const showNext = step.next !== false;
  const prev = tour.steps[tour.index - 1] || {};
  const showBack = tour.index > 0 && !step.requiresModal && !prev.requiresModal;

  const right = el('div', { class: 'tour-nav' });
  if (step.hint && !showNext) right.appendChild(el('span', { class: 'tour-waiting' }, `👆 ${step.hint}`));
  if (showBack) right.appendChild(el('button', { class: 'ghost-btn small', onclick: () => tourBack() }, 'Back'));
  if (showNext) right.appendChild(el('button', { class: 'primary-btn small', onclick: () => tourNext() }, isLast ? 'Done' : 'Next'));

  pop.appendChild(el('div', { class: 'tour-actions' },
    el('button', { class: 'tour-skip', onclick: () => endTour() }, isLast ? 'Close' : 'Skip tour'),
    right));
}

function setRect(node, top, left, width, height) {
  node.style.display = 'block';
  node.style.top = `${top}px`; node.style.left = `${left}px`;
  node.style.width = `${Math.max(0, width)}px`; node.style.height = `${Math.max(0, height)}px`;
}

function positionTour() {
  const step = tour.steps[tour.index];
  const pop = $('#tourPop');
  const ring = $('#tourRing');
  const full = $('#tmFull'), block = $('#tmBlock');
  const edges = ['tmT', 'tmB', 'tmL', 'tmR'].map((id) => document.getElementById(id));
  if (!pop) return;

  const focus = !step.center && step.target ? document.querySelector(step.target) : null;
  const focusVisible = focus && isVisible(focus);

  if (step.center || !focusVisible) {
    // Full-screen dim + centered card.
    setRect(full, 0, 0, window.innerWidth, window.innerHeight);
    edges.forEach((e) => { e.style.display = 'none'; });
    block.style.display = 'none';
    ring.style.display = 'none';
    pop.style.transform = 'none';
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = `${Math.max(12, (window.innerWidth - pw) / 2)}px`;
    pop.style.top = `${Math.max(12, (window.innerHeight - ph) / 2)}px`;
    return;
  }

  full.style.display = 'none';
  const vw = window.innerWidth, vh = window.innerHeight;
  const holeEl = step.hole ? document.querySelector(step.hole) : focus;
  const hb = (holeEl && isVisible(holeEl) ? holeEl : focus).getBoundingClientRect();
  const pad = 8;
  const h = {
    t: Math.max(0, hb.top - pad), l: Math.max(0, hb.left - pad),
    r: Math.min(vw, hb.right + pad), b: Math.min(vh, hb.bottom + pad)
  };

  // Dim everything except the hole (4 edge masks).
  setRect(edges[0], 0, 0, vw, h.t);                 // top
  setRect(edges[1], h.b, 0, vw, vh - h.b);          // bottom
  setRect(edges[2], h.t, 0, h.l, h.b - h.t);        // left
  setRect(edges[3], h.t, h.r, vw - h.r, h.b - h.t); // right

  // Non-interactive steps also block clicks on the hole (advance with Next).
  if (step.interactive) block.style.display = 'none';
  else setRect(block, h.t, h.l, h.r - h.l, h.b - h.t);

  // Accent ring around the focused element.
  const f = focus.getBoundingClientRect();
  const rp = 4;
  ring.style.display = 'block';
  ring.style.top = `${f.top - rp}px`; ring.style.left = `${f.left - rp}px`;
  ring.style.width = `${f.width + rp * 2}px`; ring.style.height = `${f.height + rp * 2}px`;

  // Place the popover beside the hole so it never covers the modal/target.
  pop.style.transform = 'none';
  const pw = pop.offsetWidth, ph = pop.offsetHeight, m = 16;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  let top, left;
  if (vw - h.r > pw + m) { left = h.r + m; top = clamp(h.t, 12, vh - ph - 12); }
  else if (h.l > pw + m) { left = h.l - pw - m; top = clamp(h.t, 12, vh - ph - 12); }
  else if (vh - h.b > ph + m) { top = h.b + m; left = clamp(h.l, 12, vw - pw - 12); }
  else if (h.t > ph + m) { top = h.t - ph - m; left = clamp(h.l, 12, vw - pw - 12); }
  else { left = clamp(vw - pw - 12, 12, vw - pw - 12); top = 12; }
  pop.style.left = `${left}px`; pop.style.top = `${top}px`;
}

function tourNext() {
  if (tour.index >= tour.steps.length - 1) { endTour(); return; }
  tour.index += 1;
  renderTourStep();
}
function tourBack() {
  if (tour.index === 0) return;
  tour.index -= 1;
  renderTourStep();
}

async function endTour() {
  if (!tour.active) return;
  tour.active = false;
  clearInterval(tour.poll); tour.poll = null;
  window.removeEventListener('resize', tour.onResize);
  window.removeEventListener('keydown', tourKeydown, true);
  if (tour.root) tour.root.remove();
  tour.root = null;
  if (!state.settings.tourSeen) {
    state.settings.tourSeen = true;
    try { await api.setSettings({ tourSeen: true }); } catch { /* non-fatal */ }
  }
}

// ============================================================================
// Auto-update UI
// ============================================================================
function updateStatusText(s) {
  if (!s) return '';
  switch (s.state) {
    case 'checking': return 'Checking for updates…';
    case 'available': return `Downloading update ${s.version || ''}…`;
    case 'downloading': return `Downloading update… ${s.percent ?? 0}%`;
    case 'ready': return `Update ${s.version || ''} ready — restart to apply.`;
    case 'none': return 'You’re on the latest version. ✓';
    case 'dev': return 'Updates work in the installed app (you’re running from source).';
    case 'unsupported': return 'Auto-update isn’t available for this build (.deb / unsigned macOS — download new versions from the website).';
    case 'error': return `Couldn’t check for updates: ${s.message || 'unknown error'}`;
    default: return '';
  }
}

function handleUpdateStatus(s) {
  state.update = s;
  const line = document.getElementById('updateStatusLine');
  if (line) line.textContent = updateStatusText(s);
  if (s.state === 'ready') showUpdateBanner(s.version);
  if (s.manual) {
    if (s.state === 'none') toast('Up to date', 'You’re on the latest version.');
    else if (s.state === 'available') toast('Update found', `Downloading version ${s.version}…`);
    else if (s.state === 'ready') toast('Update ready', `Restart to update to ${s.version}.`);
    else if (s.state === 'error') toast('Update check failed', s.message || '', 'error');
  }
}

function showUpdateBanner(version) {
  if (document.getElementById('updateBanner')) return;
  const banner = el('div', { id: 'updateBanner', class: 'update-banner' },
    el('span', { class: 'ub-text' }, `🎉 VoxelDeck ${version || ''} is ready to install`),
    el('button', { class: 'primary-btn small', onclick: () => api.installUpdate() }, 'Restart & update'),
    el('button', { class: 'ub-later', onclick: () => banner.remove() }, 'Later'));
  document.body.appendChild(banner);
}

// The "Updates" control in App settings: current version + a manual check.
function buildUpdateField() {
  const version = state.sysInfo.appVersion || '';
  const statusLine = el('div', { class: 'hint', id: 'updateStatusLine', style: 'margin-top:6px' }, updateStatusText(state.update));
  const btn = el('button', { class: 'ghost-btn', style: 'width:auto' }, '⟳ Check for updates');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Checking…';
    const r = await call(api.checkForUpdates(), { silent: true }).catch(() => null);
    if (r) { state.update = r; statusLine.textContent = updateStatusText(r); }
    btn.disabled = false;
    btn.textContent = orig;
  });
  return el('div', { class: 'field' },
    el('label', {}, `Updates  ·  v${escapeHtml(version)}`),
    btn,
    statusLine,
    el('div', { class: 'hint' }, 'VoxelDeck checks GitHub for new releases on launch and updates itself (Windows installer & Linux AppImage).'));
}

// ============================================================================
// Singleplayer launcher (instances + Microsoft account)
// ============================================================================
const INSTANCE_ST_LABEL = {
  stopped: 'Stopped', installing: 'Installing…', launching: 'Launching…',
  running: 'Running', stopping: 'Closing…'
};
function instStLabel(st) { return INSTANCE_ST_LABEL[st] || st; }
// The status-dot / status-label CSS only knows the server states; map ours on.
function instDotClass(st) {
  if (st === 'running') return 'running';
  if (st === 'installing' || st === 'launching' || st === 'stopping') return 'starting';
  return 'stopped';
}
function loaderLabel(inst) {
  const l = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt' }[inst.loader] || inst.loader;
  return inst.mcVersion ? `${l} ${inst.mcVersion}` : l;
}
function currentInstance() { return state.instances.find((i) => i.id === state.selectedInstanceId); }

async function showLauncher() {
  state.view = 'launcher';
  state.selectedId = null;
  $('#homeView').classList.add('hidden');
  $('#emptyState').classList.add('hidden');
  $('#serverDetail').classList.add('hidden');
  $('#instanceDetail').classList.add('hidden');
  $('#launcherView').classList.remove('hidden');
  $('#homeNavBtn').classList.remove('active');
  $('#launcherNavBtn').classList.add('active');
  await loadAccountBar();
  await refreshInstances();
}

async function refreshInstances() {
  try { state.instances = await call(api.launcherInstances(), { silent: true }); }
  catch { state.instances = []; }
  renderInstanceGrid();
}

function renderInstanceGrid() {
  const grid = $('#instanceGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const n = state.instances.length;
  $('#launcherSummary').textContent = n
    ? `${n} instance${n > 1 ? 's' : ''} · your own singleplayer worlds`
    : 'Create an instance to play singleplayer with one-click mods.';
  if (!n) {
    grid.appendChild(emptyList('🎮', 'No instances yet. Click “New instance” to make a vanilla, Fabric, or Quilt world.'));
    return;
  }
  for (const inst of state.instances) {
    const st = inst.state || 'stopped';
    const card = el('div', { class: 'home-card', onclick: () => selectInstance(inst.id) },
      el('div', { class: 'hc-top' },
        el('span', { class: `status-dot ${instDotClass(st)}` }),
        el('div', { class: 'hc-name' }, inst.name),
        el('span', { class: `status-label ${instDotClass(st)}` }, instStLabel(st))
      ),
      el('div', { class: 'hc-meta' },
        el('span', {}, loaderLabel(inst)),
        el('span', {}, `${inst.maxRamMb} MB`)
      ),
      el('div', { class: 'hc-open' }, 'Open →')
    );
    grid.appendChild(card);
  }
}

function selectInstance(id) {
  state.view = 'instance';
  state.selectedInstanceId = id;
  state.instanceTab = 'console';
  $('#homeView').classList.add('hidden');
  $('#emptyState').classList.add('hidden');
  $('#serverDetail').classList.add('hidden');
  $('#launcherView').classList.add('hidden');
  $('#instanceDetail').classList.remove('hidden');
  renderInstanceDetail();
  switchInstanceTab('console');
}

function renderInstanceDetail() {
  const inst = currentInstance();
  if (!inst) return;
  $('#instName').textContent = inst.name;
  $('#instVersion').textContent = loaderLabel(inst);
  $('#instRam').textContent = `🧠 ${inst.maxRamMb} MB`;
  // Vanilla instances have no mods tab, and shaders need a mod loader (Iris).
  const modded = inst.loader === 'fabric' || inst.loader === 'quilt';
  $('#instModsTab').style.display = modded ? '' : 'none';
  $('#instShadersTab').style.display = modded ? '' : 'none';
  updateInstancePowerUI();
}

function updateInstancePowerUI() {
  const inst = currentInstance();
  if (!inst) return;
  const st = inst.state || 'stopped';
  $('#instStatusDot').className = `status-dot ${instDotClass(st)}`;
  $('#instStatusLabel').className = `status-label ${instDotClass(st)}`;
  $('#instStatusLabel').textContent = instStLabel(st);
  const btn = $('#instPlayBtn');
  const busy = st === 'installing' || st === 'launching' || st === 'stopping';
  if (st === 'running' || busy) {
    btn.textContent = st === 'installing' ? '⏳ Installing…' : (st === 'stopping' ? '⏳ Closing…' : '■ Stop');
    btn.className = 'danger-btn';
  } else {
    btn.textContent = '▶ Play';
    btn.className = 'primary-btn';
  }
  btn.disabled = st === 'stopping';
}

function switchInstanceTab(tab) {
  state.instanceTab = tab;
  $$('#instanceTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.itab === tab));
  $$('#instanceDetail .tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.ipane === tab));
  if (tab === 'console') loadInstanceConsole();
  else if (tab === 'mods') loadInstanceMods();
  else if (tab === 'packs') loadInstancePacks();
  else if (tab === 'shaders') loadInstanceShaders();
  else if (tab === 'datapacks') loadInstanceDatapacks();
  else if (tab === 'settings') loadInstanceSettings();
}

async function loadInstanceConsole() {
  const inst = currentInstance();
  if (!inst) return;
  const out = $('#instConsoleOutput');
  out.innerHTML = '';
  try {
    const buffer = await call(api.launcherLogBuffer(inst.id), { silent: true });
    for (const entry of buffer) appendInstanceLogLine(entry, false);
  } catch { /* ignore */ }
  if (!out.children.length) {
    appendInstanceLogLine({ line: 'Press ▶ Play to install (first time) and launch this instance.', stream: 'sys', ts: Date.now() }, false);
  }
  out.scrollTop = out.scrollHeight;
}

function appendInstanceLogLine(entry, autoscroll = true) {
  const out = $('#instConsoleOutput');
  if (!out) return;
  const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  const cls = entry.stream === 'err' ? 'err' : entry.stream === 'sys' ? 'sys' : colorizeLevel(entry.line);
  out.appendChild(el('div', { class: `log-line ${cls}` }, entry.line));
  while (out.children.length > 2200) out.removeChild(out.firstChild);
  if (autoscroll && nearBottom) out.scrollTop = out.scrollHeight;
}

const PROGRESS_LABELS = {
  client: 'Downloading Minecraft client', libraries: 'Downloading libraries',
  assets: 'Downloading assets', java: 'Downloading Java runtime'
};
function showInstProgress(phase, done, total, received) {
  const box = $('#instProgress');
  if (!box) return;
  box.classList.remove('hidden');
  let pct = 0;
  if (total) pct = Math.min(100, Math.round(((done != null ? done : received) / total) * 100));
  box.innerHTML = '';
  box.appendChild(el('div', { class: 'ip-label' }, `${PROGRESS_LABELS[phase] || 'Preparing'}… ${total ? pct + '%' : ''}`));
  box.appendChild(el('div', { class: 'ip-track' }, el('div', { class: 'ip-fill', style: `width:${pct}%` })));
}
function hideInstProgress() { const box = $('#instProgress'); if (box) box.classList.add('hidden'); }

async function onInstancePlayToggle() {
  const inst = currentInstance();
  if (!inst) return;
  const st = inst.state || 'stopped';
  if (st === 'running' || st === 'installing' || st === 'launching') {
    try { await call(api.launcherStop(inst.id)); } catch { /* shown */ }
    return;
  }
  // Must be signed in first.
  if (!state.account) {
    switchInstanceTab('console');
    appendInstanceLogLine({ line: 'Sign in with your Microsoft account first (Play tab → account bar).', stream: 'err', ts: Date.now() });
    toast('Sign in required', 'Add your Microsoft account in the Play view to launch.', 'warn');
    return;
  }
  switchInstanceTab('console');
  try {
    await call(api.launcherPlay(inst.id));
  } catch { hideInstProgress(); /* error toasted */ }
}

// ---- Instance mods ----
async function loadInstanceMods() {
  const inst = currentInstance();
  if (!inst) return;
  const list = $('#instModsList');
  const isModded = inst.loader === 'fabric' || inst.loader === 'quilt';
  $('#instBrowseModsBtn').disabled = !isModded;
  if (!isModded) {
    $('#instModsHint').textContent = 'This is a vanilla instance — recreate it as Fabric or Quilt to add mods.';
    list.innerHTML = ''; list.appendChild(emptyList('🧊', 'Vanilla instances have no mod loader.'));
    return;
  }
  try {
    const data = await call(api.launcherModsList(inst.id));
    const n = data.entries.length;
    $('#instModsHint').textContent = `${n} mod${n === 1 ? '' : 's'} in this instance  ·  ${loaderLabel(inst)}`;
    renderInstanceModsList(inst, data.entries);
  } catch (err) {
    list.innerHTML = ''; list.appendChild(emptyList('⚠', err.message));
  }
}

function renderInstanceModsList(inst, entries) {
  const list = $('#instModsList');
  list.innerHTML = '';
  if (!entries.length) {
    list.appendChild(emptyList('🧩', 'No mods yet. Click “Browse” to install mods from Modrinth, or “Add from disk”.'));
    return;
  }
  for (const item of entries) {
    const meta = [fmtSize(item.size)];
    if (!item.enabled) meta.push('disabled');
    const toggle = el('button', { class: 'icon-btn', title: item.enabled ? 'Disable' : 'Enable' }, item.enabled ? '⏸' : '▶');
    toggle.addEventListener('click', async () => {
      try { await call(api.launcherModsToggle(inst.id, item.filename, !item.enabled)); await loadInstanceMods(); } catch { /* shown */ }
    });
    const row = el('div', { class: 'content-row' + (item.enabled ? '' : ' disabled') },
      el('div', { class: 'cr-info' },
        el('div', { class: 'cr-name' }, item.filename),
        el('div', { class: 'cr-meta' }, meta.join('  ·  '))
      ),
      toggle,
      el('button', { class: 'icon-btn', title: 'Remove', onclick: () => removeInstanceMod(inst, item) }, '🗑')
    );
    list.appendChild(row);
  }
}

async function removeInstanceMod(inst, item) {
  if (!(await confirmModal('Remove mod?', `Delete "${item.filename}" from this instance?`, { danger: true, confirmLabel: 'Remove' }))) return;
  try { await call(api.launcherModsRemove(inst.id, item.filename)); await loadInstanceMods(); } catch { /* shown */ }
}

async function onInstanceAddModLocal() {
  const inst = currentInstance();
  if (!inst) return;
  try {
    const added = await call(api.launcherModsAddLocal(inst.id));
    if (added.length) { toast('Added', `${added.length} mod(s) added.`); await loadInstanceMods(); }
  } catch { /* shown */ }
}

function openInstanceModsBrowser() {
  const inst = currentInstance();
  if (!inst || (inst.loader !== 'fabric' && inst.loader !== 'quilt')) return;
  const input = el('input', { type: 'text', placeholder: 'Search… (e.g. Sodium, Fabric API, JEI)' });
  const matchCb = el('input', { type: 'checkbox', checked: true });
  const matchLabel = el('span', {}, `Only show builds for Minecraft ${inst.mcVersion}`);
  const matchWrap = el('label', { class: 'mr-vfilter' }, matchCb, matchLabel);
  const results = el('div', { class: 'mr-results' }, el('div', { class: 'muted', style: 'padding:16px' }, 'Loading…'));
  const body = el('div', {},
    el('div', { class: 'mr-search' }, input),
    el('div', { class: 'cm-filters' }, matchWrap),
    results,
    el('div', { class: 'hint', style: 'margin-top:10px' }, 'Client mods from ',
      link('Modrinth', 'https://modrinth.com'), ` — installed straight into this ${loaderLabel(inst)} instance.`));
  modal({ title: 'Add mods', body, wide: true, actions: [{ label: 'Done', class: 'ghost-btn' }] });

  let seq = 0;
  async function doSearch() {
    const mine = ++seq;
    results.innerHTML = '';
    results.appendChild(el('div', { class: 'muted', style: 'padding:16px' }, 'Searching…'));
    try {
      const data = await call(api.launcherModsSearch(inst.id, input.value, matchCb.checked), { silent: true });
      if (mine !== seq) return;
      renderInstanceModrinthResults(inst, results, data.hits, () => matchCb.checked);
    } catch (err) {
      if (mine !== seq) return;
      results.innerHTML = ''; results.appendChild(emptyList('⚠', err.message));
    }
  }
  matchCb.addEventListener('change', doSearch);
  let t = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(doSearch, 350); });
  setTimeout(() => input.focus(), 30);
  doSearch();
}

function renderInstanceModrinthResults(inst, container, hits, getMatch) {
  container.innerHTML = '';
  if (!hits.length) { container.appendChild(emptyList('🔍', 'No matches — try a different search.')); return; }
  for (const h of hits) {
    const addBtn = el('button', { class: 'primary-btn small' }, 'Add');
    addBtn.addEventListener('click', async () => {
      const orig = addBtn.textContent;
      addBtn.disabled = true; addBtn.textContent = 'Adding…';
      const unsub = api.onLauncherModProgress((p) => {
        if (p.projectId === h.projectId && p.total) addBtn.textContent = `${Math.round((p.received / p.total) * 100)}%`;
      });
      try {
        const r = await call(api.launcherModsAdd(inst.id, h.projectId, getMatch ? getMatch() : false));
        unsub();
        addBtn.textContent = '✓ Added';
        toast('Installed', `${h.title} (${r.versionNumber})`);
        loadInstanceMods();
      } catch { unsub(); addBtn.disabled = false; addBtn.textContent = orig; }
    });
    const icon = h.icon
      ? el('img', { class: 'mr-icon', src: h.icon, alt: '', loading: 'lazy' })
      : el('div', { class: 'mr-icon mr-icon-ph' }, '🧩');
    container.appendChild(el('div', { class: 'mr-row' },
      icon,
      el('div', { class: 'mr-info' },
        el('div', { class: 'mr-title' }, h.title, el('span', { class: 'mr-author' }, ` by ${h.author}`)),
        el('div', { class: 'mr-desc' }, h.description || ''),
        el('div', { class: 'mr-meta' }, `⬇ ${Number(h.downloads).toLocaleString()} downloads`)),
      addBtn));
  }
}

// ---- Instance resource packs (works on every instance, vanilla included) ----
async function loadInstancePacks() {
  const inst = currentInstance();
  if (!inst) return;
  const list = $('#instPacksList');
  try {
    const data = await call(api.launcherPacksList(inst.id));
    const n = data.entries.length;
    $('#instPacksHint').textContent = n
      ? `${n} pack${n === 1 ? '' : 's'} installed  ·  enable them in-game under Options → Resource Packs`
      : 'Resource packs work on any instance. Add some, then enable them in-game under Options → Resource Packs.';
    renderInstancePacksList(inst, data.entries);
  } catch (err) {
    list.innerHTML = ''; list.appendChild(emptyList('⚠', err.message));
  }
}

function renderInstancePacksList(inst, entries) {
  const list = $('#instPacksList');
  list.innerHTML = '';
  if (!entries.length) {
    list.appendChild(emptyList('🎨', 'No resource packs yet. Click “Browse” to find packs on Modrinth, or “Add from disk”.'));
    return;
  }
  for (const item of entries) {
    const row = el('div', { class: 'content-row' },
      el('div', { class: 'cr-info' },
        el('div', { class: 'cr-name' }, item.filename),
        el('div', { class: 'cr-meta' }, fmtSize(item.size))
      ),
      el('button', { class: 'icon-btn', title: 'Remove', onclick: () => removeInstancePack(inst, item) }, '🗑')
    );
    list.appendChild(row);
  }
}

async function removeInstancePack(inst, item) {
  if (!(await confirmModal('Remove pack?', `Delete "${item.filename}" from this instance?`, { danger: true, confirmLabel: 'Remove' }))) return;
  try { await call(api.launcherPacksRemove(inst.id, item.filename)); await loadInstancePacks(); } catch { /* shown */ }
}

async function onInstanceAddPackLocal() {
  const inst = currentInstance();
  if (!inst) return;
  try {
    const added = await call(api.launcherPacksAddLocal(inst.id));
    if (added.length) { toast('Added', `${added.length} pack(s) added.`); await loadInstancePacks(); }
  } catch { /* shown */ }
}

function openInstancePacksBrowser() {
  const inst = currentInstance();
  if (!inst) return;
  const input = el('input', { type: 'text', placeholder: 'Search… (e.g. Faithful, Fresh Animations)' });
  const matchCb = el('input', { type: 'checkbox', checked: true });
  const matchLabel = el('span', {}, `Only show packs for Minecraft ${inst.mcVersion}`);
  const matchWrap = el('label', { class: 'mr-vfilter' }, matchCb, matchLabel);
  const results = el('div', { class: 'mr-results' }, el('div', { class: 'muted', style: 'padding:16px' }, 'Loading…'));
  const body = el('div', {},
    el('div', { class: 'mr-search' }, input),
    el('div', { class: 'cm-filters' }, matchWrap),
    results,
    el('div', { class: 'hint', style: 'margin-top:10px' }, 'Resource packs from ',
      link('Modrinth', 'https://modrinth.com'), '. After installing, enable them in-game under Options → Resource Packs.'));
  modal({ title: 'Add resource packs', body, wide: true, actions: [{ label: 'Done', class: 'ghost-btn' }] });

  let seq = 0;
  async function doSearch() {
    const mine = ++seq;
    results.innerHTML = '';
    results.appendChild(el('div', { class: 'muted', style: 'padding:16px' }, 'Searching…'));
    try {
      const data = await call(api.launcherPacksSearch(inst.id, input.value, matchCb.checked), { silent: true });
      if (mine !== seq) return;
      renderInstancePackResults(inst, results, data.hits, () => matchCb.checked);
    } catch (err) {
      if (mine !== seq) return;
      results.innerHTML = ''; results.appendChild(emptyList('⚠', err.message));
    }
  }
  matchCb.addEventListener('change', doSearch);
  let t = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(doSearch, 350); });
  setTimeout(() => input.focus(), 30);
  doSearch();
}

function renderInstancePackResults(inst, container, hits, getMatch) {
  container.innerHTML = '';
  if (!hits.length) { container.appendChild(emptyList('🔍', 'No matches — try a different search.')); return; }
  for (const h of hits) {
    const addBtn = el('button', { class: 'primary-btn small' }, 'Add');
    addBtn.addEventListener('click', async () => {
      const orig = addBtn.textContent;
      addBtn.disabled = true; addBtn.textContent = 'Adding…';
      const unsub = api.onLauncherPackProgress((p) => {
        if (p.projectId === h.projectId && p.total) addBtn.textContent = `${Math.round((p.received / p.total) * 100)}%`;
      });
      try {
        const r = await call(api.launcherPacksAdd(inst.id, h.projectId, getMatch ? getMatch() : false));
        unsub();
        addBtn.textContent = '✓ Added';
        toast('Installed', `${h.title} (${r.versionNumber})`);
        loadInstancePacks();
      } catch { unsub(); addBtn.disabled = false; addBtn.textContent = orig; }
    });
    const icon = h.icon
      ? el('img', { class: 'mr-icon', src: h.icon, alt: '', loading: 'lazy' })
      : el('div', { class: 'mr-icon mr-icon-ph' }, '🎨');
    container.appendChild(el('div', { class: 'mr-row' },
      icon,
      el('div', { class: 'mr-info' },
        el('div', { class: 'mr-title' }, h.title, el('span', { class: 'mr-author' }, ` by ${h.author}`)),
        el('div', { class: 'mr-desc' }, h.description || ''),
        el('div', { class: 'mr-meta' }, `⬇ ${Number(h.downloads).toLocaleString()} downloads`)),
      addBtn));
  }
}

// ---- Instance shaders (Fabric/Quilt only; rendered through the Iris mod) ----
async function loadInstanceShaders() {
  const inst = currentInstance();
  if (!inst) return;
  const list = $('#instShadersList');
  try {
    const data = await call(api.launcherShadersList(inst.id));
    const n = data.entries.length;
    $('#instShadersHint').textContent = `${n} shader${n === 1 ? '' : 's'} installed  ·  needs the Iris mod (add it in the Mods tab), then enable in-game under Options → Video → Shaders`;
    renderInstanceShadersList(inst, data.entries);
  } catch (err) {
    list.innerHTML = ''; list.appendChild(emptyList('⚠', err.message));
  }
}

function renderInstanceShadersList(inst, entries) {
  const list = $('#instShadersList');
  list.innerHTML = '';
  if (!entries.length) {
    list.appendChild(emptyList('✨', 'No shaders yet. Install the Iris mod (Mods tab), then “Browse” for shaders or “Add from disk”.'));
    return;
  }
  for (const item of entries) {
    const row = el('div', { class: 'content-row' },
      el('div', { class: 'cr-info' },
        el('div', { class: 'cr-name' }, item.filename),
        el('div', { class: 'cr-meta' }, fmtSize(item.size))
      ),
      el('button', { class: 'icon-btn', title: 'Remove', onclick: () => removeInstanceShader(inst, item) }, '🗑')
    );
    list.appendChild(row);
  }
}

async function removeInstanceShader(inst, item) {
  if (!(await confirmModal('Remove shader?', `Delete "${item.filename}" from this instance?`, { danger: true, confirmLabel: 'Remove' }))) return;
  try { await call(api.launcherShadersRemove(inst.id, item.filename)); await loadInstanceShaders(); } catch { /* shown */ }
}

async function onInstanceAddShaderLocal() {
  const inst = currentInstance();
  if (!inst) return;
  try {
    const added = await call(api.launcherShadersAddLocal(inst.id));
    if (added.length) { toast('Added', `${added.length} shader(s) added.`); await loadInstanceShaders(); }
  } catch { /* shown */ }
}

function openInstanceShadersBrowser() {
  const inst = currentInstance();
  if (!inst) return;
  const input = el('input', { type: 'text', placeholder: 'Search… (e.g. Complementary, BSL, Sildur’s)' });
  const matchCb = el('input', { type: 'checkbox', checked: true });
  const matchLabel = el('span', {}, `Only show shaders for Minecraft ${inst.mcVersion}`);
  const matchWrap = el('label', { class: 'mr-vfilter' }, matchCb, matchLabel);
  const results = el('div', { class: 'mr-results' }, el('div', { class: 'muted', style: 'padding:16px' }, 'Loading…'));
  const body = el('div', {},
    el('div', { class: 'mr-search' }, input),
    el('div', { class: 'cm-filters' }, matchWrap),
    results,
    el('div', { class: 'hint', style: 'margin-top:10px' }, 'Shaders from ',
      link('Modrinth', 'https://modrinth.com'), '. They run through the ', el('b', {}, 'Iris'),
      ' mod — install Iris (and Sodium) from the Mods tab, then enable a shader in-game under Options → Video → Shaders.'));
  modal({ title: 'Add shaders', body, wide: true, actions: [{ label: 'Done', class: 'ghost-btn' }] });

  let seq = 0;
  async function doSearch() {
    const mine = ++seq;
    results.innerHTML = '';
    results.appendChild(el('div', { class: 'muted', style: 'padding:16px' }, 'Searching…'));
    try {
      const data = await call(api.launcherShadersSearch(inst.id, input.value, matchCb.checked), { silent: true });
      if (mine !== seq) return;
      renderInstanceShaderResults(inst, results, data.hits, () => matchCb.checked);
    } catch (err) {
      if (mine !== seq) return;
      results.innerHTML = ''; results.appendChild(emptyList('⚠', err.message));
    }
  }
  matchCb.addEventListener('change', doSearch);
  let t = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(doSearch, 350); });
  setTimeout(() => input.focus(), 30);
  doSearch();
}

function renderInstanceShaderResults(inst, container, hits, getMatch) {
  container.innerHTML = '';
  if (!hits.length) { container.appendChild(emptyList('🔍', 'No matches — try a different search.')); return; }
  for (const h of hits) {
    const addBtn = el('button', { class: 'primary-btn small' }, 'Add');
    addBtn.addEventListener('click', async () => {
      const orig = addBtn.textContent;
      addBtn.disabled = true; addBtn.textContent = 'Adding…';
      const unsub = api.onLauncherShaderProgress((p) => {
        if (p.projectId === h.projectId && p.total) addBtn.textContent = `${Math.round((p.received / p.total) * 100)}%`;
      });
      try {
        const r = await call(api.launcherShadersAdd(inst.id, h.projectId, getMatch ? getMatch() : false));
        unsub();
        addBtn.textContent = '✓ Added';
        toast('Installed', `${h.title} (${r.versionNumber})`);
        loadInstanceShaders();
      } catch { unsub(); addBtn.disabled = false; addBtn.textContent = orig; }
    });
    const icon = h.icon
      ? el('img', { class: 'mr-icon', src: h.icon, alt: '', loading: 'lazy' })
      : el('div', { class: 'mr-icon mr-icon-ph' }, '✨');
    container.appendChild(el('div', { class: 'mr-row' },
      icon,
      el('div', { class: 'mr-info' },
        el('div', { class: 'mr-title' }, h.title, el('span', { class: 'mr-author' }, ` by ${h.author}`)),
        el('div', { class: 'mr-desc' }, h.description || ''),
        el('div', { class: 'mr-meta' }, `⬇ ${Number(h.downloads).toLocaleString()} downloads`)),
      addBtn));
  }
}

// ---- Instance datapacks (per world — installed into saves/<world>/datapacks) ----
const currentWorld = () => $('#instWorldSelect').value || '';

async function loadInstanceDatapacks() {
  const inst = currentInstance();
  if (!inst) return;
  const sel = $('#instWorldSelect');
  const prev = sel.value;
  let worlds = [];
  try { worlds = (await call(api.launcherWorldsList(inst.id), { silent: true })).worlds; } catch { worlds = []; }
  sel.innerHTML = '';
  const hasWorlds = worlds.length > 0;
  sel.style.display = hasWorlds ? '' : 'none';
  $('#instBrowseDatapacksBtn').disabled = !hasWorlds;
  $('#instAddDatapacksBtn').disabled = !hasWorlds;
  if (!hasWorlds) {
    $('#instDatapacksHint').textContent = 'Datapacks apply to a specific world. Launch this instance and create a singleplayer world first, then come back.';
    const list = $('#instDatapacksList'); list.innerHTML = '';
    list.appendChild(emptyList('🌍', 'No worlds yet. Play the instance and make a world, then add datapacks to it.'));
    return;
  }
  for (const w of worlds) sel.appendChild(el('option', { value: w }, w));
  if (worlds.includes(prev)) sel.value = prev;
  await loadInstanceDatapacksList();
}

async function loadInstanceDatapacksList() {
  const inst = currentInstance();
  if (!inst) return;
  const world = currentWorld();
  if (!world) return;
  const list = $('#instDatapacksList');
  try {
    const data = await call(api.launcherDatapacksList(inst.id, world));
    const n = data.entries.length;
    $('#instDatapacksHint').textContent = `${n} datapack${n === 1 ? '' : 's'} in “${world}”  ·  run /reload in-game (or rejoin the world) to apply changes`;
    renderInstanceDatapacksList(inst, world, data.entries);
  } catch (err) {
    list.innerHTML = ''; list.appendChild(emptyList('⚠', err.message));
  }
}

function renderInstanceDatapacksList(inst, world, entries) {
  const list = $('#instDatapacksList');
  list.innerHTML = '';
  if (!entries.length) {
    list.appendChild(emptyList('📦', 'No datapacks in this world yet. Click “Browse” to find datapacks on Modrinth, or “Add from disk”.'));
    return;
  }
  for (const item of entries) {
    const row = el('div', { class: 'content-row' },
      el('div', { class: 'cr-info' },
        el('div', { class: 'cr-name' }, item.filename),
        el('div', { class: 'cr-meta' }, fmtSize(item.size))
      ),
      el('button', { class: 'icon-btn', title: 'Remove', onclick: () => removeInstanceDatapack(inst, world, item) }, '🗑')
    );
    list.appendChild(row);
  }
}

async function removeInstanceDatapack(inst, world, item) {
  if (!(await confirmModal('Remove datapack?', `Delete "${item.filename}" from the world “${world}”?`, { danger: true, confirmLabel: 'Remove' }))) return;
  try { await call(api.launcherDatapacksRemove(inst.id, world, item.filename)); await loadInstanceDatapacksList(); } catch { /* shown */ }
}

async function onInstanceAddDatapackLocal() {
  const inst = currentInstance();
  const world = currentWorld();
  if (!inst || !world) return;
  try {
    const added = await call(api.launcherDatapacksAddLocal(inst.id, world));
    if (added.length) { toast('Added', `${added.length} datapack(s) added to “${world}”.`); await loadInstanceDatapacksList(); }
  } catch { /* shown */ }
}

function openInstanceDatapacksBrowser() {
  const inst = currentInstance();
  const world = currentWorld();
  if (!inst || !world) return;
  const input = el('input', { type: 'text', placeholder: 'Search… (e.g. Terralith, Incendium, Tectonic)' });
  const matchCb = el('input', { type: 'checkbox', checked: true });
  const matchLabel = el('span', {}, `Only show datapacks for Minecraft ${inst.mcVersion}`);
  const matchWrap = el('label', { class: 'mr-vfilter' }, matchCb, matchLabel);
  const results = el('div', { class: 'mr-results' }, el('div', { class: 'muted', style: 'padding:16px' }, 'Loading…'));
  const body = el('div', {},
    el('div', { class: 'mr-search' }, input),
    el('div', { class: 'cm-filters' }, matchWrap),
    results,
    el('div', { class: 'hint', style: 'margin-top:10px' }, 'Datapacks from ',
      link('Modrinth', 'https://modrinth.com'), ` — installed into the world “`, el('b', {}, world),
      '”. Run ', el('b', {}, '/reload'), ' in-game (or rejoin the world) to apply them. Note: worldgen datapacks only affect newly-generated chunks.'));
  modal({ title: `Add datapacks to “${world}”`, body, wide: true, actions: [{ label: 'Done', class: 'ghost-btn' }] });

  let seq = 0;
  async function doSearch() {
    const mine = ++seq;
    results.innerHTML = '';
    results.appendChild(el('div', { class: 'muted', style: 'padding:16px' }, 'Searching…'));
    try {
      const data = await call(api.launcherDatapacksSearch(inst.id, input.value, matchCb.checked), { silent: true });
      if (mine !== seq) return;
      renderInstanceDatapackResults(inst, world, results, data.hits, () => matchCb.checked);
    } catch (err) {
      if (mine !== seq) return;
      results.innerHTML = ''; results.appendChild(emptyList('⚠', err.message));
    }
  }
  matchCb.addEventListener('change', doSearch);
  let t = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(doSearch, 350); });
  setTimeout(() => input.focus(), 30);
  doSearch();
}

function renderInstanceDatapackResults(inst, world, container, hits, getMatch) {
  container.innerHTML = '';
  if (!hits.length) { container.appendChild(emptyList('🔍', 'No matches — try a different search.')); return; }
  for (const h of hits) {
    const addBtn = el('button', { class: 'primary-btn small' }, 'Add');
    addBtn.addEventListener('click', async () => {
      const orig = addBtn.textContent;
      addBtn.disabled = true; addBtn.textContent = 'Adding…';
      const unsub = api.onLauncherDatapackProgress((p) => {
        if (p.projectId === h.projectId && p.total) addBtn.textContent = `${Math.round((p.received / p.total) * 100)}%`;
      });
      try {
        const r = await call(api.launcherDatapacksAdd(inst.id, world, h.projectId, getMatch ? getMatch() : false));
        unsub();
        addBtn.textContent = '✓ Added';
        toast('Installed', `${h.title} (${r.versionNumber}) → “${world}”`);
        loadInstanceDatapacksList();
      } catch { unsub(); addBtn.disabled = false; addBtn.textContent = orig; }
    });
    const icon = h.icon
      ? el('img', { class: 'mr-icon', src: h.icon, alt: '', loading: 'lazy' })
      : el('div', { class: 'mr-icon mr-icon-ph' }, '📦');
    container.appendChild(el('div', { class: 'mr-row' },
      icon,
      el('div', { class: 'mr-info' },
        el('div', { class: 'mr-title' }, h.title, el('span', { class: 'mr-author' }, ` by ${h.author}`)),
        el('div', { class: 'mr-desc' }, h.description || ''),
        el('div', { class: 'mr-meta' }, `⬇ ${Number(h.downloads).toLocaleString()} downloads`)),
      addBtn));
  }
}

// ---- Instance settings ----
function loadInstanceSettings() {
  const inst = currentInstance();
  if (!inst) return;
  const form = $('#instSettingsForm');
  form.innerHTML = '';

  const nameInput = el('input', { type: 'text', value: inst.name });
  const minInput = el('input', { type: 'number', min: '512', step: '256', value: String(inst.minRamMb) });
  const maxInput = el('input', { type: 'number', min: '512', step: '256', value: String(inst.maxRamMb) });
  const javaInput = el('input', { type: 'text', value: inst.javaPath || '', placeholder: 'Auto (matched to the Minecraft version)' });
  const argsInput = el('input', { type: 'text', value: inst.javaArgs || '', placeholder: 'e.g. -XX:+UseG1GC' });

  const save = async (patch) => {
    try {
      const updated = await call(api.launcherUpdate(inst.id, patch));
      Object.assign(inst, updated);
      renderInstanceDetail();
    } catch { /* shown */ }
  };

  form.appendChild(el('div', { class: 'field' },
    el('label', {}, 'Instance name'), nameInput,
    (() => { nameInput.addEventListener('change', () => save({ name: nameInput.value.trim() || inst.name })); return null; })()));

  form.appendChild(el('div', { class: 'field-row' },
    el('div', { class: 'field' }, el('label', {}, 'Min RAM (MB)'), minInput),
    el('div', { class: 'field' }, el('label', {}, 'Max RAM (MB)'), maxInput)));
  const saveRam = () => save({ minRamMb: parseInt(minInput.value, 10) || 1024, maxRamMb: parseInt(maxInput.value, 10) || 2048 });
  minInput.addEventListener('change', saveRam);
  maxInput.addEventListener('change', saveRam);

  form.appendChild(el('div', { class: 'field' },
    el('label', {}, 'Java path'), javaInput,
    el('div', { class: 'hint' }, 'Leave blank to let VoxelDeck download the right Java automatically.')));
  javaInput.addEventListener('change', () => save({ javaPath: javaInput.value.trim() }));

  form.appendChild(el('div', { class: 'field' },
    el('label', {}, 'Extra JVM arguments'), argsInput));
  argsInput.addEventListener('change', () => save({ javaArgs: argsInput.value.trim() }));

  form.appendChild(el('div', { class: 'field' },
    el('label', {}, 'Version'),
    el('div', { class: 'hint' }, `${loaderLabel(inst)}${inst.loaderVersion ? ' · loader ' + inst.loaderVersion : ''}. The Minecraft version and loader are fixed when an instance is created — make a new instance to change them.`)));

  const del = el('button', { class: 'danger-btn', style: 'width:auto' }, 'Delete this instance');
  del.addEventListener('click', () => deleteInstance(inst));
  form.appendChild(el('div', { class: 'field' }, del));
}

async function deleteInstance(inst) {
  const wipe = await confirmModal('Delete instance?',
    `Delete "${inst.name}" and its worlds/mods from disk? This can’t be undone.`,
    { danger: true, confirmLabel: 'Delete everything' });
  if (!wipe) return;
  try {
    await call(api.launcherDelete(inst.id, true));
    state.selectedInstanceId = null;
    await showLauncher();
  } catch { /* shown */ }
}

// ---- New instance flow ----
async function openNewInstanceModal() {
  const nameInput = el('input', { type: 'text', placeholder: 'My World', value: 'New Instance' });
  const loaderSelect = el('select', {},
    el('option', { value: 'vanilla' }, 'Vanilla (no mods)'),
    el('option', { value: 'fabric' }, 'Fabric (mods)'),
    el('option', { value: 'quilt' }, 'Quilt (mods)'));
  const versionSelect = el('select', {}, el('option', {}, 'Loading versions…'));
  const snapshotCb = el('input', { type: 'checkbox' });

  const body = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Name'), nameInput),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' }, el('label', {}, 'Mod loader'), loaderSelect),
      el('div', { class: 'field' }, el('label', {}, 'Minecraft version'), versionSelect)),
    el('div', { class: 'field' }, el('label', { class: 'mr-vfilter' }, snapshotCb, el('span', {}, 'Include snapshots')),
      el('div', { class: 'hint' }, 'Fabric/Quilt cover most recent releases. The right Java runtime is downloaded automatically on first launch.')));

  let versionData = null;
  const fillVersions = () => {
    if (!versionData) return;
    const list = snapshotCb.checked ? [...versionData.releases, ...versionData.snapshots] : versionData.releases;
    versionSelect.innerHTML = '';
    for (const v of list) versionSelect.appendChild(el('option', { value: v.id }, v.id + (v.type === 'snapshot' ? ' (snapshot)' : '')));
    if (versionData.latest && versionData.latest.release) versionSelect.value = versionData.latest.release;
  };
  snapshotCb.addEventListener('change', fillVersions);
  (async () => {
    try { versionData = await call(api.launcherMcVersions(), { silent: true }); fillVersions(); }
    catch { versionSelect.innerHTML = ''; versionSelect.appendChild(el('option', {}, 'Could not load versions')); }
  })();

  modal({
    title: 'New instance',
    body,
    actions: [
      { label: 'Cancel', class: 'ghost-btn' },
      {
        label: 'Create', class: 'primary-btn',
        onClick: async () => {
          const name = nameInput.value.trim() || 'New Instance';
          const mcVersion = versionSelect.value;
          const loader = loaderSelect.value;
          if (!mcVersion || mcVersion.startsWith('Loading') || mcVersion.startsWith('Could')) {
            toast('Pick a version', 'Choose a Minecraft version first.', 'warn'); return true;
          }
          try {
            const inst = await call(api.launcherCreate({ name, mcVersion, loader }));
            toast('Instance created', `${name} · ${loaderLabel(inst)}`);
            await refreshInstances();
            selectInstance(inst.id);
          } catch { return true; /* keep modal open on error */ }
        }
      }
    ]
  });
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 30);
}

// ---- Microsoft account ----
async function loadAccountBar() {
  try {
    const info = await call(api.accountGet(), { silent: true });
    state.account = info.account;
    state.accountConfigured = info.configured;
  } catch { state.account = null; }
  renderAccountBar();
}

function renderAccountBar() {
  const bar = $('#accountBar');
  if (!bar) return;
  bar.innerHTML = '';
  if (state.account) {
    bar.appendChild(el('div', { class: 'account-avatar' }, '🙂'));
    bar.appendChild(el('div', { class: 'ab-info' },
      el('div', { class: 'ab-name' }, state.account.name),
      el('div', { class: 'ab-sub' }, 'Signed in with Microsoft — ready to play')));
    const out = el('button', { class: 'ghost-btn', style: 'width:auto' }, 'Sign out');
    out.addEventListener('click', onAccountLogout);
    bar.appendChild(out);
  } else {
    bar.appendChild(el('div', { class: 'account-avatar' }, '🔑'));
    bar.appendChild(el('div', { class: 'ab-info' },
      el('div', { class: 'ab-name' }, 'Not signed in'),
      el('div', { class: 'ab-sub' }, state.accountConfigured
        ? 'Sign in with a Microsoft account that owns Minecraft to launch.'
        : '⚠ Microsoft login isn’t configured yet (the app needs an Azure client ID — see the README).')));
    const login = el('button', { class: 'primary-btn' }, 'Sign in with Microsoft');
    login.disabled = !state.accountConfigured;
    login.addEventListener('click', onAccountLogin);
    bar.appendChild(login);
  }
}

async function onAccountLogin() {
  // Show the device code as it arrives, then complete in the background.
  let codeShown = false;
  const unsub = api.onAccountCode((info) => {
    codeShown = true;
    const body = el('div', {},
      el('p', {}, 'Open this page and enter the code to sign in:'),
      el('div', { class: 'device-code' }, info.userCode),
      el('p', { class: 'hint' }, 'Go to ', link(info.verificationUri, info.verificationUri),
        ' and enter the code above. This window updates automatically once you finish.'));
    const openBtn = { label: 'Open sign-in page', class: 'primary-btn', onClick: () => { api.openExternal(info.verificationUri); return true; } };
    modal({ title: 'Sign in with Microsoft', body, actions: [{ label: 'Cancel', class: 'ghost-btn', onClick: () => { api.accountCancelLogin(); } }, openBtn] });
  });
  try {
    const acc = await call(api.accountLogin());
    state.account = acc;
    $('#modalHost').classList.add('hidden'); $('#modalHost').innerHTML = '';
    renderAccountBar();
    toast('Signed in', `Welcome, ${acc.name}!`);
  } catch (err) {
    if (codeShown) { $('#modalHost').classList.add('hidden'); $('#modalHost').innerHTML = ''; }
    // error already toasted by call()
  } finally { unsub(); }
}

async function onAccountLogout() {
  if (!(await confirmModal('Sign out?', 'Remove this Microsoft account from VoxelDeck?', { confirmLabel: 'Sign out' }))) return;
  try { await call(api.accountLogout()); state.account = null; renderAccountBar(); } catch { /* shown */ }
}

// ---- go ----
init();
