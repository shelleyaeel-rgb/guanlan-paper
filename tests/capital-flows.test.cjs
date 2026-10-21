'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { capitalPerformance } = require('../core/capital-flows.cjs');
const { cnTime } = require('../core/common.cjs');

function fixture() {
  let now = new Date('2026-10-16T10:00:00+08:00');
  const state = initialState(1000000);
  state.equity[0].time = now.getTime() - 86400000;
  const engine = new Engine(state, () => now);
  const quote = (extra = {}) => ({ symbol: 'sz000001', name: '资金流测试', price: 10, open: 10,
    volume: 100000, bid: 9.99, ask: 10.01, bidSize: 10000, askSize: 10000,
    limitUp: 11, limitDown: 9, timestamp: now.getTime(), date: cnTime(now).date, ...extra });
  return { engine, quote, time: value => { now = new Date(value); } };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('追加虚拟本金后可各划拨五十万元，原本金与四组资金不重复记账', () => {
  const { engine } = fixture();
  for (const strategyId of ['swing', 'long']) engine.agencyTransfer({ strategyId, amount: 500000 });
  const historicalTransfers = structuredClone(engine.s.agency.transfers);
  const flow = engine.addCapital({ amount: 1000000, requestId: 'fund-short-and-ultra-20261016' });
  assert.equal(flow.amount, 100000000); assert.equal(flow.equityBefore, 100000000); assert.equal(flow.equityAfter, 200000000);
  assert.equal(engine.s.version, 2); assert.equal(engine.s.initialCash, 100000000);
  assert.equal(engine.s.cash, 200000000); assert.equal(engine.s.agency.manualCash, 100000000);
  for (const strategyId of ['short', 'ultra-short']) engine.agencyTransfer({ strategyId, amount: 500000 });
  assert.equal(engine.s.agency.manualCash, 0); assert.equal(engine.s.agency.groups.length, 4);
  assert.ok(engine.s.agency.groups.every(group => group.cash === 50000000 && group.netFunding === 50000000));
  assert.deepEqual(engine.s.agency.transfers.slice(0, 2), historicalTransfers);
  const stats = engine.stats();
  assert.equal(stats.cumulativeCapital, 200000000); assert.equal(stats.netContributions, 100000000);
  assert.equal(stats.pnl, 0); near(stats.returnPct, 0); near(stats.drawdown, 0);
  assert.equal(validState(engine.s), true);
});

test('亏损后盘后按当日估值入金，保留原交易、持仓、盈亏、收益率及历史回撤', () => {
  const { engine, quote, time } = fixture();
  engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 1000 }, quote());
  time('2026-10-16T15:30:00+08:00');
  const closing = quote({ price: 9, timestamp: Date.parse('2026-10-16T15:00:00+08:00') });
  const quotes = { sz000001: closing };
  const before = engine.stats(quotes), trades = structuredClone(engine.s.trades), lots = structuredClone(engine.s.lots);
  const history = structuredClone(engine.s.equity);
  assert.ok(before.pnl < 0);
  engine.addCapital({ amount: 1000000, requestId: 'loss-funding' }, quotes);
  const after = engine.stats();
  assert.equal(after.pnl, before.pnl); near(after.returnPct, before.returnPct); near(after.drawdown, before.drawdown);
  assert.equal(after.equity, before.equity + 100000000);
  assert.deepEqual(engine.s.trades, trades); assert.deepEqual(engine.s.lots, lots);
  assert.deepEqual(engine.s.equity.slice(0, history.length), history);
  assert.deepEqual(engine.s.capitalFlows[0].valuation, [{ symbol: closing.symbol, price: 9, timestamp: closing.timestamp, date: closing.date }]);
  const reloaded = new Engine(JSON.parse(JSON.stringify(engine.s)), () => new Date('2026-10-16T15:30:00+08:00'));
  assert.equal(validState(reloaded.s), true); assert.deepEqual(reloaded.stats(), engine.stats());
});

test('入金请求幂等且返回审计副本，跨日重试不重复入账，异额拒绝', () => {
  const { engine, time } = fixture(), input = { amount: '500000.00', requestId: 'once' };
  const flow = engine.addCapital(input), state = structuredClone(engine.s);
  flow.amount = 1;
  time('2026-10-17T10:00:00+08:00');
  assert.equal(engine.addCapital(input).amount, 50000000);
  assert.deepEqual(engine.s, state);
  assert.throws(() => engine.addCapital({ amount: 1, requestId: 'once' }), /不同金额/);
  assert.deepEqual(engine.s, state);
});

test('非法金额、重复编号和累计金额越界全部在修改前拒绝', () => {
  for (const amount of [undefined, null, '', 0, -1, 0.001, 100000001, NaN, Infinity, true, {}, '0.001']) {
    const { engine } = fixture(), state = structuredClone(engine.s);
    assert.throws(() => engine.addCapital({ amount, requestId: 'invalid' }));
    assert.deepEqual(engine.s, state);
  }
  for (const requestId of [undefined, '', ' ', 'leading ', 'x'.repeat(129), 123]) {
    const { engine } = fixture(), state = structuredClone(engine.s);
    assert.throws(() => engine.addCapital({ amount: 100, requestId })); assert.deepEqual(engine.s, state);
  }
  const { engine } = fixture();
  for (let index = 0; index < 9; index++) engine.addCapital({ amount: 100000000, requestId: `maximum-${index}` });
  const state = structuredClone(engine.s);
  assert.throws(() => engine.addCapital({ amount: 100000000, requestId: 'overflow' }), /累计投入/);
  assert.deepEqual(engine.s, state);
});

test('缺失、跨日、未来、代码错误估值不可使用成本回退，且失败不改状态', () => {
  const { engine, quote } = fixture();
  engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 100 }, quote());
  delete engine.s.marks.sz000001;
  for (const q of [undefined, quote({ price: 0 }), quote({ price: NaN }), quote({ date: '2026-10-15' }),
    quote({ timestamp: Date.parse('2026-10-15T15:00:00+08:00') }), quote({ timestamp: quote().timestamp + 16000 }), quote({ symbol: 'sh600000' })]) {
    const state = structuredClone(engine.s);
    assert.throws(() => engine.addCapital({ amount: 100, requestId: 'valuation' }, q ? { sz000001: q } : {}), /当日有效持仓估值/);
    assert.deepEqual(engine.s, state);
  }
  engine.s.marks.sz000001 = quote();
  assert.doesNotThrow(() => engine.addCapital({ amount: 100, requestId: 'valuation' }));
});

test('没有持仓或历史权益的候选待核验不影响净值，不阻断追加本金', () => {
  const { engine } = fixture();
  engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'add' });
  engine.s.agency.groups.find(group => group.id === 'swing').members[0].reconciliation = { status: 'pending', reason: '需核实除权' };
  assert.equal(engine.stats().comparable, true);
  const prior = engine.stats();
  assert.doesNotThrow(() => engine.addCapital({ amount: 100, requestId: 'pending-candidate' }));
  assert.equal(engine.stats().equity, prior.equity + 10000);
  assert.equal(engine.stats().pnl, prior.pnl); near(engine.stats().returnPct, prior.returnPct);
  assert.equal(validState(engine.s), true);
  assert.equal(engine.s.agency.groups.find(group => group.id === 'swing').members[0].reconciliation.status, 'pending');
});

test('实际持仓待对账仍拒绝追加，不能以资金流重置不可比净值', () => {
  const { engine, quote } = fixture();
  engine.agencyTransfer({ strategyId: 'swing', amount: 500000 });
  engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'add' });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const q = quote({ price: 10.1, bid: 10.09, ask: 10.1, prevClose: 10.05, low: 10, high: 10.2 }), asOf = '2026-10-15';
  const snapshot = { source: 'test daily', fetchedAt: q.timestamp,
    notices: { symbol: q.symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: q.timestamp, data: { items: [], total: 0 } },
    technical: { asOf, close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4, macd: 0.1, rsi: 55,
      volumeRatio: 1, trend: true, breakout: false, support: 9.7, resistance: 11.5, entryLow: 9.9,
      entryHigh: 10.3, stop: 9.6, target: 11.5, dates: [asOf] } };
  engine.agencyExecute({ strategyId: 'swing', symbol: q.symbol, action: 'buy', targetPercent: 20,
    decisionId: 'pending-holding', expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, q, snapshot, { [q.symbol]: q });
  const member = engine.s.agency.groups.find(group => group.id === 'swing').members[0];
  member.reconciliation = { status: 'pending', reason: '需核实除权' };
  assert.ok(engine.s.lots.length > 0); assert.equal(engine.stats().comparable, false);
  const state = structuredClone(engine.s);
  assert.throws(() => engine.addCapital({ amount: 100, requestId: 'pending' }), /待对账/);
  assert.deepEqual(engine.s, state);
});

test('追加本金按时段核验估值，盘中90秒、午休上午收盘窗口、盘后真实收盘报价', () => {
  for (const [at, quotedAt, allowed] of [
    ['11:00:00', '10:58:30', true], ['11:00:00', '10:58:29', false],
    ['12:00:00', '11:30:00', true], ['12:00:00', '11:28:30', true], ['12:00:00', '11:28:29', false],
    ['13:02:00', '11:30:00', false], ['14:59:00', '14:57:30', true],
    ['15:00:00', '14:59:59', false], ['17:20:00', '10:00:00', false],
    ['17:20:00', '14:59:59', false], ['17:20:00', '15:00:00', true]
  ]) {
    const { engine, quote, time } = fixture();
    engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 100 }, quote());
    time(`2026-10-16T${at}+08:00`);
    const q = quote({ timestamp: Date.parse(`2026-10-16T${quotedAt}+08:00`) }), before = structuredClone(engine.s);
    const fund = () => engine.addCapital({ amount: 100, requestId: 'session-freshness' }, { sz000001: q });
    if (allowed) { assert.doesNotThrow(fund, `${at}/${quotedAt}`); assert.equal(validState(engine.s), true); }
    else { assert.throws(fund, /估值已过期/, `${at}/${quotedAt}`); assert.deepEqual(engine.s, before); }
  }
});

test('单位净值保留入金前高点，后续收益连乘且不混淆同毫秒记录', () => {
  const history = [{ time: 1, value: 1000 }, { time: 2, value: 1200 }, { time: 3, value: 800 },
    { time: 3, value: 1800, netContributions: 1000 }, { time: 4, value: 1980, netContributions: 1000 }];
  const flows = [{ amount: 1000, equityBefore: 800, equityAfter: 1800 }];
  const perf = capitalPerformance(1000, history, flows, 1980);
  near(perf.returnPct, 0.8 * 1.1 - 1); near(perf.drawdown, 1 / 3); assert.equal(perf.pnl, -20);
  near(capitalPerformance(1000, history, flows, 900).drawdown, 2 / 3);
  flows.push({ amount: 1980, equityBefore: 1980, equityAfter: 3960 });
  history.push({ time: 5, value: 3960, netContributions: 2980 });
  const twice = capitalPerformance(1000, history, flows, 4356);
  near(twice.returnPct, 0.8 * 1.1 * 1.1 - 1); near(twice.drawdown, 1 / 3);
});

test('无入金旧账户兼容，入金账本的重复、错误净值、错误历史阶段和降级均拒绝', () => {
  assert.equal(validState(initialState()), true);
  const unfundedV2 = initialState(); unfundedV2.version = 2; assert.equal(validState(unfundedV2), true);
  const { engine } = fixture(); engine.addCapital({ amount: 100, requestId: 'audit' });
  const changes = [state => { state.version = 1; }, state => { state.capitalFlows.push({ ...state.capitalFlows[0] }); },
    state => { state.capitalFlows[0].amount = -1; }, state => { state.capitalFlows[0].equityAfter++; },
    state => { state.capitalFlows[0].equityBefore = 0; }, state => { state.capitalFlows[0].time = 'invalid'; },
    state => { state.capitalFlows[0].requestId = ''; }, state => { state.equity.at(-1).netContributions++; },
    state => { state.cash++; }];
  for (const change of changes) {
    const state = structuredClone(engine.s); change(state);
    assert.equal(validState(state), false); assert.throws(() => new Engine(state), /格式/);
  }
});

test('历史降采样分开处理入金前后区间，保留净值最大回撤', () => {
  const { engine } = fixture();
  engine.s.equity = Array.from({ length: 9 }, (_, index) => ({ time: index + 1, value: index === 4 ? 120000000 : 100000000 }));
  engine.addCapital({ amount: 1000000, requestId: 'downsample' });
  const contribution = engine.s.capitalFlows[0].amount;
  engine.s.equity.push(...Array.from({ length: 30000 }, (_, index) => ({ time: Date.parse('2026-10-16T10:00:01+08:00') + index,
    value: index === 3 ? 120000000 : 200000000, netContributions: contribution })));
  const before = engine.stats().drawdown;
  engine.record({}, true);
  assert.ok(engine.s.equity.length < 30000); assert.equal(validState(engine.s), true);
  near(engine.stats().drawdown, before); near(before, 0.5);
});

test('同毫秒先低后高的净值降采样保留执行次序，不虚增入金前历史回撤', () => {
  const { engine } = fixture();
  engine.s.equity = [100000000, 90000000, ...Array(8).fill(120000000)].map(value => ({ time: 1, value }));
  engine.addCapital({ amount: 1000000, requestId: 'same-millisecond-order' });
  engine.s.equity.push(...Array.from({ length: 30000 }, (_, index) => ({ time: index + 2,
    value: 200000000, netContributions: 100000000 })));
  const before = engine.stats().drawdown;
  near(before, 1 / 6); // The later 120 peak fell to 100 at funding, not to the earlier 90 trough.
  engine.record({}, true);
  const originalStage = engine.s.equity.filter(point => !point.netContributions);
  assert.deepEqual(originalStage.map(point => point.value), [100000000, 90000000, 120000000]);
  near(engine.stats().drawdown, before);
  assert.equal(validState(engine.s), true);
});
