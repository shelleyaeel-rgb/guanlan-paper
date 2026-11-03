'use strict';

// Diagnostics describe acquisition and eligibility separately. They never grant
// candidate status and cannot turn unavailable evidence into a negative fact.
function collectionSummary(bundle, evaluation) {
  const coverage = bundle?.coverage || {}, acquisition = bundle?.acquisition || {};
  const failures = (coverage.documentFailures || []).map(item => ({
    ...(item.acquisition || {}), documentId: item.id, message: item.reason,
  }));
  const issues = [...(acquisition.issues || []), ...failures];
  return {
    complete: bundle?.status === 'ready' && coverage.complete === true
      && !evaluation?.checks?.some(check => check.key === 'sourceIntegrity' && check.status !== 'pass'),
    indexComplete: coverage.noticeIndexComplete === true,
    annualReport: coverage.annualReport?.status || 'unknown',
    semiannualReport: coverage.semiannualReport?.status || 'unknown',
    relatedNotices: coverage.relatedNotices ? { ...coverage.relatedNotices, keywords: undefined } : null,
    documents: acquisition.documents || { loaded: bundle?.documents?.length || 0, failed: failures.length },
    cacheWarnings: [...new Set([...(bundle?.cacheWarnings || []), ...(acquisition.cacheWarnings || []),
      ...(bundle?.documents || []).map(document => document.cacheWarning)].map(value => typeof value === 'string' ? value : value?.message).filter(Boolean))].slice(0, 20),
    issues: [...new Map(issues.map(issue => [JSON.stringify([issue.stage, issue.code, issue.documentId, issue.message]), issue])).values()].slice(0, 100),
  };
}

const network = /net::ERR_|HTTP\s*(?:429|5\d\d)|网络|请求超时|fetch failed|ECONN|ETIMEDOUT|服务暂停|接口暂缓/i;
const NOTICE_DIAGNOSTICS = Object.freeze({
  'notice-index-fetch': { stage: 'download', label: '公告目录获取失败' },
  'notice-index-data': { stage: 'notices', label: '公告目录覆盖待核验' },
  'notice-body-fetch': { stage: 'download', label: '公告正文获取失败' },
  'notice-page-parse': { stage: 'parse', label: '公告页面解析待核验' },
  'notice-facts-pending': { stage: 'notices', label: '公告事实字段待核验' },
  'notice-policy-missing': { stage: 'notices', label: '公告规则尚未支持' },
  'notice-event-pending': { stage: 'notices', label: '公告事件影响待核验' },
  'notice-blocked': { stage: 'notices', label: '公告已明确阻断新开仓' },
  'notice-unclassified': { stage: 'notices', label: '公告待核验原因未细分' },
});
function noticeDiagnostics(review, context = {}) {
  if (review?.status === 'clear') return [];
  const stages = new Map();
  const add = (code, message, notice) => {
    if (!NOTICE_DIAGNOSTICS[code]) return;
    const item = stages.get(code) || { code, ...NOTICE_DIAGNOSTICS[code], messages: [], noticeIds: [] };
    if (message && !item.messages.includes(message)) item.messages.push(message);
    if (notice?.id && !item.noticeIds.includes(notice.id)) item.noticeIds.push(notice.id);
    item.message = item.messages.join('；'); stages.set(code, item);
  };
  if (context.acquisitionError || context.acquisition?.stage === 'index') add('notice-index-fetch', context.acquisitionError || context.acquisition.message);
  else if (review?.coverageComplete === false) add('notice-index-data', (review.reasons || []).join('；'));
  if (review?.diagnostic) add(review.diagnostic.code, review.diagnostic.reason);
  for (const notice of review?.notices || []) {
    if (notice.status === 'clear') continue;
    const fact = notice.factReview, eligibility = fact?.eligibility, code = eligibility?.code;
    if (notice.status === 'blocked' || eligibility?.status === 'blocked' || code === 'notice-event-blocked') { add('notice-blocked', notice.reason || eligibility?.reason, notice); continue; }
    if (notice.diagnostic && NOTICE_DIAGNOSTICS[notice.diagnostic.code]) add(notice.diagnostic.code, notice.diagnostic.reason || notice.reason, notice);
    else if (notice.acquisition) add(notice.acquisition.stage === 'parse' ? 'notice-page-parse' : 'notice-body-fetch', notice.reason, notice);
    else if (code === 'notice-risk-policy-missing' || fact?.status === 'unsupported') add('notice-policy-missing', eligibility?.reason || notice.reason, notice);
    else if (code === 'notice-event-pending' || code === 'performance-exception') add('notice-event-pending', eligibility?.reason || notice.reason, notice);
    else if (code === 'notice-facts-pending' || code?.startsWith('performance-') || fact?.status === 'incomplete') add('notice-facts-pending', eligibility?.reason || notice.reason, notice);
    else if (notice.fulltextStatus === 'verified' || notice.records?.length) add('notice-event-pending', notice.reason, notice);
    else {
      // Compatibility for saved pre-diagnostic results only. New reviews carry
      // a code; a historical generic risk word never establishes a risk fact.
      const reason = notice.reason || '';
      add(/页面|扫描|解析/.test(reason) ? 'notice-page-parse' : /原文|下载|获取/.test(reason) ? 'notice-body-fetch' : 'notice-unclassified', reason, notice);
    }
    // Missing facts remain visible even when the event has no admission rule.
    if (fact?.status === 'incomplete' && (code === 'notice-risk-policy-missing' || notice.diagnostic?.code === 'notice-policy-missing')) add('notice-facts-pending', notice.reason, notice);
  }
  if (review?.status === 'blocked' && ![...stages.keys()].includes('notice-blocked')) add('notice-blocked', (review.reasons || []).join('；'));
  if (!stages.size && review?.status === 'unverified') add('notice-unclassified', (review.reasons || []).join('；'));
  return [...stages.values()];
}
function rowDiagnostics(row, checked, review, operating, noticeReview = row?.noticeReview) {
  const stages = new Map();
  const add = (stage, code, label, details = {}) => stages.set(code, { stage, code, label, ...details });
  const message = (checked.reasons || []).join('；');
  if (checked.status !== 'pass') {
    if (checked.stage === 'daily') {
      const code = checked.technicalError || row.technicalError;
      if (code === 'insufficient') add('daily', 'daily-insufficient', '完整日线不足');
      else if (code === 'fetch') add('download', 'daily-download', '日线下载失败');
      else if (code === 'invalid') add('daily', 'daily-invalid', '日线数据无效');
      else add('daily', 'daily-date', '日线日期或价格基准异常');
    } else if (checked.stage === 'notices') {
      const diagnosis = noticeDiagnostics(noticeReview, checked);
      if (diagnosis.length) for (const item of diagnosis) stages.set(item.code, item);
      else if (checked.acquisitionError || network.test(message)) add('download', 'notice-index-fetch', NOTICE_DIAGNOSTICS['notice-index-fetch'].label, { message: checked.acquisitionError || message });
      else add('notices', checked.status === 'failed' ? 'notice-blocked' : 'notice-unclassified', NOTICE_DIAGNOSTICS[checked.status === 'failed' ? 'notice-blocked' : 'notice-unclassified'].label, { message });
    } else if (checked.stage === 'quotes' || checked.stage === 'universe') add('quotes', 'quote-data', '行情数据待核验');
    else if (checked.stage === 'finance-applicability') add('finance', checked.applicability?.status === 'inapplicable' ? 'finance-template-inapplicable' : 'finance-industry-pending',
      checked.applicability?.status === 'inapplicable' ? '财务模板不适用' : '财务模板行业分类待核验', { message });
    else if (checked.stage === 'research') {
      if (checked.status === 'failed') add('research', 'research-conditions-failed', operating?.query?.path === 'company' ? '公司经营指标条件未满足' : '产品指标条件未满足');
      else if (!operating) add('research', 'research-metrics-pending', '经营指标待核验');
    }
    else if (checked.status === 'failed') add('conditions', 'conditions-failed', '条件不符合');
    else if (checked.stage === 'finance') add('finance', 'finance-data', '财务数据待核验');
    else if (checked.stage !== 'evidence') add('conditions', 'conditions-pending', '量化条件待核验');
  }
  if (checked.stage !== 'notices' && checked.status !== 'pass' && noticeReview) for (const item of noticeDiagnostics(noticeReview)) stages.set(item.code, item);
  if (review?.status === 'pending') {
    if (review.industryReview?.status === 'pending') add('evidence', 'industry-evidence-pending', '行业排名或统计口径待核验', { message: review.industryReview.reason });
    const collection = review.collection;
    for (const issue of collection?.issues || []) {
      // Successfully recovered attempts are retained for troubleshooting, but
      // cannot be counted as current blocking acquisition failures.
      if (issue.recovered === true) continue;
      if (issue.code === 'service-paused') add('download', 'service-paused', '资料服务暂缓请求', { retryAt: issue.retryAt });
      else if (issue.code === 'size-limit') add('download', 'document-size', '附件超过大小上限', { limitBytes: issue.limitBytes, actualBytes: issue.actualBytes });
      else if (issue.code === 'cache-capacity') add('download', 'document-cache-capacity', '附件缓存容量不足');
      else if (issue.code === 'company-document-budget') add('evidence', 'document-budget', '公司资料超过容量上限');
      else if (issue.stage === 'parse') add('parse', 'document-parse', '报告解析待核验');
      else if (issue.retryable || network.test(issue.message || '') || ['body', 'download', 'index'].includes(issue.stage)
        && /http|timeout|network|connection|fetch/i.test(issue.code || '')) add('download', 'document-download', '资料下载失败');
      else add('evidence', 'document-integrity', '资料身份或完整性待核验');
    }
    if (collection?.indexComplete && [collection.annualReport, collection.semiannualReport].includes('missing')) add('directory', 'report-directory', '报告目录待补齐');
    if (review.checks?.some(check => check.key === 'ocrReview' && check.status === 'pending')) add('parse', 'ocr-review', '扫描页内容待核验');
    for (const check of review.checks || []) {
      if (!['productOutlook', 'sameProduct'].includes(check.key) || check.status !== 'pending' || !Array.isArray(check.productCandidates)) continue;
      if (!check.productCandidates.length) { add('evidence', 'product-unidentified', '产品尚未可靠识别'); continue; }
      // A failed alternative cannot be repaired by supplying a missing field.
      // Report shared gaps among still-pending products, never stitch a pass
      // from product A to a different condition belonging to product B.
      const candidates = check.productCandidates.filter(product => product.status === 'pending');
      if (!candidates.length) continue;
      let commonGaps = 0;
      for (const [key, label] of [['demand', '产品需求事实待补齐'], ['commercialization', '产品商业化事实待补齐'],
        ['advantage', '产品竞争优势比较待核验'], ['outlookRisk', '产品风险披露待核验']]) {
        const parts = candidates.map(product => product.parts?.find(part => part.key === key));
        if (parts.every(part => part?.status === 'pending')) { add('evidence', `product-${key}`, label); commonGaps++; }
      }
      if (!commonGaps) add('evidence', 'product-evidence-combination', '同一产品的证据尚未齐备');
    }
    if (![...stages.values()].some(item => ['download', 'parse', 'directory', 'evidence'].includes(item.stage))) {
      add('evidence', 'evidence-incomplete', '研究证据不足');
    }
  }
  const operatingAttempted = !!operating && ['pass', 'failed', 'pending'].includes(operating.status) && operating.query?.enabled !== false;
  if (operatingAttempted && operating.status === 'pending') {
    // The company path does not request product reports; its parallel product
    // acquisition hints are not blockers for selected company conditions.
    if (operating.query?.path === 'product') for (const issue of operating.acquisition || []) {
      if (issue.recovered === true) continue;
      const details = { message: issue.reason || issue.message || '', ...(issue.documentId ? { documentId: issue.documentId } : {}) };
      if (issue.code === 'parse-failed') add('parse', 'research-document-parse', '产品报告解析未完成', details);
      else if (issue.code === 'fetch-failed' || issue.code === 'document-unavailable') add('download', 'research-document-download', '产品资料获取未完成', details);
      else if (issue.code === 'not-located') add('directory', 'research-report-directory', '产品报告目录待补齐', details);
      else if (issue.code === 'not-requested') add('research', 'research-not-collected', '产品资料尚未获取', details);
      else if (issue.code === 'metrics-not-extracted') add('research', 'research-metrics-not-extracted', '原文已取得，产品指标尚未提取', details);
      else add('research', 'research-source-pending', '产品资料来源待核验', details);
    }
    add('research', 'research-metrics-pending', operating.query?.path === 'company' ? '公司经营指标缺项或口径待核验' : '产品指标缺项或口径待核验',
      { message: (operating.assessment?.reasons || []).join('；') });
  }
  const list = [...stages.values()], first = list[0];
  return { stage: first?.stage || 'complete', code: first?.code || 'complete', label: first?.label || '本策略核验通过',
    stages: list, researchAttempted: !!review || operatingAttempted,
    researchComplete: operatingAttempted ? ['pass', 'failed'].includes(operating.status) : review?.collection?.complete === true };
}

function combineDiagnostics(items) {
  const found = items.filter(Boolean), merged = new Map();
  for (const item of found.flatMap(item => item.stages || [])) {
    const previous = merged.get(item.code);
    merged.set(item.code, previous ? { ...previous, ...item, noticeIds: [...new Set([...(previous.noticeIds || []), ...(item.noticeIds || [])])], messages: [...new Set([...(previous.messages || []), ...(item.messages || [])])] } : { ...item });
  }
  const stages = [...merged.values()];
  const first = stages[0];
  return { stage: first?.stage || 'complete', code: first?.code || 'complete', label: first?.label || '核验完成', stages,
    researchAttempted: found.some(item => item.researchAttempted), researchComplete: found.some(item => item.researchComplete) };
}

function listedDiagnostics(rows) {
  const companies = new Map();
  for (const row of rows) { const values = companies.get(row.symbol) || []; values.push(row); companies.set(row.symbol, values); }
  const result = { scope: 'listed-companies', uniqueCompanies: companies.size, stages: {} };
  for (const values of companies.values()) for (const item of combineDiagnostics(values.map(row => row.diagnostics)).stages) {
    const counter = result.stages[item.code] ||= { label: item.label, count: 0 }; counter.count++;
  }
  return result;
}

function poolDiagnostics(strategies, { researchEnabled = true } = {}) {
  const companies = new Map();
  for (const strategy of Object.values(strategies)) for (const status of ['pass', 'failed', 'pending']) for (const row of strategy[status]) {
    const item = companies.get(row.symbol) || { statuses: new Set(), diagnostics: [] };
    item.statuses.add(status); item.diagnostics.push(row.diagnostics); companies.set(row.symbol, item);
  }
  const summary = { uniqueCompanies: companies.size, eligibleCompanies: 0, failedCompanies: 0, pendingCompanies: 0,
    researchAttempted: 0, researchComplete: 0, researchNotStarted: 0, stages: {} };
  for (const item of companies.values()) {
    const diagnostic = combineDiagnostics(item.diagnostics);
    if (diagnostic.researchAttempted) summary.researchAttempted++;
    if (diagnostic.researchComplete) summary.researchComplete++;
    if (item.statuses.has('pass')) { summary.eligibleCompanies++; continue; }
    if (!item.statuses.has('pending')) { summary.failedCompanies++; continue; }
    summary.pendingCompanies++;
    const stages = diagnostic.stages.filter(stage => stage.code !== 'conditions-failed');
    if (researchEnabled && !diagnostic.researchAttempted) { summary.researchNotStarted++; stages.push({ code: 'research-not-started', label: '尚未进入研究核验' }); }
    for (const stage of stages) { const count = summary.stages[stage.code] ||= { label: stage.label, count: 0 }; count.count++; }
  }
  return { ...summary, ...(!researchEnabled ? { researchStatus: 'disabled' } : {}) };
}

module.exports = { collectionSummary, rowDiagnostics, combineDiagnostics, poolDiagnostics, noticeDiagnostics, listedDiagnostics, NOTICE_DIAGNOSTICS };
