'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Market } = require('../core/market.cjs');
const { parseSinaBars } = require('../core/market-parsers.cjs');
const { dailyIndicators } = require('../core/daily-indicators.cjs');
const { preparedHistoryValid } = require('../core/daily-history.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');

const NOW = Date.parse('2026-10-27T10:00:00+08:00'), SYMBOL = 'sh600004';
const json = value => ({ ok: true, json: async () => structuredClone(value) });
const http = status => ({ ok: false, status });
function rows() {
  const values = [];
  for (let at = Date.parse('2026-10-26T00:00:00Z'); values.length < 80; at -= 86400000) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (calendarSession(new Date(`${day}T10:00:00+08:00`)).open)
      values.unshift({ day, open: '10.00', close: '10.20', high: '10.30', low: '9.90', volume: '12345' });
  }
  return values;
}

test('新浪日线严格保留原始价格和股数，盘中当日K线由完整日线指标剔除', () => {
  const input = rows(); input.push({ day: '2026-10-27', open: '100', close: '120', high: '130', low: '90', volume: '3' });
  const bars = parseSinaBars(input, NOW);
  assert.deepEqual(bars[0], { date: input[0].day, open: 10, close: 10.2, high: 10.3, low: 9.9, volume: 12345 });
  assert.equal(bars.at(-1).date, '2026-10-27'); assert.equal(bars.at(-1).volume, 3);
  const daily = dailyIndicators(bars, new Date(NOW));
  assert.equal(daily.asOf, '2026-10-26'); assert.equal(daily.close, 10.2); assert.equal(daily.bars.length, 80);
});

test('新浪日线拒绝空包、非日级时间、非法数值、OHLC冲突及乱序重复日期', () => {
  const first = rows()[0];
  for (const invalid of [null, {}, [], [null], [[first.day, 10, 10.2, 10.3, 9.9, 100]],
    [{ ...first, day: '2026-02-30' }], [{ ...first, day: '2026-10-26 00:00:00' }],
    [{ ...first, day: '2026-10-26 15:00:00' }], [{ ...first, day: '2026-10-26T00:00:00Z' }],
    [{ ...first, close: '' }], [{ ...first, high: '10.1' }], [{ ...first, low: '10.1' }],
    [{ ...first, open: '-1' }], [{ ...first, close: 'NaN' }], [{ ...first, volume: '-1' }],
    [{ ...first, volume: null }], [{ ...first, volume: 'Infinity' }], [first, first], rows().reverse()]) {
    assert.throws(() => parseSinaBars(invalid, NOW), { code: 'invalid' });
  }
});

test('腾讯主日线失败后先用独立新浪源恢复沪深科创创业未复权历史', async () => {
  for (const symbol of [SYMBOL, 'sz000001', 'sh688533', 'sz300750']) {
    const calls = [];
    const market = new Market(async (url, options) => {
      calls.push(url);
      if (!url.includes('quotes.sina.cn')) return http(501);
      const query = new URL(url);
      assert.equal(query.protocol, 'https:'); assert.equal(query.searchParams.get('symbol'), symbol);
      assert.equal(query.searchParams.get('scale'), '240'); assert.equal(query.searchParams.get('ma'), 'no');
      assert.ok(Number(query.searchParams.get('datalen')) >= 120);
      assert.equal(options.headers.Referer, 'https://finance.sina.com.cn/');
      assert.equal(options.cache, 'no-store'); assert.ok(options.signal instanceof AbortSignal);
      return json(rows());
    }, { clock: () => NOW });
    const history = await market.strategyHistory(symbol, null, true);
    assert.equal(calls.length, 2); assert.match(calls[0], /proxy\.finance\.qq\.com/);
    assert.match(calls[1], /quotes\.sina\.cn/); assert.equal(history.provider, 'sina');
    assert.equal(history.source, '新浪财经'); assert.equal(history.adjustment, '未复权');
    assert.equal(history.bars.at(-1).volume, 12345); assert.equal(history.fetchedAt, NOW);
    assert.ok(preparedHistoryValid(history, symbol, 'stock', NOW));
  }
});

test('三种市场指数使用独立新浪未复权备用，股票入口仍不接受指数', async () => {
  for (const symbol of ['sh000001', 'sz399001', 'sz399006']) {
    const calls = [];
    const market = new Market(async url => {
      calls.push(url); return url.includes('quotes.sina.cn') ? json(rows()) : http(501);
    }, { clock: () => NOW });
    const history = await market.indexHistory(symbol);
    assert.equal(calls.length, 2); assert.equal(history.symbol, symbol); assert.equal(history.provider, 'sina');
    assert.ok(preparedHistoryValid(history, symbol, 'index', NOW));
  }
  const market = new Market(() => assert.fail('非法指数不能发起请求'), { clock: () => NOW });
  await assert.rejects(market.strategyHistory('sh000001'), /请输入/);
  await assert.rejects(market.indexHistory(SYMBOL), /仅支持/);
});

test('新浪未复权备用不替代前复权或分时，坏新浪数据仍可切换腾讯备用', async () => {
  const qfqCalls = [];
  const qfq = new Market(async url => { qfqCalls.push(url); return http(501); }, { clock: () => NOW });
  await assert.rejects(qfq.history(SYMBOL), /前复权日线获取失败/);
  assert.equal(qfqCalls.length, 3); assert.ok(qfqCalls.every(url => !url.includes('quotes.sina.cn')));
  const minuteCalls = [];
  const minute = new Market(async url => { minuteCalls.push(url); return http(501); }, { clock: () => NOW });
  await assert.rejects(minute.intraday(SYMBOL), /分时获取失败/);
  assert.equal(minuteCalls.length, 3); assert.ok(minuteCalls.every(url => !url.includes('quotes.sina.cn')));
  const calls = [];
  const raw = rows().map(row => [row.day, row.open, row.close, row.high, row.low, '10']);
  const market = new Market(async url => {
    calls.push(url);
    if (url.includes('proxy.finance.qq.com')) return http(501);
    if (url.includes('quotes.sina.cn')) return json([{ ...rows()[0], close: '' }]);
    return json({ code: 0, data: { [SYMBOL]: { day: raw } } });
  }, { clock: () => NOW });
  assert.equal((await market.strategyHistory(SYMBOL, null, true)).provider, 'tencent');
  assert.equal(calls.length, 3); assert.match(calls[2], /web\.ifzq\.gtimg\.cn/);
});

test('所有日线源失败时保留新浪有效缓存原时间，跨完整交易日不得复用', async () => {
  let now = NOW, offline = false; const calls = [];
  const market = new Market(async url => {
    calls.push(url); return !offline && url.includes('quotes.sina.cn') ? json(rows()) : http(501);
  }, { clock: () => now });
  const first = await market.strategyHistory(SYMBOL, null, true);
  offline = true; now += 1000; calls.length = 0;
  const cached = await market.strategyHistory(SYMBOL, null, true, true);
  assert.equal(calls.length, 4); assert.equal(cached.historyStatus, 'degraded');
  assert.match(cached.refreshError, /新浪财经/); assert.match(cached.refreshError, /quotes\.sina\.cn/);
  assert.equal(cached.fetchedAt, first.fetchedAt); assert.deepEqual(cached.bars, first.bars);
  assert.ok(preparedHistoryValid(cached, SYMBOL, 'stock', now));
  now = Date.parse('2026-10-27T15:01:00+08:00');
  await assert.rejects(market.strategyHistory(SYMBOL, null, true, true), /未复权日线获取失败/);
  assert.equal(preparedHistoryValid(cached, SYMBOL, 'stock', now), false);
});

test('新浪日线请求取消终止后续备用，服务器Retry-After仍约束显式重试', async () => {
  const controller = new AbortController(), cancelledCalls = [];
  const cancelled = new Market(async (url, options) => {
    cancelledCalls.push(url);
    if (!url.includes('quotes.sina.cn')) return http(501);
    controller.abort(); options.signal.throwIfAborted();
  }, { clock: () => NOW });
  await assert.rejects(cancelled.strategyHistory(SYMBOL, controller.signal, true), { name: 'AbortError' });
  assert.equal(cancelledCalls.length, 2); assert.equal(cancelled.dailyHistory.entries.size, 0);
  let now = NOW, sinaCalls = 0, recovered = false;
  const market = new Market(async url => {
    if (!url.includes('quotes.sina.cn')) return http(501);
    sinaCalls++;
    return recovered ? json(rows()) : { ...http(429), headers: { get: name => name.toLowerCase() === 'retry-after' ? '60' : null } };
  }, { clock: () => now });
  await assert.rejects(market.strategyHistory(SYMBOL, null, true, true), /HTTP 429/);
  recovered = true; now += 30001;
  await assert.rejects(market.strategyHistory(SYMBOL, null, true, true), /暂缓重试/);
  assert.equal(sinaCalls, 1); now += 30000;
  assert.equal((await market.strategyHistory(SYMBOL, null, true, true)).provider, 'sina');
  assert.equal(sinaCalls, 2);
});
