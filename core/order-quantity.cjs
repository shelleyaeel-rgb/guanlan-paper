'use strict';

// SSE trading rules effective 2026-07-06: STAR continuous-auction orders are
// capped at 100,000 shares for limit orders and 50,000 for market orders.
// https://www.sse.com.cn/lawandrules/sselawsrules2025/fund/trading/c/c_20260424_10817739.shtml
// This simulator does not implement after-hours fixed-price orders.
function maxOrderQuantity(symbol, limitOrder = false) {
  return symbol.startsWith('sh688') ? (limitOrder ? 100000 : 50000) : 1000000;
}

module.exports = { maxOrderQuantity };
