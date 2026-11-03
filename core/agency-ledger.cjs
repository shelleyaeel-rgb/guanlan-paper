'use strict';
const { money, id, cnTime, symbolOf, numberIn } = require('./common.cjs');
const { STRATEGY_PROFILES, evaluateEntry, configureStrategy, economics } = require('./strategy.cjs');
const { fees } = require('./fees.cjs');
const { holdingValuation } = require('./holding-valuation.cjs');
const { maxOrderQuantity } = require('./order-quantity.cjs');
const { checkNoticeRisk } = require('./entry-risk.cjs');
const { validateMarketRegimeSnapshot } = require('./market-regime.cjs');
const { calendarSession } = require('./trading-calendar.cjs');
const { preparedTechnicalValid, publicDailyHistory } = require('./daily-history.cjs');
const { preopenPriceReference } = require('./preparation-state.cjs');
const { createEntryConditions, validEntryConditions, evaluateEntryConditions, usesAutomaticEvidence, automaticEntryConditions } = require('./entry-conditions.cjs');
const { validEntryEvidenceRef } = require('./entry-evidence-store.cjs');
const { validPoolLedger, validPoolCheck, pendingPoolCheck } = require('./agency-pool.cjs');
const { SELECTION_MODES, poolQualificationPending, migrateMonitoring, migrateTechnicalTrading,
  validMonitoringCheck, migrateMonitoringChecks } = require('./agency-monitoring.cjs');
const { ACTIVE_CANDIDATE_LIMIT, STANDBY_MIGRATION_REASON, activeCandidateCount, setStandby } = require('./agency-capacity.cjs');
const { memberAffectsEquity, corporateBalances, availableCorporateCash, processCorporateActions, settleDividendTaxes,
  validCorporateLedger, corporateFromDate, groupHasUnresolvedCorporate, assertCorporatePurchase } = require('./corporate-ledger.cjs');

const MODES = ['running', 'paused', 'stopped'];
const MEMBER_MODES = ['active', 'standby', 'removing', 'closing'];
const DEFAULT_LIMITS = Object.freeze({ maxPosition: 0.3, maxPositions: 5, riskPercent: 0.5, minRewardRisk: 2, maxTotalPosition: 0.8, maxPlannedRiskPercent: 2 });
const cents = n => Number.isSafeInteger(n);
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const sameEvidenceRef = (left, right) => validEntryEvidenceRef(left) && validEntryEvidenceRef(right)
  && ['version', 'hash', 'symbol', 'strategyId', 'decisionId', 'createdAt'].every(key => left[key] === right[key]);
const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
const validExitPriceBasis = basis => object(basis) && validDate(basis.date) && validDate(basis.dailyAsOf) && basis.dailyAsOf < basis.date
  && Number.isFinite(basis.prevClose) && basis.prevClose > 0 && Number.isFinite(basis.dailyClose) && basis.dailyClose > 0
  && (basis.corporateVerified === undefined || typeof basis.corporateVerified === 'boolean')
  && Number.isFinite(basis.checkedAt) && Number.isFinite(basis.corporateCheckedAt) && typeof basis.corporateBasis === 'string';
function limitsOf(input = {}, prior = DEFAULT_LIMITS) {
  const v = { ...prior, ...input };
  const limits = {
    maxPosition: numberIn(v.maxPosition, 0.01, 1, '策略单股仓位比例'),
    maxPositions: numberIn(v.maxPositions, 1, 30, '策略持仓数量上限'),
    riskPercent: numberIn(v.riskPercent, 0.1, 2, '策略单笔风险比例（%）'),
    minRewardRisk: numberIn(v.minRewardRisk, 1, 5, '策略最低含费盈亏比'),
    maxTotalPosition: numberIn(v.maxTotalPosition, 0.01, 1, '策略总仓位比例'),
    maxPlannedRiskPercent: numberIn(v.maxPlannedRiskPercent, 0.1, 10, '策略总计划风险（%）')
  };
  if (!Number.isInteger(limits.maxPositions)) throw Error('持仓数量上限须为整数');
  return limits;
}
function makeAgency(s, now) {
  return { version: 7, legacyManual: { watchlist: [], migratedAt: new Date(now).toISOString(), cancelledOrderIds: [] }, monitoringVersion: 1, entryConditionsVersion: 1, poolVersion: 1, pool: null, poolAuthorizationRevision: 0, decisionMode: 'rules', rulesVersion: '1', epoch: id(), revision: 0, manualCash: s.cash, decisions: [], executionIntents: [], transfers: [], corporateEvents: [], corporateActions: [], corporateChecks: {},
    groups: STRATEGY_PROFILES.map(p => ({ id: p.id, name: p.name, mode: 'paused', cash: 0, netFunding: 0,
      limits: { ...DEFAULT_LIMITS }, members: [], cycles: [], equity: [], unitPeak: 1, unitValue: 1, units: 0, drawdown: 0 })) };
}
function migrateAgency(s, now = new Date()) {
  const newAgency = !s.agency;
  if (newAgency) s.agency = makeAgency(s, now);
  else if (s.agency.decisionMode !== 'rules') {
    const pausedGroups = s.agency.groups.filter(group => group.mode === 'running').map(group => group.id);
    for (const group of s.agency.groups) if (group.mode === 'running') group.mode = 'paused';
    s.agency.decisionMode = 'rules'; s.agency.rulesVersion = '1'; s.agency.revision++;
    s.agency.migrationNotice = { kind: 'rules-mode-upgrade', time: new Date(now).toISOString(), pausedGroups,
      message: '交易决策已切换为固定策略规则。原运行组已暂停新开仓，请查看规则后重新启用；已有持仓沿原计划管理退出，停止全部操作的分组保持停止。' };
  }
  // Existing trades and holdings have manual ownership; do not attribute past
  // performance to newly enabled automatic strategies or rewrite trade facts.
  for (const lot of s.lots) if (!lot.owner) lot.owner = 'manual';
  if (s.agency.version === 1) { s.agency.version = 2; s.agency.revision++; }
  s.agency.corporateActions ||= [];
  s.agency.corporateChecks ||= {};
  // Older executables must not open an account while ignoring its saved entry constraints.
  if (s.agency.version === 2) { s.agency.version = 3; s.agency.entryConditionsVersion = 1; s.agency.revision++; }
  // A v3 executable must reject accounts with pool eligibility gates rather than
  // silently trading pending members. Migration itself does not opt into a pool.
  if (s.agency.version === 3) {
    s.agency.version = 4; s.agency.poolVersion = 1; s.agency.pool = null; s.agency.poolAuthorizationRevision = 0; s.agency.revision++;
  }
  if (s.agency.version === 4) migrateMonitoring(s.agency, now);
  if (s.agency.version === 5) {
    let changedMembers = 0;
    for (const group of s.agency.groups) for (const member of group.members)
      if (member.mode === 'active' && setStandby(s, member, STANDBY_MIGRATION_REASON)) changedMembers++;
    s.agency.version = 6; s.agency.revision++; s.agency.poolAuthorizationRevision++;
    s.agency.migrationNotice = { kind: 'candidate-capacity-upgrade', time: new Date(now).toISOString(), changedMembers,
      message: `筛选规则已升级：${changedMembers} 只未持仓成员保留为候补，等待更新四策略候选池重新筛选；每组最多 ${ACTIVE_CANDIDATE_LIMIT} 只活跃候选。持仓和退出安排继续保留。` };
  }
  if (s.agency.version === 6 || newAgency && (s.watchlist.length || s.orders.some(order => order.status === 'pending'))) {
    const time = new Date(now).toISOString(), pending = s.orders.filter(order => order.status === 'pending');
    let changedMembers = 0;
    for (const group of s.agency.groups) for (const member of group.members) {
      const check = member.poolCheck;
      const qualified = validPoolCheck(check) && check.policyVersion === 3 && check.status === 'pass'
        && check.matchedStrategies.includes(group.id) && (member.selectionMode !== 'strict' || check.screeningMode === 'strict');
      if (member.mode === 'active' && !qualified
        && setStandby(s, member, '自动交易专用版仅采用策略筛选候选，等待自动策略筛选核验后再开仓')) changedMembers++;
    }
    if (changedMembers) s.agency.poolAuthorizationRevision++;
    const reason = '升级自动交易专用版，撤销旧手动条件单；历史记录保留，不再自动触发';
    s.agency.legacyManual = { watchlist: structuredClone(s.watchlist), migratedAt: time, cancelledOrderIds: pending.map(order => order.id) };
    for (const order of pending) Object.assign(order, { status: 'cancelled', cancelledAt: time, cancelReason: reason, note: reason });
    s.watchlist = [];
    s.agency.version = 7; s.agency.revision++;
    const message = `已升级自动交易专用版：归档 ${s.agency.legacyManual.watchlist.length} 只人工自选，撤销 ${pending.length} 条旧手动条件单；${changedMembers} 只未持仓成员缺少本策略有效筛选通过记录，转为候补等待自动策略筛选。历史手动持仓、成交、资金和风险设置保留；历史持仓可按可卖数量、申报上限和盘口分批退出，剩余持仓保留。`;
    const previous = s.agency.migrationNotice;
    const autoOnly = { time, cancelledOrders: pending.length, archivedWatchlist: s.agency.legacyManual.watchlist.length, changedMembers };
    s.agency.migrationNotice = previous
      ? { ...previous, message: `${previous.message}\n${message}`, autoOnly }
      : { kind: 'auto-only-upgrade', time, message, autoOnly };
  }
  migrateTechnicalTrading(s, now);
  migrateMonitoringChecks(s.agency);
}
function validAgency(s) {
  const a = s.agency;
  if (!object(a) || ![1, 2, 3, 4, 5, 6, 7, 8].includes(a.version) || typeof a.epoch !== 'string' || !a.epoch || !cents(a.revision) || a.revision < 0
    || !cents(a.manualCash) || a.manualCash < 0 || !Array.isArray(a.groups) || a.groups.length !== STRATEGY_PROFILES.length
    || !['decisions', 'executionIntents', 'transfers', 'corporateEvents'].every(k => Array.isArray(a[k]))) return false;
  if (a.version >= 7) {
    const legacy = a.legacyManual;
    if (!object(legacy) || !Array.isArray(legacy.watchlist) || !legacy.watchlist.every(symbol => typeof symbol === 'string')
      || typeof legacy.migratedAt !== 'string' || !Number.isFinite(Date.parse(legacy.migratedAt))
      || !Array.isArray(legacy.cancelledOrderIds) || !legacy.cancelledOrderIds.every(orderId => typeof orderId === 'string' && orderId)
      || new Set(legacy.cancelledOrderIds).size !== legacy.cancelledOrderIds.length
      || legacy.cancelledOrderIds.some(orderId => !s.orders.some(order => order.id === orderId && order.status === 'cancelled'
        && order.cancelledAt === legacy.migratedAt && typeof order.cancelReason === 'string' && order.cancelReason.trim()))) return false;
  } else if (a.legacyManual !== undefined) return false;
  if (a.version >= 8 ? a.technicalTradingVersion !== 1 : a.technicalTradingVersion !== undefined) return false;
  if (a.marketPolicy !== undefined && (!object(a.marketPolicy) || a.marketPolicy.version !== 1 || typeof a.marketPolicy.enabled !== 'boolean')) return false;
  // Older executables must reject the new ledger instead of silently ignoring
  // tax reserves, receivables, or the listing date on bonus-share lots.
  if (a.version === 1 && (a.corporateActions !== undefined || a.corporateChecks !== undefined
    || a.corporateEvents.some(event => event.automatic) || s.lots.some(lot => lot.availableDate !== undefined))) return false;
  if (a.version >= 2 && (!Array.isArray(a.corporateActions) || !object(a.corporateChecks))) return false;
  if (a.version >= 3 ? a.entryConditionsVersion !== 1 : a.entryConditionsVersion !== undefined || a.groups.some(g => g?.members?.some(m => m.entryConditions != null))) return false;
  if (a.version >= 5 ? a.monitoringVersion !== 1 : a.monitoringVersion !== undefined) return false;
  // Unmarked accounts are accepted for the one-time Engine migration. Unknown
  // future rule versions must not silently acquire this version's authority.
  if (a.decisionMode !== undefined && (a.decisionMode !== 'rules' || a.rulesVersion !== '1')) return false;
  if (a.decisionMode === undefined && a.rulesVersion !== undefined) return false;
  const expected = new Set(STRATEGY_PROFILES.map(p => p.id)), members = new Map();
  try {
    if (!validPoolLedger(a)) return false;
    if (!validCorporateLedger(s)) return false;
    for (const trade of s.trades) {
      if (trade.entryEvidenceRequired !== undefined && trade.entryEvidenceRequired !== true) return false;
      if (trade.entryEvidenceRequired && !trade.entryEvidenceRef) return false;
      if (trade.entryEvidenceRef !== undefined && (!validEntryEvidenceRef(trade.entryEvidenceRef) || trade.side !== 'buy'
        || trade.entryEvidenceRef.symbol !== trade.symbol || trade.entryEvidenceRef.strategyId !== trade.owner || trade.entryEvidenceRef.decisionId !== trade.decisionId)) return false;
    }
    const decisionIds = new Set();
    for (const intent of a.executionIntents) {
      if (!object(intent) || typeof intent.decisionId !== 'string' || !intent.decisionId || decisionIds.has(intent.decisionId)
        || !expected.has(intent.strategyId) || symbolOf(intent.symbol) !== intent.symbol || !['sell', 'reduce'].includes(intent.action)
        || !['pending', 'completed'].includes(intent.status) || !cents(intent.targetQuantity) || intent.targetQuantity < 0 || !Array.isArray(intent.tradeIds)) return false;
      decisionIds.add(intent.decisionId);
    }
    const corporateIds = new Set(), bookedBatches = new Set(), bookedNotices = new Set();
    for (const event of a.corporateEvents) {
      if (!object(event) || !cents(event.cash) || event.cash < 0 || typeof event.eventId !== 'string' || !event.eventId || symbolOf(event.symbol) !== event.symbol
        || !Array.isArray(event.noticeIds) || !validDate(event.effectiveDate) || !expected.has(event.strategyId)) return false;
      const eventKey = `${event.symbol}:${event.eventId}`;
      if (corporateIds.has(eventKey)) return false;
      corporateIds.add(eventKey);
      if (event.confirmationOnly) {
        if (event.cash !== 0 || event.shareNumerator !== event.shareDenominator) return false;
      } else if (!event.automatic) {
        if (!validDate(event.recordDate) || event.recordDate > event.effectiveDate) return false;
        const batch = `${event.symbol}:${event.recordDate}`;
        if (bookedBatches.has(batch)) return false;
        bookedBatches.add(batch);
        for (const noticeId of event.noticeIds) {
          const noticeKey = `${event.symbol}:${noticeId}`;
          if (bookedNotices.has(noticeKey)) return false;
          bookedNotices.add(noticeKey);
        }
      }
    }
    if (a.transfers.some(transfer => !object(transfer) || !expected.has(transfer.strategyId) || !cents(transfer.amount))) return false;
    for (const g of a.groups) {
      if (!object(g) || !expected.delete(g.id) || !MODES.includes(g.mode) || !cents(g.cash) || g.cash < 0 || !cents(g.netFunding)
        || !Array.isArray(g.members) || !Array.isArray(g.cycles) || !Array.isArray(g.equity) || !object(g.limits)
        || !Number.isFinite(g.units) || g.units < 0 || !Number.isFinite(g.unitValue) || g.unitValue < 0
        || !Number.isFinite(g.unitPeak) || g.unitPeak <= 0 || !Number.isFinite(g.drawdown) || g.drawdown < 0 || g.drawdown > 1) return false;
      limitsOf(g.limits);
      if (a.version >= 6 && activeCandidateCount(s, g) > ACTIVE_CANDIDATE_LIMIT) return false;
      const funding = a.transfers.filter(t => t.strategyId === g.id).reduce((sum, t) => sum + t.amount, 0);
      const groupTrades = s.trades.filter(t => t.owner === g.id);
      const dividends = a.corporateEvents.filter(event => event.strategyId === g.id).reduce((sum, event) => sum + event.cash, 0);
      const tradeCash = groupTrades.reduce((sum, t) => sum + (t.side === 'buy' ? -t.gross - t.fees.total : t.gross - t.fees.total), 0);
      if (g.netFunding !== funding || g.cash !== funding + tradeCash + dividends) return false;
      for (const m of g.members) {
        if (!object(m) || symbolOf(m.symbol) !== m.symbol || members.has(m.symbol) || !MEMBER_MODES.includes(m.mode)
          || !object(m.reconciliation) || !['clear', 'pending'].includes(m.reconciliation.status)) return false;
        if (m.mode === 'standby' && (a.version < 6 || s.lots.some(lot => lot.symbol === m.symbol)
          || typeof m.standbyReason !== 'string' || !m.standbyReason.trim())) return false;
        if (m.standbyReason !== undefined && (a.version < 6 || m.mode !== 'standby' || typeof m.standbyReason !== 'string')) return false;
        if (m.entryConditions !== undefined && !validEntryConditions(m.entryConditions)) return false;
        if (m.legacyResearchConditions !== undefined && !validEntryConditions(m.legacyResearchConditions)) return false;
        if (m.exitPriceBasis !== undefined && !validExitPriceBasis(m.exitPriceBasis)) return false;
        if (a.version >= 5 && !SELECTION_MODES.includes(m.selectionMode)) return false;
        if (m.legacyPoolConditions !== undefined && !validEntryConditions(m.legacyPoolConditions)) return false;
        if (m.monitoringCheck !== undefined && !validMonitoringCheck(m.monitoringCheck)) return false;
        if (m.legacyMonitoringCheck !== undefined && !validMonitoringCheck(m.legacyMonitoringCheck, { legacy: true })) return false;
        members.set(m.symbol, g.id);
      }
      if (g.cycles.some(c => !object(c) || !c.id || symbolOf(c.symbol) !== c.symbol || !['open', 'closed'].includes(c.status) || !cents(c.pnl) || !cents(c.fees))) return false;
      const cycleIds = new Set(), openSymbols = new Set();
      for (const cycle of g.cycles) {
        if (cycleIds.has(cycle.id) || (cycle.status === 'open' && openSymbols.has(cycle.symbol))) return false;
        cycleIds.add(cycle.id); if (cycle.status === 'open') openSymbols.add(cycle.symbol);
        const trades = groupTrades.filter(t => t.cycleId === cycle.id);
        const entryRef = trades.find(trade => trade.side === 'buy')?.entryEvidenceRef;
        if (entryRef || cycle.entryEvidenceRef) {
          if (!sameEvidenceRef(cycle.entryEvidenceRef, entryRef)) return false;
        }
        const income = a.corporateEvents.filter(event => event.cycleId === cycle.id).reduce((sum, event) => sum + event.cash, 0);
        if (cycle.fees !== trades.reduce((sum, t) => sum + t.fees.total, 0)
          || cycle.pnl !== trades.reduce((sum, t) => sum + (t.pnl || 0), 0) + income) return false;
      }
      if (groupTrades.some(t => !cycleIds.has(t.cycleId))) return false;
    }
    if (s.cash !== a.manualCash + a.groups.reduce((sum, g) => sum + g.cash, 0)) return false;
    const owners = new Map();
    for (const l of s.lots) {
      const owner = l.owner || 'manual';
      if (l.entryEvidenceRef !== undefined) {
        const buy = s.trades.find(trade => trade.id === l.originId && trade.side === 'buy');
        if (!sameEvidenceRef(l.entryEvidenceRef, buy?.entryEvidenceRef)) return false;
      }
      if (!cents(l.quantity) || l.quantity <= 0 || !cents(l.cost) || l.cost < 0 || (owner !== 'manual' && members.get(l.symbol) !== owner)
        || (l.availableDate !== undefined && !validDate(l.availableDate))
        || (owners.has(l.symbol) && owners.get(l.symbol) !== owner) || (owner === 'manual' && members.has(l.symbol))) return false;
      owners.set(l.symbol, owner);
      if (owner !== 'manual' && !a.groups.find(g => g.id === owner).cycles.some(c => c.id === l.cycleId && c.symbol === l.symbol && c.status === 'open')) return false;
    }
    return !s.orders.some(o => o.status === 'pending' && members.has(o.symbol));
  } catch { return false; }
}
function groupOf(engine, strategyId) {
  const group = engine.s.agency.groups.find(g => g.id === strategyId);
  if (!group) throw Error('自动交易策略不存在');
  return group;
}
function membership(engine, symbol) {
  for (const group of engine.s.agency.groups) {
    const member = group.members.find(m => m.symbol === symbol);
    if (member) return { group, member };
  }
  return null;
}
function bump(engine) { engine.s.agency.revision++; }
function groupView(engine, group, quotes = {}) {
  const positions = engine.positions(quotes).filter(p => engine.s.lots.some(l => l.symbol === p.symbol && l.owner === group.id));
  const { receivable, taxReserve } = corporateBalances(engine.s, group.id, engine.clock());
  const marketValue = positions.reduce((n, p) => n + p.value, 0), equity = group.cash + marketValue + receivable - taxReserve;
  const cycles = group.cycles.map(cycle => {
    const accrual = corporateBalances(engine.s, group.id, engine.clock(), cycle.id);
    return { ...structuredClone(cycle), ...accrual, performancePnl: cycle.pnl + accrual.receivable - accrual.taxReserve };
  });
  const closed = cycles.filter(c => c.status === 'closed');
  const wins = closed.filter(c => c.performancePnl > 0).length, losses = closed.filter(c => c.performancePnl < 0).length;
  const unresolved = group.members.some(m => memberAffectsEquity(engine.s, m)) || groupHasUnresolvedCorporate(engine.s, group.id);
  return { ...structuredClone(group), cycles, positions, marketValue, equity, receivable, taxReserve, availableCash: Math.max(0, group.cash - taxReserve), pnl: equity - group.netFunding,
    realized: group.cycles.reduce((n, c) => n + c.pnl, 0), unrealized: positions.reduce((n, p) => n + p.pnl, 0),
    fees: group.cycles.reduce((n, c) => n + c.fees, 0), trades: closed.length, completedCycles: closed.length,
    wins, losses, breakeven: closed.length - wins - losses, winRate: closed.length ? wins / closed.length : null,
    drawdown: unresolved ? null : group.drawdown, returnPct: unresolved ? null : group.units > 0 ? (equity / group.units - 1) : null,
    comparable: !unresolved, performanceNote: unresolved ? '存在待对账股票，收益暂不可用于策略比较' : '按完整建仓至平仓周期统计；费用已计入；资金划拨不计收益' };
}
function recordGroup(engine, group, quotes = {}) {
  if (group.members.some(m => memberAffectsEquity(engine.s, m)) || groupHasUnresolvedCorporate(engine.s, group.id)) return;
  const equity = groupView(engine, group, quotes).equity;
  if (group.units > 0) {
    group.unitValue = equity / group.units;
    group.unitPeak = Math.max(group.unitPeak, group.unitValue);
    group.drawdown = Math.max(group.drawdown, (group.unitPeak - group.unitValue) / group.unitPeak);
  }
  const time = engine.clock().getTime(), previous = group.equity.at(-1);
  if (!previous || (time - previous.time > 60000 && previous.value !== equity)) group.equity.push({ time, value: equity, netFunding: group.netFunding });
  if (group.equity.length > 10000) group.equity.splice(0, 2000);
}
function pending(engine, member, reason, evidence = [], affectsEquity) {
  if (member.reconciliation.status !== 'pending' || member.reconciliation.reason !== reason || (affectsEquity !== undefined && member.reconciliation.affectsEquity !== affectsEquity)) {
    member.reconciliation = { status: 'pending', reason, evidence, ...(affectsEquity === undefined ? {} : { affectsEquity }), detectedAt: engine.clock().toISOString() }; bump(engine);
  }
  return reason;
}
function corporatePriceBasis(engine, symbol) {
  return JSON.stringify([
    engine.s.agency.corporateActions.filter(action => action.symbol === symbol).map(action =>
      [action.eventId, action.terms, Boolean(action.exAppliedAt), Boolean(action.shareAppliedAt), action.manualEventId]),
    engine.s.agency.corporateEvents.filter(event => event.symbol === symbol).map(event =>
      [event.eventId, event.time, event.effectiveDate, event.shareNumerator, event.shareDenominator, event.riskPriceFactor])
  ]);
}
function corporateBlock(engine, symbol, q, snapshot, allowVerifiedExit = false) {
  let found = membership(engine, symbol);
  if (!found) return { status: 'clear', reason: '' };
  const blocked = reason => ({ status: 'blocked', reason });
  const waiting = reason => ({ status: 'waiting', reason });
  const needsCorporate = engine.agencyNeedsCorporateEvidence(symbol);
  const automatic = needsCorporate && snapshot?.corporateActions ? engine.agencyProcessCorporateActions(symbol, q, snapshot) : null;
  found = membership(engine, symbol);
  const { member } = found;
  if (automatic?.status === 'blocked') return blocked(pending(engine, member, automatic.reason, automatic.evidence, automatic.affectsEquity));
  if (needsCorporate && member.reconciliation.status === 'pending' && automatic?.status !== 'clear') return blocked(`待对账：${member.reconciliation.reason}`);
  // Current data availability is distinct from the persisted reconciliation
  // latch. Keep that latch until all price checks pass, but report today's
  // missing input instead of an already-resolved corporate-source failure.
  if (!q) return waiting(typeof snapshot?.error === 'string' && snapshot.error.trim()
    ? snapshot.error.trim() : '行情尚未获取，价格基准尚未核验，暂停自动交易');
  const now = engine.clock().getTime(), basis = member.exitPriceBasis;
  const dailyProblem = typeof snapshot?.error === 'string' && snapshot.error.trim() ? snapshot.error.trim()
    : !snapshot || snapshot.error || !snapshot.technical ? '策略日线尚未获取，价格基准尚未核验，等待新鲜日线'
      : (snapshot.dailyEvidence !== undefined ? !preparedTechnicalValid(snapshot, now, symbol)
        : !Number.isFinite(snapshot.fetchedAt) || now - snapshot.fetchedAt > 180000 || snapshot.fetchedAt > now + 15000)
        ? `${snapshot.dailyEvidence !== undefined ? '日线证据' : '日线获取时间'}无效或已过期，价格基准尚未核验，等待新鲜日线` : null;
  if (dailyProblem) {
    // An unavailable daily refresh must not disable an already verified exit.
    // This is same-day price evidence, never permission to recalculate a plan
    // or to clear an unresolved ledger/corporate-action latch.
    if (!allowVerifiedExit || member.reconciliation.status !== 'clear' || member.awaitingVerification
      || !validExitPriceBasis(basis) || basis.date !== q.date || q.symbol !== symbol
      || needsCorporate && basis.corporateVerified === false
      || basis.checkedAt > now || basis.corporateBasis !== corporatePriceBasis(engine, symbol)) return waiting(dailyProblem);
    if (!Number.isFinite(q.prevClose) || Math.abs(basis.prevClose - q.prevClose) > 0.011)
      return blocked(pending(engine, member, '行情与当日已核验价格基准不一致，等待重新核验完整日线', [{ verifiedReference: basis.prevClose, marketReference: q.prevClose, quoteDate: q.date }]));
  }
  const t = dailyProblem ? { asOf: basis.dailyAsOf, close: basis.dailyClose } : snapshot.technical;
  if (!validDate(t.asOf) || t.asOf >= q.date || !validDate(q.date)) return waiting('完整日线日期尚未核验，暂停自动交易');
  const reference = q.prevClose;
  const holding = engine.s.lots.some(l => l.symbol === symbol);
  const previousDate = member.lastVerifiedDate;
  if (automatic?.status !== 'clear' && holding && previousDate && q.date > previousDate && (!Array.isArray(t.dates) || !t.dates.includes(previousDate)
    || t.dates.some(date => date > previousDate && date < q.date))) {
    return blocked(pending(engine, member, '持仓跨越未核验交易日，需补核离线期间公司行为', [{ previousDate, quoteDate: q.date }]));
  }
  const todayActions = needsCorporate ? (engine.s.agency.corporateActions || []).filter(action => action.symbol === symbol && action.status !== 'exception' && action.terms.exDate === q.date) : [];
  const expectedReference = todayActions.reduce((price, action) => (price - action.terms.cashPerShare) / (1 + action.terms.bonusPerShare + action.terms.transferPerShare), t.close);
  if (!Number.isFinite(reference) || !Number.isFinite(expectedReference) || Math.abs(expectedReference - reference) > 0.011) {
    return blocked(pending(engine, member, '行情与完整日线价格基准不一致，需核实除权或缺失日线', [{ dailyClose: t.close, marketReference: reference, asOf: t.asOf, quoteDate: q.date }]));
  }
  const notices = snapshot?.notices, check = checkNoticeRisk(notices, symbol, engine.clock());
  const cachedCorporate = dailyProblem && basis.corporateVerified !== false && !notices && !snapshot?.corporateActions
    && now - basis.corporateCheckedAt <= 300000 && basis.corporateCheckedAt <= now;
  if (needsCorporate && automatic?.status !== 'clear' && !cachedCorporate && (!check.coverageComplete || !['clear', 'blocked', 'unverified'].includes(check.status) || !Array.isArray(notices?.data?.items)
    || !Number.isFinite(notices.fetchedAt) || now - notices.fetchedAt > 300000)) return waiting('公司行为公告资料尚未核验，暂停自动交易');
  const today = cnTime(engine.clock()).date;
  // A reviewed announcement may describe a future distribution. Reviewing it
  // without booking an entitlement is only a same-day acknowledgement.
  const reconciledIds = new Set(engine.s.agency.corporateEvents.filter(e => e.symbol === symbol
    && (!e.confirmationOnly || cnTime(e.time).date === today)).flatMap(e => [e.eventId, ...(e.noticeIds || [])]));
  for (const notice of automatic?.coveredNoticeIds || []) reconciledIds.add(notice);
  const items = (!needsCorporate || automatic?.status === 'clear' || cachedCorporate ? [] : notices.data.items).filter(item => /分红|派息|送股|送转|转增|除权|除息|权益分派|配股|利润分配实施/.test(item.title || '') && !reconciledIds.has(item.id));
  if (items.length) return blocked(pending(engine, member, '发现分红送转等公司行为公告，核实生效日期及持仓权益后恢复', items.map(item => ({ id: item.id, title: item.title, date: item.date }))));
  if (dailyProblem) return { status: 'clear', reason: '', exitOnly: true, dailyReason: dailyProblem };
  member.lastVerifiedAt = engine.clock().toISOString();
  member.lastVerifiedDate = q.date;
  member.exitPriceBasis = { date: q.date, prevClose: q.prevClose, dailyAsOf: t.asOf, dailyClose: t.close, checkedAt: now,
    corporateCheckedAt: !needsCorporate ? now : automatic?.status === 'clear' ? snapshot.corporateActions.fetchedAt : notices.fetchedAt,
    corporateVerified: needsCorporate,
    corporateBasis: corporatePriceBasis(engine, symbol) };
  if (!needsCorporate) {
    member.corporateVerification = { status: 'not-required', reason: '首次开仓不预先获取公司行为资料，成交后核验持仓权益', affectsEquity: false };
    if (engine.s.agency.corporateChecks[symbol]?.affectsEquity === false) delete engine.s.agency.corporateChecks[symbol];
  }
  if (member.reconciliation.status === 'pending') { member.reconciliation = { status: 'clear', reason: '' }; bump(engine); }
  member.awaitingVerification = false;
  return { status: 'clear', reason: '' };
}
function preparationDailyDate(now) {
  const local = cnTime(now), firstOffset = local.minutes >= 900 ? 0 : 1;
  for (let offset = firstOffset; offset < 20; offset++) {
    const date = new Date(Date.parse(`${local.date}T00:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);
    const day = calendarSession(new Date(`${date}T10:00:00+08:00`));
    if (!day.known) throw Error('最近完整交易日的日历未经核验，等待更新交易日历');
    if (day.open) return date;
  }
  throw Error('无法确认最近完整交易日，等待日线核验');
}
function currentPreparation(check, now) {
  if (check?.status !== 'waiting' || check.phase !== 'prepared') return false;
  const checkedAt = Date.parse(check.checkedAt), at = now.getTime();
  if (!Number.isFinite(checkedAt) || checkedAt > at || cnTime(checkedAt).date !== cnTime(at).date) return false;
  try { return check.dailyAsOf === preparationDailyDate(now); } catch { return false; }
}
function installAgency(Engine) {
  const base = Object.fromEntries(['execute', 'selectedStrategy', 'selectStrategy', 'place', 'cancel', 'setRisk', 'configure', 'record'].map(k => [k, Engine.prototype[k]]));
  // Internal checks need one strategy's current valuation, not copies of every
  // strategy and the potentially large decision audit trail.
  Engine.prototype.agencyGroupState = function(strategyId, quotes = {}) {
    const group = this.s.agency.groups.find(item => item.id === strategyId);
    return group ? groupView(this, group, quotes) : null;
  };
  Engine.prototype.agencyState = function(quotes = {}, { decisionView = entry => entry } = {}) {
    return { version: this.s.agency.version, decisionMode: this.s.agency.decisionMode, rulesVersion: this.s.agency.rulesVersion,
      marketPolicy: structuredClone(this.s.agency.marketPolicy || null),
      migrationNotice: structuredClone(this.s.agency.migrationNotice || null), epoch: this.s.agency.epoch, revision: this.s.agency.revision, manualCash: this.s.agency.manualCash,
      groups: this.s.agency.groups.map(g => groupView(this, g, quotes)), decisions: structuredClone(this.s.agency.decisions.map(decisionView)),
      executionIntents: structuredClone(this.s.agency.executionIntents),
      transfers: structuredClone(this.s.agency.transfers), corporateEvents: structuredClone(this.s.agency.corporateEvents),
      corporateActions: structuredClone(this.s.agency.corporateActions), corporateChecks: structuredClone(this.s.agency.corporateChecks) };
  };
  Engine.prototype.agencyCorporateFromDate = function(symbol) { return corporateFromDate(this.s, symbolOf(symbol), this.clock()); };
  Engine.prototype.agencyNeedsCorporateEvidence = function(symbol) {
    symbol = symbolOf(symbol);
    // A zero current position may still have a dividend receivable or deferred
    // tax. Retain all traded symbols conservatively, including closed cycles.
    if (this.s.lots.some(lot => lot.symbol === symbol) || this.s.trades.some(trade => trade.symbol === symbol)) return true;
    if (this.s.agency.corporateActions.some(action => action.symbol === symbol && (action.entitlements?.length || action.affectsEquity === true))
      || this.s.agency.corporateEvents.some(event => event.symbol === symbol && !event.confirmationOnly)) return true;
    const member = membership(this, symbol)?.member, check = this.s.agency.corporateChecks[symbol];
    return Boolean(check?.status === 'blocked' && check.affectsEquity === true
      || member?.reconciliation.status === 'pending' && member.reconciliation.affectsEquity === true);
  };
  Engine.prototype.agencyCorporateSymbols = function() {
    return [...new Set([...this.s.agency.groups.flatMap(group => group.members.filter(member => member.mode !== 'standby').map(member => member.symbol)),
      ...this.s.lots.filter(lot => lot.owner && lot.owner !== 'manual').map(lot => lot.symbol),
      ...this.s.trades.filter(trade => trade.owner && trade.owner !== 'manual').map(trade => trade.symbol),
      ...this.s.agency.corporateActions.filter(action => action.entitlements?.length || action.affectsEquity === true).map(action => action.symbol),
      ...this.s.agency.corporateEvents.filter(event => !event.confirmationOnly).map(event => event.symbol),
      ...Object.entries(this.s.agency.corporateChecks).filter(([, check]) => check.status === 'blocked' && check.affectsEquity).map(([symbol]) => symbol)])]
      .filter(symbol => this.agencyNeedsCorporateEvidence(symbol));
  };
  Engine.prototype.agencyProcessCorporateActions = function(symbol, quote, snapshot) {
    const result = processCorporateActions(this, symbol, quote, snapshot), found = membership(this, symbolOf(symbol));
    symbol = symbolOf(symbol);
    const source = snapshot?.corporateActions || snapshot, previous = this.s.agency.corporateChecks[symbol];
    const trades = this.s.trades.filter(trade => trade.symbol === symbol && trade.owner && trade.owner !== 'manual');
    const check = { status: result.status, reason: result.reason, checkedAt: this.clock().toISOString(), eventIds: result.events || [],
      affectsEquity: result.affectsEquity, evidence: result.evidence || [], strategyIds: [...new Set([...(found ? [found.group.id] : []), ...trades.map(trade => trade.owner)])],
      events: structuredClone(source?.events || []), coverageStart: source?.coverageStart, coverageEnd: source?.coverageEnd,
      verifiedTradeId: result.status === 'clear' ? trades.at(-1)?.id || null : previous?.verifiedTradeId,
      verifiedNoHoldings: result.status === 'clear' ? !this.s.lots.some(lot => lot.symbol === symbol) : previous?.verifiedNoHoldings };
    this.s.agency.corporateChecks[symbol] = check;
    if (previous && (previous.status !== check.status || previous.reason !== check.reason || previous.affectsEquity !== check.affectsEquity)) bump(this);
    if (found) {
      const member = found.member;
      member.corporateVerification = structuredClone(check);
      if (result.status === 'blocked') pending(this, member, result.reason, result.evidence, result.affectsEquity);
    }
    return result;
  };
  Engine.prototype.agencyTransfer = function({ strategyId, amount }, quotes = {}) {
    const group = groupOf(this, strategyId), numeric = Number(amount);
    if (group.members.some(m => memberAffectsEquity(this.s, m)) || groupHasUnresolvedCorporate(this.s, group.id)) throw Error('策略有待对账或待核验股票，先恢复有效净值后再划拨');
    if (!Number.isFinite(numeric) || numeric === 0 || Math.abs(numeric * 100 - money(numeric)) > 0.00001) throw Error('划拨金额须为非零金额，最多两位小数');
    const change = money(numeric), agency = this.s.agency;
    if (!cents(change)) throw Error('划拨金额超出范围');
    if (change > agency.manualCash || -change > availableCorporateCash(this.s, group.id, this.clock())) throw Error('可划拨现金不足，持仓资金及股息税预留不能转出');
    const valuation = holdingValuation(this.s.lots.filter(lot => lot.owner === group.id), quotes, this.s.marks, this.clock(), '划拨策略资金');
    const before = groupView(this, group, valuation).equity;
    const unitValue = group.units > 0 ? before / group.units : group.unitValue;
    if (!(unitValue > 0) && change > 0) throw Error('策略净值已归零，需重置账户后重新分配资金');
    Object.assign(this.s.marks, valuation);
    group.units += change / (unitValue || 1); if (before + change === 0 || Math.abs(group.units) < 1e-7) group.units = 0;
    if (unitValue > 0) group.unitValue = unitValue;
    group.cash += change; group.netFunding += change; agency.manualCash -= change;
    agency.transfers.push({ id: id(), strategyId, amount: change, time: this.clock().toISOString() }); bump(this);
    return groupView(this, group);
  };
  Engine.prototype.agencyConfigure = function({ strategyId, limits }) {
    const group = groupOf(this, strategyId); group.limits = limitsOf(limits, group.limits); this.s.agency.poolAuthorizationRevision++; bump(this); return groupView(this, group);
  };
  Engine.prototype.agencyMode = function({ strategyId, mode }) {
    if (!MODES.includes(mode)) throw Error('自动交易运行状态无效');
    const group = groupOf(this, strategyId); group.mode = mode; this.s.agency.poolAuthorizationRevision++; bump(this); return groupView(this, group);
  };
  Engine.prototype.agencyMember = function({ strategyId, symbol, action, entryConditions }) {
    symbol = symbolOf(symbol); const group = groupOf(this, strategyId), found = membership(this, symbol);
    const position = this.positions().find(p => p.symbol === symbol);
    if (action === 'add') {
      if (found && found.group.id !== group.id) throw Error('同一股票只能归属一个自动交易策略');
      if (position && !found) throw Error('已有手动持仓，策略不能自动接管');
      if (this.s.orders.some(o => o.symbol === symbol && o.status === 'pending')) throw Error('该股票有待执行手动委托，请先处理');
      if (found) { if (found.member.mode !== 'active' && position) throw Error('已有退出安排，平仓后才能重新加入'); return structuredClone(found.member); }
      const member = { symbol, mode: 'active', selectionMode: 'strategy', addedAt: this.clock().toISOString(), reconciliation: { status: 'clear', reason: '' } };
      if (activeCandidateCount(this.s, group) >= ACTIVE_CANDIDATE_LIMIT) setStandby(this.s, member);
      const savedConditions = createEntryConditions(automaticEntryConditions(entryConditions, this.clock()), this.clock());
      if (savedConditions) member.entryConditions = savedConditions;
      group.members.push(member); this.s.agency.poolAuthorizationRevision++; bump(this); return structuredClone(member);
    }
    if (!found || found.group.id !== group.id) throw Error('股票不在该自动交易策略中');
    if (!['remove', 'close'].includes(action)) throw Error('策略自选操作无效');
    if (!position) group.members = group.members.filter(m => m.symbol !== symbol);
    else {
      found.member.mode = action === 'remove' ? 'removing' : 'closing';
      if (action === 'close') {
        const risk = this.s.risks[symbol];
        if (!risk) throw Error('持仓退出计划缺失，需核对账户');
        risk.pendingExit = '用户要求尽快平仓'; risk.enabled = true;
      }
    }
    this.s.agency.poolAuthorizationRevision++; bump(this); return position ? structuredClone(found.member) : { symbol, removed: true };
  };
  Engine.prototype.agencyLog = function(record) {
    const entry = { ...structuredClone(record), id: record.id || id(), time: record.time || this.clock().toISOString() };
    this.s.agency.decisions.push(entry); if (this.s.agency.decisions.length > 500) this.s.agency.decisions.splice(0, this.s.agency.decisions.length - 500);
    return entry;
  };
  Engine.prototype.agencyAutomaticCheck = function(symbol, q, snapshot, { allowVerifiedExit = false } = {}) {
    const found = membership(this, symbol); if (!found) return { status: 'clear', reason: '' };
    const record = result => {
      // Diagnostics do not grant execution permission or alter account
      // revisions. Corporate processing may replace member objects, so fetch
      // the current member before recording the outcome.
      const current = membership(this, symbol);
      const diagnostic = result.exitOnly ? { ...result, status: 'waiting',
        reason: `${result.dailyReason}；日线复核暂停，已存价位和待完成退出目标继续监控` } : result;
      if (current) current.member.automaticCheck = { ...diagnostic, dailyHistory: publicDailyHistory(snapshot, this.clock().getTime(), symbol), checkedAt: this.clock().toISOString() };
      return result;
    };
    if (found.group.mode === 'stopped') return record({ status: 'blocked', reason: '本策略全部自动操作已停止' });
    const trading = calendarSession(this.clock());
    if (!trading.known || !trading.open) {
      // A holding's frequent risk tick must not erase the historical preparation
      // result. Preserve its original timestamp, but return the same closed-
      // session execution block; this diagnostic never grants trade permission.
      if (trading.known && currentPreparation(found.member.automaticCheck, this.clock())) return { status: 'waiting', reason: trading.label };
      return record({ status: 'waiting', reason: trading.label });
    }
    return record(corporateBlock(this, symbol, q, snapshot, allowVerifiedExit));
  };
  Engine.prototype.agencyAutomaticBlock = function(symbol, q, snapshot) {
    return this.agencyAutomaticCheck(symbol, q, snapshot).reason || null;
  };
  Engine.prototype.agencyPrepare = function(symbol, q, snapshot) {
    const found = membership(this, symbol); if (!found) return null;
    const trading = calendarSession(this.clock());
    // Execution keeps the original session, quote and reconciliation gates.
    if (trading.open && trading.known) return this.agencyAutomaticBlock(symbol, q, snapshot);
    const record = result => {
      const current = membership(this, symbol);
      if (current) current.member.automaticCheck = { ...result, dailyHistory: publicDailyHistory(snapshot, this.clock().getTime(), symbol), checkedAt: this.clock().toISOString() };
      return result.reason || null;
    };
    const waiting = reason => record({ status: 'waiting', reason });
    if (found.group.mode === 'stopped') return record({ status: 'blocked', reason: '本策略全部自动操作已停止' });
    if (!trading.known) return waiting(trading.label);
    // Corporate dates and replayed holdings determine entitlement postings;
    // yesterday's quote must never become today's price-reference evidence.
    // Registration-day holdings are captured only after that day's close by
    // the existing corporate ledger. Its idempotent date gates also apply here.
    const needsCorporate = this.agencyNeedsCorporateEvidence(symbol);
    const automatic = needsCorporate ? this.agencyProcessCorporateActions(symbol, undefined, snapshot) : null;
    if (automatic?.status === 'blocked') return record({ status: 'blocked', reason: automatic.reason });
    if (needsCorporate && automatic?.status !== 'clear') return waiting(automatic?.reason || '公司行为实施资料尚未核验');
    if (typeof snapshot?.error === 'string' && snapshot.error.trim()) return waiting(snapshot.error.trim());
    const at = this.clock().getTime(), technical = snapshot?.technical;
    if (!technical) return waiting('策略日线尚未获取，等待最近完整交易日的日线');
    if (typeof snapshot.source !== 'string' || !snapshot.source.trim() || snapshot.source === '来源未标注'
      || (snapshot.dailyEvidence !== undefined ? !preparedTechnicalValid(snapshot, at, symbol)
        : !Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt <= 0 || at - snapshot.fetchedAt > 180000
          || snapshot.fetchedAt > at + 15000)) return waiting('日线来源或证据无效、已过期，等待新鲜日线');
    let expectedDate;
    try { expectedDate = preparationDailyDate(this.clock()); } catch (error) { return waiting(error.message); }
    if (!validDate(technical.asOf) || technical.asOf !== expectedDate || !Number.isFinite(technical.close) || technical.close <= 0)
      return waiting(`最近完整交易日 ${expectedDate} 的日线尚未核验，等待补齐日线`);
    const current = membership(this, symbol), latch = current.member.reconciliation;
    const reference = preopenPriceReference(symbol, q, technical, needsCorporate ? this.s.agency.corporateActions : [], at);
    const reason = `${needsCorporate ? '历史日线和公司行为资料' : '历史日线'}已准备（截至 ${expectedDate}）；等待开盘后实时行情、价格基准和入场校验`
      + (reference.status !== 'waiting' ? `；${reference.reason}` : '')
      + (latch.status === 'pending' ? `；原待对账状态保留：${latch.reason}` : '');
    // Prepared evidence grants no permission and clears no persisted latch.
    // In particular, lastVerifiedDate and awaitingVerification belong to the
    // complete in-session price check, never to an offline preparation pass.
    return record({ status: 'waiting', phase: 'prepared', dailyAsOf: expectedDate, reference, reason });
  };
  Engine.prototype.agencyPendingExit = function(symbol) {
    return this.s.agency.executionIntents.find(intent => intent.symbol === symbol && intent.status === 'pending') || null;
  };
  Engine.prototype.agencyAutomaticSell = function(input, q, quotes, reason) {
    const intent = this.agencyPendingExit(input.symbol);
    if (!intent) return this.execute(input, q, quotes, reason);
    this._agencyContext = { strategyId: intent.strategyId, sourceDecisionId: intent.decisionId, decisionId: `${intent.decisionId}:fill:${intent.tradeIds.length + 1}` };
    try { return this.execute(input, q, quotes, reason); } finally { delete this._agencyContext; }
  };
  Engine.prototype.agencyEvaluate = function(strategyId, symbol, q, snapshot, requestedQuantity, quotes = {}) {
    symbol = symbolOf(symbol); const group = groupOf(this, strategyId), found = membership(this, symbol);
    const holding = this.s.lots.some(lot => lot.symbol === symbol);
    const poolBlocked = !holding && poolQualificationPending(this.s.agency, found?.member);
    const poolReasons = found?.member.poolCheck?.reasons || ['请重新更新四策略候选池'];
    // Candidate authorization and current entry conditions are separate checks.
    // A deliberately skipped evidence load is not a new missing-source failure.
    const entryConditionsCheck = !found?.member.entryConditions ? null : poolBlocked
      ? { status: 'skipped', passed: false, skippedBy: 'pool-qualification',
        reason: '候选资格尚未通过，本轮未复核持续开仓条件；请更新四策略候选池完成核验',
        reasons: [...poolReasons], checks: [], checkedAt: this.clock().toISOString(), conditions: structuredClone(found.member.entryConditions) }
      : evaluateEntryConditions(automaticEntryConditions(found.member.entryConditions, this.clock()), symbol, q, snapshot, this.clock());
    const conditionReasons = entryConditionsCheck && entryConditionsCheck.status !== 'skipped' && !entryConditionsCheck.passed
      ? entryConditionsCheck.reasons.map(reason => `${holding ? '持仓提示（不触发卖出）' : '附加开仓条件'}：${reason}`) : [];
    const reject = reason => ({ symbol, strategyId, status: '自动交易规则拦截', buyable: false, quantity: 0,
      reasons: [reason, ...conditionReasons], ...(entryConditionsCheck ? { entryConditionsCheck } : {}), checkedAt: this.clock().getTime() });
    if (!found || found.group.id !== strategyId) return reject('股票不在授权自动交易组');
    if (found.member.mode === 'standby') return reject(`当前为候补，不参与自动开仓：${found.member.standbyReason}`);
    if (group.mode !== 'running' || found.member.mode !== 'active') return reject('策略已暂停新开仓或股票正在退出');
    if (poolBlocked) {
      return reject(`候选池资格待核验，暂停新开仓：${poolReasons.join('；') || '请重新更新四策略候选池'}`);
    }
    const block = this.agencyAutomaticBlock(symbol, q, snapshot); if (block) return reject(block);
    const adaptive = this.s.agency.marketPolicy?.enabled === true;
    const marketRegime = adaptive ? validateMarketRegimeSnapshot(snapshot?.marketRegime, this.clock()) : null;
    if (adaptive && !holding && !marketRegime.allowEntry) return { ...reject(marketRegime.reasons.join('；')), marketRegime, status: '市场环境暂停新开仓' };
    const multiplier = adaptive ? marketRegime.riskMultiplier : 1;
    // Every position contributes to account equity and therefore to the account
    // concentration limit. A fresh entry quote cannot make stale collateral
    // usable. Price-only marks are sufficient here; exit liquidity is unrelated.
    const valuationQuotes = { ...quotes, [symbol]: q }, now = this.clock().getTime(), today = cnTime(now).date;
    const valuationEvidence = { checkedAt: now, quotes: [] };
    for (const heldSymbol of new Set(this.s.lots.map(lot => lot.symbol))) {
      const mark = valuationQuotes[heldSymbol] ?? this.s.marks[heldSymbol];
      const age = now - mark?.timestamp;
      if (!mark || mark.symbol !== heldSymbol || !Number.isFinite(mark.price) || mark.price <= 0
        || !Number.isFinite(mark.timestamp) || age > 90000 || age < -15000 || mark.date !== today || cnTime(mark.timestamp).date !== today) {
        return reject(`账户持仓 ${heldSymbol} 缺少有效估值报价，需同日 90 秒内价格后才能计算新开仓风险预算`);
      }
      valuationQuotes[heldSymbol] = mark;
      valuationEvidence.quotes.push({ symbol: heldSymbol, price: mark.price, timestamp: mark.timestamp, date: mark.date, source: mark.source || '来源未标注' });
    }
    const stat = groupView(this, group, valuationQuotes);
    if (!stat.comparable) return reject('本策略有待对账或待核验股票，权益尚不可用于新开仓风险预算');
    if (stat.positions.length >= group.limits.maxPositions && !stat.positions.some(p => p.symbol === symbol)) return reject('达到本策略持仓数量上限');
    const facade = Object.create(this);
    facade.s = { ...this.s, cash: stat.availableCash, settings: { ...this.s.settings, maxPosition: group.limits.maxPosition },
      marketAdaptiveEntry: adaptive,
      strategySettings: { ...configureStrategy({ ...this.s.strategySettings, riskPercent: group.limits.riskPercent, minRewardRisk: group.limits.minRewardRisk }), riskPercent: group.limits.riskPercent * multiplier } };
    facade.stats = () => ({ ...stat, cash: stat.availableCash });
    const result = { ...evaluateEntry(facade, symbol, q, snapshot, requestedQuantity, strategyId, { technicalOnly: true }), valuationEvidence, ...(adaptive ? { marketRegime } : {}),
      ...(entryConditionsCheck ? { entryConditionsCheck } : {}) };
    if (adaptive && result.plan) result.plan.marketRegime = structuredClone(marketRegime);
    if (entryConditionsCheck) {
      if (result.plan) result.plan.entryConditionsCheck = structuredClone(entryConditionsCheck);
      result.reasons.push(...conditionReasons);
      if (!holding && !entryConditionsCheck.passed) {
        result.buyable = false; result.quantity = 0; result.economics = null;
        result.status = entryConditionsCheck.status === 'pending' ? '附加条件待核验' : '等待附加开仓条件';
      }
    }
    if (!result.buyable) return result;
    const existingRisk = stat.positions.reduce((total, p) => {
      const stop = p.risk?.stop;
      if (!(stop > 0)) return total + p.cost;
      const proceeds = Math.max(1, money(stop) - this.s.settings.slippageTicks) * p.quantity;
      return total + Math.max(0, p.cost - proceeds + fees(proceeds, 'sell', this.s.settings).total);
    }, 0);
    const availableRisk = Math.max(0, Math.floor(stat.equity * group.limits.maxPlannedRiskPercent * multiplier / 100) - existingRisk);
    const account = this.stats(valuationQuotes);
    const accountRoom = Math.floor(account.equity * this.s.settings.maxPosition) - (account.positions.find(p => p.symbol === symbol)?.value || 0);
    const exposureRoom = Math.max(0, Math.min(accountRoom, Math.floor(stat.equity * group.limits.maxTotalPosition) - stat.marketValue));
    const minimum = symbol.startsWith('sh688') ? 200 : 100, step = symbol.startsWith('sh688') ? 1 : 100;
    let low = 0, high = Math.max(0, Math.floor((result.quantity - minimum) / step) + 1);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2), quantity = minimum + (mid - 1) * step;
      const e = economics(result.plan.entry, result.plan.stop, result.plan.target, quantity, this.s.settings);
      if (e.loss <= availableRisk && money(result.plan.entry) * quantity <= exposureRoom) low = mid; else high = mid - 1;
    }
    const permitted = low ? minimum + (low - 1) * step : 0;
    if (!permitted) return reject('策略总仓位或总计划风险预算不足；计划风险不代表最大实际损失');
    if (requestedQuantity != null && requestedQuantity > permitted) return reject(`策略总仓位或总计划风险最多允许 ${permitted} 股`);
    const final = permitted < result.quantity ? evaluateEntry(facade, symbol, q, snapshot, permitted, strategyId, { technicalOnly: true }) : result;
    if (adaptive && final.plan) final.plan.marketRegime = structuredClone(marketRegime);
    if (entryConditionsCheck && final.plan) final.plan.entryConditionsCheck = structuredClone(entryConditionsCheck);
    return { ...final, ...(adaptive ? { marketRegime } : {}), ...(entryConditionsCheck ? { entryConditionsCheck } : {}), valuationEvidence, aggregatePlannedRisk: existingRisk, aggregateRiskBudget: availableRisk, maxQuantity: Math.min(final.maxQuantity, permitted) };
  };
  Engine.prototype.agencyExecute = function(input, q, snapshot, quotes = {}) {
    const symbol = symbolOf(input.symbol), group = groupOf(this, input.strategyId), found = membership(this, symbol), a = this.s.agency;
    if (typeof input.decisionId !== 'string' || !input.decisionId.trim() || input.decisionId.length > 200) throw Error('缺少有效自动交易决策编号');
    if (this.s.trades.some(t => t.decisionId === input.decisionId) || a.executionIntents.some(intent => intent.decisionId === input.decisionId)) throw Error('该自动交易决策已执行或已登记退出意图，禁止重复执行');
    if (input.expectedEpoch !== a.epoch || input.expectedRevision !== a.revision) throw Error('账户或自动交易授权已变化，旧决策失效');
    if (!found || found.group.id !== group.id || group.mode === 'stopped') throw Error('自动交易权限已停止或股票已移出');
    if (!['buy', 'sell', 'reduce'].includes(input.action)) throw Error('自动交易动作无效');
    const block = this.agencyAutomaticBlock(symbol, q, snapshot); if (block) throw Error(block);
    this.fresh(q);
    const target = input.targetPercent == null ? null : numberIn(input.targetPercent, 0, 100, '目标仓位（%）');
    const context = { strategyId: group.id, decisionId: input.decisionId };
    if (input.action === 'buy') {
      if (!(target > 0)) throw Error('买入决策须提供大于零的目标仓位');
      const valuationQuotes = { ...quotes, [symbol]: q };
      const ev = this.agencyEvaluate(group.id, symbol, q, snapshot, undefined, valuationQuotes);
      if (!ev.buyable) throw Error(`${ev.status}：${ev.reasons.join('；')}`);
      const targetQuantity = Math.floor(groupView(this, group, valuationQuotes).equity * target / 100 / money(ev.plan.entry));
      const quantity = symbol.startsWith('sh688') ? Math.min(ev.quantity, targetQuantity) : Math.floor(Math.min(ev.quantity, targetQuantity) / 100) * 100;
      if (quantity < (symbol.startsWith('sh688') ? 200 : 100)) throw Error('目标仓位不足以买入最小申报数量');
      const archiveRequired = usesAutomaticEvidence(automaticEntryConditions(found.member.entryConditions, this.clock()));
      if (archiveRequired || input.archiveEntryEvidence) {
        if (typeof input.archiveEntryEvidence !== 'function') throw Error('永久开仓依据归档服务未配置，本次未开仓');
        const finalEvaluation = this.agencyEvaluate(group.id, symbol, q, snapshot, quantity, valuationQuotes);
        if (!finalEvaluation.buyable) throw Error(`${finalEvaluation.status}：${finalEvaluation.reasons.join('；')}`);
        const payload = { version: 1, symbol, strategyId: group.id, decisionId: input.decisionId, createdAt: this.clock().toISOString(),
          rulesVersion: a.rulesVersion, accountEpoch: a.epoch, accountRevision: a.revision,
          entryConditions: structuredClone(found.member.entryConditions || null), poolCheck: structuredClone(found.member.poolCheck || null),
          poolPolicy: structuredClone(a.pool?.policy || null), strategySettings: structuredClone(this.s.strategySettings), limits: structuredClone(group.limits),
          execution: { quantity: finalEvaluation.quantity, quote: structuredClone(q), evaluation: structuredClone(finalEvaluation) },
          ruleDecision: structuredClone(input.entryEvidenceContext || null), snapshot: structuredClone(snapshot) };
        const ref = input.archiveEntryEvidence(payload);
        if (ref?.then) { ref.catch?.(() => {}); throw Error('永久开仓依据归档必须同步完成，本次未开仓'); }
        if (!validEntryEvidenceRef(ref) || ['symbol', 'strategyId', 'decisionId', 'createdAt'].some(key => ref[key] !== payload[key])) throw Error('永久开仓依据归档引用无效，本次未开仓');
        context.entryEvidenceRef = structuredClone(ref);
      }
      this._agencyContext = context;
      try { return this.strategyEntry({ symbol, strategyId: group.id, quantity }, q, snapshot, valuationQuotes); }
      finally { delete this._agencyContext; }
    }
    const p = this.positions(quotes).find(p => p.symbol === symbol);
    if (!p || !this.s.lots.some(l => l.symbol === symbol && l.owner === group.id)) throw Error('没有本策略持仓');
    let desired = input.action === 'sell' ? p.quantity : Math.ceil(p.quantity / 2);
    if (target !== null) desired = p.quantity - Math.floor(groupView(this, group, quotes).equity * target / 100 / money(q.price));
    if (desired <= 0) throw Error('当前持仓未超过目标仓位，无需卖出');
    if (this.s.risks[symbol]?.pendingExit) desired = p.quantity;
    desired = Math.min(desired, p.quantity);
    if (desired !== p.quantity) desired = symbol.startsWith('sh688') ? (desired >= 200 ? desired : 0) : Math.floor(desired / 100) * 100;
    if (!desired) throw Error('目标减仓量不足最小申报数量');
    if (this.agencyPendingExit(symbol)) throw Error('已有待完成退出目标，等待原目标完成后再研判');
    const intent = { decisionId: input.decisionId, strategyId: group.id, symbol, action: input.action, targetQuantity: Math.max(0, p.quantity - desired), status: 'pending', createdAt: this.clock().toISOString(), tradeIds: [] };
    a.executionIntents.push(intent); bump(this);
    const max = Math.min(maxOrderQuantity(symbol), desired, p.available, Math.floor(this.liquidity(q, 'sell')));
    const quantity = max === p.available ? max : symbol.startsWith('sh688') ? (max >= 200 ? max : 0) : Math.floor(max / 100) * 100;
    if (!quantity) return { pending: true, decisionId: input.decisionId, symbol, side: 'sell', quantity: 0, owner: group.id, reason: '退出目标已保存；受 T+1 或盘口数量限制，等待后续可成交报价' };
    this._agencyContext = context;
    try { return this.execute({ symbol, side: 'sell', quantity, automatic: true }, q, quotes, `策略自动${input.action === 'reduce' ? '减仓' : '退出'}`); }
    catch (error) { return { pending: true, decisionId: input.decisionId, symbol, side: 'sell', quantity: 0, owner: group.id, reason: `退出目标已保存；${error.message}` }; }
    finally { delete this._agencyContext; }
  };
  Engine.prototype.selectedStrategy = function(symbol) {
    return this._agencyContext?.strategyId || membership(this, symbolOf(symbol))?.group.id || base.selectedStrategy.call(this, symbol);
  };
  Engine.prototype.execute = function(input, q, quotes = {}, reason) {
    const symbol = symbolOf(input.symbol), found = membership(this, symbol), context = this._agencyContext;
    const owner = input.side === 'buy' ? (context?.strategyId || 'manual') : (this.s.lots.find(l => l.symbol === symbol)?.owner || 'manual');
    const group = owner === 'manual' ? null : groupOf(this, owner);
    if (input.side === 'buy' && found && !context) throw Error('该股票已授权策略自动交易，请先移出自动交易组再手动买入');
    if (context && (!found || found.group.id !== context.strategyId)) throw Error('自动交易归属不匹配');
    if (context && input.side === 'buy' && (group.mode !== 'running' || found.member.mode !== 'active')) throw Error('策略自动新开仓已暂停');
    if (group && input.automatic && group.mode === 'stopped') throw Error('该策略已停止全部自动操作');
    if (group && found.member.reconciliation.status === 'pending') throw Error('该股票待对账，暂停交易以保护账务');
    // Preserve all existing execution validations, including account-level
    // concentration. Roll back any later bookkeeping error as one transaction.
    const before = structuredClone(this.s), oldCash = this.s.cash;
    try {
      if (input.side === 'buy') {
        assertCorporatePurchase(this, symbol);
        const available = group ? availableCorporateCash(this.s, group.id, this.clock()) : this.s.agency.manualCash;
        const price = money(q?.ask) + this.s.settings.slippageTicks, gross = price * Number(input.quantity);
        const fee = fees(gross, 'buy', this.s.settings).total;
        if (gross + fee > available) throw Error(group ? '本策略可用资金不足' : '手动可用资金不足，自动交易资金不可挪用');
      }
      let trade;
      this._agencyPosting = true;
      try { trade = base.execute.call(this, input, q, quotes, reason); } finally { this._agencyPosting = false; }
      const delta = this.s.cash - oldCash;
      if (group) group.cash += delta; else this.s.agency.manualCash += delta;
      trade.owner = owner;
      if (context) trade.decisionId = context.decisionId;
      if (context?.entryEvidenceRef && input.side === 'buy') { trade.entryEvidenceRequired = true; trade.entryEvidenceRef = structuredClone(context.entryEvidenceRef); }
      if (context?.sourceDecisionId) trade.sourceDecisionId = context.sourceDecisionId;
      if (group) {
        trade.strategyId = group.id; trade.manualIntervention = !context && !input.automatic;
        let cycle = group.cycles.find(c => c.symbol === symbol && c.status === 'open');
        if (input.side === 'buy') {
          if (cycle) throw Error('该自动交易股票已有未结束交易周期');
          cycle = { id: id(), symbol, status: 'open', openedAt: trade.time, pnl: 0, fees: 0, dividends: 0, tradeIds: [] };
          if (trade.entryEvidenceRef) cycle.entryEvidenceRef = structuredClone(trade.entryEvidenceRef);
          group.cycles.push(cycle);
          const lot = this.s.lots.at(-1); lot.owner = group.id; lot.cycleId = cycle.id;
          if (trade.entryEvidenceRef) lot.entryEvidenceRef = structuredClone(trade.entryEvidenceRef);
        }
        if (!cycle) throw Error('自动交易持仓交易周期缺失');
        trade.cycleId = cycle.id; cycle.tradeIds.push(trade.id); cycle.fees += trade.fees.total; cycle.pnl += trade.pnl || 0;
        if (!this.s.lots.some(l => l.symbol === symbol)) {
          cycle.status = 'closed'; cycle.closedAt = trade.time;
          if (found.member.mode !== 'active') group.members = group.members.filter(m => m.symbol !== symbol);
          else {
            if (found.member.selectionMode === 'strict') found.member.poolCheck = pendingPoolCheck(require('./agency-screening.cjs').poolPolicy('strict'), this.clock(), '原持仓已平仓，请重新进行严格研究筛选后再参与新开仓');
            if (activeCandidateCount(this.s, group) > ACTIVE_CANDIDATE_LIMIT) setStandby(this.s, found.member);
          }
        }
        const intent = this.agencyPendingExit(symbol);
        if (intent && input.side === 'sell') {
          intent.tradeIds.push(trade.id);
          const remaining = this.s.lots.filter(l => l.symbol === symbol).reduce((n, l) => n + l.quantity, 0);
          if (remaining <= intent.targetQuantity) { intent.status = 'completed'; intent.completedAt = trade.time; }
        }
      } else if (input.side === 'buy') this.s.lots.at(-1).owner = 'manual';
      if (input.side === 'sell') settleDividendTaxes(this);
      this.record(quotes, true);
      bump(this); return trade;
    } catch (error) {
      // Validation failures are mutation-free. Keep live order/risk references
      // intact so the tick loop can update their notes and retry next quote.
      if (JSON.stringify(this.s) !== JSON.stringify(before)) this.s = before;
      throw error;
    }
  };
  for (const method of ['selectStrategy', 'place', 'cancel', 'setRisk', 'configure']) {
    Engine.prototype[method] = function(...args) {
      const symbol = method === 'place' ? symbolOf(args[0].symbol) : ['setRisk', 'selectStrategy'].includes(method) ? symbolOf(args[0]) : null;
      if (symbol && membership(this, symbol) && ['place', 'selectStrategy'].includes(method)) throw Error('自动交易股票不能添加手动委托或更换手动策略');
      const result = base[method].apply(this, args); bump(this); return result;
    };
  }
  Engine.prototype.record = function(quotes, force = false) {
    if (!this.s.agency?.groups.some(g => g.members.some(m => memberAffectsEquity(this.s, m)) || groupHasUnresolvedCorporate(this.s, g.id))) base.record.call(this, quotes, force);
    // During execute the per-group cash has not yet been posted.
    if (this.s.agency && this.s.cash === this.s.agency.manualCash + this.s.agency.groups.reduce((n, g) => n + g.cash, 0)) for (const g of this.s.agency.groups) recordGroup(this, g, quotes);
  };
  Engine.prototype.agencyReconcile = function(input) {
    const symbol = symbolOf(input.symbol), group = groupOf(this, input.strategyId), found = membership(this, symbol), today = cnTime(this.clock()).date;
    if (!found || found.group.id !== group.id) throw Error('股票不在对应自动交易组');
    if (typeof input.eventId !== 'string' || !input.eventId.trim() || input.eventId.length > 200) throw Error('对账需要唯一事件编号');
    if (this.s.agency.corporateEvents.some(e => e.symbol === symbol && e.eventId === input.eventId)) throw Error('该公司行为已经对账，禁止重复入账');
    if (typeof input.evidence !== 'string' || input.evidence.trim().length < 8 || input.evidence.length > 8000) throw Error('请提供公告来源、权益登记与到账依据');
    if (!validDate(input.effectiveDate) || input.effectiveDate > today) throw Error('只允许对已生效事件对账');
    const cash = money(numberIn(input.cashAmount ?? 0, 0, 100000000, '实际净分红入账金额'));
    const numerator = numberIn(input.shareNumerator ?? 1, 1, 1000, '送转后股份比例分子'), denominator = numberIn(input.shareDenominator ?? 1, 1, 1000, '送转后股份比例分母');
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < denominator) throw Error('仅支持整数比例的送转增股；配股、合并等需单独处理');
    const changed = cash > 0 || numerator !== denominator;
    const pendingNoticeIds = (found.member.reconciliation.evidence || []).map(item => item.id).filter(Boolean);
    const providedNoticeIds = input.noticeIds ?? [];
    if (!Array.isArray(providedNoticeIds) || providedNoticeIds.some(value => typeof value !== 'string' || !/^(?:AN|CN)\d{10,30}$/.test(value))) throw Error('对账公告编号格式无效');
    const noticeIds = [...new Set([...pendingNoticeIds, ...providedNoticeIds, ...(/^(?:AN|CN)\d{10,30}$/.test(input.eventId) ? [input.eventId] : [])])];
    if (changed && this.s.agency.corporateActions.some(action => action.symbol === symbol && (action.registeredAt || action.exAppliedAt)
      && (action.terms.recordDate === input.recordDate || action.noticeIds.some(notice => noticeIds.includes(notice))))) throw Error('该批权益已有自动账务阶段，不能再次手工入账');
    if (numerator !== denominator && this.s.agency.corporateActions.some(action => action.symbol === symbol && action.entitlements.some(e => e.grossCash > 0
      && e.disposals.reduce((sum, d) => sum + d.quantity, 0) < e.quantity))) throw Error('该股票仍有递延股息税权益，手工送转需先逐笔核验税务分摊');
    if (changed && this.s.agency.corporateEvents.some(event => event.symbol === symbol && !event.confirmationOnly
      && (event.recordDate === input.recordDate || event.eventId === input.eventId || (event.noticeIds || []).some(notice => noticeIds.includes(notice))))) {
      throw Error('该股票相同权益登记日或公告批次已经入账，不能更换事件编号重复处理；同批现金与股份需合并核对');
    }
    const lots = this.s.lots.filter(l => l.symbol === symbol && l.owner === group.id);
    if (changed && !lots.length) throw Error('无持仓权益，不能自动归属公司行为入账');
    if (changed && (!validDate(input.recordDate) || input.recordDate > input.effectiveDate || lots.some(l => l.date > input.recordDate))) throw Error('权益登记日缺失或持仓资格不一致，请先核对');
    const cycle = group.cycles.find(c => c.symbol === symbol && c.status === 'open');
    if (changed && (!cycle || this.s.trades.some(t => t.cycleId === cycle.id && t.side === 'sell' && cnTime(t.time).date > input.recordDate))) throw Error('登记日后已有减仓，需逐笔核对权益，不能按当前持仓推算');
    const factor = changed ? numberIn(input.riskPriceFactor, 0.001, 10, '除权后计划价格调整系数') : 1;
    if (!changed && input.confirmationOnly !== true) throw Error('无股份或现金调整时请明确选择仅核验');
    const resulting = lots.map(l => ({ lot: l, quantity: l.quantity * numerator / denominator }));
    if (resulting.some(r => !cents(r.quantity) || r.quantity <= 0)) throw Error('送转产生零碎股份，需核对登记结果后处理');
    const intent = this.agencyPendingExit(symbol), adjustedTarget = intent ? intent.targetQuantity * numerator / denominator : null;
    if (intent && !cents(adjustedTarget)) throw Error('送转后的待退出目标包含零碎股份，需人工核对');
    const risk = this.s.risks[symbol];
    if (changed && risk && ['stop', 'target', 'entryPrice', 'initialStop', 'initialTarget', 'peak'].some(k => risk[k] != null && money(risk[k] * factor) <= 0)) throw Error('调整后计划价格无效');
    for (const r of resulting) r.lot.quantity = r.quantity;
    if (intent) intent.targetQuantity = adjustedTarget;
    // A cash dividend is income. It does not reduce the original book cost;
    // therefore realized income + unrealized P&L equals the group equity gain.
    group.cash += cash; this.s.cash += cash;
    if (cycle) { cycle.pnl += cash; cycle.dividends += cash; }
    if (changed && risk) {
      const oldStop = risk.stop;
      // Execution thresholds must share the new price basis; retain the actual
      // entry and original plan separately so adjustment never rewrites history.
      risk.originalTerms ||= Object.fromEntries(['entryTradeId', 'entryDate', 'entryPrice', 'initialStop', 'initialTarget', 'initialPlannedLoss'].map(key => [key, risk[key]]));
      risk.currentPriceBasis = { type: 'company-action-adjusted', eventId: input.eventId, effectiveDate: input.effectiveDate,
        cumulativeFactor: (risk.currentPriceBasis?.cumulativeFactor || 1) * factor,
        note: '当前风控价格已按公司行为校正；原始成交及初始计划见 originalTerms 和建仓成交记录' };
      for (const key of ['stop', 'target', 'entryPrice', 'initialStop', 'initialTarget', 'peak']) if (Number.isFinite(risk[key])) risk[key] = money(risk[key] * factor) / 100;
      risk.history ||= []; risk.history.push({ time: this.clock().toISOString(), reason: '依据公司行为对账同步校正计划价格', eventId: input.eventId, oldStop, stop: risk.stop, riskPriceFactor: factor });
    }
    const event = { id: id(), symbol, strategyId: group.id, eventId: input.eventId, evidence: input.evidence, effectiveDate: input.effectiveDate,
      recordDate: input.recordDate || null, cycleId: cycle?.id || null, cash, shareNumerator: numerator, shareDenominator: denominator, riskPriceFactor: factor,
      confirmationOnly: !changed, noticeIds, time: this.clock().toISOString() };
    this.s.agency.corporateEvents.push(event); found.member.reconciliation = { status: 'clear', reason: '', eventId: input.eventId };
    found.member.lastVerifiedDate = today;
    found.member.awaitingVerification = true;
    bump(this); return structuredClone(event);
  };
}
module.exports = { migrateAgency, validAgency, installAgency, DEFAULT_LIMITS };
