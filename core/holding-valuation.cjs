'use strict';
const { cnTime, money } = require('./common.cjs');

// Valuation does not require executable liquidity: a price-only closing quote
// may value a holding even when no buy/sell can currently be matched.
function holdingValuation(lots, quotes, marks, now, action) {
  const local = cnTime(now), today = local.date, at = now.getTime();
  const quoteFloor = local.minutes >= 900 ? Date.parse(`${today}T15:00:00+08:00`)
    : local.minutes >= 690 && local.minutes < 780 ? Date.parse(`${today}T11:30:00+08:00`) - 90000
      : at - 90000;
  const valuation = {};
  for (const symbol of new Set(lots.map(lot => lot.symbol))) {
    const quote = quotes[symbol] ?? marks[symbol];
    if (!quote || quote.symbol !== symbol || !Number.isFinite(quote.price) || quote.price <= 0 || money(quote.price) <= 0
      || !Number.isFinite(quote.timestamp) || quote.timestamp > at + 15000
      || quote.date !== today || cnTime(quote.timestamp).date !== today)
      throw Error(`${symbol} 缺少当日有效持仓估值，不能${action}`);
    if (quote.timestamp < quoteFloor)
      throw Error(`${symbol} 持仓估值已过期，不能${action}；盘中需 90 秒内报价，午休需上午收盘前 90 秒内或之后的报价，盘后需 15:00 或之后的收盘报价`);
    valuation[symbol] = structuredClone(quote);
  }
  return valuation;
}

module.exports = { holdingValuation };
