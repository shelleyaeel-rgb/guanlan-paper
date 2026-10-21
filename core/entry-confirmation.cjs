'use strict';
const { createHash } = require('node:crypto');
const { cnTime } = require('./common.cjs');
const { strategyProfile, ADAPTIVE_ENTRY_TEMPLATE } = require('./strategy-profiles.cjs');

const P = ADAPTIVE_ENTRY_TEMPLATE;
const round = value => Math.round(value * 100) / 100;
const clone = value => structuredClone(value);
const quoteFields = ['symbol', 'source', 'date', 'timestamp', 'price', 'ask', 'bid', 'open', 'prevClose', 'high', 'low'];
const rawQuote = q => Object.fromEntries(quoteFields.map(key => [key, q?.[key] ?? null]));
const sameQuote = (a, b) => JSON.stringify(rawQuote(a)) === JSON.stringify(rawQuote(b));
function marketKey(regime) { return JSON.stringify([regime?.status, regime?.allowEntry, regime?.allowBreakout, regime?.riskMultiplier]); }
function marketValid(regime, now) {
  return regime?.version === 1 && ['strong', 'neutral'].includes(regime.status) && regime.allowEntry === true
    && Number.isFinite(regime.checkedAt) && regime.checkedAt <= now && Number.isFinite(regime.expiresAt) && regime.expiresAt >= now
    && cnTime(regime.checkedAt).date === cnTime(now).date;
}
function quoteValid(q, symbol, now) {
  return q?.symbol === symbol && typeof q.source === 'string' && q.source.length > 0
    && Number.isFinite(q.timestamp) && q.timestamp <= now && now - q.timestamp <= P.maxQuoteGapMs
    && q.date === cnTime(now).date && cnTime(q.timestamp).date === q.date
    && ['price', 'ask', 'open', 'prevClose'].every(key => Number.isFinite(q[key]) && q[key] > 0);
}
function entryBasis(technical, strategyId) {
  const profile = strategyProfile(strategyId), t = profile.id === 'swing' ? technical : { ...technical, ...technical?.levels?.[strategyId] };
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t.asOf || '') || !Number.isFinite(Date.parse(t.asOf)) || new Date(t.asOf).toISOString().slice(0, 10) !== t.asOf
    || !['atr', 'entryLow', 'entryHigh', 'stop', 'target', 'resistance', profile.anchor].every(k => Number.isFinite(t[k]) && t[k] > 0)) return null;
  const basis = { asOf: t.asOf, strategyId, anchor: t[profile.anchor], atr: t.atr, entryLow: t.entryLow, entryHigh: t.entryHigh, stop: t.stop, target: t.target, resistance: t.resistance,
    close: t.close, ma5: t.ma5, ma20: t.ma20, ma60: t.ma60, previousMa5: t.previousMa5, previousMa20: t.previousMa20, previousMa60: t.previousMa60, macd: t.macd, rsi: t.rsi, volumeRatio: t.volumeRatio, trend: t.trend };
  return { ...basis, key: createHash('sha256').update(JSON.stringify(basis)).digest('hex') };
}
function completedBasis(basis, now) {
  const time = cnTime(now);
  return basis && (basis.asOf < time.date || (basis.asOf === time.date && time.minutes >= 900));
}
// Replay the observed prices only. The provider's daily high/low never creates
// a touch, crossing or duration that this process did not actually observe.
function replay(observations, basis, regime) {
  let pullback = null, breakout = null, result = null;
  const threshold = basis.resistance + Math.max(0.01, P.breakoutBufferAtr * basis.atr);
  const chaseLimit = basis.resistance + P.maxChaseAtr * basis.atr;
  for (let index = 0; index < observations.length; index++) {
    const q = observations[index], p = q.price;
    const common = p >= q.open && p >= q.prevClose && p >= basis.anchor;
    result = null;
    if (p < basis.entryLow || p > basis.entryHigh) pullback = null;
    else if (p <= basis.anchor) pullback = { touch: index, low: p, start: null };
    else if (pullback) {
      if (!common || p < pullback.low + P.reboundAtr * basis.atr) pullback.start = null;
      else if (pullback.start === null) pullback.start = index;
      if (pullback.start !== null && index > pullback.start && q.timestamp - observations[pullback.start].timestamp >= P.confirmMs
        && q.observedAt - observations[pullback.start].observedAt >= P.confirmMs) {
        result = { path: 'pullback', touchIndex: pullback.touch, startIndex: pullback.start, endIndex: index };
      }
    }
    if (basis.strategyId !== 'long' && regime.status === 'strong' && regime.allowBreakout === true) {
      if (p <= basis.resistance) breakout = { touch: index, start: null };
      else if (p > chaseLimit) breakout = null;
      else if (breakout) {
        if (!common || p < threshold) breakout.start = null;
        else if (breakout.start === null) breakout.start = index;
        if (!result && breakout.start !== null && index > breakout.start && q.timestamp - observations[breakout.start].timestamp >= P.confirmMs
          && q.observedAt - observations[breakout.start].observedAt >= P.confirmMs) {
          result = { path: 'breakout', touchIndex: breakout.touch, startIndex: breakout.start, endIndex: index };
        }
      }
    } else breakout = null;
  }
  return result;
}
function pending(symbol, strategyId, now, reason) { return { version: 1, template: P.id, symbol, strategyId, status: 'pending', reason, checkedAt: now, expiresAt: now }; }
class EntryConfirmationTracker {
  constructor() { this.records = new Map(); }
  clear(symbol, strategyId) {
    if (!symbol) { this.records.clear(); return; }
    if (strategyId) this.records.delete(`${strategyId}:${symbol}`);
    else for (const key of this.records.keys()) if (key.endsWith(`:${symbol}`)) this.records.delete(key);
  }
  observe(symbol, strategyId, quote, technical, regime, inputNow = Date.now()) {
    const now = Number(inputNow), key = `${strategyId}:${symbol}`, basis = entryBasis(technical, strategyId);
    if (!Number.isFinite(now) || !marketValid(regime, now) || !quoteValid(quote, symbol, now) || !completedBasis(basis, now)) {
      this.records.delete(key); return pending(symbol, strategyId, now, '市场、完整日线或新鲜报价不足，重新累计盘中确认');
    }
    let record = this.records.get(key), q = { ...rawQuote(quote), observedAt: now };
    if (record && (record.basis.key !== basis.key || record.marketKey !== marketKey(regime) || record.quote.date !== q.date
      || record.quote.source !== q.source || q.timestamp - record.quote.timestamp > P.maxQuoteGapMs || now < record.checkedAt || now - record.checkedAt > P.maxQuoteGapMs)) record = null;
    // Old/out-of-order quotes cannot advance a timer or replace the last raw
    // observation. A changed value carrying an identical timestamp is rejected.
    if (record && q.timestamp <= record.quote.timestamp) {
      if (q.timestamp < record.quote.timestamp || !sameQuote(q, record.quote)) { this.records.delete(key); return pending(symbol, strategyId, now, '报价倒序或同时间戳数据变化，重新累计盘中确认'); }
      return clone(record);
    }
    const observations = [...(record?.observations || []), q].filter(item => q.timestamp - item.timestamp <= P.observationWindowMs).slice(-P.maxObservations);
    const signal = replay(observations, basis, regime);
    record = { version: 1, template: P.id, symbol, strategyId, asOf: basis.asOf, basis, marketKey: marketKey(regime), marketStatus: regime.status,
      status: signal ? 'confirmed' : 'pending', reason: signal ? (signal.path === 'pullback' ? '已观测回踩后回升并连续站稳' : '已观测突破旧日线区间后连续站稳') : '等待实际回踩回升或允许的突破时序，站稳至少 60 秒',
      checkedAt: now, expiresAt: Math.min(q.timestamp + P.maxQuoteGapMs, regime.expiresAt), quote: q, observations,
      ...(signal ? { path: signal.path, touchedAt: observations[signal.touchIndex].timestamp, startedAt: observations[signal.startIndex].timestamp, confirmedAt: q.timestamp } : {}) };
    this.records.set(key, record); return clone(record);
  }
  get(symbol, strategyId, inputNow = Date.now()) {
    const record = this.records.get(`${strategyId}:${symbol}`), now = Number(inputNow);
    if (!record || record.expiresAt < now || record.quote.date !== cnTime(now).date) { this.clear(symbol, strategyId); return null; }
    return clone(record);
  }
}
function validateEntryConfirmation(proof, { symbol, strategyId, quote, technical, regime, now: inputNow = Date.now() }) {
  const now = Number(inputNow), basis = entryBasis(technical, strategyId), reject = reason => ({ valid: false, reason });
  if (!marketValid(regime, now)) return reject('市场状态不足或不允许新开仓');
  if (!completedBasis(basis, now) || !quoteValid(quote, symbol, now)) return reject('盘中确认所需完整日线或新鲜报价不足');
  if (!proof || proof.version !== 1 || proof.template !== P.id || proof.status !== 'confirmed') return reject(proof?.reason || '等待回踩回升或突破后的连续新鲜报价确认');
  if (proof.symbol !== symbol || proof.strategyId !== strategyId || proof.asOf !== basis.asOf || proof.basis?.key !== basis.key || proof.marketKey !== marketKey(regime)) return reject('盘中确认与当前股票、策略、日线或市场状态不符');
  if (!Number.isFinite(proof.checkedAt) || proof.checkedAt > now || !Number.isFinite(proof.expiresAt) || proof.expiresAt < now || !sameQuote(proof.quote, quote)) return reject('盘中确认已过期或没有绑定当前原始报价');
  const observations = proof.observations;
  if (!Array.isArray(observations) || observations.length < 3 || observations.length > P.maxObservations || !sameQuote(observations.at(-1), quote)) return reject('盘中确认缺少实际时序报价');
  for (let i = 0; i < observations.length; i++) {
    const q = observations[i], prior = observations[i - 1];
    if (!Number.isFinite(q.observedAt) || q.observedAt > now || !quoteValid(q, symbol, q.observedAt) || q.source !== quote.source || q.date !== quote.date || q.timestamp > now
      || quote.timestamp - q.timestamp > P.observationWindowMs || (prior && (q.timestamp <= prior.timestamp || q.timestamp - prior.timestamp > P.maxQuoteGapMs
        || q.observedAt < prior.observedAt || q.observedAt - prior.observedAt > P.maxQuoteGapMs))) return reject('盘中确认存在旧报价、断线、跨日或来源变化');
  }
  const signal = replay(observations, basis, regime);
  if (!signal || signal.path !== proof.path || proof.startedAt !== observations[signal.startIndex].timestamp || proof.touchedAt !== observations[signal.touchIndex].timestamp || proof.confirmedAt !== quote.timestamp) return reject('原始报价不能重现已声明的回踩或突破确认');
  const plan = signal.path === 'breakout' ? {
    entryLow: Math.ceil((basis.resistance + Math.max(0.01, P.breakoutBufferAtr * basis.atr)) * 100) / 100,
    entryHigh: Math.floor((basis.resistance + P.maxChaseAtr * basis.atr) * 100) / 100,
    stop: round(Math.max(0.01, basis.resistance - P.breakoutStopAtr * basis.atr)), target: round(basis.resistance + P.breakoutTargetAtr * basis.atr),
    breakoutLevel: basis.resistance, targetBasis: '固定 ATR 模型目标，非历史阻力', stopBasis: '旧完整日线区间突破失效位'
  } : { entryLow: basis.entryLow, entryHigh: basis.entryHigh, stop: basis.stop, target: basis.target, targetBasis: '完整日线历史区间高点' };
  return { valid: true, path: signal.path, plan, evidence: { version: 1, template: P.id, path: signal.path, asOf: basis.asOf, touchedAt: proof.touchedAt, startedAt: proof.startedAt, confirmedAt: proof.confirmedAt,
    quoteTime: quote.timestamp, source: quote.source, limitation: P.limitation } };
}
module.exports = { EntryConfirmationTracker, validateEntryConfirmation, entryBasis };
