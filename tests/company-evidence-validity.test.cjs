'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { evaluateCompanyEvidence, refreshCompanyEvidence } = require('../core/company-evidence.cjs');
const { INDUSTRY_METADATA } = require('../core/selection-evidence.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const NOW = new Date('2026-10-15T10:00:00+08:00'), symbol = 'sh600001';
const query = { conditions: [], industry: { ...INDUSTRY_METADATA.defaults } };
const hash = value => createHash('sha256').update(value).digest('hex');
const evaluate = (bundle = companyBundle(symbol, NOW), now = NOW) => evaluateCompanyEvidence(bundle, query, now);

test('发布时使用原始采集时钟，6小时边界有效，重复checkedAt不能给资料续期', () => {
  const original = evaluate(), before = structuredClone(original);
  assert.equal(original.status, 'pass');
  assert.equal(refreshCompanyEvidence(original, +NOW + 21600000).status, 'pass');
  const expired = refreshCompanyEvidence({ ...original, checkedAt: new Date(+NOW + 21600001).toISOString() }, +NOW + 21600001);
  assert.equal(expired.status, 'pending'); assert.match(expired.checks[0].reason, /超过6小时/);
  assert.equal(expired.industryReview.status, 'pending');
  assert.equal(expired.industryReview.rows[0].rank, 1); assert.equal(expired.industryReview.rows[0].revenueSharePct, 35);
  assert.ok(expired.industryReview.rows.every(row => row.status === 'pending' && row.records.length));
  assert.deepEqual(expired.sourceValidity, original.sourceValidity);
  assert.deepEqual(expired.records, original.records);
  assert.deepEqual(original, before, '复核不修改历史评估');
  assert.equal(refreshCompanyEvidence(expired, +NOW + 21700000).status, 'pending');
});

test('紧凑快照只保留所需报告和参与结论来源，不复制正文和未使用的坏第三方条目', () => {
  const bundle = companyBundle(symbol, NOW);
  bundle.industryDocuments = [{ id: 'unused', kind: 'industry-report', url: 'bad', fetchedAt: 1 }];
  const result = evaluate(bundle), snapshot = result.sourceValidity;
  assert.equal(result.status, 'pass'); assert.equal(refreshCompanyEvidence(result, +NOW + 1).status, 'pass');
  assert.equal(snapshot.documents.length, 2);
  assert.ok(snapshot.documents.every(document => !Object.hasOwn(document, 'text') && !Object.hasOwn(document, 'fullText') && !Object.hasOwn(document, 'pageTexts')));
  assert.ok(JSON.stringify(snapshot).length < 2500);
});

test('目录重新核验后可继续使用旧的不可变报告正文，报告fetchedAt不误套6小时', () => {
  const bundle = companyBundle(symbol, NOW);
  for (const document of bundle.documents) document.fetchedAt = +NOW - 30 * 86400000;
  const result = evaluate(bundle);
  assert.equal(result.status, 'pass'); assert.equal(refreshCompanyEvidence(result, +NOW + 1).status, 'pass');
  assert.ok(result.sourceValidity.documents.every(document => document.fetchedAt === +NOW - 30 * 86400000));
});

test('跨5月1日重新要求最近完整年报，不让6小时内的旧年度结论继续放行', () => {
  const at = new Date('2026-04-30T23:59:00+08:00'), bundle = companyBundle(symbol, at);
  bundle.documents = bundle.documents.filter(document => document.kind === 'annual-report').map(document => ({ ...document,
    reportDate: '2024-12-31', period: '2024年度', publishedAt: '2025-04-01', title: '2024年年度报告',
    text: document.text.replaceAll('2025', '2024'), fullText: document.fullText.replaceAll('2025', '2024') }));
  const result = evaluate(bundle, at);
  assert.equal(result.status, 'pass'); assert.equal(refreshCompanyEvidence(result, at).status, 'pass');
  const refreshed = refreshCompanyEvidence(result, new Date('2026-05-01T00:00:00+08:00'));
  assert.equal(refreshed.status, 'pending'); assert.match(refreshed.checks[0].reason, /2025年完整年度报告/);
  assert.equal(result.sourceValidity.minimumAnnualReportDate, '2024-12-31');
});

test('跨9月1日重新要求本年半年报，同时保留原始排名与来源', () => {
  const at = new Date('2026-08-31T23:59:00+08:00'), bundle = companyBundle(symbol, at);
  bundle.documents = bundle.documents.filter(document => document.kind === 'annual-report');
  const result = evaluate(bundle, at); assert.equal(result.status, 'pass');
  const refreshed = refreshCompanyEvidence(result, new Date('2026-09-01T00:00:00+08:00'));
  assert.equal(refreshed.status, 'pending'); assert.match(refreshed.checks[0].reason, /2026年完整半年度报告/);
  assert.equal(refreshed.industryReview.rows[0].statisticYear, 2025);
  assert.equal(refreshed.industryReview.rows[0].records[0].sourceDocumentId, result.industryReview.rows[0].records[0].sourceDocumentId);
});

test('参与行业结论的第三方原文单独按原始获取时钟过期，未使用的来源不影响有效结论', () => {
  const bundle = companyBundle(symbol, NOW);
  for (const document of bundle.documents) {
    document.title = `隔离声学:${document.title}`;
    document.text = document.text.replace('公司名称：', '第二节 公司简介和主要财务指标\n一、公司信息\n公司名称：')
      .split('\n').filter(line => !line.includes('排名第')).join('\n'); document.fullText = document.text;
    document.pageTexts = [{ page: 1, method: 'provider-text', complete: true, numericEligible: true, text: document.text, textHash: hash(document.text) }];
  }
  const text = '2025年隔离声学股份有限公司在全国汽车扬声器市场份额排名第1，统计覆盖全部竞争者。';
  const fetchedAt = +NOW - 5 * 3600000;
  bundle.industryDocuments = [{ id: 'third-party', issuerSymbol: symbol, kind: 'industry-report', title: '2025年行业统计',
    url: 'https://www.frostchina.com/content/insight/detail/abcdef', complete: true, publishedAt: '2026-10-14', fetchedAt,
    text, textHash: hash(text), sourceHash: hash(text), pages: 1,
    pageTexts: [{ page: 1, method: 'provider-text', complete: true, numericEligible: true, text }] }];
  const result = evaluate(bundle); assert.equal(result.status, 'pass');
  assert.equal(result.sourceValidity.documents.find(document => document.id === 'third-party').fetchedAt, fetchedAt);
  assert.equal(refreshCompanyEvidence(result, +NOW + 3600000).status, 'pass');
  const expired = refreshCompanyEvidence(result, +NOW + 3600001);
  assert.equal(expired.status, 'pending'); assert.match(expired.checks[0].reason, /第三方原文原始获取时间超过6小时/);
});

test('缺失或未来时点快照的旧通过不能发布，明确失败和原待核验不会被新时钟复活或覆盖', () => {
  const valid = evaluate(), { sourceValidity, ...legacy } = valid;
  assert.equal(refreshCompanyEvidence(legacy, NOW).status, 'pending');
  const future = structuredClone(valid); future.sourceValidity.fetchedAt = +NOW + 1;
  assert.equal(refreshCompanyEvidence(future, NOW).status, 'pending');
  const failedBundle = companyBundle(symbol, NOW);
  for (const document of failedBundle.documents) document.text = document.fullText = document.text.replace('排名第1', '排名第9');
  const failed = evaluate(failedBundle); assert.equal(failed.status, 'fail');
  assert.strictEqual(refreshCompanyEvidence(failed, +NOW + 21600001), failed);
  const pendingBundle = companyBundle(symbol, NOW); pendingBundle.fetchedAt = 1;
  const pending = evaluate(pendingBundle); assert.equal(pending.status, 'pending');
  assert.strictEqual(refreshCompanyEvidence(pending, +NOW + 21600001), pending);
});

test('依赖后续公告完整覆盖的旧产品核验跨日需重新采集', () => {
  const at = new Date('2026-10-15T23:59:00+08:00'), bundle = companyBundle(symbol, at);
  const result = evaluateCompanyEvidence(bundle, { conditions: ['productOutlook'] }, at);
  assert.equal(result.status, 'pass');
  const refreshed = refreshCompanyEvidence(result, new Date('2026-10-16T00:00:00+08:00'));
  assert.equal(refreshed.status, 'pending'); assert.match(refreshed.checks[0].reason, /公告目录尚未覆盖当日/);
});
