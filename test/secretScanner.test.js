const { scanText, mask, isReservedIp, isPlaceholder } = require('../src/tools/secretScanner');

// Build sample values at runtime so this test file stays clean for
// `npm run scan:secrets` itself.
const BS = String.fromCharCode(92);
const PUBLIC_IP = [93, 184, 216, 34].join('.'); // example.com
const PRIVATE_IP = [192, 168, 1, 50].join('.');
const DOC_IP = [203, 0, 113, 10].join('.');
const GH_TOKEN = 'ghp_' + 'A'.repeat(36);
const AWS_KEY = 'AKIA' + 'B'.repeat(16);
const REAL_EMAIL = ['someone', 'acme-corp.com'].join('@');
const WIN_PATH = 'C:' + BS + 'Users' + BS + 'jdoe';
const KEY_BODY = 'A'.repeat(64);

describe('secretScanner', () => {
  it('flags a public IPv4 address', () => {
    const hits = scanText('HostName ' + PUBLIC_IP);
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe('public-ip');
    expect(hits[0].line).toBe(1);
  });

  it('ignores private, loopback and documentation addresses', () => {
    expect(scanText('host: ' + PRIVATE_IP)).toHaveLength(0);
    expect(scanText('host: 127.0.0.1')).toHaveLength(0);
    expect(scanText('host: ' + DOC_IP)).toHaveLength(0);
    expect(scanText('bind 0.0.0.0')).toHaveLength(0);
  });

  it('ignores a browser user-agent version that looks like an address', () => {
    expect(scanText('Chrome/124.0.0.0 Safari/537.36')).toHaveLength(0);
  });

  it('flags a GitHub token', () => {
    const hits = scanText('token=' + GH_TOKEN);
    expect(hits.map((h) => h.rule)).toContain('github-token');
  });

  it('flags an AWS access key id', () => {
    const hits = scanText('key: ' + AWS_KEY);
    expect(hits.map((h) => h.rule)).toContain('aws-access-key');
  });

  it('flags a home path that leaks a user name', () => {
    const hits = scanText('cd ' + WIN_PATH);
    expect(hits.map((h) => h.rule)).toContain('home-path');
  });

  it('ignores generic home path segments', () => {
    expect(scanText('C:' + BS + 'Users' + BS + 'Public')).toHaveLength(0);
    expect(scanText('/home/me/project')).toHaveLength(0);
    expect(scanText('/Users/example/app')).toHaveLength(0);
  });

  it('flags a real email address but not reserved domains', () => {
    const hits = scanText('contact ' + REAL_EMAIL);
    expect(hits.map((h) => h.rule)).toContain('email-address');
    expect(scanText('mail dev@example.com')).toHaveLength(0);
    expect(scanText('from workbuddy@local')).toHaveLength(0);
  });

  it('flags a private key with real-looking material', () => {
    const text = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + KEY_BODY + '\n-----END OPENSSH PRIVATE KEY-----';
    const hits = scanText(text);
    expect(hits.map((h) => h.rule)).toContain('private-key');
  });

  it('ignores an obviously fake key body', () => {
    const text = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----';
    expect(scanText(text)).toHaveLength(0);
  });

  it('ignores placeholder credentials in fixtures', () => {
    expect(scanText("token: 'test-token'")).toHaveLength(0);
    expect(scanText("token: 'ssh-token'")).toHaveLength(0);
    expect(scanText("password: 'changeme'")).toHaveLength(0);
    expect(scanText("apiKey = 'your-api-key'")).toHaveLength(0);
  });

  it('flags a hard-coded credential that is not a placeholder', () => {
    // Built at runtime so the repo itself stays clean for the scanner.
    const notAPlaceholder = 'hunter2' + 'hunter2';
    const hits = scanText("password: '" + notAPlaceholder + "'");
    expect(hits.map((h) => h.rule)).toContain('assigned-secret');
  });

  it('matches deny-list terms case-insensitively', () => {
    const hits = scanText('connect to My-Alias now', { denylist: ['my-alias'] });
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe('denylist');
    expect(hits[0].column).toBe(12);
  });

  it('reports the correct line number', () => {
    const hits = scanText('line one\nline two\nHostName ' + PUBLIC_IP);
    expect(hits[0].line).toBe(3);
  });

  it('masks values in the middle', () => {
    expect(mask(PUBLIC_IP)).toBe('93.' + '***' + '34');
    expect(mask('abc')).toBe('***');
  });

  it('classifies reserved ranges', () => {
    expect(isReservedIp([10, 0, 0, 1])).toBe(true);
    expect(isReservedIp([172, 20, 0, 1])).toBe(true);
    expect(isReservedIp([8, 8, 8, 8])).toBe(false);
  });

  it('recognises placeholder values', () => {
    expect(isPlaceholder('test-token')).toBe(true);
    expect(isPlaceholder('******')).toBe(true);
    expect(isPlaceholder('hunter2hunter2')).toBe(false);
  });
});
