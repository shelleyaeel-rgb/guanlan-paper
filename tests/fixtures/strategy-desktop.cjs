// Isolated desktop test entry point. Never included in the packaged application.
const fs = require('node:fs');
const path = require('node:path');
const controlPath = process.env.GUANLAN_TEST_CONTROL;
if (!controlPath || !process.argv.some(a => a.startsWith('--test-data-dir='))) throw Error('An isolated test account and control file are required');
const RealDate = Date;
let scenario = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [scenario.now])); }
  static now() { return new RealDate(scenario.now).getTime(); }
};
const { Market } = require('../../core/market.cjs');
const dates = [], cursor = new RealDate('2026-09-28T00:00:00Z');
while (dates.length < 120) { if (![0, 6].includes(cursor.getUTCDay())) dates.unshift(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() - 1); }
const bars = dates.map((date, i) => {
  let close = i < 100 ? 9 + i * 0.01 : 10 + Math.sin((i - 100) * 0.5) * 0.15 + (i - 100) * 0.002;
  if (i === 119) close = 10.07;
  close = Math.round(close * 100) / 100;
  return { date, open: close - 0.01, close, high: i === 110 ? 11.3 : close + 0.08, low: close - 0.08, volume: 100000 };
});
Market.prototype.quotes = async function(symbols) {
  scenario = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
  const price = scenario.price, date = scenario.now.slice(0, 10);
  return Object.fromEntries(symbols.map(symbol => [symbol, { symbol, name: '隔离测试股票', price, open: 10.01, prevClose: 10.07, low: Math.min(price, 10), high: Math.max(price, 10.1),
    volume: 100000, bid: price - 0.01, ask: price, bidSize: 10000, askSize: 10000, limitUp: 11.08, limitDown: 9.06, timestamp: Date.now(), date, time: '10:00:00', change: price - 10.07, changePct: (price / 10.07 - 1) * 100 }]));
};
Market.prototype.strategyHistory = async () => bars;
Market.prototype.history = async () => ({ bars, fetchedAt: Date.now(), adjustment: '测试数据' });
Market.prototype.intraday = async () => ({ date: scenario.now.slice(0, 10), points: [{ time: '0930', price: 10.01, volume: 100 }, { time: '1000', price: scenario.price, volume: 10000 }] });
require(path.join(__dirname, '../../main.cjs'));
