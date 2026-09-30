const test = require('node:test');
const assert = require('node:assert/strict');
const { Market } = require('../core/market.cjs');

const primary = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/';
const backup = 'https://web.ifzq.gtimg.cn/appstock/app/';
const symbol = 'sh688533';
const raw = Array.from({ length: 40 }, (_, i) => [new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10), '10', '11', '12', '9', '123']);
const json = data => ({ ok: true, json: async () => ({ code: 0, data: { [symbol]: data } }) });
const httpError = status => ({ ok: false, status });

test('腾讯网关保持前复权、未复权和分时的参数、价格与成交量口径', async () => {
  const calls = [];
  const market = new Market(async (url, options) => {
    calls.push(url);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Referer, 'https://gu.qq.com/');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.includes('minute/query')) return json({ data: { date: '20250101', data: ['0930 11 123', '1501 12 456'] } });
    return json(url.endsWith('qfq') ? { qfqday: raw } : { day: raw });
  });
  const history = await market.history(symbol);
  assert.equal(history.adjustment, '前复权');
  assert.deepEqual(history.bars[0], { date: '2025-01-01', open: 10, close: 11, high: 12, low: 9, volume: 12300 });
  assert.deepEqual(await market.strategyHistory(symbol), history.bars);
  const minute = await market.intraday(symbol);
  assert.equal(minute.date, '20250101'); assert.equal(minute.source, '腾讯财经');
  assert.deepEqual(minute.points, [{ time: '0930', price: 11, volume: 12300 }]);
  assert.deepEqual(calls, [primary + `fqkline/get?param=${symbol},day,,,640,qfq`, primary + `fqkline/get?param=${symbol},day,,,120,`, primary + `minute/query?code=${symbol}`]);
  assert.equal(await market.history(symbol), history);
  assert.equal(calls.length, 3);
});

test('501 和临时服务错误最多切换一次腾讯备用入口，保留完整参数', async () => {
  for (const status of [429, 500, 501, 502, 503, 504]) {
    const calls = []; let released = 0;
    const market = new Market(async url => {
      calls.push(url);
      return calls.length === 1 ? { ...httpError(status), body: { cancel: async () => { released++; } } } : json({ qfqday: raw });
    });
    assert.equal((await market.history(symbol)).bars.length, 40);
    assert.deepEqual(calls, [primary + `fqkline/get?param=${symbol},day,,,640,qfq`, backup + `fqkline/get?param=${symbol},day,,,640,qfq`]);
    assert.equal(released, 1);
  }
});

test('网络连接失败可切换备用入口，未复权与分时仍分别解析', async () => {
  for (const method of ['strategyHistory', 'intraday']) {
    const calls = [];
    const market = new Market(async url => {
      calls.push(url);
      if (calls.length === 1) throw TypeError('fetch failed');
      return json(method === 'strategyHistory' ? { day: raw } : { data: { date: '20250101', data: ['0930 11 123'] } });
    });
    const result = await market[method](symbol);
    assert.ok(method === 'strategyHistory' ? result.length === 40 : result.points.length === 1);
    assert.equal(calls[1], calls[0].replace(primary, backup));
  }
});

test('全部入口失败时返回接口及主机信息，不把缓存伪装成本次成功', async () => {
  const market = new Market(async () => json({ qfqday: raw }));
  const previous = await market.history(symbol);
  let calls = 0;
  market.fetcher = async () => httpError(++calls === 1 ? 501 : 503);
  await assert.rejects(market.history(symbol, true), error => {
    assert.match(error.message, /前复权日线获取失败/);
    assert.match(error.message, /HTTP 501（proxy\.finance\.qq\.com）/);
    assert.match(error.message, /HTTP 503（web\.ifzq\.gtimg\.cn）/);
    assert.match(error.message, /HTTP 503（push2his\.eastmoney\.com）/);
    return true;
  });
  assert.equal(calls, 3);
  assert.equal(market.cache.get(symbol), previous);
});

test('请求错误和权限错误不触发备用请求', async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    const market = new Market(async () => { calls++; return httpError(status); });
    await assert.rejects(market.strategyHistory(symbol), new RegExp(`未复权日线获取失败.*HTTP ${status}`));
    assert.equal(calls, 1);
  }
});

test('已取消的日线请求不访问网络', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const market = new Market(async () => { calls++; return json({ day: raw }); });
  await assert.rejects(market.strategyHistory(symbol, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('首个请求期间取消不会启动备用请求', async () => {
  let calls = 0;
  const controller = new AbortController();
  const market = new Market(async (url, options) => {
    calls++; controller.abort();
    assert.equal(options.signal.aborted, true);
    return httpError(501);
  });
  await assert.rejects(market.strategyHistory(symbol, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('取消信号传递至备用请求，各入口超时后有界结束', async () => {
  const controller = new AbortController(); let calls = 0;
  const market = new Market(async (url, options) => {
    if (++calls === 1) return httpError(501);
    controller.abort(); options.signal.throwIfAborted();
  });
  await assert.rejects(market.strategyHistory(symbol, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 2);
  calls = 0;
  market.fetcher = async () => { calls++; throw new DOMException('timeout', 'TimeoutError'); };
  await assert.rejects(market.intraday(symbol), /分时获取失败.*timeout/);
  assert.equal(calls, 3);
});

test('所有来源格式错误或复权字段不符时拒绝返回日线', async () => {
  let calls = 0;
  const market = new Market(async () => { calls++; return { ok: true, json: async () => { throw SyntaxError('invalid JSON'); } }; });
  await assert.rejects(market.history(symbol), /invalid JSON/);
  assert.equal(calls, 3);
  calls = 0;
  market.fetcher = async () => { calls++; return json({ qfqday: raw }); };
  await assert.rejects(market.strategyHistory(symbol), /未收到未复权日线/);
  assert.equal(calls, 3);
  assert.equal(market.cache.size, 0);
});

test('实时报价只在腾讯与新浪报价之间切换', async () => {
  const calls = [];
  const market = new Market(async url => { calls.push(url); return httpError(501); });
  await assert.rejects(market.quotes([symbol, symbol]), /HTTP 501（qt\.gtimg\.cn）/);
  assert.deepEqual(calls, [`https://qt.gtimg.cn/q=${symbol}`, `https://hq.sinajs.cn/list=${symbol}`]);
});
