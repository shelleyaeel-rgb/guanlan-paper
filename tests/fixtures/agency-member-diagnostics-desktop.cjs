// Real Electron IPC and account persistence, with a fake scanner and sources.
// This entry point requires isolated paths and blocks every external request.
const fs = require('node:fs');
const { shell } = require('electron');
if (!process.env.GUANLAN_TEST_CONTROL || !process.env.GUANLAN_TEST_NETWORK_LOG
  || !process.env.GUANLAN_TEST_EVIDENCE_LOG || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) {
  throw Error('Member diagnostics require isolated control, network/evidence logs and account paths');
}
shell.openExternal = async () => { throw Error('External navigation is disabled in member diagnostics'); };
require('./agency-pool-desktop.cjs');
const { Market } = require('../../core/market.cjs');
const { CorporateSource } = require('../../core/corporate-source.cjs');
const { CompanyEvidenceSource } = require('../../core/company-evidence-source.cjs');
const control = () => JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
const symbol = 'sh600003', history = Market.prototype.strategyHistory;
Market.prototype.strategyHistory = async function(current, ...args) {
  const result = await history.call(this, current, ...args);
  if (current === symbol && control().historyMode === 'short') return (Array.isArray(result) ? result : result.bars).slice(-23);
  return result;
};
CorporateSource.prototype.get = async function({ symbol: current, fromDate }) {
  const scenario = control(), failed = current === symbol && scenario.corporateMode === 'offline';
  return { symbol: current, source: '隔离公司行为样本', status: failed ? 'unavailable' : 'ready', fetchedAt: Date.now(),
    coverageStart: fromDate, coverageEnd: scenario.now.slice(0, 10), coverageComplete: !failed, events: [], notices: [],
    ...(failed ? { error: '隔离公司行为来源暂不可用' } : {}) };
};
CompanyEvidenceSource.prototype.get = async function(current) {
  fs.appendFileSync(process.env.GUANLAN_TEST_EVIDENCE_LOG, JSON.stringify({ symbol: current }) + '\n');
  return { symbol: current, status: 'unavailable', checkedAt: Date.now(), documents: [], errors: ['隔离公开研究资料尚未取得'] };
};
