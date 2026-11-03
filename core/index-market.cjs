'use strict';

// These instruments are a display-only catalogue. Do not pass their provider
// identifiers through the stock-symbol normalizer, account or strategy market.
const INDEX_CATALOG = Object.freeze([
  ['cn-shanghai', '上证指数', 'cn', '中国内地', 'Asia/Shanghai', '1.000001', 'sh000001'],
  ['cn-shenzhen', '深证成指', 'cn', '中国内地', 'Asia/Shanghai', '0.399001', 'sz399001'],
  ['cn-chinext', '创业板指', 'cn', '中国内地', 'Asia/Shanghai', '0.399006', 'sz399006'],
  ['cn-csi300', '沪深300', 'cn', '中国内地', 'Asia/Shanghai', '1.000300', 'sh000300'],
  ['cn-sse50', '上证50', 'cn', '中国内地', 'Asia/Shanghai', '1.000016', 'sh000016'],
  ['cn-star50', '科创50', 'cn', '中国内地', 'Asia/Shanghai', '1.000688', 'sh000688'],
  ['cn-csi500', '中证500', 'cn', '中国内地', 'Asia/Shanghai', '1.000905', 'sh000905'],
  ['cn-csi1000', '中证1000', 'cn', '中国内地', 'Asia/Shanghai', '1.000852', 'sh000852'],
  ['hk-hsi', '恒生指数', 'hk', '中国香港', 'Asia/Hong_Kong', '100.HSI', 'hkHSI'],
  ['hk-hstech', '恒生科技指数', 'hk', '中国香港', 'Asia/Hong_Kong', '124.HSTECH', 'hkHSTECH'],
  ['us-sp500', '标普500', 'us', '美国', 'America/New_York', '100.SPX', 'usINX', '.INX'],
  ['us-nasdaq', '纳斯达克综合', 'us', '美国', 'America/New_York', '100.NDX', 'usIXIC', '.IXIC'],
  ['us-dow', '道琼斯工业平均', 'us', '美国', 'America/New_York', '100.DJIA', 'usDJI', '.DJI'],
  ['us-nasdaq100', '纳斯达克100', 'us', '美国', 'America/New_York', '100.NDX100'],
  ['asia-nikkei225', '日经225', 'asia', '日本', 'Asia/Tokyo', '100.N225'],
  ['asia-kospi', '韩国KOSPI', 'asia', '韩国', 'Asia/Seoul', '100.KS11'],
  ['asia-asx200', '澳大利亚标普200', 'asia', '澳大利亚', 'Australia/Sydney', '100.AS51'],
  ['asia-taiwan', '台湾加权', 'asia', '中国台湾', 'Asia/Taipei', '100.TWII'],
  ['eu-dax', '德国DAX', 'europe', '德国', 'Europe/Berlin', '100.GDAXI'],
  ['eu-cac40', '法国CAC40', 'europe', '法国', 'Europe/Paris', '100.FCHI'],
  ['eu-ftse100', '英国富时100', 'europe', '英国', 'Europe/London', '100.FTSE'],
  ['eu-stoxx50', '欧洲斯托克50', 'europe', '欧元区', 'Europe/Berlin', '100.SX5E'],
].map(([id, name, group, region, timeZone, eastmoney, tencent = null, tencentCode = null]) => Object.freeze({
  id, name, group, region, timeZone, code: eastmoney.split('.')[1], eastmoney, tencent,
  tencentCode: tencentCode || tencent?.slice(2) || null, instrumentType: 'index', canTrade: false,
})));

const SOURCES = { eastmoney: '东方财富', tencent: '腾讯财经' };
const numeric = value => ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const positive = value => numeric(value) > 0 ? numeric(value) : null;
const invalid = message => Object.assign(Error(message), { code: 'invalid-index' });
const formatters = new Map();
function localTime(timestamp, timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }));
  const p = Object.fromEntries(formatters.get(timeZone).formatToParts(timestamp).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// Tencent's US timestamp is New York local time; mainland/HK use UTC+8.
// Resolve using IANA time zones, including US daylight saving. Ambiguous or
// nonexistent wall times are rejected instead of guessing an offset.
function zonedTimestamp(value, timeZone) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) return null;
  const wall = Date.parse(value.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19).replace('T', ' ') !== value) return null;
  const offsets = new Set([-86400000, 0, 86400000].map(delta => {
    const probe = wall + delta;
    return Date.parse(localTime(probe, timeZone).replace(' ', 'T') + 'Z') - probe;
  }));
  const matches = [...offsets].map(offset => wall - offset).filter(at => localTime(at, timeZone) === value);
  return matches.length === 1 ? matches[0] : null;
}

function makeQuote(spec, values, now, provider) {
  if (!(positive(values.price) > 0)) throw invalid('指数点位缺失或无效');
  if (!Number.isFinite(values.quoteAt) || values.quoteAt < Date.UTC(1990, 0, 1) || values.quoteAt > now + 15000) throw invalid('指数报价时间缺失、无效或晚于当前时间');
  const prevClose = positive(values.prevClose), price = positive(values.price);
  // Missing fields remain null. A zero is a real unchanged quote only when the
  // provider supplied it, or a valid previous close permits the calculation.
  const change = numeric(values.change) ?? (prevClose ? price - prevClose : null);
  const changePct = numeric(values.changePct) ?? (prevClose ? (price / prevClose - 1) * 100 : null);
  if (changePct !== null && changePct <= -100) throw invalid('指数涨跌幅无效');
  return { ...spec, price, prevClose, change, changePct, open: positive(values.open), high: positive(values.high), low: positive(values.low),
    quoteAt: values.quoteAt, quoteTime: localTime(values.quoteAt, spec.timeZone), fetchedAt: now,
    source: SOURCES[provider], provider, status: 'ok', error: null };
}

function parseEastmoneyIndices(json, catalog = INDEX_CATALOG, now = Date.now()) {
  const diff = json?.data?.diff;
  if (json?.rc !== 0 || !diff || typeof diff !== 'object') throw invalid('东方财富未返回指数列表');
  const byCode = new Map(catalog.map(spec => [spec.eastmoney, spec])), items = new Map(), errors = new Map(), seen = new Set();
  for (const row of Object.values(diff)) {
    const key = `${row?.f13}.${row?.f12}`, spec = byCode.get(key);
    if (!spec) continue;
    if (seen.has(key)) { items.delete(spec.id); errors.set(spec.id, '东方财富返回重复指数代码'); continue; }
    seen.add(key);
    try {
      const seconds = numeric(row.f124);
      if (!Number.isSafeInteger(seconds)) throw invalid('指数报价时间缺失或无效');
      items.set(spec.id, makeQuote(spec, { price: row.f2, change: row.f4, changePct: row.f3,
        open: row.f17, high: row.f15, low: row.f16, prevClose: row.f18, quoteAt: seconds * 1000 }, now, 'eastmoney'));
    } catch (error) { errors.set(spec.id, error.message); }
  }
  for (const spec of catalog) if (!items.has(spec.id) && !errors.has(spec.id)) errors.set(spec.id, '东方财富未返回该指数');
  return { items, errors };
}

function parseTencentIndices(text, catalog = INDEX_CATALOG, now = Date.now()) {
  if (typeof text !== 'string') throw invalid('腾讯指数响应格式无效');
  const requested = catalog.filter(spec => spec.tencent), bySymbol = new Map(requested.map(spec => [spec.tencent, spec])), items = new Map(), errors = new Map(), seen = new Set();
  for (const match of text.matchAll(/\bv_([A-Za-z0-9]+)\s*=\s*"([^"\r\n]*)"/g)) {
    const spec = bySymbol.get(match[1]);
    if (!spec) continue;
    if (seen.has(spec.id)) { items.delete(spec.id); errors.set(spec.id, '腾讯返回重复指数代码'); continue; }
    seen.add(spec.id);
    try {
      const fields = match[2].split('~');
      if (fields.length < 35 || fields[2] !== spec.tencentCode) throw invalid('腾讯指数代码不符或字段缺失');
      let rawTime = fields[30];
      if (/^\d{14}$/.test(rawTime)) rawTime = `${rawTime.slice(0, 4)}-${rawTime.slice(4, 6)}-${rawTime.slice(6, 8)} ${rawTime.slice(8, 10)}:${rawTime.slice(10, 12)}:${rawTime.slice(12, 14)}`;
      else rawTime = rawTime.replaceAll('/', '-');
      const quoteAt = zonedTimestamp(rawTime, spec.timeZone);
      items.set(spec.id, makeQuote(spec, { price: fields[3], prevClose: fields[4], open: fields[5], change: fields[31], changePct: fields[32], high: fields[33], low: fields[34], quoteAt }, now, 'tencent'));
    } catch (error) { errors.set(spec.id, error.message); }
  }
  for (const spec of requested) if (!items.has(spec.id) && !errors.has(spec.id)) errors.set(spec.id, '腾讯未返回该指数');
  return { items, errors };
}

class IndexMarket {
  constructor(fetcher = fetch, { clock = Date.now, requestTimeoutMs = 4500, cacheMs = 30000 } = {}) {
    this.fetcher = fetcher; this.clock = clock; this.requestTimeoutMs = requestTimeoutMs; this.cacheMs = cacheMs;
    this.snapshot = null; this.pending = null; this.lastGood = new Map();
  }
  async request(url, provider) {
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(this.requestTimeoutMs), cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: provider === 'eastmoney' ? 'https://quote.eastmoney.com/' : 'https://gu.qq.com/' } });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      throw Error(`HTTP ${response.status}`);
    }
    return provider === 'tencent' ? new TextDecoder('gb18030').decode(await response.arrayBuffer()) : response.json();
  }
  overview({ force = false } = {}) {
    if (this.pending) return this.pending.then(value => structuredClone(value));
    if (!force && this.snapshot && this.clock() - this.snapshot.attemptedAt < this.cacheMs) return Promise.resolve(structuredClone(this.snapshot));
    this.pending = this.load().then(value => { this.snapshot = value; return value; }).finally(() => { this.pending = null; });
    return this.pending.then(value => structuredClone(value));
  }
  async load() {
    const attemptedAt = this.clock(), items = new Map(), errors = new Map();
    const params = new URLSearchParams({ secids: INDEX_CATALOG.map(spec => spec.eastmoney).join(','),
      fields: 'f2,f3,f4,f12,f13,f14,f15,f16,f17,f18,f124', fltt: '2' });
    try {
      const parsed = parseEastmoneyIndices(await this.request(`https://push2.eastmoney.com/api/qt/ulist.np/get?${params}`, 'eastmoney'), INDEX_CATALOG, this.clock());
      for (const [id, item] of parsed.items) items.set(id, item);
      for (const [id, error] of parsed.errors) errors.set(id, `东方财富：${error}`);
    } catch (error) { for (const spec of INDEX_CATALOG) errors.set(spec.id, `东方财富：${error.message}`); }
    const fallback = INDEX_CATALOG.filter(spec => !items.has(spec.id) && spec.tencent);
    if (fallback.length) {
      try {
        const parsed = parseTencentIndices(await this.request(`https://qt.gtimg.cn/q=${fallback.map(spec => spec.tencent).join(',')}`, 'tencent'), fallback, this.clock());
        for (const [id, item] of parsed.items) items.set(id, item);
        for (const [id, error] of parsed.errors) errors.set(id, `${errors.get(id)}；腾讯：${error}`);
      } catch (error) { for (const spec of fallback) errors.set(spec.id, `${errors.get(spec.id)}；腾讯：${error.message}`); }
    }
    const completedAt = this.clock();
    const output = INDEX_CATALOG.map(spec => {
      const item = items.get(spec.id);
      if (item) {
        const previous = this.lastGood.get(spec.id);
        // A slower fallback must not make a previously shown quote move back in
        // time. Keep the old snapshot and explicitly expose the failed refresh.
        if (previous && item.quoteAt < previous.quoteAt) return { ...previous, status: 'stale', error: '数据源返回的报价早于上次报价，保留上次数据', attemptedAt: completedAt };
        this.lastGood.set(spec.id, item);
        return { ...item, attemptedAt: completedAt };
      }
      const error = errors.get(spec.id) || '指数行情暂不可用', previous = this.lastGood.get(spec.id);
      if (previous) return { ...previous, status: 'stale', error, attemptedAt: completedAt };
      return { ...spec, price: null, change: null, changePct: null, prevClose: null, open: null, high: null, low: null,
        quoteAt: null, quoteTime: null, fetchedAt: null, source: null, provider: null, status: 'unavailable', error, attemptedAt: completedAt };
    });
    // Snapshot acquisition completion is not a quote timestamp. Each item keeps
    // its own provider quote time and last successful acquisition time.
    return { items: output, fetchedAt: completedAt, attemptedAt };
  }
}

module.exports = { IndexMarket, INDEX_CATALOG, parseEastmoneyIndices, parseTencentIndices, zonedTimestamp };
