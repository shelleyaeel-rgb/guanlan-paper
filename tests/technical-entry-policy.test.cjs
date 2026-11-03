'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const { evaluateEntry } = require('../core/strategy.cjs');
const { TECHNICAL_STRATEGY_PROFILES, TECHNICAL_ENTRY_POLICY } = require('../core/strategy-profiles.cjs');

const symbol = 'sz000001', now = new Date('2026-10-26T10:00:00+08:00');
function fixture() {
  const engine = new Engine(initialState(100000), () => now);
  const quote = { symbol, name: '隔离技术策略', price: 10.1, prevClose: 10.08, open: 10, low: 10, high: 10.2,
    volume: 100000, amount: 2e8, turnover: 2, bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000,
    limitUp: 11.09, limitDown: 9.07, timestamp: +now, date: '2026-10-26' };
  const level = { entryLow: 9.9, entryHigh: 10.3, support: 9.7, resistance: 12, stop: 9.6, target: 12 };
  const snapshot = { source: '隔离完整日线', fetchedAt: +now, technical: {
    asOf: '2026-10-23', dates: ['2026-10-23'], close: 10.08, ma5: 10.05, previousMa5: 10.02,
    ma20: 10, previousMa20: 9.99, ma60: 9.95, previousMa60: 9.94, atr: 0.4, macd: 0.1,
    rsi: 55, volumeRatio: 1.5, trend: true, ...level,
    levels: Object.fromEntries(TECHNICAL_STRATEGY_PROFILES.map(profile => [profile.id, { ...level }]))
  } };
  const evaluate = id => evaluateEntry(engine, symbol, quote, snapshot, 100, id, { technicalOnly: true });
  return { engine, quote, snapshot, evaluate };
}

test('四类自动技术策略缺失或失败的公告财务均不阻断，成交计划明确记录停用而非通过', () => {
  for (const failed of [false, true]) for (const { id } of TECHNICAL_STRATEGY_PROFILES) {
    const f = fixture();
    if (failed) for (const section of ['notices', 'finance', 'valuation', 'automaticEvidence'])
      f.snapshot[section] = { symbol, status: 'unavailable', error: 'ERR_HTTP2_PROTOCOL_ERROR', fetchedAt: +now };
    const result = f.evaluate(id);
    assert.equal(result.buyable, true, `${id}: ${result.reasons.join('；')}`);
    assert.deepEqual(result.entryPolicy, TECHNICAL_ENTRY_POLICY);
    assert.deepEqual(result.plan.entryPolicy, TECHNICAL_ENTRY_POLICY);
    assert.equal(result.entryRisk.notices.status, 'disabled');
    assert.equal(result.plan.entryRiskEvidence.notices.status, 'disabled');
    assert.equal(result.financeCheck, undefined); assert.equal(result.plan.financeEvidence, undefined);
    assert.match(result.reasons.join('；'), /未执行公告、研究或财务估值筛查/);
  }
});

test('自动技术策略仍拒绝过期行情、日线缺失、价格错配、盘口不足与风险预算不足', () => {
  const invalid = [
    f => { f.quote.timestamp -= 90001; },
    f => { delete f.snapshot.technical; },
    f => { f.snapshot.technical.close = 20; },
    f => { f.quote.askSize = 0; },
    f => { f.engine.s.cash = 100; },
    f => { f.snapshot.technical.target = 10.11; for (const level of Object.values(f.snapshot.technical.levels)) level.target = 10.11; }
  ];
  for (const change of invalid) for (const { id } of TECHNICAL_STRATEGY_PROFILES) {
    const f = fixture(); change(f);
    assert.equal(f.evaluate(id).buyable, false, `${id}: invalid data must not authorize entry`);
    assert.equal(f.engine.s.trades.length, 0);
  }
});

test('通用研究策略入口保持原公告与长线财务要求，技术策略不会改写它', () => {
  const f = fixture();
  for (const { id } of TECHNICAL_STRATEGY_PROFILES) {
    assert.equal(f.evaluate(id).buyable, true);
    const generic = evaluateEntry(f.engine, symbol, f.quote, f.snapshot, 100, id);
    assert.equal(generic.buyable, false);
    assert.notEqual(generic.entryRisk.notices.status, 'disabled');
    if (id === 'long') assert.equal(generic.financeCheck.status, 'pending');
  }
});
