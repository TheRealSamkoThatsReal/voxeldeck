'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The single, audited surface the renderer is allowed to touch. Everything is
 * funneled through ipcRenderer.invoke (request/response) except the event
 * subscriptions, which use ipcRenderer.on with a thin unsubscribe wrapper.
 */

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  // system / app
  appInfo: () => invoke('app:info'),
  detectJava: (javaPath) => invoke('app:detectJava', javaPath),
  javaLatest: () => invoke('java:latest'),
  downloadJava: (feature) => invoke('java:download', feature),
  onJavaProgress: (cb) => on('java:progress', cb),

  // mod/plugin browser (Modrinth)
  modrinthSearch: (id, query, matchVersion) => invoke('modrinth:search', id, query, matchVersion),
  modrinthInstall: (id, projectId, matchVersion) => invoke('modrinth:install', id, projectId, matchVersion),
  onModrinthProgress: (cb) => on('modrinth:progress', cb),
  openExternal: (url) => invoke('app:openExternal', url),
  openPath: (p) => invoke('app:openPath', p),
  copyText: (text) => invoke('app:copy', text),

  // auto-update
  checkForUpdates: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),
  updateSupported: () => invoke('update:supported'),
  onUpdateStatus: (cb) => on('update:status', cb),

  // network / connection info
  netAddresses: (id) => invoke('net:addresses', id),
  netPublicIp: () => invoke('net:public'),

  // settings
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),

  // servers CRUD
  listServers: () => invoke('servers:list'),
  createServer: (partial) => invoke('servers:create', partial),
  setupServer: (opts) => invoke('servers:setup', opts),
  updateServer: (id, patch) => invoke('servers:update', id, patch),
  deleteServer: (id, deleteFiles) => invoke('servers:delete', id, deleteFiles),

  // lifecycle
  startServer: (id) => invoke('servers:start', id),
  stopServer: (id, opts) => invoke('servers:stop', id, opts),
  sendCommand: (id, command) => invoke('servers:command', id, command),
  getServerState: (id) => invoke('servers:state', id),
  getLogBuffer: (id) => invoke('servers:logBuffer', id),

  // files
  listFiles: (id, rel) => invoke('files:list', id, rel),
  readFile: (id, rel) => invoke('files:read', id, rel),
  writeFile: (id, rel, content) => invoke('files:write', id, rel, content),
  mkdir: (id, rel) => invoke('files:mkdir', id, rel),
  touch: (id, rel) => invoke('files:touch', id, rel),
  removeFile: (id, rel) => invoke('files:remove', id, rel),
  renameFile: (id, rel, newName) => invoke('files:rename', id, rel, newName),
  listJars: (id) => invoke('files:listJars', id),
  importFiles: (id, relDir) => invoke('files:import', id, relDir),

  // server.properties
  readProps: (id) => invoke('props:read', id),
  writeProps: (id, updates) => invoke('props:write', id, updates),

  // eula
  getEula: (id) => invoke('eula:get', id),
  setEula: (id, accepted) => invoke('eula:set', id, accepted),

  // players
  listPlayers: (id) => invoke('players:list', id),
  refreshPlayers: (id) => invoke('players:refresh', id),

  // mods / plugins
  listContent: (id) => invoke('content:list', id),
  toggleContent: (id, name, enable) => invoke('content:toggle', id, name, enable),
  removeContent: (id, name) => invoke('content:remove', id, name),
  addContent: (id) => invoke('content:add', id),

  // client-side mod profiles (per server) + apply to a Minecraft install
  clientModsList: (id) => invoke('clientmods:list', id),
  clientModsSearch: (id, query, matchVersion, loader) => invoke('clientmods:search', id, query, matchVersion, loader),
  clientModsAdd: (id, projectId, matchVersion, loader) => invoke('clientmods:add', id, projectId, matchVersion, loader),
  clientModsAddLocal: (id) => invoke('clientmods:addLocal', id),
  clientModsRemove: (id, filename) => invoke('clientmods:remove', id, filename),
  clientModsApply: (id, target) => invoke('clientmods:apply', id, target),
  onClientModsProgress: (cb) => on('clientmods:progress', cb),

  // backups
  backupsList: (id) => invoke('backups:list', id),
  backupsCreate: (id) => invoke('backups:create', id),
  backupsRestore: (id, name) => invoke('backups:restore', id, name),
  backupsRemove: (id, name) => invoke('backups:remove', id, name),
  backupsReveal: (id) => invoke('backups:reveal', id),
  onBackupsProgress: (cb) => on('backups:progress', cb),

  // games (multi-game support)
  gamesCatalog: () => invoke('games:catalog'),
  installGame: (id) => invoke('game:install', id),
  onGameProgress: (cb) => on('game:progress', cb),

  // server jar download
  jarMeta: () => invoke('jar:meta'),
  jarVersions: (type) => invoke('jar:versions', type),
  downloadJar: (id, version) => invoke('jar:download', id, version),
  onJarProgress: (cb) => on('jar:progress', cb),

  // singleplayer launcher (instances)
  launcherInstances: () => invoke('launcher:instances'),
  launcherMcVersions: () => invoke('launcher:mcVersions'),
  launcherLoaderVersions: (loader, mcVersion) => invoke('launcher:loaderVersions', loader, mcVersion),
  launcherCreate: (opts) => invoke('launcher:createInstance', opts),
  launcherUpdate: (id, patch) => invoke('launcher:updateInstance', id, patch),
  launcherDelete: (id, deleteFiles) => invoke('launcher:deleteInstance', id, deleteFiles),
  launcherInstall: (id) => invoke('launcher:install', id),
  launcherPlay: (id) => invoke('launcher:play', id),
  launcherStop: (id, opts) => invoke('launcher:stop', id, opts),
  launcherGetState: (id) => invoke('launcher:state', id),
  launcherLogBuffer: (id) => invoke('launcher:logBuffer', id),
  launcherOpenFolder: (id) => invoke('launcher:openFolder', id),
  onLauncherState: (cb) => on('launcher:state', cb),
  onLauncherLog: (cb) => on('launcher:log', cb),
  onLauncherProgress: (cb) => on('launcher:progress', cb),

  // per-instance mods (Modrinth)
  launcherModsList: (id) => invoke('launcher:modsList', id),
  launcherModsSearch: (id, query, matchVersion) => invoke('launcher:modsSearch', id, query, matchVersion),
  launcherModsAdd: (id, projectId, matchVersion) => invoke('launcher:modsAdd', id, projectId, matchVersion),
  launcherModsAddLocal: (id) => invoke('launcher:modsAddLocal', id),
  launcherModsToggle: (id, filename, enable) => invoke('launcher:modsToggle', id, filename, enable),
  launcherModsRemove: (id, filename) => invoke('launcher:modsRemove', id, filename),
  onLauncherModProgress: (cb) => on('launcher:modProgress', cb),

  // per-instance resource packs (Modrinth)
  launcherPacksList: (id) => invoke('launcher:packsList', id),
  launcherPacksSearch: (id, query, matchVersion) => invoke('launcher:packsSearch', id, query, matchVersion),
  launcherPacksAdd: (id, projectId, matchVersion) => invoke('launcher:packsAdd', id, projectId, matchVersion),
  launcherPacksAddLocal: (id) => invoke('launcher:packsAddLocal', id),
  launcherPacksRemove: (id, filename) => invoke('launcher:packsRemove', id, filename),
  onLauncherPackProgress: (cb) => on('launcher:packProgress', cb),

  // Microsoft account (for launching)
  accountGet: () => invoke('account:get'),
  accountLogin: () => invoke('account:login'),
  accountCancelLogin: () => invoke('account:cancelLogin'),
  accountLogout: () => invoke('account:logout'),
  onAccountCode: (cb) => on('account:code', cb),

  // native pickers
  pickDirectory: () => invoke('dialog:pickDirectory'),
  pickJar: (startDir) => invoke('dialog:pickJar', startDir),

  // events (main → renderer)
  onServerState: (cb) => on('server:state', cb),
  onServerLog: (cb) => on('server:log', cb),
  onServerStats: (cb) => on('server:stats', cb),
  onQuitting: (cb) => on('app:quitting', cb)
});
