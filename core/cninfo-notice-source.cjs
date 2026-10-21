'use strict';
const { symbolOf, cnTime } = require('./common.cjs');
const { CompanyEvidenceTransport } = require('./company-evidence-transport.cjs');

const SOURCE = '巨潮资讯', DOCUMENT_SOURCE = '巨潮资讯公告原文';
const isCninfoId = id => typeof id === 'string' && /^CN\d{10,30}$/.test(id);
const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(date)) && new Date(Date.parse(date)).toISOString().slice(0, 10) === date;
function cninfoAttachment(value, id, date) {
  if (!isCninfoId(id)) return null;
  try {
    const url = new URL(value), match = /^\/finalpage\/(\d{4}-\d{2}-\d{2})\/(\d{10,30})\.pdf$/i.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'static.cninfo.com.cn' || url.port || url.username || url.password
      || url.search || url.hash || !match || !validDate(match[1]) || match[2] !== id.slice(2) || date && date !== match[1]) return null;
    return { url: url.href, format: 'pdf', mimeType: 'application/pdf' };
  } catch { return null; }
}
function cninfoUrl(symbol, id) {
  symbol = symbolOf(symbol); if (!isCninfoId(id)) throw Error('巨潮公告编号无效');
  return `https://www.cninfo.com.cn/new/disclosure/detail?stockCode=${symbol.slice(2)}&announcementId=${id.slice(2)}`;
}
function wait(task, signal) {
  if (signal?.aborted) { task.catch(() => {}); signal.throwIfAborted(); } if (!signal) return task;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
class CninfoNoticeSource {
  constructor(fetcher = fetch, { clock = Date.now, pageSize = 30, maxPages = 40, cacheMs = 300000, deadlineMs = 60000, minIntervalMs = 300, transport = null, transportOptions = {} } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 30 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw Error('巨潮公告分页范围无效');
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120000 || !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 10000) throw Error('巨潮公告请求时间范围无效');
    Object.assign(this, { clock, pageSize, maxPages, cacheMs, deadlineMs, minIntervalMs });
    this.transport = transport || new CompanyEvidenceTransport(fetcher, { clock, timeoutMs: 8000, deadlineMs: 20000, maxAttempts: 2, ...transportOptions });
    this.identities = new Map(); this.cache = new Map(); this.pending = new Map(); this.tail = Promise.resolve(); this.nextAt = 0;
  }
  async request(path, params, signal) {
    // Public website form endpoints; retain Chromium's proxy/certificate path.
    // A single queue protects this shared source from simultaneous strategy scans.
    const task = this.tail.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const remaining = this.nextAt - Date.now(); if (remaining > 0) await wait(new Promise(resolve => setTimeout(resolve, remaining)), signal);
      signal?.throwIfAborted(); this.nextAt = Date.now() + this.minIntervalMs;
      return this.transport.json(`https://www.cninfo.com.cn${path}`, { stage: 'cninfo-index', signal }, {
        method: 'POST', body: new URLSearchParams(params).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Referer: 'https://www.cninfo.com.cn/' }
      });
    });
    this.tail = task.catch(() => {}); return wait(task, signal);
  }
  async identity(symbol, signal) {
    const previous = this.identities.get(symbol), now = this.clock();
    if (previous && now >= previous.at && now - previous.at < 86400000) return previous.value;
    const rows = await this.request('/new/information/topSearch/query', { keyWord: symbol.slice(2), maxNum: '10' }, signal);
    if (!Array.isArray(rows)) throw Error('巨潮证券身份查询格式异常');
    const matches = rows.filter(row => row?.code === symbol.slice(2) && row.category === 'A股' && row.delisted === 'false'
      && typeof row.orgId === 'string' && /^[A-Za-z0-9]{4,40}$/.test(row.orgId));
    if (matches.length !== 1) throw Error('巨潮证券身份缺失、退市或重复，不能替代公告核验');
    const value = { code: matches[0].code, orgId: matches[0].orgId };
    this.identities.set(symbol, { at: now, value }); if (this.identities.size > 2048) this.identities.delete(this.identities.keys().next().value);
    return value;
  }
  parsePage(json, symbol, identity, fromDate, toDate) {
    if (!json || !Number.isSafeInteger(json.totalAnnouncement) || json.totalAnnouncement <= 0 || !Array.isArray(json.announcements)
      || !json.announcements.length || json.announcements.length > this.pageSize || typeof json.hasMore !== 'boolean'
      || json.totalRecordNum != null && json.totalRecordNum !== json.totalAnnouncement) throw Error('巨潮公告为空或覆盖数量无法核实，不能据此认定无风险');
    const items = json.announcements.map(row => {
      const id = `CN${row?.announcementId}`, date = Number.isFinite(row?.announcementTime) ? cnTime(row.announcementTime).date : null;
      const title = typeof row?.announcementTitle === 'string' ? row.announcementTitle.trim() : '';
      const attachmentUrl = typeof row?.adjunctUrl === 'string' ? `https://static.cninfo.com.cn/${row.adjunctUrl}` : null;
      if (row?.secCode !== identity.code || row.orgId !== identity.orgId || !isCninfoId(id) || !validDate(date) || date < fromDate || date > toDate
        || !title || /<[^>]+>/.test(title) || row.adjunctType !== 'PDF' || !cninfoAttachment(attachmentUrl, id, date)
        || typeof row.pageColumn !== 'string' || !(symbol.startsWith('sh') ? /^SH/.test(row.pageColumn) : /^SZ/.test(row.pageColumn)))
        throw Error('巨潮公告的证券、机构、市场、日期或原始PDF身份无法核实');
      return { id, date, title, categories: [], source: SOURCE, issuerSymbol: symbol, orgId: identity.orgId,
        attachmentUrl, url: cninfoUrl(symbol, id) };
    });
    return { items, total: json.totalAnnouncement, hasMore: json.hasMore };
  }
  async getIndex(inputSymbol, fromDate, toDate, { signal, force = false, firstPageOnly = false, onProgress } = {}) {
    signal?.throwIfAborted(); const symbol = symbolOf(inputSymbol);
    if (!validDate(fromDate) || !validDate(toDate) || fromDate > toDate || toDate > cnTime(this.clock()).date) throw Error('巨潮公告查询期间无效');
    const key = `${symbol}:${fromDate}:${toDate}:${firstPageOnly}`, previous = this.cache.get(key), now = this.clock();
    if (!force && previous && now >= previous.fetchedAt && now - previous.fetchedAt < this.cacheMs) return structuredClone(previous);
    if (!this.pending.has(key)) {
      const controller = new AbortController(), taskSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.deadlineMs)]);
      const job = { controller, subscribers: 0, promise: null };
      const task = Promise.resolve().then(async () => {
        const identity = await this.identity(symbol, taskSignal), rows = [], ids = new Set(); let expected = null;
        for (let page = 1; page <= this.maxPages; page++) {
          const json = await this.request('/new/hisAnnouncement/query', { stock: `${identity.code},${identity.orgId}`, tabName: 'fulltext',
            pageSize: String(this.pageSize), pageNum: String(page), column: symbol.startsWith('sh') ? 'sse' : 'szse',
            category: '', plate: '', searchkey: '', secid: '', sortName: '', sortType: '', isHLtitle: 'false', seDate: `${fromDate}~${toDate}` }, taskSignal);
          const parsed = this.parsePage(json, symbol, identity, fromDate, toDate);
          if (expected !== null && parsed.total !== expected) throw Error('巨潮公告分页期间数量变化，覆盖不完整'); expected = parsed.total;
          for (const row of parsed.items) { if (ids.has(row.id)) throw Error('巨潮公告分页重复，覆盖不完整'); ids.add(row.id); rows.push(row); }
          if (rows.length > expected || parsed.hasMore !== (rows.length < expected) || parsed.hasMore && parsed.items.length !== this.pageSize)
            throw Error('巨潮公告分页数量与后续页声明不一致');
          if (rows.some((row, i) => i > 0 && row.date > rows[i - 1].date)) throw Error('巨潮公告日期排序无法核实');
          try { onProgress?.({ stage: 'index', symbol, source: SOURCE, completed: rows.length, total: expected }); } catch {}
          if (!parsed.hasMore || firstPageOnly) {
            const result = { source: SOURCE, symbol, items: rows, total: expected, fromDate, toDate, complete: !parsed.hasMore, fetchedAt: this.clock() };
            this.cache.set(key, result); if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value); return result;
          }
        }
        throw Error('巨潮公告超过分页上限，覆盖不完整');
      }).finally(() => { if (this.pending.get(key) === job) this.pending.delete(key); });
      job.promise = task; this.pending.set(key, job);
    }
    const job = this.pending.get(key); job.subscribers++;
    try { return structuredClone(await wait(job.promise, signal)); }
    finally {
      if (--job.subscribers === 0 && this.pending.get(key) === job) {
        this.pending.delete(key); job.controller.abort(Error('巨潮公告的所有调用方均已取消'));
      }
    }
  }
}
module.exports = { CninfoNoticeSource, SOURCE, DOCUMENT_SOURCE, isCninfoId, cninfoAttachment, cninfoUrl };
