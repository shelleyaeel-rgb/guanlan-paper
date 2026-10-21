const test = require('node:test');
const assert = require('node:assert/strict');
const { STRATEGY_PRESETS, composeStrategyQuery, parseStrategyDescription } = require('../core/strategy-presets.cjs');
const { defaults, validate, screen, parseDescription } = require('../core/screener.cjs');
const { Engine, initialState } = require('../core/engine.cjs');
const { evaluateEntry } = require('../core/strategy.cjs');

const row = (overrides = {}) => ({
  symbol: 'sh600001', name: '测试股票', board: 'sh', isST: false, timestamp: Date.parse('2026-09-29T10:00:00+08:00'),
  close: 10.05, ma5: 10.02, previousMa5: 10.01, ma20: 10, previousMa20: 9.99, ma60: 9.5,
  macd: 0.1, rsi: 55, dailyVolumeRatio: 1.5, amount: 3, turnover: 5,
  roe: 10, annualRoeLatest: 10, debtRatio: 40, revenueYoY: 10, profitYoY: 12, adjustedProfitYoY: 8, latestAdjustedProfit: 2, operatingCash: 5, pe: 20, pb: 2,
  ...overrides
});
const select = (strategyId, rows, personal = defaults()) => screen({ rows }, composeStrategyQuery(strategyId, personal)).rows;

test('四种周期模板可直接组成选股查询，默认候选均可被实际筛选', () => {
  assert.deepEqual(STRATEGY_PRESETS.map(preset => preset.id), ['ultra-short', 'short', 'swing', 'long']);
  for (const preset of STRATEGY_PRESETS) {
    for (const key of ['name', 'horizon', 'summary', 'entryNotes', 'limitations']) assert.ok(preset[key]);
    const query = composeStrategyQuery(preset.id);
    assert.deepEqual(validate(query), query);
    assert.deepEqual(select(preset.id, [row()]), [row()]);
  }
});

test('所有模板独立公告检查，只有短线模板说明5%行情阈值，指标查询不混入可删除风险条件', () => {
  for (const id of ['ultra-short', 'short', 'swing', 'long']) {
    const preset = STRATEGY_PRESETS.find(item => item.id === id);
    assert.match(preset.riskPolicy, /14/); assert.match(preset.riskPolicy, /不随指标删除/);
    if (['short', 'ultra-short'].includes(id)) { assert.match(preset.riskPolicy, /5%/); assert.match(preset.limitations, /产品风控阈值/); }
    else { assert.doesNotMatch(preset.riskPolicy, /5%/); assert.match(preset.limitations, /公告/); }
    assert.deepEqual(Object.keys(composeStrategyQuery(id)).sort(), ['boards', 'excludeST', 'rules', 'scope']);
  }
});

test('超短与短线同时要求日线动量及行情成交活跃，缺失指标不被视为命中', () => {
  const candidates = [row(), row({ amount: 1.5 }), row({ dailyVolumeRatio: 1.1 }), row({ close: 9.8 }), row({ amount: null }), row({ ma5: null }), row({ rsi: 80 })];
  assert.deepEqual(select('ultra-short', candidates), [candidates[0]]);
  assert.deepEqual(select('short', candidates), candidates.slice(0, 3));
});

test('波段筛选与现有开仓技术门槛一致，但通过预筛不等于进入回踩价区', () => {
  const now = new Date('2026-09-29T10:00:00+08:00'), engine = new Engine(initialState(100000), () => now);
  const changes = [{}, { ma20: 9.99 }, { ma60: 10 }, { close: 9.99 }, { macd: 0 }, { rsi: 39.9 }, { rsi: 75.1 }, { dailyVolumeRatio: 0.59 }, { close: 10, rsi: 40, dailyVolumeRatio: 0.6 }, { rsi: 75 }];
  for (const change of changes) {
    const candidate = row(change);
    const q = { symbol: candidate.symbol, price: 10.1, prevClose: candidate.close, open: 10, low: 10, high: 10.2, volume: 100000,
      bid: 10.09, ask: 10.8, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05, timestamp: now.getTime(), date: '2026-09-29' };
    const snapshot = { fetchedAt: now.getTime(), notices: { symbol: candidate.symbol, section: 'notices', source: '东方财富',
      status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } }, technical: { ...candidate, asOf: '2026-09-28',
      volumeRatio: candidate.dailyVolumeRatio, trend: candidate.close >= candidate.ma20 && candidate.ma20 > candidate.ma60 && candidate.ma20 > candidate.previousMa20,
      entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5 } };
    const result = evaluateEntry(engine, candidate.symbol, q, snapshot);
    assert.equal(select('swing', [candidate]).length === 1, result.status === '等待回踩', JSON.stringify(change));
    assert.equal(result.buyable, false);
  }
});

test('长线同时检查财务质量和正估值，负估值、负现金流、财务缺失不会入选', () => {
  const eligible = row({ roe: 1, annualRoeLatest: 8, debtRatio: 60, revenueYoY: 0, adjustedProfitYoY: 0, pe: 30, pb: 4 });
  const rejected = [{ annualRoeLatest: 7.99 }, { debtRatio: -1 }, { debtRatio: 60.01 }, { revenueYoY: -1 }, { adjustedProfitYoY: -1 }, { latestAdjustedProfit: 0 }, { latestAdjustedProfit: -1 }, { latestAdjustedProfit: null }, { operatingCash: 0 }, { operatingCash: -1 }, { pe: -5 }, { pe: 0 }, { pe: 30.01 }, { pb: -1 }, { pb: 0 }, { pb: 4.01 }, { annualRoeLatest: null }, { operatingCash: null }].map(change => row(change));
  assert.deepEqual(select('long', [eligible, ...rejected]), [eligible]);
});

test('长线默认年度ROE与盈利金额规则和执行模板一致，个人累计ROE条件仍独立叠加', () => {
  const { LONG_FINANCE_RULES } = require('../core/strategy-profiles.cjs');
  const preset = STRATEGY_PRESETS.find(item => item.id === 'long');
  assert.deepEqual(preset.rules.filter(rule => !['pe', 'pb'].includes(rule.field)), LONG_FINANCE_RULES.map(({ field, op, value }) => ({ field, op, value })));
  assert.match(preset.limitations, /产品模板.*不是会计标准/); assert.match(preset.limitations, /预筛条件不会改写内置开仓门槛/);
  const personal = { ...defaults(), rules: [{ field: 'roe', op: 'gte', value: 8 }] };
  const composed = composeStrategyQuery('long', personal);
  assert.ok(composed.rules.some(rule => rule.field === 'annualRoeLatest')); assert.ok(composed.rules.some(rule => rule.field === 'roe'));
  const candidate = row({ annualRoeLatest: 12, roe: 2 });
  assert.equal(select('long', [candidate]).length, 1); assert.equal(select('long', [candidate], personal).length, 0);
});

test('个人基本面条件按 AND 叠加，同时保留范围、板块及 ST 排除', () => {
  const personal = { scope: 'watchlist', boards: ['sh', 'sz'], excludeST: true, rules: [{ field: 'debtRatio', op: 'lt', value: 50 }] };
  const candidates = [row(), row({ symbol: 'sh600002', debtRatio: 55 }), row({ symbol: 'sh600003', amount: 0.5 }), row({ symbol: 'sh600004', isST: true }), row({ symbol: 'sh600005' }), row({ symbol: 'sh688001', board: 'star' })];
  const query = composeStrategyQuery('short', personal);
  assert.equal(query.scope, 'watchlist'); assert.deepEqual(query.boards, ['sh', 'sz']); assert.equal(query.excludeST, true);
  assert.deepEqual(screen({ rows: candidates }, query, ['sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh688001']).rows, [candidates[0]]);
});

test('策略切换保留个人条件且不会夹带上一策略条件，取消策略保留个人条件', () => {
  const personal = { ...defaults(), rules: [{ field: 'profitYoY', op: 'gt', value: 10 }] };
  const before = structuredClone(personal);
  const short = composeStrategyQuery('short', personal), long = composeStrategyQuery('long', personal);
  assert.ok(short.rules.some(rule => rule.field === 'amount'));
  assert.ok(!long.rules.some(rule => rule.field === 'amount'));
  assert.ok(long.rules.some(rule => rule.field === 'profitYoY'));
  assert.deepEqual(composeStrategyQuery('', personal), personal);
  assert.deepEqual(personal, before);
});

test('合并相同规则会去重，矛盾的数值和指标比较会明确拒绝', () => {
  const personal = { ...defaults(), rules: [{ field: 'rsi', op: 'gte', value: 45 }, { field: 'amount', op: 'gte', value: 1 }] };
  assert.equal(composeStrategyQuery('short', personal).rules.length, composeStrategyQuery('short').rules.length);
  assert.throws(() => composeStrategyQuery('short', { ...defaults(), rules: [{ field: 'rsi', op: 'lt', value: 45 }] }), /矛盾/);
  assert.throws(() => composeStrategyQuery('short', { ...defaults(), rules: [{ field: 'ma20', op: 'gte', valueField: 'ma5' }] }), /矛盾/);
  assert.throws(() => composeStrategyQuery('long', { ...defaults(), rules: [{ field: 'pe', op: 'lt', value: 0 }] }), /矛盾/);
});

test('合并查询可独立调整而不修改模板、个人输入或其他查询，未知模板拒绝执行', () => {
  const personal = { ...defaults(), boards: ['sh'], rules: [{ field: 'pe', op: 'lt', value: 25 }] };
  const before = structuredClone({ personal, presets: STRATEGY_PRESETS });
  const first = composeStrategyQuery('short', personal), second = composeStrategyQuery('short', personal);
  first.rules[0].field = 'price'; first.rules.at(-1).value = 100; first.rules.push({ field: 'pb', op: 'lt', value: 2 }); first.boards.push('star');
  assert.deepEqual({ personal, presets: STRATEGY_PRESETS }, before);
  assert.deepEqual(second, composeStrategyQuery('short', personal));
  for (const id of ['missing', '__proto__', {}, []]) assert.throws(() => composeStrategyQuery(id), /不存在/);
  assert.throws(() => composeStrategyQuery('short', { ...defaults(), rules: [{ field: 'unknown', op: 'gt', value: 1 }] }), /无效/);
});

test('文字接口兼容旧字符串，策略对象输入将基本面条件追加到原有查询', () => {
  const text = 'ROE不低于8%，资产负债率不超过50%';
  assert.deepEqual(parseStrategyDescription(text), parseDescription(text));
  const baseQuery = composeStrategyQuery('short'), before = structuredClone(baseQuery);
  const result = parseStrategyDescription({ text, baseQuery });
  assert.equal(result.query.rules.length, before.rules.length + 2);
  assert.deepEqual(result.addedRules, parseDescription(text).query.rules);
  assert.ok(result.notes.some(note => /报告期|年化/.test(note)));
  const candidates = [row(), row({ roe: 7 }), row({ debtRatio: 51 }), row({ amount: 0.5 })];
  assert.deepEqual(screen({ rows: candidates }, result.query).rows, [candidates[0]]);
  assert.deepEqual(baseQuery, before);
});

test('追加文字继承范围、板块和 ST 设置，只有明确提及的范围及板块会覆盖', () => {
  const baseQuery = { scope: 'watchlist', boards: ['star'], excludeST: true, rules: [{ field: 'price', op: 'gt', value: 1 }] };
  const inherited = parseStrategyDescription({ text: '市盈率小于20', baseQuery }).query;
  assert.equal(inherited.scope, 'watchlist'); assert.deepEqual(inherited.boards, ['star']); assert.equal(inherited.excludeST, true);
  const explicit = parseStrategyDescription({ text: '全市场，主板，ROE大于5%', baseQuery }).query;
  assert.equal(explicit.scope, 'all'); assert.deepEqual(explicit.boards, ['sh', 'sz']); assert.equal(explicit.excludeST, true);
  assert.equal(parseStrategyDescription({ text: 'Ａ股，市净率小于3', baseQuery }).query.scope, 'all');
  assert.equal(parseStrategyDescription({ text: '我的自选，排除ST，ROE大于5%', baseQuery: defaults() }).query.excludeST, true);
  assert.equal(parseStrategyDescription({ text: '我的自选，ROE大于5%', baseQuery: defaults() }).query.scope, 'watchlist');
});

test('追加的重复规则只执行一次，但仍属于个人条件且切换后保留', () => {
  const baseQuery = composeStrategyQuery('short'), result = parseStrategyDescription({ text: '成交额不低于1亿元，成交额不低于1亿元', baseQuery });
  assert.deepEqual(result.query, baseQuery);
  assert.deepEqual(result.addedRules, [{ field: 'amount', op: 'gte', value: 1 }]);
  assert.ok(composeStrategyQuery('long', { ...defaults(), rules: result.addedRules }).rules.some(rule => rule.field === 'amount'));
  result.addedRules[0].value = 9;
  assert.equal(result.query.rules.find(rule => rule.field === 'amount').value, 1);
  assert.equal(baseQuery.rules.find(rule => rule.field === 'amount').value, 1);
});

test('追加冲突或无法识别的文字原子失败，不修改已有查询与模板', () => {
  const baseQuery = composeStrategyQuery('short'), before = structuredClone({ baseQuery, presets: STRATEGY_PRESETS });
  for (const text of ['RSI小于45', 'MA20不低于MA5', 'ROE大于8%，盈利质量非常好']) {
    assert.throws(() => parseStrategyDescription({ text, baseQuery }), /矛盾|不支持|无法确定/);
    assert.deepEqual({ baseQuery, presets: STRATEGY_PRESETS }, before);
  }
  for (const input of [null, undefined, 10, {}, { text: '市盈率小于20' }, { text: '市盈率小于20', baseQuery: null }]) assert.throws(() => parseStrategyDescription(input));
});

test('合并先去重再限制条件数量，达到上限时拒绝新条件且保留原查询', () => {
  const baseQuery = { ...defaults(), rules: Array.from({ length: 30 }, (_, i) => ({ field: 'price', op: 'gte', value: i + 1 })) };
  const before = structuredClone(baseQuery);
  assert.equal(parseStrategyDescription({ text: '股价不低于30元', baseQuery }).query.rules.length, 30);
  assert.throws(() => parseStrategyDescription({ text: '股价不低于31元', baseQuery }), /格式无效/);
  assert.deepEqual(baseQuery, before);
});
