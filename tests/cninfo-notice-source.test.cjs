'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { createHash } = require('node:crypto');
const { CninfoNoticeSource, cninfoAttachment } = require('../core/cninfo-notice-source.cjs');
const { Research } = require('../core/research.cjs');
const { checkNoticeRisk } = require('../core/entry-risk.cjs');
const { CompanyEvidenceSource } = require('../core/company-evidence-source.cjs');
const { CorporateSource } = require('../core/corporate-source.cjs');
const { PARSER_VERSION } = require('../core/company-document-parser.cjs');
const NOW = Date.parse('2026-10-19T12:00:00+08:00'), SYMBOL = 'sz000001', FROM = '2026-01-01', TO = '2026-10-19';
const digest = value => createHash('sha256').update(value).digest('hex');
const identity = [{ code: '000001', category: 'A股', delisted: 'false', orgId: 'gssz0000001' }];
const row = (id = '1225601360', date = '2026-10-13', title = '关于副行长任职资格核准的公告') => ({ secCode: '000001', orgId: 'gssz0000001',
  announcementId: id, announcementTitle: title, announcementTime: Date.parse(`${date}T00:00:00+08:00`),
  adjunctUrl: `finalpage/${date}/${id}.PDF`, adjunctType: 'PDF', pageColumn: 'SZZB' });
const page = (rows, total = rows.length, hasMore = false) => ({ announcements: rows, totalAnnouncement: total, totalRecordNum: total, hasMore });
const json = data => ({ ok: true, json: async () => structuredClone(data) });
function fixture(options = {}) {
  let now = NOW, override; const calls = [];
  const fetcher = async (url, request) => {
    const params = new URLSearchParams(request.body); calls.push({ url, params, request });
    if (override) { const response = await override(url, request, params); if (response) return response; }
    return json(url.endsWith('/topSearch/query') ? identity : page([row()]));
  };
  const source = new CninfoNoticeSource(fetcher, { clock: () => now, minIntervalMs: 0, transportOptions: { maxAttempts: 1, retryBaseMs: 0 }, ...options });
  return { source, fetcher, calls, override: fn => { override = fn; }, advance: ms => { now += ms; }, get now() { return now; } };
}
test('巨潮公开目录按独立身份分页、共享缓存、force刷新并保留原数据时间', async () => {
  const f = fixture({ pageSize: 2 });
  f.override((url, request, params) => url.endsWith('/hisAnnouncement/query') ? json(params.get('pageNum') === '1'
    ? page([row(), row('1225587230', '2026-09-30')], 3, true) : page([row('1225574840', '2026-09-22')], 3)) : null);
  const first = await f.source.getIndex(SYMBOL, FROM, TO); assert.equal(first.complete, true); assert.equal(first.items.length, 3);
  assert.deepEqual(first.items.map(item => item.id), ['CN1225601360','CN1225587230','CN1225574840']);
  assert.ok(f.calls.every(call => call.request.method === 'POST'));
  assert.equal(f.calls[1].params.get('stock'), '000001,gssz0000001'); assert.equal(f.calls[1].params.get('column'), 'szse');
  f.advance(1000); const cached = await f.source.getIndex(SYMBOL, FROM, TO); assert.equal(cached.fetchedAt, first.fetchedAt); assert.equal(f.calls.length, 3);
  const forced = await f.source.getIndex(SYMBOL, FROM, TO, { force: true }); assert.equal(f.calls.length, 5); assert.equal(forced.fetchedAt, f.now);
  assert.ok(!forced.items.some(item => item.id.startsWith('AN')));
});
for (const [name, change] of [
  ['空目录', () => page([], 0)], ['错误证券', j => (j.announcements[0].secCode = '000002', j)],
  ['错误机构', j => (j.announcements[0].orgId = 'gssz0000002', j)], ['错误市场', j => (j.announcements[0].pageColumn = 'SHZB', j)],
  ['目录日期与PDF不符', j => (j.announcements[0].adjunctUrl = 'finalpage/2026-10-12/1225601360.PDF', j)],
  ['PDF编号不符', j => (j.announcements[0].adjunctUrl = 'finalpage/2026-10-13/1225601361.PDF', j)],
  ['非PDF附件', j => (j.announcements[0].adjunctType = 'HTML', j)],
  ['重复公告', j => page([j.announcements[0],j.announcements[0]])],
  ['漏页', j => ({ ...j, totalAnnouncement: 2, totalRecordNum: 2 })],
  ['数量冲突', j => ({ ...j, totalRecordNum: 2 })],
  ['标题含HTML', j => (j.announcements[0].announcementTitle = '<em>风险</em>', j)]
]) test(`巨潮拒绝${name}，失败结果不能进入完整缓存`, async () => {
  const f = fixture(); f.override(url => url.endsWith('/hisAnnouncement/query') ? json(change(page([row()]))) : null);
  await assert.rejects(f.source.getIndex(SYMBOL, FROM, TO), /巨潮/); assert.equal(f.source.cache.size, 0);
});
test('巨潮独立编号PDF白名单不能冒充东方财富附件、跨域、用户信息或查询重定向', () => {
  const url = 'https://static.cninfo.com.cn/finalpage/2026-10-13/1225601360.PDF';
  assert.ok(cninfoAttachment(url, 'CN1225601360', '2026-10-13'));
  for (const value of [url.replace('https:', 'http:'), url + '?download=1', url.replace('static.cninfo.com.cn', 'evil.cninfo.com.cn'),
    url.replace('static.cninfo.com.cn', 'user@static.cninfo.com.cn'), url.replace('1225601360.PDF','1225601361.PDF')]) assert.equal(cninfoAttachment(value, 'CN1225601360'), null);
  assert.equal(cninfoAttachment(url, 'AN1225601360'), null);
});
test('巨潮分页数量变化、遗漏或顺序倒退均拒绝，不返回先前页面作为完整目录', async () => {
  for (const later of [page([row('1225587230', '2026-09-30')], 3, true), page([row()], 2), page([row('1225587230', '2026-10-14')], 2)]) {
    const f = fixture({ pageSize: 1 }); f.override((url, request, params) => url.endsWith('/hisAnnouncement/query')
      ? json(params.get('pageNum') === '1' ? page([row()], 2, true) : later) : null);
    await assert.rejects(f.source.getIndex(SYMBOL, FROM, TO), /巨潮/); assert.equal(f.source.cache.size, 0);
  }
});
test('巨潮请求重定向到非原域名时拒绝，不把其他站点JSON视为官方目录', async () => {
  const f = fixture(); f.override(() => ({ ...json(identity), url: 'https://other.example.org/new/information/topSearch/query' }));
  await assert.rejects(f.source.getIndex(SYMBOL, FROM, TO), /重定向/); assert.equal(f.source.cache.size, 0);
});
test('共享巨潮采集单个调用取消不影响其他调用，最后取消后终止网络且可重新请求', async () => {
  const f = fixture(); let ready, finish, activeSignal;
  const began = new Promise(resolve => { ready = resolve; });
  f.override((url, request) => url.endsWith('/hisAnnouncement/query') ? new Promise((resolve, reject) => {
    activeSignal = request.signal; finish = () => resolve(json(page([row()]))); ready(); request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  }) : null);
  const a = new AbortController(), b = new AbortController();
  const first = f.source.getIndex(SYMBOL, FROM, TO, { signal: a.signal }), second = f.source.getIndex(SYMBOL, FROM, TO, { signal: b.signal });
  const firstRejected = assert.rejects(first, /first cancelled/); const secondRejected = assert.rejects(second, /last cancelled/);
  await began; a.abort(Error('first cancelled')); await firstRejected; assert.equal(activeSignal.aborted, false);
  b.abort(Error('last cancelled')); await secondRejected; assert.equal(activeSignal.aborted, true); assert.equal(f.source.cache.size, 0);
  f.override(null); const recovered = await f.source.getIndex(SYMBOL, FROM, TO); assert.equal(recovered.complete, true); assert.equal(f.source.pending.size, 0);
});
test('单个策略取消后其他策略仍取得同一份新鲜巨潮目录，不重复发送网络请求', async () => {
  const f = fixture(); let ready, finish;
  const began = new Promise(resolve => { ready = resolve; });
  f.override((url, request) => url.endsWith('/hisAnnouncement/query') ? new Promise((resolve,reject) => {
    finish = () => resolve(json(page([row()]))); ready(); request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  }) : null);
  const controller = new AbortController(), first = f.source.getIndex(SYMBOL, FROM, TO, { signal: controller.signal });
  const rejected = assert.rejects(first, /cancelled/), second = f.source.getIndex(SYMBOL, FROM, TO);
  await began; controller.abort(Error('cancelled')); await rejected; finish();
  const result = await second; assert.equal(result.complete, true); assert.equal(f.calls.length, 2); assert.equal(f.source.pending.size, 0);
});
test('巨潮整轮截止覆盖排队与分页，不把每页超时累计成无上限后台采集', async () => {
  const f = fixture({ deadlineMs: 30 }); let aborted = false;
  f.override((url, request) => url.endsWith('/hisAnnouncement/query') ? new Promise((resolve,reject) => {
    request.signal.addEventListener('abort', () => { aborted = true; reject(request.signal.reason); }, { once: true });
  }) : null);
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(f.source.getIndex(SYMBOL, FROM, TO), /timeout|超时|aborted/i); assert.equal(aborted, true); assert.equal(f.source.cache.size, 0); }
  finally { clearTimeout(keepAlive); }
});
test('巨潮Retry-After域名暂停不会被另一个策略或强制刷新绕过', async () => {
  const f = fixture(); f.override(() => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) }));
  await assert.rejects(f.source.getIndex(SYMBOL, FROM, TO), /429/); const calls = f.calls.length;
  await assert.rejects(f.source.getIndex(SYMBOL, FROM, TO, { force: true }), /暂缓/); assert.equal(f.calls.length, calls);
});
test('Research备用不伪装来源，force贯穿且不会刷新缓存取得时间，CN风险覆盖仍独立核验', async () => {
  const f = fixture(), research = new Research(async () => { throw Error('EM down'); }, { clock: () => f.now, noticeSource: f.source });
  const first = await research.get({ symbol: SYMBOL, section: 'notices' }); assert.equal(first.source, '巨潮资讯'); assert.equal(first.status, 'ready');
  assert.equal(checkNoticeRisk(first, SYMBOL, new Date(f.now)).status, 'clear');
  f.advance(1000); const fresh = await research.get({ symbol: SYMBOL, section: 'notices', force: true }); assert.equal(f.calls.length, 3); assert.equal(fresh.fetchedAt, f.now);
  const cachedSource = await f.source.getIndex(SYMBOL, '1990-01-01', TO, { firstPageOnly: true }); f.advance(1000);
  const secondResearch = new Research(async () => { throw Error('EM down'); }, { clock: () => f.now, noticeSource: f.source });
  assert.equal((await secondResearch.get({ symbol: SYMBOL, section: 'notices' })).fetchedAt, cachedSource.fetchedAt);
  for (const mutate of [r => { r.data.fromDate = TO; }, r => { r.source = '东方财富'; }, r => { r.data.items[0].issuerSymbol = 'sz000002'; },
    r => { r.data.items = []; r.data.total = 0; r.status = 'empty'; }, r => { r.data.items[0].attachmentUrl = r.data.items[0].attachmentUrl.replace('1360.PDF','1361.PDF'); }]) {
    const invalid = structuredClone(first); mutate(invalid); assert.equal(checkNoticeRisk(invalid, SYMBOL, new Date(f.now)).status, 'unverified');
  }
});
function parsed(text) {
  return { parserVersion: PARSER_VERSION, format: 'pdf', text, pages: 1, complete: true, numericEligible: true, hasOcrPages: false, issues: [],
    pageTexts: [{ page: 1, text, method: 'pdf-text', confidence: null, issues: [], complete: true, numericEligible: true, characters: text.length, textHash: digest(text) }] };
}
function companyFixture(t, { badBody = false, primaryIndex = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-cninfo-test-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^guanlan-cninfo-test-/); fs.rmSync(directory, { recursive: true, force: true }); });
  const f = fixture(); const rows = [row('1225601360','2026-10-13','关于终止减持计划的公告'), row('1225500001','2026-08-15','2026年半年度报告'), row('1225300001','2026-04-17','2025年年度报告')];
  f.override(url => url.endsWith('/hisAnnouncement/query') ? json(page(rows)) : null);
  const calls = [], texts = new Map(rows.map(item => [item.announcementId, `证券代码：${badBody ? '000002' : '000001'}。${item.announcementTitle}。本次减持计划已终止，期间未实施任何减持。本次减持计划终止对公司生产经营未造成重大不利影响。报告完整正文。`]));
  const fetcher = async (url, request) => {
    calls.push(url); const u = new URL(url);
    if (u.hostname === 'np-anotice-stock.eastmoney.com' && primaryIndex) return json({ success: 1, data: { total_hits: rows.length, page_index: 1,
      list: rows.map(item => ({ art_code: `AN${item.announcementId}`, title: item.announcementTitle, notice_date: new Date(item.announcementTime + 28800000).toISOString().slice(0,10), codes: [{ stock_code: '000001', market_code: '0' }] })) } });
    if (u.hostname === 'static.cninfo.com.cn') return new Response(Buffer.from(`%PDF-${path.basename(u.pathname, '.PDF')}`));
    return { ok: false, status: 567, headers: new Headers() };
  };
  const options = { directory, clock: () => NOW, noticeSource: f.source, deferredRecoveryMs: 1, transportOptions: { maxAttempts: 1 }, parser: { parse: async bytes => parsed(texts.get(bytes.toString().slice(5))) } };
  return { ...f, directory, rows, calls, service: new CompanyEvidenceSource(fetcher, options), create: () => new CompanyEvidenceSource(fetcher, options) };
}
test('公司研究目录失败整体切换独立巨潮原PDF，逐页解析/原件hash/重启缓存来源保留', async t => {
  const f = companyFixture(t), bundle = await f.service.get(SYMBOL);
  assert.equal(bundle.status, 'ready'); assert.equal(bundle.documents.length, 3); assert.equal(bundle.coverage.complete, true);
  assert.ok(bundle.documents.every(doc => doc.id.startsWith('CN') && doc.source === '巨潮资讯公告原文' && doc.format === 'pdf-text'));
  assert.ok(bundle.documents.every(doc => f.service.readArchivedArtifact(doc)?.sha256 === doc.sourceHash));
  const before = f.calls.length, restored = f.create().peek(SYMBOL); assert.equal(restored.status, 'ready'); assert.equal(f.calls.length, before);
  assert.deepEqual(restored.documents.map(doc => doc.fetchedAt), bundle.documents.map(doc => doc.fetchedAt));
  const response = { symbol: SYMBOL, source: '巨潮资讯', section: 'notices', status: 'ready', fetchedAt: NOW,
    data: await f.source.getIndex(SYMBOL, '1990-01-01', TO, { firstPageOnly: true }) };
  const notices = await f.service.getNotices(SYMBOL, { noticeResponse: response }); assert.equal(notices.status, 'ready');
  assert.equal(notices.documents.length, 1); assert.equal(notices.documents[0].id, 'CN1225601360');
});
test('EM正文失败改用整份巨潮目录重新选文档，不映射同标题到EM公告编号', async t => {
  const f = companyFixture(t, { primaryIndex: true }), bundle = await f.service.get(SYMBOL);
  assert.equal(bundle.status, 'ready'); assert.ok(bundle.documents.every(doc => doc.id.startsWith('CN')));
  assert.ok(bundle.acquisition.events.some(event => event.source === '巨潮资讯' && event.recovered && event.primaryErrors.length));
});
test('巨潮同标题PDF的证券身份不匹配仍待核验，不能发布正文或完整bundle', async t => {
  const f = companyFixture(t, { badBody: true }), bundle = await f.service.get(SYMBOL);
  assert.equal(bundle.status, 'unavailable'); assert.equal(bundle.documents.length, 0); assert.equal(bundle.coverage.complete, false);
  assert.ok(bundle.errors.some(error => /证券代码或目录标题/.test(error)));
});
test('公司行为只替换公告目录，结构化分红失败仍unavailable，独立CN实施公告不伪造已匹配', async () => {
  for (const structuredFails of [false, true]) {
    const f = fixture(); f.override(url => url.endsWith('/hisAnnouncement/query') ? json(page([row('1225601360', '2026-10-13', '2025年年度权益分派实施公告')])) : null);
    const corporate = new CorporateSource(async url => url.includes('eastmoney.com/api/security/ann') || structuredFails
      ? { ok: false, status: 567, headers: new Headers() } : json({ success: false, code: 9201, message: '返回数据为空', result: null }),
    { clock: () => NOW, noticeSource: f.source, transportOptions: { maxAttempts: 1, minIntervalMs: 0 } });
    const result = await corporate.get({ symbol: SYMBOL, fromDate: FROM, force: true });
    assert.equal(result.status, structuredFails ? 'unavailable' : 'ready'); assert.equal(result.coverageComplete, !structuredFails);
    assert.equal(result.source, '东方财富公司行为及巨潮资讯公告'); assert.equal(result.events.length, 0);
    assert.equal(result.notices[0].corporateStage, 'implemented'); assert.equal(result.notices[0].resolvedByEventId, undefined);
  }
});
