// Isolated deterministic statements. The production monitor, financial gates,
// renderer, IPC and persistence run; unexpected network requests are blocked.
const fs = require('node:fs');
const controlPath = process.env.GUANLAN_TEST_CONTROL;
if (!controlPath || !process.env.GUANLAN_TEST_NETWORK_LOG || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Financial UI test requires isolated control/account paths');
require('./agency-desktop.cjs');
const { Market } = require('../../core/market.cjs');
const { calendarSession } = require('../../core/trading-calendar.cjs');
const originalStrategyHistory = Market.prototype.strategyHistory;
Market.prototype.strategyHistory = async function(...args) {
  const source = await originalStrategyHistory.apply(this, args), bars = [...(Array.isArray(source) ? source : source.bars)];
  for (let cursor = new Date('2026-09-29T02:00:00Z'); cursor <= new Date('2026-10-14T02:00:00Z'); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (calendarSession(cursor).open) bars.push({ ...bars.at(-1), date: cursor.toISOString().slice(0, 10) });
  }
  return bars;
};
Market.prototype.history = async function() { return { bars: await this.strategyHistory(), fetchedAt: Date.now(), adjustment: '隔离测试数据' }; };
const { Research } = require('../../core/research.cjs'), originalGet = Research.prototype.get;
const scenario = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'));
function reports(symbol) {
  const control = scenario(), at = Date.parse(control.now), mode = control.financeScenario || 'pass';
  const annual = year => ({ reportDate: `${year}-12-31`, noticeDate: `${year + 1}-03-20`, updateDate: `${year + 1}-03-20`, currency: 'CNY',
    revenue: 8e8, profit: 2e8, adjustedProfit: 2e8, roe: year === 2025 && mode === 'low-annual' ? 6 : 12, debtRatio: 40,
    revenueYoY: 10, profitYoY: 15, adjustedProfitYoY: 15, operatingCash: 3e8 });
  const latest = { reportDate: '2026-06-30', noticeDate: '2026-08-15', updateDate: '2026-08-20', currency: mode === 'foreign-currency' ? 'USD' : 'CNY',
    revenue: 5e8, profit: 1e8, adjustedProfit: mode === 'loss' ? -1e8 : 1e8, roe: 4, debtRatio: 40,
    revenueYoY: 10, profitYoY: 8, adjustedProfitYoY: mode === 'loss' ? 20 : 8, operatingCash: mode === 'cash-missing' ? null : 2e8 };
  return { symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: at,
    data: { latest: mode === 'old' ? annual(2025) : latest, annual: mode === 'annual-missing' ? [] : [annual(2025), annual(2024), annual(2023)] } };
}
Research.prototype.get = async function(input) {
  const control = scenario(), symbol = input.symbol, at = Date.parse(control.now);
  if (input.section === 'finance') return reports(symbol);
  if (input.section === 'notices') {
    const pendingQuarter = control.financeScenario === 'sync' || control.screenFinancePending && symbol === 'sh600010';
    const items = pendingQuarter ? [{ id: 'AN20261014000001', date: '2026-10-14', title: '2026年第三季度报告', categories: ['三季报'] }] : [];
    return { symbol, section: 'notices', status: items.length ? 'ready' : 'empty', source: '东方财富', fetchedAt: at, data: { items, total: items.length } };
  }
  return originalGet.call(this, input);
};
const { FreeScreenerSource } = require('../../core/screener-sources.cjs');
FreeScreenerSource.prototype.load = async function() {
  const rows = [{ symbol: 'sh600519', name: '隔离分期财务', board: 'sh', isST: false, price: 10.17, pe: 15, pb: 2,
    timestamp: Date.now(), changePct: 0.1, turnover: 4, amount: 3 }];
  if (scenario().screenFinancePending) rows.push({ ...rows[0], symbol: 'sh600010', name: '待同步样本 <财务>' });
  return { rows, source: '隔离财务UI行情', sourceCount: rows.length, excludedCount: 0, startedAt: Date.now(), fetchedAt: Date.now() };
};
