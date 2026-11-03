'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { symbolOf, cnTime } = require('./common.cjs');
const { parseNotices, externalUrl } = require('./research.cjs');
const { CompanyAttachmentCache, attachmentInfo } = require('./company-attachment-cache.cjs');
const { CompanyDocumentParser, PARSER_VERSION, isVerifiedNonContentPage, nativeReauditEligible, documentCheckpoint } = require('./company-document-parser.cjs');
const { CompanyEvidenceTransport, classifyAcquisitionError } = require('./company-evidence-transport.cjs');
const { isSensitiveNoticeTitle, checkNoticeRisk } = require('./entry-risk.cjs');
const { isCninfoId, cninfoAttachment, DOCUMENT_SOURCE: CNINFO_SOURCE } = require('./cninfo-notice-source.cjs');

const INDEX_URL = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const BODY_URL = 'https://np-cnotice-stock.eastmoney.com/api/content/ann';
const SOURCE = '东方财富公告全文';
const PROVIDER_PARSER_VERSION = 'provider-text-2';
const COLLECTION_VERSION = 2;
const RELATED = /风险|诉讼|仲裁|处罚|立案|调查|债务|逾期|违约|更正|修正|审计|资金占用|担保|问询|监管|重大合同|产品|产能|产销|销量|业绩|调研|投资者关系|竞争|行业|市场份额|订单|停产|减值/;
const hash = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
const plain = value => typeof value === 'string' ? value.trim() : '';
const normalized = value => plain(value).normalize('NFKC').replace(/\s+/g, '');
const validId = id => typeof id === 'string' && /^AN\d{10,30}$/.test(id) || isCninfoId(id);
const ENTRY_METADATA = new Set(['fetchedAt', 'checkedAt', 'savedAt', 'downloadedAt', 'lastUsedAt', 'parsedAt', 'cached',
  'cacheWarning', 'cacheWarnings', 'cacheKey', 'filePath', 'timings', 'progress', 'acquisition', 'entryEvidenceVersion', 'batchSize']);
function entryFacts(value) {
  if (Array.isArray(value)) return value.map(entryFacts);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !ENTRY_METADATA.has(key)).map(key => [key, entryFacts(value[key])]));
}
function entryFingerprint(bundle) {
  // Keep source identity, body text/hashes, parser/page completeness, coverage
  // and failures. Cache timing and acquisition progress are not new facts.
  const failures = (bundle.acquisition?.issues || []).filter(issue => !issue.recovered)
    .map(({ stage, code, documentId, message }) => ({ stage, code, documentId, message }));
  return hash(JSON.stringify(entryFacts({ symbol: bundle.symbol, status: bundle.status, scope: bundle.scope,
    documents: bundle.documents, coverage: bundle.coverage, errors: bundle.errors, noticeReview: bundle.noticeReview, failures })));
}
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(value)) return null;
  const date = value.slice(0, 10), time = Date.parse(date);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? date : null;
}
function abortError() { const error = Error('已取消公司研究资料采集'); error.name = 'AbortError'; return error; }
function active(signal) { if (signal?.aborted) throw abortError(); }
function cancellable(task, signal) {
  const pending = Promise.resolve(task);
  if (signal?.aborted) { pending.catch(() => {}); active(signal); }
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError()); signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function reportIdentity(title, publishedAt) {
  const text = normalized(title);
  if (/摘要|英文|English|取消|撤销/.test(text)) return null;
  const match = /(20\d{2})年?(半年度报告|中期报告|年度报告)(?:[_-]?全文)?(?:[（(](?:全文|修订版|修订稿|修订|更正版|更正稿|更正|更新版|更新稿|更新|修订后|更正后|更新后)[）)])?$/.exec(text);
  if (!match) return null;
  const half = match[2] !== '年度报告', year = Number(match[1]), reportDate = `${year}-${half ? '06-30' : '12-31'}`;
  if (!dateOnly(reportDate) || reportDate >= publishedAt) return null;
  return { kind: half ? 'semiannual-report' : 'annual-report', reportDate, period: `${year}${half ? '半年度' : '年度'}` };
}
function attachmentUrl(value, id) {
  return attachmentInfo(value, id)?.url || null;
}
function documentFingerprint(item, symbol) { return hash(JSON.stringify([symbol, item.id, normalized(item.title), item.date, item.kind, item.reportDate || null,
  ...(isCninfoId(item.id) ? [item.orgId, item.attachmentUrl] : [])])); }
function validPages(result) {
  const checkpoint = ['parse-timeout', 'parse-retry'].includes(result?.checkpoint);
  const sparse = checkpoint && result.checkpointLayout === 'sparse-pages-v1';
  const checkpointValid = !result?.checkpoint || checkpoint && result.format === 'pdf' && result.complete === false && result.numericEligible === false
    && Number.isSafeInteger(result.pages) && result.pages > 0 && result.pages <= 1600
    && Array.isArray(result.pageTexts) && result.pageTexts.every(page => page?.complete === true)
    && (result.checkpoint !== 'parse-retry' || Array.isArray(result.missingPages))
    && (result.missingPages === undefined || JSON.stringify(result.missingPages) === JSON.stringify(Array.from({ length: result.pages }, (_, i) => i + 1)
      .filter(page => !result.pageTexts.some(row => row?.page === page))));
  const sparseValid = !sparse || result.complete === false && result.numericEligible === false
    && Array.isArray(result.pageTexts) && Array.isArray(result.missingPages)
    && Number.isSafeInteger(result.pages) && result.pages > 0 && result.pages <= 1600
    && result.pageTexts.every(page => page?.complete === true)
    && JSON.stringify(result.missingPages) === JSON.stringify(Array.from({ length: result.pages }, (_, i) => i + 1)
      .filter(page => !result.pageTexts.some(row => row?.page === page)));
  return result && typeof result.text === 'string' && Number.isSafeInteger(result.pages) && result.pages > 0
    && checkpointValid && sparseValid && (!result.checkpointLayout || sparse)
    && Array.isArray(result.pageTexts) && result.pageTexts.length <= result.pages
    && typeof result.complete === 'boolean' && (!result.complete || result.pageTexts.length === result.pages && result.pageTexts.every(page => page.complete && !page.nativeReauditFromVersion))
    && result.pageTexts.every((page, index) => (sparse ? Number.isSafeInteger(page?.page) && page.page > (result.pageTexts[index - 1]?.page || 0) && page.page <= result.pages : page?.page === index + 1) && typeof page.text === 'string'
      && ['provider-text', 'pdf-text', 'ocr', 'page-audit'].includes(page.method) && typeof page.complete === 'boolean'
      && (page.nativeReauditFromVersion === undefined || page.nativeReauditFromVersion === '3' && nativeReauditEligible(page))
      && (!(page.method === 'page-audit' || page.contentRole === 'non-content' || page.classification) || isVerifiedNonContentPage(page, result))
      && typeof page.numericEligible === 'boolean' && (page.method !== 'ocr' || !page.numericEligible)
      && page.characters === page.text.length && page.textHash === hash(page.text) && Array.isArray(page.issues))
    && result.text === result.pageTexts.map(page => page.text).join('\n\n')
    && result.hasOcrPages === result.pageTexts.some(page => page.method === 'ocr')
    && result.numericEligible === (result.complete && result.pageTexts.every(page => page.numericEligible));
}
function validDocument(document, symbol, parserVersion) {
  return document && validId(document.id) && document.symbol === symbol && document.issuerSymbol === symbol
    && document.complete === true && document.source === (isCninfoId(document.id) ? CNINFO_SOURCE : SOURCE) && ['annual-report', 'semiannual-report', 'notice'].includes(document.kind)
    && (!isCninfoId(document.id) || document.format !== 'provider-text' && cninfoAttachment(document.attachmentUrl, document.id, document.publishedAt))
    && document.sourceKind === document.kind && dateOnly(document.publishedAt) === document.publishedAt
    && typeof document.title === 'string' && typeof document.text === 'string' && document.text.length > 20
    && (document.fullText == null || document.fullText === document.text) && document.textHash === hash(document.text)
    && validPages(document) && document.parserVersion === (document.format === 'provider-text' ? PROVIDER_PARSER_VERSION : parserVersion)
    && /^[a-f0-9]{64}$/.test(document.sourceHash) && (document.format !== 'provider-text' || document.sourceHash === document.textHash)
    && (document.format === 'provider-text' || document.originalFile?.sha256 === document.sourceHash)
    && Number.isSafeInteger(document.pages) && document.pages > 0 && Number.isFinite(document.fetchedAt)
    && document.url === externalUrl({ symbol, kind: 'notice', article: document.id });
}

class CompanyEvidenceSource {
  constructor(fetcher = fetch, { directory = null, clock = Date.now, timeoutMs = 15000, pageSize = 100, maxIndexPages = 12,
    maxBodyPages = 160, maxDocumentChars = 800000, maxRelatedDocuments = 8, relatedDays = 90,
    maxConcurrent = 3, cacheMs = 3600000, maxCachedDocuments = 80, maxCachedBytes = 384 * 1024 * 1024,
    maxBodyCacheBytes = Math.max(1, Math.floor(maxCachedBytes * 2 / 3)), maxParsedCacheBytes = Math.max(1, maxCachedBytes - maxBodyCacheBytes), maxParsedDocuments = maxCachedDocuments,
    maxPdfBytes = 128 * 1024 * 1024, maxPdfPages = 600, pdfTimeoutMs = 120000, pdfDownloadTimeoutMs = 120000, minimumReportChars = 10000,
    maxAttachmentCacheBytes = 512 * 1024 * 1024, attachmentCacheMaxAgeMs = 30 * 86400000,
    maxCompanyDocumentBytes = 80 * 1024 * 1024, deferredRecoveryMs = 65000, maxDeferredPasses = 2,
    largeDocumentLimits = {},
    parser = null, parserVersion = PARSER_VERSION, transport = null, transportOptions = {}, onProgress = () => {}, noticeSource = null } = {}) {
    this.noticeSource = noticeSource;
    for (const [key, value, max] of [['pageSize', pageSize, 100], ['maxIndexPages', maxIndexPages, 30], ['maxBodyPages', maxBodyPages, 400],
      ['maxDocumentChars', maxDocumentChars, 2000000], ['maxRelatedDocuments', maxRelatedDocuments, 30], ['relatedDays', relatedDays, 366],
      ['maxConcurrent', maxConcurrent, 6], ['maxCachedDocuments', maxCachedDocuments, 500], ['maxCachedBytes', maxCachedBytes, 512 * 1024 * 1024],
      ['maxBodyCacheBytes', maxBodyCacheBytes, 512 * 1024 * 1024], ['maxParsedCacheBytes', maxParsedCacheBytes, 512 * 1024 * 1024], ['maxParsedDocuments', maxParsedDocuments, 500],
      ['maxPdfBytes', maxPdfBytes, 256 * 1024 * 1024], ['maxPdfPages', maxPdfPages, 1000], ['pdfTimeoutMs', pdfTimeoutMs, 120000], ['pdfDownloadTimeoutMs', pdfDownloadTimeoutMs, 120000], ['minimumReportChars', minimumReportChars, 100000],
      ['maxAttachmentCacheBytes', maxAttachmentCacheBytes, 1024 * 1024 * 1024], ['attachmentCacheMaxAgeMs', attachmentCacheMaxAgeMs, 90 * 86400000],
      ['maxCompanyDocumentBytes', maxCompanyDocumentBytes, 512 * 1024 * 1024], ['deferredRecoveryMs', deferredRecoveryMs, 120000], ['maxDeferredPasses', maxDeferredPasses, 3]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error(`${key} 上限无效`);
    }
    if (maxBodyCacheBytes + maxParsedCacheBytes > maxCachedBytes && maxCachedBytes > 1) throw Error('正文与解析缓存预算合计超过总上限');
    this.largeDocumentLimits = { maxBytes: 384 * 1024 * 1024, maxPages: 1200, maxChars: 2000000, timeoutMs: 300000, downloadTimeoutMs: 300000, ...largeDocumentLimits };
    for (const [key, limit] of [['maxBytes', 512 * 1024 * 1024], ['maxPages', 1600], ['maxChars', 4000000], ['timeoutMs', 300000], ['downloadTimeoutMs', 300000]]) {
      const value = this.largeDocumentLimits[key]; if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw Error(`大文档 ${key} 上限无效`);
    }
    Object.assign(this, { fetcher, directory: directory ? path.resolve(directory) : null, clock, timeoutMs, pageSize, maxIndexPages, maxBodyPages,
      maxDocumentChars, maxRelatedDocuments, relatedDays, maxConcurrent, cacheMs, maxCachedDocuments, maxCachedBytes, maxBodyCacheBytes, maxParsedCacheBytes, maxParsedDocuments,
      maxPdfBytes, maxPdfPages, pdfTimeoutMs, pdfDownloadTimeoutMs, minimumReportChars,
      maxAttachmentCacheBytes, attachmentCacheMaxAgeMs, maxCompanyDocumentBytes, deferredRecoveryMs, maxDeferredPasses, parserVersion, onProgress });
    this.parser = parser || new CompanyDocumentParser({ maxBytes: maxPdfBytes });
    this.transport = transport || new CompanyEvidenceTransport((...args) => this.fetcher(...args), { clock, timeoutMs, ...transportOptions });
    this.bundles = new Map(); this.documents = new Map(); this.attachments = new Map(); this.pending = new Map(); this.pendingNotices = new Map(); this.requests = 0; this.waiters = [];
    this.entryVersions = new Map();
    this.retainedSymbols = new Set(); this.batchSymbols = null; this.activeDocuments = new Map(); this.documentReferences = new Map();
    this.diskMetadata = new Map(); this.documentSizes = new WeakMap();
    if (this.directory) {
      fs.mkdirSync(this.directory, { recursive: true });
      if (fs.lstatSync(this.directory).isSymbolicLink()) throw Error('资料缓存目录不能为符号链接');
      this.realDirectory = fs.realpathSync.native(this.directory);
    }
  }
  destroy() {
    if (!this.destroying) this.destroying = Promise.resolve().then(() => { this._attachmentCache?.releaseRetention(); return this.parser.destroy?.(); }).catch(() => {});
    return this.destroying;
  }
  entryEvidenceVersion(inputSymbol) { return this.entryVersions.get(symbolOf(inputSymbol))?.version || 0; }
  observeEntryEvidence(bundle, lane) {
    const symbol = symbolOf(bundle.symbol), fingerprint = entryFingerprint(bundle);
    const state = this.entryVersions.get(symbol) || { version: 0, fingerprints: {}, completedVersions: {} };
    if (state.fingerprints[lane] !== fingerprint) {
      state.fingerprints[lane] = fingerprint; state.version++;
      this.entryVersions.set(symbol, state);
    }
    state.completedVersions[lane] = state.version;
    // Capture the version before returning across an await; another finished
    // response must not silently relabel this older result with its version.
    bundle.entryEvidenceVersion = state.version;
    return bundle;
  }
  beginBatch(options = {}) { const batch = this.transport.beginBatch(options); this.batchSymbols = new Set(); return batch; }
  endBatch() { this.batchSymbols = null; this.pruneMemory(); try { this.pruneDisk(); } catch {} }
  retainSymbols(symbols = []) {
    if (!Array.isArray(symbols)) throw Error('资料保留公司范围无效');
    this.retainedSymbols = new Set(symbols.map(symbolOf)); this.pruneMemory();
    try { this.pruneDisk(); } catch {}
  }
  protectedSymbol(symbol) { return this.retainedSymbols.has(symbol) || this.batchSymbols?.has(symbol); }
  holdDocument(symbol, id) {
    const key = `${symbol}:${id}`; this.activeDocuments.set(key, (this.activeDocuments.get(key) || 0) + 1);
    return () => { const remaining = this.activeDocuments.get(key) - 1; if (remaining) this.activeDocuments.set(key, remaining); else this.activeDocuments.delete(key); };
  }
  rememberDocument(symbol, id, value = {}) {
    const key = `${symbol}:${id}`, previous = this.documentReferences.get(key) || {};
    this.documentReferences.set(key, { ...previous, symbol, id, ...value });
  }
  progress(callback, value) { try { this.onProgress(value); callback?.(value); } catch {} }
  async slot(signal) {
    active(signal);
    if (this.requests < this.maxConcurrent) { this.requests++; return; }
    await new Promise((resolve, reject) => {
      const waiter = { resolve: () => { signal?.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1); reject(abortError()); };
      signal?.addEventListener('abort', abort, { once: true }); this.waiters.push(waiter);
    });
    if (signal?.aborted) { this.release(); throw abortError(); }
  }
  release() { const waiter = this.waiters.shift(); if (waiter) waiter.resolve(); else this.requests--; }
  async request(url, signal, stage = 'body', documentId, events = []) {
    await this.slot(signal);
    try {
      return await this.transport.json(url, { signal, stage, documentId, onDiagnostic: value => events.push(value) });
    } catch (error) { active(signal); throw error; }
    finally { this.release(); }
  }
  attachmentCache() {
    if (!this._attachmentCache) this._attachmentCache = new CompanyAttachmentCache({ directory: this.directory ? path.join(this.directory, 'attachments-v1') : null,
      clock: this.clock, maxBytes: this.maxAttachmentCacheBytes, maxAgeMs: this.attachmentCacheMaxAgeMs });
    return this._attachmentCache;
  }
  readArchivedArtifact(document) {
    if (!document || !validId(document.id) || typeof document.fingerprint !== 'string') return null;
    return this.attachmentCache().readReference(document.originalFile, { id: document.id, fingerprint: document.fingerprint },
      document.originalFile?.bytes > this.maxPdfBytes ? { mode: 'file', maxFileBytes: this.largeDocumentLimits.maxBytes } : undefined);
  }
  trustedAttachment(item, symbol) {
    const fingerprint = documentFingerprint(item, symbol), key = `${symbol}:${item.id}`;
    let saved = this.attachments.get(key);
    if (!saved && this.directory) try {
      const file = this.cacheLocation(`link-${item.id}.json`); if (fs.statSync(file).size <= 16384) saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    if (saved?.cacheKind !== 'company-attachment-link-v1' || saved.id !== item.id || saved.symbol !== symbol || saved.fingerprint !== fingerprint
      || !Number.isFinite(saved.savedAt) || saved.savedAt > this.clock() || !attachmentUrl(saved.url, item.id)) return null;
    this.attachments.set(key, saved); return saved.url;
  }
  saveTrustedAttachment(item, symbol, url) {
    if (!attachmentUrl(url, item.id)) return;
    if (this.trustedAttachment(item, symbol) === url) return;
    const saved = { cacheKind: 'company-attachment-link-v1', id: item.id, symbol, fingerprint: documentFingerprint(item, symbol), url, savedAt: this.clock() };
    this.attachments.set(`${symbol}:${item.id}`, saved); this.pruneMemory();
    try { this.write(`link-${item.id}.json`, saved); this.pruneDisk(); } catch {}
  }
  cachedOriginal(item, symbol, info) {
    return this.originalForProfile(item, symbol, info, null);
  }
  originalForProfile(item, symbol, info, profile) {
    const cache = this.attachmentCache(), fingerprint = documentFingerprint(item, symbol), key = hash(JSON.stringify([item.id, fingerprint, info.url]));
    const previous = cache.metadata(key), now = this.clock();
    if (!previous || previous.bytes > (profile?.maxBytes || this.maxPdfBytes) || now < previous.downloadedAt || now - previous.downloadedAt > this.attachmentCacheMaxAgeMs) return null;
    const raw = cache.readReference({ cacheKey: key, sha256: previous.sha256, bytes: previous.bytes, format: previous.format }, { id: item.id, fingerprint },
      profile ? { mode: 'file', maxFileBytes: profile.maxBytes } : undefined);
    if (!raw) return null;
    previous.lastUsedAt = now; try { cache.save(previous); } catch {}
    return { ...previous, ...(profile ? { filePath: raw.filePath } : { bytesData: raw.bytes }), cached: true };
  }
  cacheLocation(name) {
    if (!name || path.basename(name) !== name || name.includes('..')) throw Error('资料缓存文件名无效');
    if (!this.directory) return this.attachmentCache().location(name);
    if (fs.lstatSync(this.directory).isSymbolicLink() || fs.realpathSync.native(this.directory) !== this.realDirectory) throw Error('资料缓存目录位置已变化');
    const file = path.join(this.directory, name);
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw Error('资料缓存文件类型无效');
    return file;
  }
  parsedCachePath(sourceHash, profile, parserVersion = this.parserVersion) {
    const settingsHash = hash(JSON.stringify([parserVersion, profile?.maxPages || this.maxPdfPages, profile?.maxChars || this.maxDocumentChars]));
    return this.cacheLocation(`parsed-${sourceHash}-${settingsHash}.json`);
  }
  cachedParsing(sourceHash, profile, parserVersion = this.parserVersion) {
    try {
      const file = this.parsedCachePath(sourceHash, profile, parserVersion), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (profile?.maxChars || this.maxDocumentChars) * 10 + 1000000) return null;
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.cacheKind !== 'company-parsed-result-v1' || saved.sourceHash !== sourceHash || saved.parserVersion !== parserVersion || saved.result?.parserVersion !== parserVersion
        || saved.maxPages !== (profile?.maxPages || this.maxPdfPages) || saved.maxChars !== (profile?.maxChars || this.maxDocumentChars) || saved.result?.sourceHash && saved.result.sourceHash !== sourceHash || !validPages(saved.result)) return null;
      fs.utimesSync(file, new Date(), new Date()); return saved.result;
    } catch { return null; }
  }
  saveParsing(sourceHash, result, reference, profile) {
    let temporary;
    try {
      const file = this.parsedCachePath(sourceHash, profile); temporary = this.cacheLocation(`${path.basename(file)}-${randomUUID()}.tmp`);
      const value = { cacheKind: 'company-parsed-result-v1', sourceHash, parserVersion: this.parserVersion,
        maxPages: profile?.maxPages || this.maxPdfPages, maxChars: profile?.maxChars || this.maxDocumentChars, parsedAt: this.clock(), ...(reference ? { references: [reference] } : {}), result };
      const text = JSON.stringify(value); const commitReplacement = this.pruneDisk({ name: path.basename(file), size: Buffer.byteLength(text), value });
      fs.writeFileSync(temporary, text, { flag: 'wx' });
      fs.renameSync(temporary, file); commitReplacement?.(); this.pruneDisk();
    } catch (error) { return `解析缓存保存失败：${error.message}`; }
    finally { if (temporary) { try { const file = this.cacheLocation(path.basename(temporary)); if (fs.existsSync(file)) fs.unlinkSync(file); } catch {} } }
  }
  async pdf(item, symbol, url, signal, callback, events = [], { retryFailed = false } = {}) {
    const info = attachmentInfo(url, item.id);
    if (!info) throw Error('原始附件链接身份、域名或类型无法核验');
    const cache = this.attachmentCache(), fingerprint = documentFingerprint(item, symbol), key = hash(JSON.stringify([item.id, fingerprint, info.url]));
    const releaseOriginal = cache.hold(key), releaseDocument = this.holdDocument(symbol, item.id), startedAt = Date.now();
    let stage = 'download', downloadMs = 0, networkQueueMs = 0, raw, parsedCached = false, cacheWarning, profile = null;
    const allowLarge = info.format === 'pdf' && (['annual-report', 'semiannual-report'].includes(item.kind)
      || /重大资产重组|财务报告和审计报告|审计报告|募集说明书|招股说明书|发行股份/.test(item.title));
    const promote = reason => {
      profile = this.largeDocumentLimits;
      events.push({ stage, code: 'large-document-profile', documentId: item.id, reason, limits: { ...profile } });
    };
    const download = async () => this.originalForProfile(item, symbol, info, profile) || this.transport.run(info.url, { signal, stage: 'download', documentId: item.id,
      timeoutMs: profile?.downloadTimeoutMs || this.pdfDownloadTimeoutMs, deadlineMs: profile?.downloadTimeoutMs || this.pdfDownloadTimeoutMs,
      onDiagnostic: value => events.push(value) }, attemptSignal => cache.obtain({ id: item.id, fingerprint, url: info.url,
      ...(profile ? { mode: 'file' } : {}), maxFileBytes: profile?.maxBytes || this.maxPdfBytes, signal: attemptSignal,
      fetcher: (...args) => this.transport.response(...args),
      onProgress: detail => this.progress(callback, { stage: 'download', symbol, documentId: item.id, format: info.format, ...detail }) }));
    try {
      await this.slot(signal); networkQueueMs = Date.now() - startedAt;
      const downloadStarted = Date.now();
      try {
        const previous = cache.metadata(key);
        if (allowLarge && previous?.bytes > this.maxPdfBytes && previous.bytes <= this.largeDocumentLimits.maxBytes) promote('retained-file-size');
        try { raw = await download(); }
        catch (error) {
          const detail = error.acquisition || error;
          if (!allowLarge || profile || detail.code !== 'size-limit' || detail.actualBytes > this.largeDocumentLimits.maxBytes) throw error;
          promote('file-size-limit'); raw = await download();
        }
      } finally { downloadMs = Date.now() - downloadStarted; this.release(); }
      this.rememberDocument(symbol, item.id, { sourceHash: raw.sha256, originalFile: { cacheKey: raw.key }, fingerprint });
      stage = 'parse';
      const parse = async () => {
        let result = this.cachedParsing(raw.sha256, profile);
        // Version 3 could mistake a native header above a scanned body for a
        // complete native page. Re-audit all of those cheap text layers, while
        // retaining genuine complete OCR and independently verified blank or
        // audited pages from the exact same original and parser limits.
        if (!result && info.format === 'pdf' && this.parserVersion === '4') {
          const legacy = this.cachedParsing(raw.sha256, profile, '3');
          if (legacy?.sourceHash === raw.sha256 && legacy.format === 'pdf') {
            const retained = legacy.pageTexts.filter(page => page.complete && (page.method === 'ocr' && !page.numericEligible
              && Number.isFinite(page.confidence) && page.confidence >= (this.parser.minOcrConfidence ?? this.parser.parserOptions?.minOcrConfidence ?? 85)
              && page.confidence <= 100 || isVerifiedNonContentPage(page, legacy)))
              .map(page => nativeReauditEligible(page) ? { ...page, nativeReauditFromVersion: '3' } : page);
            result = documentCheckpoint(raw.sha256, legacy.pages, retained, 'parse-retry');
            const nativeOcrReauditPages = retained.filter(page => page.nativeReauditFromVersion === '3').length;
            events.push({ stage: 'parse', code: 'parser-cache-migrated', documentId: item.id, previousVersion: '3', parserVersion: this.parserVersion,
              retainedPages: retained.length, reauditPages: legacy.pages - retained.length + nativeOcrReauditPages, nativeOcrReauditPages });
          }
        }
        const incompleteRetry = retryFailed && result?.complete === false && !result.checkpoint;
        // Complete OCR pages remain ineligible for automatic numeric facts.
        // That policy restriction is not a failed parse to rerun. Retain every
        // verified complete page when retrying an incomplete PDF document.
        const resume = ['parse-timeout', 'parse-retry'].includes(result?.checkpoint) ? result
          : incompleteRetry && info.format === 'pdf' ? documentCheckpoint(raw.sha256, result.pages, result.pageTexts, 'parse-retry') : null;
        parsedCached = !!result && !resume && !incompleteRetry;
        if (!result || resume || incompleteRetry) {
          if (resume || incompleteRetry) events.push({ stage: 'parse', code: incompleteRetry ? 'parse-retried' : 'parse-resumed', documentId: item.id,
            ...(resume ? { checkpoint: resume.checkpoint } : {}), completedPages: resume?.pageTexts.length || 0, pages: result.pages });
          try {
          result = await cancellable(this.parser.parse(profile ? { filePath: raw.filePath, bytes: raw.bytes, sha256: raw.sha256 } : raw.bytesData, { format: info.format, signal,
            ...(resume ? { resume } : {}),
            ...(profile ? { fileMaxBytes: profile.maxBytes } : {}), maxPages: profile?.maxPages || this.maxPdfPages,
            maxChars: profile?.maxChars || this.maxDocumentChars, parseTimeoutMs: profile?.timeoutMs || this.pdfTimeoutMs,
            onProgress: detail => this.progress(callback, { stage: 'documents', symbol, documentId: item.id, format: info.format, ...detail }) }), signal);
          } catch (error) {
            const partial = error.partialResult;
            if (!signal?.aborted && (error.code === 'parse-timeout' && partial?.checkpoint === 'parse-timeout'
              || error.code === 'parser-memory-limit' && partial?.checkpoint === 'parse-retry')
              && partial.parserVersion === this.parserVersion && partial.sourceHash === raw.sha256 && validPages(partial)) {
              cacheWarning = this.saveParsing(raw.sha256, partial, { symbol, id: item.id, fingerprint }, profile);
            }
            throw error;
          }
          active(signal);
          if (result.parserVersion !== this.parserVersion || result.sourceHash && result.sourceHash !== raw.sha256 || !validPages(result)) throw Error('原始附件解析结果的页级来源或版本无法核验');
          cacheWarning = this.saveParsing(raw.sha256, result, { symbol, id: item.id, fingerprint }, profile);
        }
        return result;
      };
      let parsed = await parse();
      if (!profile && allowLarge && parsed.issues?.some(issue => /document-(?:page|char)-limit:/.test(issue))) {
        promote('page-or-character-limit');
        raw = this.originalForProfile(item, symbol, info, profile);
        if (!raw) throw Error('大文档原件完整性无法再次核验');
        parsed = await parse();
      }
      active(signal);
      if (parsed.parserVersion !== this.parserVersion || parsed.sourceHash && parsed.sourceHash !== raw.sha256 || !validPages(parsed)) throw Error('原始附件解析结果的页级来源或版本无法核验');
      if (!parsed.complete) {
        const error = Error('原始附件尚未完整解析：' + (parsed.issues?.join('；') || '存在未完整读取页面'));
        error.parseIssues = structuredClone(parsed.issues || []); error.timings = parsedCached
          ? { queuedMs: 0, parseMs: 0, parseCached: true, originalParseTimings: parsed.timings } : { ...parsed.timings, parseCached: false };
        if(cacheWarning) error.cacheWarning=cacheWarning; throw error;
      }
      const timings = { ...(parsedCached ? { queuedMs: 0, parseMs: 0 } : parsed.timings), networkQueueMs, downloadMs, totalMs: Date.now() - startedAt,
        downloadCached: raw.cached, parseCached: parsedCached };
      events.push({ stage: 'parse', code: 'document-ready', documentId: item.id, timings });
      return { ...parsed, timings, ...(profile ? { documentLimits: { ...profile } } : {}), ...(cacheWarning ? { cacheWarning } : {}), format: info.format === 'pdf' ? parsed.hasOcrPages ? 'pdf-ocr' : 'pdf-text' : info.format + '-ocr',
        downloadBytes: raw.bytes, sourceHash: raw.sha256,
        originalFile: { cacheKey: raw.key, sha256: raw.sha256, bytes: raw.bytes, format: raw.format, sourceUrl: raw.sourceUrl, downloadedAt: raw.downloadedAt } };
    } catch (error) {
      active(signal);
      if (!error.acquisition) error.acquisition = { stage, code: stage === 'parse' ? error.code || 'parse-incomplete' : classifyAcquisitionError(error).code,
        retryable: false, attempts: 1, host: new URL(info.url).hostname, transport: stage === 'parse' ? 'local-parser' : 'electron-net', documentId: item.id, message: error.message };
      error.acquisition.timings = { ...error.timings, networkQueueMs, downloadMs, totalMs: Date.now() - startedAt };
      if (cacheWarning) error.acquisition.cacheWarnings = [cacheWarning];
      throw error;
    }
    finally { releaseOriginal(); releaseDocument(); }
  }
  async index(symbol, fromDate, toDate, signal, callback, events = [], force = false) {
    try { return await this.eastmoneyIndex(symbol, fromDate, toDate, signal, callback, events); }
    catch (primary) {
      active(signal); if (!this.noticeSource) throw primary;
      try {
        const rows = await this.cninfoIndex(symbol, fromDate, toDate, signal, callback, force);
        events.push({ stage: 'index', recovered: true, source: '巨潮资讯', primaryError: primary.message }); return rows;
      } catch (fallback) { active(signal); primary.message += `；巨潮公告备用失败：${fallback.message}`; throw primary; }
    }
  }
  async cninfoIndex(symbol, fromDate, toDate, signal, callback, force = false) {
    const result = await this.noticeSource.getIndex(symbol, fromDate, toDate, { signal, onProgress: callback, force });
    if (!result.complete) throw Error('巨潮公告目录覆盖不完整');
    return result.items.map(row => ({ ...row, ...(reportIdentity(row.title, row.date) || { kind: 'notice', period: row.date }) }));
  }
  async eastmoneyIndex(symbol, fromDate, toDate, signal, callback, events = []) {
    const rows = [], ids = new Set(); let expected = null;
    for (let page = 1; page <= this.maxIndexPages; page++) {
      const query = new URLSearchParams({ sr: '-1', page_size: String(this.pageSize), page_index: String(page), ann_type: 'A', stock_list: symbol.slice(2), begin_time: fromDate, end_time: toDate });
      const json = await this.request(`${INDEX_URL}?${query}`, signal, 'index', undefined, events), parsed = parseNotices(json, symbol, this.clock());
      if (json.data.page_index != null && Number(json.data.page_index) !== page) throw Error('公告目录页码不符，覆盖无法确认');
      if (expected !== null && expected !== parsed.total) throw Error('公告目录分页期间数量变化');
      expected = parsed.total;
      if (parsed.items.length !== json.data.list.length || parsed.items.some(row => row.date < fromDate || row.date > toDate)) throw Error('公告目录披露日期超出本次采集区间');
      for (const row of parsed.items) {
        if (ids.has(row.id)) throw Error('公告目录分页重复'); ids.add(row.id);
        rows.push({ ...row, ...(reportIdentity(row.title, row.date) || { kind: 'notice', period: row.date }) });
      }
      this.progress(callback, { stage: 'index', symbol, completed: rows.length, total: expected });
      if (rows.length === expected) return rows;
      if (!parsed.items.length || rows.length > expected) throw Error('公告目录分页不完整');
    }
    throw Error(`公告目录超过 ${this.maxIndexPages * this.pageSize} 条采集上限，覆盖不完整`);
  }
  cachedDocument(item, symbol) {
    const fingerprint = documentFingerprint(item, symbol), key = `${symbol}:${item.id}`;
    let document = this.documents.get(key);
    if (!document && this.directory) {
      try { const filename = this.cacheLocation(`doc-${item.id}.json`); if (fs.statSync(filename).size <= Math.max(this.maxDocumentChars, this.largeDocumentLimits.maxChars) * 10) document = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch {}
    }
    if (!validDocument(document, symbol, this.parserVersion) || document.fingerprint !== fingerprint || document.fetchedAt > this.clock()) return null;
    if (document.originalFile && this.attachmentCache().referenceState(document.originalFile, { id: document.id, fingerprint }) === 'mismatch') return null;
    this.rememberDocument(symbol, item.id, { sourceHash: document.sourceHash, originalFile: document.originalFile, fingerprint });
    this.documents.delete(key); this.documents.set(key, document); this.pruneMemory(); return copy(document);
  }
  write(filename, value) {
    if (!this.directory) return;
    const file = this.cacheLocation(filename), tempName = `${filename}-${randomUUID()}.tmp`, temp = this.cacheLocation(tempName);
    try { const text = JSON.stringify(value); this.pruneDisk({ name: filename, size: Buffer.byteLength(text), value });
      fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' }); fs.renameSync(temp, file); }
    finally { const remaining = this.cacheLocation(tempName); if (fs.existsSync(remaining)) fs.unlinkSync(remaining); }
  }
  pruneMemory() {
    // Retained bodies are immutable inside the read cache. Re-serializing every
    // full report for every cache access previously blocked the main thread.
    const sizeOf = value => {
      if (!Array.isArray(value?.pageTexts)) return Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (!this.documentSizes.has(value)) this.documentSizes.set(value, Buffer.byteLength(JSON.stringify(value), 'utf8'));
      return this.documentSizes.get(value);
    };
    let bytes = [...this.documents.values()].reduce((total, value) => total + sizeOf(value), 0);
    const unprotected = [...this.documents].filter(([key, value]) => !this.protectedSymbol(value.symbol) && !this.activeDocuments.has(key));
    while (unprotected.length > this.maxCachedDocuments || bytes > this.maxCachedBytes && unprotected.length) {
      const [key, value] = unprotected.shift(); bytes -= sizeOf(value); this.documents.delete(key);
    }
    // Memory can be rehydrated from the separately protected disk references.
    while (bytes > this.maxCachedBytes && this.documents.size) { const key = this.documents.keys().next().value; bytes -= sizeOf(this.documents.get(key)); this.documents.delete(key); }
    for (const [map, limit, getSymbol] of [[this.bundles,100,key=>key],[this.attachments,500,key=>key.split(':')[0]],[this.documentReferences,500,key=>key.split(':')[0]]]) {
      const candidates = [...map.keys()].filter(key=>!this.protectedSymbol(getSymbol(key)) && !this.activeDocuments.has(key));
      while (candidates.length > limit) map.delete(candidates.shift());
    }
    // Metadata and bundle diagnostics also consume memory. Disk references keep
    // retention independent of this in-memory read cache.
    const maps = [this.documents, this.bundles, this.attachments, this.documentReferences];
    let total = maps.reduce((sum, map) => sum + [...map.values()].reduce((n, value) => n + sizeOf(value), 0), 0);
    for (const protectedPass of [false, true]) for (const map of maps) for (const [key, value] of map) {
      if (total <= this.maxCachedBytes) return;
      const symbol = value.symbol || key.split(':')[0];
      if (!!(this.protectedSymbol(symbol) || this.activeDocuments.has(key)) !== protectedPass) continue;
      total -= sizeOf(value); map.delete(key);
    }
  }
  pruneDisk(reserve = null) {
    const directory = this.directory || this._attachmentCache?.directory; if (!directory) return;
    const entries = fs.readdirSync(directory), candidate = (name, verify = false) => {
      try {
        const file = this.cacheLocation(name), stat = fs.lstatSync(file), cached = this.diskMetadata.get(name);
        if (!verify && cached?.size === stat.size && cached.time === stat.mtimeMs && cached.ino === stat.ino && cached.validationVersion === this.parserVersion) return [{...cached,file}];
        let owned = false, value, validBody = false;
        if (stat.size <= 21000000) try {
          const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (name.startsWith('parsed-')) owned = saved.cacheKind === 'company-parsed-result-v1'
            && /^[a-f0-9]{64}$/.test(saved.sourceHash) && typeof saved.parserVersion === 'string'
            && Number.isFinite(saved.parsedAt) && Number.isSafeInteger(saved.maxPages) && Number.isSafeInteger(saved.maxChars)
            && name === `parsed-${saved.sourceHash}-${hash(JSON.stringify([saved.parserVersion, saved.maxPages, saved.maxChars]))}.json` && validPages(saved.result);
          else if (name.startsWith('doc-')) owned = name === `doc-${saved.id}.json` && saved.source === (isCninfoId(saved.id) ? CNINFO_SOURCE : SOURCE)
            && /^(sh|sz)\d{6}$/.test(saved.symbol) && saved.issuerSymbol === saved.symbol && Number.isFinite(saved.fetchedAt)
            && typeof saved.text === 'string' && saved.textHash === hash(saved.text)
            && saved.fingerprint === documentFingerprint({ id: saved.id, title: saved.title, date: saved.publishedAt, kind: saved.kind, reportDate: saved.reportDate }, saved.symbol);
          else if (name.startsWith('link-')) owned = name === `link-${saved.id}.json` && saved.cacheKind === 'company-attachment-link-v1'
            && /^(sh|sz)\d{6}$/.test(saved.symbol) && /^[a-f0-9]{64}$/.test(saved.fingerprint) && Number.isFinite(saved.savedAt) && !!attachmentUrl(saved.url, saved.id);
          else owned = name === `bundle-${saved.symbol}.json` && saved.version === 1 && Number.isFinite(saved.checkedAt)
            && ['ready', 'partial', 'unavailable'].includes(saved.status) && Array.isArray(saved.documentRefs);
          if (owned) {
            value = { id:saved.id,symbol:saved.symbol,sourceHash:saved.sourceHash,originalFile:saved.originalFile,references:saved.references,parserVersion:saved.parserVersion };
            validBody = name.startsWith('doc-') && validDocument(saved,saved.symbol,this.parserVersion);
          }
        } catch {} // Unknown or damaged files count toward capacity but are never deleted.
        const entry = { name, size:stat.size,time:stat.mtimeMs,ino:stat.ino,owned,value,validBody,validationVersion:this.parserVersion }; this.diskMetadata.set(name,entry);
        return [{...entry,file}];
      } catch { return []; }
    };
    const files = entries.filter(name => /^doc-(?:AN|CN)\d{10,30}\.json$|^parsed-[a-f0-9]{64}-[a-f0-9]{64}\.json$|^bundle-(?:sh|sz)\d{6}\.json$|^link-(?:AN|CN)\d{10,30}\.json$/.test(name))
      .filter(name=>name!==reserve?.name).flatMap(name=>candidate(name)).sort((a,b)=>a.time-b.time);
    const names = new Set(entries); for (const name of this.diskMetadata.keys()) if (!names.has(name)) this.diskMetadata.delete(name);
    if (reserve) files.push({ ...reserve, owned: true, incoming: true, time: this.clock(),validBody:reserve.name.startsWith('doc-')&&validDocument(reserve.value,reserve.value.symbol,this.parserVersion) });
    const references = [...this.documentReferences.values()];
    for (const file of files) if (file.owned && file.name.startsWith('doc-')) references.push({ symbol:file.value.symbol,id:file.value.id,sourceHash:file.value.sourceHash,originalFile:file.value.originalFile });
    const retainedRefs = references.filter(ref=>this.protectedSymbol(ref.symbol) || this.activeDocuments.has(`${ref.symbol}:${ref.id}`));
    const protectedHashes = new Set(retainedRefs.map(ref=>ref.sourceHash).filter(Boolean));
    const duplicateHashes = new Set(files.filter(file=>file.validBody).map(file=>file.value.sourceHash));
    if (this._attachmentCache) this._attachmentCache.retainReferences(retainedRefs.flatMap(ref=>ref.originalFile?.cacheKey ? [ref.originalFile.cacheKey] : []));
    for (const item of files) {
      item.kind = item.name.startsWith('doc-') ? 'body' : item.name.startsWith('parsed-') ? 'parsed' : item.name.startsWith('bundle-') ? 'bundle' : 'link';
      const value = item.value || {}, refs = value.references || [];
      item.protected = item.owned && (item.kind === 'parsed'
        ? protectedHashes.has(value.sourceHash) || refs.some(ref=>this.protectedSymbol(ref.symbol) || this.activeDocuments.has(`${ref.symbol}:${ref.id}`))
        : this.protectedSymbol(value.symbol) || this.activeDocuments.has(`${value.symbol}:${value.id}`));
      item.duplicate = item.kind==='parsed' && duplicateHashes.has(value.sourceHash);
    }
    // An upgraded parse can replace the obsolete copy of this exact original.
    // Protect the old files until publication succeeds: pruning against net
    // replacement size must not destroy the only resumable OCR checkpoint.
    const incoming = reserve?.name.startsWith('parsed-') ? reserve.value : null;
    const incomingValid = incoming?.cacheKind === 'company-parsed-result-v1' && incoming.parserVersion === this.parserVersion
      && incoming.result?.parserVersion === this.parserVersion && incoming.result?.sourceHash === incoming.sourceHash
      && validPages(incoming.result) && /^\d+$/.test(this.parserVersion);
    const preservedPages = new Map(incomingValid ? incoming.result.pageTexts.filter(page=>page.complete).map(page=>[page.page,page]) : []);
    const confidence = this.parser.minOcrConfidence ?? this.parser.parserOptions?.minOcrConfidence ?? 85;
    const canReplace = item => {
      if (!incomingValid || !item.owned || item.incoming || item.value?.sourceHash !== incoming.sourceHash
        || !['parsed','body'].includes(item.kind) || !/^\d+$/.test(item.value?.parserVersion || '')
        || Number(item.value.parserVersion) >= Number(this.parserVersion)) return false;
      let old;
      try { old = JSON.parse(fs.readFileSync(this.cacheLocation(item.name), 'utf8')); } catch { return false; }
      if (old.parserVersion !== item.value.parserVersion || old.sourceHash !== incoming.sourceHash) return false;
      const result = item.kind === 'parsed' ? old.result : old;
      if (result?.pages !== incoming.result.pages || result?.parserVersion !== old.parserVersion || !validPages(result)) return false;
      if (item.kind === 'parsed') {
        if (old.cacheKind !== 'company-parsed-result-v1' || old.sourceHash !== incoming.sourceHash
          || old.maxPages !== incoming.maxPages || old.maxChars !== incoming.maxChars) return false;
      } else if (!validDocument(old, old.symbol, old.parserVersion) || old.sourceHash !== incoming.sourceHash
        || !(incoming.references || []).some(ref=>ref.symbol === old.symbol && ref.id === old.id && ref.fingerprint === old.fingerprint)) return false;
      // Native v3 pages are deliberately re-audited. Independently verified
      // non-content pages and reliable OCR must survive in the replacement.
      return result.pageTexts.filter(page=>page.complete && (page.method === 'ocr' && !page.numericEligible
        && Number.isFinite(page.confidence) && page.confidence >= confidence && page.confidence <= 100 || isVerifiedNonContentPage(page,result)))
        .every(page=> { const replacement=preservedPages.get(page.page); return replacement &&
          (replacement.textHash === page.textHash && replacement.method === page.method || !replacement.nativeReauditFromVersion); });
    };
    const superseded = new Set(files.filter(canReplace));
    const removed = new Set(), live = () => files.filter(file=>!removed.has(file) && !superseded.has(file));
    const remove = item => { if (!item.owned || item.incoming || !candidate(item.name,true)[0]?.owned) return false;
      fs.unlinkSync(this.cacheLocation(item.name)); this.diskMetadata.delete(item.name); removed.add(item); return true; };
    for (const [kind,limit,budget] of [['body',this.maxCachedDocuments,this.maxBodyCacheBytes],['parsed',this.maxParsedDocuments,this.maxParsedCacheBytes],['bundle',100,Infinity],['link',500,Infinity]]) {
      let list = live().filter(file=>file.kind===kind), bytes=list.reduce((sum,file)=>sum+file.size,0), count=list.filter(file=>!file.protected).length;
      // Protected bodies can borrow from the total text budget. Duplicate parsed
      // copies are cheapest to recreate and never displace their verified body.
      list.sort((a,b)=>Number(!a.duplicate)-Number(!b.duplicate)||a.time-b.time);
      for (const item of list) {
        if (count<=limit && bytes<=budget) break;
        if ((!item.protected || item.duplicate) && remove(item)) { bytes-=item.size; if(!item.protected) count--; }
      }
    }
    let bytes=live().reduce((sum,file)=>sum+file.size,0);
    const ordered=live().sort((a,b)=>Number(!a.duplicate)-Number(!b.duplicate)||Number(a.protected)-Number(b.protected)||a.time-b.time);
    for(const item of ordered) {
      if(bytes<=this.maxCachedBytes) break;
      if((!item.protected || item.duplicate) && remove(item)) bytes-=item.size;
    }
    if (reserve && bytes>this.maxCachedBytes) throw Object.assign(Error('资料缓存容量已满，保留当前候选及本轮引用；本次新资料未写入缓存'), { code:'cache-capacity' });
    if (superseded.size) return () => {
      // Re-read both the published file and each deletion candidate. An I/O
      // failure or externally changed cache must leave the old source intact.
      const published = fs.readFileSync(this.cacheLocation(reserve.name), 'utf8');
      if (published !== JSON.stringify(incoming)) throw Error('新解析缓存发布后内容不一致，保留旧版缓存');
      for (const item of superseded) if (canReplace(item)) remove(item);
    };
  }
  async body(item, symbol, signal, callback, events = [], { retryFailed = false } = {}) {
    const releaseDocument = this.holdDocument(symbol, item.id);
    try {
    const cached = this.cachedDocument(item, symbol); if (cached) return { ...cached, cached: true };
    const chunks = [], seen = new Set(); let total = null, chars = 0, attachment = this.trustedAttachment(item, symbol), pdfResult = null;
    try {
      if (isCninfoId(item.id)) {
        if (item.source !== '巨潮资讯' || item.issuerSymbol !== symbol || !cninfoAttachment(item.attachmentUrl, item.id, item.date)) throw Error('巨潮目录与原始PDF身份无法核实');
        attachment = item.attachmentUrl; this.saveTrustedAttachment(item, symbol, attachment);
        pdfResult = await this.pdf(item, symbol, attachment, signal, callback, events, { retryFailed });
        const heading = normalized(pdfResult.text.slice(0, 60000));
        if (!new RegExp(`(?:证券|股票)(?:代码|代号)[：:]?${symbol.slice(2)}(?:\\D|$)`).test(heading)
          || !heading.includes(normalized(item.title))) throw Error('巨潮原始PDF无法核对证券代码或目录标题，不能用同名公告替代');
        chunks.push(pdfResult.text); total = pdfResult.pages;
      }
      for (let page = 1; !pdfResult; page++) {
        active(signal);
        const query = new URLSearchParams({ art_code: item.id, page_index: String(page), client_source: 'web', f_node: '0', s_node: '0' });
        let json;
        try { json = await this.request(`${BODY_URL}?${query}`, signal, 'body', item.id, events); }
        catch (error) {
          active(signal);
          if (!attachment || !error.acquisition?.retryable) throw error;
          pdfResult = await this.pdf(item, symbol, attachment, signal, callback, events, { retryFailed });
          events.push({ ...error.acquisition, recovered: true, recovery: 'trusted-attachment' });
          chunks.length = 0; chunks.push(pdfResult.text); total = pdfResult.pages; break;
        }
        const data = json?.data, content = plain(data?.notice_content), pages = Number(data?.page_size);
        if (json?.success !== 1 || data?.art_code !== item.id || !Array.isArray(data.security)
          || !data.security.some(row => row.stock === symbol.slice(2) && String(row.market_uni) === (symbol.startsWith('sh') ? '1' : '0'))
          || dateOnly(data.notice_date) !== item.date || normalized(data.notice_title) !== normalized(item.title)) throw Error('公告正文股票身份、披露日期或标题与目录不符');
        if (data.is_ai_summary === true || Number(data.is_ai_summary) === 1) throw Error('接口返回的是生成摘要，不能用作公告全文');
        const verifiedAttachment = attachmentUrl(data.attach_url, item.id);
        if (verifiedAttachment) { attachment = verifiedAttachment; this.saveTrustedAttachment(item, symbol, attachment); }
        const excerpt = /(?:…{2,}|\.{3,}|点击.{0,8}全文|查看.{0,8}原文)\s*$/.test(content)
          || pages === 1 && content.length > 0 && content.length < 40
          || item.kind !== 'notice' && pages === 1 && content.length < this.minimumReportChars;
        const invalidPage = !content || !Number.isSafeInteger(pages) || pages < 1 || (data.page_index != null && Number(data.page_index) !== page);
        // Public report text is sometimes only a short excerpt while page_size
        // still says 1, or empty with page_size 0 despite a valid attachment.
        // On a bad later text page, replace all chunks with the complete PDF.
        if (attachment && (excerpt || invalidPage || page === 1 && item.kind !== 'notice' && pages > 4)) {
          try { pdfResult = await this.pdf(item, symbol, attachment, signal, callback, events, { retryFailed }); chunks.length = 0; chunks.push(pdfResult.text); total = pdfResult.pages; break; }
          catch (error) {
            active(signal);
            if (excerpt || invalidPage) {
              const wrapped = Error(`${excerpt ? '公告文本为节选' : '公告文本缺失或页码无效'}，原始 PDF 未能完整解析：${error.message}`);
              wrapped.acquisition = error.acquisition; throw wrapped;
            }
          }
        }
        if (excerpt) throw Error('公告接口返回节选，不能用作完整正文；需原始 PDF');
        if (invalidPage) throw Error('公告正文缺失或页码无效，可能需要原始 PDF');
        if (pages > this.maxBodyPages) throw Error(`公告正文 ${pages} 页超过 ${this.maxBodyPages} 页采集上限，未使用截断正文`);
        if (total !== null && total !== pages) throw Error('公告正文分页期间总页数变化'); total = pages;
        const digest = hash(content); if (seen.has(digest)) throw Error('公告正文分页重复，无法确认完整性'); seen.add(digest);
        chars += content.length; if (chars > this.maxDocumentChars) throw Error('公告正文超过长度上限，未使用截断正文'); chunks.push(content);
        this.progress(callback, { stage: 'documents', symbol, documentId: item.id, page, pages: total });
        if (page === total) break;
      }
      let content = chunks.join('\n\n');
      if (content.length < 40 && attachment && !pdfResult) {
        pdfResult = await this.pdf(item, symbol, attachment, signal, callback, events, { retryFailed });
        chunks.length = 0; chunks.push(pdfResult.text); total = pdfResult.pages; content = pdfResult.text;
      }
      // The web service may return a teaser. A verified complete original PDF
      // can legitimately be only a short shareholder-count announcement.
      if (content.length < 40 && !pdfResult) throw Error('公告正文过短，不能证明已取得有效全文');
      if (content.length > (pdfResult?.documentLimits?.maxChars || this.maxDocumentChars)) throw Error('公告完整文字超过长度上限，未使用截断正文');
      if (item.kind !== 'notice') {
        const heading = normalized(content.slice(0, 60000));
        if (!heading.includes(symbol.slice(2)) || !heading.includes(item.reportDate.slice(0, 4))
          || !(item.kind === 'annual-report' ? /年度报告/.test(heading) : /半年度报告|中期报告/.test(heading))) throw Error('报告正文首页无法核对证券代码或报告期间');
      }
      const document = { id: item.id, symbol, issuerSymbol: symbol, title: item.title, url: externalUrl({ symbol, kind: 'notice', article: item.id }),
        publishedAt: item.date, period: item.period, ...(item.reportDate ? { reportDate: item.reportDate } : {}), text: content,
        source: isCninfoId(item.id) ? CNINFO_SOURCE : SOURCE, ...(isCninfoId(item.id) ? { orgId: item.orgId } : {}), kind: item.kind, sourceKind: item.kind, fetchedAt: this.clock(), complete: true, pages: total, characters: content.length,
        completeness: pdfResult ? '已逐页解析原始附件；OCR页明确标注，不作为自动事实结论依据' : '已核对提供方声明的全部正文页；未对原始附件图片和表格做视觉核验',
        format: pdfResult?.format || 'provider-text', ...(pdfResult ? { downloadBytes: pdfResult.downloadBytes, originalFile: pdfResult.originalFile, timings: pdfResult.timings,
          ...(pdfResult.cacheWarning ? { cacheWarning: pdfResult.cacheWarning } : {}) } : {}),
        parserVersion: pdfResult?.parserVersion || PROVIDER_PARSER_VERSION, sourceHash: pdfResult?.sourceHash || hash(content),
        pageTexts: pdfResult?.pageTexts || chunks.map((text, index) => ({ page: index + 1, text, method: 'provider-text', confidence: null,
          issues: [], complete: true, numericEligible: true, characters: text.length, textHash: hash(text) })),
        hasOcrPages: pdfResult?.hasOcrPages || false, numericEligible: pdfResult?.numericEligible ?? true,
        textHash: hash(content), fingerprint: documentFingerprint(item, symbol),
        ...(attachment ? { attachmentUrl: attachment } : {}) };
      this.rememberDocument(symbol, item.id, { sourceHash: document.sourceHash, originalFile: document.originalFile, fingerprint: document.fingerprint });
      this.documents.set(`${symbol}:${item.id}`, document); this.pruneMemory();
      try { this.write(`doc-${item.id}.json`, document); this.pruneDisk(); } catch (error) {
        this.documentSizes.delete(document);
        document.cacheWarnings = [...new Set([...(document.cacheWarnings || []), document.cacheWarning, `正文缓存保存失败：${error.message}`].filter(Boolean))];
        document.cacheWarning = document.cacheWarnings.join('；');
      }
      return copy(document);
    } catch (error) {
      if (attachment) error.attachmentUrl = attachment;
      if (!error.acquisition) error.acquisition = { stage: 'body', code: 'invalid-document', retryable: false, attempts: 1,
        host: isCninfoId(item.id) ? 'static.cninfo.com.cn' : new URL(BODY_URL).hostname, transport: 'electron-net', documentId: item.id, message: error.message };
      throw error;
    }
    } finally { releaseDocument(); try { this.pruneDisk(); } catch {} }
  }
  peek(inputSymbol) {
    const symbol = symbolOf(inputSymbol);
    try {
      let saved = this.bundles.get(symbol);
      if (!saved) {
        if (!this.directory) return null;
        const file = this.cacheLocation(`bundle-${symbol}.json`); if (fs.statSync(file).size > 1000000) return null;
        saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      }
      if (saved.version !== 1 || saved.collectionVersion !== COLLECTION_VERSION || saved.symbol !== symbol || !Number.isFinite(saved.checkedAt) || !['ready', 'partial', 'unavailable'].includes(saved.status) || !Array.isArray(saved.documentRefs)) return null;
      const documents = saved.documentRefs.map(item => this.cachedDocument(item, symbol));
      if (documents.some(document => !document)) return null;
      const { version, documentRefs, ...bundle } = saved; bundle.documents = documents;
      this.bundles.set(symbol, saved); this.pruneMemory(); return copy(bundle);
    } catch { return null; }
  }
  saveBundle(bundle) {
    this.observeEntryEvidence(bundle, 'research');
    bundle.cacheWarnings = [...new Set([...(bundle.cacheWarnings || []), ...(bundle.acquisition?.cacheWarnings || []),
      ...bundle.documents.flatMap(document => document.cacheWarnings || [document.cacheWarning]),
      ...(bundle.acquisition?.issues || []).flatMap(issue => issue.cacheWarnings || [])].filter(Boolean))];
    const { documents, entryEvidenceVersion, ...rest } = bundle;
    const documentRefs = documents.map(document => ({ id: document.id, title: document.title, date: document.publishedAt, kind: document.kind, reportDate: document.reportDate,
      ...(isCninfoId(document.id) ? { source: '巨潮资讯', issuerSymbol: document.issuerSymbol, orgId: document.orgId, attachmentUrl: document.attachmentUrl } : {}) }));
    const saved = { version: 1, ...copy(rest), collectionVersion: COLLECTION_VERSION, documentRefs };
    this.bundles.delete(bundle.symbol); this.bundles.set(bundle.symbol, saved); this.pruneMemory();
    try { this.write(`bundle-${bundle.symbol}.json`, saved); this.pruneDisk(); }
    catch (error) {
      bundle.cacheWarnings.push(`资料索引缓存保存失败：${error.message}`);
      saved.cacheWarnings = [...bundle.cacheWarnings];
    }
  }
  async getNotices(inputSymbol, { noticeResponse, signal, force = false, retryFailed = false, onProgress } = {}) {
    const symbol = symbolOf(inputSymbol); active(signal);
    if (typeof force !== 'boolean' || typeof retryFailed !== 'boolean') throw Error('公告原文刷新参数无效');
    // Validate the caller's current raw index, never a saved passing verdict.
    const response = copy(noticeResponse), review = checkNoticeRisk(response, symbol, new Date(this.clock()));
    const requested = review.status === 'unverified' && review.coverageComplete === true
      ? review.notices.filter(item => item.status === 'unverified').map(item => ({ ...item, kind: 'notice', period: item.date })) : [];
    const bundle = { symbol, checkedAt: this.clock(), fetchedAt: this.clock(), status: 'unavailable', scope: 'sensitive-notices-only',
      documents: [], errors: [], noticeReview: review,
      coverage: { noticeIndexComplete: review.coverageComplete === true, requestedIds: requested.map(item => item.id), documentFailures: [], complete: false },
      acquisition: { status: 'unavailable', issues: [], events: [], documents: { attempted: 0, loaded: 0, reused: 0, failed: 0, skipped: 0,
        retainedBytes: 0, maxBytes: this.maxCompanyDocumentBytes } } };
    if (!requested.length) {
      const clear = review.status === 'clear';
      bundle.status = clear ? 'ready' : 'unavailable'; bundle.coverage.complete = clear;
      bundle.acquisition.status = 'skipped';
      bundle.acquisition.code = clear ? 'no-sensitive-notices' : review.status === 'blocked' ? 'notice-title-blocked' : 'notice-index-unverified';
      if (!clear) bundle.errors = [...review.reasons];
      return this.observeEntryEvidence(bundle, 'notices');
    }
    // Separate from full research collection. A new/corrected announcement or a
    // newly fetched index must not join an older set of requested documents.
    const key = hash(JSON.stringify([symbol, response.fetchedAt, requested.map(item => documentFingerprint(item, symbol)), retryFailed, this.parserVersion]));
    if (this.pendingNotices.has(key)) return copy(await cancellable(this.pendingNotices.get(key), signal));
    const work = (async () => {
      let next = 0, completed = 0, budgetExhausted = false;
      const loaded = new Map(), { acquisition, coverage } = bundle;
      const failures = new Map();
      const budgetError = () => Object.assign(Error(`敏感公告完整文档超过 ${this.maxCompanyDocumentBytes} 字节内存预算，后续正文尚未核验`), {
        acquisition: { stage: 'parse', code: 'company-document-budget', retryable: false, attempts: 0, transport: 'local-cache' } });
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(this.maxConcurrent, requested.length) }, async () => {
        while (next < requested.length) {
          active(signal); const item = requested[next++];
          try {
            if (budgetExhausted) { acquisition.documents.skipped++; throw budgetError(); }
            acquisition.documents.attempted++;
            const document = await this.body(item, symbol, signal, onProgress, acquisition.events, { retryFailed }); active(signal);
            const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
            if (acquisition.documents.retainedBytes + bytes > this.maxCompanyDocumentBytes) { budgetExhausted = true; throw budgetError(); }
            loaded.set(item.id, document); acquisition.documents.retainedBytes += bytes;
            acquisition.documents.loaded++; if (document.cached) acquisition.documents.reused++;
          } catch (error) {
            active(signal);
            failures.set(item.id, { item, error });
          }
          this.progress(onProgress, { stage: 'notice-documents', symbol, completed: ++completed, total: requested.length });
        }
      }));
      // Let every cancelled worker release its shared request slot before the
      // caller receives cancellation; no partial success bundle is published.
      active(signal);
      const rejected = outcomes.find(outcome => outcome.status === 'rejected'); if (rejected) throw rejected.reason;
      for (const { item, error } of failures.values()) {
        const issue = { ...(error.acquisition || { stage: 'body', code: 'document-invalid', retryable: false, attempts: 1 }),
          documentId: item.id, message: error.message };
        acquisition.issues.push(issue); acquisition.documents.failed++;
        coverage.documentFailures.push({ id: item.id, url: externalUrl({ symbol, kind: 'notice', article: item.id }), reason: error.message, acquisition: issue });
        bundle.errors.push(`${item.title}：${error.message}`);
      }
      bundle.documents = requested.map(item => loaded.get(item.id)).filter(Boolean);
      bundle.checkedAt = this.clock(); bundle.fetchedAt = bundle.checkedAt;
      // Slow downloads do not extend the lifetime of the supplied title index.
      bundle.noticeReview = checkNoticeRisk(response, symbol, new Date(bundle.checkedAt));
      coverage.noticeIndexComplete = bundle.noticeReview.coverageComplete === true;
      coverage.complete = coverage.noticeIndexComplete && bundle.noticeReview.status === 'unverified' && failures.size === 0;
      if (!coverage.noticeIndexComplete) {
        const message = bundle.noticeReview.reasons.join('；'); bundle.errors.push(message);
        acquisition.issues.push({ stage: 'index', code: 'notice-index-expired', retryable: true, attempts: 0, message });
      }
      bundle.status = coverage.complete ? 'ready' : bundle.documents.length ? 'partial' : 'unavailable';
      acquisition.status = acquisition.issues.length ? bundle.documents.length ? 'partial' : 'unavailable' : 'ready';
      return this.observeEntryEvidence(bundle, 'notices');
    })().finally(() => this.pendingNotices.delete(key));
    this.pendingNotices.set(key, work);
    return copy(await work);
  }
  async get(inputSymbol, { signal, force = false, retryFailed = false, onProgress } = {}) {
    const symbol = symbolOf(inputSymbol); active(signal);
    this.batchSymbols?.add(symbol);
    if (typeof force !== 'boolean' || typeof retryFailed !== 'boolean') throw Error('资料刷新参数无效');
    if (this.pending.has(symbol)) return copy(await cancellable(this.pending.get(symbol), signal));
    // A forced index refresh still validates/reuses each selected body below.
    // Hydrating the entire old bundle here would duplicate those reads/hashes.
    const previous = force ? null : this.peek(symbol), now = this.clock();
    if (!force && previous?.status === 'ready' && now >= previous.checkedAt && now - previous.checkedAt < this.cacheMs) {
      const known = this.entryVersions.get(symbol);
      if (!known) return this.observeEntryEvidence({ ...previous, cached: true }, 'research');
      if (known.completedVersions.research === known.version)
        return { ...previous, cached: true, entryEvidenceVersion: known.completedVersions.research };
      // Another completed lane may have corrected a body or observed failure.
      // The old full cache cannot acquire that new version merely by being read;
      // collect again using the existing directory/body cache and request policy.
    }
    const task = this.collect(symbol, signal, onProgress, { retryFailed, force }).finally(() => this.pending.delete(symbol));
    this.pending.set(symbol, task); return copy(await task);
  }
  async collect(symbol, signal, callback, { retryFailed = false, cninfoOnly = false, force = false } = {}) {
    const now = this.clock(), today = cnTime(now).date, year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
    const fromDate = `${year - 1}-01-01`, recentFrom = cnTime(now - this.relatedDays * 86400000).date;
    const coverage = { fromDate, toDate: today, noticeIndexComplete: false, noticeCount: 0,
      expectedAnnualReportDate: `${year - (month >= 5 ? 1 : 2)}-12-31`, expectedSemiannualReportDate: `${year - (month >= 9 ? 0 : 1)}-06-30`,
      annualReport: { status: 'missing' }, semiannualReport: { status: 'missing' },
      relatedNotices: { selection: 'risk-and-business-keywords', keywords: RELATED.source, windowFromDate: recentFrom, matched: 0, selected: 0, loaded: 0, omitted: 0, complete: false },
      allNoticeBodiesComplete: false, documentFailures: [], businessAnalysis: { status: 'missing', derivedFromReportIds: [] }, complete: false };
    const acquisition = { status: 'unavailable', issues: [], events: [], documents: { attempted: 0, loaded: 0, reused: 0, failed: 0, skipped: 0, retainedBytes: 0, maxBytes: this.maxCompanyDocumentBytes },
      relatedBatches: { size: this.maxRelatedDocuments, total: 0, completed: 0 } };
    const bundle = { symbol, checkedAt: now, fetchedAt: now, status: 'unavailable', documents: [], coverage, errors: [], acquisition };
    let rows;
    try { rows = cninfoOnly ? await this.cninfoIndex(symbol, fromDate, today, signal, callback, force)
      : await this.index(symbol, fromDate, today, signal, callback, acquisition.events, force); coverage.noticeIndexComplete = true; coverage.noticeCount = rows.length; }
    catch (error) {
      active(signal); bundle.errors.push(error.message);
      acquisition.issues.push(error.acquisition || { stage: 'index', code: 'invalid-index', retryable: false, attempts: 1,
        host: cninfoOnly ? 'www.cninfo.com.cn' : new URL(INDEX_URL).hostname, transport: 'electron-net', message: error.message });
      for (const key of ['annualReport', 'semiannualReport']) coverage[key] = { status: 'pending', reason: `公告目录获取失败，无法判断是否已披露：${error.message}` };
      this.saveBundle(bundle); return bundle;
    }
    // A later H-share edition is a separate disclosure, not an amendment of the
    // A-share report. Within the A-share edition, never fall back from a latest
    // amendment that could not be read to an earlier, superseded report.
    const hShare = row => /H股|港股|香港联交所/i.test(normalized(row.title));
    const selectReport = kind => rows.filter(row => row.kind === kind).sort((a, b) => b.reportDate.localeCompare(a.reportDate) || Number(hShare(a)) - Number(hShare(b)) || b.date.localeCompare(a.date)
      || Number(/修订|更正|更新/.test(b.title)) - Number(/修订|更正|更新/.test(a.title)) || b.id.localeCompare(a.id))[0];
    const annual = selectReport('annual-report'), semiannual = selectReport('semiannual-report');
    const latestReport = [annual, semiannual].filter(Boolean).sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.date.localeCompare(a.date))[0];
    const relatedFrom = latestReport && latestReport.date < recentFrom ? latestReport.date : recentFrom;
    coverage.relatedNotices.windowFromDate = relatedFrom;
    const related = rows.filter(row => row.kind === 'notice' && row.date >= relatedFrom && (RELATED.test(row.title) || isSensitiveNoticeTitle(row.title))).sort((a, b) => b.date.localeCompare(a.date));
    Object.assign(coverage.relatedNotices, { matched: related.length, selected: related.length, omitted: 0, batchSize: this.maxRelatedDocuments });
    const reportsToRead = [annual, semiannual].filter(Boolean), selected = [...reportsToRead, ...related], byId = new Map();
    const batches = [reportsToRead];
    for (let offset = 0; offset < related.length; offset += this.maxRelatedDocuments) batches.push(related.slice(offset, offset + this.maxRelatedDocuments));
    acquisition.relatedBatches.total = batches.length - 1;
    let completed = 0, budgetExhausted = false;
    const failures = new Map();
    const budgetError = item => {
      const error = Error(`单家公司完整文档超过 ${this.maxCompanyDocumentBytes} 字节内存预算，后续正文尚未核验；已取得缓存保留`);
      error.acquisition = { stage: 'parse', code: 'company-document-budget', retryable: false, attempts: 0,
        host: new URL(BODY_URL).hostname, transport: 'local-cache', documentId: item.id, message: error.message }; return error;
    };
    const load = async (item, attemptSignal = signal, deferred = false) => {
        active(signal);
        try {
          if (budgetExhausted) { acquisition.documents.skipped++; throw budgetError(item); }
          if (deferred) acquisition.documents.retried = (acquisition.documents.retried || 0) + 1;
          else acquisition.documents.attempted++;
          const document = await this.body(item, symbol, attemptSignal, callback, acquisition.events, { retryFailed }); active(signal); byId.set(item.id, document);
          const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
          if (acquisition.documents.retainedBytes + bytes > this.maxCompanyDocumentBytes) {
            byId.delete(item.id); budgetExhausted = true; throw budgetError(item);
          }
          acquisition.documents.retainedBytes += bytes;
          acquisition.documents.loaded++; if (document.cached) acquisition.documents.reused++;
          if (deferred) acquisition.events.push({ ...failures.get(item.id)?.error.acquisition, code: 'deferred-recovered', recovered: true, documentId: item.id });
          failures.delete(item.id);
        }
        catch (error) {
          active(signal);
          // Expiry of the recovery budget must not replace the underlying
          // diagnosis with a generic cancellation, or cancel other companies.
          if (!deferred || !attemptSignal?.aborted) failures.set(item.id, { item, error });
        }
    };
    for (let batch = 0; batch < batches.length; batch++) {
      let next = 0; const items = batches[batch];
      await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
      while (next < items.length) {
        active(signal); const item = items[next++];
        await load(item);
        this.progress(callback, { stage: 'documents', symbol, completed: ++completed, total: selected.length });
      }
      }));
      if (batch > 0) acquisition.relatedBatches.completed++;
    }
    const recoveryStarted = performance.now();
    for (let pass = 0; pass < this.maxDeferredPasses && !budgetExhausted; pass++) {
      const deferred = [...failures.values()].filter(({ error }) => error.acquisition?.retryable && Number.isFinite(error.acquisition.retryAt));
      if (!deferred.length || typeof this.transport.waitForRecovery !== 'function') break;
      const remaining = Math.floor(this.deferredRecoveryMs - (performance.now() - recoveryStarted));
      if (remaining < 1) break;
      const deadline = AbortSignal.timeout(remaining), recoverySignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const earliest = deferred.reduce((a, b) => a.error.acquisition.retryAt <= b.error.acquisition.retryAt ? a : b);
      try {
        this.progress(callback, { stage: 'recovery', symbol, pass: pass + 1, documents: deferred.length, retryAt: earliest.error.acquisition.retryAt });
        if (!await this.transport.waitForRecovery(earliest.error.acquisition, { signal: recoverySignal, maxWaitMs: remaining })) break;
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(2, deferred.length) }, async () => {
          while (next < deferred.length && !recoverySignal.aborted) {
            const { item } = deferred[next++]; await load(item, recoverySignal, true);
          }
        }));
      } catch (error) { active(signal); if (!deadline.aborted) throw error; }
      if (deadline.aborted) break;
    }
    for (const { item, error } of failures.values()) {
      bundle.errors.push(`${item.title}：${error.message}`); acquisition.documents.failed++;
      if (error.acquisition) acquisition.issues.push(error.acquisition);
      coverage.documentFailures.push({ id: item.id, url: externalUrl({ symbol, kind: 'notice', article: item.id }), reason: error.message,
        ...(error.acquisition ? { acquisition: error.acquisition } : {}), ...(error.attachmentUrl ? { attachmentUrl: error.attachmentUrl } : {}) });
    }
    active(signal); bundle.documents = selected.map(item => byId.get(item.id)).filter(Boolean);
    for (const [key, item, expected] of [['annualReport', annual, coverage.expectedAnnualReportDate], ['semiannualReport', semiannual, coverage.expectedSemiannualReportDate]]) {
      coverage[key] = item ? { status: byId.has(item.id) && item.reportDate >= expected ? 'ready' : 'pending', id: item.id, title: item.title, reportDate: item.reportDate,
        publishedAt: item.date, url: externalUrl({ symbol, kind: 'notice', article: item.id }), ...(item.reportDate < expected ? { reason: `最近报告期早于产品核验要求 ${expected}` }
          : !byId.has(item.id) ? { reason: coverage.documentFailures.find(failure => failure.id === item.id)?.reason || '已找到公告，完整正文尚未取得' } : {}) }
        : { status: 'missing', reason: '本次完整公告目录未识别所需报告全文条目，不能据此认定公司未披露' };
      if (coverage[key].status !== 'ready') bundle.errors.push(`${key === 'annualReport' ? '年度' : '半年度'}报告资料待补齐`);
    }
    coverage.relatedNotices.loaded = related.filter(item => byId.has(item.id)).length;
    coverage.relatedNotices.complete = coverage.relatedNotices.omitted === 0 && coverage.relatedNotices.loaded === related.length;
    const reports = bundle.documents.filter(document => document.kind !== 'notice');
    coverage.businessAnalysis = { status: reports.length ? 'available' : 'missing', derivedFromReportIds: reports.map(document => document.id),
      note: '经营与行业资料来自发行人报告全文；并非独立第三方结论，正文提取不能证明不存在其他风险' };
    coverage.allNoticeBodiesComplete = bundle.documents.length === rows.length;
    coverage.complete = coverage.annualReport.status === 'ready' && coverage.semiannualReport.status === 'ready' && coverage.relatedNotices.complete && coverage.documentFailures.length === 0;
    bundle.checkedAt = this.clock(); bundle.fetchedAt = bundle.checkedAt;
    bundle.status = coverage.complete ? 'ready' : bundle.documents.length ? 'partial' : 'unavailable';
    acquisition.status = acquisition.issues.length ? bundle.documents.length ? 'partial' : 'unavailable' : 'ready';
    if (!cninfoOnly && this.noticeSource && failures.size && rows.every(item => !isCninfoId(item.id)) && !budgetExhausted) {
      // Different providers have different announcement identities. Re-select
      // and verify the whole bundle against the independent directory; never
      // attach a similarly titled PDF to an Eastmoney announcement id.
      const alternate = await this.collect(symbol, signal, callback, { retryFailed, cninfoOnly: true, force });
      if (alternate.status === 'ready') {
        alternate.acquisition.events.push({ stage: 'documents', recovered: true, source: '巨潮资讯', primaryErrors: bundle.errors });
        this.saveBundle(alternate); return alternate;
      }
      bundle.errors.push(`巨潮独立公告备用尚未完整核验：${alternate.errors.join('；')}`);
      acquisition.events.push({ stage: 'documents', recovered: false, source: '巨潮资讯', errors: alternate.errors });
    }
    this.saveBundle(bundle); return bundle;
  }
}
module.exports = { CompanyEvidenceSource, reportIdentity, SOURCE };
