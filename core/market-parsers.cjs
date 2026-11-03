const { cnTime } = require('./common.cjs');
const { parseTencentScreenQuotes } = require('./screener-tencent.cjs');
const SOURCES = { tencent: '腾讯财经', sina: '新浪财经', eastmoney: '东方财富' };
const INDEX_SYMBOLS = new Set(['sh000001', 'sz399001', 'sz399006']);
const numeric = value => value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const scaled = (value, factor) => numeric(value) == null ? null : numeric(value) * factor;
const invalid = message => Object.assign(Error(message), { code: 'invalid' });
function validDate(date) { return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date; }
function timestamp(date, time) {
  if (!validDate(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) return null;
  return Date.parse(`${date}T${time}+08:00`);
}
function completeQuote(q) {
  if (INDEX_SYMBOLS.has(q.symbol)) q.tradeBlockedReason = '指数仅供展示';
  else if (!(q.open > 0) || !(q.volume > 0)) q.tradeBlockedReason = '停牌或无有效成交数据，仅供展示，暂停模拟成交';
  else if (!(q.limitUp > q.limitDown && q.limitDown > 0)) q.tradeBlockedReason = '缺少涨跌停价格，仅供展示，暂停模拟成交';
  else if (![q.bid, q.ask, q.bidSize, q.askSize].every(n => Number.isFinite(n) && n >= 0)) q.tradeBlockedReason = '盘口字段不完整，仅供展示，暂停模拟成交';
  q.canTrade = !q.tradeBlockedReason;
  return q;
}
function parseQuotes(text, receivedAt = Date.now()) {
  const result = {};
  for (const m of text.matchAll(/v_((?:sh|sz)\d{6})="([^"]*)"/g)) {
    const a = m[2].split('~');
    if (a.length < 35 || !(numeric(a[3]) > 0) || a[2] !== m[1].slice(2) || !/^\d{14}$/.test(a[30])) continue;
    const s = a[30], date = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, time = `${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
    const at = timestamp(date, time); if (at === null) continue;
    // Tencent's HS adapter reports STAR volume and book sizes in shares;
    // ordinary A shares use 100-share lots (same convention as the screener).
    const shareUnit = m[1].startsWith('sh688') ? 1 : 100;
    result[m[1]] = completeQuote({ symbol: m[1], code: a[2], name: a[1], price: numeric(a[3]), prevClose: numeric(a[4]), open: numeric(a[5]), volume: scaled(a[6], shareUnit),
      bid: numeric(a[9]), bidSize: scaled(a[10], shareUnit), ask: numeric(a[19]), askSize: scaled(a[20], shareUnit),
      change: numeric(a[31]), changePct: numeric(a[32]), high: numeric(a[33]), low: numeric(a[34]), amount: scaled(a[37], 10000),
      turnover: numeric(a[38]), pe: numeric(a[39]), pb: numeric(a[46]), limitUp: numeric(a[47]), limitDown: numeric(a[48]),
      date, time, timestamp: at, receivedAt, provider: 'tencent', source: SOURCES.tencent });
    if (!INDEX_SYMBOLS.has(m[1])) {
      try {
        // Reuse the screener adapter for dynamic PE, quote volume ratio and KCB units.
        // A truncated quote may still display/trade, but absent screening metrics
        // remain unavailable to any saved entry constraint that needs them.
        const row = parseTencentScreenQuotes(m[0], [m[1]], receivedAt)[0];
        result[m[1]].screeningMetrics = { ...row, source: SOURCES.tencent };
      } catch {}
    }
  }
  return result;
}
function parseSinaQuotes(text, receivedAt = Date.now()) {
  const result = {};
  for (const m of text.matchAll(/var\s+hq_str_((?:sh|sz)\d{6})="([^"]*)"/g)) {
    const a = m[2].split(','), at = timestamp(a[30], a[31]), price = numeric(a[3]), prevClose = numeric(a[2]);
    if (a.length < 32 || !a[0] || !(price > 0) || at === null) continue;
    result[m[1]] = completeQuote({ symbol: m[1], code: m[1].slice(2), name: a[0], price, prevClose, open: numeric(a[1]), high: numeric(a[4]), low: numeric(a[5]),
      bid: numeric(a[11]), bidSize: numeric(a[10]), ask: numeric(a[21]), askSize: numeric(a[20]), volume: numeric(a[8]), amount: numeric(a[9]),
      change: prevClose > 0 ? price - prevClose : null, changePct: prevClose > 0 ? (price / prevClose - 1) * 100 : null,
      turnover: null, pe: null, pb: null, limitUp: null, limitDown: null,
      date: a[30], time: a[31], timestamp: at, receivedAt, provider: 'sina', source: SOURCES.sina });
  }
  return result;
}
function validateBars(raw, now = Date.now()) {
  if (!Array.isArray(raw) || !raw.length) throw invalid('未收到有效日线');
  const bars = raw.map(a => {
    if (!Array.isArray(a)) throw invalid('日线格式异常');
    return { date: a[0], open: numeric(a[1]), close: numeric(a[2]), high: numeric(a[3]), low: numeric(a[4]), volume: scaled(a[5], 100) };
  });
  return validatePriceBars(bars, now);
}
function validatePriceBars(bars, now) {
  if (bars.some((b, i) => !validDate(b.date) || ![b.open, b.close, b.high, b.low, b.volume].every(Number.isFinite) || b.low <= 0 || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.volume < 0 || (i && b.date <= bars[i - 1].date))) throw invalid('日线价格、成交量或日期顺序异常');
  const filtered = bars.filter(b => b.date <= cnTime(now).date);
  if (!filtered.length) throw invalid('未收到截至当前日期的日线');
  return filtered;
}
function parseSinaBars(json, now = Date.now()) {
  if (!Array.isArray(json) || !json.length) throw invalid('新浪未返回有效日线');
  // The 240-minute endpoint returns daily unadjusted OHLC and volume in
  // shares, including STAR stocks and indices. Do not apply Tencent's lot
  // conversion or accept a minute timestamp as evidence of a completed day.
  const bars = json.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || !['open', 'close', 'high', 'low', 'volume'].every(key => ['number', 'string'].includes(typeof row[key])))
      throw invalid('新浪日线格式异常');
    return { date: row.day, open: numeric(row.open), close: numeric(row.close), high: numeric(row.high), low: numeric(row.low), volume: numeric(row.volume) };
  });
  return validatePriceBars(bars, now);
}
function eastmoneyData(json, symbol) {
  const data = json?.data, market = symbol.startsWith('sh') ? 1 : 0;
  if (json?.rc !== 0 || data?.code !== symbol.slice(2) || data?.market !== market) throw invalid('东方财富返回代码或市场不符');
  return data;
}
function parseEastmoneyBars(json, symbol, now) {
  const data = eastmoneyData(json, symbol);
  if (!Array.isArray(data.klines) || data.klines.some(s => typeof s !== 'string')) throw invalid('东方财富日线格式异常');
  return validateBars(data.klines.map(s => s.split(',')), now);
}
function validateMinute(date, points, now) {
  const formatted = typeof date === 'string' && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
  if (!validDate(formatted) || formatted > cnTime(now).date || !points.length || points.some((p, i) => !/^(?:09|1[0-5])[0-5]\d$/.test(p.time) || p.time < '0930' || p.time > '1500' || !(p.price > 0) || !Number.isFinite(p.volume) || p.volume < 0 || (i && (p.time <= points[i - 1].time || p.volume < points[i - 1].volume)))) throw invalid('分时日期、价格或成交量异常');
  return { date: formatted.replaceAll('-', ''), points };
}
function parseEastmoneyIntraday(json, symbol, now) {
  const data = eastmoneyData(json, symbol);
  if (!Array.isArray(data.trends) || !data.trends.length) throw invalid('东方财富分时数据缺失');
  let date, total = 0;
  const points = data.trends.map(line => {
    if (typeof line !== 'string') throw invalid('东方财富分时格式异常');
    const a = line.split(','), parts = a[0].split(' ');
    if (date && date !== parts[0]) throw invalid('分时混入多个交易日');
    date = parts[0]; const volume = scaled(a[5], 100);
    if (!Number.isFinite(volume) || volume < 0) throw invalid('分时成交量异常');
    total += volume;
    return { time: parts[1]?.replace(':', ''), price: numeric(a[2]), volume: total };
  });
  return { ...validateMinute(date, points, now), prevClose: numeric(data.preClose) };
}
module.exports = { SOURCES, INDEX_SYMBOLS, numeric, scaled, invalid, parseQuotes, parseSinaQuotes, validateBars, validateMinute, parseSinaBars, parseEastmoneyBars, parseEastmoneyIntraday };
