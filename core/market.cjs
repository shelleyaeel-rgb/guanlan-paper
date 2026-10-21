const { cnTime, session, symbolOf } = require('./common.cjs');
const { SOURCES, INDEX_SYMBOLS, numeric, scaled, invalid, parseQuotes, parseSinaQuotes, validateBars, validateMinute, parseEastmoneyBars, parseEastmoneyIntraday } = require('./market-parsers.cjs');
const TENCENT_ENDPOINTS = ['https://proxy.finance.qq.com/ifzqgtimg', 'https://web.ifzq.gtimg.cn'];
const RETRYABLE_STATUS = new Set([429, 500, 501, 502, 503, 504]);
const QUOTE_BATCH_SIZE = 80, QUOTE_CONCURRENCY = 3;
class Market {
  constructor(fetcher = fetch, { clock = Date.now, requestTimeoutMs = 3500, cooldownMs = 30000 } = {}) {
    this.fetcher = fetcher; this.clock = clock; this.requestTimeoutMs = requestTimeoutMs; this.cooldownMs = cooldownMs;
    this.cache = new Map(); this.failures = new Map(); this.quoteActive = 0; this.quoteWaiters = [];
  }
  async request(url, gbk = false, signal = null) {
    const host = new URL(url).hostname;
    const referrer = host.endsWith('sinajs.cn') ? 'https://finance.sina.com.cn/' : host.endsWith('eastmoney.com') ? 'https://quote.eastmoney.com/' : 'https://gu.qq.com/';
    const timeout = AbortSignal.timeout(this.requestTimeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    combined.throwIfAborted();
    const response = await this.fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: referrer }, signal: combined, cache: 'no-store' });
    if (!response.ok) {
      const error = Object.assign(Error(`HTTP ${response.status}（${host}）`), { status: response.status });
      const retryAfter = response.headers?.get('retry-after');
      if (retryAfter) error.retryAfterMs = Math.max(0, /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - this.clock());
      try { await response.body?.cancel(); } catch {}
      throw error;
    }
    const data = gbk ? new TextDecoder('gb18030').decode(await response.arrayBuffer()) : await response.json();
    combined.throwIfAborted(); return data;
  }
  async attempt(key, load, signal, force = false) {
    signal?.throwIfAborted();
    const prior = this.failures.get(key);
    if (prior && prior.until > this.clock() && (!force || prior.retryAfterUntil > this.clock())) throw Object.assign(Error(`暂缓重试（${prior.message}）`), { code: 'cooldown' });
    try { const result = await load(); signal?.throwIfAborted(); this.failures.delete(key); return result; }
    catch (error) {
      signal?.throwIfAborted();
      // A missing/invalid series for one stock must not disable other stocks on the same service.
      if (error.code !== 'invalid') this.failures.set(key, { until: this.clock() + Math.max(this.cooldownMs, error.retryAfterMs || 0), retryAfterUntil: this.clock() + (error.retryAfterMs || 0), message: error.message });
      throw error;
    }
  }
  async route(label, candidates, signal = null, force = false) {
    const deadline = AbortSignal.timeout(12000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline, failures = [];
    let allInvalid = true;
    for (const candidate of candidates) {
      combined.throwIfAborted();
      try { return await this.attempt(candidate.key, () => candidate.load(combined), combined, force); }
      catch (error) {
        combined.throwIfAborted(); failures.push(`${candidate.name}：${error.message}`);
        if (error.code !== 'invalid') allInvalid = false;
        if (error.status && !RETRYABLE_STATUS.has(error.status)) break;
      }
    }
    const error = Error(`${label}获取失败：${failures.join('；')}`);
    if (allInvalid) error.code = 'invalid';
    throw error;
  }
  async quotes(symbols) {
    const requested = [...new Set(symbols.map(s => INDEX_SYMBOLS.has(s) ? s : symbolOf(s)))];
    if (!requested.length) return {};
    const data = {}, errors = []; let offset = 0;
    // Each caller queues at most three batches at a time. A large import cannot
    // put thousands of requests ahead of the next holding/risk quote refresh.
    await Promise.all(Array.from({ length: Math.min(QUOTE_CONCURRENCY, Math.ceil(requested.length / QUOTE_BATCH_SIZE)) }, async () => {
      while (offset < requested.length) {
        const batch = requested.slice(offset, offset += QUOTE_BATCH_SIZE);
        try { Object.assign(data, await this.quoteBatch(batch)); }
        catch (error) { errors.push(error.message); }
      }
    }));
    if (!Object.keys(data).length) throw Error(`报价获取失败：${[...new Set(errors)].join('；')}`);
    return data;
  }
  async quoteSlot(load) {
    if (this.quoteActive >= QUOTE_CONCURRENCY) await new Promise(resolve => this.quoteWaiters.push(resolve));
    else this.quoteActive++;
    try { return await load(); }
    finally { const next = this.quoteWaiters.shift(); if (next) next(); else this.quoteActive--; }
  }
  async quoteBatch(requested) {
    const data = {}, errors = [];
    const fresh = q => {
      const now = this.clock();
      return q && q.timestamp <= now + 15000 && (!session(new Date(now)).open || (q.date === cnTime(now).date && now - q.timestamp <= 90000));
    };
    for (const provider of ['tencent', 'sina']) {
      const needed = requested.filter(s => !fresh(data[s]));
      if (!needed.length) break;
      try {
        const batch = await this.quoteSlot(() => this.attempt(`quotes:${provider}`, async () => {
          const url = provider === 'tencent' ? `https://qt.gtimg.cn/q=${needed.join(',')}` : `https://hq.sinajs.cn/list=${needed.join(',')}`;
          const parsed = (provider === 'tencent' ? parseQuotes : parseSinaQuotes)(await this.request(url, true), this.clock());
          const accepted = Object.fromEntries(needed.filter(s => parsed[s] && parsed[s].timestamp <= this.clock() + 15000).map(s => [s, parsed[s]]));
          if (!Object.keys(accepted).length) throw invalid('未收到有效报价');
          return accepted;
        }));
        for (const symbol of needed) if (batch[symbol] && (!data[symbol] || batch[symbol].timestamp >= data[symbol].timestamp)) data[symbol] = batch[symbol];
      } catch (error) { errors.push(`${SOURCES[provider]}：${error.message}`); }
    }
    if (!Object.keys(data).length) throw Error(`报价获取失败：${errors.join('；')}`);
    return data;
  }
  async daily(symbol, adjustment, count, signal = null, force = false) {
    symbol = symbolOf(symbol);
    const qfq = adjustment === 'qfq', label = qfq ? '前复权日线' : '未复权日线';
    const entry = (bars, provider) => ({ bars, provider, source: SOURCES[provider], adjustment: qfq ? '前复权' : '未复权', fetchedAt: this.clock() });
    const candidates = TENCENT_ENDPOINTS.map((endpoint, i) => ({ key: `daily:${adjustment}:tencent:${i}`, name: `${SOURCES.tencent}${i ? '备用' : ''}`, load: async signal => {
      const json = await this.request(`${endpoint}/appstock/app/fqkline/get?param=${symbol},day,,,${count},${qfq ? 'qfq' : ''}`, false, signal);
      if (json?.code != null && json.code !== 0) throw invalid('腾讯日线返回错误');
      const raw = json?.data?.[symbol]?.[qfq ? 'qfqday' : 'day'];
      if (!Array.isArray(raw)) throw invalid(`未收到${label}`);
      return entry(validateBars(raw, this.clock()), 'tencent');
    } }));
    const params = new URLSearchParams({ secid: `${symbol.startsWith('sh') ? 1 : 0}.${symbol.slice(2)}`, klt: '101', fqt: qfq ? '1' : '0', beg: '0', end: '20500101', lmt: String(count + 1), ut: '7eea3edcaed734bea9cbfc24409ed989', fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' });
    candidates.push({ key: `daily:${adjustment}:eastmoney`, name: SOURCES.eastmoney, load: async signal => entry(parseEastmoneyBars(await this.request(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`, false, signal), symbol, this.clock()).slice(-(count + 1)), 'eastmoney') });
    return this.route(label, candidates, signal, force);
  }
  async history(symbol, force = false) {
    symbol = symbolOf(symbol);
    const hit = this.cache.get(symbol);
    if (!force && hit && this.clock() - hit.fetchedAt < 60000) return hit;
    const entry = await this.daily(symbol, 'qfq', 640, null, force);
    if (entry.bars.length < 30) throw Error('前复权日线不足，暂时无法分析');
    this.cache.set(symbol, entry); return entry;
  }
  async intraday(symbol) {
    symbol = symbolOf(symbol);
    const entry = (data, provider) => ({ ...data, source: SOURCES[provider], provider, fetchedAt: this.clock() });
    const candidates = TENCENT_ENDPOINTS.map((endpoint, i) => ({ key: `minute:tencent:${i}`, name: `${SOURCES.tencent}${i ? '备用' : ''}`, load: async signal => {
      const json = await this.request(`${endpoint}/appstock/app/minute/query?code=${symbol}`, false, signal), data = json?.data?.[symbol], raw = data?.data;
      if ((json?.code != null && json.code !== 0) || !Array.isArray(raw?.data) || raw.data.some(s => typeof s !== 'string')) throw invalid('分时数据暂不可用');
      const points = raw.data.map(s => { const a = s.split(' '); return { time: a[0], price: numeric(a[1]), volume: scaled(a[2], 100) }; }).filter(p => p.time <= '1500');
      return entry({ ...validateMinute(raw.date, points, this.clock()), prevClose: numeric(data.qt?.[symbol]?.[4]) }, 'tencent');
    } }));
    const params = new URLSearchParams({ secid: `${symbol.startsWith('sh') ? 1 : 0}.${symbol.slice(2)}`, ndays: '1', iscr: '0', fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58' });
    candidates.push({ key: 'minute:eastmoney', name: SOURCES.eastmoney, load: async signal => entry(parseEastmoneyIntraday(await this.request(`https://push2.eastmoney.com/api/qt/stock/trends2/get?${params}`, false, signal), symbol, this.clock()), 'eastmoney') });
    return this.route('分时', candidates);
  }
  async strategyHistory(symbol, signal = null, withMetadata = false, force = false) {
    const entry = await this.daily(symbol, 'raw', 120, signal, force);
    return withMetadata ? entry : entry.bars;
  }
  async indexHistory(symbol, signal = null, force = false) {
    signal?.throwIfAborted();
    if (!INDEX_SYMBOLS.has(symbol)) throw Error('市场环境仅支持上证指数、深证成指、创业板指');
    const key = `index-history:${symbol}`, cached = this.cache.get(key);
    if (!force && cached && this.clock() - cached.fetchedAt < 60000) return cached;
    const entry = (bars, provider) => ({ symbol, bars, provider, source: SOURCES[provider], adjustment: '未复权', fetchedAt: this.clock() });
    const candidates = TENCENT_ENDPOINTS.map((endpoint, index) => ({ key: `index-daily:tencent:${index}`, name: `${SOURCES.tencent}${index ? '备用' : ''}`, load: async signal => {
      const json = await this.request(`${endpoint}/appstock/app/fqkline/get?param=${symbol},day,,,120,`, false, signal);
      if (json?.code != null && json.code !== 0) throw invalid('腾讯指数日线返回错误');
      return entry(validateBars(json?.data?.[symbol]?.day, this.clock()), 'tencent');
    } }));
    const params = new URLSearchParams({ secid: `${symbol.startsWith('sh') ? 1 : 0}.${symbol.slice(2)}`, klt: '101', fqt: '0', beg: '0', end: '20500101', lmt: '121', ut: '7eea3edcaed734bea9cbfc24409ed989', fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' });
    candidates.push({ key: 'index-daily:eastmoney', name: SOURCES.eastmoney, load: async signal => entry(parseEastmoneyBars(await this.request(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`, false, signal), symbol, this.clock()).slice(-121), 'eastmoney') });
    const result = await this.route('指数未复权日线', candidates, signal, force);
    this.cache.set(key, result); return result;
  }
}
module.exports = { Market, QUOTE_BATCH_SIZE, QUOTE_CONCURRENCY, parseQuotes, parseSinaQuotes, parseEastmoneyBars, parseEastmoneyIntraday };
