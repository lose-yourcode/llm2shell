const path = require('path');
const SessionStore = require('../src/bridge/sessionStore');

describe('SessionStore', () => {
  it('always creates a default session', () => {
    const store = new SessionStore({ cwd: process.cwd() });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('sess-1');
    expect(list[0].name).toBe('default');
  });

  it('creates, gets, lists and kills sessions', () => {
    const store = new SessionStore({ cwd: process.cwd() });
    const s2 = store.create('work', process.cwd());
    expect(store.list()).toHaveLength(2);
    expect(store.get(s2.id).name).toBe('work');
    expect(store.kill(s2.id)).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.kill('nope')).toBe(false);
  });

  it('supports at least three independent sessions', () => {
    const store = new SessionStore({ cwd: process.cwd() });
    store.create('two', process.cwd());
    store.create('three', process.cwd());
    expect(store.list().length).toBeGreaterThanOrEqual(3);
    const ids = store.list().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolveCwd returns the session cwd', () => {
    const store = new SessionStore({ cwd: process.cwd() });
    const id = store.list()[0].id;
    expect(store.resolveCwd(id)).toBe(process.cwd());
  });

  it('applyCd updates cwd for an existing directory', () => {
    const store = new SessionStore({ cwd: process.cwd() });
    const id = store.list()[0].id;
    const target = process.cwd();
    expect(store.applyCd(id, 'cd "' + target + '"')).toBe(true);
    expect(store.resolveCwd(id)).toBe(path.normalize(target));
  });

  it('applyCd ignores non-existent directories', () => {
    const store = new SessionStore({ cwd: process.cwd() });
    const id = store.list()[0].id;
    const before = store.resolveCwd(id);
    expect(store.applyCd(id, 'cd Z:\\definitely\\not\\here\\xyz')).toBe(false);
    expect(store.resolveCwd(id)).toBe(before);
  });

  it('applyCd ignores compound commands', () => {
    const store = new SessionStore({ cwd: process.cwd() });
    const id = store.list()[0].id;
    expect(store.applyCd(id, 'cd foo && dir')).toBe(false);
    expect(store.applyCd(id, 'echo hi')).toBe(false);
  });

  it('creates, connects and executes a persistent SSH session', async () => {
    const calls = [];
    const fakeSsh = {
      connect: async () => { calls.push('connect'); },
      exec: async (cmd, opts) => {
        calls.push(['exec', cmd, opts]);
        return { exitCode: 0, stdout: 'ssh-ok', stderr: '' };
      },
      close: () => { calls.push('close'); }
    };

    const store = new SessionStore({
      cwd: process.cwd(),
      sshFactory: () => fakeSsh,
      sshConfigResolver: () => null
    });
    const s = store.createSSH({ host: 'example.com', username: 'root', password: 'secret' });
    expect(s.type).toBe('ssh');
    expect(s.status).toBe('disconnected');

    await store.connect(s.id);
    expect(s.status).toBe('connected');

    const res = await store.execSSH(s.id, 'echo hi');
    expect(res.stdout).toBe('ssh-ok');

    const info = store.publicInfo(s.id);
    expect(info.host).toBe('example.com');
    expect(info.password).toBeUndefined();
    expect(info.status).toBe('connected');

    store.kill(s.id);
    expect(calls).toContain('close');
  });

  it('resolves an ~/.ssh/config alias into host, user, port and key', () => {
    const seen = [];
    const store = new SessionStore({
      cwd: process.cwd(),
      sshFactory: (cfg) => { seen.push(cfg); return { connect: async () => {}, close: () => {} }; },
      sshConfigResolver: (alias) =>
        alias === 'myserver'
          ? {
              alias: 'myserver',
              host: '203.0.113.10',
              port: 2222,
              username: 'deploy',
              identityFile: null
            }
          : null
    });

    const s = store.createSSH({ host: 'myserver' });
    expect(s.host).toBe('203.0.113.10');
    expect(s.port).toBe(2222);
    expect(s.username).toBe('deploy');
    expect(s.alias).toBe('myserver');
    expect(seen[0].host).toBe('203.0.113.10');
  });

  it('keeps explicit values over the alias defaults', () => {
    const store = new SessionStore({
      cwd: process.cwd(),
      sshFactory: () => ({ connect: async () => {}, close: () => {} }),
      sshConfigResolver: () => ({ host: 'real-host', port: 22, username: 'from-config' })
    });
    const s = store.createSSH({ host: 'alias', username: 'explicit', port: 2200 });
    expect(s.host).toBe('real-host');
    expect(s.username).toBe('explicit');
    expect(s.port).toBe(2200);
  });

  it('rejects an alias that needs a jump host', () => {
    const store = new SessionStore({
      cwd: process.cwd(),
      sshFactory: () => ({ connect: async () => {}, close: () => {} }),
      sshConfigResolver: () => ({ host: 'internal', port: 22, username: 'me', proxyJump: 'bastion' })
    });
    expect(() => store.createSSH({ host: 'internal' })).toThrow(/ProxyJump/);
  });

  it('loads a private key file when one is given', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const keyPath = path.join(os.tmpdir(), 'awt-test-key-' + Date.now());
    fs.writeFileSync(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n', 'utf8');

    let cfgSeen = null;
    const store = new SessionStore({
      cwd: process.cwd(),
      sshFactory: (cfg) => { cfgSeen = cfg; return { connect: async () => {}, close: () => {} }; },
      sshConfigResolver: () => null
    });
    store.createSSH({ host: 'h', username: 'u', identityFile: keyPath });
    expect(Buffer.isBuffer(cfgSeen.privateKey)).toBe(true);
    expect(cfgSeen.privateKey.toString()).toContain('BEGIN OPENSSH PRIVATE KEY');

    try { fs.unlinkSync(keyPath); } catch (_) {}
  });

  it('reports a readable error for a missing key file', () => {
    const store = new SessionStore({
      cwd: process.cwd(),
      sshFactory: () => ({ connect: async () => {}, close: () => {} }),
      sshConfigResolver: () => null
    });
    expect(() => store.createSSH({ host: 'h', username: 'u', identityFile: '/nope/id_rsa' })).toThrow(
      /Cannot read SSH key/
    );
  });
});
