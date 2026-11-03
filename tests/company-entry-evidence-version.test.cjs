'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { CompanyEvidenceSource } = require('../core/company-evidence-source.cjs');

const SYMBOL = 'sh600001', NOW = Date.parse('2026-10-22T10:00:00+08:00');
const ID = 'AN20261021000001', TITLE = '关于诉讼结案的公告';
const TEXT = '本次诉讼已结案，相关义务已全部履行完毕。本次诉讼对公司生产经营未造成重大不利影响。';
const hash = value => createHash('sha256').update(value).digest('hex');
const document = () => ({ id: ID, symbol: SYMBOL, issuerSymbol: SYMBOL, title: TITLE, publishedAt: '2026-10-21', kind: 'notice',
  text: TEXT, textHash: hash(TEXT), sourceHash: hash(TEXT), fingerprint: 'verified-identity', fetchedAt: NOW, complete: true,
  format: 'provider-text', parserVersion: 'provider-text-2', pages: 1, numericEligible: true,
  pageTexts: [{ page: 1, text: TEXT, textHash: hash(TEXT), method: 'provider-text', complete: true, numericEligible: true, issues: [] }] });
const bundle = () => ({ symbol: SYMBOL, checkedAt: NOW, fetchedAt: NOW, status: 'ready', documents: [document()], errors: [],
  coverage: { fromDate: '2025-01-01', toDate: '2026-10-22', noticeIndexComplete: true, complete: true, documentFailures: [] },
  acquisition: { status: 'ready', issues: [], events: [], documents: { loaded: 1, reused: 0 } } });
function fixture(t) {
  let now = NOW, nextDocument = document(), failure = '', bodyCalls = 0;
  const saved = [], source = new CompanyEvidenceSource(() => assert.fail('版本测试不得访问网络'), { clock: () => now, parser: { destroy() {} } });
  source.write = (_name, value) => saved.push(structuredClone(value));
  source.body = async () => { bodyCalls++; if (failure) throw Error(failure); return structuredClone(nextDocument); };
  t.after(() => source.destroy());
  return { source, saved, calls: () => bodyCalls, advance: ms => { now += ms; }, setDocument: value => { nextDocument = value; }, fail: value => { failure = value; },
    index: (items = [{ id: ID, title: TITLE, date: '2026-10-21', categories: [] }]) => ({ symbol: SYMBOL, section: 'notices', source: '东方财富',
      status: items.length ? 'ready' : 'empty', fetchedAt: now, data: { items, total: items.length } }) };
}

test('研究版本 getter 仅查内存，首次已完成资料响应带版本且不持久化', t => {
  const f = fixture(t), value = bundle();
  f.source.peek = () => assert.fail('getter 不得读取或水合缓存');
  f.source.cacheLocation = () => assert.fail('getter 不得访问磁盘');
  assert.equal(f.source.entryEvidenceVersion(SYMBOL), 0);
  f.source.saveBundle(value);
  assert.equal(value.entryEvidenceVersion, 1); assert.equal(f.source.entryEvidenceVersion(SYMBOL), 1);
  assert.equal(f.source.entryEvidenceVersion('sh600002'), 0);
  assert.equal(f.saved[0].entryEvidenceVersion, undefined);
  assert.equal(f.source.bundles.get(SYMBOL).entryEvidenceVersion, undefined);
  assert.equal(f.calls(), 0);
});

test('同业务内容的研究续取不增版本，取数时间缓存与进度不改变事实指纹', t => {
  const f = fixture(t), first = bundle(); f.source.saveBundle(first);
  const next = structuredClone(first);
  next.checkedAt += 1000; next.fetchedAt += 1000; next.cached = true; next.cacheWarnings = ['磁盘保存提示'];
  next.documents[0].fetchedAt += 1000; next.documents[0].cached = true; next.documents[0].timings = { parseMs: 250, queuedMs: 20 };
  next.documents[0].cacheWarning = '缓存提示'; next.acquisition.documents.reused = 1;
  next.acquisition.events.push({ stage: 'documents', completed: 1, total: 1 });
  f.source.saveBundle(next);
  assert.equal(next.entryEvidenceVersion, first.entryEvidenceVersion);
  assert.equal(f.source.entryEvidenceVersion(SYMBOL), first.entryEvidenceVersion);
  assert.equal(first.fetchedAt, NOW); assert.equal(first.documents[0].fetchedAt, NOW);
});

test('研究正文身份、文本、解析完整性、覆盖和失败变化立即撤销旧版本', async t => {
  for (const [name, change] of [
    ['文档身份', value => { value.documents[0].id = 'AN20261021000002'; }],
    ['正文修订', value => { value.documents[0].text += '更正后诉讼尚未结案。'; }],
    ['原文哈希修订', value => { value.documents[0].sourceHash = 'a'.repeat(64); }],
    ['逐页解析不完整', value => { value.documents[0].pageTexts[0].complete = false; }],
    ['逐页数字不可用', value => { value.documents[0].pageTexts[0].numericEligible = false; }],
    ['覆盖失效', value => { value.coverage.noticeIndexComplete = false; }],
    ['资料失败', value => { value.status = 'unavailable'; value.errors = ['正文无法获取']; }],
    ['新模块失败', value => { value.acquisition.issues = [{ stage: 'parse', code: 'invalid-page', documentId: ID, message: '正文解析失败', attempts: 2 }]; }]
  ]) await t.test(name, t => {
    const f = fixture(t), first = bundle(); f.source.saveBundle(first);
    const next = structuredClone(first); change(next); f.source.saveBundle(next);
    assert.equal(next.entryEvidenceVersion, first.entryEvidenceVersion + 1);
    assert.equal(first.entryEvidenceVersion, 1, '旧响应的版本不能被较晚响应改写');
    assert.equal(f.source.entryEvidenceVersion(SYMBOL), 2);
  });
});

test('敏感公告完整响应同内容续取保留版本，正文修订与失败各自产生新版本', async t => {
  const f = fixture(t), first = await f.source.getNotices(SYMBOL, { noticeResponse: f.index() });
  assert.equal(first.entryEvidenceVersion, 1);
  f.advance(1000);
  const cached = document(); cached.fetchedAt += 1000; cached.cached = true; cached.timings = { parseMs: 50 }; f.setDocument(cached);
  const same = await f.source.getNotices(SYMBOL, { noticeResponse: f.index() });
  assert.equal(same.entryEvidenceVersion, first.entryEvidenceVersion);
  const revised = document(); revised.text += '更正：仍有部分义务未完成。'; revised.textHash = hash(revised.text); f.setDocument(revised);
  const changed = await f.source.getNotices(SYMBOL, { noticeResponse: f.index() });
  assert.equal(changed.entryEvidenceVersion, 2); assert.equal(first.entryEvidenceVersion, 1);
  f.fail('公告正文接口失败');
  const failed = await f.source.getNotices(SYMBOL, { noticeResponse: f.index() });
  assert.equal(failed.status, 'unavailable'); assert.equal(failed.entryEvidenceVersion, 3);
  const repeat = await f.source.getNotices(SYMBOL, { noticeResponse: f.index() });
  assert.equal(repeat.entryEvidenceVersion, 3); assert.equal(f.source.entryEvidenceVersion(SYMBOL), 3);
  assert.equal(f.source.bundles.size, 0, '敏感公告版本不能覆盖完整研究缓存');
});

test('无敏感项与无效目录也发布准确版本，不触发正文获取', async t => {
  const f = fixture(t);
  const clear = await f.source.getNotices(SYMBOL, { noticeResponse: f.index([]) });
  f.advance(1000);
  const same = await f.source.getNotices(SYMBOL, { noticeResponse: f.index([]) });
  assert.equal(clear.entryEvidenceVersion, same.entryEvidenceVersion);
  const badIndex = { ...f.index([]), status: 'unavailable', error: '目录获取失败' };
  const failed = await f.source.getNotices(SYMBOL, { noticeResponse: badIndex });
  assert.equal(failed.entryEvidenceVersion, clear.entryEvidenceVersion + 1);
  assert.equal(f.calls(), 0);
});

test('研究缓存命中携带完成版本，保留原始证据时间且不重复递增', async t => {
  const f = fixture(t), value = bundle(); f.source.saveBundle(value);
  f.source.peek = () => structuredClone(value);
  f.advance(1000);
  const cached = await f.source.get(SYMBOL);
  assert.equal(cached.cached, true); assert.equal(cached.entryEvidenceVersion, value.entryEvidenceVersion);
  assert.equal(cached.fetchedAt, NOW); assert.equal(cached.checkedAt, NOW); assert.equal(cached.documents[0].fetchedAt, NOW);
  assert.equal(f.calls(), 0);
});

test('敏感公告失败后完整研究旧缓存不能获得新版本，重新采集失败继续阻断，恢复后才重新就绪', async t => {
  const f = fixture(t), original = bundle(); f.source.saveBundle(original);
  let fresh = structuredClone(original), collectCalls = 0;
  f.source.peek = () => structuredClone(original);
  f.source.collect = async (symbol, signal, callback, options) => {
    assert.equal(symbol, SYMBOL); assert.equal(options.force, false, '沿用正常后台采集与缓存策略');
    collectCalls++;
    const result = structuredClone(fresh); f.source.saveBundle(result); return result;
  };
  const cacheHit = await f.source.get(SYMBOL);
  assert.equal(cacheHit.entryEvidenceVersion, original.entryEvidenceVersion); assert.equal(collectCalls, 0);
  f.fail('敏感公告正文查新失败');
  const noticeFailure = await f.source.getNotices(SYMBOL, { noticeResponse: f.index() });
  assert.equal(noticeFailure.status, 'unavailable');
  assert.ok(noticeFailure.entryEvidenceVersion > original.entryEvidenceVersion);
  fresh.status = 'unavailable'; fresh.documents = []; fresh.coverage.complete = false; fresh.errors = ['正文新核验仍失败'];
  const failed = await f.source.get(SYMBOL);
  assert.equal(collectCalls, 1); assert.equal(failed.status, 'unavailable');
  assert.equal(failed.cached, undefined); assert.equal(original.entryEvidenceVersion, 1);
  // Use the actually published full failure for subsequent reads.
  f.source.peek = () => structuredClone(fresh);
  const failedAgain = await f.source.get(SYMBOL);
  assert.equal(collectCalls, 2); assert.equal(failedAgain.status, 'unavailable');
  assert.equal(failedAgain.entryEvidenceVersion, failed.entryEvidenceVersion);
  fresh = bundle();
  // A current failure must still take the collection path before recovery.
  f.source.peek = () => structuredClone(failedAgain);
  const recovered = await f.source.get(SYMBOL);
  assert.equal(collectCalls, 3); assert.equal(recovered.status, 'ready');
  assert.equal(recovered.entryEvidenceVersion, f.source.entryEvidenceVersion(SYMBOL));
  f.source.peek = () => structuredClone(recovered);
  const reused = await f.source.get(SYMBOL);
  assert.equal(collectCalls, 3); assert.equal(reused.entryEvidenceVersion, recovered.entryEvidenceVersion);
  assert.equal(reused.fetchedAt, original.fetchedAt);
});

test('另一资料路径完成后，完整研究同内容重新采集可追上版本，缓存读取本身不能续版', async t => {
  const f = fixture(t), original = bundle(); f.source.saveBundle(original);
  f.source.peek = () => structuredClone(original);
  await f.source.getNotices(SYMBOL, { noticeResponse: f.index() });
  const changedVersion = f.source.entryEvidenceVersion(SYMBOL);
  assert.ok(changedVersion > original.entryEvidenceVersion);
  let complete;
  f.source.collect = () => new Promise(resolve => { complete = () => {
    const fresh = structuredClone(original); f.source.saveBundle(fresh); resolve(fresh);
  }; });
  const pending = f.source.get(SYMBOL);
  assert.equal(f.source.entryEvidenceVersion(SYMBOL), changedVersion);
  assert.equal(original.entryEvidenceVersion, 1);
  complete();
  const fresh = await pending;
  assert.equal(fresh.entryEvidenceVersion, changedVersion);
  assert.equal(f.source.entryEvidenceVersion(SYMBOL), changedVersion, '相同业务内容的新完成不额外增版');
});
