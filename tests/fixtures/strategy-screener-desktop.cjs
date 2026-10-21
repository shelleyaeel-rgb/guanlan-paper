// Deterministic strategy screening, real IPC and isolated accounts. Not packaged.
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { Research } = require('../../core/research.cjs');
const samples = require('./research-data.cjs');
Research.prototype.request = async function(rawUrl) {
  const scenario = JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
  const url = new URL(rawUrl), report = url.searchParams.get('reportName');
  const section = report?.includes('BASICINFO') ? 'profile' : report?.includes('FINANCE') ? 'finance' : url.pathname.includes('/ann') ? 'notices' : 'valuation';
  const code = (url.searchParams.get('filter') || '').match(/(\d{6})\.(SH|SZ)/);
  const stock = code ? code[2].toLowerCase() + code[1] : url.searchParams.get('stock_list') || url.searchParams.get('secids').split('.')[1];
  const symbol = /^(sh|sz)/.test(stock) ? stock : (/^6/.test(stock) ? 'sh' : 'sz') + stock;
  if (section === 'finance' && scenario.financeMode === 'slow') await delay(150);
  if (section === 'finance' && scenario.financeMode === 'offline') throw Error('测试财务接口断线');
  const result = samples[section](symbol);
  if (section === 'finance') {
    for (const row of result.result.data) {
      row.TOTALOPERATEREVETZ = 12;
      row.PARENTNETPROFITTZ = 8;
      row.KCFJCXSYJLRTZ = 7;
    }
    if (scenario.financeMode === 'partial' && symbol === 'sh600002') result.result.data[0].ROEJQ = null;
    if (scenario.financeMode === 'partial' && symbol === 'sh600003') throw Error('测试单只财务断线');
  }
  return result;
};
require('./screener-technical-desktop.cjs');
