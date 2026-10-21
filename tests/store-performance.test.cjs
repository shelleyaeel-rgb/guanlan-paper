'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-store-performance-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('guanlan-store-performance-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return new Store(directory);
}
function state(refreshSeconds) {
  const value = initialState(); value.settings.refreshSeconds = refreshSeconds; return value;
}
function patch(methods, work) {
  const originals = Object.fromEntries(Object.keys(methods).map(name => [name, fs[name]]));
  for (const [name, wrap] of Object.entries(methods)) fs[name] = wrap(originals[name]);
  try { return work(); } finally { Object.assign(fs, originals); }
}
function countPrimaryReads(store, work) {
  let reads = 0;
  patch({ readFileSync: original => (file, ...args) => { if (file === store.file) reads++; return original(file, ...args); } }, work);
  return reads;
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('unchanged committed files skip full rereads while preserving fsync, backup and atomic replacement', t => {
  const store = fixture(t), first = state(10), second = state(11), third = state(12);
  fs.writeFileSync(store.file, JSON.stringify(first));
  assert.equal(countPrimaryReads(store, () => store.save(second)), 1, 'first save verifies the existing file');
  assert.deepEqual(read(store.file + '.bak'), first);
  const operations = [];
  const reads = countPrimaryReads(store, () => patch({
    fsyncSync: original => fd => { operations.push('fsync'); return original(fd); },
    copyFileSync: original => (...args) => { operations.push('backup'); return original(...args); },
    renameSync: original => (...args) => { operations.push('rename'); return original(...args); }
  }, () => store.save(third)));
  assert.equal(reads, 0); assert.deepEqual(operations, ['fsync', 'backup', 'rename']);
  assert.deepEqual(read(store.file), third); assert.deepEqual(read(store.file + '.bak'), second);
  assert.deepEqual(new Store(path.dirname(store.file)).load(), third);
});

test('a restarted store verifies the disk file before using it as backup', t => {
  const store = fixture(t); store.save(state(10));
  const restarted = new Store(path.dirname(store.file));
  restarted.load();
  assert.equal(countPrimaryReads(restarted, () => restarted.save(state(11))), 1);
});

test('external valid changes are revalidated and preserved as the preceding backup', t => {
  const store = fixture(t), external = state(12);
  store.save(state(10)); store.save(state(11));
  const replacement = store.file + '.external';
  fs.writeFileSync(replacement, JSON.stringify(external)); fs.renameSync(replacement, store.file);
  assert.equal(countPrimaryReads(store, () => store.save(state(13))), 1);
  assert.deepEqual(read(store.file + '.bak'), external);
});

test('same-length corruption with restored mtime is caught by ctime and cannot replace a good backup', t => {
  const store = fixture(t), first = state(10);
  store.save(first); store.save(state(11));
  const before = fs.statSync(store.file, { bigint: true }), content = fs.readFileSync(store.file, 'utf8');
  fs.writeFileSync(store.file, '!' + content.slice(1));
  // Model an editor restoring mtime exactly, including nanoseconds; ctime must
  // still participate in identity even when size, inode and mtime all match.
  const reads = countPrimaryReads(store, () => patch({ statSync: original => (file, options) => {
    const value = original(file, options);
    if (file === store.file && options?.bigint) { value.mtimeNs = before.mtimeNs; value.ctimeNs = before.ctimeNs + 1n; }
    return value;
  } }, () => store.save(state(12))));
  assert.equal(reads, 1); assert.deepEqual(read(store.file + '.bak'), first); assert.equal(validState(read(store.file)), true);
});

test('corrupt primary recovery retains the good backup and never trusts the damaged file', t => {
  const store = fixture(t), first = state(10);
  store.save(first); store.save(state(11)); fs.writeFileSync(store.file, 'broken');
  const recovered = store.load(); assert.deepEqual(recovered, first); assert.match(store.warning, /恢复/);
  assert.equal(countPrimaryReads(store, () => store.save(recovered)), 1);
  assert.deepEqual(read(store.file + '.bak'), first); assert.deepEqual(read(store.file), first);
  assert.ok(fs.readdirSync(path.dirname(store.file)).some(name => name.startsWith('account.json.corrupt-')));
});

test('fsync failure preserves committed account and backup, closes the file and forces revalidation on retry', t => {
  const store = fixture(t), first = state(10), second = state(11), third = state(12);
  store.save(first); store.save(second); let closes = 0;
  patch({ fsyncSync: () => () => { throw Error('simulated fsync failure'); },
    closeSync: original => fd => { closes++; return original(fd); }
  }, () => assert.throws(() => store.save(third), /simulated fsync failure/));
  assert.equal(closes, 1); assert.deepEqual(read(store.file), second); assert.deepEqual(read(store.file + '.bak'), first);
  assert.equal(countPrimaryReads(store, () => store.save(third)), 1);
  assert.deepEqual(read(store.file), third); assert.deepEqual(read(store.file + '.bak'), second);
});

test('rename failure keeps the old account and a valid backup and forces revalidation on retry', t => {
  const store = fixture(t), second = state(11), third = state(12);
  store.save(state(10)); store.save(second);
  patch({ renameSync: () => () => { throw Error('simulated rename failure'); } },
    () => assert.throws(() => store.save(third), /simulated rename failure/));
  assert.deepEqual(read(store.file), second); assert.deepEqual(read(store.file + '.bak'), second);
  assert.equal(countPrimaryReads(store, () => store.save(third)), 1); assert.deepEqual(read(store.file), third);
});

test('post-commit stat failure disables reuse without reporting a successful save as failed', t => {
  const store = fixture(t), first = state(10);
  patch({ statSync: () => () => { throw Error('simulated stat failure'); } }, () => store.save(first));
  assert.deepEqual(read(store.file), first);
  assert.equal(countPrimaryReads(store, () => store.save(state(11))), 1);
});

test('invalid new state is rejected even when the existing file is trusted', t => {
  const store = fixture(t), first = state(10); store.save(first);
  assert.throws(() => store.save({ ...first, cash: -1 }), /拒绝保存无效账户/);
  assert.deepEqual(read(store.file), first);
});
