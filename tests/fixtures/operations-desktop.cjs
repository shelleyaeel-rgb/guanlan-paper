'use strict';
const fs = require('node:fs');
const { net, ipcMain } = require('electron');
if (!process.env.GUANLAN_TEST_CONTROL || !process.env.GUANLAN_OPERATION_LOG || !process.argv.some(a => a.startsWith('--test-data-dir='))) throw Error('Only isolated operation test accounts are supported');
const control = () => JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [control().now])); }
  static now() { return new RealDate(control().now).getTime(); }
};
net.fetch = async () => { throw Error('Isolated fixture: network disabled'); };
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  if (!['trade', 'order', 'strategy:buy', 'agency:transfer'].includes(channel)) return listener(...args);
  fs.appendFileSync(process.env.GUANLAN_OPERATION_LOG, JSON.stringify({ channel, payload: args[1] }) + '\n');
  const mode = control().operationMode;
  if (mode === 'before') throw Error('Isolated fixture: request not delivered');
  const result = await listener(...args);
  if (mode === 'after') throw Error('Isolated fixture: committed reply lost');
  return result;
});
const { Market } = require('../../core/market.cjs');
Market.prototype.quotes = async symbols => Object.fromEntries(symbols.map(symbol => [symbol, { symbol, name: '隔离操作测试', price: 10, open: 10, prevClose: 10,
  volume: 100000, bid: 9.99, ask: 10.01, bidSize: 10000, askSize: 10000, limitUp: 11, limitDown: 9,
  date: control().now.slice(0, 10), timestamp: Date.now(), source: '隔离测试行情' }]));
const bars = [], day = new RealDate('2026-10-15T00:00:00Z');
while (bars.length < 90) {
  if (![0, 6].includes(day.getUTCDay())) bars.unshift({ date: day.toISOString().slice(0, 10), open: 10, high: 10.1, low: 9.9, close: 10, volume: 100000 });
  day.setUTCDate(day.getUTCDate() - 1);
}
Market.prototype.history = async () => ({ bars, fetchedAt: Date.now(), adjustment: '隔离数据' });
Market.prototype.intraday = async () => ({ date: control().now.slice(0, 10), points: [] });
const { StrategyMonitor } = require('../../core/strategy-monitor.cjs');
StrategyMonitor.prototype.load = async () => null;
StrategyMonitor.prototype.scan = async () => {};
const { MarketRegimeService } = require('../../core/market-regime-service.cjs');
MarketRegimeService.prototype.poll = async () => {};
const { NoticeMonitor } = require('../../core/notice-monitor.cjs');
NoticeMonitor.prototype.poll = async () => {};
const { CorporateSource } = require('../../core/corporate-source.cjs');
CorporateSource.prototype.get = async ({ symbol, fromDate }) => ({ symbol, status: 'ready', fetchedAt: Date.now(), coverageStart: fromDate,
  coverageEnd: control().now.slice(0, 10), coverageComplete: true, events: [], notices: [] });
require('../../main.cjs');
