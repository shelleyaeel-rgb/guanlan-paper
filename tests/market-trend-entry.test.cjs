'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { EntryConfirmationTracker } = require('../core/entry-confirmation.cjs');
const { enableMarketPolicy } = require('../core/market-policy.cjs');
const { INDEX_SYMBOLS, evaluateMarketRegime } = require('../core/market-regime.cjs');
const { strategyProfile } = require('../core/strategy-profiles.cjs');
const { cnTime } = require('../core/common.cjs');

const SYMBOL = 'sz000001', START = Date.parse('2026-10-16T10:00:00+08:00');
// Isolated synthetic inputs: market indices decline while the candidate itself
// meets its strategy's trend. No production account or live source is used.
function market(now, { advancing = 0.6, highVolatility = false, direction = -1 } = {}) {
  const bars = Array.from({ length: 70 }, (_, index) => {
    const close = 100 + direction * index * 0.2, range = highVolatility ? 4 : 0.2;
    return { date: new Date(Date.parse('2026-10-15T00:00:00Z') - (69 - index) * 86400000).toISOString().slice(0, 10),
      open: close, close, high: close + range, low: close - range, volume: 10000 };
  });
  const histories = Object.fromEntries(INDEX_SYMBOLS.map(symbol => [symbol, { symbol, bars, source: 'isolated index', fetchedAt: now, adjustment: '未复权' }]));
  const quotes = Object.fromEntries(INDEX_SYMBOLS.map(symbol => [symbol, { symbol, source: 'isolated index',
    price: bars.at(-1).close, prevClose: bars.at(-1).close, timestamp: now, date: cnTime(now).date }]));
  const rows = Array.from({ length: 1200 }, (_, index) => ({ symbol: `sh${600000 + index}`, price: 10,
    changePct: index < 1200 * advancing ? 1 : -1, timestamp: now }));
  return evaluateMarketRegime({ histories, quotes, breadth: { rows, source: 'isolated breadth',
    sourceCount: rows.length, excludedCount: 0, fetchedAt: now } }, now);
}

function fixture(strategyId, options = {}) {
  let now = START;
  const engine = new Engine(initialState(1000000), () => new Date(now));
  engine.agencyTransfer({ strategyId, amount: 500000 });
  engine.agencyMember({ strategyId, symbol: SYMBOL, action: 'add' });
  engine.agencyMode({ strategyId, mode: 'running' });
  enableMarketPolicy(engine.s);
  const tracker = new EntryConfirmationTracker();
  const technical = { asOf: '2026-10-15', close: 10.05, ma5: 10, previousMa5: 9.99,
    ma20: 9.95, previousMa20: 9.94, ma60: 9.9, previousMa60: 9.89,
    atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1.5, trend: true, breakout: false,
    entryLow: 9.8, entryHigh: 10.3, stop: 9.5, target: 11.5, support: 9.6, resistance: 11.5,
    dates: ['2026-10-15'], levels: {} };
  for (const id of ['ultra-short', 'short', 'long']) technical.levels[id] = {
    entryLow: 9.8, entryHigh: 10.3, stop: 9.5, target: 11.5, support: 9.6, resistance: 11.5 };
  const quote = price => ({ symbol: SYMBOL, name: '隔离趋势样本', source: 'isolated quote', price, ask: price, bid: price - 0.01,
    prevClose: technical.close, open: 10, low: 9.8, high: 10.3, volume: 100000, amount: 3e8, turnover: 4,
    askSize: 50000, bidSize: 50000, timestamp: now, date: cnTime(now).date, limitUp: 11.05, limitDown: 9.05 });
  const observe = (seconds, price, nextOptions = options) => {
    now = START + seconds * 1000;
    const q = quote(price), marketRegime = market(now, nextOptions);
    return { q, snapshot: { technical, source: 'isolated daily', fetchedAt: now, marketRegime,
      entryConfirmation: tracker.observe(SYMBOL, strategyId, q, technical, marketRegime, now) } };
  };
  const confirmed = () => {
    observe(0, technical[strategyProfile(strategyId).anchor]);
    observe(10, 10.08);
    return observe(70, 10.1);
  };
  const evaluate = ({ q, snapshot }) => engine.agencyEvaluate(strategyId, SYMBOL, q, snapshot, undefined, { [SYMBOL]: q });
  const execute = ({ q, snapshot }) => engine.agencyExecute({ symbol: SYMBOL, strategyId, action: 'buy', targetPercent: 20,
    decisionId: `isolated-${strategyId}`, expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, q, snapshot, { [SYMBOL]: q });
  return { engine, observe, confirmed, evaluate, execute };
}

for (const strategyId of ['ultra-short', 'short', 'swing', 'long']) {
  test(`${strategyId}：三指数中期下行仍可通过买点并模拟成交，预算不因此减额`, () => {
    const f = fixture(strategyId), entry = f.confirmed(), result = f.evaluate(entry);
    assert.equal(entry.snapshot.marketRegime.metrics.downCount, 3);
    assert.equal(result.buyable, true, result.reasons.join('；'));
    assert.equal(result.plan.config.riskPercent, 0.5);
    assert.equal(result.budget, 250000);
    const trade = f.execute(entry);
    assert.equal(trade.side, 'buy');
    assert.equal(trade.strategyPlan.config.riskPercent, 0.5);
    assert.equal(trade.strategyPlan.marketRegime.policyVersion, 2);
    assert.equal(trade.strategyPlan.marketRegime.metrics.downCount, 3);
    assert.ok(trade.strategyPlan.economics.loss <= result.budget);
    assert.equal(validState(f.engine.s), true);
  });

  test(`${strategyId}：中性广度和高波动仍减半，弱广度、旧版与过期证据仍拒绝成交`, () => {
    for (const options of [{ advancing: 0.4 }, { highVolatility: true }]) {
      const f = fixture(strategyId, options), entry = f.confirmed(), result = f.evaluate(entry);
      assert.equal(result.buyable, true, result.reasons.join('；'));
      assert.equal(result.plan.config.riskPercent, 0.25);
      assert.equal(result.budget, 125000);
      assert.equal(result.marketRegime.allowBreakout, false);
    }
    for (const failure of ['breadth', 'old-policy', 'expired', 'missing']) {
      const f = fixture(strategyId), entry = f.confirmed();
      assert.equal(f.evaluate(entry).buyable, true);
      if (failure === 'breadth') entry.snapshot.marketRegime = market(START + 70000, { advancing: 0.3 });
      if (failure === 'old-policy') entry.snapshot.marketRegime.policyVersion = 1;
      if (failure === 'expired') entry.snapshot.marketRegime.expiresAt = START;
      if (failure === 'missing') delete entry.snapshot.marketRegime;
      const before = structuredClone(f.engine.s);
      assert.equal(f.evaluate(entry).buyable, false);
      assert.throws(() => f.execute(entry));
      assert.deepEqual(f.engine.s, before);
    }
  });
}

test('指数趋势改变不重置回踩确认，个股自身趋势仍须通过', () => {
  const f = fixture('short');
  f.observe(0, 10, { direction: 1 });
  f.observe(10, 10.08, { direction: -1 });
  const entry = f.observe(70, 10.1, { direction: -1 });
  assert.equal(entry.snapshot.entryConfirmation.status, 'confirmed');
  assert.equal(f.evaluate(entry).buyable, true);
  entry.snapshot.technical.ma5 = 9.9;
  const result = f.evaluate(entry);
  assert.equal(result.buyable, false);
  assert.equal(result.status, '等待趋势');
});
