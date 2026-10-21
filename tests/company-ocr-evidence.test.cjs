const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCompanyEvidence } = require('../core/company-evidence.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const NOW = new Date('2026-10-13T10:00:00+08:00');
const QUERY = { conditions: ['productOutlook', 'financialReview'], leadership: 'either', minSegmentRevenuePct: 30 };
function pages(document, inputs) {
  document.pageTexts = inputs.map(([text, method = 'pdf-text', confidence = null], i) => ({ page: i + 1, text, method, confidence, complete: true, numericEligible: method !== 'ocr' }));
  document.pages = inputs.length; document.text = inputs.map(input => input[0]).join('\n\n'); delete document.fullText;
  document.hasOcrPages = inputs.some(input => input[1] === 'ocr'); document.parserVersion = '1';
}
test('OCR cover completes acquisition without discarding native body facts and keeps source page provenance', () => {
  const bundle = companyBundle();
  for (const document of bundle.documents) pages(document, [['隔离声学股份有限公司\n年度报告封面', 'ocr', 96], [document.text]]);
  const result = evaluateCompanyEvidence(bundle, QUERY, NOW);
  assert.equal(result.status, 'pass'); assert.ok(result.records.length);
  assert.ok(result.records.every(record => record.locations.some(location => location.page === 2 && location.method === 'pdf-text')));
  assert.ok(result.records.every(record => record.sourceDocumentId && record.parserVersion === '1'));
});
test('even high confidence OCR digits, rankings and negative statements cannot make a stock pass', () => {
  const bundle = companyBundle();
  for (const document of bundle.documents) pages(document, [[document.text, 'ocr', 99]]);
  const result = evaluateCompanyEvidence(bundle, QUERY, NOW);
  assert.equal(result.status, 'pending');
  assert.ok(result.checks.some(check => check.key === 'ocrReview' && check.status === 'pending'));
  assert.ok(result.records.every(record => record.reviewState === 'pending'));
  assert.ok(result.records.some(record => record.locations[0].confidence === 99));
});
test('OCR possible adverse matter prevents a native positive report silently passing', () => {
  const bundle = companyBundle(), doc = bundle.documents[1];
  pages(doc, [[doc.text], ['公司本报告期存在债务逾期，相关偿付计划正在执行。', 'ocr', 97]]);
  const result = evaluateCompanyEvidence(bundle, QUERY, NOW);
  assert.equal(result.status, 'pending');
  assert.equal(result.checks.find(check => check.key === 'financialReview').status, 'pass');
  assert.equal(result.checks.find(check => check.key === 'ocrReview').status, 'pending');
});
test('unrecognized OCR adverse wording cannot be silently excluded to turn a native failure into pass', () => {
  for (const text of ['汽车扬声器产品发生重大质量事故。', '汽车扬声器业务已停止生产。', '新增正文采用当前规则未认识的表述。']) {
    const bundle = companyBundle(), doc = bundle.documents[1];
    pages(doc, [[doc.text], [text, 'ocr', 99]]);
    const result = evaluateCompanyEvidence(bundle, QUERY, NOW);
    assert.equal(result.status, 'pending');
    assert.equal(result.checks.find(check => check.key === 'ocrReview').status, 'pending');
  }
});
test('tampered full text and low confidence cannot bypass per-page evidence checks', () => {
  for (const mutate of [doc => { doc.text += '\n不属于页级内容'; }, doc => { doc.pageTexts[0].confidence = 30; }]) {
    const bundle = companyBundle(), doc = bundle.documents[1]; pages(doc, [[doc.text, 'ocr', 99]]); mutate(doc);
    const result = evaluateCompanyEvidence(bundle, QUERY, NOW);
    assert.equal(result.status, 'pending'); assert.equal(result.checks[0].key, 'sourceIntegrity'); assert.equal(result.records.length, 0);
  }
});

test('independently registered decorative pages retain their page slots and do not become factual evidence', () => {
  const audit = require('../core/company-document-page-audits.json')[0];
  const bundle = companyBundle(), doc = bundle.documents[1], body = doc.text;
  doc.pages = audit.pages; doc.sourceHash = audit.sourceSha256;
  doc.pageTexts = Array.from({length:audit.pages},(_,i)=>({page:i+1,text:i===1?body:'已解析原生正文',method:'pdf-text',complete:true,numericEligible:true}));
  for(const pageNumber of audit.pageNumbers) doc.pageTexts[pageNumber-1]={page:pageNumber,text:'独立登记的封面装饰',method:'page-audit',complete:true,numericEligible:false,contentRole:'non-content',classification:{kind:'decorative-cover',verified:true,basis:'exact-source-page-audit',sourceHash:audit.sourceSha256,pages:audit.pages,page:pageNumber,auditId:audit.id}};
  doc.text=doc.pageTexts.map(page=>page.text).join('\n\n');delete doc.fullText;
  const result=evaluateCompanyEvidence(bundle,QUERY,NOW);
  assert.equal(result.status,'pass');
  assert.ok(result.records.filter(record=>record.sourceDocumentId===doc.id).every(record=>record.locations.every(location=>location.page===2)));
  const copy=structuredClone(bundle);copy.documents[1].sourceHash='0'.repeat(64);
  const altered=evaluateCompanyEvidence(copy,QUERY,NOW);
  assert.equal(altered.status,'pending');assert.equal(altered.checks[0].key,'sourceIntegrity');
});

test('a claimed decorative classification cannot hide an arbitrary high-confidence OCR page', () => {
  const bundle=companyBundle(),doc=bundle.documents[1];pages(doc,[[doc.text],['公司本报告期存在债务逾期。','ocr',99]]);
  const page=doc.pageTexts[1];page.contentRole='non-content';page.classification={kind:'decorative-cover',verified:true,basis:'exact-source-page-audit',auditId:'invented',sourceHash:'a'.repeat(64),page:2,pages:2};doc.sourceHash='a'.repeat(64);
  const result=evaluateCompanyEvidence(bundle,QUERY,NOW);
  assert.equal(result.status,'pending');assert.ok(result.checks.some(check=>check.key==='ocrReview'));
});
