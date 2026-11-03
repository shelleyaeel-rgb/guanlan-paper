'use strict';

// Engineering limits for continuously refreshed, unheld candidates. Holdings
// and their exit arrangements remain outside this candidate budget.
const ACTIVE_CANDIDATE_LIMIT = 20;
const STANDBY_CAPACITY_REASON = `本策略活跃候选已达 ${ACTIVE_CANDIDATE_LIMIT} 只，保留为候补，等待更新四策略候选池重新筛选`;
const STANDBY_MIGRATION_REASON = '筛选规则已升级，等待更新四策略候选池重新筛选';

function held(state, symbol) { return state.lots.some(lot => lot.symbol === symbol); }
function activeCandidateCount(state, group) {
  const holdings = new Set(state.lots.map(lot => lot.symbol));
  return group.members.filter(member => member.mode === 'active' && !holdings.has(member.symbol)).length;
}
function setStandby(state, member, reason = STANDBY_CAPACITY_REASON) {
  if (held(state, member.symbol) || ['closing', 'removing'].includes(member.mode)) return false;
  if (typeof reason !== 'string' || !reason.trim()) throw Error('候补原因不能为空');
  member.mode = 'standby'; member.standbyReason = reason;
  return true;
}
function activateCandidate(state, group, member) {
  if (held(state, member.symbol) || ['closing', 'removing'].includes(member.mode)) return false;
  if (member.mode !== 'active' && activeCandidateCount(state, group) >= ACTIVE_CANDIDATE_LIMIT) return false;
  member.mode = 'active'; delete member.standbyReason;
  return true;
}

module.exports = { ACTIVE_CANDIDATE_LIMIT, STANDBY_CAPACITY_REASON, STANDBY_MIGRATION_REASON,
  activeCandidateCount, setStandby, activateCandidate };
