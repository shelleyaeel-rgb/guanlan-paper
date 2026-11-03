const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Screener, defaults, financialQualityRules } = require('../core/screener.cjs');
const { runAgencyScreening: screenAgency } = require('../core/agency-screening.cjs');
const runAgencyScreening = (screener, options = {}) => screenAgency(screener, { screeningMode: 'strict', ...options });
const { calendarSession } = require('../core/trading-calendar.cjs');
const { FINANCE_MAX_AGE_MS, ScreeningDataCache } = require('../core/screening-data-cache.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');

const INITIAL = Date.parse('2026-10-13T10:00:00+08:00');
const SYMBOL = 'sh600001';
function bars(end = '2026-10-12') {
  const dates = []; let day = Date.parse(`${end}T10:00:00+08:00`);
  while (dates.length < 120) { const session = calendarSession(new Date(day)); if (session.open) dates.unshift(session.date); day -= 86400000; }
  const level = i => i * 0.008 + Math.sin(i / 4 + 1.6) * 0.12 + (i % 2 === 0 ? 0.02 : -0.02);
  return dates.map((date, i) => {
    const close = 10.94 + level(i) - level(119);
    return { date, close, open: close, high: close + 0.1, low: close - 0.1, volume: i === 119 ? 150 : 100 };
  });
}
function fixture(t, { persistent = false } = {}) {
  let directory;
  if (persistent) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-candidate-cache-'));
    t.after(() => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('guanlan-candidate-cache-'));
      fs.rmSync(directory, { recursive: true, force: true });
    });
  }
  const state = { now: INITIAL, quoteSource: '隔离同源行情', dailyEnd: '2026-10-12', dailyError: false, financeError: false,
    sourceFetchedAt: null, report: {}, quote: {}, calls: { quotes: [], finance: [], daily: 0, notices: 0, evidence: 0 } };
  const make = (namespace = 'isolated-v1') => new Screener(null, null, async () => {
    state.calls.daily++; if (state.dailyError) throw Error('日线下载失败');
    return { bars: bars(state.dailyEnd), source: '隔离完整未复权日线' };
  }, () => new Date(state.now), async (symbol, signal, force) => {
    state.calls.finance.push(force); if (state.financeError) throw Error('财报下载失败');
    return { symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: state.sourceFetchedAt ?? state.now,
      industryProfile: ordinaryProfile(symbol, state.now),
      data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', updateDate: '2026-08-20', currency: 'CNY', roe: 9,
        debtRatio: 40, adjustedProfit: 1e8, revenueYoY: 10, adjustedProfitYoY: 10, operatingCash: 2e8, ...state.report },
      annual: [2025, 2024, 2023].map(year => ({ reportDate: `${year}-12-31`, noticeDate: `${year + 1}-03-30`, currency: 'CNY', roe: 12, adjustedProfit: 2e8, operatingCash: 3e8 })) } };
  }, async symbol => {
    state.calls.notices++; return { symbol, section: 'notices', status: 'empty', source: '东方财富', fetchedAt: state.now, data: { items: [], total: 0 } };
  }, null, async () => {
    state.calls.quotes.push(state.now); return { rows: [{ symbol: SYMBOL, name: '隔离样本', board: 'sh', isST: false, timestamp: state.now,
      price: 11.05, prevClose: 10.94, changePct: 1, amount: 3, turnover: 3, pe: 20, pb: 2, ...state.quote }],
    source: state.quoteSource, fetchedAt: state.now, sourceCount: 1, excludedCount: 0 };
  }, null, async symbol => { state.calls.evidence++; return companyBundle(symbol, new Date(state.now)); },
  { screeningCacheDirectory: directory, screeningCacheNamespace: namespace });
  const snapshot = () => ({ rows: [{ symbol: SYMBOL, name: '隔离样本', board: 'sh', isST: false, timestamp: state.now, price: 11.05, prevClose: 10.94, ...state.quote }], source: state.quoteSource });
  const financeQuery = { ...defaults(), rules: financialQualityRules() }, dailyQuery = { ...defaults(), rules: [{ field: 'rsi', op: 'gt', value: 0 }] };
  const finance = (s, extra = {}, observed = state.now) => s.scanFinance(snapshot(), financeQuery, [], true, new AbortController().signal, new Date(observed), { mode: 'candidate', ...extra });
  const daily = (s, extra = {}, observed = state.now) => s.scanDaily(snapshot(), dailyQuery, [], true, new AbortController().signal, new Date(observed), { mode: 'candidate', expectedDailyDate: state.dailyEnd, ...extra });
  return { state, make, finance, daily, directory };
}

test('技术候选重试刷新行情并复用完整日线，财务公告与研究始终不请求', async t => {
  const f = fixture(t), s = f.make();
  const forceFlags = [], originalLoad = s.load.bind(s);
  s.load = force => { forceFlags.push(force); return originalLoad(force); };
  const first = await runAgencyScreening(s);
  assert.equal(first.strategies.long.pass.length, 1);
  f.state.now += 120000; f.state.quote.pe = 100;
  const second = await runAgencyScreening(s, { force: false, retryEvidence: true });
  assert.deepEqual(forceFlags, [true, true]); assert.equal(f.state.calls.quotes.length, 2);
  assert.equal(f.state.calls.finance.length, 0); assert.equal(f.state.calls.daily, 1);
  assert.equal(f.state.calls.notices, 0); assert.equal(f.state.calls.evidence, 0);
  assert.equal(second.strategies.long.pass.length, 1); assert.equal(second.strategies.swing.pass.length, 1);
  assert.equal(second.coverage.cache.finance, null); assert.equal(second.coverage.cache.daily.hits, 1);
  assert.equal(second.strategies.swing.pass[0].financeFetchedAt, undefined);
  assert.equal(second.strategies.swing.pass[0].technicalFetchedAt, INITIAL);
  assert.equal(second.coverage.quantitativeStages.long.quotePossible, 1);
  assert.equal(second.coverage.quantitativeStages.swing.dailyRequired, 1);
  assert.deepEqual(Object.keys(second.coverage.timings), ['quotes', 'daily']);
  assert.equal(second.coverage.researchChecks.status, 'disabled');
});

test('技术候选磁盘重启复用日线，namespace变化与强刷重取日线而不取财报', async t => {
  const f = fixture(t, { persistent: true });
  await runAgencyScreening(f.make()); f.state.now += 120000;
  const restored = f.make(), reused = await runAgencyScreening(restored);
  assert.equal(f.state.calls.finance.length, 0); assert.equal(f.state.calls.daily, 1);
  assert.equal(reused.coverage.cache.finance, null); assert.equal(reused.coverage.cache.daily.hits, 1);
  f.state.report = { updateDate: '2026-10-13', debtRatio: 80 };
  const refreshed = await runAgencyScreening(restored, { refreshQuantitative: true });
  assert.equal(refreshed.strategies.long.pass.length, 1); assert.equal(refreshed.coverage.commonFailed, 0);
  assert.equal(f.state.calls.finance.length, 0); assert.equal(f.state.calls.daily, 2);
  assert.equal(restored.screeningDataCache.get('finance', SYMBOL), undefined);
  await runAgencyScreening(f.make()); assert.equal(f.state.calls.daily, 2, '更新后的有效日线继续复用');
  await runAgencyScreening(f.make('provider-v2')); assert.equal(f.state.calls.daily, 3);
  assert.equal(f.state.calls.finance.length, 0); assert.equal(f.state.calls.notices, 0); assert.equal(f.state.calls.evidence, 0);
});

test('财务按源获取时点6小时及观察日期失效，不因本轮加载时间延长旧资料寿命', async t => {
  const f = fixture(t), s = f.make();
  await f.finance(s); f.state.now += FINANCE_MAX_AGE_MS - 1; await f.finance(s);
  assert.equal(f.state.calls.finance.length, 1);
  f.state.now++; await f.finance(s); assert.equal(f.state.calls.finance.length, 2);
  f.state.now = Date.parse('2026-10-14T00:01:00+08:00'); await f.finance(s);
  assert.equal(f.state.calls.finance.length, 3);
  f.state.sourceFetchedAt = f.state.now - FINANCE_MAX_AGE_MS;
  await f.finance(s, { refreshQuantitative: true }); await f.finance(s);
  assert.equal(f.state.calls.finance.length, 5, '来源旧时间不能被loadedAt重新起算');
});

test('财务缺项只重试缺失股票，强刷失败清除已成功缓存且不回退旧数值', async t => {
  const f = fixture(t), s = f.make(); f.state.report.debtRatio = null;
  await f.finance(s); assert.equal(s.screeningDataCache.get('finance', SYMBOL), undefined);
  f.state.report.debtRatio = 40; const fixed = await f.finance(s);
  assert.equal(fixed.rows[0].debtRatio, 40); assert.equal(f.state.calls.finance.length, 2);
  f.state.financeError = true;
  const failed = await f.finance(s, { refreshQuantitative: true });
  assert.equal(failed.rows[0].debtRatio, null); assert.equal(failed.rows[0].financeError, 'fetch');
  assert.equal(s.screeningDataCache.get('finance', SYMBOL), undefined);
});

test('同完整交易日日线可跨午夜复用；价格基准、行情源、收盘日期变化均重取', async t => {
  const f = fixture(t), s = f.make();
  await f.daily(s); f.state.now += 120000; await f.daily(s); assert.equal(f.state.calls.daily, 1);
  f.state.now = Date.parse('2026-10-14T00:01:00+08:00'); await f.daily(s); assert.equal(f.state.calls.daily, 1);
  f.state.quote.prevClose = 11; const mismatch = await f.daily(s); assert.equal(f.state.calls.daily, 2);
  assert.equal(mismatch.technicalScan.cache.hits, 0); assert.equal(s.screeningDataCache.get('daily', SYMBOL), undefined);
  f.state.quote.prevClose = 10.94; await f.daily(s); assert.equal(f.state.calls.daily, 3);
  f.state.quoteSource = '切换后的行情源'; await f.daily(s); assert.equal(f.state.calls.daily, 4);
  f.state.dailyEnd = '2026-10-13'; await f.daily(s); assert.equal(f.state.calls.daily, 5);
});

test('错配日线重取失败保持待核验，不用旧缓存作通过或明确失败', async t => {
  const f = fixture(t), s = f.make(); await runAgencyScreening(s);
  f.state.now += 120000; f.state.quote.prevClose = 11; f.state.dailyError = true;
  const result = await runAgencyScreening(s);
  for (const id of ['ultra-short', 'short', 'swing', 'long']) {
    assert.equal(result.strategies[id].pending.length, 1); assert.equal(result.strategies[id].failed.length, 0);
    assert.equal(result.strategies[id].pending[0].technicalError, 'fetch');
  }
  assert.equal(result.strategies.long.pass.length, 0); assert.equal(s.screeningDataCache.get('daily', SYMBOL), undefined);
});

test('缓存元数据版本损坏、未来观察时点及文件损坏回退获取，不中断候选扫描', async t => {
  const f = fixture(t, { persistent: true }), s = f.make(); await f.finance(s); await f.daily(s);
  s.screeningDataCache.get('finance', SYMBOL).reportVersion = 'corrupt'; await f.finance(s);
  assert.equal(f.state.calls.finance.length, 2);
  s.screeningDataCache.get('daily', SYMBOL).observedAt = f.state.now + 1; await f.daily(s);
  assert.equal(f.state.calls.daily, 2);
  fs.writeFileSync(path.join(f.directory, 'screening-data-v1.json'), '{invalid');
  const cache = new ScreeningDataCache(f.directory, 'isolated-v1'); assert.match(cache.warning, /重新获取/);
  const result = await runAgencyScreening(f.make()); assert.equal(result.status, 'ready');
});

test('旧严格筛选参数不再启用研究；复用有效日线且研究失败不能影响技术筛选', async t => {
  const f = fixture(t), s = f.make();
  const first = await screenAgency(s);
  assert.equal(first.screeningMode, 'strategy'); assert.equal(first.strategies.swing.pass.length, 1); assert.equal(f.state.calls.evidence, 0);
  f.state.now += 120000;
  s.automaticEvidenceLoader = async symbol => { f.state.calls.evidence++; return { symbol, status: 'unavailable', documents: [], errors: ['研究资料待补齐'] }; };
  const strict = await screenAgency(s, { screeningMode: 'strict' });
  assert.equal(strict.screeningMode, 'strategy'); assert.equal(strict.strategies.swing.pass.length, 1); assert.equal(strict.strategies.swing.pending.length, 0);
  assert.equal(f.state.calls.evidence, 0); assert.equal(f.state.calls.finance.length, 0); assert.equal(f.state.calls.daily, 1);
  assert.equal(strict.coverage.cache.finance, null); assert.equal(strict.coverage.cache.daily.hits, 1);
  assert.equal(strict.coverage.researchChecks.status, 'disabled');
});
