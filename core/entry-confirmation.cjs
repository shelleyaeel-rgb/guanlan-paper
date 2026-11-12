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
  return { signal: result, pullback, breakout };
}
const priceText = value => Number(value.toFixed(4)).toString();
function confirmationProgress(observations, start) {
  const first = observations[start], last = observations.at(-1);
  const elapsedMs = Math.max(0, Math.min(last.timestamp - first.timestamp, last.observedAt - first.observedAt));
  return { startedAt: first.timestamp, observedStartedAt: first.observedAt, elapsedMs, remainingMs: Math.max(0, P.confirmMs - elapsedMs) };
}
function progressReason(label, progress) {
  return `${label}已开始站稳确认，已累计 ${Math.floor(progress.elapsedMs / 1000)} 秒，还需至少 ${Math.ceil(progress.remainingMs / 1000)} 秒的连续新鲜报价`;
}
function unmetReboundLevels(quote, basis, minimum) {
  const levels = [
    { label: '锚点', price: basis.anchor, strict: true },
    { label: '昨收', price: quote.prevClose },
    { label: '今开', price: quote.open },
    { label: '最低反弹价', price: minimum }
  ];
  return levels.filter(level => level.strict ? quote.price <= level.price : quote.price < level.price);
}
function pullbackDiagnostic(observations, basis, pullback) {
  const quote = observations.at(-1), anchorLabel = strategyProfile(basis.strategyId).anchor.toUpperCase();
  const path = 'pullback';
  const minimumReboundPrice = basis.entryLow + P.reboundAtr * basis.atr;
  const conflicts = [
    { failed: Math.max(quote.open, quote.prevClose) > basis.entryHigh,
      reason: `确认要求不低于昨收 ${priceText(quote.prevClose)}、今开 ${priceText(quote.open)}，已超出区间上限` },
    { failed: basis.anchor >= basis.entryHigh,
      reason: `确认要求站上 ${anchorLabel} ${priceText(basis.anchor)}，已无法留在区间内` },
    { failed: basis.anchor < basis.entryLow,
      reason: `触碰锚点 ${anchorLabel} ${priceText(basis.anchor)} 已低于区间下限` },
    { failed: minimumReboundPrice > basis.entryHigh,
      reason: `从区间下限反弹 ${priceText(P.reboundAtr * basis.atr)} 后至少达到 ${priceText(minimumReboundPrice)}，已超出区间上限` }
  ].filter(item => item.failed).map(item => item.reason);
  if (conflicts.length) {
    return { path, stage: 'no-overlap', minimumReboundPrice, conflicts,
      reason: `当日回踩条件无交集，回踩区间 ${priceText(basis.entryLow)}–${priceText(basis.entryHigh)}。${conflicts.join('。')}` };
  }
  if (quote.price < basis.entryLow) {
    return { path, stage: 'below-range', reason: `当前价 ${priceText(quote.price)} 低于回踩区间下限 ${priceText(basis.entryLow)}，等待回到区间后重新观察回踩回升` };
  }
  if (quote.price > basis.entryHigh) {
    return { path, stage: 'above-range', reason: `当前价 ${priceText(quote.price)} 高于回踩区间上限 ${priceText(basis.entryHigh)}，等待回到区间并重新触碰 ${anchorLabel} ${priceText(basis.anchor)}` };
  }
  if (!pullback) {
    return { path, stage: 'waiting-touch', reason: `尚未形成有效回踩序列，当前价 ${priceText(quote.price)}，需要在区间 ${priceText(basis.entryLow)}–${priceText(basis.entryHigh)} 内触碰 ${anchorLabel} ${priceText(basis.anchor)}` };
  }
  const touchedAt = observations[pullback.touch].timestamp, touchPrice = pullback.low;
  const reboundPrice = touchPrice + P.reboundAtr * basis.atr;
  if (pullback.start === null) {
    const unmet = unmetReboundLevels(quote, basis, reboundPrice);
    const thresholds = unmet.map(level => `${level.label} ${priceText(level.price)}`).join('、');
    return { path, stage: 'waiting-rebound', touchedAt, touchPrice, reboundPrice, unmet,
      reason: `已观测回踩 ${priceText(touchPrice)}，当前价 ${priceText(quote.price)} 尚未满足回升门槛（${thresholds}），站稳计时尚未开始` };
  }
  const progress = confirmationProgress(observations, pullback.start);
  return { path, stage: 'confirming', touchedAt, touchPrice, reboundPrice, ...progress, reason: progressReason('回踩回升', progress) };
}
function breakoutDiagnostic(observations, basis, breakout) {
  const quote = observations.at(-1), path = 'breakout';
  const threshold = basis.resistance + Math.max(0.01, P.breakoutBufferAtr * basis.atr);
  const chaseLimit = basis.resistance + P.maxChaseAtr * basis.atr;
  const values = { path, threshold, chaseLimit };
  if (quote.price > chaseLimit) {
    return { ...values, stage: 'above-chase-limit', reason: `突破路径可检查，当前价 ${priceText(quote.price)} 超过追价上限 ${priceText(chaseLimit)}，等待重新观察有效穿越` };
  }
  if (!breakout) {
    return { ...values, stage: 'waiting-crossing', reason: `突破路径可检查，当前需要重新观测从前高 ${priceText(basis.resistance)} 下方穿越，确认价至少 ${priceText(threshold)}` };
  }
  const touchedAt = observations[breakout.touch].timestamp;
  if (breakout.start === null) {
    return { ...values, stage: 'waiting-breakout', touchedAt,
      reason: `突破路径可检查，当前价 ${priceText(quote.price)} 等待达到突破确认价 ${priceText(threshold)}，并不低于锚点 ${priceText(basis.anchor)}、昨收 ${priceText(quote.prevClose)}、今开 ${priceText(quote.open)}` };
  }
  const progress = confirmationProgress(observations, breakout.start);
  return { ...values, stage: 'confirming', touchedAt, ...progress, reason: progressReason('突破', progress) };
}
function pendingDiagnostic(observations, basis, regime, replayed, resetReason) {
  const quote = observations.at(-1), pullback = pullbackDiagnostic(observations, basis, replayed.pullback);
  const paths = [pullback];
  if (basis.strategyId !== 'long' && regime.status === 'strong' && regime.allowBreakout === true) {
    paths.push(breakoutDiagnostic(observations, basis, replayed.breakout));
  }
  const primary = paths.find(item => item.stage === 'confirming')
    || (pullback.stage === 'no-overlap' ? paths.at(-1) : pullback);
  return { stage: primary.stage, path: primary.path, price: quote.price, anchor: basis.anchor,
    entryLow: basis.entryLow, entryHigh: basis.entryHigh, prevClose: quote.prevClose, open: quote.open,
    observationCount: observations.length, observationSpanMs: quote.timestamp - observations[0].timestamp,
    paths, ...(resetReason ? { resetReason } : {}), reason: [resetReason, ...paths.map(item => item.reason)].filter(Boolean).join('。') };
}
function resetReason(record, basis, regime, quote, now) {
  if (!record) return '';
  if (record.basis.key !== basis.key) return '完整日线或入场基准变化，重新累计观察';
  if (record.marketKey !== marketKey(regime)) return '市场开仓权限变化，重新累计观察';
  if (record.quote.date !== quote.date) return '报价跨日，重新累计观察';
  if (record.quote.source !== quote.source) return '报价来源变化，重新累计观察';
  if (now < record.checkedAt) return '观察时间倒序，重新累计观察';
  if (quote.timestamp - record.quote.timestamp > P.maxQuoteGapMs || now - record.checkedAt > P.maxQuoteGapMs) {
    return `连续报价间隔超过 ${P.maxQuoteGapMs / 1000} 秒，重新累计观察`;
  }
  return '';
}
function pending(symbol, strategyId, now, reason, stage) {
  return { version: 1, template: P.id, symbol, strategyId, status: 'pending', reason, checkedAt: now, expiresAt: now,
    diagnostic: { stage, path: null, reason, reset: true } };
}
class EntryConfirmationTracker {
  constructor() { this.records = new Map(); }
  clear(symbol, strategyId) {
    if (!symbol) { this.records.clear(); return; }
    if (strategyId) this.records.delete(`${strategyId}:${symbol}`);
    else for (const key of this.records.keys()) if (key.endsWith(`:${symbol}`)) this.records.delete(key);
  }
  observe(symbol, strategyId, quote, technical, regime, inputNow = Date.now()) {
    const now = Number(inputNow), key = `${strategyId}:${symbol}`, basis = entryBasis(technical, strategyId);
    let unavailable;
    if (!Number.isFinite(now)) unavailable = { stage: 'invalid-time', reason: '观察时间无效，盘中确认已重置' };
    else if (!marketValid(regime, now)) unavailable = { stage: 'market-unavailable', reason: '市场开仓权限未就绪或已过期，盘中确认已重置' };
    else if (!quoteValid(quote, symbol, now)) unavailable = { stage: 'quote-unavailable', reason: `报价缺失、日期无效或超过 ${P.maxQuoteGapMs / 1000} 秒，盘中确认已重置` };
    else if (!completedBasis(basis, now)) unavailable = { stage: 'history-unavailable', reason: '完整日线或入场基准不足，盘中确认已重置' };
    if (unavailable) {
      this.records.delete(key);
      return pending(symbol, strategyId, now, unavailable.reason, unavailable.stage);
    }
    let record = this.records.get(key), q = { ...rawQuote(quote), observedAt: now };
    const reset = resetReason(record, basis, regime, q, now);
    if (reset) record = null;
    // Old/out-of-order quotes cannot advance a timer or replace the last raw
    // observation. A changed value carrying an identical timestamp is rejected.
    if (record && q.timestamp <= record.quote.timestamp) {
      if (q.timestamp < record.quote.timestamp || !sameQuote(q, record.quote)) { this.records.delete(key); return pending(symbol, strategyId, now, '报价倒序或同时间戳数据变化，重新累计盘中确认', 'quote-reset'); }
      return clone(record);
    }
    const observations = [...(record?.observations || []), q].filter(item => q.timestamp - item.timestamp <= P.observationWindowMs).slice(-P.maxObservations);
    const replayed = replay(observations, basis, regime), signal = replayed.signal;
    const diagnostic = signal ? null : pendingDiagnostic(observations, basis, regime, replayed, reset);
    record = { version: 1, template: P.id, symbol, strategyId, asOf: basis.asOf, basis, marketKey: marketKey(regime), marketStatus: regime.status,
      status: signal ? 'confirmed' : 'pending', reason: signal ? (signal.path === 'pullback' ? '已观测回踩后回升并连续站稳' : '已观测突破旧日线区间后连续站稳') : diagnostic.reason,
      checkedAt: now, expiresAt: Math.min(q.timestamp + P.maxQuoteGapMs, regime.expiresAt), quote: q, observations,
      ...(diagnostic ? { diagnostic } : {}),
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
  const { signal } = replay(observations, basis, regime);
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
