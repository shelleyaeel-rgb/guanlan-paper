// Real Electron IPC, pool synchronization and persistence. Only market services
// and the scanner result are deterministic fixtures; no live account is opened.
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const controlPath = process.env.GUANLAN_TEST_CONTROL;
if (!controlPath || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Pool UI fixture requires isolated control and account paths');
const control = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'));
const screening = require('../../core/agency-screening.cjs');
const { composeAgencySelectionQuery } = require('../../core/agency-selection.cjs');
const { rowDiagnostics, poolDiagnostics } = require('../../core/agency-pool-diagnostics.cjs');
const { COMPANY_EVIDENCE_RULE_VERSION } = require('../../core/company-evidence.cjs');
screening.runAgencyScreening = async (screener, options) => {
  const scenario = control(), policy = screening.poolPolicy(options.screeningMode), researchRequired = policy.screeningMode === 'strict', controller = new AbortController();
  screener.activeRun = controller;
  if (process.env.GUANLAN_TEST_POOL_LOG) fs.appendFileSync(process.env.GUANLAN_TEST_POOL_LOG, JSON.stringify(options) + '\n');
  try {
    screener.progress = { loading: true, stage: 'daily', completed: 12, total: 30 };
    await delay(scenario.poolDelay || 150, undefined, { signal: controller.signal });
    if (scenario.poolFailure) throw Error('隔离全市场行情获取失败，本次结果未应用');
    const rows = [...new Set([...(scenario.poolSymbols || ['sh600519', 'sh600036', 'sh600002', 'sh600003', 'sh600005', 'sh600006', 'sh600009',
      ...Array.from({ length: 23 }, (_, index) => `sh${600100 + index}`)]), ...(options.requiredSymbols || [])])].map(symbol => ({ symbol, name: `隔离候选 ${symbol.slice(2)}` }));
    const strategies = Object.fromEntries(policy.priority.map(id => {
      const result = { query: composeAgencySelectionQuery(id, policy.commonQuery), pass: [], failed: [], pending: [] };
      for (const row of rows) {
        const status = scenario.poolOnlySwing && id !== 'swing' || ['sh600519', 'sh600002'].includes(row.symbol) ? 'failed'
          : scenario.dailyPending && row.symbol === 'sh600009' ? 'pending'
          : researchRequired && !scenario.retryResolves && ['sh600003', 'sh600009'].includes(row.symbol) ? 'pending' : 'pass';
        const evidenceReview = !researchRequired ? null : row.symbol === 'sh600009' && scenario.diagnosticEvidenceReview ? structuredClone(scenario.diagnosticEvidenceReview) : status === 'failed' ? null : { mode: 'automatic', status, checkedAt: Date.now(),
          checks: [{ key: 'productOutlook', label: '产品前景', status: 'pass', reason: '产品资料满足明确核验规则', records: [{ sourceTitle: '隔离公开披露原文', publishedAt: '2026-08-20', period: '2025 年度', quote: '隔离原文摘录 <不是人工审核>', locations: [{ page: 3, method: 'pdf-text' }, { page: 4, method: 'ocr', confidence: 91 }], url: 'https://example.com/company/report' }] },
            { key: 'leadership', label: '行业地位', status, reason: status === 'pending' ? '公开排名未明确全国或全球市场口径' : '公开排名与市场口径可核验', records: [] },
            { key: 'financialReview', label: '财务事项', status: 'pass', reason: '已取得的财务事项资料符合规则', records: [] }] };
        if (evidenceReview && !(row.symbol === 'sh600009' && scenario.diagnosticEvidenceReview)) evidenceReview.collection = { complete: true, indexComplete: true, annualReport: 'ready', semiannualReport: 'ready', issues: [] };
        const checked = { status, stage: status === 'failed' || !researchRequired ? 'conditions' : 'evidence', reasons: researchRequired && row.symbol === 'sh600009' && scenario.diagnosticEvidenceReview
          ? evidenceReview.checks.map(check => check.reason) : [status === 'pass' ? researchRequired ? '共同质量标准与本策略条件均通过' : '本策略数值发现条件通过'
          : status === 'pending' ? '完整日线资料不足 <隔离样本>' : '行情技术条件不满足'] };
        result[status].push({ ...row, ...checked, diagnostics: rowDiagnostics(row, checked, evidenceReview), ...(evidenceReview ? { evidenceReview } : {}),
          ...(!researchRequired && scenario.noticeReview && row.symbol === 'sh600009' ? { noticeReview: scenario.noticeReview, reasons: ['敏感公告尚有事实字段待核验'] } : {}) });
      }
      return [id, result];
    }));
    const attempted = rows.filter(row => !['sh600519', 'sh600002'].includes(row.symbol)).length, pending = scenario.retryResolves ? 0 : rows.filter(row => ['sh600003', 'sh600009'].includes(row.symbol)).length, passed = attempted - pending;
    return { startedAt: Date.now(), finishedAt: Date.now(), screeningMode: policy.screeningMode, candidateSelection: policy.candidateSelection, strategies,
      researchChecks: structuredClone(policy.researchChecks), evidenceMode: policy.evidenceMode,
      coverage: { screeningMode: policy.screeningMode, researchRequired, researchChecks: structuredClone(policy.researchChecks), universeComplete: true, universeCount: rows.length, sourceCount: rows.length, excludedCount: 0, requiredMissing: [], partial: researchRequired && pending > 0,
        ...(!researchRequired && scenario.noticeReview ? { noticeFulltextChecked: 1 } : {}),
        diagnostics: poolDiagnostics(strategies), quantitativeCandidates: attempted, evidenceChecked: researchRequired ? attempted : 0, evidenceSummary: { pass: researchRequired ? passed : 0, failed: 0, pending: researchRequired ? pending : 0, checks: {
          productOutlook: { label: '产品前景', pass: attempted, failed: 0, pending: 0 }, leadership: { label: '行业地位', pass: passed, failed: 0, pending }, financialReview: { label: '财务事项', pass: attempted, failed: 0, pending: 0 } } } },
      sources: { quotes: { source: '隔离 UI 行情样本', fetchedAt: Date.now(), oldestQuote: '2026-09-30T07:00:00.000Z', newestQuote: '2026-09-30T07:00:00.000Z', unknownQuoteTime: 0 }, expectedQuoteDate: '2026-09-30', expectedDailyDate: '2026-09-30', ...(researchRequired ? { evidence: `公开披露资料程序核验（规则版本 ${COMPANY_EVIDENCE_RULE_VERSION}）` } : {}) } };
  } catch (error) {
    if (controller.signal.aborted) throw Error('已取消候选池更新，本次结果未应用');
    throw error;
  } finally { screener.activeRun = null; screener.progress.loading = false; }
};
require('./agency-desktop.cjs');
