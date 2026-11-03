const CommandExecutor = require('../src/bridge/commandExecutor');

const isWin = process.platform === 'win32';

describe('CommandExecutor (real child process)', () => {
  it('captures stdout and a zero exit code', async () => {
    const ex = new CommandExecutor();
    const cmd = isWin ? 'Write-Output "hello-awt"' : 'echo hello-awt';
    const res = await ex.run({ command: cmd, timeout: 30000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hello-awt');
    expect(res.timedOut).toBe(false);
  }, 40000);

  it('separates stdout and stderr', async () => {
    const ex = new CommandExecutor();
    const cmd = isWin
      ? 'Write-Output "OUT-LINE"; [Console]::Error.WriteLine("ERR-LINE")'
      : 'echo OUT-LINE; echo ERR-LINE 1>&2';
    const res = await ex.run({ command: cmd, timeout: 30000 });
    expect(res.stdout).toContain('OUT-LINE');
    expect(res.stderr).toContain('ERR-LINE');
    // Ensure they are not mixed into each other.
    expect(res.stdout).not.toContain('ERR-LINE');
    expect(res.stderr).not.toContain('OUT-LINE');
  }, 40000);

  it('returns the real non-zero exit code', async () => {
    const ex = new CommandExecutor();
    const cmd = isWin ? 'exit 3' : 'exit 3';
    const res = await ex.run({ command: cmd, timeout: 30000 });
    expect(res.exitCode).toBe(3);
  }, 40000);

  it('streams output through onData', async () => {
    const ex = new CommandExecutor();
    let streamed = '';
    const cmd = isWin ? 'Write-Output "stream-me"' : 'echo stream-me';
    await ex.run({ command: cmd, timeout: 30000, onData: (d) => { streamed += d; } });
    expect(streamed).toContain('stream-me');
  }, 40000);
});
