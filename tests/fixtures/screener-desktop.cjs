// Test-only market pages; the account and clock are isolated by strategy-desktop.
const fs = require('node:fs');
const { Screener } = require('../../core/screener.cjs');
// This legacy table fixture deliberately feeds synthetic Eastmoney-shaped pages.
// The free-provider adapter has separate request-level and real-network checks.
const fetchAll = Screener.prototype.fetchAll;
Screener.prototype.fetchAll = function(...args) { this.snapshotLoader = null; return fetchAll.apply(this, args); };
Screener.prototype.page = async function(page) {
  const scenario = JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
  if (scenario.screenFail) throw Error('测试选股接口断线');
  const codes = ['000001', '600519', '300750', '688001', ...Array.from({ length: 131 }, (_, i) => String(600001 + i))];
  return { total: codes.length, diff: codes.slice((page - 1) * 100, page * 100).map((code, n) => {
    const i = (page - 1) * 100 + n;
    const row = { f12: code, f13: /^[03]/.test(code) ? 0 : 1, f14: i === 4 ? '*ST测试' : `测试股票${i}`, f2: 10 + i % 20, f3: i % 10 - 3, f5: 20000, f6: 1e8, f7: 5, f8: 3 + i % 8, f9: i % 4 ? 15 : -2, f10: 1.8, f20: 100e8, f21: 80e8, f23: 1.2, f124: Date.now() / 1000 };
    if (scenario.screenMode === 'preopen') { row.f2 = '-'; row.f124 = 0; row.f9 = [12, 39.99, 40, 50, '-'][i % 5]; }
    if (scenario.screenMode === 'missing-pe') row.f9 = '-';
    if (scenario.screenMode === 'high-pe') row.f9 = 50;
    return row;
  }) };
};
require('./strategy-desktop.cjs');
