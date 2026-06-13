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
  // files tab
  filesCwd: '.',
  openFile: null,
  fileDirty: false,
  // console history per server
  history: {},          // id -> [commands]
  historyIdx: {},       // id -> index
  // cached log render position to avoid full re-render
  renderedLogCount: {}  // id -> number
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

  // properties
  $('#savePropsBtn').addEventListener('click', saveProperties);

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
        el('div', { class: 'si-meta' }, `${typeLabel(srv.type)} · ${stLabel(st)}`)
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
  $('#serverDetail').classList.remove('hidden');
  $('#homeNavBtn').classList.remove('active');
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
  $('#homeView').classList.remove('hidden');
  $('#homeNavBtn').classList.add('active');
  renderServerList();
  renderHome();
}

function showEmpty() {
  state.view = 'empty';
  state.selectedId = null;
  $('#serverDetail').classList.add('hidden');
  $('#homeView').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
  $('#homeNavBtn').classList.remove('active');
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
        el('span', {}, typeLabel(srv.type)),
        el('span', {}, `👥 ${stats.players}${stats.maxPlayers ? '/' + stats.maxPlayers : ''}`),
        el('span', {}, `🧠 ${fmtMb(srv.maxRamMb)}`)
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

function renderDetail() {
  const srv = currentServer();
  if (!srv) return;
  $('#detailName').textContent = srv.name;
  $('#contentTab').textContent = contentLabel(srv.type);
  $('#contentTitle').textContent = contentLabel(srv.type);
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
  $('#consoleInput').disabled = !live;
  $('#consoleSend').disabled = !live;
}

function updateStatsUI() {
  const srv = currentServer();
  if (!srv) return;
  const stats = srv.stats || { players: 0, maxPlayers: 0 };
  $('#detailPlayers').textContent = `👥 ${stats.players}${stats.maxPlayers ? '/' + stats.maxPlayers : ''}`;
  $('#detailRam').textContent = `🧠 ${(srv.maxRamMb / 1024).toFixed(srv.maxRamMb % 1024 ? 1 : 0)} GB`;
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
  else if (tab === 'properties') loadProperties();
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
  if (port === 25565) {
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
          el('button', { class: 'primary-btn small', onclick: async () => {
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
  const autoWrap = el('div', { class: 'field' });
  const autoCb = el('input', { type: 'checkbox' });
  autoCb.checked = !!srv.autoRestart;
  autoCb.addEventListener('change', () => patch(srv, { autoRestart: autoCb.checked }));
  autoWrap.appendChild(el('div', { class: 'checkbox-field' }, autoCb, el('label', { style: 'margin:0' }, 'Auto-restart if the server crashes')));
  card4.appendChild(autoWrap);
  form.appendChild(card4);

  // --- Danger ---
  const card5 = sectionCard('Danger zone', 'Remove this server from the dashboard. Your files on disk are NOT deleted.');
  const del = el('button', { class: 'danger-btn', onclick: () => deleteServer(srv) }, 'Remove server from dashboard');
  card5.appendChild(del);
  form.appendChild(card5);
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
    await call(api.deleteServer(srv.id));
    state.selectedId = null;
    await refreshServers();
    if (state.servers.length) showHome();
    else showEmpty();
  } catch { /* shown */ }
}

// ============================================================================
// Add-server modal
// ============================================================================
/** Best-effort server type from a jar filename. */
function guessTypeFromJar(filePath) {
  const n = baseName(filePath).toLowerCase();
  if (n.includes('purpur')) return 'purpur';
  if (n.includes('paper')) return 'paper';
  if (n.includes('spigot')) return 'spigot';
  if (n.includes('craftbukkit') || n.includes('bukkit')) return 'bukkit';
  if (n.includes('neoforge')) return 'neoforge';
  if (n.includes('forge')) return 'forge';
  if (n.includes('fabric')) return 'fabric';
  if (n.includes('quilt')) return 'quilt';
  if (n.includes('vanilla') || n.includes('minecraft_server') || n === 'server.jar') return 'vanilla';
  return null;
}

/** Local mirror of the main-process folder sanitizer, for the live preview. */
function sanitizeFolderPreview(name) {
  const cleaned = String(name || '').trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return cleaned || 'server';
}

function openAddServerModal() {
  let parentDir = state.settings.serversRoot || state.sysInfo.defaultServersRoot || '';
  let jarSource = '';   // absolute path to the chosen jar (copied on create)

  const nameInput = el('input', { type: 'text', id: 'tourAddName', placeholder: 'My Survival Server' });
  const typeSel = el('select', { id: 'tourAddType' }, ...SERVER_TYPES.map((t) => el('option', { value: t.value }, t.label)));

  // --- jar chooser ---
  const jarName = el('span', { class: 'muted', style: 'font-family:var(--mono);font-size:12px;word-break:break-all' }, 'No file chosen — you can add one later');
  const jarBtn = el('button', { class: 'ghost-btn', id: 'tourAddJar', style: 'width:auto;white-space:nowrap', onclick: async () => {
    const file = await call(api.pickJar());
    if (!file) return;
    jarSource = file;
    jarName.textContent = baseName(file);
    jarName.classList.remove('muted');
    const guessed = guessTypeFromJar(file);
    if (guessed) typeSel.value = guessed;  // auto-detect software from the jar name
  } }, 'Choose .jar…');

  // --- location + live preview ---
  const preview = el('div', { class: 'hint', style: 'font-family:var(--mono)' });
  const updatePreview = () => {
    preview.textContent = `📁 Creates: ${parentDir}/${sanitizeFolderPreview(nameInput.value)}`;
  };
  nameInput.addEventListener('input', updatePreview);
  const changeLocBtn = el('button', { class: 'ghost-btn', style: 'width:auto;white-space:nowrap', onclick: async () => {
    const dir = await call(api.pickDirectory());
    if (dir) { parentDir = dir; updatePreview(); }
  } }, 'Change…');
  updatePreview();

  const body = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Server name'), nameInput),
    el('div', { class: 'field' },
      el('label', {}, 'Server jar'),
      el('div', { style: 'display:flex;align-items:center;gap:10px' }, jarBtn, jarName),
      el('div', { class: 'hint' }, 'Point to your server .jar anywhere on disk — it’s copied into the new folder. The software type is auto-detected from the name.')),
    el('div', { class: 'field' }, el('label', {}, 'Server software'), typeSel),
    el('div', { class: 'field' },
      el('label', {}, 'Location'),
      el('div', { style: 'display:flex;align-items:center;gap:10px' },
        changeLocBtn,
        el('span', { class: 'muted', style: 'font-size:12px' }, 'where the folder is created')),
      preview)
  );

  modal({
    title: 'Add a server',
    sub: 'The dashboard creates and sets up the folder for you.',
    body,
    actions: [
      { label: 'Cancel', class: 'ghost-btn' },
      { label: 'Create server', class: 'primary-btn', id: 'tourAddCreate', onClick: async () => {
        const name = nameInput.value.trim();
        if (!name) { toast('Name required', 'Give your server a name.', 'warn'); return true; }
        try {
          const created = await call(api.setupServer({ name, type: typeSel.value, parentDir, jarSource }));
          await refreshServers();
          selectServer(created.id);
          switchTab('settings');
          toast('Server ready',
            jarSource
              ? 'Folder created and jar copied in. Set RAM & accept the EULA, then flip the toggle.'
              : 'Folder created. Add a jar in Settings, then flip the toggle to start.');
        } catch { return true; }
      } }
    ]
  });
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
      el('label', {}, 'Getting started'),
      el('button', { class: 'ghost-btn', style: 'width:auto', onclick: () => {
        const host = $('#modalHost'); host.classList.add('hidden'); host.innerHTML = '';
        startTour();
      } }, '↻ Replay the guided tour')),
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
        const patch = { javaPath: javaInput.value.trim(), serversRoot: rootInput.value.trim() };
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
    'Not sure? ', el('b', {}, 'Paper'), ' is a great default — you can change it any time in Settings. ',
    'Pick a .jar below, or grab one later with ⬇ Download. Then press Next.');
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

    { id: 'software', target: '#tourAddJar', hole: M, interactive: true, requiresModal: true, waitFor: '#tourAddJar',
      title: 'Choose your server software',
      body: 'This decides what your server can do — whether it supports plugins, mods, or neither:',
      node: serverSoftwareNode() },

    { id: 'create', target: '#tourAddCreate', hole: M, interactive: true, requiresModal: true, next: false,
      hint: 'Click “Create server” to continue', advanceWhen: () => state.view === 'detail', waitFor: '#tourAddCreate',
      title: 'Create it!',
      body: 'When you’re happy, click “Create server”. The dashboard creates the folder and sets everything up for you.' },

    { id: 'tabs', target: '#tabs', waitFor: '#tabs',
      title: 'Your server is ready! 🎉',
      body: 'Here’s your new server. These tabs are how you manage it:', node: tabsExplainerNode() },

    { id: 'settings-tab', target: '.tab[data-tab="settings"]',
      title: 'Start here: Settings',
      body: 'You’ve landed on the Settings tab. This is where you set how much RAM to give the server, pick or ⬇ download the jar, set your Java path, and accept the Minecraft EULA — everything you need before the first start.' },

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

// ---- go ----
init();
