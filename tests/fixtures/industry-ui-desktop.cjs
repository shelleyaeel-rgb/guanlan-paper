// Synthetic universe/disclosures; real industry evaluation, IPC and persistence.
const fs = require('node:fs');
const { ipcMain } = require('electron');
const controlPath = process.env.GUANLAN_TEST_CONTROL, callsPath = process.env.GUANLAN_TEST_INDUSTRY_CALLS;
if (!controlPath || !callsPath || !process.env.GUANLAN_TEST_NETWORK_LOG || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Industry UI requires isolated account and control files');
const control = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'));
const { evaluateCompanyEvidence } = require('../../core/company-evidence.cjs');
const { companyBundle } = require('./company-evidence-data.cjs');
const screening = require('../../core/agency-screening.cjs');
const { composeStrategyQuery } = require('../../core/strategy-presets.cjs');
const { rowDiagnostics, poolDiagnostics } = require('../../core/agency-pool-diagnostics.cjs');
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, handler) => handle(name, async (event, payload) => {
  if (['agency:pool:run', 'agency:pool:retry', 'agency:members:add', 'screener:run'].includes(name)) fs.appendFileSync(callsPath, JSON.stringify({ name, payload }) + '\n');
  return handler(event, payload);
});
function bundle(symbol, now) {
  const value = companyBundle(symbol, now);
  if (symbol === 'sh600009') for (const document of value.documents) {
    document.text = document.text.replace(/统计覆盖全部竞争者/g, '统计覆盖上市公司样本'); document.fullText = document.text;
  }
  return value;
}
screening.runAgencyScreening = async (screener, options) => {
  const now = new Date(control().now), policy = screening.poolPolicy(options.screeningMode, options.research, options.performance, options.industry);
  const rows = ['sh600009', 'sh600010'].map(symbol => {
    const evidenceReview = evaluateCompanyEvidence(bundle(symbol, now), policy.commonQuery.evidence, now);
    return { symbol, name: symbol === 'sh600009' ? '隔离行业范围待补' : '隔离行业排名已核实', evidenceReview, selectionEvidence: evidenceReview };
  });
  const strategies = Object.fromEntries(policy.priority.map(id => {
    const entries = rows.map(row => {
      const status = id !== 'swing' ? 'failed' : row.evidenceReview.status === 'fail' ? 'failed' : row.evidenceReview.status;
      const checked = { status, stage: status === 'pass' ? 'passed' : 'evidence', reasons: [id !== 'swing' ? '隔离样本只匹配波段' : row.evidenceReview.industryReview?.reason || '未附加行业限制'] };
      return { ...row, ...checked, diagnostics: rowDiagnostics(row, checked) };
    });
    return [id, { query: composeStrategyQuery(id, policy.commonQuery), ...Object.fromEntries(['pass', 'pending', 'failed'].map(status => [status, entries.filter(row => row.status === status)])) }];
  }));
  return { startedAt: +now, finishedAt: +now, screeningMode: policy.screeningMode, industry: options.industry, strategies,
    coverage: { screeningMode: policy.screeningMode, researchRequired: policy.evidenceMode === 'automatic', universeComplete: true, universeCount: 2,
      requiredMissing: [], diagnostics: poolDiagnostics(strategies), partial: true }, sources: { quotes: { source: '隔离行业 UI 行情', fetchedAt: +now } } };
};
require('./agency-desktop.cjs');
const { FreeScreenerSource } = require('../../core/screener-sources.cjs');
FreeScreenerSource.prototype.load = async function() {
  const rows = ['sh600009', 'sh600010', 'sh600011', 'sh600012'].map(symbol => ({ symbol, name: `隔离行业${symbol.slice(2)}`, board: 'sh', isST: false,
    price: 10.17, pe: 15, timestamp: Date.now(), changePct: 0.1, turnover: 4, amount: 3 }));
  return { rows, source: '隔离行业 UI 行情', sourceCount: rows.length, excludedCount: 0, startedAt: Date.now(), fetchedAt: Date.now() };
};
