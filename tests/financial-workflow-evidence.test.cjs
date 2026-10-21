'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createEntryConditions, evaluateEntryConditions } = require('../core/entry-conditions.cjs');
const { candidateData } = require('../core/agency-service.cjs');
const { normalizeFinance } = require('../core/screener.cjs');
const { financialConditionCheck } = require('../core/agency-screening.cjs');
const symbol = 'sh600001', now = new Date('2026-10-15T10:00:00+08:00');

test('公司经营和个人财务开仓条件等待正式新报同步，同时保留旧报原值供查看', () => {
  const snapshot = { finance: { symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: +now,
    data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', currency: 'CNY', revenueYoY: 10, roe: 9 } } },
    notices: { symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +now,
      data: { items: [{ id: 'AN20261013000001', title: '2026年第三季度报告', date: '2026-10-13' }], total: 1 } } };
  const conditions = createEntryConditions({ rules: [{ field: 'roe', op: 'gte', value: 8 }],
    research: { version: 1, enabled: true, path: 'company', rules: [{ field: 'revenueYoY', op: 'gte', value: 0 }] } }, now);
  const pending = evaluateEntryConditions(conditions, symbol, null, snapshot, now);
  assert.equal(pending.status, 'pending'); assert.match(pending.reasons.join(''), /正式财报/);
  assert.equal(pending.researchReview.status, 'pending'); assert.equal(pending.researchReview.companyMetrics.metrics.revenueYoY.value, 10);
  assert.equal(pending.researchReview.companyMetrics.metrics.revenueYoY.usable, false);
  snapshot.notices.data.items[0].title = '2026年前三季度业绩预告';
  assert.equal(evaluateEntryConditions(conditions, symbol, null, snapshot, now).status, 'pass');
});

test('自动检查候选及证据保留财务、估值、预告独立结果和同步依据', () => {
  const financeCheck = { status: 'pass', checkedAt: +now, reportDate: '2026-06-30', checks: [] };
  const valuationCheck = { status: 'pending', checkedAt: +now, checks: [] };
  const performanceReview = { status: 'failed', checkedAt: now.toISOString(), checks: [] };
  const result = candidateData(symbol, null, { financeReportSync: { status: 'pending', checkedAt: +now } },
    { buyable: false, status: '等待公告核验', reasons: [], financeCheck, valuationCheck, entryConditionsCheck: { performanceReview } }, null, { equity: 0 });
  assert.deepEqual(result.financeCheck, financeCheck); assert.deepEqual(result.valuationCheck, valuationCheck); assert.deepEqual(result.performanceReview, performanceReview);
  for (const kind of ['financeCheck', 'valuationCheck', 'performanceReview', 'financeReportSync']) assert.ok(result.sources.some(source => source.kind === kind));
});

test('季度新报同步仅阻断累计字段，年度字段独立通过或明确不符，混合规则分别判断', () => {
  const annual = year => ({ reportDate: `${year}-12-31`, noticeDate: `${year + 1}-03-28`, currency: 'CNY', roe: 12, adjustedProfit: 1e8, operatingCash: 2e8 });
  const snapshot = { finance: { symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: +now,
    data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', currency: 'CNY', roe: 9 }, annual: [annual(2025), annual(2024), annual(2023)] } },
    notices: { symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +now,
      data: { items: [{ id: 'AN20261013000001', title: '2026年第三季度报告', date: '2026-10-13' }], total: 1 } } };
  const rule = (field, value) => ({ field, op: 'gte', value });
  const evaluate = rules => evaluateEntryConditions(createEntryConditions({ rules }, now), symbol, null, snapshot, now);
  const pool = rules => financialConditionCheck({ symbol, ...normalizeFinance(snapshot.finance, symbol, now) }, { rules }, now, snapshot.notices);
  for (const evaluateRules of [evaluate, pool]) {
    assert.equal(evaluateRules([rule('annualRoeLatest', 10)]).status, 'pass');
    assert.equal(evaluateRules([rule('annualRoeLatest', 13)]).status, 'failed');
    assert.equal(evaluateRules([rule('roe', 8)]).status, 'pending');
    const mixed = evaluateRules([rule('annualRoeLatest', 10), rule('roe', 8)]);
    assert.equal(mixed.status, 'pending'); assert.deepEqual(mixed.checks.map(check => check.status), ['pass', 'pending']);
    const failed = evaluateRules([rule('annualRoeLatest', 13), rule('roe', 8)]);
    assert.equal(failed.status, 'failed'); assert.deepEqual(failed.checks.map(check => check.status), ['failed', 'pending']);
  }
  const annualCheck = pool([rule('annualRoeLatest', 10)]);
  assert.equal(annualCheck.reportDate, '2025-12-31'); assert.equal(annualCheck.checks[0].reportDate, '2025-12-31');
});

test('新年度报告已披露而年度链未同步时仅阻断所依赖年度链，最新累计值不能冒充年度值', () => {
  const at = new Date('2026-04-20T10:00:00+08:00');
  const annual = year => ({ reportDate: `${year}-12-31`, noticeDate: `${year + 1}-03-28`, currency: 'CNY', roe: 12, adjustedProfit: 1e8, operatingCash: 2e8 });
  const snapshot = { finance: { symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: +at,
    data: { latest: { reportDate: '2026-03-31', noticeDate: '2026-04-15', currency: 'CNY', roe: 9 }, annual: [annual(2024), annual(2023), annual(2022)] } },
    notices: { symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +at,
      data: { items: [{ id: 'AN20260415000001', title: '2025年度报告', date: '2026-04-15' }], total: 1 } } };
  const rules = [{ field: 'annualRoeLatest', op: 'gte', value: 10 }, { field: 'roe', op: 'gte', value: 8 }];
  const saved = createEntryConditions({ rules }, at);
  const checked = evaluateEntryConditions(saved, symbol, null, snapshot, at);
  assert.equal(checked.status, 'pending'); assert.deepEqual(checked.checks.map(check => check.status), ['pending', 'pass']);
  const pool = financialConditionCheck({ symbol, ...normalizeFinance(snapshot.finance, symbol, at) }, { rules }, at, snapshot.notices);
  assert.equal(pool.status, 'pending'); assert.deepEqual(pool.checks.map(check => check.status), ['pending', 'pass']);
  assert.equal(pool.pendingReport.reportDate, '2025-12-31');
  snapshot.finance.data.annual = [annual(2025), annual(2024), annual(2023)];
  assert.equal(evaluateEntryConditions(saved, symbol, null, snapshot, at).status, 'pass');
});
