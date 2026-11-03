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
});
