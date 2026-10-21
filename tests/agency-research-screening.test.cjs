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
  return dates.map((date, i) => { const close = 10 + i * 0.008 + Math.sin(i / 4 + 1.6) * 0.12;
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

test('product screening uses raw report values without an industry gate or unselected missing metrics', async () => {
  const { s, calls } = scanner(), research = query('product', [{ field: 'currentRevenue', op: 'gt', value: 1 }]);
  const result = await runAgencyScreening(s, { research });
  for (const id of IDS) {
    const item = entry(result, id); assert.ok(item, id); assert.equal(item.researchReview.status, 'pass');
    assert.equal(item.diagnostics.researchAttempted, true); assert.equal(item.diagnostics.researchComplete, true);
    assert.equal(item.selectionEvidence, undefined); assert.deepEqual(result.strategies[id].query.research, research);
  }
  assert.equal(calls.product.length, 1); assert.equal(calls.product[0].options.includeIndustry, false);
  assert.equal(result.coverage.operatingResearch.pass, 1); assert.equal(result.coverage.evidenceChecked, 0);
  const candidate = entry(result, 'swing').researchReview.productMetrics.products.find(item => item.subject === '石油液体');
  assert.equal(candidate.metrics.currentRevenue.value, 178913e6); assert.equal(candidate.metrics.grossMarginPct.usable, false);
  assert.equal(result.coverage.diagnostics.researchAttempted, 1);
});

test('explicit company screening uses company values without requesting product reports or industry', async () => {
  const { s, calls } = scanner({ product: () => { throw Error('company mode must not request PDFs'); } });
  const result = await runAgencyScreening(s, { research: query('company', [{ field: 'revenueYoY', op: 'gte', value: 10 }]) });
  for (const id of IDS) { assert.ok(entry(result, id)); assert.equal(entry(result, id).researchReview.assessment.label, '公司经营条件'); }
  assert.equal(calls.product.length, 0); assert.equal(calls.finance.length, 1);
  assert.equal(result.coverage.diagnostics.researchComplete, 1);
});

test('missing selected company metric is pending while an unselected missing metric does not block', async () => {
  const missing = scanner({ finance: { adjustedProfit: null } });
  const pending = await runAgencyScreening(missing.s, { research: query('company', [{ field: 'latestAdjustedProfit', op: 'gt', value: 0 }]) });
  for (const id of IDS) {
    const item = entry(pending, id, 'pending'); assert.ok(item, id); assert.equal(item.stage, id === 'long' ? 'finance' : 'research');
    if (id !== 'long') assert.equal(item.diagnostics.code, 'research-metrics-pending'); assert.equal(item.diagnostics.researchAttempted, true);
    assert.equal(item.diagnostics.researchComplete, false); assert.doesNotMatch(item.diagnostics.label, /产品|量化/);
  }
  assert.equal(pending.coverage.diagnostics.researchNotStarted, 0);
  const unselected = await runAgencyScreening(missing.s, { research: query('company', [{ field: 'revenueYoY', op: 'gte', value: 10 }]) });
  for (const id of IDS.slice(0, 3)) assert.ok(entry(unselected, id), id);
  assert.equal(entry(unselected, 'long', 'pending').financeCheck.checks.find(check => check.field === 'latestAdjustedProfit').status, 'pending');
  assert.equal(missing.calls.product.length, 0);
});

test('selected product missingness stays pending without borrowing company profitability', async () => {
  const result = await runAgencyScreening(scanner().s, { research: query('product', [{ field: 'grossMarginPct', op: 'gte', value: 10 }]) });
  for (const id of IDS) {
    const item = entry(result, id, 'pending'); assert.ok(item, id); assert.equal(item.stage, 'research');
    assert.equal(item.researchReview.assessment.path, 'product'); assert.equal(item.diagnostics.researchAttempted, true);
  }
  assert.equal(result.coverage.operatingResearch.pending, 1); assert.equal(result.coverage.diagnostics.researchComplete, 0);
});

test('known unmet metrics are failed; parsing failures remain pending with acquisition diagnostics', async () => {
  const failed = await runAgencyScreening(scanner().s, { research: query('company', [{ field: 'revenueYoY', op: 'gt', value: 100 }]) });
  for (const id of IDS) { const item = entry(failed, id, 'failed'); assert.ok(item, id); assert.equal(item.diagnostics.code, 'research-conditions-failed'); }
  assert.equal(failed.coverage.diagnostics.researchComplete, 1);
  const unavailable = scanner({ product: symbol => ({ symbol, documents: [], checkedAt: +NOW, acquisition: { issues: [
    { stage: 'parse', code: 'parser-error', message: '本报告原文解析失败', documentId: 'AN1' } ] } }) });
  const pending = await runAgencyScreening(unavailable.s, { research: query('product', [{ field: 'currentRevenue', op: 'gt', value: 1 }]) });
  for (const id of IDS) assert.equal(entry(pending, id, 'pending').diagnostics.code, 'research-document-parse');
});

test('disabled research does not request products, block candidates, or count an attempted condition check', async () => {
  const { s, calls } = scanner({ product: () => { throw Error('disabled mode must not collect'); } });
  const research = query('product', [{ field: 'grossMarginPct', op: 'gte', value: 99 }], false);
  const result = await runAgencyScreening(s, { research });
  for (const id of IDS) { assert.ok(entry(result, id), id); assert.equal(entry(result, id).researchReview.status, 'observing'); }
  assert.equal(calls.product.length, 0); assert.equal(result.coverage.diagnostics.researchAttempted, 0);
});

test('company and product alternatives retain strategy finance and announcement gates', async () => {
  const result = await runAgencyScreening(scanner({ finance: { annualRoe: 1 } }).s,
    { research: query('product', [{ field: 'currentRevenue', op: 'gt', value: 1 }]) });
  for (const id of IDS.slice(0, 3)) assert.ok(entry(result, id), id);
  assert.ok(entry(result, 'long', 'failed')); assert.match(entry(result, 'long', 'failed').reasons.join(''), /年度ROE/);
  const { s, calls } = scanner({ notices: symbol => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW,
    data: { items: [{ id: 'AN20261013000001', date: '2026-10-13', title: '关于被立案调查的公告' }], total: 1 } }) });
  const risk = await runAgencyScreening(s, { research: query('product', [{ field: 'currentRevenue', op: 'gt', value: 1 }]) });
  for (const id of IDS) assert.equal(risk.strategies[id].pass.length, 0);
  assert.equal(calls.product.length, 1); assert.equal(risk.coverage.operatingResearch.evaluated, 1);
  for (const id of IDS) {
    const candidate = [...risk.strategies[id].failed, ...risk.strategies[id].pending][0];
    assert.equal(candidate.researchReview.status, 'pass');
    assert.match(candidate.reasons.join('；'), /风险|公告/);
  }
  assert.throws(() => poolPolicy('strict', query('company', [{ field: 'revenueYoY', op: 'gt', value: 0 }])), /独立路径/);
});

test('final publication rechecks early product data after a later source takes more than six hours', async () => {
  const now = new Date(NOW), symbols = ['sh600001', 'sh600002'];
  const { s } = scanner({ now, rows: symbols.map(symbol => row(symbol)), product: async symbol => {
    const bundle = productBundle(symbol);
    if (symbol === symbols[1]) { await new Promise(resolve => setImmediate(resolve)); now.setTime(+now + 21600001); }
    return bundle;
  } });
  const result = await runAgencyScreening(s, { research: query('product', [{ field: 'currentRevenue', op: 'gt', value: 1 }]) });
  for (const id of IDS) {
    assert.equal(result.strategies[id].pass.length, 0);
    const item = result.strategies[id].pending.find(item => item.symbol === symbols[0]);
    assert.equal(item.stage, id === 'long' ? 'finance' : 'research'); assert.equal(item.researchReview.status, 'pending');
    assert.match(item.researchReview.assessment.reasons.join(''), /6\s*小时/);
    assert.equal(item.researchReview.productSource.checkedAt, +NOW);
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
