'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

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

    // Validate directory + jar exist before spawning.
    if (!server.directory || !fs.existsSync(server.directory)) {
      throw new Error('Server directory does not exist. Set it in Settings.');
    }
    const jarPath = path.join(server.directory, server.jar || '');
    if (!server.jar || !fs.existsSync(jarPath)) {
      throw new Error('Server jar not found. Pick one in Settings.');
    }

    const java = this._resolveJava(server, globalJavaPath);

    const args = [];
    args.push(`-Xms${server.minRamMb}M`);
    args.push(`-Xmx${server.maxRamMb}M`);
    if (server.javaArgs && server.javaArgs.trim()) {
      args.push(...tokenize(server.javaArgs));
    }
    args.push('-jar', server.jar);
    if (server.serverArgs && server.serverArgs.trim()) {
      args.push(...tokenize(server.serverArgs));
    }

    rt.manualStop = false;
    rt.playerNames.clear();
    this._setState(id, 'starting');
    this._pushLog(id, `$ ${java} ${args.join(' ')}`, 'sys');
    this._pushLog(id, `(working directory: ${server.directory})`, 'sys');

    let proc;
    try {
      proc = spawn(java, args, {
        cwd: server.directory,
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
        this._pushLog(id, `Java executable not found ("${java}"). Install Java or set a Java path in Settings.`, 'err');
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

  /** Parse interesting events out of server log lines. */
  _scanLine(id, line) {
    const rt = this.getRuntime(id);

    // Transition starting → running when the server reports it's done.
    if (rt.state === 'starting' && /\bDone\b.*For help, type/i.test(line)) {
      this._setState(id, 'running');
    }
    // Some softwares just print 'Done (x.xxxs)!'
    if (rt.state === 'starting' && /]:\s*Done\s*\(/i.test(line)) {
      this._setState(id, 'running');
    }

    // Player join / leave (vanilla + most forks), capturing the player name.
    const joinM = line.match(/:\s([A-Za-z0-9_]{1,16}) joined the game\b/);
    const leaveM = line.match(/:\s([A-Za-z0-9_]{1,16}) left the game\b/);
    if (joinM) {
      rt.playerNames.add(joinM[1]);
      this._emitStats(id);
    } else if (leaveM) {
      rt.playerNames.delete(leaveM[1]);
      this._emitStats(id);
    }

    // Output of the `list` command — authoritative sync of who's online.
    //   "There are 2 of a max of 20 players online: Alice, Bob"
    const listM = line.match(/There are \d+ of a max of (\d+) players online:?\s*(.*)$/i);
    if (listM) {
      rt.maxPlayers = parseInt(listM[1], 10);
      const names = listM[2]
        .split(',')
        .map((s) => s.trim().split(/\s+/)[0]) // drop any "(uuid)"/suffix
        .filter((s) => /^[A-Za-z0-9_]{1,16}$/.test(s));
      rt.playerNames = new Set(names);
      this._emitStats(id);
    }

    // Max players from a "max-players" config/log line, if present.
    const maxMatch = line.match(/max(?:imum)?[ -]?players?[:=]\s*(\d+)/i);
    if (maxMatch) {
      rt.maxPlayers = parseInt(maxMatch[1], 10);
      this._emitStats(id);
    }
  }

  _emitStats(id) {
    const rt = this.getRuntime(id);
    this.emit('stats', { id, players: rt.playerNames.size, maxPlayers: rt.maxPlayers });
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
    this._pushLog(id, 'Sending "stop" to server…', 'sys');
    try {
      if (rt.proc.stdin.writable) rt.proc.stdin.write('stop\n');
    } catch { /* ignore */ }

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
      try {
        if (rt.proc && rt.proc.stdin.writable) rt.proc.stdin.write('stop\n');
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

/** Split a command-line string into tokens, honoring simple quotes. */
function tokenize(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

module.exports = new ServerManager();
