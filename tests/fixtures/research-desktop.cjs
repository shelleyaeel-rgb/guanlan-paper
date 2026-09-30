const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { Research } = require('../../core/research.cjs');
const { Market } = require('../../core/market.cjs');
const sample = require('./research-data.cjs');
Research.prototype.request = async function(rawUrl) {
  const scenario = JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
  const url = new URL(rawUrl), report = url.searchParams.get('reportName');
  const section = report?.includes('BASICINFO') ? 'profile' : report?.includes('FINANCE') ? 'finance' : url.pathname.includes('/ann') ? 'notices' : 'valuation';
  const code = (url.searchParams.get('filter') || '').match(/(\d{6})\.(SH|SZ)/);
  const stock = code ? code[2].toLowerCase() + code[1] : url.searchParams.get('stock_list') || url.searchParams.get('secids').split('.')[1];
  const symbol = /^(sh|sz)/.test(stock) ? stock : (/^6/.test(stock) ? 'sh' : 'sz') + stock;
  if (scenario.slowSymbol === symbol) await delay(900);
  if (scenario.failSections?.includes(section)) throw Error('测试资料接口断线');
  if (section === 'notices' && scenario.emptyNotices) return { success: 1, data: { list: [], total_hits: 0 } };
  const data = sample[section](symbol);
  if (section === 'profile') data.result.data[0].MAIN_BUSINESS = '测试业务 <img src=x onerror="window.researchXss=true">';
  if (section === 'finance' && scenario.missingFinance) { data.result.data[0].ROEJQ = null; data.result.data[0].NETCASH_OPERATE_PK = '-'; }
  return data;
};
require('./screener-desktop.cjs');
const quoteBefore = Market.prototype.quotes;
Market.prototype.quotes = async function(symbols) {
  const scenario = JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
  if (scenario.quoteFail && symbols.length === 1) throw Error('测试行情断线');
  return quoteBefore.call(this, symbols);
};
