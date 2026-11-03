/*
 * LLM2Shell content adapter (browser extension).
 * ----------------------------------------------
 * Injected into ChatGPT / Gemini pages. It:
 *   1. Detects shell code blocks and adds Run / Run All / Copy / Select Terminal.
 *   2. Renders a floating output panel with Send Output / Send Selected / Copy.
 *   3. Talks to the local Bridge through the extension service worker.
 *   4. Can place text back into the AI input box for the user to confirm.
 *
 * No Node access. All execution requests are sent to the Bridge, which only
 * runs after the user clicks a button.
 */
(function () {
  if (window.__awtInstalled) return;
  window.__awtInstalled = true;

  var SHELL_LANGS = [
    'bash', 'sh', 'shell', 'zsh', 'ksh', 'fish',
    'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'batch',
    'console', 'shell-session', 'shellsession', 'terminal',
    'commandline', 'command', 'shellscript'
  ];

  var SHELL_TOKENS = [
    'cd', 'ls', 'dir', 'echo', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir',
    'npm', 'pnpm', 'yarn', 'git', 'python', 'python3', 'pip', 'pip3', 'node',
    'pwsh', 'powershell', 'cmd', 'ssh', 'scp', 'sftp', 'rsync',
    'curl', 'wget', 'chmod', 'chown', 'sudo', 'su', 'apt', 'apt-get', 'yum',
    'brew', 'docker', 'podman', 'kubectl', 'export', 'set', 'unset',
    'copy', 'move', 'del', 'type', 'ren', 'taskkill', 'net',
    'find', 'grep', 'sed', 'awk', 'tar', 'zip', 'unzip', 'tree', 'touch',
    'kill', 'ps', 'ping', 'tracert', 'netstat', 'ipconfig', 'cls', 'clear',
    'start', 'code', 'dotnet', 'go', 'cargo', 'gcc', 'make', 'cmake'
  ];
  var TOKEN_RE = new RegExp('^\\s*(' + SHELL_TOKENS.join('|') + ')\\b', 'i');
  var CODE_START_RE = /^\s*(def\s|function\s|class\s|import\s|from\s|const\s|let\s|var\s|console\.|#include|#!\/|<\?php|select\s|package\s|public\s|private\s|protected\s|using\s|fn\s|func\s|print\(|System\.out|interface\s)/i;

  var state = {
    config: {},
    connected: false,
    sessionId: null,
    sessions: [],
    lastResult: null,
    outputText: '',
    panel: null
  };

  // ------------------------------------------------------------------ utils
  function normLang(raw) {
    return (raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function isShellLang(raw) {
    var l = normLang(raw);
    if (!l) return false;
    if (SHELL_LANGS.indexOf(l) !== -1) return true;
    return l === 'terminal' || l === 'commandline' || l === 'command';
  }

  function looksLikeShell(code) {
    var lines = (code || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!lines.length) return false;
    var hits = 0;
    for (var i = 0; i < lines.length; i++) {
      if (TOKEN_RE.test(lines[i])) hits++;
    }
    if (hits > 0) return true;
    if (lines.length <= 2) return !CODE_START_RE.test(lines[0]);
    return false;
  }

  function shouldRun(lang, code) {
    if (isShellLang(lang)) return true;
    var l = normLang(lang);
    if (!l || l === 'text' || l === 'plaintext' || l === 'none' || l === 'txt') {
      return looksLikeShell(code);
    }
    return false;
  }

  function detectLang(pre, code) {
    var attrs = [
      code.className,
      pre.className,
      code.getAttribute('data-language'),
      pre.getAttribute('data-language'),
      code.getAttribute('lang')
    ];
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      if (!a) continue;
      var m = String(a).match(/language-([a-z0-9+#-]+)/i) || String(a).match(/lang-([a-z0-9+#-]+)/i);
      if (m) return m[1];
      if (/^[a-z0-9+#-]+$/i.test(String(a).trim())) return String(a).trim();
    }
    return '';
  }

  function redact(text) {
    var t = String(text || '');
    t = t.replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)([^\s"']+)/gi, '$1***');
    t = t.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
    t = t.replace(/AKIA[0-9A-Z]{16}/g, 'AKIA****************');
    return t;
  }

  function truncate(text, max) {
    max = max || 12000;
    if (text.length <= max) return { text: text, truncated: false };
    return { text: text.slice(0, max), truncated: true };
  }

  // ------------------------------------------------------------- input fill
  function findInput() {
    var selectors = state.config.inputSelectors || [
      'textarea',
      'div[contenteditable="true"]',
      'div[role="textbox"]',
      '[contenteditable="true"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var list = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (el.offsetParent !== null && (el.tagName === 'TEXTAREA' || el.isContentEditable || el.getAttribute('role') === 'textbox')) {
          return el;
        }
      }
    }
    var all = document.querySelectorAll('textarea, div[contenteditable="true"]');
    for (var k = all.length - 1; k >= 0; k--) {
      if (all[k].offsetParent !== null) return all[k];
    }
    return null;
  }

  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillInput(text) {
    var el = findInput();
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      setNativeValue(el, text);
      try { el.setSelectionRange(text.length, text.length); } catch (e) {}
    } else {
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
      } catch (e) {
        el.textContent = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }

  // ------------------------------------------------------------------ panel
  function buildPanel() {
    if (document.getElementById('awt-panel')) {
      state.panel = document.getElementById('awt-panel');
      return;
    }
    var panel = document.createElement('div');
    panel.id = 'awt-panel';
    panel.innerHTML =
      '<div class="awt-head">' +
        '<span class="awt-dot" title="Bridge status"></span>' +
        '<span class="awt-title">LLM2Shell</span>' +
        '<select class="awt-session" title="Session"><option>default</option></select>' +
        '<span class="awt-spacer"></span>' +
        '<button class="awt-btn" data-awt="ssh" title="Connect a remote host">+ SSH</button>' +
        '<button class="awt-btn" data-awt="send" title="Put the last output into the AI input">Send Output</button>' +
        '<button class="awt-btn" data-awt="sendsel" title="Send the selected text">Send Selected</button>' +
        '<button class="awt-btn" data-awt="copy" title="Copy the output">Copy</button>' +
        '<button class="awt-btn" data-awt="clear" title="Clear the panel">Clear</button>' +
        '<button class="awt-btn awt-icon" data-awt="collapse" title="Collapse / expand">–</button>' +
      '</div>' +
      '<div class="awt-sshform" style="display:none">' +
        '<input class="awt-ssh-host" placeholder="host" spellcheck="false" />' +
        '<input class="awt-ssh-port" value="22" title="port" />' +
        '<input class="awt-ssh-user" placeholder="user" spellcheck="false" />' +
        '<input class="awt-ssh-pass" type="password" placeholder="password" />' +
        '<button class="awt-btn" data-awt="ssh-connect">Connect</button>' +
        '<button class="awt-btn" data-awt="ssh-cancel">Cancel</button>' +
      '</div>' +
      '<pre class="awt-out"></pre>' +
      '<div class="awt-inputrow">' +
        '<span class="awt-prompt">$</span>' +
        '<input class="awt-cmd" type="text" placeholder="Type a command and press Enter" spellcheck="false" />' +
      '</div>';

    (document.body || document.documentElement).appendChild(panel);
    state.panel = panel;

    panel.querySelector('.awt-session').addEventListener('change', function (e) {
      state.sessionId = e.target.value;
    });

    var cmdInput = panel.querySelector('.awt-cmd');
    if (cmdInput) {
      cmdInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && cmdInput.value.trim()) {
          var cmd = cmdInput.value;
          cmdInput.value = '';
          runCommand(cmd, 'shell');
        }
      });
    }
    panel.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-awt]') : null;
      if (!btn) return;
      var action = btn.getAttribute('data-awt');
      if (action === 'send') sendToAI('output');
      else if (action === 'sendsel') sendToAI('selected');
      else if (action === 'copy') copyOutput();
      else if (action === 'clear') clearPanel();
      else if (action === 'collapse') panel.classList.toggle('awt-collapsed');
      else if (action === 'ssh') {
        var form = panel.querySelector('.awt-sshform');
        form.style.display = form.style.display === 'none' ? 'flex' : 'none';
      } else if (action === 'ssh-cancel') {
        panel.querySelector('.awt-sshform').style.display = 'none';
      } else if (action === 'ssh-connect') {
        connectSSH();
      }
    });
  }

  function setConnected(connected) {
    state.connected = !!connected;
    if (!state.panel) return;
    var dot = state.panel.querySelector('.awt-dot');
    dot.classList.toggle('awt-on', state.connected);
    dot.title = state.connected ? 'Bridge connected' : 'Bridge not connected';
  }

  function expandPanel() {
    if (state.panel) state.panel.classList.remove('awt-collapsed');
  }

  function setSessions(sessions) {
    state.sessions = sessions || [];
    if (!state.panel) return;
    var sel = state.panel.querySelector('.awt-session');
    if (!sel) return;
    var current = state.sessionId;
    sel.innerHTML = '';
    if (!state.sessions.length) {
      var opt = document.createElement('option');
      opt.textContent = 'no sessions';
      opt.value = '';
      sel.appendChild(opt);
      return;
    }
    state.sessions.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name || s.id;
      sel.appendChild(o);
    });
    if (current && state.sessions.some(function (s) { return s.id === current; })) {
      sel.value = current;
    } else {
      state.sessionId = state.sessions[0].id;
      sel.value = state.sessionId;
    }
  }

  function appendOut(text, stream) {
    if (!state.panel) return;
    var out = state.panel.querySelector('.awt-out');
    if (stream === 'stderr') {
      var span = document.createElement('span');
      span.className = 'awt-stderr';
      span.textContent = text;
      out.appendChild(span);
    } else {
      out.appendChild(document.createTextNode(text));
    }
    out.scrollTop = out.scrollHeight;
    state.outputText += text;
  }

  function clearPanel() {
    state.outputText = '';
    if (state.panel) state.panel.querySelector('.awt-out').textContent = '';
  }

  function copyOutput() {
    try { navigator.clipboard.writeText(state.outputText); } catch (e) {}
  }

  function buildPayload(mode) {
    var rec = state.lastResult;
    if (!rec) {
      if (!state.outputText.trim()) return null;
      var only = truncate(redact(state.outputText));
      return only.text + (only.truncated ? '\n…[truncated]' : '');
    }

    var body = rec.stdout || '';
    if (rec.stderr) body += (body ? '\n' : '') + '[stderr]\n' + rec.stderr;

    if (mode === 'selected') {
      var sel = window.getSelection ? window.getSelection().toString() : '';
      if (sel && sel.trim()) body = sel;
    }

    var t = truncate(redact(body));
    var header = '[LLM2Shell] session=' + rec.sessionId + ' exit=' + rec.exitCode + ' status=' + rec.status;
    var text = mode === 'cmdout'
      ? header + '\n$ ' + rec.command + '\n\n' + t.text
      : header + '\n\n' + t.text;
    if (t.truncated) text += '\n\n…[output truncated by LLM2Shell]';
    return text;
  }

  function sendToAI(mode) {
    var text = buildPayload(mode);
    if (text === null) {
      appendOut('\n[LLM2Shell] Nothing to send yet — run a command first.\n', 'stderr');
      return;
    }
    if (fillInput(text)) {
      appendOut('\n[LLM2Shell] Placed the result in the AI input box. Review and send.\n', 'stderr');
    } else {
      appendOut('\n[LLM2Shell] Could not find the AI input box.\n', 'stderr');
    }
  }

  // ---------------------------------------------------------------- SSH form
  function connectSSH() {
    if (!state.panel) return;
    var host = state.panel.querySelector('.awt-ssh-host').value.trim();
    var port = parseInt(state.panel.querySelector('.awt-ssh-port').value, 10) || 22;
    var username = state.panel.querySelector('.awt-ssh-user').value.trim();
    var password = state.panel.querySelector('.awt-ssh-pass').value;

    if (!host || !username) {
      appendOut('\n[LLM2Shell] SSH host and username are required.\n', 'stderr');
      return;
    }

    expandPanel();
    appendOut('\n[LLM2Shell] Connecting to ' + username + '@' + host + ':' + port + '…\n', 'stdout');
    state.panel.querySelector('.awt-ssh-pass').value = '';
    state.panel.querySelector('.awt-sshform').style.display = 'none';

    try {
      chrome.runtime.sendMessage(
        {
          type: 'awt:createSession',
          session: {
            sessionType: 'ssh',
            name: username + '@' + host,
            host: host,
            port: port,
            username: username,
            password: password
          }
        },
        function (resp) {
          if (resp && !resp.ok) appendOut('[LLM2Shell] Bridge unavailable.\n', 'stderr');
        }
      );
    } catch (e) {
      appendOut('[LLM2Shell] ' + e.message + '\n', 'stderr');
    }
  }

  // -------------------------------------------------------------- detection
  function makeButton(label, title, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'awt-run-btn';
    b.textContent = label;
    b.title = title || label;
    b.setAttribute('data-awt-btn', '1');
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      fn();
    });
    return b;
  }

  function buildToolbar(text, lang) {
    var bar = document.createElement('div');
    bar.className = 'awt-toolbar';
    bar.setAttribute('data-awt-toolbar', '1');
    var tag = document.createElement('span');
    tag.className = 'awt-tag';
    tag.textContent = 'LLM2Shell';
    bar.appendChild(tag);

    bar.appendChild(makeButton('Run', 'Run in the selected terminal', function () {
      runCommand(text, lang);
    }));
    bar.appendChild(makeButton('Run All', 'Run this block', function () {
      runCommand(text, lang);
    }));
    bar.appendChild(makeButton('Copy', 'Copy to clipboard', function () {
      try { navigator.clipboard.writeText(text); } catch (e) {}
    }));
    bar.appendChild(makeButton('Select Terminal', 'Choose which session runs this', function () {
      if (state.panel) {
        expandPanel();
        var sel = state.panel.querySelector('.awt-session');
        if (sel) sel.focus();
      }
    }));
    return bar;
  }

  function runCommand(command, lang) {
    if (!command || !String(command).trim()) return;
    expandPanel();
    clearPanel();
    appendOut('$ ' + command + '\n', 'stdout');
    state.lastResult = null;
    if (!state.connected) {
      appendOut('[LLM2Shell] Bridge not connected. Start it with `npm start` and set the token in the extension options.\n', 'stderr');
    }
    try {
      chrome.runtime.sendMessage(
        { type: 'awt:run', command: command, lang: lang, sessionId: state.sessionId },
        function (resp) {
          if (chrome.runtime.lastError) {
            appendOut('[LLM2Shell] Extension error: ' + chrome.runtime.lastError.message + '\n', 'stderr');
            return;
          }
          if (resp && !resp.ok && !resp.queued) {
            appendOut('[LLM2Shell] Bridge unavailable.\n', 'stderr');
          }
        }
      );
    } catch (e) {
      appendOut('[LLM2Shell] ' + e.message + '\n', 'stderr');
    }
  }

  function processPre(pre) {
    if (!pre || pre.getAttribute('data-awt') === '1') return;
    var code = pre.querySelector('code') || pre;
    var text = code.innerText || code.textContent || '';
    if (!text.trim()) return;
    var lang = detectLang(pre, code);
    if (!shouldRun(lang, text)) return;
    pre.setAttribute('data-awt', '1');
    var bar = buildToolbar(text.replace(/\n+$/, ''), lang);
    if (pre.parentNode) pre.parentNode.insertBefore(bar, pre);
  }

  function scan(root) {
    var scope = root || document;
    // A newly added node may itself be a <pre>; process it before descendants.
    if (scope.nodeType === 1 && scope.tagName === 'PRE') processPre(scope);
    var pres = scope.querySelectorAll ? scope.querySelectorAll('pre') : [];
    for (var i = 0; i < pres.length; i++) processPre(pres[i]);
  }

  // -------------------------------------------------------------- messaging
  function onMessage(message) {
    if (!message || !message.type) return;
    var p = message.payload || {};
    switch (message.type) {
      case 'awt:run.started':
        expandPanel();
        break;
      case 'awt:output':
        appendOut(p.data || '', p.stream);
        break;
      case 'awt:result':
        state.lastResult = p;
        appendOut('\n[exit ' + p.exitCode + ' · ' + p.status + ']\n', p.exitCode === 0 ? 'stdout' : 'stderr');
        break;
      case 'awt:error':
        appendOut('\n[error] ' + (p.message || 'unknown') + '\n', 'stderr');
        break;
      case 'awt:sessions':
        setSessions(p.sessions);
        break;
      case 'awt:session.created':
        if (p.session) {
          state.sessionId = p.session.id;
          appendOut(
            '\n[LLM2Shell] Session "' + (p.session.name || p.session.id) + '" ready (' + p.session.type + ').\n',
            'stdout'
          );
        }
        chrome.runtime.sendMessage({ type: 'awt:sessions' });
        break;
      case 'awt:status':
        setConnected(p.connected);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ install
  function install(config) {
    state.config = config || {};
    if (!document.body) {
      setTimeout(function () { install(config); }, 300);
      return;
    }
    buildPanel();

    try {
      chrome.runtime.onMessage.addListener(onMessage);
      chrome.runtime.sendMessage({ type: 'awt:status' }, function (r) {
        if (r) setConnected(r.connected);
      });
      chrome.runtime.sendMessage({ type: 'awt:sessions' });
    } catch (e) {
      // Not running as an extension (e.g. manual injection): stay usable but
      // without a Bridge connection.
      setConnected(false);
    }

    var observer = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) scan(added[j]);
        }
      }
    });
    try { observer.observe(document.body, { childList: true, subtree: true }); } catch (e) {}

    scan(document);
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      scan(document);
      if (tries >= 10) clearInterval(timer);
    }, 1000);
  }

  window.LLM2Shell = { install: install };
})();
