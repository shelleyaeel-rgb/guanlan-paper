'use strict';
const { cnTime, money, id, symbolOf } = require('./common.cjs');

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const amount = value => Number.isSafeInteger(value) && value >= 0;
const shares = terms => (terms.bonusPerShare || 0) + (terms.transferPerShare || 0);
const actionKey = action => `${action.symbol}:${action.eventId}`;
const unresolved = member => member.reconciliation?.status === 'pending' || member.awaitingVerification;

// Cash distribution tax is deferred until disposal. The reserve is an estimate
// of the liability if remaining shares were sold today, not a posted expense.
// The exact current policy and official references are supplied with each event.
function taxRate(purchaseDate, disposalDate, conservative = false) {
  const bought = new Date(`${purchaseDate}T00:00:00Z`), sold = new Date(`${disposalDate}T00:00:00Z`);
  if (!validDate(purchaseDate) || !validDate(disposalDate) || sold < bought) throw Error('股息税持有日期无效');
  const anniversary = (months) => {
    const result = new Date(bought); result.setUTCDate(1); result.setUTCMonth(result.getUTCMonth() + months);
    const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
    result.setUTCDate(Math.min(bought.getUTCDate(), last));
    if (last < bought.getUTCDate()) {
      const upper = new Date(result); upper.setUTCDate(upper.getUTCDate() + bought.getUTCDate() - last);
      if (sold >= result && sold <= upper && !conservative) throw Error('持股期限跨月末无对应日，股息税日期口径需核验');
      if (conservative) return upper;
    }
    return result;
  };
  // Acquisition day through the day BEFORE disposal is the holding interval.
  // Disposal on the corresponding date is exactly a natural month/year; the
  // lower tax bracket starts only on its following date.
  return sold > anniversary(12) ? 0 : sold > anniversary(1) ? 0.1 : 0.2;
}

function replayHoldings(state, symbol, throughDate) {
  const lots = [], disposals = [], timeline = [];
  for (const trade of state.trades.filter(item => item.symbol === symbol)) {
    const date = cnTime(trade.time).date;
    if (date <= throughDate) timeline.push({ type: 'trade', date, time: trade.time, item: trade });
  }
  for (const event of state.agency.corporateEvents.filter(item => item.symbol === symbol && !item.automatic && !item.confirmationOnly)) {
    if (event.effectiveDate <= throughDate && event.shareNumerator !== event.shareDenominator)
      timeline.push({ type: 'legacy', date: event.effectiveDate, time: `${event.effectiveDate}T00:00:00+08:00`, item: event });
  }
  for (const event of state.agency.corporateActions || []) {
    if (event.symbol === symbol && event.shareAppliedAt && event.terms.exDate <= throughDate && shares(event.terms) > 0)
      timeline.push({ type: 'shares', date: event.terms.exDate, time: `${event.terms.exDate}T00:00:00+08:00`, item: event });
  }
  timeline.sort((a, b) => a.date.localeCompare(b.date) || new Date(a.time) - new Date(b.time));
  for (const step of timeline) {
    const item = step.item;
    if (step.type === 'legacy') {
      for (const lot of lots.filter(lot => lot.strategyId === item.strategyId && (!item.cycleId || lot.cycleId === item.cycleId))) {
        lot.quantity = lot.quantity * item.shareNumerator / item.shareDenominator;
        if (!Number.isSafeInteger(lot.quantity)) throw Error('历史公司行为产生无法重放的零碎股份');
      }
    } else if (step.type === 'shares') {
      for (const entitlement of item.entitlements) {
        const quantity = entitlement.quantity * shares(item.terms);
        if (quantity) lots.push({ buyId: `${actionKey(item)}:${entitlement.buyId}`, strategyId: entitlement.strategyId,
          cycleId: entitlement.cycleId, purchaseDate: entitlement.purchaseDate, quantity, availableDate: item.terms.listingDate });
      }
    } else if (item.side === 'buy') {
      if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) throw Error('历史成交数量无效');
      lots.push({ buyId: item.id, strategyId: item.owner || 'manual', cycleId: item.cycleId || null,
        purchaseDate: step.date, quantity: item.quantity, availableDate: null });
    } else if (item.side === 'sell') {
      let remaining = item.quantity;
      for (const lot of lots) {
        if (!remaining || lot.strategyId !== (item.owner || 'manual') || !lot.quantity || lot.purchaseDate >= step.date
          || (lot.availableDate && lot.availableDate > step.date)) continue;
        const quantity = Math.min(remaining, lot.quantity); lot.quantity -= quantity; remaining -= quantity;
        disposals.push({ buyId: lot.buyId, strategyId: lot.strategyId, cycleId: lot.cycleId, purchaseDate: lot.purchaseDate,
          tradeId: item.id, date: step.date, quantity });
      }
      if (remaining) throw Error('历史成交不足以重建登记日权益，请核对导入持仓或遗漏记录');
    }
  }
  return { lots: lots.filter(lot => lot.quantity > 0), disposals };
}

function corporateFromDate(state, symbol, now = new Date()) {
  const dates = state.trades.filter(trade => trade.symbol === symbol && trade.owner && trade.owner !== 'manual').map(trade => cnTime(trade.time).date);
  for (const action of state.agency.corporateActions || []) if (action.symbol === symbol && action.terms?.recordDate) dates.push(action.terms.recordDate);
  return dates.length ? dates.sort()[0] : cnTime(new Date(new Date(now).getTime() - 14 * 86400000)).date;
}

function memberAffectsEquity(state, member) {
  if (!unresolved(member)) return false;
  if (state.lots.some(lot => lot.symbol === member.symbol && lot.owner !== 'manual')) return true;
  if (member.reconciliation?.affectsEquity === false || member.corporateVerification?.affectsEquity === false) return false;
  return state.trades.some(trade => trade.symbol === member.symbol && trade.owner && trade.owner !== 'manual')
    || (state.agency.corporateActions || []).some(action => action.symbol === member.symbol && action.entitlements?.length);
}

function groupHasUnresolvedCorporate(state, strategyId) {
  return Object.values(state.agency.corporateChecks || {}).some(check => check.status === 'blocked' && check.affectsEquity && check.strategyIds?.includes(strategyId))
    || (state.agency.corporateActions || []).some(action => action.status === 'exception' && action.affectsEquity !== false
    && (action.entitlements.some(e => e.strategyId === strategyId) || state.trades.some(trade => trade.symbol === action.symbol && trade.owner === strategyId)));
}

function assertCorporatePurchase(engine, symbol) {
  const today = cnTime(engine.clock()).date;
  const rights = (engine.s.agency.corporateActions || []).some(action => action.symbol === symbol && action.entitlements.some(e => e.grossCash > 0
    && (e.disposals.reduce((sum, d) => sum + d.quantity, 0) < e.quantity || e.disposals.some(d => d.date === today))));
  if (rights && engine.s.trades.some(trade => trade.symbol === symbol && trade.side === 'sell' && cnTime(trade.time).date === today))
    throw Error('该股票有股息税权益且今日已卖出，同日回买需按日终净额核税，暂不支持自动入账');
}

function assertTaxHistory(state, action, throughDate) {
  if (!action.entitlements.some(e => e.grossCash > 0)) return;
  if (action.entitlements.every(e => e.disposals.reduce((sum, d) => sum + d.quantity, 0) === e.quantity))
    throughDate = action.entitlements.flatMap(e => e.disposals.map(d => d.date)).sort().at(-1) || throughDate;
  const from = action.entitlements.map(e => e.purchaseDate).sort()[0], dates = new Map();
  for (const trade of state.trades.filter(trade => trade.symbol === action.symbol)) {
    const date = cnTime(trade.time).date;
    if (date < from || date > throughDate) continue;
    const sides = dates.get(date) || new Set(); sides.add(trade.side); dates.set(date, sides);
    if (sides.size > 1) throw Error('历史同日买卖涉及日终净额股息税，需逐笔核验');
  }
}

function taxForEntitlement(action, entitlement, today) {
  const disposals = entitlement.disposals || [], sold = disposals.reduce((sum, item) => sum + item.quantity, 0);
  const gross = entitlement.grossCash, perShare = gross / entitlement.quantity;
  // Round cumulative liability, then post only its delta. Repeated partial fills
  // therefore cannot create or destroy tax cents through per-fill rounding.
  const due = Math.round(disposals.reduce((sum, item) => sum + item.quantity * perShare * taxRate(entitlement.purchaseDate, item.date), 0));
  const prospective = Math.round((entitlement.quantity - sold) * perShare * taxRate(entitlement.purchaseDate, today, true));
  return { due, reserve: prospective + (action.paymentAppliedAt ? 0 : due) };
}

function corporateBalances(state, strategyId, now = new Date(), cycleId) {
  const today = cnTime(now).date;
  let receivable = 0, taxReserve = 0;
  for (const action of state.agency?.corporateActions || []) {
    if (!action.exAppliedAt) continue;
    for (const entitlement of action.entitlements || []) {
      if (strategyId && entitlement.strategyId !== strategyId) continue;
      if (cycleId && entitlement.cycleId !== cycleId) continue;
      if (!action.paymentAppliedAt) receivable += entitlement.grossCash;
      taxReserve += taxForEntitlement(action, entitlement, today).reserve;
    }
  }
  return { receivable, taxReserve };
}

function availableCorporateCash(state, strategyId, now = new Date()) {
  const cash = strategyId ? state.agency.groups.find(group => group.id === strategyId)?.cash || 0 : state.cash;
  return Math.max(0, cash - corporateBalances(state, strategyId, now).taxReserve);
}

function assertTerms(raw) {
  const terms = { recordDate: raw.recordDate, exDate: raw.exDate, payDate: raw.payDate || null, listingDate: raw.listingDate || null,
    cashPerShare: raw.cashPerShare, bonusPerShare: raw.bonusPerShare ?? 0, transferPerShare: raw.transferPerShare ?? 0,
    taxPolicy: raw.taxPolicy || null, transferTaxExempt: raw.transferTaxExempt === true };
  if (!validDate(terms.recordDate) || !validDate(terms.exDate) || terms.exDate <= terms.recordDate) throw Error('实施方案缺少有效登记日或除权除息日');
  if (![terms.cashPerShare, terms.bonusPerShare, terms.transferPerShare].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100)) throw Error('实施方案分配比例缺失或异常');
  if (!(terms.cashPerShare > 0 || shares(terms) > 0)) throw Error('实施方案没有可确认的现金或股份分配');
  if (terms.cashPerShare > 0 && (!validDate(terms.payDate) || terms.payDate < terms.exDate)) throw Error('现金红利到账日期未确认');
  if (terms.cashPerShare > 0 && terms.taxPolicy !== 'cn-individual-deferred-v1') throw Error('个人现金红利递延扣税依据尚未确认');
  if (terms.bonusPerShare > 0) throw Error('送股计税来源及权益处理需要进一步核验');
  if (terms.cashPerShare > 0 && shares(terms) > 0) throw Error('同批现金与转增的递延税权益分摊需要进一步核验');
  if (shares(terms) > 0 && (!terms.transferTaxExempt || !validDate(terms.listingDate) || terms.listingDate < terms.exDate)) throw Error('转增税源或新增股份上市日期未确认');
  return terms;
}

function updateRisk(engine, action) {
  const risk = engine.s.risks[action.symbol], factor = 1 + shares(action.terms), dividend = action.terms.cashPerShare;
  if (!risk) return;
  const keys = ['stop', 'target', 'entryPrice', 'initialStop', 'initialTarget', 'peak'];
  const adjusted = Object.fromEntries(keys.filter(key => Number.isFinite(risk[key])).map(key => [key, money((risk[key] - dividend) / factor) / 100]));
  if (Object.values(adjusted).some(value => value <= 0)) throw Error('除权除息后的计划价格无效，需要核验');
  const oldStop = risk.stop;
  risk.originalTerms ||= Object.fromEntries(['entryTradeId', 'entryDate', 'entryPrice', 'initialStop', 'initialTarget', 'initialPlannedLoss'].map(key => [key, risk[key]]));
  Object.assign(risk, adjusted);
  risk.currentPriceBasis = { type: 'company-action-adjusted', eventId: action.eventId, effectiveDate: action.terms.exDate,
    note: '按实施方案逐项扣除每股现金并除以送转后比例；原始计划保存在 originalTerms' };
  risk.history ||= []; risk.history.push({ time: engine.clock().toISOString(), reason: '自动依据权益分派实施方案校正计划价格', eventId: action.eventId, oldStop, stop: risk.stop });
}

function updateDisposals(state, action, today) {
  const replay = replayHoldings(state, action.symbol, today);
  for (const entitlement of action.entitlements) {
    entitlement.disposals = replay.disposals.filter(item => item.buyId === entitlement.buyId && item.date > action.terms.recordDate)
      .map(item => ({ tradeId: item.tradeId, date: item.date, quantity: item.quantity }));
    if (entitlement.disposals.reduce((sum, item) => sum + item.quantity, 0) > entitlement.quantity) throw Error('登记权益与后续卖出数量无法对应');
    for (const disposal of entitlement.disposals) if (entitlement.grossCash > 0) taxRate(entitlement.purchaseDate, disposal.date);
  }
  assertTaxHistory(state, action, today);
}

function postCash(engine, action, entitlement, today) {
  const group = engine.s.agency.groups.find(item => item.id === entitlement.strategyId);
  const cycle = group?.cycles.find(item => item.id === entitlement.cycleId);
  if (!group || !cycle) throw Error('历史权益所属策略或交易周期缺失');
  const taxPaid = entitlement.computedDue ?? taxForEntitlement(action, entitlement, today).due;
  const eventId = `${action.eventId}:auto:${entitlement.cycleId}`;
  let event = engine.s.agency.corporateEvents.find(item => item.symbol === action.symbol && item.eventId === eventId);
  const cash = entitlement.grossCash - taxPaid;
  const delta = cash - (event?.cash || 0);
  if (group.cash + delta < 0 || engine.s.cash + delta < 0) throw Error('递延股息税资金不足，需要核对账户');
  if (!event) {
    event = { id: id(), symbol: action.symbol, strategyId: entitlement.strategyId, cycleId: entitlement.cycleId,
      eventId, automatic: true, actionId: action.eventId, evidence: action.sourceUrl, noticeIds: action.noticeIds,
      recordDate: action.terms.recordDate, effectiveDate: action.terms.payDate, shareNumerator: 1, shareDenominator: 1,
      riskPriceFactor: 1, confirmationOnly: false, time: engine.clock().toISOString(), cash: 0 };
    engine.s.agency.corporateEvents.push(event);
  }
  event.quantity = entitlement.quantity; event.grossCash = entitlement.grossCash; event.taxPaid = taxPaid; event.cash = cash;
  group.cash += delta; engine.s.cash += delta; cycle.pnl += delta; cycle.dividends = (cycle.dividends || 0) + delta;
  entitlement.taxPaid = taxPaid;
  return delta !== 0;
}

function postActionCash(engine, action, today) {
  const groups = new Map();
  for (const entitlement of action.entitlements) {
    const key = `${entitlement.strategyId}:${entitlement.cycleId}`;
    const aggregated = groups.get(key) || { ...entitlement, quantity: 0, grossCash: 0, due: 0, items: [] };
    aggregated.quantity += entitlement.quantity; aggregated.grossCash += entitlement.grossCash;
    aggregated.due += taxForEntitlement(action, entitlement, today).due; aggregated.items.push(entitlement); groups.set(key, aggregated);
  }
  for (const aggregate of groups.values()) {
    const due = aggregate.due;
    // The journal is per original strategy cycle; its taxable lots retain their
    // individual purchase dates in the entitlement ledger.
    postCash(engine, action, { ...aggregate, computedDue: due }, today);
    for (const item of aggregate.items) item.taxPaid = taxForEntitlement(action, item, today).due;
  }
}

function applyAction(engine, action, quote, snapshot) {
  const state = engine.s, today = cnTime(engine.clock()).date, time = engine.clock().toISOString();
  const t = action.terms;
  if (!action.registeredAt) {
    if (today < t.recordDate || (today === t.recordDate && cnTime(engine.clock()).minutes < 900)) { action.status = 'scheduled'; return; }
    const replay = replayHoldings(state, action.symbol, t.recordDate);
    const current = replayHoldings(state, action.symbol, today).lots;
    const actual = state.lots.filter(lot => lot.symbol === action.symbol);
    const holdingsByOwner = items => {
      const totals = new Map();
      for (const item of items) { const key = `${item.strategyId || item.owner || 'manual'}:${item.cycleId || ''}`; totals.set(key, (totals.get(key) || 0) + item.quantity); }
      return [...totals].sort((a, b) => a[0].localeCompare(b[0]));
    };
    if (JSON.stringify(holdingsByOwner(current)) !== JSON.stringify(holdingsByOwner(actual))) throw Error('成交及公司行为历史与当前持仓不一致，无法自动确认权益');
    action.entitlements = replay.lots.filter(lot => lot.strategyId !== 'manual').map(lot => ({ ...lot,
      grossCash: money(lot.quantity * t.cashPerShare), disposals: [], taxPaid: 0 }));
    if (action.entitlements.some(item => !item.cycleId)) throw Error('登记日权益缺少所属交易周期');
    if (t.cashPerShare > 0 && action.entitlements.some(entitlement => !state.trades.some(trade => trade.id === entitlement.buyId)
      || state.agency.corporateEvents.some(event => event.symbol === action.symbol && !event.automatic && !event.confirmationOnly
        && event.shareNumerator !== event.shareDenominator && event.cycleId === entitlement.cycleId && event.effectiveDate <= t.recordDate)))
      throw Error('登记权益包含送转来源股份，其股息税取得日期需进一步核验');
    action.registeredAt = time;
    action.status = action.entitlements.length ? 'registered' : 'no-entitlement';
  }
  if (!action.entitlements.length) return;
  updateDisposals(state, action, today);
  if (!action.exAppliedAt && today >= t.exDate) {
    if (shares(t) > 0) {
      if (action.entitlements.some(item => item.disposals.length)) throw Error('登记后已有卖出，转增权益与原始股份需逐笔核验');
      if ((state.agency.corporateActions || []).some(other => other !== action && other.symbol === action.symbol && other.exAppliedAt
        && other.entitlements.some(item => item.grossCash > 0 && item.disposals.reduce((sum, d) => sum + d.quantity, 0) < item.quantity))) throw Error('转增涉及尚未结清的其他股息税权益，需逐笔核验');
      for (const entitlement of action.entitlements) if (!Number.isSafeInteger(entitlement.quantity * shares(t))) throw Error('转增产生零碎股份，需要登记结果核验');
      const intent = state.agency.executionIntents.find(item => item.symbol === action.symbol && item.status === 'pending');
      if (intent && !Number.isSafeInteger(intent.targetQuantity * (1 + shares(t)))) throw Error('转增后的退出目标存在零碎股份');
      for (const entitlement of action.entitlements) {
        const matching = state.lots.filter(item => item.symbol === action.symbol && item.owner === entitlement.strategyId && item.cycleId === entitlement.cycleId
          && (item.originId === entitlement.buyId || !item.originId && !item.corporateActionId));
        const lot = matching.length === 1 ? matching[0] : null;
        if (!lot || lot.quantity !== entitlement.quantity) throw Error('转增持仓批次无法唯一匹配');
        const quantity = entitlement.quantity * shares(t), cost = Math.round(lot.cost * quantity / (lot.quantity + quantity));
        lot.cost -= cost;
        state.lots.push({ id: id(), originId: `${actionKey(action)}:${entitlement.buyId}`, symbol: action.symbol, name: lot.name, quantity, cost, date: t.exDate,
          availableDate: t.listingDate, owner: lot.owner, cycleId: lot.cycleId, corporateActionId: action.eventId, purchaseDate: entitlement.purchaseDate });
      }
      if (intent) intent.targetQuantity *= 1 + shares(t);
      action.shareAppliedAt = time;
    }
    // If the original cycle is closed, a later/new holding must not inherit its
    // historical distribution's price adjustment.
    if (state.lots.some(lot => lot.symbol === action.symbol && action.entitlements.some(item => item.cycleId === lot.cycleId))) updateRisk(engine, action);
    const mark = state.marks[action.symbol];
    if (mark && mark.date < t.exDate) state.marks[action.symbol] = { ...mark, price: money((mark.price - t.cashPerShare) / (1 + shares(t))) / 100, companyActionAdjusted: action.eventId };
    action.exAppliedAt = time; action.status = 'ex-applied';
  }
  if (action.exAppliedAt && (!t.cashPerShare || today >= t.payDate)) {
    if (t.cashPerShare) postActionCash(engine, action, today);
    action.paymentAppliedAt ||= time;
    action.status = 'completed';
  }
}

function settleDividendTaxes(engine) {
  const today = cnTime(engine.clock()).date;
  for (const action of engine.s.agency.corporateActions || []) {
    if (!action.exAppliedAt || !action.entitlements?.length) continue;
    updateDisposals(engine.s, action, today);
    if (action.paymentAppliedAt && action.terms.cashPerShare) postActionCash(engine, action, today);
  }
}

// Only these ledger fields can change while applying a corporate event. Audit
// decisions and candidate-pool evidence are unrelated and can be much larger.
function corporateMutableState(state) {
  const agency = state.agency;
  return { cash: state.cash, lots: state.lots, risks: state.risks, marks: state.marks,
    agency: { corporateActions: agency.corporateActions, corporateEvents: agency.corporateEvents,
      executionIntents: agency.executionIntents, groups: agency.groups.map(group => ({ id: group.id, cash: group.cash, cycles: group.cycles })) } };
}

function processCorporateActions(engine, symbol, quote, snapshot) {
  symbol = symbolOf(symbol);
  const source = snapshot?.corporateActions || (snapshot?.section === 'corporateActions' ? snapshot : null);
  if (!source) return { status: 'unavailable', reason: '公司行为实施资料尚未获取', changed: false, coveredNoticeIds: [], affectsEquity: true };
  const state = engine.s, today = cnTime(engine.clock()).date;
  const symbolTrades = state.trades.filter(trade => trade.symbol === symbol && trade.owner && trade.owner !== 'manual');
  const history = symbolTrades.length > 0;
  const holding = state.lots.some(lot => lot.symbol === symbol && lot.owner !== 'manual');
  const priorCheck = state.agency.corporateChecks?.[symbol];
  const fullyChecked = priorCheck?.verifiedTradeId === symbolTrades.at(-1)?.id && priorCheck?.verifiedNoHoldings === true;
  const pendingRights = state.agency.corporateActions.some(action => action.symbol === symbol && action.entitlements.length
    && (!action.paymentAppliedAt || action.entitlements.some(e => e.disposals.reduce((sum, d) => sum + d.quantity, 0) < e.quantity)));
  const result = { status: 'clear', reason: '', changed: false, coveredNoticeIds: [], affectsEquity: holding || pendingRights || history && !fullyChecked, events: [],
    evidence: Array.isArray(source.notices) ? source.notices.filter(notice => notice.corporateStage).map(notice => ({ id: notice.id, title: notice.title, date: notice.date, url: notice.url,
      ...(typeof notice.source === 'string' ? { source: notice.source } : {}) })) : [] };
  if (source.symbol !== symbol || !['ready', 'empty'].includes(source.status) || source.coverageComplete !== true
    || !validDate(source.coverageStart) || source.coverageStart > corporateFromDate(state, symbol, engine.clock()) || source.coverageEnd !== today || !Array.isArray(source.events)
    || !Number.isFinite(source.fetchedAt) || engine.clock().getTime() - source.fetchedAt > 300000 || source.fetchedAt > engine.clock().getTime() + 15000) {
    return { ...result, status: 'blocked', reason: `公司行为实施资料不新鲜或未覆盖持仓期间${typeof source.error === 'string' && source.error ? `：${source.error}` : ''}` };
  }
  const before = source.events.length || !state.agency.corporateActions ? JSON.stringify(corporateMutableState(state)) : null;
  state.agency.corporateActions ||= [];
  for (const raw of [...source.events].sort((a, b) => String(a.recordDate || '').localeCompare(String(b.recordDate || '')))) {
    if (!raw || typeof raw.eventId !== 'string' || !raw.eventId || !Array.isArray(raw.noticeIds) || typeof raw.sourceUrl !== 'string') {
      result.status = 'blocked'; result.reason = '公司行为事件缺少可追溯编号或来源'; continue;
    }
    let action = state.agency.corporateActions.find(item => item.symbol === symbol && item.eventId === raw.eventId);
    if (['planned', 'cancelled'].includes(raw.status) && !action?.registeredAt) { result.coveredNoticeIds.push(...raw.noticeIds); continue; }
    const checkpoint = structuredClone(state);
    try {
      const manual = state.agency.corporateEvents.find(item => item.symbol === symbol && !item.automatic && !item.confirmationOnly
        && (validDate(raw.recordDate) && item.recordDate === raw.recordDate || item.noticeIds.some(notice => raw.noticeIds.includes(notice))));
      if (manual) {
        if (action && !action.exAppliedAt) { action.status = 'completed'; action.manualEventId = manual.eventId; action.affectsEquity = false; action.entitlements = []; delete action.blockedReason; }
        result.coveredNoticeIds.push(...raw.noticeIds); continue;
      }
      if (raw.status !== 'implemented') throw Error(raw.reason || '公司行为类型或实施状态尚未确认');
      const terms = assertTerms(raw);
      if (action && JSON.stringify(action.terms) !== JSON.stringify(terms)) {
        if (action.registeredAt || action.exAppliedAt) throw Error('已登记的实施方案发生更正，需要复核已有权益');
        action.terms = terms;
      }
      const duplicate = state.agency.corporateActions.find(item => item.symbol === symbol && item.eventId !== raw.eventId
        && (item.terms?.recordDate === terms.recordDate || item.noticeIds.some(notice => raw.noticeIds.includes(notice))));
      if (duplicate) throw Error('相同登记日或公告批次存在不同事件，暂停重复入账');
      if (!action) {
        action = { symbol, eventId: raw.eventId, sourceUrl: raw.sourceUrl, noticeIds: [...new Set(raw.noticeIds)], terms,
          status: 'scheduled', entitlements: [], createdAt: engine.clock().toISOString() };
        state.agency.corporateActions.push(action);
      }
      delete action.blockedReason;
      applyAction(engine, action, quote, snapshot);
      result.coveredNoticeIds.push(...raw.noticeIds); result.events.push(action.eventId);
    } catch (error) {
      // Every event is atomic: retain prior successful events, never half an
      // entitlement, a price adjustment, or a cash posting from this event.
      for (const key of Object.keys(state)) delete state[key]; Object.assign(state, checkpoint);
      action = state.agency.corporateActions.find(item => item.symbol === symbol && item.eventId === raw.eventId);
      if (!action) {
        action = { symbol, eventId: raw.eventId, sourceUrl: raw.sourceUrl, noticeIds: [...new Set(raw.noticeIds)],
          terms: { recordDate: raw.recordDate || null, exDate: raw.exDate || null, cashPerShare: raw.cashPerShare ?? null }, entitlements: [], createdAt: engine.clock().toISOString() };
        state.agency.corporateActions.push(action);
      }
      action.status = 'exception'; action.blockedReason = error.message;
      if (!holding && validDate(raw.recordDate)) {
        try { action.affectsEquity = replayHoldings(state, symbol, raw.recordDate).lots.some(lot => lot.strategyId !== 'manual'); } catch { action.affectsEquity = true; }
      } else action.affectsEquity = holding || history;
      result.status = 'blocked'; result.reason = error.message;
    }
  }
  const omitted = state.agency.corporateActions.find(action => action.symbol === symbol && action.status !== 'no-entitlement'
    && !source.events.some(event => event.eventId === action.eventId));
  if (omitted) { result.status = 'blocked'; result.reason ||= '已跟踪的实施事件缺少本次来源确认'; }
  const unmatched = (source.notices || []).filter(notice => notice.corporateStage && notice.corporateStage !== 'planned' && !result.coveredNoticeIds.includes(notice.id));
  if (unmatched.length) { result.status = 'blocked'; result.reason ||= '历史公司行为公告尚未与已核验实施方案匹配'; }
  const reverted = (source.notices || []).find(notice => ['planned', 'cancelled', 'unsupported'].includes(notice.corporateStage) && !notice.resolvedByEventId
    && state.agency.corporateActions.some(action => action.symbol === symbol && action.registeredAt && action.noticeIds.includes(notice.id)));
  if (reverted) { result.status = 'blocked'; result.reason ||= '已登记实施公告出现状态退回、更正或撤销，需要复核'; }
  if (!holding && result.status === 'clear') {
    result.affectsEquity = state.agency.corporateActions.some(action => action.symbol === symbol && action.entitlements.length && !action.paymentAppliedAt);
  }
  if (!holding && result.status === 'blocked' && state.agency.corporateActions.filter(action => action.symbol === symbol && action.status === 'exception').length) {
    result.affectsEquity = state.agency.corporateActions.some(action => action.symbol === symbol
      && (action.status === 'exception' ? action.affectsEquity !== false : action.entitlements.length > 0 && !action.paymentAppliedAt));
  }
  result.changed = before !== null && before !== JSON.stringify(corporateMutableState(state));
  if (result.changed) state.agency.revision++;
  return result;
}

function validCorporateLedger(state) {
  const actions = state.agency?.corporateActions;
  if (actions === undefined) return !state.agency.corporateEvents.some(event => event.automatic);
  if (!Array.isArray(actions)) return false;
  const keys = new Set();
  if (state.agency.corporateChecks !== undefined && (!state.agency.corporateChecks || typeof state.agency.corporateChecks !== 'object' || Array.isArray(state.agency.corporateChecks))) return false;
  for (const action of actions) {
    if (!action || typeof action.eventId !== 'string' || !action.eventId || symbolOf(action.symbol) !== action.symbol || keys.has(actionKey(action))
      || !Array.isArray(action.noticeIds) || !Array.isArray(action.entitlements) || !action.terms
      || !['scheduled', 'registered', 'ex-applied', 'completed', 'exception', 'no-entitlement'].includes(action.status)) return false;
    keys.add(actionKey(action));
    const timestamps = ['registeredAt', 'exAppliedAt', 'paymentAppliedAt', 'shareAppliedAt'];
    if (timestamps.some(key => action[key] !== undefined && (typeof action[key] !== 'string' || !Number.isFinite(Date.parse(action[key]))))) return false;
    if (action.registeredAt && !action.manualEventId) {
      try { assertTerms(action.terms); } catch { return false; }
      if (cnTime(action.registeredAt).date < action.terms.recordDate) return false;
    }
    if (!action.manualEventId && (action.status === 'completed' && (!action.exAppliedAt || !action.paymentAppliedAt || !action.entitlements.length)
      || action.status === 'no-entitlement' && (!action.registeredAt || action.entitlements.length || action.exAppliedAt)
      || action.status === 'registered' && (!action.registeredAt || action.exAppliedAt || !action.entitlements.length)
      || action.status === 'scheduled' && action.registeredAt)) return false;
    if (action.exAppliedAt && (!action.entitlements.length || cnTime(action.exAppliedAt).date < action.terms.exDate)) return false;
    if (action.paymentAppliedAt && action.terms.cashPerShare > 0 && cnTime(action.paymentAppliedAt).date < action.terms.payDate) return false;
    if (action.shareAppliedAt && (!action.exAppliedAt || !(shares(action.terms) > 0))) return false;
    const entitlementIds = new Set();
    for (const e of action.entitlements) {
      if (!amount(e.quantity) || e.quantity === 0 || !amount(e.grossCash) || !amount(e.taxPaid) || !e.buyId || entitlementIds.has(e.buyId)
        || !validDate(e.purchaseDate) || !Array.isArray(e.disposals) || !state.agency.groups.some(group => group.id === e.strategyId && group.cycles.some(cycle => cycle.id === e.cycleId))) return false;
      entitlementIds.add(e.buyId);
      if (e.grossCash !== money(e.quantity * action.terms.cashPerShare) || e.disposals.some(d => !amount(d.quantity) || !d.quantity || !validDate(d.date)
        || d.date <= action.terms.recordDate || !state.trades.some(t => t.id === d.tradeId && t.side === 'sell' && t.symbol === action.symbol))
        || new Set(e.disposals.map(d => d.tradeId)).size !== e.disposals.length || e.disposals.reduce((sum, d) => sum + d.quantity, 0) > e.quantity) return false;
      if (action.paymentAppliedAt ? e.taxPaid !== taxForEntitlement(action, e, action.terms.payDate || action.terms.exDate).due : e.taxPaid !== 0) return false;
    }
    if (action.exAppliedAt && (!action.registeredAt || !validDate(action.terms.exDate))) return false;
    if (action.paymentAppliedAt && !action.exAppliedAt) return false;
    if (action.paymentAppliedAt && action.terms.cashPerShare > 0) {
      for (const cycleId of new Set(action.entitlements.map(e => e.cycleId))) {
        const entries = action.entitlements.filter(e => e.cycleId === cycleId);
        const event = state.agency.corporateEvents.find(event => event.automatic && event.symbol === action.symbol && event.actionId === action.eventId && event.cycleId === cycleId);
        if (!event || event.grossCash !== entries.reduce((sum, e) => sum + e.grossCash, 0)
          || event.taxPaid !== entries.reduce((sum, e) => sum + e.taxPaid, 0) || event.cash !== event.grossCash - event.taxPaid
          || event.quantity !== entries.reduce((sum, e) => sum + e.quantity, 0) || event.strategyId !== entries[0].strategyId) return false;
      }
    }
  }
  for (const event of state.agency.corporateEvents.filter(event => event.automatic)) {
    const action = actions.find(action => action.symbol === event.symbol && action.eventId === event.actionId);
    if (!action?.paymentAppliedAt || !action.entitlements.some(e => e.cycleId === event.cycleId && e.strategyId === event.strategyId)
      || event.eventId !== `${action.eventId}:auto:${event.cycleId}` || !amount(event.grossCash) || !amount(event.taxPaid)) return false;
  }
  return true;
}

module.exports = { replayHoldings, corporateFromDate, memberAffectsEquity, affectsEquity: memberAffectsEquity, corporateBalances,
  availableCorporateCash, processCorporateActions, settleDividendTaxes, validCorporateLedger, taxRate, groupHasUnresolvedCorporate, assertCorporatePurchase };
