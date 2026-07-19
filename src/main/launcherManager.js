'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fsp = require('fs/promises');
const mojang = require('./mojang');
const loaders = require('./loaders');
const games = require('./games');

/**
 * Owns installing and launching singleplayer Minecraft *client* instances —
 * the counterpart to serverManager, but for the game itself.
 *
 * States: stopped → installing → launching → running → stopping → stopped
 *
 * Emits:
 *   'state'    { id, state, pid }
 *   'log'      { id, line, stream }        stream = 'out' | 'err' | 'sys'
 *   'progress' { id, phase, done, total }  during install/download
 *
 * Unlike a server, a client is a GUI process with no stdin console, so it's
 * stopped with a signal (the player usually just closes the game window).
 */
class LauncherManager extends EventEmitter {
  constructor() {
    super();
    this.runtime = new Map();
    this.MAX_LOG_LINES = 2000;
  }

  getRuntime(id) {
    if (!this.runtime.has(id)) {
      this.runtime.set(id, { proc: null, state: 'stopped', logBuffer: [], instance: null, stopTimer: null, manualStop: false });
    }
    return this.runtime.get(id);
  }

  getState(id) { return this.getRuntime(id).state; }
  getLogBuffer(id) { return this.getRuntime(id).logBuffer; }

  isRunning(id) {
    const s = this.getRuntime(id).state;
    return s === 'installing' || s === 'launching' || s === 'running' || s === 'stopping';
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
    if (rt.logBuffer.length > this.MAX_LOG_LINES) rt.logBuffer.splice(0, rt.logBuffer.length - this.MAX_LOG_LINES);
    this.emit('log', { id, ...entry });
  }

  _progress(id, p) { this.emit('progress', { id, ...p }); }

  /**
   * Resolve+download everything needed to launch an instance. Returns
   * { merged, paths, majorVersion }. `ctx`: { home, onProgress }.
   */
  async prepare(instance, ctx) {
    if (!instance.mcVersion) throw new Error('This instance has no Minecraft version set.');
    const vanilla = await mojang.ensureVersionJson(ctx.home, instance.mcVersion);
    let merged = vanilla;
    if (instance.loader && instance.loader !== 'vanilla') {
      const lv = instance.loaderVersion || await loaders.latestLoader(instance.loader, instance.mcVersion);
      const prof = await loaders.profile(instance.loader, instance.mcVersion, lv);
      merged = mojang.mergeLoaderProfile(vanilla, prof);
    }
    const paths = await mojang.ensureFiles(ctx.home, merged, ctx.onProgress);
    const majorVersion = (vanilla.javaVersion && vanilla.javaVersion.majorVersion) || 8;
    return { merged, paths, majorVersion };
  }

  /**
   * Install an instance's files without launching (used by the "Install" button
   * so a first launch is fast). `ctx`: { home, onProgress }.
   */
  async install(instance, ctx) {
    const id = instance.id;
    if (this.isRunning(id)) throw new Error('This instance is busy.');
    this._setState(id, 'installing');
    try {
      const prep = await this.prepare(instance, { home: ctx.home, onProgress: (p) => this._progress(id, p) });
      this._setState(id, 'stopped');
      return { majorVersion: prep.majorVersion };
    } catch (err) {
      this._setState(id, 'stopped');
      throw err;
    }
  }

  /**
   * Prepare (install if needed) then launch the game.
   * `ctx`: { home, launcherVersion, ensureJava(major) -> javaBinPath }.
   */
  async play(instance, account, ctx) {
    const id = instance.id;
    const rt = this.getRuntime(id);
    if (this.isRunning(id)) throw new Error('This instance is already running.');
    rt.instance = instance;
    rt.manualStop = false;

    this._setState(id, 'installing');
    let prep;
    try {
      prep = await this.prepare(instance, { home: ctx.home, onProgress: (p) => this._progress(id, p) });
    } catch (err) {
      this._pushLog(id, `Install failed: ${err.message}`, 'err');
      this._setState(id, 'stopped');
      throw err;
    }

    // Resolve the Java binary (per-instance override, else auto by version).
    let javaBin = instance.javaPath && instance.javaPath.trim();
    if (!javaBin) {
      try {
        javaBin = await ctx.ensureJava(prep.majorVersion);
      } catch (err) {
        this._pushLog(id, `Java setup failed: ${err.message}`, 'err');
        this._setState(id, 'stopped');
        throw err;
      }
    }

    const spec = mojang.buildLaunchSpec(prep.merged, {
      clientJar: prep.paths.clientJar,
      librariesDir: prep.paths.librariesDir,
      nativesDir: prep.paths.nativesDir,
      assetsDir: prep.paths.assetsDir,
      gameDir: instance.directory,
      libraries: prep.paths.libraries
    }, account, {
      minRamMb: instance.minRamMb,
      maxRamMb: instance.maxRamMb,
      extraJvmArgs: instance.javaArgs ? games.tokenize(instance.javaArgs) : [],
      launcherVersion: ctx.launcherVersion
    });

    await fsp.mkdir(instance.directory, { recursive: true });

    this._setState(id, 'launching');
    // Log the command WITHOUT the access token (it grants access to the account).
    const safeArgs = spec.args.map((a) => (account.accessToken && a === account.accessToken ? '<token>' : a));
    this._pushLog(id, `$ ${javaBin} ${safeArgs.join(' ')}`, 'sys');
    this._pushLog(id, `(game directory: ${instance.directory})`, 'sys');

    let proc;
    try {
      proc = spawn(javaBin, spec.args, { cwd: instance.directory, env: process.env });
    } catch (err) {
      this._pushLog(id, `Failed to launch: ${err.message}`, 'err');
      this._setState(id, 'stopped');
      throw err;
    }
    rt.proc = proc;
    let sawOutput = false;

    proc.on('error', (err) => {
      this._pushLog(id, err.code === 'ENOENT'
        ? `Couldn’t launch Java ("${javaBin}"). Set a Java path or let VoxelDeck download one.`
        : `Process error: ${err.message}`, 'err');
      rt.proc = null;
      this._setState(id, 'stopped');
    });

    const onData = (chunk, stream) => {
      if (!sawOutput) { sawOutput = true; if (rt.state === 'launching') this._setState(id, 'running'); }
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.length) this._pushLog(id, line, stream);
      }
    };
    proc.stdout.on('data', (c) => onData(c, 'out'));
    proc.stderr.on('data', (c) => onData(c, 'err'));

    proc.on('exit', (code, signal) => {
      if (rt.stopTimer) { clearTimeout(rt.stopTimer); rt.stopTimer = null; }
      this._pushLog(id, `Game process ended (${signal ? `signal ${signal}` : `exit code ${code}`}).`, 'sys');
      rt.proc = null;
      // A non-zero exit that we didn't ask for is a crash worth flagging.
      if (!rt.manualStop && code && code !== 0) {
        this._pushLog(id, 'The game exited unexpectedly — check the log above for errors.', 'err');
      }
      this._setState(id, 'stopped');
    });

    return { pid: proc.pid };
  }

  /** Stop a running instance (SIGTERM, then SIGKILL). */
  async stop(id, { force = false } = {}) {
    const rt = this.getRuntime(id);
    if (!rt.proc) { this._setState(id, 'stopped'); return; }
    rt.manualStop = true;
    if (force) {
      this._pushLog(id, 'Force killing the game…', 'sys');
      try { rt.proc.kill('SIGKILL'); } catch { /* gone */ }
      return;
    }
    this._setState(id, 'stopping');
    this._pushLog(id, 'Closing the game…', 'sys');
    try { rt.proc.kill('SIGTERM'); } catch { /* ignore */ }
    rt.stopTimer = setTimeout(() => {
      if (rt.proc) { try { rt.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    }, 8000);
  }

  async stopAll() {
    const ids = [...this.runtime.keys()].filter((id) => this.isRunning(id));
    for (const id of ids) {
      const rt = this.getRuntime(id);
      try { if (rt.proc) rt.proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 2500));
    for (const id of ids) {
      const rt = this.getRuntime(id);
      if (rt.proc) { try { rt.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    }
  }
}

module.exports = new LauncherManager();
