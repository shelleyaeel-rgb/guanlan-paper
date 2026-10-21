'use strict';
const { symbolOf, cnTime } = require('./common.cjs');
const { buildProductMetrics } = require('./company-product-metrics.cjs');
const { validateResearchRules, evaluateResearchRules, buildCompanyMetrics, minimumCoveredReportDate } = require('./research-rules.cjs');
const { knownProductRiskSignals } = require('./company-evidence.cjs');
const { latestDisclosedReport, reportSyncReason } = require('./financial-report-status.cjs');

const timestamp = value => typeof value === 'string' ? Date.parse(value) : value;
const ageValid = (value, now) => Number.isFinite(timestamp(value)) && timestamp(value) > 0
  && timestamp(value) <= now && now - timestamp(value) <= 21600000;

function acquisitionDiagnostics(bundle) {
  if (!bundle) return [{ code: 'not-requested', label: '产品资料尚未获取', reason: '当前可先查看公司经营指标；产品指标需读取公开报告', action: '读取产品资料', retryable: true }];
  const items = [], add = item => items.push(item);
  for (const issue of [...(bundle.acquisition?.issues || []), ...(bundle.coverage?.documentFailures || [])]) {
    if (issue.recovered) continue;
    const reason = issue.message || issue.reason || '本次资料未取得', parse = issue.stage === 'parse' || /解析|OCR|文字识别/.test(reason);
    add({ code: parse ? 'parse-failed' : 'fetch-failed', label: parse ? '原文解析未完成' : '资料获取未完成', reason,
      documentId: issue.documentId || issue.id || null, action: '重试缺失资料', retryable: true });
  }
  for (const key of ['annualReport', 'semiannualReport']) {
    const report = bundle.coverage?.[key];
    if (report && !['ready', 'available'].includes(report.status)) add({ code: report.id ? 'document-unavailable' : 'not-located',
      label: report.id ? '已定位报告，原文尚不可用' : '公告源尚未定位报告', documentId: report.id || null,
      reason: report.reason || '尚未取得可核验原文，不能据此认定公司未披露', action: '重试资料或核对原始公告', retryable: true });
  }
  for (const reason of bundle.errors || []) add({ code: /解析|OCR/.test(reason) ? 'parse-failed' : 'fetch-failed',
    label: '资料补取提示', reason, action: '重试缺失资料', retryable: true });
  return [...new Map(items.map(item => [`${item.code}:${item.documentId}:${item.reason}`, item])).values()].slice(0, 40);
}

function productSourceIssues(bundle, metrics, now) {
  const issues = [];
  if (!bundle || !ageValid(bundle.checkedAt ?? bundle.fetchedAt, now.getTime())
    || bundle.fetchedAt != null && !ageValid(bundle.fetchedAt, now.getTime())) issues.push('产品资料检查时间缺失、超过 6 小时或晚于本次核验');
  if (bundle?.coverage?.noticeIndexComplete !== true) issues.push('公告目录尚未核验完整，无法确认当前适用的产品报告');
  const today = cnTime(now).date, expected = minimumCoveredReportDate(today);
  const knownDates = [expected, bundle?.coverage?.annualReport?.reportDate, bundle?.coverage?.semiannualReport?.reportDate]
    .filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= today).sort();
  if (!metrics.reportDate || metrics.reportDate < knownDates.at(-1)) issues.push(`当前可核验产品报告未覆盖 ${knownDates.at(-1)}，旧数据仅供查看`);
  return issues;
}

function metricSourceDiagnostics(metrics) {
  return (metrics.diagnostics || []).map(item => {
    const missingRows = item.reasonCode === 'supported-product-rows-not-extracted';
    const textMissing = item.reasonCode === 'native-text-not-available';
    return { code: missingRows ? 'metrics-not-extracted' : textMissing ? 'parse-failed' : 'source-unverified',
      documentId: item.sourceDocumentId || null, reasonCode: item.reasonCode,
      label: missingRows ? '原文已取得，产品指标尚未提取' : textMissing ? '可核验的原生文字尚未取得' : '报告身份或完整性待核验',
      reason: item.reason || (missingRows ? '当前支持的表格解析尚未取得可靠的产品行；不代表公司没有披露产品数据'
        : textMissing ? '现有文字或扫描页不足以可靠提取数值，不能据此补零' : '报告的来源、期间、时点或逐页完整性未通过检查，不能用于自动判断'),
      action: missingRows ? '核对原始报告或使用公司经营路径' : '重试资料并核对原文', retryable: !missingRows };
  });
}

function assessResearch(query, symbol, productMetrics, companyMetrics, riskSignals, date) {
  const assessment = evaluateResearchRules(query, { symbol, productMetrics, companyMetrics }, date);
  if (query?.enabled && riskSignals.length) {
    assessment.status = riskSignals.some(item => item.status === 'fail') ? 'failed' : 'pending';
    assessment.passed = false; assessment.blocksEntry = true;
    assessment.reasons = [...(assessment.reasons || []), ...riskSignals.map(item => `${item.subject}：${item.reason}`)];
  }
  return assessment;
}

// Recheck at the publication boundary without retaining or reparsing every PDF
// in a large batch. The original acquisition times never advance here.
function currentCompanyMetrics(company, symbol, date, notices) {
  const metrics = buildCompanyMetrics(company, { symbol, now: date });
  const pendingReport = latestDisclosedReport(notices, symbol, date, company?.financeReportDate);
  if (pendingReport) {
    metrics.status = 'pending'; metrics.pendingReport = pendingReport; metrics.reason = reportSyncReason(pendingReport);
    for (const cell of Object.values(metrics.metrics || {})) { cell.usable = false; cell.reasonCode = 'formal-report-pending'; cell.reason = metrics.reason; }
  }
  return metrics;
}

function refreshOperatingResearch(review, { company = null, now = new Date(), notices = null } = {}) {
  const date = new Date(now), next = structuredClone(review);
  const issues = productSourceIssues(next.productSource, next.productMetrics, date);
  next.productMetrics.sourceIssues = issues;
  if (issues.length) for (const product of next.productMetrics.products || []) for (const cell of Object.values(product.metrics || {})) {
    cell.usable = false; cell.reasonCode = 'source-unverified';
    cell.reason = [...new Set([cell.reason, ...issues].filter(Boolean))].join('；');
  }
  next.companyMetrics = currentCompanyMetrics(company, next.symbol, date, notices);
  next.assessment = assessResearch(next.query, next.symbol, next.productMetrics, next.companyMetrics, next.riskSignals || [], date);
  next.status = next.assessment.status; next.checkedAt = date.toISOString();
  return next;
}

function evaluateOperatingResearch(bundle, input, { company = null, now = new Date(), symbol: inputSymbol, companyError = null, notices = null } = {}) {
  const date = new Date(now), symbol = symbolOf(inputSymbol || bundle?.symbol || company?.symbol);
  if (!Number.isFinite(date.getTime())) throw Error('经营指标核验时间无效');
  const query = validateResearchRules(input);
  if (bundle && bundle.symbol !== symbol) throw Error('产品资料股票代码不符');
  const productMetrics = buildProductMetrics(bundle?.documents || [], { symbol, now: date });
  const sourceIssues = productSourceIssues(bundle, productMetrics, date);
  // Preserve observed values for inspection, but never refresh old evidence by
  // merely rebuilding a metric object with today's timestamp.
  if (sourceIssues.length) for (const product of productMetrics.products || []) for (const cell of Object.values(product.metrics || {})) {
    cell.usable = false;
    cell.reasonCode = 'source-unverified';
    cell.reason = [cell.reason, ...sourceIssues].filter(Boolean).join('；');
  }
  productMetrics.sourceIssues = sourceIssues;
  const companyMetrics = currentCompanyMetrics(company, symbol, date, notices);
  if (companyError) companyMetrics.error = companyError;
  let riskSignals = [];
  if (bundle) {
    riskSignals = knownProductRiskSignals(bundle, productMetrics.products.map(product => product.subject), date);
  }
  const assessment = assessResearch(query, symbol, productMetrics, companyMetrics, riskSignals, date);
  return { version: 1, symbol, status: assessment.status, checkedAt: date.toISOString(), query,
    productSource: bundle ? { checkedAt: bundle.checkedAt, fetchedAt: bundle.fetchedAt,
      coverage: { noticeIndexComplete: bundle.coverage?.noticeIndexComplete,
        annualReport: { reportDate: bundle.coverage?.annualReport?.reportDate }, semiannualReport: { reportDate: bundle.coverage?.semiannualReport?.reportDate } } } : null,
    productMetrics, companyMetrics, assessment, riskSignals,
    acquisition: [...acquisitionDiagnostics(bundle), ...metricSourceDiagnostics(productMetrics)],
    limitations: ['产品指标与公司经营指标分别判断，公司数据不补填产品缺项', '数值条件由用户设置，未经策略效果验证；经营指标结论不等于产品前景或买入许可'] };
}

module.exports = { evaluateOperatingResearch, refreshOperatingResearch, acquisitionDiagnostics, productSourceIssues };
