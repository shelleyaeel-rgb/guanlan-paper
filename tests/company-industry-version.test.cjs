'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { CompanyIndustrySource, discoveryTerms } = require('../core/company-industry-source.cjs');

const SYMBOL = 'sh600001', NOW = Date.parse('2026-10-23T10:00:00+08:00');
const hash = value => createHash('sha256').update(value).digest('hex');
const parser = { parse: async () => { throw Error('隔离测试不读取PDF'); } };
const bundle = () => ({ symbol: SYMBOL, documents: [{ issuerSymbol: SYMBOL, kind: 'annual-report', complete: true,
  title: '隔离声学:2025年年度报告', reportDate: '2025-12-31', text: '隔离发行人的完整年度报告' }] });
const fingerprint = () => hash(JSON.stringify(discoveryTerms(bundle())));
function item(at = NOW) {
  return { version: 1, symbol: SYMBOL, fingerprint: fingerprint(), fetchedAt: at,
    industryDocuments: [{ id: 'frost-isolated', kind: 'industry-report', issuerSymbol: SYMBOL, complete: true,
      text: '原始行业事实', textHash: hash('原始行业事实'), fetchedAt: at,
      pageTexts: [{ page: 1, text: '原始行业事实', method: 'provider-text', complete: true, numericEligible: true }] }],
    industryCoverage: { status: 'ready', fetchedAt: at, terms: discoveryTerms(bundle()), issues: [] } };
}

test('行业证据版本只在业务内容或失败状态变化时递增，读取版本不加载正文', async () => {
  let calls = 0, now = NOW;
  const source = new CompanyIndustrySource(async () => { calls++; throw Error('不允许网络'); }, { parser, clock: () => now });
  try {
    assert.equal(source.entryEvidenceVersion(SYMBOL), 0);
    const original = item(); source.save(original);
    const first = source.entryEvidenceVersion(SYMBOL); assert.equal(first, 1);
    now += 1000;
    const renewed = item(now); renewed.checkedAt = now; renewed.cached = true;
    renewed.industryDocuments[0].timings = { downloadMs: 3 };
    renewed.cacheWarnings = ['本地缓存诊断'];
    source.save(renewed); assert.equal(source.entryEvidenceVersion(SYMBOL), first);
    const corrected = structuredClone(renewed); corrected.industryDocuments[0].pageTexts[0].numericEligible = false;
    source.save(corrected); assert.equal(source.entryEvidenceVersion(SYMBOL), first + 1);
    const failed = { ...item(now), industryDocuments: [], industryCoverage: { status: 'error', fetchedAt: now, issues: ['最新行业原文获取失败'] } };
    source.save(failed); assert.equal(source.entryEvidenceVersion(SYMBOL), first + 2);
    source.save(original); assert.equal(source.entryEvidenceVersion(SYMBOL), first + 3, '恢复旧内容仍产生新版本，旧决策不能重新获得许可');
    source.cachePath = () => { throw Error('读取版本不能访问磁盘'); };
    source.observeEntryEvidence = () => { throw Error('读取版本不能重新序列化正文'); };
    for (let index = 0; index < 10; index++) assert.equal(source.entryEvidenceVersion(SYMBOL), first + 3);
    assert.equal(calls, 0);
  } finally { await source.destroy(); }
});

test('行业enrich结果绑定完成时版本，相同缓存保持版本，后续失败撤销旧版本', async () => {
  let now = NOW, failed = false, calls = 0;
  const row = { _id: '69eb362eeb778a7e2b5004d7', title: '隔离行业统计', category: 'insight', status: 1,
    publishDate: '2026-10-22T00:00:00.000Z', content: '<p>已核验的隔离行业事实。</p>' };
  const source = new CompanyIndustrySource(async url => {
    calls++;
    if (failed) return new Response('', { status: 503 });
    return url.includes('/api/') ? new Response(JSON.stringify({ errCode: 0, data: { data: [row] } }))
      : new Response(`<div class="content">${row.content}</div>`);
  }, { parser, clock: () => now });
  try {
    const first = await source.enrich(bundle());
    assert.equal(first.industryCoverage.status, 'ready'); assert.equal(first.industryEvidenceVersion, 1);
    assert.equal(first.industryEvidenceVersion, source.entryEvidenceVersion(SYMBOL));
    const beforeCache = calls, cached = await source.enrich(bundle());
    assert.equal(cached.industryEvidenceVersion, first.industryEvidenceVersion); assert.equal(calls, beforeCache);
    now += 21600001; failed = true;
    const unavailable = await source.enrich(bundle());
    assert.equal(unavailable.industryCoverage.status, 'error');
    assert.ok(unavailable.industryEvidenceVersion > first.industryEvidenceVersion);
    assert.equal(unavailable.industryEvidenceVersion, source.entryEvidenceVersion(SYMBOL));
    assert.equal(first.industryEvidenceVersion, 1, '早先返回的快照不会被新版本原地修改');
  } finally { await source.destroy(); }
});

test('行业磁盘缓存首次读取发布内存版本，版本查询本身不会读取缓存', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-industry-version-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('guanlan-industry-version-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const fetcher = async () => { throw Error('磁盘缓存测试不允许网络'); };
  const first = new CompanyIndustrySource(fetcher, { directory, parser, clock: () => NOW });
  first.save(item()); await first.destroy();
  const restored = new CompanyIndustrySource(fetcher, { directory, parser, clock: () => NOW });
  try {
    assert.equal(restored.entryEvidenceVersion(SYMBOL), 0);
    const result = await restored.enrich(bundle());
    assert.equal(result.industryEvidenceVersion, 1); assert.equal(restored.entryEvidenceVersion(SYMBOL), 1);
    assert.equal((await restored.enrich(bundle())).industryEvidenceVersion, 1);
  } finally { await restored.destroy(); }
});

test('行业缓存写入失败仍为本次已取得正文绑定有效版本', async () => {
  const source = new CompanyIndustrySource(async () => new Response(JSON.stringify({ errCode: 0, data: { data: [] } })), { parser, clock: () => NOW });
  source.save = () => { throw Error('隔离缓存写入失败'); };
  try {
    const result = await source.enrich(bundle());
    assert.equal(result.industryEvidenceVersion, 1); assert.equal(result.industryEvidenceVersion, source.entryEvidenceVersion(SYMBOL));
    assert.match(result.industryCoverage.issues.join('；'), /缓存保存失败/);
  } finally { await source.destroy(); }
});
