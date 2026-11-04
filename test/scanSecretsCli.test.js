const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const script = path.join(__dirname, '..', 'scripts', 'scan-secrets.js');

// Built at runtime so this fixture does not itself trip the scanner.
const PUBLIC_IP = [93, 184, 216, 34].join('.');

function commit(dir, message) {
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

function scan(dir, extra) {
  return spawnSync(process.execPath, [script, '--cwd', dir].concat(extra || []), {
    encoding: 'utf8'
  });
}

describe('scan-secrets CLI', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-scan-'));
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('exits 0 on a clean repository', () => {
    fs.writeFileSync(path.join(dir, 'notes.md'), '# clean\nnothing private here\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'clean');

    const res = scan(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No findings');
  });

  it('exits 1 and names the rule when a public IP is committed', () => {
    fs.writeFileSync(path.join(dir, 'config.txt'), 'HostName ' + PUBLIC_IP + '\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'leak');

    const res = scan(dir);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('public-ip');
    expect(res.stdout).toContain('config.txt:1');
    // The value itself must be masked in the report.
    expect(res.stdout).not.toContain(PUBLIC_IP);
  });

  it('catches a secret that only exists in history', () => {
    const file = path.join(dir, 'config.txt');
    fs.writeFileSync(file, 'HostName ' + PUBLIC_IP + '\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'leak');

    // Remove it from the working tree and HEAD — the object stays in history.
    fs.writeFileSync(file, 'HostName example.invalid\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'clean up');

    const res = scan(dir);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('public-ip');
    expect(res.stdout).toContain('in 1 commit(s)');
  });

  it('can skip the history scan with --no-history', () => {
    const res = scan(dir, ['--no-history']);
    expect(res.status).toBe(0);
  });

  it('honours a local deny-list file', () => {
    fs.writeFileSync(path.join(dir, '.secret-denylist'), '# local\nmy-private-alias\n');
    fs.writeFileSync(path.join(dir, 'doc.md'), 'run ssh my-private-alias to connect\n');
    execFileSync('git', ['add', 'doc.md'], { cwd: dir });
    commit(dir, 'doc');

    const res = scan(dir);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('denylist');
    expect(res.stdout).toContain('doc.md:1');
  });

  it('supports --json output', () => {
    fs.writeFileSync(path.join(dir, 'config.txt'), 'HostName ' + PUBLIC_IP + '\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'leak');

    const res = scan(dir, ['--json']);
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.findings.length).toBeGreaterThan(0);
    expect(parsed.findings[0].rule).toBe('public-ip');
  });
});
