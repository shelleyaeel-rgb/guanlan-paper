const { cnTime } = require('./common.cjs');
function parseQuotes(text, receivedAt = Date.now()) {
  const result = {};
  for (const m of text.matchAll(/v_((?:sh|sz)\d{6})="([^"]*)"/g)) {
    const a = m[2].split('~');
    if (a.length < 34 || !(+a[3] > 0) || !/^\d{14}$/.test(a[30])) continue;
    const s = a[30], date = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, time = `${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
    result[m[1]] = { symbol: m[1], code: a[2], name: a[1], price: +a[3], prevClose: +a[4], open: +a[5], volume: +a[6] * 100,
      bid: +a[9], bidSize: +a[10] * 100, ask: +a[19], askSize: +a[20] * 100,
      change: +a[31], changePct: +a[32], high: +a[33], low: +a[34], amount: +a[37] * 10000,
      turnover: +a[38] || 0, pe: +a[39] || null, pb: +a[46] || null, limitUp: +a[47] || null, limitDown: +a[48] || null,
      date, time, timestamp: Date.parse(`${date}T${time}+08:00`), receivedAt, source: '腾讯财经公开行情' };
  }
  return result;
}
class Market {
  constructor(fetcher = fetch) { this.fetcher = fetcher; this.cache = new Map(); }
  async request(url, gbk = false) {
    const response = await this.fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' }, signal: AbortSignal.timeout(12000), cache: 'no-store' });
    if (!response.ok) throw Error(`行情服务 HTTP ${response.status}`);
    return gbk ? new TextDecoder('gb18030').decode(await response.arrayBuffer()) : response.json();
  }
  async quotes(symbols) {
    const data = parseQuotes(await this.request(`https://qt.gtimg.cn/q=${[...new Set(symbols)].join(',')}`, true));
    if (!Object.keys(data).length) throw Error('未收到有效报价，请检查网络或稍后重试');
    return data;
  }
  async history(symbol, force = false) {
    const hit = this.cache.get(symbol);
    if (!force && hit && Date.now() - hit.fetchedAt < 60000) return hit;
    const j = await this.request(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,640,qfq`);
    const raw = j.data?.[symbol]?.qfqday;
    if (!Array.isArray(raw) || raw.length < 30) throw Error('前复权日线不足，暂时无法分析');
    const bars = raw.map(a => ({ date: a[0], open: +a[1], close: +a[2], high: +a[3], low: +a[4], volume: +a[5] * 100 }))
      .filter(a => a.close > 0 && a.open > 0 && a.high >= a.low && a.date <= cnTime().date).sort((a, b) => a.date.localeCompare(b.date));
    const entry = { bars, fetchedAt: Date.now(), adjustment: '前复权', source: '腾讯财经' };
    this.cache.set(symbol, entry);
    return entry;
  }
  async intraday(symbol) {
    const j = await this.request(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`);
    const raw = j.data?.[symbol]?.data;
    if (!Array.isArray(raw?.data)) throw Error('分时数据暂不可用');
    return { date: raw.date, points: raw.data.map(s => { const a = s.split(' '); return { time: a[0], price: +a[1], volume: +a[2] * 100 }; }).filter(a => a.price > 0 && a.time <= '1500') };
  }
}
module.exports = { Market, parseQuotes };
