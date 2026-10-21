// Isolated UI fixture: real IPC/pool persistence; deterministic research sources.
const fs = require('node:fs');
const { ipcMain } = require('electron');
const controlPath = process.env.GUANLAN_TEST_CONTROL, callsPath = process.env.GUANLAN_TEST_RESEARCH_CALLS;
if (!controlPath || !callsPath || !process.env.GUANLAN_TEST_NETWORK_LOG || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Research UI verification requires isolated files and account');
const { evaluateResearchRules, validateResearchRules } = require('../../core/research-rules.cjs');
const scenario = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'));
function reviewFor(symbol, research, includeProducts = true) {
  const control = scenario(), review = structuredClone(control.researchReview);
  review.symbol = symbol; review.query = validateResearchRules(research); review.companyMetrics.symbol = symbol; review.productMetrics.symbol = symbol;
  if (!includeProducts) { review.productMetrics.products = []; review.productMetrics.reason = '本次尚未请求产品报告'; review.acquisition = [{ code: 'not-requested', label: '产品资料尚未获取', reason: '公司经营数据不替代产品指标', action: '读取产品资料', retryable: true }]; }
  review.assessment = evaluateResearchRules(review.query, { symbol, productMetrics: review.productMetrics, companyMetrics: review.companyMetrics }, control.now);
  review.status = review.assessment.status;
  return review;
}
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, handler) => register(name, async (event, payload) => {
  if (['research:inspect', 'agency:pool:run', 'agency:pool:retry', 'agency:members:add', 'screener:run'].includes(name)) fs.appendFileSync(callsPath, JSON.stringify({ name, payload }) + '\n');
  if (name === 'research:inspect') return { ok: true, data: reviewFor(payload.symbol, payload.research, payload.includeProducts) };
  return handler(event, payload);
});
const screening = require('../../core/agency-screening.cjs');
const { composeStrategyQuery } = require('../../core/strategy-presets.cjs');
const { rowDiagnostics, poolDiagnostics } = require('../../core/agency-pool-diagnostics.cjs');
const { FreeScreenerSource } = require('../../core/screener-sources.cjs');
const { Screener, normalize } = require('../../core/screener.cjs');
FreeScreenerSource.prototype.load = async function() {
  const raw = await Screener.prototype.page(1), rows = raw.diff.map(normalize);
  return { rows, source: '隔离研究 UI 全市场快照', sourceCount: rows.length, excludedCount: 0, startedAt: Date.now(), fetchedAt: Date.now() };
};
screening.runAgencyScreening = async (screener, options) => {
  const policy = screening.poolPolicy(options.screeningMode), research = validateResearchRules(options.research);
  const review = research ? reviewFor('sh600009', research) : null, row = { symbol: 'sh600009', name: '隔离经营研究样本' };
  const strategies = Object.fromEntries(policy.priority.map(id => {
    const status = id !== 'swing' ? 'failed' : !research?.enabled ? 'pass' : review.status;
    const checked = { status, stage: id !== 'swing' ? 'conditions' : research ? 'research' : 'passed', reasons: id !== 'swing' ? ['不满足本策略条件'] : review?.assessment.reasons || [] };
    return [id, { query: { ...composeStrategyQuery(id, policy.commonQuery), ...(research ? { research } : {}) }, pass: [], pending: [], failed: [], [status]: [{ ...row, ...checked, diagnostics: rowDiagnostics(row, checked), ...(review ? { researchReview: review } : {}) }] }];
  }));
  return { startedAt: Date.now(), finishedAt: Date.now(), screeningMode: options.screeningMode, ...(research ? { research } : {}), strategies,
    coverage: { screeningMode: options.screeningMode, researchRequired: false, universeComplete: true, universeCount: 1, requiredMissing: [], diagnostics: poolDiagnostics(strategies), partial: review?.status === 'pending', researchSummary: { passed: review?.status === 'pass' ? 1 : 0, pending: review?.status === 'pending' ? 1 : 0, failed: review?.status === 'failed' ? 1 : 0 } },
    sources: { quotes: { source: '隔离研究 UI 行情', fetchedAt: Date.now() } } };
};
require('./agency-desktop.cjs');
