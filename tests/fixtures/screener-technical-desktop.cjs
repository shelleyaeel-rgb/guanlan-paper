// Reuse the isolated account, quote pages and clock; replace only test daily bars.
require('./screener-desktop.cjs');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { Market } = require('../../core/market.cjs');
const dates = [], day = new Date('2026-09-29T00:00:00Z');
while (dates.length < 120) { if (![0, 6].includes(day.getUTCDay())) dates.unshift(day.toISOString().slice(0, 10)); day.setUTCDate(day.getUTCDate() - 1); }
const bars = dates.map((date, i) => {
  const close = 10 + i * 0.008 + Math.sin(i / 4 + 1.6) * 0.12;
  return { date, open: close, close, high: close + 0.1, low: close - 0.1, volume: i === 119 ? 60 : 100 };
});
Market.prototype.strategyHistory = async (symbol, signal) => {
  const scenario = JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
  if (scenario.dailyMode === 'slow') await delay(10000, null, { signal });
  if (scenario.dailyMode === 'offline') throw Error('测试日线断线');
  if (scenario.dailyMode === 'partial') {
    if (symbol === 'sh600002') return bars.slice(-60);
    if (symbol === 'sh600003') return [...bars, bars.at(-1)];
    if (symbol === 'sh600004') throw Error('测试日线断线');
  }
  return bars;
};
