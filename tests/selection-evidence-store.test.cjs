const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SelectionEvidenceStore } = require('../core/selection-evidence-store.cjs');
const record = (changes = {}) => ({ symbol: '600001', kind: 'demand', subject: '核心产品', value: 'supported', reviewState: 'confirmed', sourceTitle: '年报', url: 'https://example.com/report', publishedAt: '2026-04-01', period: '2025年度', reviewedAt: '2026-05-01', validUntil: '2027-05-01', quote: '原文依据', notes: '', ...changes });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-selection-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new SelectionEvidenceStore(directory, () => new Date('2026-10-08T08:00:00Z')) };
}

test('独立证据库生成编号、规范股票代码、重启恢复、修改与删除', t => {
  const { store, directory } = fixture(t);
  const account = path.join(directory, 'account.json');
  fs.writeFileSync(account, '用户账户不可覆盖');
  const saved = store.save(record());
  assert.match(saved.id, /^[a-f0-9-]{36}$/);
  assert.equal(saved.symbol, 'sh600001');
  assert.equal(store.list('600001').length, 1);
  assert.equal(store.list('600002').length, 0);
  const payload = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(payload.version, 1); assert.equal(payload.updatedAt, '2026-10-08T08:00:00.000Z');
  const restarted = new SelectionEvidenceStore(directory);
  assert.deepEqual(restarted.list(), [saved]);
  const updated = restarted.save({ ...saved, value: 'unsupported' });
  assert.equal(updated.id, saved.id);
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.list()[0].value, 'unsupported');
  assert.throws(() => restarted.save({ ...saved, symbol: '600002' }), /不能更改/);
  assert.throws(() => restarted.save({ ...saved, id: '15555555-5555-4555-8555-555555555555' }), /不存在/);
  assert.equal(restarted.remove({ id: saved.id }), true);
  assert.equal(restarted.remove({ id: saved.id }), false);
  assert.deepEqual(new SelectionEvidenceStore(directory).list(), []);
  assert.equal(fs.readFileSync(account, 'utf8'), '用户账户不可覆盖');
});

test('返回值与调用方入参不能修改内存；草稿允许缺少来源', t => {
  const { store } = fixture(t);
  const input = record({ reviewState: 'draft', url: '', quote: '', reviewedAt: '' });
  const saved = store.save(input);
  input.value = 'unsupported'; saved.value = 'unknown';
  const listed = store.list(); listed[0].quote = '被改写';
  assert.equal(store.list()[0].value, 'supported');
  assert.equal(store.list()[0].quote, '');
});

test('损坏、未知版本、重复编号文件保留且拒绝读写，不阻止应用构造', t => {
  const { directory, store } = fixture(t);
  const saved = store.save(record());
  const invalidPayloads = ['{bad json', JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [saved, saved] }), JSON.stringify({ version: 1, records: [{ ...saved, publishedAt: '2026-02-30' }] })];
  for (const source of invalidPayloads) {
    fs.writeFileSync(store.file, source);
    const damaged = new SelectionEvidenceStore(directory);
    assert.match(damaged.warning, /无法读取/);
    assert.throws(() => damaged.list(), /原文件已保留/);
    assert.throws(() => damaged.save(record()), /原文件已保留/);
    assert.throws(() => damaged.remove({ id: saved.id }), /原文件已保留/);
    assert.equal(fs.readFileSync(store.file, 'utf8'), source);
  }
});

test('原子替换失败时保留原文件和内存、清理临时文件，后续可重试', t => {
  const { directory, store } = fixture(t);
  const saved = store.save(record());
  const source = fs.readFileSync(store.file, 'utf8');
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === store.file) throw Error('模拟磁盘替换失败'); return rename(from, to); };
    assert.throws(() => store.save({ ...saved, value: 'unsupported' }), /模拟磁盘替换失败/);
    assert.throws(() => store.remove({ id: saved.id }), /模拟磁盘替换失败/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(store.list(), [saved]);
  assert.equal(fs.readFileSync(store.file, 'utf8'), source);
  assert.deepEqual(fs.readdirSync(directory), ['selection-evidence.json']);
  assert.equal(store.save({ ...saved, value: 'unsupported' }).value, 'unsupported');
});

test('写入执行与读取相同的 UTF-8 字节上限，超限不会生成无法重载的库', t => {
  const { store } = fixture(t);
  const saved = store.save(record());
  const source = fs.readFileSync(store.file, 'utf8');
  const large = { ...saved, quote: '中'.repeat(12000), notes: '文'.repeat(12000) };
  assert.throws(() => store.persist(Array(1000).fill(large)), /64 MiB/);
  assert.equal(fs.readFileSync(store.file, 'utf8'), source);
  assert.deepEqual(store.list(), [saved]);
});
