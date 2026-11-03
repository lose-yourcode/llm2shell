'use strict';

/* global window, document, MutationObserver */

const api = window.electronAPI;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const AI_PRESETS = {
  chatgpt: { title: 'ChatGPT', url: 'https://chatgpt.com/' },
  gemini: { title: 'Gemini', url: 'https://gemini.google.com/app' }
};

const state = {
  aiTabs: [],          // { id, site, title, url, webview, pollTimer, draining }
  activeAiId: null,
  sessions: [],        // { id, title, type, term, fit, el }
  activeSessionId: null,
  lastResult: {},      // sessionId -> result record
  pollInterval: 450
};

let aiCounter = 0;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function $(sel) { return document.querySelector(sel); }

function setStatus(msg, kind) {
  const el = $('#statusText');
  el.textContent = msg;
  el.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '';
}

function nowTitle(type) {
  return type === 'ssh' ? 'SSH' : 'Local';
}

// Mask obvious secrets before sending output back to a third-party AI site.
function redact(text) {
  let t = String(text || '');
  t = t.replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)([^\s"']+)/gi, '$1***');
  t = t.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
  t = t.replace(/AKIA[0-9A-Z]{16}/g, 'AKIA****************');
  t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY----- *** -----END PRIVATE KEY-----');
  return t;
}

const MAX_OUTPUT = 12000;
function truncate(text) {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  return { text: text.slice(0, MAX_OUTPUT), truncated: true };
}

// ---------------------------------------------------------------------------
// AI tabs
// ---------------------------------------------------------------------------
function getActiveAiTab() {
  return state.aiTabs.find((t) => t.id === state.activeAiId) || null;
}

function addAiTab(site, title, url) {
  const id = 'ai-' + (++aiCounter);
  const tab = { id, site, title, url, webview: null, pollTimer: null, draining: false };
  state.aiTabs.push(tab);

  // tab button
  const btn = document.createElement('button');
  btn.className = 'tab';
  btn.dataset.aiId = id;
  btn.innerHTML = '<span class="label"></span><span class="x" title="Close">✕</span>';
  btn.querySelector('.label').textContent = title;
  btn.addEventListener('click', (e) => {
    if (e.target.classList.contains('x')) {
      closeAiTab(id);
    } else {
      activateAiTab(id);
    }
  });
  $('#aiTabs').appendChild(btn);

  activateAiTab(id);
  return tab;
}

function closeAiTab(id) {
  const idx = state.aiTabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = state.aiTabs[idx];
  if (tab.pollTimer) clearInterval(tab.pollTimer);
  if (tab.webview && tab.webview.parentNode) tab.webview.parentNode.removeChild(tab.webview);
  state.aiTabs.splice(idx, 1);
  const btn = document.querySelector(`.tab[data-ai-id="${id}"]`);
  if (btn) btn.remove();
  if (state.activeAiId === id) {
    const next = state.aiTabs[state.aiTabs.length - 1];
    if (next) activateAiTab(next.id);
    else state.activeAiId = null;
  }
}

function ensureWebview(tab) {
  if (tab.webview) return tab.webview;

  const wv = document.createElement('webview');
  wv.setAttribute('src', tab.url);
  wv.setAttribute('partition', 'persist:llm2shell-ai');
  wv.setAttribute('allowpopups', 'true');
  wv.setAttribute(
    'useragent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  wv.dataset.aiId = tab.id;

  wv.addEventListener('dom-ready', () => {
    injectAdapter(tab);
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode !== -3) setStatus(`Failed to load ${tab.title}: ${e.errorDescription}`, 'err');
  });

  $('#webviewHost').appendChild(wv);
  tab.webview = wv;
  startPolling(tab);
  return wv;
}

async function injectAdapter(tab) {
  if (!tab.webview) return;
  try {
    const script = await api.invoke('adapter:get', tab.site);
    if (!script) return;
    const wrapped = 'window.__awtSiteId=' + JSON.stringify(tab.id) + ';\n' + script;
    await tab.webview.executeJavaScript(wrapped, true);
    setStatus(`${tab.title} adapter ready.`, 'ok');
  } catch (e) {
    setStatus(`Adapter injection failed on ${tab.title}: ${e.message}`, 'err');
  }
}

function startPolling(tab) {
  if (tab.pollTimer) return;
  tab.pollTimer = setInterval(async () => {
    if (!tab.webview || tab.draining) return;
    tab.draining = true;
    try {
      const msgs = await tab.webview.executeJavaScript(
        '(window.__awt && window.__awt.queue) ? window.__awt.queue.splice(0, window.__awt.queue.length) : []',
        true
      );
      if (Array.isArray(msgs)) {
        for (const m of msgs) handleAdapterMessage(tab, m);
      }
    } catch (_) {
      // page navigating / not ready — ignore
    } finally {
      tab.draining = false;
    }
  }, state.pollInterval);
}

function activateAiTab(id) {
  const tab = state.aiTabs.find((t) => t.id === id);
  if (!tab) return;
  state.activeAiId = id;
  document.querySelectorAll('#aiTabs .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.aiId === id);
  });
  document.querySelectorAll('#webviewHost webview').forEach((w) => {
    w.classList.toggle('active', w.dataset.aiId === id);
  });
  ensureWebview(tab);
  $('#emptyHint').style.display = 'none';
  setStatus(`${tab.title} active.`);
}

function handleAdapterMessage(tab, msg) {
  if (!msg || !msg.action) return;
  if (msg.action === 'run') {
    runCommand(msg.command, msg.lang);
  } else if (msg.action === 'select') {
    setStatus('Pick a session in "Run in", then click Run.');
    $('#sessionSelect').focus();
  }
}

// ---------------------------------------------------------------------------
// Terminal sessions
// ---------------------------------------------------------------------------
function findSession(id) {
  return state.sessions.find((s) => s.id === id) || null;
}

function getActiveSession() {
  return findSession(state.activeSessionId);
}

function syncSessionSelect() {
  const sel = $('#sessionSelect');
  const prev = state.activeSessionId;
  sel.innerHTML = '';
  state.sessions.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

async function ensureSession() {
  if (getActiveSession()) return getActiveSession();
  return await createLocalSession();
}

async function createLocalSession() {
  const res = await api.invoke('session:create', { type: 'local' });
  if (!res || res.error) {
    setStatus('Could not create local session: ' + (res && res.error), 'err');
    return null;
  }
  return addSessionUI(res.id, `${nowTitle('local')} ${state.sessions.length + 1}`, 'local');
}

async function createSshSession(opts) {
  const res = await api.invoke('session:create', Object.assign({ type: 'ssh' }, opts));
  if (!res || res.error) {
    setStatus('SSH failed: ' + (res && res.error), 'err');
    return null;
  }
  return addSessionUI(res.id, `SSH ${opts.username || ''}@${opts.host}`, 'ssh');
}

function addSessionUI(id, title, type) {
  const host = $('#termHost');
  const el = document.createElement('div');
  el.className = 'term-instance';
  el.dataset.sessionId = id;
  host.appendChild(el);

  const session = { id, title, type, el, term: null, fit: null };

  if (window.xterm && window.xterm.Terminal) {
    const term = new window.xterm.Terminal({
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#101216',
        foreground: '#e6e9ef',
        cursor: '#4f8cff',
        selectionBackground: '#2f6fe0'
      }
    });
    const fit = new window.xterm.FitAddon ? new window.xterm.FitAddon() : null;
    term.open(el);
    if (fit) {
      term.loadAddon(fit);
      try { fit.fit(); } catch (_) {}
    }
    term.onData((data) => api.send('session:write', { id, data }));
    term.onResize(({ cols, rows }) => api.send('session:resize', { id, cols, rows }));
    session.term = term;
    session.fit = fit;
  } else {
    el.innerHTML = '<div style="color:#e05555;padding:12px">xterm.js failed to load. Check `npm install`.</div>';
  }

  // session tab button
  const btn = document.createElement('button');
  btn.className = 'tab';
  btn.dataset.sessionId = id;
  btn.textContent = title;
  btn.addEventListener('click', () => activateSession(id));
  $('#sessionTabs').appendChild(btn);

  state.sessions.push(session);
  syncSessionSelect();
  activateSession(id);
  return session;
}

function activateSession(id) {
  const s = findSession(id);
  if (!s) return;
  state.activeSessionId = id;
  document.querySelectorAll('#sessionTabs .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.sessionId === id);
  });
  document.querySelectorAll('.term-instance').forEach((e) => {
    e.classList.toggle('active', e.dataset.sessionId === id);
  });
  $('#sessionSelect').value = id;
  requestAnimationFrame(() => {
    if (s.fit) { try { s.fit.fit(); } catch (_) {} }
    if (s.term) s.term.focus();
  });
  setStatus(`Session ${s.title} active.`);
}

function removeSession(id) {
  const idx = state.sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const s = state.sessions[idx];
  if (s.term) { try { s.term.dispose(); } catch (_) {} }
  if (s.el && s.el.parentNode) s.el.parentNode.removeChild(s.el);
  const btn = document.querySelector(`#sessionTabs .tab[data-session-id="${id}"]`);
  if (btn) btn.remove();
  state.sessions.splice(idx, 1);
  if (state.activeSessionId === id) {
    const next = state.sessions[state.sessions.length - 1];
    if (next) activateSession(next.id);
    else state.activeSessionId = null;
  }
  syncSessionSelect();
}

function fitActive() {
  const s = getActiveSession();
  if (s && s.fit) { try { s.fit.fit(); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Run a command from the AI page
// ---------------------------------------------------------------------------
async function runCommand(command, lang) {
  if (!command || !command.trim()) return;
  const session = await ensureSession();
  if (!session) return;
  setStatus(`Running in ${session.title}…`);
  api.invoke('bridge:run', { sessionId: session.id, command, lang });
}

// ---------------------------------------------------------------------------
// Send results back to the AI input box
// ---------------------------------------------------------------------------
function buildPayload(mode) {
  const rec = state.lastResult[state.activeSessionId];
  if (!rec) {
    setStatus('No command result yet for this session. Run a command first.', 'err');
    return null;
  }

  let body = rec.stdout || '';
  if (rec.stderr) body += (body ? '\n' : '') + '[stderr]\n' + rec.stderr;

  if (mode === 'selected') {
    const s = getActiveSession();
    const sel = s && s.term ? s.term.getSelection() : '';
    body = sel && sel.trim() ? sel : body;
  }

  const tr = truncate(redact(body));
  const header = `[LLM2Shell] session=${rec.sessionId} exit=${rec.exitCode} status=${rec.status}`;
  let text;
  if (mode === 'cmdout') {
    text = `${header}\n$ ${rec.command}\n\n${tr.text}`;
  } else {
    text = `${header}\n\n${tr.text}`;
  }
  if (tr.truncated) text += '\n\n…[output truncated by LLM2Shell]';
  return text;
}

async function sendToAI(mode) {
  const tab = getActiveAiTab();
  if (!tab || !tab.webview) {
    setStatus('Open an AI tab first.', 'err');
    return;
  }
  const text = buildPayload(mode);
  if (text === null) return;
  try {
    const ok = await tab.webview.executeJavaScript(
      'window.__awt ? window.__awt.fillInput(' + JSON.stringify(text) + ') : false',
      true
    );
    if (ok) setStatus('Result placed in the AI input box — review and press send.', 'ok');
    else setStatus('Could not locate the AI input box on this page.', 'err');
  } catch (e) {
    setStatus('Failed to fill AI input: ' + e.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// IPC events from main
// ---------------------------------------------------------------------------
function wireMainEvents() {
  api.on('bridge:data', ({ sessionId, data }) => {
    const s = findSession(sessionId);
    if (s && s.term) s.term.write(data);
  });

  api.on('bridge:result-new', (rec) => {
    setStatus(`Running command ${rec.commandId}…`);
  });

  api.on('bridge:result-done', (rec) => {
    state.lastResult[rec.sessionId] = rec;
    const kind = rec.status === 'success' ? 'ok' : 'err';
    setStatus(`Done (exit ${rec.exitCode}, ${rec.status}). Use Send Output to return it to the AI.`, kind);
  });

  api.on('bridge:exit', ({ sessionId, exitCode }) => {
    setStatus(`Session ${sessionId} exited (code ${exitCode}).`, 'err');
    const s = findSession(sessionId);
    if (s && s.term) s.term.write(`\r\n\x1b[33m[session exited: ${exitCode}]\x1b[0m\r\n`);
  });

  api.on('bridge:error', ({ sessionId, error }) => {
    setStatus(`Session error (${sessionId}): ${error}`, 'err');
  });

  api.on('bridge:ready', ({ id }) => {
    setStatus(`SSH session ${id} connected.`, 'ok');
  });
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function wireUi() {
  $('#btnAddSite').addEventListener('click', () => showModal('#siteModal'));

  $('#btnNewLocal').addEventListener('click', () => createLocalSession());
  $('#btnNewSSH').addEventListener('click', () => showModal('#sshModal'));
  $('#btnKill').addEventListener('click', () => {
    const s = getActiveSession();
    if (!s) return;
    api.send('session:kill', s.id);
    removeSession(s.id);
    setStatus('Session killed.');
  });

  $('#sessionSelect').addEventListener('change', (e) => activateSession(e.target.value));

  $('#btnSendOutput').addEventListener('click', () => sendToAI('output'));
  $('#btnSendSelected').addEventListener('click', () => sendToAI('selected'));
  $('#btnSendCmdOut').addEventListener('click', () => sendToAI('cmdout'));

  // SSH modal
  $('#sshCancel').addEventListener('click', () => hideModal('#sshModal'));
  $('#sshConnect').addEventListener('click', async () => {
    const opts = {
      host: $('#sshHost').value.trim(),
      port: parseInt($('#sshPort').value, 10) || 22,
      username: $('#sshUser').value.trim(),
      password: $('#sshPass').value
    };
    if (!opts.host || !opts.username) {
      setStatus('Host and username are required.', 'err');
      return;
    }
    hideModal('#sshModal');
    setStatus(`Connecting to ${opts.host}…`);
    await createSshSession(opts);
    $('#sshPass').value = '';
  });

  // Site modal
  $('#siteCancel').addEventListener('click', () => hideModal('#siteModal'));
  $('#siteAdd').addEventListener('click', () => {
    const name = $('#siteName').value.trim() || 'Custom AI';
    const url = $('#siteUrl').value.trim();
    if (!/^https?:\/\//i.test(url)) {
      setStatus('Enter a valid http(s) URL.', 'err');
      return;
    }
    hideModal('#siteModal');
    addAiTab('generic', name, url);
  });

  // Splitter drag
  const splitter = $('#splitter');
  let dragging = false;
  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const panel = $('#terminalPanel');
    const newHeight = Math.max(140, window.innerHeight - e.clientY);
    panel.style.flexBasis = newHeight + 'px';
    fitActive();
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('resize', fitActive);
}

function showModal(sel) { $(sel).classList.remove('hidden'); }
function hideModal(sel) { $(sel).classList.add('hidden'); }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function restoreSessions() {
  try {
    const saved = await api.invoke('session:saved');
    if (!Array.isArray(saved)) return;
    for (const s of saved) {
      if (s.type === 'local') {
        const res = await api.invoke('session:restore', s);
        if (res && !res.error) addSessionUI(res.id, `${nowTitle('local')} ${state.sessions.length + 1}`, 'local');
      }
    }
  } catch (_) {}
}

async function boot() {
  wireUi();
  wireMainEvents();

  // Default AI tabs (created lazily; webviews load on activation).
  addAiTab('chatgpt', 'ChatGPT', AI_PRESETS.chatgpt.url);
  addAiTab('gemini', 'Gemini', AI_PRESETS.gemini.url);
  // Start on ChatGPT.
  activateAiTab(state.aiTabs[0].id);

  await restoreSessions();
  // Always give the user at least one usable terminal.
  if (state.sessions.length === 0) await createLocalSession();

  setStatus('Ready. Ask an AI for a command, then click Run.');
}

window.addEventListener('DOMContentLoaded', boot);
