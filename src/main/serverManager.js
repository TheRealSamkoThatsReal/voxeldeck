'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const games = require('./games');

/**
 * Owns the lifecycle of every Minecraft server process.
 *
 * States: stopped → starting → running → stopping → stopped
 *
 * Emits:
 *   'state'  { id, state, pid }
 *   'log'    { id, line, stream }   stream = 'out' | 'err' | 'sys'
 *   'stats'  { id, players, maxPlayers, ... }
 */
class ServerManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {proc, state, logBuffer, players, maxPlayers, server, stopTimer, manualStop}>} */
    this.runtime = new Map();
    this.MAX_LOG_LINES = 2000;
  }

  getRuntime(id) {
    if (!this.runtime.has(id)) {
      this.runtime.set(id, {
        proc: null,
        state: 'stopped',
        logBuffer: [],
        playerNames: new Set(),  // names of players currently online
        maxPlayers: 0,
        server: null,
        stopTimer: null,
        manualStop: false
      });
    }
    return this.runtime.get(id);
  }

  getState(id) {
    return this.getRuntime(id).state;
  }

  getLogBuffer(id) {
    return this.getRuntime(id).logBuffer;
  }

  getStats(id) {
    const rt = this.getRuntime(id);
    return { players: rt.playerNames.size, maxPlayers: rt.maxPlayers };
  }

  /** Names of players currently online (from join/leave + `list` parsing). */
  getPlayerNames(id) {
    return [...this.getRuntime(id).playerNames];
  }

  isRunning(id) {
    const s = this.getRuntime(id).state;
    return s === 'running' || s === 'starting' || s === 'stopping';
  }

  _setState(id, state) {
    const rt = this.getRuntime(id);
    rt.state = state;
    this.emit('state', { id, state, pid: rt.proc ? rt.proc.pid : null });
  }

  _pushLog(id, line, stream = 'out') {
    const rt = this.getRuntime(id);
    const entry = { line, stream, ts: Date.now() };
    rt.logBuffer.push(entry);
    if (rt.logBuffer.length > this.MAX_LOG_LINES) {
      rt.logBuffer.splice(0, rt.logBuffer.length - this.MAX_LOG_LINES);
    }
    this.emit('log', { id, ...entry });
  }

  /** Resolve the java executable to use for a server. */
  _resolveJava(server, globalJavaPath) {
    if (server.javaPath && server.javaPath.trim()) return server.javaPath.trim();
    if (globalJavaPath && globalJavaPath.trim()) return globalJavaPath.trim();
    return 'java'; // rely on PATH
  }

  async start(server, globalJavaPath) {
    const id = server.id;
    const rt = this.getRuntime(id);
    rt.server = server;

    if (this.isRunning(id)) {
      throw new Error('Server is already running');
    }

    const game = games.get(server.game);
    const platform = process.platform;

    // Validate prerequisites (directory + jar/binary) with a friendly message.
    game.validate(server, platform);

    // Native game binaries can lose their executable bit through zip extraction
    // or a file copy — restore it best-effort before launching.
    if (game.capabilities.native && game.binaryPath) {
      try { fs.chmodSync(game.binaryPath(server, platform), 0o755); } catch { /* best effort */ }
    }

    const resolvedJava = this._resolveJava(server, globalJavaPath);
    const launch = game.launch(server, { resolvedJava, platform });

    rt.manualStop = false;
    rt.playerNames.clear();
    this._setState(id, 'starting');
    this._pushLog(id, `$ ${launch.command} ${launch.args.join(' ')}`, 'sys');
    this._pushLog(id, `(working directory: ${launch.cwd})`, 'sys');

    let proc;
    try {
      proc = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env || process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      this._setState(id, 'stopped');
      this._pushLog(id, `Failed to launch: ${err.message}`, 'err');
      throw err;
    }

    rt.proc = proc;

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        const hint = game.id === 'minecraft'
          ? 'Install Java or set a Java path in Settings.'
          : 'The server files may be missing — re-run setup from Settings.';
        this._pushLog(id, `Couldn’t launch ("${launch.command}"). ${hint}`, 'err');
      } else {
        this._pushLog(id, `Process error: ${err.message}`, 'err');
      }
      rt.proc = null;
      this._setState(id, 'stopped');
    });

    proc.stdout.on('data', (chunk) => this._handleOutput(id, chunk, 'out'));
    proc.stderr.on('data', (chunk) => this._handleOutput(id, chunk, 'err'));

    proc.on('exit', (code, signal) => {
      if (rt.stopTimer) { clearTimeout(rt.stopTimer); rt.stopTimer = null; }
      const how = signal ? `signal ${signal}` : `exit code ${code}`;
      this._pushLog(id, `Server process ended (${how}).`, 'sys');
      rt.proc = null;
      rt.playerNames.clear();
      const wasManual = rt.manualStop;
      this._setState(id, 'stopped');
      this.emit('stats', { id, players: 0, maxPlayers: rt.maxPlayers });

      // Auto-restart on unexpected crash, if enabled.
      if (!wasManual && code !== 0 && rt.server && rt.server.autoRestart) {
        this._pushLog(id, 'Auto-restart enabled — restarting in 5s…', 'sys');
        setTimeout(() => {
          if (this.getState(id) === 'stopped') {
            this.start(rt.server, globalJavaPath).catch((e) =>
              this._pushLog(id, `Auto-restart failed: ${e.message}`, 'err'));
          }
        }, 5000);
      }
    });

    return { pid: proc.pid };
  }

  _handleOutput(id, chunk, stream) {
    const rt = this.getRuntime(id);
    const text = chunk.toString('utf8');
    const lines = text.split(/\r?\n/);
    // Keep the trailing partial line attached to the next chunk would be
    // ideal; for a console this line-split is good enough and simpler.
    for (const line of lines) {
      if (line.length === 0) continue;
      this._pushLog(id, line, stream);
      this._scanLine(id, line);
    }
  }

  /** Parse interesting events out of server log lines (per-game rules). */
  _scanLine(id, line) {
    const rt = this.getRuntime(id);
    const game = games.get(rt.server && rt.server.game);
    const p = game.parse || {};

    // Transition starting → running when the server reports it's ready.
    if (rt.state === 'starting' && (p.ready || []).some((re) => re.test(line))) {
      this._setState(id, 'running');
    }

    // Player tracking only applies to games that surface players in their logs.
    if (!game.capabilities.players) return;

    // Player join / leave, capturing the player name.
    if (p.join) {
      const m = line.match(p.join);
      if (m) { rt.playerNames.add(m[1].trim()); this._emitStats(id); }
    }
    if (p.leave) {
      const m = line.match(p.leave);
      if (m) { rt.playerNames.delete(m[1].trim()); this._emitStats(id); }
    }

    // Output of a roster command (e.g. Minecraft `list`) — authoritative sync.
    if (p.list) {
      const m = line.match(p.list);
      if (m) {
        rt.maxPlayers = parseInt(m[1], 10);
        const names = (m[2] || '')
          .split(',')
          .map((s) => s.trim().split(/\s+/)[0]) // drop any "(uuid)"/suffix
          .filter((s) => /^[A-Za-z0-9_]{1,16}$/.test(s));
        rt.playerNames = new Set(names);
        this._emitStats(id);
      }
    }

    // Max players from a config/log line, if present.
    if (p.maxPlayers) {
      const m = line.match(p.maxPlayers);
      if (m) { rt.maxPlayers = parseInt(m[1], 10); this._emitStats(id); }
    }
  }

  _emitStats(id) {
    const rt = this.getRuntime(id);
    this.emit('stats', { id, players: rt.playerNames.size, maxPlayers: rt.maxPlayers });
  }

  /** Push an informational line into a server's console (e.g. from the scheduler). */
  systemLog(id, line) {
    this._pushLog(id, line, 'sys');
  }

  /** Send a raw command line to the server's stdin. */
  sendCommand(id, command) {
    const rt = this.getRuntime(id);
    if (!rt.proc || !rt.proc.stdin.writable) {
      throw new Error('Server is not running');
    }
    rt.proc.stdin.write(command.replace(/\r?\n$/, '') + '\n');
    this._pushLog(id, `> ${command}`, 'sys');
  }

  /** Graceful stop: send `stop`, then SIGTERM, then SIGKILL on timeout. */
  async stop(id, { force = false } = {}) {
    const rt = this.getRuntime(id);
    if (!rt.proc) {
      this._setState(id, 'stopped');
      return;
    }
    rt.manualStop = true;

    if (force) {
      this._pushLog(id, 'Force killing server…', 'sys');
      try { rt.proc.kill('SIGKILL'); } catch { /* already gone */ }
      return;
    }

    this._setState(id, 'stopping');
    const spec = games.get(rt.server && rt.server.game).stopSpec(rt.server);
    if (spec.type === 'signal') {
      this._pushLog(id, `Sending ${spec.signal} to server (it saves on shutdown)…`, 'sys');
      try { rt.proc.kill(spec.signal); } catch { /* ignore */ }
    } else {
      this._pushLog(id, `Sending "${spec.command}" to server…`, 'sys');
      try {
        if (rt.proc.stdin.writable) rt.proc.stdin.write(spec.command + '\n');
      } catch { /* ignore */ }
    }

    // Escalate if it doesn't exit cleanly.
    rt.stopTimer = setTimeout(() => {
      if (rt.proc) {
        this._pushLog(id, 'Stop timed out — sending SIGTERM…', 'sys');
        try { rt.proc.kill('SIGTERM'); } catch { /* ignore */ }
        rt.stopTimer = setTimeout(() => {
          if (rt.proc) {
            this._pushLog(id, 'Still alive — sending SIGKILL…', 'sys');
            try { rt.proc.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }, 8000);
      }
    }, 25000);
  }

  /** Stop everything (called on app quit). */
  async stopAll() {
    const ids = [...this.runtime.keys()].filter((id) => this.isRunning(id));
    for (const id of ids) {
      const rt = this.getRuntime(id);
      const spec = games.get(rt.server && rt.server.game).stopSpec(rt.server);
      try {
        if (spec.type === 'signal') { if (rt.proc) rt.proc.kill(spec.signal); }
        else if (rt.proc && rt.proc.stdin.writable) rt.proc.stdin.write(spec.command + '\n');
      } catch { /* ignore */ }
    }
    // Give them a moment, then hard-kill leftovers.
    await new Promise((r) => setTimeout(r, 4000));
    for (const id of ids) {
      const rt = this.getRuntime(id);
      if (rt.proc) {
        try { rt.proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
  }
}

module.exports = new ServerManager();
