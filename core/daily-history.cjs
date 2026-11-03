'use strict';
const { createHash } = require('node:crypto');
const { cnTime, symbolOf } = require('./common.cjs');
const { calendarSession } = require('./trading-calendar.cjs');
const { dailyIndicators } = require('./daily-indicators.cjs');
const INDEX_SYMBOLS = new Set(['sh000001', 'sz399001', 'sz399006']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Runtime versions revoke already-returned snapshots after a known correction,
// including snapshots held across an await before the final transaction check.
const revisions = new Map();
function registerDailyRevision(runtimeId, kind, symbol, hash) { revisions.set(`${runtimeId}:${kind}:${symbol}`, hash); }
function currentRevision(evidence) {
  return evidence?.runtimeId === undefined || revisions.get(`${evidence.runtimeId}:${evidence.kind}:${evidence.symbol}`) === evidence.barsHash;
}

function expectedDailyDate(now) {
  if (!Number.isFinite(now) || now <= 0) throw Error('日线核验时间无效');
  const cn = cnTime(now), first = cn.minutes >= 900 ? 0 : 1;
  if (!calendarSession(new Date(now)).known) throw Error('交易日历未经核验');
  for (let offset = first; offset < 25; offset++) {
    const date = new Date(Date.parse(`${cn.date}T00:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);
    const trading = calendarSession(new Date(`${date}T10:00:00+08:00`));
    if (!trading.known) throw Error('最近完整交易日的日历未经核验');
    if (trading.open) return date;
  }
  throw Error('无法确认最近完整交易日');
}

// Only completed, unadjusted series acquire this evidence. Download time never
// advances when a series is read from memory, disk, or checked again today.
function prepareHistory(symbol, kind, entry, now) {
  try {
    if (!['stock', 'index'].includes(kind) || (kind === 'index' ? !INDEX_SYMBOLS.has(symbol) : symbolOf(symbol) !== symbol)) return null;
    if (!entry || (entry.symbol != null && entry.symbol !== symbol) || entry.adjustment !== '未复权'
      || typeof entry.source !== 'string' || !entry.source.trim() || entry.source === '来源未标注'
      || typeof entry.provider !== 'string' || !entry.provider.trim()
      || !Number.isFinite(entry.fetchedAt) || entry.fetchedAt <= 0 || entry.fetchedAt > now) return null;
    const expected = expectedDailyDate(now), daily = dailyIndicators(entry.bars, new Date(now));
    if (daily.asOf !== expected || entry.fetchedAt < Date.parse(`${expected}T15:00:00+08:00`)) return null;
    const bars = daily.bars.slice(-121).map(bar => ({ date: bar.date, open: bar.open, close: bar.close, high: bar.high, low: bar.low, volume: bar.volume }));
    const dailyEvidence = { version: 1, kind, symbol, asOf: expected, close: daily.close, count: bars.length,
      source: entry.source, provider: entry.provider, adjustment: '未复权', fetchedAt: entry.fetchedAt, barsHash: digest(bars) };
    return { symbol, bars, source: entry.source, provider: entry.provider, adjustment: '未复权', fetchedAt: entry.fetchedAt, dailyEvidence };
  } catch { return null; }
}

function preparedHistoryValid(entry, symbol, kind, now) {
  if (!entry?.dailyEvidence || !currentRevision(entry.dailyEvidence)) return false;
  const prepared = prepareHistory(symbol, kind, entry, now);
  return !!prepared && Object.entries(prepared.dailyEvidence).every(([key, value]) => entry.dailyEvidence[key] === value)
    && entry.bars.length === prepared.bars.length && digest(entry.bars) === prepared.dailyEvidence.barsHash;
}

function preparedTechnicalValid(snapshot, now, symbol) {
  try {
    const evidence = snapshot?.dailyEvidence, t = snapshot?.technical;
    if (!evidence || !currentRevision(evidence) || evidence.version !== 1 || evidence.kind !== 'stock' || (symbol != null && symbol !== evidence.symbol)
      || symbolOf(evidence.symbol) !== evidence.symbol || evidence.adjustment !== '未复权'
      || evidence.source !== snapshot.source || !evidence.source?.trim() || evidence.source === '来源未标注'
      || !evidence.provider?.trim() || (snapshot.provider != null && evidence.provider !== snapshot.provider)
      || evidence.fetchedAt !== snapshot.fetchedAt || !Number.isFinite(evidence.fetchedAt) || evidence.fetchedAt > now
      || evidence.fetchedAt < Date.parse(`${evidence.asOf}T15:00:00+08:00`)
      || evidence.asOf !== expectedDailyDate(now) || evidence.asOf !== t?.asOf || evidence.close !== t.close || !(t.close > 0)
      || !/^[a-f0-9]{64}$/.test(evidence.barsHash) || !Number.isInteger(evidence.count) || evidence.count < 61
      || evidence.count > 121 || !Array.isArray(t.dates) || t.dates.length !== evidence.count || t.dates.at(-1) !== evidence.asOf
      || t.dates.some((date, index) => typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > evidence.asOf || (index > 0 && date <= t.dates[index - 1]))) return false;
    return true;
  } catch { return false; }
}

function publicDailyHistory(value, now, symbol = value?.symbol) {
  const evidence = value?.dailyEvidence;
  if (!evidence) return null;
  if (now !== undefined && !(value.technical ? preparedTechnicalValid(value, now, symbol ?? evidence.symbol)
    : preparedHistoryValid(value, symbol ?? evidence.symbol, evidence.kind, now))) return null;
  return { asOf: evidence.asOf, fetchedAt: value.fetchedAt,
    status: ['fresh', 'cached', 'refreshing', 'degraded'].includes(value.historyStatus) ? value.historyStatus : 'fresh',
    refreshError: value.refreshError || '', cacheWarning: value.cacheWarning || '' };
}

module.exports = { expectedDailyDate, prepareHistory, preparedHistoryValid, preparedTechnicalValid, publicDailyHistory, registerDailyRevision };
