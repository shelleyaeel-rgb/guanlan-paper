const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { FreeScreenerSource } = require('../core/screener-sources.cjs');
const { TENCENT_SCREEN_SOURCE } = require('../core/screener-tencent.cjs');

const mainSymbols = count => Array.from({ length: count }, (_, i) => `sh${600001 + i}`);
function quote(symbol, changes = {}) {
  const values = Array(88).fill('');
  Object.assign(values, {
    0: symbol.startsWith('sh') ? '1' : '51', 1: `Tencent-${symbol}`, 2: symbol.slice(2),
    3: '12.50', 30: '20250930150000', 32: '-1.25', 36: symbol.startsWith('sh688') ? '2000000' : '20000',
    37: '25000', 38: '3.5', 39: '99', 43: '4.5', 44: '80', 45: '100', 46: '2', 49: '1.5',
    52: '15', 53: '88', 57: '25000.1234',
    61: symbol.startsWith('sh688') ? 'GP-A-KCB' : /^sz30/.test(symbol) ? 'GP-A-CYB' : 'GP-A', ...changes
  });
  return `v_${symbol}="${values.join('~')}";\n`;
}
const jsonResponse = value => new Response(JSON.stringify(value));
const textResponse = text => new Response(text);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(symbols = ['sh600001'], options = {}) {
  const list = symbols.map(symbol => ({ symbol, code: symbol.slice(2), name: 'Sina-ST-name', trade: '999', per: '999', pb: '999', volume: '999', ticktime: '09:00:00' }));
  const calls = [];
  const controls = { intercept: null, count: (number) => String(list.length), page: rows => rows, quotes: values => values.map(s => quote(s)).join('') };
  let counts = 0;
  const fetcher = async (url, request) => {
    const parsed = new URL(url);
    const call = { url: parsed, request, at: Date.now() }; calls.push(call);
    if (controls.intercept) {
      const response = await controls.intercept(call);
      if (response !== undefined) return response;
    }
    if (parsed.pathname.endsWith('getHQNodeStockCount')) return jsonResponse(controls.count(++counts));
    if (parsed.pathname.endsWith('getHQNodeData')) {
      const page = Number(parsed.searchParams.get('page'));
      return jsonResponse(controls.page(list.slice((page - 1) * 80, page * 80), page));
    }
    assert.equal(parsed.hostname, 'qt.gtimg.cn');
    const requested = parsed.pathname.slice('/q='.length).split(',');
    return textResponse(controls.quotes(requested));
  };
  return { source: new FreeScreenerSource(fetcher, { spacingMs: 0, ...options }), controls, calls, list };
}
const byEndpoint = (f, endpoint) => f.calls.filter(call => call.url.pathname.endsWith(endpoint));
const quoteCalls = f => f.calls.filter(call => call.url.hostname === 'qt.gtimg.cn');

test('名单补证可显式获取UTF8原文，保留中文且不误当JSON或GB18030解码', async () => {
  const body = '<html>证券代码：001381；上市状态：待上市</html>';
  const source = new FreeScreenerSource(async () => new Response(body), { spacingMs: 0 });
  assert.equal(await source.request('https://data.eastmoney.com/xg/xg/detail/001381.html', new AbortController().signal, 'utf8'), body);
});

test('新浪按80条分页取得完整代码池，腾讯按50只批量取指标，排除不支持代码并保留完整来源', async () => {
  const supported = [...mainSymbols(161), 'sh688001', 'sz000001', 'sz300001'];
  const symbols = ['bj920001', 'sh510300', ...supported, 'sz302132'].sort();
  const f = fixture(symbols), progress = [], before = JSON.stringify(f.list);
  const result = await f.source.load({ onProgress: value => progress.push({ ...value }) });
  assert.deepEqual(result.rows.map(row => row.symbol), supported);
  assert.equal(result.source, TENCENT_SCREEN_SOURCE); assert.equal(result.sourceCount, 167); assert.equal(result.excludedCount, 3);
  assert.ok(Number.isSafeInteger(result.startedAt)); assert.ok(result.fetchedAt >= result.startedAt);
  assert.equal(byEndpoint(f, 'getHQNodeStockCount').length, 3);
  const pages = byEndpoint(f, 'getHQNodeData'); assert.equal(pages.length, 3);
  for (const [i, call] of pages.entries()) {
    assert.equal(call.url.searchParams.get('node'), 'hs_a'); assert.equal(call.url.searchParams.get('num'), '80');
    assert.equal(call.url.searchParams.get('sort'), 'symbol'); assert.equal(call.url.searchParams.get('asc'), '1');
    assert.equal(call.url.searchParams.get('page'), String(i + 1));
  }
  const batches = quoteCalls(f).map(call => call.url.pathname.slice('/q='.length).split(','));
  assert.deepEqual(batches.map(batch => batch.length), [50, 50, 50, 14]); assert.deepEqual(batches.flat(), supported);
  for (const row of result.rows) {
    assert.equal(row.name, `Tencent-${row.symbol}`); assert.equal(row.isST, false);
    assert.equal(row.price, 12.5); assert.equal(row.pe, 15); assert.equal(row.pb, 2); assert.equal(row.volume, 2);
    assert.equal(row.amount, 2.50001234); assert.equal(row.timestamp, Date.parse('2025-09-30T15:00:00+08:00'));
  }
  assert.deepEqual(progress.filter(p => p.stage === 'universe' && p.total).map(p => p.completed), [0, 1, 2, 3]);
  assert.deepEqual(progress.filter(p => p.stage === 'screen-quotes').map(p => p.completed), [0, 50, 100, 150, 164]);
  assert.equal(progress.at(-1).total, supported.length);
  assert.equal(JSON.stringify(f.list), before);
  assert.ok(f.calls.every(call => call.request.cache === 'no-store' && call.request.signal instanceof AbortSignal));
  assert.ok(f.calls.every(call => ['vip.stock.finance.sina.com.cn', 'qt.gtimg.cn'].includes(call.url.hostname)));
});

test('最后一页与报价批次边界不多取一页或空批次', async () => {
  for (const size of [1, 50, 80, 81, 100, 160]) {
    const f = fixture(mainSymbols(size)), result = await f.source.load();
    assert.equal(result.rows.length, size);
    assert.equal(byEndpoint(f, 'getHQNodeData').length, Math.ceil(size / 80));
    assert.equal(quoteCalls(f).length, Math.ceil(size / 50));
  }
});

test('新浪有估值时也不填补腾讯缺失指标，不使用新浪名称或时分秒作为报价时间', async () => {
  const f = fixture(); f.controls.quotes = symbols => symbols.map(s => quote(s, { 3: '', 30: '', 52: '', 49: '' })).join('');
  const [row] = (await f.source.load()).rows;
  assert.equal(row.price, null); assert.equal(row.pe, null); assert.equal(row.volumeRatio, null); assert.equal(row.timestamp, null);
  assert.equal(row.name, 'Tencent-sh600001'); assert.equal(row.isST, false);
});

test('总数格式错误和非JSON响应拒绝，不能把接口异常当作空股票池', async () => {
  for (const value of [null, true, {}, [], 0, -1, 15001, 1.5, '1.5', 'abc', '']) {
    const f = fixture(); f.controls.count = () => value;
    await assert.rejects(f.source.load(), /总数无效/); assert.equal(f.calls.length, 1);
  }
  const f = fixture(); f.controls.intercept = () => textResponse('<html>service unavailable</html>');
  await assert.rejects(f.source.load(), /有效 JSON/); assert.equal(f.calls.length, 1);
});

test('列表结构、代码格式、排序及重复异常立即拒绝，不重试或取腾讯报价', async () => {
  const cases = [
    { change: () => ({}), error: /格式无效/ },
    { change: rows => [null, rows[1]], error: /代码格式/ },
    { change: rows => [{ ...rows[0], symbol: 'sh60001' }, rows[1]], error: /代码格式/ },
    { change: rows => [{ ...rows[0], code: '600999' }, rows[1]], error: /代码格式/ },
    { change: rows => [...rows].reverse(), error: /排序/ },
    { change: rows => [rows[0], rows[0]], error: /重复/ }
  ];
  for (const { change, error } of cases) {
    const f = fixture(mainSymbols(2)); f.controls.page = change;
    await assert.rejects(f.source.load(), error); assert.equal(quoteCalls(f).length, 0); assert.equal(f.calls.length, 2);
  }
  const f = fixture(mainSymbols(81)); f.controls.page = (rows, page) => page === 2 ? [f.list[79]] : rows;
  await assert.rejects(f.source.load(), /重复|排序/); assert.equal(quoteCalls(f).length, 0);
  const badJson = fixture(); badJson.controls.intercept = ({ url }) => url.pathname.endsWith('getHQNodeData') ? textResponse('[{"symbol":') : undefined;
  await assert.rejects(badJson.source.load(), /有效 JSON/); assert.equal(badJson.calls.length, 2); assert.equal(quoteCalls(badJson).length, 0);
});

test('HTTP200截断列表页只重取失败页，恢复完整后才推进进度及取得腾讯指标', async () => {
  const f = fixture(mainSymbols(81)), progress = []; let truncated = false;
  f.controls.page = (rows, page) => {
    if (page === 2 && !truncated) { truncated = true; assert.equal(quoteCalls(f).length, 0); return []; }
    return rows;
  };
  const result = await f.source.load({ onProgress: p => progress.push({ ...p }) });
  assert.equal(result.rows.length, 81); assert.deepEqual(result.rows.map(row => row.symbol), mainSymbols(81));
  const pages = byEndpoint(f, 'getHQNodeData');
  assert.deepEqual(pages.map(call => call.url.searchParams.get('page')), ['1', '2', '2']);
  assert.ok(pages[2].at - pages[1].at >= 700, 'truncated response retries must also back off');
  assert.deepEqual(progress.filter(p => p.stage === 'universe' && p.total).map(p => p.completed), [0, 1, 2]);
  assert.equal(byEndpoint(f, 'getHQNodeStockCount').length, 3); assert.equal(quoteCalls(f).length, 2);
});

test('列表页持续过短或过长最多重试一次并拒绝发布，不能跳过或裁剪成完整页', async () => {
  for (const change of [rows => rows.slice(0, 1), rows => [...rows, rows[0]]]) {
    const f = fixture(mainSymbols(2)), progress = []; f.controls.page = change;
    await assert.rejects(f.source.load({ onProgress: p => progress.push({ ...p }) }), /页不完整/);
    assert.equal(byEndpoint(f, 'getHQNodeData').length, 2); assert.equal(byEndpoint(f, 'getHQNodeStockCount').length, 1);
    assert.equal(quoteCalls(f).length, 0); assert.equal(progress.at(-1).completed, 0);
    f.controls.page = rows => rows; assert.equal((await f.source.load()).rows.length, 2);
  }
});

test('代码池前后总数改变或只有不支持品种时拒绝发布，不发起腾讯报价', async () => {
  for (const changed of [2, 4]) {
    const f = fixture(mainSymbols(3)); f.controls.count = request => request === 1 ? '3' : String(changed);
    await assert.rejects(f.source.load(), /股票池.*变化/); assert.equal(quoteCalls(f).length, 0);
  }
  const f = fixture(['bj920001', 'sh510300', 'sz302132']);
  await assert.rejects(f.source.load(), /未返回支持/); assert.equal(quoteCalls(f).length, 0);
});

test('最后报价批次缺失一只、重复或正文代码错误均拒绝整次加载，恢复后可以重新获取完整结果', async () => {
  for (const broken of [
    symbols => symbols.slice(1).map(s => quote(s)).join(''),
    symbols => symbols.map(s => quote(s) + quote(s)).join(''),
    symbols => symbols.map(s => quote(s, { 2: '600999' })).join('')
  ]) {
    const f = fixture(mainSymbols(51)), progress = [];
    f.controls.quotes = symbols => symbols.length === 1 ? broken(symbols) : symbols.map(s => quote(s)).join('');
    await assert.rejects(f.source.load({ onProgress: p => progress.push({ ...p }) }), /缺少|重复|代码或市场/);
    assert.equal(quoteCalls(f).length, 2); assert.equal(progress.at(-1).completed, 50); assert.equal(progress.at(-1).total, 51);
    f.controls.quotes = symbols => symbols.map(s => quote(s)).join('');
    assert.equal((await f.source.load()).rows.length, 51);
  }
});

test('HTTP502有限退避重试一次后恢复，已成功页与报价不重复请求', async () => {
  const f = fixture(mainSymbols(81)); let failed = false;
  f.controls.intercept = ({ url }) => {
    if (url.pathname.endsWith('getHQNodeData') && url.searchParams.get('page') === '2' && !failed) {
      failed = true; return new Response('', { status: 502 });
    }
  };
  assert.equal((await f.source.load()).rows.length, 81);
  const pages = byEndpoint(f, 'getHQNodeData');
  assert.deepEqual(pages.map(call => call.url.searchParams.get('page')), ['1', '2', '2']);
  assert.ok(pages[2].at - pages[1].at >= 700, 'retry must wait for the backoff');
  assert.equal(quoteCalls(f).length, 2);
});

test('HTTP403不重试，429长Retry-After不立即重试且不继续扫描', async () => {
  for (const config of [{ status: 403 }, { status: 429, headers: { 'Retry-After': '600' } }, { status: 429, headers: { 'Retry-After': new Date(Date.now() + 600000).toUTCString() } }]) {
    let advance = 0;
    const f = fixture(undefined, { requestClock: () => Date.now() + advance }); f.controls.intercept = () => new Response('', config);
    await assert.rejects(f.source.load(), new RegExp(`HTTP ${config.status}`)); assert.equal(f.calls.length, 1);
    f.controls.intercept = null;
    if (config.status === 429) {
      await assert.rejects(f.source.load(), /Retry-After.*本次未发送/); assert.equal(f.calls.length, 1);
      advance = 601000;
    }
    assert.equal((await f.source.load()).rows.length, 1);
  }
});

test('列表和报价请求进行中取消会中止网络、停止排队，随后同一provider可重新加载', async () => {
  for (const target of ['list', 'quotes']) {
    const f = fixture(mainSymbols(81)), controller = new AbortController(), entered = deferred(); let aborted = false;
    f.controls.intercept = ({ url, request }) => {
      if ((target === 'list' && url.pathname.endsWith('getHQNodeData')) || (target === 'quotes' && url.hostname === 'qt.gtimg.cn')) {
        return new Promise((resolve, reject) => {
          request.signal.addEventListener('abort', () => { aborted = true; reject(Error('network aborted')); }, { once: true });
          entered.resolve();
        });
      }
    };
    const running = f.source.load({ signal: controller.signal }); await entered.promise;
    const callsBefore = f.calls.length; controller.abort(); await assert.rejects(running, /已取消/);
    assert.equal(aborted, true); assert.equal(f.calls.length, callsBefore);
    f.controls.intercept = null; assert.equal((await f.source.load()).rows.length, 81);
  }
});

test('最后一批响应读完时取消仍拒绝返回快照，后续加载不会使用部分旧数据', async () => {
  const f = fixture(mainSymbols(51)), controller = new AbortController();
  f.controls.intercept = ({ url }) => {
    if (url.hostname === 'qt.gtimg.cn' && url.pathname === '/q=sh600051') {
      return { ok: true, arrayBuffer: async () => { controller.abort(); return Buffer.from(quote('sh600051'), 'ascii'); } };
    }
  };
  await assert.rejects(f.source.load({ signal: controller.signal }), /已取消/);
  assert.equal(quoteCalls(f).length, 2);
  f.controls.intercept = null; assert.equal((await f.source.load()).rows.length, 51);
});

test('全部报价解析完后的进度回调取消也不发布本次快照', async () => {
  const f = fixture(), controller = new AbortController();
  await assert.rejects(f.source.load({ signal: controller.signal, onProgress: p => {
    if (p.stage === 'screen-quotes' && p.completed === p.total) controller.abort();
  } }), /已取消/);
  assert.equal((await f.source.load()).rows.length, 1);
});

test('退避期间取消立即停止重试，已取消信号不触发任何请求', async () => {
  const f = fixture(), controller = new AbortController(), attempted = deferred();
  f.controls.intercept = () => { attempted.resolve(); return new Response('', { status: 502 }); };
  const running = f.source.load({ signal: controller.signal }); await attempted.promise;
  await delay(25); controller.abort(); await assert.rejects(running, /已取消/); assert.equal(f.calls.length, 1);
  const never = fixture(); await assert.rejects(never.source.load({ signal: controller.signal }), /已取消/); assert.equal(never.calls.length, 0);
  f.controls.intercept = null; assert.equal((await f.source.load()).rows.length, 1);
});

test('整体期限中止未完成请求，不能把超时当作成功的部分股票池', async () => {
  const f = fixture(mainSymbols(81), { deadlineMs: 50 }); let aborted = false;
  f.controls.intercept = ({ request }) => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => { aborted = true; reject(Error('deadline')); }, { once: true });
  });
  // AbortSignal.timeout is unref'ed; this local timer keeps the isolated test alive.
  const keepAlive = setTimeout(() => {}, 500);
  try { await assert.rejects(f.source.load(), /超时.*不完整/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(aborted, true); assert.equal(f.calls.length, 1);
});

test('完整代码池同日缓存30分钟，报价每轮重取且保留代码池原始验证时间', async () => {
  let now = Date.parse('2026-10-19T10:00:00+08:00');
  const f = fixture(mainSymbols(81), { clock: () => now });
  f.controls.quotes = symbols => symbols.map(symbol => quote(symbol, { 30: '20261019100000' })).join('');
  const first = await f.source.load(), pages = byEndpoint(f, 'getHQNodeData').length;
  now += 60000;
  f.controls.quotes = symbols => symbols.map(symbol => quote(symbol, { 3: '13.00', 30: '20261019100100' })).join('');
  const progress = [], second = await f.source.load({ onProgress: p => progress.push(p) });
  assert.equal(byEndpoint(f, 'getHQNodeData').length, pages, 'cached symbols avoid another full Sina scan');
  assert.equal(byEndpoint(f, 'getHQNodeStockCount').length, 5, 'cold scan checks three times; cached scan checks before and after quotes');
  assert.equal(quoteCalls(f).length, 4, 'every quote batch is requested again');
  assert.equal(second.universeValidatedAt, first.universeValidatedAt);
  assert.equal(second.fetchedAt, now); assert.equal(second.rows[0].price, 13);
  assert.equal(second.rows[0].timestamp, Date.parse('2026-10-19T10:01:00+08:00'));
  assert.ok(progress.some(p => p.stage === 'universe' && p.cached === true && p.validatedAt === first.universeValidatedAt));
  now = first.universeValidatedAt + 30 * 60000;
  const expired = await f.source.load();
  assert.equal(byEndpoint(f, 'getHQNodeData').length, pages * 2);
  assert.equal(expired.universeValidatedAt, now);
});

test('北京时间跨日及系统时钟回退均重新核验代码池，不借用未来验证时间', async () => {
  for (const [start, next] of [
    ['2026-10-19T23:59:00+08:00', '2026-10-20T00:00:00+08:00'],
    ['2026-10-19T10:00:00+08:00', '2026-10-19T09:59:59+08:00']
  ]) {
    let now = Date.parse(start); const f = fixture(mainSymbols(2), { clock: () => now });
    await f.source.load(); now = Date.parse(next); const result = await f.source.load();
    assert.equal(byEndpoint(f, 'getHQNodeData').length, 2); assert.equal(result.universeValidatedAt, now);
  }
});

test('缓存期间开始计数变化立即重建完整代码池，报价覆盖新加入的股票', async () => {
  const f = fixture(mainSymbols(2)); await f.source.load();
  f.list.push({ symbol: 'sh600003', code: '600003' });
  const result = await f.source.load();
  assert.equal(byEndpoint(f, 'getHQNodeData').length, 2); assert.equal(result.sourceCount, 3);
  assert.deepEqual(result.rows.map(row => row.symbol), mainSymbols(3));
});

test('报价结束计数变化拒绝整轮结果并清除代码池，下一轮完整重建', async () => {
  for (const cached of [false, true]) {
    const f = fixture(mainSymbols(3)); if (cached) await f.source.load();
    const changedCall = cached ? 5 : 3;
    f.controls.count = number => number === changedCall ? '4' : '3';
    await assert.rejects(f.source.load(), /报价获取期间发生变化/);
    assert.equal(f.source.universe, null); assert.equal(quoteCalls(f).length, cached ? 2 : 1);
    const pagesBefore = byEndpoint(f, 'getHQNodeData').length;
    f.controls.count = () => '3'; await f.source.load();
    assert.equal(byEndpoint(f, 'getHQNodeData').length, pagesBefore + 1);
  }
});

test('列表最多3页并发，响应乱序仍按页顺序核验并输出完整有序代码池', async () => {
  const f = fixture(mainSymbols(321)); let active = 0, peak = 0; const completions = [];
  f.controls.intercept = async ({ url, request }) => {
    if (!url.pathname.endsWith('getHQNodeData')) return;
    const page = Number(url.searchParams.get('page'));
    active++; peak = Math.max(peak, active);
    try { await delay(page === 1 ? 90 : 30, undefined, { signal: request.signal }); }
    finally { active--; }
    completions.push(page); return jsonResponse(f.list.slice((page - 1) * 80, page * 80));
  };
  const result = await f.source.load();
  assert.equal(peak, 3); assert.notEqual(completions[0], 1);
  assert.deepEqual(result.rows.map(row => row.symbol), mainSymbols(321));
  assert.equal(byEndpoint(f, 'getHQNodeData').length, 5);
});

test('三个列表任务共享同host150ms启动间隔，不因并发形成突发请求', async () => {
  const f = fixture(mainSymbols(241), { spacingMs: 150 }); let active = 0, peak = 0;
  f.controls.intercept = async ({ url, request }) => {
    if (!url.pathname.endsWith('getHQNodeData')) return;
    active++; peak = Math.max(peak, active);
    try { await delay(340, undefined, { signal: request.signal }); } finally { active--; }
  };
  await f.source.load(); assert.equal(peak, 3);
  for (const host of ['vip.stock.finance.sina.com.cn', 'qt.gtimg.cn']) {
    const calls = f.calls.filter(call => call.url.hostname === host);
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 150, `${host}: ${calls[i].at - calls[i - 1].at}ms`);
  }
});

test('一个列表页的Retry-After阻止其他同host并发页启动，等待期满后才继续', async () => {
  const f = fixture(mainSymbols(241), { spacingMs: 30 }); let rejectedAt = 0, rejected = false;
  f.controls.intercept = ({ url }) => {
    if (!url.pathname.endsWith('getHQNodeData') || url.searchParams.get('page') !== '1' || rejected) return;
    rejected = true; rejectedAt = Date.now(); return new Response('', { status: 429, headers: { 'Retry-After': '1' } });
  };
  assert.equal((await f.source.load()).rows.length, 241);
  const later = f.calls.filter(call => call.url.hostname === 'vip.stock.finance.sina.com.cn' && call.at > rejectedAt);
  assert.ok(later.length > 0); assert.ok(later.every(call => call.at - rejectedAt >= 1000));
  assert.deepEqual(byEndpoint(f, 'getHQNodeData').map(call => Number(call.url.searchParams.get('page'))).sort((a, b) => a - b), [1, 1, 2, 3, 4]);
});

test('已有代码池缓存也不能绕过来源长Retry-After，期限后恢复时才重新取报价', async () => {
  const start = Date.parse('2026-10-19T10:00:00.250+08:00');
  let advance = 0; const f = fixture(mainSymbols(2), { requestClock: () => start + advance });
  await f.source.load(); const quotesBefore = quoteCalls(f).length;
  f.controls.intercept = () => new Response('', { status: 429, headers: { 'Retry-After': '600' } });
  await assert.rejects(f.source.load(), /HTTP 429/); const callsBefore = f.calls.length;
  f.controls.intercept = null;
  await assert.rejects(f.source.load(), error => {
    assert.equal(error.code, 'source-cooldown'); assert.equal(error.retryAt, start + 600000);
    assert.match(error.message, /Retry-After.*2026-10-19 10:10:01（北京时间）.*本次未发送/);
    assert.doesNotMatch(error.message, /秒后/); return true;
  });
  assert.equal(f.calls.length, callsBefore); assert.equal(quoteCalls(f).length, quotesBefore);
  advance = 601000; assert.equal((await f.source.load()).rows.length, 2);
  assert.equal(quoteCalls(f).length, quotesBefore + 1);
});

test('列表一页终止性失败会中止其余并发请求，不缓存残缺列表且之后可以恢复', async () => {
  const f = fixture(mainSymbols(321)); let aborted = 0;
  f.controls.intercept = ({ url, request }) => {
    if (!url.pathname.endsWith('getHQNodeData')) return;
    if (url.searchParams.get('page') === '1') return new Response('', { status: 403 });
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => { aborted++; reject(Error('sibling aborted')); }, { once: true }));
  };
  await assert.rejects(f.source.load(), /HTTP 403/);
  assert.equal(aborted, 2); assert.equal(byEndpoint(f, 'getHQNodeData').length, 3);
  assert.equal(quoteCalls(f).length, 0); assert.equal(f.source.universe, null);
  f.controls.intercept = null; assert.equal((await f.source.load()).rows.length, 321);
});

test('并发调用共用完整扫描并广播进度，一个调用者取消不取消其他调用者', async () => {
  const f = fixture(mainSymbols(81)), entered = deferred(), release = deferred(), firstController = new AbortController();
  const firstProgress = [], secondProgress = []; let networkAborted = false, held = false;
  f.controls.intercept = async ({ url, request }) => {
    if (!url.pathname.endsWith('getHQNodeStockCount') || held) return;
    held = true; request.signal.addEventListener('abort', () => { networkAborted = true; }, { once: true });
    entered.resolve(); await release.promise; return jsonResponse('81');
  };
  const first = f.source.load({ signal: firstController.signal, onProgress: p => firstProgress.push(p) });
  await entered.promise;
  const second = f.source.load({ onProgress: p => secondProgress.push(p) });
  const rejected = assert.rejects(first, /已取消/); firstController.abort(); await rejected;
  assert.equal(networkAborted, false); release.resolve(); const result = await second;
  assert.equal(result.rows.length, 81); assert.equal(byEndpoint(f, 'getHQNodeData').length, 2);
  assert.equal(quoteCalls(f).length, 2); assert.equal(firstProgress.length, 1);
  assert.equal(secondProgress[0].stage, 'universe'); assert.equal(secondProgress.at(-1).completed, 81);
});

test('最后一名调用者取消才中止共享请求，随后新调用不会加入已取消任务', async () => {
  const f = fixture(mainSymbols(2)), entered = deferred(), controllers = [new AbortController(), new AbortController()]; let aborted = 0;
  f.controls.intercept = ({ request }) => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => { aborted++; reject(Error('network aborted')); }, { once: true }); entered.resolve();
  });
  const calls = controllers.map(controller => f.source.load({ signal: controller.signal }));
  const failures = calls.map(promise => assert.rejects(promise, /已取消/)); await entered.promise;
  controllers[0].abort(); await failures[0]; assert.equal(aborted, 0);
  controllers[1].abort(); await failures[1]; assert.equal(aborted, 1);
  f.controls.intercept = null; assert.equal((await f.source.load()).rows.length, 2);
});

test('共享失败同时通知所有调用者，紧接着重试不复用已完成的任务或旧错误', async () => {
  const f = fixture(mainSymbols(2)); f.controls.intercept = () => new Response('', { status: 403 });
  const outcomes = await Promise.allSettled([f.source.load(), f.source.load()]);
  assert.ok(outcomes.every(result => result.status === 'rejected' && /HTTP 403/.test(result.reason.message)));
  assert.equal(f.calls.length, 1); f.controls.intercept = null;
  const result = await f.source.load().then(() => f.source.load());
  assert.equal(result.rows.length, 2); assert.equal(byEndpoint(f, 'getHQNodeData').length, 1);
  assert.equal(quoteCalls(f).length, 2);
});

test('进度回调互不修改；一个观察者抛错仅结束自己的订阅', async () => {
  const f = fixture(mainSymbols(2)), events = [];
  const broken = f.source.load({ onProgress: p => { p.total = -1; throw Error('observer failed'); } });
  const healthy = f.source.load({ onProgress: p => events.push(p) });
  await assert.rejects(broken, /observer failed/); assert.equal((await healthy).rows.length, 2);
  assert.ok(events.every(p => p.total >= 0));
});

test('同次进度广播中被另一调用者取消的订阅不再接收该条进度', async () => {
  const f = fixture(mainSymbols(2)), controller = new AbortController(), events = [];
  const first = f.source.load({ onProgress: p => { if (p.stage === 'screen-quotes') controller.abort(); } });
  const second = f.source.load({ signal: controller.signal, onProgress: p => events.push(p) });
  const rejected = assert.rejects(second, /已取消/);
  assert.equal((await first).rows.length, 2); await rejected;
  assert.ok(events.length > 0); assert.ok(events.every(p => p.stage !== 'screen-quotes'));
});
