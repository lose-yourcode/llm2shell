// @vitest-environment jsdom
const fs = require('fs');
const path = require('path');

const adapterSrc = fs.readFileSync(
  path.join(__dirname, '..', 'browser', 'content', 'adapter.js'),
  'utf8'
);
const promptSrc = fs.readFileSync(
  path.join(__dirname, '..', 'browser', 'content', 'prompt.js'),
  'utf8'
);

function installAdapter(win) {
  const calls = [];
  const listeners = [];
  const stored = {};
  const chromeMock = {
    runtime: {
      id: 'test-extension-id',
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (msg, cb) => {
        calls.push(msg);
        if (typeof cb === 'function') {
          if (msg.type === 'awt:status') cb({ connected: true });
          else cb({ ok: true });
        }
      },
      lastError: undefined
    },
    storage: {
      local: {
        get: (defaults, cb) => {
          const out = Object.assign({}, defaults, stored);
          if (typeof cb === 'function') cb(out);
        },
        set: (obj, cb) => {
          Object.assign(stored, obj);
          if (typeof cb === 'function') cb();
        }
      }
    }
  };

  // prompt.js must run first: the adapter reads window.LLM2ShellPrompt.
  new Function('window', promptSrc)(win);

  // Evaluate the browser IIFE with jsdom globals injected as parameters.
  const fn = new Function(
    'window', 'document', 'chrome', 'MutationObserver', 'navigator',
    'setInterval', 'clearInterval', 'Event',
    adapterSrc
  );
  fn(win, win.document, chromeMock, win.MutationObserver, win.navigator, () => 0, () => {}, win.Event);
  return { chromeMock, calls, listeners, stored };
}

describe('browser adapter DOM behaviour', () => {
  let calls;
  let listeners;

  // The MutationObserver work is debounced to an animation frame in real
  // browsers. Wait for that flush (rAF, or a short timeout in jsdom) instead of
  // a bare setTimeout(0), which resolves before the frame fires.
  const tick = () =>
    new Promise((r) => {
      if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(r);
      else setTimeout(r, 20);
    });

  beforeAll(() => {
    document.body.innerHTML =
      '<pre><code class="language-powershell">Get-ChildItem</code></pre>' +
      '<textarea id="prompt-textarea"></textarea>';
    const ta = document.querySelector('textarea');
    // jsdom performs no layout; make the input look visible to findInput().
    Object.defineProperty(ta, 'offsetParent', { value: document.body, configurable: true });

    const installed = installAdapter(window);
    calls = installed.calls;
    listeners = installed.listeners;

    window.LLM2Shell.install({
      site: 'test',
      newChatUrl: 'https://example.test/new',
      inputSelectors: ['textarea']
    });
  });

  it('injects a toolbar with Run / Run All / Copy / Select Terminal', () => {
    const toolbar = document.querySelector('.awt-toolbar');
    expect(toolbar).toBeTruthy();
    const labels = Array.from(toolbar.querySelectorAll('.awt-run-btn')).map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Run', 'Run All', 'Copy', 'Select Terminal']));
  });

  it('does not add a toolbar to a Python code block', async () => {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-python';
    code.textContent = 'print(1)';
    pre.appendChild(code);
    document.body.appendChild(pre);
    // Let the MutationObserver run.
    await tick();
    const toolbarBefore = pre.previousElementSibling;
    expect(toolbarBefore && toolbarBefore.classList.contains('awt-toolbar')).toBeFalsy();
  });

  it('clicking Run sends the command to the bridge', () => {
    const runBtn = Array.from(document.querySelectorAll('.awt-run-btn')).find(
      (b) => b.textContent === 'Run'
    );
    runBtn.click();
    const runCall = calls.find((c) => c.type === 'awt:run');
    expect(runCall).toBeTruthy();
    expect(runCall.command).toContain('Get-ChildItem');
  });

  it('runs the live block text, not the snapshot taken at injection time', () => {
    // Streaming replies append to <code> after the toolbar was injected.
    const code = document.querySelector('pre code');
    code.textContent = 'Get-ChildItem -Path C:\\Temp';

    const runBtn = Array.from(document.querySelectorAll('.awt-run-btn')).find(
      (b) => b.textContent === 'Run'
    );
    runBtn.click();

    const runCall = calls.filter((c) => c.type === 'awt:run').pop();
    expect(runCall.command).toBe('Get-ChildItem -Path C:\\Temp');
  });

  it('Send Output fills the AI input box with the result', () => {
    const listener = listeners[0];
    listener({
      type: 'awt:result',
      payload: {
        reqId: 'r1',
        sessionId: 'sess-1',
        command: 'Get-ChildItem',
        exitCode: 0,
        stdout: 'file1.txt\n',
        stderr: '',
        status: 'success'
      }
    });
    const sendBtn = document.querySelector('#awt-panel button[data-awt="send"]');
    sendBtn.click();
    const ta = document.querySelector('textarea');
    expect(ta.value).toContain('file1.txt');
    expect(ta.value).toContain('exit=0');
  });

  it('appends the result below what is already in the input box', () => {
    const ta = document.querySelector('textarea');
    const modeSel = document.querySelector('#awt-panel .awt-mode');
    expect(modeSel.value).toBe('append');

    ta.value = 'my earlier question';
    document.querySelector('#awt-panel button[data-awt="send"]').click();

    expect(ta.value.startsWith('my earlier question')).toBe(true);
    expect(ta.value).toContain('file1.txt');
    expect(ta.value.indexOf('my earlier question')).toBeLessThan(ta.value.indexOf('file1.txt'));
  });

  it('replaces the input box when the mode is switched to Replace', () => {
    const ta = document.querySelector('textarea');
    const modeSel = document.querySelector('#awt-panel .awt-mode');
    modeSel.value = 'replace';
    modeSel.dispatchEvent(new window.Event('change', { bubbles: true }));

    ta.value = 'my earlier question';
    document.querySelector('#awt-panel button[data-awt="send"]').click();

    expect(ta.value).not.toContain('my earlier question');
    expect(ta.value).toContain('file1.txt');
  });

  it('the Prompt button inserts the formatting prompt', () => {
    const ta = document.querySelector('textarea');
    ta.value = '';
    document.querySelector('#awt-panel button[data-awt="prompt"]').click();

    expect(ta.value).toContain('LLM2Shell');
    expect(ta.value).toMatch(/fenced code block/i);
    expect(ta.value).toMatch(/powershell/i);
  });

  it('does not stack a second copy of the prompt in append mode', () => {
    const ta = document.querySelector('textarea');
    const modeSel = document.querySelector('#awt-panel .awt-mode');
    modeSel.value = 'append';
    modeSel.dispatchEvent(new window.Event('change', { bubbles: true }));

    ta.value = '';
    const btn = document.querySelector('#awt-panel button[data-awt="prompt"]');
    btn.click();
    btn.click();

    const occurrences = ta.value.split('You are helping me operate a real terminal').length - 1;
    expect(occurrences).toBe(1);
  });

  it('manual command input sends a command on Enter', () => {
    const input = document.querySelector('#awt-panel .awt-cmd');
    input.value = 'Get-Location';
    const ev = new window.Event('keydown', { bubbles: true });
    ev.key = 'Enter';
    input.dispatchEvent(ev);
    const runCall = calls.filter((c) => c.type === 'awt:run').pop();
    expect(runCall.command).toBe('Get-Location');
  });

  it('keeps a transcript: every command keeps its own header line', () => {
    const input = document.querySelector('#awt-panel .awt-cmd');
    const send = (cmd) => {
      input.value = cmd;
      const ev = new window.Event('keydown', { bubbles: true });
      ev.key = 'Enter';
      input.dispatchEvent(ev);
    };
    send('Get-Location');
    send('Get-Date');

    const out = document.querySelector('#awt-panel .awt-out');
    const headers = Array.from(out.querySelectorAll('.awt-cmdline')).map((n) => n.textContent.trim());
    expect(headers.slice(-2)).toEqual(['$ Get-Location', '$ Get-Date']);
    // The first command is not wiped by the second one.
    expect(out.textContent).toContain('$ Get-Location');
    expect(headers.length).toBeGreaterThan(2);
  });

  it('Send All puts every result, each with its command, into the input', () => {
    const listener = listeners[0];
    const rec = (cmd, out) => ({
      type: 'awt:result',
      payload: {
        reqId: 'r-' + cmd,
        sessionId: 'sess-1',
        command: cmd,
        exitCode: 0,
        stdout: out,
        stderr: '',
        status: 'success'
      }
    });
    listener(rec('Get-Location', 'C:\\Users\\me\n'));
    listener(rec('Get-Date', '2026-11-03\n'));

    const ta = document.querySelector('textarea');
    ta.value = '';
    const modeSel = document.querySelector('#awt-panel .awt-mode');
    modeSel.value = 'replace';
    modeSel.dispatchEvent(new window.Event('change', { bubbles: true }));

    document.querySelector('#awt-panel button[data-awt="sendall"]').click();

    expect(ta.value).toContain('$ Get-Location');
    expect(ta.value).toContain('$ Get-Date');
    expect(ta.value).toContain('C:\\Users\\me');
    expect(ta.value).toContain('2026-11-03');
  });

  it('has a jump-to-latest control and a new-chat button', () => {
    const jump = document.querySelector('#awt-panel button[data-awt="jump"]');
    expect(jump).toBeTruthy();
    expect(() => jump.click()).not.toThrow();

    const opened = [];
    window.open = (url) => {
      opened.push(url);
      return {};
    };
    document.querySelector('#awt-panel button[data-awt="newchat"]').click();
    expect(opened).toContain('https://example.test/new');
  });

  it('gives the toolbar a full-width line inside a flex-row code container', async () => {
    // ChatGPT lays the code body out as `display:flex`. A plain sibling would be
    // squeezed by the wide <pre> until the buttons wrap one letter per line.
    const row = document.createElement('div');
    row.style.display = 'flex';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-powershell';
    code.textContent = 'Get-Process';
    pre.appendChild(code);
    row.appendChild(pre);
    document.body.appendChild(row);
    await tick();

    const bar = Array.from(row.children).find((el) => el.classList.contains('awt-toolbar'));
    expect(bar).toBeTruthy();
    expect(row.style.flexWrap).toBe('wrap');
    expect(bar.style.flex).toBe('0 0 100%');
    expect(bar.nextElementSibling).toBe(pre);
  });

  it('puts the toolbar above a flex row that has other children', async () => {
    const card = document.createElement('div');
    const row = document.createElement('div');
    row.style.display = 'flex';
    const gutter = document.createElement('div');
    gutter.textContent = '1';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-bash';
    code.textContent = 'ls -la';
    pre.appendChild(code);
    row.appendChild(gutter);
    row.appendChild(pre);
    card.appendChild(row);
    document.body.appendChild(card);
    await tick();

    const bar = Array.from(card.children).find((el) => el.classList.contains('awt-toolbar'));
    expect(bar).toBeTruthy();
    expect(bar.nextElementSibling).toBe(row);
    // The gutter keeps sharing the row with the code.
    expect(row.contains(gutter)).toBe(true);
    expect(row.contains(pre)).toBe(true);
  });

  it('adds Run buttons to a Gemini-style code block', async () => {
    // Gemini wraps the block in <code-block> and labels the language in a header
    // span; the <pre>/<code> only carry layout classes such as
    // "code-block-internal". Those class names must not be read as a language.
    const host = document.createElement('code-block');
    host.innerHTML =
      '<div class="code-block">' +
      '<div class="code-block-decoration"><span class="code-block-decoration-text">PowerShell</span></div>' +
      '<div class="formatted-code-block-internal-container">' +
      '<pre class="code-block-internal"><code class="code-block-internal">Get-ChildItem -Path C:\\Temp</code></pre>' +
      '</div></div>';
    document.body.appendChild(host);
    await tick();

    const pre = host.querySelector('pre');
    const bar = host.querySelector('.awt-toolbar');
    expect(bar).toBeTruthy();
    expect(pre.getAttribute('data-awt')).toBe('1');
  });

  it('does not treat an arbitrary hyphenated class name as a language', async () => {
    const pre = document.createElement('pre');
    pre.className = 'formatted-code-block-internal';
    const code = document.createElement('code');
    code.className = 'some-layout-class';
    code.textContent = 'Get-Process';
    pre.appendChild(code);
    document.body.appendChild(pre);
    await tick();

    expect(pre.getAttribute('data-awt')).toBe('1');
  });

  it('still skips a Gemini-style block whose header says Python', async () => {
    const host = document.createElement('code-block');
    host.innerHTML =
      '<div class="code-block">' +
      '<div class="code-block-decoration"><span>Python</span></div>' +
      '<pre class="code-block-internal"><code class="code-block-internal">print(1)</code></pre>' +
      '</div>';
    document.body.appendChild(host);
    await tick();

    expect(host.querySelector('.awt-toolbar')).toBeFalsy();
  });

  it('picks up a block whose text arrives after the element was created', async () => {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-bash';
    pre.appendChild(code);
    document.body.appendChild(pre);
    await tick();
    expect(pre.getAttribute('data-awt')).toBeNull();

    // Streaming: the text is appended into an already-present, empty <code>.
    code.textContent = 'ls -la';
    await tick();

    expect(pre.getAttribute('data-awt')).toBe('1');
    expect(pre.previousElementSibling.classList.contains('awt-toolbar')).toBe(true);
  });

  it('collapses and restores the panel, keeping the collapse button usable', () => {
    const panel = document.getElementById('awt-panel');
    const btn = panel.querySelector('button[data-awt="collapse"]');

    expect(panel.querySelector('.awt-resize')).toBeTruthy();

    btn.click();
    expect(panel.classList.contains('awt-collapsed')).toBe(true);
    expect(btn.textContent).toBe('+');

    btn.click();
    expect(panel.classList.contains('awt-collapsed')).toBe(false);
    expect(btn.textContent).toBe('–');
  });
});
