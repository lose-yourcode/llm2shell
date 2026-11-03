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
    // Always have one usable session.
    this.create(options.defaultName || 'default', this.defaultCwd);
  }

  create(name, cwd) {
    const id = 'sess-' + ++this._n;
    const session = {
      id,
      name: name || id,
      cwd: cwd || this.defaultCwd,
      createdAt: new Date().toISOString()
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  list() {
    return Array.from(this.sessions.values());
  }

  kill(id) {
    return this.sessions.delete(id);
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
