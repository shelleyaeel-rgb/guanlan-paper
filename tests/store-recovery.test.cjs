'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-store-recovery-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('guanlan-store-recovery-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store: new Store(directory) };
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('only a directory with neither primary nor automatic backup starts a new account', t => {
  const { store } = fixture(t);
  assert.equal(store.load(), null); assert.equal(store.warning, '');
});

test('missing primary recovers the valid backup and subsequent saves preserve account history', t => {
  const { store } = fixture(t), now = new Date('2026-09-30T10:00:00+08:00');
  const engine = new Engine(initialState(50000), () => now);
  engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 100 }, { symbol: 'sz000001', name: '恢复测试', price: 10,
    ask: 10, bid: 9.99, askSize: 1000, bidSize: 1000, open: 10, volume: 10000, limitUp: 11, limitDown: 9,
    timestamp: now.getTime(), date: '2026-09-30' });
  engine.place({ symbol: 'sz000002', side: 'buy', quantity: 100, limit: 9 });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const expected = structuredClone(engine.s), bytes = JSON.stringify(expected);
  fs.writeFileSync(store.file + '.bak', bytes);
  const loaded = store.load();
  assert.deepEqual(loaded, expected); assert.match(store.warning, /主文件缺失.*恢复/);
  assert.equal(fs.existsSync(store.file), false, 'load does not write or replace recovery sources');
  assert.equal(fs.readFileSync(store.file + '.bak', 'utf8'), bytes);
  // Main's existing warning path stops automatic groups before the first save.
  const restarted = new Engine(loaded, () => now);
  if (store.warning) for (const group of restarted.s.agency.groups) restarted.agencyMode({ strategyId: group.id, mode: 'stopped' });
  store.save(restarted.s); store.save(restarted.s);
  for (const file of [store.file, store.file + '.bak']) {
    const actual = read(file);
    for (const key of ['initialCash', 'cash', 'lots', 'trades', 'orders']) assert.deepEqual(actual[key], expected[key], key);
    assert.ok(actual.agency.groups.every(group => group.mode === 'stopped'));
  }
  assert.deepEqual(new Store(path.dirname(store.file)).load(), restarted.s);
});

test('missing primary with malformed or invalid backup fails without changing the recovery file', t => {
  for (const bytes of ['{ invalid', JSON.stringify({ ...initialState(50000), cash: -1 })]) {
    const { store } = fixture(t); fs.writeFileSync(store.file + '.bak', bytes);
    assert.throws(() => store.load(), /主文件缺失.*备份无法读取.*没有重置/);
    assert.equal(fs.existsSync(store.file), false);
    assert.equal(fs.readFileSync(store.file + '.bak', 'utf8'), bytes);
  }
});

test('missing primary uses the configured backup decoder before validation', t => {
  const { directory, store: files } = fixture(t), state = new Engine(initialState(50000)).s;
  fs.writeFileSync(files.file + '.bak', JSON.stringify({ recovery: state }));
  const store = new Store(directory, { decode: value => value.recovery });
  assert.deepEqual(store.load(), state); assert.match(store.warning, /恢复/);
});

test('failed first save after missing-primary recovery leaves the valid backup intact', t => {
  const { store } = fixture(t), bytes = JSON.stringify(new Engine(initialState(50000)).s);
  fs.writeFileSync(store.file + '.bak', bytes);
  const recovered = store.load(), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === store.file) throw Error('injected first recovery save failure');
    return rename(from, to);
  });
  assert.throws(() => store.save(recovered), /first recovery save failure/);
  assert.equal(fs.existsSync(store.file), false);
  assert.equal(fs.readFileSync(store.file + '.bak', 'utf8'), bytes);
  assert.deepEqual(new Store(path.dirname(store.file)).load(), recovered);
});

test('upgrading a missing-primary recovery protects the source and rolls back a failed commit', t => {
  const { store, directory } = fixture(t), original = new Engine(initialState(50000));
  const bytes = JSON.stringify(original.s); fs.writeFileSync(store.file + '.bak', bytes);
  const restored = new Engine(store.load()); restored.addCapital({ amount: 100, requestId: 'missing-primary-upgrade' });
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === store.file) throw Error('injected upgrade commit failure');
    return rename(from, to);
  });
  assert.throws(() => store.save(restored.s), /upgrade commit failure/);
  assert.equal(fs.existsSync(store.file), false);
  assert.equal(fs.readFileSync(store.file + '.bak', 'utf8'), bytes);
  mocked.mock.restore();
  store.save(restored.s);
  assert.deepEqual(read(store.file), restored.s); assert.deepEqual(read(store.file + '.bak'), restored.s);
  const archives = fs.readdirSync(directory).filter(name => name.startsWith('account-before-v2-'));
  assert.ok(archives.length);
  for (const name of archives) assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), bytes);
});
