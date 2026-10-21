'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RESEARCH_METADATA, validateResearchRules, describeResearchRules, evaluateResearchRules, buildCompanyMetrics, minimumCoveredReportDate } = require('../core/research-rules.cjs');
const NOW = new Date('2026-10-15T10:00:00+08:00'), SYMBOL = 'sh600001';
const productQuery = rules => ({ version: 1, enabled: true, path: 'product', rules });
const companyQuery = rules => ({ version: 1, enabled: true, path: 'company', rules });
const rule = (field, value, op = 'gte', unit) => ({ field, op, value, ...(unit ? { unit } : {}) });
function cell(value, unit = '%', extra = {}) {
  return { status: 'available', usable: true, verification: 'source-verified', value, unit, sourceRefs: [{ sourceDocumentId: 'test-half-year', title: '隔离半年报',
    reportDate: '2026-06-30', publishedAt: '2026-08-15', url: 'https://example.com/half-year', quote: '隔离产品数据原文', locations: [{ page: 1, lineStart: 3, lineEnd: 5 }] }], ...extra };
}
function productData(products = [{ subject: '产品甲', reportDate: '2026-06-30', metrics: { currentRevenue: cell(100, '元'), revenueGrowthPct: cell(10), currentSalesVolume: cell(5, '吨'), salesGrowthPct: cell(5) } }]) {
  return { symbol: SYMBOL, productMetrics: { version: '1', symbol: SYMBOL, status: 'ready', checkedAt: NOW.toISOString(), reportDate: '2026-06-30', products } };
}
function companyRow(extra = {}) {
  return { symbol: SYMBOL, financeReportDate: '2026-06-30', financeNoticeDate: '2026-08-15', financeUpdateDate: '2026-08-16', financeSource: '东方财富', financeCurrency: 'CNY',
    financeFetchedAt: NOW.getTime(), revenueYoY: 10, adjustedProfitYoY: 12, latestAdjustedProfit: 0.5, operatingCash: -0.2, ...extra };
}
function companyData(extra) { return { symbol: SYMBOL, companyMetrics: buildCompanyMetrics(companyRow(extra), { symbol: SYMBOL, now: NOW }) }; }

test('metadata defines exactly seven product and four company fields without default thresholds', () => {
  assert.deepEqual(Object.keys(RESEARCH_METADATA.fields.product), ['currentRevenue', 'revenueSharePct', 'revenueGrowthPct', 'currentSalesVolume', 'salesGrowthPct', 'grossMarginPct', 'grossMarginChangePp']);
  assert.equal(Object.keys(RESEARCH_METADATA.fields.company).length, 4);
  assert.ok(RESEARCH_METADATA.volumeUnits.includes('十亿立方英尺'));
  assert.equal(validateResearchRules(null), undefined);
  assert.equal(Object.values(RESEARCH_METADATA.fields.product).some(value => Object.hasOwn(value, 'default')), false);
});
test('validation preserves explicit mode, supports negative values and rejects malformed or cross-path rules', () => {
  assert.deepEqual(validateResearchRules(companyQuery([rule('operatingCash', -0.5, 'gt')])), companyQuery([rule('operatingCash', -0.5, 'gt')]));
  for (const value of [undefined, null, NaN, Infinity, '1', false]) assert.throws(() => validateResearchRules(productQuery([rule('currentRevenue', value)])));
  for (const query of [productQuery([]), { ...productQuery([rule('currentRevenue', 1)]), version: 2 }, { ...companyQuery([rule('revenueYoY', 0)]), fallback: true },
    companyQuery([rule('currentRevenue', 1)]), productQuery([rule('revenueYoY', 1)]), productQuery([{ ...rule('currentRevenue', 1), valueField: 'currentCost' }]),
    productQuery([rule('currentSalesVolume', 1)]), productQuery([rule('currentSalesVolume', 1, 'gte', 'unknown')]), productQuery([rule('currentRevenue', 1, 'gte', '亿元')]),
    productQuery([rule('grossMarginPct', 101)]), productQuery([rule('revenueSharePct', -1)])]) assert.throws(() => validateResearchRules(query));
});
test('contradictory bounds and mixed absolute-volume units are rejected, duplicates normalized', () => {
  assert.throws(() => validateResearchRules(productQuery([rule('currentRevenue', 10, 'gt'), rule('currentRevenue', 10, 'lte')])));
  assert.throws(() => validateResearchRules(productQuery([rule('currentSalesVolume', 10, 'gte', '吨'), rule('currentSalesVolume', 20, 'lte', '万吨')])));
  assert.equal(validateResearchRules(productQuery([rule('currentRevenue', 10), rule('currentRevenue', 10)])).rules.length, 1);
});
test('unconfigured and disabled research remains observing without granting a rule pass', () => {
  for (const query of [undefined, { version: 1, enabled: false, path: 'product', rules: [] }, { ...productQuery([rule('currentRevenue', 1)]), enabled: false }]) {
    const result = evaluateResearchRules(query, {}, NOW);
    assert.equal(result.status, 'observing'); assert.equal(result.passed, null); assert.equal(result.blocksEntry, false); assert.deepEqual(result.checks, []);
  }
  assert.match(describeResearchRules({ version: 1, enabled: false, path: 'company', rules: [] }).join(''), /仅观察/);
});
test('all requested rules must pass within one product; another complete product may qualify', () => {
  const query = productQuery([rule('currentRevenue', 100), rule('salesGrowthPct', 3)]), split = productData([
    { subject: '产品甲', reportDate: '2026-06-30', metrics: { currentRevenue: cell(100, '元') } },
    { subject: '产品乙', reportDate: '2026-06-30', metrics: { salesGrowthPct: cell(5) } }
  ]);
  assert.equal(evaluateResearchRules(query, split, NOW).status, 'pending');
  split.productMetrics.products.push(productData().productMetrics.products[0]);
  // Duplicate identities are ambiguity, not a permission to choose a nicer row.
  assert.equal(evaluateResearchRules(query, split, NOW).status, 'pending');
  split.productMetrics.products[2].subject = '产品丙';
  const result = evaluateResearchRules(query, split, NOW);
  assert.equal(result.status, 'pass'); assert.equal(result.selectedProduct, '产品丙');
});
test('an unmet numeric rule is failed; missing, conflicted, and reported-only values remain pending', () => {
  assert.equal(evaluateResearchRules(productQuery([rule('currentRevenue', 101)]), productData(), NOW).status, 'failed');
  for (const extra of [{ value: null }, { status: 'conflict' }, { usable: false, reason: '同比无法复算', reasonCode: 'missing-base' }, { verification: 'disclosed-only' }]) {
    const data = productData(); Object.assign(data.productMetrics.products[0].metrics.currentRevenue, extra);
    assert.equal(evaluateResearchRules(productQuery([rule('currentRevenue', 1)]), data, NOW).status, 'pending');
  }
});
test('actual zero and negative values are not coerced to missing and exact unit mismatch cannot pass', () => {
  const data = productData(); data.productMetrics.products[0].metrics.currentRevenue.value = 0;
  data.productMetrics.products[0].metrics.grossMarginChangePp = cell(-1.5, '百分点');
  assert.equal(evaluateResearchRules(productQuery([rule('currentRevenue', 0, 'eq'), rule('grossMarginChangePp', -2)]), data, NOW).status, 'pass');
  const mismatch = evaluateResearchRules(productQuery([rule('currentSalesVolume', 1, 'gte', '万吨')]), data, NOW);
  assert.equal(mismatch.status, 'pending'); assert.equal(mismatch.checks[0].reasonCode, 'incomparable-unit');
  assert.equal(evaluateResearchRules(productQuery([rule('currentSalesVolume', 5, 'eq', '吨')]), data, NOW).status, 'pass');
});
test('product data cannot silently fall back to qualifying company metrics', () => {
  const data = companyData(); const result = evaluateResearchRules(productQuery([rule('currentRevenue', 1)]), data, NOW);
  assert.equal(result.status, 'pending'); assert.match(result.reasons.join(''), /资料缺失|替代/);
  assert.equal(result.path, 'product'); assert.equal(result.blocksEntry, true);
});
test('selected company path evaluates company facts and never claims product approval', () => {
  const result = evaluateResearchRules(companyQuery([rule('revenueYoY', 0), rule('latestAdjustedProfit', 0, 'gt'), rule('operatingCash', 0, 'lt')]), companyData(), NOW);
  assert.equal(result.status, 'pass'); assert.equal(result.selectedProduct, null); assert.deepEqual(result.productCandidates, []);
  assert.equal(result.label, '公司经营条件'); assert.match(result.limitation, /不能表述为产品前景已通过/);
  assert.equal(result.checks[1].actual, 0.5); assert.equal(result.checks[1].unit, '亿元');
});
test('company snapshot keeps source-reported growth separate from a recalculated product growth', () => {
  const data = companyData();
  assert.equal(data.companyMetrics.metrics.adjustedProfitYoY.verification, 'provider-reported');
  assert.match(data.companyMetrics.metrics.adjustedProfitYoY.definition, /不宣称已重新核算/);
  assert.equal(evaluateResearchRules(companyQuery([rule('adjustedProfitYoY', 12, 'eq')]), data, NOW).status, 'pass');
});
test('missing currency blocks company money only, missing optional fields do not block chosen growth', () => {
  const data = companyData({ financeCurrency: 'USD', latestAdjustedProfit: undefined });
  assert.equal(evaluateResearchRules(companyQuery([rule('operatingCash', 0, 'lt')]), data, NOW).status, 'pending');
  assert.equal(evaluateResearchRules(companyQuery([rule('revenueYoY', 0)]), data, NOW).status, 'pass');
  assert.equal(buildCompanyMetrics(null, { symbol: SYMBOL, now: NOW }).status, 'pending');
});
test('future, stale, wrong-issuer and invalid company snapshots cannot pass', () => {
  for (const extra of [{ symbol: 'sh600002' }, { financeFetchedAt: NOW.getTime() + 1 }, { financeFetchedAt: NOW.getTime() - 21600001 },
    { financeNoticeDate: '2026-10-16' }, { financeUpdateDate: '2026-10-16' }, { financeUpdateDate: '2026-05-01' }, { financeSource: '来源未标注' }]) {
    const data = companyData(extra);
    assert.equal(evaluateResearchRules(companyQuery([rule('revenueYoY', 0)]), data, NOW).status, 'pending');
  }
});

test('fresh acquisition does not make an obsolete company report usable', () => {
  const data = companyData({ financeReportDate: '2020-12-31', financeNoticeDate: '2021-04-20', financeUpdateDate: '2021-04-20' });
  assert.equal(data.companyMetrics.reportDate, '2020-12-31');
  const result = evaluateResearchRules(companyQuery([rule('revenueYoY', 0)]), data, NOW);
  assert.equal(result.status, 'pending'); assert.match(result.reasons.join(''), /最低适用报告期 2026-06-30/);
});

test('minimum coverage is an annual or semiannual floor rather than a claim of latest-quarter completeness', () => {
  for (const [date, expected] of [['2026-04-30', '2024-12-31'], ['2026-05-01', '2025-12-31'], ['2026-08-31', '2025-12-31'], ['2026-09-01', '2026-06-30']]) {
    assert.equal(minimumCoveredReportDate(date), expected);
  }
  const data = companyData({ financeReportDate: '2026-09-30', financeNoticeDate: '2026-10-10', financeUpdateDate: '2026-10-10' });
  assert.equal(evaluateResearchRules(companyQuery([rule('revenueYoY', 0)]), data, NOW).status, 'pass');
});
test('future publication, unsafe provenance, stale snapshot and old product period stay pending', () => {
  for (const mutate of [
    data => { data.productMetrics.symbol = 'sh600002'; },
    data => { data.productMetrics.checkedAt = new Date(NOW.getTime() + 1).toISOString(); },
    data => { data.productMetrics.checkedAt = new Date(NOW.getTime() - 21600001).toISOString(); },
    data => { data.productMetrics.products[0].reportDate = '2025-12-31'; },
    data => { delete data.productMetrics.reportDate; },
    data => { data.productMetrics.products[0].metrics.currentRevenue.sourceRefs[0].publishedAt = '2026-10-16'; },
    data => { data.productMetrics.products[0].metrics.currentRevenue.sourceRefs[0].url = 'http://localhost/private'; },
    data => { data.productMetrics.products[0].metrics.currentRevenue.sourceRefs = []; },
  ]) { const data = productData(); mutate(data); assert.equal(evaluateResearchRules(productQuery([rule('currentRevenue', 1)]), data, NOW).status, 'pending'); }
});
test('evaluation and normalization do not mutate input objects', () => {
  const data = productData(), query = productQuery([rule('currentRevenue', 100)]), before = structuredClone({ data, query });
  const result = evaluateResearchRules(query, data, NOW); result.checks[0].sourceRefs[0].quote = 'changed output';
  assert.deepEqual({ data, query }, before);
  assert.match(describeResearchRules(query).join(''), /同一产品.*100 元/);
});
