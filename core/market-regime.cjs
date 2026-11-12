'use strict';
const { cnTime, symbolOf } = require('./common.cjs');
const { dailyIndicators } = require('./daily-indicators.cjs');
const { calendarSession } = require('./trading-calendar.cjs');
const { preparedHistoryValid, publicDailyHistory } = require('./daily-history.cjs');

const INDEX_SYMBOLS = Object.freeze(['sh000001', 'sz399001', 'sz399006']);
// These are disclosed product defaults, not fitted parameters or evidence of profitability.
const MARKET_REGIME_POLICY = Object.freeze({ version: 2, quoteMaxAgeMs: 90000, breadthMaxAgeMs: 180000,
  dailyMaxAgeMs: 21600000, minBreadthCount: 1000, minBreadthCoverage: 0.8,
  strongAdvanceRatio: 0.55, weakAdvanceRatio: 0.35, highAtrRatio: 0.025,
  confirmationMs: 120000, confirmationSamples: 2, confirmationMaxGapMs: 180000, pollIntervalMs: 30000,
  note: '市场环境阈值为尚未回测及样本外验证的产品模板，不代表收益优势。开仓权限按当日市场广度与指数波动确定，指数中期趋势仅供观察，不影响任何策略的开仓权限或风险预算。广度为沪深 A 股有效同日报价中上涨股票占比，不含北交所；平盘计入分母。' });
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const timeOf = now => now instanceof Date ? now.getTime() : Number(now);
const goodTime = value => Number.isFinite(value) && value > 0 && value <= 8640000000000000;
const labels = { strong: '偏强', neutral: '中性', weak: '偏弱', unknown: '待核验' };

function unknownMarketRegime(reason = '市场环境尚未完成核验', now = Date.now(), previous = null) {
  const at = timeOf(now), validAt = goodTime(at) ? at : null;
  return { version: 1, policyVersion: MARKET_REGIME_POLICY.version, status: 'unknown', label: labels.unknown, riskMultiplier: 0,
    allowEntry: false, allowBreakout: false, checkedAt: previous?.checkedAt ?? validAt,
    expiresAt: previous?.expiresAt ?? validAt, date: previous?.date ?? (validAt ? cnTime(validAt).date : ''),
    reason, reasons: [reason], metrics: previous?.metrics || {}, evidence: previous?.evidence || {}, policyNote: MARKET_REGIME_POLICY.note };
}

// The account boundary treats a missing, stale or inconsistent permission as closed.
function validateMarketRegimeSnapshot(snapshot, now = Date.now()) {
  const at = timeOf(now), fail = reason => unknownMarketRegime(reason, at, snapshot);
  if (!goodTime(at) || !snapshot || snapshot.version !== 1 || snapshot.policyVersion !== MARKET_REGIME_POLICY.version || !Object.hasOwn(labels, snapshot.status)) return fail('市场环境快照身份或版本无效');
  if (!goodTime(snapshot.checkedAt) || !goodTime(snapshot.expiresAt) || snapshot.checkedAt > at || snapshot.expiresAt <= at
    || snapshot.expiresAt - snapshot.checkedAt > MARKET_REGIME_POLICY.quoteMaxAgeMs
    || snapshot.date !== cnTime(at).date || cnTime(snapshot.checkedAt).date !== snapshot.date) return fail(snapshot.status === 'unknown' && snapshot.reason ? snapshot.reason : '市场环境证据过期、跨日或时间无效，暂停新开仓');
  const permission = snapshot.status === 'strong' ? [0.5, 1] : snapshot.status === 'neutral' ? [0.5] : [0];
  if (!permission.includes(snapshot.riskMultiplier) || snapshot.allowEntry !== (snapshot.riskMultiplier > 0)
    || snapshot.allowBreakout !== (snapshot.status === 'strong' && snapshot.riskMultiplier === 1)) return fail('市场环境状态与交易权限不一致');
  if (snapshot.riskMultiplier === 1 && snapshot.metrics?.highVolatility === true) return fail('高波动市场环境不得使用完整计划风险或突破入场');
  if (snapshot.riskMultiplier > 0 && (!goodTime(snapshot.evidence?.quoteTime) || snapshot.evidence.quoteTime > snapshot.checkedAt
    || snapshot.checkedAt - snapshot.evidence.quoteTime > MARKET_REGIME_POLICY.breadthMaxAgeMs)) return fail('市场环境原始行情证据时间无效');
  if (snapshot.riskMultiplier > 0) {
    const indexTimes = INDEX_SYMBOLS.map(symbol => snapshot.evidence?.indexQuoteTimes?.[symbol]);
    const breadthTime = snapshot.evidence?.breadthQuoteTime;
    if (indexTimes.some(time => !goodTime(time) || time > snapshot.checkedAt || cnTime(time).date !== snapshot.date || snapshot.expiresAt > time + MARKET_REGIME_POLICY.quoteMaxAgeMs)
      || !goodTime(breadthTime) || breadthTime > snapshot.checkedAt || cnTime(breadthTime).date !== snapshot.date
      || snapshot.expiresAt > breadthTime + MARKET_REGIME_POLICY.breadthMaxAgeMs
      || snapshot.evidence.quoteTime !== Math.min(...indexTimes, breadthTime)) return fail('市场环境原始证据与有效期不一致');
  }
  return snapshot;
}

function expectedDailyDate(now) {
  const cn = cnTime(now), firstOffset = cn.minutes >= 900 ? 0 : 1;
  for (let offset = firstOffset; offset < 20; offset++) {
    const date = new Date(Date.parse(`${cn.date}T00:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);
    const session = calendarSession(new Date(`${date}T10:00:00+08:00`));
    if (!session.known) throw Error('指数完整日线的交易日历未经核验');
    if (session.open) return date;
  }
  throw Error('无法确认最近完整交易日');
}

function preparedIndexHistory(symbol, history, now, expectedDate = expectedDailyDate(now)) {
  const policy = MARKET_REGIME_POLICY;
  const validTime = history?.dailyEvidence !== undefined ? preparedHistoryValid(history, symbol, 'index', now)
    : history && goodTime(history.fetchedAt) && history.fetchedAt <= now && now - history.fetchedAt <= policy.dailyMaxAgeMs;
  if (!history || (history.symbol != null && history.symbol !== symbol) || history.adjustment !== '未复权' || !validTime || !history.source) throw Error(`${symbol} 指数日线来源、口径或获取时间无效`);
  const daily = dailyIndicators(history.bars, new Date(now));
  if (daily.asOf !== expectedDate) throw Error(`${symbol} 缺少最近完整交易日 ${expectedDate} 的指数日线`);
  return daily;
}

function indexMetrics(symbol, history, quote, now, expectedDate) {
  const policy = MARKET_REGIME_POLICY, date = cnTime(now).date;
  const daily = preparedIndexHistory(symbol, history, now, expectedDate);
  if (!quote || quote.symbol !== symbol || !quote.source || !goodTime(quote.timestamp) || quote.timestamp > now || now - quote.timestamp > policy.quoteMaxAgeMs
    || quote.date !== date || cnTime(quote.timestamp).date !== date || ![quote.price, quote.prevClose].every(value => Number.isFinite(value) && value > 0)) throw Error(`${symbol} 指数同日报价缺失或超过 90 秒`);
  const reference = daily.asOf === date ? quote.price : quote.prevClose;
  if (Math.abs(daily.close - reference) > Math.max(0.021, reference * 0.00002)) throw Error(`${symbol} 指数日线与报价基准不一致`);
  const closes = daily.bars.map(bar => bar.close), priorMa20 = mean(closes.slice(-25, -5));
  const ma20Slope5 = daily.ma20 / priorMa20 - 1;
  const tail = daily.bars.slice(-14), offset = daily.bars.length - 14;
  const atr = mean(tail.map((bar, index) => Math.max(bar.high - bar.low, Math.abs(bar.high - closes[offset + index - 1]), Math.abs(bar.low - closes[offset + index - 1]))));
  const atrRatio = atr / daily.close;
  const up = daily.close >= daily.ma20 && daily.ma20 > daily.ma60 && ma20Slope5 > 0 && quote.price >= daily.ma20;
  const down = daily.close < daily.ma20 && daily.ma20 < daily.ma60 && ma20Slope5 < 0;
  return { symbol, asOf: daily.asOf, close: daily.close, price: quote.price, changePct: (quote.price / quote.prevClose - 1) * 100,
    ma20: daily.ma20, ma60: daily.ma60, ma20Slope5, atr, atrRatio, trend: up ? 'up' : down ? 'down' : 'mixed',
    quoteTime: quote.timestamp, source: quote.source, dailySource: history.source, dailyFetchedAt: history.fetchedAt,
    ...(history.dailyEvidence ? { dailyHistory: publicDailyHistory(history, now) } : {}) };
}

function breadthMetrics(snapshot, now) {
  const policy = MARKET_REGIME_POLICY, date = cnTime(now).date;
  if (!snapshot || !Array.isArray(snapshot.rows) || !snapshot.source || !goodTime(snapshot.fetchedAt) || snapshot.fetchedAt > now
    || now - snapshot.fetchedAt > policy.breadthMaxAgeMs || cnTime(snapshot.fetchedAt).date !== date) throw Error('全市场广度快照缺失、过期或跨日');
  const expected = snapshot.sourceCount - snapshot.excludedCount;
  if (!Number.isInteger(snapshot.sourceCount) || !Number.isInteger(snapshot.excludedCount) || snapshot.excludedCount < 0
    || expected < policy.minBreadthCount || snapshot.rows.length > expected) throw Error('全市场广度覆盖基数无效');
  const seen = new Set(), valid = [];
  for (const row of snapshot.rows) {
    let symbol;
    try { symbol = symbolOf(row?.symbol); } catch { continue; }
    if (symbol !== row.symbol || seen.has(symbol)) throw Error('全市场广度含重复或无效股票代码');
    seen.add(symbol);
    if (!goodTime(row.timestamp) || row.timestamp > now || now - row.timestamp > policy.breadthMaxAgeMs || cnTime(row.timestamp).date !== date
      || !(row.price > 0) || !Number.isFinite(row.changePct) || row.changePct <= -100) continue;
    if (row.date != null && row.date !== date) continue;
    valid.push(row);
  }
  const coverage = valid.length / expected;
  if (valid.length < policy.minBreadthCount || coverage < policy.minBreadthCoverage) throw Error(`全市场广度有效覆盖不足：${valid.length}/${expected}，要求至少 ${policy.minBreadthCount} 只且覆盖 ${(policy.minBreadthCoverage * 100).toFixed(0)}%`);
  const advancing = valid.filter(row => row.changePct > 0).length, declining = valid.filter(row => row.changePct < 0).length;
  return { expected, valid: valid.length, advancing, declining, unchanged: valid.length - advancing - declining, coverage,
    advanceRatio: advancing / valid.length, oldestQuote: Math.min(...valid.map(row => row.timestamp)), newestQuote: Math.max(...valid.map(row => row.timestamp)),
    fetchedAt: snapshot.fetchedAt, source: snapshot.source, scope: '沪深 A 股，不含北交所' };
}

function evaluateMarketRegime({ histories = {}, quotes = {}, breadth } = {}, now = Date.now()) {
  const at = timeOf(now), policy = MARKET_REGIME_POLICY;
  try {
    if (!goodTime(at)) throw Error('市场环境核验时间无效');
    const expected = expectedDailyDate(at), indices = INDEX_SYMBOLS.map(symbol => indexMetrics(symbol, histories[symbol], quotes[symbol], at, expected));
    const broad = breadthMetrics(breadth, at), upCount = indices.filter(index => index.trend === 'up').length, downCount = indices.filter(index => index.trend === 'down').length;
    const highVolatility = indices.some(index => index.atrRatio >= policy.highAtrRatio);
    // Index direction is retained as observation evidence only. It cannot change
    // entry permission, breakout permission or risk sizing for any strategy.
    const status = broad.advanceRatio <= policy.weakAdvanceRatio ? 'weak'
      : broad.advanceRatio >= policy.strongAdvanceRatio ? 'strong' : 'neutral';
    const riskMultiplier = status === 'weak' ? 0 : status === 'strong' && !highVolatility ? 1 : 0.5;
    const breadthReason = status === 'weak' ? `不高于 ${(policy.weakAdvanceRatio * 100).toFixed(0)}%，市场广度偏弱`
      : status === 'strong' ? `达到 ${(policy.strongAdvanceRatio * 100).toFixed(0)}%，市场广度偏强`
        : `介于 ${(policy.weakAdvanceRatio * 100).toFixed(0)}% 与 ${(policy.strongAdvanceRatio * 100).toFixed(0)}% 之间，市场广度中性`;
    const reasons = [`有效报价上涨占比 ${(broad.advanceRatio * 100).toFixed(1)}%，${breadthReason}`,
      `三个指数中 ${upCount} 个中期向上、${downCount} 个中期向下；指数中期趋势仅供观察，不参与本次交易限制`,
      highVolatility ? '指数 ATR/收盘价达到高波动阈值，计划风险最多减半，暂停突破入场' : '指数波动未达到高波动阈值',
      riskMultiplier === 0 ? '暂停新开仓，已有持仓退出继续执行' : riskMultiplier === 0.5 ? '新开仓采用一半计划风险预算' : '新开仓采用正常计划风险预算，允许检查突破条件'];
    const quoteTime = Math.min(...indices.map(index => index.quoteTime), broad.oldestQuote);
    return { version: 1, policyVersion: policy.version, status, label: labels[status], riskMultiplier, allowEntry: riskMultiplier > 0,
      allowBreakout: status === 'strong' && riskMultiplier === 1, checkedAt: at,
      expiresAt: Math.min(...indices.map(index => index.quoteTime + policy.quoteMaxAgeMs), broad.oldestQuote + policy.breadthMaxAgeMs, broad.fetchedAt + policy.breadthMaxAgeMs),
      date: cnTime(at).date, reason: reasons.join('；'), reasons, metrics: { indices, breadth: broad, upCount, downCount, highVolatility },
      evidence: { quoteTime, indexQuoteTimes: Object.fromEntries(indices.map(index => [index.symbol, index.quoteTime])), breadthQuoteTime: broad.oldestQuote, breadthFetchedAt: broad.fetchedAt }, policyNote: policy.note };
  } catch (error) { return unknownMarketRegime(error.message, at); }
}

module.exports = { INDEX_SYMBOLS, MARKET_REGIME_POLICY, unknownMarketRegime, validateMarketRegimeSnapshot, evaluateMarketRegime, preparedIndexHistory };
