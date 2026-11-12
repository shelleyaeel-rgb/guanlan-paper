const test = require('node:test');
const assert = require('node:assert/strict');
const { Market } = require('../core/market.cjs');
const { INDEX_SYMBOLS, MARKET_REGIME_POLICY, evaluateMarketRegime, validateMarketRegimeSnapshot } = require('../core/market-regime.cjs');
const { MarketRegimeService } = require('../core/market-regime-service.cjs');
const { cachedBreadthLoader } = require('../core/market-policy.cjs');
const { AgencyService } = require('../core/agency-service.cjs');
const { monitoringCheck } = require('../core/agency-monitoring.cjs');
const { Engine, initialState } = require('../core/engine.cjs');

const START = Date.parse('2026-10-16T10:00:00+08:00');
function fixture(now = START, { direction = 1, advancing = 0.65, highVolatility = false } = {}) {
  const bars = Array.from({ length: 70 }, (_, i) => {
    const close = 100 + direction * i * 0.2;
    return { date: new Date(Date.parse('2026-10-15T00:00:00Z') - (69 - i) * 86400000).toISOString().slice(0, 10),
      open: close, close, high: close + (highVolatility ? 4 : 0.2), low: close - (highVolatility ? 4 : 0.2), volume: 10000 };
  });
  const histories = Object.fromEntries(INDEX_SYMBOLS.map(symbol => [symbol, { symbol, bars, source: 'fixture', fetchedAt: now, adjustment: '未复权' }]));
  const quotes = Object.fromEntries(INDEX_SYMBOLS.map(symbol => [symbol, { symbol, price: bars.at(-1).close, prevClose: bars.at(-1).close, timestamp: now, date: '2026-10-16', source: 'fixture' }]));
  const rows = Array.from({ length: 1200 }, (_, i) => ({ symbol: i < 1000 ? `sh${600000 + i}` : `sz${String(i - 1000).padStart(6, '0')}`, price: 10, changePct: i < 1200 * advancing ? 1 : -1, timestamp: now }));
  return { histories, quotes, breadth: { rows, source: 'fixture', sourceCount: rows.length, excludedCount: 0, startedAt: now - 1000, fetchedAt: now } };
}
function harness(options = {}) {
  let now = START, data = fixture(now, options), fail = false, calls = 0;
  const service = new MarketRegimeService({ clock: () => now,
    indexHistory: async symbol => data.histories[symbol], getQuotes: () => data.quotes,
    loadBreadth: async () => { calls++; if (fail) throw Error('network unavailable'); return data.breadth; } });
  return { service, advance(ms, nextOptions = options) { now += ms; data = fixture(now, nextOptions); }, staleAdvance(ms) { now += ms; },
    setFail() { fail = true; }, now: () => now, calls: () => calls };
}

test('市场环境仅按同日广度和指数波动分配权限，趋势继续作为观察证据', () => {
  const strong = evaluateMarketRegime(fixture(), START);
  assert.equal(strong.status, 'strong'); assert.equal(strong.riskMultiplier, 1); assert.equal(strong.allowBreakout, true);
  assert.equal(strong.metrics.indices.length, 3); assert.ok(strong.metrics.indices.every(index => index.ma20Slope5 > 0));
  assert.equal(strong.metrics.breadth.coverage, 1); assert.match(strong.policyNote, /尚未回测/);
  assert.match(strong.policyNote, /指数中期趋势仅供观察/); assert.equal(strong.policyVersion, MARKET_REGIME_POLICY.version);
  assert.equal(validateMarketRegimeSnapshot(strong, START), strong);
  for (const direction of [-1, 0, 1]) {
    for (const [advancing, status, multiplier] of [[0.6, 'strong', 1], [0.4, 'neutral', 0.5], [0.3, 'weak', 0]]) {
      const result = evaluateMarketRegime(fixture(START, { direction, advancing }), START);
      assert.equal(result.status, status, `direction=${direction}, advancing=${advancing}`);
      assert.equal(result.riskMultiplier, multiplier); assert.equal(result.allowEntry, multiplier > 0);
      assert.equal(result.allowBreakout, multiplier === 1);
      assert.equal(result.metrics.downCount, direction === -1 ? 3 : 0);
      assert.equal(result.metrics.upCount, direction === 1 ? 3 : 0);
      assert.match(result.reason, /指数中期趋势仅供观察，不参与本次交易限制/);
      assert.match(result.reason, /有效报价上涨占比/);
      assert.equal(validateMarketRegimeSnapshot(result, START), result);
    }
  }
});

test('弱广度暂停的观察文案不会把市场条件误归类为资金受限', () => {
  for (const highVolatility of [false, true]) {
    const marketRegime = evaluateMarketRegime(fixture(START, { direction: -1, advancing: 0.3, highVolatility }), START);
    const check = monitoringCheck({ buyable: false, status: '市场环境暂停新开仓', reasons: marketRegime.reasons, marketRegime }, {}, START);
    assert.equal(check.status, 'conditions');
    assert.match(check.reason, /市场广度偏弱/);
  }
});

test('广度35%含边界暂停、55%含边界正常，中间半额，不受三指数下降影响', () => {
  for (const [advancing, status, multiplier] of [[0.35, 'weak', 0], [0.351, 'neutral', 0.5], [0.549, 'neutral', 0.5], [0.55, 'strong', 1]]) {
    const result = evaluateMarketRegime(fixture(START, { direction: -1, advancing }), START);
    assert.equal(result.metrics.downCount, 3); assert.equal(result.status, status);
    assert.equal(result.riskMultiplier, multiplier); assert.equal(result.allowEntry, multiplier > 0);
    assert.equal(result.allowBreakout, multiplier === 1);
  }
});

test('三指数向下且广度60%时高波动仍半额禁突破；平盘计入广度分母', () => {
  const input = fixture(START, { direction: -1, advancing: 0.6, highVolatility: true });
  const result = evaluateMarketRegime(input, START);
  assert.equal(result.status, 'strong'); assert.equal(result.riskMultiplier, 0.5); assert.equal(result.allowBreakout, false);
  assert.equal(result.allowEntry, true); assert.equal(result.metrics.downCount, 3);
  assert.ok(result.metrics.indices[0].atrRatio >= MARKET_REGIME_POLICY.highAtrRatio);
  assert.equal(validateMarketRegimeSnapshot(result, START), result);
  input.breadth.rows.slice(0, 600).forEach(row => { row.changePct = 0; });
  const flat = evaluateMarketRegime(input, START);
  assert.equal(flat.metrics.breadth.unchanged, 600); assert.equal(flat.metrics.breadth.advanceRatio, 0.1);
  assert.equal(flat.status, 'weak'); assert.equal(flat.allowEntry, false);
});

test('指数缺失、日线滞后、未完成K线、跨日广度和覆盖不足全部关停新开仓', () => {
  const mutations = [
    input => { delete input.quotes.sh000001; },
    input => { input.histories.sh000001.bars = input.histories.sh000001.bars.slice(0, -1); },
    input => { input.histories.sh000001.adjustment = '前复权'; },
    input => { input.quotes.sh000001.timestamp = START - 90001; },
    input => { input.breadth.fetchedAt = START - 86400000; },
    input => { input.breadth.rows.slice(0, 300).forEach(row => { row.timestamp = START - 86400000; }); },
    input => { input.breadth.rows.push(input.breadth.rows[0]); }
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input); const result = evaluateMarketRegime(input, START);
    assert.equal(result.status, 'unknown', result.reason); assert.equal(result.riskMultiplier, 0); assert.equal(result.allowEntry, false);
  }
  const input = fixture();
  input.histories.sh000001.bars.push({ date: '2026-10-16', open: 999, high: 999, low: 999, close: 999, volume: 1000 });
  assert.equal(evaluateMarketRegime(input, START).metrics.indices[0].asOf, '2026-10-15');
});

test('成交前校验拒绝旧版、未知版本、过期、跨日、伪造权限及来源时间；不会刷新checkedAt', () => {
  const snapshot = evaluateMarketRegime(fixture(), START);
  assert.equal(MARKET_REGIME_POLICY.version, 2);
  for (const [copy, at] of [[snapshot, START + 90000], [snapshot, START + 86400000], [{ ...snapshot, allowEntry: false }, START],
    [{ ...snapshot, policyVersion: 1 }, START], [{ ...snapshot, policyVersion: MARKET_REGIME_POLICY.version + 1 }, START],
    [{ ...snapshot, status: 'weak' }, START], [{ ...snapshot, allowBreakout: false }, START],
    [{ ...snapshot, metrics: { ...snapshot.metrics, highVolatility: true } }, START],
    [{ ...snapshot, evidence: { quoteTime: START + 1 } }, START]]) {
    const rejected = validateMarketRegimeSnapshot(copy, at);
    assert.equal(rejected.allowEntry, false); assert.equal(rejected.status, 'unknown'); assert.equal(rejected.checkedAt, snapshot.checkedAt);
    assert.equal(rejected.policyVersion, MARKET_REGIME_POLICY.version);
  }
});

test('服务启动和改善等待不同证据跨120秒；降级立即且重启重新确认', async () => {
  const h = harness();
  assert.equal((await h.service.poll()).status, 'unknown');
  h.advance(60000); assert.equal((await h.service.poll()).status, 'unknown');
  h.advance(60000); assert.equal((await h.service.poll()).status, 'strong');
  h.advance(30000, { advancing: 0.2 }); assert.equal((await h.service.poll()).status, 'weak');
  h.advance(30000); assert.equal((await h.service.poll()).status, 'weak');
  h.advance(120000); assert.equal((await h.service.poll()).status, 'strong');
  assert.equal(harness().service.getSnapshot().status, 'unknown');
});

test('相同缓存不累计确认，过期读取不制造新时间', async () => {
  const h = harness();
  await h.service.poll();
  const original = h.service.getSnapshot().checkedAt;
  for (let i = 0; i < 3; i++) { h.staleAdvance(30000); await h.service.poll(); }
  assert.equal(h.service.getSnapshot().allowEntry, false);
  const once = h.service.getSnapshot(); h.staleAdvance(30000); const twice = h.service.getSnapshot();
  assert.equal(twice.checkedAt, once.checkedAt); assert.ok(twice.checkedAt >= original);
});

test('强市波动升高立即半额，波动回落不能立即恢复满额', async () => {
  const h = harness(); await h.service.poll(); h.advance(120000); assert.equal((await h.service.poll()).riskMultiplier, 1);
  h.advance(30000, { highVolatility: true }); const lower = await h.service.poll();
  assert.equal(lower.status, 'strong'); assert.equal(lower.riskMultiplier, 0.5); assert.equal(lower.allowBreakout, false);
  h.advance(30000); assert.equal((await h.service.poll()).riskMultiplier, 0.5);
  h.advance(120000); assert.equal((await h.service.poll()).riskMultiplier, 1);
});

test('服务并发去重限流，网络失败立即unknown，快照副本不允许外部改写内部状态', async () => {
  const h = harness(); const first = h.service.poll(), second = h.service.poll(); assert.equal(first, second);
  await first; await h.service.poll(); assert.equal(h.calls(), 1);
  const copy = h.service.publicState(); copy.allowEntry = true; assert.equal(h.service.publicState().allowEntry, false);
  h.advance(120000); await h.service.poll(); h.advance(30000); h.setFail();
  const failed = await h.service.poll(); assert.equal(failed.status, 'unknown'); assert.match(failed.reason, /network unavailable/);
});

test('指数日线独立白名单入口保持未复权并缓存真实获取时间，股票入口不放宽', async () => {
  let now = START, calls = 0;
  const raw = fixture().histories.sh000001.bars.map(bar => [bar.date, bar.open, bar.close, bar.high, bar.low, 100]);
  const market = new Market(async url => { calls++; assert.match(url, /param=sh000001,day,,,120,$/); return { ok: true, json: async () => ({ code: 0, data: { sh000001: { day: raw } } }) }; }, { clock: () => now });
  const first = await market.indexHistory('sh000001'); now += 30000;
  const cached = await market.indexHistory('sh000001');
  assert.deepEqual(cached.bars, first.bars); assert.deepEqual(cached.dailyEvidence, first.dailyEvidence);
  assert.equal(cached.historyStatus, 'cached'); assert.equal(cached.fetchedAt, START); assert.equal(calls, 1);
  assert.equal(first.adjustment, '未复权');
  await assert.rejects(market.strategyHistory('sh000001'), /请输入/);
  await assert.rejects(market.indexHistory('sh600000'), /仅支持/);
});

test('手动重试发布真实获取进度及上次失败，完成后清除旧错但仍要求持续确认', async () => {
  let now = START, fail = true, release, request;
  const updates = [], data = fixture();
  const service = new MarketRegimeService({ clock: () => now,
    indexHistory: async symbol => data.histories[symbol], getQuotes: () => data.quotes,
    loadBreadth: async options => {
      request = options;
      if (fail) throw Error('选股行情获取超时，未使用不完整股票池');
      options.onProgress({ stage: 'screen-quotes', completed: 500, total: 1200,
        provider: 'sina', providerLabel: '新浪财经', fallbackReason: '腾讯临时不可用' });
      return new Promise(resolve => { release = resolve; });
    }, onChange: snapshot => updates.push(snapshot) });
  const failed = await service.poll();
  const engine = new Engine(initialState()), agency = new AgencyService({ getEngine: () => engine,
    getMarketRegime: () => service.getSnapshot(), clock: () => now });
  assert.equal(agency.publicState().marketRegime.acquisition.stage, 'failed');
  assert.equal(failed.acquisition.loading, false); assert.equal(failed.acquisition.stage, 'failed');
  assert.match(failed.acquisition.lastError, /超时/); assert.equal(failed.acquisition.lastErrorAt, START);
  now += 1000; fail = false;
  const pending = service.poll({ force: true });
  assert.equal(service.poll({ force: true }), pending, 'all strategies share an in-flight acquisition');
  await Promise.resolve();
  const loading = service.getSnapshot();
  assert.equal(request.force, true); assert.equal(loading.acquisition.loading, true);
  assert.equal(loading.acquisition.stage, 'screen-quotes'); assert.equal(loading.acquisition.completed, 500);
  assert.equal(loading.acquisition.lastError, failed.reason);
  assert.equal(loading.checkedAt, failed.checkedAt); assert.equal(loading.expiresAt, failed.expiresAt);
  assert.equal(loading.allowEntry, false);
  const publicMarket = agency.publicState().marketRegime;
  assert.equal(publicMarket.acquisition.loading, true); assert.equal(publicMarket.acquisition.completed, 500);
  assert.equal(publicMarket.acquisition.providerLabel, '新浪财经');
  assert.equal(publicMarket.acquisition.fallbackReason, '腾讯临时不可用');
  assert.equal(publicMarket.allowEntry, false); assert.equal(publicMarket.expiresAt, failed.expiresAt);
  loading.acquisition.completed = 999; assert.equal(service.getSnapshot().acquisition.completed, 500);
  release(data.breadth);
  const recovered = await pending;
  assert.equal(recovered.acquisition.loading, false); assert.equal(recovered.acquisition.stage, 'complete');
  assert.equal(recovered.acquisition.lastError, ''); assert.equal(recovered.acquisition.lastErrorAt, null);
  assert.equal(recovered.acquisition.finishedAt, now);
  assert.equal(recovered.acquisition.source, data.breadth.source);
  assert.match(recovered.reason, /持续确认/); assert.equal(recovered.allowEntry, false);
  assert.ok(updates.some(value => value.acquisition.loading && value.acquisition.stage === 'starting'));
  assert.ok(updates.some(value => value.acquisition.loading && value.acquisition.completed === 500));
  assert.equal(updates.at(-1).acquisition.loading, false);
});

test('正在获取不能延长旧市场许可；获取结束使用新证据重新确认', async () => {
  const h = harness(); await h.service.poll(); h.advance(120000);
  const ready = await h.service.poll(); assert.equal(ready.allowEntry, true);
  let release;
  h.service.loadBreadth = () => new Promise(resolve => { release = resolve; });
  const pending = h.service.poll({ force: true }); await Promise.resolve();
  h.staleAdvance(90000);
  const stale = h.service.getSnapshot();
  assert.equal(stale.acquisition.loading, true); assert.equal(stale.allowEntry, false);
  assert.equal(stale.expiresAt, ready.expiresAt); assert.equal(stale.checkedAt, ready.checkedAt);
  release(fixture(h.now()).breadth);
  const result = await pending; assert.equal(result.allowEntry, false);
});

test('进度观察者异常不能中止市场核验或制造第二个获取任务', async () => {
  const h = harness();
  let joined, changes = 0;
  h.service.onChange = () => { changes++; joined = h.service.poll({ force: true }); throw Error('test UI observer'); };
  const pending = h.service.poll({ force: true });
  await pending;
  assert.equal(joined, pending); assert.equal(h.calls(), 1); assert.ok(changes >= 2);
  assert.equal(h.service.getSnapshot().acquisition.loading, false);
});

test('广度成功缓存最多30秒、强制刷新绕过缓存且不改原始获取与报价时间', async () => {
  let now = START, calls = 0;
  const source = { load: async () => { calls++; return { fetchedAt: now, rows: [{ timestamp: now - 1000 }] }; } };
  const load = cachedBreadthLoader(source, () => now);
  const first = await load(); now += 29999;
  assert.equal(await load(), first); assert.equal(calls, 1);
  assert.equal(first.fetchedAt, START); assert.equal(first.rows[0].timestamp, START - 1000);
  const forced = await load({ force: true }); assert.notEqual(forced, first); assert.equal(calls, 2);
  now += 30000; const next = await load(); assert.equal(calls, 3); assert.notEqual(next, forced);
});

test('广度进行中请求共用、失败不缓存，已取消调用不返回旧成功缓存', async () => {
  let calls = 0, release, fail = true;
  const source = { load: () => { calls++; return new Promise((resolve, reject) => {
    release = () => fail ? reject(Error('offline')) : resolve({ fetchedAt: START, rows: [] });
  }); } };
  const load = cachedBreadthLoader(source, () => START);
  const first = load({ force: true }), second = load({ force: true });
  assert.equal(calls, 1); release();
  await Promise.all([assert.rejects(first, /offline/), assert.rejects(second, /offline/)]);
  fail = false; const retry = load(); assert.equal(calls, 2); release(); await retry;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(load({ signal: controller.signal })); assert.equal(calls, 2);
});

test('广度路由使用专用多源入口，force穿透缓存且来源切换不能绕过120秒确认', async () => {
  let now = START; const requests = [];
  const source = { load() { throw Error('不能从广度入口调用完整选股接口'); },
    async loadBreadth(options) {
      requests.push(options.force === true);
      options.onProgress?.({ provider: 'sina', providerLabel: '新浪财经', fallbackReason: '腾讯请求失败', stage: 'screen-quotes', completed: 1200, total: 1200 });
      return { ...fixture(now).breadth, source: '新浪财经（备用）' };
    } };
  const service = new MarketRegimeService({ clock: () => now, loadBreadth: cachedBreadthLoader(source, () => now),
    indexHistory: async symbol => fixture(now).histories[symbol], getQuotes: () => fixture(now).quotes });
  const first = await service.poll({ force: true });
  assert.equal(first.allowEntry, false); assert.equal(first.metrics.breadth.source, '新浪财经（备用）');
  assert.equal(first.acquisition.providerLabel, '新浪财经'); assert.equal(first.acquisition.lastError, '');
  assert.equal(first.acquisition.source, '新浪财经（备用）'); assert.equal(first.evidence.quoteTime, START);
  now += 1000; const second = await service.poll({ force: true });
  assert.deepEqual(requests, [true, true]); assert.equal(second.allowEntry, false);
  now += 119000; const confirmed = await service.poll({ force: true });
  assert.equal(confirmed.allowEntry, true); assert.equal(confirmed.acquisition.source, '新浪财经（备用）');
});

test('盘前501自动重试历史资料，开盘自动取得实时证据且持续确认从开盘开始', async () => {
  let now = Date.parse('2026-10-16T09:28:59+08:00'), fail = true, historyCalls = 0, breadthCalls = 0;
  const service = new MarketRegimeService({ clock: () => now,
    indexHistory: async (symbol, _signal, force) => {
      historyCalls++; assert.equal(force, false);
      if (fail) throw Error('HTTP 501（proxy.finance.qq.com）');
      return fixture(now).histories[symbol];
    }, getQuotes: () => fixture(now).quotes,
    loadBreadth: async () => { breadthCalls++; return fixture(now).breadth; } });
  const failed = await service.poll();
  assert.equal(failed.acquisition.stage, 'failed'); assert.match(failed.reason, /HTTP 501/);
  assert.equal(failed.allowEntry, false); assert.equal(breadthCalls, 0);
  fail = false; now += 59999; await service.poll(); assert.equal(historyCalls, 3);
  now++; const prepared = await service.poll();
  assert.equal(historyCalls, 6); assert.equal(prepared.acquisition.stage, 'prepared');
  assert.equal(prepared.acquisition.lastError, ''); assert.equal(prepared.allowEntry, false);
  assert.ok(prepared.acquisition.prepared.every(item => item.asOf === '2026-10-15'));
  assert.equal(breadthCalls, 0); assert.equal(service.confirmation, null);

  now += 1000; const opening = await service.poll();
  assert.equal(historyCalls, 9); assert.equal(breadthCalls, 1);
  assert.equal(opening.allowEntry, false); assert.match(opening.reason, /持续确认/);
  now += 60000; assert.equal((await service.poll()).allowEntry, false);
  now += 60000; assert.equal((await service.poll()).allowEntry, true);
});

test('盘前历史日线不完整或过期不能显示准备完成，未知日历不请求实时广度', async () => {
  const now = Date.parse('2026-10-16T09:00:00+08:00');
  for (const mutation of [history => { history.bars.pop(); }, history => { history.adjustment = '前复权'; },
    history => { history.fetchedAt -= 21600001; }]) {
    const data = fixture(now); mutation(data.histories.sh000001);
    const service = new MarketRegimeService({ clock: () => now,
      indexHistory: async symbol => data.histories[symbol], getQuotes: () => { throw Error('不应读取盘前报价'); },
      loadBreadth: async () => { throw Error('不应读取盘前广度'); } });
    const result = await service.poll();
    assert.equal(result.acquisition.stage, 'failed'); assert.equal(result.allowEntry, false);
  }
  let calls = 0;
  const service = new MarketRegimeService({ clock: () => Date.parse('2027-01-04T09:00:00+08:00'),
    indexHistory: async () => { calls++; }, getQuotes: () => { calls++; }, loadBreadth: async () => { calls++; } });
  assert.match((await service.poll()).reason, /交易日历未经核验/); assert.equal(calls, 0);
});

test('盘中取数跨越午休不能授予权限，午后自动重新累计实时确认', async () => {
  let now = Date.parse('2026-10-16T11:29:00+08:00'), release;
  const service = new MarketRegimeService({ clock: () => now,
    indexHistory: async symbol => fixture(now).histories[symbol], getQuotes: () => fixture(now).quotes,
    loadBreadth: async () => new Promise(resolve => { release = resolve; }) });
  const pending = service.poll(); await Promise.resolve();
  now = Date.parse('2026-10-16T11:31:00+08:00'); release(fixture(now).breadth);
  const closed = await pending;
  assert.equal(closed.allowEntry, false); assert.equal(closed.acquisition.stage, 'waiting-open'); assert.equal(service.confirmation, null);
  service.loadBreadth = async () => fixture(now).breadth;
  await service.poll(); assert.equal(service.getSnapshot().acquisition.stage, 'prepared');
  now = Date.parse('2026-10-16T13:00:00+08:00');
  assert.equal((await service.poll()).allowEntry, false);
  now += 120000; assert.equal((await service.poll()).allowEntry, true);
});

const preparedUniverse = now => ({ symbols: Array.from({ length: 1200 }, (_, i) => `sh${600000 + i}`),
  source: '测试完整证券名单', sourceCount: 1200, excludedCount: 0, validatedAt: now, date: '2026-10-16' });

test('盘前并行准备指数和完整名单，状态按当前时间重新校验且五分钟维护不累计实时确认', async () => {
  let now = Date.parse('2026-10-16T08:45:00+08:00'), universeCalls = 0, quoteCalls = 0, breadthCalls = 0;
  const service = new MarketRegimeService({ clock: () => now,
    indexHistory: async symbol => fixture(now).histories[symbol],
    prepareUniverse: async options => { universeCalls++; assert.equal(options.force, false); return preparedUniverse(now); },
    getQuotes: () => { quoteCalls++; return fixture(now).quotes; }, loadBreadth: async () => { breadthCalls++; return fixture(now).breadth; } });
  const ready = await service.poll();
  assert.equal(ready.preparation.ready, true); assert.equal(ready.preparation.status, 'ready');
  assert.equal(ready.preparation.indices.ready, 3); assert.equal(ready.preparation.universe.count, 1200);
  assert.deepEqual(ready.preparation.missing, []); assert.equal(ready.allowEntry, false); assert.equal(service.confirmation, null);
  assert.equal(quoteCalls, 0); assert.equal(breadthCalls, 0);
  now += 299999; await service.poll(); assert.equal(universeCalls, 1);
  now++; await service.poll(); assert.equal(universeCalls, 2);
  now += 1800000;
  const expired = service.getSnapshot(); assert.equal(expired.preparation.ready, false); assert.equal(expired.preparation.universe.ready, false);
  assert.deepEqual(expired.preparation.missing, ['完整证券名单']);
  await service.poll(); assert.equal(service.getSnapshot().preparation.ready, true); assert.equal(universeCalls, 3);
  now = Date.parse('2026-10-19T08:45:00+08:00');
  assert.equal(service.getSnapshot().preparation.ready, false); assert.equal(service.getSnapshot().preparation.indices.ready, 0);
});

test('盘前证券名单失败仍保留各指数准备诊断，手动重试穿透完整名单获取', async () => {
  const now = Date.parse('2026-10-16T09:00:00+08:00'); let fail = true, forced;
  const service = new MarketRegimeService({ clock: () => now,
    indexHistory: async symbol => fixture(now).histories[symbol], getQuotes: () => fixture(now).quotes, loadBreadth: async () => fixture(now).breadth,
    prepareUniverse: async options => { forced = options.force; if (fail) throw Error('名单 HTTP 501'); return preparedUniverse(now); } });
  const failed = await service.poll(); assert.equal(failed.preparation.status, 'partial'); assert.equal(failed.preparation.indices.ready, 3);
  assert.equal(failed.preparation.universe.ready, false); assert.match(failed.preparation.universe.error, /501/);
  assert.equal(failed.allowEntry, false); fail = false;
  const recovered = await service.poll({ force: true }); assert.equal(forced, true); assert.equal(recovered.preparation.ready, true);
  assert.equal(recovered.preparation.universe.error, '');
});

test('开盘不等盘前慢请求，取消旧订阅且迟到结果和进度不覆盖新时段任务', async () => {
  let now = Date.parse('2026-10-16T09:29:59+08:00'), release, oldSignal, oldProgress, breadthCalls = 0;
  const service = new MarketRegimeService({ clock: () => now,
    indexHistory: async symbol => fixture(now).histories[symbol], getQuotes: () => fixture(now).quotes,
    prepareUniverse: options => { oldSignal = options.signal; oldProgress = options.onProgress; return new Promise(resolve => { release = resolve; }); },
    loadBreadth: async () => { breadthCalls++; return fixture(now).breadth; } });
  const preopen = service.poll(); await Promise.resolve(); now += 1000;
  const opening = service.poll(); assert.notEqual(opening, preopen);
  const live = await opening; assert.equal(oldSignal.aborted, true); assert.equal(breadthCalls, 1);
  assert.equal(live.acquisition.stage, 'complete'); assert.equal(live.allowEntry, false); assert.match(live.reason, /持续确认/);
  const preparedAt = live.preparation.preparedAt;
  release(preparedUniverse(now - 1000)); oldProgress({ stage: 'universe', completed: 999, total: 1200 }); await preopen;
  assert.equal(service.getSnapshot().acquisition.stage, 'complete'); assert.equal(service.getSnapshot().preparation.preparedAt, preparedAt);
  assert.equal(service.pending, null);
});

test('开盘接口返回竞价旧tick不能启动120秒持续确认，即使同日且未超过时效', async () => {
  let now = Date.parse('2026-10-16T09:30:00+08:00'), old = true;
  const data = () => fixture(old ? now - 60000 : now);
  const service = new MarketRegimeService({ clock: () => now, indexHistory: async symbol => fixture(now).histories[symbol],
    getQuotes: () => data().quotes, loadBreadth: async () => data().breadth });
  const first = await service.poll(); assert.equal(first.allowEntry, false); assert.match(first.reason, /竞价报价/); assert.equal(service.confirmation, null);
  old = false; now += 30000; await service.poll(); assert.equal(service.confirmation.firstQuoteTime, now);
  now += 119999; assert.equal((await service.poll({ force: true })).allowEntry, false);
  now++; assert.equal((await service.poll({ force: true })).allowEntry, true);
});
