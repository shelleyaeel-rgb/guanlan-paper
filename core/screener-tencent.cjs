const { symbolOf } = require('./common.cjs');

const TENCENT_SCREEN_SOURCE = '腾讯财经公开行情（新浪证券列表）';
const invalid = message => Object.assign(Error(message), { code: 'invalid' });

function numeric(value) {
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function quoteTimestamp(value, receivedAt) {
  if (!/^\d{14}$/.test(value)) return null;
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const time = `${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}`;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) return null;
  const day = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) return null;
  const at = Date.parse(`${date}T${time}+08:00`);
  return Number.isFinite(at) && at > 0 && at <= receivedAt ? at : null;
}

// Field indices and units are verified against Tencent's own HS quote adapter:
// https://st.gtimg.com/quotes/hs-fund/bundle.13362df9.js (2026-10-08).
// In particular, [52] is dynamic_ratio, while [39] is a different PE field.
// KCB volume is in shares; other supported A-share volume is in 100-share lots.
function parseTencentScreenQuotes(text, expectedSymbols, receivedAt = Date.now()) {
  if (typeof text !== 'string' || !Array.isArray(expectedSymbols) || !Number.isFinite(receivedAt)) throw invalid('腾讯选股行情参数无效');
  const expected = new Set();
  for (const symbol of expectedSymbols) {
    let standard;
    try { standard = symbolOf(symbol); } catch { throw invalid('腾讯选股仅支持标准沪深 A 股代码'); }
    if (typeof symbol !== 'string' || symbol !== standard) throw invalid('腾讯选股仅支持标准沪深 A 股代码');
    if (expected.has(symbol)) throw invalid(`腾讯选股请求代码重复：${symbol}`);
    expected.add(symbol);
  }

  const rows = new Map();
  for (const match of text.matchAll(/\bv_([a-zA-Z0-9_]+)\s*=\s*"([^"\r\n]*)"/g)) {
    const symbol = match[1];
    if (!expected.has(symbol)) throw invalid(`腾讯选股行情包含未请求股票：${symbol}`);
    if (rows.has(symbol)) throw invalid(`腾讯选股行情代码重复：${symbol}`);
    const a = match[2].split('~');
    if (a.length < 62) throw invalid(`腾讯选股行情字段截断：${symbol}`);
    if (a[2] !== symbol.slice(2) || a[0] !== (symbol.startsWith('sh') ? '1' : '51')) throw invalid(`腾讯选股行情代码或市场不符：${symbol}`);
    const name = a[1].trim();
    if (!name) throw invalid(`腾讯选股行情名称缺失：${symbol}`);
    const board = symbol.startsWith('sh688') ? 'star' : /^sz30/.test(symbol) ? 'chinext' : symbol.startsWith('sh') ? 'sh' : 'sz';
    const stockType = a[61].trim();
    const knownType = { star: 'GP-A-KCB', chinext: 'GP-A-CYB', sh: 'GP-A', sz: 'GP-A' }[board];
    if (stockType && stockType !== knownType) throw invalid(`腾讯选股证券类型不符：${symbol}`);
    const field = (index, valid = () => true, divisor = 1) => {
      const n = numeric(a[index]);
      return n !== null && valid(n) ? n / divisor : null;
    };
    const nonnegative = n => n >= 0, positive = n => n > 0, nonzero = n => n !== 0;
    // The provider displays zero valuation, volume-ratio and market-cap values
    // as unavailable. Zero traded volume/amount and zero percentage changes are valid.
    const preciseAmount = field(57, nonnegative, 10000);
    rows.set(symbol, {
      symbol, name, board, isST: /ST|退/i.test(name),
      price: field(3, positive), prevClose: field(4, positive), changePct: field(32), turnover: field(38, nonnegative),
      volumeRatio: field(49, positive), amount: preciseAmount ?? field(37, nonnegative, 10000),
      marketCap: field(45, positive), floatCap: field(44, positive),
      pe: field(52, nonzero), pb: field(46, nonzero), amplitude: field(43, nonnegative),
      volume: field(36, nonnegative, board === 'star' ? 1000000 : 10000),
      timestamp: quoteTimestamp(a[30], receivedAt)
    });
  }
  const missing = expectedSymbols.filter(symbol => !rows.has(symbol));
  if (missing.length) throw invalid(`腾讯选股行情缺少 ${missing.length} 只股票：${missing.slice(0, 3).join('、')}`);
  return expectedSymbols.map(symbol => rows.get(symbol));
}

module.exports = { parseTencentScreenQuotes, TENCENT_SCREEN_SOURCE };
