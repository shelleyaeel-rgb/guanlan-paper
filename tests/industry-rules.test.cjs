'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { INDUSTRY_METADATA, validateIndustryRules, describeIndustryRules, validateEvidenceQuery, describeEvidenceQuery, evaluateEvidence } = require('../core/selection-evidence.cjs');
const { evaluateCompanyEvidence } = require('../core/company-evidence.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const { revenueTable } = require('./fixtures/company-report-table-excerpts.cjs');
const NOW = new Date('2026-10-15T10:00:00+08:00'), symbol = 'sh600001';
const config = overrides => ({ ...INDUSTRY_METADATA.defaults, ...overrides });
const query = industry => ({ conditions: [], industry });
const manual = (kind, changes = {}) => ({ symbol, kind, subject: '汽车扬声器', value: 'ranked', reviewState: 'confirmed',
  sourceTitle: '2025年度汽车扬声器统计', url: 'https://example.com/report', period: '2025年度', quote: '隔离排名证据',
  publishedAt: '2026-04-01', reviewedAt: '2026-10-15', validUntil: '2027-04-01',
  market: '汽车扬声器', geography: '中国', metric: 'marketShare', coverage: 'allCompetitors', rank: 1, statisticYear: 2025,
  revenueSharePct: 35, ...changes });
function automatic(rank = 1, shares = [35]) {
  const bundle = companyBundle(symbol, NOW);
  for (const document of bundle.documents) {
    document.text = document.fullText = document.text.replace('排名第1', `排名第${rank}`)
      .replace('汽车扬声器业务营业收入占公司总收入35%。', shares.map(share => `汽车扬声器业务营业收入占公司总收入${share}%。`).join('\n'));
  }
  return bundle;
}

test('行业原始条件严格验证且可选，旧查询与描述不新增字段或改变字样', () => {
  assert.equal(validateIndustryRules(undefined), undefined);
  assert.equal(validateEvidenceQuery({ industry: null }), undefined);
  assert.deepEqual(validateIndustryRules(config()), INDUSTRY_METADATA.defaults);
  const legacy = { conditions: [], leadership: 'either', minSegmentRevenuePct: 30 };
  assert.deepEqual(validateEvidenceQuery(legacy), legacy);
  assert.deepEqual(describeEvidenceQuery(legacy), ['主行业前三或重要细分行业龙头（细分业务营收占比 ≥ 30%，细分排名第 1）']);
  assert.equal(Object.hasOwn(validateEvidenceQuery(legacy), 'industry'), false);
  assert.equal(validateEvidenceQuery(query(config())).industry.mainRankMax, 3);
  assert.match(describeIndustryRules(config({ scope: 'segment', segmentRankMax: 4, minSegmentRevenuePct: 25 })), /细分业务排名 ≤ 4 且营收占比 ≥ 25%/);
  for (const bad of [false, [], config({ version: 2 }), config({ scope: 'leader' }), config({ mainRankMax: 0 }), config({ mainRankMax: 1.5 }),
    config({ segmentRankMax: 100001 }), config({ minSegmentRevenuePct: -1 }), config({ minSegmentRevenuePct: 101 }),
    config({ mainRankMax: '3' }), config({ extra: true }), { version: 1, scope: 'main' }]) assert.throws(() => validateIndustryRules(bad));
  assert.throws(() => validateEvidenceQuery({ ...legacy, industry: config() }), /不能同时启用/);
});

test('主营与细分数字阈值及OR含义在自动原文和手工证据中一致', () => {
  for (const [rank, share, settings, expected] of [
    [5, 35, { scope: 'main', mainRankMax: 5 }, 'pass'], [5, 35, { scope: 'main', mainRankMax: 4 }, 'fail'],
    [2, 35, { scope: 'segment', segmentRankMax: 2, minSegmentRevenuePct: 35 }, 'pass'],
    [2, 35, { scope: 'segment', segmentRankMax: 2, minSegmentRevenuePct: 35.01 }, 'fail'],
    [2, 35, { scope: 'either', mainRankMax: 1, segmentRankMax: 2 }, 'pass'],
    [5, 35, { scope: 'either', mainRankMax: 4, segmentRankMax: 2 }, 'fail']
  ]) {
    const input = query(config(settings));
    const fromText = evaluateCompanyEvidence(automatic(rank, [share]), input, NOW);
    const fromManual = evaluateEvidence([manual('mainRank', { rank, revenueSharePct: share }), manual('segmentRank', { rank, revenueSharePct: share })], input, NOW);
    for (const result of [fromText, fromManual]) {
      assert.equal(result.status, expected, JSON.stringify(settings));
      assert.equal(result.industryReview.status, expected);
      assert.equal(result.checks.find(item => item.key === 'industry').status, expected);
      assert.ok(result.industryReview.rows.every(row => row.rank === rank && row.revenueSharePct === share));
      assert.ok(result.industryReview.rows.every(row => row.market && row.geography && row.metric && row.statisticYear === 2025 && row.records.length));
    }
    assert.equal(fromText.industryReview.rows[0].sourceRelation, 'issuer-cites-third-party');
    assert.equal(fromManual.industryReview.rows[0].sourceRelation, 'manual-record');
  }
});

test('同年同口径矛盾排名即待核验，不能因都落在阈值同侧或主体别名不同而通过', () => {
  assert.equal(evaluateEvidence([manual('mainRank'), manual('segmentRank', { rank: 2 })], query(config()), NOW).status, 'pending');
  const newer = evaluateEvidence([manual('mainRank', { rank: 8 }), manual('segmentRank', { statisticYear: 2024 })], query(config()), NOW);
  assert.equal(newer.status, 'pending', '较旧细分标签不能绕过同一市场的新年度排名');
  for (const ranks of [[1, 2], [8, 9]]) {
    for (const input of [{ conditions: [], leadership: 'mainTop3' }, query(config({ scope: 'main' }))]) {
      const records = ranks.map((rank, index) => manual('mainRank', { rank, subject: index ? '主营业务别名' : '汽车扬声器' }));
      const result = evaluateEvidence(records, input, NOW);
      assert.equal(result.status, 'pending'); assert.match(result.checks[0].reason, /排名冲突/);
      const bundle = automatic(ranks[0]);
      for (const document of bundle.documents) document.text = document.fullText = document.text + '\n' + document.text.split('\n').find(line => line.includes('排名第')).replace(`排名第${ranks[0]}`, `排名第${ranks[1]}`);
      assert.equal(evaluateCompanyEvidence(bundle, input, NOW).status, 'pending');
    }
  }
});

test('同报告表格推导的占比与直接披露冲突时也保留双边证据', () => {
  const bundle = automatic(), report = bundle.documents.find(item => item.kind === 'semiannual-report');
  report.text = report.fullText = report.text + '\n' + revenueTable.replaceAll('镜片', '汽车扬声器');
  const result = evaluateCompanyEvidence(bundle, query(config({ scope: 'segment' })), NOW);
  assert.equal(result.status, 'pending');
  const row = result.industryReview.rows[0];
  assert.equal(row.revenueSharePct, null); assert.equal(row.revenueShareValues[0], 35);
  assert.ok(row.revenueShareValues[1] > 82 && row.revenueShareValues[1] < 83);
  assert.ok(row.records.some(record => record.derivation && record.amount && record.totalRevenue));
});

test('同期细分营收占比冲突不受正文或证据顺序影响，保留所有原始值', () => {
  for (const shares of [[35, 20], [20, 35]]) {
    for (const input of [{ conditions: [], leadership: 'segmentLeader', minSegmentRevenuePct: 30 }, query(config({ scope: 'segment' }))]) {
      const fromText = evaluateCompanyEvidence(automatic(1, shares), input, NOW);
      const fromManual = evaluateEvidence(shares.map(revenueSharePct => manual('segmentRank', { revenueSharePct })), input, NOW);
      for (const result of [fromText, fromManual]) {
        assert.equal(result.status, 'pending'); assert.match(result.checks[0].reason, /占比冲突/);
      }
      if (input.industry) {
        assert.deepEqual(fromText.industryReview.rows[0].revenueShareValues, [20, 35]);
        assert.equal(fromText.industryReview.rows[0].revenueSharePct, null);
        assert.deepEqual(fromManual.industryReview.rows.map(row => row.revenueSharePct), shares);
      }
    }
    // The independent main branch can still satisfy an explicitly chosen OR.
    assert.equal(evaluateCompanyEvidence(automatic(1, shares), query(config()), NOW).status, 'pass');
  }
});

test('原文失效、缺失原始证据或手工记录畸形不能显示行业通过，也不能伪造零排名', () => {
  const input = query(config()), bundle = automatic(); bundle.documents[1].complete = false;
  const sourcePending = evaluateCompanyEvidence(bundle, input, NOW);
  assert.equal(sourcePending.status, 'pending'); assert.equal(sourcePending.industryReview.status, 'pending');
  assert.deepEqual(sourcePending.industryReview.rows, []); assert.ok(sourcePending.industryReview.reason);
  const missing = evaluateEvidence([], input, NOW);
  assert.equal(missing.industryReview.status, 'pending'); assert.deepEqual(missing.industryReview.rows, []);
  const invalid = evaluateEvidence([manual('mainRank'), manual('mainRank', { rank: '1' })], input, NOW);
  assert.equal(invalid.industryReview.status, 'pending'); assert.ok(invalid.industryReview.rows.every(row => row.status === 'pending'));
});
