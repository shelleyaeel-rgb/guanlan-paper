const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { buildProductMetrics, metricsFromObservations } = require('../core/company-product-metrics.cjs');
const { reportProductTables } = require('../core/company-evidence-structured.cjs');
const { evaluateResearchRules } = require('../core/research-rules.cjs');
const NOW = new Date('2026-10-15T10:00:00+08:00'), SYMBOL = 'sh600001';
const shareHeader = '营业收入构成\n单位：万元\n本报告期 上年同期 同比增减\n金额 占营业收入比重 金额 占营业收入比重';
const share = `${shareHeader}\n营业收入合计 200 100% 160 100% 25%\n分产品\n汽车扬声器 120 60% 80 50% 50%`;
const marginHeader = '单位：万元\n营业收入 营业成本 毛利率 营业收入比上年同期增减 营业成本比上年同期增减 毛利率比上年同期增减';
const margin = `${marginHeader}\n分产品\n汽车扬声器 120 90 25% 50% 40% 5%`;
const sales = '产品名称 单位 本期销量 上年同期销量 同比增减\n汽车扬声器 台 120 100 20%';
function document(text, extra = {}) {
  const parts = Array.isArray(text) ? text : [text];
  return { id: 'test-half', title: '隔离声学2026年半年度报告', kind: 'semiannual-report', issuerSymbol: SYMBOL,
    reportDate: '2026-06-30', publishedAt: '2026-08-15', url: 'https://example.com/report.pdf', complete: true,
    format: 'pdf-text', parserVersion: '4', pages: parts.length, hasOcrPages: false, numericEligible: true,
    text: parts.join('\n\n'), pageTexts: parts.map((value, index) => ({ page: index + 1, text: value, method: 'pdf-text', complete: true, numericEligible: true,
      characters: value.length, textHash: createHash('sha256').update(value).digest('hex') })), ...extra };
}
function build(text, extra = {}, options = {}) { return buildProductMetrics([document(text, extra)], { symbol: SYMBOL, now: NOW, subjects: ['汽车扬声器'], ...options }); }
function fields(result, subject = '汽车扬声器') { return result.products.find(product => product.subject === subject).metrics; }

test('raw same-product values and independently derived ratios carry units, period and page sources', () => {
  const result = build([share, margin, sales]), metrics = fields(result);
  assert.equal(result.status, 'available'); assert.equal(result.reportDate, '2026-06-30');
  assert.equal(Object.keys(metrics).length, 14);
  assert.equal(metrics.currentRevenue.value, 1200000); assert.equal(metrics.currentRevenue.unit, '元');
  assert.equal(metrics.currentRevenue.rawValue, '120'); assert.equal(metrics.currentRevenue.rawUnit, '万元');
  assert.equal(metrics.previousRevenue.value, 800000); assert.equal(metrics.currentCost.value, 900000);
  assert.equal(metrics.currentTotalRevenue.value, 2000000); assert.equal(metrics.previousTotalRevenue.value, 1600000);
  assert.equal(metrics.revenueGrowthPct.value, 50); assert.equal(metrics.revenueSharePct.value, 60);
  assert.equal(metrics.grossMarginPct.value, 25); assert.ok(Math.abs(metrics.salesGrowthPct.value - 20) < 1e-8);
  assert.equal(metrics.currentSalesVolume.unit, '台'); assert.equal(metrics.grossMarginPct.verification, 'calculated');
  assert.equal(metrics.currentRevenue.sourceRefs[0].sourceDocumentId, 'test-half');
  assert.equal(metrics.currentRevenue.sourceRefs[0].locations[0].page, 1);
  assert.equal(metrics.currentRevenue.sourceRefs[0].reportDate, '2026-06-30');
  assert.equal(metrics.previousCost.value, null); assert.equal(metrics.grossMarginChangePp.value, null);
});

test('reported growth disagreement does not erase source amounts or silently validate a conflicting ratio', () => {
  const bad = share.replace('80 50% 50%', '80 50% 40%'), metrics = fields(build(bad));
  assert.equal(reportProductTables(document(bad)).length, 0, 'legacy strict criteria are unchanged');
  assert.equal(metrics.currentRevenue.value, 1200000); assert.equal(metrics.currentRevenue.usable, true);
  assert.equal(metrics.revenueGrowthPct.value, 50); assert.equal(metrics.revenueGrowthPct.reportedValue, 40);
  assert.equal(metrics.revenueGrowthPct.status, 'conflict'); assert.equal(metrics.revenueGrowthPct.usable, false);
  assert.equal(metrics.revenueGrowthPct.reasonCode, 'reported-calculated-mismatch');
});

test('zero values remain zero and a nonpositive comparison base never yields growth', () => {
  const zero = fields(build(share.replace('120 60% 80 50% 50%', '0 0% 0 0% 0%')));
  assert.equal(zero.currentRevenue.value, 0); assert.equal(zero.previousRevenue.value, 0);
  assert.equal(zero.revenueGrowthPct.usable, false); assert.equal(zero.revenueGrowthPct.verification, 'disclosed-only');
  assert.equal(zero.revenueGrowthPct.reasonCode, 'nonpositive-base');
  const negative = fields(build(share.replace('120 60% 80 50% 50%', '120 60% -80 50% 50%')));
  assert.equal(negative.previousRevenue.value, -800000); assert.equal(negative.revenueGrowthPct.usable, false);
});

test('missing cells remain missing while other original columns and reported ratios survive', () => {
  const metrics = fields(build(share.replace('120 60% 80 50% 50%', '120 60% - 50% 50%')));
  assert.equal(metrics.currentRevenue.value, 1200000); assert.equal(metrics.previousRevenue.value, null);
  assert.equal(metrics.previousRevenue.reasonCode, 'reported-placeholder');
  assert.equal(metrics.revenueGrowthPct.value, 50); assert.equal(metrics.revenueGrowthPct.reportedValue, 50);
  assert.equal(metrics.revenueGrowthPct.verification, 'disclosed-only'); assert.equal(metrics.revenueGrowthPct.usable, false);
});

test('independent original volumes can calculate growth even if a reported change lacks percent units', () => {
  const text = sales.replace('20%', '20'), metrics = fields(build(text));
  assert.equal(reportProductTables(document(text)).length, 0);
  assert.ok(Math.abs(metrics.salesGrowthPct.value - 20) < 1e-8); assert.equal(metrics.salesGrowthPct.usable, true);
  assert.equal(metrics.salesGrowthPct.reportedValue, null);
});

test('inventory tables preserve source sales and reported growth without inventing prior sales', () => {
  const text = '主要产品 单位 生产量 销售量 库存量 生产量比上年增减 销售量比上年增减 库存量比上年增减\n汽车扬声器 台 130 120 10 30% 20% 0%';
  const metrics = fields(build(text));
  assert.equal(metrics.currentSalesVolume.value, 120); assert.equal(metrics.previousSalesVolume.value, null);
  assert.equal(metrics.salesGrowthPct.value, 20); assert.equal(metrics.salesGrowthPct.verification, 'disclosed-only');
  assert.equal(metrics.salesGrowthPct.usable, false);
});

test('malformed or percentage amount cells cannot become numeric raw facts', () => {
  for (const amount of ['120%', '(120%)']) {
    const metrics = fields(build(share.replace('120 60%', `${amount} 60%`)));
    assert.equal(metrics.currentRevenue.value, null); assert.equal(metrics.currentRevenue.usable, false);
  }
  const malformed = build(share.replace('120 60%', '355,63 6 60%'));
  assert.equal(fields(malformed).currentRevenue.value, null);
  assert.equal(malformed.products[0].observations[0].issues[0].reasonCode, 'column-count-mismatch');
});

test('same-period conflicting values or sales units remain visible and unusable', () => {
  const metrics = fields(build([share, share.replace('120 60% 80 50% 50%', '125 62.5% 80 50% 56.25%')]));
  assert.equal(metrics.currentRevenue.status, 'conflict'); assert.equal(metrics.currentRevenue.usable, false);
  assert.equal(metrics.revenueGrowthPct.status, 'conflict');
  const units = fields(build([sales, sales.replace(' 台 ', ' 万台 ')]));
  assert.equal(units.currentSalesVolume.status, 'conflict'); assert.equal(units.salesGrowthPct.usable, false);
});

test('monetary normalization preserves matching raw source scales without converting volume units', () => {
  const other = share.replace('单位：万元', '单位：元').replace('200 100% 160', '2000000 100% 1600000').replace('120 60% 80', '1200000 60% 800000');
  const metrics = fields(build([share, other]));
  assert.equal(metrics.currentRevenue.value, 1200000); assert.equal(metrics.currentRevenue.usable, true);
  assert.equal(metrics.currentRevenue.sourceRefs.length, 2);
});

test('products do not borrow another product cost, sales or denominator', () => {
  const metrics = fields(build([share, margin.replace('汽车扬声器', '耳机'), sales.replace('汽车扬声器', '耳机')]));
  assert.equal(metrics.currentRevenue.value, 1200000); assert.equal(metrics.currentCost.value, null);
  assert.equal(metrics.grossMarginPct.usable, false); assert.equal(metrics.currentSalesVolume.value, null);
});

test('source identity, publication time, completeness and native reliability are prerequisites', () => {
  for (const extra of [{ issuerSymbol: 'sh600002' }, { publishedAt: '2026-11-01' }, { complete: false }, { url: '' },
    { publishedAt: '2026-10-15T12:00:00+08:00' }, { publishedAt: '2026-09-31' },
    { pageTexts: [{ page: 1, text: share, complete: true, numericEligible: false, method: 'ocr' }] }]) {
    const result = build(share, extra); assert.equal(fields(result).currentRevenue.usable, false); assert.ok(result.diagnostics.length);
  }
});

test('saved PDF metrics require the current parser and intact complete page records', () => {
  const original = document(share), mutations = [
    value => { value.parserVersion = '3'; },
    value => { delete value.parserVersion; },
    value => { delete value.pageTexts; },
    value => { value.pages = 2; },
    value => { value.pageTexts[0].page = 2; },
    value => { value.pageTexts[0].complete = false; },
    value => { value.pageTexts[0].nativeReauditFromVersion = '3'; },
    value => { value.pageTexts[0].characters++; },
    value => { value.pageTexts[0].textHash = '0'.repeat(64); },
    value => { value.pageTexts[0].text = share.replace('120', '121'); },
    value => { value.fullText = `${share}\n未包含的正文`; },
    value => { value.textHash = '0'.repeat(64); },
    value => { value.pageTexts[0].method = 'ocr'; value.pageTexts[0].confidence = 99; },
    value => { value.pageTexts[0].method = 'page-audit'; },
    value => { value.pageTexts[0].classification = { contentRole: 'non-content' }; },
    value => { value.hasOcrPages = true; },
    value => { value.numericEligible = false; }
  ];
  for (const mutate of mutations) {
    const value = structuredClone(original); mutate(value);
    const result = buildProductMetrics([value], { symbol: SYMBOL, now: NOW, subjects: ['汽车扬声器'] });
    assert.equal(fields(result).currentRevenue.usable, false, mutate.toString());
    assert.ok(result.diagnostics.length, mutate.toString());
  }
  const inferredPdf = structuredClone(original); delete inferredPdf.format; delete inferredPdf.parserVersion;
  assert.equal(fields(buildProductMetrics([inferredPdf], { symbol: SYMBOL, now: NOW, subjects: ['汽车扬声器'] })).currentRevenue.usable, false);
  assert.equal(fields(build(share)).currentRevenue.usable, true);
});

test('publication calendar uses Shanghai date while exact timestamps cannot be future', () => {
  const now = new Date('2026-10-15T00:30:00+08:00');
  assert.equal(fields(build(share, { publishedAt: '2026-10-15' }, { now })).currentRevenue.usable, true);
  assert.equal(fields(build(share, { publishedAt: '2026-10-15T00:20:00+08:00' }, { now })).currentRevenue.usable, true);
  assert.equal(fields(build(share, { publishedAt: '2026-10-15T00:40:00+08:00' }, { now })).currentRevenue.usable, false);
});

test('explicit foreign currency is not silently relabelled as renminbi', () => {
  const metrics = fields(build(share.replace('单位：万元', '单位：万元 币种：美元')));
  assert.equal(metrics.currentRevenue.usable, false); assert.equal(metrics.currentRevenue.reasonCode, 'currency-not-cny');
  assert.equal(metrics.currentTotalRevenue.usable, false);
});

test('latest report missing a value never borrows the earlier annual-report value', () => {
  const old = document(share, { id: 'test-annual', kind: 'annual-report', reportDate: '2025-12-31', publishedAt: '2026-04-01' });
  const result = buildProductMetrics([old, document('主要产品为汽车扬声器。')], { symbol: SYMBOL, now: NOW, subjects: ['汽车扬声器'] });
  assert.equal(result.reportDate, '2026-06-30'); assert.equal(fields(result).currentRevenue.value, null);
});

test('current and prior revenue/cost originals calculate margin changes in percentage points', () => {
  const observation = { document: document(''), subject: '汽车扬声器', table: 'isolated-four-originals', unit: '万元',
    columns: ['currentRevenue', 'currentCost', 'previousRevenue', 'previousCost'], cells: '120 84 100 80',
    locations: [{ page: 1, lineStart: 1, lineEnd: 2, method: 'pdf-text', numericEligible: true }], text: '隔离原值测试',
    period: { currentEnd: '2026-06-30', previousEnd: '2025-06-30' } };
  const metrics = metricsFromObservations([observation])[0].metrics;
  assert.equal(metrics.grossMarginPct.value, 30); assert.equal(metrics.previousGrossMarginPct.value, 20);
  assert.ok(Math.abs(metrics.grossMarginChangePp.value - 10) < 1e-8);
  assert.equal(metrics.grossMarginChangePp.unit, '百分点'); assert.equal(metrics.grossMarginChangePp.usable, true);
});

const comparableCosts = ['七、合并财务报表项目注释', `单位：万元 币种：人民币
项目 本期发生额 上期发生额
收入 成本 收入 成本
合计 120 84 100 80
2 )主营业务(分产品)
产品名称 本期发生额 上期发生额
收入 成本 收入 成本
汽车扬声器 120 84 100 80
合计 120 84 100 80`];
function reportedMarginChange(cell, unit = '', heading = '') {
  return `${heading}${marginHeader}${unit}\n分产品\n汽车扬声器 120 84 30% 20% 5% ${cell}`;
}
function marginRule(productMetrics) {
  return evaluateResearchRules({ version: 1, enabled: true, path: 'product', rules: [{ field: 'grossMarginChangePp', op: 'gt', value: 0 }] },
    { symbol: SYMBOL, productMetrics }, NOW);
}

test('原始毛利率增减表只披露百分比时不把它当作百分点，也不忽略后放行', () => {
  // Exercise both source-table parsers, then the real rule evaluation boundary.
  for (const heading of ['', '三、主营业务分析\n']) for (const disclosure of ['-5%', '10%']) {
    const result = build([reportedMarginChange(disclosure, '', heading), ...comparableCosts]);
    const metric = fields(result).grossMarginChangePp;
    assert.ok(Math.abs(metric.value - 10) < 1e-8);
    assert.equal(metric.unit, '百分点');
    assert.equal(metric.reportedValue, Number(disclosure.replace('%', '')));
    assert.equal(metric.reportedUnit, '%');
    assert.equal(metric.rawUnit, '%');
    assert.equal(metric.status, 'pending'); assert.equal(metric.usable, false);
    assert.equal(metric.reasonCode, 'reported-change-unit-unverified');
    assert.equal(marginRule(result).status, 'pending'); assert.equal(marginRule(result).blocksEntry, true);
    assert.equal(fields(result).grossMarginPct.usable, true, 'an ambiguous change does not erase current margin');
    assert.ok(metric.sourceRefs.some(source => source.quote.includes(disclosure)));
  }
});

test('明确百分点的原始表格须与同产品两期成本复算一致才能通过规则', () => {
  for (const heading of ['', '三、主营业务分析\n']) for (const disclosure of ['10', '-5']) {
    const result = build([reportedMarginChange(disclosure, '（百分点）', heading), ...comparableCosts]);
    const metric = fields(result).grossMarginChangePp, matching = disclosure === '10';
    assert.ok(Math.abs(metric.value - 10) < 1e-8);
    assert.equal(metric.reportedValue, Number(disclosure)); assert.equal(metric.reportedUnit, '百分点');
    assert.equal(metric.rawUnit, '百分点'); assert.equal(metric.usable, matching);
    assert.equal(metric.status, matching ? 'available' : 'conflict');
    assert.equal(metric.reasonCode, matching ? null : 'reported-calculated-mismatch');
    assert.equal(marginRule(result).status, matching ? 'pass' : 'pending');
    assert.equal(marginRule(result).blocksEntry, !matching);
  }
});

test('毛利率增减单位缺失、与单元格冲突或不同原文披露值冲突时保留待核验', () => {
  for (const table of [reportedMarginChange('-5'), reportedMarginChange('-5%', '（百分点）')]) {
    const result = build([table, ...comparableCosts]), metric = fields(result).grossMarginChangePp;
    assert.equal(metric.usable, false); assert.equal(metric.status, 'pending');
    assert.equal(metric.rawValue, '-5' + (table.includes('-5%') ? '%' : ''));
    assert.equal(metric.reportedValue, null, 'do not reinterpret an unverified source value');
    assert.equal(marginRule(result).blocksEntry, true);
  }
  const conflict = build([reportedMarginChange('10', '（百分点）'), reportedMarginChange('-5', '（百分点）'), ...comparableCosts]);
  assert.equal(fields(conflict).grossMarginChangePp.status, 'conflict');
  assert.equal(marginRule(conflict).status, 'pending');
});

test('native Feike two-period product costs calculate margins and exclude later parent-only notes', () => {
  const table = `单位:元 币种:人民币
项目 本期发生额 上期发生额
收入 成本 收入 成本
主营业务 2,010,959,167.70 803,211,581.30 2,109,002,439.83 897,525,365.78
其他业务 8,282,968.68 3,054,148.93 6,613,171.30 1,284,312.80
合计 2,019,242,136.38 806,265,730.23 2,115,615,611.13 898,809,678.58
1 )营业收入明细
项目 本期金额 上期金额
客户合同产生的收入 2,018,789,432.15 2,114,880,023.54
租赁收入 452,704.23 735,587.59
合计 2,019,242,136.38 2,115,615,611.13
2 )主营业务(分产品)
产品名称 本期发生额 上期发生额
收入 成本 收入 成本
电动剃须刀 1,413,843,417.72 478,275,707.88 1,418,344,732.09 518,396,436.18
合计 2,010,959,167.70 803,211,581.30 2,109,002,439.83 897,525,365.78`;
  const d = document(['七、合并财务报表项目注释', table, '十九、母公司财务报表主要项目注释', table.replace('1,413,843,417.72', '891,114,136.18')]);
  const snapshot = buildProductMetrics([d], { symbol: SYMBOL, now: NOW });
  const metrics = fields(snapshot, '电动剃须刀');
  assert.equal(metrics.currentRevenue.value, 1413843417.72); assert.equal(metrics.previousCost.value, 518396436.18);
  assert.equal(metrics.currentTotalRevenue.value, 2019242136.38, 'company total, not the narrower main-business subtotal');
  assert.equal(metrics.previousGrossMarginPct.usable, true); assert.equal(metrics.grossMarginChangePp.usable, true);
  assert.ok(metrics.currentRevenue.sourceRefs.every(source => source.locations[0].page === 2));
  assert.equal(reportProductTables(d).filter(fact => fact.table === 'product-revenue-cost-two-periods').length, 0);
  for (const text of [table.replace('2 )主营业务(分产品)', '其他统计表\n2 )主营业务(分产品)'),
    table.replace('单位:元 币种:人民币', '单位:元 单位:万元 币种:人民币')]) {
    const invalid = buildProductMetrics([document(['七、合并财务报表项目注释', text])], { symbol: SYMBOL, now: NOW, subjects: ['电动剃须刀'] });
    assert.equal(fields(invalid, '电动剃须刀').currentRevenue.usable, false);
  }
  const swapped = buildProductMetrics([document(['七、合并财务报表项目注释', table.replaceAll('收入 成本 收入 成本', '收入 收入 成本 成本')])],
    { symbol: SYMBOL, now: NOW, subjects: ['电动剃须刀'] });
  assert.equal(fields(swapped, '电动剃须刀').currentRevenue.usable, false);
});

test('all original scope protections also apply to the raw metrics path', () => {
  for (const heading of ['2025年度营业收入构成', '产品销量情况（2025年上半年）', '第一节竞争对手经营情况\n一、产销统计', '供应商情况']) {
    const result = build(`${heading}\n${share}`); assert.equal(fields(result).currentRevenue.usable, false, heading);
  }
});
