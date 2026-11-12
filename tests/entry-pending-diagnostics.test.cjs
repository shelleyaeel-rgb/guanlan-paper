'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EntryConfirmationTracker, validateEntryConfirmation } = require('../core/entry-confirmation.cjs');
const { monitoringCheck } = require('../core/agency-monitoring.cjs');

const SYMBOL = 'sz000001', START = Date.parse('2026-11-05T10:00:00+08:00');
function fixture({ breakout = false, strategyId = 'swing' } = {}) {
  const tracker = new EntryConfirmationTracker();
  const level = { entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, resistance: 11.5 };
  const technical = { asOf: '2026-11-04', close: 10.05, ma5: 10, ma20: 10, ma60: 10, atr: 0.4,
    ...level, levels: { short: { ...level }, 'ultra-short': { ...level }, long: { ...level } } };
  const regime = { version: 1, status: 'strong', allowEntry: true, allowBreakout: breakout,
    riskMultiplier: breakout ? 1 : 0.5, checkedAt: START, expiresAt: START + 1800000 };
  const quote = (seconds, price, extra = {}) => ({ symbol: SYMBOL, source: 'isolated quote', date: '2026-11-05',
    timestamp: START + seconds * 1000, price, ask: price, bid: price - 0.01, open: 10, prevClose: 10.05,
    high: 12, low: 9.8, ...extra });
  const observe = (seconds, price, extra = {}, observedSeconds = seconds) => {
    const q = quote(seconds, price, extra), now = START + observedSeconds * 1000;
    return { q, now, proof: tracker.observe(SYMBOL, strategyId, q, technical, regime, now) };
  };
  const validate = ({ proof, q, now }) => validateEntryConfirmation(proof, { symbol: SYMBOL, strategyId, quote: q, technical, regime, now });
  return { tracker, technical, regime, quote, observe, validate };
}
function pullbackPath(proof) { return proof.diagnostic.paths.find(item => item.path === 'pullback'); }

test('当日确认下限高于回踩上限时直接解释无交集，长线也不提示突破', () => {
  for (const extra of [{ open: 10.5 }, { prevClose: 10.5 }]) {
    const f = fixture(), { proof } = f.observe(0, 10.1, extra);
    assert.equal(proof.status, 'pending');
    assert.equal(proof.diagnostic.stage, 'no-overlap');
    assert.equal(proof.diagnostic.entryHigh, 10.3);
    assert.match(proof.reason, /当日回踩条件无交集/);
    assert.match(proof.reason, /10\.3/); assert.match(proof.reason, /10\.5/);
    assert.doesNotMatch(proof.reason, /还需.*秒/);
    assert.equal(monitoringCheck({ buyable: false, reasons: [proof.reason] }, {}, START).status, 'conditions');
  }
  const f = fixture({ breakout: true, strategyId: 'long' });
  const { proof } = f.observe(0, 10.1, { open: 10.5 });
  assert.equal(proof.diagnostic.paths.length, 1); assert.equal(proof.diagnostic.path, 'pullback');
  assert.doesNotMatch(proof.reason, /突破/);
});

test('仅价格高于锚点和日内low曾回踩不构成已触碰，区间以下单独解释', () => {
  const f = fixture();
  f.observe(0, 10.1, { low: 9.95 });
  const waiting = f.observe(70, 10.2, { low: 9.95 }).proof;
  assert.equal(waiting.diagnostic.stage, 'waiting-touch');
  assert.equal(waiting.diagnostic.observationSpanMs, 70000);
  assert.match(waiting.reason, /尚未.*触碰 MA20 10/);
  assert.doesNotMatch(waiting.reason, /已累计|还需.*秒/);
  const below = f.observe(80, 9.8).proof;
  assert.equal(below.diagnostic.stage, 'below-range');
  assert.match(below.reason, /当前价 9\.8 低于回踩区间下限 9\.9/);
  assert.equal(f.observe(90, 10.1).proof.diagnostic.stage, 'waiting-touch', '跌出区间后须重新观测触碰');
});

test('触碰后向上离开区间会失效，回到区间时准确提示需要形成新的有效序列', () => {
  const f = fixture();
  f.observe(0, 9.96); f.observe(10, 10.08);
  const above = f.observe(20, 10.4).proof;
  assert.equal(above.diagnostic.stage, 'above-range');
  assert.match(above.reason, /高于回踩区间上限 10\.3/);
  assert.match(above.reason, /重新触碰 MA20 10/);
  assert.doesNotMatch(above.reason, /尚未.*触碰/);
  const returned = f.observe(30, 10.1).proof;
  assert.equal(returned.diagnostic.stage, 'waiting-touch');
  assert.match(returned.reason, /尚未形成有效回踩序列/);
  assert.equal(pullbackPath(returned).remainingMs, undefined);
});

test('触碰范围与最低反弹幅度的无交集也可解释，恰好可行的边界仍确认', () => {
  for (const [changes, expected] of [
    [{ ma20: 9.8 }, /触碰锚点 MA20 9\.8 已低于区间下限/],
    [{ ma20: 10.3 }, /确认要求站上 MA20 10\.3/],
    [{ ma20: 9.91, entryHigh: 9.92 }, /反弹 0\.04 后至少达到 9\.94/]
  ]) {
    const f = fixture(); Object.assign(f.technical, changes);
    const proof = f.observe(0, 9.9, { open: 9.9, prevClose: 9.9 }).proof;
    assert.equal(proof.diagnostic.stage, 'no-overlap');
    assert.match(proof.reason, expected);
    assert.equal(pullbackPath(proof).minimumReboundPrice, 9.94);
  }
  const f = fixture(); Object.assign(f.technical, { ma20: 9.91, entryHigh: 9.94 });
  f.observe(0, 9.9, { open: 9.9, prevClose: 9.9 });
  const started = f.observe(10, 9.94, { open: 9.9, prevClose: 9.9 });
  assert.equal(started.proof.diagnostic.stage, 'confirming');
  const confirmed = f.observe(70, 9.94, { open: 9.9, prevClose: 9.9 });
  assert.equal(confirmed.proof.status, 'confirmed'); assert.equal(f.validate(confirmed).valid, true);
});

test('触碰后分别指出锚点、昨收、今开与最低反弹幅度尚未满足', () => {
  const f = fixture();
  const touched = f.observe(0, 9.98, { open: 10.04, prevClose: 10.05 }).proof;
  assert.equal(touched.diagnostic.stage, 'waiting-rebound');
  assert.deepEqual(pullbackPath(touched).unmet.map(item => item.label), ['锚点', '昨收', '今开', '最低反弹价']);
  assert.match(touched.reason, /站稳计时尚未开始/);
  const rising = f.observe(10, 10.01, { open: 10.04, prevClose: 10.05 }).proof;
  assert.deepEqual(pullbackPath(rising).unmet.map(item => item.label), ['昨收', '今开', '最低反弹价']);
  assert.equal(pullbackPath(rising).touchPrice, 9.98);
  assert.equal(pullbackPath(rising).reboundPrice, 10.02);
  assert.equal(f.observe(20, 10.03, { open: 10.04, prevClose: 10.05 }).proof.diagnostic.stage, 'waiting-rebound');
});

test('真实回升后才显示剩余时间，重复缓存不会推进计时，满60秒仍可验证', () => {
  const f = fixture();
  f.observe(0, 9.96);
  const started = f.observe(10, 10.08);
  assert.equal(started.proof.diagnostic.stage, 'confirming');
  assert.equal(pullbackPath(started.proof).remainingMs, 60000);
  const cached = f.tracker.observe(SYMBOL, 'swing', started.q, f.technical, f.regime, START + 40000);
  assert.equal(pullbackPath(cached).elapsedMs, 0);
  assert.equal(cached.checkedAt, started.proof.checkedAt);
  const waiting = f.observe(69, 10.1);
  assert.equal(pullbackPath(waiting.proof).elapsedMs, 59000);
  assert.equal(pullbackPath(waiting.proof).remainingMs, 1000);
  assert.match(waiting.proof.reason, /已累计 59 秒，还需至少 1 秒/);
  const confirmed = f.observe(70, 10.1);
  assert.equal(confirmed.proof.status, 'confirmed');
  assert.equal(f.validate(confirmed).valid, true);
  assert.equal(confirmed.proof.diagnostic, undefined);
});

test('补送历史报价的计时取观察时长和报价时长较短值', () => {
  const f = fixture();
  f.observe(0, 9.96, {}, 80);
  f.observe(10, 10.08, {}, 80);
  const pending = f.observe(70, 10.1, {}, 80).proof;
  assert.equal(pending.status, 'pending');
  assert.equal(pullbackPath(pending).elapsedMs, 0);
  assert.equal(pullbackPath(pending).remainingMs, 60000);
});

test('跌回锚点撤销计时，重新回升后重新显示完整60秒', () => {
  const f = fixture();
  f.observe(0, 9.96); f.observe(10, 10.08);
  assert.equal(pullbackPath(f.observe(40, 10.1).proof).remainingMs, 30000);
  const touched = f.observe(50, 9.98).proof;
  assert.equal(touched.diagnostic.stage, 'waiting-rebound');
  assert.equal(pullbackPath(touched).remainingMs, undefined);
  assert.equal(pullbackPath(f.observe(60, 10.1).proof).remainingMs, 60000);
});

test('回踩无交集但突破可用时显示独立突破阶段并仍可确认突破', () => {
  const f = fixture({ breakout: true });
  const observed = f.observe(0, 11.49, { open: 11, prevClose: 11 });
  assert.equal(pullbackPath(observed.proof).stage, 'no-overlap');
  assert.equal(observed.proof.diagnostic.path, 'breakout');
  assert.match(observed.proof.reason, /突破路径可检查/);
  assert.equal(observed.proof.diagnostic.paths.length, 2);
  const started = f.observe(10, 11.53, { open: 11, prevClose: 11 });
  assert.equal(started.proof.diagnostic.path, 'breakout');
  assert.equal(started.proof.diagnostic.stage, 'confirming');
  assert.match(started.proof.reason, /突破已开始站稳确认/);
  const confirmed = f.observe(70, 11.54, { open: 11, prevClose: 11 });
  assert.equal(confirmed.proof.path, 'breakout'); assert.equal(f.validate(confirmed).valid, true);
});

test('突破缺少实际穿越或越过追价上限时不显示站稳计时', () => {
  const f = fixture({ breakout: true });
  const above = f.observe(0, 11.55).proof;
  assert.equal(above.diagnostic.paths[1].stage, 'waiting-crossing');
  assert.match(above.reason, /当前需要重新观测从前高/);
  const chased = f.observe(10, 11.71).proof;
  assert.equal(chased.diagnostic.paths[1].stage, 'above-chase-limit');
  assert.match(chased.reason, /超过追价上限 11\.7/);
  assert.doesNotMatch(chased.reason, /还需.*秒/);
});

test('突破计时被追价上限撤销后再次入区间，准确提示须重新观察穿越', () => {
  const f = fixture({ breakout: true });
  f.observe(0, 11.49);
  const started = f.observe(10, 11.53).proof;
  assert.equal(started.diagnostic.paths[1].stage, 'confirming');
  assert.equal(f.observe(20, 11.71).proof.diagnostic.paths[1].stage, 'above-chase-limit');
  const returned = f.observe(30, 11.54).proof;
  assert.equal(returned.observations.length, 4);
  assert.equal(returned.diagnostic.paths[1].stage, 'waiting-crossing');
  assert.match(returned.reason, /当前需要重新观测从前高 11\.5 下方穿越/);
  assert.doesNotMatch(returned.reason, /尚未在本段|已累计|还需.*秒/);
  f.observe(40, 11.49);
  const restarted = f.observe(50, 11.53).proof;
  assert.equal(restarted.diagnostic.paths[1].remainingMs, 60000);
});

test('断流、基准和市场权限变化后从新序列诊断，数据失效与报价重置不携带旧倒计时', () => {
  for (const mutation of [
    f => { f.technical.ma20 += 0.01; },
    f => { f.regime.status = 'neutral'; },
    () => {}
  ]) {
    const f = fixture(); f.observe(0, 9.96); f.observe(10, 10.08);
    mutation(f);
    const reset = f.observe(110, 10.1).proof;
    assert.equal(reset.observations.length, 1);
    assert.equal(reset.diagnostic.stage, 'waiting-touch');
    assert.match(reset.diagnostic.resetReason, /重新累计观察/);
    assert.equal(pullbackPath(reset).remainingMs, undefined);
  }
  const f = fixture(); f.observe(0, 9.96); const started = f.observe(10, 10.08);
  const changed = f.observe(10, 10.09).proof;
  assert.equal(changed.diagnostic.stage, 'quote-reset');
  assert.equal(f.tracker.get(SYMBOL, 'swing', started.now), null);
  const stale = f.observe(0, 10.1, {}, 100).proof;
  assert.equal(stale.diagnostic.stage, 'quote-unavailable'); assert.equal(stale.observations, undefined);
  f.regime.allowEntry = false;
  assert.equal(f.observe(110, 10.1).proof.diagnostic.stage, 'market-unavailable');
  f.regime.allowEntry = true; f.technical.asOf = '2026-11-05';
  assert.equal(f.observe(120, 10.1).proof.diagnostic.stage, 'history-unavailable');
});

test('新增诊断不参与成交授权，旧已确认proof及旧pending原因仍兼容', () => {
  const f = fixture(); f.observe(0, 9.96); f.observe(10, 10.08);
  const confirmed = f.observe(70, 10.1), legacy = structuredClone(confirmed);
  delete legacy.proof.diagnostic;
  assert.equal(f.validate(legacy).valid, true);
  const forged = structuredClone(confirmed);
  forged.proof.observations[0].price = 10.1;
  forged.proof.diagnostic = { stage: 'confirming', remainingMs: 0 };
  assert.equal(f.validate(forged).valid, false);
  const oldPending = { ...confirmed, proof: { version: 1, template: 'observed-entry-v1', status: 'pending', reason: '旧保存等待原因' } };
  assert.equal(f.validate(oldPending).reason, '旧保存等待原因');
});
