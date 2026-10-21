const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCompanyEvidence } = require('../core/company-evidence.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const NOW = new Date('2026-10-13T10:00:00+08:00');
const query = { conditions: ['productOutlook', 'financialReview'], leadership: 'either', minSegmentRevenuePct: 30 };
function missingReport(mutate) {
  const bundle = companyBundle('sh600160', NOW);
  bundle.documents = bundle.documents.filter(document => document.kind !== 'semiannual-report');
  bundle.coverage.semiannualReport = { status: 'pending', id: 'AN202608251828415678', reportDate: '2026-06-30', publishedAt: '2026-08-26' };
  mutate(bundle);
  const result = evaluateCompanyEvidence(bundle, query, NOW);
  assert.equal(result.status, 'pending');
  return result.checks.find(check => check.key === 'sourceIntegrity').reason;
}

test('identified August half-year filing with failed body acquisition is not described as an undisclosed report', () => {
  const reason = missingReport(bundle => {
    bundle.coverage.documentFailures = [{ id: 'AN202608251828415678', reason: 'PDF 下载超时' }];
  });
  assert.match(reason, /已找到2026年半年度报告公告/);
  assert.match(reason, /披露日期 2026-08-26/);
  assert.match(reason, /全文尚未完整取得或未通过校验：PDF 下载超时/);
  assert.doesNotMatch(reason, /未识别|尚未披露|缺少2026/);
});

test('directory network failure means publication is unknown rather than missing', () => {
  const reason = missingReport(bundle => {
    bundle.coverage.noticeIndexComplete = false;
    bundle.coverage.semiannualReport = { status: 'missing' };
  });
  assert.match(reason, /公告目录获取未完成/);
  assert.match(reason, /不能据此认定公司未披露/);
  assert.doesNotMatch(reason, /未识别出|缺少2026/);
});

test('complete source directory with no recognized report keeps source qualification explicit', () => {
  const reason = missingReport(bundle => { bundle.coverage.semiannualReport = { status: 'missing' }; });
  assert.match(reason, /当前公告源未识别出2026年完整半年度报告全文条目/);
  assert.match(reason, /不等于公司尚未披露/);
});

test('old identified report distinguishes stale reporting period from failed current PDF', () => {
  const reason = missingReport(bundle => { bundle.coverage.semiannualReport.reportDate = '2025-06-30'; });
  assert.match(reason, /仅识别到报告期 2025-06-30/);
  assert.match(reason, /不能以旧报告替代/);
  assert.doesNotMatch(reason, /已找到2026/);
});

test('report coverage failure remains pending even when an older usable body exists', () => {
  const bundle = companyBundle('sh600160', NOW);
  bundle.coverage.semiannualReport = { status: 'pending', id: 'AN20261001000001', reportDate: '2026-06-30', publishedAt: '2026-10-01', reason: '最新更正版下载失败' };
  const result = evaluateCompanyEvidence(bundle, query, NOW);
  assert.equal(result.status, 'pending');
  assert.match(result.checks[0].reason, /2026-10-01.*最新更正版下载失败/);
});
