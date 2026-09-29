const { money, yuan, id, cnTime, session, symbolOf, numberIn } = require('./common.cjs');
const defaults = { commission: 0.00025, minCommission: 5, stampTax: 0.0005, transferFee: 0.00001, slippageTicks: 1, maxPosition: 0.3, refreshSeconds: 10 };
function initialState(capital = 1000000) {
  const cents = money(numberIn(capital, 10000, 100000000, '初始资金'));
  return { version: 1, initialCash: cents, cash: cents, settings: { ...defaults }, watchlist: ['sh600519', 'sz000001', 'sz300750', 'sh600036', 'sz002594', 'sh601318'], lots: [], risks: {}, orders: [], trades: [], equity: [{ time: Date.now(), value: cents }], marks: {}, consumed: {}, createdAt: new Date().toISOString() };
}
function validState(s) {
  return s?.version === 1 && Number.isSafeInteger(s.cash) && s.cash >= 0 && Number.isSafeInteger(s.initialCash) && s.initialCash > 0 && ['lots', 'orders', 'trades', 'equity', 'watchlist'].every(k => Array.isArray(s[k])) && s.settings && s.risks && s.marks && s.consumed;
}
function fees(gross, side, settings) {
  const commission = Math.max(money(settings.minCommission), Math.round(gross * settings.commission));
  const stampTax = side === 'sell' ? Math.round(gross * settings.stampTax) : 0;
  const transferFee = Math.round(gross * settings.transferFee);
  return { commission, stampTax, transferFee, total: commission + stampTax + transferFee };
}
class Engine {
  constructor(state = initialState(), clock = () => new Date()) { if (!validState(state)) throw Error('账户数据格式不正确'); this.s = state; this.clock = clock; }
  positions(quotes = {}) {
    const grouped = {};
    for (const l of this.s.lots) {
      const p = grouped[l.symbol] ||= { symbol: l.symbol, name: l.name, quantity: 0, available: 0, cost: 0 };
      p.quantity += l.quantity; p.cost += l.cost;
      if (l.date < cnTime(this.clock()).date) p.available += l.quantity;
    }
    return Object.values(grouped).map(p => {
      const q = quotes[p.symbol] || this.s.marks[p.symbol], price = q?.price || yuan(p.cost / p.quantity), value = money(price) * p.quantity;
      return { ...p, average: yuan(p.cost / p.quantity), price, value, pnl: value - p.cost, pnlPct: (value - p.cost) / p.cost, quoteTime: q?.timestamp, risk: this.s.risks[p.symbol] || null };
    });
  }
  stats(quotes = {}) {
    const positions = this.positions(quotes), marketValue = positions.reduce((s, p) => s + p.value, 0), equity = this.s.cash + marketValue;
    const sells = this.s.trades.filter(t => t.side === 'sell'), wins = sells.filter(t => t.pnl > 0), losses = sells.filter(t => t.pnl < 0);
    const gain = wins.reduce((s, t) => s + t.pnl, 0), loss = -losses.reduce((s, t) => s + t.pnl, 0);
    let peak = this.s.initialCash, drawdown = 0;
    for (const e of [...this.s.equity, { value: equity }]) { peak = Math.max(peak, e.value); drawdown = Math.max(drawdown, (peak - e.value) / peak); }
    return { equity, cash: this.s.cash, marketValue, pnl: equity - this.s.initialCash, returnPct: equity / this.s.initialCash - 1,
      realized: sells.reduce((s, t) => s + t.pnl, 0), unrealized: positions.reduce((s, p) => s + p.pnl, 0),
      fees: this.s.trades.reduce((s, t) => s + t.fees.total, 0), sells: sells.length, wins: wins.length, losses: losses.length, breakeven: sells.length - wins.length - losses.length,
      winRate: sells.length ? wins.length / sells.length : null, profitFactor: loss ? gain / loss : null, drawdown, positions };
  }
  fresh(q) {
    const now = this.clock(), t = cnTime(now);
    if (!session(now).open) throw Error(`${session(now).label}。仅在 09:30–11:30、13:00–14:57 连续竞价时段撮合`);
    if (!q || !Number.isFinite(q.price) || q.price <= 0 || !Number.isFinite(q.timestamp)) throw Error('没有有效报价');
    const age = now.getTime() - q.timestamp;
    if (q.date !== t.date || age > 90000 || age < -15000) throw Error('报价过期或市场休市，暂停撮合；需要当日 90 秒内报价');
    if (!(q.volume > 0) || !(q.open > 0)) throw Error('停牌或无成交行情，暂停撮合');
    if (!Number.isFinite(q.limitUp) || !Number.isFinite(q.limitDown) || !(q.limitUp > q.limitDown) || !(q.limitDown > 0)) throw Error('缺少涨跌停信息；首版暂停无价格限制证券的撮合');
  }
  validateQuantity(symbol, quantity, side) {
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1000000) throw Error('数量须为 1 至 1,000,000 的整数');
    const star = symbol.startsWith('sh688'), p = this.positions().find(p => p.symbol === symbol);
    if (side === 'sell' && p && quantity === p.available) return;
    if (star ? quantity < 200 : quantity % 100 !== 0) throw Error(star ? '科创板单次申报至少 200 股；不足 200 股的可卖余额须一次卖出' : '买卖数量须为 100 股的整数倍；零股可卖余额须一次卖出');
  }
  liquidity(q, side) {
    const key = `${q.symbol}:${side}`, used = this.s.consumed[key];
    return Math.max(0, (side === 'buy' ? q.askSize : q.bidSize) - (used?.timestamp === q.timestamp ? used.quantity : 0));
  }
  execute(input, q, quotes = {}, reason = '手动模拟交易') {
    const symbol = symbolOf(input.symbol), side = input.side;
    if (!['buy', 'sell'].includes(side)) throw Error('买卖方向无效');
    if (q?.symbol !== symbol) throw Error('行情代码不匹配');
    this.fresh(q);
    const quantity = Number(input.quantity); this.validateQuantity(symbol, quantity, side);
    const book = side === 'buy' ? q.ask : q.bid;
    if (!(book > 0) || this.liquidity(q, side) < quantity) throw Error('对手一档可见数量不足；本工具不模拟排队，可减少数量或等待新报价');
    const priceCents = money(book) + (side === 'buy' ? 1 : -1) * this.s.settings.slippageTicks;
    if (priceCents > money(q.limitUp) || priceCents < money(q.limitDown)) throw Error('加入滑点后的价格超出涨跌停范围，等待可成交报价');
    const price = yuan(priceCents);
    if (input.limit != null && (side === 'buy' ? price > input.limit : price < input.limit)) throw Error('含滑点价格尚未满足限价');
    const gross = priceCents * quantity, f = fees(gross, side, this.s.settings), now = this.clock(), date = cnTime(now).date;
    const trade = { id: id(), symbol, name: q.name, side, quantity, price, gross, fees: f, pnl: null, time: now.toISOString(), quoteTime: q.timestamp, reason };
    if (side === 'buy') {
      if (gross + f.total > this.s.cash) throw Error('模拟可用资金不足');
      const stat = this.stats(quotes), existing = stat.positions.find(p => p.symbol === symbol)?.value || 0;
      if (existing + gross > stat.equity * this.s.settings.maxPosition) throw Error(`超过单股仓位上限 ${(this.s.settings.maxPosition * 100).toFixed(0)}%，请调整数量或风控设置`);
      this.s.cash -= gross + f.total;
      this.s.lots.push({ id: id(), symbol, name: q.name, quantity, cost: gross + f.total, date });
    } else {
      const p = this.positions().find(p => p.symbol === symbol);
      if (!p || quantity > p.available) throw Error(`T+1 可卖数量不足，当前可卖 ${p?.available || 0} 股`);
      let remain = quantity, cost = 0;
      for (const lot of this.s.lots) {
        if (lot.symbol !== symbol || lot.date >= date || !remain) continue;
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
    this.s.trades.push(trade); this.record(quotes, true); return trade;
  }
  place(input) {
    const symbol = symbolOf(input.symbol), side = input.side;
    if (!['buy', 'sell'].includes(side)) throw Error('买卖方向无效');
    const quantity = Number(input.quantity); this.validateQuantity(symbol, quantity, side);
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
    const stop = input.stop === '' || input.stop == null ? null : numberIn(input.stop, 0.01, 100000, '止损价');
    const target = input.target === '' || input.target == null ? null : numberIn(input.target, 0.01, 100000, '止盈价');
    const trailing = numberIn(input.trailing || 0, 0, 30, '移动止损比例');
    if (stop != null && target != null && stop >= target) throw Error('止损价须低于止盈价');
    this.s.risks[symbol] = { stop, target, trailing, enabled: Boolean(input.enabled), peak: this.s.marks[symbol]?.price || this.positions().find(p => p.symbol === symbol).price, note: '等待实时行情' };
  }
  tick(quotes) {
    Object.assign(this.s.marks, quotes);
    const events = [];
    // Risk exits get priority over optional entry orders.
    for (const p of this.positions(quotes)) {
      const r = this.s.risks[p.symbol], q = quotes[p.symbol];
      if (!r?.enabled) continue;
      try {
        this.fresh(q); r.peak = Math.max(r.peak || 0, q.price);
        const trailingStop = r.trailing ? r.peak * (1 - r.trailing / 100) : 0, threshold = Math.max(r.stop || 0, trailingStop);
        const reason = threshold && q.price <= threshold ? '止损触发' : r.target && q.price >= r.target ? '止盈触发' : null;
        if (!reason) { r.note = '监控中'; continue; }
        if (!p.available) throw Error('已触发，但受 T+1 限制暂不可卖');
        const max = Math.min(p.available, this.liquidity(q, 'sell'));
        const quantity = max === p.available ? max : p.symbol.startsWith('sh688') ? (max >= 200 ? Math.floor(max) : 0) : Math.floor(max / 100) * 100;
        if (!quantity) throw Error('已触发，对手一档数量不足，继续等待');
        events.push(this.execute({ symbol: p.symbol, side: 'sell', quantity }, q, quotes, reason)); r.note = `${reason}，已卖出 ${quantity} 股`;
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
    if (force || !prev || (time - prev.time > 60000 && value !== prev.value)) this.s.equity.push({ time, value });
    // Downsample old observations while preserving extrema used for drawdown.
    if (this.s.equity.length > 30000) {
      const old = this.s.equity.splice(0, 10000), compact = [];
      for (let i = 0; i < old.length; i += 10) { const block = old.slice(i, i + 10); const extremes = [block[0], block.reduce((a,b)=>a.value>b.value?a:b), block.reduce((a,b)=>a.value<b.value?a:b), block.at(-1)]; compact.push(...[...new Set(extremes)].sort((a,b)=>a.time-b.time)); }
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
module.exports = { Engine, initialState, validState, fees, defaults };
