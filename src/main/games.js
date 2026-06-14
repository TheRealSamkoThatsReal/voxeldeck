'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Game registry — the single source of truth for how each supported game is
 * launched, stopped, parsed and configured. VoxelDeck started Minecraft-only;
 * this layer lets Terraria and Valheim be first-class without sprinkling
 * `if (game === 'x')` across the codebase.
 *
 * Each definition has:
 *   - capabilities: which UI/behaviours apply (drives both backend & renderer)
 *   - launch(server, ctx): { command, args, cwd, env } to spawn
 *   - validate(server, platform): throws a friendly error if not runnable
 *   - stopSpec(server): how to ask it to stop ({type:'stdin',command} | {type:'signal',signal})
 *   - parse: regexes for ready-detection and (where supported) player tracking
 *   - configSchema: declarative fields the renderer renders for setup/settings
 *   - install: how the app can fetch/scaffold it
 *
 * The *functions* only run in the main process. `catalog()` returns the
 * JSON-serialisable subset for the renderer (over IPC).
 */

/** Split a command-line string into tokens, honoring simple quotes. */
function tokenize(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ---------------------------------------------------------------------------
// Minecraft
// ---------------------------------------------------------------------------
const minecraft = {
  id: 'minecraft',
  name: 'Minecraft',
  tagline: 'Java Edition servers — Paper, Fabric, Forge & more',
  capabilities: {
    console: true,
    stdinCommands: true,
    ram: true,
    eula: true,
    properties: true,    // server.properties editor
    players: true,       // OP / gamemode panel
    quickCommands: true,
    mods: true,          // Modrinth browser
    jarDownload: true,   // version dropdown + auto jar download
    minecraftSoftware: true // renderer shows the Paper/Fabric/… picker
  },
  defaultPort: 25565,
  configSchema: [], // handled by the existing Minecraft-specific UI
  install: { method: 'jar' },

  validate(server) {
    if (!server.directory || !fs.existsSync(server.directory)) {
      throw new Error('Server directory does not exist. Set it in Settings.');
    }
    const jarPath = path.join(server.directory, server.jar || '');
    if (!server.jar || !fs.existsSync(jarPath)) {
      throw new Error('Server jar not found. Pick one in Settings.');
    }
  },

  launch(server, ctx) {
    const args = [`-Xms${server.minRamMb}M`, `-Xmx${server.maxRamMb}M`];
    if (server.javaArgs && server.javaArgs.trim()) args.push(...tokenize(server.javaArgs));
    args.push('-jar', server.jar);
    if (server.serverArgs && server.serverArgs.trim()) args.push(...tokenize(server.serverArgs));
    return { command: ctx.resolvedJava, args, cwd: server.directory, env: process.env };
  },

  stopSpec() { return { type: 'stdin', command: 'stop' }; },

  parse: {
    ready: [/\bDone\b.*For help, type/i, /]:\s*Done\s*\(/i],
    join: /:\s([A-Za-z0-9_]{1,16}) joined the game\b/,
    leave: /:\s([A-Za-z0-9_]{1,16}) left the game\b/,
    list: /There are \d+ of a max of (\d+) players online:?\s*(.*)$/i,
    maxPlayers: /max(?:imum)?[ -]?players?[:=]\s*(\d+)/i
  }
};

// ---------------------------------------------------------------------------
// Terraria
// ---------------------------------------------------------------------------
function terrariaBinary(server, platform) {
  if (server.gameConfig && server.gameConfig.binary) {
    return path.resolve(server.directory, server.gameConfig.binary);
  }
  const name = platform === 'win32' ? 'TerrariaServer.exe' : 'TerrariaServer.bin.x86_64';
  return path.join(server.directory, name);
}

const terraria = {
  id: 'terraria',
  name: 'Terraria',
  tagline: 'Dedicated server — auto-downloaded, console & players',
  capabilities: {
    console: true,
    stdinCommands: true,
    ram: false,
    eula: false,
    properties: false,
    players: true,
    quickCommands: false,
    mods: false,
    jarDownload: false,
    native: true
  },
  defaultPort: 7777,
  // Drives the add-server form and the per-server settings editor. These values
  // are written into serverconfig.txt at setup and on save.
  configSchema: [
    { key: 'worldName', label: 'World name', type: 'text', default: 'World', placeholder: 'World' },
    { key: 'worldSize', label: 'World size', type: 'select', default: '3',
      options: [{ value: '1', label: 'Small' }, { value: '2', label: 'Medium' }, { value: '3', label: 'Large' }],
      hint: 'Used only when the world is first created.' },
    { key: 'difficulty', label: 'Difficulty', type: 'select', default: '0',
      options: [{ value: '0', label: 'Classic' }, { value: '1', label: 'Expert' }, { value: '2', label: 'Master' }, { value: '3', label: 'Journey' }] },
    { key: 'maxPlayers', label: 'Max players', type: 'number', default: 8, min: 1, max: 255 },
    { key: 'port', label: 'Port', type: 'number', default: 7777, min: 1, max: 65535 },
    { key: 'password', label: 'Server password', type: 'text', default: '', hint: 'Leave blank for no password.' },
    { key: 'motd', label: 'Welcome message (MOTD)', type: 'text', default: 'Welcome!' }
  ],
  install: { method: 'terraria-zip' },

  validate(server, platform) {
    if (!server.directory || !fs.existsSync(server.directory)) {
      throw new Error('Server directory does not exist. Set it in Settings.');
    }
    const bin = terrariaBinary(server, platform || process.platform);
    if (!fs.existsSync(bin)) {
      throw new Error('Terraria server not found. Re-run setup or set the server folder in Settings.');
    }
  },

  launch(server, ctx) {
    const bin = terrariaBinary(server, ctx.platform);
    const configPath = path.join(server.directory, 'serverconfig.txt');
    const args = ['-config', configPath, '-noupnp'];
    return { command: bin, args, cwd: server.directory, env: process.env };
  },

  stopSpec() { return { type: 'stdin', command: 'exit' }; },

  parse: {
    ready: [/Server started/i],
    // Terraria names can contain spaces; match the whole "<name> has joined."
    join: /^(.+?) has joined\.?\s*$/,
    leave: /^(.+?) has left\.?\s*$/
  },

  binaryPath: terrariaBinary,

  /** Build serverconfig.txt contents from a server's gameConfig. */
  configFile(server) {
    const c = server.gameConfig || {};
    const dir = server.directory;
    const worldName = (c.worldName || 'World').replace(/[\r\n]/g, '');
    const worldsDir = path.join(dir, 'worlds');
    const worldPath = path.join(worldsDir, worldName + '.wld');
    const lines = [
      '# Generated by VoxelDeck — edit in the server\'s Settings tab.',
      `world=${worldPath}`,
      `worldpath=${worldsDir}`,
      `autocreate=${c.worldSize || '3'}`,
      `worldname=${worldName}`,
      `difficulty=${c.difficulty || '0'}`,
      `maxplayers=${c.maxPlayers || 8}`,
      `port=${c.port || 7777}`,
      `password=${(c.password || '').replace(/[\r\n]/g, '')}`,
      `motd=${(c.motd || 'Welcome!').replace(/[\r\n]/g, '')}`,
      'secure=1',
      'upnp=0',
      'language=en/US'
    ];
    return { path: path.join(dir, 'serverconfig.txt'), contents: lines.join('\n') + '\n', ensureDirs: [worldsDir] };
  }
};

// ---------------------------------------------------------------------------
// Valheim
// ---------------------------------------------------------------------------
function valheimBinary(server, platform) {
  const name = (platform || process.platform) === 'win32' ? 'valheim_server.exe' : 'valheim_server.x86_64';
  return path.join(server.directory, name);
}

const valheim = {
  id: 'valheim',
  name: 'Valheim',
  tagline: 'Dedicated server via SteamCMD — survive & build',
  capabilities: {
    console: true,
    stdinCommands: false, // Valheim has no console input; stop via signal
    ram: false,
    eula: false,
    properties: false,
    players: false,       // names aren't reliably in the logs
    quickCommands: false,
    mods: false,
    jarDownload: false,
    native: true
  },
  defaultPort: 2456,
  configSchema: [
    { key: 'serverName', label: 'In-game server name (shown in the browser)', type: 'text', default: 'My Valheim Server', placeholder: 'My Valheim Server' },
    { key: 'worldName', label: 'World name', type: 'text', default: 'Dedicated' },
    { key: 'password', label: 'Password', type: 'text', default: '', hint: 'At least 5 characters; can’t contain the server name. Required by Valheim.' },
    { key: 'port', label: 'Port', type: 'number', default: 2456, min: 1, max: 65530, hint: 'Valheim also uses the next port up.' },
    { key: 'public', label: 'List publicly (community server browser)', type: 'bool', default: false },
    { key: 'crossplay', label: 'Enable crossplay', type: 'bool', default: false }
  ],
  install: { method: 'steamcmd', appId: '896660', steamAppId: '892970' },

  validate(server, platform) {
    if (!server.directory || !fs.existsSync(server.directory)) {
      throw new Error('Server directory does not exist. Set it in Settings.');
    }
    const bin = valheimBinary(server, platform || process.platform);
    if (!fs.existsSync(bin)) {
      throw new Error('Valheim server not installed. Re-run setup (it installs via SteamCMD).');
    }
  },

  launch(server, ctx) {
    const dir = server.directory;
    const c = server.gameConfig || {};
    const bin = valheimBinary(server, ctx.platform);
    const args = [
      '-nographics', '-batchmode',
      '-name', c.serverName || 'My Valheim Server',
      '-port', String(c.port || 2456),
      '-world', c.worldName || 'Dedicated',
      '-password', c.password || '',
      '-savedir', path.join(dir, 'data'),
      '-public', c.public ? '1' : '0'
    ];
    if (c.crossplay) args.push('-crossplay');
    const ld = path.join(dir, 'linux64');
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: ld + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''),
      SteamAppId: (this.install && this.install.steamAppId) || '892970'
    };
    return { command: bin, args, cwd: dir, env };
  },

  stopSpec() { return { type: 'signal', signal: 'SIGINT' }; },

  parse: {
    ready: [/Game server connected/i, /DungeonDB Start/i, /Session ".*" with join code/i]
  },

  binaryPath: valheimBinary
};

// ---------------------------------------------------------------------------
const GAMES = { minecraft, terraria, valheim };
const DEFAULT_GAME = 'minecraft';

function get(gameId) {
  return GAMES[gameId] || GAMES[DEFAULT_GAME];
}

function isNative(gameId) {
  return !!get(gameId).capabilities.native;
}

/** JSON-serialisable view for the renderer (no functions). */
function catalog() {
  return Object.values(GAMES).map((g) => ({
    id: g.id,
    name: g.name,
    tagline: g.tagline,
    capabilities: g.capabilities,
    defaultPort: g.defaultPort,
    configSchema: g.configSchema,
    install: g.install
  }));
}

module.exports = { GAMES, DEFAULT_GAME, get, isNative, catalog, tokenize };
