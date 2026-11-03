'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { DailyHistoryStore, MAX_DAILY_HISTORY_BYTES } = require('../core/daily-history-store.cjs');

const KEY = 'stock:sh600000';
const entry = () => ({ fetchedAt: 1792638000000, source: '测试日线源', series: [{ date: '2026-10-21', open: 10, high: 11, low: 9, close: 10.5, volume: 1000 }] });
function fixture(t, Store = DailyHistoryStore) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-daily-history-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('guanlan-daily-history-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'daily-history');
  return { root, directory, store: new Store(directory), file: path.join(directory, 'stock-sh600000.json') };
}

test('日线按独立证券写入，重启可读且读取结果和入参不能改写缓存', t => {
  const f = fixture(t), input = entry();
  assert.equal(f.store.read(KEY), null);
  const account = path.join(f.root, 'account.json');
  fs.writeFileSync(account, 'isolated account sentinel');
  f.store.write(KEY, input);
  input.series[0].close = 999;
  const restarted = new DailyHistoryStore(f.directory), first = restarted.read(KEY);
  assert.deepEqual(first, entry());
  first.series[0].close = 888;
  assert.deepEqual(restarted.read(KEY), entry());
  const envelope = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(Object.keys(envelope), ['version', 'key', 'sha256', 'entry']);
  assert.equal(envelope.version, 1); assert.equal(envelope.key, KEY);
  assert.equal(envelope.sha256, createHash('sha256').update(JSON.stringify(entry())).digest('hex'));
  assert.equal(fs.readFileSync(account, 'utf8'), 'isolated account sentinel');
});

test('不同股票与指数互相隔离，删除仅影响指定键且可重复执行', t => {
  const f = fixture(t), otherKey = 'stock:sz000001', indexKey = 'index:sh600000';
  f.store.write(KEY, entry());
  f.store.write(otherKey, { ...entry(), source: '第二个证券' });
  f.store.write(indexKey, { ...entry(), source: '指数' });
  f.store.write(KEY, { ...entry(), source: '更新证券' });
  assert.equal(f.store.read(otherKey).source, '第二个证券');
  assert.equal(f.store.read(indexKey).source, '指数');
  f.store.delete(KEY); f.store.delete(KEY);
  assert.equal(f.store.read(KEY), null);
  assert.equal(f.store.read(otherKey).source, '第二个证券');
  assert.equal(f.store.read(indexKey).source, '指数');
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['index-sh600000.json', 'stock-sz000001.json']);
});

test('无效键在读写删除时均被拒绝且不能越过缓存目录', t => {
  const f = fixture(t);
  for (const key of ['../account', 'stock:sh600000/../../account', 'stock:SH600000', 'stock:sh600000\n', 'stock:sh6000000', 'stock:bj430001', 'account:sh600000', null, 600000]) {
    assert.throws(() => f.store.read(key), /缓存键无效/);
    assert.throws(() => f.store.write(key, entry()), /缓存键无效/);
    assert.throws(() => f.store.delete(key), /缓存键无效/);
  }
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('损坏 JSON、未知版本、错配身份和校验和失败不会被当成有效日线', t => {
  const f = fixture(t);
  f.store.write(KEY, entry());
  const good = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  const invalid = [
    '{"version":1,',
    'null',
    JSON.stringify({ ...good, version: 2 }),
    JSON.stringify({ ...good, key: 'stock:sz000001' }),
    JSON.stringify({ ...good, sha256: '0'.repeat(64) }),
    JSON.stringify({ ...good, entry: { ...entry(), source: '悄悄改写' } }),
    JSON.stringify({ version: 1, key: KEY, sha256: good.sha256 })
  ];
  for (const source of invalid) {
    fs.writeFileSync(f.file, source);
    assert.throws(() => new DailyHistoryStore(f.directory).read(KEY));
    assert.equal(fs.readFileSync(f.file, 'utf8'), source, '读取错误必须保留原文件供诊断');
  }
});

test('读写执行同一 UTF-8 大小上限，超大写入和不可序列化内容保留原值', t => {
  const f = fixture(t);
  f.store.write(KEY, entry());
  const original = fs.readFileSync(f.file);
  for (const value of [{ text: '中'.repeat(Math.ceil(MAX_DAILY_HISTORY_BYTES / 3)) }, undefined, 1n]) {
    assert.throws(() => f.store.write(KEY, value));
    assert.ok(fs.readFileSync(f.file).equals(original));
  }
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => f.store.write(KEY, cyclic));
  assert.ok(fs.readFileSync(f.file).equals(original));
  fs.writeFileSync(f.file, Buffer.alloc(MAX_DAILY_HISTORY_BYTES + 1, 32));
  assert.throws(() => f.store.read(KEY), /256 KiB/);
});

test('stat 后文件增大仍受实际读取上限保护', t => {
  const f = fixture(t);
  f.store.write(KEY, entry());
  const stat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', fd => {
    const result = stat(fd);
    fs.appendFileSync(f.file, ' '.repeat(MAX_DAILY_HISTORY_BYTES));
    return result;
  });
  assert.throws(() => f.store.read(KEY), /256 KiB/);
});

test('残留临时文件不会覆盖已提交缓存或被当成首次有效数据', t => {
  const f = fixture(t);
  f.store.write(KEY, entry());
  fs.writeFileSync(f.file + '.crash.tmp', '{"version":1,');
  fs.writeFileSync(path.join(f.directory, 'stock-sz000001.json.crash.tmp'), '{"version":1,');
  const restarted = new DailyHistoryStore(f.directory);
  assert.deepEqual(restarted.read(KEY), entry());
  assert.equal(restarted.read('stock:sz000001'), null);
});

test('部分写入、同步和原子替换失败都保留原值并清理本次临时文件', t => {
  const f = fixture(t);
  f.store.write(KEY, entry());
  const original = fs.readFileSync(f.file);
  for (const method of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const originalMethod = fs[method];
    const mocked = t.mock.method(fs, method, (...args) => {
      if (method === 'writeFileSync') originalMethod(args[0], '{"partial":', 'utf8');
      throw Object.assign(Error(`injected ${method} failure`), { code: 'EIO' });
    });
    assert.throws(() => f.store.write(KEY, { ...entry(), source: '新数据' }), new RegExp(`injected ${method}`));
    mocked.mock.restore();
    assert.ok(fs.readFileSync(f.file).equals(original));
    assert.deepEqual(f.store.read(KEY), entry());
    assert.deepEqual(fs.readdirSync(f.directory), ['stock-sh600000.json']);
  }
  f.store.write(KEY, { ...entry(), source: '恢复写入' });
  assert.equal(f.store.read(KEY).source, '恢复写入');
});

test('Windows 短暂占用仅重试原子替换，持续占用后仍保留旧值', t => {
  const filename = path.join(__dirname, '../core/daily-history-store.cjs'), waits = [], module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: createRequire(filename), module, Buffer, process: { platform: 'win32', pid: process.pid }, Int32Array, SharedArrayBuffer,
    Atomics: { wait: (_array, _index, _value, milliseconds) => { waits.push(milliseconds); } }
  }, { filename });
  const f = fixture(t, module.exports.DailyHistoryStore);
  f.store.write(KEY, entry());
  const rename = fs.renameSync; let calls = 0;
  const transient = t.mock.method(fs, 'renameSync', (...args) => {
    calls++;
    if (calls < 3) throw Object.assign(Error('temporary lock'), { code: 'EBUSY' });
    return rename(...args);
  });
  f.store.write(KEY, { ...entry(), source: '切换成功' });
  transient.mock.restore();
  assert.equal(calls, 3); assert.deepEqual(waits, [50, 100]);
  assert.equal(f.store.read(KEY).source, '切换成功');
  const committed = fs.readFileSync(f.file); calls = 0; waits.length = 0;
  const persistent = t.mock.method(fs, 'renameSync', () => { calls++; throw Object.assign(Error('persistent lock'), { code: 'EPERM' }); });
  assert.throws(() => f.store.write(KEY, entry()), /persistent lock/);
  persistent.mock.restore();
  assert.equal(calls, 5); assert.deepEqual(waits, [50, 100, 200, 400]);
  assert.ok(fs.readFileSync(f.file).equals(committed));
  assert.deepEqual(fs.readdirSync(f.directory), ['stock-sh600000.json']);
});

test('entry 序列化仅执行一次，校验和与实际写入数据保持一致', t => {
  const f = fixture(t); let count = 0;
  f.store.write(KEY, { toJSON: () => ({ ...entry(), serialization: ++count }) });
  assert.equal(count, 1);
  assert.equal(f.store.read(KEY).serialization, 1);
});
