const test = require('node:test');
const assert = require('node:assert/strict');
const { collectionSummary, rowDiagnostics, poolDiagnostics } = require('../core/agency-pool-diagnostics.cjs');
const { noticeDiagnostics, listedDiagnostics } = require('../core/agency-pool-diagnostics.cjs');

test('公告诊断优先结构化分类，正文下载与目录下载不会混为一类', () => {
  const review = { status: 'unverified', coverageComplete: true, notices: [
    { id: 'one', status: 'unverified', reason: '包含风险、敏感、下载等旧关键词', diagnostic: { code: 'notice-page-parse', stage: 'parse' } },
    { id: 'two', status: 'unverified', reason: 'HTTP 500', acquisition: { stage: 'body', code: 'http' } },
    { id: 'three', status: 'clear', diagnostic: { code: 'notice-policy-missing' } },
  ] };
  assert.deepEqual(noticeDiagnostics(review).map(item => item.code), ['notice-page-parse', 'notice-body-fetch']);
  assert.deepEqual(noticeDiagnostics({ status: 'unverified', coverageComplete: false, notices: [] }, { acquisitionError: 'offline' }).map(item => item.code), ['notice-index-fetch']);
  assert.deepEqual(noticeDiagnostics({ status: 'unverified', coverageComplete: false, notices: [] }).map(item => item.code), ['notice-index-data']);
});

test('事实缺项、规则缺失、事件影响与已明确阻断保持独立，旧业绩结果兼容', () => {
  const review = { status: 'unverified', notices: [
    { id: 'policy', status: 'unverified', factReview: { status: 'incomplete', eligibility: { code: 'notice-risk-policy-missing' } } },
    { id: 'event', status: 'unverified', factReview: { status: 'verified', eligibility: { code: 'notice-event-pending' } } },
    { id: 'blocked', status: 'blocked', diagnostic: { code: 'notice-facts-pending' }, factReview: { status: 'incomplete', eligibility: { code: 'notice-event-blocked', status: 'blocked' } } },
    { id: 'forecast', status: 'unverified', factReview: { status: 'incomplete', eligibility: { code: 'performance-period' } } },
  ] };
  const values = noticeDiagnostics(review);
  assert.deepEqual(values.map(item => item.code), ['notice-policy-missing', 'notice-facts-pending', 'notice-event-pending', 'notice-blocked']);
  assert.deepEqual(values.find(item => item.code === 'notice-facts-pending').noticeIds, ['policy', 'forecast']);
  assert.deepEqual(noticeDiagnostics({ status: 'clear', notices: review.notices }), []);
});

test('明确公告阻断的失败策略与其他待核验策略合并时，不再标为公告风险待核验', () => {
  const failed = { symbol: 'sh600001', diagnostics: rowDiagnostics({}, { status: 'failed', stage: 'notices', reasons: ['不利风险'] }, null, null,
    { status: 'blocked', notices: [{ id: 'n', status: 'blocked', reason: '标题风险信号' }] }) };
  const pending = { symbol: 'sh600001', diagnostics: rowDiagnostics({}, { status: 'pending', stage: 'daily', technicalError: 'insufficient', reasons: [] }) };
  const summary = poolDiagnostics({ short: { pass: [], pending: [], failed: [failed] }, long: { pass: [], pending: [pending], failed: [] } });
  assert.equal(summary.stages['notice-blocked'].count, 1); assert.equal(summary.stages['notice-risk'], undefined);
});

test('列表统计只统计实际展示行，同公司同原因跨分类及策略只计一次', () => {
  const make = (symbol, code) => ({ symbol, diagnostics: { stages: [{ code, label: code }] } });
  const result = listedDiagnostics([make('sh600001', 'notice-policy-missing'), make('sh600001', 'notice-policy-missing'),
    make('sh600001', 'notice-facts-pending'), make('sh600002', 'notice-blocked')]);
  assert.equal(result.scope, 'listed-companies'); assert.equal(result.uniqueCompanies, 2);
  assert.equal(result.stages['notice-policy-missing'].count, 1); assert.equal(result.stages['notice-facts-pending'].count, 1); assert.equal(result.stages['notice-blocked'].count, 1);
});

test('行业诊断区分模板不适用、分类未知和排名资料不足', () => {
  const inapplicable = rowDiagnostics({}, { status: 'failed', stage: 'finance-applicability',
    applicability: { status: 'inapplicable' }, reasons: ['银行不适用普通模板'] });
  assert.equal(inapplicable.code, 'finance-template-inapplicable');
  assert.equal(inapplicable.stages.some(item => item.code === 'conditions-failed'), false);
  const unknown = rowDiagnostics({}, { status: 'pending', stage: 'finance-applicability',
    applicability: { status: 'pending' }, reasons: ['分类待核验'] });
  assert.equal(unknown.code, 'finance-industry-pending');
  const ranking = rowDiagnostics({}, { status: 'pending', stage: 'evidence', reasons: ['排名资料不足'] },
    { status: 'pending', industryReview: { status: 'pending', reason: '统计范围未知' }, checks: [] });
  assert.equal(ranking.code, 'industry-evidence-pending');
});

test('产品缺项按仍有可能通过的同一产品诊断，未知历史明细不补成识别失败', () => {
  const diagnose = check => rowDiagnostics({}, { status: 'pending', stage: 'evidence', reasons: [] }, { status: 'pending', checks: [check] });
  const product = { key: 'productOutlook', status: 'pending' };
  assert.equal(diagnose(product).code, 'evidence-incomplete');
  assert.equal(diagnose({ ...product, productCandidates: [] }).code, 'product-unidentified');
  const candidate = (subject, demand, commercialization) => ({ subject, status: 'pending', parts: [
    { key: 'demand', status: demand }, { key: 'commercialization', status: commercialization },
    { key: 'advantage', status: 'pending' }, { key: 'outlookRisk', status: 'pending' },
  ] });
  const checks = { ...product, productCandidates: [candidate('扬声器', 'pass', 'pass'), candidate('耳机', 'pending', 'pass')] };
  assert.deepEqual(diagnose(checks).stages.map(item => item.code), ['product-advantage', 'product-outlookRisk']);
  const split = [candidate('扬声器', 'pass', 'pending'), candidate('耳机', 'pending', 'pass')];
  for (const item of split) for (const part of item.parts) if (['advantage', 'outlookRisk'].includes(part.key)) part.status = 'pass';
  assert.equal(diagnose({ ...product, productCandidates: split }).code, 'product-evidence-combination');
  assert.equal(diagnose({ ...product, status: 'pass', productCandidates: split }).code, 'evidence-incomplete');
});

test('同一公司产品缺项跨策略去重，明确不符产品不制造待补资料标签', () => {
  const review = { status: 'pending', checks: [{ key: 'productOutlook', status: 'pending', productCandidates: [
    { subject: '已停产产品', status: 'fail', parts: [{ key: 'demand', status: 'pass' }] },
    { subject: '存续产品', status: 'pending', parts: [{ key: 'demand', status: 'pending' }] },
  ] }] };
  const diagnostics = rowDiagnostics({}, { status: 'pending', stage: 'evidence', reasons: [] }, review);
  assert.deepEqual(diagnostics.stages.map(item => item.code), ['product-demand']);
  const strategy = { pass: [], failed: [], pending: [{ symbol: 'sh600001', diagnostics }] };
  assert.equal(poolDiagnostics({ short: strategy, long: strategy }).stages['product-demand'].count, 1);
});

test('附件大小与缓存容量限制不误报为身份错误或网络中断', () => {
  const review = { status: 'pending', collection: { issues: [{ stage: 'download', code: 'size-limit', limitBytes: 134217728 },
    { stage: 'download', code: 'cache-capacity' }] } };
  const result = rowDiagnostics({}, { status: 'pending', stage: 'evidence', reasons: [] }, review);
  assert.deepEqual(result.stages.map(stage => stage.code), ['document-size', 'document-cache-capacity']);
  assert.equal(result.stages[0].limitBytes, 134217728);
});

test('资料下载恢复后不算下载失败，完整获取也不冒充条件通过', () => {
  const review = { status: 'pending', checks: [{ key: 'leadership', status: 'pending' }] };
  review.collection = collectionSummary({ status: 'ready', documents: [{ complete: true }], coverage: { complete: true, noticeIndexComplete: true },
    acquisition: { issues: [{ stage: 'body', code: 'ERR_HTTP2_PROTOCOL_ERROR', retryable: true, recovered: true }] } }, review);
  const diagnostic = rowDiagnostics({}, { status: 'pending', stage: 'evidence', reasons: ['行业排名资料不足'] }, review);
  assert.equal(diagnostic.researchComplete, true);
  assert.deepEqual(diagnostic.stages.map(item => item.code), ['evidence-incomplete']);
});

test('核验失败分类区分网络、解析、报告目录与量化日线，不把无效资料算完整', () => {
  const review = { status: 'pending', checks: [{ key: 'sourceIntegrity', status: 'pending' }] };
  review.collection = collectionSummary({ status: 'ready', coverage: { complete: true, noticeIndexComplete: true, annualReport: { status: 'missing' },
    documentFailures: [{ id: 'AN1', reason: 'net::ERR_HTTP2_PROTOCOL_ERROR', acquisition: { stage: 'body', code: 'http2', retryable: true } },
      { id: 'AN2', reason: '原文扫描页缺失', acquisition: { stage: 'parse', code: 'parse-incomplete' } }] } }, review);
  assert.equal(review.collection.complete, false);
  const diagnostic = rowDiagnostics({ technicalError: 'insufficient' }, { status: 'pending', stage: 'daily', reasons: [] }, review);
  assert.deepEqual(diagnostic.stages.map(item => item.code), ['daily-insufficient', 'document-download', 'document-parse', 'report-directory']);
});

test('跨策略按公司统计：待核验分类可重叠，但同公司同原因只计一次', () => {
  const pending = (symbol, review) => ({ symbol, diagnostics: rowDiagnostics({ technicalError: 'mismatch' }, { status: 'pending', stage: 'daily', reasons: [] }, review) });
  const review = { status: 'pending', collection: { complete: false, issues: [{ stage: 'body', code: 'service-paused', retryable: true }] } };
  const strategies = {
    short: { pass: [], failed: [{ symbol: 'sh600003', diagnostics: {} }], pending: [pending('sh600001'), pending('sh600002', review)] },
    long: { pass: [], failed: [{ symbol: 'sh600003', diagnostics: {} }], pending: [pending('sh600001'), pending('sh600002', review)] },
  };
  const result = poolDiagnostics(strategies);
  assert.equal(result.uniqueCompanies, 3); assert.equal(result.pendingCompanies, 2); assert.equal(result.failedCompanies, 1);
  assert.equal(result.researchAttempted, 1); assert.equal(result.researchComplete, 0); assert.equal(result.researchNotStarted, 1);
  assert.equal(result.stages['daily-date'].count, 2); assert.equal(result.stages['service-paused'].count, 1);
  assert.equal(result.stages['research-not-started'].count, 1);
});

test('经营指标缺项标记为研究已尝试，解析和获取失败分别呈现而不误报量化条件', () => {
  const operating = { status: 'pending', query: { enabled: true, path: 'product' }, assessment: { reasons: ['销量同期口径尚未核验'] },
    acquisition: [{ code: 'parse-failed', reason: '扫描页无法提取', documentId: 'AN1' }, { code: 'fetch-failed', reason: '附件请求失败', documentId: 'AN2' },
      { code: 'not-located', reason: '尚未定位报告' }, { code: 'fetch-failed', reason: '已恢复', recovered: true }] };
  const diagnostic = rowDiagnostics({}, { status: 'pending', stage: 'research', reasons: [] }, null, operating);
  assert.equal(diagnostic.researchAttempted, true); assert.equal(diagnostic.researchComplete, false);
  assert.deepEqual(diagnostic.stages.map(stage => stage.code), ['research-document-parse', 'research-document-download', 'research-report-directory', 'research-metrics-pending']);
  assert.equal(diagnostic.stages[1].message, '附件请求失败');
  const strategy = { pass: [], failed: [], pending: [{ symbol: 'sh600001', diagnostics: diagnostic }] };
  const summary = poolDiagnostics({ short: strategy, swing: strategy });
  assert.equal(summary.researchAttempted, 1); assert.equal(summary.researchNotStarted, 0); assert.equal(summary.researchComplete, 0);
  assert.equal(summary.stages['research-document-parse'].count, 1); assert.equal(summary.stages['conditions-pending'], undefined);
});

test('公司路径不把未请求产品报告当成缺项，可判定通过和不符都算研究完成', () => {
  const operating = { status: 'pending', query: { enabled: true, path: 'company' }, assessment: { reasons: ['公司营收缺失'] },
    acquisition: [{ code: 'not-requested', reason: '未请求产品报告' }] };
  const pending = rowDiagnostics({}, { status: 'pending', stage: 'research', reasons: [] }, null, operating);
  assert.deepEqual(pending.stages.map(stage => stage.code), ['research-metrics-pending']); assert.match(pending.label, /公司经营/);
  for (const status of ['pass', 'failed']) {
    const diagnostic = rowDiagnostics({}, { status, stage: 'research', reasons: [] }, null, { ...operating, status });
    assert.equal(diagnostic.researchAttempted, true); assert.equal(diagnostic.researchComplete, true);
    assert.equal(diagnostic.code, status === 'pass' ? 'complete' : 'research-conditions-failed');
    if (status === 'failed') assert.match(diagnostic.label, /公司经营指标条件未满足/);
  }
  const observing = rowDiagnostics({}, { status: 'pass', stage: 'research', reasons: [] }, null,
    { ...operating, status: 'observing', query: { enabled: false, path: 'company' } });
  assert.equal(observing.researchAttempted, false); assert.equal(observing.researchComplete, false);
});

test('原文已取但指标未提取不冒充未披露、下载失败或来源不明', () => {
  const operating = { status: 'pending', query: { enabled: true, path: 'product' }, assessment: { reasons: ['当前表格结构尚未可靠识别'] },
    acquisition: [{ code: 'metrics-not-extracted', reason: '原文完整，尚未提取产品行' }] };
  const diagnostic = rowDiagnostics({}, { status: 'pending', stage: 'research', reasons: [] }, null, operating);
  assert.equal(diagnostic.code, 'research-metrics-not-extracted');
  assert.match(diagnostic.label, /原文已取得/); assert.doesNotMatch(diagnostic.label, /未披露|下载|来源/);
});
