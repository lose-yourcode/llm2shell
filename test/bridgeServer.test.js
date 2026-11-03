const WebSocket = require('ws');
const { createBridgeServer } = require('../bridge/server');
const SessionStore = require('../src/bridge/sessionStore');

const isWin = process.platform === 'win32';

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('open timeout')), 5000);
  });
}

function nextMessage(ws, predicate, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), timeoutMs);
    const onMessage = (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!predicate || predicate(m)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(m);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('Bridge server (WebSocket integration)', () => {
  let bridge;

  beforeAll(async () => {
    bridge = await createBridgeServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      sessions: new SessionStore({ cwd: process.cwd() })
    });
  });

  afterAll(async () => {
    if (bridge) await bridge.close();
  });

  it('rejects a wrong token', async () => {
    const ws = await open(`ws://127.0.0.1:${bridge.port}`);
    ws.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
    const m = await nextMessage(ws, (x) => x.type === 'auth.error' || x.type === 'closed');
    expect(['auth.error']).toContain(m.type);
    ws.close();
  });

  it('accepts the right token and lists sessions', async () => {
    const ws = await open(`ws://127.0.0.1:${bridge.port}`);
    ws.send(JSON.stringify({ type: 'hello', token: 'test-token' }));
    const hello = await nextMessage(ws, (x) => x.type === 'hello.ok');
    expect(hello.version).toBeTruthy();
    expect(Array.isArray(hello.sessions)).toBe(true);
    expect(hello.sessions.length).toBeGreaterThan(0);
    ws.close();
  });

  it('runs a command and streams output + a result', async () => {
    const ws = await open(`ws://127.0.0.1:${bridge.port}`);
    ws.send(JSON.stringify({ type: 'hello', token: 'test-token' }));
    await nextMessage(ws, (x) => x.type === 'hello.ok');

    const reqId = 'test-run-1';
    const command = isWin ? 'Write-Output "bridge-ok"' : 'echo bridge-ok';

    const outputs = [];
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'output' && m.reqId === reqId) outputs.push(m);
      } catch (_) {}
    });

    ws.send(JSON.stringify({ type: 'run', reqId, command }));
    const result = await nextMessage(ws, (x) => x.type === 'result' && x.reqId === reqId);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('bridge-ok');
    expect(result.status).toBe('success');
    expect(outputs.length).toBeGreaterThan(0);
    ws.close();
  }, 45000);

  it('reports a non-zero exit code', async () => {
    const ws = await open(`ws://127.0.0.1:${bridge.port}`);
    ws.send(JSON.stringify({ type: 'hello', token: 'test-token' }));
    await nextMessage(ws, (x) => x.type === 'hello.ok');

    const reqId = 'test-run-2';
    ws.send(JSON.stringify({ type: 'run', reqId, command: 'exit 5' }));
    const result = await nextMessage(ws, (x) => x.type === 'result' && x.reqId === reqId);
    expect(result.exitCode).toBe(5);
    expect(result.status).toBe('failed');
    ws.close();
  }, 45000);

  it('creates an SSH session and runs over the persistent connection', async () => {
    const fakeSsh = {
      connect: async () => {},
      exec: async () => ({ exitCode: 0, stdout: 'ssh-ok', stderr: '' }),
      close: () => {}
    };
    const store = new SessionStore({ cwd: process.cwd(), sshFactory: () => fakeSsh });
    const sshBridge = await createBridgeServer({
      host: '127.0.0.1',
      port: 0,
      token: 'ssh-token',
      sessions: store
    });

    const ws = await open(`ws://127.0.0.1:${sshBridge.port}`);
    ws.send(JSON.stringify({ type: 'hello', token: 'ssh-token' }));
    await nextMessage(ws, (x) => x.type === 'hello.ok');

    const createReq = 'ssh-create-1';
    ws.send(
      JSON.stringify({
        type: 'session.create',
        reqId: createReq,
        sessionType: 'ssh',
        host: 'example.com',
        username: 'root'
      })
    );
    const created = await nextMessage(
      ws,
      (x) => x.type === 'session.created' && x.reqId === createReq
    );
    expect(created.session.type).toBe('ssh');
    expect(created.session.host).toBe('example.com');
    expect(created.session.password).toBeUndefined();

    const runReq = 'ssh-run-1';
    ws.send(
      JSON.stringify({ type: 'run', reqId: runReq, sessionId: created.session.id, command: 'echo hi' })
    );
    const result = await nextMessage(ws, (x) => x.type === 'result' && x.reqId === runReq);
    expect(result.stdout).toBe('ssh-ok');
    expect(result.exitCode).toBe(0);

    ws.close();
    await sshBridge.close();
  }, 45000);
});
