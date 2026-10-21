// Product diagnostics fixture: actual IPC, pool reconciliation and persistence,
// fixed research results, isolated account and blocked unexpected network.
const fs = require('node:fs');
const controlPath = process.env.GUANLAN_TEST_CONTROL;
if (!controlPath || !process.env.GUANLAN_TEST_NETWORK_LOG || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Product UI checks require isolated control, account and network log');
const screening = require('../../core/agency-screening.cjs');
const { composeStrategyQuery } = require('../../core/strategy-presets.cjs');
const { rowDiagnostics, poolDiagnostics } = require('../../core/agency-pool-diagnostics.cjs');
screening.runAgencyScreening = async (screener, options) => {
  const scenario = JSON.parse(fs.readFileSync(controlPath, 'utf8')), policy = screening.poolPolicy(options.screeningMode);
  if (policy.screeningMode !== 'strict') throw Error('Product fixture requires explicit strict screening');
  const review = scenario.productReview, row = { symbol: 'sh600009', name: '隔离产品核验样本' };
  const strategies = Object.fromEntries(policy.priority.map(id => {
    const checked = id === 'swing' ? { status: review.status, stage: 'evidence', reasons: review.checks.map(check => check.reason) }
      : { status: 'failed', stage: 'conditions', reasons: ['隔离样本未满足此策略发现条件'] };
    const status = checked.status === 'fail' ? 'failed' : checked.status;
    return [id, { query: composeStrategyQuery(id, policy.commonQuery), pass: [], pending: [], failed: [],
      [status]: [{ ...row, ...checked, status, diagnostics: rowDiagnostics(row, checked, id === 'swing' ? review : null), ...(id === 'swing' ? { evidenceReview: review } : {}) }] }];
  }));
  const checks = Object.fromEntries(review.checks.map(check => [check.key, { label: check.label,
    pass: check.status === 'pass' ? 1 : 0, failed: ['fail', 'failed'].includes(check.status) ? 1 : 0, pending: check.status === 'pending' ? 1 : 0 }]));
  return { startedAt: Date.now(), finishedAt: Date.now(), screeningMode: 'strict', strategies,
    coverage: { screeningMode: 'strict', researchRequired: true, universeComplete: true, universeCount: 1, sourceCount: 1, excludedCount: 0, requiredMissing: [],
      partial: review.status === 'pending', diagnostics: poolDiagnostics(strategies), quantitativeCandidates: 1, evidenceChecked: 1,
      evidenceSummary: { pass: review.status === 'pass' ? 1 : 0, failed: ['fail', 'failed'].includes(review.status) ? 1 : 0, pending: review.status === 'pending' ? 1 : 0, checks } },
    sources: { quotes: { source: '隔离产品 UI 行情样本', fetchedAt: Date.now() }, evidence: '隔离产品已披露经营证据样本' } };
};
require('./agency-desktop.cjs');
