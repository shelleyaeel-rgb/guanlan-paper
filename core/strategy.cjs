const { cnTime, money, yuan, numberIn } = require('./common.cjs');
const { dailyIndicators } = require('./daily-indicators.cjs');
const { fees } = require('./fees.cjs');
const strategyDefaults = { minRewardRisk: 2, riskPercent: 0.5, adjustmentAtr: 0.25 };
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const round = n => yuan(money(n));

function configureStrategy(input) {
  return {
    minRewardRisk: numberIn(input.minRewardRisk, 1, 5, '最低含费盈亏比'),
    riskPercent: numberIn(input.riskPercent, 0.1, 2, '单笔计划风险比例（%）'),
    adjustmentAtr: numberIn(input.adjustmentAtr, 0.05, 0.5, '单日调整幅度（ATR）')
  };
}

// Trading levels always use unadjusted bars, matching the executable quote basis.
function technicals(rawBars, now = new Date()) {
  const daily = dailyIndicators(rawBars, now), { bars, ma5, ma20, ma60 } = daily;
  const c = bars.map(b => b.close), last = bars.at(-1);
  const atr = mean(bars.slice(-14).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - c[c.length - 15 + i]), Math.abs(b.low - c[c.length - 15 + i]))));
  if (!(atr > 0)) throw Error('波动幅度不足，暂停生成计划');
  const support = Math.min(ma20, ...bars.slice(-5).map(b => b.low)), resistance = Math.max(...bars.slice(-20).map(b => b.high));
  return {
    asOf: last.date, close: last.close, previousClose: c.at(-2), dates: bars.map(b => b.date), ma5, ma20, ma60, atr,
    rsi: daily.rsi, macd: daily.macd, volumeRatio: daily.dailyVolumeRatio,
    trend: last.close >= ma20 && ma20 > ma60 && ma20 > daily.previousMa20,
    breakout: last.close > Math.max(...bars.slice(-6, -1).map(b => b.high)), support, resistance,
    entryLow: round(ma20 - atr * 0.25), entryHigh: round(ma20 + atr * 0.75),
    stop: round(Math.max(0.01, support - atr * 0.25)), target: round(resistance)
  };
}

function usableTechnical(snapshot, q, now = new Date()) {
  if (!snapshot || snapshot.error) throw Error(snapshot?.error || '正在获取策略日线');
  if (!Number.isFinite(snapshot.fetchedAt) || now.getTime() - snapshot.fetchedAt > 180000 || snapshot.fetchedAt > now.getTime() + 15000) throw Error('策略日线缓存已过期，等待重新获取');
  const t = snapshot.technical, date = cnTime(now).date;
  if (!t || !q || t.asOf > q.date || t.asOf > date) throw Error('日线与报价日期不一致');
  // Catch missed sessions and ex-rights reference changes instead of mixing price bases.
  const reference = t.close;
  const marketReference = t.asOf === q.date ? q.price : q.prevClose;
  if (!Number.isFinite(marketReference) || Math.abs(reference - marketReference) > 0.011) throw Error('日线与行情价格基准不一致（可能缺日线或除权），暂停策略更新');
  return t;
}

function economics(price, stop, target, quantity, settings) {
  const cost = money(price) * quantity, buyFee = fees(cost, 'buy', settings).total;
  const stopGross = Math.max(1, money(stop) - settings.slippageTicks) * quantity;
  const targetGross = Math.max(1, money(target) - settings.slippageTicks) * quantity;
  const loss = cost + buyFee - stopGross + fees(stopGross, 'sell', settings).total;
  const reward = targetGross - fees(targetGross, 'sell', settings).total - cost - buyFee;
  return { cost: cost + buyFee, loss, reward, rewardRisk: loss > 0 ? reward / loss : 0 };
}

function evaluateEntry(engine, symbol, q, snapshot, requestedQuantity) {
  const now = engine.clock(), settings = engine.s.settings, config = engine.s.strategySettings;
  const result = { symbol, status: '等待数据', buyable: false, reasons: [], quoteTime: q?.timestamp, quoteSource: q?.source, dailySource: snapshot?.source, checkedAt: now.getTime(), quantity: 0 };
  const position = engine.positions().find(p => p.symbol === symbol);
  if (position) {
    try { const t = usableTechnical(snapshot, q, now); result.plan = { entry: q.price, entryLow: t.entryLow, entryHigh: t.entryHigh, stop: t.stop, target: t.target, asOf: t.asOf }; } catch {}
    return { ...result, status: position.risk?.pendingExit ? '卖出触发' : '持仓跟踪', reasons: [position.risk?.note || '已有持仓，本策略暂不加仓'], risk: position.risk };
  }
  let t;
  try { t = usableTechnical(snapshot, q, now); }
  catch (e) { result.reasons.push(e.message); return result; }
  const price = q?.ask > 0 ? round(q.ask + settings.slippageTicks * 0.01) : null;
  result.plan = { entryLow: t.entryLow, entryHigh: t.entryHigh, entry: price, stop: t.stop, target: t.target, asOf: t.asOf };
  const reject = (status, reason) => { result.status = status; result.reasons.push(reason); return result; };
  try { engine.fresh(q); } catch (e) { return reject('等待有效行情', e.message); }
  if (!t.trend || t.macd <= 0 || t.rsi < 40 || t.rsi > 75 || !Number.isFinite(t.volumeRatio) || t.volumeRatio < 0.6) return reject('等待趋势', '需要 MA20 向上且高于 MA60、收盘不低于 MA20、MACD 柱为正、RSI 40–75、日量比不低于 0.6');
  if (!(price >= t.entryLow && price <= t.entryHigh)) return reject('等待回踩', '含滑点买价尚未进入 MA20 附近的回踩区域');
  if (!(q.price >= q.prevClose && q.price >= q.open && q.price >= t.ma20 && q.low <= t.entryHigh)) return reject('等待确认', '等待盘中价格站回 MA20，且不低于昨收和今开');
  if (!(t.stop < price && t.target > price)) return reject('空间不足', '支撑止损、入场价与压力止盈的顺序不满足交易条件');
  if (money(price) > money(q.limitUp) || money(price) < money(q.limitDown)) return reject('等待有效行情', '含滑点价格超出涨跌停范围');
  if (engine.s.orders.some(o => o.symbol === symbol && o.side === 'buy' && o.status === 'pending')) return reject('已有买入委托', '请先处理该股票的待执行买单，避免重复建仓');
  // A stopped-out strategy cannot immediately re-enter on the same closed-bar signal.
  const previous = [...engine.s.trades].reverse().find(tr => tr.symbol === symbol && tr.side === 'buy' && tr.strategyPlan);
  if (previous?.strategyPlan.asOf >= t.asOf) return reject('等待新日线', '本根日线已用于策略建仓，平仓后等待下一根完整日线');
  const stat = engine.stats({ [symbol]: q }), budget = Math.floor(stat.equity * config.riskPercent / 100), star = symbol.startsWith('sh688'), minimum = star ? 200 : 100, step = star ? 1 : 100;
  let maxQuantity = Math.min(1000000, Math.floor(engine.liquidity(q, 'buy')), Math.floor(stat.equity * settings.maxPosition / money(price)), Math.floor(stat.cash / money(price)));
  const units = n => star ? n : Math.floor(n / 100) * 100;
  maxQuantity = units(maxQuantity);
  // Binary search includes minimum commissions and exact cent rounding in the budget.
  let low = 0, high = Math.max(0, Math.floor((maxQuantity - minimum) / step) + 1);
  while (low < high) { const mid = Math.ceil((low + high) / 2), quantity = minimum + (mid - 1) * step, e = economics(price, t.stop, t.target, quantity, settings); if (e.cost <= stat.cash && e.loss <= budget) low = mid; else high = mid - 1; }
  const recommended = low ? minimum + (low - 1) * step : 0;
  result.maxQuantity = recommended; result.budget = budget;
  const quantity = requestedQuantity == null ? recommended : Number(requestedQuantity);
  if (!recommended) return reject('风险预算不足', '资金、仓位、单笔风险预算或一档数量不足以买入最小数量');
  try { engine.validateQuantity(symbol, quantity, 'buy'); } catch (e) { return reject('数量无效', e.message); }
  if (quantity > recommended) return reject('超过计划上限', `当前最多允许 ${recommended} 股，请重新确认计划`);
  result.quantity = quantity; result.economics = economics(price, t.stop, t.target, quantity, settings);
  if (result.economics.rewardRisk < config.minRewardRisk) return reject('空间不足', `含双边费用及滑点的盈亏比低于 ${config.minRewardRisk}`);
  return { ...result, buyable: true, status: '可以买入', reasons: ['趋势与回踩确认通过，含费盈亏比、资金、仓位和风险预算通过；提交时重新校验'] };
}

function updateDynamicRisk(risk, snapshot, q, now) {
  if (!risk.strategy || !risk.dynamic || risk.pendingExit) return;
  let t;
  try { t = usableTechnical(snapshot, q, now); } catch (e) { risk.reviewNote = e.message; return; }
  if (t.asOf <= risk.lastReviewAsOf) return;
  const oldStop = risk.stop, oldTarget = risk.target, step = Math.floor(t.atr * risk.config.adjustmentAtr * 100) / 100, noise = Math.max(0.01, t.atr * 0.05);
  const heldDays = t.dates.filter(date => date > risk.entryDate).length;
  let reason = '新日线确认，保留原计划';
  if (t.ma20 < t.ma60 || t.close < t.ma20 - t.atr * 0.5) {
    risk.pendingExit = '波段趋势失效'; reason = '完整日线跌破趋势条件，等待可卖报价退出';
  } else if (heldDays >= 15 && t.close <= risk.entryPrice) {
    risk.pendingExit = '波段持有超时'; reason = '持有满 15 根新日线仍未上涨，等待退出';
  } else {
    const desiredStop = round(Math.min(t.support - t.atr * 0.25, t.close - t.atr, q.price - 0.01, risk.target - 0.01));
    if (desiredStop - risk.stop >= noise && step >= 0.01) { risk.stop = round(Math.min(desiredStop, risk.stop + step)); reason = '有效支撑抬高，上移止损保护仓位'; }
    if (t.trend && t.breakout && risk.stop > oldStop) {
      risk.target = round(risk.target + step); reason += '；完整日线突破近 5 日压力，小幅上调止盈';
    } else if (t.close < t.ma5 || t.macd <= 0) {
      const desiredTarget = Math.max(risk.stop + 0.01, q.price + 0.01, t.close + t.atr);
      if (risk.target - desiredTarget >= noise && step >= 0.01) { risk.target = round(Math.max(desiredTarget, risk.target - step)); reason += '；动能减弱，小幅下调止盈'; }
    }
  }
  risk.lastReviewAsOf = t.asOf; risk.reviewNote = reason;
  risk.history.push({ time: now.toISOString(), asOf: t.asOf, oldStop, stop: risk.stop, oldTarget, target: risk.target, reason });
}

module.exports = { strategyDefaults, configureStrategy, technicals, usableTechnical, economics, evaluateEntry, updateDynamicRisk };
