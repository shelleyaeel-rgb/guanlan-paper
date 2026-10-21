const { symbolOf, cnTime } = require('./common.cjs');

const SOURCE = '东方财富沪深 A 股在市名单';
const PAGE_SIZE = 100, MAX_AGE_MS = 30 * 60000, FAILURE_COOLDOWN_MS = 60000;
// The public quote centre's hs_a_board filter excludes retired securities with
// f:!2. Filtering by quote price would incorrectly discard suspended stocks.
// Verified against https://quote.eastmoney.com/center/static/build/index.js.
const MARKET_FILTER = 'm:0 t:6 f:!2,m:0 t:80 f:!2,m:1 t:2 f:!2,m:1 t:23 f:!2';
const invalid = message => Object.assign(Error(`东方财富股票名单无效：${message}；未使用不完整股票池`), { code: 'invalid' });

function pageUrl(page) {
  const params = new URLSearchParams({ pn: String(page), pz: String(PAGE_SIZE), po: '0', np: '1', fltt: '2', invt: '2',
    fid: 'f12', fs: MARKET_FILTER, fields: 'f12,f13,f14,f26' });
  return `https://push2.eastmoney.com/api/qt/clist/get?${params}`;
}
function listingDate(value) {
  if (value === '-' || value === null) return null;
  if (!/^\d{8}$/.test(String(value))) throw invalid('上市日期缺失或无效');
  const raw = String(value), date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw invalid('上市日期无效');
  return date;
}
function parsePage(json, page) {
  const data = json?.data;
  if (json?.rc !== 0 || !Number.isSafeInteger(data?.total) || data.total < 1 || data.total > 15000 || !Array.isArray(data.diff)) throw invalid('列表格式或总数异常');
  const expected = Math.min(PAGE_SIZE, data.total - (page - 1) * PAGE_SIZE);
  if (expected <= 0 || data.diff.length !== expected) throw invalid(`第 ${page} 页不完整`);
  const rows = data.diff.map(row => {
    if (!row || typeof row.f12 !== 'string' || !/^\d{6}$/.test(row.f12) || ![0, 1].includes(row.f13)
      || typeof row.f14 !== 'string' || !row.f14.trim() || row.f14.trim() === '-') throw invalid('证券身份或名称缺失');
    const exchange = row.f13 === 1 ? 'sh' : 'sz', code = row.f12;
    if (exchange === 'sh' ? !/^6\d{5}$/.test(code) : !/^[03]\d{5}$/.test(code)) throw invalid('证券市场与代码不一致');
    return { symbol: exchange + code, name: row.f14.trim(), listedAt: listingDate(row.f26) };
  });
  for (let i = 1; i < rows.length; i++) if (rows[i].symbol.slice(2) <= rows[i - 1].symbol.slice(2)) throw invalid('列表排序改变或证券重复');
  return { total: data.total, rows, fingerprint: rows.map(row => `${row.symbol}:${row.listedAt}`).join(',') };
}
function copyUniverse(value) {
  return { ...value, symbols: [...value.symbols], pendingListings: (value.pendingListings || []).map(row => ({ ...row })),
    pendingEvidence: (value.pendingEvidence || []).map(row => ({ ...row })) };
}

function ipoUrl(symbol) { return `https://data.eastmoney.com/xg/xg/detail/${symbol.slice(2)}.html`; }
function confirmPendingListing(html, row, now) {
  if (typeof html !== 'string') throw invalid(`${row.symbol} 上市状态补证不是有效网页`);
  const stamp = html.match(/<!--\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) at server\[\d+\]\s*-->/);
  const object = html.match(/\bvar\s+info\s*=\s*(\{[^\r\n]*\});/);
  let info;
  try { info = object ? JSON.parse(object[1]) : null; } catch { throw invalid(`${row.symbol} 上市状态补证格式无效`); }
  const at = stamp ? Date.parse(`${stamp[1]}T${stamp[2]}+08:00`) : NaN;
  if (!info || !Number.isFinite(at) || cnTime(at).date !== cnTime(now).date || at > now + 60000 || now - at >= MAX_AGE_MS) throw invalid(`${row.symbol} 缺少当日有效上市状态补证`);
  const sh = row.symbol.startsWith('sh');
  const markets = sh ? ['069001001001', '069001001003', '069001001006'] : ['069001002001', '069001002002', '069001002003', '069001002005'];
  if (info.SECURITY_CODE !== row.symbol.slice(2) || !markets.includes(info.TRADE_MARKET_CODE) || typeof info.TRADE_MARKET !== 'string'
    || !info.TRADE_MARKET.includes(sh ? '上海' : '深圳') || info.SECURITY_NAME?.replace(/\s/g, '') !== row.name.replace(/\s/g, '')) throw invalid(`${row.symbol} 上市状态补证证券身份不一致`);
  const parseDate = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?: 00:00:00)?$/.test(value)) throw invalid(`${row.symbol} 上市状态补证日期无效`);
    return listingDate(value.slice(0, 10).replace(/-/g, ''));
  };
  const applyDate = parseDate(info.APPLY_DATE), listedAt = info.LISTING_DATE === null ? null : parseDate(info.LISTING_DATE);
  if (info.CONTINUOUS_1WORD_NUM !== '待上市' || listedAt && listedAt <= cnTime(now).date) throw invalid(`${row.symbol} 未证实尚未上市，不能排除`);
  if (listedAt && listedAt < applyDate) throw invalid(`${row.symbol} 上市与申购日期矛盾`);
  return { symbol: row.symbol, state: 'pending-listing', source: '东方财富新股发行公开详情', sourceUrl: ipoUrl(row.symbol),
    sourceAt: at, checkedAt: now, applyDate, listedAt };
}

class EastmoneyStockUniverseSource {
  // request is FreeScreenerSource.request: the shared host queue handles spacing,
  // request timeout, bounded retry and Retry-After for this independent provider.
  constructor(request, { clock = Date.now, maxAgeMs = MAX_AGE_MS, failureCooldownMs = FAILURE_COOLDOWN_MS } = {}) {
    this.request = request; this.clock = clock; this.maxAgeMs = maxAgeMs; this.failureCooldownMs = failureCooldownMs;
    this.cache = null; this.retryAt = 0; this.lastError = '';
  }
  async page(number, signal) {
    let result;
    const json = await this.request(pageUrl(number), signal, false, value => { result = parsePage(value, number); });
    signal.throwIfAborted();
    return result || parsePage(json, number);
  }
  usable(value, now = this.clock()) {
    return value && Number.isFinite(value.validatedAt) && now >= value.validatedAt && now - value.validatedAt < this.maxAgeMs && value.date === cnTime(now).date;
  }
  failed(error, signal) {
    if (!signal.aborted) {
      this.cache = null; this.retryAt = this.clock() + this.failureCooldownMs; this.lastError = error.message;
    }
    throw error;
  }
  checkCooldown(signal) {
    signal.throwIfAborted();
    if (this.clock() < this.retryAt) {
      const time = cnTime(this.retryAt);
      throw Object.assign(Error(`东方财富股票名单暂缓重试，允许再次尝试时间：${time.date} ${time.time}（北京时间）；${this.lastError}`), { code: 'universe-cooldown', retryAt: this.retryAt });
    }
  }
  async validate(universe, { signal = new AbortController().signal } = {}) {
    this.checkCooldown(signal);
    try {
      if (!this.usable(universe) || universe.source !== SOURCE || typeof universe.firstFingerprint !== 'string' || typeof universe.lastFingerprint !== 'string') throw invalid('名单已过期或来源不一致');
      const pages = Math.ceil(universe.sourceCount / PAGE_SIZE);
      const first = await this.page(1, signal);
      const last = pages > 1 ? await this.page(pages, signal) : first;
      if (first.total !== universe.sourceCount || last.total !== universe.sourceCount || first.fingerprint !== universe.firstFingerprint || last.fingerprint !== universe.lastFingerprint) throw invalid('股票池在获取期间发生变化');
      const pendingEvidence = [];
      for (const row of universe.pendingListings || []) {
        const html = await this.request(ipoUrl(row.symbol), signal, 'utf8');
        signal.throwIfAborted(); pendingEvidence.push(confirmPendingListing(html, row, this.clock()));
      }
      if (!this.usable(universe)) throw invalid('名单在获取期间跨日或过期');
      universe.pendingEvidence = pendingEvidence;
      return true;
    } catch (error) { return this.failed(error, signal); }
  }
  async load({ signal = new AbortController().signal, onProgress = () => {} } = {}) {
    this.checkCooldown(signal);
    try {
      if (this.usable(this.cache)) {
        await this.validate(this.cache, { signal });
        onProgress({ loading: true, stage: 'universe', completed: this.cache.symbols.length, total: this.cache.symbols.length, cached: true, validatedAt: this.cache.validatedAt, source: SOURCE });
        return copyUniverse(this.cache);
      }
      this.cache = null;
      const date = cnTime(this.clock()).date, first = await this.page(1, signal), pages = Math.ceil(first.total / PAGE_SIZE), results = [first];
      let next = 2, completed = 1, failure;
      const controller = new AbortController(), pageSignal = AbortSignal.any([signal, controller.signal]);
      onProgress({ loading: true, stage: 'universe', completed, total: pages, source: SOURCE });
      await Promise.all(Array.from({ length: Math.min(3, pages - 1) }, async () => {
        while (next <= pages && !pageSignal.aborted) {
          const number = next++;
          try {
            const page = await this.page(number, pageSignal);
            if (page.total !== first.total) throw invalid('股票池总数在分页期间变化');
            results[number - 1] = page;
            onProgress({ loading: true, stage: 'universe', completed: ++completed, total: pages, source: SOURCE });
          } catch (error) { failure ||= error; controller.abort(); }
        }
      }));
      if (failure) throw failure;
      signal.throwIfAborted();
      const raw = results.flatMap(page => page.rows), seen = new Set(), symbols = [], pendingListings = [];
      let prior = '', excludedCount = 0;
      for (const row of raw) {
        const code = row.symbol.slice(2);
        if (seen.has(row.symbol) || code <= prior) throw invalid('分页重复或排序改变');
        seen.add(row.symbol); prior = code;
        let supported = false;
        try { supported = symbolOf(row.symbol) === row.symbol; } catch {}
        if (!supported || row.listedAt > date) excludedCount++;
        else if (row.listedAt === null) { excludedCount++; pendingListings.push(row); }
        else symbols.push(row.symbol);
      }
      // A broad field outage must fail promptly rather than fan out into
      // thousands of IPO-detail requests to the independent provider.
      if (pendingListings.length > 20) throw invalid('过多证券缺少上市日期，未尝试逐只补证');
      if (raw.length !== first.total || seen.size !== first.total || !symbols.length) throw invalid('完整性校验未通过');
      if (cnTime(this.clock()).date !== date) throw invalid('名单获取跨越北京时间日期');
      const candidate = { symbols: symbols.sort(), source: SOURCE, sourceCount: first.total, excludedCount, pendingListings, validatedAt: this.clock(), date,
        firstFingerprint: first.fingerprint, lastFingerprint: results.at(-1).fingerprint };
      await this.validate(candidate, { signal });
      signal.throwIfAborted();
      this.cache = candidate; this.retryAt = 0; this.lastError = '';
      return copyUniverse(candidate);
    } catch (error) { return this.failed(error, signal); }
  }
}
module.exports = { EastmoneyStockUniverseSource, EASTMONEY_UNIVERSE_SOURCE: SOURCE, pageUrl, parsePage, confirmPendingListing };
