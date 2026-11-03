'use strict';

const { EventEmitter } = require('events');

/**
 * SessionManager
 * --------------
 * Owns logical terminal sessions:
 *   - local : a node-pty process (PowerShell on Windows, bash/zsh on *nix)
 *   - ssh   : an ssh2 shell stream to a remote host
 *
 * All output is emitted as `data` events tagged with sessionId so the renderer
 * can route each stream to the correct xterm instance. Designed so that the
 * node-pty / ssh2 modules are injected (lazy + overridable) -> unit-testable
 * without native dependencies.
 */
class SessionManager extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {object} [options.pty] injected node-pty (for tests)
   * @param {object} [options.ssh] injected ssh2 (for tests)
   */
  constructor(options = {}) {
    super();
    this._pty = options.pty || null;
    this._ssh = options.ssh || null;
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    this._nextId = 1;
  }

  _requirePty() {
    if (!this._pty) {
      try {
        this._pty = require('node-pty');
      } catch (e) {
        throw new Error('node-pty is not installed (' + e.message + '). Run `npm install`.');
      }
    }
    return this._pty;
  }

  _requireSsh() {
    if (!this._ssh) {
      try {
        this._ssh = require('ssh2');
      } catch (e) {
        throw new Error('ssh2 is not installed (' + e.message + '). Run `npm install`.');
      }
    }
    return this._ssh;
  }

  /** Default interactive shell for the current platform. */
  getShellForPlatform() {
    if (process.platform === 'win32') return 'powershell.exe';
    if (process.platform === 'darwin') return '/bin/zsh';
    return process.env.SHELL || '/bin/bash';
  }

  createLocal(opts = {}) {
    const pty = this._requirePty();
    const shell = opts.shell || this.getShellForPlatform();
    const cwd = opts.cwd || process.cwd();
    const cols = opts.cols || 80;
    const rows = opts.rows || 24;
    const ptyProc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env
    });
    const id = 'local-' + this._nextId++;
    const session = { id, type: 'local', shell, cwd, pty: ptyProc, alive: true };
    ptyProc.onData((d) => this.emit('data', { sessionId: id, data: d }));
    ptyProc.onExit(({ exitCode }) => {
      session.alive = false;
      this.emit('exit', { sessionId: id, exitCode });
    });
    this.sessions.set(id, session);
    this.emit('created', session);
    return session;
  }

  createSSH(opts = {}) {
    if (!opts.host) throw new Error('SSH requires a host');
    const { Client } = this._requireSsh();
    const id = 'ssh-' + this._nextId++;
    const conn = new Client();
    const session = {
      id,
      type: 'ssh',
      config: opts,
      conn,
      stream: null,
      alive: false,
      cwd: opts.cwd || '~',
      host: opts.host
    };
    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) {
          this.emit('error', { sessionId: id, error: err.message });
          return;
        }
        session.stream = stream;
        session.alive = true;
        stream.on('data', (d) => this.emit('data', { sessionId: id, data: d.toString('utf8') }));
        stream.stderr.on('data', (d) => this.emit('data', { sessionId: id, data: d.toString('utf8') }));
        stream.on('close', () => {
          session.alive = false;
          this.emit('exit', { sessionId: id });
        });
        this.emit('ready', session);
      });
    });
    conn.on('error', (err) => this.emit('error', { sessionId: id, error: err.message }));
    conn.connect({
      host: opts.host,
      port: opts.port || 22,
      username: opts.username,
      password: opts.password,
      privateKey: opts.privateKey,
      passphrase: opts.passphrase,
      readyTimeout: opts.readyTimeout || 20000
    });
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  list() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      type: s.type,
      alive: s.alive,
      cwd: s.cwd,
      shell: s.shell,
      host: s.config && s.config.host
    }));
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.type === 'local') {
      s.pty.write(data);
    } else if (s.type === 'ssh' && s.stream) {
      s.stream.write(data);
    } else {
      return false;
    }
    return true;
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s || s.type !== 'local') return false;
    try {
      s.pty.resize(cols, rows);
      return true;
    } catch (e) {
      return false;
    }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.type === 'local') {
      try { s.pty.kill(); } catch (_) {}
    } else if (s.type === 'ssh') {
      try { s.conn.end(); } catch (_) {}
    }
    this.sessions.delete(id);
    return true;
  }

  killAll() {
    for (const id of Array.from(this.sessions.keys())) this.kill(id);
  }
}

module.exports = SessionManager;
