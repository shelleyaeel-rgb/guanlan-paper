const { cnTime } = require('./common.cjs');
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const std = a => Math.sqrt(mean(a.map(x => (x - mean(a)) ** 2)));
const last = a => a.at(-1);
const quantile = (a, p) => { const b = [...a].sort((x, y) => x - y), i = (b.length - 1) * p, lo = Math.floor(i); return b[lo] + (b[Math.ceil(i)] - b[lo]) * (i - lo); };
function ema(a, period) { const k = 2 / (period + 1), out = [a[0]]; for (let i = 1; i < a.length; i++) out.push(k * a[i] + (1 - k) * last(out)); return out; }
function rsi(c, p = 14) {
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; gain += Math.max(0, d) / p; loss += Math.max(0, -d) / p; }
  for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; gain = (gain * (p - 1) + Math.max(0, d)) / p; loss = (loss * (p - 1) + Math.max(0, -d)) / p; }
  return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
}
function features(c, i) {
  const a = c.slice(i - 20, i + 1), ret = a.slice(1).map((v, k) => Math.log(v / a[k]));
  return [Math.log(c[i] / c[i - 5]), Math.log(c[i] / c[i - 20]), c[i] / mean(a.slice(-20)) - 1, std(ret)];
}
// At index t, only include samples whose five-day outcomes have already closed by t.
function forecastAt(c, t, horizon = 5) {
  const target = features(c, t), scales = [0.04, 0.10, 0.06, 0.02], pool = [];
  for (let i = 20; i + horizon <= t; i++) {
    const f = features(c, i), distance = Math.sqrt(mean(f.map((v, k) => ((v - target[k]) / scales[k]) ** 2)));
    pool.push({ distance, ret: c[i + horizon] / c[i] - 1 });
  }
  const neighbors = pool.sort((a, b) => a.distance - b.distance).slice(0, 40), returns = neighbors.map(a => a.ret);
  if (returns.length < 20) return null;
  return { n: returns.length, median: quantile(returns, 0.5), low: quantile(returns, 0.1), high: quantile(returns, 0.9), upRate: returns.filter(r => r > 0).length / returns.length, horizon };
}
function analyze(rawBars, quote, now = new Date()) {
  const cn = cnTime(now);
  // Exclude today's unfinished daily bar, so the five-day model uses closed observations.
  const bars = rawBars.filter(b => b.date < cn.date || (b.date === cn.date && cn.minutes >= 900));
  if (bars.length < 60) return { error: '完整日线不足 60 根，暂不生成信号和预测。' };
  const c = bars.map(b => b.close), close = last(c), ma5 = mean(c.slice(-5)), ma20 = mean(c.slice(-20)), ma60 = mean(c.slice(-60));
  const e12 = ema(c, 12), e26 = ema(c, 26), dif = c.map((_, i) => e12[i] - e26[i]), dea = ema(dif, 9), hist = (last(dif) - last(dea)) * 2;
  const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close))), atr = mean(tr.slice(-14));
  const r = rsi(c), volRatio = last(bars).volume / Math.max(1, mean(bars.slice(-21, -1).map(b => b.volume)));
  let score = 50; const reasons = [];
  if (close > ma20) { score += 15; reasons.push('收盘价位于 MA20 上方，短期趋势偏强'); } else { score -= 15; reasons.push('收盘价低于 MA20，等待趋势修复'); }
  if (ma20 > ma60) { score += 10; reasons.push('MA20 高于 MA60，中期趋势向上'); } else { score -= 10; reasons.push('MA20 低于 MA60，中期趋势偏弱'); }
  score += hist > 0 ? 10 : -10;
  reasons.push(hist > 0 ? 'MACD 柱为正，动能偏多' : 'MACD 柱为负，动能偏空');
  if (r > 75) { score -= 15; reasons.push('RSI 超过 75，注意短期回撤'); }
  else if (r >= 45 && r <= 65) score += 5;
  else if (r < 30) reasons.push('RSI 低于 30，超卖并不代表已经止跌');
  if (volRatio > 1.3 && last(c) > c.at(-2)) score += 5;
  score = Math.max(0, Math.min(100, score));
  const forecast = forecastAt(c, c.length - 1), tests = [];
  // Non-overlapping five-session outcomes; each prediction is fitted only on its own past.
  for (let i = Math.max(100, c.length - 125); i + 5 < c.length; i += 5) {
    const p = forecastAt(c, i); if (!p) continue;
    const actual = c[i + 5] / c[i] - 1;
    tests.push({ date: bars[i].date, predicted: p.median, actual, correct: Math.sign(p.median) === Math.sign(actual), covered: actual >= p.low && actual <= p.high });
  }
  const base = quote?.price || close, risk = Math.max(base * 0.025, atr * 1.5);
  return { asOf: last(bars).date, count: bars.length, close, ma5, ma20, ma60, rsi: r, dif: last(dif), dea: last(dea), macd: hist, atr, volRatio,
    score, signal: score >= 70 ? '关注回踩买点' : score <= 30 ? '减仓 / 观望' : '等待确认', reasons,
    plan: { entryLow: Math.min(base, ma20), entryHigh: Math.max(Math.min(base, ma20), Math.min(base, ma20 + atr * 0.35)), stop: Math.max(0.01, base - risk), target: base + risk * 2, ratio: 2 },
    forecast: forecast && { ...forecast, base: close, price: close * (1 + forecast.median), lowPrice: close * (1 + forecast.low), highPrice: close * (1 + forecast.high) },
    validation: { count: tests.length, accuracy: tests.length ? mean(tests.map(t => +t.correct)) : null, coverage: tests.length ? mean(tests.map(t => +t.covered)) : null, mae: tests.length ? mean(tests.map(t => Math.abs(t.predicted - t.actual))) : null, tests } };
}
module.exports = { analyze, forecastAt, rsi, ema };
