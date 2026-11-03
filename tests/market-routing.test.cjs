const test = require('node:test');
const assert = require('node:assert/strict');
const { Market, parseQuotes, parseSinaQuotes, parseEastmoneyBars, parseEastmoneyIntraday } = require('../core/market.cjs');
const { Engine, initialState } = require('../core/engine.cjs');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const { Screener, normalize, parseDescription } = require('../core/screener.cjs');
const now = Date.parse('2026-09-30T10:00:00+08:00'), symbol = 'sz000001';
const stock2 = 'sh600519';
const textResponse = text => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const jsonResponse = json => ({ ok: true, json: async () => json });
const http = status => ({ ok: false, status });
function tencent(s = symbol, changes = {}) {
  const a = Array(50).fill('');
  Object.assign(a, { 1: 'Test', 2: s.slice(2), 3: '10', 4: '9.9', 5: '9.95', 6: '123', 9: '9.99', 10: '3', 19: '10', 20: '4', 30: '20260930100000', 31: '.1', 32: '1.01', 33: '10.1', 34: '9.8', 37: '12.3', 47: '10.89', 48: '8.91', ...changes });
  return `v_${s}="${a.join('~')}";`;
}
function sina(s = symbol, changes = {}) {
  const a = Array(33).fill('0');
  Object.assign(a, { 0: 'Test', 1: '9.95', 2: '9.9', 3: '10', 4: '10.1', 5: '9.8', 8: '12345', 9: '123456.7', 10: '300', 11: '9.99', 20: '400', 21: '10', 30: '2026-09-30', 31: '10:00:00', ...changes });
  return `var hq_str_${s}="${a.join(',')}";`;
}
const raw = Array.from({ length: 80 }, (_, i) => [new Date(Date.UTC(2026, 6, 12 + i)).toISOString().slice(0, 10), '9.9', '10', '10.2', '9.8', '123']);
const txDaily = (bars = raw, qfq = true, s = symbol) => ({ code: 0, data: { [s]: { [qfq ? 'qfqday' : 'day']: bars } } });
const emDaily = (bars = raw, s = symbol) => ({ rc: 0, data: { code: s.slice(2), market: s.startsWith('sh') ? 1 : 0, klines: bars.map(a => a.join(',')) } });
const emMinute = (lines = ['2026-09-30 09:30,10,10,10,10,12,12000,10', '2026-09-30 09:31,10,10.01,10.01,10,3,3003,10']) => ({ rc: 0, data: { code: '000001', market: 0, preClose: 9.9, trends: lines } });
const marketWith = (fetcher, options) => new Market(fetcher, { clock: () => now, ...options });

test('新浪盘口与成交量以股计，不推算涨跌停；日期和空字段严格解析', () => {
  const q = parseSinaQuotes(sina(), now)[symbol];
  assert.equal(q.source, '新浪财经'); assert.equal(q.volume, 12345); assert.equal(q.bidSize, 300); assert.equal(q.askSize, 400);
  assert.equal(q.timestamp, now); assert.equal(q.limitUp, null); assert.equal(q.limitDown, null); assert.equal(q.canTrade, false);
  assert.match(q.tradeBlockedReason, /缺少涨跌停/);
  assert.deepEqual(parseSinaQuotes(sina(symbol, { 30: '2026-02-30' })), {});
  assert.deepEqual(parseSinaQuotes(sina(symbol, { 31: '25:00:00' })), {});
  assert.equal(parseQuotes(tencent(symbol, { 20: '' }), now)[symbol].askSize, null);
  assert.equal(parseQuotes(tencent(symbol, { 20: '' }), now)[symbol].canTrade, false);
});

test('腾讯正常时不请求新浪；首选失败后新浪补整份报价并使用对应 Referer', async () => {
  const urls = [];
  const market = marketWith(async (url, options) => {
    urls.push(url); assert.equal(options.headers.Referer, url.includes('sinajs') ? 'https://finance.sina.com.cn/' : 'https://gu.qq.com/');
    return textResponse(url.includes('sinajs') ? sina() : tencent());
  });
  assert.equal((await market.quotes([symbol, symbol]))[symbol].provider, 'tencent'); assert.equal(urls.length, 1);
  market.fetcher = async url => { urls.push(url); return url.includes('gtimg') ? http(501) : textResponse(sina()); };
  const fallback = (await market.quotes([symbol]))[symbol];
  assert.equal(fallback.provider, 'sina'); assert.equal(fallback.limitUp, null); assert.equal(urls.length, 3);
});

test('部分缺失只补请求缺失标的，单只股票的字段不会跨源拼接', async () => {
  const urls = [];
  const market = marketWith(async url => { urls.push(url); return textResponse(url.includes('gtimg') ? tencent() : sina(stock2) + sina(symbol, { 3: '999' })); });
  const data = await market.quotes([symbol, stock2]);
  assert.equal(data[symbol].price, 10); assert.equal(data[symbol].provider, 'tencent');
  assert.equal(data[stock2].provider, 'sina'); assert.equal(data[stock2].limitUp, null);
  assert.equal(urls[1], `https://hq.sinajs.cn/list=${stock2}`);
});

test('盘中过期报价尝试另一来源，未来报价拒绝，旧报价不改写其时间', async () => {
  const market = marketWith(async url => textResponse(url.includes('gtimg') ? tencent(symbol, { 30: '20260930095500' }) : sina()));
  assert.equal((await market.quotes([symbol]))[symbol].provider, 'sina');
  market.fetcher = async url => textResponse(url.includes('gtimg') ? tencent(symbol, { 30: '20260930110000' }) : sina());
  assert.equal((await market.quotes([symbol]))[symbol].provider, 'sina');
  market.fetcher = async url => url.includes('gtimg') ? textResponse(tencent(symbol, { 30: '20260930095500' })) : http(503);
  const stale = (await market.quotes([symbol]))[symbol]; assert.equal(stale.time, '09:55:00');
  assert.throws(() => new Engine(initialState(), () => new Date(now)).execute({ symbol, side: 'buy', quantity: 100 }, stale), /报价过期/);
});

test('报价故障有冷却，其他能力不受影响，到期后自动恢复主源', async () => {
  let time = now, calls = 0, offline = true;
  const market = marketWith(async url => {
    if (url.includes('qt.gtimg')) { calls++; if (offline) return http(501); return textResponse(tencent()); }
    if (url.includes('sinajs')) return textResponse(sina());
    return jsonResponse(txDaily());
  }, { clock: () => time });
  await market.quotes([symbol]); await market.quotes([symbol]); assert.equal(calls, 1);
  assert.equal((await market.history(symbol)).provider, 'tencent');
  offline = false; time += 30001;
  assert.equal((await market.quotes([symbol]))[symbol].provider, 'tencent'); assert.equal(calls, 2);
});

test('新浪展示行情不能手动成交、触发条件单或自动风控成交', () => {
  const engine = new Engine(initialState(), () => new Date(now)), q = parseSinaQuotes(sina(), now)[symbol];
  const before = engine.s.cash;
  assert.throws(() => engine.execute({ symbol, side: 'buy', quantity: 100 }, q), /仅供展示/);
  const order = engine.place({ symbol, side: 'buy', quantity: 100, limit: 10.1 });
  engine.tick({ [symbol]: q }); assert.equal(order.status, 'pending'); assert.match(order.note, /仅供展示/);
  assert.equal(engine.s.cash, before); assert.equal(engine.s.trades.length, 0);
  engine.execute({ symbol, side: 'buy', quantity: 100 }, parseQuotes(tencent(), now)[symbol]);
  engine.s.lots.forEach(l => { l.date = '2026-09-29'; });
  engine.setRisk(symbol, { stop: 9.95, target: '', trailing: 0, enabled: true });
  engine.tick({ [symbol]: { ...q, price: 9.8 } });
  assert.equal(engine.s.trades.length, 1); assert.match(engine.s.risks[symbol].note, /仅供展示/);
});

test('盘口缺失、非有限数量及时间倒退不得再次消耗一档', () => {
  const engine = new Engine(initialState(), () => new Date(now)), q = parseQuotes(tencent(), now)[symbol];
  for (const askSize of [NaN, undefined, null, -1, Infinity]) assert.throws(() => engine.execute({ symbol, side: 'buy', quantity: 100 }, { ...q, askSize }), /数量不足/);
  engine.execute({ symbol, side: 'buy', quantity: 300 }, q);
  const saved = structuredClone(engine.s);
  assert.throws(() => engine.execute({ symbol, side: 'buy', quantity: 200 }, q), /数量不足/);
  assert.throws(() => engine.execute({ symbol, side: 'buy', quantity: 100 }, { ...q, timestamp: now - 1000 }), /数量不足/);
  assert.deepEqual(engine.s, saved); assert.equal(engine.s.trades[0].quoteSource, '腾讯财经');
});

test('优先日线来源不可用后东财以明确 fqt 参数返回整段日线及来源', async () => {
  for (const adjustment of ['qfq', 'raw']) {
    const urls = [];
    const market = marketWith(async (url, options) => {
      urls.push(url);
      if (!url.includes('eastmoney')) return http(501);
      const params = new URL(url).searchParams;
      assert.equal(params.get('fqt'), adjustment === 'qfq' ? '1' : '0'); assert.equal(params.get('klt'), '101');
      assert.equal(params.get('secid'), '0.000001'); assert.equal(options.headers.Referer, 'https://quote.eastmoney.com/');
      return jsonResponse(emDaily());
    });
    const data = adjustment === 'qfq' ? await market.history(symbol) : await market.strategyHistory(symbol, null, true);
    assert.equal(data.source, '东方财富'); assert.equal(data.provider, 'eastmoney'); assert.equal(urls.length, adjustment === 'qfq' ? 3 : 4);
    assert.equal(data.bars[0].volume, 12300); assert.equal(data.bars[0].close, 10);
    assert.equal(data.adjustment, adjustment === 'qfq' ? '前复权' : '未复权');
  }
});

test('切换日线来源整段替换缓存，不填补其他来源的日期或复权字段', async () => {
  const market = marketWith(async () => jsonResponse(txDaily()));
  assert.equal((await market.history(symbol)).bars.length, 80);
  market.fetcher = async url => url.includes('eastmoney') ? jsonResponse(emDaily(raw.slice(-40).map(a => [a[0], '20', '21', '22', '19', '10']))) : http(501);
  const next = await market.history(symbol, true);
  assert.equal(next.bars.length, 40); assert.ok(next.bars.every(b => b.close === 21)); assert.equal(next.source, '东方财富');
  assert.equal(await market.history(symbol), next);
});

test('东财响应代码、市场、日期顺序、OHLC 与成交量异常均拒绝', () => {
  const bad = [
    { ...emDaily(), rc: 1 }, { rc: 0, data: { ...emDaily().data, code: '600519' } }, { rc: 0, data: { ...emDaily().data, market: 1 } },
    emDaily([...raw, raw.at(-1)]), emDaily(raw.slice().reverse()), emDaily([['2026-02-30',10,10,10,10,1]]),
    emDaily([['2026-09-29',10,11,10,9,1]]), emDaily([['2026-09-29',10,10,11,9,'']]), emDaily([['2026-09-29',10,10,11,9,-1]])
  ];
  for (const data of bad) assert.throws(() => parseEastmoneyBars(data, symbol, now));
  assert.equal(parseEastmoneyBars(emDaily([...raw, ['2026-10-01',10,10,11,9,1]]), symbol, now).length, 80);
});

test('单只股票数据缺失不会熔断整个渠道', async () => {
  let goodCalls = 0;
  const market = marketWith(async url => {
    if (url.includes(stock2)) { goodCalls++; return jsonResponse(txDaily(raw, false, stock2)); }
    return jsonResponse({ code: 0, data: {} });
  });
  await assert.rejects(market.strategyHistory(symbol), { code: 'invalid' });
  assert.equal((await market.strategyHistory(stock2)).length, 80); assert.equal(goodCalls, 1);
});

test('日线各入口超时后切换，取消会终止后续入口', async () => {
  const urls = [];
  const market = marketWith(async (url, options) => {
    urls.push(url);
    if (url.includes('eastmoney')) return jsonResponse(emDaily());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('test request did not abort')), 1000);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
    });
  }, { requestTimeoutMs: 5 });
  assert.equal((await market.strategyHistory(symbol, null, true)).provider, 'eastmoney'); assert.equal(urls.length, 4);
  const controller = new AbortController(); let calls = 0;
  const cancel = marketWith(async () => { calls++; controller.abort(); return http(501); });
  await assert.rejects(cancel.strategyHistory(symbol, controller.signal), { name: 'AbortError' }); assert.equal(calls, 1);
  assert.equal(cancel.failures.size, 0);
});

test('Retry-After 等待期间手动强刷也不重复访问限流入口', async () => {
  let time = now, primaryCalls = 0;
  const market = marketWith(async url => {
    if (url.includes('proxy.finance')) { primaryCalls++; return { ...http(429), headers: { get: () => '60' } }; }
    return jsonResponse(txDaily());
  }, { clock: () => time });
  await market.history(symbol, true); time += 30001; await market.history(symbol, true); assert.equal(primaryCalls, 1);
  time += 30000; await market.history(symbol, true); assert.equal(primaryCalls, 2);
});

test('重新核验策略日线绕过普通故障冷却，自动检查仍等待冷却恢复', async () => {
  let recovered = false, calls = 0;
  const market = marketWith(async () => {
    calls++;
    return recovered ? jsonResponse(txDaily(raw, false)) : http(503);
  });
  await assert.rejects(market.strategyHistory(symbol), /HTTP 503/);
  assert.equal(calls, 4);
  recovered = true;
  const monitor = new StrategyMonitor(market, () => new Date(now));
  const automatic = await monitor.load(symbol);
  assert.match(automatic.error, /暂缓重试/); assert.equal(calls, 4);
  const explicit = await monitor.load(symbol, true);
  assert.equal(explicit.error, undefined); assert.equal(explicit.technical.asOf, '2026-09-29');
  assert.equal(explicit.provider, 'tencent'); assert.equal(calls, 5);
});

test('重新核验策略日线仍遵守服务端 Retry-After，到期后取得新日线', async () => {
  let time = now, recovered = false, calls = 0;
  const market = marketWith(async () => {
    calls++;
    return recovered ? jsonResponse(txDaily(raw, false)) : { ...http(429), headers: { get: () => '60' } };
  }, { clock: () => time });
  const monitor = new StrategyMonitor(market, () => new Date(time));
  assert.match((await monitor.load(symbol)).error, /HTTP 429/); assert.equal(calls, 4);
  recovered = true; time += 30001;
  assert.match((await monitor.load(symbol, true)).error, /暂缓重试/); assert.equal(calls, 4);
  time += 30000;
  const retried = await monitor.load(symbol, true);
  assert.equal(retried.error, undefined); assert.equal(retried.technical.asOf, '2026-09-29');
  assert.equal(retried.fetchedAt, time); assert.equal(calls, 5);
});

test('东财分时每分钟手数转为累计股数，带独立日期、昨收及来源', async () => {
  const market = marketWith(async url => url.includes('eastmoney') ? jsonResponse(emMinute()) : http(503));
  const data = await market.intraday(symbol);
  assert.equal(data.source, '东方财富'); assert.equal(data.date, '20260930'); assert.equal(data.prevClose, 9.9);
  assert.deepEqual(data.points, [{ time: '0930', price: 10, volume: 1200 }, { time: '0931', price: 10.01, volume: 1500 }]);
  assert.throws(() => parseEastmoneyIntraday(emMinute(['2026-09-29 09:30,10,10,10,10,1', '2026-09-30 09:31,10,10,10,10,1']), symbol, now), /多个交易日/);
  assert.throws(() => parseEastmoneyIntraday(emMinute(['2026-09-30 09:30,10,10,10,10,-1']), symbol, now), /成交量/);
});

test('策略与技术筛选记录真实日线来源，保留股票池估值来源', async () => {
  const market = marketWith(async url => url.includes('eastmoney') ? jsonResponse(emDaily()) : http(501));
  const monitor = new StrategyMonitor(market, () => new Date(now));
  const snapshot = await monitor.load(symbol); assert.equal(snapshot.source, '东方财富'); assert.equal(snapshot.technical.asOf, '2026-09-29');
  const screener = new Screener(async () => { throw Error('unexpected snapshot fetch'); }, null, (s, signal) => market.strategyHistory(s, signal, true), () => new Date(now));
  const row = normalize({ f12: '000001', f13: 0, f14: 'Test', f2: 10, f9: 12, f124: now / 1000 });
  const data = { rows: [row], source: '东方财富公开行情', fetchedAt: now };
  const result = await screener.scanDaily(data, parseDescription('MA20大于0').query, [], true, new AbortController().signal);
  assert.equal(result.source, data.source); assert.equal(result.rows[0].technicalSource, '东方财富');
  assert.match(result.technicalScan.source, /东方财富/); assert.equal(result.rows[0].pe, 12);
  assert.equal(data.rows[0].technicalSource, undefined);
});

test('大股票池报价分批有界，并发调用共享限流且持仓报价不排在全部候选后', async () => {
  const symbols = Array.from({ length: 421 }, (_, index) => `sh${600001 + index}`), calls = [], releases = [];
  let active = 0, peak = 0;
  const market = marketWith(async url => {
    const requested = url.split('=').at(-1).split(','); calls.push(requested);
    active++; peak = Math.max(peak, active);
    if (calls.length <= 3) await new Promise(resolve => releases.push(resolve));
    else await new Promise(resolve => setImmediate(resolve));
    active--; return textResponse(requested.map(s => tencent(s)).join(''));
  });
  const bulk = market.quotes([...symbols, symbols[0]]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3);
  const holding = market.quotes([symbol]);
  for (const release of releases) release();
  const [all, one] = await Promise.all([bulk, holding]);
  assert.equal(Object.keys(all).length, symbols.length); assert.ok(one[symbol]);
  assert.equal(peak, 3); assert.ok(calls.every(batch => batch.length <= 80));
  assert.equal(calls.findIndex(batch => batch.includes(symbol)), 3, '后续持仓请求先于剩余批量请求获得并发名额');
  assert.equal(market.quoteActive, 0); assert.equal(market.quoteWaiters.length, 0);
});

test('分批报价保留已成功批次，缺失股票逐批补源且无效批次不熔断其他标的', async () => {
  const symbols = Array.from({ length: 181 }, (_, index) => `sh${600001 + index}`), calls = [];
  const market = marketWith(async url => {
    const requested = url.split('=').at(-1).split(','); calls.push({ url, requested });
    const parsed = url.includes('gtimg') ? requested.slice(1).map(s => tencent(s)) : requested.map(s => sina(s));
    return textResponse(parsed.join(''));
  });
  const all = await market.quotes(symbols);
  assert.equal(Object.keys(all).length, symbols.length);
  assert.equal(calls.filter(call => call.url.includes('sinajs')).length, 3);
  assert.ok(calls.filter(call => call.url.includes('sinajs')).every(call => call.requested.length === 1));
  assert.equal(all[symbols[0]].provider, 'sina'); assert.equal(all[symbols[1]].provider, 'tencent');
  assert.equal(all[symbols[0]].canTrade, false);
});
