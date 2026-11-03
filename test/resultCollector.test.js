const ResultCollector = require('../src/bridge/resultCollector');

describe('ResultCollector', () => {
  it('creates a record with the F06 schema', () => {
    const rc = new ResultCollector();
    const rec = rc.create({ sessionId: 'local-1', command: 'echo hi', lang: 'bash' });
    expect(rec.commandId).toMatch(/^cmd_/);
    expect(rec.sessionId).toBe('local-1');
    expect(rec.command).toBe('echo hi');
    expect(rec.status).toBe('pending');
    expect(rec.stdout).toBe('');
    expect(rec.stderr).toBe('');
    expect(rec.exitCode).toBeNull();
    expect(rec.startTime).toBeTruthy();
    expect(rec.endTime).toBeNull();
  });

  it('updates status and sets endTime on terminal states', () => {
    const rc = new ResultCollector();
    const rec = rc.create({ sessionId: 's1', command: 'x' });
    const running = rc.update(rec.commandId, { status: 'running' });
    expect(running.endTime).toBeNull();
    const done = rc.update(rec.commandId, { status: 'success', exitCode: 0, stdout: 'ok' });
    expect(done.status).toBe('success');
    expect(done.exitCode).toBe(0);
    expect(done.endTime).toBeTruthy();
  });

  it('appends stdout/stderr separately', () => {
    const rc = new ResultCollector();
    const rec = rc.create({ sessionId: 's1', command: 'x' });
    rc.appendOutput(rec.commandId, 'stdout', 'a');
    rc.appendOutput(rec.commandId, 'stdout', 'b');
    rc.appendOutput(rec.commandId, 'stderr', 'e');
    const r = rc.get(rec.commandId);
    expect(r.stdout).toBe('ab');
    expect(r.stderr).toBe('e');
  });

  it('filters by sessionId', () => {
    const rc = new ResultCollector();
    rc.create({ sessionId: 'a', command: '1' });
    rc.create({ sessionId: 'b', command: '2' });
    rc.create({ sessionId: 'a', command: '3' });
    expect(rc.list({ sessionId: 'a' })).toHaveLength(2);
    expect(rc.list()).toHaveLength(3);
  });

  it('returns null for unknown ids', () => {
    const rc = new ResultCollector();
    expect(rc.get('nope')).toBeNull();
    expect(rc.update('nope', {})).toBeNull();
    expect(rc.appendOutput('nope', 'stdout', 'x')).toBe(false);
  });
});
