const {
  findUnterminatedQuote,
  isBalanced,
  formatQuoteWarning,
  isPowerShellShell
} = require('../src/bridge/quoteGuard');

describe('quoteGuard', () => {
  it('accepts a normal command', () => {
    expect(isBalanced('Get-ChildItem -Path C:\\Temp', 'powershell')).toBe(true);
    expect(isBalanced('ls -la /tmp', 'bash')).toBe(true);
  });

  it('accepts balanced quotes in both shells', () => {
    expect(isBalanced('ssh myserver "systemctl status nginx --no-pager -l"', 'powershell')).toBe(true);
    expect(isBalanced("echo 'a b' \"c d\"", 'bash')).toBe(true);
  });

  it('accepts a quoted command that wraps across lines (PowerShell allows it)', () => {
    const cmd = 'ssh myserver "systemctl list-dependencies --reverse rpcbind.service --no-pager;\nsystemctl is-enabled rpcbind.service rpcbind.socket"';
    expect(isBalanced(cmd, 'powershell')).toBe(true);
  });

  it('flags a double quote that never closes and reports where', () => {
    const cmd = 'ssh myserver "systemctl list-dependencies --reverse rpcbind.service';
    const info = findUnterminatedQuote(cmd, 'powershell');
    expect(info).toBeTruthy();
    expect(info.quote).toBe('"');
    expect(info.line).toBe(1);
    expect(info.column).toBe(14);
  });

  it('flags an unterminated single quote', () => {
    const info = findUnterminatedQuote("echo 'oops", 'bash');
    expect(info).toBeTruthy();
    expect(info.quote).toBe("'");
    expect(info.line).toBe(1);
  });

  it('reports the line of a later unterminated quote', () => {
    const cmd = 'echo one\necho two\nssh host "still open';
    const info = findUnterminatedQuote(cmd, 'bash');
    expect(info.line).toBe(3);
  });

  it('ignores quotes inside a comment', () => {
    expect(isBalanced('ls -la # don\'t worry "about this', 'bash')).toBe(true);
    expect(isBalanced('Get-Date # it\'s "fine', 'powershell')).toBe(true);
  });

  it('does not treat a # inside a URL as a comment', () => {
    expect(isBalanced('curl http://example.com/page#frag "x"', 'bash')).toBe(true);
  });

  it('handles PowerShell "" and `" escapes', () => {
    expect(isBalanced('Write-Output "say ""hi"""', 'powershell')).toBe(true);
    expect(isBalanced('Write-Output "say `"hi`""', 'powershell')).toBe(true);
  });

  it('handles bash backslash-escaped quotes', () => {
    expect(isBalanced('echo "say \\"hi\\""', 'bash')).toBe(true);
  });

  it('accepts a PowerShell here-string', () => {
    const cmd = 'Write-Output @"\nline "quoted"\n"@\nWrite-Output done';
    expect(isBalanced(cmd, 'powershell')).toBe(true);
  });

  it('flags an unterminated here-string', () => {
    const info = findUnterminatedQuote('Write-Output @"\nno terminator', 'powershell');
    expect(info).toBeTruthy();
  });

  it('formats a warning that names the position and the offending line', () => {
    const cmd = 'ssh myserver "systemctl status';
    const msg = formatQuoteWarning(findUnterminatedQuote(cmd, 'powershell'), cmd);
    expect(msg).toContain('unterminated "');
    expect(msg).toContain('line 1, column 14');
    expect(msg).toContain('ssh myserver "systemctl status');
    expect(msg).toContain('Refusing to run');
  });

  it('detects the PowerShell shell aliases', () => {
    expect(isPowerShellShell('powershell')).toBe(true);
    expect(isPowerShellShell('pwsh')).toBe(true);
    expect(isPowerShellShell('bash')).toBe(false);
  });
});
