// Deterministic market evidence only; main IPC, service, permission validation and
// renderer remain production code. All other network access is blocked upstream.
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { FreeScreenerSource } = require('../../core/screener-sources.cjs');
if (!process.env.GUANLAN_TEST_CONTROL || !process.env.GUANLAN_TEST_MARKET_LOG
  || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Market retry fixture requires isolated paths');
const scenario = () => JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
const bars = Array.from({ length: 70 }, (_, index) => {
  const close = 100 + index * 0.2;
  return { date: new Date(Date.parse('2026-09-28T00:00:00Z') - (69 - index) * 86400000).toISOString().slice(0, 10),
    open: close, close, high: close + 0.2, low: close - 0.2, volume: 10000 };
});
FreeScreenerSource.prototype.loadBreadth = FreeScreenerSource.prototype.load = async function({ signal, onProgress = () => {}, force = false } = {}) {
  fs.appendFileSync(process.env.GUANLAN_TEST_MARKET_LOG, JSON.stringify({ force, time: Date.now(), mode: scenario().marketMode }) + '\n');
  onProgress({ stage: 'universe', completed: 0, total: 2 });
  await delay(80, undefined, { signal });
  onProgress({ stage: 'universe', completed: 2, total: 2 });
  const fallback = scenario().marketMode === 'ready';
  onProgress({ stage: 'screen-quotes', completed: 300, total: 1200,
    provider: fallback ? 'sina' : 'tencent', providerLabel: fallback ? '新浪财经' : '腾讯财经',
    fallbackReason: fallback ? '测试主来源临时不可用' : '' });
  while (scenario().marketHold) await delay(30, undefined, { signal });
  if (scenario().marketMode === 'offline') throw Error('选股行情获取超时，未使用不完整股票池');
  const now = Date.now(), rows = Array.from({ length: 1200 }, (_, index) => ({
    symbol: index < 1000 ? `sh${600000 + index}` : `sz${String(index - 1000).padStart(6, '0')}`,
    price: 10, changePct: index < 780 ? 1 : -1, timestamp: now, date: scenario().now.slice(0, 10)
  }));
  onProgress({ stage: 'screen-quotes', completed: rows.length, total: rows.length });
  return { rows, source: fallback ? '新浪财经（隔离备用样本）' : '隔离市场环境测试', sourceCount: 1200, excludedCount: 0, startedAt: now - 1000, fetchedAt: now };
};
require('./corporate-ui-desktop.cjs');
const { Market } = require('../../core/market.cjs');
Market.prototype.indexHistory = async symbol => ({ symbol, bars, source: '隔离指数完整日线', fetchedAt: Date.now(), adjustment: '未复权' });
const originalQuotes = Market.prototype.quotes;
Market.prototype.quotes = async function(symbols) {
  const result = await originalQuotes.call(this, symbols);
  for (const symbol of ['sh000001', 'sz399001', 'sz399006']) if (result[symbol]) {
    result[symbol].price = bars.at(-1).close; result[symbol].prevClose = bars.at(-1).close;
  }
  return result;
};
