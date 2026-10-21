const test = require('node:test');
const { revenueTable, oilTable } = require('./fixtures/company-report-table-excerpts.cjs');
const assert = require('node:assert/strict');
const { correctionSections, debtCoverage, reportProductTables, industryClassification, productName } = require('../core/company-evidence-structured.cjs');
const native = (texts, method = 'pdf-text') => ({ reportDate: '2026-06-30', pageTexts: texts.map((text, index) => ({ page: index + 1, text, method, complete: true, numericEligible: method !== 'ocr' })) });

test('current correction parent is answered only by both immediate named methods', () => {
  const text = '十八、其他重要事项\n1、 前期会计差错更正\n(1) 追溯重述法\n□适用√不适用\n(2) 未来适用法\n□适用 √不适用';
  const [fact] = correctionSections(native([text]));
  assert.equal(fact.clear, true); assert.equal(fact.locations[0].lineStart, 2); assert.equal(fact.locations[0].lineEnd, 6);
  assert.equal(correctionSections(native([text.replace('□适用 √不适用', '√适用 □不适用')]))[0].clear, false);
  assert.equal(correctionSections(native([text.replace('(2) 未来适用法', '2、债务重组')])).length, 0);
  assert.equal(correctionSections(native([text], 'ocr')).length, 0);
  assert.equal(correctionSections(native([text.split('\n').slice(0, 4).join('\n'), text.split('\n').slice(4).join('\n')])).length, 0);
});
test('direct correction negative is located and a bare blank template is not negative evidence', () => {
  assert.equal(correctionSections(native(['1、前期会计差错更正\n□适用 √不适用']))[0].clear, true);
  assert.equal(correctionSections(native(['1、前期会计差错更正\n□适用 □不适用']))[0].clear, false);
  assert.equal(correctionSections(native(['1、前期会计差错更正\n2、其他事项\n□适用 √不适用'])).length, 0);
});
test('tax, regional and accounting fragments are not product identities', () => {
  for (const value of ['为期10年航运', '年海外地区实现主营', '本集团的主营', '按地理信息划分的对外主营', '主营', '海外', '原料', '相关服务']) assert.equal(productName(value), null, value);
  for (const value of ['铜', '铌', '铝', '铁矿石', '天然气', '光学树脂镜片', '汽车扬声器']) assert.equal(productName(value), value);
});
test('issuer industry code G5521 is eligible while finance J is inapplicable', () => {
  assert.equal(industryClassification('本公司所处行业属于水上货物运输（G552）中的远洋货物运输（G5521）。').applicable, true);
  assert.equal(industryClassification('公司所属行业：货币金融服务（J66）').applicable, false);
  assert.equal(industryClassification('参股公司所属行业：制造业（C39）'), null);
  assert.equal(industryClassification('子公司所属行业：制造业（C39）'), null);
  assert.equal(industryClassification('公司拟从事制造业（C39）'), null);
  assert.equal(industryClassification('本公司主要业务为勘探、开发、生产及销售原油和天然气').applicable, true);
  assert.equal(industryClassification('公司主营的贸易品种包括铌、铜、铝等有色金属产品').applicable, true);
  assert.equal(industryClassification('客户公司主要业务为勘探、开发、生产及销售原油和天然气'), null);
  assert.equal(industryClassification('公司计划主要业务为勘探、开发、生产及销售原油和天然气'), null);
});
const debtLines = ['短期借款', '长期借款', '应付债券', '应付票据', '租赁负债', '应付账款', '其他应付款', '其他有息债务'];
test('category debt review requires all applicable categories and both overdue/default facts', () => {
  const text = '本公司短期借款未发生逾期。\n本公司短期借款未发生违约。\n' + debtLines.slice(1).map(label => `本公司${label}期末余额为0.00元。`).join('\n');
  const review = debtCoverage(native([text])); assert.equal(review.complete, true); assert.equal(review.records.length, 9);
  assert.equal(debtCoverage(native([text.replace('本公司短期借款未发生违约。', '')])).complete, false);
  assert.equal(debtCoverage(native([text.replace('本公司其他有息债务期末余额为0.00元。', '')])).complete, false);
  assert.equal(debtCoverage(native([text.replace('本公司短期借款未发生逾期。', '客户公司短期借款未发生逾期。')])).complete, false);
  assert.equal(debtCoverage(native([text], 'ocr')).complete, false);
  assert.equal(debtCoverage(native([text + '\n本公司短期借款存在违约。'])).complete, false);
});
test('loan subset, guarantees and empty debt rows cannot clear an entire issuer debt review', () => {
  for (const text of ['已逾期未偿还的短期借款情况\n□适用 √不适用', '本集团没有已逾期未偿还的借款。', '应付债券\n单位：元\n项目 期末余额 期初余额', '公司无担保逾期。']) assert.equal(debtCoverage(native([text])).complete, false);
});
test('an explicit closed issuer debt inventory allows grouped review without inventing absent categories', () => {
  const text = '本公司全部债务仅包括短期借款、长期借款及应付债券。\n本公司短期借款、长期借款及应付债券均不存在逾期及违约。';
  assert.equal(debtCoverage(native([text])).complete, true);
  assert.equal(debtCoverage(native([text.replace('全部债务', '有息债务')])).complete, false);
  assert.equal(debtCoverage(native([text.replace('仅包括', '包括')])).complete, false);
  assert.equal(debtCoverage(native([text.replace('本公司全部债务', '参股公司全部债务')])).complete, false);
  assert.equal(debtCoverage(native([text + '\n本公司租赁负债期末余额为10万元。'])).complete, false);
  assert.equal(debtCoverage(native([text + '\n本公司全部债务仅包括借款及租赁负债。'])).complete, false);
});

test('real split-cents product row has verified revenue, gross margin and same-unit share provenance', () => {
  const facts = reportProductTables(native([revenueTable])); assert.equal(facts.length, 1);
  assert.equal(facts[0].subject, '镜片'); assert.equal(facts[0].revenue, 377892754.57);
  assert.ok(Math.abs(facts[0].revenueShare - 82.775) < .01); assert.ok(facts[0].totalLocation);
  assert.equal(facts[0].growth, undefined, 'revenue growth must not supply demand');
});
test('table column ambiguity, mismatching margin, units, periods and OCR remain unknown', () => {
  assert.equal(reportProductTables(native([revenueTable.replace('61.18%', '10.00%')])).length, 0);
  assert.equal(reportProductTables(native([revenueTable.replace('营业收入 营业成本 毛利率', '营业成本 营业收入 毛利率')])).length, 0);
  assert.equal(reportProductTables(native([revenueTable.replace('三、主营业务分析', '2025年产品收入')])).length, 0);
  assert.equal(reportProductTables(native([revenueTable], 'ocr')).length, 0);
  assert.equal(reportProductTables(native([revenueTable.replace('单位：元', '单位：万元')]))[0].revenueShare, null);
});

test('real product sales table keeps declining revenue distinct from increasing product sales volume', () => {
  const facts = reportProductTables(native([oilTable])); assert.equal(facts.length, 4);
  assert.equal(facts.find(fact => fact.subject === '天然气' && fact.revenue).revenue, 27173);
  assert.equal(facts.find(fact => fact.subject === '天然气' && fact.growth).growth, .6);
  assert.ok(facts.every(fact => fact.locations[0].lineStart > 0));
  assert.equal(reportProductTables(native([oilTable.replace('2026 年', '2025 年')])).length, 0);
  assert.equal(reportProductTables(native([oilTable.replace('492.3 489.2 3.1 0.6', '492.3 489.2 3.1 60.0')])).filter(fact => fact.subject === '天然气' && fact.growth).length, 0);
});
