const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'browser');

describe('Browser extension files', () => {
  it('manifest is valid JSON with MV3 and the expected content scripts', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.content_scripts.length).toBe(2);
    const matches = manifest.content_scripts.flatMap((c) => c.matches);
    expect(matches.some((m) => m.includes('chatgpt.com'))).toBe(true);
    expect(matches.some((m) => m.includes('gemini.google.com'))).toBe(true);
  });

  it('adapter.js is valid JS and exposes the expected surface', () => {
    const src = fs.readFileSync(path.join(dir, 'content', 'adapter.js'), 'utf8');
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain('window.LLM2Shell');
    expect(src).toContain('fillInput');
    expect(src).toContain('MutationObserver');
    expect(src).toContain("'Run'");
    expect(src).toContain("'Run All'");
    expect(src).toContain('Send Output');
    expect(src).toContain('awt:run');
  });

  it('site profiles call install with input selectors', () => {
    for (const f of ['chatgpt.js', 'gemini.js']) {
      const src = fs.readFileSync(path.join(dir, 'content', f), 'utf8');
      expect(() => new Function(src)).not.toThrow();
      expect(src).toContain('LLM2Shell.install');
      expect(src).toContain('inputSelectors');
    }
  });

  it('background.js relays the protocol', () => {
    const src = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain('new WebSocket');
    expect(src).toContain('hello.ok');
    expect(src).toContain('pendingTabs');
  });
});
