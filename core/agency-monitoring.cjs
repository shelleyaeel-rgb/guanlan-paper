'use strict';
const { createEntryConditions, automaticEntryConditions } = require('./entry-conditions.cjs');
const { financialQualityRules } = require('./screener.cjs');
const { TECHNICAL_ENTRY_POLICY } = require('./strategy-profiles.cjs');

const SELECTION_MODES = ['strategy', 'strict'];
const MONITORING_STATUSES = ['eligible', 'holding', 'paused', 'data', 'risk', 'funds', 'conditions'];

// Saved v1/v2 pool predicates must be identified using the templates that
// generated them. Current presets evolve: using them here would remove new
// matching personal rules and retain obsolete generated ones during migration.
const LEGACY_POOL_STRATEGY_RULES = {
  'ultra-short': [
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
  ],
  short: [
    { field: 'close', op: 'gte', valueField: 'ma5' },
    { field: 'ma5', op: 'gt', valueField: 'ma20' },
    { field: 'ma20', op: 'gt', valueField: 'previousMa20' },
    { field: 'macd', op: 'gt', value: 0 },
    { field: 'rsi', op: 'gte', value: 45 },
    { field: 'rsi', op: 'lte', value: 75 },
    { field: 'dailyVolumeRatio', op: 'gte', value: 1 },
    { field: 'amount', op: 'gte', value: 1 }
  ],
  swing: [
    { field: 'ma20', op: 'gt', valueField: 'previousMa20' },
    { field: 'ma20', op: 'gt', valueField: 'ma60' },
    { field: 'close', op: 'gte', valueField: 'ma20' },
    { field: 'macd', op: 'gt', value: 0 },
    { field: 'rsi', op: 'gte', value: 40 },
    { field: 'rsi', op: 'lte', value: 75 },
    { field: 'dailyVolumeRatio', op: 'gte', value: 0.6 }
  ],
  long: [
    { field: 'annualRoeLatest', op: 'gte', value: 8 },
    { field: 'debtRatio', op: 'gte', value: 0 },
    { field: 'debtRatio', op: 'lte', value: 60 },
    { field: 'revenueYoY', op: 'gte', value: 0 },
    { field: 'adjustedProfitYoY', op: 'gte', value: 0 },
    { field: 'latestAdjustedProfit', op: 'gt', value: 0 },
    { field: 'operatingCash', op: 'gt', value: 0 },
    { field: 'pe', op: 'gt', value: 0 },
    { field: 'pe', op: 'lte', value: 30 },
    { field: 'pb', op: 'gt', value: 0 },
    { field: 'pb', op: 'lte', value: 4 }
  ]
};
for (const rules of Object.values(LEGACY_POOL_STRATEGY_RULES)) {
  for (const rule of rules) Object.freeze(rule);
  Object.freeze(rules);
}
Object.freeze(LEGACY_POOL_STRATEGY_RULES);

// Selection is a discovery step. Only an explicitly strict member carries a
// research qualification gate; a later ordinary scan cannot grant that gate.
function poolQualificationPending(agency, member) {
  if (!member) return false;
  if (agency.technicalTradingVersion === 1) return false;
  if (agency.version < 5) return !!agency.pool && (member.poolCheck?.status !== 'pass'
    || member.poolCheck.policyVersion !== agency.pool.policy.version);
  return member.selectionMode === 'strict' && (member.poolCheck?.status !== 'pass'
    || member.poolCheck.policyVersion !== 3 || member.poolCheck.screeningMode !== 'strict');
}

function migrateTechnicalTrading(state, now) {
  const agency = state.agency;
  if (agency.version !== 7) return;
  let changedMembers = 0;
  for (const group of agency.groups) for (const member of group.members) {
    const saved = member.entryConditions, next = automaticEntryConditions(saved, now);
    const changed = JSON.stringify(saved || null) !== JSON.stringify(next);
    if (changed && saved) member.legacyResearchConditions ||= structuredClone(saved);
    if (next) member.entryConditions = structuredClone(next);
    else delete member.entryConditions;
    if (changed || member.selectionMode === 'strict') changedMembers++;
    member.selectionMode = 'strategy';
  }
  // Preserve the completed scan as history. The scheduler distinguishes it
  // from a new scan using the result's own technical-policy marker.
  // Keep the old result and its matching policy together until a new technical
  // scan commits. Neither is used to restore disabled research conditions.
  agency.version = 8; agency.technicalTradingVersion = 1;
  agency.revision++; agency.poolAuthorizationRevision++;
  const message = `自动交易已切换纯行情技术规则：公告风险、财报及行业研究、财务估值条件全部停用；${changedMembers} 只成员的旧研究条件已留档。资金、持仓与原退出计划保留；公司行为仅用于持仓及历史权益处理，首次无权益候选按行情与日线核验价格基准。`;
  agency.migrationNotice = { ...(agency.migrationNotice || {}), kind: 'technical-trading-upgrade', time: new Date(now).toISOString(),
    changedMembers, message: agency.migrationNotice ? `${agency.migrationNotice.message}\n${message}` : message };
}

function validMonitoringCheck(value, { legacy = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !MONITORING_STATUSES.includes(value.status) || typeof value.reason !== 'string'
    || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) return false;
  if (legacy) return Object.keys(value).every(key => ['status', 'reason', 'checkedAt'].includes(key));
  // Unstamped checks remain readable so existing v7/v8 accounts can migrate.
  // An unknown future policy must not be accepted as the current policy.
  return value.entryPolicyVersion === undefined || value.entryPolicyVersion === TECHNICAL_ENTRY_POLICY.version;
}

function migrateMonitoringChecks(agency) {
  if (agency.version < 8) return;
  let changed = false;
  for (const group of agency.groups) for (const member of group.members) {
    const check = member.monitoringCheck;
    if (!check || check.entryPolicyVersion === TECHNICAL_ENTRY_POLICY.version) continue;
    // A result from the retired policy is history, including an old pass.
    // Keep one bounded record and wait for a real current-policy evaluation.
    member.legacyMonitoringCheck = { status: check.status, reason: check.reason, checkedAt: check.checkedAt };
    delete member.monitoringCheck;
    changed = true;
  }
  if (changed) agency.revision++;
}

function migrateMonitoring(agency, now) {
  let changed = 0;
  for (const group of agency.groups) for (const member of group.members) {
    member.selectionMode = 'strategy';
    const saved = member.entryConditions;
    if (saved?.source?.kind !== 'agency-pool' || ![1, 2].includes(saved.source.policyVersion)) continue;
    // Old pool snapshots mixed imposed common predicates with personal ones.
    // Keep the original for inspection, remove only known generated predicates,
    // and retain stricter/different personal rules and evidence requirements.
    member.legacyPoolConditions = structuredClone(saved);
    const generated = [...financialQualityRules(), ...(saved.source.selectedAt
      ? LEGACY_POOL_STRATEGY_RULES[group.id] || [] : [])];
    const imposed = new Set(generated.map(rule => JSON.stringify(rule)));
    const rules = saved.rules.filter(rule => !imposed.has(JSON.stringify(rule)));
    let evidence;
    if (saved.evidence) {
      const conditions = saved.evidence.conditions.filter(key => !['productOutlook', 'financialReview'].includes(key));
      const leadership = saved.evidence.leadership === 'either' ? null : saved.evidence.leadership;
      if (conditions.length || leadership) evidence = { ...saved.evidence, conditions, leadership: leadership || '' };
    }
    const next = createEntryConditions({ rules, excludeST: saved.excludeST, ...(evidence ? { evidence } : {}),
      source: { kind: 'agency-pool', policyVersion: 3, screeningMode: 'strategy', migratedFrom: saved.source.policyVersion } }, now);
    if (next) member.entryConditions = next;
    else delete member.entryConditions;
    changed++;
  }
  agency.version = 5; agency.monitoringVersion = 1; agency.revision++; agency.poolAuthorizationRevision++;
  if (agency.pool || changed) agency.migrationNotice = { kind: 'strategy-monitoring-upgrade', time: new Date(now).toISOString(), changedMembers: changed,
    message: '已升级为策略监控：加入自选后按各策略持续检查；旧候选池自动附加的共同财务、行业和产品研究门槛已移除，原条件留档。个人额外条件、资金、运行状态及持仓退出计划保留；严格研究可在筛选时另选。' };
}

function monitoringCheck(evaluation, { holding = false, paused = false } = {}, now = Date.now()) {
  const reasons = evaluation?.reasons || [], reason = reasons.join('；') || evaluation?.status || '等待下一轮检查';
  let status = 'conditions';
  if (holding) status = 'holding';
  else if (paused) status = 'paused';
  else if (evaluation?.buyable === true) status = 'eligible';
  else if (/资金不足|现金不足|可用资金|可用现金|持仓数量上限|仓位|风险预算|风险额度/.test(reason)) status = 'funds';
  else if (evaluation?.entryRisk?.status === 'blocked') status = 'risk';
  else if (/缺失|缺少|不足\s*61|日线不足|不完整|未获取|未就绪|尚未准备|等待后台|不可用|获取失败|下载|解析|时间未知|过期|超过.*分钟|超过.*秒|不是当日|待补齐|资料不足|来源.*无法|日期.*不一致/.test(reason)
    || ['等待数据', '等待有效行情'].includes(evaluation?.status)) status = 'data';
  else if (evaluation?.entryRisk?.status === 'unverified' || /公告|风险拦截|待对账|公司行为|除权|停牌|涨跌停|ST.*禁止/.test(reason)) status = 'risk';
  return { status, reason, checkedAt: new Date(now).toISOString(), entryPolicyVersion: TECHNICAL_ENTRY_POLICY.version };
}

module.exports = { SELECTION_MODES, MONITORING_STATUSES, poolQualificationPending, migrateMonitoring, migrateTechnicalTrading,
  validMonitoringCheck, migrateMonitoringChecks, monitoringCheck };
