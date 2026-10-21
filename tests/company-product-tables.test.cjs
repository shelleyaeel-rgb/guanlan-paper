const test = require('node:test');
const assert = require('node:assert/strict');
const { reportProductTables, splitProductNames, productName } = require('../core/company-evidence-structured.cjs');
const { paragraphEntries } = require('../core/company-evidence-text.cjs');
const { evaluateCompanyEvidence } = require('../core/company-evidence.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const { revenueTable, oilTable } = require('./fixtures/company-report-table-excerpts.cjs');
const doc = (text, options = {}) => ({ reportDate: '2026-06-30', ...options,
  pageTexts: (Array.isArray(text) ? text : [text]).map((part, index) => ({ text: part, page: index + 1,
    complete: true, numericEligible: true, method: 'pdf-text', ...options.page })) });
const read = (text, options) => reportProductTables(doc(text, options));
const shareHeader = `营业收入构成
单位：元
本报告期 上年同期 同比增减
金额 占营业收入比重 金额 占营业收入比重`;
const shares = `${shareHeader}
营业收入合计 200 100% 160 100% 25%
分行业
化工制造业 200 100% 160 100% 25%
分产品
聚乙烯 120 60% 80 50% 50%
聚丙烯 80 40% 80 50% 0%
分地区
国内 200 100% 160 100% 25%`;
const marginHeader = `单位：元
营业收入 营业成本 毛利率 营业收入比上
年同期增减
营业成本比上
年同期增减
毛利率比上年
同期增减`;
const grouped = `产品分类 项目 单位 2025年 2024年 同比增减
聚乙烯 销售量 吨 120 100 20%
生产量 吨 130 100 30%
库存量 吨 20 10 100%`;
const annual = { reportDate: '2025-12-31' };

test('five-column revenue compares both periods and shares with exact page/line provenance', () => {
  const facts = read(shares);
  assert.deepEqual(facts.map(fact => fact.subject), ['聚乙烯', '聚丙烯']);
  const fact = facts[0];
  assert.deepEqual([fact.revenue, fact.previousRevenue, fact.revenueGrowthPct, fact.revenueShare], [120, 80, 50, 60]);
  assert.equal(fact.growth, undefined);
  assert.deepEqual([fact.locations[0].page, fact.locations[0].lineStart, fact.locations[0].lineEnd, fact.rowStart], [1, 2, 9, 9]);
  assert.equal(fact.period.previousEnd, '2025-06-30');
});

test('revenue arithmetic, column shifts, malformed amounts and invalid totals do not verify', () => {
  for (const row of ['聚乙烯 120 60% 80 50% 40%', '聚乙烯 120 10% 80 50% 50%',
    '聚乙烯 60% 120 50% 80 50%', '聚乙烯 120 60% 8 0 50% 50%', '聚乙烯 355,63 6 60% 80 50% 50%']) {
    assert.ok(!read(shares.replace('聚乙烯 120 60% 80 50% 50%', row)).some(fact => fact.subject === '聚乙烯'), row);
  }
  assert.equal(read(shares.replace('200 100% 160 100% 25%', '200 100% 160 100% 10%')).length, 0);
  assert.equal(read(shares.replace('金额 占营业收入比重 金额 占营业收入比重', '占营业收入比重 金额 金额 占营业收入比重')).length, 0);
});

test('same-page tables cannot borrow an earlier header or unit', () => {
  const first = `${shareHeader}\n分产品\n聚乙烯 120 60% 80 50% 50%`;
  const later = '\n二、其他统计表\n分产品\n碳酸锂 150 75% 100 50% 50%';
  const facts = read(first + later);
  assert.deepEqual(facts.map(fact => fact.subject), ['聚乙烯']);
  assert.equal(read(`${shareHeader}\n二、其他统计表\n分产品\n碳酸锂 150 75% 100 50% 50%`).length, 0);
  assert.equal(read(shares.replace('单位：元', '单位：元 单位：万元')).length, 0);
  assert.equal(read(shares.replace('分产品', '单位：万元\n分产品')).length, 0);
  const second = '\n营业收入构成\n单位：万元\n本报告期 上年同期 同比增减\n金额 占营业收入比重 金额 占营业收入比重\n分产品\n碳酸锂 150 75% 100 50% 50%';
  assert.deepEqual(read(first + second).map(fact => [fact.subject, fact.unit]), [['聚乙烯', '元'], ['碳酸锂', '万元']]);
});

test('margin headers cannot borrow a stale unit or accept conflicting declarations', () => {
  const text = `三、主营业务分析\n${marginHeader}\n分产品\n聚乙烯 100 75 25% 20% 15% 3%`;
  assert.equal(read(text).length, 1);
  assert.equal(read(text.replace('单位：元', '单位：元 单位：万元')).length, 0);
  assert.equal(read(text.replace('分产品', '二、其他统计表\n分产品')).length, 0);
  assert.equal(read(text.replace('营业收入 营业成本', '营业成本 营业收入')).length, 0);
});

test('native Satellite and Tianshan wrapped product categories preserve their disclosed identity', () => {
  const satellite = `${marginHeader}\n分行业\n化学品\n及新材\n料行业\n30,624,754,078.50 22,032,232,140.73 28.06% 30.83% 18.54% 7.46%\n其他业\n务 88,400,512.06 52,476,461.10 40.64% 70.08% 6.90% 35.08%\n分产品\n功能化\n学品 23,368,546,678.32 16,924,252,873.09 27.58% 35.07% 19.95% 9.13%\n高分子\n新材料 7,256,207,400.18 5,107,979,267.64 29.61% 18.81% 14.07% 2.93%`;
  assert.deepEqual(read(satellite).map(fact => fact.subject), ['功能化学品', '高分子新材料']);
  assert.ok(read(satellite).every(fact => fact.growth === undefined));
  const tianshan = `${shareHeader}\n分产品\n销售铝箔及铝箔\n坯料 1,741,616,504.20 9.95% 1,056,259,786.53 6.89% 64.89%`;
  assert.deepEqual(read(tianshan).map(fact => fact.subject), ['铝箔及铝箔坯料']);
  assert.equal(read(tianshan)[0].rowStart, 6);
  assert.ok(!read(tianshan).some(fact => ['铝箔', '铝箔坯料'].includes(fact.subject)));
  const wrappedIndustry = shares.replace('化工制造业 200', '有 色 金 属 冶 炼\n和压延加工 200')
    .replace('金额 占营业收入比重 金额 占营业收入比重', '( % ) 金额 占营业收入比重\n( % ) 金额 占营业收入比重\n( % )');
  assert.equal(read(wrappedIndustry).length, 2);
});

test('two independently complete product names are never fused by wrapping', () => {
  const text = `${shareHeader}\n分产品\n聚乙烯\n聚丙烯 80 40% 80 50% 0%`;
  assert.deepEqual(read(text).map(fact => fact.subject), ['聚丙烯']);
});

test('same-page missing headers preserve identity only; OCR never supplies table facts', () => {
  const row = '分产品\n聚乙烯 120 60% 80 50% 50%';
  const facts = read([shareHeader, row]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].table, 'product-identification');
  assert.equal(facts[0].revenue, undefined);
  assert.equal(facts[0].growth, undefined);
  assert.equal(read(shares, { page: { method: 'ocr', numericEligible: false } }).length, 0);
  assert.equal(read(shares, { reportDate: '2026-09-30' }).length, 0);
});

test('other-issuer, forecast and historical table contexts cannot produce issuer facts', () => {
  for (const heading of ['竞争对手产品情况', '母公司财务报表', '子公司主要财务', '预计产品收入', '2025年产品收入']) {
    assert.equal(read(`${heading}\n${shares}`).length, 0, heading);
  }
  // An unrelated completed statement earlier on the page is not the table's issuer.
  assert.equal(read(`收回参股公司借款。\n相关现金流量说明。\n其他说明。\n本公司收入分析。\n${shares}`).length, 2);
});

test('sales triplets verify current/prior sales while production growth remains separate', () => {
  const facts = read(grouped, annual);
  assert.equal(facts.length, 1);
  assert.deepEqual([facts[0].subject, facts[0].volume, facts[0].priorVolume, facts[0].growth], ['聚乙烯', 120, 100, 20]);
  assert.equal(read(grouped.replace('120 100 20%', '80 100 -20%'), annual)[0].growth, -20);
  for (const bad of [grouped.replace('120 100 20%', '120 100 30%'), grouped.replace('2025年 2024年', '2024年 2023年'),
    grouped.replace('生产量 吨', '生产量 万吨'), grouped.replaceAll(' 吨 ', ' 万元 '),
    grouped.replace('库存量 吨', '碳酸锂 库存量 吨'), `预计销售情况\n${grouped}`]) assert.equal(read(bad, annual).length, 0, bad);
});

test('industry labels require independently disclosed matching product identity', () => {
  const sales = grouped.replace('产品分类', '行业分类').replace('聚乙烯 销售量', '氯化钾制造业 销售量');
  assert.equal(read(sales, annual).length, 0);
  const products = '分产品\n氯化钾 120 60% 80 50% 50%';
  const facts = read([products, sales], annual);
  assert.equal(facts.find(fact => fact.growth === 20)?.subject, '氯化钾');
  const middleLabel = sales.replace('氯化钾制造业 销售量', '销售量').replace('生产量 吨', '氯化钾制造业 生产量 吨');
  assert.equal(read([products, middleLabel], annual).find(fact => fact.growth === 20)?.subject, '氯化钾');
  assert.ok(!read(['竞争对手产品情况\n' + products, sales], annual).some(fact => fact.growth !== undefined));
  assert.ok(!read(['分产品\n电解铝 120 60% 80 50% 50%', sales.replace('氯化钾制造业', '铝行业')], annual).some(fact => fact.growth !== undefined));
});

test('sales/orders require matched units and comparable current/prior arithmetic', () => {
  for (const [metric, unit] of [['销量', '吨'], ['订单量', '万件'], ['订单金额', '万元']]) {
    const text = `产品名称 单位 本期${metric} 上年同期${metric} 同比增减\n聚乙烯 ${unit} 120 100 20%`;
    assert.equal(read(text)[0]?.growth, 20);
    assert.equal(read(text.replace('120 100 20%', '120 100 25%')).length, 0);
    assert.equal(read(text.replace(`聚乙烯 ${unit}`, `聚乙烯 ${unit === '万元' ? '吨' : '万元'}`)).length, 0);
  }
});

test('production/sales/inventory without prior sales preserves reported figures without verified growth', () => {
  const text = '主要产品 单位 生产量 销售量 库存量 生产量比上年增减(%) 销售量比上年增减(%) 库存量比上年增减(%)\nEVA/LDPE 吨 230,146.99 227,566.65 8,765.90 42.58 47.00 32.69';
  const fact = read(text, annual)[0];
  assert.equal(fact.subject, 'EVA/LDPE');
  assert.equal(fact.volume, 227566.65);
  assert.equal(fact.reportedGrowthPct, 47);
  assert.equal(fact.growth, undefined);
  assert.equal(read(text.replaceAll('(%)', ''), annual)[0].reportedGrowthPct, undefined);
  assert.equal(read(text.replace(' 吨 ', ' 元 '), annual).length, 0);
});

test('connected product names survive list splitting and known native word wrapping', () => {
  assert.deepEqual(splitProductNames('氧化铝、变形铝及铝合金圆铸锭、变形铝及铝合金扁铸锭和铝及铝合金焊材、EVA/LDPE'),
    ['氧化铝', '变形铝及铝合金圆铸锭', '变形铝及铝合金扁铸锭', '铝及铝合金焊材', 'EVA/LDPE']);
  const text = '主要产品有氧\n化铝、变形铝及铝合\n金扁铸锭、铝及铝合金焊材。';
  const entries = paragraphEntries(doc(text).pageTexts[0]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].lineEnd, 3);
  assert.equal(paragraphEntries(doc(text, { page: { method: 'ocr', numericEligible: false } }).pageTexts[0]).length, 3);
  assert.equal(productName('钾产品'), '钾产品');
  assert.equal(productName('铝行业'), null);
  assert.equal(productName('石化分部'), null);
});

const directSales = '产品名称 单位 本期销量 上年同期销量 同比增减\n汽车扬声器 台 120 100 20%';
const directRevenue = `${shareHeader}\n分产品\n汽车扬声器 120 60% 80 50% 50%`;
function evaluateTable(text, key) {
  const now = new Date('2026-10-15T10:00:00+08:00'), bundle = companyBundle('sh600001', now);
  const document = bundle.documents.find(item => item.kind === 'semiannual-report');
  document.text = document.fullText = document.text.replace('汽车扬声器产品销量同比增长12.5%，已完成交付。', '')
    .replace('汽车扬声器产品实现营业收入3亿元。', '') + `\n${text}`;
  const result = evaluateCompanyEvidence(bundle, { conditions: [key] }, now);
  return result.checks.flatMap(check => check.productCandidates || []).find(candidate => candidate.subject === '汽车扬声器')
    ?.parts.find(part => part.key === key);
}

test('historical years and single-quarter headings cannot pass current cumulative demand evaluation', () => {
  assert.equal(evaluateTable(`2026年上半年产品销量数据\n${directSales}`, 'demand').status, 'pass');
  assert.equal(evaluateTable(`2026年1-6月产品销量数据\n${directSales}`, 'demand').status, 'pass');
  for (const heading of ['2025年上半年产品销量数据', '2026年第二季度产品销量数据', '2026年度产品销量数据',
    '2026年下半年产品销量数据', '2026年1-3月产品销量数据', '2026年4-6月产品销量数据',
    '公司2025年上半年产品销量数据', '上年度产品销售情况', '第二季度产品销量数据',
    '产品销量情况（2025年上半年）', '产品销量情况（上年度）']) {
    const value = `${heading}\n样本范围：境内市场\n统计说明：产销量\n口径说明：实物量\n${directSales}`;
    assert.equal(read(value).length, 0, heading);
    assert.equal(evaluateTable(value, 'demand').status, 'pending', heading);
  }
  assert.equal(evaluateTable(`2025年度营业收入构成\n${directRevenue}`, 'commercialization').status, 'pending');
  assert.equal(evaluateTable(`2026年第二季度营业收入构成\n${directRevenue}`, 'commercialization').status, 'pending');
  assert.equal(evaluateTable(`2026年半年度营业收入构成\n${directRevenue}`, 'commercialization').status, 'pass');
});

test('section scope crosses page boundaries without inheriting previous-page table columns', () => {
  for (const heading of ['2025年度产品销量数据', '2026年第二季度产品销量数据', '竞争对手产品销量情况', '供应商产品销量情况']) {
    assert.equal(read([heading, `隔离声学股份有限公司2026年半年度报告全文\n${directSales}`]).length, 0, heading);
    assert.equal(read([heading, `第二节 主营业务分析\n${directSales}`]).filter(fact => fact.growth === 20).length, 1, heading);
  }
  assert.ok(read([shareHeader, '分产品\n汽车扬声器 120 60% 80 50% 50%']).every(fact => fact.revenue === undefined));
  for (const heading of ['第一节 2025年度经营情况', '第一节 竞争对手经营情况', '第一节 经营情况（2025年度）', '2025年度经营情况']) {
    const content = `一、产销统计\n样本范围：境内市场\n统计说明：实物量\n${directSales}`;
    assert.equal(read([heading, content]).length, 0);
    assert.equal(evaluateTable(`${heading}\n${content}`, 'demand').status, 'pending');
    assert.equal(read(`${heading}\n第二节2026年上半年经营情况\n${content}`).length, 1);
  }
  const scoped = read(`第一节2026年上半年经营情况\n一、产销统计\n${directSales}`)[0];
  assert.deepEqual(scoped.tableScope.headings.map(item => item.location.lineStart), [1, 2]);
  assert.equal(scoped.tableScope.reportDate, '2026-06-30');
});

test('third-party headings and intervening table notes cannot pass issuer demand evaluation', () => {
  for (const heading of ['供应商产品销量情况', '主要客户产品销量情况', '竞争对手产品销量情况', '参股公司产品销量情况',
    '供应商情况', '竞争对手', '主要客户', '参股公司']) {
    const text = `${heading}\n样本范围：境内市场\n统计说明：产销量\n口径说明：实物量\n${directSales}`;
    assert.equal(read(text).length, 0, heading);
    assert.equal(evaluateTable(text, 'demand').status, 'pending', heading);
  }
  assert.equal(evaluateTable(`收回参股公司借款。\n相关现金流量说明。\n其他说明。\n本公司收入分析。\n${directSales}`, 'demand').status, 'pass');
});

test('percentage cells cannot masquerade as quantities or currency in any supported layout', () => {
  const sales = directSales.replace('120 100', '120% 100%');
  const revenue = directRevenue.replace('120 60% 80', '120% 60% 80%');
  assert.equal(read(sales).length, 0);
  assert.equal(evaluateTable(sales, 'demand').status, 'pending');
  assert.equal(read(revenue).length, 0);
  assert.equal(evaluateTable(revenue, 'commercialization').status, 'pending');
  assert.equal(evaluateTable(directSales, 'demand').status, 'pass');
  assert.equal(evaluateTable(directRevenue, 'commercialization').status, 'pass');
  assert.equal(read(grouped.replace('120 100', '120% 100%'), annual).length, 0);
  assert.equal(read(`${marginHeader}\n分产品\n汽车扬声器 100% 75% 25% 20% 15% 3%`).length, 0);
  assert.equal(read(revenueTable.replace('377,892,754.\n57', '377,892,754.57%')).length, 0);
  assert.equal(read(oilTable.replace('492.3 489.2', '492.3% 489.2%')).filter(fact => fact.subject === '天然气' && fact.growth !== undefined).length, 0);
  const inventory = '主要产品 单位 生产量 销售量 库存量 生产量比上年增减 销售量比上年增减 库存量比上年增减\n汽车扬声器 台 130 120% 10 30% 20% 0%';
  assert.equal(read(inventory, annual).length, 0);
});

test('legacy margin and oil layouts obey enclosing issuer and period scopes', () => {
  for (const heading of ['2025年度产品销售情况', '2026年第二季度产品销售情况', '供应商产品销售情况']) {
    const text = `${heading}\n统计范围：境内\n统计口径：数量\n其他说明：不含出口\n`;
    assert.equal(read(text + oilTable).length, 0, heading);
    assert.equal(read(text + revenueTable.replace('三、主营业务分析\n', '')).length, 0, heading);
  }
});

test('a bare increment column is not a percentage merely because both arithmetic interpretations fit', () => {
  const ambiguous = directSales.replace('20%', '20');
  assert.equal(read(ambiguous).length, 0);
  assert.equal(evaluateTable(ambiguous, 'demand').status, 'pending');
  assert.equal(read(ambiguous.replace('同比增减', '同比增减(%)'))[0].growth, 20);
  assert.equal(read(grouped.replace('120 100 20%', '120 100 20'), annual).length, 0);
  assert.equal(read(grouped.replace('120 100 20%', '120 100 20').replace('同比增减', '同比增减(%)'), annual)[0].growth, 20);
  assert.equal(read(directRevenue.replace('50% 50%', '50% 50')).length, 0);
  assert.equal(read(directRevenue.replace('50% 50%', '50% 50').replace('同比增减', '同比增减(%)'))[0].revenue, 120);
});

test('CNOOC native narrative across pages does not become a forecast or historical table heading', () => {
  // Verbatim native excerpts from AN202608261828491081, pages 3, 11 and 25.
  const caveat = '预期和预测存在不确定性 ,取决于一些可能导致实际业绩 、表现和财务状况与本公司的\n预期不同的因素。';
  const outlook = '下半年 ,我们将锚定年度生产经营目标 ,全力攻坚增储上产 ,深化攻关核心技术 ,稳步';
  const introduction = '管理层讨论与分析\n经营业绩\n营业收入\n本公司营业收入人民币 242,660 百万元 ,比上年同期的人民币 207,608 百万元增加 16.9% ,\n主要是油气销量上涨和国际油价上涨的综合影响 。油气销售收入 ,油气价格及销量同比\n资料如下表所示 :';
  const text = introduction + '\n' + oilTable.replace('管理层讨论与分析\n', '');
  const facts = read([caveat, outlook, text]);
  assert.equal(facts.length, 4);
  assert.deepEqual(facts.filter(fact => fact.growth > 0).map(fact => [fact.subject, fact.growth]), [['石油液体', 4.7], ['天然气', .6]]);
  assert.deepEqual(facts.filter(fact => fact.revenue).map(fact => [fact.subject, fact.revenue]), [['石油液体', 178913], ['天然气', 27173]]);
  assert.ok(facts.every(fact => !fact.tableScope.headings.some(item => /预期和预测|本公司营业收入人民币/.test(item.text))));
  const margin = '三、主营业务分析\n单位：元\n营业收入\n营业成本\n毛利率\n营业收入比上年同期增减\n营业成本比上年同期增减\n毛利率比上年同期增减\n分产品\n汽车扬声器 100 75 25% 20% 15% 3%';
  assert.equal(read(margin).length, 1);
  assert.equal(read(`${caveat}\n${directRevenue}`).length, 1);
  const cashflowExplanation = '主要系报告期内销售回款金额较上年同期增\n长,同时报告期内支付的货款较上年同期减少\n所致。';
  assert.equal(read(`${cashflowExplanation}\n${directRevenue}`).length, 1);
});
