'use strict';
const { checkNoticeRisk } = require('./entry-risk.cjs');
const { safeEvidenceUrl } = require('./selection-evidence.cjs');
const { isVerifiedNonContentPage } = require('./company-document-parser.cjs');
const { reviewNoticeFacts } = require('./company-notice-facts.cjs');
const { reviewEventNotice } = require('./company-notice-events.cjs');
const { reviewCorporateAction } = require('./company-notice-corporate-actions.cjs');
const normalize = text => String(text || '').normalize('NFKC').replace(/\s+/g, '');
const SCOPE = '在新鲜公告目录覆盖的14日范围内，逐篇核验敏感公告的完整原文、事件类型及阶段；事实核实与候选准入分开，保留观察提示、资料缺项和明确风险，不推断未披露事实。';

// A positive title or a generic "no material impact" sentence cannot clear an
// ongoing event. Only narrowly supported, completed events can be resolved.
function reviewDocument(document, notice, symbol, at) {
  const pending = (reason, code = 'notice-body-fetch', stage = 'body') => ({ ...notice, status: 'unverified', reason, records: [],
    fulltextStatus: 'unverified', diagnostic: { code, stage, reason } });
  if (!document || document.issuerSymbol !== symbol || document.kind !== 'notice' || document.complete !== true
    || document.publishedAt !== notice.date || normalize(document.title) !== normalize(notice.title)
    || !safeEvidenceUrl(document.url) || typeof document.text !== 'string' || !document.text.trim()
    || !Number.isFinite(document.fetchedAt) || document.fetchedAt <= 0 || document.fetchedAt > at) {
    return pending('敏感公告尚未取得身份、日期、标题一致的完整原文');
  }
  const pages = document.pageTexts;
  if (!Array.isArray(pages) || !pages.length || document.pages !== pages.length
    || pages.some((page, index) => page.page !== index + 1 || page.complete !== true || typeof page.text !== 'string'
      || !isVerifiedNonContentPage(page, document) && (!['pdf-text', 'provider-text'].includes(page.method) || page.numericEligible !== true))
    || normalize(pages.map(page => page.text).join('\n\n')) !== normalize(document.text)) {
    return pending('敏感公告存在未可靠核验的页面、扫描文字或表格，暂不能确认实际影响', 'notice-page-parse', 'parse');
  }
  const entries = pages.filter(page => !isVerifiedNonContentPage(page, document)).flatMap(page => String(page.text).split(/[。；;]/).map(text => ({ text: text.trim(), page: page.page, method: page.method })));
  const records = entries.filter(entry => /诉讼|仲裁|减持|终止|影响|风险|处罚|立案|资产|临床|解禁|限售|业绩/.test(entry.text))
    .slice(0, 12).map(entry => ({ id: `${document.id}#notice:${entry.page}:${normalize(entry.text).slice(0, 100)}`,
      symbol, kind: 'noticeReview', subject: notice.title, value: 'disclosed', reviewState: 'automatic', mode: 'automatic',
      sourceTitle: document.title, source: document.source, sourceRelation: 'issuer-disclosure', sourceDocumentId: document.id,
      sourceHash: document.sourceHash || null, parserVersion: document.parserVersion || null, publishedAt: document.publishedAt,
      checkedAt: new Date(at).toISOString(), url: document.url, quote: entry.text.slice(0, 2000),
      locations: [{ page: entry.page, method: entry.method }] }));
  const cancelledReduction = /减持/.test(notice.title) && /终止|取消/.test(notice.title) && !/资产|诉讼|处罚|立案/.test(notice.title);
  if (!cancelledReduction) {
    const content = { ...document, pageTexts: pages.filter(page => !isVerifiedNonContentPage(page, document)) };
    const factReview = reviewEventNotice(content, notice) || reviewCorporateAction(content, notice) || reviewNoticeFacts(content, notice);
    const factualRecords = factReview.checks.flatMap(check => check.records.map((record, index) => ({
      id: `${document.id}#notice-fact:${check.key}:${record.page}:${index}`, symbol, kind: 'noticeReview', subject: `${factReview.label} · ${check.label}`,
      value: check.status === 'verified' ? 'fact-verified' : 'fact-pending', reviewState: 'automatic', mode: 'automatic',
      sourceTitle: document.title, source: document.source, sourceRelation: 'issuer-disclosure', sourceDocumentId: document.id,
      sourceHash: document.sourceHash || null, parserVersion: document.parserVersion || null, publishedAt: document.publishedAt,
      checkedAt: new Date(at).toISOString(), url: document.url, quote: record.quote.slice(0, 2000), locations: [{ page: record.page, method: record.method }] })));
    const status = factReview.eligibility.status === 'pass' ? 'clear' : factReview.eligibility.status === 'blocked' ? 'blocked' : 'unverified';
    const eligibilityCode = factReview.eligibility.code;
    const diagnostic = status === 'clear' ? { code: 'notice-cleared', stage: 'complete' } : status === 'blocked' ? { code: 'notice-blocked', stage: 'event' }
      : eligibilityCode === 'notice-risk-policy-missing' ? { code: 'notice-policy-missing', stage: 'policy' }
        : eligibilityCode === 'notice-event-pending' || /performance-(?:exception|amendment|not-comparable|comparative-basis)/.test(eligibilityCode)
          ? { code: 'notice-event-pending', stage: 'event' } : { code: 'notice-facts-pending', stage: 'facts' };
    return { ...notice, status, fulltextStatus: 'verified', diagnostic: { ...diagnostic, reason: factReview.eligibility.reason },
      factReview, warnings: factReview.warnings || [], records: [...factualRecords, ...records], reason: factReview.reason };
  }
  const text = normalize(document.text);
  // Unresolved risks elsewhere in the same notice win over a local resolution.
  const unresolved = /尚未|尚待|仍需|仍存在|未结案|未履行|未执行完毕|不确定性|无法判断|无法确定|可能.{0,16}(?:损失|不利|影响)|不能排除|其他.{0,12}(?:诉讼|仲裁|争议)|(?:本公司|公司).{0,12}(?:被立案|涉嫌违法)|(?<!不)(?<!未)会.{0,6}产生重大不利影响/.test(text)
    || text.split(/[。；;，,]/).some(clause => /(?:造成|产生|导致).{0,12}(?:重大不利|重大损失)/.test(clause) && !/未|无|不会|不产生/.test(clause));
  const sentences = entries.map(entry => normalize(entry.text)).filter(value => value.length <= 1000);
  const completed = sentences.some(value => /^本次减持计划(?:已|已经)(?:终止|取消)[,，](?:期间|实施期间|计划期间)(?:本公司|公司|相关股东)?(?:未减持|未实施任何减持|未发生减持)$/.test(value));
  const event = '减持计划(?:终止|取消)';
  const impactSubject = `本次${event}(?:事项)?[,，]?`;
  const issuerOperations = '(?:本公司|公司)(?:的)?(?:生产经营|经营|财务状况|经营及财务状况)';
  const clearImpact = value => new RegExp(`^${impactSubject}对${issuerOperations}(?:未造成|未产生|无)重大不利影响$`).test(value)
    || new RegExp(`^${impactSubject}未对${issuerOperations}(?:造成|产生)重大不利影响$`).test(value);
  const impact = sentences.some(clearImpact);
  // Do not enumerate just a few adverse verbs: "构成不利影响" or "遭受损失"
  // must not be defeated by a separate, narrower no-impact statement. Every
  // risk-bearing statement needs its own exact supported negative scope.
  const unresolvedImpact = entries.some(entry => {
    const value = normalize(entry.text);
    return /不利|损失|亏损|违约|处罚|立案/.test(value) && !clearImpact(value);
  });
  if (!unresolved && !unresolvedImpact && completed && impact) return { ...notice, status: 'clear', fulltextStatus: 'verified', records,
    diagnostic: { code: 'notice-cleared', stage: 'complete' },
    reason: '完整原文明示本事件已结束、相关义务履行完毕或未实施减持，并披露未造成重大不利影响；仅确认该事件披露范围' };
  return { ...notice, status: 'unverified', fulltextStatus: 'verified', records,
    diagnostic: { code: 'notice-event-pending', stage: 'event' },
    reason: '已读取敏感公告原文，尚缺可程序确认的事件结束、义务履行及实际影响证据；一般性风险说明或预计无影响不构成通过依据' };
}

function reviewNoticeEvidence(titleReview, bundle, symbol, now = new Date()) {
  const at = new Date(now).getTime();
  if (!titleReview || titleReview.status !== 'unverified' || titleReview.coverageComplete !== true || !titleReview.notices?.length
    || !Number.isFinite(at) || titleReview.symbol !== symbol) return titleReview;
  if (!bundle || bundle.symbol !== symbol || !Number.isFinite(bundle.fetchedAt) || bundle.fetchedAt <= 0
    || bundle.fetchedAt > at || at - bundle.fetchedAt > 21600000) return titleReview;
  const documents = Array.isArray(bundle.documents) ? bundle.documents : [];
  const notices = titleReview.notices.map(notice => {
    const matches = documents.filter(document => document.id === notice.id);
    const reviewed = reviewDocument(matches.length === 1 ? matches[0] : null, notice, symbol, at);
    if (!matches.length) {
      const failure = [...(Array.isArray(bundle.errors) ? bundle.errors : []), ...(Array.isArray(bundle.acquisition?.issues) ? bundle.acquisition.issues : [])]
        .find(item => item && typeof item === 'object' && item.documentId === notice.id && (typeof item.message === 'string' || typeof item.reason === 'string' || typeof item.error === 'string'));
      if (failure) return { ...reviewed, reason: `${reviewed.reason}；${failure.message || failure.reason || failure.error}`,
        acquisition: { code: failure.code || null, stage: failure.stage || null, documentId: notice.id } };
    }
    return reviewed;
  });
  const clear = notices.every(notice => notice.status === 'clear');
  const warnings = notices.flatMap(notice => (notice.warnings || []).map(warning => ({ ...warning, noticeId: notice.id, noticeTitle: notice.title })));
  return { ...titleReview, status: clear ? 'clear' : notices.some(notice => notice.status === 'blocked') ? 'blocked' : 'unverified', checkedAt: at, notices, mode: 'automatic-fulltext', scope: SCOPE,
    warnings, reasons: clear ? ['限定范围内敏感公告的完整原文核验通过', ...warnings.map(warning => `${warning.noticeTitle}：${warning.reason}`)] : notices.filter(notice => notice.status !== 'clear').map(notice => `${notice.title}：${notice.reason}`) };
}

function checkNoticeWithEvidence(response, symbol, bundle, now = new Date()) {
  return reviewNoticeEvidence(checkNoticeRisk(response, symbol, now), bundle, symbol, now);
}
module.exports = { reviewNoticeEvidence, checkNoticeWithEvidence };
