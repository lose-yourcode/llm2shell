'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit IPC surface for the app window. The window only ever
// loads local, trusted UI; remote AI pages live inside isolated <webview>s.
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});

// Expose xterm.js (pure browser library) so the renderer can build terminals
// without a bundler.
try {
  const { Terminal } = require('@xterm/xterm');
  const { FitAddon } = require('@xterm/addon-fit');
  contextBridge.exposeInMainWorld('xterm', { Terminal, FitAddon });
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn('[preload] xterm unavailable:', e.message);
  contextBridge.exposeInMainWorld('xterm', null);
}
