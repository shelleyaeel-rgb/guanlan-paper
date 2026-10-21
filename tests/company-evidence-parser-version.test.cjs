const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { PARSER_VERSION } = require('../core/company-document-parser.cjs');
const { evaluateCompanyEvidence } = require('../core/company-evidence.cjs');
const { collectIndependentRankings } = require('../core/company-industry-evidence.cjs');
const { CompanyIndustrySource, discoveryTerms } = require('../core/company-industry-source.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const now = new Date('2026-10-14T02:00:00Z');
const hash = value => createHash('sha256').update(value).digest('hex');
function bundle() {
  const value = companyBundle('sh600001', now);
  for (const document of value.documents) document.title = `隔离声学:${document.title}`;
  return value;
}
function pdf(document, changes = {}) {
  return { ...document, format: 'pdf-text', parserVersion: PARSER_VERSION, pages: 1,
    pageTexts: [{ page: 1, method: 'pdf-text', text: document.text, complete: true, numericEligible: true, textHash: hash(document.text) }], ...changes };
}
function issuerEvaluation(changes = {}) {
  const value = bundle(); value.documents = value.documents.map(document => pdf(document, changes));
  return evaluateCompanyEvidence(value, { conditions: ['commercialization'] }, now);
}
test('direct issuer PDF bundles reject legacy or missing parser versions before factual evaluation', () => {
  for (const format of ['pdf', 'pdf-text', 'pdf-ocr']) for (const parserVersion of ['2', '3', undefined]) {
    const result = issuerEvaluation({ format, parserVersion });
    assert.equal(result.status, 'pending');
    assert.equal(result.checks[0].key, 'sourceIntegrity');
    assert.match(result.checks[0].reason, /PDF 解析版本/);
    assert.equal(result.records.length, 0);
  }
});
test('an original PDF reference cannot bypass version gating by losing its display format', () => {
  const result = issuerEvaluation({ format: undefined, parserVersion: '3', originalFile: { format: 'pdf' } });
  assert.equal(result.checks[0].key, 'sourceIntegrity');
});
test('current-version native PDFs require their page records and preserve supported facts', () => {
  assert.equal(issuerEvaluation().status, 'pass');
  const result = issuerEvaluation({ pageTexts: undefined });
  assert.equal(result.status, 'pending'); assert.match(result.checks[0].reason, /逐页完整性/);
});
test('verified provider text and legacy format-free semantic fixtures remain compatible', () => {
  assert.equal(issuerEvaluation({ format: 'provider-text', parserVersion: 'provider-text-2' }).status, 'pass');
  assert.equal(evaluateCompanyEvidence(bundle(), { conditions: ['commercialization'] }, now).status, 'pass');
});

const claim = '2025年隔离声学在全国汽车扬声器市场份额排名第2，统计覆盖全部竞争者。';
function industry(changes = {}) {
  return { id: 'official-rank', issuerSymbol: 'sh600001', kind: 'industry-report', complete: true,
    title: '2025年汽车扬声器市场统计', url: 'https://img.frostchina.com/report.pdf',
    format: 'pdf', parserVersion: PARSER_VERSION, publishedAt: '2026-10-13', fetchedAt: +now,
    text: claim, textHash: hash(claim), sourceHash: 'a'.repeat(64), originalBase64: Buffer.from('%PDF-test').toString('base64'),
    pages: 1, pageTexts: [{ page: 1, method: 'pdf-text', text: claim, complete: true, numericEligible: true, textHash: hash(claim) }], ...changes };
}
test('direct industry ranking refuses old PDF claims even when every old page says complete', () => {
  for (const changes of [{ parserVersion: '3' }, { parserVersion: undefined }, { parserVersion: '3', format: undefined }]) {
    const value = bundle(); value.industryDocuments = [industry(changes)];
    assert.deepEqual(collectIndependentRankings(value, { now, minimumYear: 2024 }), []);
  }
  const value = bundle(); value.industryDocuments = [industry()];
  assert.equal(collectIndependentRankings(value, { now, minimumYear: 2024 }).length, 1);
});
test('ready industry PDF caches cannot outlive their parser version, including force refresh', async () => {
  for (const force of [false, true]) {
    let requests = 0;
    const source = new CompanyIndustrySource(async () => { requests++; return new Response(JSON.stringify({ errCode: 0, data: { data: [] } })); }, { clock: () => +now, parser: {} });
    const value = bundle();
    source.cache.set(value.symbol, { version: 1, symbol: value.symbol, fetchedAt: +now,
      fingerprint: hash(JSON.stringify(discoveryTerms(value))), industryCoverage: { status: 'ready' }, industryDocuments: [industry({ parserVersion: '3' })] });
    const result = await source.enrich(value, { force });
    assert.equal(requests, 1); assert.equal(result.industryDocuments.length, 0);
    await source.destroy();
  }
});
test('current PDF and publisher HTML caches remain reusable without requests or OCR', async () => {
  for (const document of [industry(), industry({ format: 'publisher-html', parserVersion: '3', originalBase64: undefined })]) {
    let requests = 0;
    const source = new CompanyIndustrySource(async () => { requests++; throw Error('unexpected request'); }, { clock: () => +now, parser: { parse: () => { throw Error('unexpected OCR'); } } });
    const value = bundle();
    source.cache.set(value.symbol, { version: 1, symbol: value.symbol, fetchedAt: +now,
      fingerprint: hash(JSON.stringify(discoveryTerms(value))), industryCoverage: { status: 'ready' }, industryDocuments: [document] });
    const result = await source.enrich(value, { force: true });
    assert.equal(requests, 0); assert.equal(result.industryDocuments.length, 1);
    await source.destroy();
  }
});
