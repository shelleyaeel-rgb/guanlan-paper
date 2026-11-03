'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Screener } = require('../core/screener.cjs');
const { runAgencyScreening, poolPolicy } = require('../core/agency-screening.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');
const { oilTable } = require('./fixtures/company-report-table-excerpts.cjs');
const { evaluateOperatingResearch, refreshOperatingResearch } = require('../core/company-research.cjs');
const NOW = new Date('2026-10-13T10:00:00+08:00'), IDS = ['ultra-short', 'short', 'swing', 'long'];
const query = (path, rules, enabled = true) => ({ version: 1, enabled, path, rules });
const row = (symbol = 'sh600001') => ({ symbol, name: '隔离经营筛选', board: 'sh', isST: false, timestamp: +NOW,
  price: 11.05, prevClose: 10.94, changePct: 1, amount: 3, turnover: 3, pe: 20, pb: 2 });
function bars() {
  const dates = []; let day = Date.parse('2026-10-12T10:00:00+08:00');
  while (dates.length < 120) { const session = calendarSession(new Date(day)); if (session.open) dates.unshift(session.date); day -= 86400000; }
  const level = i => i * 0.008 + Math.sin(i / 4 + 1.6) * 0.12 + (i % 2 === 0 ? 0.02 : -0.02);
  return dates.map((date, i) => { const close = 10.94 + level(i) - level(119);
    return { date, open: close, close, high: close + 0.1, low: close - 0.1, volume: i === 119 ? 150 : 100 }; });
}
const DAILY = bars();
function productBundle(symbol) {
  const bundle = companyBundle(symbol, NOW), report = bundle.documents.find(item => item.kind === 'semiannual-report');
  report.text = report.fullText = oilTable;
  // This path is intentionally independent of outside industry rankings.
  bundle.industry = { status: 'unavailable', reason: '隔离测试不提供行业资料' };
  return bundle;
}
function scanner({ rows = [row()], finance = {}, product, notices, now = NOW } = {}) {
  const calls = { product: [], finance: [], notices: [] };
  const s = new Screener(null, null, () => ({ bars: DAILY, source: '隔离未复权日线' }), () => now,
    symbol => { calls.finance.push(symbol); return { symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: +now, industryProfile: ordinaryProfile(symbol, now), data: { latest: {
      reportDate: '2026-06-30', noticeDate: '2026-08-15', currency: 'CNY', roe: 9, debtRatio: 40, adjustedProfit: 1e8,
      revenueYoY: 10, adjustedProfitYoY: 10, operatingCash: 2e8, ...finance }, annual: [2025, 2024, 2023].map(year => ({ reportDate: `${year}-12-31`, noticeDate: `${year + 1}-03-28`, currency: 'CNY', roe: finance.annualRoe ?? 12, adjustedProfit: 1e8, operatingCash: 2e8 })) } }; },
    symbol => { calls.notices.push(symbol); return notices ? notices(symbol) : { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: +now, data: { items: [], total: 0 } }; },
    null, null, () => { throw Error('经营指标不可依赖人工证据'); }, (symbol, options) => {
      calls.product.push({ symbol, options }); return product ? product(symbol, options) : productBundle(symbol);
    });
  s.load = async () => ({ rows: structuredClone(rows), fetchedAt: +NOW, source: '隔离行情', sourceCount: rows.length, excludedCount: 0 });
  return { s, calls };
}
const entry = (result, strategy, status = 'pass') => result.strategies[strategy][status][0];

test('旧公司产品业绩和行业条件全部停用，不再启动任何公告财务或PDF采集', async () => {
  const options = [
    { research: query('product', [{ field: 'grossMarginPct', op: 'gte', value: 99 }]) },
    { research: query('company', [{ field: 'revenueYoY', op: 'gt', value: 1000 }]) },
    { performance: { version: 1, enabled: true, rules: [{ field: 'netProfitGrowthMinPct', op: 'gt', value: 1000 }] } },
    { screeningMode: 'strict', industry: { invalidLegacy: true } }
  ];
  for (const selected of options) {
    const { s, calls } = scanner({ finance: { annualRoe: null, adjustedProfit: null }, product: () => { throw Error('PDF不可用'); }, notices: () => { throw Error('公告不可用'); } });
    const result = await runAgencyScreening(s, selected);
    assert.deepEqual(calls, { product: [], finance: [], notices: [] });
    for (const id of IDS) {
      assert.ok(entry(result, id), id);
      assert.equal(entry(result, id).researchReview, undefined); assert.equal(entry(result, id).financeCheck, undefined);
      for (const key of ['evidence', 'research', 'performance']) assert.equal(result.strategies[id].query[key], undefined);
    }
    assert.equal(result.coverage.diagnostics.researchAttempted, 0); assert.equal(result.coverage.researchStatus, 'disabled');
    const policy = poolPolicy(selected.screeningMode, selected.research, selected.performance, selected.industry);
    assert.equal(policy.screeningMode, 'strategy'); assert.equal(policy.researchChecks.status, 'disabled');
  }
});

test('lightweight publication refresh enforces company acquisition age and a changed minimum report period', () => {
  const symbol = 'sh600001', company = { symbol, financeSource: '东方财富', financeCurrency: 'CNY', financeReportDate: '2026-06-30',
    financeNoticeDate: '2026-08-15', financeFetchedAt: +NOW, revenueYoY: 10 };
  const research = query('company', [{ field: 'revenueYoY', op: 'gt', value: 0 }]);
  const original = evaluateOperatingResearch(null, research, { symbol, company, now: NOW });
  assert.equal(original.status, 'pass');
  const aged = refreshOperatingResearch(original, { company, now: new Date(+NOW + 21600001) });
  assert.equal(aged.status, 'pending'); assert.match(aged.assessment.reasons.join(''), /6\s*小时/);
  const start = new Date('2026-08-31T23:59:59+08:00');
  Object.assign(company, { financeReportDate: '2026-03-31', financeNoticeDate: '2026-04-20', financeFetchedAt: +start });
  const before = evaluateOperatingResearch(null, research, { symbol, company, now: start });
  assert.equal(before.status, 'pass');
  const after = refreshOperatingResearch(before, { company, now: new Date(+start + 1000) });
  assert.equal(after.status, 'pending'); assert.match(after.assessment.reasons.join(''), /最低适用报告期 2026-06-30/);
  assert.equal(before.status, 'pass'); assert.equal(before.companyMetrics.reportDate, '2026-03-31');
});
