'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const SessionManager = require('../src/terminal/sessionManager');
const CommandExecutor = require('../src/bridge/commandExecutor');
const ResultCollector = require('../src/bridge/resultCollector');

let mainWindow = null;

const sessions = new SessionManager();
const executor = new CommandExecutor();
const results = new ResultCollector();

// ---------------------------------------------------------------------------
// Session metadata persistence (for "reconnect after restart", A11).
// We persist the *description* of each session (never passwords / private keys)
// so the app can recreate/reconnect the logical session on next launch.
// ---------------------------------------------------------------------------
function sessionsFile() {
  return path.join(app.getPath('userData'), 'sessions.json');
}

function loadSavedSessions() {
  try {
    const raw = fs.readFileSync(sessionsFile(), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function saveSessionConfig(config) {
  try {
    const list = loadSavedSessions().filter((c) => c.id !== config.id);
    list.push(config);
    fs.mkdirSync(path.dirname(sessionsFile()), { recursive: true });
    fs.writeFileSync(sessionsFile(), JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.warn('[awt] failed to persist session config:', e.message);
  }
}

function removeSavedSession(id) {
  try {
    const list = loadSavedSessions().filter((c) => c.id !== id);
    fs.writeFileSync(sessionsFile(), JSON.stringify(list, null, 2), 'utf8');
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Renderer messaging
// ---------------------------------------------------------------------------
function sendToRenderer(channel, payload) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function wireSessionEvents() {
  sessions.on('data', ({ sessionId, data }) => sendToRenderer('bridge:data', { sessionId, data }));
  sessions.on('exit', ({ sessionId, exitCode }) => sendToRenderer('bridge:exit', { sessionId, exitCode }));
  sessions.on('error', ({ sessionId, error }) => sendToRenderer('bridge:error', { sessionId, error }));
  sessions.on('ready', ({ id }) => sendToRenderer('bridge:ready', { id }));
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: 'LLM2Shell — AI Web Terminal Bridge',
    backgroundColor: '#1b1e24',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.env.AWT_DEV === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  // ---- terminal sessions -------------------------------------------------
  ipcMain.handle('session:create', (e, opts = {}) => {
    try {
      if (opts.type === 'ssh') {
        const s = sessions.createSSH(opts);
        saveSessionConfig({
          id: s.id,
          type: 'ssh',
          host: opts.host,
          port: opts.port || 22,
          username: opts.username,
          cwd: opts.cwd || '~'
        });
        return { id: s.id, type: s.type };
      }
      const s = sessions.createLocal(opts);
      saveSessionConfig({
        id: s.id,
        type: 'local',
        shell: s.shell,
        cwd: s.cwd
      });
      return { id: s.id, type: s.type, shell: s.shell, cwd: s.cwd };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('session:list', () => sessions.list());

  ipcMain.handle('session:get', (e, id) => {
    const s = sessions.get(id);
    return s ? { id: s.id, type: s.type, alive: s.alive } : null;
  });

  ipcMain.on('session:write', (e, { id, data }) => {
    sessions.write(id, data);
  });

  ipcMain.on('session:resize', (e, { id, cols, rows }) => {
    sessions.resize(id, cols, rows);
  });

  ipcMain.on('session:kill', (e, id) => {
    sessions.kill(id);
    removeSavedSession(id);
  });

  // ---- saved sessions / reconnect ---------------------------------------
  ipcMain.handle('session:saved', () => loadSavedSessions());

  ipcMain.handle('session:restore', (e, saved) => {
    try {
      if (saved.type === 'ssh') {
        const s = sessions.createSSH(saved);
        return { id: s.id, type: s.type };
      }
      const s = sessions.createLocal({ shell: saved.shell, cwd: saved.cwd });
      return { id: s.id, type: s.type, shell: s.shell, cwd: s.cwd };
    } catch (err) {
      return { error: err.message };
    }
  });

  // ---- command execution (capture layer) --------------------------------
  ipcMain.handle('bridge:run', async (e, { sessionId, command, lang } = {}) => {
    const session = sessions.get(sessionId);
    const cwd = session && session.cwd ? session.cwd : process.cwd();

    const rec = results.create({ sessionId, command, lang, status: 'running' });
    sendToRenderer('bridge:result-new', rec);

    const res = await executor.run({
      command,
      cwd,
      onData: (data) => sendToRenderer('bridge:data', { sessionId, data })
    });

    results.update(rec.commandId, {
      status: res.exitCode === 0 ? 'success' : 'failed',
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr
    });

    const updated = results.get(rec.commandId);
    sendToRenderer('bridge:result-done', updated);
    return updated;
  });

  ipcMain.handle('bridge:result', (e, id) => results.get(id));
  ipcMain.handle('bridge:results', (e, filter) => results.list(filter || {}));

  // ---- AI adapters -------------------------------------------------------
  ipcMain.handle('adapter:get', (e, site) => {
    const dir = path.join(__dirname, 'adapters');
    const read = (name) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8');
      } catch (_) {
        return '';
      }
    };
    const generic = read('generic.adapter.js');
    if (site === 'chatgpt' || site === 'gemini') {
      return read(site + '.adapter.js') + '\n;\n' + generic;
    }
    return generic;
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  wireSessionEvents();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  sessions.killAll();
  if (process.platform !== 'darwin') app.quit();
});
