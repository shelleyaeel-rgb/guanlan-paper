'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFinance, defaults, classifyScreenRow } = require('../core/screener.cjs');
const { financialConditionCheck } = require('../core/agency-screening.cjs');
const { createEntryConditions, evaluateEntryConditions } = require('../core/entry-conditions.cjs');
const { buildCompanyMetrics, evaluateResearchRules } = require('../core/research-rules.cjs');
const { longFinanceCheck } = require('../core/strategy.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');

const symbol = 'sh600001';
const rule = { field: 'latestAdjustedProfit', op: 'gt', value: 0 };
function snapshotAt(now, reportDate, noticeDate) {
  return { finance: { symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: +now, industryProfile: ordinaryProfile(symbol, now),
    data: { latest: { reportDate, noticeDate, currency: 'CNY', roe: reportDate.endsWith('-12-31') ? 10 : 2, debtRatio: 40, revenueYoY: 5,
      adjustedProfitYoY: 6, adjustedProfit: 1e8, operatingCash: 2e8 },
    annual: [{ reportDate: '2025-12-31', noticeDate: '2026-03-20', currency: 'CNY', roe: 10 }] } },
    notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: +now, data: { items: [], total: 0 } } };
}
function statuses(snapshot, now) {
  const row = { symbol, ...normalizeFinance(snapshot.finance, symbol, now) };
  const companyMetrics = buildCompanyMetrics(row, { symbol, now });
  const query = { ...defaults(), rules: [rule] };
  return {
    screening: classifyScreenRow(row, query).status,
    pool: financialConditionCheck(row, query, now, snapshot.notices).status,
    entry: evaluateEntryConditions(createEntryConditions(query, now), symbol, null, snapshot, now).status,
    company: evaluateResearchRules({ version: 1, enabled: true, path: 'company', rules: [rule] }, { symbol, companyMetrics }, now).status,
    long: longFinanceCheck(snapshot, symbol, now).checks.find(check => check.field === rule.field)?.status
  };
}

test('报告覆盖期在北京时间边界切换，筛选、候选池、持续开仓和公司经营判断一致', () => {
  for (const [before, after, oldReport, oldNotice, newReport, newNotice] of [
    ['2026-04-30T23:59:59+08:00', '2026-05-01T00:00:00+08:00', '2025-12-31', '2026-03-20', '2026-03-31', '2026-04-25'],
    ['2026-08-31T23:59:59+08:00', '2026-09-01T00:00:00+08:00', '2026-03-31', '2026-04-25', '2026-06-30', '2026-08-25'],
    ['2026-10-31T23:59:59+08:00', '2026-11-01T00:00:00+08:00', '2026-06-30', '2026-08-25', '2026-09-30', '2026-10-25']
  ]) {
    const earlier = new Date(before), later = new Date(after);
    const pass = { screening: 'pass', pool: 'pass', entry: 'pass', company: 'pass', long: 'pass' };
    assert.deepEqual(statuses(snapshotAt(earlier, oldReport, oldNotice), earlier), pass, before);
    const stale = snapshotAt(later, oldReport, oldNotice);
    assert.deepEqual(statuses(stale, later), Object.fromEntries(Object.keys(pass).map(key => [key, 'pending'])), after);
    const annual = longFinanceCheck(stale, symbol, later).checks.find(check => check.field === 'annualRoeLatest');
    assert.equal(annual.status, 'pass');
    assert.equal(annual.reportDate, '2025-12-31');
    assert.deepEqual(statuses(snapshotAt(later, newReport, newNotice), later), pass, newReport);
  }
});

test('同一累计期间盈利金额与正同比独立，所有入口保留亏损为明确不符', () => {
  const now = new Date('2026-10-15T10:00:00+08:00'), snapshot = snapshotAt(now, '2026-06-30', '2026-08-25');
  snapshot.finance.data.latest.adjustedProfit = -1e8;
  snapshot.finance.data.latest.adjustedProfitYoY = 50;
  assert.deepEqual(statuses(snapshot, now), { screening: 'failed', pool: 'failed', entry: 'failed', company: 'failed', long: 'failed' });
  const check = longFinanceCheck(snapshot, symbol, now);
  assert.equal(check.checks.find(item => item.field === 'adjustedProfitYoY').status, 'pass');
  assert.equal(check.checks.find(item => item.field === 'latestAdjustedProfit').value, -1);
});
