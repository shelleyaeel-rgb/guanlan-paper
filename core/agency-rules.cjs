'use strict';
const { symbolOf } = require('./common.cjs');
const { strategyProfile } = require('./strategy-profiles.cjs');

const RULES_VERSION = '1', RULES_INTERVAL_MS = 300000, DECISION_TTL_SECONDS = 120;
class AgencyRulesError extends Error { constructor(message) { super(message); this.name = 'AgencyRulesError'; } }

// Pure decision formatting. Entry permission comes only from engine.agencyEvaluate;
// this module cannot loosen a strategy, size an order or create an exit instruction.
function evaluateRuleDecisions({ strategyId, candidates, context = {} }, now = Date.now()) {
  strategyProfile(strategyId);
  if (!Array.isArray(candidates) || candidates.length > 20) throw new AgencyRulesError('单轮规则检查最多 20 只股票');
  const maxPosition = context.limits?.maxPosition;
  if (!Number.isFinite(maxPosition) || maxPosition < 0.01 || maxPosition > 1) throw new AgencyRulesError('策略单股仓位限制无效');
  const requestedAt = Number(now);
  if (!Number.isFinite(requestedAt)) throw new AgencyRulesError('规则检查时间无效');
  const seen = new Set();
  const decisions = candidates.map(candidate => {
    if (!candidate || symbolOf(candidate.symbol) !== candidate.symbol || seen.has(candidate.symbol)) throw new AgencyRulesError('规则检查股票无效或重复');
    seen.add(candidate.symbol);
    const holding = Number(candidate.position?.quantity) > 0;
    const action = holding ? 'hold' : candidate.entryAllowed === true ? 'buy' : 'wait';
    const currentPercent = Number.isFinite(candidate.currentPercent) ? Math.max(0, Math.min(100, candidate.currentPercent)) : 0;
    const reasons = Array.isArray(candidate.rules?.reasons) ? candidate.rules.reasons.filter(reason => typeof reason === 'string' && reason.trim()).map(reason => reason.slice(0, 2000)) : [];
    const reason = (action === 'hold' ? ['已有持仓，不重复建仓或加仓；退出由固定策略与原风控计划持续管理', ...reasons]
      : action === 'buy' ? ['固定策略入场规则全部通过，提交时重新核验最新行情、资金和风险', ...reasons]
        : reasons.length ? reasons : ['固定策略入场条件尚未全部满足，继续等待']).join('；');
    return { symbol: candidate.symbol, strategyId, action, targetPercent: action === 'buy' ? maxPosition * 100 : action === 'hold' ? currentPercent : 0,
      reason, evidence: ruleEvidence(candidate), validForSeconds: DECISION_TTL_SECONDS, decisionSource: 'rules', rulesVersion: RULES_VERSION };
  });
  return { decisionSource: 'rules', rulesVersion: RULES_VERSION, decisions, requestedAt, evaluatedAt: requestedAt, expiresAt: requestedAt + DECISION_TTL_SECONDS * 1000 };
}
function ruleEvidence(candidate) {
  const facts = [];
  const valueText = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)).toString() : '缺失';
  const labels = { finance: '财务', valuation: '估值', notices: '公告标题', selectionEvidence: '研究证据' };
  const statuses = { ready: '资料可用', empty: '本次未返回记录', error: '获取失败', stale: '资料过期' };
  for (const source of candidate.sources || []) {
    if (typeof source?.id !== 'string') continue;
    let detail;
    if (source.kind === 'quote') detail = `报价 ${valueText(source.data?.price)}，卖一 ${valueText(source.data?.ask)}，买一 ${valueText(source.data?.bid)}`;
    else if (source.kind === 'completed-unadjusted-daily') detail = `完整未复权日线 ${source.data?.asOf ?? '未知'}，MA20 ${valueText(source.data?.ma20, 4)}，MA60 ${valueText(source.data?.ma60, 4)}`;
    else detail = `${labels[source.kind] || '资料'}：${statuses[source.status] || '状态待核对'}`;
    facts.push({ sourceId: source.id, detail });
  }
  return facts;
}
module.exports = { evaluateRuleDecisions, ruleEvidence, AgencyRulesError, RULES_VERSION, RULES_INTERVAL_MS, DECISION_TTL_SECONDS };
