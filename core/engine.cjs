const { money, yuan, id, cnTime, session, symbolOf, numberIn } = require('./common.cjs');
const { fees } = require('./fees.cjs');
const { strategyDefaults, configureStrategy, evaluateEntry, updateDynamicRisk, strategyProfile } = require('./strategy.cjs');
const { migrateAgency, validAgency, installAgency } = require('./agency-ledger.cjs');
const { memberAffectsEquity, corporateBalances, availableCorporateCash, groupHasUnresolvedCorporate } = require('./corporate-ledger.cjs');
const { validCapitalFlows, capitalPerformance, MAX_ADDITION_CENTS, MAX_CUMULATIVE_CENTS, identifier } = require('./capital-flows.cjs');
const { holdingValuation } = require('./holding-valuation.cjs');
const { maxOrderQuantity } = require('./order-quantity.cjs');
const { validClientRequests } = require('./account-operations.cjs');
const defaults = { commission: 0.00025, minCommission: 5, stampTax: 0.0005, transferFee: 0.00001, slippageTicks: 1, maxPosition: 0.3, refreshSeconds: 10 };
function initialState(capital = 1000000) {
  const cents = money(numberIn(capital, 10000, 100000000, '初始资金'));
  return { version: 1, initialCash: cents, cash: cents, settings: { ...defaults }, strategySettings: { ...strategyDefaults }, planSelections: {}, watchlist: ['sh600519', 'sz000001', 'sz300750', 'sh600036', 'sz002594', 'sh601318'], lots: [], risks: {}, orders: [], trades: [], equity: [{ time: Date.now(), value: cents }], marks: {}, consumed: {}, createdAt: new Date().toISOString() };
}
function validState(s) {
  if (!([1, 2].includes(s?.version) && Number.isSafeInteger(s.cash) && s.cash >= 0 && Number.isSafeInteger(s.initialCash) && s.initialCash > 0 && ['lots', 'orders', 'trades', 'equity', 'watchlist'].every(k => Array.isArray(s[k])) && s.settings && s.risks && s.marks && s.consumed)) return false;
  if (!validCapitalFlows(s)) return false;
  if (!validClientRequests(s)) return false;
  if (s.agency !== undefined && !validAgency(s)) return false;
  if (s.planSelections === undefined) return true;
  if (!s.planSelections || typeof s.planSelections !== 'object' || Array.isArray(s.planSelections)) return false;
  try { return Object.entries(s.planSelections).every(([symbol, strategyId]) => symbolOf(symbol) === symbol && strategyProfile(strategyId).id === strategyId); } catch { return false; }
}
class Engine {
  constructor(state = initialState(), clock = () => new Date()) {
    if (!validState(state)) throw Error('账户数据格式不正确');
    const selections = state.planSelections ?? {};
    if (typeof selections !== 'object' || Array.isArray(selections)) throw Error('账户买卖计划选择格式不正确');
    for (const [symbol, strategyId] of Object.entries(selections)) { if (symbolOf(symbol) !== symbol) throw Error('账户买卖计划股票代码无效'); strategyProfile(strategyId); }
    this.s = state; this.s.planSelections = { ...selections };
    this.s.strategySettings = configureStrategy({ ...strategyDefaults, ...state.strategySettings }); this.clock = clock;
    migrateAgency(this.s, this.clock());
  }
  selectedStrategy(symbol) {
    symbol = symbolOf(symbol);
    const risk = this.s.risks[symbol];
    return strategyProfile(risk?.strategy ? risk.strategyId || 'swing' : this.s.planSelections[symbol] || 'swing').id;
  }
  selectStrategy(symbol, strategyId) {
    symbol = symbolOf(symbol); const profile = strategyProfile(strategyId), existing = this.s.risks[symbol];
    if (existing?.strategy && profile.id !== this.selectedStrategy(symbol)) throw Error('已有策略持仓，平仓前保留建仓策略；不能切换买卖计划');
    this.s.planSelections[symbol] = profile.id;
    return profile.id;
  }
  positions(quotes = {}) {
    const grouped = {};
    for (const l of this.s.lots) {
      const p = grouped[l.symbol] ||= { symbol: l.symbol, name: l.name, quantity: 0, available: 0, cost: 0 };
      p.quantity += l.quantity; p.cost += l.cost;
      const today = cnTime(this.clock()).date;
      if (l.availableDate ? l.availableDate <= today : l.date < today) p.available += l.quantity;
    }
    return Object.values(grouped).map(p => {
      const q = quotes[p.symbol] || this.s.marks[p.symbol], price = q?.price || yuan(p.cost / p.quantity), value = money(price) * p.quantity;
      return { ...p, average: yuan(p.cost / p.quantity), price, value, pnl: value - p.cost, pnlPct: (value - p.cost) / p.cost, quoteTime: q?.timestamp, risk: this.s.risks[p.symbol] || null };
    });
  }
  stats(quotes = {}) {
    const { receivable, taxReserve } = corporateBalances(this.s, undefined, this.clock());
    const positions = this.positions(quotes), marketValue = positions.reduce((s, p) => s + p.value, 0), equity = this.s.cash + marketValue + receivable - taxReserve;
    const sells = this.s.trades.filter(t => t.side === 'sell'), wins = sells.filter(t => t.pnl > 0), losses = sells.filter(t => t.pnl < 0);
    const gain = wins.reduce((s, t) => s + t.pnl, 0), loss = -losses.reduce((s, t) => s + t.pnl, 0);
    const performance = capitalPerformance(this.s.initialCash, this.s.equity, this.s.capitalFlows, equity);
    const comparable = !this.s.agency?.groups.some(g => g.members.some(m => memberAffectsEquity(this.s, m)) || groupHasUnresolvedCorporate(this.s, g.id));
    return { equity, cash: this.s.cash, availableCash: availableCorporateCash(this.s, undefined, this.clock()), receivable, taxReserve, manualCash: this.s.agency?.manualCash ?? this.s.cash, marketValue,
      pnl: performance.pnl, netContributions: performance.netContributions, cumulativeCapital: performance.cumulativeCapital,
      comparable, returnPct: comparable ? performance.returnPct : null, timeWeightedReturnPct: comparable ? performance.returnPct : null,
      realized: sells.reduce((s, t) => s + t.pnl, 0) + (this.s.agency?.corporateEvents || []).reduce((total, event) => total + event.cash, 0), unrealized: positions.reduce((s, p) => s + p.pnl, 0),
      fees: this.s.trades.reduce((s, t) => s + t.fees.total, 0), sells: sells.length, wins: wins.length, losses: losses.length, breakeven: sells.length - wins.length - losses.length,
      winRate: sells.length ? wins.length / sells.length : null, profitFactor: loss ? gain / loss : null, drawdown: comparable ? performance.drawdown : null, positions };
  }
  addCapital(input, quotes = {}) {
    const numeric = Number(input?.amount), requestId = input?.requestId;
    if (!identifier(requestId)) throw Error('追加本金必须提供 1 至 128 字符的唯一请求编号');
    if (!['number', 'string'].includes(typeof input?.amount) || !Number.isFinite(numeric) || numeric <= 0
      || numeric > MAX_ADDITION_CENTS / 100 || Math.abs(numeric * 100 - money(numeric)) > 0.00001)
      throw Error('追加本金须为 0.01 至 100,000,000 元，最多两位小数');
    const amount = money(numeric);
    if (amount <= 0) throw Error('追加本金至少为 0.01 元');
    if (!validState(this.s)) throw Error('账户账本无效，不能追加本金');
    const existing = this.s.capitalFlows?.find(flow => flow.requestId === requestId);
    if (existing) {
      if (existing.amount !== amount) throw Error('同一追加本金请求编号不能使用不同金额');
      return structuredClone(existing);
    }
    const now = this.clock();
    if (this.s.capitalFlows?.length && Date.parse(this.s.capitalFlows.at(-1).time) > now.getTime()) throw Error('系统时间早于上次追加本金记录');
    if (this.s.agency.groups.some(group => group.members.some(member => memberAffectsEquity(this.s, member))
      || groupHasUnresolvedCorporate(this.s, group.id)))
      throw Error('账户有待对账或待核验股票，先恢复有效净值后再追加本金');
    const valuation = holdingValuation(this.s.lots, quotes, this.s.marks, now, '追加本金');
    const auditQuotes = Object.values(valuation).map(quote => ({ symbol: quote.symbol, price: quote.price, timestamp: quote.timestamp, date: quote.date }));
    const before = this.stats(valuation);
    if (!before.comparable || !Number.isSafeInteger(before.equity) || before.equity <= 0) throw Error('账户净值未能可靠确认，不能追加本金');
    if (before.cumulativeCapital + amount > MAX_CUMULATIVE_CENTS) throw Error('累计投入不能超过 1,000,000,000 元');
    const flow = { id: id(), requestId, amount, time: now.toISOString(), equityBefore: before.equity,
      equityAfter: before.equity + amount, valuation: auditQuotes };
    const next = { ...this.s, version: 2, cash: this.s.cash + amount, capitalFlows: [...(this.s.capitalFlows || []), flow],
      marks: { ...this.s.marks, ...valuation },
      equity: [...this.s.equity, { time: now.getTime(), value: flow.equityAfter, netContributions: before.netContributions + amount }],
      agency: { ...this.s.agency, manualCash: this.s.agency.manualCash + amount, revision: this.s.agency.revision + 1 } };
    if (!validState(next)) throw Error('追加本金后的账本校验失败，未修改账户');
    // No state is changed until every valuation and ledger check succeeds.
    Object.assign(this.s, next);
    return structuredClone(flow);
  }
  fresh(q) {
    const now = this.clock(), t = cnTime(now);
    if (!session(now).open) throw Error(`${session(now).label}。仅在 09:30–11:30、13:00–14:57 连续竞价时段撮合`);
    if (!q || !Number.isFinite(q.price) || q.price <= 0 || !Number.isFinite(q.timestamp)) throw Error('没有有效报价');
    if (q.canTrade === false) throw Error(q.tradeBlockedReason || '当前行情仅供展示，暂停模拟成交');
    const age = now.getTime() - q.timestamp;
    if (q.date !== t.date || age > 90000 || age < -15000) throw Error('报价过期或市场休市，暂停撮合；需要当日 90 秒内报价');
    if (!(q.volume > 0) || !(q.open > 0)) throw Error('停牌或无成交行情，暂停撮合');
    if (!Number.isFinite(q.limitUp) || !Number.isFinite(q.limitDown) || !(q.limitUp > q.limitDown) || !(q.limitDown > 0)) throw Error('缺少涨跌停信息；首版暂停无价格限制证券的撮合');
  }
  validateQuantity(symbol, quantity, side, limitOrder = false) {
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1000000) throw Error('数量须为 1 至 1,000,000 的整数');
    if (quantity > maxOrderQuantity(symbol, limitOrder)) throw Error(`科创板${limitOrder ? '限价' : '市价'}单次申报最多 ${maxOrderQuantity(symbol, limitOrder).toLocaleString('en-US')} 股`);
    const star = symbol.startsWith('sh688'), p = this.positions().find(p => p.symbol === symbol);
    if (side === 'sell' && p && quantity === p.available) return;
    if (star ? quantity < 200 : quantity % 100 !== 0) throw Error(star ? '科创板单次申报至少 200 股；不足 200 股的可卖余额须一次卖出' : '买卖数量须为 100 股的整数倍；零股可卖余额须一次卖出');
  }
  liquidity(q, side) {
    const key = `${q.symbol}:${side}`, used = this.s.consumed[key];
    const size = side === 'buy' ? q.askSize : q.bidSize;
    if (!Number.isFinite(size) || size < 0 || (used && q.timestamp < used.timestamp)) return 0;
    return Math.max(0, size - (used?.timestamp === q.timestamp ? used.quantity : 0));
  }
  execute(input, q, quotes = {}, reason = '手动模拟交易') {
    const symbol = symbolOf(input.symbol), side = input.side;
    if (!['buy', 'sell'].includes(side)) throw Error('买卖方向无效');
    if (q?.symbol !== symbol) throw Error('行情代码不匹配');
    this.fresh(q);
    const limit = input.limit == null ? null : numberIn(input.limit, 0.01, 100000, '限价');
    if (limit !== null && Math.abs(limit * 100 - Math.round(limit * 100)) > 0.0001) throw Error('限价最多保留两位小数');
    const quantity = Number(input.quantity); this.validateQuantity(symbol, quantity, side, limit !== null);
    const book = side === 'buy' ? q.ask : q.bid;
    if (!(book > 0) || this.liquidity(q, side) < quantity) throw Error('对手一档可见数量不足；本工具不模拟排队，可减少数量或等待新报价');
    const priceCents = money(book) + (side === 'buy' ? 1 : -1) * this.s.settings.slippageTicks;
    if (priceCents > money(q.limitUp) || priceCents < money(q.limitDown)) throw Error('加入滑点后的价格超出涨跌停范围，等待可成交报价');
    const price = yuan(priceCents);
    if (limit !== null && (side === 'buy' ? price > limit : price < limit)) throw Error('含滑点价格尚未满足限价');
    const gross = priceCents * quantity, f = fees(gross, side, this.s.settings), now = this.clock(), date = cnTime(now).date;
    const trade = { id: id(), symbol, name: q.name, side, quantity, price, gross, fees: f, pnl: null, time: now.toISOString(), quoteTime: q.timestamp, quoteSource: q.source || '来源未标注', reason };
    if (side === 'buy') {
      if (this.s.risks[symbol]?.strategy) throw Error('该股票已有策略持仓，平仓前不能加仓，以保留原交易风控边界');
      if (gross + f.total > availableCorporateCash(this.s, undefined, this.clock())) throw Error('模拟可用资金不足（含股息税预留）');
      const valuation = holdingValuation(this.s.lots, { ...quotes, [symbol]: q }, this.s.marks, now, '计算买入仓位');
      const stat = this.stats(valuation), existing = stat.positions.find(p => p.symbol === symbol)?.value || 0;
      if (existing + gross > stat.equity * this.s.settings.maxPosition) throw Error(`超过单股仓位上限 ${(this.s.settings.maxPosition * 100).toFixed(0)}%，请调整数量或风控设置`);
      this.s.cash -= gross + f.total;
      this.s.lots.push({ id: id(), originId: trade.id, symbol, name: q.name, quantity, cost: gross + f.total, date });
    } else {
      const p = this.positions().find(p => p.symbol === symbol);
      if (!p || quantity > p.available) throw Error(`T+1 可卖数量不足，当前可卖 ${p?.available || 0} 股`);
      if (this.s.risks[symbol]?.strategy) trade.riskSnapshot = structuredClone(this.s.risks[symbol]);
      let remain = quantity, cost = 0;
      for (const lot of this.s.lots) {
        if (lot.symbol !== symbol || (lot.availableDate ? lot.availableDate > date : lot.date >= date) || !remain) continue;
        const take = Math.min(remain, lot.quantity), usedCost = take === lot.quantity ? lot.cost : Math.round(lot.cost * take / lot.quantity);
        lot.quantity -= take; lot.cost -= usedCost; remain -= take; cost += usedCost;
      }
      this.s.lots = this.s.lots.filter(l => l.quantity > 0);
      this.s.cash += gross - f.total; trade.pnl = gross - f.total - cost; trade.cost = cost;
      if (!this.s.lots.some(l => l.symbol === symbol)) delete this.s.risks[symbol];
    }
    const key = `${symbol}:${side}`, prior = this.s.consumed[key];
    this.s.consumed[key] = { timestamp: q.timestamp, quantity: quantity + (prior?.timestamp === q.timestamp ? prior.quantity : 0) };
    this.s.marks[symbol] = q;
    this.s.trades.push(trade); if (!this._agencyPosting) this.record(quotes, true); return trade;
  }
  strategyEntry(input, q, snapshot, quotes = {}) {
    const symbol = symbolOf(input.symbol), selected = this.selectedStrategy(symbol), strategyId = strategyProfile(input.strategyId ?? selected).id;
    if (strategyId !== selected) throw Error('已选策略发生变化，请查看当前买卖计划后重新确认');
    let evaluation;
    if (this._agencyContext) evaluation = this.agencyEvaluate(strategyId, symbol, q, snapshot, input.quantity, quotes);
    else {
      const valuation = holdingValuation(this.s.lots, { ...quotes, [symbol]: q }, this.s.marks, this.clock(), '计算策略风险预算');
      const evaluator = Object.create(this);
      evaluator.stats = overrides => this.stats({ ...valuation, ...overrides });
      evaluation = evaluateEntry(evaluator, symbol, q, snapshot, input.quantity, strategyId);
    }
    if (!evaluation.buyable) throw Error(`${evaluation.status}：${evaluation.reasons.join('；')}`);
    const p = evaluation.plan;
    if (input.expected) {
      const expected = input.expected;
      const configChanged = expected.config && Object.keys(this.s.strategySettings).some(key => expected.config[key] !== this.s.strategySettings[key]);
      const financialValues = plan => plan.financeEvidence?.finance?.data?.latest || null;
      if ((expected.strategyId || 'swing') !== strategyId || expected.asOf !== p.asOf || expected.stop !== p.stop || expected.target !== p.target || !Number.isFinite(expected.entry) || p.entry > expected.entry || configChanged || (strategyId === 'long' && JSON.stringify(financialValues(expected)) !== JSON.stringify(financialValues(p)))) throw Error('交易策略、计划参数、财报或买价已变化，请查看新计划后重新确认');
    }
    const profile = strategyProfile(strategyId);
    const trade = this.execute({ symbol, side: 'buy', quantity: evaluation.quantity }, q, quotes, profile.name);
    const plan = { ...p, source: snapshot.source || '来源未标注', entry: trade.price, quantity: trade.quantity, economics: evaluation.economics, config: { ...(p.config || this.s.strategySettings) } };
    trade.strategyPlan = structuredClone(plan);
    this.s.risks[symbol] = {
      stop: p.stop, target: p.target, trailing: 0, peak: q.price, enabled: true, dynamic: true, strategy: strategyId === 'swing' ? 'swing-pullback-v1' : `${strategyId}-v1`, strategyId, strategyName: profile.name,
      entryTradeId: trade.id, entryPrice: trade.price, entryDate: cnTime(this.clock()).date, initialStop: p.stop, initialTarget: p.target,
      initialPlannedLoss: evaluation.economics.loss, config: { ...(p.config || this.s.strategySettings) }, lastReviewAsOf: p.asOf, heldBars: 0,
      ...(p.financeEvidence ? { financeEvidence: structuredClone(p.financeEvidence) } : {}),
      note: '策略建仓完成，T+1 后可卖出；监控止盈止损', reviewNote: '等待新的完整日线',
      history: [{ time: trade.time, asOf: p.asOf, oldStop: null, stop: p.stop, oldTarget: null, target: p.target, reason: '按实际成交价校验风险预算，建立交易计划' }]
    };
    return trade;
  }
  place(input) {
    const symbol = symbolOf(input.symbol), side = input.side;
    if (!['buy', 'sell'].includes(side)) throw Error('买卖方向无效');
    const quantity = Number(input.quantity); this.validateQuantity(symbol, quantity, side, true);
    const limit = numberIn(input.limit, 0.01, 100000, '限价');
    if (Math.abs(limit * 100 - Math.round(limit * 100)) > 0.0001) throw Error('限价最多保留两位小数');
    if (this.s.orders.filter(o => o.status === 'pending').length >= 100) throw Error('最多保留 100 条待执行条件单');
    const order = { id: id(), symbol, side, quantity, limit, status: 'pending', createdAt: this.clock().toISOString(), note: '等待新鲜报价触发；不冻结资金或股份' };
    this.s.orders.push(order); return order;
  }
  cancel(orderId) { const o = this.s.orders.find(o => o.id === orderId); if (!o || o.status !== 'pending') throw Error('委托已结束或不存在'); o.status = 'cancelled'; o.note = '用户撤销'; }
  setRisk(symbol, input) {
    symbol = symbolOf(symbol);
    if (!this.s.lots.some(l => l.symbol === symbol)) throw Error('请先持有该股票，再设置止盈止损');
    const existing = this.s.risks[symbol];
    if (existing?.strategy) {
      // Strategy prices are managed as one plan. Pausing does not reset its audit trail or exit latch.
      existing.enabled = Boolean(input.enabled); existing.dynamic = Boolean(input.dynamic);
      existing.note = existing.enabled ? '策略风控监控中' : '自动模拟卖出已暂停';
      existing.history.push({ time: this.clock().toISOString(), asOf: existing.lastReviewAsOf, oldStop: existing.stop, stop: existing.stop, oldTarget: existing.target, target: existing.target, reason: `${existing.enabled ? '启用' : '暂停'}自动卖出；${existing.dynamic ? '启用' : '暂停'}日线复核（调价、趋势和期限退出）` });
      return;
    }
    const stop = input.stop === '' || input.stop == null ? null : numberIn(input.stop, 0.01, 100000, '止损价');
    const target = input.target === '' || input.target == null ? null : numberIn(input.target, 0.01, 100000, '止盈价');
    const trailing = numberIn(input.trailing || 0, 0, 30, '移动止损比例');
    if (stop != null && target != null && stop >= target) throw Error('止损价须低于止盈价');
    this.s.risks[symbol] = { stop, target, trailing, enabled: Boolean(input.enabled), peak: this.s.marks[symbol]?.price || this.positions().find(p => p.symbol === symbol).price, note: '等待实时行情' };
  }
  tick(quotes, snapshots = {}) {
    Object.assign(this.s.marks, quotes);
    const events = [];
    // Risk exits get priority over optional entry orders.
    for (const p of this.positions(quotes)) {
      const r = this.s.risks[p.symbol], q = quotes[p.symbol];
      if (!r || (!r.enabled && !r.strategy)) continue;
      try {
        const agencyCheck = this.agencyAutomaticCheck(p.symbol, q, snapshots[p.symbol], { allowVerifiedExit: true });
        if (agencyCheck.reason) { r.note = agencyCheck.reason; continue; }
        this.fresh(q); r.peak = Math.max(r.peak || 0, q.price);
        const trailingStop = r.trailing ? r.peak * (1 - r.trailing / 100) : 0, threshold = Math.max(r.stop || 0, trailingStop);
        let reason = r.pendingExit || (threshold && q.price <= threshold ? '止损触发' : r.target && q.price >= r.target ? '止盈触发' : null);
        // Honor previously crossed boundaries before any adjustment. Never move a target away from a triggered exit.
        if (!reason && !agencyCheck.exitOnly) {
          updateDynamicRisk(r, snapshots[p.symbol], q, this.clock());
          reason = r.pendingExit || (r.stop && q.price <= r.stop ? '止损触发' : r.target && q.price >= r.target ? '止盈触发' : null);
        }
        if (agencyCheck.exitOnly) r.reviewNote = agencyCheck.dailyReason;
        const agencyIntent = !reason ? this.agencyPendingExit(p.symbol) : null;
        if (agencyIntent) reason = agencyIntent.action === 'reduce' ? '自动减仓目标待完成' : '自动退出目标待完成';
        if (!reason) { r.note = r.strategy ? `${r.enabled ? '持仓跟踪' : '自动卖出暂停'} · ${r.dynamic ? r.reviewNote : '日线复核已暂停，仅按已存价位监控；趋势与期限退出暂停'}` : '监控中'; continue; }
        if (r.strategy && !agencyIntent) r.pendingExit = reason;
        if (!r.enabled) { r.note = `${reason}，自动卖出已暂停，等待用户启用`; continue; }
        if (!p.available) throw Error('已触发，但受 T+1 限制暂不可卖');
        const max = Math.min(maxOrderQuantity(p.symbol), p.available, this.liquidity(q, 'sell'), agencyIntent ? Math.max(0, p.quantity - agencyIntent.targetQuantity) : p.quantity);
        const quantity = max === p.available ? max : p.symbol.startsWith('sh688') ? (max >= 200 ? Math.floor(max) : 0) : Math.floor(max / 100) * 100;
        if (!quantity) throw Error('已触发，对手一档数量不足，继续等待');
        events.push(this.agencyAutomaticSell({ symbol: p.symbol, side: 'sell', quantity, automatic: true }, q, quotes, reason)); r.note = `${reason}，已卖出 ${quantity} 股`;
      } catch (e) { r.note = e.message; }
    }
    for (const o of this.s.orders.filter(o => o.status === 'pending')) {
      const q = quotes[o.symbol];
      try { this.fresh(q); if ((o.side === 'buy' && q.ask > o.limit) || (o.side === 'sell' && q.bid < o.limit)) { o.note = '等待到达限价'; continue; }
        const trade = this.execute(o, q, quotes, '限价条件单'); o.status = 'filled'; o.tradeId = trade.id; o.note = '已模拟成交'; events.push(trade);
      } catch (e) { o.note = e.message; }
    }
    this.record(quotes); return events;
  }
  record(quotes, force = false) {
    const value = this.stats(quotes).equity, time = this.clock().getTime(), prev = this.s.equity.at(-1);
    if (force || !prev || (time - prev.time > 60000 && value !== prev.value)) this.s.equity.push({ time, value,
      ...(this.s.capitalFlows?.length ? { netContributions: this.s.capitalFlows.reduce((sum, flow) => sum + flow.amount, 0) } : {}) });
    // Downsample old observations while preserving extrema used for drawdown.
    if (this.s.equity.length > 30000) {
      const old = this.s.equity.splice(0, 10000), compact = [];
      for (let i = 0; i < old.length;) {
        let end = i + 1;
        // Raw equity extrema are comparable only within one funding stage.
        while (end < Math.min(old.length, i + 10) && (old[end].netContributions ?? 0) === (old[i].netContributions ?? 0)) end++;
        const block = old.slice(i, end), extremes = [block[0], block.reduce((a,b)=>a.value>b.value?a:b), block.reduce((a,b)=>a.value<b.value?a:b), block.at(-1)];
        // Millisecond timestamps can be identical for several fills. Retain
        // insertion order rather than reordering a later peak before a trough.
        const selected = new Set(extremes);
        for (const point of block) if (selected.delete(point)) compact.push(point);
        i = end;
      }
      this.s.equity.unshift(...compact);
    }
  }
  configure(input) {
    const next = { ...this.s.settings };
    for (const [key, min, max, label] of [['commission', 0, 0.01, '佣金率'], ['minCommission', 0, 100, '最低佣金'], ['stampTax', 0, 0.01, '印花税率'], ['transferFee', 0, 0.01, '过户费率'], ['maxPosition', 0.01, 1, '单股仓位上限'], ['refreshSeconds', 5, 60, '刷新间隔'], ['slippageTicks', 0, 50, '滑点']]) next[key] = numberIn(input[key], min, max, label);
    if (!Number.isInteger(next.slippageTicks) || !Number.isInteger(next.refreshSeconds)) throw Error('刷新秒数和滑点档数须为整数');
    this.s.settings = next;
  }
}
installAgency(Engine);
module.exports = { Engine, initialState, validState, fees, defaults };
