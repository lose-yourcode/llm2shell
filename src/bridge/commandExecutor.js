'use strict';

const { EventEmitter } = require('events');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * commandExecutor
 * ----------------
 * Runs a command through a *separate* child process so that stdout and stderr
 * are captured independently and the exit code is exact (F06). This is the
 * "capture layer", deliberately distinct from the interactive PTY terminal
 * stream (constraint #9: do not treat the PTY/tmux screen buffer as the only
 * source of results).
 *
 * Output is also streamed to an optional `onData` callback so the user can
 * watch execution live in the terminal panel.
 */
class CommandExecutor extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.shell] override shell (default: powershell on win32, bash elsewhere)
   */
  constructor(options = {}) {
    super();
    this.shell = options.shell || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
  }

  /**
   * Run a command and resolve with { exitCode, stdout, stderr, timedOut }.
   * @param {object} opts
   * @param {string} opts.command
   * @param {string} [opts.cwd]
   * @param {number} [opts.timeout] ms; 0 disables
   * @param {(data:string, stream:'stdout'|'stderr')=>void} [opts.onData]
   * @returns {Promise<{exitCode:number,stdout:string,stderr:string,timedOut:boolean}>}
   */
  run({ command, cwd, timeout = 60000, onData } = {}) {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const spawnOpts = {
        cwd: cwd || process.cwd(),
        env: process.env,
        windowsHide: true
      };

      let child;
      let tmpFile = null;

      try {
        if (isWin) {
          // PowerShell: use a temp .ps1 for reliable multi-line execution.
          tmpFile = path.join(os.tmpdir(), 'awt_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.ps1');
          fs.writeFileSync(tmpFile, command, 'utf8');
          child = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], spawnOpts);
        } else {
          child = cp.spawn('bash', ['-c', command], spawnOpts);
        }
      } catch (err) {
        if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) {} }
        resolve({ exitCode: -1, stdout: '', stderr: '[spawn error] ' + err.message, timedOut: false });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const cleanup = () => {
        if (tmpFile) {
          try { fs.unlinkSync(tmpFile); } catch (_) {}
          tmpFile = null;
        }
      };

      child.stdout.on('data', (d) => {
        const s = d.toString();
        stdout += s;
        if (onData) onData(s, 'stdout');
      });
      child.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        if (onData) onData(s, 'stderr');
      });
      child.on('error', (err) => {
        stderr += '\n[spawn error] ' + err.message;
        if (onData) onData('[error] ' + err.message);
      });

      const timer = timeout
        ? setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch (_) {}
          }, timeout)
        : null;

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        cleanup();
        resolve({
          exitCode: code === null ? (timedOut ? 124 : -1) : code,
          stdout,
          stderr,
          timedOut
        });
      });
    });
  }
}

module.exports = CommandExecutor;
