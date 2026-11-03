'use strict';
const { FIELDS, defaults, validate, describe } = require('./screener.cjs');
const { STRATEGY_PRESETS } = require('./strategy-presets.cjs');
const { ACTIVE_CANDIDATE_LIMIT } = require('./agency-capacity.cjs');

function isTechnicalSelectionRule(rule) {
  return !!rule && [rule.field, rule.valueField].filter(Boolean)
    .every(field => FIELDS[field]?.source !== 'finance' && !['pe', 'pb', 'marketCap', 'floatCap'].includes(field));
}

// Saved conditions remain readable, but automatic trading no longer evaluates
// research or financial conditions. Keep unrelated metadata and personal market
// rules so migrations do not silently replace the user's technical choices.
function technicalEntryQuery(input = defaults()) {
  if (!input || typeof input !== 'object') return input;
  const { evidence, research, performance, ...query } = structuredClone(input);
  if (Array.isArray(query.rules)) query.rules = query.rules.filter(isTechnicalSelectionRule);
  return query;
}

// Admission thresholds for the automatic pool, not fitted return forecasts.
// These do not rewrite execution profiles or existing positions' exit plans.
const AGENCY_SELECTION_RULES = {
  'ultra-short': [
    { field: 'atrPct14', op: 'gt', value: 0 },
    { field: 'atrPct14', op: 'lte', value: 6 },
    { field: 'biasMa5Pct', op: 'lte', value: 6 }
  ],
  short: [
    { field: 'atrPct14', op: 'gt', value: 0 },
    { field: 'atrPct14', op: 'lte', value: 5 },
    { field: 'biasMa5Pct', op: 'lte', value: 6 },
    { field: 'ma20Change5Pct', op: 'gt', value: 0 }
  ],
  swing: [
    { field: 'amount', op: 'gte', value: 1 },
    { field: 'atrPct14', op: 'gt', value: 0 },
    { field: 'atrPct14', op: 'lte', value: 4 },
    { field: 'biasMa20Pct', op: 'lte', value: 8 },
    { field: 'ma20Change5Pct', op: 'gt', value: 0 }
  ],
  long: [
    { field: 'amount', op: 'gte', value: 0.5 },
    { field: 'atrPct14', op: 'gt', value: 0 },
    { field: 'atrPct14', op: 'lte', value: 3 },
    { field: 'biasMa60Pct', op: 'lte', value: 12 }
  ]
};
for (const rules of Object.values(AGENCY_SELECTION_RULES)) {
  rules.forEach(Object.freeze); Object.freeze(rules);
}
Object.freeze(AGENCY_SELECTION_RULES);

function composeAgencySelectionQuery(id, commonQuery = defaults()) {
  if (!Object.hasOwn(AGENCY_SELECTION_RULES, id)) throw Error('自动候选策略不存在');
  const base = validate(technicalEntryQuery(commonQuery));
  const preset = STRATEGY_PRESETS.find(item => item.id === id);
  const rules = [...new Map([...preset.rules.filter(isTechnicalSelectionRule), ...base.rules, ...AGENCY_SELECTION_RULES[id]]
    .map(rule => [JSON.stringify(rule), { ...rule }])).values()];
  return validate({ ...base, rules });
}

function agencySelectionPolicy() {
  return {
    version: 3, name: '技术精选', researchStatus: 'disabled', activeLimitPerGroup: ACTIVE_CANDIDATE_LIMIT,
    limitations: `以下为尚未回测及样本外验证的产品筛选阈值，不代表胜率或收益提升。各策略独立满足全部条件后才参与活跃名额排序，不足 ${ACTIVE_CANDIDATE_LIMIT} 只不补齐。`,
    basis: '成交额使用真实行情累计金额，盘中尚未达到下限列为待核验；不能解释为历史日均成交额。波动与乖离使用最近完整未复权日线，ATR 为 14 根真实波幅的简单均值除以收盘价；MA20 五日变化比较五根完整日线前的均线。公告风险、公司及产品研究、行业研究、财务和估值条件均已停用，不代表这些项目核验通过。',
    strategies: STRATEGY_PRESETS.map(preset => {
      const query = composeAgencySelectionQuery(preset.id);
      return { id: preset.id, name: preset.name.split(' · ')[0], rules: query.rules, labels: describe(query).slice(1) };
    })
  };
}

module.exports = { AGENCY_SELECTION_RULES, isTechnicalSelectionRule, technicalEntryQuery, composeAgencySelectionQuery, agencySelectionPolicy };
