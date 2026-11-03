'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { cnTime, symbolOf } = require('./common.cjs');
const { trustedIndustryUrl, issuerSearchName, hasCurrentIndustryPdfParsing } = require('./company-industry-evidence.cjs');
const { CompanyDocumentParser, PARSER_VERSION } = require('./company-document-parser.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const active = signal => { if (signal?.aborted) throw Object.assign(Error('已取消行业资料核验'), { name: 'AbortError' }); };
function entryEvidenceContents(value) {
  if (Array.isArray(value)) return value.map(entryEvidenceContents);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter(key => !['fetchedAt', 'checkedAt', 'cached', 'timings', 'acquisition', 'cacheWarning', 'cacheWarnings', 'industryEvidenceVersion'].includes(key))
    .map(key => [key, entryEvidenceContents(value[key])]));
}
function textFromHtml(html) {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<\/?(?:p|div|tr|li|h[1-6]|br)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value) => { const n = /^x/i.test(value) ? parseInt(value.slice(1), 16) : +value; return n <= 0x10ffff ? String.fromCodePoint(n) : ''; })
    .replace(/&(nbsp|amp|lt|gt|quot|apos|ldquo|rdquo|lsquo|rsquo);/g, (_, key) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' })[key])
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}
function publisherBodyMatches(html, expected) {
  const openings = /<div\b[^>]*class="content(?: xiumi-content)?"[^>]*>/g; let opening;
  while ((opening = openings.exec(html))) {
    const start = opening.index + opening[0].length, tags = /<!--[\s\S]*?-->|<\/?div\b[^>]*>/gi; tags.lastIndex = start;
    let depth = 1, tag;
    while ((tag = tags.exec(html))) {
      if (tag[0].startsWith('<!--')) continue;
      depth += /^<\//.test(tag[0]) ? -1 : 1;
      if (!depth) { if (html.slice(start, tag.index) === expected) return true; break; }
    }
  }
  return false;
}
function discoveryTerms(bundle) {
  const name = issuerSearchName(bundle), terms = name ? [name] : [];
  for (const document of bundle.documents || []) {
    // Use only markets mentioned alongside an actual source citation. The
    // directory search is discovery, never proof of a company ranking.
    const text = String(document.text || '').normalize('NFKC').replace(/\s+/g, '');
    const citation = /(?:沙利文|弗若斯特)[^。]{0,200}?《[^》]*?(?:20\d{2}年?)?(?:中国|全球)?([^《》\d]{2,20}?)(?:行业|市场)(?:研究|白皮书|报告)/.exec(text)
      || /(?:沙利文|弗若斯特)[^。]{0,200}?(?:中国|全国|全球)([^,，:：。\d]{2,20}?)(?:行业|市场)(?:零售|研究|白皮书|报告|格局)/.exec(text);
    if (citation) { terms.push(citation[1].replace(/^(?:年|中国|全球)/, '')); break; }
  }
  return [...new Set(terms)].filter(term => term.length >= 2 && term.length <= 40).slice(0, 2);
}
class CompanyIndustrySource {
  constructor(fetcher = fetch, { directory = null, clock = Date.now, parser = null, timeoutMs = 12000, maxDocuments = 3 } = {}) {
    if (typeof fetcher !== 'function' || !Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 3 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('行业源参数无效');
    Object.assign(this, { fetcher, clock, timeoutMs, maxDocuments }); this.parser = parser || new CompanyDocumentParser(); this.ownParser = !parser;
    this.directory = directory && path.resolve(directory); this.cache = new Map(); this.queue = Promise.resolve(); this.cooldownUntil = 0;
    this.entryEvidenceVersions = new Map();
    if (this.directory) { fs.mkdirSync(this.directory, { recursive: true }); if (fs.lstatSync(this.directory).isSymbolicLink()) throw Error('行业缓存目录无效'); }
  }
  async request(url, { signal, maxBytes = 4 * 1024 * 1024 } = {}) {
    active(signal); if (!trustedIndustryUrl(url)) throw Error('行业原文来源不在已支持的官方域名范围');
    if (this.clock() < this.cooldownUntil) throw Error('行业官方源限流冷却中，待后续手动更新重试');
    for (let attempt = 0; attempt < 2; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await this.fetcher(url, { signal: combined, redirect: 'error', headers: { Accept: 'application/json,application/pdf', 'request-platform': 'FROST_WEBSITE' } });
        if (response.url && !trustedIndustryUrl(response.url)) throw Error('行业原文跳转到未支持来源');
        if (response.status === 429) { this.cooldownUntil = this.clock() + 60000; throw Error('行业官方源限流，保留待核验'); }
        if (!response.ok) { const error = Error(`行业官方源 HTTP ${response.status}`); error.retryable = response.status >= 500; throw error; }
        if (Number(response.headers.get('content-length')) > maxBytes) throw Error('行业原文超过本次读取上限');
        const reader = response.body?.getReader(); if (!reader) throw Error('行业原文响应不支持有界读取');
        const chunks = []; let size = 0;
        try { while (true) { active(combined); const part = await reader.read(); if (part.done) break; size += part.value.length;
          if (size > maxBytes) throw Error('行业原文超过本次读取上限'); chunks.push(Buffer.from(part.value)); } }
        finally { await reader.cancel().catch(() => {}); }
        return Buffer.concat(chunks);
      } catch (error) {
        active(signal); if (attempt || !(error.retryable || timeout.aborted || /fetch failed|ERR_HTTP2|ECONNRESET|ETIMEDOUT/.test(error.message))) throw error;
      }
    }
  }
  cachePath(symbol) { return path.join(this.directory, `${symbolOf(symbol)}.json`); }
  // Only completed background observations publish versions. Trading reads the
  // small counter without loading a cache file or hashing report bodies.
  entryEvidenceVersion(symbol) { return this.entryEvidenceVersions.get(symbolOf(symbol))?.version || 0; }
  observeEntryEvidence(item) {
    const symbol = symbolOf(item.symbol), fingerprint = hash(JSON.stringify(entryEvidenceContents(item)));
    const previous = this.entryEvidenceVersions.get(symbol);
    if (!previous || previous.fingerprint !== fingerprint)
      this.entryEvidenceVersions.set(symbol, { fingerprint, version: (previous?.version || 0) + 1 });
    return this.entryEvidenceVersion(symbol);
  }
  cached(symbol, fingerprint) {
    let item = this.cache.get(symbol);
    if (!item && this.directory) try { const file = this.cachePath(symbol); if (!fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).size <= 36 * 1024 * 1024) item = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (item?.version !== 1 || item.fingerprint !== fingerprint || item.symbol !== symbol || !item.industryCoverage || !Array.isArray(item.industryDocuments)
      || item.industryDocuments.some(document => !hasCurrentIndustryPdfParsing(document))
      || !Number.isFinite(item.fetchedAt) || item.fetchedAt <= 0 || item.fetchedAt > this.clock() || this.clock() - item.fetchedAt > (item.industryCoverage.status === 'error' ? 300000 : 21600000)) return null;
    // Memory entries were observed by save(). A first disk hit has no local
    // version yet; register it before exposing the corresponding evidence.
    if (!this.cache.has(symbol) || !this.entryEvidenceVersions.has(symbol)) this.observeEntryEvidence(item);
    return { ...structuredClone(item), industryEvidenceVersion: this.entryEvidenceVersion(symbol) };
  }
  save(item) {
    const { industryEvidenceVersion, ...stored } = item; item = stored;
    this.observeEntryEvidence(item);
    this.cache.set(item.symbol, structuredClone(item)); let memoryBytes = 0;
    for (const [key, value] of [...this.cache].reverse()) { memoryBytes += Buffer.byteLength(JSON.stringify(value)); if (memoryBytes > 64 * 1024 * 1024) this.cache.delete(key); }
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value);
    if (!this.directory) return;
    const body = JSON.stringify(item); if (Buffer.byteLength(body) > 36 * 1024 * 1024) return;
    const file = this.cachePath(item.symbol), temporary = `${file}.${randomUUID()}.tmp`;
    try { if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('行业缓存文件类型无效'); fs.writeFileSync(temporary, body, { flag: 'wx' }); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    let bytes = 0; const files = fs.readdirSync(this.directory).filter(name => /^(?:sh|sz)\d{6}\.json$/.test(name)).map(name => { const file = path.join(this.directory, name); return { file, stat: fs.lstatSync(file) }; }).filter(row => row.stat.isFile() && !row.stat.isSymbolicLink()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (let i = 0; i < files.length; i++) { bytes += files[i].stat.size; if (i >= 128 || bytes > 256 * 1024 * 1024) fs.unlinkSync(files[i].file); }
  }
  async enrich(bundle, options = {}) {
    if (!bundle?.documents?.some(document => document.complete && ['annual-report', 'semiannual-report'].includes(document.kind))) return bundle;
    const symbol = symbolOf(bundle.symbol), terms = discoveryTerms(bundle), fingerprint = hash(JSON.stringify(terms));
    const run = async () => {
      active(options.signal); const existing = this.cached(symbol, fingerprint);
      if (existing && !(existing.industryCoverage.status !== 'ready' && (options.force || options.retryFailed))) return { ...bundle, industryDocuments: existing.industryDocuments,
        industryCoverage: existing.industryCoverage, industryEvidenceVersion: existing.industryEvidenceVersion };
      const started = this.clock(), issues = [], documents = [], seen = new Set(), today = cnTime(new Date(started)).date; let failed = false;
      const deadline = AbortSignal.timeout(60000), signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      try {
        for (const term of terms) {
          const url = new URL('https://www.frostchina.com/api/content/webPage'); url.search = new URLSearchParams({ page: '1', pageSize: '5', 'query[fuzzyQuery]': term }).toString();
          const payload = JSON.parse((await this.request(url.href, { signal })).toString('utf8'));
          if (payload.errCode !== 0 || !Array.isArray(payload.data?.data)) throw Error('行业官方目录结构无法核验');
          for (const row of payload.data.data) {
            if (seen.has(row._id) || !/^[a-f0-9]{24}$/.test(row._id || '') || row.isDeleted || row.status !== 1 || !['insight', 'news', 'industry'].includes(row.category) || row.publishDate?.slice(0, 10) > today) continue;
            seen.add(row._id); if (documents.length >= this.maxDocuments) break;
            const rawSource = JSON.stringify(row), sourceUrl = `https://www.frostchina.com/content/${row.category}/detail/${row._id}`;
            const base = { id: `frost-${row._id}`, issuerSymbol: symbol, kind: 'industry-report', title: row.title, publishedAt: row.publishDate?.slice(0, 10),
              fetchedAt: started, source: '弗若斯特沙利文公开原文', sourceUrl, sourceHash: hash(rawSource), rawSource, url: sourceUrl };
            const attachment = row.attachment ? new URL(row.attachment, 'https://img.frostchina.com/').href : (row.content || '').match(/https:\/\/img\.frostchina\.com\/[^\s"'<>]+\.pdf(?:\?[^\s"'<>]*)?/)?.[0];
            if (attachment && trustedIndustryUrl(attachment) && new URL(attachment).pathname.endsWith('.pdf')) {
              const bytes = await this.request(attachment, { signal, maxBytes: 8 * 1024 * 1024 });
              if (bytes.subarray(0, 5).toString() !== '%PDF-') { issues.push(`${row.title}：公开附件不是有效 PDF`); continue; }
              const parsed = await this.parser.parse(bytes, { format: 'pdf', signal, maxBytes: 8 * 1024 * 1024, maxPages: 200, maxChars: 600000, parseTimeoutMs: 30000 });
              if (parsed.parserVersion !== PARSER_VERSION || !parsed.complete || parsed.pageTexts?.some(page => page.numericEligible !== true)) { issues.push(`${row.title}：PDF 解析版本不匹配或尚有未可靠核验页面`); continue; }
              documents.push({ ...base, ...parsed, url: attachment, rawSource: undefined, sourceHash: hash(bytes), textHash: hash(parsed.text), originalBase64: bytes.toString('base64') });
            } else if (row.pageCount > 0 || /下载(?:报告|白皮书)|完整版|报告摘要|报告简介/.test(row.content || '') || /<(?:img|iframe|object|video|table)\b/i.test(row.content || '')) {
              issues.push(`${row.title}：目录仅提供介绍、图表或需授权的报告，尚未取得可完整核验的公开原文`);
            } else if (typeof row.content === 'string' && row.content.trim()) {
              const publishedPage = (await this.request(sourceUrl, { signal })).toString('utf8');
              // Confirm the directory's content is the publisher's visible
              // original body, not its search abstract or an escaped snippet.
              if (!publisherBodyMatches(publishedPage, row.content)) { issues.push(`${row.title}：目录正文与官方详情原文未能对应`); continue; }
              const text = textFromHtml(row.content);
              if (text) documents.push({ ...base, publisherPageHash: hash(publishedPage), text, textHash: hash(text), complete: true, format: 'publisher-html', pages: 1,
                pageTexts: [{ page: 1, text, method: 'provider-text', complete: true, numericEligible: true }] });
            }
          }
        }
      } catch (error) { active(options.signal); failed = true; this.cooldownUntil = Math.max(this.cooldownUntil, this.clock() + 60000); issues.push(deadline.aborted ? '行业原文单公司读取达到60秒上限，待后续更新重试' : error.message); }
      active(options.signal);
      if (!documents.length && !issues.length) issues.push('已支持的官方源未找到可公开获取且匹配的完整行业原文；不能据此认定公司不具备行业地位');
      const industryCoverage = { source: '弗若斯特沙利文公开目录及原文', status: failed ? 'error' : issues.length ? 'partial' : 'ready', terms, fetchedAt: started, issues,
        scope: '每家公司最多2个关键词、每词首页5项、3份公开原文；尚未覆盖全部行业协会和研究机构，搜索结果本身不作证据' };
      const item = { version: 1, symbol, fingerprint, fetchedAt: started, industryDocuments: documents, industryCoverage };
      try { this.save(item); } catch (error) {
        this.observeEntryEvidence(item);
        industryCoverage.issues.push(`本次原文已取得，行业缓存保存失败：${error.message}`);
      }
      return { ...bundle, industryDocuments: documents, industryCoverage, industryEvidenceVersion: this.entryEvidenceVersion(symbol) };
    };
    const operation = this.queue.then(run); this.queue = operation.catch(() => {}); return operation;
  }
  readArchivedArtifact(document) {
    if (document?.kind !== 'industry-report' || !document.originalBase64) return null;
    const bytes = Buffer.from(document.originalBase64, 'base64');
    if (hash(bytes) !== document.sourceHash || bytes.subarray(0, 5).toString() !== '%PDF-') throw Error('行业原件哈希或格式无效');
    return { bytes, sha256: hash(bytes), format: 'pdf' };
  }
  async destroy() { await this.queue; if (this.ownParser) await this.parser.destroy(); }
}
module.exports = { CompanyIndustrySource, textFromHtml, discoveryTerms, publisherBodyMatches };
