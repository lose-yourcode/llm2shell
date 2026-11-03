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
    history: [],
    outputText: '',
    pinned: true,
    // 'append' keeps whatever is already in the AI box and adds the new text
    // below it; 'replace' overwrites the box. Append is the default because a
    // multi-step conversation produces several results that the model needs
    // to see together.
    insertMode: 'append',
    prompt: '',
    panel: null
  };

  var APPEND_SEPARATOR = '\n\n';

  // Safety cap on the in-memory transcript copy (the visible panel keeps the
  // full text). Large enough for any realistic session; bounds memory if a
  // command dumps an enormous amount of output.
  var MAX_OUTPUT_CHARS = 2 * 1000 * 1000;

  // Reliable wrapper around chrome.runtime.sendMessage.
  // MV3 extensions restart their service worker on reload/update. A tab left
  // open across that reload keeps the OLD injected content script, whose
  // chrome.runtime now throws "Extension context invalidated". Detect that up
  // front and tell the user to refresh the tab, instead of swallowing a raw
  // Chrome error or silently dropping the message.
  function sendRuntime(message, cb) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      appendOut(
        '[LLM2Shell] 插件上下文已失效 (Extension context invalidated)。\n' +
          '原因：重载过插件但本标签页未刷新。请按 F5 / Ctrl+R 刷新本页，再重试。\n',
        'stderr'
      );
      if (cb) cb({ ok: false, contextInvalidated: true });
      return false;
    }
    try {
      chrome.runtime.sendMessage(message, function (resp) {
        if (chrome.runtime.lastError) {
          var msg = chrome.runtime.lastError.message || '';
          if (/Extension context invalidated/i.test(msg)) {
            appendOut('[LLM2Shell] 插件上下文已失效，请刷新本标签页 (F5) 后重试。\n', 'stderr');
          } else {
            appendOut('[LLM2Shell] Extension error: ' + msg + '\n', 'stderr');
          }
          if (cb) cb({ ok: false, error: msg });
          return;
        }
        if (cb) cb(resp);
      });
    } catch (e) {
      var em = e && e.message ? e.message : String(e);
      if (/Extension context invalidated/i.test(em)) {
        appendOut('[LLM2Shell] 插件上下文已失效，请刷新本标签页 (F5) 后重试。\n', 'stderr');
      } else {
        appendOut('[LLM2Shell] ' + em + '\n', 'stderr');
      }
      if (cb) cb({ ok: false, error: em });
    }
    return true;
  }

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

  // Only these class tokens / header labels are treated as a language. Anything
  // else (e.g. Gemini's "code-block-internal") is layout, not a language tag.
  var LANG_WORDS = /^(bash|sh|shell|zsh|ksh|fish|powershell|pwsh|ps1|cmd|bat|batch|console|terminal|command|commandline|shell-session|shellsession|shellscript|python|py|javascript|js|jsx|typescript|ts|tsx|json|jsonc|yaml|yml|toml|ini|html|xml|svg|css|scss|less|sql|java|kotlin|swift|go|golang|rust|ruby|php|perl|lua|r|c|cpp|csharp|cs|dotnet|dockerfile|makefile|markdown|md|text|plaintext|txt|none)$/i;

  function classTokens(el) {
    if (!el || !el.className) return [];
    var raw = typeof el.className === 'string' ? el.className : String(el.className.baseVal || '');
    return raw.split(/\s+/).filter(Boolean);
  }

  // "language-powershell" / "lang-bash" / a bare known language token.
  function langFromClasses(el) {
    var toks = classTokens(el);
    for (var i = 0; i < toks.length; i++) {
      var m = toks[i].match(/^(?:language|lang)-(.+)$/i);
      if (m) return m[1].toLowerCase();
      if (LANG_WORDS.test(toks[i])) return toks[i].toLowerCase();
    }
    return '';
  }

  // Gemini prints the language in a header next to the block instead of on the
  // <pre>. Walk a couple of ancestors and look for a short label like "PowerShell".
  function langFromHeader(pre) {
    var node = pre.parentElement;
    for (var depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      var kids = node.querySelectorAll('span,div,header,h3,h4,button');
      for (var i = 0; i < kids.length && i < 40; i++) {
        var el = kids[i];
        if (el.contains(pre)) continue;
        var t = (el.textContent || '').trim();
        if (!t || t.length > 20 || t.indexOf('\n') >= 0) continue;
        if (LANG_WORDS.test(t)) return t.toLowerCase();
      }
    }
    return '';
  }

  function detectLang(pre, code) {
    var attr =
      (code && code.getAttribute('data-language')) ||
      (pre && pre.getAttribute('data-language')) ||
      (code && code.getAttribute('lang')) ||
      (pre && pre.getAttribute('lang'));
    if (attr && String(attr).trim()) return String(attr).trim().toLowerCase();

    var fromClass = langFromClasses(code) || langFromClasses(pre);
    if (fromClass) return fromClass;

    return langFromHeader(pre);
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

  // Read what the user already has in the AI box. ChatGPT/Gemini use a
  // contenteditable editor, where innerText preserves the paragraph breaks that
  // textContent drops.
  function readInput(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    var t = el.innerText;
    if (typeof t !== 'string') t = el.textContent || '';
    return t;
  }

  // Build the final string according to the insert mode. Appending never
  // destroys what is already typed; it only adds below it.
  function composeInsert(text, existing, mode) {
    var body = String(text == null ? '' : text);
    if (mode === 'replace') return body;
    var current = String(existing == null ? '' : existing);
    if (!current.trim()) return body;
    return current.replace(/\s+$/, '') + APPEND_SEPARATOR + body;
  }

  function applyInputValue(el, value) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      setNativeValue(el, value);
      try { el.setSelectionRange(value.length, value.length); } catch (e) {}
      return true;
    }
    // contenteditable (ProseMirror / rich-textarea): replace the whole content
    // so the caret ends up at the bottom of the appended text.
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, value);
    } catch (e) {
      el.textContent = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function fillInput(text, mode) {
    var el = findInput();
    if (!el) return { ok: false, reason: 'no-input', mode: mode || state.insertMode };
    var useMode = mode || state.insertMode;
    el.focus();
    var finalText = composeInsert(text, readInput(el), useMode);
    applyInputValue(el, finalText);
    return { ok: true, mode: useMode, length: finalText.length };
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
      '<div class="awt-resize" title="Drag to resize"></div>' +
      '<div class="awt-head">' +
        '<span class="awt-dot" title="Bridge status"></span>' +
        '<span class="awt-title">LLM2Shell</span>' +
        '<select class="awt-session" title="Session"><option>default</option></select>' +
        '<select class="awt-mode" title="Append below what is already typed, or replace it">' +
          '<option value="append">Append</option>' +
          '<option value="replace">Replace</option>' +
        '</select>' +
        '<span class="awt-spacer"></span>' +
        '<button class="awt-btn awt-icon awt-collapse" data-awt="collapse" title="Collapse / expand">–</button>' +
      '</div>' +
      '<div class="awt-actions">' +
        '<button class="awt-btn awt-prompt-btn" data-awt="prompt" title="Put the formatting prompt into the AI input">Prompt</button>' +
        '<button class="awt-btn" data-awt="ssh" title="Connect a remote host">+ SSH</button>' +
        '<button class="awt-btn awt-disconnect" data-awt="disconnect" title="Disconnect the selected SSH session">Disconnect</button>' +
        '<button class="awt-btn" data-awt="send" title="Put the last result into the AI input">Send Output</button>' +
        '<button class="awt-btn" data-awt="sendall" title="Put every result in this panel into the AI input">Send All</button>' +
        '<button class="awt-btn" data-awt="sendsel" title="Send the selected text">Send Selected</button>' +
        '<button class="awt-btn" data-awt="copy" title="Copy the output">Copy</button>' +
        '<button class="awt-btn" data-awt="clear" title="Clear the panel">Clear</button>' +
        '<button class="awt-btn" data-awt="newchat" title="Open a fresh conversation with the AI">New Chat</button>' +
      '</div>' +
      '<button class="awt-jump" data-awt="jump" title="Jump to the latest output">↓ latest</button>' +
      '<div class="awt-sshform" style="display:none">' +
        '<input class="awt-ssh-host" placeholder="host or ssh alias" spellcheck="false" />' +
        '<input class="awt-ssh-port" value="22" title="port" />' +
        '<input class="awt-ssh-user" placeholder="user (alias fills this)" spellcheck="false" />' +
        '<input class="awt-ssh-pass" type="password" placeholder="password" />' +
        '<input class="awt-ssh-key" placeholder="key path, e.g. ~/.ssh/id_ed25519" spellcheck="false" />' +
        '<div class="awt-sshbtns">' +
          '<button class="awt-btn" data-awt="ssh-connect">Connect</button>' +
          '<button class="awt-btn" data-awt="ssh-cancel">Cancel</button>' +
        '</div>' +
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

    var modeSel = panel.querySelector('.awt-mode');
    if (modeSel) {
      modeSel.value = state.insertMode;
      modeSel.addEventListener('change', function (e) {
        setInsertMode(e.target.value);
      });
    }

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

    var outEl = panel.querySelector('.awt-out');
    if (outEl) {
      outEl.addEventListener('scroll', function () {
        state.pinned = atBottom(outEl);
        updateJump(outEl);
      });
    }
    var savedSize = null;
    function setCollapsed(collapsed) {
      if (collapsed) {
        savedSize = { width: panel.style.width, height: panel.style.height };
        panel.style.width = '';
        panel.style.height = '';
      } else if (savedSize) {
        panel.style.width = savedSize.width;
        panel.style.height = savedSize.height;
        savedSize = null;
      }
      panel.classList.toggle('awt-collapsed', collapsed);
      var cb = panel.querySelector('button[data-awt="collapse"]');
      if (cb) {
        cb.textContent = collapsed ? '+' : '–';
        cb.title = collapsed ? 'Expand' : 'Collapse';
      }
    }

    panel.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-awt]') : null;
      if (!btn) return;
      var action = btn.getAttribute('data-awt');
      if (action === 'send') sendToAI('output');
      else if (action === 'sendall') sendToAI('all');
      else if (action === 'sendsel') sendToAI('selected');
      else if (action === 'prompt') sendPrompt();
      else if (action === 'jump') jumpToLatest();
      else if (action === 'newchat') openNewChat();
      else if (action === 'copy') copyOutput();
      else if (action === 'clear') clearPanel();
      else if (action === 'collapse') setCollapsed(!panel.classList.contains('awt-collapsed'));
      else if (action === 'ssh') {
        var form = panel.querySelector('.awt-sshform');
        // 'grid', not 'flex': the form uses grid-template-areas.
        form.style.display = form.style.display === 'none' ? 'grid' : 'none';
      } else if (action === 'ssh-cancel') {
        panel.querySelector('.awt-sshform').style.display = 'none';
      } else if (action === 'ssh-connect') {
        connectSSH();
      } else if (action === 'disconnect') {
        disconnectSession();
      }
    });

    // Resize from the top-left grip (the panel is anchored bottom-right, so
    // dragging left/up grows it).
    var grip = panel.querySelector('.awt-resize');
    if (grip) {
      var startX = 0, startY = 0, startW = 0, startH = 0, resizing = false;
      var onMove = function (e) {
        if (!resizing) return;
        var w = Math.max(320, Math.min(window.innerWidth - 36, startW - (e.clientX - startX)));
        var h = Math.max(160, Math.min(window.innerHeight - 36, startH - (e.clientY - startY)));
        panel.style.width = w + 'px';
        panel.style.height = h + 'px';
      };
      var onUp = function () {
        resizing = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      grip.addEventListener('mousedown', function (e) {
        if (panel.classList.contains('awt-collapsed')) return;
        resizing = true;
        startX = e.clientX;
        startY = e.clientY;
        var rect = panel.getBoundingClientRect();
        startW = rect.width;
        startH = rect.height;
        e.preventDefault();
        e.stopPropagation();
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    // Double-click the title to collapse/expand as a second restore path.
    var titleEl = panel.querySelector('.awt-title');
    if (titleEl) {
      titleEl.addEventListener('dblclick', function () {
        setCollapsed(!panel.classList.contains('awt-collapsed'));
      });
    }
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

  // Coalesce autoscroll + "jump to latest" toggling into one layout pass per
  // frame instead of forcing a synchronous reflow on every streamed chunk.
  var followRAF = 0;
  function scheduleFollow(out) {
    if (!out) return;
    if (followRAF) return;
    var run = function () {
      followRAF = 0;
      if (state.pinned) out.scrollTop = out.scrollHeight;
      updateJump(out);
    };
    followRAF = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame(run)
      : setTimeout(run, 16);
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
    state.outputText += text;
    if (state.outputText.length > MAX_OUTPUT_CHARS) {
      state.outputText = state.outputText.slice(-MAX_OUTPUT_CHARS);
    }
    // Follow the stream only while the user is already at the bottom, so
    // scrolling up to read something is not yanked back on every chunk.
    scheduleFollow(out);
  }

  // Header line for each command, so a long transcript never loses track of
  // which command produced which output.
  function appendCommandHeader(command) {
    if (!state.panel) return;
    var out = state.panel.querySelector('.awt-out');
    var span = document.createElement('span');
    span.className = 'awt-cmdline';
    // display:block in CSS supplies the line break; adding '\n' here would
    // leave a blank line inside the <pre>.
    span.textContent = '$ ' + command;
    out.appendChild(span);
    state.outputText += (state.outputText ? '\n' : '') + '$ ' + command + '\n';
    if (state.outputText.length > MAX_OUTPUT_CHARS) {
      state.outputText = state.outputText.slice(-MAX_OUTPUT_CHARS);
    }
    scheduleFollow(out);
  }

  function atBottom(out) {
    if (!out) return true;
    return out.scrollTop + out.clientHeight >= out.scrollHeight - 24;
  }

  function updateJump(out) {
    if (!state.panel) return;
    var btn = state.panel.querySelector('.awt-jump');
    if (!btn) return;
    var show = out ? !atBottom(out) : false;
    btn.style.display = show ? 'block' : 'none';
  }

  function jumpToLatest() {
    if (!state.panel) return;
    var out = state.panel.querySelector('.awt-out');
    state.pinned = true;
    out.scrollTop = out.scrollHeight;
    updateJump(out);
  }

  function clearPanel() {
    state.outputText = '';
    state.history = [];
    state.lastResult = null;
    state.pinned = true;
    if (state.panel) {
      state.panel.querySelector('.awt-out').textContent = '';
      updateJump(state.panel.querySelector('.awt-out'));
    }
  }

  function copyOutput() {
    try { navigator.clipboard.writeText(state.outputText); } catch (e) {}
  }

  function blockFor(rec, mode) {
    var body = rec.stdout || '';
    if (rec.stderr) body += (body ? '\n' : '') + '[stderr]\n' + rec.stderr;

    if (mode === 'selected') {
      var sel = window.getSelection ? window.getSelection().toString() : '';
      if (sel && sel.trim()) body = sel;
    }

    var t = truncate(redact(body));
    var header = '[LLM2Shell] session=' + rec.sessionId +
      (rec.cwd ? ' cwd=' + rec.cwd : '') +
      ' exit=' + rec.exitCode + ' status=' + rec.status;
    // The command line is always included: a transcript with several results
    // is unreadable without knowing which command produced which output.
    var text = header + '\n$ ' + rec.command + '\n\n' + t.text;
    if (t.truncated) text += '\n\n…[output truncated by LLM2Shell]';
    return text;
  }

  function buildPayload(mode) {
    if (mode === 'all') {
      if (!state.history.length) return null;
      return state.history.map(function (rec) {
        return blockFor(rec, 'output');
      }).join('\n\n');
    }

    var rec = state.lastResult;
    if (!rec) {
      if (!state.outputText.trim()) return null;
      var only = truncate(redact(state.outputText));
      return only.text + (only.truncated ? '\n…[truncated]' : '');
    }
    return blockFor(rec, mode);
  }

  function sendToAI(mode) {
    var text = buildPayload(mode);
    if (text === null) {
      appendOut('\n[LLM2Shell] Nothing to send yet — run a command first.\n', 'stderr');
      return;
    }
    var res = fillInput(text);
    if (!res.ok) {
      appendOut('\n[LLM2Shell] Could not find the AI input box.\n', 'stderr');
      return;
    }
    appendOut(
      '\n[LLM2Shell] ' + (res.mode === 'append' ? 'Appended to' : 'Replaced') +
        ' the AI input box (' + res.length + ' chars). Review and send.\n',
      'stderr'
    );
  }

  // ------------------------------------------------------------- insert mode
  function setInsertMode(mode, persist) {
    state.insertMode = mode === 'replace' ? 'replace' : 'append';
    if (state.panel) {
      var sel = state.panel.querySelector('.awt-mode');
      if (sel && sel.value !== state.insertMode) sel.value = state.insertMode;
    }
    if (persist !== false) {
      try { chrome.storage.local.set({ awtInsertMode: state.insertMode }); } catch (e) {}
    }
    return state.insertMode;
  }

  function loadInsertMode(done) {
    try {
      chrome.storage.local.get({ awtInsertMode: 'append' }, function (cfg) {
        if (cfg && cfg.awtInsertMode) setInsertMode(cfg.awtInsertMode, false);
        if (typeof done === 'function') done(state.insertMode);
      });
    } catch (e) {
      if (typeof done === 'function') done(state.insertMode);
    }
  }

  // ----------------------------------------------------------- prompt button
  function promptText() {
    if (state.config.prompt) return state.config.prompt;
    if (typeof window.LLM2ShellPrompt === 'string' && window.LLM2ShellPrompt) {
      return window.LLM2ShellPrompt;
    }
    return typeof window.LLM2ShellPromptShort === 'string'
      ? window.LLM2ShellPromptShort
      : 'Put each runnable command batch in a fenced block tagged `powershell` / `bash` / `sh`.';
  }

  function sendPrompt() {
    expandPanel();
    var text = promptText();
    // Clicking twice in append mode would stack two copies of the prompt.
    var probe = text.slice(0, 40);
    var el = findInput();
    if (el && state.insertMode === 'append' && readInput(el).indexOf(probe) !== -1) {
      appendOut('\n[LLM2Shell] The prompt is already in the input box.\n', 'stderr');
      return;
    }
    var res = fillInput(text);
    if (!res.ok) {
      appendOut('\n[LLM2Shell] Could not find the AI input box.\n', 'stderr');
      return;
    }
    appendOut(
      '\n[LLM2Shell] ' + (res.mode === 'append' ? 'Appended' : 'Inserted') +
        ' the formatting prompt. Send it once per conversation.\n',
      'stderr'
    );
  }

  // ------------------------------------------------------------ new chat
  function newChatUrl() {
    if (state.config.newChatUrl) return state.config.newChatUrl;
    try {
      return window.location.origin + '/';
    } catch (e) {
      return '';
    }
  }

  function openNewChat() {
    var url = newChatUrl();
    if (!url) {
      appendOut('\n[LLM2Shell] No new-chat URL for this site.\n', 'stderr');
      return;
    }
    var win = null;
    try {
      win = window.open(url, '_blank', 'noopener');
    } catch (e) {
      win = null;
    }
    appendOut(
      '\n[LLM2Shell] ' + (win ? 'Opened' : 'Could not open') + ' a new conversation: ' + url + '\n',
      win ? 'stdout' : 'stderr'
    );
  }

  // ---------------------------------------------------------------- SSH form
  function connectSSH() {
    if (!state.panel) return;
    var host = state.panel.querySelector('.awt-ssh-host').value.trim();
    var port = parseInt(state.panel.querySelector('.awt-ssh-port').value, 10) || 22;
    var username = state.panel.querySelector('.awt-ssh-user').value.trim();
    var password = state.panel.querySelector('.awt-ssh-pass').value;
    var identityFile = state.panel.querySelector('.awt-ssh-key').value.trim();

    if (!host) {
      appendOut('\n[LLM2Shell] SSH host (or ~/.ssh/config alias) is required.\n', 'stderr');
      return;
    }

    expandPanel();
    appendOut('\n[LLM2Shell] Connecting to ' + (username ? username + '@' : '') + host + ':' + port + '…\n', 'stdout');
    state.panel.querySelector('.awt-ssh-pass').value = '';
    state.panel.querySelector('.awt-sshform').style.display = 'none';

    sendRuntime(
      {
        type: 'awt:createSession',
        session: {
          sessionType: 'ssh',
          name: (username ? username + '@' : '') + host,
          host: host,
          port: port,
          username: username,
          password: password,
          identityFile: identityFile
        }
      },
      function (resp) {
        if (resp && !resp.ok && !resp.contextInvalidated) appendOut('[LLM2Shell] Bridge unavailable.\n', 'stderr');
      }
    );
  }

  // --------------------------------------------------------- SSH disconnect
  function disconnectSession() {
    if (!state.panel) return;
    var id = state.sessionId;
    var sess = null;
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === id) { sess = state.sessions[i]; break; }
    }
    if (!sess) {
      appendOut('\n[LLM2Shell] No session selected to disconnect.\n', 'stderr');
      return;
    }
    if (sess.type !== 'ssh') {
      appendOut(
        '\n[LLM2Shell] Only SSH sessions can be disconnected — local sessions are stateless.\n',
        'stderr'
      );
      return;
    }
    appendOut('\n[LLM2Shell] Disconnecting "' + (sess.name || sess.id) + '"…\n', 'stdout');
    sendRuntime({ type: 'awt:killSession', sessionId: sess.id });
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

  // Read the block at click time, not when the toolbar was injected. ChatGPT and
  // Gemini stream code into the DOM, so a toolbar can be created while the block
  // is still being written; using the captured snapshot then runs a truncated
  // command (typically ending in an unterminated quote).
  function blockText(pre) {
    if (!pre) return '';
    var code = pre.querySelector('code') || pre;
    var t = code.innerText;
    if (typeof t !== 'string') t = code.textContent || '';
    return t.replace(/\n+$/, '');
  }

  function buildToolbar(pre, lang) {
    var bar = document.createElement('div');
    bar.className = 'awt-toolbar';
    bar.setAttribute('data-awt-toolbar', '1');
    var tag = document.createElement('span');
    tag.className = 'awt-tag';
    tag.textContent = 'LLM2Shell';
    bar.appendChild(tag);

    bar.appendChild(makeButton('Run', 'Run in the selected terminal', function () {
      runCommand(blockText(pre), lang);
    }));
    bar.appendChild(makeButton('Run All', 'Run this block', function () {
      runCommand(blockText(pre), lang);
    }));
    bar.appendChild(makeButton('Copy', 'Copy to clipboard', function () {
      try { navigator.clipboard.writeText(blockText(pre)); } catch (e) {}
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
    // The panel is a transcript: previous commands and their output stay, each
    // new one is introduced by its own `$ command` header. Clear it manually
    // with the Clear button.
    state.pinned = true;
    appendCommandHeader(command);
    if (/^\s*ssh\s/i.test(command)) {
      var cur = null;
      for (var i = 0; i < state.sessions.length; i++) {
        if (state.sessions[i].id === state.sessionId) cur = state.sessions[i];
      }
      if (!cur || cur.type !== 'ssh') {
        appendOut(
          '[LLM2Shell] Tip: a local `ssh host "cmd"` is one-shot — it reconnects every time, prints\n' +
            'the "Pseudo-terminal will not be allocated" warning, and cannot answer a password prompt.\n' +
            'Use + SSH for a persistent, authenticated session (or add -T to silence the warning).\n',
          'stderr'
        );
      }
    }
    state.lastResult = null;
    if (!state.connected) {
      appendOut('[LLM2Shell] Bridge not connected. Start it with `npm start` and set the token in the extension options.\n', 'stderr');
    }
    sendRuntime(
      { type: 'awt:run', command: command, lang: lang, sessionId: state.sessionId },
      function (resp) {
        if (resp && !resp.ok && !resp.queued && !resp.contextInvalidated) {
          appendOut('[LLM2Shell] Bridge unavailable.\n', 'stderr');
        }
      }
    );
  }

  // ChatGPT and Gemini often lay a code block out as a flex row. Dropped in as a
  // plain sibling, the toolbar becomes a flex item that the wide <pre> squeezes
  // down to a few pixels — the buttons then wrap one letter per line. Give the
  // toolbar a full-width line of its own instead of letting it share the row.
  function placeToolbar(bar, pre) {
    var parent = pre.parentNode;
    if (!parent || parent.nodeType !== 1) return;

    var cs = null;
    try { cs = window.getComputedStyle(parent); } catch (e) {}
    var disp = cs ? String(cs.display || '') : '';

    if (disp === 'flex' || disp === 'inline-flex') {
      var dir = String((cs && cs.flexDirection) || 'row').toLowerCase();
      if (dir.indexOf('column') === -1) {
        var others = 0;
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i] !== pre) others++;
        }
        if (others === 0) {
          // Only the code block lives in this row: allow wrapping and claim a line.
          try { parent.style.flexWrap = 'wrap'; } catch (e) {}
          bar.style.flex = '0 0 100%';
          bar.style.width = '100%';
        } else if (parent.parentNode) {
          // Something else shares the row (a gutter, a line-number column) —
          // put the toolbar above the whole row rather than reflowing it.
          parent.parentNode.insertBefore(bar, parent);
          return;
        }
      }
    } else if (disp === 'grid' || disp === 'inline-grid') {
      bar.style.gridColumn = '1 / -1';
    }

    // Code cards clip at a rounded corner; line the toolbar up with the code
    // text so the label is not shaved off by the curve.
    var pad = 0;
    try {
      var pcs = window.getComputedStyle(pre);
      pad = parseFloat(pcs.paddingLeft) || 0;
    } catch (e) {}
    if (pad > 0) {
      bar.style.paddingLeft = pad + 'px';
      bar.style.paddingRight = pad + 'px';
    }

    parent.insertBefore(bar, pre);
  }

  // The panel's own output <pre> is NOT a code block and must be ignored by the
  // code-block scanner. Crucially it must also be excluded from the page-wide
  // MutationObserver: every streamed SSH/output chunk would otherwise force a
  // full reflow of the (growing) panel, which scales O(n^2) over a session and
  // pegs CPU / memory.
  function insidePanel(node) {
    if (!state.panel || !node) return false;
    if (node === state.panel) return true;
    var el = node.nodeType === 1 ? node : (node.parentElement || node.parentNode);
    return !!(el && state.panel.contains(el));
  }

  function processPre(pre) {
    if (!pre || pre.getAttribute('data-awt') === '1') return;
    if (insidePanel(pre)) return;
    var code = pre.querySelector('code') || pre;
    var text = code.innerText || code.textContent || '';
    if (!text.trim()) return;
    var lang = detectLang(pre, code);
    if (!shouldRun(lang, text)) return;
    pre.setAttribute('data-awt', '1');
    var bar = buildToolbar(pre, lang);
    placeToolbar(bar, pre);
  }

  function scan(root) {
    var scope = root || document;
    // A newly added node may itself be a <pre>; process it before descendants.
    if (scope.nodeType === 1 && scope.tagName === 'PRE' && !insidePanel(scope)) processPre(scope);
    var pres = scope.querySelectorAll ? scope.querySelectorAll('pre') : [];
    for (var i = 0; i < pres.length; i++) {
      if (!insidePanel(pres[i])) processPre(pres[i]);
    }
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
        state.history.push(p);
        if (state.history.length > 50) state.history.shift();
        if (p.invalid) {
          appendOut('[LLM2Shell] Nothing was executed: the command is malformed.\n', 'stderr');
        } else if (p.timedOut) {
          appendOut(
            '[LLM2Shell] Timed out. A password prompt or an interactive program cannot be answered\n' +
              'from this panel — use + SSH for a remote host.\n',
            'stderr'
          );
        }
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
        sendRuntime({ type: 'awt:sessions' });
        break;
      case 'awt:session.killed':
        if (state.sessionId === p.sessionId) state.sessionId = null;
        appendOut('\n[LLM2Shell] Session "' + (p.sessionId || '?') + '" disconnected.\n', 'stdout');
        sendRuntime({ type: 'awt:sessions' });
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
    loadInsertMode();

    try {
      chrome.runtime.onMessage.addListener(onMessage);
      sendRuntime({ type: 'awt:status' }, function (r) {
        if (r && typeof r.connected === 'boolean') setConnected(r.connected);
      });
      sendRuntime({ type: 'awt:sessions' });
    } catch (e) {
      // Not running as an extension (e.g. manual injection): stay usable but
      // without a Bridge connection.
      setConnected(false);
    }

    // Streaming replies fill an already-mounted <code> with text instead of
    // adding a new <pre>. Without re-checking on text mutations those blocks are
    // seen once while empty and never get a toolbar.
    function recheck(node) {
      if (!node) return;
      var el = node.nodeType === 1 ? node : node.parentElement || node.parentNode;
      if (!el || el.nodeType !== 1) return;
      var pre = el.tagName === 'PRE' ? el : el.closest ? el.closest('pre') : null;
      if (pre && pre.getAttribute('data-awt') !== '1') processPre(pre);
    }

    var pendingMuts = [];
    var flushScheduled = false;
    function flushObserver() {
      flushScheduled = false;
      var batch = pendingMuts;
      pendingMuts = [];
      for (var i = 0; i < batch.length; i++) {
        var mut = batch[i];
        if (insidePanel(mut.target)) continue;
        if (mut.type === 'characterData') {
          recheck(mut.target);
          continue;
        }
        var added = mut.addedNodes;
        if (!added) continue;
        for (var j = 0; j < added.length; j++) {
          if (insidePanel(added[j])) continue;
          if (added[j].nodeType === 1) scan(added[j]);
          else if (added[j].nodeType === 3) recheck(added[j]);
        }
      }
    }
    // Debounce: in a real browser collapse every mutation burst into a single
    // pass per animation frame (requestAnimationFrame). Without this, a streamed
    // reply / output chunk triggers one full page re-scan per character, and the
    // panel's own growth would reflow O(n^2). Where rAF is unavailable (jsdom /
    // tests) fall back to flushing synchronously so behaviour is unchanged.
    var hasRAF = typeof requestAnimationFrame === 'function';
    var observer = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) pendingMuts.push(muts[i]);
      if (flushScheduled) return;
      flushScheduled = true;
      if (hasRAF) requestAnimationFrame(flushObserver);
      else flushObserver();
    });
    try {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch (e) {}

    scan(document);
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      scan(document);
      if (tries >= 10) clearInterval(timer);
    }, 1000);
  }

  // `LLM2Shell.debug()` in the page console explains why a block has no buttons:
  // detected language, whether it passed the shell check, and its text length.
  function debug() {
    var rows = [];
    var pres = document.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      var code = pre.querySelector('code') || pre;
      var text = code.innerText || code.textContent || '';
      var lang = detectLang(pre, code);
      rows.push({
        injected: pre.getAttribute('data-awt') === '1',
        lang: lang || '(none)',
        shell: shouldRun(lang, text),
        chars: text.length,
        head: text.replace(/\s+/g, ' ').slice(0, 60)
      });
    }
    if (console.table) console.table(rows);
    return rows;
  }

  window.LLM2Shell = {
    install: install,
    rescan: function () { scan(document); },
    debug: debug
  };
})();
