const { symbolOf } = require('./common.cjs');

const SOURCE = '东方财富证券搜索';
const SOURCE_LIMIT = 30, RESULT_LIMIT = 20, MAX_BODY_BYTES = 128 * 1024;
const invalid = message => Object.assign(Error(`股票搜索响应无效：${message}`), { code: 'invalid' });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeQuery(input) {
  if (typeof input !== 'string') throw Error('请输入股票名称、代码或拼音首字母');
  const query = input.normalize('NFKC').trim();
  if (!query || query.length > 32 || !/^[\p{Script=Han}a-zA-Z0-9*· .-]+$/u.test(query)) throw Error('搜索词应为 1 至 32 个字符，仅支持名称、代码或拼音首字母');
  const normalized = query.toLowerCase(), prefixed = /^(sh|sz)(\d{1,6})$/.exec(normalized);
  if (prefixed && prefixed[2].length === 6) symbolOf(normalized);
  return { query, key: normalized, term: prefixed ? prefixed[2] : normalized, exchange: prefixed?.[1] || null };
}

function searchUrl(term) {
  const params = new URLSearchParams({ type: '14', count: String(SOURCE_LIMIT), input: term });
  return `https://searchapi.eastmoney.com/api/suggest/get?${params}`;
}

function parseSearch(json, exchange = null) {
  const table = json?.QuotationCodeTable;
  if (!plain(table) || table.Status !== 0 || !Number.isSafeInteger(table.TotalCount) || table.TotalCount < 0
    || table.TotalCount > 1000000 || !(Array.isArray(table.Data) || table.Data === null && table.TotalCount === 0)) throw invalid('列表状态或总数异常');
  const rows = table.Data || [];
  if (rows.length > SOURCE_LIMIT || rows.length > table.TotalCount || !rows.length && table.TotalCount > 0) throw invalid('候选数量异常');
  const found = new Map();
  for (const row of rows) {
    if (!plain(row) || typeof row.Classify !== 'string' || typeof row.Code !== 'string' || typeof row.MktNum !== 'string'
      || typeof row.SecurityType !== 'string') throw invalid('证券身份字段缺失');
    // The provider also returns indices, funds, bonds and overseas securities.
    // STAR shares use Classify=23 / SecurityType=25, not AStock.
    const market = row.Classify === 'AStock' && row.SecurityType === '1' && row.MktNum === '1' ? 'sh'
      : row.Classify === 'AStock' && row.SecurityType === '2' && row.MktNum === '0' ? 'sz'
      : row.Classify === '23' && row.SecurityType === '25' && row.MktNum === '1' ? 'sh' : null;
    if (!market) continue;
    if (!/^\d{6}$/.test(row.Code) || row.QuoteID !== `${row.MktNum}.${row.Code}`) throw invalid('证券市场或行情标识不一致');
    let symbol;
    // Valid source identities outside this app's supported stock codes (such
    // as 689 CDRs) must not discard other usable candidates in the same batch.
    try { symbol = symbolOf(row.Code); } catch { continue; }
    if (symbol !== market + row.Code) throw invalid('沪深 A 股代码与市场不一致');
    if ((row.Classify === '23') !== row.Code.startsWith('688')) throw invalid('证券板块与代码不一致');
    if (typeof row.Name !== 'string' || !row.Name.trim() || row.Name.length > 80 || /[\u0000-\u001f\u007f<>]/.test(row.Name)
      || typeof row.PinYin !== 'string' || row.PinYin.length > 80 || !/^[a-zA-Z0-9* .-]*$/.test(row.PinYin)) throw invalid('股票名称或拼音无效');
    if (exchange && market !== exchange) continue;
    const item = { symbol, code: row.Code, name: row.Name.trim(), pinyin: row.PinYin.toUpperCase() };
    const previous = found.get(symbol);
    if (previous && (previous.name !== item.name || previous.pinyin !== item.pinyin)) throw invalid('同一股票身份冲突');
    found.set(symbol, item);
  }
  return { items: [...found.values()].slice(0, RESULT_LIMIT), hasMore: table.TotalCount > rows.length || found.size > RESULT_LIMIT, sourceLimit: SOURCE_LIMIT };
}

function copyResult(value, query, cached) { return { ...value, query, cached, items: value.items.map(item => ({ ...item })) }; }

class StockSearch {
  constructor(fetcher = fetch, { clock = Date.now, requestTimeoutMs = 3500, maxAgeMs = 300000, maxCacheEntries = 100 } = {}) {
    this.fetcher = fetcher; this.clock = clock; this.requestTimeoutMs = requestTimeoutMs; this.maxAgeMs = maxAgeMs;
    this.maxCacheEntries = Math.max(1, Math.min(100, Math.floor(maxCacheEntries) || 100));
    this.cache = new Map(); this.inflight = new Map(); this.active = 0; this.waiting = null;
  }
  schedule(load) {
    return new Promise((resolve, reject) => {
      const job = { load, resolve, reject };
      if (this.active < 3) this.start(job);
      else {
        this.waiting?.reject(Object.assign(Error('搜索词已更新'), { code: 'search-superseded' }));
        this.waiting = job;
      }
    });
  }
  start(job) {
    this.active++;
    Promise.resolve().then(job.load).then(job.resolve, job.reject).finally(() => {
      this.active--;
      const next = this.waiting; this.waiting = null;
      if (next) this.start(next);
    });
  }
  async request(term) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(Error('股票搜索超时，请稍后重试'), { code: 'search-timeout' });
        controller.abort(error); reject(error);
      }, this.requestTimeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await this.fetcher(searchUrl(term), { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' }, signal: controller.signal, cache: 'no-store' });
        controller.signal.throwIfAborted();
        if (!response.ok) { try { await response.body?.cancel(); } catch {} throw Error(`股票搜索失败：HTTP ${response.status}`); }
        const declared = Number(response.headers?.get('content-length'));
        if (declared > MAX_BODY_BYTES) { try { await response.body?.cancel(); } catch {} throw invalid('响应过大'); }
        let text;
        if (response.body?.getReader) {
          const reader = response.body.getReader(), chunks = []; let size = 0;
          try {
            while (true) {
              const { value, done } = await reader.read(); if (done) break;
              controller.signal.throwIfAborted(); size += value.byteLength;
              if (size > MAX_BODY_BYTES) { try { await reader.cancel(); } catch {} throw invalid('响应过大'); }
              chunks.push(Buffer.from(value));
            }
            text = Buffer.concat(chunks).toString('utf8');
          } finally { reader.releaseLock(); }
        } else { text = await response.text(); if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw invalid('响应过大'); }
        controller.signal.throwIfAborted();
        try { return JSON.parse(text); } catch { throw invalid('不是有效 JSON'); }
      })()]);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error.code === 'invalid' || /^股票搜索/.test(error.message || '')) throw error;
      throw Error(`股票搜索连接失败：${error.message || '请稍后重试'}`);
    } finally { clearTimeout(timer); }
  }
  async search(input = {}) {
    const normalized = normalizeQuery(input?.query), now = this.clock();
    for (const [key, value] of this.cache) if (now < value.fetchedAt || now - value.fetchedAt >= this.maxAgeMs) this.cache.delete(key);
    const cached = this.cache.get(normalized.key);
    if (cached) {
      this.cache.delete(normalized.key); this.cache.set(normalized.key, cached);
      return copyResult(cached, normalized.query, true);
    }
    let pending = this.inflight.get(normalized.key);
    if (!pending) {
      pending = this.schedule(async () => {
        const parsed = parseSearch(await this.request(normalized.term), normalized.exchange);
        const result = { ...parsed, source: SOURCE, fetchedAt: this.clock() };
        this.cache.set(normalized.key, result);
        while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
        return result;
      }).finally(() => this.inflight.delete(normalized.key));
      this.inflight.set(normalized.key, pending);
    }
    return copyResult(await pending, normalized.query, false);
  }
}

module.exports = { StockSearch, STOCK_SEARCH_SOURCE: SOURCE, searchUrl, parseSearch, normalizeQuery };
