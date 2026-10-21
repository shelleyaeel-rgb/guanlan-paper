'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const cases = require('./fixtures/notice-event-cases.json');
const { checkNoticeWithEvidence } = require('../core/company-notice-review.cjs');
const now = new Date('2026-10-16T02:00:00Z');
function evaluate(item, transform) {
  const document = structuredClone(item.document);
  document.fetchedAt = +now;
  if (transform) {
    document.text = transform(document.text);
    document.pages = 1;
    document.pageTexts = [{ page: 1, text: document.text, method: 'provider-text', complete: true, numericEligible: true }];
  }
  const notice = { id: document.id, title: document.title, date: document.publishedAt };
  const response = { symbol: item.symbol, source: '东方财富', section: 'notices', status: 'ready', fetchedAt: +now, data: { items: [notice], total: 1 } };
  return checkNoticeWithEvidence(response, item.symbol, { symbol: item.symbol, fetchedAt: +now, documents: [document] }, now).notices[0];
}
const find = symbol => cases.find(item => item.symbol === symbol);
test('真实制度与不减持承诺按文件性质核验，不再由列举风险或否定词制造待核验', () => {
  for (const symbol of ['sz000598', 'sh601236']) {
    const result = evaluate(find(symbol));
    assert.equal(result.status, 'clear', result.reason);
    assert.equal(result.fulltextStatus, 'verified');
    assert.equal(result.factReview.missingFields.length, 0);
  }
  assert.equal(evaluate(find('sh601236'), text => text + '公司已发生债务违约。').status, 'blocked');
});
test('真实六份临床公告保留受理、批准和结果的区别，不将常规研发不确定性误当失败', () => {
  for (const symbol of ['sh600276', 'sz000963', 'sz002317', 'sz002349', 'sz300199', 'sz300357']) {
    const result = evaluate(find(symbol));
    assert.equal(result.status, 'clear', result.reason);
    assert.equal(result.factReview.type, 'clinical');
    assert.ok(result.warnings.some(item => item.code === 'clinical-stage-observation'));
  }
  const accepted = evaluate(find('sz300199'));
  assert.equal(accepted.factReview.data.stage, 'application-accepted');
  assert.match(accepted.warnings[0].reason, /尚非获准开展试验/);
  const result = evaluate(find('sz002317'));
  assert.equal(result.factReview.checks.find(item => item.key === 'sampleSize').value, 641);
  assert.equal(result.factReview.checks.find(item => item.key === 'endpoint').value, 'achieved');
});
test('临床正面标题和局部正面数据不能覆盖实际失败、无法确认或原文缺项', () => {
  const item = find('sh600276');
  for (const text of ['产品名称：SHR-3201注射液。尚未同意本品开展临床试验。',
    '产品名称：SHR-3201注射液。临床试验申请尚未获得批准。', '尚无正文事实。']) {
    assert.notEqual(evaluate(item, () => text).status, 'clear', text);
  }
  for (const extra of ['本次临床试验已失败。', '公司不存在重大损失，但本次临床试验已失败。', '公司已发生债务违约。', '公司不存在重大损失且已发生债务违约。']) {
    assert.equal(evaluate(item, text => text + extra).status, 'blocked', extra);
  }
  assert.equal(evaluate(item, text => text + '公司不存在重大损失。').status, 'clear');
  assert.notEqual(evaluate(find('sz002317'), text => text.replaceAll('达到主要终点', '无法确认达到主要终点')).status, 'clear');
});
test('临床结果不能拼接另一产品或试验的数据，零样本和否定安全性不构成核实', () => {
  const item = structuredClone(find('sz002317')); item.document.title = '关于A123三期临床试验顶线结果的公告';
  for (const text of [
    '产品名称：A123注射液。A123正在开展III期临床试验。A123达到主要终点。A123共入组0例。A123尚不能确认安全性良好。',
    '产品名称：A123注射液。A123正在开展III期临床试验。本次试验结果尚未形成。另一产品B456已经达到主要终点，入组100例，安全性良好。',
    '产品名称：A123注射液。A123正在开展III期临床试验。B456已经达到主要终点，入组100例，安全性良好。',
  ]) assert.notEqual(evaluate(item, () => text).status, 'clear', text);
});
test('真实终止融资与未出资投资可核验，实际清算投资缺失损益仍待核验', () => {
  for (const item of cases.filter(item => ['sz300364', 'sz301269'].includes(item.symbol))) {
    const result = evaluate(item); assert.equal(result.status, 'clear', result.reason);
  }
  const liquidated = evaluate(find('sh603882'));
  assert.equal(liquidated.status, 'unverified');
  assert.equal(liquidated.factReview.type, 'investment-termination');
  assert.ok(liquidated.factReview.missingFields.includes('funded'));
  assert.doesNotMatch(liquidated.reason, /公告修订/);
  assert.equal(evaluate(find('sz301269'), text => text + '公司已发生重大损失。').status, 'blocked');
  assert.notEqual(evaluate(find('sz301269'), text => text.replaceAll('尚未出资', '已经出资')).status, 'clear');
});
test('终止决议的否定不能当已完成，资产收购终止不能套用融资规则，承诺日期必须有效', () => {
  const financing = cases.find(item => item.symbol === 'sz300364' && /H股/.test(item.document.title));
  assert.notEqual(evaluate(financing, () => '董事会尚未审议通过终止H股发行的议案。公司生产经营正常。本次终止不会对公司经营造成影响。').status, 'clear');
  const acquisition = structuredClone(financing); acquisition.document.title = '关于终止发行股份购买资产的公告';
  const result = evaluate(acquisition, () => '董事会审议通过终止发行股份购买资产的议案。公司生产经营正常。本次终止不会对公司经营造成影响。');
  assert.equal(result.status, 'unverified'); assert.equal(result.factReview.type, 'asset-transaction-termination');
  for (const period of ['自2026年12月31日至2026年1月1日', '自2026年2月30日至2027年1月1日']) {
    assert.notEqual(evaluate(find('sh601236'), () => `控股股东承诺：${period}，不以任何方式减持所持有的公司股份。`).status, 'clear');
  }
});
test('引用重组法规或否定违法不等于实际违法，五篇交易说明保留具体影响待核验', () => {
  for (const item of cases.filter(item => item.symbol === 'sz002860')) {
    const result = evaluate(item);
    assert.equal(result.status, 'unverified', result.reason);
    assert.equal(result.diagnostic.code, 'notice-event-pending');
    assert.equal(result.factReview.type, 'asset-transaction');
  }
});
test('八篇实际股价异动风险不再混为资料不足，明确原文依据和阻断原因', () => {
  const selected = cases.filter(item => ['sh600812', 'sh603200', 'sh603968', 'sh605058', 'sh605577', 'sh688004', 'sh688137'].includes(item.symbol));
  assert.equal(selected.length, 8);
  for (const item of selected) {
    const result = evaluate(item);
    assert.equal(result.status, 'blocked', result.reason);
    assert.equal(result.diagnostic.code, 'notice-blocked');
    assert.equal(result.factReview.checks.find(item => item.key === 'tradingRisk').status, 'verified');
  }
});
test('真实五篇诉讼完整正文已读，未生效判决和仅执行裁定不补成执行完毕', () => {
  for (const symbol of ['sz000692', 'sz000892', 'sz002181', 'sz002799', 'sz300368']) {
    const result = evaluate(find(symbol));
    assert.equal(result.status, 'unverified', result.reason);
    assert.equal(result.fulltextStatus, 'verified');
    assert.equal(result.diagnostic.code, 'notice-event-pending');
    assert.equal(result.factReview.type, 'litigation');
    assert.ok(result.records.length);
  }
});
test('结案的否定补充不会反向制造风险，未履行义务和实际损失仍不能放行', () => {
  const base = '本次诉讼已结案，相关义务已全部履行完毕。本次诉讼对公司生产经营未造成重大不利影响。';
  for (const extra of ['本公司不存在其他诉讼或仲裁事项。', '本次诉讼未造成损失。', '本次诉讼不存在不确定性。']) {
    assert.equal(evaluate(find('sz000692'), () => base + extra).status, 'clear', extra);
  }
  assert.notEqual(evaluate(find('sz000692'), () => base + '公司义务未完成。').status, 'clear');
  assert.equal(evaluate(find('sz000692'), () => base + '本次诉讼已造成重大损失。').status, 'blocked');
});
