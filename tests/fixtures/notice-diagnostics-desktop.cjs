// Isolated supplied reviews, real diagnostics, pool IPC and persistence.
const fs = require('node:fs');
const controlPath = process.env.GUANLAN_TEST_CONTROL;
if (!controlPath || !process.env.GUANLAN_TEST_NETWORK_LOG || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Notice diagnostics requires isolated paths');
const screening = require('../../core/agency-screening.cjs');
const { composeStrategyQuery } = require('../../core/strategy-presets.cjs');
const { rowDiagnostics, poolDiagnostics } = require('../../core/agency-pool-diagnostics.cjs');
screening.runAgencyScreening = async (screener, options) => {
  const control = JSON.parse(fs.readFileSync(controlPath, 'utf8')), policy = screening.poolPolicy(options.screeningMode);
  const rows = Object.entries(control.reviews).map(([symbol, noticeReview]) => {
    const checked = { status: noticeReview.status === 'blocked' ? 'failed' : 'pending', stage: 'notices', reasons: noticeReview.reasons || [],
      ...(noticeReview.diagnostic?.code === 'notice-index-fetch' ? { acquisitionError: '隔离目录接口离线' } : {}) };
    return { symbol, name: `隔离公告${symbol.slice(2)}`, ...checked, noticeReview, diagnostics: rowDiagnostics({}, checked, null, null, noticeReview) };
  });
  const strategies = Object.fromEntries(policy.priority.map(id => [id, { query: composeStrategyQuery(id, policy.commonQuery), pass: [],
    pending: rows.filter(row => row.status === 'pending'), failed: rows.filter(row => row.status === 'failed') }]));
  return { startedAt: Date.now(), finishedAt: Date.now(), screeningMode: policy.screeningMode, strategies,
    coverage: { screeningMode: policy.screeningMode, researchRequired: false, universeComplete: true, universeCount: rows.length, requiredMissing: [],
      diagnostics: poolDiagnostics(strategies), noticeFulltextChecked: rows.length - 1 }, sources: { quotes: { source: '隔离公告诊断样本' } } };
};
require('./agency-desktop.cjs');
