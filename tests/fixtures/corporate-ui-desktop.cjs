// Company-action UI checks use a fresh account and never open external browsers.
const fs = require('node:fs');
const { shell } = require('electron');
if (!process.env.GUANLAN_TEST_EXTERNAL_LOG || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Corporate UI tests require isolated paths');
shell.openExternal = async url => { fs.appendFileSync(process.env.GUANLAN_TEST_EXTERNAL_LOG, JSON.stringify({ url }) + '\n'); };
require('./agency-desktop.cjs');
const { CorporateSource } = require('../../core/corporate-source.cjs');
const { Market } = require('../../core/market.cjs');
const control = () => JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
CorporateSource.prototype.get = async function(input) {
  const scenario = control(), symbol = input.symbol, mode = scenario.corporateMode || 'empty';
  const notices = mode === 'empty' ? [] : [{ id: 'AN202609281234567890', title: '隔离样本2026年度现金分红实施公告', date: '2026-09-28', symbol, corporateStage: mode === 'planned' ? 'planned' : 'implemented' }];
  const events = ['cash', 'invalid', 'planned'].includes(mode) ? [{ symbol, eventId: 'fixture-cash-sep29', noticeIds: ['AN202609281234567890'],
    sourceUrl: `https://data.eastmoney.com/notices/detail/${symbol.slice(2)}/AN202609281234567890.html`, status: mode === 'planned' ? 'planned' : 'implemented',
    recordDate: '2026-09-29', exDate: '2026-09-30', payDate: mode === 'invalid' ? null : '2026-10-08', listingDate: null,
    cashPerShare: 0.1, bonusPerShare: 0, transferPerShare: 0, taxPolicy: 'cn-individual-deferred-v1' }] : [];
  return { symbol, source: '隔离公司行为样本', status: mode === 'offline' ? 'unavailable' : 'ready', fetchedAt: Date.now(),
    coverageStart: input.fromDate, coverageEnd: scenario.now.slice(0, 10), coverageComplete: mode !== 'offline', events, notices,
    ...(mode === 'offline' ? { error: scenario.corporateError || '测试实施来源暂不可用，公告仍已找到' } : {}) };
};
const quotes = Market.prototype.quotes, history = Market.prototype.strategyHistory;
Market.prototype.quotes = async function(symbols) {
  const result = await quotes.call(this, symbols), scenario = control();
  if (scenario.referencePrice != null) for (const quote of Object.values(result)) quote.prevClose = scenario.referencePrice;
  return result;
};
Market.prototype.strategyHistory = async function(...args) {
  const result = await history.apply(this, args), scenario = control();
  if (!scenario.postDividendDaily) return result;
  const bars = Array.isArray(result) ? result : result.bars;
  return [...bars, { ...bars.at(-1), date: '2026-09-30', open: 10.06, high: 10.12, low: 9.98, close: 10.06 }];
};
