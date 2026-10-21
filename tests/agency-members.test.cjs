const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { addAgencyMembers, MAX_BATCH_AGENCY_MEMBERS } = require('../core/agency-members.cjs');
const now = new Date('2026-09-29T10:00:00+08:00');
const quote = symbol => ({ symbol, name: '批量加入隔离测试', price: 10, prevClose: 10, open: 10, low: 10, high: 10, volume: 100000,
  bid: 10, ask: 10, bidSize: 20000, askSize: 20000, limitUp: 11, limitDown: 9, timestamp: now.getTime(), date: '2026-09-29' });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-agency-members-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('guanlan-agency-members-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const engine = new Engine(initialState(100000), () => now), store = new Store(directory), calls = [], accepted = [];
  let transactions = 0, failSave = false, fetchQuotes = async symbols => Object.fromEntries(symbols.map(symbol => [symbol, quote(symbol)]));
  const transaction = fn => {
    const before = structuredClone(engine.s); transactions++;
    try { const result = fn(); if (failSave) throw Error('模拟账户保存失败'); store.save(engine.s); return result; }
    catch (error) { engine.s = before; throw error; }
  };
  return { engine, store, calls, accepted, get transactions() { return transactions; }, failSave: () => { failSave = true; },
    quotes: fn => { fetchQuotes = fn; },
    add: (symbols, strategyId = 'swing') => addAgencyMembers({ symbols, strategyId }, { getEngine: () => engine, transaction,
      market: { quotes: async symbols => { calls.push([...symbols]); return fetchQuotes(symbols); } }, acceptQuotes: batch => accepted.push(batch) }) };
}

test('全量批量加入超过旧 50 只限制，去重后仅一次查询和保存，重启恢复全部成员', async t => {
  const f = fixture(t), symbols = Array.from({ length: 125 }, (_, index) => `sh600${String(index).padStart(3, '0')}`);
  const beforeCash = f.engine.s.cash, result = await f.add([...symbols, '600000', 'SH600001']);
  assert.equal(result.total, 125); assert.deepEqual(result.added, symbols); assert.deepEqual(result.skipped, []); assert.deepEqual(result.failed, []);
  assert.deepEqual(f.calls, [symbols]); assert.equal(f.transactions, 1); assert.equal(validState(f.engine.s), true);
  assert.equal(f.engine.s.cash, beforeCash); assert.equal(f.engine.s.trades.length, 0);
  const restored = new Engine(f.store.load(), () => now);
  assert.deepEqual(restored.s.agency.groups.find(group => group.id === 'swing').members.map(member => member.symbol), symbols);
  assert.equal(restored.s.agency.groups.find(group => group.id === 'swing').mode, 'paused');
  assert.deepEqual(restored.s.marks.sh600000, quote('sh600000'));
  assert.equal(Object.keys(restored.s.marks).length, 125);
  restored.clock = () => new Date(now.getTime() + 120000);
  assert.throws(() => restored.fresh(restored.s.marks.sh600000), /报价过期/);
  const again = await f.add(symbols);
  assert.equal(again.added.length, 0); assert.equal(again.skipped.length, 125); assert.equal(f.transactions, 1); assert.equal(f.calls.length, 1);
});

test('逐项报告重复归属、手动持仓、委托及非法代码，不查询冲突股票且不重启退出中的成员', async t => {
  const f = fixture(t);
  f.engine.agencyMember({ strategyId: 'swing', symbol: '000001', action: 'add' });
  f.engine.s.agency.groups.find(group => group.id === 'swing').members[0].mode = 'closing';
  f.engine.agencyMember({ strategyId: 'long', symbol: '000002', action: 'add' });
  f.engine.execute({ symbol: '000003', side: 'buy', quantity: 100 }, quote('sz000003'));
  f.engine.place({ symbol: '000004', side: 'buy', quantity: 100, limit: 10 });
  const result = await f.add(['000001', '000002', '000003', '000004', '000005', 'invalid', 'invalid', 'bj920001']);
  assert.equal(result.total, 7); assert.deepEqual(result.added, ['sz000005']); assert.deepEqual(f.calls, [['sz000005']]);
  assert.deepEqual(result.skipped.map(item => item.code), ['already-member', 'other-strategy', 'manual-position', 'manual-order']);
  assert.deepEqual(result.failed.map(item => item.code), ['invalid-symbol', 'invalid-symbol']);
  assert.equal(f.engine.s.agency.groups.find(group => group.id === 'swing').members[0].mode, 'closing');
  assert.equal(f.engine.s.agency.groups.find(group => group.id === 'long').members[0].symbol, 'sz000002');
  assert.equal(validState(f.engine.s), true);
});

test('部分缺少报价只加入有报价项并完整报告，网络整体失败不写入账户', async t => {
  const f = fixture(t);
  f.quotes(async () => ({ sz000001: quote('sz000001') }));
  const partial = await f.add(['000001', '000002']);
  assert.deepEqual(partial.added, ['sz000001']);
  assert.deepEqual(partial.failed.map(item => [item.symbol, item.code]), [['sz000002', 'quote-unavailable']]);
  assert.equal(f.engine.s.marks.sz000002, undefined);
  const before = structuredClone(f.engine.s);
  f.quotes(async () => { throw Error('行情网络不可用'); });
  const failed = await f.add(['000001', '000002', '000003']);
  assert.equal(failed.skipped.length, 1); assert.equal(failed.added.length, 0); assert.equal(failed.failed.length, 2);
  assert.ok(failed.failed.every(item => item.reason.includes('行情网络不可用')));
  assert.deepEqual(f.engine.s, before); assert.equal(f.transactions, 1);
});

test('等待行情期间出现的跨策略加入与手动委托在保存事务中重新校验', async t => {
  const f = fixture(t);
  f.quotes(async symbols => {
    f.engine.agencyMember({ strategyId: 'long', symbol: '000001', action: 'add' });
    f.engine.place({ symbol: '000002', side: 'buy', quantity: 100, limit: 10 });
    return Object.fromEntries(symbols.map(symbol => [symbol, quote(symbol)]));
  });
  const result = await f.add(['000001', '000002', '000003']);
  assert.deepEqual(result.added, ['sz000003']);
  assert.deepEqual(result.skipped.map(item => item.code), ['other-strategy', 'manual-order']);
  assert.deepEqual(Object.keys(f.engine.s.marks), ['sz000003']);
  assert.equal(validState(f.engine.s), true); assert.equal(f.transactions, 1);
});

test('保存失败回滚全部新增成员，不返回伪成功且原账户文件保持原样', async t => {
  const f = fixture(t); await f.add(['000001']);
  const before = structuredClone(f.engine.s), persisted = fs.readFileSync(f.store.file, 'utf8');
  f.failSave();
  await assert.rejects(f.add(['000002', '000003']), /模拟账户保存失败/);
  assert.deepEqual(f.engine.s, before); assert.equal(fs.readFileSync(f.store.file, 'utf8'), persisted);
});

test('等待行情期间重置账户使批量请求失效，不将旧请求加入新账户', async t => {
  const f = fixture(t);
  f.quotes(async symbols => {
    f.engine.s = new Engine(initialState(200000), () => now).s;
    return Object.fromEntries(symbols.map(symbol => [symbol, quote(symbol)]));
  });
  await assert.rejects(f.add(['000001', '000002']), /账户已重置/);
  assert.equal(f.engine.s.agency.groups.flatMap(group => group.members).length, 0); assert.equal(f.transactions, 0); assert.equal(f.accepted.length, 0);
});

test('无效策略与非法批量结构在请求行情前拒绝', async t => {
  const f = fixture(t);
  await assert.rejects(f.add(['000001'], 'unknown'), /策略不存在/);
  for (const symbols of [null, [], '000001', Array(MAX_BATCH_AGENCY_MEMBERS + 1).fill('000001')]) await assert.rejects(f.add(symbols), /请选择/);
  assert.equal(f.calls.length, 0); assert.equal(f.transactions, 0);
});
