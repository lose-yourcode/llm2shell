const d = require('../src/bridge/commandDetector');

describe('commandDetector.isShellLang', () => {
  it('accepts common shell language tags', () => {
    for (const lang of ['bash', 'sh', 'shell', 'zsh', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'console']) {
      expect(d.isShellLang(lang)).toBe(true);
    }
  });

  it('normalizes case and punctuation', () => {
    expect(d.isShellLang('PowerShell')).toBe(true);
    expect(d.isShellLang('shell-session')).toBe(true);
    expect(d.isShellLang('shell_session')).toBe(true);
  });

  it('rejects non-shell languages', () => {
    for (const lang of ['python', 'js', 'javascript', 'json', 'html', 'css', 'yaml', 'sql']) {
      expect(d.isShellLang(lang)).toBe(false);
    }
  });
});

describe('commandDetector.parseFencedCode', () => {
  it('extracts language and code', () => {
    const md = 'Here you go:\n```bash\necho hi\nls -la\n```\nDone.';
    const blocks = d.parseFencedCode(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('bash');
    expect(blocks[0].code).toBe('echo hi\nls -la');
  });

  it('handles multiple blocks and info strings', () => {
    const md = '```powershell title=x\nGet-ChildItem\n```\n\n```python\nprint(1)\n```';
    const blocks = d.parseFencedCode(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].lang).toBe('powershell');
    expect(blocks[1].lang).toBe('python');
  });

  it('returns empty for non-string', () => {
    expect(d.parseFencedCode(null)).toEqual([]);
  });
});

describe('commandDetector.looksLikeShellCommand', () => {
  it('detects typical commands', () => {
    expect(d.looksLikeShellCommand('git status')).toBe(true);
    expect(d.looksLikeShellCommand('npm install')).toBe(true);
    expect(d.looksLikeShellCommand('Get-ChildItem C:\\')).toBe(true);
    expect(d.looksLikeShellCommand('cd /tmp && ls')).toBe(true);
  });

  it('does not flag python source', () => {
    expect(d.looksLikeShellCommand('def main():\n    return 1')).toBe(false);
  });
});

describe('commandDetector.shouldRunBlock', () => {
  it('runs explicit shell blocks', () => {
    expect(d.shouldRunBlock('bash', 'anything')).toBe(true);
  });

  it('falls back to content heuristic for generic tags', () => {
    expect(d.shouldRunBlock('text', 'git log --oneline')).toBe(true);
    expect(d.shouldRunBlock('', 'ls -la')).toBe(true);
    expect(d.shouldRunBlock('text', 'const x = 1;\nconsole.log(x);')).toBe(false);
  });

  it('ignores known non-shell languages', () => {
    expect(d.shouldRunBlock('python', 'print(1)')).toBe(false);
  });
});
