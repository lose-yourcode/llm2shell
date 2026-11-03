/*
 * generic.adapter.js
 * ------------------
 * Injected into every AI web page (<webview>). Responsibilities:
 *   1. Watch the DOM for AI replies that contain shell code blocks.
 *   2. Attach Run / Run All / Copy / Select Terminal buttons.
 *   3. Queue commands for the host to pick up (host polls __awt.queue).
 *   4. Expose __awt.fillInput(text) so results can be put back into the
 *      chat input box for the user to confirm & send.
 *
 * This runs inside the *remote* page, so it has no Node access and must never
 * assume a fixed DOM structure. Selectors are heuristics with fallbacks.
 */
(function () {
  if (window.__awtInstalled) return;
  window.__awtInstalled = true;

  var cfg = window.__awtConfig || {};
  var SITE = cfg.site || 'generic';
  var INPUT_SELECTORS = cfg.inputSelectors || [
    'textarea',
    'div[contenteditable="true"]',
    'div[role="textbox"]',
    '[contenteditable="true"]'
  ];

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
    return hits > 0 || lines.length <= 2;
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
    var attrs = [code.className, pre.className, code.getAttribute('data-language'), pre.getAttribute('data-language'), code.getAttribute('lang')];
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      if (!a) continue;
      var m = String(a).match(/language-([a-z0-9+#-]+)/i) || String(a).match(/lang-([a-z0-9+#-]+)/i);
      if (m) return m[1];
      if (/^[a-z0-9+#-]+$/i.test(String(a).trim())) return String(a).trim();
    }
    return '';
  }

  // ---- command queue -------------------------------------------------------
  var queue = [];
  function push(msg) {
    msg.site = SITE;
    msg.ts = Date.now();
    queue.push(msg);
  }

  // ---- input filling -------------------------------------------------------
  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findInput() {
    for (var i = 0; i < INPUT_SELECTORS.length; i++) {
      var list = document.querySelectorAll(INPUT_SELECTORS[i]);
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (el.offsetParent !== null && (el.tagName === 'TEXTAREA' || el.isContentEditable || el.getAttribute('role') === 'textbox')) {
          return el;
        }
      }
    }
    // Fallback: the last visible textarea / contenteditable on the page.
    var all = document.querySelectorAll('textarea, div[contenteditable="true"]');
    for (var k = all.length - 1; k >= 0; k--) {
      if (all[k].offsetParent !== null) return all[k];
    }
    return null;
  }

  function fillInput(text) {
    var el = findInput();
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      setNativeValue(el, text);
      try { el.setSelectionRange(text.length, text.length); } catch (e) {}
    } else {
      // contenteditable (ChatGPT / Gemini editors)
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

  // ---- toolbar injection ---------------------------------------------------
  function makeButton(label, title, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title || label;
    b.setAttribute('data-awt-btn', '1');
    b.style.cssText = 'cursor:pointer;padding:2px 9px;border:1px solid #9aa0a6;border-radius:5px;background:#f1f3f4;color:#202124;font:12px/1.6 system-ui,sans-serif;';
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      fn();
    });
    return b;
  }

  function buildToolbar(text, lang) {
    var bar = document.createElement('div');
    bar.setAttribute('data-awt-toolbar', '1');
    bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px;align-items:center;';
    var tag = document.createElement('span');
    tag.textContent = 'LLM2Shell';
    tag.style.cssText = 'font:11px system-ui,sans-serif;color:#5f6368;margin-right:2px;';
    bar.appendChild(tag);
    bar.appendChild(makeButton('Run', 'Run in the selected terminal', function () { push({ action: 'run', command: text, lang: lang }); }));
    bar.appendChild(makeButton('Run All', 'Run all commands in this block', function () { push({ action: 'run', command: text, lang: lang, all: true }); }));
    bar.appendChild(makeButton('Copy', 'Copy to clipboard', function () {
      try { navigator.clipboard.writeText(text); } catch (e) {}
    }));
    bar.appendChild(makeButton('Select Terminal', 'Choose which terminal session runs this', function () { push({ action: 'select', command: text, lang: lang }); }));
    return bar;
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
    var pres = scope.querySelectorAll ? scope.querySelectorAll('pre') : [];
    for (var i = 0; i < pres.length; i++) processPre(pres[i]);
  }

  // ---- expose + observe ----------------------------------------------------
  window.__awt = {
    site: SITE,
    queue: queue,
    fillInput: fillInput,
    scan: function () { scan(document); return true; },
    ping: function () { return { ok: true, site: SITE }; }
  };

  var observer = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        if (added[j].nodeType === 1) scan(added[j]);
      }
    }
  });
  try {
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (e) {
    // body may not exist yet; retry once shortly.
    setTimeout(function () { try { observer.observe(document.body, { childList: true, subtree: true }); } catch (_) {} }, 500);
  }

  scan(document);
  // Re-scan a few times for SPA hydration.
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    scan(document);
    if (tries >= 10) clearInterval(timer);
  }, 1000);
})();
