const test = require('node:test');
const assert = require('node:assert/strict');
const { Market } = require('../core/market.cjs');
const { analyze } = require('../core/analysis.cjs');
const { dailyIndicators } = require('../core/daily-indicators.cjs');

const symbol = 'sh600519', now = new Date('2026-10-26T10:00:00+08:00');
const bars = count => Array.from({ length: count }, (_, i) => ({
  date: new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10),
  open: 10 + i, close: 10 + i, high: 11 + i, low: 9 + i, volume: 100 + i
}));

test('看盘接受一根前复权日线，保留价格与来源并正常复用缓存', async () => {
  let calls = 0;
  const market = new Market(async () => {
    calls++;
    return { ok: true, json: async () => ({ code: 0, data: { [symbol]: { qfqday: [['2026-10-26', '10', '11', '12', '9', '123']] } } }) };
  }, { clock: () => now.getTime() });
  const history = await market.history('600519');
  assert.equal(history.adjustment, '前复权'); assert.equal(history.source, '腾讯财经');
  assert.deepEqual(history.bars, [{ date: '2026-10-26', open: 10, close: 11, high: 12, low: 9, volume: 12300 }]);
  assert.equal(await market.history(symbol), history); assert.equal(calls, 1);
  const analysis = analyze(history.bars, null, now);
  assert.equal(analysis.count, 0); assert.equal(analysis.asOf, null); assert.equal(analysis.close, null);
  for (const key of ['ma5', 'ma20', 'ma60', 'rsi', 'atr', 'dif', 'dea', 'macd', 'volRatio']) assert.equal(analysis[key], null, key);
  assert.match(analysis.error, /不足 60 根/); assert.equal(analysis.forecast, undefined);
});

test('看盘短历史仍拒绝缺失或无效价格，不能把坏数据当成新股行情', async () => {
  for (const raw of [[], [['2026-10-26', '10', '11', '9', '12', '123']]]) {
    const market = new Market(async () => ({ ok: true, json: async () => ({ code: 0, data: { [symbol]: { qfqday: raw } } }) }), { clock: () => now.getTime() });
    await assert.rejects(market.history(symbol), /前复权日线获取失败/);
    assert.equal(market.cache.size, 0);
  }
});

test('基础指标逐项等待足够完整日线，未满足的指标返回空缺', () => {
  const thresholds = { ma5: 5, ma20: 20, ma60: 60, rsi: 15, atr: 15, dif: 26, dea: 34, macd: 34, volRatio: 21 };
  for (const [key, required] of Object.entries(thresholds)) {
    assert.equal(analyze(bars(required - 1), null, now)[key], null, `${key} needs ${required} bars`);
    assert.ok(Number.isFinite(analyze(bars(required), null, now)[key]), `${key} becomes available`);
  }
  const a = analyze(bars(20), null, now);
  assert.equal(a.ma5, 27); assert.equal(a.ma20, 19.5); assert.equal(a.ma60, null);
  assert.equal(a.rsi, 100); assert.equal(a.atr, 2); assert.equal(a.count, 20);
  assert.equal(a.asOf, '2026-06-20'); assert.equal(a.close, 29);
});

test('盘中日K可以画出，但不参与基础指标、技术评分或预测', () => {
  const complete = bars(19), unfinished = { date: '2026-10-26', open: 500, close: 999, high: 1000, low: 400, volume: 1000000 };
  assert.deepEqual(analyze([...complete, unfinished], null, now), analyze(complete, null, now));
  const closed = analyze([...complete, unfinished], null, new Date('2026-10-26T15:00:00+08:00'));
  assert.equal(closed.count, 20); assert.equal(closed.asOf, '2026-10-26');
  assert.ok(Number.isFinite(closed.ma20)); assert.equal(closed.forecast, undefined);
});

test('展示门槛放宽不放宽评分、预测与自动交易策略的完整样本要求', () => {
  const short = analyze(bars(59), null, now);
  assert.match(short.error, /不足 60 根/);
  for (const key of ['score', 'signal', 'plan', 'forecast', 'validation']) assert.equal(short[key], undefined, key);
  const full = analyze(bars(60), null, now);
  assert.equal(full.error, undefined); assert.equal(full.ma60, 39.5); assert.equal(full.score, 70);
  assert.ok(full.forecast); assert.ok(full.plan); assert.equal(full.validation.count, 0);
  assert.throws(() => dailyIndicators(bars(60), now), /完整未复权日线不足 61 根/);
  assert.equal(dailyIndicators(bars(61), now).bars.length, 61);
});
