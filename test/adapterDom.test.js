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

    window.LLM2Shell.install({ site: 'test', inputSelectors: ['textarea'] });
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
    await new Promise((r) => setTimeout(r, 0));
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
