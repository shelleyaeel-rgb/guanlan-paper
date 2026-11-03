// Real desktop, preload, IPC and account; search and market providers are isolated.
'use strict';
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
require('./market-board-desktop.cjs');
const { StockSearch } = require('../../core/stock-search.cjs');
const scenario = () => JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
const record = (kind, data = {}) => fs.appendFileSync(process.env.GUANLAN_TEST_SOURCE_LOG, JSON.stringify({ kind, ...data }) + '\n');
const stocks = [
  { symbol: 'sh600519', code: '600519', name: '贵州茅台', pinyin: 'GZMT' },
  { symbol: 'sz000001', code: '000001', name: '平安银行', pinyin: 'PAYH' },
  { symbol: 'sh600036', code: '600036', name: '招商银行', pinyin: 'ZSYH' },
  { symbol: 'sh600000', code: '600000', name: '浦发银行', pinyin: 'PFYH' },
  { symbol: 'sz000002', code: '000002', name: '万科A', pinyin: 'WKA' }
];
StockSearch.prototype.search = async function({ query }) {
  const control = scenario(), normalized = String(query || '').trim().normalize('NFKC');
  record('search-start', { query: normalized });
  if (control.searchDelays?.[normalized]) await delay(control.searchDelays[normalized]);
  if (control.searchFailures?.includes(normalized)) {
    record('search-failed', { query: normalized }); throw Error('隔离证券搜索暂时不可用');
  }
  const term = normalized.toUpperCase();
  const items = term ? stocks.filter(stock => [stock.symbol, stock.code, stock.name, stock.pinyin].some(value => value.toUpperCase().includes(term))) : [];
  record('search-complete', { query: normalized, symbols: items.map(item => item.symbol) });
  return { query: normalized, items, source: '隔离证券搜索', fetchedAt: Date.now(), hasMore: false, cached: false };
};
