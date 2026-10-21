const test = require('node:test');
const assert = require('node:assert/strict');
const { checkNoticeWithEvidence } = require('../core/company-notice-review.cjs');
const { isSensitiveNoticeTitle } = require('../core/entry-risk.cjs');
const now = new Date('2026-10-13T10:00:00+08:00'), symbol = 'sh600001';
const resolved = '本次诉讼已结案，相关义务已全部履行完毕。本次诉讼对公司生产经营未造成重大不利影响。';
function fixture(text = resolved, title = '关于诉讼结案的公告') {
  const item = { id: 'AN20261013000001', date: '2026-10-13', title };
  const response = { symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +now, data: { items: [item], total: 1 } };
  const doc = { id: item.id, issuerSymbol: symbol, kind: 'notice', publishedAt: item.date, title, complete: true, fetchedAt: +now,
    url: 'https://data.eastmoney.com/notices/detail/600001/AN20261013000001.html', source: '东方财富公告全文', text, pages: 1,
    pageTexts: [{ page: 1, text, method: 'provider-text', numericEligible: true, complete: true }] };
  return { response, bundle: { symbol, fetchedAt: +now, documents: [doc] }, doc };
}
const review = f => checkNoticeWithEvidence(f.response, symbol, f.bundle, now);

test('敏感公告已结案且义务完成和影响明确，原文核验可通过并保留页码摘录', () => {
  const result = review(fixture());
  assert.equal(result.status, 'clear'); assert.equal(result.mode, 'automatic-fulltext');
  assert.equal(result.notices[0].records[0].locations[0].page, 1);
  assert.equal(result.notices[0].records[0].sourceRelation, 'issuer-disclosure');
});
test('只有标题、泛称无影响、仍在进展、未来或他人事件不能放行', () => {
  for (const text of ['本次诉讼对公司生产经营未造成重大不利影响。',
    '本次诉讼已结案。', '预计本次诉讼已结案，相关义务已全部履行完毕。本次诉讼对公司生产经营未造成重大不利影响。',
    '客户公司本次诉讼已结案，相关义务已全部履行完毕。本次诉讼对公司生产经营未造成重大不利影响。',
    resolved + '本次诉讼仍存在执行争议。', resolved + '本次诉讼已造成重大损失。',
    resolved + '公司另有其他诉讼尚待解决。',
    resolved + '本次诉讼已对公司财务状况构成重大不利影响。',
    resolved + '公司因本次诉讼遭受重大损失。',
    resolved + '本次诉讼受到的不利影响无法量化。',
    resolved + '未受处罚，但公司因本次诉讼遭受重大损失。',
    '本次诉讼并非已结案，相关义务已全部履行完毕。本次诉讼对公司经营未造成重大不利影响。',
    '本次诉讼已结案，对方相关义务已全部履行完毕。本次诉讼对公司经营未造成重大不利影响。',
    '本次诉讼已结案，相关义务已全部履行完毕。本次诉讼对公司经营的影响不能认定为无重大不利影响。',
    '本次诉讼已结案，相关义务已全部履行完毕但是公司义务未完成。本次诉讼对公司经营无重大不利影响。']) assert.notEqual(review(fixture(text)).status, 'clear', text);
});
test('减持计划终止必须明确期间未减持和本次终止影响，其他敏感事件不套用', () => {
  const text = '本次减持计划已终止，计划期间未实施任何减持。本次减持计划终止对公司生产经营未造成重大不利影响。';
  assert.equal(review(fixture(text, '关于提前终止减持计划的公告')).status, 'clear');
  assert.equal(review(fixture(text.replace('未实施任何减持', '已实施减持'), '关于提前终止减持计划的公告')).status, 'unverified');
  assert.equal(review(fixture(resolved, '关于重大资产重组暨诉讼的公告')).status, 'unverified');
});
test('陈旧或不完整目录、标题明确不利，不被正文中的局部正面句覆盖', () => {
  for (const change of [f => { f.response.fetchedAt -= 300001; }, f => { f.response.data.total = 40; },
    f => { f.response.data.items[0].title = '关于公司被立案的公告'; f.doc.title = f.response.data.items[0].title; }]) {
    const f = fixture(); change(f); assert.notEqual(review(f).status, 'clear');
  }
});
test('原文逐页可靠性、身份、日期、重复ID、时点或全文不一致均不能放行', () => {
  for (const change of [f => { f.doc.issuerSymbol = 'sh600002'; }, f => { f.doc.publishedAt = '2026-10-12'; },
    f => { f.doc.title = '其他公告'; }, f => { f.doc.complete = false; }, f => { f.doc.pageTexts[0].method = 'ocr'; },
    f => { f.doc.pageTexts[0].numericEligible = false; }, f => { f.doc.pages = 2; },
    f => { f.doc.pageTexts[0].text += '额外内容'; }, f => { f.bundle.documents.push({ ...f.doc }); },
    f => { f.bundle.fetchedAt -= 21600001; }, f => { f.doc.fetchedAt++; }, f => { f.doc.url = 'javascript:alert(1)'; }]) {
    const f = fixture(); change(f); assert.equal(review(f).status, 'unverified');
  }
});
test('同一目录中新增未读取的敏感公告必须重新核验，不复用上一条的通过', () => {
  const f = fixture(); f.response.data.items.push({ id: 'AN20261013000002', date: '2026-10-13', title: '重大诉讼进展公告' }); f.response.data.total++;
  const result = review(f); assert.equal(result.status, 'unverified'); assert.equal(result.notices[0].status, 'clear');
  assert.match(result.notices[1].reason, /尚未取得/);
});
test('敏感标题采集范围统一包含旧相关关键词未覆盖的事件', () => {
  for (const title of ['解除限售公告', '减持计划公告', '临床试验进展公告', '重大资产重组公告', '终止上市公告']) assert.equal(isSensitiveNoticeTitle(title), true);
});
test('全文未取得时保留本公告具体获取失败，不能错误引用另一公告的异常', () => {
  const f = fixture(); f.bundle.documents = [];
  f.bundle.errors = ['另一公告的未结构化获取错误'];
  f.bundle.acquisition = { issues: [{ documentId: 'AN20261013000002', code: 'download', message: '不属于本公告的错误' },
    { documentId: f.doc.id, code: 'attachment-http', stage: 'fetch', message: '公告附件请求失败：HTTP 502' }] };
  const result = review(f);
  assert.equal(result.status, 'unverified'); assert.match(result.notices[0].reason, /尚未取得.*HTTP 502/);
  assert.doesNotMatch(result.notices[0].reason, /不属于本公告/); assert.equal(result.notices[0].acquisition.code, 'attachment-http');
});
