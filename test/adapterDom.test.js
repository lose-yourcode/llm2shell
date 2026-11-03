// @vitest-environment jsdom
const fs = require('fs');
const path = require('path');

const adapterSrc = fs.readFileSync(
  path.join(__dirname, '..', 'browser', 'content', 'adapter.js'),
  'utf8'
);

function installAdapter(win) {
  const calls = [];
  const listeners = [];
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
    }
  };

  // Evaluate the browser IIFE with jsdom globals injected as parameters.
  const fn = new Function(
    'window', 'document', 'chrome', 'MutationObserver', 'navigator',
    'setInterval', 'clearInterval', 'Event',
    adapterSrc
  );
  fn(win, win.document, chromeMock, win.MutationObserver, win.navigator, () => 0, () => {}, win.Event);
  return { chromeMock, calls, listeners };
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

  it('manual command input sends a command on Enter', () => {
    const input = document.querySelector('#awt-panel .awt-cmd');
    input.value = 'Get-Location';
    const ev = new window.Event('keydown', { bubbles: true });
    ev.key = 'Enter';
    input.dispatchEvent(ev);
    const runCall = calls.filter((c) => c.type === 'awt:run').pop();
    expect(runCall.command).toBe('Get-Location');
  });
});
