'use strict';
const { cnTime } = require('./common.cjs');
const { latestDisclosedReport, reportSyncReason } = require('./financial-report-status.cjs');
const { classifyFinanceApplicability } = require('./industry-applicability.cjs');
const FINANCE_MAX_AGE_MS = 21600000;
const numeric = value => !['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const SPECS = {
  roe: { raw: 'roe', unit: '%' }, debtRatio: { raw: 'debtRatio', unit: '%', min: 0 }, revenueYoY: { raw: 'revenueYoY', unit: '%' },
  profitYoY: { raw: 'profitYoY', unit: '%' }, adjustedProfitYoY: { raw: 'adjustedProfitYoY', unit: '%' },
  operatingCash: { raw: 'operatingCash', unit: '亿元', money: true }, latestAdjustedProfit: { raw: 'adjustedProfit', unit: '亿元', money: true },
  annualRoeLatest: { raw: 'roe', unit: '%', annual: true }, annualRoeAverage: { raw: 'roe', unit: '%', annual: true, aggregate: 'average' },
  annualProfitableYears: { raw: 'adjustedProfit', unit: '年', annual: true, aggregate: 'positive', money: true },
  annualCashPositiveYears: { raw: 'operatingCash', unit: '年', annual: true, aggregate: 'positive', money: true },
  annualCashSum: { raw: 'operatingCash', unit: '亿元', annual: true, aggregate: 'sum', money: true }
};
const LABELS = { roe: '加权净资产收益率', debtRatio: '资产负债率', revenueYoY: '营收同比', profitYoY: '归母净利润同比',
  adjustedProfitYoY: '扣非净利润同比', operatingCash: '经营现金流净额', latestAdjustedProfit: '最新报告期扣非净利润',
  annualRoeLatest: '最近一年年度ROE', annualRoeAverage: '近三年平均年度ROE', annualProfitableYears: '近三年扣非盈利年数',
  annualCashPositiveYears: '近三年经营现金流为正年数', annualCashSum: '近三年经营现金流合计' };
function minimumFinanceReportDate(today, annual = false) {
  const year = Number(today.slice(0, 4)), month = today.slice(5, 10);
  if (annual) return `${year - (month < '05-01' ? 2 : 1)}-12-31`;
  return month >= '11-01' ? `${year}-09-30` : month >= '09-01' ? `${year}-06-30` : month >= '05-01' ? `${year}-03-31` : `${year - 1}-09-30`;
}
function financeResponseIssue(result, symbol, checkedAt = new Date()) {
  const at = new Date(checkedAt).getTime();
  if (!Number.isFinite(at)) return { code: 'invalid', reason: '财务核验时间无效' };
  if (!result || result.symbol !== symbol || result.section !== 'finance') return { code: 'invalid', reason: '财务资料股票代码或模块不符' };
  if (result.source !== '东方财富') return { code: 'invalid', reason: '财务资料来源无法验证，仅接受东方财富' };
  if (result.error || ['stale', 'unavailable'].includes(result.status)) return { code: 'fetch', reason: '财务资料获取失败或已过期' };
  if (!['ready', 'empty'].includes(result.status)) return { code: 'invalid', reason: '财务资料状态无效' };
  if (result.status === 'empty') return { code: 'missing', reason: '暂无可用财务报告' };
  if (!result.data?.latest && !result.data?.annual?.length) return { code: 'missing', reason: '暂无可用财务报告' };
  if (!Number.isFinite(result.fetchedAt) || result.fetchedAt <= 0 || result.fetchedAt > at) return { code: 'invalid', reason: '财务资料获取时点无法验证' };
  if (at - result.fetchedAt > FINANCE_MAX_AGE_MS) return { code: 'fetch', reason: '财务资料获取时间超过 6 小时，等待刷新' };
  return null;
}
function reportIssue(report, today, annual) {
  if (!report || !validDate(report.reportDate) || !(annual ? /-12-31$/ : /-(03-31|06-30|09-30|12-31)$/).test(report.reportDate)
    || !validDate(report.noticeDate) || report.noticeDate < report.reportDate || report.reportDate > today || report.noticeDate > today
    || report.updateDate != null && (!validDate(report.updateDate) || report.updateDate < report.reportDate || report.updateDate > today)) return '财务报告期、公告日期或更新日期无法验证';
  return '';
}
function buildFinanceSnapshot(result, symbol, now = new Date(), { checkedAt = now, notices = null } = {}) {
  const observedAt = new Date(now).getTime(), today = Number.isFinite(observedAt) ? cnTime(now).date : '',
    checkedDate = Number.isFinite(new Date(checkedAt).getTime()) ? cnTime(checkedAt).date : today,
    responseIssue = financeResponseIssue(result, symbol, checkedAt), latest = result?.data?.latest || null;
  const reports = (Array.isArray(result?.data?.annual) ? result.data.annual : []).filter(report => report && typeof report === 'object').map(report => ({ ...report }));
  if (!reportIssue(latest, today, true) && !reports.some(report => report.reportDate === latest.reportDate)) reports.push({ ...latest });
  reports.sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)));
  const annual = reports.slice(0, 3), checks = {};
  for (const [field, spec] of Object.entries(SPECS)) {
    const report = spec.annual ? annual[0] : latest, basis = spec.annual ? 'annual' : 'latest-disclosed-cumulative';
    const invalidReport = reportIssue(report, today, spec.annual);
    let reason = responseIssue?.reason || invalidReport, reasonCode = responseIssue?.code || (invalidReport ? report ? 'invalid' : 'missing' : null), rawValue = numeric(report?.[spec.raw]);
    if (!reason && report.reportDate < minimumFinanceReportDate(checkedDate, spec.annual)) {
      reason = `报告未覆盖最低适用报告期 ${minimumFinanceReportDate(checkedDate, spec.annual)}（${spec.annual ? '年度' : '累计'}口径）；新抓取时间不能使旧报告重新有效`;
      reasonCode = 'stale-period';
    }
    const pendingReport = latestDisclosedReport(notices, symbol, checkedAt, report?.reportDate, { annualOnly: !!spec.annual });
    if (!reason && pendingReport) { reason = reportSyncReason(pendingReport); reasonCode = 'formal-report-pending'; }
    if (spec.aggregate) {
      const year = Number(String(annual[0]?.reportDate).slice(0, 4));
      const continuous = annual.length === 3 && annual.every((item, index) => !reportIssue(item, today, true) && Number(item.reportDate.slice(0, 4)) === year - index);
      if (!continuous) { reason ||= '缺少连续三个有效完整年度的财务报告，不能用季度报告或零值补齐'; rawValue = null; }
      else if (annual.some(item => numeric(item[spec.raw]) === null)) { reason ||= '部分年度指标缺失，不能用零补齐'; rawValue = null; }
      else rawValue = spec.aggregate === 'positive' ? annual.filter(item => numeric(item[spec.raw]) > 0).length
        : annual.reduce((sum, item) => sum + numeric(item[spec.raw]), 0) / (spec.aggregate === 'average' ? 3 : 1);
      if (spec.money && annual.some(item => item.currency !== 'CNY')) reason ||= '年度金额币种未确认人民币';
    } else if (spec.money && report?.currency !== 'CNY') reason ||= '金额币种未确认人民币，不能按亿元比较';
    if (spec.money && spec.unit === '亿元' && rawValue !== null) rawValue /= 1e8;
    if (rawValue === null || spec.min != null && rawValue < spec.min) reason ||= `${LABELS[field]}缺失、单位不明或数值无效；缺失不等于零`;
    checks[field] = { status: reason ? 'pending' : 'ready', reason, reasonCode: reason ? reasonCode || 'missing-value' : null, reportDate: report?.reportDate || null, noticeDate: report?.noticeDate || null,
      updateDate: report?.updateDate || null, source: result?.source || null, fetchedAt: result?.fetchedAt ?? null, basis, unit: spec.unit,
      value: reason ? null : rawValue, rawValue, currency: report?.currency || null, ...(pendingReport ? { pendingReport } : {}) };
  }
  const annualChecks = Object.entries(checks).filter(([field]) => field.startsWith('annual')).map(([, check]) => check);
  return { symbol, ...Object.fromEntries(Object.entries(checks).map(([field, check]) => [field, check.value])), financeFieldChecks: checks,
    financeApplicability: classifyFinanceApplicability(result?.industryProfile, symbol, checkedAt),
    financeReportDate: latest?.reportDate || null, financeNoticeDate: latest?.noticeDate || null, financeUpdateDate: latest?.updateDate || null,
    financeCurrency: latest?.currency || null, financeFetchedAt: result?.fetchedAt ?? null, financeSource: result?.source || '来源未标注',
    financeReportVersion: [latest?.reportDate, latest?.noticeDate, latest?.updateDate || latest?.noticeDate].join('/'),
    financeAnnualReports: annual, financeAnnualStatus: annualChecks.every(check => check.status === 'ready') ? 'ready' : 'pending',
    financeAnnualReason: [...new Set(annualChecks.map(check => check.reason).filter(Boolean))].join('；') || '连续三个有效完整年度，年度指标独立核验',
    financeObservedAt: Number.isFinite(observedAt) ? observedAt : null,
    financeSourceSnapshot: result ? structuredClone(result) : null, ...(responseIssue ? { financeError: responseIssue.code } : {}) };
}
function sourceFromNormalized(row, symbol) {
  if (row?.financeSourceSnapshot) return row.financeSourceSnapshot;
  return { symbol: row?.symbol || symbol, section: 'finance', source: row?.financeSource, status: row?.financeError ? 'unavailable' : 'ready', fetchedAt: row?.financeFetchedAt,
    industryProfile: row?.industryProfile,
    data: { latest: { reportDate: row?.financeReportDate, noticeDate: row?.financeNoticeDate, updateDate: row?.financeUpdateDate, currency: row?.financeCurrency,
      ...Object.fromEntries(Object.entries(SPECS).filter(([, spec]) => !spec.annual).map(([field, spec]) => [spec.raw, Number.isFinite(row?.[field]) ? row[field] * (spec.money ? 1e8 : 1) : null])) }, annual: row?.financeAnnualReports || [] } };
}
function refreshFinanceSnapshot(row, symbol, now = new Date(), options = {}) {
  // Publication checks advance freshness/deadline checks, never the original
  // information boundary of a scan that may have crossed midnight.
  const observedAt = Number.isFinite(row?.financeObservedAt) ? new Date(row.financeObservedAt) : now;
  return { ...row, ...buildFinanceSnapshot(sourceFromNormalized(row, symbol), symbol, observedAt, { ...options, checkedAt: options.checkedAt ?? now }) };
}
module.exports = { FINANCE_MAX_AGE_MS, minimumFinanceReportDate, financeResponseIssue, buildFinanceSnapshot, refreshFinanceSnapshot };
