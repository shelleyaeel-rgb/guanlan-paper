'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyEvidenceSource } = require('../core/company-evidence-source.cjs');
const { checkNoticeWithEvidence } = require('../core/company-notice-review.cjs');
const SYMBOL = 'sh600001', NOW = Date.parse('2026-10-15T10:00:00+08:00');
const RESOLVED = '本次诉讼已结案，相关义务已全部履行完毕。本次诉讼对公司生产经营未造成重大不利影响。';
const notice = (id = 'AN20261013000001', title = '关于诉讼结案的公告') => ({ id, title, date: '2026-10-13', categories: [] });
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-notice-source-'));
  let now = NOW, override;
  const rows = new Map([[notice().id, { ...notice(), text: RESOLVED }]]), calls = [];
  const fetcher = async (input, request) => {
    const url = new URL(input); calls.push(url.href);
    assert.equal(url.hostname, 'np-cnotice-stock.eastmoney.com', 'notice-only collection must never request a report index or industry source');
    if (override) { const result = await override(url, request); if (result) return result; }
    const row = rows.get(url.searchParams.get('art_code'));
    return response(row);
  };
  const create = () => new CompanyEvidenceSource(fetcher, { directory, clock: () => now, parser: { destroy() {} },
    transportOptions: { retryBaseMs: 0 }, ...options });
  const source = create();
  t.after(async () => {
    await source.destroy();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('guanlan-notice-source-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { source, create, rows, calls, directory, now: () => now, advance: ms => now += ms,
    override: fn => { override = fn; }, index: (items = [...rows.values()].map(({ text, ...item }) => item), changes = {}) => ({ symbol: SYMBOL, section: 'notices', source: '东方财富',
      status: items.length ? 'ready' : 'empty', fetchedAt: now, data: { items, total: items.length }, ...changes }) };
}
function response(row, changes = {}) {
  return { ok: true, json: async () => ({ success: 1, data: { art_code: row.id, notice_title: row.title, notice_date: row.date,
    security: [{ stock: SYMBOL.slice(2), market_uni: '1' }], page_size: 1, page_index: 1, notice_content: row.text, is_ai_summary: 0, ...changes } }) };
}

test('公告专用采集只读取敏感原文、复用完整正文缓存，不覆盖完整研究bundle', async t => {
  const f = fixture(t), ordinary = notice('AN20261013000002', '关于召开股东大会的通知');
  const sentinel = { saved: 'isolated full research bundle' }, bundlePath = path.join(f.directory, `bundle-${SYMBOL}.json`);
  f.source.bundles.set(SYMBOL, sentinel); fs.writeFileSync(bundlePath, JSON.stringify(sentinel));
  const index = f.index([notice(), ordinary]), result = await f.source.getNotices(SYMBOL, { noticeResponse: index });
  assert.equal(result.status, 'ready'); assert.equal(result.scope, 'sensitive-notices-only');
  assert.deepEqual(result.coverage.requestedIds, [notice().id]); assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].kind, 'notice'); assert.equal(result.documents[0].pageTexts[0].method, 'provider-text');
  assert.equal(result.documents[0].pageTexts[0].numericEligible, true);
  assert.equal(checkNoticeWithEvidence(index, SYMBOL, result, new Date(f.now())).status, 'clear');
  assert.equal(f.calls.length, 1); assert.equal(f.source.bundles.get(SYMBOL), sentinel);
  assert.equal(fs.readFileSync(bundlePath, 'utf8'), JSON.stringify(sentinel));
  const restarted = f.create(); t.after(() => restarted.destroy());
  const cached = await restarted.getNotices(SYMBOL, { noticeResponse: index, force: true });
  assert.equal(cached.acquisition.documents.reused, 1); assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(bundlePath, 'utf8'), JSON.stringify(sentinel));
});

test('陈旧、不完整、错公司、明确不利或无敏感项的目录不会触发正文采集', async t => {
  const f = fixture(t), invalid = [f.index(undefined, { fetchedAt: NOW - 300001 }),
    f.index(undefined, { symbol: 'sz000001' }), f.index(undefined, { data: { items: [notice()], total: 2 } }),
    f.index([notice(undefined, '关于公司涉嫌违法被立案的公告')])];
  for (const noticeResponse of invalid) {
    const result = await f.source.getNotices(SYMBOL, { noticeResponse });
    assert.equal(result.documents.length, 0); assert.equal(result.status, 'unavailable'); assert.equal(result.acquisition.status, 'skipped');
    assert.ok(result.errors.length);
  }
  for (const noticeResponse of [f.index([]), f.index([notice(undefined, '关于召开股东大会的通知')])]) {
    const result = await f.source.getNotices(SYMBOL, { noticeResponse });
    assert.equal(result.status, 'ready'); assert.equal(result.acquisition.code, 'no-sensitive-notices'); assert.equal(result.documents.length, 0);
  }
  assert.equal(f.calls.length, 0);
});

test('同目录并发复用请求，返回副本；更正标题和新增公告不能沿用旧正文集合', async t => {
  const f = fixture(t), index = f.index();
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.override(async url => { const captured = { ...f.rows.get(url.searchParams.get('art_code')) }; started(); await gate; return response(captured); });
  const first = f.source.getNotices(SYMBOL, { noticeResponse: index }); await began;
  const duplicate = f.source.getNotices(SYMBOL, { noticeResponse: index });
  const corrected = { ...notice(), title: '关于诉讼结案的更正公告', text: RESOLVED + '本公告更正前次披露的事项。' };
  f.rows.set(corrected.id, corrected);
  const second = f.source.getNotices(SYMBOL, { noticeResponse: f.index() });
  const extra = { ...notice('AN20261014000002', '关于重大诉讼的公告'), text: '公司本次重大诉讼尚未结案，相关义务尚未完成，案件实际影响存在不确定性，后续进展另行公告。' };
  f.rows.set(extra.id, extra);
  const latestIndex = f.index(), third = f.source.getNotices(SYMBOL, { noticeResponse: latestIndex });
  release(); const [one, copy, amended, expanded] = await Promise.all([first, duplicate, second, third]);
  assert.equal(one.documents[0].title, notice().title); assert.deepEqual(copy, one);
  one.documents[0].text = 'changed local copy'; assert.equal(copy.documents[0].text, RESOLVED);
  assert.equal(amended.documents[0].title, corrected.title); assert.equal(amended.documents.length, 1);
  assert.deepEqual(expanded.coverage.requestedIds, [corrected.id, extra.id]);
  assert.equal(expanded.documents.length, 2);
  assert.equal(checkNoticeWithEvidence(latestIndex, SYMBOL, expanded, new Date(f.now())).status, 'unverified');
  assert.equal(f.calls.length, 4, 'identical in-flight directory shares one fetch; revised or expanded directories are separate');
  assert.equal(f.source.pendingNotices.size, 0); assert.equal(f.source.pending.size, 0);
});

test('正文身份、分页及网络失败保留逐公告诊断，不能冒充完整采集', async t => {
  const f = fixture(t), ids = ['AN20261013000001', 'AN20261013000002', 'AN20261013000003', 'AN20261013000004'];
  for (const id of ids.slice(1)) f.rows.set(id, { ...notice(id), text: RESOLVED });
  f.override(url => {
    const id = url.searchParams.get('art_code'), row = f.rows.get(id);
    if (id === ids[1]) return response(row, { security: [{ stock: '600002', market_uni: '1' }] });
    if (id === ids[2]) return new Response('', { status: 404 });
    if (id === ids[3]) return response(row, { page_size: 0 });
    return null;
  });
  const index = f.index(), result = await f.source.getNotices(SYMBOL, { noticeResponse: index });
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.documents.map(item => item.id), [ids[0]]);
  assert.equal(result.acquisition.documents.failed, 3); assert.equal(result.coverage.documentFailures.length, 3);
  assert.ok(result.acquisition.issues.some(issue => issue.documentId === ids[1] && /股票身份/.test(issue.message)));
  assert.ok(result.acquisition.issues.some(issue => issue.documentId === ids[2] && issue.code === 'http-404'));
  assert.ok(result.acquisition.issues.some(issue => issue.documentId === ids[3] && /页码无效/.test(issue.message)));
  assert.equal(checkNoticeWithEvidence(index, SYMBOL, result, new Date(f.now())).status, 'unverified');
  assert.equal(f.source.requests, 0); assert.equal(f.source.activeDocuments.size, 0);
});

test('并发正文沿用全局请求上限，取消释放工作者和等待队列，不影响另一目录请求', async t => {
  const f = fixture(t, { maxConcurrent: 1 });
  const extra = { ...notice('AN20261014000002'), text: RESOLVED }; f.rows.set(extra.id, extra);
  let release, started;
  const began = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.override(async (url, request) => {
    if (url.searchParams.get('art_code') !== notice().id) return null;
    started(); await new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' })), { once: true });
      gate.then(resolve);
    });
    return response(f.rows.get(notice().id));
  });
  const controller = new AbortController(), cancelled = f.source.getNotices(SYMBOL, { noticeResponse: f.index([notice()]), signal: controller.signal });
  const rejected = assert.rejects(cancelled, error => error.name === 'AbortError'); await began;
  const other = f.source.getNotices(SYMBOL, { noticeResponse: f.index([notice(extra.id)]) });
  assert.equal(f.source.requests, 1); controller.abort(); release(); await rejected;
  const result = await other;
  assert.equal(result.status, 'ready'); assert.deepEqual(result.documents.map(item => item.id), [extra.id]);
  assert.equal(f.source.requests, 0); assert.equal(f.source.waiters.length, 0);
  assert.equal(f.source.pendingNotices.size, 0); assert.equal(f.source.activeDocuments.size, 0);
  assert.equal(fs.existsSync(path.join(f.directory, `bundle-${SYMBOL}.json`)), false);
});

test('耗时下载不续期旧目录，超文档预算不输出截断正文或成功状态', async t => {
  const f = fixture(t), index = f.index();
  f.override(() => { f.advance(300001); return null; });
  const expired = await f.source.getNotices(SYMBOL, { noticeResponse: index });
  assert.equal(expired.status, 'partial'); assert.equal(expired.coverage.complete, false);
  assert.ok(expired.acquisition.issues.some(issue => issue.code === 'notice-index-expired'));
  assert.equal(checkNoticeWithEvidence(index, SYMBOL, expired, new Date(f.now())).status, 'unverified');
  const limited = fixture(t, { maxCompanyDocumentBytes: 50 });
  const result = await limited.source.getNotices(SYMBOL, { noticeResponse: limited.index() });
  assert.equal(result.status, 'unavailable'); assert.equal(result.documents.length, 0);
  assert.ok(result.acquisition.issues.some(issue => issue.code === 'company-document-budget'));
});
