// Deterministic market/research responses; real indicators, IPC, engine and isolated persistence.
// This entry point is excluded from the packaged application.
const fs = require('node:fs');
const controlPath = process.env.GUANLAN_TEST_CONTROL;
if (!controlPath || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('An isolated test account and control file are required');
const RealDate = Date;
const scenario = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'));
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [scenario().now])); }
  static now() { return new RealDate(scenario().now).getTime(); }
};
const { Market } = require('../../core/market.cjs');
const { Research } = require('../../core/research.cjs');
const { Screener } = require('../../core/screener.cjs');
const samples = require('./research-data.cjs');
const dates = [], cursor = new RealDate('2026-09-28T00:00:00Z');
while (dates.length < 220) { if (![0, 6].includes(cursor.getUTCDay())) dates.unshift(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() - 1); }
const lastTen = [10.10, 10.08, 10.03, 9.99, 10.00, 10.08, 10.04, 10.07, 10.10, 10.16];
const bars = dates.map((date, i) => {
  let close = i < 200 ? 9.9 + i * 0.00045 : 10 + Math.sin((i - 200) * 0.5) * 0.15 + (i - 200) * 0.002;
  if (i >= 210) close = lastTen[i - 210];
  close = Math.round(close * 100) / 100;
  return { date, open: close - 0.01, close, high: i === 170 ? 14.3 : i === 217 ? 11.3 : close + 0.08, low: close - 0.08, volume: i === 219 ? 150000 : 100000 };
});
Market.prototype.quotes = async function(symbols) {
  const control = scenario(), price = control.price, date = control.now.slice(0, 10);
  return Object.fromEntries(symbols.map(symbol => [symbol, control.includeLimitDownCase && symbol === 'sh688578' ? {
    symbol, name: '艾力斯 · 隔离回归案例', source: '隔离测试行情', price: 89.26, prevClose: 111.58, open: 92.83,
    low: 89.26, high: 94.97, volume: 580000, amount: 5.18e8, turnover: 1.29, bid: 0, bidSize: 0, ask: 89.26, askSize: 3000000,
    limitUp: 133.9, limitDown: 89.26, timestamp: Date.now(), date, time: '10:36:32', change: -22.32, changePct: -20
  } : { symbol, name: '隔离策略测试', source: '隔离测试行情', price, open: 10.1, prevClose: 10.16,
    low: Math.min(price, 10), high: Math.max(price, 10.2), volume: 100000, amount: 3e8, turnover: 4,
    bid: Math.round((price - 0.01) * 100) / 100, ask: price, bidSize: control.bidSize ?? 10000, askSize: 10000,
    limitUp: 11.18, limitDown: 9.14, timestamp: Date.now(), date, time: '10:00:00', change: price - 10.16, changePct: (price / 10.16 - 1) * 100 }]));
};
Market.prototype.strategyHistory = async () => {
  if (scenario().dailyMode === 'offline') throw Error('测试日线断线');
  return bars;
};
Market.prototype.history = async () => ({ bars, fetchedAt: Date.now(), adjustment: '隔离测试数据' });
Market.prototype.intraday = async () => ({ date: scenario().now.slice(0, 10), points: [{ time: '0930', price: 10.1, volume: 100 }, { time: '1000', price: scenario().price, volume: 10000 }] });
Research.prototype.request = async function(rawUrl) {
  const control = scenario(), url = new URL(rawUrl), report = url.searchParams.get('reportName');
  const section = report?.includes('BASICINFO') ? 'profile' : report?.includes('FINANCE') ? 'finance' : url.pathname.includes('/ann') ? 'notices' : 'valuation';
  const code = (url.searchParams.get('filter') || '').match(/(\d{6})\.(SH|SZ)/);
  const stock = code ? code[2].toLowerCase() + code[1] : url.searchParams.get('stock_list') || url.searchParams.get('secids').split('.')[1];
  const symbol = /^(sh|sz)/.test(stock) ? stock : (/^6/.test(stock) ? 'sh' : 'sz') + stock;
  if (section === 'finance' && control.financeMode === 'offline') throw Error('测试财务接口断线');
  if (section === 'valuation' && control.valuationMode === 'offline') throw Error('测试估值接口断线');
  if (section === 'notices' && control.noticeMode === 'offline') throw Error('测试公告接口断线');
  const result = samples[section](symbol);
  if (section === 'notices' && control.noticeMode === 'event') {
    result.data.list[0].notice_date = control.now.slice(0, 10) + ' 00:00:00';
    result.data.list[0].title = '关于伏美替尼用于 EGFR 20 外显子插入突变 NSCLC 一线治疗的关键性临床试验进展的公告';
  }
  if (section === 'finance') for (const row of result.result.data) {
    row.TOTALOPERATEREVETZ = 12; row.PARENTNETPROFITTZ = 8; row.KCFJCXSYJLRTZ = 7;
  }
  if (section === 'valuation') {
    result.data.diff[0].f9 = 15;
    result.data.diff[0].f124 = Date.now() / 1000;
  }
  return result;
};
Screener.prototype.page = async function(page) {
  const codes = ['600519', '000001', '300750', '688001'];
  if (scenario().includeLimitDownCase) codes.push('688578');
  return { total: codes.length, diff: page > 1 ? [] : codes.map(code => ({
    f12: code, f13: /^6/.test(code) ? 1 : 0, f14: code === '688578' ? '艾力斯 · 隔离回归案例' : `隔离策略测试${code}`, f2: code === '688578' ? 89.26 : scenario().price,
    f3: code === '688578' ? -20 : 0.1, f5: 100000, f6: 3e8, f7: 3, f8: 4, f9: 15, f10: 1.5, f20: 100e8, f21: 80e8, f23: 2, f124: Date.now() / 1000
  })) };
};
require('../../main.cjs');
