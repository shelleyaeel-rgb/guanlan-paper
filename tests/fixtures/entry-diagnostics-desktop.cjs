// Real indicators, monitor, agency rules, IPC and persistence; only source data
// are controlled. The inherited fixture rejects every unexpected HTTP request.
const fs = require('node:fs');
const { shell } = require('electron');
if (!process.env.GUANLAN_TEST_CONTROL || !process.env.GUANLAN_TEST_NETWORK_LOG
  || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Entry diagnostics require isolated control, network log and account paths');
shell.openExternal = async () => { throw Error('External navigation is disabled in entry diagnostics'); };
require('./agency-desktop.cjs');
const { Market } = require('../../core/market.cjs');
const { CorporateSource } = require('../../core/corporate-source.cjs');
const control = () => JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
const trendSymbol = 'sh600519', dailySymbol = 'sz001395';
const history = Market.prototype.strategyHistory, quotes = Market.prototype.quotes;
Market.prototype.strategyHistory = async function(symbol, ...args) {
  const result = await history.call(this, symbol, ...args);
  const bars = Array.isArray(result) ? result : result.bars;
  if (symbol === trendSymbol) return bars.map((bar, index) => {
    const close = index < bars.length - 20 ? 20 : 10;
    return { ...bar, open: close, close, high: close + 0.1, low: close - 0.1 };
  });
  if (symbol === dailySymbol && control().historyMode === 'short') return bars.slice(-23);
  return result;
};
Market.prototype.quotes = async function(symbols) {
  const result = await quotes.call(this, symbols);
  for (const [symbol, quote] of Object.entries(result)) {
    if (![trendSymbol, dailySymbol].includes(symbol)) continue;
    const price = symbol === trendSymbol ? 10.05 : 11, prevClose = symbol === trendSymbol ? 10 : 10.16;
    Object.assign(quote, { name: symbol === trendSymbol ? '趋势诊断隔离样本' : '日线诊断隔离样本', price, prevClose,
      open: prevClose, high: price + 0.01, low: prevClose - 0.05, bid: price - 0.01, ask: price,
      limitUp: Math.round(prevClose * 110) / 100, limitDown: Math.round(prevClose * 90) / 100,
      change: price - prevClose, changePct: (price / prevClose - 1) * 100 });
  }
  return result;
};
CorporateSource.prototype.get = async function({ symbol, fromDate }) {
  const scenario = control(), failed = symbol === dailySymbol && scenario.corporateMode === 'offline';
  return { symbol, source: '隔离公司行为样本', status: failed ? 'unavailable' : 'ready', fetchedAt: Date.now(),
    coverageStart: fromDate, coverageEnd: scenario.now.slice(0, 10), coverageComplete: !failed, events: [], notices: [],
    ...(failed ? { error: '隔离公司行为来源暂不可用' } : {}) };
};
