const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { paragraphEntries } = require('../core/company-evidence-text.cjs');
const { evaluateCompanyEvidence } = require('../core/company-evidence.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const NOW = new Date('2026-10-14T09:15:00Z');
// Verbatim native lines 24–25, 2026 half-year report AN202608281828633456,
// page 7. This excerpt proves product identity only, never demand or rank.
const first = '公司自成立以来致力于高端数控金属切削机床的研发、生产和销售,主要产品包括数控龙门';
const second = '加工中心、数控卧式加工中心、数控立式加工中心、数控车床等。';
const excerpt = `${first}\n${second}`;
function page(text, number = 7, extra = {}) {
  return { text, page: number, method: 'pdf-text', complete: true, numericEligible: true,
    textHash: createHash('sha256').update(text).digest('hex'), ...extra };
}
function evaluate(texts, extra = {}) {
  const bundle = companyBundle('sh600001', NOW), document = bundle.documents[1];
  document.pageTexts = texts.map((text, i) => page(text, i + 1, extra));
  document.pages = texts.length; document.text = texts.join('\n\n'); delete document.fullText;
  document.sourceHash = 'a'.repeat(64); document.parserVersion = '4';
  return evaluateCompanyEvidence(bundle, { conditions: ['productOutlook'] }, NOW);
}
function subjects(result) { return result.checks.find(item => item.key === 'productOutlook')?.productCandidates.map(item => item.subject) || []; }

test('real Haitian page 7 restores four complete product names and exact line provenance', () => {
  const entries = paragraphEntries(page(`${'\n'.repeat(23)}${excerpt}`));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, excerpt.slice(0, -1));
  assert.deepEqual([entries[0].page, entries[0].lineStart, entries[0].lineEnd], [7, 24, 25]);
  const result = evaluate([excerpt]);
  assert.deepEqual(subjects(result), ['数控龙门加工中心', '数控卧式加工中心', '数控立式加工中心', '数控车床']);
  assert.equal(result.status, 'pending');
  assert.equal(result.records.length, 0);
  assert.ok(result.checks[0].productCandidates.every(candidate => candidate.parts.every(part => part.status === 'pending')));
});

test('known horizontal and vertical machine-tool words may wrap inside the same product list', () => {
  for (const type of ['龙门', '卧式', '立式']) {
    const result = evaluate([`主要产品包括数控${type}\n加工中心、数控车床等。`]);
    assert.deepEqual(subjects(result), [`数控${type}加工中心`, '数控车床']);
  }
});

for (const [name, text] of [
  ['generic unfinished product', '主要产品包括智能\n设备、数控车床等。'],
  ['a complete word followed by another claim', `${first}\n加工中心市场需求增长20%。`],
  ['an intervening empty line', `${first}\n\n${second}`],
  ['an intervening heading', `${first}\n二、经营模式\n${second}`],
  ['a new issuer statement', `${first}\n公司加工中心已量产。`],
  ['an explicit competing issuer', `${first}\n竞争对手加工中心已经量产。`],
  ['a full stop terminates the first claim', `${first}。\n${second}`],
  ['a non-list description', `公司主要业务为数控龙门\n${second}`],
]) test(`machine-tool recovery rejects ${name}`, () => {
  const entries = paragraphEntries(page(text));
  assert.ok(entries.every(entry => entry.lineStart === entry.lineEnd));
  assert.ok(!subjects(evaluate([text])).includes('数控龙门加工中心'));
});

test('product recovery cannot cross a PDF page boundary', () => {
  assert.ok(!subjects(evaluate([first, second])).includes('数控龙门加工中心'));
  assert.equal(paragraphEntries(page(first))[0].lineEnd, 1);
});

test('untrusted OCR lines never gain joined or automatic product facts', () => {
  const extra = { method: 'ocr', numericEligible: false, confidence: 99 };
  assert.equal(paragraphEntries(page(excerpt, 7, extra)).length, 2);
  assert.ok(paragraphEntries(page(excerpt, 7, extra)).every(entry => entry.trusted === false));
  const result = evaluate([excerpt], extra);
  assert.deepEqual(subjects(result), []);
  assert.equal(result.status, 'pending');
});

test('restoring an explicit competing-company product list never transfers ownership', () => {
  const result = evaluate([excerpt.replace('公司自成立以来', '竞争对手公司自成立以来')]);
  assert.deepEqual(subjects(result), []);
});
