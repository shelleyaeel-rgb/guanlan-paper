const test = require('node:test');
const assert = require('node:assert/strict');
const { Research, parseProfile, parseFinance, parseValuation, parseNotices, externalUrl, TTL } = require('../core/research.cjs');
const sample = require('./fixtures/research-data.cjs');
const NOW = Date.parse('2026-09-30T12:00:00+08:00');
const response = data => ({ ok: true, json: async () => data });

test('company identity, industry and listing date are validated without executing source text', () => {
  const raw = sample.profile(); raw.result.data[0].MAIN_BUSINESS = '<img onerror="alert(1)">';
  const result = parseProfile(raw, 'sh600519');
  assert.equal(result.company, '测试公司 sh600519'); assert.equal(result.listedAt, '2001-08-27');
  assert.equal(result.business, '<img onerror="alert(1)">');
  assert.throws(() => parseProfile(raw, 'sz000001'), /代码不符/);
  assert.equal(parseProfile(sample.data([]), 'sh600519'), null);
  assert.throws(() => parseProfile({ success: true, result: {} }, 'sh600519'), /格式异常/);
});
test('finance preserves cumulative amounts, growth percentages and latest versus annual periods', () => {
  const result = parseFinance(sample.finance(), 'sh600519', NOW);
  assert.equal(result.latest.reportDate, '2026-06-30'); assert.equal(result.latest.revenue, 920e8);
  assert.equal(result.latest.revenueYoY, 1.3); assert.equal(result.latest.profitYoY, -1.9);
  assert.equal(result.latest.operatingCash, 700e8); assert.equal(result.latest.roe, 16.75);
  assert.deepEqual(result.annual.map(r => r.reportDate), ['2025-12-31', '2024-12-31', '2023-12-31']);
  assert.equal(result.latest.noticeDate, '2026-08-15'); assert.equal(result.latest.updateDate, '2026-08-20');
});
test('finance retains losses, zero and source currency; missing values never become zero', () => {
  const r = sample.financialRow(); Object.assign(r, { CURRENCY: 'USD', PARENTNETPROFIT: -12e8, KCFJCXSYJLR: 0, NETCASH_OPERATE_PK: '-', ROEJQ: null, TOTALOPERATEREVETZ: '', ZCFZL: false, NOTICE_DATE: null });
  const result = parseFinance(sample.data([r]), 'sh600519', NOW).latest;
  assert.equal(result.currency, 'USD'); assert.equal(result.profit, -12e8); assert.equal(result.adjustedProfit, 0);
  for (const field of ['operatingCash', 'roe', 'revenueYoY', 'debtRatio', 'noticeDate']) assert.equal(result[field], null);
});
test('finance excludes future disclosures and revisions and rejects invalid or duplicate periods', () => {
  const raw = sample.finance(); raw.result.data[0].NOTICE_DATE = '2026-10-01';
  assert.equal(parseFinance(raw, 'sh600519', NOW).latest.reportDate, '2025-12-31');
  raw.result.data[1].UPDATE_DATE = '2026-10-01';
  assert.equal(parseFinance(raw, 'sh600519', NOW).latest.reportDate, '2024-12-31');
  assert.throws(() => parseFinance(sample.data([sample.financialRow(), sample.financialRow()]), 'sh600519', NOW), /重复/);
  assert.throws(() => parseFinance(sample.data([{ ...sample.financialRow(), REPORT_DATE: '2026-02-30' }]), 'sh600519', NOW), /报告期/);
  assert.throws(() => parseFinance(sample.finance('sz000001'), 'sh600519', NOW), /代码不符/);
});
test('valuation preserves negative PE and validates market, missing time and null fields', () => {
  const raw = sample.valuation(); raw.data.diff[0].f124 = 0; raw.data.diff[0].f20 = '-';
  let result = parseValuation(raw, 'sh600519', NOW);
  assert.equal(result.pe, -2.3); assert.equal(result.marketCap, null); assert.equal(result.quoteTime, null);
  raw.data.diff[0].f124 = NOW / 1000 + 3600;
  assert.equal(parseValuation(raw, 'sh600519', NOW).quoteTime, null);
  raw.data.diff[0].f13 = 0; assert.throws(() => parseValuation(raw, 'sh600519', NOW), /不符/);
});
test('announcements distinguish an empty result from an invalid response', () => {
  assert.equal(parseNotices(sample.notices(), 'sh600519', NOW).items[0].categories[0], '半年度报告');
  assert.deepEqual(parseNotices({ success: 1, data: { list: [], total_hits: 0 } }, 'sh600519', NOW), { items: [], total: 0 });
  assert.throws(() => parseNotices({ success: 0, data: { list: [], total_hits: 0 } }, 'sh600519', NOW), /格式异常/);
  assert.throws(() => parseNotices({ success: 1, data: { list: [], total_hits: 1 } }, 'sh600519', NOW), /格式异常/);
  assert.throws(() => parseNotices(sample.notices('sz000001'), 'sh600519', NOW), /不符/);
  const raw = sample.notices(); raw.data.list[0].notice_date = '2026-10-01';
  assert.equal(parseNotices(raw, 'sh600519', NOW).items.length, 0);
});
test('external links are generated from validated symbols and announcement identifiers only', () => {
  assert.equal(externalUrl({ symbol: '600519', kind: 'notice', article: 'AN202608141827994403' }), 'https://data.eastmoney.com/notices/detail/600519/AN202608141827994403.html');
  assert.match(externalUrl({ symbol: 'sz000001', kind: 'profile' }), /code=SZ000001$/);
  for (const input of [{ symbol: 'file:///a', kind: 'profile' }, { symbol: '600519', kind: 'notice', article: 'https://evil.test' }, { symbol: '600519', kind: '__proto__' }]) assert.throws(() => externalUrl(input));
});
test('research service caches each section and symbol separately, expires and refreshes explicitly', async () => {
  let calls = 0, now = NOW;
  const service = new Research(async url => { calls++; const symbol = new URL(url).searchParams.get('filter').includes('000001') ? 'sz000001' : 'sh600519'; return response(sample.profile(symbol)); }, { clock: () => now });
  const input = { symbol: 'sh600519', section: 'profile' };
  const first = await service.get(input); assert.equal(first.status, 'ready');
  assert.equal((await service.get(input)).cached, true); assert.equal(calls, 1);
  await service.get({ ...input, force: true }); assert.equal(calls, 2);
  now += TTL.profile + 1; await service.get(input); assert.equal(calls, 3);
  assert.equal((await service.get({ ...input, symbol: 'sz000001' })).data.company, '测试公司 sz000001'); assert.equal(calls, 4);
});
test('concurrent requests share a fetch; a slow stock cannot overwrite another stock', async () => {
  let resolve, calls = 0;
  const service = new Research(async url => { calls++; if (url.includes('600519')) await new Promise(r => { resolve = r; }); return response(sample.profile(url.includes('600519') ? 'sh600519' : 'sz000001')); }, { clock: () => NOW });
  const a = service.get({ symbol: '600519', section: 'profile' }), b = service.get({ symbol: '600519', section: 'profile' });
  const other = await service.get({ symbol: '000001', section: 'profile' }); assert.equal(other.symbol, 'sz000001');
  resolve(); assert.deepEqual(await a, await b); assert.equal(calls, 2); assert.equal(service.pending.size, 0);
});
test('failed refresh retains original data time with an explicit stale status until recovery', async () => {
  let now = NOW, fail = false;
  const service = new Research(async () => { if (fail) throw Error('network offline'); return response(sample.finance()); }, { clock: () => now });
  const input = { symbol: '600519', section: 'finance' }, first = await service.get(input);
  fail = true; now += 1000;
  const stale = await service.get({ ...input, force: true });
  assert.equal(stale.status, 'stale'); assert.equal(stale.fetchedAt, first.fetchedAt); assert.equal(stale.checkedAt, now); assert.deepEqual(stale.data, first.data);
  assert.equal((await service.get(input)).status, 'stale');
  const unavailable = await service.get({ ...input, symbol: 'sz000001' }); assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.data, null);
  fail = false; now += 1000; assert.equal((await service.get(input)).status, 'ready');
});
test('request failures stay isolated and valuation uses a single successful provider response', async () => {
  const service = new Research(async url => {
    if (url.includes('FINANCE')) return response(sample.finance());
    if (url.includes('82.push2')) return response(sample.valuation());
    return { ok: false, status: 503 };
  }, { clock: () => NOW });
  const result = await Promise.all(['profile', 'finance', 'valuation', 'notices'].map(section => service.get({ symbol: '600519', section })));
  assert.deepEqual(result.map(r => r.status), ['unavailable', 'ready', 'ready', 'unavailable']);
  assert.match(result[0].error, /503/); assert.equal(result[2].data.pe, -2.3);
});
test('invalid IPC input never reaches the network', async () => {
  const service = new Research(() => { assert.fail('network must not be called'); });
  for (const input of [null, { symbol: '600519', section: '__proto__' }, { symbol: 'sh000001', section: 'finance' }]) await assert.rejects(service.get(input));
});
