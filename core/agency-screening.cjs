const { cnTime, symbolOf } = require('./common.cjs');
const { calendarSession } = require('./trading-calendar.cjs');
const { FIELDS, defaults, financialQualityRules, classifyScreenRow, quoteRange, cancellable } = require('./screener.cjs');
const { STRATEGY_PRESETS, composeStrategyQuery } = require('./strategy-presets.cjs');
const { evaluateCompanyEvidence, refreshCompanyEvidence, COMPANY_EVIDENCE_RULE_VERSION } = require('./company-evidence.cjs');
const { checkNoticeRisk, NOTICE_RISK_POLICY } = require('./entry-risk.cjs');
const { reviewNoticeEvidence, checkNoticeWithEvidence } = require('./company-notice-review.cjs');
const { collectionSummary, rowDiagnostics, poolDiagnostics } = require('./agency-pool-diagnostics.cjs');
const { validateResearchRules } = require('./research-rules.cjs');
const { evaluateOperatingResearch, refreshOperatingResearch } = require('./company-research.cjs');
const { validatePerformanceRules, evaluatePerformanceRules } = require('./performance-rules.cjs');
const { latestDisclosedReport, pendingFinanceReport, reportSyncReason } = require('./financial-report-status.cjs');
const { refreshFinanceSnapshot } = require('./finance-validity.cjs');
const { validateIndustryRules } = require('./selection-evidence.cjs');
const { financeTemplateCheck } = require('./finance-template.cjs');

function noticeAcquisition(response) {
  return response?.error ? { acquisitionError: response.error } : {};
}

function deepFreeze(value) {
  for (const item of Object.values(value)) if (item && typeof item === 'object') deepFreeze(item);
  return Object.freeze(value);
}
const AGENCY_POOL_POLICY = deepFreeze({
  version: 3, name: '按策略筛选', screeningMode: 'strategy', mode: 'manual', evidenceMode: 'none',
  commonQuery: { ...defaults(), excludeST: true },
  priority: STRATEGY_PRESETS.map(preset => preset.id),
  priorityLabels: STRATEGY_PRESETS.map(preset => preset.name),
  ownership: '已有归属优先；新增重叠按超短线、短线、波段、长线顺序归属',
  scopeLabel: '沪深 A 股（主板、创业板、科创板）',
  limitations: '按各策略自身条件选择监控候选；保留已有监控及个人开仓条件。实际新开仓继续执行实时行情、盘口和风险校验。'
});
function poolPolicy(screeningMode = 'strategy', inputResearch, inputPerformance, inputIndustry) {
  if (!['strategy', 'strict'].includes(screeningMode)) throw Error('候选筛选模式无效');
  const policy = structuredClone(AGENCY_POOL_POLICY);
  const research = validateResearchRules(inputResearch);
  const industry = validateIndustryRules(inputIndustry);
  if (industry && screeningMode === 'strict') throw Error('旧严格研究已含固定行业地位条件；请切换策略筛选后编辑行业数值条件');
  if (research && screeningMode === 'strict') throw Error('旧严格研究与经营指标是独立路径，请明确选择一种筛选方式');
  if (research) {
    policy.commonQuery.research = research;
    policy.name = `${research.path === 'product' ? '产品指标' : '公司经营'}${research.enabled ? '筛选' : '观察'}`;
  }
  if (screeningMode === 'strict') Object.assign(policy, {
    name: '财务质量与行业龙头', screeningMode, evidenceMode: 'automatic',
    commonQuery: { ...defaults(), excludeST: true, rules: financialQualityRules(),
      evidence: { conditions: ['productOutlook', 'financialReview'], leadership: 'either', minSegmentRevenuePct: 30 } },
    limitations: '普通非金融企业严格研究模板；量化条件入围后核验公开披露原文，资料不足或冲突不授予严格候选资格。实际新开仓仍执行实时策略及风险校验。'
  });
  const performance = validatePerformanceRules(inputPerformance);
  if (performance) policy.commonQuery.performance = performance;
  if (industry) {
    policy.commonQuery.evidence = { conditions: [], leadership: '', minSegmentRevenuePct: 30, industry };
    policy.evidenceMode = 'automatic';
    policy.name += ' · 行业数值条件';
    policy.limitations += '行业条件只核验已披露排名和细分收入占比，保留统计期间与范围，不代表行业景气或未来前景。';
  }
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

function checkStrategy(row, query, now, expectedQuoteDate, expectedDailyDate, allowedQuoteDates, requireTemplate = false, checkedAt = now) {
  const quote = quoteAssessment(row, now, expectedQuoteDate, allowedQuoteDates);
  if (requireTemplate && quote.status === 'pass') {
    const template = financeTemplateCheck(row, checkedAt);
    if (template.status !== 'pass') return template;
  }
  // Below-minimum turnover/amount are inconclusive until the session completes.
  const numeric = classifyScreenRow(row, query, { deferMinimumFields: quote.cumulativeComplete ? [] : ['amount', 'turnover'] });
  const checks = [numeric];
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
  const policy = poolPolicy(screeningMode, research, performance, industry), researchRequired = policy.evidenceMode === 'automatic';
  const metricQuery = policy.commonQuery.research;
  const performanceQuery = policy.commonQuery.performance;
  const required = [...new Set(requiredSymbols.map(symbolOf))];
  if (screener.activeRun) throw Error('已有选股任务进行中，请等待完成或取消');
  const controller = new AbortController(), { signal } = controller;
  screener.activeRun = controller;
  const startedAt = screener.clock().getTime(), commonQuery = policy.commonQuery;
  const strategies = Object.fromEntries(policy.priority.map(id => [id, { query: composeStrategyQuery(id, commonQuery), pass: [], failed: [], pending: [] }]));
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
    const cachePolicy = { mode: 'candidate', expectedDailyDate, refreshQuantitative, requireIndustry: true,
      requiredFinanceFields: [...new Set(Object.values(strategies).flatMap(item => item.query.rules)
        .flatMap(rule => [rule.field, rule.valueField].filter(field => field && FIELDS[field].source === 'finance'))
        .concat(metricQuery?.enabled && metricQuery.path === 'company' ? metricQuery.rules.map(rule => rule.field) : []))] };
    // Cheap quote checks precede quantitative enrichment. Research documents
    // are collected only for the union of quantitative strategy matches.
    const common = new Map(original.rows.map(row => {
      const quote = quoteAssessment(row, scanTime, expectedQuoteDate, allowedQuoteDates);
      return [row.symbol, quote.status !== 'pass' ? { ...quote, stage: 'quotes' } : { ...classifyScreenRow(row, { ...commonQuery, rules: [] }), stage: 'common' }];
    }));
    const financeRows = original.rows.filter(row => common.get(row.symbol).status === 'pass');
    // One pass supplies all financial fields, keeping cumulative long-plan ROE
    // separate from the common annual quality conditions.
    const financeStartedAt = screener.clock().getTime();
    const financial = financeRows.length ? await screener.scanFinance({ ...original, rows: financeRows }, commonQuery, [], force, signal, scanTime, cachePolicy)
      : { ...original, rows: [], financeScan: null };
    markStage('finance', financeStartedAt);
    assertActive(signal);
    for (const row of financial.rows) {
      const template = screeningMode === 'strict' ? financeTemplateCheck(row, screener.clock()) : null;
      common.set(row.symbol, template && template.status !== 'pass' ? template : { ...classifyScreenRow(row, commonQuery), stage: 'finance' });
    }
    const commonRows = financial.rows.filter(row => common.get(row.symbol).status === 'pass');
    // Keep strategy-specific AND conditions separate: a PE or turnover failure
    // cannot eliminate the same company's swing strategy. Missing cumulative
    // observations remain pending, and the final classifier still verifies all
    // observation boundaries before deciding a definitive failure.
    const quantitativeStages = Object.fromEntries(policy.priority.map(id => [id, { quotePossible: 0, financePossible: 0, dailyRequired: 0 }]));
    for (const row of financeRows) for (const id of policy.priority) {
      const query = strategies[id].query, quote = quoteAssessment(row, scanTime, expectedQuoteDate, allowedQuoteDates);
      const checked = classifyScreenRow(row, { ...query, rules: query.rules.filter(rule => [rule.field, rule.valueField].filter(Boolean).every(field => !FIELDS[field].source)) },
        { deferMinimumFields: quote.cumulativeComplete ? [] : ['amount', 'turnover'] });
      if (checked.status !== 'failed') quantitativeStages[id].quotePossible++;
    }
    const dailyRows = commonRows.filter(row => {
      let needed = false;
      for (const id of policy.priority) {
        const query = strategies[id].query, quote = quoteAssessment(row, scanTime, expectedQuoteDate, allowedQuoteDates);
        const checked = classifyScreenRow(row, { ...query, rules: query.rules.filter(rule => [rule.field, rule.valueField].filter(Boolean).every(field => FIELDS[field].source !== 'daily')) },
          { deferMinimumFields: quote.cumulativeComplete ? [] : ['amount', 'turnover'] });
        if (checked.status !== 'failed') {
          quantitativeStages[id].financePossible++;
          if (query.rules.some(rule => [rule.field, rule.valueField].filter(Boolean).some(field => FIELDS[field].source === 'daily'))) {
            quantitativeStages[id].dailyRequired++; needed = true;
          }
        }
      }
      return needed;
    });
    const technicalRules = [...new Map(STRATEGY_PRESETS.flatMap(preset => preset.rules).filter(rule => FIELDS[rule.field].source === 'daily').map(rule => [JSON.stringify(rule), rule])).values()];
    const dailyStartedAt = screener.clock().getTime();
    const daily = dailyRows.length ? await screener.scanDaily({ ...financial, rows: dailyRows }, { ...defaults(), rules: technicalRules }, [], force, signal, scanTime, cachePolicy)
      : { ...financial, rows: [], technicalScan: null };
    markStage('daily', dailyStartedAt);
    assertActive(signal);
    const enriched = new Map([...financial.rows, ...daily.rows].map(row => [row.symbol, row]));
    const preliminary = new Map();
    for (const originalRow of original.rows) {
      const row = enriched.get(originalRow.symbol) || originalRow, shared = common.get(row.symbol);
      const checks = Object.fromEntries(policy.priority.map(id => [id, shared.status === 'pass'
        ? checkStrategy(row, strategies[id].query, scanTime, expectedQuoteDate, expectedDailyDate, allowedQuoteDates, id === 'long', screener.clock()) : shared]));
      for (const id of ['ultra-short', 'short']) if (checks[id].status === 'pass') {
        if (!Number.isFinite(row.changePct) || row.changePct <= -100) checks[id] = { status: 'pending', reasons: ['最近行情涨跌幅缺失或无效，短线风险待核验'], stage: 'market-risk' };
        else if (row.changePct <= -5 + 1e-8) checks[id] = { status: 'failed', reasons: ['最近行情跌幅达到 5% 的短线候选风险阈值'], stage: 'market-risk' };
      }
      preliminary.set(row.symbol, { row, checks });
    }
    const noticeRows = [...preliminary.values()].filter(item => policy.priority.some(id => item.checks[id].status === 'pass')).map(item => item.row);
    const noticesStartedAt = screener.clock().getTime();
    screener.progress = { loading: true, stage: 'notices', completed: 0, total: noticeRows.length };
    const noticeResponses = new Map(), noticeChecks = new Map(); let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, noticeRows.length) }, async () => {
      while (next < noticeRows.length && !signal.aborted) {
        const row = noticeRows[next++];
        try {
          if (!screener.noticeLoader) throw Error('公告服务未配置');
          noticeResponses.set(row.symbol, await cancellable(screener.noticeLoader(row.symbol, signal, force), signal));
        } catch (error) { assertActive(signal); noticeResponses.set(row.symbol, { error: error.message }); }
        assertActive(signal);
        // Judge each response when it arrives. Waiting for a large batch would
        // expire its earliest results and skip their research permanently.
        // Qualified companies still receive the final freshness check below.
        const notice = checkNoticeRisk(noticeResponses.get(row.symbol), row.symbol, screener.clock());
        noticeChecks.set(row.symbol, { status: notice.status === 'clear' ? 'pass' : notice.status === 'blocked' ? 'failed' : 'pending', reasons: notice.reasons, evaluation: notice,
          ...noticeAcquisition(noticeResponses.get(row.symbol)) });
        screener.progress.completed++;
      }
    }));
    markStage('notices', noticesStartedAt);
    assertActive(signal);
    const reportSyncRows = noticeRows.filter(row => cachePolicy.requiredFinanceFields.some(field => pendingFinanceReport(noticeResponses.get(row.symbol), row.symbol, screener.clock(), row, field)));
    if (reportSyncRows.length) {
      // A fresh directory can expose a formal report newer than the cached
      // financial response. Retry that response once, never replace it with a
      // forecast, and retain the explicit pending period if the provider lags.
      const refreshed = await screener.scanFinance({ ...original, rows: reportSyncRows }, commonQuery, [], true, signal, scanTime,
        { ...cachePolicy, refreshQuantitative: true });
      assertActive(signal);
      const updates = new Map(refreshed.rows.map(row => [row.symbol, row]));
      for (const row of reportSyncRows) {
        Object.assign(row, updates.get(row.symbol));
        const template = screeningMode === 'strict' ? financeTemplateCheck(row, screener.clock()) : null;
        const shared = template && template.status !== 'pass' ? template : { ...classifyScreenRow(row, commonQuery), stage: 'finance' };
        common.set(row.symbol, shared);
        const checks = preliminary.get(row.symbol).checks;
        for (const id of policy.priority) {
          // Finance refresh cannot change quote-only risk decisions, but a
          // revised financial value must affect every strategy that uses it.
          if (shared.status !== 'pass') checks[id] = shared;
          else if (strategies[id].query.rules.some(rule => [rule.field, rule.valueField].some(field => FIELDS[field]?.source === 'finance'))) {
            checks[id] = checkStrategy(row, strategies[id].query, scanTime, expectedQuoteDate, expectedDailyDate, allowedQuoteDates, id === 'long', screener.clock());
          }
        }
      }
    }
    // Valid sensitive titles request original documents after quantitative
    // selection. Missing/stale indexes and explicit adverse titles stay gated.
    const evidenceRows = researchRequired ? noticeRows.filter(row => {
      const notice = noticeChecks.get(row.symbol);
      return notice.status === 'pass' || notice.status === 'pending' && notice.evaluation.coverageComplete && notice.evaluation.notices?.length;
    }) : [];
    if (researchRequired) screener.evidenceRetention?.([...new Set([...required, ...evidenceRows.map(row => row.symbol)])]);
    const evidenceChecks = new Map(), evidenceSummary = { pass: 0, failed: 0, pending: 0, checks: {} };
    const evidenceBundles = new Map(), researchStatuses = new Map();
    const updateReview = (row, evaluation, notice, researchStatus = evaluation.status) => {
      const checks = evaluation.checks.filter(check => check.key !== 'noticeBodyReview');
      if (notice.mode === 'automatic-fulltext' || notice.status !== 'clear') checks.push({ key: 'noticeBodyReview', label: notice.mode === 'automatic-fulltext' ? '敏感公告原文核验' : '公告目录与时点核验',
        status: notice.status === 'clear' ? 'pass' : notice.status === 'blocked' ? 'fail' : 'pending',
        reason: notice.reasons.join('；'), records: notice.notices.flatMap(item => item.records || []) });
      evaluation = { ...evaluation, checks, noticeReview: notice,
        status: researchStatus === 'fail' || notice.status === 'blocked' ? 'fail' : researchStatus === 'pending' || notice.status !== 'clear' ? 'pending' : 'pass',
        records: [...new Map(checks.flatMap(check => check.records || []).map(record => [record.id, record])).values()] };
      const status = evaluation.status === 'fail' ? 'failed' : evaluation.status;
      evidenceChecks.set(row.symbol, { status, reasons: checks.filter(check => check.status !== 'pass').map(check => `${check.label}：${check.reason}`), evaluation });
      noticeChecks.set(row.symbol, { ...noticeChecks.get(row.symbol), status: notice.status === 'clear' ? 'pass' : notice.status === 'blocked' ? 'failed' : 'pending', reasons: notice.reasons, evaluation: notice });
    };
    screener.progress = { loading: true, stage: 'evidence', completed: 0, total: evidenceRows.length, quantitativeCandidates: noticeRows.length };
    const evidenceStartedAt = screener.clock().getTime();
    next = 0;
    await Promise.all(Array.from({ length: Math.min(3, evidenceRows.length) }, async () => {
      while (next < evidenceRows.length && !signal.aborted) {
        const row = evidenceRows[next++];
        let evaluation;
        try {
          if (!screener.automaticEvidenceLoader) throw Error('公开研究资料采集服务未配置');
          const bundle = await cancellable(screener.automaticEvidenceLoader(row.symbol, { signal, force, retryFailed: retryEvidence,
            onProgress: detail => { if (!signal.aborted && screener.activeRun === controller) screener.progress.detail = { ...detail, name: row.name || row.symbol }; }
          }), signal);
          if (bundle?.symbol !== row.symbol) throw Error('研究资料股票代码不符');
          evidenceBundles.set(row.symbol, bundle);
          evaluation = evaluateCompanyEvidence(bundle, commonQuery.evidence, screener.clock());
          evaluation.collection = collectionSummary(bundle, evaluation);
        } catch (error) {
          assertActive(signal);
          evaluation = { symbol: row.symbol, mode: 'automatic', ruleVersion: COMPANY_EVIDENCE_RULE_VERSION, status: 'pending', checkedAt: screener.clock().toISOString(),
            ...(industry ? { industryReview: { version: 1, scope: industry.scope, checkedAt: screener.clock().toISOString(), status: 'pending',
              reason: `行业资料获取或核验失败：${error.message}`, rows: [] } } : {}),
            collection: { complete: false, issues: [{ ...(error.acquisition || {}), message: error.message }] },
            records: [], checks: [{ key: 'source', label: '公开研究资料', status: 'pending', reason: `资料获取或核验失败：${error.message}`, records: [] }] };
        }
        assertActive(signal);
        researchStatuses.set(row.symbol, evaluation.status);
        updateReview(row, evaluation, reviewNoticeEvidence(noticeChecks.get(row.symbol).evaluation, evidenceBundles.get(row.symbol), row.symbol, screener.clock()));
        // Full bundles can be hundreds of MB. Only retain sensitive notice
        // documents needed for the final fresh-index check in this scan.
        const bundle = evidenceBundles.get(row.symbol);
        if (bundle) {
          const sensitiveIds = new Set(noticeChecks.get(row.symbol).evaluation.notices.map(notice => notice.id));
          evidenceBundles.set(row.symbol, { symbol: bundle.symbol, fetchedAt: bundle.fetchedAt,
            documents: bundle.documents?.filter(document => document.kind === 'notice' && sensitiveIds.has(document.id)) || [],
            ...(bundle.errors ? { errors: bundle.errors } : {}), ...(bundle.acquisition ? { acquisition: bundle.acquisition } : {}) });
        }
        screener.progress.completed++;
      }
    }));
    markStage('evidence', evidenceStartedAt);
    assertActive(signal);
    // Ordinary monitors need only the sensitive announcements in their current
    // directory. This path does not collect annual reports or industry evidence.
    const noticeOnlyRows = !researchRequired && screener.noticeEvidenceLoader ? noticeRows.filter(row => {
      const notice = noticeChecks.get(row.symbol).evaluation;
      return notice.status === 'unverified' && notice.coverageComplete && notice.notices.length;
    }) : [];
    const noticeBodyStartedAt = screener.clock().getTime();
    if (noticeOnlyRows.length) {
      screener.progress = { loading: true, stage: 'noticeEvidence', completed: 0, total: noticeOnlyRows.length };
      next = 0;
      await Promise.all(Array.from({ length: Math.min(3, noticeOnlyRows.length) }, async () => {
        while (next < noticeOnlyRows.length && !signal.aborted) {
          const row = noticeOnlyRows[next++];
          let response = noticeResponses.get(row.symbol), bundle;
          try {
            if (!Number.isFinite(response?.fetchedAt) || screener.clock().getTime() - response.fetchedAt > NOTICE_RISK_POLICY.noticeMaxAgeMs) {
              response = await cancellable(screener.noticeLoader(row.symbol, signal, true), signal);
              noticeResponses.set(row.symbol, response);
            }
            bundle = await cancellable(screener.noticeEvidenceLoader(row.symbol, { noticeResponse: response, signal, retryFailed: retryEvidence,
              onProgress: detail => { if (!signal.aborted && screener.activeRun === controller) screener.progress.detail = { ...detail, name: row.name || row.symbol }; }
            }), signal);
            if (bundle?.symbol !== row.symbol) throw Error('公告原文股票代码不符');
          } catch (error) {
            assertActive(signal);
            const failure = { ...(error.acquisition || {}), stage: error.acquisition?.stage || 'body', code: error.acquisition?.code || 'notice-body-fetch', message: error.message || '公告原文获取失败' };
            const notices = checkNoticeRisk(response, row.symbol, screener.clock()).notices || [];
            bundle = { symbol: row.symbol, fetchedAt: screener.clock().getTime(), documents: [],
              errors: notices.length ? notices.map(notice => ({ ...failure, documentId: notice.id })) : [failure] };
          }
          assertActive(signal);
          evidenceBundles.set(row.symbol, bundle);
          const notice = checkNoticeWithEvidence(response, row.symbol, bundle, screener.clock());
          noticeChecks.set(row.symbol, { status: notice.status === 'clear' ? 'pass' : notice.status === 'blocked' ? 'failed' : 'pending',
            reasons: notice.reasons, evaluation: notice, ...noticeAcquisition(response) });
          screener.progress.completed++;
        }
      }));
    }
    if (noticeOnlyRows.length) markStage('noticeEvidence', noticeBodyStartedAt);
    assertActive(signal);
    const researchReviews = new Map();
    if (metricQuery) {
      // Announcement uncertainty must not hide independently available operating
      // metrics. Eligibility still combines every required gate below.
      const metricRows = noticeRows;
      screener.progress = { loading: true, stage: 'operatingResearch', completed: 0, total: metricRows.length };
      if (metricQuery.enabled && metricQuery.path === 'product') screener.evidenceRetention?.([...new Set([...required, ...metricRows.map(row => row.symbol)])]);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(3, metricRows.length) }, async () => {
        while (cursor < metricRows.length && !signal.aborted) {
          const row = metricRows[cursor++]; let bundle;
          if (metricQuery.enabled && metricQuery.path === 'product') {
            try {
              if (!screener.automaticEvidenceLoader) throw Error('产品原文服务未配置');
              bundle = await cancellable(screener.automaticEvidenceLoader(row.symbol, { signal, force, retryFailed: retryEvidence, includeIndustry: false,
                onProgress: detail => { if (!signal.aborted && screener.activeRun === controller) screener.progress.detail = { ...detail, name: row.name || row.symbol }; } }), signal);
              if (bundle?.symbol !== row.symbol) throw Error('产品资料股票代码不符');
            } catch (error) { assertActive(signal); bundle = { symbol: row.symbol, documents: [], errors: [error.message] }; }
          }
          let review;
          try { review = evaluateOperatingResearch(bundle, metricQuery, { company: row, now: screener.clock(), symbol: row.symbol }); }
          catch (error) {
            assertActive(signal);
            bundle = { symbol: row.symbol, documents: [], errors: [`产品资料核验失败：${error.message}`] };
            review = evaluateOperatingResearch(bundle, metricQuery, { company: row, now: screener.clock(), symbol: row.symbol });
          }
          researchReviews.set(row.symbol, review);
          if (bundle) {
            const old = evidenceBundles.get(row.symbol)?.documents || [];
            evidenceBundles.set(row.symbol, { symbol: row.symbol, fetchedAt: bundle.fetchedAt,
              documents: [...new Map([...old, ...(bundle.documents || []).filter(document => document.kind === 'notice')].map(document => [document.id, document])).values()] });
          }
          screener.progress.completed++;
        }
      }));
      assertActive(signal);
    }
    // Full reports can take longer than the notice freshness window. Refresh
    // expired notice data for qualified companies before publishing eligibility.
    const finalNoticeRows = researchRequired ? evidenceRows.filter(row => researchStatuses.get(row.symbol) === 'pass')
      : noticeRows.filter(row => noticeChecks.get(row.symbol).status === 'pass' || noticeOnlyRows.includes(row));
    const finalNoticeStartedAt = screener.clock().getTime();
    next = 0;
    await Promise.all(Array.from({ length: Math.min(3, finalNoticeRows.length) }, async () => {
    while (next < finalNoticeRows.length && !signal.aborted) {
      const row = finalNoticeRows[next++];
      let response = noticeResponses.get(row.symbol);
      if (!Number.isFinite(response?.fetchedAt) || screener.clock().getTime() - response.fetchedAt > NOTICE_RISK_POLICY.noticeMaxAgeMs) {
        try { response = await cancellable(screener.noticeLoader(row.symbol, signal, true), signal); }
        catch (error) { assertActive(signal); response = { error: error.message }; }
      }
      noticeResponses.set(row.symbol, response);
      const notice = checkNoticeWithEvidence(response, row.symbol, evidenceBundles.get(row.symbol), screener.clock());
      noticeChecks.set(row.symbol, { status: notice.status === 'clear' ? 'pass' : notice.status === 'blocked' ? 'failed' : 'pending', reasons: notice.reasons, evaluation: notice,
        ...noticeAcquisition(response) });
      if (researchRequired) updateReview(row, evidenceChecks.get(row.symbol).evaluation, notice, researchStatuses.get(row.symbol));
    }
    }));
    assertActive(signal);
    // A slow later refresh can expire an earlier response again. Apply a single
    // final boundary without an unbounded refresh-until-everything-is-new loop.
    const publishTime = screener.clock();
    for (const row of evidenceRows) {
      const current = evidenceChecks.get(row.symbol)?.evaluation;
      if (!current) continue;
      // Recheck the original source timestamps; a later batch must not extend
      // an earlier company's permission by updating its evaluation time.
      const refreshed = refreshCompanyEvidence(current, publishTime);
      researchStatuses.set(row.symbol, refreshed.status);
      updateReview(row, refreshed, noticeChecks.get(row.symbol).evaluation, refreshed.status);
    }
    for (const row of noticeRows) if (researchReviews.has(row.symbol)) {
      researchReviews.set(row.symbol, refreshOperatingResearch(researchReviews.get(row.symbol), { company: row, now: publishTime }));
    }
    for (const row of finalNoticeRows) {
      const notice = checkNoticeWithEvidence(noticeResponses.get(row.symbol), row.symbol, evidenceBundles.get(row.symbol), publishTime);
      if (researchRequired) updateReview(row, evidenceChecks.get(row.symbol).evaluation, notice, researchStatuses.get(row.symbol));
      else noticeChecks.set(row.symbol, { status: notice.status === 'clear' ? 'pass' : notice.status === 'blocked' ? 'failed' : 'pending',
        reasons: notice.reasons, evaluation: notice, ...noticeAcquisition(noticeResponses.get(row.symbol)) });
    }
    const performanceReviews = new Map();
    const pendingReports = new Map();
    for (const row of noticeRows) {
      const pendingReport = latestDisclosedReport(noticeResponses.get(row.symbol), row.symbol, publishTime, row.financeReportDate);
      if (pendingReport) {
        pendingReports.set(row.symbol, pendingReport);
        const review = researchReviews.get(row.symbol);
        if (metricQuery?.enabled && metricQuery.path === 'company' && review) {
          const reason = reportSyncReason(pendingReport);
          researchReviews.set(row.symbol, { ...review, status: 'pending', pendingReport,
            companyMetrics: { ...review.companyMetrics, status: 'pending', reason, pendingReport,
              metrics: Object.fromEntries(Object.entries(review.companyMetrics?.metrics || {}).map(([field, cell]) => [field, { ...cell, usable: false, reason, reasonCode: 'formal-report-pending' }])) },
            assessment: { ...review.assessment, status: 'pending', passed: false, blocksEntry: true, reasons: [reason] } });
        }
      }
      if (performanceQuery) performanceReviews.set(row.symbol, evaluatePerformanceRules(performanceQuery, noticeChecks.get(row.symbol)?.evaluation, { symbol: row.symbol, now: publishTime }));
    }
    markStage('noticeRecheck', finalNoticeStartedAt);
    for (const { status, evaluation } of evidenceChecks.values()) {
      evidenceSummary[status]++;
      for (const check of evaluation.checks) {
        const counts = evidenceSummary.checks[check.key] ||= { label: check.label, pass: 0, failed: 0, pending: 0 };
        counts[check.status === 'fail' ? 'failed' : check.status]++;
      }
    }
    assertActive(signal);
    for (const { row, checks } of preliminary.values()) {
      for (const id of policy.priority) {
        let checked = checks[id];
        const evidence = evidenceChecks.get(row.symbol), notice = noticeChecks.get(row.symbol), operating = researchReviews.get(row.symbol), performanceReview = performanceReviews.get(row.symbol);
        const requireTemplate = id === 'long' || screeningMode === 'strict';
        const financeCheck = financialConditionCheck(row, strategies[id].query, publishTime, noticeResponses.get(row.symbol), requireTemplate);
        if (requireTemplate && !['quotes', 'common'].includes(checked.stage)) {
          const template = financeTemplateCheck(row, publishTime);
          if (template.status !== 'pass') checked = template;
        }
        const pendingReport = financeCheck?.pendingReport || (metricQuery?.enabled && metricQuery.path === 'company' ? pendingReports.get(row.symbol) : null);
        if (row.financeSourceSnapshot && checked.stage !== 'quotes' && financeCheck?.checks.some(check => check.pendingFields?.length)) {
          const currentRow = { ...row };
          for (const field of financeCheck.checks.flatMap(check => check.pendingFields || [])) currentRow[field] = null;
          checked = checkStrategy(currentRow, strategies[id].query, scanTime, expectedQuoteDate, expectedDailyDate, allowedQuoteDates, requireTemplate, publishTime);
          if (checked.status === 'pending') checked = { ...checked, reasons: [...new Set([...checked.reasons, ...financeCheck.reasons])], stage: 'finance' };
        }
        if (checked.status === 'pass' && notice?.status !== 'pass') checked = { ...notice, stage: 'notices' };
        if (researchRequired && checked.status === 'pass' && evidence?.status !== 'pass') checked = { ...evidence, stage: 'evidence' };
        if (metricQuery?.enabled && checked.status === 'pass' && operating?.status !== 'pass') checked = {
          status: operating?.status === 'failed' ? 'failed' : 'pending', reasons: operating?.assessment?.reasons?.length ? operating.assessment.reasons : ['经营指标资料尚未完成核验'], stage: 'research' };
        if (performanceQuery?.enabled && checked.status === 'pass' && performanceReview?.status !== 'pass') checked = {
          status: performanceReview?.status === 'failed' ? 'failed' : 'pending', reasons: performanceReview?.reasons?.length ? performanceReview.reasons : ['业绩预告/快报条件尚未完成核验'], stage: 'performance' };
        const extra = { ...(checked.technicalError ? { technicalError: checked.technicalError, technicalErrorDetail: checked.technicalErrorDetail || null } : {}),
          diagnostics: rowDiagnostics(row, checked, evidence?.evaluation, operating, notice?.evaluation),
          ...(evidence ? { evidenceReview: evidence.evaluation } : {}),
          ...(operating ? { researchReview: operating } : {}),
          ...(financeCheck ? { financeCheck } : {}),
          ...(performanceReview ? { performanceReview } : {}), ...(pendingReport ? { pendingReport } : {}),
          ...(notice?.evaluation ? { noticeReview: notice.evaluation } : {}), ...(checked.status === 'pass'
          ? { ...(evidence ? { selectionEvidence: evidence.evaluation } : {}), entryRisk: { status: 'clear', notices: notice.evaluation }, observedQuoteDate: cnTime(row.timestamp).date } : {}) };
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
    const coverage = { screeningMode, researchRequired, diagnostics: poolDiagnostics(strategies), universeComplete: true, universeCount: original.rows.length, sourceCount: original.sourceCount ?? original.rows.length,
      excludedCount: original.excludedCount || 0, requiredMissing: missingSymbols, commonPassed: commonRows.length,
      commonFailed: [...common.values()].filter(check => check.status === 'failed').length,
      commonPending: [...common.values()].filter(check => check.status === 'pending').length,
      financeFailures: financial.financeScan?.failures || {}, technicalFailures: daily.technicalScan?.failures || {},
      quantitativeCandidates: noticeRows.length, evidenceChecked: evidenceRows.length, evidenceSummary, financeChecked: financeRows.length, technicalChecked: dailyRows.length,
      ...(metricQuery ? { operatingResearch: { path: metricQuery.path, enabled: metricQuery.enabled, evaluated: researchReviews.size,
        ...Object.fromEntries(['pass', 'failed', 'pending', 'observing'].map(status => [status, [...researchReviews.values()].filter(review => review.status === status).length])) } } : {}),
      ...(performanceQuery ? { performance: { enabled: performanceQuery.enabled, evaluated: performanceReviews.size,
        ...Object.fromEntries(['pass', 'failed', 'pending', 'observing'].map(status => [status, [...performanceReviews.values()].filter(review => review.status === status).length])) } } : {}),
      quantitativeStages, timings, cache: { finance: financial.financeScan?.cache || null, daily: daily.technicalScan?.cache || null },
      noticesChecked: noticeRows.length, noticeFulltextChecked: noticeOnlyRows.length, counts, partial: anyPending };
    screener.progress = { loading: true, stage: 'complete', completed: original.rows.length, total: original.rows.length };
    return { status: anyPass ? 'ready' : anyPending ? 'unavailable' : 'empty', startedAt, finishedAt: screener.clock().getTime(), policyVersion: policy.version, screeningMode,
      commonQuery, coverage, strategies,
      sources: { quotes: { source: original.source || '来源未标注', fetchedAt: original.fetchedAt ?? null, ...quoteRange(original.rows) },
        finance: financial.financeScan || null, technical: daily.technicalScan || null, scanTime: scanTime.toISOString(), expectedQuoteDate, allowedQuoteDates, expectedDailyDate,
        evidence: researchRequired ? `公开披露资料程序核验（规则版本 ${COMPANY_EVIDENCE_RULE_VERSION}）` : metricQuery?.enabled ? `${metricQuery.path === 'product' ? '同一产品原始指标' : '公司经营指标'}条件核验` : '按策略筛选不要求公司研究报告', notices: '东方财富近 14 日公告目录及按需敏感公告原文；未核验或风险未通过时阻断',
        note: '候选筛选使用最近有效行情与完整日线；不代表当前可成交，实际新开仓仍重新核验实时条件。' } };
  } finally {
    // Cache housekeeping cannot strand the scan lock or change eligibility.
    try { if (researchRequired || metricQuery?.enabled && metricQuery.path === 'product') screener.endEvidenceBatch?.(); } catch {}
    if (screener.activeRun === controller) screener.activeRun = null;
    screener.progress.loading = false;
  }
}

module.exports = { AGENCY_POOL_POLICY, poolPolicy, financialConditionCheck, runAgencyScreening };
