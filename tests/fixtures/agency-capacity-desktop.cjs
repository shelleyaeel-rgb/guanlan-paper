// Capacity UI keeps production engine, IPC and persistence; only providers and
// screening outcomes are deterministic. The parent fixture blocks all network.
'use strict';
require('./agency-pool-desktop.cjs');
const { Market } = require('../../core/market.cjs');
Market.prototype.fetchIndexHistory = async function(symbol, signal) {
  const result = await this.strategyHistory(symbol, signal);
  return { symbol, bars: (Array.isArray(result) ? result : result.bars).slice(-121),
    source: '隔离候选容量指数日线', provider: 'fixture', fetchedAt: Date.now(), adjustment: '未复权' };
};
