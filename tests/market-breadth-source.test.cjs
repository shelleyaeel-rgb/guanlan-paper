const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { MarketBreadthSource, parseSinaBreadth, validateBreadth } = require('../core/market-breadth-source.cjs');
const { FreeScreenerSource } = require('../core/screener-sources.cjs');

const NOW = Date.parse('2026-10-19T10:15:00+08:00');
const symbols = count => Array.from({ length: count }, (_, index) => `sh${600000 + index}`);
const universe = (count = 1000) => ({ symbols: symbols(count), sourceCount: count, excludedCount: 0,
  source: '新浪财经沪深证券列表', validatedAt: NOW - 1000, date: '2026-10-19' });
const snapshot = (count = 1000) => ({ rows: symbols(count).map(symbol => ({ symbol, price: 12, changePct: 1, timestamp: NOW - 1000 })),
  source: '腾讯财经公开行情（新浪证券列表）', sourceCount: count, excludedCount: 0, universeSource: '新浪财经沪深证券列表',
  universeValidatedAt: NOW - 1000, fetchedAt: NOW, startedAt: NOW - 2000 });
function sinaQuote(symbol, changes = {}) {
  const fields = Array(33).fill('0');
  Object.assign(fields, { 0: '测试股票', 1: '10', 2: '10', 3: '11', 30: '2026-10-19', 31: '10:14:59', ...changes });
  return `var hq_str_${symbol}="${fields.join(',')}";`;
}
function fixture(options = {}) {
  const calls = [], controls = { primary: async () => snapshot(), universe: async () => universe(), validate: async () => {},
    quote: async batch => batch.map(symbol => sinaQuote(symbol)).join('\n') };
  const primary = {
    load: options => { calls.push({ kind: 'primary', options }); return controls.primary(options); },
    loadUniverse: options => { calls.push({ kind: 'universe', options }); return controls.universe(options); },
    validateUniverse: (value, options) => { calls.push({ kind: 'validate', universe: value, options }); return controls.validate(value, options); },
    request: async (url, signal, gbk) => {
      const parsed = new URL(url); assert.equal(parsed.hostname, 'hq.sinajs.cn'); assert.equal(gbk, true); signal.throwIfAborted();
      const batch = parsed.pathname.slice('/list='.length).split(','); calls.push({ kind: 'quotes', batch, signal });
      return controls.quote(batch, signal);
    }
  };
  const source = new MarketBreadthSource(primary, { clock: () => NOW, ...options });
  return { source, primary, controls, calls };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const unavailable = () => Promise.reject(Error('主源暂不可用'));

test('新浪广度只取完整原始日期、价格及昨收，不填入选股估值或以获取时间代替报价时间', () => {
  const rows = parseSinaBreadth(sinaQuote('sh600000') + sinaQuote('sz000001', { 3: '9', 31: '10:14:50' }), ['sh600000', 'sz000001']);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['changePct', 'date', 'prevClose', 'price', 'symbol', 'timestamp']);
  assert.equal(rows[0].timestamp, NOW - 1000); assert.equal(rows[1].timestamp, NOW - 10000);
  assert.ok(Math.abs(rows[0].changePct - 10) < 1e-9); assert.ok(Math.abs(rows[1].changePct + 10) < 1e-9);
  const suspended = parseSinaBreadth(sinaQuote('sh600000', { 3: '0', 30: '2026-10-16' }), ['sh600000'])[0];
  assert.equal(suspended.changePct, null); assert.equal(suspended.date, '2026-10-16');
});

test('新浪空响应、截断、缺漏、重复、未请求代码和非法日期时间都拒绝发布', () => {
  const good = sinaQuote('sh600000');
  for (const value of ['', 'Forbidden', 'var hq_str_sh600000="";', good + good, good + sinaQuote('sz000001'),
    sinaQuote('sh600000', { 30: '2026-02-30' }), sinaQuote('sh600000', { 31: '25:00:00' }), sinaQuote('sh600000', { 30: '' })]) {
    assert.throws(() => parseSinaBreadth(value, ['sh600000']));
  }
  assert.throws(() => parseSinaBreadth(good, ['sh600000', 'sh600001']), /缺少/);
  assert.throws(() => parseSinaBreadth(good, ['sh600000', 'sh600000']), /重复/);
});

test('广度完整性与原始行情覆盖校验保留80%、1000只和180秒约束', () => {
  assert.equal(validateBreadth(snapshot(), NOW).rows.length, 1000);
  const enough = snapshot(1200); enough.rows.slice(1000).forEach(row => { row.timestamp = NOW - 180001; });
  assert.equal(validateBreadth(enough, NOW), enough);
  const corruptions = [value => value.rows.pop(), value => { value.rows[1] = { ...value.rows[0] }; },
    value => value.rows.forEach(row => { row.timestamp = NOW - 180001; }), value => value.rows.forEach(row => { row.timestamp = NOW + 1; }),
    value => value.rows.forEach(row => { row.timestamp = NOW - 86400000; }), value => { value.fetchedAt = NOW + 1; },
    value => { value.excludedCount = -1; }, value => { value.rows[0].symbol = 'bj920001'; }, value => { value.rows[0].changePct = null; }];
  for (const corrupt of corruptions) { const value = snapshot(); corrupt(value); assert.throws(() => validateBreadth(value, NOW)); }
});

test('腾讯成功直接复用原始快照，不请求新浪；后续强制调用重新获取报价', async () => {
  const f = fixture(), progress = [];
  f.controls.primary = async ({ onProgress }) => { onProgress({ stage: 'screen-quotes', completed: 1000, total: 1000 }); return snapshot(); };
  const value = await f.source.load({ onProgress: item => progress.push(item) });
  assert.equal(value.provider, 'tencent'); assert.equal(value.rows[0].timestamp, NOW - 1000);
  assert.deepEqual(value.acquisitionDiagnostics, []); assert.equal(value.universeValidatedAt, NOW - 1000);
  assert.equal(progress[0].providerLabel, '腾讯财经'); assert.equal(progress[0].fallbackReason, null);
  await f.source.load({ force: true }); assert.deepEqual(f.calls.map(call => call.kind), ['primary', 'primary']);
});

test('腾讯网络错误切换新浪全量批次，完成后复核名单，记录真实来源与失败原因', async () => {
  const f = fixture(), progress = []; f.controls.primary = unavailable;
  const result = await f.source.load({ onProgress: value => progress.push(value) });
  assert.equal(result.provider, 'sina'); assert.equal(result.rows.length, 1000);
  assert.equal(result.source, '新浪财经公开行情（新浪财经沪深证券列表）');
  assert.equal(result.universeValidatedAt, NOW - 1000); assert.equal(result.rows[0].timestamp, NOW - 1000);
  assert.deepEqual(result.acquisitionDiagnostics.map(item => item.provider), ['tencent']);
  const batches = f.calls.filter(call => call.kind === 'quotes');
  assert.deepEqual(batches.map(call => call.batch.length), [...Array(12).fill(80), 40]);
  assert.deepEqual(batches.flatMap(call => call.batch), symbols(1000)); assert.equal(f.calls.at(-1).kind, 'validate');
  assert.ok(progress.every(value => value.provider === 'sina' && value.fallbackReason.includes('主源暂不可用')));
});

test('腾讯HTTP成功但原始报价过期、缺失或重复也会切换新浪，不返回部分主源数据', async () => {
  for (const corrupt of [value => value.rows.forEach(row => { row.timestamp = NOW - 190000; }),
    value => value.rows.pop(), value => { value.rows[1] = { ...value.rows[0] }; }]) {
    const f = fixture(); f.controls.primary = async () => { const value = snapshot(); corrupt(value); return value; };
    const result = await f.source.load(); assert.equal(result.provider, 'sina'); assert.equal(result.rows.length, 1000);
    assert.ok(result.rows.every(row => row.prevClose === 10));
  }
});

test('主源有独立预算，到期转备用时仍保留整体时间，不等待120秒才切换', async () => {
  const f = fixture({ deadlineMs: 1000, primaryBudgetMs: 25 }), pending = deferred(); let primarySignal;
  f.controls.primary = ({ signal }) => { primarySignal = signal; return pending.promise; };
  const began = Date.now(), result = await f.source.load();
  assert.equal(result.provider, 'sina'); assert.ok(primarySignal.aborted);
  assert.ok(Date.now() - began >= 20); assert.ok(Date.now() - began < 800);
  assert.match(result.acquisitionDiagnostics[0].message, /预算/); pending.resolve(snapshot());
});

test('新浪名单不可用时使用独立完整名单并在报价后复核，禁止部分名单替代全市场', async () => {
  const fallback = universe(); fallback.source = '备用完整名单'; const calls = [];
  const f = fixture({ universeLoader: { load: async () => { calls.push('load'); return fallback; }, validate: async value => { calls.push('validate'); assert.equal(value, fallback); } } });
  f.controls.primary = unavailable; f.controls.universe = async () => { throw Error('新浪名单失败'); };
  const result = await f.source.load(); assert.deepEqual(calls, ['load', 'validate']);
  assert.equal(result.universeSource, '备用完整名单'); assert.match(result.source, /备用完整名单/);
  assert.deepEqual(result.acquisitionDiagnostics.map(item => item.provider), ['tencent', 'sina-universe']);
  const bad = fixture({ universeLoader: { load: async () => ({ ...universe(), symbols: symbols(999) }), validate: async () => {} } });
  bad.controls.primary = unavailable; bad.controls.universe = async () => { throw Error('新浪名单失败'); };
  await assert.rejects(bad.source.load(), /名单不完整/); assert.ok(!bad.calls.some(call => call.kind === 'quotes'));
});

test('新浪名单获取有自己的预算，超时后仍能启动独立名单和备用报价', async () => {
  const f = fixture({ deadlineMs: 1000, universeBudgetMs: 20,
    universeLoader: { load: async () => ({ ...universe(), source: '备用名单' }), validate: async () => {} } });
  f.controls.primary = unavailable; f.controls.universe = () => new Promise(() => {});
  const result = await f.source.load(); assert.equal(result.provider, 'sina'); assert.equal(result.universeSource, '备用名单');
});

test('备用缺一只、时效不足或最终名单发生变化一律失败，不把局部成功发布', async () => {
  for (const mode of ['missing', 'stale', 'changed']) {
    const f = fixture(); f.controls.primary = unavailable;
    if (mode === 'missing') f.controls.quote = async batch => batch.slice(1).map(symbol => sinaQuote(symbol)).join('');
    if (mode === 'stale') f.controls.quote = async batch => batch.map(symbol => sinaQuote(symbol, { 30: '2026-10-16' })).join('');
    if (mode === 'changed') f.controls.validate = async () => { throw Error('名单总数发生变化'); };
    await assert.rejects(f.source.load(), /全部来源获取失败/);
  }
});

test('并发调用共用工作，取消一个订阅不会中止另一个或重复请求', async () => {
  const f = fixture(), pending = deferred(), controller = new AbortController(); let primarySignal;
  f.controls.primary = ({ signal, onProgress }) => { primarySignal = signal; onProgress({ stage: 'screen-quotes', completed: 1, total: 1000 }); return pending.promise; };
  const first = f.source.load({ signal: controller.signal }), second = f.source.load();
  await delay(1); controller.abort(); await assert.rejects(first);
  assert.equal(primarySignal.aborted, false); pending.resolve(snapshot());
  assert.equal((await second).provider, 'tencent'); assert.equal(f.calls.filter(call => call.kind === 'primary').length, 1);
});

test('全部订阅取消中止本轮且不触发备用，下一次可重新获取', async () => {
  const f = fixture(), controller = new AbortController(); let primarySignal;
  f.controls.primary = ({ signal }) => { primarySignal = signal; return new Promise(() => {}); };
  const pending = f.source.load({ signal: controller.signal }); await delay(1); controller.abort(); await assert.rejects(pending);
  await delay(1); assert.ok(primarySignal.aborted); assert.ok(!f.calls.some(call => call.kind === 'universe'));
  f.controls.primary = async () => snapshot(); assert.equal((await f.source.load()).provider, 'tencent');
});

test('整体超时终止备用请求并拒绝，不在后台继续产生下一批', async () => {
  const f = fixture({ deadlineMs: 50, primaryBudgetMs: 10 }); f.controls.primary = unavailable;
  let quoteSignal; f.controls.quote = (batch, signal) => { quoteSignal = signal; return new Promise(() => {}); };
  await assert.rejects(f.source.load(), /市场广度获取超时/); assert.ok(quoteSignal.aborted);
  assert.equal(f.calls.filter(call => call.kind === 'quotes').length, 1);
});

test('主源连续失败后暂缓重复访问，强制重试恢复成功清除旧失败', async () => {
  const f = fixture(); f.controls.primary = unavailable;
  await f.source.load(); await f.source.load();
  assert.equal(f.calls.filter(call => call.kind === 'primary').length, 1);
  f.controls.primary = async () => snapshot(); const result = await f.source.load({ force: true });
  assert.equal(result.provider, 'tencent'); assert.deepEqual(result.acquisitionDiagnostics, []);
  await f.source.load(); assert.equal(f.calls.filter(call => call.kind === 'primary').length, 3);
});

test('坏进度订阅只影响自己，不影响其他调用获取最终快照', async () => {
  const f = fixture(), pending = deferred(); let publish;
  f.controls.primary = ({ onProgress }) => { publish = onProgress; return pending.promise; };
  const bad = f.source.load({ onProgress: () => { throw Error('observer failed'); } }), good = f.source.load();
  await delay(1); publish({ stage: 'screen-quotes', completed: 1, total: 1000 });
  await assert.rejects(bad, /observer failed/); pending.resolve(snapshot()); assert.equal((await good).provider, 'tencent');
});

test('共享传输保留新浪域名Retry-After，后续备用不绕过本地限流发送', async () => {
  let requests = 0;
  const transport = new FreeScreenerSource(async () => { requests++; return new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }); }, { spacingMs: 0 });
  const f = fixture(); f.primary.request = transport.request.bind(transport); f.controls.primary = unavailable;
  await assert.rejects(f.source.load(), /HTTP 429/); assert.equal(requests, 1);
  await assert.rejects(f.source.load(), /本次未发送/); assert.equal(requests, 1);
});

function integratedFixture({ holdTencent = null, primaryBudgetMs = 1000 } = {}) {
  const list = symbols(1000), calls = [];
  const source = new FreeScreenerSource(async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, signal: options.signal });
    if (parsed.pathname.endsWith('getHQNodeStockCount')) return new Response(JSON.stringify(String(list.length)));
    if (parsed.pathname.endsWith('getHQNodeData')) {
      const page = Number(parsed.searchParams.get('page'));
      return new Response(JSON.stringify(list.slice((page - 1) * 80, page * 80).map(symbol => ({ symbol, code: symbol.slice(2) }))));
    }
    if (parsed.hostname === 'hq.sinajs.cn') return new Response(parsed.pathname.slice('/list='.length).split(',').map(symbol => sinaQuote(symbol)).join(''));
    assert.equal(parsed.hostname, 'qt.gtimg.cn');
    if (holdTencent) await holdTencent;
    return new Response(parsed.pathname.slice('/q='.length).split(',').map(symbol => {
      const fields = Array(88).fill('');
      Object.assign(fields, { 0: '1', 1: 'Tencent', 2: symbol.slice(2), 3: '11', 4: '10', 30: '20261019101459', 32: '10', 61: 'GP-A' });
      return `v_${symbol}="${fields.join('~')}";`;
    }).join(''));
  }, { clock: () => NOW, spacingMs: 0 });
  source.breadthSource = new MarketBreadthSource(source, { clock: () => NOW, primaryBudgetMs });
  return { source, calls };
}

test('真实FreeScreenerSource选股和广度同时获取只发送一份完整腾讯报价', async () => {
  const f = integratedFixture();
  const [screen, breadth] = await Promise.all([f.source.load(), f.source.loadBreadth()]);
  assert.equal(screen.rows, breadth.rows); assert.equal(breadth.provider, 'tencent');
  assert.equal(f.calls.filter(call => call.url.hostname === 'qt.gtimg.cn').length, 20);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('getHQNodeData')).length, 13);
});

test('广度预算到期切新浪不会取消仍有选股订阅的腾讯请求', async () => {
  const gate = deferred(), f = integratedFixture({ holdTencent: gate.promise, primaryBudgetMs: 50 });
  const screen = f.source.load(), breadth = await f.source.loadBreadth();
  assert.equal(breadth.provider, 'sina');
  const quote = f.calls.find(call => call.url.hostname === 'qt.gtimg.cn');
  assert.ok(quote); assert.equal(quote.signal.aborted, false);
  gate.resolve(); assert.equal((await screen).rows.length, 1000);
  assert.equal(f.calls.filter(call => call.url.hostname === 'qt.gtimg.cn').length, 20);
});

test('盘前完整名单准备不抓报价，开盘主源复用全部分页名单并保留原校验时间', async () => {
  const f = integratedFixture();
  const prepared = await f.source.prepareUniverse();
  assert.equal(prepared.symbols.length, 1000); assert.equal(prepared.validatedAt, NOW);
  assert.equal(f.calls.filter(call => call.url.hostname === 'qt.gtimg.cn').length, 0);
  assert.equal(f.calls.filter(call => call.url.hostname === 'hq.sinajs.cn').length, 0);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('getHQNodeData')).length, 13);
  const breadth = await f.source.loadBreadth();
  assert.equal(breadth.provider, 'tencent'); assert.equal(breadth.universeValidatedAt, NOW);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('getHQNodeData')).length, 13, 'opening reuses all prepared list pages');
  assert.equal(f.calls.filter(call => call.url.hostname === 'qt.gtimg.cn').length, 20);
});

test('已预热的独立完整名单在备用报价阶段直接复用，仍在报价后复核身份边界', async () => {
  const calls = [], fallback = { ...universe(), source: '备用完整名单' };
  const f = fixture({ universeLoader: { load: async () => { calls.push('load'); return fallback; }, validate: async () => { calls.push('validate'); } } });
  f.controls.universe = async () => { throw Error('新浪名单失败'); };
  const prepared = await f.source.prepareUniverse(); assert.equal(prepared.source, fallback.source);
  assert.deepEqual(f.calls.map(call => call.kind), ['universe']); assert.deepEqual(calls, ['load']);
  f.controls.primary = unavailable;
  const result = await f.source.load(); assert.equal(result.universeSource, fallback.source);
  assert.deepEqual(calls, ['load', 'validate']); assert.equal(f.calls.filter(call => call.kind === 'universe').length, 1);
});

test('静态名单预热并发共享且只取消自己的订阅，最后取消后新调用重建', async () => {
  const f = fixture(), pending = deferred(), controller = new AbortController(); let listSignal;
  f.controls.universe = ({ signal }) => { listSignal = signal; return pending.promise; };
  const first = f.source.prepareUniverse({ signal: controller.signal }), second = f.source.prepareUniverse();
  await delay(1); controller.abort(); await assert.rejects(first); assert.equal(listSignal.aborted, false);
  pending.resolve(universe()); assert.equal((await second).symbols.length, 1000);
  assert.equal(f.calls.filter(call => call.kind === 'universe').length, 1);
  const lastController = new AbortController();
  f.controls.universe = ({ signal }) => { listSignal = signal; return new Promise(() => {}); };
  const abandoned = f.source.prepareUniverse({ signal: lastController.signal }); await delay(1); lastController.abort();
  await assert.rejects(abandoned); assert.equal(listSignal.aborted, true);
  f.controls.universe = async () => universe(); assert.equal((await f.source.prepareUniverse()).symbols.length, 1000);
});

test('盘前名单强制重试仍尊重真实传输Retry-After，不在冷却期间发送请求', async () => {
  let calls = 0;
  const transport = new FreeScreenerSource(async () => { calls++; return new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }); }, { spacingMs: 0 });
  const f = fixture(); f.controls.universe = options => transport.loadUniverse(options);
  await assert.rejects(f.source.prepareUniverse(), /HTTP 429/); assert.equal(calls, 1);
  await assert.rejects(f.source.prepareUniverse({ force: true }), /本次未发送/); assert.equal(calls, 1);
  assert.ok(!f.calls.some(call => call.kind === 'primary' || call.kind === 'quotes'));
});
