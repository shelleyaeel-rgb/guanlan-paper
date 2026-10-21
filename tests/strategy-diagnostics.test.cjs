const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const { evaluateEntry, technicals } = require('../core/strategy.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');

const symbol = 'sz000001', now = new Date('2026-09-29T10:00:00+08:00');
function fixture(overrides = {}) {
  const engine = new Engine(initialState(100000), () => now);
  const level = { entryLow: 9.9, entryHigh: 10.3, support: 9.7, resistance: 11.8, stop: 9.6, target: 11.8, breakout: false };
  const technical = { asOf: '2026-09-28', dates: ['2026-09-28'], close: 10.08,
    ma5: 10.05, previousMa5: 10.02, ma20: 10, previousMa20: 9.99, ma60: 9.95, previousMa60: 9.94,
    atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1.5, ...level,
    levels: Object.fromEntries(['ultra-short', 'short', 'swing', 'long'].map(id => [id, { ...level }])), ...overrides };
  technical.trend = Object.hasOwn(overrides, 'trend') ? overrides.trend
    : technical.close >= technical.ma20 && technical.ma20 > technical.ma60 && technical.ma20 > technical.previousMa20;
  const quote = { symbol, name: '隔离趋势诊断样本', price: 10.1, prevClose: technical.close, open: 10, low: 10, high: 10.2,
    volume: 100000, bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000, limitUp: 11.09, limitDown: 9.07,
    amount: 2e8, turnover: 2, timestamp: now.getTime(), date: '2026-09-29' };
  const response = section => ({ symbol, section, source: '东方财富', status: 'ready', fetchedAt: now.getTime() });
  const snapshot = { source: '隔离未复权日线', fetchedAt: now.getTime(), technical,
    notices: { ...response('notices'), status: 'empty', data: { items: [], total: 0 } },
    finance: { ...response('finance'), industryProfile: ordinaryProfile(symbol, now), data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', currency: 'CNY',
      roe: 8, debtRatio: 60, revenueYoY: 0, adjustedProfitYoY: 0, adjustedProfit: 1e8, operatingCash: 1e8 },
      annual: [{ reportDate: '2025-12-31', noticeDate: '2026-03-20', currency: 'CNY', roe: 8 }] } },
    valuation: { ...response('valuation'), data: { pe: 30, pb: 4, quoteTime: now.getTime() } } };
  return { engine, quote, snapshot, evaluate: id => evaluateEntry(engine, symbol, quote, snapshot, 100, id) };
}

test('长线财务通过后只列出实际失败的趋势指标与数值，不重复财务门槛', () => {
  const f = fixture({ ma20: 10.1, ma60: 10.2, previousMa60: 10.3 });
  const result = f.evaluate('long');
  assert.equal(result.status, '等待趋势'); assert.equal(result.buyable, false);
  assert.ok(result.plan.financeEvidence, '财务和估值已经通过，失败原因应限于趋势');
  assert.deepEqual(result.reasons, [
    'MA20 10.1 < MA60 10.2，要求MA20 ≥ MA60',
    'MA60 10.2 < 前一日 MA60 10.3，要求MA60 ≥ 前一日 MA60',
    '完整日线收盘价 10.08 < MA60 10.2，要求完整日线收盘价 ≥ MA60'
  ]);
  assert.doesNotMatch(result.reasons.join('；'), /ROE|负债率|现金流|PE|PB|财务|回踩/);
});

test('超短、短线和波段同时报告各项失败值，已通过项目不混入拒绝原因', () => {
  const cases = [
    ['ultra-short', { macd: 0, rsi: 49.5, volumeRatio: 3.2 }, [
      'MACD 柱 0 = 0，要求MACD 柱 > 0', 'RSI 49.5 < 50，要求RSI ≥ 50', '日量比 3.2 > 3，要求日量比 ≤ 3']],
    ['short', { previousMa20: 10.01, volumeRatio: 0.9 }, [
      'MA20 10 < 前一日 MA20 10.01，要求MA20 > 前一日 MA20', '日量比 0.9 < 1，要求日量比 ≥ 1']],
    ['swing', { ma60: 10, rsi: 76, volumeRatio: 0.5 }, [
      'MA20 10 = MA60 10，要求MA20 > MA60', 'RSI 76 > 75，要求RSI ≤ 75', '日量比 0.5 < 0.6，要求日量比 ≥ 0.6']]
  ];
  for (const [id, overrides, expected] of cases) {
    const result = fixture(overrides).evaluate(id);
    assert.equal(result.status, '等待趋势', id); assert.deepEqual(result.reasons, expected, id);
  }
});

test('原有严格和含等号的趋势边界保持不变，边界通过时仍能实际模拟建仓', () => {
  const cases = [
    ['long', { close: 10.08, ma20: 10.08, ma60: 10.08, previousMa60: 10.08 }, true],
    ['long', { ma20: 9.9499 }, false], ['long', { previousMa60: 9.9501 }, false], ['long', { close: 9.9499 }, false],
    ['ultra-short', { rsi: 50, volumeRatio: 1.2 }, true], ['ultra-short', { rsi: 75, volumeRatio: 3 }, true],
    ['ultra-short', { rsi: 49.9999 }, false], ['ultra-short', { rsi: 75.0001 }, false],
    ['ultra-short', { volumeRatio: 1.1999 }, false], ['ultra-short', { volumeRatio: 3.0001 }, false],
    ['ultra-short', { close: 10.05 }, false], ['ultra-short', { previousMa5: 10.05 }, false],
    ['ultra-short', { ma5: 10 }, false], ['ultra-short', { macd: 0 }, false],
    ['short', { close: 10.05, rsi: 45, volumeRatio: 1, macd: 0.000001 }, true],
    ['short', { rsi: 75 }, true], ['short', { rsi: 44.9999 }, false], ['short', { rsi: 75.0001 }, false],
    ['short', { volumeRatio: 0.9999 }, false], ['short', { previousMa20: 10 }, false],
    ['short', { close: 10.0499 }, false], ['short', { ma5: 10 }, false], ['short', { macd: 0 }, false],
    ['swing', { close: 10, rsi: 40, volumeRatio: 0.6, macd: 0.000001 }, true],
    ['swing', { rsi: 75 }, true], ['swing', { rsi: 39.9999 }, false], ['swing', { rsi: 75.0001 }, false],
    ['swing', { volumeRatio: 0.5999 }, false], ['swing', { ma60: 10 }, false],
    ['swing', { previousMa20: 10 }, false], ['swing', { close: 9.9999 }, false], ['swing', { macd: 0 }, false]
  ];
  for (const [id, overrides, buyable] of cases) {
    const f = fixture(overrides), before = structuredClone(f.engine.s), result = f.evaluate(id);
    const label = `${id}: ${JSON.stringify(overrides)}`;
    assert.equal(result.buyable, buyable, `${label}: ${result.reasons.join('；')}`);
    assert.deepEqual(f.engine.s, before, `诊断不应修改账户：${label}`);
    if (buyable) {
      f.engine.selectStrategy(symbol, id);
      const trade = f.engine.strategyEntry({ symbol, strategyId: id, quantity: 100 }, f.quote, f.snapshot);
      assert.equal(trade.quantity, 100, label); assert.equal(trade.strategyPlan.strategyId, id, label);
    } else {
      assert.equal(result.status, '等待趋势', label); assert.ok(result.reasons.length, label);
    }
  }
});

test('缺失或无效指标明确提示数据问题，不显示 NaN，也不使用财务或成交额文案', () => {
  for (const [id, overrides, label] of [
    ['long', { previousMa60: undefined }, '前一日 MA60'], ['ultra-short', { previousMa5: NaN }, '前一日 MA5'],
    ['short', { volumeRatio: undefined }, '日量比'], ['swing', { macd: NaN }, 'MACD 柱']
  ]) {
    const result = fixture(overrides).evaluate(id);
    assert.equal(result.status, '等待趋势', id);
    assert.ok(result.reasons.some(reason => reason.includes(`${label}缺失或无效`)), id);
    assert.doesNotMatch(result.reasons.join('；'), /NaN|undefined|财务|成交额|换手率/);
  }
});

test('小于六位小数的临界差异仍显示真实值，避免拒绝文案看起来已经满足条件', () => {
  const result = fixture({ rsi: 75.00000001 }).evaluate('short');
  assert.deepEqual(result.reasons, ['RSI 75.00000001 > 75，要求RSI ≤ 75']);
});

test('保留旧波段快照的趋势标记语义，诊断不会偷偷重算后放行', () => {
  const rejected = fixture({ trend: false }).evaluate('swing');
  assert.equal(rejected.status, '等待趋势');
  assert.deepEqual(rejected.reasons, ['完整日线趋势标记未通过，等待重新获取日线核验']);
  const oldSnapshot = fixture({ trend: true, previousMa20: undefined });
  assert.equal(oldSnapshot.evaluate('swing').buyable, true);
});

test('使用真实完整日线计算的长期下降趋势可定位失败均线与前一日数值', () => {
  const f = fixture();
  const bars = Array.from({ length: 80 }, (_, index) => {
    const close = 12 - index * 0.02;
    return { date: new Date(Date.UTC(2026, 6, 11 + index)).toISOString().slice(0, 10),
      open: close, close, high: close + 0.1, low: close - 0.1, volume: 100000 };
  });
  f.snapshot.technical = technicals(bars, now);
  f.quote.prevClose = f.snapshot.technical.close;
  const result = f.evaluate('long');
  assert.equal(result.status, '等待趋势'); assert.equal(result.reasons.length, 3);
  assert.match(result.reasons[0], /^MA20 [\d.]+ < MA60 [\d.]+/);
  assert.match(result.reasons[1], /^MA60 [\d.]+ < 前一日 MA60 [\d.]+/);
  assert.match(result.reasons[2], /^完整日线收盘价 [\d.]+ < MA60 [\d.]+/);
});
