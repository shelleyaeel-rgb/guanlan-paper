const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { evaluateCompanyEvidence, COMPANY_EVIDENCE_RULE_VERSION } = require('../core/company-evidence.cjs');
const { PARSER_VERSION } = require('../core/company-document-parser.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');

const NOW = new Date('2026-10-15T10:00:00+08:00');
const product = '汽车扬声器';
const riskLine = `${product}产品未发生重大不利变化。`;
const rankingLine = '根据中国电子行业协会发布的《2025年度汽车扬声器市场研究报告》，2025年公司在全国汽车扬声器市场份额排名第1，统计覆盖全部竞争者。';
// Heading/answer structure transcribed from the native 2026 half-year Qingdao
// Beer disclosure cached under AN202608... in the read-only replay corpus.
// Issuer-specific quantitative assertions below are isolated test data.
const majorChange = '报告期内公司经营情况的重大变化,以及报告期内发生的对公司经营情况有重大影响和预计未来\n会有重大影响的事项\n□ 适用 √ 不适用';
const riskChapter = '(一) 可能面对的风险\n1、市场竞争风险\n公司面临市场竞争加剧和原材料价格波动风险，客户需求变化可能影响产品销售。公司采取持续跟踪客户需求、优化采购安排及质量管理等应对措施，相关措施不保证消除经营风险。\n(二) 其他披露事项\n□适用 √不适用';
const referenceChapter = '(一) 可能面对的风险\n√适用 □不适用\n报告期内公司可能面对的风险无变化,详见公司2025年年度报告。\n(二) 其他披露事项\n□适用 √不适用';

function change(bundle, from, to, kind = 'semiannual-report') {
  for (const document of bundle.documents) if (document.kind === kind) document.text = document.fullText = document.text.replace(from, to);
}
function evaluate(mutate = () => {}, conditions = ['productOutlook']) {
  const bundle = companyBundle('sh600001', NOW); mutate(bundle);
  return evaluateCompanyEvidence(bundle, { conditions }, NOW);
}
function part(result, key, subject = product) { return result.checks[0].productCandidates.find(item => item.subject === subject).parts.find(item => item.key === key); }
function addNotice(bundle, text, date = '2026-10-01', id = `notice-${date}`) {
  bundle.documents.push({ id, title: '产品事项说明公告', issuerSymbol: bundle.symbol, kind: 'notice', publishedAt: date, fetchedAt: NOW.getTime(),
    url: `https://example.com/${id}`, complete: true, text, fullText: text });
}
function scoped(bundle) { change(bundle, riskLine, `${majorChange}\n${riskChapter}`); }
function native(document, pages) {
  document.pageTexts = pages.map((text, index) => ({ text, page: index + 1, complete: true, method: 'pdf-text', numericEligible: true, textHash: createHash('sha256').update(text).digest('hex') }));
  document.pages = pages.length; document.text = pages.join('\n\n'); delete document.fullText;
  document.parserVersion = PARSER_VERSION; document.sourceHash = 'a'.repeat(64); document.format = 'pdf';
}

test('rule 6 preserves complete per-product checks and source evidence', () => {
  const result = evaluate();
  assert.equal(COMPANY_EVIDENCE_RULE_VERSION, '7'); assert.equal(result.status, 'pass');
  assert.equal(result.checks[0].productIdentification.status, 'identified');
  assert.ok(part(result, 'outlookRisk').records[0].locations.length);
  assert.equal(part(result, 'outlookRisk').basis, 'explicit-disclosure');
});

for (const statement of ['主要产品耳机未发生重大不利变化。', '核心产品耳机未发生重大不利变化。', '全部产品耳机未发生重大不利变化。', '汽车扬声器配件产品未发生重大不利变化。']) {
  test(`a different named product cannot clear the selected product: ${statement}`, () => {
    const result = evaluate(bundle => change(bundle, riskLine, statement));
    assert.equal(part(result, 'outlookRisk').status, 'pending');
    assert.equal(part(result, 'outlookRisk').records.length, 0);
  });
}
test('issuer-wide all-products disclosure and explicit same-product category remain attributable', () => {
  for (const statement of ['公司全部产品均未发生重大不利变化。', '公司主要产品汽车扬声器未发生重大不利变化。']) {
    assert.equal(part(evaluate(bundle => change(bundle, riskLine, statement)), 'outlookRisk').status, 'pass');
  }
});
test('another major product adverse event does not fail the selected product', () => {
  const result = evaluate(bundle => addNotice(bundle, '主要产品耳机产品发生重大质量事故。'));
  assert.equal(part(result, 'outlookRisk').status, 'pass');
});
test('risk keyword absence alone never establishes a scope review', () => {
  const result = evaluate(bundle => change(bundle, riskLine, '公司认真开展日常经营并保持正常生产。'));
  assert.equal(part(result, 'outlookRisk').status, 'pending');
});
test('explicit major-change answer plus substantive risk chapter establishes only a bounded disclosure review', () => {
  const result = evaluate(scoped), risk = part(result, 'outlookRisk');
  assert.equal(risk.status, 'pass'); assert.equal(risk.basis, 'disclosure-scope-review');
  assert.match(risk.limitedScope, /不代表不存在未披露风险/);
  assert.equal(risk.scope.reportDate, '2026-06-30'); assert.equal(risk.scope.toDate, '2026-10-15');
  assert.ok(risk.records.every(record => record.quote.length <= 600 && record.locations.length && record.sectionLocations.length));
});
test('real half-year unchanged-risk cross-reference requires the identified annual risk section', () => {
  const result = evaluate(bundle => {
    change(bundle, riskLine, `${majorChange}\n${referenceChapter}`);
    change(bundle, riskLine, riskChapter, 'annual-report');
  });
  assert.equal(part(result, 'outlookRisk').status, 'pass');
  assert.ok(part(result, 'outlookRisk').records.some(record => record.sourceDocumentId === 'AN20260401000001'));
  const missing = evaluate(bundle => change(bundle, riskLine, `${majorChange}\n${referenceChapter}`));
  assert.equal(part(missing, 'outlookRisk').status, 'pending');
});
test('adverse facts in an explicitly inherited annual risk disclosure remain blocking', () => {
  const result = evaluate(bundle => {
    change(bundle, riskLine, `${majorChange}\n${referenceChapter}`);
    change(bundle, riskLine, `${riskChapter}\n汽车扬声器产品发生重大质量事故。`, 'annual-report');
  });
  assert.equal(part(result, 'outlookRisk').status, 'fail');
});
for (const [name, replacement] of [
  ['applicable major changes', majorChange.replace('□ 适用 √ 不适用', '√ 适用 □ 不适用')],
  ['unmarked major changes', majorChange.replace('√ 不适用', '□ 不适用')],
  ['wrong company scope', majorChange.replace('公司经营情况', '参股公司经营情况')],
]) test(`${name} cannot become a completed product risk scope review`, () => {
  const result = evaluate(bundle => change(bundle, riskLine, `${replacement}\n${riskChapter}`));
  assert.equal(part(result, 'outlookRisk').status, 'pending');
});
test('a heading, empty risk section or bare reference cannot stand in for substantive risk material', () => {
  for (const chapter of ['(一)可能面对的风险\n□适用 √不适用', '(一)可能面对的风险\n详见其他公告。']) {
    assert.equal(part(evaluate(bundle => change(bundle, riskLine, `${majorChange}\n${chapter}`)), 'outlookRisk').status, 'pending');
  }
});
test('coverage gaps, an explicit adverse fact, and trusted OCR gaps continue blocking', () => {
  const incomplete = evaluate(bundle => { scoped(bundle); bundle.coverage.relatedNotices.complete = false; });
  assert.equal(part(incomplete, 'outlookRisk').status, 'pending');
  const adverse = evaluate(bundle => { scoped(bundle); addNotice(bundle, '汽车扬声器产品发生重大质量事故。'); });
  assert.equal(part(adverse, 'outlookRisk').status, 'fail');
  const ocr = evaluate(bundle => {
    scoped(bundle); native(bundle.documents[1], [bundle.documents[1].text, '尚待可靠核对的附加正文。']);
    Object.assign(bundle.documents[1].pageTexts[1], { method: 'ocr', confidence: 95, numericEligible: false });
  });
  assert.equal(ocr.status, 'pending');
  assert.equal(ocr.checks.find(check => check.key === 'ocrReview').status, 'pending');
});
test('a later explicit same-product disclosure can supply the missing positive evidence', () => {
  const result = evaluate(bundle => { change(bundle, riskLine, ''); addNotice(bundle, riskLine); });
  assert.equal(part(result, 'outlookRisk').status, 'pass');
});
for (const statement of ['公司发生重大产品质量事故。', '公司主要产品发生重大质量事故。', '公司产品需求严重下滑。']) {
  test(`unallocated issuer product adverse evidence blocks a scope review: ${statement}`, () => {
    const result = evaluate(bundle => { scoped(bundle); change(bundle, riskChapter, riskChapter.replace('(二)', `${statement}\n(二)`)); });
    const risk = part(result, 'outlookRisk');
    assert.equal(risk.status, 'pending'); assert.equal(risk.reasonCode, 'adverse-product-unidentified');
    assert.ok(risk.records.some(record => record.value === 'unassignedAdverse' && record.quote.includes(statement.replace('。', ''))));
  });
}
for (const statement of ['其他公司发生重大产品质量事故。', '竞争对手公司产品需求严重下滑。', '如果公司产品需求严重下滑，公司将采取措施。',
  '公司产品需求可能严重下滑。', '公司未发生重大产品质量事故。', '公司主要产品未发生重大质量事故。']) {
  test(`nonactual or other-issuer risk statement does not masquerade as an actual issuer event: ${statement}`, () => {
    const result = evaluate(bundle => { scoped(bundle); change(bundle, riskChapter, riskChapter.replace('(二)', `${statement}\n(二)`)); });
    assert.equal(part(result, 'outlookRisk').status, 'pass');
  });
}

const event = '汽车扬声器产品发生重大质量事故。';
const resolution = '公司针对2026年9月1日披露的汽车扬声器产品重大质量事故已完成整改，相关重大不利影响已消除。';
function withEvent(bundle, explanation) {
  change(bundle, riskLine, ''); addNotice(bundle, event, '2026-09-01'); addNotice(bundle, explanation, '2026-10-01');
}
test('dated matching remediation can resolve only its identified product event', () => {
  const result = evaluate(bundle => withEvent(bundle, resolution)), risk = part(result, 'outlookRisk');
  assert.equal(risk.status, 'pass'); assert.equal(risk.basis, 'resolved-event');
  assert.ok(risk.records.some(record => record.value === 'adverse'));
  assert.ok(risk.records.some(record => record.value === 'resolved' && record.resolvesRecordId));
});
for (const [name, explanation] of [
  ['generic later denial', riskLine], ['another product', resolution.replaceAll(product, '耳机')],
  ['another event date', resolution.replace('9月1日', '9月2日')], ['planned remediation', resolution.replace('已完成整改', '计划完成整改')],
  ['impact still present', resolution.replace('已消除', '尚未消除')], ['missing event reference', resolution.replace('2026年9月1日披露的', '')],
  ['product-name prefix collision', resolution.replaceAll(product, `${product}配件`)],
  ['intervening different product remediation', resolution.replace('重大质量事故已完成整改', '重大质量事故，耳机已完成整改')],
]) test(`${name} cannot erase a known product event`, () => {
  assert.equal(part(evaluate(bundle => withEvent(bundle, explanation)), 'outlookRisk').status, 'fail');
});
test('a later correction of the remediation statement leaves the original event unresolved', () => {
  const result = evaluate(bundle => { withEvent(bundle, resolution); addNotice(bundle, '汽车扬声器已完成整改及影响已消除的表述不准确，现撤回。', '2026-10-02'); });
  assert.equal(part(result, 'outlookRisk').status, 'fail');
});

const comparison = '根据中国声学研究院发布的《2026年汽车扬声器同规格检测报告》，2026年上半年同规格同口径，公司汽车扬声器产品单位成本为8元/台，同期行业同规格汽车扬声器产品平均单位成本为10元/台。';
function compare(bundle, statement = comparison) { change(bundle, rankingLine, '', 'annual-report'); change(bundle, rankingLine, statement); }
test('same-product current-period traceable unit-cost comparison provides a limited advantage path', () => {
  const result = evaluate(bundle => compare(bundle)), advantage = part(result, 'advantage');
  assert.equal(advantage.status, 'pass'); assert.match(advantage.reason, /单项优势/);
  const record = advantage.records.find(record => record.value === 'quantifiedAdvantage');
  assert.equal(record.ownValue, 8); assert.equal(record.benchmarkValue, 10); assert.equal(record.unit, '元/台');
  assert.equal(record.comparisonPeriod, '2026-06-30'); assert.equal(record.sourceRelation, 'issuer-cites-third-party');
});
for (const [name, statement] of [
  ['energy lower is better', comparison.replaceAll('单位成本', '单位能耗').replaceAll('元/台', '千瓦时/台')],
  ['efficiency higher is better', comparison.replaceAll('单位成本', '转换效率').replace('为8元/台', '为98%').replace('为10元/台', '为95%')],
  ['market share above same-market average', comparison.replaceAll('同规格同口径', '全国同口径').replace('同期行业同规格', '同期全国全市场').replaceAll('单位成本', '市场份额').replace('为8元/台', '为20%').replace('为10元/台', '为10%')],
]) test(`${name} can support its disclosed comparison metric`, () => {
  assert.equal(part(evaluate(bundle => compare(bundle, statement)), 'advantage').status, 'pass');
});
for (const [name, statement] of [
  ['cost is worse', comparison.replace('为8元/台', '为12元/台')], ['equal cost', comparison.replace('为8元/台', '为10元/台')],
  ['no source', comparison.slice(comparison.indexOf('2026年上半年'))], ['vague source', comparison.replace('中国声学研究院', '有关研究机构')],
  ['affiliated institution', comparison.replace('中国声学研究院', '本公司子公司声学研究院')],
  ['prior reporting period', comparison.replace('2026年上半年', '2025年上半年')], ['year-only half-year claim', comparison.replace('2026年上半年', '2026年')],
  ['different benchmark product', comparison.replace('行业同规格汽车扬声器', '行业同规格耳机')], ['different units', comparison.replace('为10元/台', '为10元/件')],
  ['no same-basis disclosure', comparison.replace('同规格同口径，', '')], ['forward target', comparison.replace('单位成本为8', '单位成本预计为8')],
  ['ordinary margin', comparison.replaceAll('单位成本', '毛利率').replaceAll('元/台', '%')],
  ['self promotion', '公司汽车扬声器产品处于行业领先地位，专利数量100项，毛利率50%。'],
]) test(`${name} cannot establish a quantified competitive advantage`, () => {
  assert.equal(part(evaluate(bundle => compare(bundle, statement)), 'advantage').status, 'pending');
});
test('mismatched market geography, impossible percentages, conflicting measurements and later corrections stay pending', () => {
  const market = comparison.replaceAll('同规格同口径', '全国同口径').replace('同期行业同规格', '同期全球全市场').replaceAll('单位成本', '市场份额').replaceAll('元/台', '%');
  assert.equal(part(evaluate(bundle => compare(bundle, market)), 'advantage').status, 'pending');
  const impossible = comparison.replaceAll('单位成本', '转换效率').replace('为8元/台', '为110%').replace('为10元/台', '为95%');
  assert.equal(part(evaluate(bundle => compare(bundle, impossible)), 'advantage').status, 'pending');
  const conflict = evaluate(bundle => compare(bundle, `${comparison}\n${comparison.replace('为8元/台', '为12元/台')}`));
  assert.equal(part(conflict, 'advantage').status, 'pending'); assert.match(part(conflict, 'advantage').reason, /冲突/);
  const corrected = evaluate(bundle => { compare(bundle); addNotice(bundle, '汽车扬声器单位成本比较表述不准确，现撤回。'); });
  assert.equal(part(corrected, 'advantage').status, 'pending');
});
test('explicit cited-report year inconsistent with the comparison period is a visible conflict', () => {
  const result = evaluate(bundle => compare(bundle, comparison.replace('《2026年', '《2024年')));
  const advantage = part(result, 'advantage');
  assert.equal(advantage.status, 'pending'); assert.match(advantage.reason, /冲突/);
  assert.ok(advantage.records.some(record => record.automaticConflict && /年度/.test(record.conflictReason)));
});
