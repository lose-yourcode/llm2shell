'use strict';

const path = require('path');
const fs = require('fs');

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || process.cwd();
}

/**
 * SessionStore
 * ------------
 * Lightweight logical sessions for the browser Bridge. The Bridge executes each
 * command in a *fresh* child process (accurate stdout/stderr/exit capture), so
 * a session is a persistent working-directory context rather than a live PTY.
 *
 * `cd` is emulated: a command that is exactly `cd <path>` updates the session's
 * cwd for subsequent commands. Multi-line scripts containing `cd` are executed
 * as-is but do not change the tracked cwd (documented limitation).
 */
class SessionStore {
  constructor(options = {}) {
    this.sessions = new Map();
    this._n = 0;
    this.defaultCwd = options.cwd || homeDir();
    // Injectable SSH session factory (tests / custom transports).
    this.sshFactory = options.sshFactory || null;
    // Injectable ~/.ssh/config resolver (tests pass a stub).
    this.sshConfigResolver = options.sshConfigResolver || null;
    // Always have one usable session.
    this.create(options.defaultName || 'default', this.defaultCwd);
  }

  create(name, cwd) {
    const id = 'sess-' + ++this._n;
    const session = {
      id,
      name: name || id,
      type: 'local',
      cwd: cwd || this.defaultCwd,
      createdAt: new Date().toISOString()
    };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Create a persistent SSH session. The connection is opened by `connect()`.
   *
   * `config.host` may be an `~/.ssh/config` alias (e.g. `myserver`). When it is,
   * HostName/User/Port/IdentityFile are filled in from the config file, so the
   * user can type the same alias they use in their own shell.
   */
  createSSH(config = {}) {
    const resolved = this._resolveSshTarget(config);
    const id = 'ssh-' + ++this._n;
    const session = {
      id,
      name: config.name || ((resolved.username || 'user') + '@' + (resolved.host || 'host')),
      type: 'ssh',
      cwd: config.cwd || '~',
      host: resolved.host,
      port: resolved.port || 22,
      username: resolved.username,
      status: 'disconnected',
      ssh: null,
      alias: resolved.alias || null,
      createdAt: new Date().toISOString()
    };

    const factory = this.sshFactory || ((cfg) => {
      // Lazy require so the module loads without ssh2 installed.
      const SshSession = require('./sshSession');
      return new SshSession(cfg);
    });
    session.ssh = factory(resolved);

    this.sessions.set(id, session);
    return session;
  }

  /**
   * Merge an SSH config alias and a key file into a usable ssh2 config.
   * Throws a readable error when the alias needs something ssh2 cannot do.
   */
  _resolveSshTarget(config) {
    const cfg = Object.assign({}, config);
    const alias = String(cfg.host || '').trim();

    if (alias && !cfg.noAliasLookup) {
      let resolved = null;
      try {
        const resolver = this.sshConfigResolver || require('./sshConfig').resolveHost;
        resolved = resolver(alias);
      } catch (_) {
        resolved = null;
      }
      if (resolved) {
        if (resolved.proxyJump || resolved.proxyCommand) {
          const via = resolved.proxyJump ? 'ProxyJump ' + resolved.proxyJump : 'ProxyCommand';
          throw new Error(
            'SSH alias "' + alias + '" uses ' + via + ', which this Bridge does not support. ' +
              'Use the HostName (' + resolved.host + ') directly, or reach the host some other way.'
          );
        }
        cfg.host = resolved.host;
        cfg.port = cfg.port || resolved.port;
        cfg.username = cfg.username || resolved.username;
        cfg.identityFile = cfg.identityFile || resolved.identityFile;
        cfg.alias = resolved.alias;
      }
    }

    if (cfg.identityFile && !cfg.privateKey) {
      const file = cfg.identityFile;
      try {
        cfg.privateKey = fs.readFileSync(file);
      } catch (e) {
        throw new Error('Cannot read SSH key "' + file + '": ' + e.message);
      }
    }
    return cfg;
  }

  async connect(id) {
    const s = this.get(id);
    if (!s || s.type !== 'ssh') throw new Error('not an SSH session');
    s.status = 'connecting';
    try {
      await s.ssh.connect();
      s.status = 'connected';
      return s;
    } catch (err) {
      s.status = 'error';
      throw err;
    }
  }

  async execSSH(id, command, opts = {}) {
    const s = this.get(id);
    if (!s || s.type !== 'ssh') throw new Error('not an SSH session');
    if (!s.ssh) throw new Error('SSH session has no connection');
    return s.ssh.exec(command, Object.assign({ cwd: s.cwd }, opts));
  }

  /** Safe, serialisable view (never includes passwords or keys). */
  publicInfo(id) {
    const s = this.get(id);
    if (!s) return null;
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      cwd: s.cwd,
      host: s.host,
      port: s.port,
      username: s.username,
      status: s.status || 'ready'
    };
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  list() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      cwd: s.cwd,
      host: s.host,
      port: s.port,
      username: s.username,
      status: s.status || 'ready'
    }));
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.type === 'ssh' && s.ssh) {
      try { s.ssh.close(); } catch (_) {}
    }
    this.sessions.delete(id);
    return true;
  }

  resolveCwd(id) {
    const s = id ? this.get(id) : this.list()[0];
    return s ? s.cwd : this.defaultCwd;
  }

  /**
   * If `command` is exactly `cd [path]`, update the session cwd (only when the
   * target exists). Returns true when the cwd changed.
   */
  applyCd(id, command) {
    const s = id ? this.get(id) : this.list()[0];
    if (!s) return false;

    const m = /^\s*cd(?:\s+(.+?))?\s*$/i.exec(String(command || ''));
    if (!m) return false;

    let target = (m[1] || '~').replace(/^["']|["']$/g, '').trim();
    if (target === '~') target = homeDir();
    // Expand Windows-style %VAR% references.
    target = target.replace(/%([^%]+)%/g, (_, v) => process.env[v] || '');

    const next = path.isAbsolute(target) ? path.normalize(target) : path.resolve(s.cwd, target);
    try {
      if (fs.existsSync(next) && fs.statSync(next).isDirectory()) {
        s.cwd = next;
        return true;
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }
}

module.exports = SessionStore;
