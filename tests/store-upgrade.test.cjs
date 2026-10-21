'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');

function fixture(t, { backup = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-store-upgrade-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('guanlan-store-upgrade-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const store = new Store(directory), engine = new Engine(initialState(1000000));
  store.save(engine.s);
  if (backup) { engine.s.settings.refreshSeconds = 11; store.save(engine.s); }
  const original = fs.readFileSync(store.file, 'utf8');
  const originalBackup = backup ? fs.readFileSync(store.file + '.bak', 'utf8') : null;
  engine.addCapital({ amount: 1000000, requestId: 'upgrade-capital' });
  return { store, engine, directory, original, originalBackup };
}
function patch(methods, work) {
  const originals = Object.fromEntries(Object.keys(methods).map(name => [name, fs[name]]));
  for (const [name, wrap] of Object.entries(methods)) fs[name] = wrap(originals[name]);
  try { return work(); } finally { Object.assign(fs, originals); }
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const archives = f => fs.readdirSync(f.directory).filter(name => /^account-before-v2-.*\.json$/.test(name));

test('首次升级先将自动备份写为v2，独立归档原始v1字节，旧程序无法回退成入金前账户', t => {
  const f = fixture(t); let checked = false;
  patch({ renameSync: original => (from, to) => {
    if (to === f.store.file) {
      assert.equal(read(f.store.file).version, 1);
      assert.equal(read(f.store.file + '.bak').version, 2);
      assert.equal(read(f.store.file + '.bak').capitalFlows[0].amount, 100000000);
      checked = true;
    }
    return original(from, to);
  } }, () => f.store.save(f.engine.s));
  assert.equal(checked, true); assert.deepEqual(read(f.store.file), f.engine.s);
  assert.deepEqual(read(f.store.file + '.bak'), f.engine.s);
  const saved = archives(f); assert.equal(saved.length, 1);
  assert.equal(fs.readFileSync(path.join(f.directory, saved[0]), 'utf8'), f.original);
  assert.equal(new Store(f.directory).load().capitalFlows.length, 1);
  // Model the old loader's primary-then-.bak selection: neither is v1.
  assert.equal([f.store.file, f.store.file + '.bak'].map(read).find(state => state.version === 1), undefined);
  assert.ok(validState(read(f.store.file)));
});

test('升级写盘各阶段失败均不提交主账户或留下可恢复的新资金流，随后可安全重试', t => {
  for (const stage of ['tmp-fsync', 'archive-fsync', 'backup-fsync', 'archive-copy', 'backup-rename', 'primary-rename']) {
    const f = fixture(t); let syncCount = 0;
    const failure = () => { throw Error(`injected ${stage}`); };
    const methods = {
      fsyncSync: original => fd => {
        syncCount++;
        if (syncCount === { 'tmp-fsync': 1, 'archive-fsync': 2, 'backup-fsync': 3 }[stage]) failure();
        return original(fd);
      },
      copyFileSync: original => (from, to, ...args) => {
        if (stage === 'archive-copy' && path.basename(to).startsWith('account-before-v2-')) failure();
        return original(from, to, ...args);
      },
      renameSync: original => (from, to) => {
        if (stage === 'backup-rename' && to === f.store.file + '.bak' || stage === 'primary-rename' && to === f.store.file) failure();
        return original(from, to);
      }
    };
    patch(methods, () => assert.throws(() => f.store.save(f.engine.s), /injected/, stage));
    assert.equal(fs.readFileSync(f.store.file, 'utf8'), f.original, stage);
    assert.equal(fs.readFileSync(f.store.file + '.bak', 'utf8'), f.originalBackup, stage);
    assert.equal(new Store(f.directory).load().version, 1, stage);
    f.store.save(f.engine.s);
    assert.deepEqual(read(f.store.file), f.engine.s, stage);
    assert.deepEqual(read(f.store.file + '.bak'), f.engine.s, stage);
  }
});

test('没有旧自动备份时升级提交失败移除准备态备份，原主文件和独立归档保留', t => {
  const f = fixture(t, { backup: false });
  patch({ renameSync: original => (from, to) => {
    if (to === f.store.file) throw Error('primary commit failed');
    return original(from, to);
  } }, () => assert.throws(() => f.store.save(f.engine.s), /primary commit failed/));
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), f.original);
  assert.equal(fs.existsSync(f.store.file + '.bak'), false);
  assert.equal(archives(f).length, 1);
  f.store.save(f.engine.s); assert.deepEqual(read(f.store.file + '.bak'), f.engine.s);
  assert.equal(archives(f).length, 2, '重试生成唯一归档，不覆盖第一次原始文件');
});

test('损坏主文件从v1自动备份恢复后升级，自动备份同样不会留成v1', t => {
  const f = fixture(t), originalRecovery = f.originalBackup;
  fs.writeFileSync(f.store.file, 'broken');
  const recovered = new Engine(new Store(f.directory).load());
  recovered.addCapital({ amount: 1000000, requestId: 'recovered-upgrade' });
  f.store.save(recovered.s);
  assert.deepEqual(read(f.store.file), recovered.s); assert.deepEqual(read(f.store.file + '.bak'), recovered.s);
  assert.equal(fs.readFileSync(path.join(f.directory, archives(f)[0]), 'utf8'), originalRecovery);
});
