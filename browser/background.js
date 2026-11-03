'use strict';

/**
 * MV3 service worker.
 * Owns the WebSocket to the local Bridge and relays messages between the
 * Bridge and the content script in the active AI tab.
 */

const DEFAULT_URL = 'ws://127.0.0.1:8765';

let ws = null;
let connected = false;
let reconnectTimer = null;
let outbox = [];
const pendingTabs = new Map(); // reqId -> tabId

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['bridgeUrl', 'bridgeToken'], (r) => {
      resolve({ url: r.bridgeUrl || DEFAULT_URL, token: r.bridgeToken || '' });
    });
  });
}

async function ensureConnection() {
  const cfg = await getConfig();
  if (!cfg.token) {
    broadcastStatus('no-token');
    return false;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return true;
  }
  connect(cfg);
  return true;
}

function connect(cfg) {
  try {
    ws = new WebSocket(cfg.url);
  } catch (_) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ type: 'hello', token: cfg.token }));
    } catch (_) {}
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    handleBridgeMessage(msg);
  };

  ws.onclose = () => {
    connected = false;
    broadcastStatus('closed');
    scheduleReconnect();
  };

  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureConnection();
  }, 3000);
}

function flushOutbox() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const items = outbox;
  outbox = [];
  for (const item of items) {
    try { ws.send(JSON.stringify(item)); } catch (_) {}
  }
}

function handleBridgeMessage(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'hello.ok') {
    connected = true;
    flushOutbox();
    broadcastStatus('connected');
    return;
  }
  if (msg.type === 'auth.error') {
    connected = false;
    broadcastStatus('auth');
    return;
  }

  const tabId = msg.reqId != null ? pendingTabs.get(msg.reqId) : undefined;
  if (msg.reqId != null && (msg.type === 'result' || msg.type === 'error')) {
    pendingTabs.delete(msg.reqId);
  }

  const payload = { type: 'awt:' + msg.type, payload: msg };
  if (tabId != null) {
    try { chrome.tabs.sendMessage(tabId, payload).catch(() => {}); } catch (_) {}
  } else {
    broadcastToTabs(payload);
  }
}

function broadcastToTabs(payload) {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.id == null) continue;
      try { chrome.tabs.sendMessage(t.id, payload).catch(() => {}); } catch (_) {}
    }
  });
}

function broadcastStatus(reason) {
  broadcastToTabs({ type: 'awt:status', payload: { connected, reason } });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (_) {}
  }
  outbox.push(msg);
  ensureConnection();
  return false;
}

chrome.runtime.onInstalled.addListener(() => { ensureConnection(); });
chrome.runtime.onStartup.addListener(() => { ensureConnection(); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'awt:run') {
    const reqId = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    if (sender.tab && sender.tab.id != null) pendingTabs.set(reqId, sender.tab.id);
    const ok = send({
      type: 'run',
      reqId,
      command: message.command,
      lang: message.lang,
      sessionId: message.sessionId
    });
    sendResponse({ ok, queued: !ok, reqId });
    return true;
  }

  if (message.type === 'awt:sessions') {
    send({ type: 'session.list', reqId: 'q_' + Date.now() });
    sendResponse({ ok: connected });
    return true;
  }

  if (message.type === 'awt:createSession') {
    send({ type: 'session.create', reqId: 'c_' + Date.now(), name: message.name });
    sendResponse({ ok: connected });
    return true;
  }

  if (message.type === 'awt:status') {
    ensureConnection();
    sendResponse({ connected });
    return true;
  }

  if (message.type === 'awt:setConfig') {
    chrome.storage.local.set({ bridgeUrl: message.url, bridgeToken: message.token }, () => {
      if (ws) { try { ws.close(); } catch (_) {} ws = null; }
      connected = false;
      ensureConnection();
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});
