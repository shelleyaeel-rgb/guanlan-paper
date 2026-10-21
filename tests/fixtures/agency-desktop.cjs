// Real Electron IPC, fixed rules and account persistence. Market/research data
// are isolated fixtures; every unexpected HTTP request is rejected and logged.
const fs = require('node:fs');
const { net } = require('electron');
const controlPath = process.env.GUANLAN_TEST_CONTROL;
if (!controlPath || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Agency UI tests require isolated control and account paths');
const control = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'));
const { CorporateSource } = require('../../core/corporate-source.cjs');
CorporateSource.prototype.get = async function({ symbol, fromDate }) {
  const scenario = control(), today = scenario.now.slice(0, 10);
  const notices = scenario.companyAction ? [{ id: 'AN202609301234567890', title: '隔离样本：权益分派实施资料待补齐',
    date: today, corporateStage: 'unsupported', url: `https://data.eastmoney.com/notices/detail/${symbol.slice(2)}/AN202609301234567890.html` }] : [];
  return { symbol, source: '隔离公司行为样本', status: 'ready', fetchedAt: Date.now(),
    coverageStart: fromDate, coverageEnd: today, coverageComplete: true, events: [], notices };
};
net.fetch = async (url) => {
  if (process.env.GUANLAN_TEST_NETWORK_LOG) fs.appendFileSync(process.env.GUANLAN_TEST_NETWORK_LOG, JSON.stringify({ url: String(url) }) + '\n');
  throw Error('The isolated fixture blocks all unexpected network requests');
};
require('./strategy-modes-desktop.cjs');
// On the next trading day expose the newly completed bar, so normal next-day
// exits do not intentionally simulate an unverified offline corporate event.
const { Market } = require('../../core/market.cjs');
const strategyHistory = Market.prototype.strategyHistory;
Market.prototype.strategyHistory = async function(...args) {
  const result = await strategyHistory.apply(this, args), scenario = control();
  if (!scenario.advanceDaily || scenario.now.slice(0, 10) < '2026-09-30') return result;
  const bars = Array.isArray(result) ? result : result.bars;
  return [...bars, { ...bars.at(-1), date: '2026-09-29' }];
};
const { Research } = require('../../core/research.cjs');
const researchRequest = Research.prototype.request;
Research.prototype.request = async function(url) {
  const response = await researchRequest.call(this, url);
  if (control().companyAction && String(url).includes('/ann') && response.data?.list?.length) {
    response.data.list[0].notice_date = control().now.slice(0, 10) + ' 00:00:00';
    response.data.list[0].title = '关于年度权益分派实施及除权除息的公告';
  }
  return response;
};
