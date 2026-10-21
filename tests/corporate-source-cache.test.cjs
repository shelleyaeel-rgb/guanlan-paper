'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { CorporateSource } = require('../core/corporate-source.cjs');
const NOW = Date.parse('2026-10-19T10:00:00+08:00');
const input = { symbol: 'sh688685', fromDate: '2026-10-05' };
const response = value => ({ ok: true, json: async () => value });
const empty = url => response(new URL(url).hostname === 'np-anotice-stock.eastmoney.com'
  ? { success: 1, data: { list: [], total_hits: 0, page_index: 1 } }
  : { success: true, result: { data: [], count: 0, pages: 0 } });

test('超过100只自选仍复用有效公司行为证据，缓存不伪造新的获取时间', async () => {
  let calls = 0;
  const source = new CorporateSource(async url => { calls++; return empty(url); }, { clock: () => NOW, transportOptions: { minIntervalMs: 0 } });
  const first = await source.get(input);
  for (let i = 0; i < 150; i++) await source.get({ ...input, symbol: `sh${600000 + i}` });
  const before = calls, again = await source.get(input);
  assert.equal(again.status, 'ready'); assert.equal(again.cached, true);
  assert.equal(again.fetchedAt, first.fetchedAt); assert.equal(calls, before);
});

test('失败结果短期复用保持不可用，到期或主动刷新重新请求成功后才能恢复', async () => {
  let calls = 0, now = NOW, failed = true;
  const source = new CorporateSource(async url => {
    calls++; if (failed && url.includes('np-anotice')) throw Error('network failure');
    return empty(url);
  }, { clock: () => now, transportOptions: { minIntervalMs: 0, retryBaseMs: 0 } });
  const first = await source.get(input), before = calls;
  failed = false; now += 1000;
  const cached = await source.get(input);
  assert.equal(cached.status, 'unavailable'); assert.equal(cached.coverageComplete, false);
  assert.equal(cached.fetchedAt, first.fetchedAt); assert.equal(calls, before);
  const refreshed = await source.get({ ...input, force: true });
  assert.equal(refreshed.status, 'ready'); assert.equal(refreshed.coverageComplete, true); assert.ok(calls > before);
  failed = true; await source.get({ ...input, force: true });
  failed = false; now += 60000;
  assert.equal((await source.get(input)).status, 'ready');
});

test('公司行为主动重核验也遵守来源567冷却，失败不会回退旧成功证据', async () => {
  let now = NOW, rejected = false, indexCalls = 0;
  const source = new CorporateSource(async url => {
    if (url.includes('np-anotice')) { indexCalls++; if (rejected) return { ok: false, status: 567 }; }
    return empty(url);
  }, { clock: () => now, transportOptions: { minIntervalMs: 0 } });
  assert.equal((await source.get(input)).status, 'ready');
  rejected = true;
  const denied = await source.get({ ...input, force: true });
  assert.equal(denied.status, 'unavailable'); assert.equal(denied.coverageComplete, false);
  assert.equal(denied.acquisition.issues[0].code, 'http-567'); assert.equal(indexCalls, 2);
  const retry = await source.get({ ...input, force: true });
  assert.equal(retry.status, 'unavailable'); assert.equal(retry.acquisition.issues[0].code, 'source-cooldown');
  assert.equal(indexCalls, 2);
  rejected = false; now += 60000;
  assert.equal((await source.get({ ...input, force: true })).status, 'ready'); assert.equal(indexCalls, 3);
});

test('一只股票的567拒绝不污染其他股票的公告覆盖结论或阻止其真实取证', async () => {
  const requests = [], deniedCode = input.symbol.slice(2), allowed = { ...input, symbol: 'sh600066' };
  const source = new CorporateSource(async url => {
    const query = new URL(url);
    if (query.hostname === 'np-anotice-stock.eastmoney.com') {
      requests.push(query.searchParams.get('stock_list'));
      if (query.searchParams.get('stock_list') === deniedCode) return { ok: false, status: 567 };
    }
    return empty(url);
  }, { clock: () => NOW, transportOptions: { minIntervalMs: 0 } });
  assert.equal((await source.get(input)).status, 'unavailable');
  const successful = await source.get(allowed);
  assert.equal(successful.status, 'ready'); assert.equal(successful.coverageComplete, true);
  assert.deepEqual(successful.acquisition.issues, []);
  assert.deepEqual(requests, [deniedCode, '600066']);
  const retry = await source.get({ ...input, force: true });
  assert.equal(retry.status, 'unavailable'); assert.equal(retry.acquisition.issues[0].code, 'source-cooldown');
  assert.equal(retry.acquisition.issues[0].scope, 'request'); assert.equal(retry.acquisition.issues[0].attempts, 0);
  assert.match(retry.error, /本次未发送/); assert.doesNotMatch(retry.error, /\d+ 秒后再试/);
  assert.equal(requests.length, 2);
  assert.equal((await source.get(allowed)).cached, true);
});
