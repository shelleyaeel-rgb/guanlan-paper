// Real desktop/IPC/account persistence with deterministic, isolated providers.
'use strict';
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { ipcMain } = require('electron');
const scenario = () => JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
const record = (kind, data = {}) => fs.appendFileSync(process.env.GUANLAN_TEST_SOURCE_LOG, JSON.stringify({ kind, ...data }) + '\n');
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, listener) => handle(name, (event, ...args) => {
  if (name === 'detail') record('detail-request', { input: args[0] });
  return listener(event, ...args);
});
require('./auto-only-desktop.cjs');
const { Market } = require('../../core/market.cjs');
const originalHistory = Market.prototype.history, originalQuotes = Market.prototype.quotes;
const prices = { sh600519: 1500.25, sz000001: 11.25, sh600036: 40.25 };
Market.prototype.quotes = async function(symbols) {
  const control = scenario();
  if (control.quoteDelays) await delay(Math.max(0, ...symbols.map(symbol => control.quoteDelays[symbol] || 0)));
  if (symbols.some(symbol => control.quoteFailures?.includes(symbol))) {
    record('quotes-failed', { symbols }); throw Error('隔离看盘报价获取失败');
  }
  const result = await originalQuotes.call(this, symbols);
  for (const symbol of symbols) {
    if (!prices[symbol]) continue;
    const price = prices[symbol], prevClose = price - 0.25;
    Object.assign(result[symbol], { name: `隔离看盘 ${symbol.slice(2)}`, price, prevClose, open: price - 0.1,
      high: price + 0.5, low: price - 0.5, change: 0.25, changePct: 0.25 / prevClose * 100 });
  }
  record('quotes-complete', { symbols }); return result;
};
Market.prototype.history = async function(symbol) {
  const control = scenario(); record('history-start', { symbol });
  if (control.historyDelays?.[symbol]) await delay(control.historyDelays[symbol]);
  if (control.historyFailures?.includes(symbol)) { record('history-failed', { symbol }); throw Error('隔离看盘前复权日线获取失败'); }
  const result = await originalHistory.call(this, symbol), scale = (prices[symbol] || 10.17) / 10.17;
  record('history-complete', { symbol });
  const bars = control.historyLengths?.[symbol] ? result.bars.slice(-control.historyLengths[symbol]) : result.bars;
  if (control.unfinishedHistory?.includes(symbol)) bars[bars.length - 1] = { ...bars.at(-1), date: control.now.slice(0, 10) };
  return { ...result, bars: bars.map(bar => ({ ...bar, open: bar.open * scale, close: bar.close * scale,
    high: bar.high * scale, low: bar.low * scale })), source: `隔离看盘日线 ${symbol}`, adjustment: '前复权' };
};
Market.prototype.intraday = async function(symbol) {
  if (scenario().minuteFailures?.includes(symbol)) throw Error('隔离看盘分时获取失败');
  return { source: `隔离看盘分时 ${symbol}`, date: scenario().now.slice(0, 10), fetchedAt: Date.now(),
    prevClose: prices[symbol] || 10.17, points: [{ time: '0930', price: prices[symbol] || 10.17, volume: 100 },
      { time: '1000', price: (prices[symbol] || 10.17) + 0.01, volume: 10000 }] };
};
