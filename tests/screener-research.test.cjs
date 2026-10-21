'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Screener, defaults, validate, describe, RESEARCH_METADATA } = require('../core/screener.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const { oilTable } = require('./fixtures/company-report-table-excerpts.cjs');
const NOW = new Date('2026-10-15T10:00:00+08:00');
const row = (symbol = 'sh600001', extra = {}) => ({ symbol, name: '隔离样本', board: 'sh', isST: false, price: 10, pe: 15, timestamp: NOW.getTime(), ...extra });
const research = (path, rules, enabled = true) => ({ version: 1, enabled, path, rules });
const query = (path, rules, extra = {}) => ({ ...defaults(), research: research(path, rules), ...extra });
const finance = (symbol, extra = {}) => ({ symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: NOW.getTime(), data: { latest: {
  reportDate: '2026-06-30', noticeDate: '2026-08-15', updateDate: '2026-08-15', currency: 'CNY', revenueYoY: 10, adjustedProfitYoY: 20, adjustedProfit: 2e8, operatingCash: -1e8, ...extra
} } });
function productBundle(symbol) {
  const bundle = companyBundle(symbol, NOW), document = bundle.documents.find(document => document.kind === 'semiannual-report');
  document.text = document.fullText = oilTable;
  return bundle;
}
function scanner({ rows = [row()], company = null, product = null, evidence = null, notices = null, history = null } = {}) {
  const service = new Screener(null, history, null, () => NOW, company, notices, null, null, evidence, product);
  service.snapshot = { rows, fetchedAt: NOW.getTime(), source: '隔离行情' };
  service.load = async () => service.snapshot;
  return service;
}

test('screener validation and descriptions preserve explicit research independently of legacy evidence', () => {
  const input = query('company', [{ field: 'revenueYoY', op: 'gt', value: 0 }], { evidence: { conditions: ['demand'] } });
  const saved = validate(input);
  assert.equal(saved.research.path, 'company'); assert.deepEqual(saved.evidence.conditions, ['demand']);
  assert.match(describe(saved).join(''), /公司经营/);
  assert.equal(Object.keys(RESEARCH_METADATA.fields.product).length, 7);
});
test('enabled company rules use existing finance units, preserve diagnostics, and do not collect product reports', async () => {
  const calls = [];
  const service = scanner({ rows: [row(), row('sh600002'), row('sh600003')], company: symbol => { calls.push(symbol); return finance(symbol,
    symbol === 'sh600002' ? { adjustedProfit: -1e8 } : symbol === 'sh600003' ? { adjustedProfit: null } : {}); }, product: () => { throw Error('must not collect'); } });
  const before = structuredClone(service.snapshot);
  const result = await service.run(query('company', [{ field: 'latestAdjustedProfit', op: 'gt', value: 0 }, { field: 'operatingCash', op: 'eq', value: -1 }]), []);
  assert.equal(calls.length, 3); assert.deepEqual(result.rows.map(row => row.symbol), ['sh600001']);
  assert.deepEqual(result.researchFailedRows.map(row => row.symbol), ['sh600002']);
  assert.deepEqual(result.researchPendingRows.map(row => row.symbol), ['sh600003']);
  assert.equal(result.rows[0].researchReview.assessment.path, 'company');
  assert.equal(result.rows[0].researchReview.companyMetrics.metrics.latestAdjustedProfit.value, 2);
  assert.equal(result.rows[0].financeCurrency, 'CNY'); assert.equal(result.partial, true);
  assert.deepEqual(service.snapshot, before);
});
test('missing company loader stays pending instead of inventing data or falling back to products', async () => {
  const service = scanner({ product: () => { throw Error('must not collect'); } });
  const result = await service.run(query('company', [{ field: 'revenueYoY', op: 'gt', value: 0 }]), []);
  assert.equal(result.status, 'unavailable'); assert.equal(result.matched, null); assert.equal(result.researchPendingRows.length, 1);
});
test('disabled research is only an observation preference and requests no extra sources', async () => {
  const service = scanner({ company: () => { throw Error('must not load'); }, product: () => { throw Error('must not collect'); } });
  const result = await service.run({ ...defaults(), research: research('product', [{ field: 'currentRevenue', op: 'gt', value: 1e12 }], false) }, []);
  assert.equal(result.matched, 1); assert.equal(result.researchScreen, undefined); assert.equal(result.rows[0].researchReview, undefined);
});
test('historical research rejects before accessing a current loader or historical quote', async () => {
  const service = scanner({ history: { get() { throw Error('must not read history'); } }, company: () => { throw Error('must not load'); } });
  service.load = () => { throw Error('must not load'); };
  await assert.rejects(service.run(query('company', [{ field: 'revenueYoY', op: 'gt', value: 0 }]), [], false, 'old'), /历史快照.*经营资料/);
});
test('product rule uses automatic full report collection only after ordinary quantitative rules', async () => {
  const calls = [], service = scanner({ rows: [row(), row('sh600002', { pe: 30 })], product: (symbol, options) => {
    calls.push([symbol, options.force, options.includeIndustry]); return productBundle(symbol);
  }, evidence: () => { throw Error('must not use manual evidence'); } });
  const before = structuredClone(service.snapshot);
  const result = await service.run(query('product', [{ field: 'currentRevenue', op: 'gt', value: 1 }], { rules: [{ field: 'pe', op: 'lt', value: 20 }] }), [], true);
  assert.deepEqual(calls, [['sh600001', true, false]]); assert.equal(result.matched, 1);
  assert.equal(result.rows[0].researchReview.status, 'pass'); assert.equal(result.rows[0].researchReview.assessment.path, 'product');
  assert.deepEqual(service.snapshot, before);
});
test('product source failure stays pending and cannot borrow otherwise good company numbers', async () => {
  const service = scanner({ company: symbol => finance(symbol), product: () => { throw Error('报告未取得'); } });
  const result = await service.run(query('product', [{ field: 'currentRevenue', op: 'gt', value: 1 }], { rules: [{ field: 'revenueYoY', op: 'gt', value: 0 }] }), []);
  assert.equal(result.status, 'unavailable'); assert.equal(result.researchPendingRows[0].revenueYoY, 10);
  assert.match(result.researchPendingRows[0].researchReview.loadError, /报告未取得/);
});
test('legacy evidence remains an additional gate when a company rule was explicitly chosen', async () => {
  const service = scanner({ company: symbol => finance(symbol), evidence: () => [] });
  const result = await service.run(query('company', [{ field: 'revenueYoY', op: 'gt', value: 0 }], { evidence: { conditions: ['demand'] } }), []);
  assert.equal(result.matched, null); assert.equal(result.evidencePendingRows.length, 1); assert.equal(result.researchScreen.evaluated, 0);
  assert.deepEqual(result.query.evidence.conditions, ['demand']); assert.equal(result.query.research.path, 'company');
});
test('product collection is immediately cancellable and never writes research into quote snapshots', async () => {
  const releases = [], calls = [], service = scanner({ rows: Array.from({ length: 6 }, (_, i) => row(`sh60000${i + 1}`)), product: (symbol, options) => {
    calls.push({ symbol, signal: options.signal }); return new Promise(resolve => releases.push(() => resolve(productBundle(symbol))));
  } });
  const before = structuredClone(service.snapshot), task = service.run(query('product', [{ field: 'currentRevenue', op: 'gt', value: 1 }]), []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3); assert.equal(service.progress.stage, 'research'); service.cancel();
  await assert.rejects(task, /取消/); assert.ok(calls.every(call => call.signal.aborted));
  releases.forEach(release => release()); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(service.snapshot, before); assert.equal(service.activeRun, null);
});

test('product batches reduce source documents before fetching more and recheck freshness at the final boundary', async () => {
  const parsed = new Set(), now = new Date(NOW), rows = Array.from({ length: 4 }, (_, i) => row(`sh60000${i + 1}`));
  const service = scanner({ rows, product: async symbol => {
    if (symbol === 'sh600004') {
      assert.ok(parsed.has('sh600001'), 'first report must be reduced before a fourth source is requested');
      now.setTime(+now + 21600001);
    }
    const bundle = productBundle(symbol), document = bundle.documents.find(item => item.kind === 'semiannual-report'), text = document.text;
    Object.defineProperty(document, 'text', { enumerable: true, get() { parsed.add(symbol); return text; } });
    return bundle;
  } });
  service.clock = () => now;
  const result = await service.run(query('product', [{ field: 'currentRevenue', op: 'gt', value: 1 }]), []);
  assert.equal(result.status, 'unavailable'); assert.equal(result.researchPendingRows.length, 4);
  const first = result.researchPendingRows.find(row => row.symbol === 'sh600001').researchReview;
  assert.match(first.assessment.reasons.join(''), /6\s*小时/); assert.equal(first.productSource.documents, undefined);
});

test('slow announcement review expires surviving research without restoring a risk-excluded company', async () => {
  const now = new Date(NOW), notices = [], financeCalls = [];
  const service = scanner({ rows: [row(), row('sh600002')], company: symbol => { financeCalls.push(symbol); return finance(symbol); }, notices: symbol => {
    notices.push(symbol);
    if (symbol === 'sh600001') now.setTime(+now + 21600001);
    return { symbol, section: 'notices', source: '东方财富', status: symbol === 'sh600002' ? 'ready' : 'empty', fetchedAt: +now,
      data: symbol === 'sh600002' ? { total: 1, items: [{ id: 'AN20261015000001', date: '2026-10-15', title: '关于被立案调查的公告' }] } : { total: 0, items: [] } };
  } });
  service.clock = () => now;
  const result = await service.run(query('company', [{ field: 'revenueYoY', op: 'gte', value: 10 }]), [], false, null, 'swing');
  assert.equal(result.rows.length, 0); assert.equal(result.matched, null); assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.researchPendingRows.map(row => row.symbol), ['sh600001']);
  assert.deepEqual(result.riskExcluded.map(row => row.symbol), ['sh600002']);
  assert.equal(result.researchScreen.evaluated, 2); assert.equal(result.researchScreen.passed, 1); assert.equal(result.researchScreen.pending, 1);
  assert.equal(result.researchScreen.failed, 0); assert.equal(result.researchScreen.checkedAt, now.toISOString());
  assert.match(result.researchPendingRows[0].researchReview.assessment.reasons.join(''), /6\s*小时/);
  assert.match(result.dataMessage, /发布前重新核验/); assert.equal(result.oldestQuote, null);
  assert.deepEqual(financeCalls, ['sh600001', 'sh600002']); assert.deepEqual(notices, ['sh600001', 'sh600002']);
});
