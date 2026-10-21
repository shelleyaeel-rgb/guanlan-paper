// Isolated renderer/IPC fixture. All statements and prices are synthetic; the
// production source parser, editable conditions and account persistence run.
const fs = require('node:fs');
const { ipcMain } = require('electron');
const controlPath = process.env.GUANLAN_TEST_CONTROL, callsPath = process.env.GUANLAN_TEST_PERFORMANCE_CALLS;
if (!controlPath || !callsPath || !process.env.GUANLAN_TEST_NETWORK_LOG || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Performance UI test requires isolated control/account/network files');
const control = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'));
const { checkNoticeWithEvidence } = require('../../core/company-notice-review.cjs');
const { evaluatePerformanceRules } = require('../../core/performance-rules.cjs');
const screening = require('../../core/agency-screening.cjs');
const { composeStrategyQuery } = require('../../core/strategy-presets.cjs');
const { rowDiagnostics, poolDiagnostics } = require('../../core/agency-pool-diagnostics.cjs');
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, handler) => register(name, async (event, payload) => {
  if (['agency:pool:run', 'agency:pool:retry', 'agency:members:add', 'screener:run'].includes(name)) fs.appendFileSync(callsPath, JSON.stringify({ name, payload }) + '\n');
  return handler(event, payload);
});
screening.runAgencyScreening = async (screener, options) => {
  const scenario = control(), now = new Date(scenario.now), policy = screening.poolPolicy(options.screeningMode, options.research, options.performance);
  const rows = ['sh600009', 'sh600010'].map(symbol => {
    const sample = scenario.samples[symbol], noticeReview = checkNoticeWithEvidence(sample.response, symbol, sample.bundle, now);
    // Adversarial source text is only a presentation test, never a source verdict.
    noticeReview.notices[0].factReview.warnings = [{ reason: scenario.injection }];
    return { symbol, name: symbol === 'sh600009' ? '隔离预告待补样本' : '隔离预告已核实样本', noticeReview,
      financeCheck: scenario.financeCheck, performanceReview: evaluatePerformanceRules(options.performance, noticeReview, { symbol, now }) };
  });
  const strategies = Object.fromEntries(policy.priority.map(id => {
    const entries = rows.map(row => {
      const status = id !== 'swing' ? 'failed' : row.noticeReview.status !== 'clear' ? 'pending' : row.performanceReview.blocksEntry ? row.performanceReview.status : 'pass';
      const checked = { status, stage: status === 'pass' ? 'passed' : row.noticeReview.status !== 'clear' ? 'notice' : 'performance',
        reasons: id !== 'swing' ? ['隔离样本只匹配波段策略'] : [...row.noticeReview.reasons, ...row.performanceReview.reasons] };
      return { ...row, ...checked, diagnostics: rowDiagnostics(row, checked) };
    });
    return [id, { query: composeStrategyQuery(id, policy.commonQuery), ...Object.fromEntries(['pass', 'pending', 'failed'].map(status => [status, entries.filter(row => row.status === status)])) }];
  }));
  return { startedAt: +now, finishedAt: +now, screeningMode: policy.screeningMode, performance: options.performance, strategies,
    coverage: { screeningMode: policy.screeningMode, researchRequired: false, universeComplete: true, universeCount: 2, requiredMissing: [],
      noticeFulltextChecked: 2, diagnostics: poolDiagnostics(strategies), partial: true }, sources: { quotes: { source: '隔离业绩UI行情', fetchedAt: +now } } };
};
require('./agency-desktop.cjs');
const { Research } = require('../../core/research.cjs'), originalGet = Research.prototype.get;
Research.prototype.get = async function(input) {
  const sample = control().samples[input.symbol];
  if (sample && input.section === 'notices') return structuredClone(sample.response);
  return originalGet.call(this, input);
};
const { CompanyEvidenceSource } = require('../../core/company-evidence-source.cjs');
CompanyEvidenceSource.prototype.getNotices = async function(symbol) {
  const sample = control().samples[symbol];
  return sample ? structuredClone(sample.bundle) : { symbol, fetchedAt: Date.now(), documents: [] };
};
const { FreeScreenerSource } = require('../../core/screener-sources.cjs');
FreeScreenerSource.prototype.load = async function() {
  const scenario = control(), rows = Object.keys(scenario.samples).map(symbol => ({ symbol, name: `隔离预告${symbol.slice(2)}`, board: 'sh', isST: false,
    price: 10.17, pe: 15, timestamp: Date.now(), changePct: 0.1, turnover: 4, amount: 3 }));
  return { rows, source: '隔离业绩UI行情', sourceCount: rows.length, excludedCount: 0, startedAt: Date.now(), fetchedAt: Date.now() };
};
