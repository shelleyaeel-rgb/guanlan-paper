const test = require('node:test');
const assert = require('node:assert/strict');
const { composeAgencySelectionQuery, agencySelectionPolicy, isTechnicalSelectionRule, technicalEntryQuery } = require('../core/agency-selection.cjs');
const { composeStrategyQuery } = require('../core/strategy-presets.cjs');
const { classifyScreenRow, defaults } = require('../core/screener.cjs');

const IDS = ['ultra-short', 'short', 'swing', 'long'];
const candidate = (extra = {}) => ({
  symbol: 'sh600001', name: '隔离候选', board: 'sh', isST: false,
  close: 10.05, ma5: 10.02, previousMa5: 10.01, ma20: 10, previousMa20: 9.99, ma60: 9.5, previousMa60: 9.49,
  macd: 0.1, rsi: 55, dailyVolumeRatio: 1.5, amount: 3, turnover: 5,
  atrPct14: 2, biasMa5Pct: 0.3, biasMa20Pct: 0.5, biasMa60Pct: 5.8, ma20Change5Pct: 0.4,
  annualRoeLatest: 12, debtRatio: 40, revenueYoY: 10, adjustedProfitYoY: 8, latestAdjustedProfit: 2, operatingCash: 5,
  annualProfitableYears: 3, annualRoeAverage: 12, annualCashPositiveYears: 3, annualCashSum: 9, pe: 20, pb: 2,
  ...extra
});
const classify = (id, extra, options) => classifyScreenRow(candidate(extra), composeAgencySelectionQuery(id, defaults()), options).status;

test('自动技术池保留原策略技术条件且普通选股不被改写', () => {
  for (const id of IDS) {
    const ordinary = composeStrategyQuery(id), before = structuredClone(ordinary);
    const selected = composeAgencySelectionQuery(id, defaults());
    assert.equal(classify(id), 'pass', id);
    for (const rule of ordinary.rules.filter(isTechnicalSelectionRule)) assert.ok(selected.rules.some(item => JSON.stringify(item) === JSON.stringify(rule)), `${id} ${rule.field}`);
    assert.deepEqual(composeStrategyQuery(id), before);
    assert.ok(!ordinary.rules.some(rule => rule.field === 'atrPct14'));
  }
});


test('波动边界按策略区分，零波动不授予候选资格，缺失不当成零', () => {
  for (const [id, maximum] of [['ultra-short', 6], ['short', 5], ['swing', 4], ['long', 3]]) {
    assert.equal(classify(id, { atrPct14: maximum }), 'pass', id);
    assert.equal(classify(id, { atrPct14: maximum + 0.001 }), 'failed', id);
    assert.equal(classify(id, { atrPct14: 0 }), 'failed', id);
    assert.equal(classify(id, { atrPct14: null }), 'pending', id);
  }
});

test('追高约束使用各自均线偏离上限，并非对负偏离取绝对值', () => {
  for (const [id, field, maximum] of [['ultra-short', 'biasMa5Pct', 6], ['short', 'biasMa5Pct', 6], ['swing', 'biasMa20Pct', 8], ['long', 'biasMa60Pct', 12]]) {
    assert.equal(classify(id, { [field]: maximum }), 'pass', id);
    assert.equal(classify(id, { [field]: maximum + 0.001 }), 'failed', id);
    assert.equal(classify(id, { [field]: -maximum - 1 }), 'pass', id);
    assert.equal(classify(id, { [field]: null }), 'pending', id);
  }
});

test('短线和波段要求五日中期均线持续改善，超短和长线沿用各自趋势定义', () => {
  for (const id of ['short', 'swing']) {
    assert.equal(classify(id, { ma20Change5Pct: 0.001 }), 'pass', id);
    for (const ma20Change5Pct of [0, -0.001]) assert.equal(classify(id, { ma20Change5Pct }), 'failed', id);
    assert.equal(classify(id, { ma20Change5Pct: null }), 'pending', id);
  }
  for (const id of ['ultra-short', 'long']) assert.equal(classify(id, { ma20Change5Pct: -1 }), 'pass', id);
});

test('四类策略均有成交额下限，盘中累计不足延期但完整值明确失败', () => {
  for (const [id, minimum] of [['ultra-short', 2], ['short', 1], ['swing', 1], ['long', 0.5]]) {
    assert.equal(classify(id, { amount: minimum }), 'pass', id);
    assert.equal(classify(id, { amount: minimum - 0.001 }), 'failed', id);
    assert.equal(classify(id, { amount: minimum - 0.001 }, { deferMinimumFields: ['amount'] }), 'pending', id);
    assert.equal(classify(id, { amount: null }), 'pending', id);
  }
});



test('自动池组合保留个人条件和范围，冲突拒绝，返回值不会污染后续查询', () => {
  const personal = { ...defaults(), scope: 'watchlist', boards: ['sh'], excludeST: true, rules: [{ field: 'amount', op: 'gte', value: 4 }] };
  const before = structuredClone(personal), query = composeAgencySelectionQuery('swing', personal);
  assert.equal(query.scope, 'watchlist'); assert.deepEqual(query.boards, ['sh']); assert.equal(query.excludeST, true);
  assert.equal(classifyScreenRow(candidate(), query).status, 'failed');
  assert.equal(classifyScreenRow(candidate({ amount: 4 }), query).status, 'pass');
  query.rules[0].field = 'price'; query.boards.push('sz');
  assert.deepEqual(personal, before);
  assert.equal(classifyScreenRow(candidate({ amount: 4 }), composeAgencySelectionQuery('swing', personal)).status, 'pass');
  assert.throws(() => composeAgencySelectionQuery('swing', { ...defaults(), rules: [{ field: 'atrPct14', op: 'gt', value: 5 }] }), /矛盾/);
});

test('公开技术政策逐项可读并标明产品阈值未经验证，策略顺序及返回快照独立', () => {
  const policy = agencySelectionPolicy();
  assert.equal(policy.version, 3); assert.equal(policy.name, '技术精选'); assert.equal(policy.researchStatus, 'disabled');
  assert.equal(policy.activeLimitPerGroup, 20); assert.match(policy.limitations, /不足 20 只不补齐/);
  assert.deepEqual(policy.strategies.map(item => item.id), IDS);
  for (const strategy of policy.strategies) {
    assert.ok(strategy.name); assert.ok(strategy.rules.length); assert.ok(strategy.labels.length);
    assert.ok(strategy.labels.every(label => typeof label === 'string' && label.trim()));
  }
  assert.match(JSON.stringify(policy), /产品/); assert.match(JSON.stringify(policy), /未经|未完成|尚未/);
  const expected = structuredClone(policy);
  policy.strategies[0].rules[0].value = -100; policy.strategies.reverse();
  assert.deepEqual(agencySelectionPolicy(), expected);
});

test('自动技术条件移除全部财务估值与旧研究配置，普通预设仍保留原用途', () => {
  const removed = ['latestAdjustedProfit', 'annualRoeLatest', 'revenueYoY', 'pe', 'pb', 'marketCap', 'floatCap'];
  const input = { ...defaults(), rules: [...removed.map(field => ({ field, op: 'gt', value: 999 })), { field: 'amount', op: 'gte', value: 1 }],
    evidence: { invalidLegacy: true }, research: { invalidLegacy: true }, performance: { invalidLegacy: true }, source: { kind: 'manual' } };
  const before = structuredClone(input), clean = technicalEntryQuery(input);
  assert.deepEqual(clean.rules, [{ field: 'amount', op: 'gte', value: 1 }]); assert.deepEqual(clean.source, input.source);
  for (const key of ['evidence', 'research', 'performance']) assert.equal(clean[key], undefined);
  for (const id of IDS) {
    const query = composeAgencySelectionQuery(id, input);
    assert.ok(query.rules.every(isTechnicalSelectionRule));
    assert.equal(classifyScreenRow(candidate(Object.fromEntries(removed.map(field => [field, null]))), query).status, 'pass');
  }
  assert.deepEqual(input, before); assert.ok(composeStrategyQuery('long').rules.some(rule => rule.field === 'annualRoeLatest'));
});
