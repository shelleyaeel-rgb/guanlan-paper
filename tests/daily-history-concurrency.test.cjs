'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DailyHistoryCache } = require('../core/daily-history-cache.cjs');
const { prepareHistory, expectedDailyDate } = require('../core/daily-history.cjs');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');

const NOW = Date.parse('2026-10-27T09:00:00+08:00');
const PREVIOUS_CLOSE = Date.parse('2026-10-26T16:00:00+08:00');
const symbols = Array.from({ length: 20 }, (_, i) => `sh${600001 + i}`);
const next = () => new Promise(resolve => setImmediate(resolve));

function history(symbol, now = NOW, offset = 0) {
  const bars = [], end = Date.parse(`${expectedDailyDate(now)}T00:00:00Z`);
  for (let day = end; bars.length < 90; day -= 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (calendarSession(new Date(`${date}T10:00:00+08:00`)).open)
      bars.unshift({ date, open: 10 + offset, close: 10 + offset, high: 11 + offset, low: 9 + offset, volume: 100000 });
  }
  return { symbol, bars, source: '隔离日线来源', provider: 'fixture', adjustment: '未复权', fetchedAt: now };
}

function downloads(clock = () => NOW) {
  const requests = [];
  let active = 0, peak = 0;
  const load = symbol => signal => {
    active++; peak = Math.max(peak, active);
    let abort;
    return new Promise((resolve, reject) => {
      const request = { symbol, signal, completed: false, finish(offset = 0) {
        if (this.completed) return;
        this.completed = true; resolve(history(symbol, clock(), offset));
      } };
      abort = () => { request.completed = true; reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      requests.push(request);
    }).finally(() => { signal.removeEventListener('abort', abort); active--; });
  };
  const drain = async cache => {
    const pending = [...cache.pending.values()];
    for (let i = 0; i < 30 && cache.pending.size; i++) {
      requests.forEach(request => request.finish());
      await next();
    }
    assert.equal(cache.pending.size, 0, '所有实际下载和排队请求应完成');
    await Promise.all(pending);
  };
  return { requests, load, drain, get peak() { return peak; }, get active() { return active; } };
}

function warmCache(warmSymbols) {
  const entries = new Map(warmSymbols.map(symbol => [`stock:${symbol}`,
    prepareHistory(symbol, 'stock', history(symbol, PREVIOUS_CLOSE), NOW)]));
  return new DailyHistoryCache({ clock: () => NOW, store: { read: key => entries.get(key), write() {} } });
}

test('20只昨收缓存的监控扫描立即完成，实际后台日线下载始终最多3个', async () => {
  const cache = warmCache(symbols), source = downloads();
  const monitor = new StrategyMonitor({ strategyHistory: symbol => cache.load(symbol, 'stock', source.load(symbol)) }, () => new Date(NOW));
  await monitor.scan(symbols);
  assert.equal(Object.keys(monitor.snapshots).length, 20);
  assert.equal(source.requests.length, 3);
  assert.equal(source.active, 3);
  for (const symbol of symbols) {
    assert.equal(monitor.snapshots[symbol].fetchedAt, PREVIOUS_CLOSE);
    assert.equal(monitor.snapshots[symbol].dailyEvidence.asOf, '2026-10-26');
    assert.equal(monitor.snapshots[symbol].error, undefined);
  }
  await source.drain(cache);
  assert.equal(source.requests.length, 20);
  assert.equal(source.peak, 3);
});

test('缺失缓存的指数请求与个股共享下载上限，并优先于排队中的后台刷新', async () => {
  const cache = warmCache(symbols.slice(0, 5)), source = downloads();
  await Promise.all(symbols.slice(0, 5).map(symbol => cache.load(symbol, 'stock', source.load(symbol))));
  const index = cache.load('sh000001', 'index', source.load('sh000001'));
  await next();
  assert.deepEqual(source.requests.map(request => request.symbol), symbols.slice(0, 3));
  source.requests[0].finish(); await next();
  assert.equal(source.requests[3].symbol, 'sh000001');
  await source.drain(cache);
  assert.equal((await index).dailyEvidence.kind, 'index');
  assert.deepEqual(source.requests.slice(4).map(request => request.symbol), symbols.slice(3, 5));
  assert.equal(source.peak, 3);
});

test('排队请求共享下载，单个等待者取消不影响其他人，全部取消的股票不访问来源', async () => {
  const cache = new DailyHistoryCache({ clock: () => NOW }), source = downloads();
  const blockers = symbols.slice(0, 3).map(symbol => cache.load(symbol, 'stock', source.load(symbol)));
  const one = new AbortController(), all = new AbortController();
  const waiting = cache.load(symbols[3], 'stock', source.load(symbols[3]), { signal: one.signal });
  const shared = cache.load(symbols[3], 'stock', () => assert.fail('共享排队请求不能重复调用来源'));
  const cancelled = cache.load(symbols[4], 'stock', () => assert.fail('取消的排队任务不能调用来源'), { signal: all.signal });
  await next();
  const waitingRejected = assert.rejects(waiting, { name: 'AbortError' });
  const cancelledRejected = assert.rejects(cancelled, { name: 'AbortError' });
  one.abort(); all.abort();
  await Promise.all([waitingRejected, cancelledRejected]);
  source.requests[0].finish(); await next();
  assert.equal(source.requests[3].symbol, symbols[3]);
  assert.equal(source.requests[3].signal.aborted, false);
  await source.drain(cache);
  await Promise.all(blockers);
  assert.equal((await shared).dailyEvidence.asOf, '2026-10-26');
  assert.equal(source.requests.length, 4);
  assert.equal(cache.errors.size, 0);
  assert.equal(cache.users.size, 0);
});

test('正在执行的最后一个等待者取消后释放下载槽，后续股票继续获取', async () => {
  const cache = new DailyHistoryCache({ clock: () => NOW }), source = downloads();
  const controller = new AbortController();
  const cancelled = cache.load(symbols[0], 'stock', source.load(symbols[0]), { signal: controller.signal });
  const other = symbols.slice(1, 4).map(symbol => cache.load(symbol, 'stock', source.load(symbol)));
  await next();
  assert.equal(source.requests.length, 3);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort(); await rejected; await next();
  assert.equal(source.requests.length, 4);
  assert.equal(source.requests[3].symbol, symbols[3]);
  await source.drain(cache); await Promise.all(other);
  assert.equal(source.peak, 3);
  assert.equal(cache.errors.size, 0);
});

test('排队旧下载完成后才执行合并的强制刷新，普通等待者保留旧请求结果', async () => {
  const cache = new DailyHistoryCache({ clock: () => NOW }), source = downloads();
  const blockers = symbols.slice(0, 3).map(symbol => cache.load(symbol, 'stock', source.load(symbol)));
  const first = cache.load(symbols[3], 'stock', source.load(symbols[3]));
  const shared = cache.load(symbols[3], 'stock', () => assert.fail('普通排队调用应共享'));
  const forced = cache.load(symbols[3], 'stock', source.load(symbols[3]), { force: true });
  const forcedShared = cache.load(symbols[3], 'stock', () => assert.fail('同一旧请求的强刷后继应共享'), { force: true });
  await next();
  assert.equal(source.requests.length, 3);
  source.requests[0].finish(); await next();
  assert.equal(source.requests[3].symbol, symbols[3]);
  assert.equal(source.requests.length, 4);
  source.requests[3].finish(); await next();
  assert.equal((await first).dailyEvidence.close, 10);
  assert.equal((await shared).dailyEvidence.close, 10);
  assert.equal(source.requests.length, 5);
  assert.equal(source.requests[4].symbol, symbols[3]);
  source.requests[4].finish(1);
  assert.equal((await forced).dailyEvidence.close, 11);
  assert.equal((await forcedShared).dailyEvidence.close, 11);
  await source.drain(cache); await Promise.all(blockers);
  assert.equal(source.peak, 3);
});

test('排队不消耗12秒下载期限，拿到执行槽后才记录尝试时间并创建期限', async t => {
  let now = NOW;
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    deadlines.push({ milliseconds, createdAt: now });
    return new AbortController().signal;
  });
  const cache = new DailyHistoryCache({ clock: () => now }), source = downloads(() => now);
  const jobs = symbols.slice(0, 4).map(symbol => cache.load(symbol, 'stock', source.load(symbol)));
  await next();
  assert.equal(deadlines.length, 3);
  assert.equal(cache.attempts.has(`stock:${symbols[3]}`), false);
  now += 20000;
  source.requests[0].finish(); await next();
  assert.equal(source.requests.length, 4);
  assert.equal(source.requests[3].signal.aborted, false);
  assert.equal(deadlines.length, 4);
  assert.deepEqual(deadlines[3], { milliseconds: 12000, createdAt: now });
  assert.equal(cache.attempts.get(`stock:${symbols[3]}`), now);
  await source.drain(cache); await Promise.all(jobs);
});
