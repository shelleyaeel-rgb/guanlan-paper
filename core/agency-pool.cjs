'use strict';
const { randomUUID } = require('node:crypto');
const { symbolOf } = require('./common.cjs');
const { createEntryConditions } = require('./entry-conditions.cjs');
const { combineDiagnostics, listedDiagnostics } = require('./agency-pool-diagnostics.cjs');
const { validateResearchRules } = require('./research-rules.cjs');
const { validatePerformanceRules } = require('./performance-rules.cjs');
const { validateIndustryRules } = require('./selection-evidence.cjs');
const IDS = ['ultra-short', 'short', 'swing', 'long'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const iso = value => new Date(value).toISOString();
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && iso(value) === value;

function validPoolCheck(check) {
  return object(check) && [1, 2, 3].includes(check.policyVersion) && ['pass', 'pending', 'failed'].includes(check.status)
    && (check.policyVersion < 3 || ['strategy', 'strict'].includes(check.screeningMode))
    && validTime(check.checkedAt) && Array.isArray(check.reasons) && check.reasons.every(reason => typeof reason === 'string')
    && Array.isArray(check.matchedStrategies) && check.matchedStrategies.every(id => IDS.includes(id))
    && new Set(check.matchedStrategies).size === check.matchedStrategies.length;
}
function validPoolLedger(agency) {
  if (agency.version < 4) return agency.poolVersion === undefined && agency.pool === undefined && agency.poolAuthorizationRevision === undefined
    && agency.groups.every(group => group.members.every(member => member.poolCheck === undefined));
  if (agency.poolVersion !== 1 || !Number.isSafeInteger(agency.poolAuthorizationRevision) || agency.poolAuthorizationRevision < 0) return false;
  if (agency.pool === null) return agency.groups.every(group => group.members.every(member => member.poolCheck === undefined
    || (agency.version >= 5 && validPoolCheck(member.poolCheck))));
  const pool = agency.pool, policy = pool?.policy;
  if (!object(pool) || !object(policy) || ![1, 2, 3].includes(policy.version) || (policy.version === 2 && policy.evidenceMode !== 'automatic')
    || (policy.version === 3 && (!['strategy', 'strict'].includes(policy.screeningMode) || policy.evidenceMode !== (policy.screeningMode === 'strict' || policy.commonQuery?.evidence?.industry ? 'automatic' : 'none'))) || typeof policy.name !== 'string'
    || JSON.stringify(policy.priority) !== JSON.stringify(IDS)) return false;
  try { if (!createEntryConditions(policy.commonQuery)) return false;
    if (policy.screeningMode === 'strict' && (policy.commonQuery.research || policy.commonQuery.evidence?.industry)) return false;
  } catch { return false; }
  const result = pool.lastResult;
  if (!object(result) || typeof result.id !== 'string' || result.policyVersion !== policy.version
    || (policy.version === 3 && result.screeningMode !== policy.screeningMode) || !validTime(result.startedAt) || !validTime(result.finishedAt)
    || !object(result.counts) || !object(result.strategies)) return false;
  for (const key of ['added', 'retained', 'removed', 'pending', 'held', 'skipped']) {
    if (!Array.isArray(result[key]) || result.counts[key] !== result[key].length) return false;
    for (const item of result[key]) {
      try { if (!object(item) || symbolOf(item.symbol) !== item.symbol || !IDS.includes(item.strategyId) || !Array.isArray(item.reasons)) return false; }
      catch { return false; }
    }
  }
  if (!Array.isArray(result.unassignedPending) || result.counts.unassignedPending !== result.unassignedPending.length) return false;
  for (const item of result.unassignedPending) {
    try { if (!object(item) || symbolOf(item.symbol) !== item.symbol || !Array.isArray(item.strategyIds) || !item.strategyIds.length
      || item.strategyIds.some(id => !IDS.includes(id)) || !Array.isArray(item.reasons) || item.reasons.some(reason => typeof reason !== 'string')) return false; }
    catch { return false; }
  }
  return agency.groups.every(group => group.members.every(member => (agency.version >= 5 && member.poolCheck === undefined) || validPoolCheck(member.poolCheck)));
}

// Explicit policy composition remains available for older saved workflows.
// Ordinary manual additions no longer inherit a global candidate policy.
function poolEntryConditions(input, policy, now) {
  const source = { kind: 'agency-pool', policyVersion: policy.version, ...(policy.version >= 3 ? { screeningMode: policy.screeningMode } : {}) };
  const common = createEntryConditions({ ...policy.commonQuery, source }, now), supplied = createEntryConditions(input, now);
  if (!supplied) return common;
  const rules = [...new Map([...common.rules, ...supplied.rules].map(rule => [JSON.stringify(rule), rule])).values()];
  const left = common.evidence, right = supplied.evidence;
  if (left && right && (left.industry || right.industry) && (left.leadership || right.leadership
    || left.industry && right.industry && JSON.stringify(left.industry) !== JSON.stringify(right.industry))) throw Error('两套行业条件不能隐式覆盖，请明确选择');
  const evidence = left && right ? { conditions: [...new Set([...left.conditions, ...right.conditions])],
    leadership: right.leadership && right.leadership !== 'either' ? right.leadership : left.leadership || right.leadership,
    minSegmentRevenuePct: Math.max(left.minSegmentRevenuePct || 0, right.minSegmentRevenuePct || 0),
    ...(left.industry || right.industry ? { industry: left.industry || right.industry } : {}) } : left || right;
  if (common.research && supplied.research && JSON.stringify(common.research) !== JSON.stringify(supplied.research)) throw Error('两套经营指标条件不能隐式覆盖，请明确选择');
  const research = supplied.research || common.research;
  if (common.performance && supplied.performance && JSON.stringify(common.performance) !== JSON.stringify(supplied.performance)) throw Error('两套业绩预告/快报条件不能隐式覆盖，请明确选择');
  const performance = supplied.performance || common.performance;
  return createEntryConditions({ rules, excludeST: common.excludeST || supplied.excludeST,
    ...(evidence ? { evidence } : {}), ...(research ? { research } : {}), ...(performance ? { performance } : {}), source }, now);
}
function pendingPoolCheck(policy, now, reason) {
  return { policyVersion: policy.version, ...(policy.version >= 3 ? { screeningMode: policy.screeningMode } : {}),
    status: 'pending', checkedAt: iso(now), matchedStrategies: [], reasons: [reason] };
}
function checkedResult(scan, policy) {
  if (!object(scan) || !object(scan.strategies)) throw Error('候选池筛选结果无效，本次未应用');
  const indexes = new Map();
  for (const strategyId of policy.priority) {
    const strategy = scan.strategies[strategyId], index = new Map();
    if (!object(strategy) || !createEntryConditions(strategy.query)) throw Error('策略筛选条件缺失，本次未应用');
    for (const status of ['pass', 'failed', 'pending']) {
      if (!Array.isArray(strategy[status])) throw Error('策略筛选分类不完整，本次未应用');
      for (const row of strategy[status]) {
        if (!object(row) || symbolOf(row.symbol) !== row.symbol || index.has(row.symbol)) throw Error('策略筛选股票无效或重复，本次未应用');
        index.set(row.symbol, { ...row, status, reasons: Array.isArray(row.reasons) ? row.reasons.filter(reason => typeof reason === 'string') : [] });
      }
    }
    indexes.set(strategyId, index);
  }
  return indexes;
}

class AgencyPoolService {
  constructor({ getEngine, transaction, screener, onChange = () => {}, clock = Date.now, screen, policy, prepareSource = () => {} } = {}) {
    Object.assign(this, { getEngine, transaction, screener, onChange, clock, screen, policy, prepareSource });
    this.active = null; this.lastRun = null; this.lastError = '';
  }
  progressState() {
    const run = this.active || this.lastRun;
    return { runId: run?.id || null, running: !!this.active, operation: this.active?.operation || null,
      progress: this.active ? structuredClone(this.screener.progress || {}) : null,
      elapsedMs: run ? Math.max(0, (run.finishedAt ?? Number(this.clock())) - run.startedAt) : 0,
      lastError: this.lastError };
  }
  publicState() {
    const pool = this.getEngine().s.agency.pool;
    const policy = require('./agency-screening.cjs').poolPolicy;
    return { ...this.progressState(), lastResult: pool ? structuredClone(pool.lastResult) : null,
      policy: structuredClone(this.policy?.('strategy') || policy()),
      policies: { strategy: structuredClone(this.policy?.('strategy') || policy('strategy')), strict: structuredClone(this.policy?.('strict') || policy('strict')) } };
  }
  cancel() { if (this.active) { this.active.cancelled = true; this.screener.cancel(); this.onChange({ progressOnly: true }); } return !!this.active; }
  async run({ retryEvidence = false, refreshQuantitative = false, screeningMode, research, performance, industry } = {}) {
    if (typeof retryEvidence !== 'boolean' || typeof refreshQuantitative !== 'boolean') throw Error('资料重试参数无效');
    if (this.active) throw Error('四策略候选池正在更新，请等待完成或取消');
    if (this.screener.activeRun) throw Error('选股任务正在执行，请完成或取消后再更新候选池');
    const engine = this.getEngine(), agency = engine.s.agency;
    const previous = agency.pool?.lastResult;
    if (screeningMode === undefined) screeningMode = retryEvidence ? previous?.screeningMode || (previous?.policyVersion < 3 ? 'strict' : 'strategy') : 'strategy';
    if (retryEvidence) { research = agency.pool?.policy?.commonQuery?.research; performance = agency.pool?.policy?.commonQuery?.performance; industry = agency.pool?.policy?.commonQuery?.evidence?.industry; }
    research = validateResearchRules(research);
    performance = validatePerformanceRules(performance);
    industry = validateIndustryRules(industry);
    if (!['strategy', 'strict'].includes(screeningMode)) throw Error('候选筛选模式无效');
    if (retryEvidence && (!previous || !(previous.counts.pending + previous.counts.unassignedPending > 0 || previous.coverage?.diagnostics?.pendingCompanies > 0
      || previous.held?.some(item => item.status === 'pending')))) throw Error('没有可重试的待核验结果，请先更新四策略候选池');
    const run = { id: randomUUID(), startedAt: Number(this.clock()), epoch: agency.epoch, authorization: agency.poolAuthorizationRevision,
      cancelled: false, operation: retryEvidence ? 'retry' : 'update' };
    const policy = structuredClone(this.policy?.(screeningMode, research, performance, industry) || require('./agency-screening.cjs').poolPolicy(screeningMode, research, performance, industry));
    const requiredSymbols = agency.groups.flatMap(group => group.members.map(member => member.symbol));
    const exiting = new Set(agency.groups.flatMap(group => group.members.filter(member => member.mode !== 'active').map(member => member.symbol)));
    this.active = run; this.lastRun = run; this.lastError = '';
    this.screener.progress = { loading: true, stage: 'preparing', completed: 0, total: 0 };
    this.onChange();
    try {
      if (screeningMode === 'strict' || industry || research?.enabled && research.path === 'product') this.prepareSource({ retry: retryEvidence });
      // Even a document retry must recheck current quantitative eligibility;
      // its source reuses verified bodies, never stale candidate permissions.
      const scan = await (this.screen || require('./agency-screening.cjs').runAgencyScreening)(this.screener, { force: true, requiredSymbols, retryEvidence, refreshQuantitative, screeningMode, research, performance, industry });
      if (run.cancelled) throw Error('已取消候选池更新，本次结果未应用');
      const indexes = checkedResult(scan, policy);
      const finishedAt = iso(scan.finishedAt || this.clock()), startedAt = iso(scan.startedAt || finishedAt);
      const result = { id: randomUUID(), startedAt, finishedAt, policyVersion: policy.version, screeningMode, operation: run.operation,
        ...(research ? { research: structuredClone(research) } : {}),
        ...(performance ? { performance: structuredClone(performance) } : {}),
        ...(industry ? { industry: structuredClone(industry) } : {}),
        coverage: structuredClone(scan.coverage || {}), sources: structuredClone(scan.sources || []), priority: [...policy.priority],
        added: [], retained: [], removed: [], pending: [], held: [], skipped: [], unassignedPending: [], counts: {}, strategies: {} };
      for (const id of policy.priority) result.strategies[id] = Object.fromEntries(['pass', 'failed', 'pending'].map(status => [status, scan.strategies[id][status].length]));
      this.transaction(() => {
        const current = this.getEngine(), a = current.s.agency;
        if (run.cancelled) throw Error('已取消候选池更新，本次结果未应用');
        if (a.epoch !== run.epoch) throw Error('账户已重置，本次候选池结果未应用');
        if (a.poolAuthorizationRevision !== run.authorization) throw Error('策略或成员授权已变化，请重新更新候选池');
        const holdings = new Set(current.s.lots.map(lot => lot.symbol));
        const orders = new Set(current.s.orders.filter(order => order.status === 'pending').map(order => order.symbol));
        const owners = new Map();
        const matches = symbol => policy.priority.filter(id => indexes.get(id).get(symbol)?.status === 'pass');
        const lookup = (id, symbol) => indexes.get(id).get(symbol) || { symbol, status: 'pending', reasons: ['本次资料未覆盖该股票，等待重新核验'] };
        const entry = (id, row) => ({ symbol: row.symbol, name: row.name || current.s.marks[row.symbol]?.name || row.symbol,
          strategyId: id, status: row.status, reasons: [...row.reasons], matchedStrategies: matches(row.symbol),
          ...(row.stage ? { stage: row.stage } : {}), ...(row.technicalAsOf ? { technicalAsOf: row.technicalAsOf } : {}),
          ...(row.technicalError ? { technicalError: row.technicalError } : {}),
          ...(row.diagnostics ? { diagnostics: structuredClone(row.diagnostics) } : {}),
          ...(row.noticeReview ? { noticeReview: structuredClone(row.noticeReview) } : {}),
          ...(row.researchReview ? { researchReview: structuredClone(row.researchReview) } : {}),
          ...(row.performanceReview ? { performanceReview: structuredClone(row.performanceReview) } : {}),
          ...(row.financeCheck ? { financeCheck: structuredClone(row.financeCheck), financeChecks: { [id]: structuredClone(row.financeCheck) } } : {}),
          ...(row.pendingReport ? { pendingReport: structuredClone(row.pendingReport) } : {}),
          ...(row.evidenceReview ? { evidenceReview: structuredClone(row.evidenceReview) } : {}) });
        const check = row => ({ policyVersion: policy.version, screeningMode, status: row.status, checkedAt: finishedAt, name: row.name || current.s.marks[row.symbol]?.name || row.symbol,
          matchedStrategies: matches(row.symbol), reasons: [...row.reasons] });
        for (const group of a.groups) {
          const retained = [];
          for (const member of group.members) {
            const row = lookup(group.id, member.symbol), item = entry(group.id, row);
            // A strategy scan is diagnostic for existing monitors. It cannot
            // revoke or grant a member's separately chosen strict qualification.
            if (member.selectionMode !== 'strict' || screeningMode === 'strict') member.poolCheck = check(row);
            if (holdings.has(member.symbol)) {
              retained.push(member); owners.set(member.symbol, group.id); result.held.push(item); continue;
            }
            if (member.mode !== 'active') {
              retained.push(member); owners.set(member.symbol, group.id); result.skipped.push({ ...item, reasons: ['已有退出安排，本次不重新授权开仓'] }); continue;
            }
            retained.push(member); owners.set(member.symbol, group.id);
            result[row.status === 'pending' ? 'pending' : 'retained'].push(item);
          }
          group.members = retained;
        }
        const candidates = [...new Set(policy.priority.flatMap(id => scan.strategies[id].pass.map(row => row.symbol)))].sort();
        for (const symbol of candidates) {
          if (owners.has(symbol)) continue;
          const strategyId = matches(symbol)[0], row = lookup(strategyId, symbol), item = entry(strategyId, row);
          const reason = holdings.has(symbol) ? '已有手动持仓，策略不能自动接管'
            : orders.has(symbol) ? '有待执行手动委托，本次不接管' : exiting.has(symbol) ? '保留本轮开始时的退出安排，不自动重新加入' : '';
          if (reason) { result.skipped.push({ ...item, reasons: [reason] }); continue; }
          const member = { symbol, mode: 'active', selectionMode: screeningMode, addedAt: current.clock().toISOString(), reconciliation: { status: 'clear', reason: '' }, poolCheck: check(row) };
          if (screeningMode === 'strict' || research?.enabled || performance?.enabled || industry) member.entryConditions = createEntryConditions({ ...policy.commonQuery,
            source: { kind: 'agency-pool', policyVersion: policy.version, screeningMode, selectedAt: finishedAt } }, current.clock());
          a.groups.find(group => group.id === strategyId).members.push(member); owners.set(symbol, strategyId); result.added.push(item);
        }
        // Unknown eligibility is separate from members awaiting revalidation. A
        // first scan can have thousands of unknown stocks without adding any.
        const unknown = new Map();
        for (const strategyId of policy.priority) for (const row of scan.strategies[strategyId].pending) {
          if (owners.has(row.symbol) || holdings.has(row.symbol) || orders.has(row.symbol) || exiting.has(row.symbol)) continue;
          const item = unknown.get(row.symbol) || { symbol: row.symbol, name: row.name || row.symbol, strategyIds: [], reasons: [] };
          if (row.evidenceReview) item.evidenceReview = structuredClone(row.evidenceReview);
          if (row.researchReview) item.researchReview = structuredClone(row.researchReview);
          if (row.performanceReview) item.performanceReview = structuredClone(row.performanceReview);
          if (row.pendingReport) item.pendingReport = structuredClone(row.pendingReport);
          if (row.financeCheck) {
            item.financeChecks ||= {};
            item.financeChecks[strategyId] = structuredClone(row.financeCheck);
            // Keep the first strategy's check for older readers; a later
            // strategy's different thresholds must not overwrite that result.
            item.financeCheck ||= structuredClone(row.financeCheck);
          }
          if (row.noticeReview) item.noticeReview = structuredClone(row.noticeReview);
          if (row.diagnostics) item.diagnostics = combineDiagnostics([item.diagnostics, row.diagnostics]);
          if (row.technicalAsOf) item.technicalAsOf = row.technicalAsOf;
          if (row.technicalError) item.technicalError = row.technicalError;
          item.strategyIds.push(strategyId);
          item.reasons = [...new Set([...item.reasons, ...(Array.isArray(row.reasons) ? row.reasons.filter(reason => typeof reason === 'string') : [])])];
          unknown.set(row.symbol, item);
        }
        result.unassignedPending = [...unknown.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
        for (const key of ['added', 'retained', 'removed', 'pending', 'held', 'skipped', 'unassignedPending']) result.counts[key] = result[key].length;
        result.listedDiagnostics = listedDiagnostics(['added', 'retained', 'removed', 'pending', 'held', 'skipped', 'unassignedPending'].flatMap(key => result[key]));
        a.pool = { policy, lastResult: structuredClone(result) }; a.poolAuthorizationRevision++; a.revision++;
      });
      return result;
    } catch (error) { this.lastError = error.message || '候选池更新失败，本次结果未应用'; throw error; }
    finally { run.finishedAt = Number(this.clock()); this.active = null; this.onChange(); }
  }
}
module.exports = { AgencyPoolService, validPoolLedger, validPoolCheck, poolEntryConditions, pendingPoolCheck };
