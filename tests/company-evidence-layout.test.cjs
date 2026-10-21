const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { evaluateCompanyEvidence, COMPANY_EVIDENCE_RULE_VERSION } = require('../core/company-evidence.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const { revenueTable, oilTable } = require('./fixtures/company-report-table-excerpts.cjs');
const NOW = new Date('2026-10-13T10:00:00+08:00');
const query = { conditions: ['productOutlook', 'financialReview'], leadership: 'either', minSegmentRevenuePct: 30 };
const ranking = '根据中国电子行业协会发布的《2025年度汽车扬声器市场研究报告》，2025年公司在全国汽车扬声器市场份额排名第1，统计覆盖全部竞争者。';
function native(document, texts) {
  document.pageTexts = texts.map((text, i) => ({ text, page: i + 1, method: 'pdf-text', complete: true, numericEligible: true, textHash: createHash('sha256').update(text).digest('hex') }));
  document.pages = texts.length; document.text = texts.join('\n\n'); delete document.fullText;
  document.sourceHash = 'a'.repeat(64); document.parserVersion = '2';
}
function evaluate(mutate = () => {}, inputQuery = query) {
  const bundle = companyBundle('sh600001', NOW); mutate(bundle);
  return evaluateCompanyEvidence(bundle, inputQuery, NOW);
}
function replace(bundle, from, to, kind) {
  for (const document of bundle.documents) if (!kind || kind === document.kind) native(document, [document.text.replace(from, to)]);
}
const check = (result, key) => result.checks.find(item => item.key === key);
const has = (result, value) => result.records.some(record => record.value === value);
const originalAudit = `一 、 审计意见
我们审计了中国海洋石油有限公司的财务报表 ,包括 2025 年 12 月 31 日的合并及公司
资产负债表 , 2025 年度的合并及公司利润表 、股东权益变动表和现金流量表以及相
关财务报表附注 。
我们认为 ,后附的中国海洋石油有限公司的财务报表在所有重大方面按照企业会计
准则的规定编制 ,公允反映了中国海洋石油有限公司 2025 年 12 月 31 日的合并及公司
财务状况以及 2025 年度的合并及公司经营成果和现金流量 。
二 、 形成审计意见的基础`;
test('real CNOOC page 116 native audit excerpt survives its hard wraps with precise provenance', () => {
  const result = evaluate(bundle => {
    const annual = bundle.documents[0];
    native(annual, [annual.text.replace(/审计意见类型：[\s\S]+$/, ''), originalAudit]);
  }, { conditions: ['financialReview'] });
  const record = result.records.find(item => item.value === 'auditClear');
  assert.ok(record);
  assert.deepEqual(record.locations.map(p => [p.page, p.method, p.lineStart, p.lineEnd]), [[2, 'pdf-text', 5, 7]]);
  assert.equal(record.ruleVersion, COMPANY_EVIDENCE_RULE_VERSION);
  assert.equal(COMPANY_EVIDENCE_RULE_VERSION, '7');
});
for (const [name, opinion] of [
  ['responsibility section', originalAudit.replace('一 、 审计意见', '一 、 注册会计师对财务报表审计的责任')],
  ['hypothetical heading', originalAudit.replace('一 、 审计意见', '例如，如果审计意见为以下内容')],
  ['conditional opinion', originalAudit.replace('我们认为 ,后附', '如果我们认为 ,后附')],
]) test(`${name} does not become a current audit opinion after line recovery`, () => {
  const result = evaluate(bundle => replace(bundle, /审计意见类型：[\s\S]+$/, opinion, 'annual-report'), { conditions: ['financialReview'] });
  assert.equal(has(result, 'auditClear'), false);
});
test('audit recovery never crosses a page boundary', () => {
  const result = evaluate(bundle => {
    const annual = bundle.documents[0];
    native(annual, [annual.text.replace(/审计意见类型：[\s\S]+$/, '') + '一、审计意见\n我们认为，后附财务报表在所有重大方面按照企业会计',
      '准则的规定编制，公允反映了公司财务状况。']);
  }, { conditions: ['financialReview'] });
  assert.equal(has(result, 'auditClear'), false);
});
const correctionTitle = '六、董事会关于报告期会计政策、会计估计变更或重大会计差错更正的说明';
test('real Haikan native heading and immediately adjacent negative checkbox remain attributable', () => {
  const result = evaluate(bundle => replace(bundle, '本报告期未发生重大会计差错更正。', `${correctionTitle}\n□ 适用 ☑ 不适用`, 'semiannual-report'), { conditions: ['financialReview'] });
  const record = result.records.find(item => item.value === 'correctionClear');
  assert.ok(record); assert.match(record.quote, /说明\n□ 适用 ☑ 不适用/);
  assert.equal(record.locations.length, 1);
  assert.equal(record.locations[0].lineEnd - record.locations[0].lineStart, 1);
});
for (const [name, text] of [
  ['applicable selected', `${correctionTitle}\n☑ 适用 □ 不适用`],
  ['both unselected', `${correctionTitle}\n□ 适用 □ 不适用`],
  ['both selected', `${correctionTitle}\n☑ 适用 ☑ 不适用`],
  ['unknown native glyph', `${correctionTitle}\n\uf052 适用 □ 不适用`],
  ['extra unknown selected option', `${correctionTitle} □适用 ☑不适用 ■适用`],
  ['intervening heading', `${correctionTitle}\n七、合并范围变更情况\n□ 适用 ☑ 不适用`],
  ['unknown body between', `${correctionTitle}\n具体处理尚待核验\n□ 适用 ☑ 不适用`],
  ['investee ownership', `参股公司重大会计差错更正情况\n□ 适用 ☑ 不适用`],
]) test(`checkbox ${name} cannot clear issuer correction`, () => {
  const result = evaluate(bundle => replace(bundle, '本报告期未发生重大会计差错更正。', text, 'semiannual-report'), { conditions: ['financialReview'] });
  assert.equal(has(result, 'correctionClear'), false);
});
test('a negative annual checkbox cannot substitute for absent latest half-year correction disclosure', () => {
  const result = evaluate(bundle => {
    replace(bundle, '本报告期未发生重大会计差错更正。', `${correctionTitle}\n□ 适用 ☑ 不适用`, 'annual-report');
    replace(bundle, '本报告期未发生重大会计差错更正。', '', 'semiannual-report');
  }, { conditions: ['financialReview'] });
  assert.equal(has(result, 'correctionClear'), false);
});
test('a checkbox on the next page cannot answer the previous page heading', () => {
  const result = evaluate(bundle => {
    const semi = bundle.documents[1]; native(semi, [semi.text.replace('本报告期未发生重大会计差错更正。', correctionTitle), '□ 适用 ☑ 不适用']);
  }, { conditions: ['financialReview'] });
  assert.equal(has(result, 'correctionClear'), false);
});
test('same product volume followed by an immediate growth clause is recognised', () => {
  for (const growth of ['同比增长12.5%', '比去年上升12.5%', '同比上涨12.5%']) {
    const result = evaluate(bundle => replace(bundle, '汽车扬声器产品销量同比增长12.5%', `汽车扬声器产品销量1,000万件，${growth}`), { conditions: ['demand'] });
    assert.equal(result.status, 'pass');
    assert.ok(result.records.every(record => record.locations.length));
  }
});
for (const statement of [
  '汽车扬声器产品销量100万件，手机扬声器销量同比增长12.5%',
  '汽车扬声器产品销量100万件，竞争对手同比增长12.5%',
  '汽车扬声器产品销量100万件，收入同比增长12.5%',
  '汽车扬声器产品销量100万件，预计同比增长12.5%',
  '汽车扬声器产品销量100万件，其他业务保持稳定，同比增长12.5%',
  '2025年，汽车扬声器产品销量100万件，同比增长12.5%',
  '二零二五年，汽车扬声器产品销量100万件，同比增长12.5%',
  '汽车扬声器产品销量100万件\n手机扬声器产品销量同比增长12.5%',
]) test(`same-product ownership/period is not inferred across: ${statement}`, () => {
  const result = evaluate(bundle => replace(bundle, '汽车扬声器产品销量同比增长12.5%', statement), { conditions: ['demand'] });
  assert.equal(result.records.some(record => record.subject === '汽车扬声器' && record.kind === 'demand'), false);
});
test('主营/内外销 accounting categories never become product subjects', () => {
  const result = evaluate(bundle => {
    native(bundle.documents[1], ['主营业务收入100亿元。\n内销业务收入80亿元。\n外销业务收入20亿元。']);
  }, { conditions: ['commercialization'] });
  assert.equal(result.status, 'pending'); assert.equal(result.records.length, 0);
  assert.doesNotMatch(result.checks[0].reason, /产品「(?:主营|内销|外销)」/);
});
test('native core product lists discover real products without turning services prose into a product', () => {
  const result = evaluate(bundle => {
    native(bundle.documents[1], ['公司主要为零售企业提供服务，核心产品及服务包括电子价签、智能购物车、门店机器人等智能终端。\n电子价签产品实现营业收入3亿元。']);
  }, { conditions: ['commercialization'] });
  assert.equal(result.status, 'pass'); assert.equal(result.records[0].subject, '电子价签');
});
test('issuer production and sales description identifies oil and gas as products', () => {
  const result = evaluate(bundle => {
    bundle.documents[1].title = '中国海油:2026年半年度报告';
    native(bundle.documents[1], ['中国海油是中国最大的海上原油及天然气生产商，亦是全球最大的独立油气勘探及生产\n集团之一，其主要业务是勘探、开发、生产及销售原油和天然气。\n天然气产品实现销售收入100亿元。']);
  }, { conditions: ['commercialization'] });
  assert.equal(result.status, 'pass'); assert.equal(result.records[0].subject, '天然气');
});

test('the current CNOOC halfway-word issuer description identifies oil and gas', () => {
  const result = evaluate(bundle => {
    native(bundle.documents[1], ['本公司为中国最大之海上原油及天然气生产商，亦为全球最大之独立油气勘探及生产企\n业之一，主要业务为勘探、开发、生产及销售原油和天然气。\n天然气产品实现销售收入100亿元。']);
  }, { conditions: ['commercialization'] });
  assert.equal(result.status, 'pass'); assert.equal(result.records[0].subject, '天然气');
});
test('the CITIC issuer trading list is recognised without borrowing investee products', () => {
  const result = evaluate(bundle => {
    native(bundle.documents[1], ['公司主营的贸易品种包括铌、铜、铝等有色金属产品，以及铁矿石、\n钢材等黑色金属产品。公司参股的项目包括铂族多金属矿。\n铜产品实现销售收入100亿元。']);
  }, { conditions: ['commercialization'] });
  assert.equal(result.status, 'pass'); assert.equal(result.records[0].subject, '铜');
});
test('a parent correction answered by two negative methods clears, while either applicable method blocks', () => {
  const correction = '1、前期会计差错更正\n(1)追溯重述法\n□适用 √不适用\n(2)未来适用法\n□适用 √不适用';
  const result = evaluate(bundle => replace(bundle, '本报告期未发生重大会计差错更正。', correction, 'semiannual-report'), { conditions: ['financialReview'] });
  assert.equal(has(result, 'correctionClear'), true);
  assert.equal(result.records.find(record => record.value === 'correctionClear').locations[0].lineEnd - result.records.find(record => record.value === 'correctionClear').locations[0].lineStart, 4);
  const conflicting = evaluate(bundle => replace(bundle, '本报告期未发生重大会计差错更正。', correction.replace('(2)未来适用法\n□适用 √不适用', '(2)未来适用法\n√适用 □不适用'), 'semiannual-report'), { conditions: ['financialReview'] });
  assert.equal(has(conflicting, 'correctionClear'), false);
});
for (const statement of ['本公司并非不存在债务逾期。', '本公司不存在供应商债务逾期。', '本公司不存在短期借款债务逾期。']) test(`a negated or partial-scope debt denial is not issuer-wide clearance: ${statement}`, () => {
  const result = evaluate(bundle => replace(bundle, '本报告期不存在债务逾期。', statement, 'semiannual-report'), { conditions: ['financialReview'] });
  assert.equal(has(result, 'debtClear'), false);
});
test('a correction denial quoted as inaccurate is not affirmative negative evidence', () => {
  const result = evaluate(bundle => replace(bundle, '本报告期未发生重大会计差错更正。', '本报告期未发生重大会计差错更正的说法不准确。', 'semiannual-report'), { conditions: ['financialReview'] });
  assert.equal(has(result, 'correctionClear'), false);
});
test('unverified all-competitor denominator is retained as a citation but cannot establish rank eligibility', () => {
  const result = evaluate(bundle => replace(bundle, '，统计覆盖全部竞争者', ''), { conditions: [], leadership: 'mainTop3' });
  assert.equal(result.status, 'pending'); assert.ok(result.records.some(record => record.kind === 'ranking' && record.coverage === 'unverified'));
});
test('real native CNOOC table supplies matched current gas sales volume and commercialization', () => {
  const result = evaluate(bundle => native(bundle.documents[1], [oilTable]), { conditions: ['demand', 'commercialization'] });
  assert.equal(result.status, 'pass');
  assert.ok(result.records.every(record => record.subject === '石油液体'));
  assert.equal(result.records.find(record => record.kind === 'demand').growthPct, 4.7);
  assert.equal(result.records.find(record => record.kind === 'commercialization').amount, 178913);
});
test('same-scope ranking uses same-period product table revenue share with numerator and denominator locations', () => {
  const result = evaluate(bundle => {
    replace(bundle, ranking, ranking.replaceAll('汽车扬声器', '镜片'));
    native(bundle.documents[1], [bundle.documents[1].text, revenueTable]);
  }, { conditions: [], leadership: 'segmentLeader', minSegmentRevenuePct: 30 });
  assert.equal(result.status, 'pass');
  const share = result.records.find(record => record.kind === 'segmentRevenue');
  assert.equal(share.subject, '镜片'); assert.equal(share.amount, 377892754.57); assert.equal(share.totalRevenue, 456529256.91);
  assert.equal(share.locations.length, 2);
});
test('a branded-market ranking never borrows the revenue of all lenses', () => {
  const result = evaluate(bundle => {
    replace(bundle, ranking, ranking.replaceAll('汽车扬声器', '品牌镜片'));
    native(bundle.documents[1], [bundle.documents[1].text, revenueTable]);
  }, { conditions: [], leadership: 'segmentLeader', minSegmentRevenuePct: 30 });
  assert.equal(result.status, 'pending'); assert.equal(result.records.some(record => record.kind === 'segmentRevenue'), false);
});
function independentRank(bundle, rank, fullScope = true) {
  // The provider metadata ties this synthetic report title to its issuer.
  for (const document of bundle.documents) document.title = `隔离声学股份有限公司:${document.title}`;
  const text = `2025年隔离声学股份有限公司在全国汽车扬声器市场份额排名第${rank}${fullScope ? '，统计覆盖全部竞争者' : ''}。`;
  bundle.industryDocuments = [{ id: 'isolated-official-rank', issuerSymbol: bundle.symbol, kind: 'industry-report', complete: true,
    title: '2025年汽车扬声器市场研究', url: 'https://www.frostchina.com/isolated-ranking-test', publishedAt: '2026-05-01', fetchedAt: NOW.getTime(),
    text, textHash: createHash('sha256').update(text).digest('hex'), sourceHash: 'b'.repeat(64), pages: 1,
    pageTexts: [{ page: 1, text, method: 'provider-text', complete: true, numericEligible: true }] }];
}
test('independently fetched ranking supports the same issuer without a misleading issuer-citation label', () => {
  const result = evaluate(bundle => { replace(bundle, ranking, ''); independentRank(bundle, 2); }, { conditions: [], leadership: 'mainTop3' });
  assert.equal(result.status, 'pass'); assert.equal(result.records.find(record => record.kind === 'ranking').sourceRelation, 'independent-third-party');
  assert.match(result.checks[0].reason, /已独立取得第三方原文/); assert.doesNotMatch(result.checks[0].reason, /未独立取回/);
});
for (const fullScope of [true, false]) test(`conflicting independent and issuer-cited same-year ranks cannot establish eligibility (verified scope=${fullScope})`, () => {
  const result = evaluate(bundle => independentRank(bundle, 8, fullScope));
  assert.equal(check(result, 'leadership').status, 'pending'); assert.equal(check(result, 'productOutlook').status, 'pending');
  assert.match(check(result, 'productOutlook').reason, /行业比较事实存在冲突/);
});
test('industry-source failures are visible without invalidating complete issuer reports', () => {
  const result = evaluate(bundle => { replace(bundle, ranking, ''); bundle.industryCoverage = { issues: ['已找到行业摘要但未公开完整原文'] }; });
  assert.equal(result.checks.some(item => item.key === 'sourceIntegrity'), false);
  assert.ok(result.reasons.includes('行业原文：已找到行业摘要但未公开完整原文'));
  assert.match(check(result, 'leadership').reason, /行业摘要但未公开完整原文/);
});
test('a later official retraction invalidates an issuer-only rank even without a replacement numeric rank', () => {
  const result = evaluate(bundle => {
    independentRank(bundle, 2);
    const document = bundle.industryDocuments[0];
    document.text = '隔离声学股份有限公司汽车扬声器市场份额排名表述不准确，现撤回。';
    document.pageTexts[0].text = document.text; document.textHash = createHash('sha256').update(document.text).digest('hex'); document.publishedAt = '2026-10-01';
  });
  assert.equal(check(result, 'leadership').status, 'pending'); assert.equal(check(result, 'productOutlook').status, 'pending');
  assert.ok(result.records.some(record => record.kind === 'rankingConflict' && record.sourceRelation === 'independent-third-party'));
});
test('a wrapped third-party ranking keeps quote, page and source identity', () => {
  const result = evaluate(bundle => replace(bundle, ranking, ranking.replace('，2025年', '，\n2025年')), { conditions: [], leadership: 'mainTop3' });
  assert.equal(result.status, 'pass');
  assert.ok(result.records.filter(record => record.kind === 'ranking').every(record => record.locations.length === 1 && record.locations[0].lineEnd > record.locations[0].lineStart));
});
test('real Mingyue citation supplies a traceable ranking, while missing current segment mapping stays pending', () => {
  const excerpt = `公司作为深交所注册制背景下上市的唯一一家镜片品牌企业，根据国际知名市场调研机构弗若斯特
沙利文(以下简称“沙利文”)公布的权威市场调研数据显示，在2025年中国品牌镜片行业零售格局中，按零售量计，明月
镜片以11.7%的市场份额排名第一，另据沙利文2026年3月出具的市场地位确认证书，明月镜片“眼镜镜片连续十年全国销
量领先”，彰显了明月镜片的行业头部地位与强劲品牌实力。`;
  const result = evaluate(bundle => {
    for (const document of bundle.documents) { document.title = '明月镜片:' + document.title; native(document, [document.text.replace(ranking, excerpt)]); }
  }, { conditions: [], leadership: 'either' });
  assert.equal(result.status, 'pending');
  const record = result.records.find(item => item.kind === 'ranking');
  assert.ok(record); assert.equal(record.subject, '品牌镜片'); assert.equal(record.rank, 1); assert.equal(record.statisticYear, 2025);
  assert.equal(record.citedSource, '弗若斯特沙利文'); assert.equal(record.locations[0].lineEnd - record.locations[0].lineStart, 3);
});
for (const mutation of [
  line => line.replace('公司在全国', '竞争对手在全国'),
  line => line.replace('统计覆盖全部竞争者', '统计范围仅上市公司'),
  line => line.replace('排名第1', '预计排名第1'),
  line => `仅上市公司范围，${line}`,
  line => `如果${line}`,
  line => line.replace('中国电子行业协会发布的《2025年度汽车扬声器市场研究报告》', '机构统计'),
]) test('line recovery does not relax ranking attribution, coverage or factuality', () => {
  const result = evaluate(bundle => replace(bundle, ranking, mutation(ranking).replace('，2025年', '，\n2025年')), { conditions: [], leadership: 'mainTop3' });
  assert.equal(result.status, 'pending'); assert.equal(result.records.length, 0);
});
test('explicit issuer-wide debt checkbox can clear only its own debt topic', () => {
  const result = evaluate(bundle => replace(bundle, '本报告期不存在债务逾期。', '债务逾期情况\n□适用 ☑不适用', 'semiannual-report'), {conditions:['financialReview']});
  assert.equal(has(result,'debtClear'),true);
});
for (const text of [
  '短期借款逾期情况\n□适用 ☑不适用',
  '本集团没有已逾期未偿还的借款。',
  '本期末已逾期未偿还的短期借款总额为0.00元。',
  '债务逾期情况\n☑适用 □不适用',
]) test(`a partial scope or nonnegative debt checkbox cannot clear all debt: ${text}`, () => {
  const result = evaluate(bundle => replace(bundle,'本报告期不存在债务逾期。',text,'semiannual-report'),{conditions:['financialReview']});
  assert.equal(has(result,'debtClear'),false);
});
