const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCompanyEvidence, COMPANY_EVIDENCE_RULE_VERSION } = require('../core/company-evidence.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');

const NOW = new Date('2026-10-13T10:00:00+08:00');
const QUERY = { conditions: ['productOutlook', 'financialReview'], leadership: 'either', minSegmentRevenuePct: 30 };
const rankingLine = '根据中国电子行业协会发布的《2025年度汽车扬声器市场研究报告》，2025年公司在全国汽车扬声器市场份额排名第1，统计覆盖全部竞争者。';
function edit(bundle, fn, kind) {
  for (const document of bundle.documents) if (!kind || document.kind === kind) document.text = document.fullText = fn(document.text);
  return bundle;
}
function evaluate(mutator = () => {}, query = QUERY) {
  const bundle = companyBundle('sh600001', NOW);
  mutator(bundle);
  return evaluateCompanyEvidence(bundle, query, NOW);
}
const statusOf = (result, key) => result.checks.find(check => check.key === key)?.status;
function notice(bundle, text) {
  bundle.documents.push({ id: 'notice-20261001', title: '经营及财务事项公告', url: 'https://example.com/disclosures/notice-20261001',
    source: '东方财富公告全文', publishedAt: '2026-10-01', period: '2026-10-01', issuerSymbol: bundle.symbol, kind: 'notice',
    complete: true, fetchedAt: NOW.getTime(), text, fullText: text });
}

test('all original evidence categories can pass automatically with disclosed source provenance', () => {
  const result = evaluate();
  assert.equal(result.status, 'pass');
  assert.equal(result.symbol, 'sh600001');
  assert.equal(result.mode, 'automatic');
  assert.equal(result.ruleVersion, COMPANY_EVIDENCE_RULE_VERSION);
  assert.ok(result.records.length > 5);
  assert.ok(result.records.every(record => record.reviewState === 'automatic' && record.quote && record.url && record.publishedAt && record.period));
  const ranking = result.records.find(record => record.kind === 'ranking');
  assert.equal(ranking.sourceRelation, 'issuer-cites-third-party');
  assert.match(ranking.coverageBasis, /第三方原文未独立取回/);
});

for (const [name, mutate] of [
  ['missing full text', b => { b.documents[1].text = ''; }],
  ['wrong issuer', b => { b.documents[1].issuerSymbol = 'sh600002'; }],
  ['future publication', b => { b.documents[1].publishedAt = '2026-10-14'; }],
  ['future fetch', b => { b.fetchedAt = NOW.getTime() + 1; }],
  ['stale fetch', b => { b.fetchedAt -= 21600001; }],
  ['incomplete latest report', b => { b.documents[1].complete = false; }],
  ['invalid source URL', b => { b.documents[1].url = 'http://localhost/private'; }],
  ['impossible report period', b => { b.documents[1].reportDate = '2027-06-30'; }]
]) test(`${name} leaves evidence pending without falling back to definite old-report conclusions`, () => {
  const result = evaluate(b => {
    edit(b, text => text + '\n本报告期发生债务违约。', 'annual-report');
    mutate(b);
  });
  assert.equal(result.status, 'pending');
  assert.equal(statusOf(result, 'sourceIntegrity'), 'pending');
});

test('missing documents and stale annual reports do not pass', () => {
  assert.equal(evaluate(b => { b.documents = []; }).status, 'pending');
  const result = evaluate(b => { b.documents[0].reportDate = '2024-12-31'; b.documents[0].period = '2024年度'; });
  assert.equal(result.status, 'pending');
});

test('source failures remain visible on pending evaluations instead of a generic missing-report label alone', () => {
  const result = evaluate(b => {
    b.documents = [];
    b.errors = ['半年报 PDF 第12页未取得可核验文字', '近期相关公告另有3篇未取正文', '半年报 PDF 第12页未取得可核验文字'];
  });
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.reasons, ['资料获取：半年报 PDF 第12页未取得可核验文字', '资料获取：近期相关公告另有3篇未取正文']);
  assert.equal(result.records.length, 0);
});

test('October requires the current half-year report and cannot fail on old annual adverse facts', () => {
  const result = evaluate(b => {
    b.documents = b.documents.filter(document => document.kind === 'annual-report');
    edit(b, text => text + '\n本报告期发生债务违约。');
    b.coverage.semiannualReport = { status: 'missing' };
    b.coverage.relatedNotices.windowFromDate = '2026-04-01';
  });
  assert.equal(result.status, 'pending');
  assert.equal(statusOf(result, 'sourceIntegrity'), 'pending');
  assert.match(result.checks[0].reason, /2026年完整半年度报告/);
});

test('an incomplete latest report declared by coverage cannot pass with otherwise valid text', () => {
  const result = evaluate(b => { b.coverage.semiannualReport.status = 'missing'; });
  assert.equal(result.status, 'pending');
});

test('numeric finance data cannot replace financial-review disclosures', () => {
  const result = evaluate(b => edit(b, () => '净资产收益率20%，营业收入增长30%，经营现金流量净额1亿元。'));
  assert.equal(statusOf(result, 'financialReview'), 'pending');
});

for (const [name, replacement] of [
  ['another product', '汽车扬声器业务介绍，手机扬声器产品销量同比增长12.5%'],
  ['competitor after product', '汽车扬声器市场中，竞争对手销量同比增长12.5%'],
  ['competitor owning product', '竞争对手汽车扬声器产品销量同比增长12.5%'],
  ['revenue is not demand', '汽车扬声器产品收入同比增长12.5%'],
  ['forecast', '汽车扬声器产品销量预计同比增长12.5%'],
  ['prior period', '2025年汽车扬声器产品销量同比增长12.5%']
]) test(`${name} cannot supply current issuer product demand`, () => {
  const result = evaluate(b => edit(b, text => text.replace('汽车扬声器产品销量同比增长12.5%', replacement)));
  assert.equal(statusOf(result, 'productOutlook'), 'pending');
  assert.equal(result.records.some(record => record.kind === 'demand' && record.value === 'supported'), false);
});

for (const [name, replacement] of [
  ['planned revenue', '汽车扬声器产品预计实现营业收入3亿元'],
  ['negative revenue', '汽车扬声器产品实现营业收入-3亿元'],
  ['another product revenue', '汽车扬声器产品介绍，手机扬声器产品实现营业收入3亿元'],
  ['competitor revenue', '汽车扬声器产品中竞争对手实现营业收入3亿元']
]) test(`${name} cannot prove commercialization of the selected product`, () => {
  const result = evaluate(b => edit(b, text => text.replace('汽车扬声器产品实现营业收入3亿元', replacement)));
  assert.equal(statusOf(result, 'productOutlook'), 'pending');
});

test('conditions cannot be stitched across separate products', () => {
  const result = evaluate(b => edit(b, text => text.replace('主要产品为汽车扬声器', '主要产品为汽车扬声器、手机扬声器')
    .replace('汽车扬声器产品实现营业收入3亿元', '手机扬声器产品实现营业收入3亿元')));
  assert.equal(statusOf(result, 'productOutlook'), 'pending');
});

test('explicit demand disagreement in the same period stays pending', () => {
  const result = evaluate(b => edit(b, text => text + '\n汽车扬声器产品销量同比下降10%。'));
  assert.equal(statusOf(result, 'productOutlook'), 'pending');
});

test('a later product adverse disclosure prevents a positive outlook', () => {
  const result = evaluate(b => notice(b, '汽车扬声器产品需求严重下滑，已终止生产。'));
  assert.equal(statusOf(result, 'productOutlook'), 'fail');
});

test('another product adverse fact cannot be assigned to the selected product in the same paragraph', () => {
  const result = evaluate(b => notice(b, '汽车扬声器产品需求保持增长，但手机扬声器产品需求严重下滑。'));
  assert.equal(statusOf(result, 'productOutlook'), 'pass');
});

test('a competitor product adverse fact cannot be assigned to the issuer', () => {
  const result = evaluate(b => notice(b, '竞争对手汽车扬声器产品需求严重下滑。'));
  assert.equal(statusOf(result, 'productOutlook'), 'pass');
});

test('a later ranking correction leaves original positive ranking disputed', () => {
  const result = evaluate(b => notice(b, '汽车扬声器市场份额排名第一的表述不准确，现撤回相关表述。'));
  assert.equal(statusOf(result, 'leadership'), 'pending');
  assert.equal(statusOf(result, 'productOutlook'), 'pending');
});

test('a competitor rank earlier in a paragraph cannot be borrowed by the issuer', () => {
  const result = evaluate(b => edit(b, text => text.replace(rankingLine,
    '根据中国电子行业协会发布的《2025年度汽车扬声器市场研究报告》，竞争对手市场份额排名第1，2025年公司在全国汽车扬声器市场份额排名第8，统计覆盖全部竞争者。')));
  assert.equal(statusOf(result, 'leadership'), 'fail');
  assert.ok(result.records.filter(record => record.kind === 'ranking').every(record => record.rank === 8));
});

for (const scope of ['仅上市公司', '协会会员', '参评企业', '受访企业', '调查样本', '重点企业', '覆盖30家企业', '华东区域', '母公司集团']) {
  test(`${scope} ranking does not establish an all-competitor national ranking`, () => {
    const result = evaluate(b => edit(b, text => text.replace('统计覆盖全部竞争者', `统计范围为${scope}`)));
    assert.equal(statusOf(result, 'leadership'), 'pending');
  });
}

for (const replacement of ['公司自认为是全国汽车扬声器行业龙头。', '根据有关机构统计，2025年公司在全国汽车扬声器市场份额排名第1。']) {
  test(`untraceable ranking stays pending: ${replacement}`, () => {
    const result = evaluate(b => edit(b, text => text.replace(rankingLine, replacement)));
    assert.equal(statusOf(result, 'leadership'), 'pending');
  });
}

for (const [rank, expected] of [['第二十', 'fail'], ['第一百', 'fail'], ['第1至第10之间', 'pending']]) {
  test(`${rank} is not parsed as rank one or two`, () => {
    const result = evaluate(b => edit(b, text => text.replace('排名第1', `排名${rank}`)));
    assert.equal(statusOf(result, 'leadership'), expected);
  });
}

test('newer statistics supersede an older favorable ranking', () => {
  const result = evaluate(b => {
    edit(b, text => text.replaceAll('2025年', '2024年'), 'annual-report');
    edit(b, text => text.replace('排名第1', '排名第8'), 'semiannual-report');
  });
  assert.equal(statusOf(result, 'leadership'), 'fail');
  assert.ok(result.records.filter(record => record.kind === 'ranking').every(record => record.statisticYear === 2025 && record.rank === 8));
});

test('conflicting same-year ranking cannot establish industry leadership', () => {
  const result = evaluate(b => edit(b, text => text + '\n' + rankingLine.replace('排名第1', '排名第5')));
  assert.equal(statusOf(result, 'leadership'), 'pending');
});

for (const [share, expected] of [[30, 'pass'], [29.9, 'fail'], [-30, 'pending'], [130, 'pending']]) {
  test(`segment leadership validates current revenue share ${share}%`, () => {
    const result = evaluate(b => edit(b, text => text.replace('收入35%', `收入${share}%`)), { conditions: [], leadership: 'segmentLeader', minSegmentRevenuePct: 30 });
    assert.equal(result.status, expected);
  });
}

test('unrelated product revenue share cannot be borrowed by a ranked segment', () => {
  const result = evaluate(b => edit(b, text => text.replace('汽车扬声器业务营业收入占公司总收入35%', '汽车扬声器相关情况，手机扬声器业务营业收入占公司总收入35%')),
    { conditions: [], leadership: 'segmentLeader', minSegmentRevenuePct: 30 });
  assert.equal(result.status, 'pending');
});

for (const statement of ['本报告期存在债务逾期。', '本报告期发生债务违约。', '本报告期发生重大会计差错更正。', '本期不存在重大会计差错但发生债务违约。', '重大会计差错更正不适用，但公司发生债务违约。']) {
  test(`actual latest financial adverse fact fails: ${statement}`, () => {
    const result = evaluate(b => edit(b, text => text + '\n' + statement, 'semiannual-report'));
    assert.equal(statusOf(result, 'financialReview'), 'fail');
  });
}

test('hypothetical debt default is not a present financial adverse fact', () => {
  const result = evaluate(b => edit(b, text => text + '\n若发生债务违约，公司将及时披露。'));
  assert.equal(statusOf(result, 'financialReview'), 'pass');
});

test('investee debt disclosure cannot clear issuer debt', () => {
  const result = evaluate(b => edit(b, text => text.replace('本报告期不存在债务逾期', '参股公司本报告期不存在债务逾期')));
  assert.equal(statusOf(result, 'financialReview'), 'pending');
});

test('checkbox not applicable is not a going-concern failure', () => {
  const result = evaluate(b => edit(b, text => text + '\n与持续经营相关的重大不确定性 □适用 √不适用。', 'annual-report'));
  assert.equal(statusOf(result, 'financialReview'), 'pass');
});

test('actual going-concern uncertainty in the annual report fails financial review', () => {
  const result = evaluate(b => edit(b, text => text + '\n公司持续经营能力存在重大不确定性。', 'annual-report'));
  assert.equal(statusOf(result, 'financialReview'), 'fail');
});

test('generic audit responsibility wording is not the opinion', () => {
  const result = evaluate(b => edit(b, text => text.replace('审计意见类型：标准的无保留意见。', '注册会计师对财务报表审计的责任。'), 'annual-report'));
  assert.equal(statusOf(result, 'financialReview'), 'pending');
});

test('a conventional audit opinion under its own section can pass', () => {
  const result = evaluate(b => edit(b, text => text.replace('审计意见类型：标准的无保留意见。', '一、审计意见。'), 'annual-report'));
  assert.equal(statusOf(result, 'financialReview'), 'pass');
});

test('securities-exchange rules following an industry heading are not a financial industry assertion', () => {
  const result = evaluate(b => edit(b, text => text + '\n公司行业分类\n公司需遵守《深圳证券交易所相关规定》。'));
  assert.equal(statusOf(result, 'financialReview'), 'pass');
});

test('an explicit issuer banking industry is inapplicable to the ordinary-company template', () => {
  const result = evaluate(b => edit(b, text => text.replace('所属行业：电子设备制造业', '所属行业：银行业')));
  assert.equal(statusOf(result, 'financialReview'), 'fail');
});

test('incomplete post-report notice body coverage cannot clear product or financial risks', () => {
  const result = evaluate(b => { b.coverage.relatedNotices.complete = false; b.coverage.relatedNotices.omitted = 1; });
  assert.equal(statusOf(result, 'productOutlook'), 'pending');
  assert.equal(statusOf(result, 'financialReview'), 'pending');
});

for (const statement of [
  '3 、由于重大会计差错更正,影响期初未分配利润 0 元。',
  '3)、由于重大会计差错更正,影响期初未分配利润 0.00 元。',
  '3 )由于重大会计差错更正,影响期初未分配利润 0.00 元。',
  '3)、由于重大会计差错更正,影响期初未分配利润元。',
  '详见见“第五节 重要事项”之“五、公司对会计政策、会计估计变更或重大会计差错更正。',
  '计准则变更以外的原因作出会计政策、会计估计变更或者重大会计差错更正。',
  '(四)因会计准则变更以外的原因作出会计政策、会计估计变更或者重大会计差错更正。',
  '(三)前期重大会计差错更正情况。'
]) test(`report correction template is not an adverse fact or a substitute for missing review: ${statement}`, () => {
  const result = evaluate(b => edit(b, text => text.replace('本报告期未发生重大会计差错更正。', statement)));
  assert.equal(statusOf(result, 'financialReview'), 'pending');
  assert.equal(result.records.some(record => record.kind === 'financialReview' && record.value === 'adverse'), false);
  assert.equal(result.records.some(record => record.kind === 'financialReview' && record.value === 'correctionClear'), false);
});

for (const amount of ['100', '-100', '0.01', '-0.01', '1,000.00']) {
  test(`an actual nonzero accounting correction impact ${amount} remains adverse`, () => {
    const result = evaluate(b => edit(b, text => text + `\n由于重大会计差错更正，影响期初未分配利润${amount}元。`, 'semiannual-report'));
    assert.equal(statusOf(result, 'financialReview'), 'fail');
  });
}

test('zero retained-earnings impact does not erase an explicit actual major correction', () => {
  const result = evaluate(b => edit(b, text => text + '\n公司本期发生重大会计差错更正，影响期初未分配利润0元。', 'semiannual-report'));
  assert.equal(statusOf(result, 'financialReview'), 'fail');
});

test('zero correction impact and a cross-reference do not erase actual debt default', () => {
  const result = evaluate(b => edit(b, text => text + '\n由于重大会计差错更正，影响期初未分配利润0元，但公司发生债务违约，详见相关公告。', 'semiannual-report'));
  assert.equal(statusOf(result, 'financialReview'), 'fail');
});

for (const statement of [
  '形成否定意见的,应改聘会计师事务所,审计与风险管理委员会改聘下一年度会计师事务所时,应通过书面沟通的方式进行评价。',
  '3最近一年审计报告为非无保留意见或带与持续经营相关的重大不确定性段。',
  '重大缺陷的认定标准：①企业财务报表已经或者很可能被注册会计师出具否定意见或者拒绝表示意见。',
  '出具否定意见。',
  '我们可能出具否定意见。',
  '公司未出具保留意见。',
  '[注 3]鉴于上海智眠信息科技有限公司已发生重大亏损且净资产较低,其持续经营能力存在重大不确定性,在经过。'
]) test(`audit definitions, headings and other companies do not replace issuer audit evidence: ${statement}`, () => {
  const result = evaluate(b => edit(b, text => text.replace('审计意见类型：标准的无保留意见。', statement), 'annual-report'));
  assert.equal(statusOf(result, 'financialReview'), 'pending');
  assert.equal(result.records.some(record => record.kind === 'financialReview' && record.value === 'adverse'), false);
});

test('unrelated nonzero balance movement does not turn a correction heading into a major correction', () => {
  const result = evaluate(b => edit(b, text => text.replace('本报告期未发生重大会计差错更正。', '重大会计差错更正情况。\n其他因素影响期初未分配利润100元。')));
  assert.equal(statusOf(result, 'financialReview'), 'pending');
});

for (const statement of [
  '未发生重大会计差错更正，本期营业收入增加5亿元。',
  '重大会计差错更正不适用，本期未分配利润增加5元。'
]) test(`negated correction cannot borrow a nonzero unrelated amount: ${statement}`, () => {
  const result = evaluate(b => edit(b, text => text + '\n' + statement, 'semiannual-report'));
  assert.equal(statusOf(result, 'financialReview'), 'pass');
});

test('a negated correction and unrelated amount do not conceal actual debt default later in the paragraph', () => {
  const result = evaluate(b => edit(b, text => text + '\n未发生重大会计差错更正，本期营业收入增加5亿元，但本期发生债务违约。', 'semiannual-report'));
  assert.equal(statusOf(result, 'financialReview'), 'fail');
});

for (const statement of ['审计意见类型：保留意见。', '审计意见类型：否定意见。', '审计意见类型：无法表示意见。', '我们对本公司财务报表出具了否定意见。']) {
  test(`an explicit actual modified issuer audit opinion remains adverse: ${statement}`, () => {
    const result = evaluate(b => edit(b, text => text.replace('审计意见类型：标准的无保留意见。', statement), 'annual-report'));
    assert.equal(statusOf(result, 'financialReview'), 'fail');
  });
}
