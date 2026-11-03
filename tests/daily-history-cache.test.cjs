'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DailyHistoryCache } = require('../core/daily-history-cache.cjs');
const { DailyHistoryStore } = require('../core/daily-history-store.cjs');
const { prepareHistory, preparedHistoryValid, preparedTechnicalValid, expectedDailyDate } = require('../core/daily-history.cjs');
const { Market } = require('../core/market.cjs');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const { technicals, usableTechnical } = require('../core/strategy.cjs');
const { preparedIndexHistory } = require('../core/market-regime.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');
const START = Date.parse('2026-10-22T09:00:00+08:00'), SYMBOL = 'sh600004';
function history(now = START, symbol = SYMBOL, offset = 0) {
  const end = Date.parse(`${expectedDailyDate(now)}T00:00:00Z`), bars = [];
  for (let day = end; bars.length < 90; day -= 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (calendarSession(new Date(`${date}T10:00:00+08:00`)).open) bars.unshift({ date, open: 10 + offset, close: 10 + offset, high: 10.5 + offset, low: 9.5 + offset, volume: 100000 });
  }
  return { symbol, source: '腾讯财经', provider: 'tencent', adjustment: '未复权', fetchedAt: now, bars };
}
const next = () => new Promise(resolve => setImmediate(resolve));

test('盘前日线在盘中复用且保留真实获取时间，当前未完成K线不进入缓存', async () => {
  let now = START, calls = 0;
  const cache = new DailyHistoryCache({ clock: () => now });
  const value = history(); value.bars.push({ date: '2026-10-22', open: 20, close: 20, high: 21, low: 19, volume: 100 });
  const load = () => { calls++; return Promise.resolve(value); };
  const first = await cache.load(SYMBOL, 'stock', load);
  now += 5 * 60000;
  const second = await cache.load(SYMBOL, 'stock', load);
  assert.equal(calls, 1); assert.equal(second.historyStatus, 'cached'); assert.equal(second.fetchedAt, START);
  assert.equal(second.bars.at(-1).date, '2026-10-21'); assert.equal(second.dailyEvidence.count, 90);
  second.bars[0].close = 999;
  assert.equal((await cache.load(SYMBOL, 'stock', load)).bars[0].close, first.bars[0].close);
});

test('后台刷新不阻塞有效日线，501后保留成功版本并显示错误', async () => {
  let now = START, fail;
  const cache = new DailyHistoryCache({ clock: () => now });
  await cache.load(SYMBOL, 'stock', async () => history());
  now += 31 * 60000;
  const hit = await cache.load(SYMBOL, 'stock', () => new Promise((resolve, reject) => { fail = reject; }));
  assert.equal(hit.historyStatus, 'refreshing'); assert.equal(hit.fetchedAt, START);
  fail(Error('HTTP 501')); await next();
  const degraded = await cache.load(SYMBOL, 'stock', () => assert.fail('失败后一分钟内不能重复联网'));
  assert.equal(degraded.historyStatus, 'degraded'); assert.equal(degraded.refreshError, 'HTTP 501');
  assert.equal(degraded.fetchedAt, START); assert.ok(preparedHistoryValid(degraded, SYMBOL, 'stock', now));
});

test('显式重核验会联网，失败仍可复用有效历史，恢复修正时替换完整版本', async () => {
  let now = START, changes = 0;
  const cache = new DailyHistoryCache({ clock: () => now, onChange: () => changes++ });
  const first = await cache.load(SYMBOL, 'stock', async () => history()); now += 1000;
  const failed = await cache.load(SYMBOL, 'stock', async () => { throw Error('HTTP 501'); }, { force: true });
  assert.equal(failed.dailyEvidence.barsHash, first.dailyEvidence.barsHash); assert.equal(failed.historyStatus, 'degraded');
  const recovered = await cache.load(SYMBOL, 'stock', async () => history(now, SYMBOL, 1), { force: true });
  assert.equal(recovered.refreshError, ''); assert.equal(recovered.historyStatus, 'fresh');
  assert.equal(recovered.bars.at(-1).close, 11); assert.equal(recovered.fetchedAt, now); assert.equal(changes, 2);
});

test('隔离重启可恢复日线；跨日缺最新完整日线时必须阻断，不能靠相同收盘价放行', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-history-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = START;
  const make = () => new DailyHistoryCache({ store: new DailyHistoryStore(dir), clock: () => now });
  await make().load(SYMBOL, 'stock', async () => history()); now += 10 * 60000;
  const restarted = make();
  assert.equal((await restarted.load(SYMBOL, 'stock', () => assert.fail('无需联网'))).fetchedAt, START);
  now = Date.parse('2026-10-23T10:00:00+08:00');
  await assert.rejects(restarted.load(SYMBOL, 'stock', async () => { throw Error('HTTP 501'); }), /501/);
  const stale = await restarted.load(SYMBOL, 'stock', async () => ({ ...history(), fetchedAt: now }), { force: true });
  assert.equal(stale.dailyEvidence, null);
  const snap = { ...stale, technical: technicals(stale.bars, new Date(now)) };
  assert.throws(() => usableTechnical(snap, { symbol: SYMBOL, date: '2026-10-23', price: 10, prevClose: 10 }, new Date(now)), /日线/);
});

test('收盘后前一交易日缓存失效，未知年份、未来获取时间、错误口径及篡改内容不能复用', async () => {
  const prepared = prepareHistory(SYMBOL, 'stock', history(), START);
  assert.ok(preparedHistoryValid(prepared, SYMBOL, 'stock', START));
  for (const [mutate, now] of [
    [x => { x.bars[0].close += 0.01; }, START], [x => { x.adjustment = '前复权'; }, START],
    [x => { x.symbol = 'sh600011'; }, START], [x => { x.fetchedAt = START + 1; }, START],
    [x => {}, Date.parse('2026-10-22T15:00:00+08:00')], [x => {}, Date.parse('2027-01-04T10:00:00+08:00')]
  ]) { const copy = structuredClone(prepared); mutate(copy); assert.equal(preparedHistoryValid(copy, SYMBOL, 'stock', now), false); }
  assert.equal(prepareHistory(SYMBOL, 'stock', { ...history(), fetchedAt: Date.parse('2026-10-21T14:59:59+08:00') }, START), null);
});

test('周末只复用覆盖最近完整交易日的历史，下一交易日收盘后不能跨日使用', () => {
  const friday = Date.parse('2026-10-23T16:00:00+08:00'), sunday = Date.parse('2026-10-25T10:00:00+08:00');
  const entry = prepareHistory(SYMBOL, 'stock', history(friday), friday);
  assert.ok(preparedHistoryValid(entry, SYMBOL, 'stock', sunday));
  assert.ok(preparedHistoryValid(entry, SYMBOL, 'stock', Date.parse('2026-10-26T10:00:00+08:00')));
  assert.equal(preparedHistoryValid(entry, SYMBOL, 'stock', Date.parse('2026-10-26T15:00:00+08:00')), false);
});

test('指数历史按完整交易日复用，时间与行情基准规则保留', async () => {
  const symbol = 'sh000001', at = Date.parse('2026-10-22T14:00:00+08:00');
  const original = history(Date.parse('2026-10-21T16:00:00+08:00'), symbol);
  const entry = prepareHistory(symbol, 'index', original, at);
  assert.ok(entry); assert.equal(preparedIndexHistory(symbol, entry, at).asOf, '2026-10-21');
  assert.throws(() => preparedIndexHistory('sz399001', entry, at), /来源/);
});

test('文件损坏重新获取；写缓存失败仍使用本次真实数据并暴露警告', async () => {
  const cache = new DailyHistoryCache({ clock: () => START, store: { read: () => { throw Error('校验和不匹配'); }, write: () => { throw Error('EACCES'); } } });
  const result = await cache.load(SYMBOL, 'stock', async () => history());
  assert.ok(preparedHistoryValid(result, SYMBOL, 'stock', START)); assert.match(result.cacheWarning, /EACCES/);
});

test('交易调用者取消不返回成功，来源超时仍保留有效历史', async () => {
  const cache = new DailyHistoryCache({ clock: () => START });
  await cache.load(SYMBOL, 'stock', async () => history());
  const timedOut = await cache.load(SYMBOL, 'stock', async () => { throw Object.assign(Error('来源超时'), { name: 'TimeoutError' }); }, { force: true });
  assert.equal(timedOut.historyStatus, 'degraded');
  const controller = new AbortController();
  await assert.rejects(cache.load(SYMBOL, 'stock', async () => { controller.abort(); throw controller.signal.reason; }, { force: true, signal: controller.signal }), { name: 'AbortError' });
});

test('共享日线源合并并发请求，显式重试排在旧请求之后并保持新请求结果', async () => {
  const cache = new DailyHistoryCache({ clock: () => START }); let release, calls = 0;
  const first = cache.load(SYMBOL, 'stock', () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const shared = cache.load(SYMBOL, 'stock', () => assert.fail('同一股票在途请求应合并'));
  const forced = cache.load(SYMBOL, 'stock', async () => { calls++; return history(START, SYMBOL, 1); }, { force: true });
  await next(); release(history());
  assert.equal((await first).dailyEvidence.close, 10); assert.equal((await shared).dailyEvidence.close, 10);
  assert.equal((await forced).dailyEvidence.close, 11); assert.equal(calls, 2);
});

test('取消筛选只取消自己的等待，不取消共享日线下载或持仓监控', async () => {
  const controller = new AbortController(); let release, requestSignal, calls = 0;
  const raw = history().bars.map(b => [b.date, b.open, b.close, b.high, b.low, b.volume / 100]);
  const market = new Market(async (url, options) => {
    calls++; requestSignal = options.signal;
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ code: 0, data: { [SYMBOL]: { day: raw } } }) };
  }, { clock: () => START });
  const screen = market.strategyHistory(SYMBOL, controller.signal, true);
  const holding = market.strategyHistory(SYMBOL, null, true);
  await next();
  controller.abort(); await assert.rejects(screen, { name: 'AbortError' });
  assert.equal(requestSignal.aborted, false); release();
  assert.equal((await holding).dailyEvidence.asOf, '2026-10-21'); assert.equal(calls, 1);
  assert.equal(market.dailyHistory.errors.size, 0);
});

test('所有调用方取消后不启动排队的强制刷新', async () => {
  const cache = new DailyHistoryCache({ clock: () => START });
  const firstAbort = new AbortController(), nextAbort = new AbortController(); let release, nextCalls = 0;
  const first = cache.load(SYMBOL, 'stock', () => new Promise(resolve => { release = resolve; }), { signal: firstAbort.signal });
  await next();
  const forced = cache.load(SYMBOL, 'stock', async () => { nextCalls++; return history(); }, { force: true, signal: nextAbort.signal });
  firstAbort.abort(); nextAbort.abort();
  await assert.rejects(first, { name: 'AbortError' }); await assert.rejects(forced, { name: 'AbortError' });
  release(history()); await next();
  assert.equal(nextCalls, 0); assert.equal(cache.entries.size, 0); assert.equal(cache.pending.size, 0);
});

test('已知日线修正使在途监控和交易手中旧证据失效，不能因等待公告后写回而复活', async () => {
  let revision = 0, release;
  const market = new Market(() => assert.fail('只用隔离数据'), { clock: () => START });
  market.daily = async () => history(START, SYMBOL, revision);
  const old = await market.strategyHistory(SYMBOL, null, true);
  const held = { ...old, technical: technicals(old.bars, new Date(START)) };
  const monitor = new StrategyMonitor(market, () => new Date(START), () => {}, {
    get: () => new Promise(resolve => { release = () => resolve({ status: 'empty', fetchedAt: START, data: { items: [], total: 0 } }); })
  });
  const pending = monitor.load(SYMBOL, false, false, true); await next();
  revision = 1; const corrected = await market.strategyHistory(SYMBOL, null, true, true);
  assert.notEqual(corrected.dailyEvidence.barsHash, old.dailyEvidence.barsHash);
  assert.equal(preparedTechnicalValid(held, START, SYMBOL), false);
  assert.throws(() => usableTechnical(held, { symbol: SYMBOL, date: '2026-10-22', price: 10, prevClose: 10 }, new Date(START)), /日线/);
  release(); const stale = await pending;
  assert.match(stale.error, /版本已更新/); assert.equal(preparedTechnicalValid(stale, START, SYMBOL), false);
  const fresh = await monitor.load(SYMBOL);
  assert.equal(fresh.technical.close, 11); assert.ok(preparedTechnicalValid(fresh, START, SYMBOL));
});

test('真实Market到Monitor链路保留原获取时间；备用接口全失败不抹去当日有效指标', async () => {
  let now = START, calls = 0, offline = false;
  const raw = history().bars.map(b => [b.date, b.open, b.close, b.high, b.low, b.volume / 100]);
  const market = new Market(async () => { calls++; return offline ? { ok: false, status: 501 } : { ok: true, json: async () => ({ code: 0, data: { [SYMBOL]: { day: raw } } }) }; }, { clock: () => now });
  const monitor = new StrategyMonitor(market, () => new Date(now));
  const first = await monitor.load(SYMBOL); now += 5 * 60000; offline = true;
  const second = await monitor.load(SYMBOL);
  assert.equal(calls, 1); assert.equal(second.fetchedAt, first.fetchedAt); assert.ok(preparedTechnicalValid(second, now, SYMBOL));
  const failedRefresh = await monitor.load(SYMBOL, true);
  assert.equal(calls, 5); assert.equal(failedRefresh.error, undefined); assert.match(failedRefresh.refreshError, /501/);
  assert.ok(preparedTechnicalValid(failedRefresh, now, SYMBOL));
});
