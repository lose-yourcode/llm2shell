const path = require('path');
const { parseSshConfig, resolveHost, resolveFromBlocks, expandHome } = require('../src/bridge/sshConfig');

const SAMPLE = `
Host myserver
  HostName 203.0.113.10
  User deploy
  Port 2222
  IdentityFile ~/.ssh/myserver_ed25519

Host work-??
  HostName work.example.com
  User deploy

Host bastioned
  HostName 10.0.0.5
  ProxyJump jump.example.com

# Defaults last: OpenSSH takes the FIRST value found, so a "Host *" block at the
# top would override every specific block below it.
Host *
  ServerAliveInterval 30
  User defaultuser
`;

describe('sshConfig', () => {
  it('parses blocks in order', () => {
    const blocks = parseSshConfig(SAMPLE);
    expect(blocks[0].patterns).toEqual(['myserver']);
    expect(blocks[0].options.hostname).toBe('203.0.113.10');
    expect(blocks[blocks.length - 1].patterns).toEqual(['*']);
  });

  it('resolves an alias to host, user, port and key', () => {
    const r = resolveFromBlocks(parseSshConfig(SAMPLE), 'myserver', '/home/me');
    expect(r.host).toBe('203.0.113.10');
    expect(r.username).toBe('deploy');
    expect(r.port).toBe(2222);
    expect(r.identityFile).toBe(path.join('/home/me', '.ssh', 'myserver_ed25519'));
  });

  it('falls back to global * options for unlisted aliases', () => {
    const r = resolveFromBlocks(parseSshConfig(SAMPLE), 'unknown-host', '/home/me');
    expect(r).toBeTruthy();
    expect(r.host).toBe('unknown-host');
    expect(r.username).toBe('defaultuser');
    expect(r.port).toBe(22);
  });

  it('matches ? and * wildcards', () => {
    const r = resolveFromBlocks(parseSshConfig(SAMPLE), 'work-01', '/home/me');
    expect(r.host).toBe('work.example.com');
    expect(r.username).toBe('deploy');
  });

  it('exposes ProxyJump so the caller can refuse it', () => {
    const r = resolveFromBlocks(parseSshConfig(SAMPLE), 'bastioned', '/home/me');
    expect(r.proxyJump).toBe('jump.example.com');
  });

  it('returns null when the config file is missing', () => {
    const r = resolveHost('myserver', { readFile: () => { throw new Error('ENOENT'); } });
    expect(r).toBeNull();
  });

  it('reads through an injected reader', () => {
    const r = resolveHost('myserver', { readFile: () => SAMPLE, home: '/home/me' });
    expect(r.host).toBe('203.0.113.10');
  });

  it('expands ~ in key paths', () => {
    expect(expandHome('~/.ssh/id_rsa', '/home/me')).toBe(path.join('/home/me', '.ssh', 'id_rsa'));
    expect(expandHome('/abs/key', '/home/me')).toBe('/abs/key');
  });
});
