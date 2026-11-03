'use strict';
const { cnTime } = require('./common.cjs');
const { calendarSession } = require('./trading-calendar.cjs');

// This is a readiness diagnostic, never an execution authorization. Auction
// reference fields do not describe an executable continuous-trading order book.
function preopenPriceReference(symbol, quote, technical, actions, now) {
  const time = cnTime(now), day = calendarSession(new Date(`${time.date}T10:00:00+08:00`));
  const waiting = reason => ({ status: 'waiting', reason });
  if (!day.known || !day.open || time.minutes < 555 || time.minutes >= 570)
    return waiting('等待交易日竞价阶段的当日参考基准');
  if (!quote || quote.symbol !== symbol || quote.provider !== 'tencent' || !quote.source
    || quote.date !== time.date || !Number.isFinite(quote.timestamp) || quote.timestamp > now
    || now - quote.timestamp > 90000 || cnTime(quote.timestamp).date !== time.date
    || cnTime(quote.timestamp).minutes < 555 || !(quote.prevClose > 0)
    || !(quote.limitUp > quote.limitDown && quote.limitDown > 0))
    return waiting('竞价当日参考基准尚未取得，开盘后以新鲜报价核验');
  const expected = (actions || []).filter(action => action.symbol === symbol && action.status !== 'exception' && action.terms?.exDate === time.date)
    .reduce((price, action) => (price - action.terms.cashPerShare) / (1 + action.terms.bonusPerShare + action.terms.transferPerShare), technical?.close);
  if (!(expected > 0) || !Number.isFinite(expected) || Math.abs(expected - quote.prevClose) > 0.011)
    return { status: 'mismatch', reason: '竞价参考基准与完整日线及除权资料不一致，等待核实', expected, reference: quote.prevClose, quoteTime: quote.timestamp };
  return { status: 'checked', reason: '竞价参考基准预检通过；开盘仍核对最新报价与盘口',
    date: time.date, reference: quote.prevClose, dailyAsOf: technical.asOf, quoteTime: quote.timestamp, source: quote.source };
}

function preparationState(engine, monitor, quotes = {}, now = Date.now()) {
  const session = calendarSession(new Date(now)), date = cnTime(now).date;
  const members = engine.s.agency.groups.flatMap(group => group.members.map(member => {
    const basic = { symbol: member.symbol, strategyId: group.id, checkedAt: now, preparedAt: null, components: [] };
    if (member.mode === 'standby') return { ...basic, status: 'inactive', reason: member.standbyReason || '候补不参与高频准备，更新四策略候选池时重新筛选' };
    if (group.mode === 'stopped') return { ...basic, status: 'inactive', reason: '本策略已停止' };
    const details = monitor?.preparationState?.(member.symbol, false, false)
      || { status: 'preparing', reason: '等待盘前资料准备' };
    const result = { ...basic, ...details, symbol: member.symbol, strategyId: group.id };
    if (!session.known) return { ...result, status: 'error', reason: session.label };
    if (!['prepared', 'waiting-live'].includes(result.status)) return result;
    if (member.reconciliation?.status === 'pending' || member.automaticCheck?.status === 'blocked')
      return { ...result, status: 'error', reason: `资料已取得，但仍有核验阻断：${member.reconciliation?.status === 'pending'
        ? member.reconciliation.reason : member.automaticCheck.reason}` };
    const checkedAt = Date.parse(member.automaticCheck?.checkedAt);
    if (member.automaticCheck?.reference?.status === 'mismatch' && Number.isFinite(checkedAt)
      && cnTime(checkedAt).date === date && !session.open)
      return { ...result, status: 'error', reason: member.automaticCheck.reference.reason };
    if (!session.open) return { ...result, reason: `${result.reason}；${session.label}，等待连续交易行情与策略判断` };
    const q = quotes[member.symbol], basis = member.exitPriceBasis, snapshot = monitor?.snapshots?.[member.symbol];
    const quoteReady = q?.symbol === member.symbol && q.date === date && q.source && q.canTrade !== false
      && Number.isFinite(q.timestamp) && q.timestamp <= now && now - q.timestamp <= 90000
      && cnTime(q.timestamp).date === date && calendarSession(new Date(q.timestamp)).open
      && q.price > 0 && q.prevClose > 0;
    const basisReady = member.automaticCheck?.status === 'clear' && !member.awaitingVerification
      && member.reconciliation?.status === 'clear' && basis?.date === date && basis.checkedAt <= now
      && basis.dailyAsOf === snapshot?.technical?.asOf && basis.dailyClose === snapshot?.technical?.close
      && Math.abs(basis.prevClose - q?.prevClose) <= 0.011;
    if (result.status === 'waiting-live' || !quoteReady || !basisReady)
      return { ...result, status: 'waiting-live', reason: !quoteReady ? '历史资料已准备，等待当日连续交易的有效报价'
        : !basisReady ? '历史资料已准备，等待当前价格基准核验' : result.reason };
    return { ...result, status: 'ready', reason: group.mode === 'paused' ? '资料已就绪；本策略暂停新开仓'
      : '资料已就绪；入场仍需市场环境、策略信号及成交前检查通过' };
  }));
  return { date, checkedAt: now, total: members.length,
    prepared: members.filter(member => member.status === 'prepared').length,
    waitingLive: members.filter(member => member.status === 'waiting-live').length,
    ready: members.filter(member => member.status === 'ready').length,
    failed: members.filter(member => member.status === 'error').length,
    preparing: members.filter(member => member.status === 'preparing').length,
    inactive: members.filter(member => member.status === 'inactive').length, members };
}

function noticePreparationOpen(now = Date.now()) {
  const time = cnTime(now), day = calendarSession(new Date(`${time.date}T10:00:00+08:00`));
  return day.known && day.open && time.minutes >= 525 && time.minutes < 900;
}

module.exports = { preopenPriceReference, preparationState, noticePreparationOpen };
