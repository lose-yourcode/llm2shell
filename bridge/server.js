'use strict';

/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 WorkBuddy AI
 * Licensed under the GNU GPL v3 or later; see LICENSE.
 *
 * LLM2Shell Bridge
 * ----------------
 * A local WebSocket service that executes shell commands on behalf of the
 * browser extension. It binds to 127.0.0.1 only, requires a token handshake,
 * and rejects connections whose Origin is a normal web page (so arbitrary
 * websites cannot drive your shell).
 *
 * Protocol (JSON):
 *   client -> bridge : hello {token}
 *                      run {reqId, command, sessionId, lang}
 *                      session.create {reqId, name, cwd}
 *                      session.list {reqId}
 *                      session.kill {reqId, sessionId}
 *                      ping {reqId}
 *   bridge -> client : hello.ok {version, sessions}
 *                      run.started {reqId, sessionId, command, startTime}
 *                      output {reqId, sessionId, stream, data}
 *                      result {reqId, sessionId, command, exitCode, stdout, stderr,
 *                              status, startTime, endTime}
 *                      sessions {reqId, sessions}
 *                      session.created / session.killed
 *                      error {reqId, message}
 *                      auth.error {message}
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const CommandExecutor = require('../src/bridge/commandExecutor');
const SessionStore = require('../src/bridge/sessionStore');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const VERSION = '0.2.0';

function tokenFile() {
  return path.join(__dirname, '.token');
}

function loadToken() {
  if (process.env.AWT_TOKEN) return process.env.AWT_TOKEN;
  try {
    const t = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (t) return t;
  } catch (_) {
    /* not created yet */
  }
  const t = crypto.randomBytes(16).toString('hex');
  try {
    fs.writeFileSync(tokenFile(), t, 'utf8');
  } catch (_) {
    /* read-only fs is fine, token still returned */
  }
  return t;
}

/**
 * Start the Bridge.
 * @returns {Promise<{server, wss, token, host, port, sessions, close}>}
 */
function createBridgeServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port == null ? DEFAULT_PORT : options.port;
  const token = options.token || loadToken();
  const executor = options.executor || new CommandExecutor();
  const sessions = options.sessions || new SessionStore();

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`LLM2Shell bridge ${VERSION}\nStatus: running\nSessions: ${sessions.list().length}\n`);
  });

  const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin || '';
    // Allow extension origins and no-Origin clients (CLI/tests); reject web pages.
    if (origin && !/^(chrome-extension|moz-extension):\/\//i.test(origin)) {
      ws.close(4003, 'forbidden origin');
      return;
    }

    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) ws.close(4001, 'auth timeout');
    }, 5000);

    const send = (obj) => {
      try {
        ws.send(JSON.stringify(obj));
      } catch (_) {
        /* socket closed */
      }
    };

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

      if (!authed) {
        if (msg.type === 'hello' && msg.token === token) {
          authed = true;
          clearTimeout(authTimer);
          send({ type: 'hello.ok', version: VERSION, sessions: sessions.list() });
        } else {
          send({ type: 'auth.error', message: 'invalid token' });
          ws.close(4002, 'unauthorized');
        }
        return;
      }

      handleMessage(msg).catch((err) => send({ type: 'error', reqId: msg.reqId, message: err.message }));
    });

    ws.on('close', () => clearTimeout(authTimer));

    async function handleMessage(msg) {
      const reqId = msg.reqId || 'r_' + Date.now();

      switch (msg.type) {
        case 'ping':
          send({ type: 'pong', reqId });
          return;

        case 'session.create': {
          if (msg.sessionType === 'ssh') {
            if (!msg.host) {
              send({ type: 'error', reqId, message: 'SSH requires a host (or an ~/.ssh/config alias)' });
              return;
            }
            let s;
            try {
              s = sessions.createSSH({
                name: msg.name,
                host: msg.host,
                port: msg.port,
                username: msg.username,
                password: msg.password,
                identityFile: msg.identityFile,
                privateKey: msg.privateKey,
                passphrase: msg.passphrase,
                cwd: msg.cwd
              });
            } catch (err) {
              send({ type: 'error', reqId, message: 'SSH session rejected: ' + err.message });
              return;
            }
            if (!s.username) {
              sessions.kill(s.id);
              send({
                type: 'error',
                reqId,
                message:
                  'SSH needs a username. "' + msg.host + '" is not an alias in ~/.ssh/config, ' +
                  'so fill in the user field (or type the alias exactly as in `ssh <alias>`).'
              });
              return;
            }
            try {
              await sessions.connect(s.id);
              send({ type: 'session.created', reqId, session: sessions.publicInfo(s.id) });
            } catch (err) {
              sessions.kill(s.id);
              send({ type: 'error', reqId, message: 'SSH connect failed: ' + err.message });
            }
            return;
          }
          const s = sessions.create(msg.name, msg.cwd);
          send({ type: 'session.created', reqId, session: sessions.publicInfo(s.id) });
          return;
        }

        case 'session.list':
          send({ type: 'sessions', reqId, sessions: sessions.list() });
          return;

        case 'session.kill':
          sessions.kill(msg.sessionId);
          send({ type: 'session.killed', reqId, sessionId: msg.sessionId });
          return;

        case 'run': {
          const command = String(msg.command || '');
          if (!command.trim()) {
            send({ type: 'error', reqId, message: 'empty command' });
            return;
          }

          let sessionId = msg.sessionId;
          if (!sessionId) {
            const first = sessions.list()[0];
            sessionId = first ? first.id : null;
          }

          sessions.applyCd(sessionId, command);
          const cwd = sessions.resolveCwd(sessionId);
          const startTime = new Date().toISOString();
          send({ type: 'run.started', reqId, sessionId, command, startTime });

          const session = sessions.get(sessionId);
          const onData = (data, stream) =>
            send({ type: 'output', reqId, sessionId, stream: stream || 'stdout', data });

          let res;
          if (session && session.type === 'ssh') {
            // Persistent SSH connection: reuse it instead of re-running `ssh`.
            res = await sessions.execSSH(sessionId, command, { onData });
          } else {
            res = await executor.run({ command, cwd, onData });
          }

          send({
            type: 'result',
            reqId,
            sessionId,
            command,
            exitCode: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
            timedOut: !!res.timedOut,
            invalid: !!res.invalid,
            status: res.exitCode === 0 ? 'success' : 'failed',
            startTime,
            endTime: new Date().toISOString()
          });
          return;
        }

        default:
          send({ type: 'error', reqId, message: 'unknown message type: ' + msg.type });
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        server,
        wss,
        token,
        host,
        port: addr.port,
        sessions,
        close: () =>
          new Promise((r) => {
            for (const client of wss.clients) {
              try { client.terminate(); } catch (_) {}
            }
            wss.close(() => server.close(() => r()));
          })
      });
    });
  });
}

if (require.main === module) {
  const port = parseInt(process.env.AWT_PORT, 10) || DEFAULT_PORT;
  createBridgeServer({ port })
    .then(({ port: actual, token }) => {
      console.log('');
      console.log('  LLM2Shell Bridge');
      console.log('  ----------------');
      console.log(`  Listening : ws://127.0.0.1:${actual}`);
      console.log(`  Token     : ${token}`);
      console.log('');
      console.log('  Next: open the extension options page and paste the token.');
      console.log('  Keep this window open while you use ChatGPT / Gemini.');
      console.log('');
    })
    .catch((err) => {
      console.error('Bridge failed to start:', err.message);
      process.exit(1);
    });
}

module.exports = { createBridgeServer, loadToken, VERSION, DEFAULT_PORT, DEFAULT_HOST };
