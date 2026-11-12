'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DailyHistoryCache } = require('../core/daily-history-cache.cjs');
const { prepareHistory, preparedHistoryValid, registerDailyRevision } = require('../core/daily-history.cjs');
const { MarketRegimeService } = require('../core/market-regime-service.cjs');
const { INDEX_SYMBOLS, evaluateMarketRegime, unknownMarketRegime } = require('../core/market-regime.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');
const START = Date.parse('2026-11-05T10:00:00+08:00');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function history(symbol, fetchedAt, { correction = 0, highVolatility = false } = {}) {
  const bars = [];
  for (let day = Date.parse('2026-11-04T00:00:00Z'); bars.length < 90; day -= 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (calendarSession(new Date(`${date}T10:00:00+08:00`)).open) {
      const width = highVolatility ? 4 : 1;
      bars.unshift({ date, open: 100, close: 100 + correction, high: 100 + width, low: 100 - width, volume: 100000 });
    }
  }
  return { symbol, bars, source: correction ? '新浪财经' : '腾讯财经', provider: correction ? 'sina' : 'tencent',
    adjustment: '未复权', fetchedAt };
}
async function harness({ highVolatility = false, start = START, ServiceClass = MarketRegimeService } = {}) {
  let now = start - 31 * 60000;
  const cache = new DailyHistoryCache({ clock: () => now });
  const original = Object.fromEntries(await Promise.all(INDEX_SYMBOLS.map(async symbol => [symbol,
    await cache.load(symbol, 'index', async () => history(symbol, now, { highVolatility }))])));
  let loader = async symbol => history(symbol, now, { highVolatility });
  now = start;
  const calls = [];
  const quotes = () => Object.fromEntries(INDEX_SYMBOLS.map(symbol => [symbol, { symbol, price: 100, prevClose: 100,
    source: '隔离报价', date: '2026-11-05', timestamp: now }]));
  const breadth = () => ({ source: '隔离广度', sourceCount: 1200, excludedCount: 0, fetchedAt: now,
    rows: Array.from({ length: 1200 }, (_, i) => ({ symbol: `sh${600000 + i}`, price: 10, changePct: i < 960 ? 1 : -1,
      date: '2026-11-05', timestamp: now })) });
  const service = new ServiceClass({ clock: () => now,
    indexHistory: (symbol, signal, force) => {
      calls.push({ symbol, signal, force });
      return cache.load(symbol, 'index', () => loader(symbol), { signal, force });
    }, getQuotes: quotes, loadBreadth: async () => breadth() });
  service.snapshot = evaluateMarketRegime({ histories: original, quotes: quotes(), breadth: breadth() }, now);
  assert.equal(service.snapshot.allowEntry, true);
  return { cache, service, original, calls, quotes, breadth, now: () => now,
    advance: ms => { now += ms; }, setTime: value => { now = value; }, setLoader: value => { loader = value; } };
}
async function refreshDuring(h, stage, revision = {}) {
  const refresh = deferred(), slow = deferred();
  h.setLoader(symbol => refresh.promise.then(() => history(symbol, h.now(), { correction: 0.003, ...revision })));
  if (stage === 'breadth') h.service.loadBreadth = () => slow.promise;
  else h.service.getQuotes = () => slow.promise;
  const pending = h.service.poll();
  await tick();
  const downloads = [...h.cache.pending.values()];
  assert.equal(downloads.length, 3);
  h.advance(1000); refresh.resolve(); await Promise.all(downloads);
  assert.ok(INDEX_SYMBOLS.every(symbol => !preparedHistoryValid(h.original[symbol], symbol, 'index', h.now())));
  h.advance(10000); slow.resolve(stage === 'breadth' ? h.breadth() : h.quotes());
  return pending;
}

for (const stage of ['breadth', 'quotes']) test(`refresh during slow ${stage} replaces revoked histories without resetting a confirmed market`, async () => {
  const h = await harness();
  const result = await refreshDuring(h, stage);
  assert.equal(result.status, 'strong');
  assert.equal(result.riskMultiplier, 1);
  assert.equal(result.allowBreakout, true);
  assert.equal(h.service.confirmation, null);
  assert.ok(result.metrics.indices.every(index => index.dailySource === '新浪财经' && index.close === 100.003));
  assert.ok(result.preparation.indices.items.every(item => item.ready));
  assert.equal(h.calls.length, 6);
  assert.ok(h.calls.every(call => call.force === false));
});

test('a revision before the first indexHistory await resumes can be recovered through the same cache', async () => {
  const h = await harness();
  h.cache.refreshMs = Infinity;
  const first = new Set();
  h.service.indexHistory = async (symbol, signal) => {
    const value = await h.cache.load(symbol, 'index', () => assert.fail('valid cache should be reused'), { signal });
    if (!first.has(symbol)) {
      first.add(symbol);
      await h.cache.load(symbol, 'index', async () => history(symbol, h.now(), { correction: 0.003 }), { force: true });
    }
    return value;
  };
  const result = await h.service.poll();
  assert.equal(result.allowEntry, true);
  assert.ok(result.metrics.indices.every(index => index.dailySource === '新浪财经'));
  assert.ok(INDEX_SYMBOLS.every(symbol => !preparedHistoryValid(h.original[symbol], symbol, 'index', h.now())));
});

test('unchanged history requires one read per index even during explicit refresh', async () => {
  const h = await harness();
  const result = await h.service.poll({ force: true });
  assert.equal(result.allowEntry, true);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every(call => call.force === true));
});

test('the final history validation and permission evaluation share one synchronous turn', async () => {
  const regime = require('../core/market-regime.cjs');
  const servicePath = require.resolve('../core/market-regime-service.cjs');
  const originalModule = require.cache[servicePath], originalPrepare = regime.preparedIndexHistory;
  let armed = false, revisionQueued = false, h;
  regime.preparedIndexHistory = (...args) => {
    const result = originalPrepare(...args);
    if (armed && !revisionQueued && args[0] === INDEX_SYMBOLS.at(-1)) {
      revisionQueued = true;
      // Simulate a queued cache completion immediately after the final index
      // check. An extra await here would revoke the views before evaluation.
      queueMicrotask(() => {
        for (const symbol of INDEX_SYMBOLS) {
          const corrected = prepareHistory(symbol, 'index', history(symbol, h.now(), { correction: 0.003 }), h.now());
          h.cache.entries.set(`index:${symbol}`, corrected);
          registerDailyRevision(h.cache.runtimeId, 'index', symbol, corrected.dailyEvidence.barsHash);
        }
      });
    }
    return result;
  };
  delete require.cache[servicePath];
  let ServiceClass;
  try { ServiceClass = require(servicePath).MarketRegimeService; }
  finally { regime.preparedIndexHistory = originalPrepare; require.cache[servicePath] = originalModule; }
  h = await harness({ ServiceClass });
  h.cache.refreshMs = Infinity;
  armed = true;
  const result = await h.service.poll();
  assert.equal(revisionQueued, true);
  assert.equal(result.allowEntry, true);
  assert.equal(result.status, 'strong');
  assert.equal(h.calls.length, 3);
  assert.ok(INDEX_SYMBOLS.every(symbol => !preparedHistoryValid(h.original[symbol], symbol, 'index', h.now())));
});

test('higher volatility in revised history reduces risk and closes breakout permission immediately', async () => {
  const h = await harness();
  const result = await refreshDuring(h, 'breadth', { highVolatility: true });
  assert.equal(result.status, 'strong');
  assert.equal(result.riskMultiplier, 0.5);
  assert.equal(result.allowBreakout, false);
  assert.equal(result.metrics.highVolatility, true);
  assert.equal(h.service.confirmation, null);
});

test('a less volatile revision still needs 120 seconds of distinct market quotes before increasing permission', async () => {
  const h = await harness({ highVolatility: true });
  const first = await refreshDuring(h, 'quotes', { highVolatility: false });
  assert.equal(first.riskMultiplier, 0.5);
  assert.equal(first.allowBreakout, false);
  assert.match(first.reason, /120 秒/);
  h.service.getQuotes = h.quotes;
  h.advance(60000);
  assert.equal((await h.service.poll()).riskMultiplier, 0.5);
  h.advance(60000);
  assert.equal((await h.service.poll()).riskMultiplier, 1);
});

test('revision replacement preserves an already accumulating confirmation interval', async () => {
  const h = await harness();
  h.service.snapshot = unknownMarketRegime('等待首次确认', h.now());
  h.service.apply(evaluateMarketRegime({ histories: h.original, quotes: h.quotes(), breadth: h.breadth() }, h.now()));
  const started = h.service.confirmation.firstQuoteTime;
  h.advance(30000);
  const result = await refreshDuring(h, 'breadth');
  assert.equal(result.allowEntry, false);
  assert.equal(h.service.confirmation.firstQuoteTime, started);
  assert.equal(h.service.confirmation.count, 2);
  assert.match(result.reason, /120 秒/);
});

test('a genuine source rejection remains closed during initial or replacement reads', async () => {
  for (const duringReplacement of [false, true]) {
    const h = await harness();
    h.cache.refreshMs = Infinity;
    const counts = new Map();
    h.service.indexHistory = async (symbol, signal) => {
      const count = (counts.get(symbol) || 0) + 1; counts.set(symbol, count);
      if (!duringReplacement || count > 1) throw Error('真实来源 HTTP 503');
      const old = await h.cache.load(symbol, 'index', () => assert.fail('valid cache expected'), { signal });
      await h.cache.load(symbol, 'index', async () => history(symbol, h.now(), { correction: 0.003 }), { force: true });
      return old;
    };
    const result = await h.service.poll();
    assert.equal(result.allowEntry, false);
    assert.equal(result.acquisition.stage, 'failed');
    assert.match(result.reason, /HTTP 503/);
    assert.equal(h.service.confirmation, null);
    assert.ok([...counts.values()].every(count => count === (duringReplacement ? 2 : 1)));
  }
});

test('repeated revisions stop after two replacement reads and keep permission closed', async () => {
  const h = await harness();
  h.cache.refreshMs = Infinity;
  const counts = new Map();
  h.service.indexHistory = async (symbol, signal) => {
    const count = (counts.get(symbol) || 0) + 1; counts.set(symbol, count);
    const old = await h.cache.load(symbol, 'index', () => assert.fail('valid cache expected'), { signal });
    await h.cache.load(symbol, 'index', async () => history(symbol, h.now(), { correction: count * 0.001 }), { force: true });
    return old;
  };
  const result = await h.service.poll();
  assert.equal(result.allowEntry, false);
  assert.equal(result.acquisition.stage, 'failed');
  assert.match(result.reason, /指数日线/);
  assert.ok([...counts.values()].every(count => count === 3));
});

test('replacement reads cannot make already old index quotes fresh', async () => {
  const h = await harness();
  h.cache.refreshMs = Infinity;
  const first = new Set();
  h.service.indexHistory = async (symbol, signal) => {
    const value = await h.cache.load(symbol, 'index', () => assert.fail('valid cache expected'), { signal });
    if (!first.has(symbol)) {
      first.add(symbol);
      await h.cache.load(symbol, 'index', async () => history(symbol, h.now(), { correction: 0.003 }), { force: true });
    } else if (symbol === 'sh000001') h.advance(90001);
    return value;
  };
  const result = await h.service.poll();
  assert.equal(result.allowEntry, false);
  assert.match(result.reason, /超过 90 秒/);
});

test('session cancellation during replacement reads prevents late results overwriting the next session', async () => {
  const h = await harness({ start: Date.parse('2026-11-05T11:29:00+08:00') });
  h.cache.refreshMs = Infinity;
  const first = new Set(), replacement = deferred();
  let oldSignal;
  h.service.indexHistory = async (symbol, signal) => {
    const current = await h.cache.load(symbol, 'index', () => assert.fail('valid cache expected'), { signal });
    if (!first.has(symbol)) {
      first.add(symbol);
      await h.cache.load(symbol, 'index', async () => history(symbol, h.now(), { correction: 0.003 }), { force: true });
      return current;
    }
    oldSignal = signal;
    return replacement.promise.then(() => current);
  };
  const old = h.service.poll(); await tick();
  assert.ok(oldSignal);
  h.setTime(Date.parse('2026-11-05T11:31:00+08:00'));
  h.service.indexHistory = (symbol, signal) => h.cache.load(symbol, 'index', () => assert.fail('valid cache expected'), { signal });
  const closed = await h.service.poll();
  assert.equal(oldSignal.aborted, true);
  assert.equal(closed.allowEntry, false);
  assert.equal(closed.acquisition.stage, 'prepared');
  replacement.resolve(); await old;
  assert.equal(h.service.getSnapshot().acquisition.stage, 'prepared');
  assert.equal(h.service.getSnapshot().allowEntry, false);
  assert.equal(h.service.confirmation, null);
});
