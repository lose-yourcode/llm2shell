const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'electron', 'adapters');

describe('AI adapter scripts', () => {
  const files = ['generic.adapter.js', 'chatgpt.adapter.js', 'gemini.adapter.js'];

  for (const f of files) {
    it(`${f} is syntactically valid JavaScript`, () => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(() => new Function(src)).not.toThrow();
    });
  }

  it('generic adapter exposes the expected API and buttons', () => {
    const src = fs.readFileSync(path.join(dir, 'generic.adapter.js'), 'utf8');
    expect(src).toContain('window.__awt');
    expect(src).toContain('fillInput');
    expect(src).toContain("'Run'");
    expect(src).toContain("'Run All'");
    expect(src).toContain("'Copy'");
    expect(src).toContain("'Select Terminal'");
    expect(src).toContain('MutationObserver');
  });

  it('site adapters set __awtConfig', () => {
    for (const f of ['chatgpt.adapter.js', 'gemini.adapter.js']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src).toContain('window.__awtConfig');
    }
  });
});
