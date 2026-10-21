'use strict';
const { createEntryConditions } = require('./entry-conditions.cjs');
const { financialQualityRules } = require('./screener.cjs');
const { STRATEGY_PRESETS } = require('./strategy-presets.cjs');

const SELECTION_MODES = ['strategy', 'strict'];
const MONITORING_STATUSES = ['eligible', 'holding', 'paused', 'data', 'risk', 'funds', 'conditions'];

// Selection is a discovery step. Only an explicitly strict member carries a
// research qualification gate; a later ordinary scan cannot grant that gate.
function poolQualificationPending(agency, member) {
  if (!member) return false;
  if (agency.version < 5) return !!agency.pool && (member.poolCheck?.status !== 'pass'
    || member.poolCheck.policyVersion !== agency.pool.policy.version);
  return member.selectionMode === 'strict' && (member.poolCheck?.status !== 'pass'
    || member.poolCheck.policyVersion !== 3 || member.poolCheck.screeningMode !== 'strict');
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
      ? STRATEGY_PRESETS.find(preset => preset.id === group.id)?.rules || [] : [])];
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
  else if (/缺失|缺少|不足\s*61|日线不足|不完整|未获取|不可用|获取失败|下载|解析|时间未知|过期|超过.*分钟|超过.*秒|不是当日|待补齐|资料不足|来源.*无法|日期.*不一致/.test(reason)
    || ['等待数据', '等待有效行情'].includes(evaluation?.status)) status = 'data';
  else if (evaluation?.entryRisk?.status === 'unverified' || /公告|风险拦截|待对账|公司行为|除权|停牌|涨跌停|ST.*禁止/.test(reason)) status = 'risk';
  return { status, reason, checkedAt: new Date(now).toISOString() };
}

module.exports = { SELECTION_MODES, MONITORING_STATUSES, poolQualificationPending, migrateMonitoring, monitoringCheck };
