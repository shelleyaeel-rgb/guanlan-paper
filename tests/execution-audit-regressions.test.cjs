'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { cnTime } = require('../core/common.cjs');
const { parseQuotes } = require('../core/market-parsers.cjs');
const { evaluateEntry } = require('../core/strategy.cjs');

function fixture(capital = 1000000) {
  let now = new Date('2026-10-20T10:00:00+08:00');
  const engine = new Engine(initialState(capital), () => now);
  const quote = (symbol = 'sh600001', extra = {}) => ({ symbol, name: '隔离回归账户', price: 10, prevClose: 10,
    open: 10, high: 10.2, low: 9.9, volume: 2000000, bid: 10, ask: 10, bidSize: 2000000, askSize: 2000000,
    limitUp: 12, limitDown: 8, timestamp: now.getTime(), date: cnTime(now).date, ...extra });
  const snapshot = (symbol = 'sh600001', extra = {}) => ({ source: '隔离日线', fetchedAt: now.getTime(),
    notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } },
    technical: { asOf: cnTime(now.getTime() - 86400000).date, close: 10.05, ma5: 10, ma20: 10, ma60: 9.5,
      atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false, support: 9.7,
      resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5,
      dates: [cnTime(now.getTime() - 86400000).date], ...extra } });
  return { engine, quote, snapshot, time: value => { now = new Date(value); } };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
function strategyHolding(capital = 100000, symbol = 'sh600001', funding = 50000) {
  const f = fixture(capital), e = f.engine;
  e.agencyTransfer({ strategyId: 'swing', amount: funding });
  e.agencyConfigure({ strategyId: 'swing', limits: { riskPercent: 2 } });
  e.agencyMember({ strategyId: 'swing', symbol, action: 'add' });
  e.agencyMode({ strategyId: 'swing', mode: 'running' });
  const q = f.quote(symbol, { price: 10.1, prevClose: 10.05, ask: 10.1 });
  e.agencyExecute({ strategyId: 'swing', symbol, action: 'buy', targetPercent: 30, decisionId: 'isolated-buy',
    expectedEpoch: e.s.agency.epoch, expectedRevision: e.s.agency.revision }, q, f.snapshot(symbol));
  assert.equal(validState(e.s), true);
  return { ...f, symbol };
}

test('腾讯科创板盘口及成交量按股换算；不能放大盘口或重复消耗同一报价', () => {
  const at = Date.parse('2026-10-20T10:00:00+08:00');
  const raw = symbol => {
    const a = Array(85).fill('');
    Object.assign(a, { 0: '1', 1: '隔离腾讯报价', 2: symbol.slice(2), 3: '10', 4: '10', 5: '10', 6: '20000',
      9: '10', 10: '200', 19: '10', 20: '200', 30: '20261020100000', 31: '0', 32: '0', 33: '10.1', 34: '9.9',
      36: '20000', 37: '20', 47: '12', 48: '8', 57: '200000', 61: symbol.startsWith('sh688') ? 'GP-A-KCB' : 'GP-A' });
    return `v_${symbol}="${a.join('~')}";`;
  };
  for (const [symbol, factor] of [['sh688001', 1], ['sh600001', 100]]) {
    const q = parseQuotes(raw(symbol), at)[symbol];
    assert.equal(q.bidSize, 200 * factor); assert.equal(q.askSize, 200 * factor);
    assert.equal(q.volume, 20000 * factor); assert.equal(q.volume, q.screeningMetrics.volume * 1000000);
  }
  const { engine } = fixture(), q = parseQuotes(raw('sh688001'), at).sh688001;
  assert.throws(() => engine.execute({ symbol: q.symbol, side: 'buy', quantity: 1000 }, q), /数量不足/);
  engine.execute({ symbol: q.symbol, side: 'buy', quantity: 200 }, q);
  assert.throws(() => engine.execute({ symbol: q.symbol, side: 'buy', quantity: 200 }, q), /数量不足/);
  assert.equal(engine.s.trades.length, 1);
});

test('科创板即时申报限5万股、限价限10万股；全额卖出不绕过上限', () => {
  const { engine: e, quote, time } = fixture(5000000), symbol = 'sh688001', q = quote(symbol);
  for (const side of ['buy', 'sell']) {
    assert.doesNotThrow(() => e.validateQuantity(symbol, 50000, side));
    assert.throws(() => e.validateQuantity(symbol, 50001, side), /50,000/);
    assert.doesNotThrow(() => e.validateQuantity(symbol, 100000, side, true));
    assert.throws(() => e.place({ symbol, side, quantity: 100001, limit: 10.1 }), /100,000/);
    assert.doesNotThrow(() => e.validateQuantity('sh600001', 1000000, side));
  }
  const before = structuredClone(e.s);
  assert.throws(() => e.execute({ symbol, side: 'buy', quantity: 50001 }, q), /50,000/);
  assert.throws(() => e.execute({ symbol, side: 'buy', quantity: 100000, limit: NaN }, q), /限价/);
  assert.deepEqual(e.s, before);
  const order = e.place({ symbol, side: 'buy', quantity: 100000, limit: 10.1 });
  assert.equal(e.tick({ [symbol]: q })[0].quantity, 100000); assert.equal(order.status, 'filled');
  time('2026-10-21T10:00:00+08:00');
  assert.throws(() => e.execute({ symbol, side: 'sell', quantity: 100000 }, quote(symbol)), /50,000/);
  assert.equal(e.execute({ symbol, side: 'sell', quantity: 100000, limit: 9.9 }, quote(symbol)).quantity, 100000);
  assert.equal(validState(e.s), true);
});

test('科创板策略自动选量不超过市价上限，不因超量而整笔拒绝', () => {
  const { engine, quote, snapshot } = fixture(10000000), symbol = 'sh688001';
  const q = quote(symbol, { price: 10.1, prevClose: 10.05, ask: 10.1 });
  const evaluation = evaluateEntry(engine, symbol, q, snapshot(symbol));
  assert.equal(evaluation.buyable, true); assert.equal(evaluation.quantity, 50000);
  assert.equal(engine.strategyEntry({ symbol, quantity: evaluation.quantity }, q, snapshot(symbol)).quantity, 50000);
});

test('超过科创板单笔上限的既有持仓按5万股退出并卖清不足200股尾数', () => {
  const { engine: e, quote, time } = fixture(5000000), symbol = 'sh688001';
  e.execute({ symbol, side: 'buy', quantity: 99900, limit: 10.1 }, quote(symbol));
  e.execute({ symbol, side: 'buy', quantity: 201, limit: 10.1 }, quote(symbol));
  e.setRisk(symbol, { stop: 9.9, target: 11, enabled: true });
  time('2026-10-21T10:00:00+08:00');
  const q = quote(symbol, { price: 9.8, bid: 9.8 });
  const restored = new Engine(structuredClone(e.s), e.clock), quantities = [];
  for (let index = 0; index < 3; index++) quantities.push(...restored.tick({ [symbol]: q }).map(trade => trade.quantity));
  assert.deepEqual(quantities, [50000, 50000, 101]);
  assert.equal(restored.positions().length, 0); assert.equal(validState(restored.s), true);
});

test('旧账户超量科创板条件单可恢复但不能执行超上限成交', () => {
  const { engine: e, quote } = fixture(10000000), symbol = 'sh688001';
  e.s.orders.push({ id: 'legacy-star-order', symbol, side: 'buy', quantity: 100001, limit: 10.1,
    status: 'pending', createdAt: e.clock().toISOString(), note: '旧版本条件单' });
  const restored = new Engine(JSON.parse(JSON.stringify(e.s)), e.clock);
  assert.deepEqual(restored.tick({ [symbol]: quote(symbol) }), []);
  assert.equal(restored.s.orders[0].status, 'pending'); assert.match(restored.s.orders[0].note, /100,000/);
  assert.equal(restored.s.trades.length, 0); assert.equal(validState(restored.s), true);
});

test('科创板策略送转后超量持仓分批退出，重启保留全退或部分减仓目标', () => {
  for (const action of ['sell', 'reduce']) {
    const { engine: e, quote, snapshot, time, symbol } = strategyHolding(10000000, 'sh688001', 8000000);
    assert.equal(e.positions()[0].quantity, 50000);
    time('2026-10-21T10:00:00+08:00');
    e.agencyReconcile({ strategyId: 'swing', symbol, eventId: `isolated-split-${action}`,
      evidence: '隔离测试三倍送转，验证完整交易链路', effectiveDate: '2026-10-21', recordDate: '2026-10-20',
      shareNumerator: 3, shareDenominator: 1, riskPriceFactor: 1 / 3 });
    e.setRisk(symbol, { enabled: true, dynamic: false });
    assert.equal(e.positions()[0].quantity, 150000); assert.equal(validState(e.s), true);
    const q = quote(symbol, { price: 3.37, prevClose: 3.35, open: 3.35, high: 3.4, low: 3.3,
      bid: 3.36, ask: 3.37, limitUp: 4.02, limitDown: 2.68 });
    const snap = snapshot(symbol, { close: 3.35 }), decisionId = `split-exit-${action}`;
    const first = e.agencyExecute({ strategyId: 'swing', symbol, action, decisionId,
      expectedEpoch: e.s.agency.epoch, expectedRevision: e.s.agency.revision }, q, snap, { [symbol]: q });
    assert.equal(first.quantity, 50000); assert.equal(e.agencyPendingExit(symbol).targetQuantity, action === 'sell' ? 0 : 75000);
    const restored = new Engine(JSON.parse(JSON.stringify(e.s)), e.clock), quantities = [first.quantity];
    for (let index = 0; index < 3 && restored.agencyPendingExit(symbol); index++)
      quantities.push(...restored.tick({ [symbol]: q }, { [symbol]: snap }).map(trade => trade.quantity));
    assert.deepEqual(quantities, action === 'sell' ? [50000, 50000, 50000] : [50000, 25000]);
    assert.equal(restored.positions()[0]?.quantity || 0, action === 'sell' ? 0 : 75000);
    assert.equal(restored.s.agency.executionIntents.find(intent => intent.decisionId === decisionId).status, 'completed');
    assert.equal(validState(restored.s), true);
  }
});

test('手动及条件买入须重估全部持仓；新估值收紧集中度，失败不成交', () => {
  for (const conditional of [false, true]) {
    const { engine: e, quote, time } = fixture();
    e.execute({ symbol: 'sh600001', side: 'buy', quantity: 29900 }, quote());
    time('2026-10-21T10:00:00+08:00');
    const b = quote('sh600002'), input = { symbol: b.symbol, side: 'buy', quantity: 29900, ...(conditional ? { limit: 10.1 } : {}) };
    const order = conditional ? e.place(input) : null;
    const before = structuredClone(e.s);
    if (conditional) { assert.equal(e.tick({ [b.symbol]: b }).length, 0); assert.match(order.note, /持仓估值/); }
    else { assert.throws(() => e.execute(input, b, { [b.symbol]: b }), /持仓估值/); assert.deepEqual(e.s, before); }
    const a = quote('sh600001', { price: 9 });
    if (conditional) { assert.equal(e.tick({ [a.symbol]: a, [b.symbol]: b }).length, 0); assert.match(order.note, /仓位上限/); assert.equal(order.status, 'pending'); }
    else assert.throws(() => e.execute(input, b, { [a.symbol]: a, [b.symbol]: b }), /仓位上限/);
    assert.equal(e.s.trades.length, 1);
    if (conditional) e.cancel(order.id);
    assert.equal(e.execute({ ...input, quantity: 20000 }, b, { [a.symbol]: a, [b.symbol]: b }).quantity, 20000);
  }
});

test('手动买入拒绝缺失、错股、未来、跨日或过期估值；退出不受无关持仓旧价阻断', () => {
  const { engine: e, quote, time } = fixture();
  e.execute({ symbol: 'sh600001', side: 'buy', quantity: 100 }, quote());
  time('2026-10-21T10:00:00+08:00');
  delete e.s.marks.sh600001;
  const b = quote('sh600002'), input = { symbol: b.symbol, side: 'buy', quantity: 100 };
  for (const a of [undefined, quote('sh600003'), quote('sh600001', { price: 0 }),
    quote('sh600001', { timestamp: b.timestamp + 15001 }), quote('sh600001', { date: '2026-10-20' }),
    quote('sh600001', { timestamp: b.timestamp - 90001 })]) {
    const before = structuredClone(e.s);
    assert.throws(() => e.execute(input, b, a ? { sh600001: a } : {}), /持仓估值/);
    assert.deepEqual(e.s, before);
  }
  // A fresh price-only mark is sufficient for valuation; it need not be tradable.
  e.execute(input, b, { sh600001: { symbol: 'sh600001', price: 10, timestamp: b.timestamp - 90000, date: b.date } });
  assert.equal(e.execute({ symbol: 'sh600001', side: 'sell', quantity: 100 }, quote()).side, 'sell');
});

test('手动策略建仓的推荐数量和实际下单使用同一批新鲜持仓估值', () => {
  const { engine: e, quote, snapshot, time } = fixture();
  e.execute({ symbol: 'sh600001', side: 'buy', quantity: 29900 }, quote());
  time('2026-10-21T10:00:00+08:00');
  const symbol = 'sh600002', q = quote(symbol, { price: 10.1, prevClose: 10.05, ask: 10.1 }), snap = snapshot(symbol);
  const a = quote('sh600001', { price: 9 }), control = new Engine(structuredClone(e.s), e.clock);
  control.s.marks.sh600001 = a;
  const stalePlan = evaluateEntry(e, symbol, q, snap), freshPlan = evaluateEntry(control, symbol, q, snap);
  assert.equal(freshPlan.buyable, true); assert.ok(freshPlan.quantity < stalePlan.quantity);
  assert.throws(() => e.strategyEntry({ symbol }, q, snap), /持仓估值/);
  const trade = e.strategyEntry({ symbol }, q, snap, { sh600001: a });
  assert.equal(trade.quantity, freshPlan.quantity);
  assert.ok(trade.strategyPlan.economics.loss <= control.stats().equity * e.s.strategySettings.riskPercent / 100);
});

test('有持仓策略划拨使用当日净值，转入转出均保持收益率并跨重启保存', () => {
  const { engine: e, quote, time, symbol } = strategyHolding();
  time('2026-10-21T10:00:00+08:00');
  const q = quote(symbol, { price: 11 }), quotes = { [symbol]: q };
  const before = e.agencyGroupState('swing', quotes), saved = structuredClone(e.s);
  assert.throws(() => e.agencyTransfer({ strategyId: 'swing', amount: 50000 }), /持仓估值/);
  assert.deepEqual(e.s, saved);
  const added = e.agencyTransfer({ strategyId: 'swing', amount: 50000 }, quotes);
  near(added.returnPct, before.returnPct); assert.equal(added.equity, before.equity + 5000000);
  const removed = e.agencyTransfer({ strategyId: 'swing', amount: -25000 }, quotes);
  near(removed.returnPct, before.returnPct); assert.equal(removed.equity, before.equity + 2500000);
  const restored = new Engine(JSON.parse(JSON.stringify(e.s)), e.clock);
  near(restored.agencyGroupState('swing').returnPct, before.returnPct);
  assert.equal(restored.s.marks[symbol].price, 11); assert.equal(validState(restored.s), true);
});

test('策略划拨复用盘中、午休和盘后估值规则；不依赖其他策略持仓', () => {
  for (const [at, quotedAt, allowed] of [['11:00:00', '10:58:30', true], ['11:00:00', '10:58:29', false],
    ['12:00:00', '11:28:30', true], ['12:00:00', '11:28:29', false], ['13:02:00', '11:30:00', false],
    ['17:00:00', '14:59:59', false], ['17:00:00', '15:00:00', true]]) {
    const { engine: e, quote, time, symbol } = strategyHolding();
    time(`2026-10-21T${at}+08:00`);
    const q = quote(symbol, { timestamp: Date.parse(`2026-10-21T${quotedAt}+08:00`) }), saved = structuredClone(e.s);
    const run = () => e.agencyTransfer({ strategyId: 'swing', amount: 100 }, { [symbol]: q });
    if (allowed) { assert.doesNotThrow(run); assert.equal(validState(e.s), true); }
    else { assert.throws(run, /估值已过期/); assert.deepEqual(e.s, saved); }
  }
  const { engine: e, time } = strategyHolding();
  time('2026-10-21T10:00:00+08:00');
  assert.doesNotThrow(() => e.agencyTransfer({ strategyId: 'long', amount: 100 }));
});
