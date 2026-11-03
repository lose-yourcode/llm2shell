const SshSession = require('../src/bridge/sshSession');

function makeFakeSsh({ stdout = 'out', stderr = 'err', exitCode = 0 } = {}) {
  const state = { connectCfg: null, execs: [], ended: false };

  class FakeClient {
    constructor() {
      this.handlers = {};
    }
    on(ev, cb) {
      (this.handlers[ev] = this.handlers[ev] || []).push(cb);
      return this;
    }
    connect(cfg) {
      state.connectCfg = cfg;
      setTimeout(() => (this.handlers.ready || []).forEach((f) => f()), 0);
    }
    exec(cmd, opts, cb) {
      state.execs.push({ cmd, opts });
      const stream = {
        stdout: { on: () => {} },
        stderr: {
          on: (ev, f) => {
            if (ev === 'data') setTimeout(() => f(Buffer.from(stderr)), 0);
          }
        },
        on: (ev, f) => {
          if (ev === 'data') setTimeout(() => f(Buffer.from(stdout)), 0);
          if (ev === 'close') setTimeout(() => f(exitCode), 10);
        },
        close: () => {}
      };
      setTimeout(() => cb(null, stream), 0);
    }
    end() {
      state.ended = true;
    }
  }

  return { sshModule: { Client: FakeClient }, state };
}

describe('SshSession (persistent connection)', () => {
  it('connects and stays connected', async () => {
    const fake = makeFakeSsh();
    const s = new SshSession({ host: 'example.com', username: 'root' }, { ssh: fake.sshModule });
    await s.connect();
    expect(s.connected).toBe(true);
    expect(fake.state.connectCfg.host).toBe('example.com');
    expect(fake.state.connectCfg.username).toBe('root');
  });

  it('exec captures stdout, stderr and the exact exit code', async () => {
    const fake = makeFakeSsh({ stdout: 'hello', stderr: 'oops', exitCode: 3 });
    const s = new SshSession({ host: 'h', username: 'u' }, { ssh: fake.sshModule });
    await s.connect();
    const chunks = [];
    const res = await s.exec('ls', { onData: (d, stream) => chunks.push([stream, d]) });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe('hello');
    expect(res.stderr).toBe('oops');
    expect(chunks.some(([stream]) => stream === 'stdout')).toBe(true);
    expect(chunks.some(([stream]) => stream === 'stderr')).toBe(true);
  });

  it('prefixes the tracked cwd so it persists across commands', async () => {
    const fake = makeFakeSsh();
    const s = new SshSession({ host: 'h', username: 'u' }, { ssh: fake.sshModule });
    await s.connect();
    await s.exec('pwd', { cwd: '/tmp' });
    expect(fake.state.execs[0].cmd).toContain("cd '/tmp' &&");
    expect(fake.state.execs[0].opts).toEqual({ pty: false });
  });

  it('rejects when not connected', async () => {
    const s = new SshSession({ host: 'h', username: 'u' }, { ssh: makeFakeSsh().sshModule });
    await expect(s.exec('ls')).rejects.toThrow(/not connected/i);
  });

  it('closes the underlying client', async () => {
    const fake = makeFakeSsh();
    const s = new SshSession({ host: 'h', username: 'u' }, { ssh: fake.sshModule });
    await s.connect();
    s.close();
    expect(fake.state.ended).toBe(true);
    expect(s.connected).toBe(false);
  });
});
