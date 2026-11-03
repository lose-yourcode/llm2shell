'use strict';

/**
 * SshSession
 * ----------
 * A *persistent* SSH connection backed by ssh2. One TCP/auth connection is kept
 * open; each command runs in a fresh channel via `client.exec()`. This is what
 * avoids the "connect → run one command → disconnect" behaviour of the OpenSSH
 * CLI's command mode.
 *
 * `exec()` does not allocate a PTY (pty:false), which is correct for
 * non-interactive commands and avoids the OpenSSH "Pseudo-terminal will not be
 * allocated" warning. Interactive TUI programs would need a `client.shell()`
 * channel instead.
 *
 * The ssh2 module is injectable for tests.
 */
class SshSession {
  constructor(config = {}, deps = {}) {
    this.config = config;
    this._ssh = deps.ssh || null;
    this.client = null;
    this.connected = false;
    this.lastError = null;
  }

  _requireSsh() {
    if (!this._ssh) {
      try {
        this._ssh = require('ssh2');
      } catch (e) {
        throw new Error('ssh2 is not installed (' + e.message + '). Run `npm install ssh2`.');
      }
    }
    return this._ssh;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const { Client } = this._requireSsh();
      const client = new Client();
      this.client = client;

      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      client.on('ready', () => {
        this.connected = true;
        finish();
      });
      client.on('error', (err) => {
        this.connected = false;
        this.lastError = err;
        finish(err);
      });
      client.on('close', () => {
        this.connected = false;
      });

      try {
        client.connect({
          host: this.config.host,
          port: this.config.port || 22,
          username: this.config.username,
          password: this.config.password,
          privateKey: this.config.privateKey,
          passphrase: this.config.passphrase,
          readyTimeout: this.config.readyTimeout || 20000
        });
      } catch (err) {
        finish(err);
      }
    });
  }

  /**
   * Run one command over the persistent connection.
   * @returns {Promise<{exitCode:number,stdout:string,stderr:string,timedOut:boolean}>}
   */
  exec(command, opts = {}) {
    const { cwd, timeout = 60000, onData } = opts;

    return new Promise((resolve, reject) => {
      if (!this.client || !this.connected) {
        reject(new Error('SSH session is not connected'));
        return;
      }

      let full = String(command || '');
      // Emulate a persistent working directory for this stateless-per-command model.
      if (cwd && cwd !== '~') {
        const q = String(cwd).replace(/'/g, "'\\''");
        full = "cd '" + q + "' && (\n" + command + "\n)";
      }

      let settled = false;
      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        fn(val);
      };

      this.client.exec(full, { pty: false }, (err, stream) => {
        if (err) {
          finish(reject, err);
          return;
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = timeout
          ? setTimeout(() => {
              timedOut = true;
              try { stream.close(); } catch (_) {}
            }, timeout)
          : null;

        stream.on('data', (d) => {
          const s = d.toString('utf8');
          stdout += s;
          if (onData) onData(s, 'stdout');
        });
        stream.stderr.on('data', (d) => {
          const s = d.toString('utf8');
          stderr += s;
          if (onData) onData(s, 'stderr');
        });
        stream.on('close', (code) => {
          if (timer) clearTimeout(timer);
          finish(resolve, {
            exitCode: code == null ? (timedOut ? 124 : -1) : code,
            stdout,
            stderr,
            timedOut
          });
        });
        stream.on('error', (e) => {
          if (timer) clearTimeout(timer);
          finish(reject, e);
        });
      });
    });
  }

  close() {
    if (this.client) {
      try { this.client.end(); } catch (_) {}
    }
    this.connected = false;
  }
}

module.exports = SshSession;
