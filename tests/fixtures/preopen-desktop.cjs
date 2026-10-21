// Real Electron services, IPC and renderer with an isolated clock/data source.
// Only provider responses are replaced; all unanticipated network is blocked.
'use strict';
const fs = require('node:fs');
const { app, ipcMain, session } = require('electron');
if (!process.env.GUANLAN_TEST_CONTROL || !process.env.GUANLAN_TEST_SOURCE_LOG
  || !process.env.GUANLAN_TEST_NETWORK_LOG || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) {
  throw Error('Pre-open UI fixture requires isolated account, control and log paths');
}
const scenario = () => JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
const record = (type, details = {}) => fs.appendFileSync(process.env.GUANLAN_TEST_SOURCE_LOG,
  JSON.stringify({ type, now: scenario().now, ...details }) + '\n');
const blocked = url => {
  fs.appendFileSync(process.env.GUANLAN_TEST_NETWORK_LOG, JSON.stringify({ url: String(url) }) + '\n');
  throw Error('Pre-open isolated fixture blocks all unexpected network requests');
};
global.fetch = async url => blocked(url);
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  transport.request = transport.get = url => blocked(url);
}
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
  const external = /^(https?|wss?):/i.test(details.url);
  if (external) fs.appendFileSync(process.env.GUANLAN_TEST_NETWORK_LOG, JSON.stringify({ url: details.url }) + '\n');
  callback({ cancel: external });
}));
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, listener) => handle(name, (event, ...args) => {
  if (name !== 'state') record('ipc', { name });
  return listener(event, ...args);
});

require('./corporate-ui-desktop.cjs');
const { Market } = require('../../core/market.cjs');
const { FreeScreenerSource } = require('../../core/screener-sources.cjs');
const originalHistory = Market.prototype.strategyHistory;
Market.prototype.strategyHistory = async function(symbol, signal, unadjusted, force = false) {
  record('strategy-history', { symbol, force, mode: scenario().historyMode });
  if (scenario().historyMode === 'offline') throw Error('行情日线 HTTP 501');
  const result = await originalHistory.call(this, symbol, signal, unadjusted, force);
  return { bars: Array.isArray(result) ? result : result.bars, source: '隔离盘前完整日线', provider: 'fixture', fetchedAt: Date.now() };
};
const indexBars = Array.from({ length: 70 }, (_, index) => {
  const close = 100 + index * 0.2;
  return { date: new Date(Date.parse('2026-09-28T00:00:00Z') - (69 - index) * 86400000).toISOString().slice(0, 10),
    open: close, close, high: close + 0.2, low: close - 0.2, volume: 10000 };
});
Market.prototype.indexHistory = async function(symbol, signal, force = false) {
  record('index-history', { symbol, force, mode: scenario().historyMode });
  if (scenario().historyMode === 'offline') throw Error('指数日线 HTTP 501');
  return { symbol, bars: indexBars, source: '隔离指数完整日线', fetchedAt: Date.now(), adjustment: '未复权' };
};
const originalQuotes = Market.prototype.quotes;
Market.prototype.quotes = async function(symbols) {
  const result = await originalQuotes.call(this, symbols);
  const closed = scenario().now.slice(11, 16) < '09:30';
  for (const [symbol, quote] of Object.entries(result)) {
    if (['sh000001', 'sz399001', 'sz399006'].includes(symbol)) {
      quote.price = indexBars.at(-1).close; quote.prevClose = indexBars.at(-1).close;
    }
    if (closed) {
      quote.timestamp = Date.parse('2026-09-28T15:00:00+08:00');
      quote.date = '2026-09-28'; quote.time = '15:00:00';
      // Deliberate prior-session mismatch proves preparation cannot use it as
      // today's reference price or manufacture a reconciliation failure.
      quote.prevClose = quote.price * 0.9;
    } else quote.time = scenario().now.slice(11, 19);
  }
  record('quotes', { symbols, closed, timestamp: Object.values(result)[0]?.timestamp });
  return result;
};
FreeScreenerSource.prototype.loadBreadth = FreeScreenerSource.prototype.load = async function({ force = false, onProgress = () => {} } = {}) {
  record('breadth', { force });
  const now = Date.now();
  const rows = Array.from({ length: 1200 }, (_, index) => ({
    symbol: index < 1000 ? `sh${600000 + index}` : `sz${String(index - 1000).padStart(6, '0')}`,
    price: 10, changePct: index < 780 ? 1 : -1, timestamp: now, date: scenario().now.slice(0, 10)
  }));
  onProgress({ stage: 'screen-quotes', completed: rows.length, total: rows.length });
  return { rows, source: '隔离盘中市场广度', sourceCount: 1200, excludedCount: 0, startedAt: now, fetchedAt: now };
};
