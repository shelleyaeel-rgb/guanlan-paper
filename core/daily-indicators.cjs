const { cnTime } = require('./common.cjs');
const { ema, rsi } = require('./analysis.cjs');
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const invalid = (message, code) => Object.assign(new Error(message), { code });

// Both the strategy and technical screener use complete, unadjusted daily bars.
// Keep execution-specific checks (ATR, quote freshness, account limits) outside.
function dailyIndicators(rawBars, now = new Date()) {
  const cn = cnTime(now);
  if (!Array.isArray(rawBars) || rawBars.some(b => !b || typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !Number.isFinite(Date.parse(b.date)) || new Date(b.date).toISOString().slice(0, 10) !== b.date)) throw invalid('日线日期无效', 'invalid');
  const bars = rawBars.filter(b => b.date < cn.date || (b.date === cn.date && cn.minutes >= 900));
  if (bars.some((b, i) => ![b.open, b.close, b.high, b.low, b.volume].every(Number.isFinite) || b.low <= 0 || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.volume < 0 || (i && b.date <= bars[i - 1].date))) throw invalid('日线数据无效或日期重复', 'invalid');
  if (bars.length < 61) throw invalid('完整未复权日线不足 61 根', 'insufficient');
  const c = bars.map(b => b.close), last = bars.at(-1);
  const e12 = ema(c, 12), e26 = ema(c, 26), dif = c.map((_, i) => e12[i] - e26[i]), dea = ema(dif, 9);
  const previousVolume = mean(bars.slice(-21, -1).map(b => b.volume));
  return {
    bars, asOf: last.date, close: last.close, previousClose: c.at(-2),
    ma5: mean(c.slice(-5)), ma20: mean(c.slice(-20)), ma60: mean(c.slice(-60)),
    previousMa5: mean(c.slice(-6, -1)), previousMa20: mean(c.slice(-21, -1)), previousMa60: mean(c.slice(-61, -1)),
    rsi: rsi(c), macd: 2 * (dif.at(-1) - dea.at(-1)),
    dailyVolumeRatio: previousVolume > 0 ? last.volume / previousVolume : null
  };
}
module.exports = { dailyIndicators };
