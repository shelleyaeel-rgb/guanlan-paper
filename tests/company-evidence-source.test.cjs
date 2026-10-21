'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyEvidenceSource, reportIdentity } = require('../core/company-evidence-source.cjs');
const { CompanyDocumentParser, PARSER_VERSION } = require('../core/company-document-parser.cjs');
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
const NOW = Date.parse('2026-10-13T10:00:00+08:00'), SYMBOL = 'sh600519';
const annualId = 'AN20260417000001', halfId = 'AN20260815000002', noticeId = 'AN20260915000003';
const notices = [
  { id: noticeId, title: '贵州茅台:关于主要产品经营情况的公告', date: '2026-09-15', chunks: ['证券代码600519。公司本次披露主要产品经营情况，主营业务经营情况稳定。相关资料为本公司的公开原始公告正文。'] },
  { id: halfId, title: '贵州茅台:2026年半年度报告', date: '2026-08-15', chunks: ['证券代码600519。2026年半年度报告。公司报告期为2026年上半年。本半年度报告未经审计。', '管理层讨论与分析：公司产品形成收入，市场份额及竞争情况详见相关说明。全文最后一页。'] },
  { id: annualId, title: '贵州茅台:2025年年度报告', date: '2026-04-17', chunks: ['证券代码600519。2025年年度报告。以下为年度经营情况和财务报告的完整正文第一页。', '年度报告第二页。审计报告及董事会意见原文。详细报告以本年度披露的完整公告为准。'] }
];
function fixture(t, { rows = notices, options = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-company-source-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('guanlan-company-source-')); fs.rmSync(directory, { recursive: true, force: true }); });
  let now = NOW, override = null; const calls = [], progress = [];
  const fetcher = async (input, request) => {
    const url = new URL(input), q = url.searchParams; calls.push({ url: url.href, signal: request.signal });
    if (override) { const value = await override(url, request); if (value) return value; }
    if (url.hostname === 'np-anotice-stock.eastmoney.com') {
      const page = Number(q.get('page_index')), size = Number(q.get('page_size'));
      return response({ success: 1, data: { page_index: page, total_hits: rows.length,
        list: rows.slice((page - 1) * size, page * size).map(row => ({ art_code: row.id, title: row.title, notice_date: row.date,
          codes: [{ stock_code: '600519', market_code: '1' }], columns: [] })) } });
    }
    const row = rows.find(item => item.id === q.get('art_code')), page = Number(q.get('page_index'));
    return response(body(row, page));
  };
  const create = () => new CompanyEvidenceSource(fetcher, { directory, clock: () => now, pageSize: 2, minimumReportChars: 40, deferredRecoveryMs: 1, onProgress: item => progress.push(item), ...options });
  return { service: create(), create, directory, calls, progress, override: fn => { override = fn; }, advance: ms => { now += ms; }, get now() { return now; } };
}
const response = json => ({ ok: true, json: async () => json });
function body(row, page = 1, overrides = {}) {
  return { success: 1, data: { art_code: row.id, notice_title: row.title, notice_date: row.date, page_size: row.chunks.length,
    security: [{ stock: '600519', market_uni: '1' }], notice_content: row.chunks[page - 1], is_ai_summary: 0,
    attach_url: `https://pdf.dfcfw.com/pdf/H2_${row.id}_1.pdf`, ...overrides } };
}
const bodyCalls = f => f.calls.filter(call => new URL(call.url).hostname === 'np-cnotice-stock.eastmoney.com').length;

test('仅原始报告或重组审计附件命中普通限制后切换独立文件预算，普通公告不自动放宽', async t => {
  const row = { ...notices[0], title: '贵州茅台:重大资产重组财务报告和审计报告', chunks: ['公告节选……'] };
  const pdf = textPdf('Verified source for stock 600519. Complete original audit report text.');
  const inputs = [], parser = { parse: async (input, options) => {
    inputs.push({ input, options }); assert.equal(typeof input.filePath, 'string'); assert.equal(input.bytes, pdf.length);
    assert.equal(input.sha256, digest(pdf)); assert.equal(fs.readFileSync(input.filePath).equals(pdf), true);
    return { ...parsedText(), sourceHash: input.sha256 };
  } };
  const f = fixture(t, { rows: [row], options: { parser, maxPdfBytes: 64, largeDocumentLimits: { maxBytes: 1024 * 1024, maxPages: 1200, maxChars: 2000000 } } });
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? new Response(pdf, { headers: { 'content-length': String(pdf.length) } }) : null);
  const result = await f.service.get(SYMBOL), document = result.documents[0];
  assert.equal(document.complete, true); assert.equal(inputs.length, 1); assert.equal(inputs[0].options.fileMaxBytes, 1024 * 1024);
  assert.equal(inputs[0].options.maxPages, 1200); assert.equal(inputs[0].options.parseTimeoutMs, 300000);
  assert.equal(f.service.maxPdfBytes, 64); assert.equal(f.service.maxPdfPages, 600);
  assert.ok(result.acquisition.events.some(event => event.code === 'large-document-profile' && event.reason === 'file-size-limit'));
  const ordinary = fixture(t, { rows: [notices[0]], options: { maxPdfBytes: 64 } });
  ordinary.override(url => url.hostname === 'pdf.dfcfw.com' ? new Response(pdf, { headers: { 'content-length': String(pdf.length) } })
    : url.searchParams.get('art_code') === noticeId ? response(body(notices[0], 1, { notice_content: '公告节选……' })) : null);
  const rejected = await ordinary.service.get(SYMBOL); assert.equal(rejected.documents.length, 0);
  assert.ok(rejected.acquisition.issues.some(issue => issue.code === 'size-limit'));
  assert.ok(!rejected.acquisition.events.some(event => event.code === 'large-document-profile'));
});

test('大文档独立硬预算不可越界，声明超出大文件额度不启动第二次下载', async t => {
  for (const largeDocumentLimits of [{ maxBytes: 512 * 1024 * 1024 + 1 }, { maxPages: 1601 }, { maxChars: 4000001 }, { timeoutMs: 300001 }]) {
    assert.throws(() => new CompanyEvidenceSource(async () => {}, { largeDocumentLimits }), /大文档/);
  }
  const row = { ...notices[0], title: '贵州茅台:重大资产重组审计报告', chunks: ['公告节选……'] }, f = fixture(t, { rows: [row], options: { maxPdfBytes: 64, largeDocumentLimits: { maxBytes: 128 } } });
  let downloads = 0;
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? (downloads++, new Response('fake', { headers: { 'content-length': '304342284' } })) : null);
  const result = await f.service.get(SYMBOL); assert.equal(downloads, 1); assert.equal(result.documents.length, 0);
  assert.equal(result.acquisition.issues[0].code, 'size-limit'); assert.equal(result.acquisition.issues[0].actualBytes, 304342284);
});

test('长报告页数命中普通限制后沿用同一原件进入大文档路径，复用解析缓存不重复下载', async t => {
  const row = { ...notices[0], title: '贵州茅台:重大资产重组审计报告', chunks: ['公告节选……'] }, inputModes = [];
  const parser = { parse: async (input, options) => {
    inputModes.push(input.filePath ? 'file' : 'buffer');
    if (!input.filePath) return { text: '', pages: 1033, pageTexts: [], complete: false, numericEligible: false, hasOcrPages: false,
      issues: ['document-page-limit: PDF 页数超过上限，未使用截断正文'], parserVersion: PARSER_VERSION };
    assert.equal(options.maxPages, 1200); return { ...parsedText(), sourceHash: input.sha256 };
  } };
  const f = fixture(t, { rows: [row], options: { parser } }), pdf = textPdf('Original audited source report with complete readable text for stock 600519.'); let downloads = 0;
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? (downloads++, new Response(pdf)) : null);
  const item = { ...row, kind: 'notice', period: row.date }, url = `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`, events = [];
  const result = await f.service.pdf(item, SYMBOL, url, undefined, undefined, events); assert.equal(result.complete, true);
  assert.deepEqual(inputModes, ['buffer', 'file']); assert.equal(downloads, 1);
  assert.ok(events.some(event => event.reason === 'page-or-character-limit'));
  const second = await f.service.pdf(item, SYMBOL, url); assert.equal(second.timings.parseCached, true);
  assert.deepEqual(inputModes, ['buffer', 'file']); assert.equal(downloads, 1);
});

test('执行超时仅保存可核验完整页断点，下轮从断点恢复且不重新下载原件', async t => {
  const pdf = textPdf('Verified original source with two complete pages for issuer 600519.', 2), sourceHash = digest(pdf);
  let parses = 0, downloads = 0;
  const first = parsedText('The first completed page has readable source text.');
  const partial = { ...first, format: 'pdf', pages: 2, complete: false, numericEligible: false,
    checkpoint: 'parse-timeout', sourceHash, issues: ['document-parse-timeout: 尚有未处理页'] };
  const parser = { parse: async (_input, options) => {
    if (++parses === 1) { assert.equal(options.resume, undefined); throw Object.assign(Error('执行超时'), { code: 'parse-timeout', partialResult: partial }); }
    assert.deepEqual(options.resume, partial); return { ...parsedText(), sourceHash };
  } };
  const f = fixture(t, { options: { parser } });
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? (downloads++, new Response(pdf)) : null);
  const item = { ...notices[0], kind: 'notice', period: notices[0].date }, url = `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`;
  await assert.rejects(f.service.pdf(item, SYMBOL, url), error => error.code === 'parse-timeout');
  assert.equal(f.service.cachedParsing(sourceHash).checkpoint, 'parse-timeout');
  const events = [], result = await f.service.pdf(item, SYMBOL, url, undefined, undefined, events);
  assert.equal(result.complete, true); assert.equal(result.timings.parseCached, false); assert.equal(parses, 2); assert.equal(downloads, 1);
  assert.ok(events.some(event => event.code === 'parse-resumed' && event.completedPages === 1));
  assert.equal(f.service.cachedParsing(sourceHash).checkpoint, undefined);
});

test('内存回收保留真实完整页为parse-retry断点，错误仍是内存限制；重启只补缺页且原件不重下载', async t => {
  const pdf = textPdf('Verified original public announcement page for memory recovery.', 2), sourceHash = digest(pdf);
  const real = new CompanyDocumentParser({ recognize: () => { throw Error('native original must not need OCR'); } });
  t.after(() => real.destroy());
  const original = await real.parse(pdf), page = original.pageTexts[1];
  const partial = { ...original, text: page.text, pageTexts: [page], complete: false, numericEligible: false,
    checkpoint: 'parse-retry', checkpointLayout: 'sparse-pages-v1', missingPages: [1], issues: ['document-memory-limit: 内存回收；缺页待核验'] };
  let parses = 0, downloads = 0; const parsedPages = [];
  const memory = { startRssBytes: 600, failureRssBytes: 900, workerLimitBytes: 800, completedDocuments: 3, inputBytes: pdf.length };
  const parser = { parse: async (input, options) => {
    if (++parses === 1) throw Object.assign(Error('内存超过预算'), { code: 'parser-memory-limit', partialResult: partial, timings: { parseMs: 30, workerMemory: memory } });
    assert.deepEqual(options.resume, partial);
    return real.parse(input, { ...options, onProgress: value => { if (value.stage === 'parsed') parsedPages.push(value.page); options.onProgress?.(value); } });
  } };
  const f = fixture(t, { options: { parser } }); f.override(url => url.hostname === 'pdf.dfcfw.com' ? (downloads++, new Response(pdf)) : null);
  const item = { ...notices[0], kind: 'notice' }, url = `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`;
  await assert.rejects(f.service.pdf(item, SYMBOL, url), error => {
    assert.equal(error.code, 'parser-memory-limit'); assert.equal(error.acquisition.code, 'parser-memory-limit');
    assert.deepEqual(error.acquisition.timings.workerMemory, memory); return true;
  });
  const saved = f.service.cachedParsing(sourceHash); assert.equal(saved.checkpoint, 'parse-retry'); assert.equal(saved.complete, false);
  assert.equal(saved.numericEligible, false); assert.deepEqual(saved.missingPages, [1]); assert.match(saved.issues[0], /memory-limit/);
  const restarted = f.create(), result = await restarted.pdf(item, SYMBOL, url);
  assert.equal(result.complete, true); assert.equal(result.numericEligible, true); assert.deepEqual(parsedPages, [1]);
  assert.deepEqual(result.pageTexts[1], page); assert.equal(downloads, 1); assert.equal(parses, 2);
});

test('内存错误不得保存原件hash、版本、缺页或完整性不符的断点；取消也不写断点', async t => {
  const pdf = textPdf('Verified public source document for memory checkpoint rejection.', 2), sourceHash = digest(pdf);
  const base = parsedText('A complete first page whose provenance is checked before caching.');
  const partial = { ...base, format: 'pdf', sourceHash, pages: 2, complete: false, numericEligible: false,
    checkpoint: 'parse-retry', missingPages: [2], issues: ['document-memory-limit: 缺页待核验'] };
  for (const change of [{ sourceHash: 'b'.repeat(64) }, { parserVersion: 'wrong-version' }, { missingPages: [] },
    { complete: true, numericEligible: true }, { pageTexts: [{ ...base.pageTexts[0], complete: false }] }, { cancel: true }]) {
    const controller = new AbortController();
    const f = fixture(t, { options: { parser: { parse: async () => {
      if (change.cancel) controller.abort();
      throw Object.assign(Error('内存超过预算'), { code: 'parser-memory-limit', partialResult: { ...partial, ...change } });
    } } } });
    f.override(url => url.hostname === 'pdf.dfcfw.com' ? new Response(pdf) : null);
    await assert.rejects(f.service.pdf({ ...notices[0], kind: 'notice' }, SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`, controller.signal),
      error => change.cancel ? error.name === 'AbortError' : error.code === 'parser-memory-limit');
    assert.equal(f.service.cachedParsing(sourceHash), null); assert.equal(fs.existsSync(f.service.parsedCachePath(sourceHash)), false);
  }
});
function parsedText(text = 'Complete verified source text for issuer 600519 and its public announcement.') {
  return { text, pages: 1, pageTexts: [{ page: 1, text, method: 'pdf-text', complete: true, numericEligible: true,
    issues: [], characters: text.length, textHash: digest(text) }], complete: true, hasOcrPages: false, numericEligible: true, parserVersion: PARSER_VERSION };
}

test('两阶段解析断点保存不连续完整页，重试补缺页且不能伪装全文完成', async t => {
  const pdf = textPdf('Verified source page for checkpoint cache.'), sourceHash = digest(pdf);
  const page = { ...parsedText().pageTexts[0], page: 2 };
  const partial = { ...parsedText(), format: 'pdf', sourceHash, pages: 3, pageTexts: [page],
    complete: false, numericEligible: false, checkpoint: 'parse-timeout', checkpointLayout: 'sparse-pages-v1',
    missingPages: [1, 3], issues: ['document-parse-timeout: 等待缺页'] };
  let parses = 0;
  const f = fixture(t, { options: { parser: { parse: async (_input, options) => {
    if (++parses === 1) throw Object.assign(Error('执行超时'), { code: 'parse-timeout', partialResult: partial });
    assert.deepEqual(options.resume, partial);
    const result = parsedText(); result.pages = 3; result.pageTexts = [1, 2, 3].map(number => ({ ...page, page: number }));
    result.text = result.pageTexts.map(row => row.text).join('\n\n'); return { ...result, sourceHash };
  } } } });
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? new Response(pdf) : null);
  const item = { ...notices[0], kind: 'notice' }, url = `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`;
  await assert.rejects(f.service.pdf(item, SYMBOL, url), { code: 'parse-timeout' });
  assert.deepEqual(f.service.cachedParsing(sourceHash).missingPages, [1, 3]);
  assert.equal((await f.service.pdf(item, SYMBOL, url)).complete, true);
  for (const change of [{ complete: true, numericEligible: true }, { missingPages: [1] },
    { pageTexts: [page, page], text: [page.text, page.text].join('\n\n') }, { checkpoint: undefined }]) {
    f.service.saveParsing(sourceHash, { ...partial, ...change });
    assert.equal(f.service.cachedParsing(sourceHash), null);
  }
});

test('强制目录更新每份成功正文只装载一次，仍按公告身份复用且不重取正文', async t => {
  const f = fixture(t); await f.service.get(SYMBOL);
  const beforeBodies = bodyCalls(f), reads = [];
  const cachedDocument = f.service.cachedDocument.bind(f.service);
  f.service.cachedDocument = (item, symbol) => { reads.push(item.id); return cachedDocument(item, symbol); };
  const result = await f.service.get(SYMBOL, { force: true });
  assert.equal(result.status, 'ready'); assert.equal(bodyCalls(f), beforeBodies);
  assert.equal(reads.length, result.documents.length);
  assert.equal(result.acquisition.documents.reused, result.documents.length);
});

test('非空短正文回退已核实附件，短分页合计不足也不得直接失败或冒充完整正文', async t => {
  for (const chunks of [['请阅读附件'], ['短正文第一页', '短正文第二页']]) {
    const row = { ...notices[0], chunks }, f = fixture(t, { rows: [row] });
    const pdf = textPdf('Complete verified source text for issuer 600519 and its public announcement.');
    f.override(url => url.hostname === 'pdf.dfcfw.com' ? new Response(pdf) : null);
    const result = await f.service.get(SYMBOL), document = result.documents[0];
    assert.equal(document.format, 'pdf-text'); assert.equal(document.complete, true);
    assert.equal(result.acquisition.documents.failed, 0); assert.match(document.text, /Complete verified/);
    assert.equal(f.calls.filter(call => new URL(call.url).hostname === 'pdf.dfcfw.com').length, 1);
    assert.equal(f.service.activeDocuments.size, 0); assert.equal(f.service.attachmentCache().registry.pins.size, 0);
    await f.service.destroy();
  }
});

test('解析排队时释放网络并发槽，仅将用户取消信号与执行预算交给解析器', async t => {
  let started, finish, parseOptions; const began = new Promise(resolve => { started = resolve; });
  const parser = { parse: (bytes, options) => { parseOptions = options; started(); return new Promise(resolve => { finish = resolve; }); } };
  const f = fixture(t, { options: { maxConcurrent: 1, pdfTimeoutMs: 10, parser } }), controller = new AbortController();
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? new Response(textPdf('Readable original source page.')) : null);
  const pending = f.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`, controller.signal);
  await began; assert.equal(f.service.requests, 0); assert.equal(parseOptions.signal, controller.signal); assert.equal(parseOptions.parseTimeoutMs, 10);
  await f.service.request('https://np-anotice-stock.eastmoney.com/api/security/ann?page_index=1&page_size=2');
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(controller.signal.aborted, false);
  finish({ ...parsedText(), timings: { queuedMs: 20, parseMs: 1 } }); const result = await pending;
  assert.equal(result.timings.queuedMs, 20); assert.equal(result.timings.parseMs, 1); assert.equal(f.service.requests, 0);
});

test('活动批次保留超过80篇完整正文，结束后按候选范围保留，移出候选才回到普通上限', async t => {
  const rows = [...Array.from({ length: 82 }, (_, index) => ({ ...notices[0], id: `AN2026091500${String(index + 100).padStart(4, '0')}` })), ...notices.slice(1)];
  const f = fixture(t, { rows, options: { pageSize: 100 } }); f.service.beginBatch();
  const result = await f.service.get(SYMBOL); assert.equal(result.status, 'ready'); assert.equal(result.documents.length, 84);
  const docCount = () => fs.readdirSync(f.directory).filter(name => name.startsWith('doc-')).length;
  assert.equal(docCount(), 84); f.service.retainSymbols([SYMBOL]); f.service.endBatch(); assert.equal(docCount(), 84);
  const restart = f.create(); restart.retainSymbols([SYMBOL]); assert.equal(restart.peek(SYMBOL).documents.length, 84);
  const oldCalls = bodyCalls(f); await restart.get(SYMBOL, { force: true }); assert.equal(bodyCalls(f), oldCalls);
  restart.retainSymbols([]); assert.equal(docCount(), 80);
});

test('已保留候选的bundle不受100份数量淘汰，解除范围恢复普通预算', t => {
  const f = fixture(t), symbols = Array.from({ length: 103 }, (_, index) => `sh${600000 + index}`);
  f.service.retainSymbols(symbols);
  for (const symbol of symbols) f.service.saveBundle({ symbol, checkedAt: f.now, status: 'unavailable', documents: [], errors: [] });
  assert.equal(fs.readdirSync(f.directory).filter(name => name.startsWith('bundle-')).length, 103);
  f.service.retainSymbols([]); assert.equal(fs.readdirSync(f.directory).filter(name => name.startsWith('bundle-')).length, 100);
});

test('保留正文可借用剩余解析预算，总容量压力优先去掉已有完整正文的解析副本', async t => {
  const f = fixture(t, { rows: [{ ...notices[0], chunks: ['请见附件'] }] }); f.service.retainSymbols([SYMBOL]);
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? new Response(textPdf('Verified complete document with text and retained original attachment.')) : null);
  const first = await f.service.get(SYMBOL), document = first.documents[0], parsed = f.service.parsedCachePath(document.sourceHash);
  assert.equal(fs.existsSync(parsed), true);
  const bytes = fs.readdirSync(f.directory).filter(name=>name.endsWith('.json')).reduce((sum,name)=>sum+fs.statSync(path.join(f.directory,name)).size,0);
  f.service.maxCachedBytes = bytes - fs.statSync(parsed).size; f.service.maxBodyCacheBytes = 1; f.service.maxParsedCacheBytes = f.service.maxCachedBytes - 1;
  f.service.pruneDisk(); assert.equal(fs.existsSync(parsed), false); assert.ok(f.service.cachedDocument({ ...notices[0],kind:'notice',period:notices[0].date },SYMBOL));
  const remaining = fs.readdirSync(f.directory).filter(name=>name.endsWith('.json')).reduce((sum,name)=>sum+fs.statSync(path.join(f.directory,name)).size,0);
  assert.ok(remaining <= f.service.maxCachedBytes); assert.equal(f.create().peek(SYMBOL).documents[0].textHash,document.textHash);
  await f.service.destroy();
});

test('缓存写入预算不足仅提示未保存，本次已取得正文及覆盖仍可核验且磁盘不越界', async t => {
  const f = fixture(t, { options: { maxCachedBytes: 1 } }), result = await f.service.get(SYMBOL);
  assert.equal(result.status, 'ready'); assert.equal(result.coverage.complete, true); assert.equal(result.documents.length, 3);
  assert.deepEqual(result.errors, []); assert.ok(result.cacheWarnings.some(warning => /正文缓存保存失败/.test(warning)));
  assert.ok(result.cacheWarnings.some(warning => /资料索引缓存保存失败/.test(warning)));
  assert.equal(fs.readdirSync(f.directory).filter(name => /^(doc|parsed|bundle|link)-/.test(name)).length, 0);
  const total = [f.service.documents,f.service.bundles,f.service.attachments,f.service.documentReferences]
    .reduce((sum,map) => sum + [...map.values()].reduce((size,value) => size + Buffer.byteLength(JSON.stringify(value)),0),0);
  assert.ok(total <= 1);
  const pdfFixture = fixture(t, { rows: [{ ...notices[0], chunks: ['请见附件'] }], options: { maxCachedBytes: 1 } });
  pdfFixture.override(url => url.hostname === 'pdf.dfcfw.com' ? new Response(textPdf('Verified source announcement with complete readable public content.')) : null);
  const pdfResult = await pdfFixture.service.get(SYMBOL); assert.equal(pdfResult.documents.length, 1);
  assert.ok(pdfResult.cacheWarnings.some(warning => /解析缓存保存失败/.test(warning))); assert.equal(pdfResult.acquisition.documents.failed, 0);
  await pdfFixture.service.destroy();
});

test('相关公告新增敏感标题范围后旧bundle失效，完整正文仍按身份复用', async t => {
  const sensitive = { ...notices[0], title: '贵州茅台:关于控股股东减持股份计划的公告' }, f = fixture(t, { rows: [sensitive, ...notices.slice(1)] });
  const first = await f.service.get(SYMBOL); assert.equal(first.coverage.relatedNotices.loaded, 1);
  const filename = path.join(f.directory, `bundle-${SYMBOL}.json`), saved = JSON.parse(fs.readFileSync(filename)); delete saved.collectionVersion;
  fs.writeFileSync(filename, JSON.stringify(saved)); const restart = f.create(); assert.equal(restart.peek(SYMBOL), null);
  const oldCalls = bodyCalls(f); const next = await restart.get(SYMBOL); assert.equal(next.status, 'ready'); assert.equal(bodyCalls(f), oldCalls);
});

test('非正文页登记在资料缓存边界复核，真实空白页可复用，伪造登记或原件hash不可冒充', async t => {
  const f = fixture(t), audit = require('../core/company-document-page-audits.json')[0], base = parsedText();
  const pages = Array.from({ length: audit.pages }, (_, index) => ({ ...base.pageTexts[0], page: index + 1 }));
  for (const page of audit.pageNumbers) pages[page - 1] = { ...pages[page - 1], text: '', characters: 0, textHash: digest(''), method: 'page-audit', numericEligible: false,
    contentRole: 'non-content', classification: { kind:'decorative-cover',verified:true,basis:'exact-source-page-audit',sourceHash:audit.sourceSha256,pages:audit.pages,page,auditId:audit.id } };
  const parsed = { ...base, sourceHash:audit.sourceSha256,pages:audit.pages,pageTexts:pages,text:pages.map(page=>page.text).join('\n\n'),numericEligible:false };
  assert.equal(f.service.saveParsing(audit.sourceSha256, parsed), undefined); assert.ok(f.service.cachedParsing(audit.sourceSha256));
  const corrupted = structuredClone(parsed); corrupted.pageTexts[0].classification.auditId = 'unreviewed';
  f.service.saveParsing(audit.sourceSha256, corrupted); assert.equal(f.service.cachedParsing(audit.sourceSha256), null);
  const forged = fixture(t, { options:{parser:{parse:async()=>parsed}} });
  forged.override(url=>url.hostname==='pdf.dfcfw.com'?new Response(textPdf('An entirely different raw file.')):null);
  await assert.rejects(forged.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`), /来源或版本/);
  const bytes = textPdf('Readable verified source content for this complete document.', 2).toString();
  const emptyPage = bytes.replace(/BT[^\n]+page 2\) Tj ET/, match=>' '.repeat(match.length));
  f.override(url=>url.hostname==='pdf.dfcfw.com'?new Response(Buffer.from(emptyPage)):null);
  const first = await f.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`);
  assert.equal(first.complete,true); assert.equal(first.pageTexts[1].classification.kind,'blank');
  const second = await f.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`); assert.equal(second.timings.parseCached,true);
  await f.service.destroy();
});

test('完整目录与正文逐页核对身份、披露时间和报告期，业务分析明确来自发行人报告', async t => {
  const f = fixture(t), result = await f.service.get(SYMBOL, { force: true });
  assert.equal(result.status, 'ready'); assert.equal(result.coverage.noticeIndexComplete, true); assert.equal(result.coverage.noticeCount, 3);
  assert.equal(result.coverage.annualReport.reportDate, '2025-12-31'); assert.equal(result.coverage.semiannualReport.reportDate, '2026-06-30');
  assert.equal(result.documents.length, 3); assert.equal(bodyCalls(f), 5);
  const annual = result.documents.find(document => document.id === annualId);
  assert.equal(annual.pages, 2); assert.equal(annual.complete, true); assert.equal(annual.publishedAt, '2026-04-17'); assert.equal(annual.period, '2025年度');
  assert.equal(annual.issuerSymbol, SYMBOL); assert.equal(annual.text, notices[2].chunks.join('\n\n')); assert.equal(annual.fullText, undefined);
  assert.equal(annual.parserVersion, 'provider-text-2'); assert.equal(annual.pageTexts.map(page => page.text).join('\n\n'), annual.text);
  assert.match(annual.url, /data\.eastmoney\.com\/notices\/detail\/600519\/AN/); assert.match(annual.attachmentUrl, /pdf\.dfcfw\.com/);
  assert.deepEqual(result.coverage.businessAnalysis.derivedFromReportIds.sort(), [annualId, halfId].sort());
  assert.equal(result.coverage.relatedNotices.selection, 'risk-and-business-keywords'); assert.equal(result.coverage.relatedNotices.loaded, 1);
  assert.equal(result.coverage.allNoticeBodiesComplete, true); assert.ok(f.progress.some(item => item.stage === 'index')); assert.ok(f.progress.some(item => item.page === 2));
});

test('force重新读目录但按公告ID复用完整正文，磁盘重启保留原资料时间而不是伪刷新', async t => {
  const f = fixture(t), first = await f.service.get(SYMBOL, { force: true }), oldBodyCalls = bodyCalls(f), oldCalls = f.calls.length;
  f.advance(10000); const cached = await f.service.get(SYMBOL); assert.equal(f.calls.length, oldCalls); assert.equal(cached.checkedAt, first.checkedAt);
  const next = await f.service.get(SYMBOL, { force: true }); assert.equal(bodyCalls(f), oldBodyCalls); assert.equal(f.calls.length, oldCalls + 2);
  assert.equal(f.service.bundles.get(SYMBOL).documents, undefined, 'bundle只保存引用，不在全文cache上限之外复制全文');
  assert.equal(next.checkedAt, f.now); assert.ok(next.documents.every(document => document.fetchedAt === NOW));
  f.advance(10000); const restart = f.create(), peek = restart.peek(SYMBOL);
  assert.equal(peek.checkedAt, next.checkedAt); assert.ok(peek.documents.every(document => document.fetchedAt === NOW));
  peek.documents[0].text = '调用者不可修改缓存'; assert.notEqual(restart.peek(SYMBOL).documents[0].text, peek.documents[0].text);
  const before = bodyCalls(f); await restart.get(SYMBOL, { force: true }); assert.equal(bodyCalls(f), before);
});

function textPdf(text, count = 1) {
  if (Array.isArray(text)) count = text.length;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`];
  const fontId = 3 + count * 2;
  for (let i = 0; i < count; i++) {
    const pageText = Array.isArray(text) ? text[i] : `${text} page ${i + 1}`;
    const content = `BT /F1 12 Tf 20 700 Td (${pageText.replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(pdf);
}

test('真实全文标题变体能识别本期报告，摘要、英文与专项报告仍不混入', async t => {
  const rows = notices.map(row => ({ ...row, title: row.id === halfId ? '陕西煤业:陕西煤业股份有限公司2026年半年度报告全文'
    : row.id === annualId ? '杭叉集团:杭叉集团股份有限公司2025年年度报告全文' : row.title }));
  const f = fixture(t, { rows }), result = await f.service.get(SYMBOL);
  assert.equal(result.coverage.semiannualReport.status, 'ready'); assert.equal(result.coverage.annualReport.status, 'ready');
  assert.equal(result.coverage.semiannualReport.title, rows[1].title);
  for (const title of ['中谷物流:2026年半年度报告全文', '中谷物流:2025年半年度报告_全文', '公司:2026年半年度报告全文(修订稿)']) {
    assert.equal(reportIdentity(title, '2026-09-01').kind, 'semiannual-report');
  }
  for (const title of ['公司:2026年半年度报告摘要', '公司:2026年半年度报告全文(英文版)', '公司:关于2026年半年度报告全文的更正公告', '公司:2026年半年度募集资金存放专项报告']) {
    assert.equal(reportIdentity(title, '2026-09-01'), null);
  }
});

test('同报告期A股全文优先于后发H股版本，但最新A股修订失败不能退回旧正文', async t => {
  const hShare = { ...notices[1], id: 'AN20260911000004', title: '公司:公司H股2026年中期报告', date: '2026-09-11' };
  const first = fixture(t, { rows: [hShare, ...notices] }), result = await first.service.get(SYMBOL);
  assert.equal(result.coverage.semiannualReport.id, halfId); assert.equal(result.coverage.semiannualReport.status, 'ready');
  assert.ok(first.calls.every(call => new URL(call.url).searchParams.get('art_code') !== hShare.id));
  const revised = { ...notices[1], id: 'AN20260912000005', title: '公司:2026年半年度报告全文(修订稿)', date: '2026-09-12' };
  const next = fixture(t, { rows: [revised, hShare, ...notices] });
  next.override(url => url.searchParams.get('art_code') === revised.id ? response(body(revised, 1, { security: [{ stock: '000001', market_uni: '0' }] })) : null);
  const pending = await next.service.get(SYMBOL);
  assert.equal(pending.coverage.semiannualReport.id, revised.id); assert.equal(pending.coverage.semiannualReport.status, 'pending');
  assert.match(pending.coverage.semiannualReport.reason, /股票身份/);
  assert.ok(next.calls.every(call => new URL(call.url).searchParams.get('art_code') !== halfId));
  assert.ok(!pending.documents.some(document => document.kind === 'semiannual-report'));
});

test('空正文或错误页码可用已核实附件回退完整PDF，后续坏页丢弃已有文本且身份错误不能回退', async t => {
  const pdf = textPdf('Verified original full public announcement for stock 600519. All pages are available.', 2);
  for (const variant of ['empty-first', 'wrong-page', 'empty-later']) {
    const row = { ...notices[0], chunks: ['THIS TEXT MUST BE DISCARDED. Public announcement content before a missing second page.', 'second page'] };
    const f = fixture(t, { rows: [row, ...notices.slice(1)] });
    f.override(url => {
      if (url.hostname === 'pdf.dfcfw.com') return new Response(pdf);
      if (url.searchParams.get('art_code') !== noticeId) return null;
      const page = Number(url.searchParams.get('page_index'));
      return variant === 'empty-later' && page === 1 ? response(body(row, page))
        : response(body(row, page, variant === 'wrong-page' ? { page_index: 7 } : { notice_content: null, page_size: 0 }));
    });
    const result = await f.service.get(SYMBOL), doc = result.documents.find(document => document.id === noticeId);
    assert.equal(doc.format, 'pdf-text', variant); assert.equal(doc.pages, 2); assert.doesNotMatch(doc.text, /MUST BE DISCARDED/);
    assert.equal((doc.text.match(/page 1/g) || []).length, 1); assert.equal(result.coverage.documentFailures.length, 0);
  }
  const bad = fixture(t); let pdfCalls = 0;
  bad.override(url => {
    if (url.hostname === 'pdf.dfcfw.com') { pdfCalls++; return new Response(pdf); }
    return url.searchParams.get('art_code') === noticeId ? response(body(notices[0], 1, { notice_content: null, page_size: 0, notice_date: '2026-09-16' })) : null;
  });
  const rejected = await bad.service.get(SYMBOL); assert.equal(pdfCalls, 0); assert.ok(!rejected.documents.some(document => document.id === noticeId));
});

test('默认128MiB有界额度可读取超过旧64MiB限制的有效PDF，显式旧限制和256MiB配置上限仍有效', async t => {
  const small = textPdf('Original valid public report attachment for stock 600519. Complete report text.'), raw = small.toString('ascii');
  const oldOffset = Number(/startxref\n(\d+)/.exec(raw)[1]), padding = Buffer.from('%' + ' '.repeat(66 * 1024 * 1024) + '\n');
  const suffix = Buffer.from(raw.slice(oldOffset).replace(/startxref\n\d+/, `startxref\n${oldOffset + padding.length}`));
  const pdf = Buffer.concat([small.subarray(0, oldOffset), padding, suffix]);
  const f = fixture(t); f.override(url => url.hostname === 'pdf.dfcfw.com' ? new Response(pdf, { headers: { 'content-length': String(pdf.length) } }) : null);
  assert.equal(f.service.maxPdfBytes, 128 * 1024 * 1024);
  const result = await f.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`);
  assert.equal(result.downloadBytes, pdf.length); assert.match(result.text, /Complete report text/);
  f.service.maxPdfBytes = 64 * 1024 * 1024;
  await assert.rejects(f.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`), error=>error.acquisition.code==='size-limit'&&error.acquisition.limitBytes===64*1024*1024);
  assert.doesNotThrow(() => new CompanyEvidenceSource(null, { maxPdfBytes: 256 * 1024 * 1024 }));
  assert.throws(() => new CompanyEvidenceSource(null, { maxPdfBytes: 256 * 1024 * 1024 + 1 }), /上限无效/);
});

test('实际PDF.js提取原始PDF全部页，接口节选不能伪装全文；附件大小、页数和重定向受限', async t => {
  const pdf = textPdf('Original full public announcement for stock 600519. This is complete document text.', 2);
  const f = fixture(t);
  f.override(url => {
    if (url.hostname === 'pdf.dfcfw.com') return new Response(pdf, { headers: { 'content-length': String(pdf.length) } });
    if (url.searchParams.get('art_code') === noticeId) return response(body(notices[0], 1, { notice_content: '证券代码600519。公告原文节选，查看完整正文……' }));
    return null;
  });
  const result = await f.service.get(SYMBOL), doc = result.documents.find(document => document.id === noticeId);
  assert.equal(doc.format, 'pdf-text'); assert.equal(doc.pages, 2); assert.match(doc.text, /page 1/); assert.match(doc.text, /page 2/); assert.equal(doc.complete, true);
  const parsed = await f.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`);
  assert.equal(parsed.downloadBytes, pdf.length, 'worker buffer transfer must not erase original download size');
  for (const options of [{ maxPdfPages: 1 }, { maxPdfBytes: 64 }]) {
    const limited = fixture(t, { options }); limited.override(url => url.hostname === 'pdf.dfcfw.com' ? new Response(pdf, { headers: { 'content-length': String(pdf.length) } }) : null);
    await assert.rejects(limited.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`), /上限/);
  }
  const redirected = fixture(t); redirected.override(url => {
    if (url.hostname !== 'pdf.dfcfw.com') return null;
    const value = new Response(pdf); Object.defineProperty(value, 'url', { value: 'https://example.com/unknown.pdf' }); return value;
  });
  await assert.rejects(redirected.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`), /重定向/);
});

test('同股强制扫描在运行时，交易前非强制读取等待同一结果；取消不能退回旧成功bundle', async t => {
  const f = fixture(t); const first = await f.service.get(SYMBOL); let began;
  const started = new Promise(resolve => { began = resolve; });
  f.override(url => { if (url.hostname === 'np-anotice-stock.eastmoney.com') { began(); return new Promise(() => {}); } return null; });
  const controller = new AbortController(), scan = f.service.get(SYMBOL, { force: true, signal: controller.signal }); await started;
  let executionCompleted = false;
  const execution = f.service.get(SYMBOL).then(value => { executionCompleted = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(executionCompleted, false);
  controller.abort(); await assert.rejects(scan, /取消/); await assert.rejects(execution, /取消/);
  assert.equal(f.service.peek(SYMBOL).checkedAt, first.checkedAt, '取消保留原cache时间供展示，get调用本身不能成功回退');
});

test('原始PDF流式下载取消立即释放槽位，未知重定向不会解析为可信公告', async t => {
  const f = fixture(t); let started;
  const downloading = new Promise(resolve => { started = resolve; });
  f.override(url => {
    if (url.hostname !== 'pdf.dfcfw.com') return null;
    started(); return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('%PDF-1.4')); } }));
  });
  const controller = new AbortController(), pending = f.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`, controller.signal);
  await downloading; controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(f.service.requests, 0);
  const redirected = fixture(t); redirected.override(url => url.hostname === 'np-anotice-stock.eastmoney.com'
    ? { ok: true, url: 'https://example.com/ann', json: async () => { throw Error('不应读取不可信返回'); } } : null);
  const result = await redirected.service.get(SYMBOL); assert.equal(result.status, 'unavailable'); assert.match(result.errors[0], /来源域名/);
});

test('PDF下载与解析分别有界120秒，可缩短下载期限且超时取消底层流并释放并发槽位', async t => {
  const normal = fixture(t); assert.equal(normal.service.pdfTimeoutMs, 120000); assert.equal(normal.service.pdfDownloadTimeoutMs, 120000);
  for (const field of ['pdfTimeoutMs', 'pdfDownloadTimeoutMs']) for (const value of [0, 120001, Infinity]) assert.throws(() => new CompanyEvidenceSource(null, { [field]: value }), /上限无效/);
  const f = fixture(t, { options: { pdfDownloadTimeoutMs: 10 } }); let cancelled = false;
  f.override(url => url.hostname !== 'pdf.dfcfw.com' ? null : new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('%PDF-1.4')); }, cancel() { cancelled = true; }
  })));
  // Keep the isolated event loop alive while the unref'ed AbortSignal expires.
  const keeper = setInterval(() => {}, 1000);
  try { await assert.rejects(f.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`), error => error.acquisition.stage === 'download' && error.acquisition.code === 'deadline'); }
  finally { clearInterval(keeper); }
  assert.equal(cancelled, true); assert.equal(f.service.requests, 0); assert.equal(f.service.waiters.length, 0);
});

test('相关公告覆盖至少从最新报告披露日开始，跨90天不把中间遗漏视为完整', async t => {
  const olderHalf = { ...notices[1], date: '2026-07-01' }, added = { ...notices[0], id: 'AN20260702000004', date: '2026-07-02' };
  const f = fixture(t, { rows: [notices[0], added, olderHalf, notices[2]] }); const result = await f.service.get(SYMBOL);
  assert.equal(result.coverage.relatedNotices.windowFromDate, '2026-07-01'); assert.equal(result.coverage.relatedNotices.matched, 2); assert.equal(result.coverage.relatedNotices.loaded, 2);
});

test('错误身份、日期、重复页、缺失正文、生成摘要及正文报告期不符均不能作为完整文档', async t => {
  for (const overrides of [
    { security: [{ stock: '000001', market_uni: '0' }] }, { notice_date: '2026-04-18' }, { notice_content: '' },
    { is_ai_summary: 1 }, { page_size: 3 }, { notice_content: '证券代码000001。2024年年度报告。资料属于另外一家公司，不应被当作目标公司的有效报告。' }
  ]) {
    const f = fixture(t);
    f.override(url => url.searchParams.get('art_code') === annualId ? response(body(notices[2], 1, overrides)) : null);
    const result = await f.service.get(SYMBOL, { force: true });
    assert.equal(result.status, 'partial'); assert.ok(!result.documents.some(document => document.id === annualId));
    assert.equal(result.coverage.annualReport.status, 'pending'); assert.equal(result.coverage.documentFailures[0].id, annualId);
    assert.ok(result.errors.length);
    if (overrides.security || overrides.notice_date || overrides.is_ai_summary) assert.equal(result.coverage.documentFailures[0].attachmentUrl, undefined, '身份错误或AI摘要的附件链接不能成为可信回退来源');
    else assert.ok(result.coverage.documentFailures[0].attachmentUrl);
  }
});

test('目录与全文上限明确覆盖不足，相关公告按批次完整读取而非永久省略', async t => {
  const cappedIndex = fixture(t, { options: { maxIndexPages: 1 } });
  const indexResult = await cappedIndex.service.get(SYMBOL); assert.equal(indexResult.status, 'unavailable'); assert.equal(indexResult.coverage.noticeIndexComplete, false); assert.equal(bodyCalls(cappedIndex), 0);
  const cappedBody = fixture(t, { options: { maxBodyPages: 1 } }), bodyResult = await cappedBody.service.get(SYMBOL);
  assert.equal(bodyResult.status, 'partial'); assert.equal(bodyResult.documents.length, 1); assert.equal(bodyResult.coverage.annualReport.status, 'pending');
  const other = { ...notices[0], id: 'AN20260914000004', date: '2026-09-14' };
  const cappedRelated = fixture(t, { rows: [...notices, other], options: { maxRelatedDocuments: 1 } }), relatedResult = await cappedRelated.service.get(SYMBOL);
  assert.equal(relatedResult.status, 'ready'); assert.equal(relatedResult.coverage.relatedNotices.omitted, 0); assert.equal(relatedResult.coverage.relatedNotices.complete, true);
  assert.equal(relatedResult.coverage.allNoticeBodiesComplete, true); assert.deepEqual(relatedResult.acquisition.relatedBatches, { size: 1, total: 2, completed: 2 });
});

test('目录刷新失败保留不可变正文缓存，最近bundle明确失败；重试与重启不复用伪成功', async t => {
  const f = fixture(t); await f.service.get(SYMBOL); const oldBodies = bodyCalls(f), docFile = path.join(f.directory, `doc-${annualId}.json`), savedDoc = fs.readFileSync(docFile, 'utf8');
  f.advance(1000); f.override(url => url.hostname === 'np-anotice-stock.eastmoney.com' ? { ok: false, status: 503 } : null);
  const result = await f.service.get(SYMBOL, { force: true }); assert.equal(result.status, 'unavailable'); assert.equal(result.documents.length, 0);
  assert.equal(result.coverage.semiannualReport.status, 'pending'); assert.match(result.coverage.semiannualReport.reason, /目录获取失败.*HTTP 503/);
  assert.equal(f.service.peek(SYMBOL).status, 'unavailable'); assert.equal(f.create().peek(SYMBOL).status, 'unavailable'); assert.equal(fs.readFileSync(docFile, 'utf8'), savedDoc);
  f.override(null); const retried = await f.create().get(SYMBOL, { force: true }); assert.equal(retried.status, 'ready'); assert.equal(bodyCalls(f), oldBodies);
});

test('只有上市公告书而没有独立定期报告时如实保留未识别状态，不能虚构半年报', async t => {
  const listing = { ...notices[0], title: '格林生物:首次公开发行股票并在创业板上市之上市公告书', date: '2026-09-01' };
  const f = fixture(t, { rows: [listing] }), result = await f.service.get(SYMBOL);
  assert.equal(result.coverage.noticeIndexComplete, true); assert.equal(result.coverage.semiannualReport.status, 'missing');
  assert.match(result.coverage.semiannualReport.reason, /未识别.*不能据此认定公司未披露/); assert.equal(result.documents.length, 0);
});

test('取消不等待忽略signal的服务，释放有界并发队列，保持上次bundle且可以重试', async t => {
  const f = fixture(t, { options: { maxConcurrent: 1 } }); let began;
  const started = new Promise(resolve => { began = resolve; });
  f.override(url => { if (url.hostname === 'np-cnotice-stock.eastmoney.com') { began(); return new Promise(() => {}); } return null; });
  const controller = new AbortController(), pending = f.service.get(SYMBOL, { signal: controller.signal, force: true }); await started;
  assert.equal(f.service.requests, 1); controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(f.service.requests, 0); assert.equal(f.service.waiters.length, 0); assert.equal(f.service.peek(SYMBOL), null);
  f.override(null); assert.equal((await f.service.get(SYMBOL, { force: true })).status, 'ready');
});

test('缓存正文被修改、公告元数据修订及摘要条目不能冒充已验证完整报告', async t => {
  const f = fixture(t); await f.service.get(SYMBOL); const filename = path.join(f.directory, `doc-${annualId}.json`), cached = JSON.parse(fs.readFileSync(filename, 'utf8'));
  cached.text = '被截断的缓存内容'; fs.writeFileSync(filename, JSON.stringify(cached));
  const restart = f.create(); assert.equal(restart.peek(SYMBOL), null);
  const before = bodyCalls(f); assert.equal((await restart.get(SYMBOL, { force: true })).status, 'ready'); assert.equal(bodyCalls(f), before + 2);
  assert.equal(reportIdentity('公司:2025年年度报告摘要', '2026-04-17'), null);
  assert.equal(reportIdentity('公司:2025年度审计委员会履职情况报告', '2026-04-17'), null);
  assert.equal(reportIdentity('公司:2026年年度报告', '2026-10-13'), null);
  assert.deepEqual(reportIdentity('公司:2025年年度报告(修订版)', '2026-04-18'), { kind: 'annual-report', reportDate: '2025-12-31', period: '2025年度' });
});

test('原件、解析结果与逐页来源贯通缓存，解析器升级重解析但未变化原件不重新下载', async t => {
  const original = new CompanyDocumentParser(); let parsed = 0;
  const parser = { parse: async (...args) => { parsed++; return original.parse(...args); } };
  const f = fixture(t, { options: { parser } }), pdf = textPdf('Original verified public document. Complete native text for the announcement stock 600519.', 2);
  let downloads = 0;
  f.override(url => {
    if (url.hostname === 'pdf.dfcfw.com') { downloads++; return new Response(pdf); }
    return url.searchParams.get('art_code') === noticeId ? response(body(notices[0], 1, { notice_content: '公告节选……' })) : null;
  });
  const first = await f.service.get(SYMBOL), document = first.documents.find(item => item.id === noticeId);
  assert.equal(parsed, 1); assert.equal(downloads, 1); assert.equal(document.parserVersion, PARSER_VERSION);
  assert.equal(document.sourceHash, digest(pdf)); assert.equal(document.pageTexts.map(page => page.text).join('\n\n'), document.text);
  assert.ok(document.pageTexts.every(page => page.method === 'pdf-text' && page.numericEligible));
  assert.deepEqual(f.service.readArchivedArtifact(document).bytes, pdf);
  assert.equal(f.service.readArchivedArtifact({ ...document, originalFile: { ...document.originalFile, cacheKey: '../account' } }), null);
  await f.service.get(SYMBOL, { force: true }); assert.equal(parsed, 1);
  const upgraded = f.create(); upgraded.parserVersion = 'future-parser';
  upgraded.parser = { parse: async (...args) => { parsed++; return { ...await original.parse(...args), parserVersion: 'future-parser' }; } };
  const next = await upgraded.get(SYMBOL, { force: true }); assert.equal(parsed, 2); assert.equal(downloads, 1);
  assert.equal(next.documents.find(item => item.id === noticeId).parserVersion, 'future-parser');
  const restored = upgraded.readArchivedArtifact(next.documents.find(item => item.id === noticeId)); assert.equal(restored.sha256, digest(pdf));
  await original.destroy();
});

test('版本3误判完整的混合PDF必须重新核验原生页，已成功OCR页迁移；低置信不放行且显式重试仅缺页', async t => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/company-mixed-audit-pages.pdf'));
  const seed = new CompanyDocumentParser({ recognize: () => ({ data: { text: 'Previously recognized complete audit disclosure retained from the original.', confidence: 96 } }) });
  const old = await seed.parse(bytes); await seed.destroy();
  // Reproduce v3's bug: page 2's searchable furniture was mistaken for the
  // whole native body. Keep page 3 as a genuine previously completed OCR row.
  const header = 'Company annual report 2025. Audit section. Applicable.';
  old.pageTexts[1] = { page: 2, text: header, method: 'pdf-text', confidence: null, complete: true, numericEligible: true,
    tableLike: false, issues: [], characters: header.length, textHash: digest(header) };
  old.text = old.pageTexts.map(row => row.text).join('\n\n'); old.parserVersion = '3';
  const f = fixture(t, { options: { parserVersion: '3', parser: { parse: async () => structuredClone(old) } } });
  let downloads = 0, confidence = 30; const calls = [], parsedPages = [];
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? (downloads++, new Response(bytes))
    : url.searchParams.get('art_code') === noticeId ? response(body(notices[0], 1, { notice_content: '公告节选……' })) : null);
  const legacy = await f.service.get(SYMBOL); assert.equal(legacy.documents.find(doc => doc.id === noticeId).complete, true);
  assert.equal(downloads, 1);
  const parser = new CompanyDocumentParser({ recognize: (_bytes, metadata) => { calls.push(metadata.page);
    return { data: { text: 'Re-audited complete scanned original body retains exact source identity.', confidence } }; } });
  t.after(() => parser.destroy());
  const upgraded = f.create(); upgraded.parserVersion = PARSER_VERSION;
  upgraded.parser = { parse: (input, options) => parser.parse(input, { ...options, onProgress: value => {
    if (value.stage === 'parsed') parsedPages.push(value.page); options.onProgress?.(value);
  } }) };
  assert.equal(upgraded.peek(SYMBOL), null, '旧完整文档不得继续作为当前已核验正文');
  const pending = await upgraded.get(SYMBOL, { force: true });
  assert.equal(pending.status, 'partial'); assert.ok(!pending.documents.some(doc => doc.id === noticeId));
  assert.deepEqual(calls, [2]); assert.deepEqual(parsedPages, [1, 4, 2]); assert.equal(downloads, 1);
  const migration = pending.acquisition.events.find(event => event.code === 'parser-cache-migrated');
  assert.equal(migration.retainedPages, 1); assert.equal(migration.reauditPages, 3);
  const checkpoint = upgraded.cachedParsing(digest(bytes));
  assert.equal(checkpoint.parserVersion, PARSER_VERSION); assert.equal(checkpoint.complete, false);
  assert.deepEqual(checkpoint.pageTexts[2], old.pageTexts[2]);
  confidence = 96; parsedPages.length = 0;
  const retried = await upgraded.get(SYMBOL, { force: true, retryFailed: true }), document = retried.documents.find(doc => doc.id === noticeId);
  assert.equal(document.complete, true); assert.equal(document.numericEligible, false); assert.equal(document.parserVersion, PARSER_VERSION);
  assert.deepEqual(calls, [2, 2]); assert.deepEqual(parsedPages, [2]); assert.equal(downloads, 1);
  assert.deepEqual(document.pageTexts[2], old.pageTexts[2]);
});

test('版本3乱码转OCR缓存经实际资料入口重审字体，复用原件且新版正文不再带重审标记', async t => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/company-native-embedded-checkboxes.pdf'));
  const seed = new CompanyDocumentParser({ recognize: () => { throw Error('Native fixture must not need OCR'); } });
  const old = await seed.parse(bytes); await seed.destroy();
  // Model the earlier parser's completed OCR rows; source acquisition and the
  // upgraded parser below use the actual PDF bytes, not text-output mocks.
  old.pageTexts = old.pageTexts.map(({ page }) => {
    const text = `Previously completed OCR disclosure page ${page}, with a checkbox whose PDF font was anonymous.`;
    return { page, text, method: 'ocr', confidence: 96, complete: true, numericEligible: false, tableLike: false,
      issues: ['text-layer-replaced: text-garbled: 文字含乱码'], characters: text.length, textHash: digest(text) };
  });
  old.text = old.pageTexts.map(page => page.text).join('\n\n'); old.hasOcrPages = true; old.numericEligible = false; old.parserVersion = '3';
  old.issues = old.pageTexts.flatMap(page => page.issues.map(issue => `第 ${page.page} 页 ${issue}`));
  const f = fixture(t, { options: { parserVersion: '3', parser: { parse: async () => structuredClone(old) } } });
  let downloads = 0, ocrCalls = 0; const resumes = [];
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? (downloads++, new Response(bytes))
    : url.searchParams.get('art_code') === noticeId ? response(body(notices[0], 1, { notice_content: '公告节选……' })) : null);
  const legacy = await f.service.get(SYMBOL);
  assert.equal(legacy.documents.find(doc => doc.id === noticeId).hasOcrPages, true);
  const parser = new CompanyDocumentParser({ recognize: () => { ocrCalls++; throw Error('Valid embedded font must not use OCR'); } });
  t.after(() => parser.destroy());
  const upgraded = f.create(); upgraded.parserVersion = PARSER_VERSION;
  upgraded.parser = { parse: (input, options) => { resumes.push(structuredClone(options.resume)); return parser.parse(input, options); } };
  assert.equal(upgraded.peek(SYMBOL), null);
  const result = await upgraded.get(SYMBOL, { force: true, retryFailed: true });
  const document = result.documents.find(doc => doc.id === noticeId);
  assert.ok(document, result.errors.join(';')); assert.equal(document.complete, true); assert.equal(document.numericEligible, true);
  assert.equal(document.parserVersion, PARSER_VERSION); assert.equal(document.hasOcrPages, false);
  assert.equal(downloads, 1); assert.equal(ocrCalls, 0); assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0].pageTexts.map(page => page.nativeReauditFromVersion), ['3', '3']);
  assert.ok(document.pageTexts.every(page => page.method === 'pdf-text' && page.nativeReauditFromVersion === undefined));
  assert.deepEqual(document.pageTexts.map(page => page.verifiedCheckboxes.length), [6, 1]);
  const migration = result.acquisition.events.find(event => event.code === 'parser-cache-migrated');
  assert.equal(migration.retainedPages, 2); assert.equal(migration.nativeOcrReauditPages, 2); assert.equal(migration.reauditPages, 2);
  const restart = f.create(); restart.parserVersion = PARSER_VERSION;
  restart.parser = { parse: async () => { throw Error('The completed v4 document must survive restart'); } };
  const restored = await restart.get(SYMBOL, { force: true, retryFailed: true });
  assert.equal(restored.documents.find(doc => doc.id === noticeId).numericEligible, true); assert.equal(downloads, 1);
});

test('旧解析正文不能仅靠改写外层缓存版本冒充新版核验结果', t => {
  const f = fixture(t), sourceHash = 'a'.repeat(64), old = { ...parsedText(), sourceHash, parserVersion: '3' };
  assert.equal(f.service.saveParsing(sourceHash, old), undefined);
  assert.equal(f.service.cachedParsing(sourceHash), null);
});

test('未完整OCR结果也按原件hash和解析器版本缓存，重复更新不重复OCR且不能假装完整', async t => {
  let calls = 0, downloads = 0;
  const originalParseTimings = { queuedMs: 60598, parseMs: 44914, ocrMs: 40000 };
  const text = '识别结果仍需核验', page = { page: 1, text, method: 'ocr', confidence: 25, complete: false, numericEligible: false,
    characters: text.length, textHash: digest(text), issues: ['ocr-confidence-low: OCR置信度不足'] };
  const parser = { parse: async () => { calls++; return { text, pages: 1, pageTexts: [page], format: 'pdf', parserVersion: PARSER_VERSION,
    complete: false, hasOcrPages: true, numericEligible: false, issues: ['第 1 页 OCR置信度不足'], timings: originalParseTimings }; } };
  const f = fixture(t, { options: { parser } }), pdf = textPdf('A complete original attachment for the isolated OCR cache test.');
  f.override(url => {
    if (url.hostname === 'pdf.dfcfw.com') { downloads++; return new Response(pdf); }
    return url.searchParams.get('art_code') === noticeId ? response(body(notices[0], 1, { notice_content: '公告节选……' })) : null;
  });
  for (let round = 0; round < 2; round++) {
    const result = await f.service.get(SYMBOL, { force: true });
    assert.ok(!result.documents.some(document => document.id === noticeId)); assert.match(result.errors.join(''), /OCR置信度不足/);
    const timings = result.acquisition.issues.find(issue => issue.documentId === noticeId).timings;
    assert.equal(timings.parseCached, round > 0);
    assert.equal(timings.parseMs, round > 0 ? 0 : originalParseTimings.parseMs);
    assert.equal(timings.queuedMs, round > 0 ? 0 : originalParseTimings.queuedMs);
    if (round > 0) assert.deepEqual(timings.originalParseTimings, originalParseTimings);
  }
  assert.equal(calls, 1); assert.equal(downloads, 1);
  const cached = fs.readdirSync(f.directory).filter(name => name.startsWith('parsed-'));
  assert.equal(cached.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, cached[0]), 'utf8')).result.complete, false);
  const restart = f.create(); await restart.get(SYMBOL, { force: true }); assert.equal(calls, 1, '重启仍复用待核验解析结果');
});

test('显式重试真实PDF仅重识别失败页，完整原生与OCR页复用；重试仍低置信不放行', async t => {
  const bytes = textPdf(['', 'Complete native evidence from issuer 600519 remains source matched.', '']);
  const calls = [], progress = []; let confidence = 25, parses = 0, downloads = 0;
  const parser = new CompanyDocumentParser({ recognize: (_bytes, { page }) => {
    calls.push(page); return { data: { text: 'Complete isolated original disclosure text for issuer 600519.', confidence: page === 1 ? confidence : 95 } };
  } });
  t.after(() => parser.destroy());
  const parse = parser.parse.bind(parser);
  parser.parse = (input, options) => { parses++; progress.length = 0;
    return parse(input, { ...options, onProgress: value => { progress.push(value); options.onProgress?.(value); } }); };
  const f = fixture(t, { options: { parser } });
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? (downloads++, new Response(bytes))
    : url.searchParams.get('art_code') === noticeId ? response(body(notices[0], 1, { notice_content: '公告节选……' })) : null);
  const first = await f.service.get(SYMBOL, { force: true });
  assert.equal(first.status, 'partial'); assert.deepEqual(calls, [1, 3]);
  const saved = f.service.cachedParsing(digest(bytes)); assert.equal(saved.complete, false);
  await f.service.get(SYMBOL, { force: true }); assert.equal(parses, 1, '普通更新复用尚待核验的解析结果');
  const failed = await f.service.get(SYMBOL, { force: true, retryFailed: true });
  assert.equal(failed.status, 'partial'); assert.equal(failed.documents.some(doc => doc.id === noticeId), false);
  assert.deepEqual(calls, [1, 3, 1]); assert.deepEqual(progress.filter(value => value.stage === 'parsed').map(value => value.page), [1]);
  const retry = failed.acquisition.events.find(event => event.code === 'parse-retried');
  assert.equal(retry.checkpoint, 'parse-retry'); assert.equal(retry.completedPages, 2);
  confidence = 95;
  const successful = await f.create().get(SYMBOL, { force: true, retryFailed: true });
  const document = successful.documents.find(doc => doc.id === noticeId);
  assert.equal(successful.status, 'ready'); assert.equal(document.complete, true); assert.equal(document.numericEligible, false);
  assert.deepEqual(calls, [1, 3, 1, 1]); assert.equal(downloads, 1);
  assert.deepEqual(document.pageTexts.slice(1), saved.pageTexts.slice(1));
  const before = parses;
  await f.create().get(SYMBOL, { force: true, retryFailed: true });
  assert.equal(parses, before, '完整高置信OCR不能靠重识别变为数值证据；完整正文继续复用');
});

test('取消显式页级重试不覆盖之前的不完整解析缓存，下轮仍能恢复可信页', async t => {
  const bytes = textPdf(['', 'Complete native page retained across cancelled retry.']);
  let began, hang = false, calls = 0; const started = new Promise(resolve => { began = resolve; });
  const parser = new CompanyDocumentParser({ recognize: () => {
    calls++; if (hang) { began(); return new Promise(() => {}); }
    return { data: { text: 'Incomplete OCR remains pending before the retry.', confidence: 20 } };
  } });
  t.after(() => parser.destroy());
  const f = fixture(t, { options: { parser } });
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? new Response(bytes)
    : url.searchParams.get('art_code') === noticeId ? response(body(notices[0], 1, { notice_content: '公告节选……' })) : null);
  await f.service.get(SYMBOL, { force: true });
  const filename = f.service.parsedCachePath(digest(bytes)), before = fs.readFileSync(filename, 'utf8');
  hang = true; const controller = new AbortController();
  const pending = f.service.get(SYMBOL, { force: true, retryFailed: true, signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await started; controller.abort(); await rejected; await parser.parseQueue;
  assert.equal(fs.readFileSync(filename, 'utf8'), before); assert.equal(f.service.pending.size, 0);
  assert.equal(f.service.cachedParsing(digest(bytes)).complete, false); assert.equal(calls, 2);
});

test('图片失败显式重试整张图片且不制造PDF断点，普通更新及成功OCR继续复用', async t => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/company-ocr-page.png'));
  let confidence = 25, calls = 0, downloads = 0;
  const real = new CompanyDocumentParser({ recognize: () => { calls++; return { data: { text: 'Complete original image announcement from issuer 600519.', confidence } }; } });
  t.after(() => real.destroy());
  const parser = { parse: (input, options) => { assert.equal(options.resume, undefined); return real.parse(input, options); } };
  const f = fixture(t, { options: { parser } }), item = { ...notices[0], kind: 'notice' }, url = `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.png`;
  f.override(input => input.hostname === 'pdf.dfcfw.com' ? (downloads++, new Response(bytes)) : null);
  await assert.rejects(f.service.pdf(item, SYMBOL, url), /未完整解析/);
  await assert.rejects(f.service.pdf(item, SYMBOL, url), /未完整解析/); assert.equal(calls, 1);
  confidence = 95;
  const result = await f.service.pdf(item, SYMBOL, url, undefined, undefined, [], { retryFailed: true });
  assert.equal(result.complete, true); assert.equal(result.numericEligible, false); assert.equal(calls, 2); assert.equal(downloads, 1);
  await f.service.pdf(item, SYMBOL, url, undefined, undefined, [], { retryFailed: true }); assert.equal(calls, 2);
});

test('缺少页级及版本元数据的旧正文缓存必须重新取得，不能被标成已经OCR核验', async t => {
  const f = fixture(t); await f.service.get(SYMBOL); const file = path.join(f.directory, `doc-${annualId}.json`);
  const old = JSON.parse(fs.readFileSync(file, 'utf8')); delete old.parserVersion; delete old.pageTexts; delete old.sourceHash;
  fs.writeFileSync(file, JSON.stringify(old)); const previousCalls = bodyCalls(f), restarted = f.create();
  assert.equal(restarted.peek(SYMBOL), null);
  const result = await restarted.get(SYMBOL); assert.equal(bodyCalls(f), previousCalls + 2);
  const document = result.documents.find(item => item.id === annualId);
  assert.equal(document.parserVersion, 'provider-text-2'); assert.equal(document.hasOcrPages, false);
});

test('解析结果与正文使用独立数量预算，未保留的公告bundle索引最多100份', async t => {
  const f = fixture(t, { options: { maxCachedDocuments: 2 } }); await f.service.get(SYMBOL);
  const value = 'readable native source page', result = { text: value, pages: 1, pageTexts: [{ page: 1, text: value, method: 'pdf-text', confidence: null,
    complete: true, numericEligible: true, issues: [], characters: value.length, textHash: digest(value) }], complete: true, hasOcrPages: false, numericEligible: true, parserVersion: PARSER_VERSION };
  f.service.saveParsing(digest('one'), result); f.service.saveParsing(digest('two'), result);
  assert.equal(fs.readdirSync(f.directory).filter(name => /^doc-/.test(name)).length, 2);
  assert.equal(fs.readdirSync(f.directory).filter(name => /^parsed-/.test(name)).length, 2);
  for (let index = 0; index < 105; index++) f.service.saveBundle({ symbol: `sh${String(600000 + index)}`, checkedAt: f.now, status: 'unavailable', documents: [], errors: [] });
  assert.equal(fs.readdirSync(f.directory).filter(name => name.startsWith('bundle-')).length, 100);
});

test('缓存清理核验内容归属，未知同名文件、旁边账户和链接目标均保留', async t => {
  const f = fixture(t, { options: { maxCachedDocuments: 1 } });
  const unknown = path.join(f.directory, 'doc-AN20260000000000.json'), account = path.join(f.directory, 'account.json');
  fs.writeFileSync(unknown, '{ damaged or not generated by this cache'); fs.writeFileSync(account, 'ACCOUNT');
  await f.service.get(SYMBOL); f.service.pruneDisk();
  assert.equal(fs.readFileSync(unknown, 'utf8'), '{ damaged or not generated by this cache');
  assert.equal(fs.readFileSync(account, 'utf8'), 'ACCOUNT');
  assert.deepEqual(fs.readdirSync(f.directory).filter(name => name.startsWith('doc-')), [path.basename(unknown)]);
  const link = path.join(f.directory, 'doc-AN20260000000001.json');
  try { fs.symlinkSync(account, link, 'file'); } catch (error) { if (error.code === 'EPERM') return; throw error; }
  f.service.pruneDisk(); assert.equal(fs.lstatSync(link).isSymbolicLink(), true); assert.equal(fs.readFileSync(account, 'utf8'), 'ACCOUNT');
});

test('解析缓存写入失败清理本次临时文件，destroy只释放一次parser而保留缓存', async t => {
  let destroyed = 0;
  const f = fixture(t, { options: { parser: { destroy: async () => { destroyed++; } } } });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (path.dirname(to) === f.directory && path.basename(to).startsWith('parsed-')) throw Error('isolated rename failure'); return rename(from, to); };
  try { f.service.saveParsing(digest('failure'), {}); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readdirSync(f.directory).filter(name => name.endsWith('.tmp')), []);
  await f.service.get(SYMBOL); const before = fs.readdirSync(f.directory);
  await Promise.all([f.service.destroy(), f.service.destroy()]);
  assert.equal(destroyed, 1); assert.deepEqual(fs.readdirSync(f.directory), before);
});

test('正文协议错误有限重试可恢复，当前issues不混入已恢复过程且完整正文后续复用', async t => {
  const f = fixture(t, { options: { transportOptions: { retryBaseMs: 0 } } }); let attempts = 0;
  f.override(url => { if (url.searchParams.get('art_code') === noticeId && ++attempts < 3) throw Error('net::ERR_HTTP2_PROTOCOL_ERROR'); return null; });
  const first = await f.service.get(SYMBOL, { force: true }); assert.equal(first.status, 'ready'); assert.equal(attempts, 3);
  assert.deepEqual(first.acquisition.issues, []); assert.ok(first.acquisition.events.some(event => event.recovered === true && event.code === 'recovered'));
  assert.equal(first.acquisition.documents.loaded, 3); f.advance(1000);
  const second = await f.service.get(SYMBOL, { force: true }); assert.equal(attempts, 3); assert.equal(second.acquisition.documents.reused, 3);
  assert.deepEqual(second.documents.map(document => document.fetchedAt), first.documents.map(document => document.fetchedAt));
});

test('partial立即重试失败资料，手动新批恢复探针不会重抓已成功正文或复用一小时伪成功', async t => {
  const f = fixture(t, { options: { transportOptions: { retryBaseMs: 0 } } }); let failedBodies = 0;
  f.override(url => { if (url.searchParams.get('art_code') === noticeId) { failedBodies++; throw Error('net::ERR_HTTP2_PROTOCOL_ERROR'); } return null; });
  const first = await f.service.get(SYMBOL, { force: true }); assert.equal(first.status, 'partial'); assert.equal(first.documents.length, 2); assert.equal(failedBodies, 3);
  assert.equal(first.acquisition.issues[0].code, 'http2-protocol'); assert.equal(first.coverage.documentFailures[0].acquisition.documentId, noticeId);
  const indices = f.calls.filter(call => new URL(call.url).hostname === 'np-anotice-stock.eastmoney.com').length;
  const paused = await f.service.get(SYMBOL); assert.equal(paused.status, 'partial'); assert.equal(failedBodies, 3);
  assert.equal(paused.acquisition.issues[0].code, 'service-paused'); assert.equal(paused.acquisition.issues[0].attempts, 0);
  assert.ok(f.calls.filter(call => new URL(call.url).hostname === 'np-anotice-stock.eastmoney.com').length > indices, 'partial重新取得目录');
  f.override(null); f.service.beginBatch({ retry: true }); f.advance(1000);
  const before = bodyCalls(f), recovered = await f.service.get(SYMBOL, { force: true, retryFailed: true });
  assert.equal(recovered.status, 'ready'); assert.equal(bodyCalls(f), before + 1); assert.equal(recovered.acquisition.documents.reused, 2);
  assert.deepEqual(recovered.acquisition.issues, []); assert.equal(recovered.documents.find(document => document.id === annualId).fetchedAt, NOW);
});

test('已核实附件链接持久绑定公告指纹，正文网络失败可回退；首次、修订及身份错误不猜附件', async t => {
  const f = fixture(t, { options: { transportOptions: { retryBaseMs: 0 } } }), pdf = textPdf('Original complete verified public source announcement for stock 600519.'), item = { ...notices[0], kind: 'notice', period: notices[0].date };
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? { ok: false, status: 404 } : url.searchParams.get('art_code') === noticeId ? response(body(notices[0], 1, { notice_content: '公告节选……' })) : null);
  await assert.rejects(f.service.body(item, SYMBOL), /HTTP 404/);
  assert.ok(fs.existsSync(path.join(f.directory, `link-${noticeId}.json`)));
  const restarted = f.create(); let downloads = 0;
  f.override(url => { if (url.hostname === 'pdf.dfcfw.com') { downloads++; return new Response(pdf); } throw Error('net::ERR_HTTP2_PROTOCOL_ERROR'); });
  const events = [], document = await restarted.body(item, SYMBOL, undefined, undefined, events);
  assert.equal(document.complete, true); assert.equal(document.format, 'pdf-text'); assert.equal(downloads, 1);
  assert.ok(events.some(event => event.recovered && event.recovery === 'trusted-attachment'));
  await assert.rejects(restarted.body({ ...item, id: 'AN20260915009999' }, SYMBOL), error => error.acquisition.code === 'service-paused');
  await assert.rejects(restarted.body({ ...item, title: item.title + '（修订版）' }, SYMBOL), error => error.acquisition.code === 'service-paused');
  assert.equal(downloads, 1, '未知身份或修订不能使用旧链接或猜路径');
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? (downloads++, new Response(pdf)) : response(body(notices[0], 1, { security: [{ stock: '000001', market_uni: '0' }] })));
  restarted.documents.clear(); fs.unlinkSync(path.join(f.directory, `doc-${noticeId}.json`)); restarted.beginBatch({ retry: true });
  await assert.rejects(restarted.body(item, SYMBOL), /股票身份/); assert.equal(downloads, 1, '正文明确身份错误不能由缓存附件掩盖');
});

test('超过8篇近期相关公告分批全部读取，任一未完成不会宣称覆盖完整且取消释放全局槽位', async t => {
  const related = Array.from({ length: 17 }, (_, index) => ({ ...notices[0], id: `AN2026091500${String(index + 100).padStart(4, '0')}` }));
  const f = fixture(t, { rows: [...related, ...notices.slice(1)] });
  const result = await f.service.get(SYMBOL);
  assert.equal(result.status, 'ready'); assert.equal(result.coverage.relatedNotices.selected, 17); assert.equal(result.coverage.relatedNotices.loaded, 17);
  assert.equal(result.coverage.relatedNotices.omitted, 0); assert.deepEqual(result.acquisition.relatedBatches, { size: 8, total: 3, completed: 3 });
  assert.equal(result.documents.length, 19); assert.equal(f.service.requests, 0);
  const cancelFixture = fixture(t, { rows: [...related, ...notices.slice(1)] }), controller = new AbortController(); let started;
  const began = new Promise(resolve => { started = resolve; });
  cancelFixture.override(url => { if (related.some(item => item.id === url.searchParams.get('art_code'))) { started(); return new Promise(() => {}); } return null; });
  const pending = cancelFixture.service.get(SYMBOL, { signal: controller.signal }); await began; controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(cancelFixture.service.requests, 0); assert.equal(cancelFixture.service.waiters.length, 0);
});

test('附件host冷却仍可核验原件hash后本地重解析，不发网络或更改原件获取时间', async t => {
  const f = fixture(t), pdf = textPdf('Verified local original announcement for issuer 600519.'); let downloads = 0;
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? (downloads++, new Response(pdf)) : null);
  const first = await f.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`);
  const state = f.service.transport.state('pdf.dfcfw.com'); state.until = f.now + 30000; state.failures = 3; state.lastCode = 'http2-protocol';
  const sourceHash = first.sourceHash; fs.unlinkSync(f.service.parsedCachePath(sourceHash)); f.advance(1000);
  const second = await f.service.pdf(notices[0], SYMBOL, `https://pdf.dfcfw.com/pdf/H2_${noticeId}_1.pdf`);
  assert.equal(second.complete, true); assert.equal(downloads, 1); assert.equal(second.originalFile.downloadedAt, first.originalFile.downloadedAt);
});

test('单家公司累计全文预算有界，超出后停止读取余下正文并明确覆盖不足且保留成功缓存', async t => {
  const rows = [...Array.from({ length: 12 }, (_, index) => ({ ...notices[0], id: `AN2026091500${String(index + 100).padStart(4, '0')}` })), ...notices.slice(1)];
  const f = fixture(t, { rows, options: { maxCompanyDocumentBytes: 7000 } }), result = await f.service.get(SYMBOL);
  assert.notEqual(result.status, 'ready'); assert.equal(result.coverage.complete, false);
  assert.ok(result.acquisition.documents.retainedBytes <= 7000); assert.ok(result.acquisition.documents.skipped > 0);
  assert.ok(result.acquisition.issues.some(issue => issue.code === 'company-document-budget' && !issue.retryable));
  assert.ok(result.acquisition.documents.attempted < rows.length); assert.ok(fs.readdirSync(f.directory).some(name => name.startsWith('doc-')));
  assert.equal(result.coverage.relatedNotices.complete, false);
});

test('同轮冷却后延期重试覆盖被级联跳过的公告，已恢复过程不保留为当前失败', async t => {
  const related = Array.from({ length: 3 }, (_, index) => ({ ...notices[0], id: `AN20260915000${index + 3}` }));
  const sleeps = []; let attempts = 0;
  const f = fixture(t, { rows: [...related, ...notices.slice(1)], options: { maxConcurrent: 1, deferredRecoveryMs: 65000,
    transportOptions: { retryBaseMs: 0, sleep: async ms => { if (ms) { sleeps.push(ms); f.advance(ms); } } }
  } });
  f.override(url => {
    if (related.some(item => item.id === url.searchParams.get('art_code')) && ++attempts <= 3) throw Error('net::ERR_HTTP2_PROTOCOL_ERROR');
    return null;
  });
  const result = await f.service.get(SYMBOL);
  assert.equal(result.status, 'ready'); assert.equal(result.coverage.complete, true); assert.equal(result.documents.length, 5);
  assert.deepEqual(sleeps, [30000]); assert.equal(attempts, 6); assert.equal(result.acquisition.documents.retried, 3);
  assert.equal(result.acquisition.documents.failed, 0); assert.deepEqual(result.acquisition.issues, []); assert.deepEqual(result.coverage.documentFailures, []);
  const recovered = result.acquisition.events.filter(event => event.code === 'deferred-recovered');
  assert.deepEqual(recovered.map(event => event.documentId).sort(), related.map(row => row.id).sort());
  assert.ok(recovered.every(event => event.recovered)); assert.ok(recovered.some(event => event.attempts === 0), '未发请求的连带跳过也必须补读');
  assert.equal(f.service.requests, 0); assert.equal(f.service.waiters.length, 0);
});

test('429的长Retry-After超过同轮预算时保留待补齐，不靠延期或手动新批提前重试', async t => {
  const sleeps = []; let attempts = 0;
  const f = fixture(t, { options: { deferredRecoveryMs: 65000, transportOptions: { retryBaseMs: 0,
    sleep: async ms => { sleeps.push(ms); f.advance(ms); }
  } } });
  f.override(url => {
    if (url.searchParams.get('art_code') === noticeId) { attempts++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); }
    return null;
  });
  const first = await f.service.get(SYMBOL);
  assert.equal(first.status, 'partial'); assert.equal(first.acquisition.documents.failed, 1); assert.equal(first.acquisition.documents.retried || 0, 0);
  assert.equal(first.acquisition.issues[0].code, 'http-429'); assert.equal(first.acquisition.issues[0].retryAt, NOW + 120000);
  assert.equal(attempts, 1); assert.deepEqual(sleeps, []);
  f.service.beginBatch({ retry: true });
  const second = await f.service.get(SYMBOL, { force: true, retryFailed: true });
  assert.equal(second.status, 'partial'); assert.equal(second.acquisition.issues[0].code, 'service-paused');
  assert.equal(second.acquisition.issues[0].attempts, 0); assert.equal(attempts, 1); assert.deepEqual(sleeps, []);
});

test('永久协议失败最多两轮延期探测，保留最终诊断且不宣称完整覆盖', async t => {
  const sleeps = []; let attempts = 0;
  const f = fixture(t, { options: { deferredRecoveryMs: 65000, maxDeferredPasses: 2, transportOptions: { retryBaseMs: 0,
    sleep: async ms => { if (ms) { sleeps.push(ms); f.advance(ms); } }
  } } });
  f.override(url => { if (url.searchParams.get('art_code') === noticeId) { attempts++; throw Error('net::ERR_HTTP2_PROTOCOL_ERROR'); } return null; });
  const result = await f.service.get(SYMBOL);
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.complete, false); assert.equal(attempts, 5);
  assert.deepEqual(sleeps, [30000, 30000]); assert.equal(result.acquisition.documents.retried, 2); assert.equal(result.acquisition.documents.failed, 1);
  assert.equal(result.acquisition.issues[0].code, 'http2-protocol'); assert.equal(result.acquisition.issues[0].attempts, 1);
  assert.equal(result.acquisition.issues[0].retryAt, NOW + 90000);
  assert.ok(!result.acquisition.events.some(event => event.code === 'deferred-recovered'));
});

test('用户取消同轮恢复等待立即退出并释放请求、活动文档与pending，不写成功bundle', async t => {
  let started, attempts = 0; const began = new Promise(resolve => { started = resolve; }), controller = new AbortController();
  const f = fixture(t, { rows: [notices[0]], options: { deferredRecoveryMs: 65000,
    transportOptions: { retryBaseMs: 0, sleep: async ms => { if (!ms) return; started(); await new Promise(() => {}); } }
  } });
  f.override(url => { if (url.searchParams.get('art_code') === noticeId) { attempts++; throw Error('net::ERR_HTTP2_PROTOCOL_ERROR'); } return null; });
  const pending = f.service.get(SYMBOL, { signal: controller.signal }); await began; controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(attempts, 3);
  assert.equal(f.service.requests, 0); assert.equal(f.service.waiters.length, 0); assert.equal(f.service.activeDocuments.size, 0); assert.equal(f.service.pending.size, 0);
  assert.equal(fs.existsSync(path.join(f.directory, `bundle-${SYMBOL}.json`)), false);
});

test('延期总预算到期会取消无响应探针并保留原始协议失败，不能变成成功或泛化取消', async t => {
  let attempts = 0; const keeper = setInterval(() => {}, 1000); t.after(() => clearInterval(keeper));
  const f = fixture(t, { rows: [notices[0]], options: { deferredRecoveryMs: 40, maxDeferredPasses: 2,
    transportOptions: { failureThreshold: 1, cooldownMs: 1, retryBaseMs: 0, sleep: async ms => { f.advance(ms); } }
  } });
  f.override(url => {
    if (url.searchParams.get('art_code') !== noticeId) return null;
    if (++attempts === 1) throw Error('net::ERR_HTTP2_PROTOCOL_ERROR');
    return new Promise(() => {});
  });
  const result = await f.service.get(SYMBOL);
  assert.equal(result.status, 'unavailable'); assert.equal(result.coverage.complete, false); assert.equal(attempts, 2);
  assert.equal(result.acquisition.documents.retried, 1); assert.equal(result.acquisition.documents.failed, 1);
  assert.equal(result.acquisition.issues[0].code, 'http2-protocol'); assert.equal(result.acquisition.issues[0].attempts, 1);
  assert.equal(result.acquisition.issues[0].retryAt, NOW + 1);
  assert.equal(f.service.requests, 0); assert.equal(f.service.waiters.length, 0); assert.equal(f.service.activeDocuments.size, 0);
});

test('已完整解析的25字原始PDF接受并可重启复用，无附件25字网页节选仍拒绝', async t => {
  const row = { ...notices[0], chunks: ['请查阅附件'] }, pdf = textPdf('Issuer record 1234');
  const f = fixture(t, { rows: [row] }); let downloads = 0;
  f.override(url => url.hostname === 'pdf.dfcfw.com' ? (downloads++, new Response(pdf)) : null);
  const result = await f.service.get(SYMBOL), document = result.documents[0];
  assert.equal(document.text, 'Issuer record 1234 page 1'); assert.equal(document.characters, 25);
  assert.equal(document.complete, true); assert.equal(document.format, 'pdf-text'); assert.equal(document.pageTexts[0].complete, true);
  assert.equal(document.originalFile.sha256, digest(pdf)); assert.equal(result.acquisition.documents.failed, 0);
  const restarted = f.create(), cached = restarted.peek(SYMBOL);
  assert.equal(cached.documents[0].text, document.text); const next = await restarted.get(SYMBOL, { force: true });
  assert.equal(next.documents[0].text, document.text); assert.equal(downloads, 1); assert.equal(next.acquisition.documents.reused, 1);
  await f.service.destroy(); await restarted.destroy();
  const web = fixture(t, { rows: [{ ...row, chunks: [document.text] }] });
  web.override(url => url.searchParams.get('art_code') === noticeId ? response(body({ ...row, chunks: [document.text] }, 1, { attach_url: '' })) : null);
  const rejected = await web.service.get(SYMBOL);
  assert.equal(rejected.documents.length, 0); assert.equal(rejected.acquisition.documents.failed, 1);
  assert.equal(rejected.acquisition.issues[0].code, 'invalid-document'); assert.match(rejected.errors.join(''), /节选/);
  assert.equal(web.calls.some(call => new URL(call.url).hostname === 'pdf.dfcfw.com'), false);
});
