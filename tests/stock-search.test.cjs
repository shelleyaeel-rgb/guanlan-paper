const test = require('node:test'), assert = require('node:assert/strict');
const { StockSearch, searchUrl, parseSearch } = require('../core/stock-search.cjs');

const NOW = Date.parse('2026-10-26T03:00:00Z');
const stock = (code = '600519', overrides = {}) => {
  const sh = code.startsWith('6'), star = code.startsWith('688');
  return { Code: code, Name: '贵州茅台', PinYin: 'GZMT', Classify: star ? '23' : 'AStock', SecurityType: star ? '25' : sh ? '1' : '2',
    MktNum: sh ? '1' : '0', QuoteID: `${sh ? '1' : '0'}.${code}`, ...overrides };
};
const table = (data = [stock()], total = data?.length || 0) => ({ QuotationCodeTable: { Status: 0, TotalCount: total, Data: data } });
const response = json => new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('lightweight suggestions accept names, partial codes, initials and qualified codes', async () => {
  const calls = [], source = new StockSearch(async (url, options) => {
    calls.push({ url: new URL(url), options }); return response(table());
  }, { clock: () => NOW });
  for (const query of ['茅台', '6005', ' GZMT ', 'ＳＨ６００５１９']) {
    const result = await source.search({ query });
    assert.equal(result.items[0].symbol, 'sh600519'); assert.equal(result.items[0].name, '贵州茅台');
    assert.equal(result.fetchedAt, NOW); assert.equal(result.source, '东方财富证券搜索'); assert.equal(result.cached, false);
  }
  assert.deepEqual(calls.map(c => c.url.searchParams.get('input')), ['茅台', '6005', 'gzmt', '600519']);
  for (const call of calls) {
    assert.equal(call.url.hostname, 'searchapi.eastmoney.com'); assert.equal(call.url.searchParams.get('count'), '30');
    assert.equal(call.url.searchParams.get('type'), '14'); assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.equal(new URL(searchUrl('ST 银行')).searchParams.get('input'), 'ST 银行');
});

test('supported Shanghai, Shenzhen and STAR shares retain provider identities and duplicate rows collapse', () => {
  const rows = [stock(), stock('000001', { Name: '平安银行', PinYin: 'PAYH' }), stock('300750', { Name: '宁德时代', PinYin: 'NDSD' }), stock('688001', { Name: '华兴源创', PinYin: 'HXYC' }), stock()];
  assert.deepEqual(parseSearch(table(rows)).items.map(item => item.symbol), ['sh600519', 'sz000001', 'sz300750', 'sh688001']);
  assert.deepEqual(parseSearch(table(rows), 'sz').items.map(item => item.symbol), ['sz000001', 'sz300750']);
});

test('same-code index, funds, bonds, Beijing and overseas securities never become A shares', () => {
  const rows = [
    stock('000001', { Classify: 'Index', SecurityType: '5', MktNum: '1', QuoteID: '1.000001', Name: '上证指数' }),
    stock('000001', { Name: '平安银行', PinYin: 'PAYH' }),
    stock('510300', { Classify: 'Fund', SecurityType: '3' }),
    stock('110001', { Classify: 'Bond', SecurityType: '4' }),
    stock('920001', { Classify: 'NEEQ', SecurityType: '27' }),
    stock('00700', { Classify: 'HK', SecurityType: '6', MktNum: '116' }),
    stock('MSFT', { Classify: 'UsStock', SecurityType: '7', MktNum: '105' }),
  ];
  assert.deepEqual(parseSearch(table(rows)).items.map(item => item.symbol), ['sz000001']);
  const filtered = parseSearch(table([rows[0]], 100));
  assert.equal(filtered.items.length, 0); assert.equal(filtered.hasMore, true);
});

test('unsupported STAR CDRs are filtered without discarding other valid A shares', () => {
  const cdr = stock('689009', { Name: '九号公司-WD', PinYin: 'JHGSWD', Classify: '23', SecurityType: '25' });
  const result = parseSearch(table([stock('600689', { Name: '上海三毛', PinYin: 'SHSM' }), cdr, stock('688001')]));
  assert.deepEqual(result.items.map(item => item.symbol), ['sh600689', 'sh688001']);
  assert.equal(parseSearch(table([cdr])).items.length, 0);
  assert.throws(() => parseSearch(table([stock('000001', { SecurityType: '1', MktNum: '1', QuoteID: '1.000001' })])), /市场不一致/);
});

test('candidate and display limits preserve a non-exhaustive result indication', () => {
  const rows = Array.from({ length: 30 }, (_, i) => stock(String(600000 + i)));
  const result = parseSearch(table(rows, 100));
  assert.equal(result.items.length, 20); assert.equal(result.sourceLimit, 30); assert.equal(result.hasMore, true);
  assert.equal(parseSearch(table([stock()], 1)).hasMore, false);
});

test('empty results must have a successful, internally consistent provider response', () => {
  assert.deepEqual(parseSearch(table(null)), { items: [], hasMore: false, sourceLimit: 30 });
  assert.equal(parseSearch(table([])).items.length, 0);
  for (const json of [{}, table(null, 1), table([], 1), table([stock()], 0), { QuotationCodeTable: { Status: 1, TotalCount: 0, Data: null } }]) {
    assert.throws(() => parseSearch(json), /股票搜索响应无效/);
  }
});

test('malformed identity, market mismatch, unsafe names and conflicting duplicates fail closed', () => {
  for (const row of [stock('000001', { SecurityType: '1', MktNum: '1', QuoteID: '1.000001' }), stock('600519', { QuoteID: '0.600519' }),
    stock('688001', { Classify: 'AStock', SecurityType: '1' }), stock('600519', { Code: 600519 }), stock('600519', { Name: '<img src=x>' }),
    stock('600519', { Name: '贵州\n茅台' }), stock('600519', { PinYin: null }), null]) {
    assert.throws(() => parseSearch(table([row])), /股票搜索响应无效/);
  }
  assert.throws(() => parseSearch(table([stock(), stock('600519', { Name: '另一名称' })])), /身份冲突/);
});

test('invalid or oversized input never reaches the network', async () => {
  let calls = 0; const source = new StockSearch(async () => { calls++; return response(table()); });
  for (const query of [null, {}, '', '   ', 'a'.repeat(33), '600519&input=000001', 'sh000001', '名字\n代码']) {
    await assert.rejects(source.search({ query }));
  }
  assert.equal(calls, 0);
});

test('same-term concurrent requests share one fetch and cached data cannot be mutated by callers', async () => {
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const source = new StockSearch(async () => { calls++; await gate; return response(table()); }, { clock: () => NOW });
  const a = source.search({ query: 'gzmt' }), b = source.search({ query: 'GZMT' });
  await flush(); assert.equal(calls, 1); release();
  const [first, second] = await Promise.all([a, b]);
  first.items[0].name = 'changed'; first.items.push({});
  assert.equal(second.items[0].name, '贵州茅台'); assert.equal(second.query, 'GZMT');
  const cached = await source.search({ query: 'GZMT' });
  assert.equal(cached.cached, true); assert.equal(cached.items.length, 1); assert.equal(cached.items[0].name, '贵州茅台');
});

test('cache expiry, clock rollback and entry bounds trigger fresh requests', async () => {
  let now = NOW, calls = 0;
  const source = new StockSearch(async () => { calls++; return response(table()); }, { clock: () => now, maxAgeMs: 100, maxCacheEntries: 2 });
  await source.search({ query: '甲' }); await source.search({ query: '乙' }); await source.search({ query: '甲' });
  await source.search({ query: '丙' }); await source.search({ query: '乙' }); assert.equal(calls, 4); assert.equal(source.cache.size, 2);
  now += 100; await source.search({ query: '乙' }); assert.equal(calls, 5);
  now -= 1; await source.search({ query: '乙' }); assert.equal(calls, 6);
});

test('network, HTTP and body failures remain errors and are retried on the next query', async () => {
  for (const fail of [() => { throw Error('offline'); }, () => new Response('', { status: 503 }), () => new Response('<html>oops</html>'),
    () => new Response('x', { headers: { 'Content-Length': '200000' } }), () => new Response('x'.repeat(128 * 1024 + 1))]) {
    let calls = 0;
    const source = new StockSearch(async () => ++calls === 1 ? fail() : response(table()));
    await assert.rejects(source.search({ query: '茅台' }), /股票搜索/);
    assert.equal((await source.search({ query: '茅台' })).items.length, 1); assert.equal(calls, 2);
  }
});

test('request timeout aborts a stalled request and clears the shared pending entry', async () => {
  let signal;
  const source = new StockSearch(async (_url, options) => { signal = options.signal; return new Promise(() => {}); }, { requestTimeoutMs: 15 });
  await assert.rejects(source.search({ query: '茅台' }), /超时/);
  assert.equal(signal.aborted, true); assert.equal(source.inflight.size, 0);
});

test('only three queries run concurrently and the newest pending query replaces older waiting work', async () => {
  const releases = [], calls = [];
  const source = new StockSearch(async url => {
    calls.push(new URL(url).searchParams.get('input'));
    await new Promise(resolve => releases.push(resolve)); return response(table());
  });
  const first = ['甲', '乙', '丙'].map(query => source.search({ query })); await flush();
  const dropped = source.search({ query: '丁' });
  const rejected = assert.rejects(dropped, error => error.code === 'search-superseded');
  const latest = source.search({ query: '戊' }); await flush();
  assert.deepEqual(calls, ['甲', '乙', '丙']); await rejected;
  releases[0](); await flush(); assert.deepEqual(calls, ['甲', '乙', '丙', '戊']);
  releases.slice(1).forEach(release => release()); await Promise.all([...first, latest]);
  assert.equal(source.active, 0); assert.equal(source.inflight.size, 0);
});
