'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IndexMarket, INDEX_CATALOG, parseEastmoneyIndices, parseTencentIndices, zonedTimestamp } = require('../core/index-market.cjs');

const NOW = Date.parse('2026-10-28T02:35:00Z');
const spec = id => INDEX_CATALOG.find(item => item.id === id);
function row(item, extra = {}) {
  const [market, code] = item.eastmoney.split('.');
  return { f12: code, f13: Number(market), f14: item.name, f2: 102, f3: 2, f4: 2,
    f15: 103, f16: 99, f17: 100, f18: 100, f124: Math.floor(NOW / 1000) - 60, ...extra };
}
const json = rows => ({ rc: 0, data: { diff: rows } });
const response = payload => ({ ok: true, json: async () => payload });
function tencent(item, dateTime, extra = {}) {
  const fields = Array(35).fill('');
  Object.assign(fields, { 1: item.name, 2: item.tencentCode, 3: '102', 4: '100', 5: '101', 30: dateTime, 31: '2', 32: '2', 33: '103', 34: '99' }, extra);
  return `v_${item.tencent}="${fields.join('~')}";`;
}
const textResponse = payload => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(payload).buffer });

test('catalogue identifies 22 read-only indices and distinguishes Nasdaq Composite from Nasdaq 100', () => {
  assert.equal(INDEX_CATALOG.length, 22);
  assert.equal(new Set(INDEX_CATALOG.map(item => item.id)).size, 22);
  assert.equal(new Set(INDEX_CATALOG.map(item => item.eastmoney)).size, 22);
  assert.equal(spec('hk-hstech').eastmoney, '124.HSTECH');
  assert.equal(spec('us-nasdaq').eastmoney, '100.NDX');
  assert.equal(spec('us-nasdaq100').eastmoney, '100.NDX100');
  assert.ok(INDEX_CATALOG.every(item => item.canTrade === false && item.instrumentType === 'index'));
});

test('matches index code and market rather than response order, and ignores unsolicited identities', () => {
  const a = spec('cn-shanghai'), b = spec('cn-shenzhen');
  const parsed = parseEastmoneyIndices(json([row(b, { f2: 202 }), row(a), row(a, { f13: 0, f2: 999 })]), [a, b], NOW);
  assert.equal(parsed.items.get(a.id).price, 102);
  assert.equal(parsed.items.get(b.id).price, 202);
  assert.equal(parsed.items.size, 2);
  assert.equal(parsed.errors.size, 0);
});

test('epoch quotation time is converted to each market time independently of Chinese trading hours', () => {
  const us = spec('us-sp500'), jp = spec('asia-nikkei225');
  const quoteAt = Date.parse('2026-10-27T20:00:00Z');
  const parsed = parseEastmoneyIndices(json([row(us, { f124: quoteAt / 1000 }), row(jp, { f124: quoteAt / 1000 })]), [us, jp], NOW);
  assert.equal(parsed.items.get(us.id).quoteTime, '2026-10-27 16:00:00');
  assert.equal(parsed.items.get(jp.id).quoteTime, '2026-10-28 05:00:00');
  assert.equal(parsed.items.get(us.id).quoteAt, quoteAt);
  assert.equal(parsed.items.get(us.id).fetchedAt, NOW);
  assert.equal(parsed.items.get(us.id).status, 'ok');
});

test('absent numeric fields remain null while valid unchanged values remain zero', () => {
  const a = spec('cn-shanghai');
  const missing = parseEastmoneyIndices(json([row(a, { f3: '-', f4: null, f18: '', f15: false })]), [a], NOW).items.get(a.id);
  assert.equal(missing.changePct, null);
  assert.equal(missing.change, null);
  assert.equal(missing.prevClose, null);
  assert.equal(missing.high, null);
  const zero = parseEastmoneyIndices(json([row(a, { f3: '0', f4: 0, f18: 102 })]), [a], NOW).items.get(a.id);
  assert.equal(zero.changePct, 0);
  assert.equal(zero.change, 0);
});

test('can derive changes only from a valid previous close', () => {
  const a = spec('cn-shanghai');
  const item = parseEastmoneyIndices(json([row(a, { f3: undefined, f4: undefined })]), [a], NOW).items.get(a.id);
  assert.equal(item.change, 2);
  assert.ok(Math.abs(item.changePct - 2) < 1e-9);
});

test('rejects invalid price, missing/future timestamps and duplicate identities per row', () => {
  const requested = INDEX_CATALOG.slice(0, 5);
  const parsed = parseEastmoneyIndices(json([
    row(requested[0], { f2: 0 }), row(requested[1], { f124: null }),
    row(requested[2], { f124: NOW / 1000 + 16 }), row(requested[3]), row(requested[3]), row(requested[4]),
  ]), requested, NOW);
  assert.equal(parsed.items.size, 1);
  assert.equal(parsed.items.get(requested[4].id).price, 102);
  assert.equal(parsed.errors.size, 4);
  assert.match(parsed.errors.get(requested[3].id), /重复/);
});

test('Tencent supports mainland/HK timestamp shapes and New York daylight saving without a fixed offset', () => {
  const cn = spec('cn-shanghai'), hk = spec('hk-hsi'), us = spec('us-sp500');
  const parsed = parseTencentIndices(tencent(cn, '20261028103000') + tencent(hk, '2026/10/28 10:15:00') + tencent(us, '2026-10-27 16:00:00'), [cn, hk, us], NOW);
  assert.equal(parsed.items.get(cn.id).quoteAt, Date.parse('2026-10-28T02:30:00Z'));
  assert.equal(parsed.items.get(hk.id).quoteAt, Date.parse('2026-10-28T02:15:00Z'));
  assert.equal(parsed.items.get(us.id).quoteAt, Date.parse('2026-10-27T20:00:00Z'));
  assert.equal(zonedTimestamp('2026-12-01 16:00:00', 'America/New_York'), Date.parse('2026-12-01T21:00:00Z'));
  assert.equal(zonedTimestamp('2026-11-01 01:30:00', 'America/New_York'), null);
  assert.equal(zonedTimestamp('2026-03-08 02:30:00', 'America/New_York'), null);
  assert.equal(zonedTimestamp('2026-02-30 10:00:00', 'Asia/Shanghai'), null);
});

test('Tencent rejects mismatched identifiers and unavailable values instead of accepting a stock quote', () => {
  const a = spec('cn-shanghai'), b = spec('us-sp500');
  const parsed = parseTencentIndices(tencent(a, '20261028103000', { 2: '600000' }) + tencent(b, '2026-10-27 16:00:00', { 3: '' }), [a, b], NOW);
  assert.equal(parsed.items.size, 0);
  assert.match(parsed.errors.get(a.id), /代码/);
  assert.match(parsed.errors.get(b.id), /点位/);
});

test('overview coalesces concurrent loads, caches for 30 seconds and protects its cached objects', async () => {
  let calls = 0, now = NOW;
  const source = new IndexMarket(async () => { calls++; return response(json(INDEX_CATALOG.map(item => row(item)))); }, { clock: () => now });
  const [a, b] = await Promise.all([source.overview(), source.overview({ force: true })]);
  assert.equal(calls, 1);
  assert.equal(a.items.length, 22);
  a.items[0].price = -1;
  assert.equal(b.items[0].price, 102);
  assert.equal((await source.overview()).items[0].price, 102);
  assert.equal(calls, 1);
  now += 30001;
  await source.overview();
  assert.equal(calls, 2);
  await source.overview({ force: true });
  assert.equal(calls, 3);
});

test('partial primary failure uses Tencent only for missing supported indices and retains other valid rows', async () => {
  const missing = spec('cn-shanghai'), unavailable = spec('eu-dax');
  const urls = [];
  const source = new IndexMarket(async url => {
    urls.push(url);
    if (url.includes('eastmoney')) return response(json(INDEX_CATALOG.filter(item => ![missing.id, unavailable.id].includes(item.id)).map(item => row(item))));
    assert.equal(url, `https://qt.gtimg.cn/q=${missing.tencent}`);
    return textResponse(tencent(missing, '20261028103000'));
  }, { clock: () => NOW });
  const result = await source.overview();
  assert.equal(urls.length, 2);
  assert.equal(result.items.find(item => item.id === missing.id).provider, 'tencent');
  const bad = result.items.find(item => item.id === unavailable.id);
  assert.equal(bad.status, 'unavailable');
  assert.equal(bad.price, null);
  assert.equal(bad.quoteAt, null);
  assert.match(bad.error, /未返回/);
  assert.equal(result.items.filter(item => item.status === 'ok').length, 21);
});

test('failed refresh retains values and successful acquisition times but exposes a stale status and error', async () => {
  let fail = false, now = NOW;
  const source = new IndexMarket(async () => {
    if (fail) throw Error('测试网络离线');
    return response(json(INDEX_CATALOG.map(item => row(item))));
  }, { clock: () => now });
  const before = await source.overview();
  now += 60000; fail = true;
  const after = await source.overview();
  assert.ok(after.items.every(item => item.status === 'stale' && item.price === 102 && item.fetchedAt === NOW));
  assert.equal(after.items[0].quoteAt, before.items[0].quoteAt);
  assert.match(after.items[0].error, /测试网络离线/);
  assert.equal(after.fetchedAt, now);
  assert.equal(after.attemptedAt, now);
});

test('a source timestamp regression preserves the last observation with an explicit stale message', async () => {
  let seconds = NOW / 1000 - 60;
  const source = new IndexMarket(async () => response(json(INDEX_CATALOG.map(item => row(item, { f124: seconds })))), { clock: () => NOW });
  await source.overview();
  seconds -= 300;
  const after = await source.overview({ force: true });
  assert.ok(after.items.every(item => item.status === 'stale'));
  assert.equal(after.items[0].quoteAt, NOW - 60000);
  assert.match(after.items[0].error, /早于上次/);
});

test('cold-start network failure returns the entire catalogue with null data and retryable errors', async () => {
  const source = new IndexMarket(async () => { throw Error('网络不可用'); }, { clock: () => NOW });
  const result = await source.overview();
  assert.equal(result.items.length, 22);
  assert.ok(result.items.every(item => item.status === 'unavailable' && item.price === null && item.changePct === null && item.fetchedAt === null));
  assert.ok(result.items.every(item => item.error.includes('网络不可用')));
});
