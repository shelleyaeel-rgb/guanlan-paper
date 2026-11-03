const test = require('node:test'), assert = require('node:assert/strict');
const { EastmoneyStockUniverseSource, EASTMONEY_UNIVERSE_SOURCE, pageUrl, parsePage, confirmPendingListing } = require('../core/stock-universe-source.cjs');

const NOW = Date.parse('2026-10-19T03:00:00Z');
const stock = (code, overrides = {}) => ({ f12: code, f13: code[0] === '6' ? 1 : 0, f14: '测试证券', f26: 20200101, ...overrides });
const rows = (n = 205) => Array.from({ length: n }, (_, i) => stock(String(i + 1).padStart(6, '0')));
function fixture(data = rows(), options = {}) {
  let now = NOW; const calls = [];
  const request = async (url, signal, gbk, validate) => {
    if (url.includes('/xg/')) return options.html?.(url, signal);
    signal.throwIfAborted(); const page = Number(new URL(url).searchParams.get('pn')); calls.push(page);
    const json = { rc: 0, data: { total: data.length, diff: structuredClone(data.slice((page - 1) * 100, page * 100)) } };
    if (options.response) await options.response(json, page, calls.length, signal);
    if (validate) validate(json); return json;
  };
  const source = new EastmoneyStockUniverseSource(request, { clock: () => now, ...options.config });
  return { source, calls, setTime: time => { now = time; } };
}

test('independent active-universe query uses public current filter, ordered pages and no price filter', () => {
  const url = new URL(pageUrl(2));
  assert.equal(url.hostname, 'push2.eastmoney.com'); assert.equal(url.searchParams.get('pn'), '2');
  assert.equal(url.searchParams.get('fid'), 'f12'); assert.equal(url.searchParams.get('po'), '0');
  assert.equal(url.searchParams.get('fs'), 'm:0 t:6 f:!2,m:0 t:80 f:!2,m:1 t:2 f:!2,m:1 t:23 f:!2');
  assert.equal(url.searchParams.get('fields'), 'f12,f13,f14,f26');
});

test('publishes only complete supported listed symbols and preserves suspended securities', async () => {
  const data = [stock('000001', { f2: '-', f14: '暂停交易' }), stock('600001'), stock('688001'), stock('689009'), stock('688002', { f26: 20261020 })].sort((a, b) => a.f12.localeCompare(b.f12));
  const f = fixture(data), result = await f.source.load();
  assert.deepEqual(result.symbols, ['sh600001', 'sh688001', 'sz000001']);
  assert.equal(result.source, EASTMONEY_UNIVERSE_SOURCE); assert.equal(result.sourceCount, 5); assert.equal(result.excludedCount, 2);
  assert.equal(result.validatedAt, NOW); assert.equal(result.date, '2026-10-19');
  assert.deepEqual(f.calls, [1, 1]);
});

test('cold complete pagination checks both boundary pages and warm load only checks boundaries', async () => {
  const f = fixture(), first = await f.source.load();
  assert.equal(first.symbols.length, 205); assert.deepEqual(f.calls, [1, 2, 3, 1, 3]);
  first.symbols.length = 0;
  f.setTime(NOW + 60000); const progress = [], second = await f.source.load({ onProgress: p => progress.push(p) });
  assert.equal(second.symbols.length, 205); assert.equal(second.validatedAt, NOW);
  assert.deepEqual(f.calls.slice(-2), [1, 3]); assert.equal(progress.at(-1).cached, true);
});

test('concurrent pre-open and live list consumers share one download with independent cancellation', async () => {
  let release, entered, listSignal;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = fixture(rows(), { response: async (_json, page, number, signal) => {
    if (page === 1 && number === 1) { listSignal = signal; entered(); await gate; }
  } });
  const controller = new AbortController(), preparing = f.source.load({ signal: controller.signal }); await started;
  const live = f.source.load(); controller.abort(); await assert.rejects(preparing); assert.equal(listSignal.aborted, false);
  release(); assert.equal((await live).symbols.length, 205); assert.deepEqual(f.calls, [1, 2, 3, 1, 3]);
});

test('preparation renews an independent list five minutes before expiry without extending old timestamps', async () => {
  const f = fixture(); const first = await f.source.load({ refreshBeforeMs: 300000 });
  f.setTime(NOW + 24 * 60000); const warm = await f.source.load({ refreshBeforeMs: 300000 });
  assert.equal(warm.validatedAt, first.validatedAt); assert.equal(f.calls.length, 7);
  f.setTime(NOW + 25 * 60000); const renewed = await f.source.load({ refreshBeforeMs: 300000 });
  assert.equal(renewed.validatedAt, NOW + 25 * 60000); assert.equal(f.calls.length, 12);
});

test('30 minute expiry, Beijing date rollover and clock rollback rebuild the whole universe', async t => {
  for (const [name, initial, next] of [['expiry', NOW, NOW + 1800000], ['day', Date.parse('2026-10-19T15:59:50Z'), Date.parse('2026-10-19T16:00:01Z')], ['rollback', NOW, NOW - 1]]) {
    await t.test(name, async () => {
      const f = fixture(); f.setTime(initial); await f.source.load(); const count = f.calls.length;
      f.setTime(next); const result = await f.source.load();
      assert.equal(f.calls.length - count, 5); assert.equal(result.validatedAt, next);
    });
  }
});

test('invalid pagination, listing dates and identities cannot publish a universe', async t => {
  for (const [name, change] of [
    ['missing row', json => json.data.diff.pop()],
    ['duplicate', json => { json.data.diff[1] = json.data.diff[0]; }],
    ['market mismatch', json => { json.data.diff[0].f13 = 1; }],
    ['numeric identity', json => { json.data.diff[0].f12 = 1; }],
    ['missing listing date', json => { delete json.data.diff[0].f26; }],
    ['invalid calendar date', json => { json.data.diff[0].f26 = 20260230; }],
    ['missing name', json => { json.data.diff[0].f14 = '-'; }],
    ['wrong provider status', json => { json.rc = 1; }],
    ['invalid total', json => { json.data.total = 20000; }],
  ]) await t.test(name, async () => {
    const f = fixture(rows(), { response: (json, page) => { if (page === 2) change(json); } });
    await assert.rejects(f.source.load(), /未使用不完整股票池/); assert.equal(f.source.cache, null);
  });
});

test('provider total changing on a middle page rejects otherwise complete pages', async () => {
  const f = fixture(rows(), { response: (json, page) => { if (page === 2) json.data.total++; } });
  await assert.rejects(f.source.load(), /总数.*变化/); assert.equal(f.source.cache, null);
});

test('duplicate identities across page boundaries reject the complete-length response', async () => {
  const f = fixture(rows(), { response: (json, page) => { if (page === 2) json.data.diff[0] = stock('000100'); } });
  await assert.rejects(f.source.load(), /分页重复或排序改变/); assert.equal(f.source.cache, null);
});

test('boundary membership changes with unchanged total reject the result before publication', async () => {
  const f = fixture(rows(), { response: (json, page, n) => { if (page === 1 && n > 1) json.data.diff[0] = stock('000000'); } });
  await assert.rejects(f.source.load(), /获取期间发生变化/); assert.equal(f.source.cache, null);
});

test('after quote collection validate detects a changed last page even if count remains unchanged', async () => {
  let changed = false;
  const f = fixture(rows(), { response: (json, page) => { if (changed && page === 3) json.data.diff.at(-1).f26 = 20210101; } });
  const universe = await f.source.load(); changed = true;
  await assert.rejects(f.source.validate(universe), /获取期间发生变化/); assert.equal(f.source.cache, null);
});

test('failed endpoint is locally cooled down and then can recover without retaining failed lists', async () => {
  let broken = true;
  const f = fixture(rows(), { response: () => { if (broken) throw Error('HTTP 503'); } });
  await assert.rejects(f.source.load(), /HTTP 503/); const count = f.calls.length;
  await assert.rejects(f.source.load(), error => error.code === 'universe-cooldown' && /北京时间/.test(error.message));
  assert.equal(f.calls.length, count); broken = false; f.setTime(NOW + 60001);
  const recovered = await f.source.load(); assert.equal(recovered.symbols.length, 205); assert.equal(f.source.retryAt, 0);
});

test('an aborted request makes no network call and does not impose source failure cooldown', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.source.load({ signal: controller.signal }), /abort/i);
  assert.equal(f.calls.length, 0); assert.equal(f.source.retryAt, 0);
  assert.equal((await f.source.load()).symbols.length, 205);
});

test('a source change is rejected even if the supplied list has current timestamps', async () => {
  const f = fixture(), universe = await f.source.load();
  await assert.rejects(f.source.validate({ ...universe, source: '新浪' }), /来源不一致/);
});

test('bare parsePage rejects empty page and unexpected B-share identities', () => {
  assert.throws(() => parsePage({ rc: 0, data: { total: 1, diff: [] } }, 1), /不完整/);
  assert.throws(() => parsePage({ rc: 0, data: { total: 1, diff: [stock('900001', { f13: 1 })] } }, 1), /市场与代码/);
});

const ipoRow = { symbol: 'sz001381', name: '测试新股' };
function ipoHtml(overrides = {}, stamp = '2026-10-19 11:00:00') {
  const info = { SECURITY_CODE: '001381', SECURITY_NAME: '测试新股', TRADE_MARKET_CODE: '069001002001', TRADE_MARKET: '深圳证券交易所',
    APPLY_DATE: '2026-10-19 00:00:00', LISTING_DATE: null, CONTINUOUS_1WORD_NUM: '待上市', ...overrides };
  return `<!-- ${stamp} at server[200] -->\n<script>var info= ${JSON.stringify(info)};</script>`;
}

test('missing quote-list listing date requires same-day matching public IPO evidence before exclusion', async () => {
  let proofs = 0;
  const f = fixture([stock('000001'), stock('001381', { f14: '测试新股', f26: '-' })], { html: () => { proofs++; return ipoHtml(); } });
  const result = await f.source.load();
  assert.deepEqual(result.symbols, ['sz000001']); assert.equal(result.excludedCount, 1);
  assert.equal(result.pendingEvidence[0].symbol, 'sz001381'); assert.equal(result.pendingEvidence[0].state, 'pending-listing');
  assert.equal(result.pendingEvidence[0].sourceAt, NOW); assert.equal(proofs, 1);
  await f.source.validate(result); assert.equal(proofs, 2);
});

test('unknown, stale, mismatched and already-listed IPO evidence never justify dropping a symbol', async t => {
  for (const [name, overrides, stamp] of [
    ['wrong code', { SECURITY_CODE: '001382' }], ['wrong market', { TRADE_MARKET_CODE: '069001001001' }],
    ['wrong market name', { TRADE_MARKET: '上海证券交易所' }], ['wrong issuer', { SECURITY_NAME: '其他新股' }],
    ['unknown state', { CONTINUOUS_1WORD_NUM: null }], ['already listed', { CONTINUOUS_1WORD_NUM: 3, LISTING_DATE: '2026-10-16 00:00:00' }],
    ['listing day reached', { LISTING_DATE: '2026-10-19 00:00:00' }], ['missing subscription date', { APPLY_DATE: null }],
    ['bad listing date', { LISTING_DATE: '2026-02-30 00:00:00' }], ['stale date', {}, '2026-10-16 11:00:00'],
    ['stale same day', {}, '2026-10-19 10:29:59'], ['future timestamp', {}, '2026-10-19 11:02:00'],
  ]) await t.test(name, () => assert.throws(() => confirmPendingListing(ipoHtml(overrides, stamp), ipoRow, NOW), /未使用不完整股票池/));
  assert.throws(() => confirmPendingListing('<html>unavailable</html>', ipoRow, NOW), /补证/);
});

test('explicit future IPO listing date can exclude only until its listing date arrives', () => {
  const html = ipoHtml({ LISTING_DATE: '2026-10-20 00:00:00' });
  assert.equal(confirmPendingListing(html, ipoRow, NOW).listedAt, '2026-10-20');
  assert.throws(() => confirmPendingListing(ipoHtml({ LISTING_DATE: '2026-10-20 00:00:00' }, '2026-10-20 11:00:00'), ipoRow, NOW + 86400000), /未证实尚未上市/);
});

test('missing or failed IPO evidence leaves the whole universe unpublished', async () => {
  const f = fixture([stock('000001'), stock('001381', { f14: '测试新股', f26: '-' })], { html: () => '<html>error</html>' });
  await assert.rejects(f.source.load(), /补证/); assert.equal(f.source.cache, null);
});

test('cached exclusions are rechecked and invalidated when an IPO starts listing', async () => {
  let listed = false;
  const f = fixture([stock('000001'), stock('001381', { f14: '测试新股', f26: '-' })], {
    html: () => ipoHtml(listed ? { LISTING_DATE: '2026-10-19 00:00:00', CONTINUOUS_1WORD_NUM: 1 } : {})
  });
  const universe = await f.source.load(); assert.equal(universe.symbols.length, 1);
  listed = true;
  await assert.rejects(f.source.validate(universe), /未证实尚未上市/);
  assert.equal(f.source.cache, null);
  await assert.rejects(f.source.load(), error => error.code === 'universe-cooldown');
});
