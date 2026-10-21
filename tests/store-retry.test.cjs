'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { Engine, initialState, validState } = require('../core/engine.cjs');

function fixture(t, platform = 'win32') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-store-retry-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('guanlan-store-retry-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // Exercise the real Store on all test hosts, replacing only the platform and
  // delay primitive. All writes and renames use an isolated real filesystem.
  const filename = path.join(__dirname, '../core/store.cjs'), waits = [], module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: createRequire(filename), module, process: { platform }, Int32Array, SharedArrayBuffer,
    Atomics: { wait: (_array, _index, _value, milliseconds) => { waits.push(milliseconds); return 'timed-out'; } }
  }, { filename });
  const store = new module.exports.Store(directory), engine = new Engine(initialState());
  store.save(engine.s);
  engine.s.settings.refreshSeconds = 11; store.save(engine.s);
  return { store, engine, directory, waits, primary: fs.readFileSync(store.file), backup: fs.readFileSync(store.file + '.bak') };
}
function patch(t, methods) { for (const [name, wrap] of Object.entries(methods)) t.mock.method(fs, name, wrap(fs[name])); }
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const failure = (code, from, to) => Object.assign(Error(`${code}: injected rename failure`), { code, syscall: 'rename', path: from, dest: to });

test('Windows transient rename errors retry the same staged state without rewriting or duplicating the backup', t => {
  const f = fixture(t), codes = ['EPERM', 'EACCES', 'EBUSY'];
  f.engine.s.settings.refreshSeconds = 12;
  let renames = 0, writes = 0, copies = 0, syncs = 0, deletes = 0;
  patch(t, {
    writeFileSync: original => (...args) => { writes++; return original(...args); },
    copyFileSync: original => (...args) => { copies++; return original(...args); },
    fsyncSync: original => (...args) => { syncs++; return original(...args); },
    unlinkSync: original => (...args) => { deletes++; return original(...args); },
    renameSync: original => (from, to) => {
      renames++; assert.equal(from, f.store.file + '.tmp'); assert.equal(to, f.store.file);
      assert.ok(fs.readFileSync(to).equals(f.primary), 'committed account remains until the atomic replacement');
      assert.ok(fs.readFileSync(to + '.bak').equals(f.primary), 'backup is the preceding committed state');
      assert.equal(read(from).settings.refreshSeconds, 12);
      if (renames <= codes.length) throw failure(codes[renames - 1], from, to);
      return original(from, to);
    }
  });
  f.store.save(f.engine.s);
  assert.deepEqual(f.waits, [50, 100, 200]);
  assert.deepEqual({ renames, writes, copies, syncs, deletes }, { renames: 4, writes: 1, copies: 1, syncs: 1, deletes: 0 });
  assert.deepEqual(read(f.store.file), f.engine.s); assert.ok(validState(read(f.store.file)));
  assert.ok(fs.readFileSync(f.store.file + '.bak').equals(f.primary));
  assert.equal(fs.existsSync(f.store.file + '.tmp'), false);
});

test('persistent Windows lock exhausts a bounded retry budget and preserves the original error, account and backup', t => {
  const f = fixture(t); f.engine.s.settings.refreshSeconds = 12;
  let renames = 0, lastError;
  patch(t, { renameSync: () => (from, to) => { renames++; throw (lastError = failure('EPERM', from, to)); } });
  assert.throws(() => f.store.save(f.engine.s), error => error === lastError && error.code === 'EPERM' && error.dest === f.store.file);
  assert.equal(renames, 5); assert.deepEqual(f.waits, [50, 100, 200, 400]);
  assert.equal(f.waits.reduce((sum, ms) => sum + ms, 0), 750);
  assert.ok(fs.readFileSync(f.store.file).equals(f.primary));
  assert.ok(fs.readFileSync(f.store.file + '.bak').equals(f.primary));
  assert.deepEqual(read(f.store.file + '.tmp'), f.engine.s);
  assert.equal(f.store.validatedFile, null); assert.equal(f.store.validatedVersion, null);
});

test('non-lock errors and non-Windows permission errors fail immediately', t => {
  for (const [platform, code] of [['win32', 'ENOSPC'], ['win32', 'EIO'], ['win32', 'ENOENT'], ['linux', 'EPERM']]) {
    const f = fixture(t, platform); f.engine.s.settings.refreshSeconds = 12;
    let renames = 0;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => { renames++; throw failure(code, from, to); });
    assert.throws(() => f.store.save(f.engine.s), error => error.code === code);
    assert.equal(renames, 1); assert.deepEqual(f.waits, []);
    assert.ok(fs.readFileSync(f.store.file).equals(f.primary));
    mock.mock.restore();
  }
});

test('upgrade retries backup and primary replacement without repeating the capital addition or archive', t => {
  const f = fixture(t); f.engine.addCapital({ amount: 1000000, requestId: 'retry-upgrade' });
  const calls = new Map();
  patch(t, { renameSync: original => (from, to) => {
    const count = (calls.get(to) || 0) + 1; calls.set(to, count);
    if (count === 1) throw failure('EACCES', from, to);
    return original(from, to);
  } });
  f.store.save(f.engine.s);
  assert.deepEqual(f.waits, [50, 50]);
  assert.equal(calls.get(f.store.file), 2); assert.equal(calls.get(f.store.file + '.bak'), 2);
  assert.deepEqual(read(f.store.file), f.engine.s); assert.deepEqual(read(f.store.file + '.bak'), f.engine.s);
  assert.equal(read(f.store.file).capitalFlows.length, 1);
  assert.equal(fs.readdirSync(f.directory).filter(name => name.startsWith('account-before-v2-')).length, 1);
});

test('upgrade lock exhaustion at either rename preserves the pre-upgrade account and restores its original backup', t => {
  for (const suffix of ['.bak', '']) {
    const f = fixture(t); f.engine.addCapital({ amount: 1000000, requestId: 'failed-retry-upgrade' });
    let blocked = 0;
    const original = fs.renameSync, mock = t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === f.store.file + suffix) { blocked++; throw failure('EBUSY', from, to); }
      return original(from, to);
    });
    assert.throws(() => f.store.save(f.engine.s), error => error.code === 'EBUSY');
    assert.equal(blocked, 5); assert.deepEqual(f.waits, [50, 100, 200, 400]);
    assert.ok(fs.readFileSync(f.store.file).equals(f.primary));
    assert.ok(fs.readFileSync(f.store.file + '.bak').equals(f.backup));
    assert.equal(read(f.store.file).version, 1); assert.equal(read(f.store.file + '.bak').version, 1);
    const files = fs.readdirSync(f.directory);
    assert.equal(files.filter(name => name.startsWith('account-before-v2-')).length, 1);
    assert.ok(!files.some(name => name.includes('.upgrade-') || name.includes('.rollback-')));
    mock.mock.restore();
  }
});
