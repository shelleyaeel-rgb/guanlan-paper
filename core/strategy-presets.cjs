const { defaults, validate, parseDescription } = require('./screener.cjs');
const { LONG_FINANCE_RULES, LONG_FINANCE_POLICY_NOTE } = require('./strategy-profiles.cjs');

// Indicator rules are editable. All presets enforce notice checks; short horizons also check current market risk.
const STRATEGY_PRESETS = [
  {
    id: 'ultra-short',
    name: '超短线 · 隔夜观察',
    horizon: '隔夜至 3 个交易日观察',
    summary: '以完整日线的短期动量配合成交活跃度，筛选隔夜观察候选；指标可调整，当日行情与近期公告检查固定执行。',
    entryNotes: '观察短均线上行与放量，另行检查买入时点、盘口数量及卖出安排；匹配条件不代表可立即开仓。',
    limitations: '当日跌幅达到 5% 或行情无法核验时排除；近期敏感公告或公告获取不完整时列为待核验，不进入观察候选。5% 是产品风控阈值，并非交易所规则或收益保证。普通 A 股买入当日不可卖出，隔夜跳空或跌停可能无法按计划退出；历史快照不支持本检查。',
    riskPolicy: '当日跌幅达到 5% 排除；过去 14 天敏感公告及资料不完整待核验。风险检查不随指标删除而取消。',
    rules: [
      { field: 'close', op: 'gt', valueField: 'ma5' },
      { field: 'ma5', op: 'gt', valueField: 'previousMa5' },
      { field: 'ma5', op: 'gt', valueField: 'ma20' },
      { field: 'macd', op: 'gt', value: 0 },
      { field: 'rsi', op: 'gte', value: 50 },
      { field: 'rsi', op: 'lte', value: 75 },
      { field: 'dailyVolumeRatio', op: 'gte', value: 1.2 },
      { field: 'dailyVolumeRatio', op: 'lte', value: 3 },
      { field: 'amount', op: 'gte', value: 2 },
      { field: 'turnover', op: 'gte', value: 2 },
      { field: 'turnover', op: 'lte', value: 15 }
    ]
  },
  {
    id: 'short',
    name: '短线 · 动量跟踪',
    horizon: '约 3–10 个交易日观察',
    summary: '以短中期均线、动量与成交额筛选短线跟踪候选；指标可调整，当日行情与近期公告检查固定执行。',
    entryNotes: '观察价格保持在短均线上方及中期均线上行，另行评估回撤空间、交易成本与仓位。',
    limitations: '技术指标使用完整未复权日线，不能代表当日走势。当日跌幅达到 5% 或行情无法核验时排除；近期敏感公告或公告获取不完整时列为待核验，不进入观察候选。5% 是产品风控阈值，并非交易所规则或收益保证。候选仍需在买卖计划中重新校验；历史快照不支持本检查。',
    riskPolicy: '当日跌幅达到 5% 排除；过去 14 天敏感公告及资料不完整待核验。风险检查不随指标删除而取消。',
    rules: [
      { field: 'close', op: 'gte', valueField: 'ma5' },
      { field: 'ma5', op: 'gt', valueField: 'ma20' },
      { field: 'ma20', op: 'gt', valueField: 'previousMa20' },
      { field: 'macd', op: 'gt', value: 0 },
      { field: 'rsi', op: 'gte', value: 45 },
      { field: 'rsi', op: 'lte', value: 75 },
      { field: 'dailyVolumeRatio', op: 'gte', value: 1 },
      { field: 'amount', op: 'gte', value: 1 }
    ]
  },
  {
    id: 'swing',
    name: '波段 · 趋势预筛',
    horizon: '数日至数周观察',
    summary: '沿用现有波段开仓判断中的日线趋势条件，快速缩小候选范围；指标可调整，近期公告检查固定执行。',
    entryNotes: 'MA20 上行并高于 MA60，收盘不低于 MA20，MACD 柱为正，RSI 40–75，日量比不低于 0.6。',
    limitations: '技术预筛另加近期公告检查；敏感公告或公告资料不完整时不进入观察候选，标题规则通过也不代表没有重大风险。未纳入回踩价区、盘中确认、盘口流动性、费用滑点、风险预算及盈亏比。筛选通过不等于波段开仓校验通过；历史快照不支持公告检查。',
    riskPolicy: '过去 14 天敏感公告及资料不完整待核验，不进入观察候选。公告检查不随指标删除而取消。',
    rules: [
      { field: 'ma20', op: 'gt', valueField: 'previousMa20' },
      { field: 'ma20', op: 'gt', valueField: 'ma60' },
      { field: 'close', op: 'gte', valueField: 'ma20' },
      { field: 'macd', op: 'gt', value: 0 },
      { field: 'rsi', op: 'gte', value: 40 },
      { field: 'rsi', op: 'lte', value: 75 },
      { field: 'dailyVolumeRatio', op: 'gte', value: 0.6 }
    ]
  },
  {
    id: 'long',
    name: '长线 · 质量估值',
    horizon: '数月至一年以上研究',
    summary: '结合最近完整年度 ROE、最新累计盈利、负债、增长与现金流，以及正估值区间，筛选长期研究候选；预筛指标可调整，近期公告检查固定执行。',
    entryNotes: '在财务筛选基础上继续研究商业模式、治理、行业差异与估值合理性；筛选条件本身不是持有期限或收益预测。',
    limitations: `默认 ROE 门槛使用最近完整年度加权 ROE，季度累计 ROE 仅观察且不简单年化；扣非利润同比增长与实际金额盈利分别判断。PE 为动态口径而非 TTM，统一负债与估值阈值不适合所有行业。${LONG_FINANCE_POLICY_NOTE}历史财报不能抵消新事件风险；敏感公告或公告资料不完整时不进入观察候选，标题规则通过也不代表没有重大风险。建仓前仍需通过长线买卖计划校验；历史快照不支持公告检查。`,
    riskPolicy: '过去 14 天敏感公告及资料不完整待核验，不进入观察候选。公告检查不随指标删除而取消。',
    rules: [
      ...LONG_FINANCE_RULES.map(({ field, op, value }) => ({ field, op, value })),
      { field: 'pe', op: 'gt', value: 0 },
      { field: 'pe', op: 'lte', value: 30 },
      { field: 'pb', op: 'gt', value: 0 },
      { field: 'pb', op: 'lte', value: 4 }
    ]
  }
];

// A result may be edited freely without changing future selections or another user's query.
for (const preset of STRATEGY_PRESETS) {
  for (const rule of preset.rules) Object.freeze(rule);
  Object.freeze(preset.rules);
  Object.freeze(preset);
}
Object.freeze(STRATEGY_PRESETS);

function composeStrategyQuery(strategyId, personalQuery = defaults()) {
  const personal = validate(personalQuery);
  if (strategyId == null || strategyId === '') return personal;
  const preset = STRATEGY_PRESETS.find(item => item.id === strategyId);
  if (!preset) throw Error('所选投资策略不存在，请重新选择');
  // Deduplicate before the 30-condition cap; validate still checks contradictions in the union.
  const rules = [...new Map([...preset.rules, ...personal.rules].map(rule => [JSON.stringify(rule), { ...rule }])).values()];
  return validate({ ...personal, rules });
}

function parseStrategyDescription(input) {
  const parsed = parseDescription(typeof input === 'string' ? input : input?.text);
  // The original text-only flow replaces its query; strategy mode explicitly supplies a base.
  if (typeof input === 'string') return parsed;
  const base = validate(input.baseQuery), text = input.text.normalize('NFKC');
  const rules = [...new Map([...base.rules, ...parsed.query.rules].map(rule => [JSON.stringify(rule), rule])).values()];
  let evidence = base.evidence || parsed.query.evidence;
  if (base.evidence && parsed.query.evidence) {
    const previous = base.evidence, added = parsed.query.evidence;
    if ((previous.industry || added.industry) && (previous.leadership || added.leadership
      || previous.industry && added.industry && JSON.stringify(previous.industry) !== JSON.stringify(added.industry))) throw Error('行业数值条件与新增行业标签不能隐式合并，请在行业条件中明确选择');
    if (previous.leadership && added.leadership && previous.leadership !== added.leadership && previous.leadership !== 'either' && added.leadership !== 'either') throw Error('已有与新增行业地位条件要求两条路径同时满足，当前界面仅支持单一路径或二选一；请在证据条件中明确选择');
    const leadership = previous.leadership === 'either' ? (added.leadership || previous.leadership) : added.leadership === 'either' ? (previous.leadership || added.leadership) : previous.leadership || added.leadership;
    evidence = { conditions: [...new Set([...previous.conditions, ...added.conditions])], leadership, minSegmentRevenuePct: Math.max(previous.minSegmentRevenuePct, added.minSegmentRevenuePct),
      ...(previous.industry || added.industry ? { industry: previous.industry || added.industry } : {}) };
  }
  const query = validate({ ...base,
    scope: /自选|全市场|(?:全部|沪深)?\s*A\s*股/i.test(text) ? parsed.query.scope : base.scope,
    boards: parsed.query.boards.length ? parsed.query.boards : base.boards,
    excludeST: base.excludeST || parsed.query.excludeST,
    rules, ...(evidence ? { evidence } : {})
  });
  // Keep text rules even when shared with the strategy, so they remain personal on switching.
  return { ...parsed, addedRules: parsed.query.rules, ...(parsed.query.evidence ? { addedEvidence: parsed.query.evidence } : {}), query };
}

module.exports = { STRATEGY_PRESETS, composeStrategyQuery, parseStrategyDescription };
