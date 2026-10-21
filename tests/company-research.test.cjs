'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateOperatingResearch } = require('../core/company-research.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const now = new Date('2026-10-15T10:00:00+08:00'), symbol = 'sh600001';
const query = (path = 'product', field = 'currentRevenue', value = 1) => ({ version: 1, enabled: true, path, rules: [{ field, op: 'gt', value, ...(field === 'currentSalesVolume' ? { unit: '台' } : {}) }] });
const company = { symbol, financeSource: '东方财富', financeCurrency: 'CNY', financeReportDate: '2026-06-30', financeNoticeDate: '2026-08-15',
  financeFetchedAt: now.getTime(), revenueYoY: 10, latestAdjustedProfit: 2, operatingCash: 3 };
function bundle() {
  const value = companyBundle(symbol, now);
  const text = '主要产品为汽车扬声器\n营业收入构成\n单位：万元\n本报告期 上年同期 同比增减\n金额 占营业收入比重 金额 占营业收入比重\n营业收入合计 200 100% 160 100% 25%\n分产品\n汽车扬声器 120 60% 80 50% 50%';
  Object.assign(value.documents[1], { text, fullText: text, pageTexts: [{ page: 1, text, method: 'provider-text', complete: true, numericEligible: true }] });
  return value;
}
const evaluate = (source, input = query()) => evaluateOperatingResearch(source, input, { symbol, company, now });

test('原始产品指标独立判断：所选收入通过，未选销量缺失不阻断', () => {
  const result = evaluate(bundle());
  assert.equal(result.status, 'pass');
  const metrics = result.productMetrics.products.find(p => p.subject === '汽车扬声器').metrics;
  assert.equal(metrics.currentRevenue.value, 1200000);
  assert.equal(metrics.currentSalesVolume.value, null);
  assert.equal(evaluate(bundle(), query('product', 'currentSalesVolume')).status, 'pending');
});

test('公司路径可独立判断，产品缺失仍明确保留；观察不生成新门槛', () => {
  const result = evaluate(null, query('company', 'revenueYoY', 0));
  assert.equal(result.status, 'pass'); assert.equal(result.productMetrics.products.length, 0);
  assert.equal(result.acquisition[0].code, 'not-requested');
  const observed = evaluate(null, { version: 1, enabled: false, path: 'product', rules: [] });
  assert.equal(observed.status, 'observing'); assert.equal(observed.assessment.blocksEntry, false);
});

test('重建指标不能刷新过期来源，保留原值展示但不准用于判断', () => {
  for (const change of [b => { b.checkedAt -= 21600001; }, b => { b.fetchedAt -= 21600001; }, b => { b.coverage.noticeIndexComplete = false; }]) {
    const b = bundle(); change(b); const result = evaluate(b);
    assert.equal(result.status, 'pending');
    const metric = result.productMetrics.products.find(p => p.subject === '汽车扬声器').metrics.currentRevenue;
    assert.equal(metric.value, 1200000); assert.equal(metric.usable, false);
  }
});

test('没有数值产品行也保留已披露重大不利事实，公司增长不能抵消', () => {
  const b = companyBundle(symbol, now);
  for (const doc of b.documents) doc.text = doc.fullText = doc.text.replace('汽车扬声器产品未发生重大不利变化。', '汽车扬声器产品发生重大质量事故。');
  const result = evaluate(b, query('company', 'revenueYoY', 0));
  assert.equal(result.productMetrics.products.length, 0);
  assert.equal(result.status, 'failed'); assert.ok(result.riskSignals.length > 0);
  assert.equal(result.assessment.blocksEntry, true);
  assert.equal(evaluate(b, { version: 1, enabled: false, path: 'company', rules: [] }).status, 'observing');
});

test('获取失败与解析失败分开提示，不能称作公司未披露', () => {
  const b = { symbol, documents: [], acquisition: { issues: [{ stage: 'parse', message: 'PDF文字解析失败' }, { stage: 'download', message: 'HTTP 503' }] } };
  const result = evaluate(b);
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.acquisition.map(item => item.code), ['parse-failed', 'fetch-failed']);
});
