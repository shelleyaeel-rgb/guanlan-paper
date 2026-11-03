const { cnTime, symbolOf } = require('./common.cjs');
const { calendarSession } = require('./trading-calendar.cjs');
const { FIELDS, defaults, classifyScreenRow, quoteRange, cancellable } = require('./screener.cjs');
const { STRATEGY_PRESETS } = require('./strategy-presets.cjs');
const { composeAgencySelectionQuery, agencySelectionPolicy } = require('./agency-selection.cjs');
const { rowDiagnostics, poolDiagnostics } = require('./agency-pool-diagnostics.cjs');
const { pendingFinanceReport, reportSyncReason } = require('./financial-report-status.cjs');
const { refreshFinanceSnapshot } = require('./finance-validity.cjs');
const { financeTemplateCheck } = require('./finance-template.cjs');

function deepFreeze(value) {
  for (const item of Object.values(value)) if (item && typeof item === 'object') deepFreeze(item);
  return Object.freeze(value);
}
const AGENCY_POOL_POLICY = deepFreeze({
  version: 3, name: '纯行情技术筛选', screeningMode: 'strategy', mode: 'manual', evidenceMode: 'none',
  commonQuery: { ...defaults(), excludeST: true },
  priority: STRATEGY_PRESETS.map(preset => preset.id),
  priorityLabels: STRATEGY_PRESETS.map(preset => preset.id === 'long' ? '长线 · 趋势跟踪' : preset.name),
  researchChecks: { status: 'disabled', notices: false, reports: false, industry: false, finance: false, valuation: false },
  ownership: '已有归属优先；新增重叠按超短线、短线、波段、长线顺序归属',
  scopeLabel: '沪深 A 股（主板、创业板、科创板）',
  limitations: '仅按行情与完整日线技术条件选择候选。公告风险、报告与行业研究、财务及估值筛查已停用，不代表核验通过；实际开仓继续执行实时行情、盘口、交易规则和账户风控校验。'
});
function poolPolicy(screeningMode = 'strategy', _research, _performance, _industry) {
  if (!['strategy', 'strict'].includes(screeningMode)) throw Error('候选筛选模式无效');
  // Accept legacy saved options without re-enabling the removed research path.
  const policy = structuredClone(AGENCY_POOL_POLICY);
  policy.candidateSelection = agencySelectionPolicy();
  return policy;
}
const assertActive = signal => { if (signal.aborted) throw Error('已取消候选更新，本次结果未应用'); };
const statusOf = checks => checks.some(check => check.status === 'failed') ? 'failed' : checks.some(check => check.status === 'pending') ? 'pending' : 'pass';

// This calendar check chooses the latest observable session, never an execution
// permission. A scan itself is allowed before open, after close and on holidays.
function latestSessionDate(now, complete) {
  // Providers can publish today's observations before continuous trading. A
  // complete daily bar still requires the close, regardless of quote date.
  const time = cnTime(now), includeToday = !complete || time.minutes >= 900;
  let day = Date.parse(`${time.date}T10:00:00+08:00`) - (includeToday ? 0 : 86400000);
  for (let i = 0; i < 370; i++, day -= 86400000) {
    const session = calendarSession(new Date(day));
    if (!session.known) return null;
    if (session.open) return session.date;
  }
  return null;
}

function quoteAssessment(row, now, expectedDate, allowedDates = [expectedDate]) {
  const at = now.getTime(), timestamp = row.timestamp;
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > at) return { status: 'pending', reasons: ['行情时间缺失、无效或晚于本次检查时间'] };
  if (!Number.isFinite(row.price) || row.price <= 0) return { status: 'pending', reasons: ['最近行情价格缺失或无效'] };
  const time = cnTime(timestamp);
  if (!expectedDate) return { status: 'pending', reasons: ['交易日历无法核验最近行情日期；已完成扫描，候选等待日期核验'] };
  if (!allowedDates.includes(time.date)) return { status: 'pending', reasons: [`行情日期 ${time.date} 不在本次允许的观测日期 ${allowedDates.join('、')}`] };
  if (row.date != null && row.date !== time.date) return { status: 'pending', reasons: ['行情日期与时间戳不一致'] };
  const today = cnTime(now);
  const completed = time.date < today.date || today.minutes >= 900;
  if (completed && time.minutes < 898.5) return { status: 'pending', reasons: ['最近交易日行情尚未覆盖收盘附近，等待完整行情；不因此剔除候选'] };
  return { status: 'pass', reasons: [], quoteDate: time.date, cumulativeComplete: completed };
}

function summarize(row, status, reasons, stage, extra = {}) {
  const base = status === 'pass' ? row : {
    symbol: row.symbol, name: row.name || row.symbol, board: row.board,
    timestamp: row.timestamp ?? null, technicalAsOf: row.technicalAsOf || null,
    technicalError: row.technicalError || null, technicalErrorDetail: row.technicalErrorDetail || null,
    financeReportDate: row.financeReportDate || null, financeNoticeDate: row.financeNoticeDate || null
  };
  return { ...base, ...extra, symbol: row.symbol, name: row.name || row.symbol, status, reasons: [...new Set(reasons)], stage };
}

function financialConditionCheck(row, query, now, notices = null, requireTemplate = false) {
  const rules = query.rules.filter(rule => [rule.field, rule.valueField].some(field => FIELDS[field]?.source === 'finance'));
  if (!rules.length) return null;
  row = refreshFinanceSnapshot(row, row.symbol, now, { notices });
  const checks = rules.map(rule => {
    const check = classifyScreenRow(row, { ...defaults(), rules: [rule] });
    const dependencies = [rule.field, rule.valueField].filter(field => FIELDS[field]?.source === 'finance');
    const pendingFields = dependencies
      .map(field => ({ field, report: pendingFinanceReport(notices, row.symbol, now, row, field) })).filter(item => item.report);
    const pendingReport = pendingFields.sort((a, b) => b.report.reportDate.localeCompare(a.report.reportDate))[0]?.report;
    const validity = row.financeFieldChecks[rule.field];
    const unavailable = dependencies.filter(field => row.financeFieldChecks[field]?.status === 'pending');
    return { field: rule.field, label: FIELDS[rule.field].label, value: validity?.rawValue ?? (Number.isFinite(row[rule.field]) ? row[rule.field] : null),
      unit: FIELDS[rule.field].unit || '', op: rule.op, expected: rule.valueField ? row[rule.valueField] : rule.value,
      reportDate: rule.field.startsWith('annual') ? row.financeAnnualReports?.[0]?.reportDate || null : row.financeReportDate || null,
      noticeDate: validity?.noticeDate || null, basis: validity?.basis || null, currency: validity?.currency || null,
      ...(pendingReport ? { pendingReport, pendingFields: pendingFields.map(item => item.field) } : {}),
      ...(unavailable.length ? { pendingFields: [...new Set([...unavailable, ...pendingFields.map(item => item.field)])] } : {}),
      status: pendingReport || unavailable.length ? 'pending' : check.status, reason: pendingReport ? reportSyncReason(pendingReport)
        : unavailable.length ? [...new Set(unavailable.map(field => row.financeFieldChecks[field].reason))].join('；') : check.reasons.join('；') };
  });
  const pendingReport = checks.filter(check => check.pendingReport).sort((a, b) => b.pendingReport.reportDate.localeCompare(a.pendingReport.reportDate))[0]?.pendingReport;
  const template = requireTemplate ? financeTemplateCheck(row, now) : null;
  if (template && template.status !== 'pass') return { ...template, source: row.financeSource, fetchedAt: row.financeFetchedAt,
    checkedAt: now.getTime(), checks: [], observations: checks.map(check => ({ ...check, status: 'observing' })) };
  return { status: statusOf(checks), reasons: [...new Set(checks.filter(check => check.status !== 'pass').map(check => check.reason))],
    ...(template ? { applicability: template.applicability } : {}),
    reportDate: rules.every(rule => rule.field.startsWith('annual') && (!rule.valueField || rule.valueField.startsWith('annual'))) ? row.financeAnnualReports?.[0]?.reportDate || null : row.financeReportDate || null,
    noticeDate: row.financeNoticeDate || null, source: row.financeSource || null,
    fetchedAt: row.financeFetchedAt || null, checkedAt: now.getTime(), checks, ...(pendingReport ? { pendingReport } : {}) };
}

function checkStrategy(row, query, now, expectedQuoteDate, expectedDailyDate, allowedQuoteDates) {
  const quote = quoteAssessment(row, now, expectedQuoteDate, allowedQuoteDates);
  // Below-minimum turnover/amount are inconclusive until the session completes.
  const numeric = classifyScreenRow(row, query, { deferMinimumFields: quote.cumulativeComplete ? [] : ['amount', 'turnover'] });
  const checks = [numeric];
  // The cheap scan intentionally skips daily downloads after a definitive
  // quote rejection. Missing unneeded bars must not turn that
  // rejection into "pending". Invalid quote dates still cannot prove failure.
  if (quote.status === 'pass' && numeric.status === 'failed') {
    const independent = classifyScreenRow(row, { ...query,
      rules: query.rules.filter(rule => [rule.field, rule.valueField].filter(Boolean).every(field => FIELDS[field].source !== 'daily'))
    }, { deferMinimumFields: quote.cumulativeComplete ? [] : ['amount', 'turnover'] });
    if (independent.status === 'failed') return { ...independent, stage: 'conditions' };
  }
  if (query.rules.some(rule => [rule.field, rule.valueField].filter(Boolean).some(field => FIELDS[field].source === 'daily'))) {
    if (['insufficient', 'invalid', 'fetch'].includes(row.technicalError)) {
      const label = { insufficient: '完整日线根数不足，技术指标待补齐', invalid: '日线数据无效，技术指标待核验', fetch: '技术日线获取失败，等待重新获取' }[row.technicalError];
      return { status: 'pending', reasons: [row.technicalErrorDetail ? `${label}：${row.technicalErrorDetail}` : label], stage: 'daily',
        technicalError: row.technicalError, technicalErrorDetail: row.technicalErrorDetail || null };
    }
    if (!expectedDailyDate || row.technicalAsOf !== expectedDailyDate) {
      const stale = expectedDailyDate && row.technicalAsOf && row.technicalAsOf < expectedDailyDate;
      return { status: 'pending', reasons: [stale
        ? `完整日线日期 ${row.technicalAsOf} 未覆盖最近完整交易日 ${expectedDailyDate}`
        : `完整日线日期 ${row.technicalAsOf || '未知'} 与本轮允许的完整交易日 ${expectedDailyDate || '待核验'} 不一致，不能使用较新或日期不明的日线`],
        stage: 'daily', technicalError: stale ? 'stale' : 'mismatch' };
    }
    const reference = row.technicalAsOf === quote.quoteDate ? row.price : row.prevClose;
    if (!Number.isFinite(reference) || reference <= 0 || !Number.isFinite(row.close) || Math.abs(row.close - reference) > 0.011) {
      return { status: 'pending', reasons: ['完整日线与同源行情价格基准缺失或不一致（可能缺日线或除权），不能据此调整候选资格'], stage: 'daily', technicalError: 'mismatch' };
    }
  }
  // Invalid observation dates cannot establish a destructive numerical failure.
  if (quote.status !== 'pass') return { status: 'pending', reasons: quote.reasons, stage: 'quotes' };
  const status = statusOf(checks);
  return { status, reasons: checks.filter(check => check.status === status).flatMap(check => check.reasons), stage: 'conditions' };
}

/** Shared, read-only scan. Account reconciliation belongs to agency-pool-sync. */
async function runAgencyScreening(screener, { force = true, requiredSymbols = [], retryEvidence = false, refreshQuantitative = false, screeningMode = 'strategy', research, performance, industry } = {}) {
  if (!screener || typeof screener.load !== 'function') throw Error('候选筛选服务未配置');
  if (typeof force !== 'boolean' || typeof retryEvidence !== 'boolean' || typeof refreshQuantitative !== 'boolean' || !Array.isArray(requiredSymbols)) throw Error('候选更新参数无效');
  const policy = poolPolicy(screeningMode, research, performance, industry);
  screeningMode = policy.screeningMode;
  const required = [...new Set(requiredSymbols.map(symbolOf))];
  if (screener.activeRun) throw Error('已有选股任务进行中，请等待完成或取消');
  const controller = new AbortController(), { signal } = controller;
  screener.activeRun = controller;
  const startedAt = screener.clock().getTime(), commonQuery = policy.commonQuery;
  const strategies = Object.fromEntries(policy.priority.map(id => [id, { query: composeAgencySelectionQuery(id, commonQuery), pass: [], failed: [], pending: [] }]));
  const timings = {}, markStage = (stage, from) => { timings[stage] = { startedAt: from, finishedAt: screener.clock().getTime(), elapsedMs: Math.max(0, screener.clock().getTime() - from) }; };
  try {
    screener.progress = { loading: true, stage: 'quotes', completed: 0, total: 0 };
    const original = await cancellable(screener.load(true), signal);
    markStage('quotes', startedAt);
    assertActive(signal);
    if (!original || !Array.isArray(original.rows) || !original.rows.length || original.partial === true) throw Error('全市场股票池缺失或不完整，本次候选未更新');
    const seen = new Set();
    for (const row of original.rows) {
      if (!row || symbolOf(row.symbol) !== row.symbol || seen.has(row.symbol)) throw Error('全市场股票池代码无效或重复，本次候选未更新');
      seen.add(row.symbol);
    }
    if (!Number.isSafeInteger(original.sourceCount) || !Number.isSafeInteger(original.excludedCount ?? 0) || (original.excludedCount || 0) < 0 || original.sourceCount !== original.rows.length + (original.excludedCount || 0)) throw Error('全市场股票池覆盖数量不完整，本次候选未更新');
    // Freeze a copy after quote acquisition. Later stages may cross the close
    // or midnight; they must not change this snapshot's observation boundary.
    const scanTime = new Date(screener.clock().getTime()), expectedQuoteDate = latestSessionDate(scanTime, false), expectedDailyDate = latestSessionDate(scanTime, true);
    const scanClock = cnTime(scanTime);
    // Before 09:30, both a current-day pre-open/auction observation and the last
    // complete session are legitimate provider responses. After 09:30 only the
    // current trading day is accepted; holidays still use the last session.
    const allowedQuoteDates = [...new Set([expectedQuoteDate,
      ...(expectedQuoteDate === scanClock.date && scanClock.minutes < 570 ? [expectedDailyDate] : [])].filter(Boolean))];
    const cachePolicy = { mode: 'candidate', expectedDailyDate, refreshQuantitative };
    // Only market observations and complete daily bars are loaded.
    const common = new Map(original.rows.map(row => {
      const quote = quoteAssessment(row, scanTime, expectedQuoteDate, allowedQuoteDates);
      return [row.symbol, quote.status !== 'pass' ? { ...quote, stage: 'quotes' } : { ...classifyScreenRow(row, { ...commonQuery, rules: [] }), stage: 'common' }];
    }));
    const commonRows = original.rows.filter(row => common.get(row.symbol).status === 'pass');
    const quantitativeStages = Object.fromEntries(policy.priority.map(id => [id, { quotePossible: 0, dailyRequired: 0 }]));
    const dailyRows = commonRows.filter(row => {
      let needed = false;
      for (const id of policy.priority) {
        const query = strategies[id].query, quote = quoteAssessment(row, scanTime, expectedQuoteDate, allowedQuoteDates);
        const checked = classifyScreenRow(row, { ...query, rules: query.rules.filter(rule => [rule.field, rule.valueField].filter(Boolean).every(field => FIELDS[field].source !== 'daily')) },
          { deferMinimumFields: quote.cumulativeComplete ? [] : ['amount', 'turnover'] });
        if (checked.status !== 'failed') {
          quantitativeStages[id].quotePossible++;
          if (query.rules.some(rule => [rule.field, rule.valueField].filter(Boolean).some(field => FIELDS[field].source === 'daily'))) {
            quantitativeStages[id].dailyRequired++; needed = true;
          }
        }
      }
      return needed;
    });
    const technicalRules = [...new Map(Object.values(strategies).flatMap(strategy => strategy.query.rules).filter(rule => FIELDS[rule.field].source === 'daily').map(rule => [JSON.stringify(rule), rule])).values()];
    const dailyStartedAt = screener.clock().getTime();
    const daily = dailyRows.length ? await screener.scanDaily({ ...original, rows: dailyRows }, { ...defaults(), rules: technicalRules }, [], force, signal, scanTime, cachePolicy)
      : { ...original, rows: [], technicalScan: null };
    markStage('daily', dailyStartedAt);
    assertActive(signal);
    const enriched = new Map([...original.rows, ...daily.rows].map(row => [row.symbol, row]));
    const strategyCheck = (row, id) => {
      const checked = checkStrategy(row, strategies[id].query, scanTime, expectedQuoteDate, expectedDailyDate, allowedQuoteDates);
      // Short-horizon market risk remains independent of the removed research gates.
      if (checked.status === 'pass' && ['ultra-short', 'short'].includes(id)) {
        if (!Number.isFinite(row.changePct) || row.changePct <= -100) return { status: 'pending', reasons: ['最近行情涨跌幅缺失或无效，短线风险待核验'], stage: 'market-risk' };
        if (row.changePct <= -5 + 1e-8) return { status: 'failed', reasons: ['最近行情跌幅达到 5% 的短线候选风险阈值'], stage: 'market-risk' };
      }
      return checked;
    };
    const preliminary = new Map();
    for (const originalRow of original.rows) {
      const row = enriched.get(originalRow.symbol) || originalRow, shared = common.get(row.symbol);
      const checks = Object.fromEntries(policy.priority.map(id => [id, shared.status === 'pass'
        ? strategyCheck(row, id) : shared]));
      preliminary.set(row.symbol, { row, checks });
    }
    for (const { row, checks } of preliminary.values()) {
      for (const id of policy.priority) {
        const checked = checks[id];
        const diagnostics = { ...rowDiagnostics(row, checked), researchStatus: 'disabled' };
        const extra = { ...(checked.technicalError ? { technicalError: checked.technicalError, technicalErrorDetail: checked.technicalErrorDetail || null } : {}),
          diagnostics, researchChecks: structuredClone(policy.researchChecks),
          ...(checked.status === 'pass' ? { observedQuoteDate: cnTime(row.timestamp).date } : {}) };
        strategies[id][checked.status].push(summarize(row, checked.status, checked.reasons || [], checked.stage, extra));
      }
    }
    const missingSymbols = required.filter(symbol => !seen.has(symbol));
    for (const symbol of missingSymbols) for (const id of policy.priority) {
      const checked = { status: 'pending', reasons: ['本次完整股票池未返回该既有候选，不能据此认定不符合条件'], stage: 'universe' };
      strategies[id].pending.push(summarize({ symbol }, checked.status, checked.reasons, checked.stage, { diagnostics: rowDiagnostics({ symbol }, checked) }));
    }
    const counts = Object.fromEntries(policy.priority.map(id => [id, Object.fromEntries(['pass', 'failed', 'pending'].map(key => [key, strategies[id][key].length]))]));
    const anyPass = Object.values(counts).some(count => count.pass), anyPending = Object.values(counts).some(count => count.pending);
    const coverage = { screeningMode, researchRequired: false, researchStatus: 'disabled', researchChecks: structuredClone(policy.researchChecks),
      diagnostics: poolDiagnostics(strategies, { researchEnabled: false }), universeComplete: true,
      universeCount: original.rows.length, sourceCount: original.sourceCount ?? original.rows.length,
      excludedCount: original.excludedCount || 0, requiredMissing: missingSymbols, commonPassed: commonRows.length,
      commonFailed: [...common.values()].filter(check => check.status === 'failed').length,
      commonPending: [...common.values()].filter(check => check.status === 'pending').length,
      financeFailures: {}, technicalFailures: daily.technicalScan?.failures || {},
      quantitativeCandidates: [...preliminary.values()].filter(item => policy.priority.some(id => item.checks[id].status === 'pass')).length,
      evidenceChecked: 0, evidenceSummary: { pass: 0, failed: 0, pending: 0, checks: {} }, financeChecked: 0,
      technicalChecked: dailyRows.length, quantitativeStages, timings, cache: { finance: null, daily: daily.technicalScan?.cache || null },
      noticesChecked: 0, noticeFulltextChecked: 0, counts, partial: anyPending };
    screener.progress = { loading: true, stage: 'complete', completed: original.rows.length, total: original.rows.length };
    return { status: anyPass ? 'ready' : anyPending ? 'unavailable' : 'empty', startedAt, finishedAt: screener.clock().getTime(), policyVersion: policy.version, screeningMode,
      commonQuery, candidateSelection: policy.candidateSelection, coverage, strategies,
      sources: { quotes: { source: original.source || '来源未标注', fetchedAt: original.fetchedAt ?? null, ...quoteRange(original.rows) },
        finance: null, technical: daily.technicalScan || null, scanTime: scanTime.toISOString(), expectedQuoteDate, allowedQuoteDates, expectedDailyDate,
        evidence: '未启用报告、行业、经营、财务及估值筛查', notices: '未启用公告风险筛查',
        note: '候选筛选使用最近有效行情与完整日线；不代表当前可成交，实际新开仓仍重新核验实时条件。' } };
  } finally {
    if (screener.activeRun === controller) screener.activeRun = null;
    screener.progress.loading = false;
  }
}

module.exports = { AGENCY_POOL_POLICY, poolPolicy, financialConditionCheck, runAgencyScreening };
