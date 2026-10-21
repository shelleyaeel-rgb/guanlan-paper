const test = require('node:test');
const assert = require('node:assert/strict');
const { EntryConfirmationTracker, validateEntryConfirmation } = require('../core/entry-confirmation.cjs');
const { evaluateEntry } = require('../core/strategy.cjs');
const { Engine, initialState } = require('../core/engine.cjs');
const { cnTime } = require('../core/common.cjs');

const symbol = 'sz000001';
function fixture() {
  const started = Date.parse('2026-10-16T10:00:00+08:00');
  let now = started;
  const engine = new Engine(initialState(100000), () => new Date(now));
  engine.s.agency.marketPolicy = { enabled: true }; engine.s.marketAdaptiveEntry = true;
  const tracker = new EntryConfirmationTracker();
  const level = { entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, support: 9.7, resistance: 11.5 };
  const technical = { asOf: '2026-10-15', close: 10.05, ma5: 10.03, previousMa5: 10.02, ma20: 10, previousMa20: 9.99,
    ma60: 9.5, previousMa60: 9.49, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1.5, trend: true, breakout: false,
    dates: ['2026-10-15'], ...level, levels: { short: { ...level }, 'ultra-short': { ...level }, long: { ...level, entryLow: 9.4, entryHigh: 9.8 } } };
  const regime = { version: 1, status: 'strong', allowEntry: true, allowBreakout: true, riskMultiplier: 1, checkedAt: started, expiresAt: started + 1800000 };
  const quote = (price = 10.1, extra = {}) => ({ symbol, source: '腾讯财经', name: '隔离样本', price, ask: price, bid: price - 0.01,
    prevClose: 10.05, open: 10, high: 12, low: 9.9, volume: 100000, amount: 3e8, turnover: 4,
    askSize: 20000, bidSize: 20000, timestamp: now, date: cnTime(now).date, limitUp: 12.8, limitDown: 9.04, ...extra });
  const snapshot = proof => ({ technical, source: '隔离日线', fetchedAt: now, marketRegime: regime, entryConfirmation: proof,
    notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now, checkedAt: now, data: { items: [], total: 0 } } });
  const observe = (seconds, price, strategyId = 'swing', extra = {}) => {
    now = started + seconds * 1000; const q = quote(price, extra);
    return { q, proof: tracker.observe(symbol, strategyId, q, technical, regime, now) };
  };
  const validate = (proof, q, strategyId = 'swing') => validateEntryConfirmation(proof, { symbol, strategyId, quote: q, technical, regime, now });
  const evaluate = (proof, q) => evaluateEntry(engine, symbol, q, snapshot(proof));
  return { started, engine, tracker, technical, regime, quote, snapshot, observe, validate, evaluate, at: seconds => { now = started + seconds * 1000; }, now: () => now };
}
function pullback(f) { f.observe(0, 9.96); f.observe(10, 10.08); return f.observe(70, 10.1); }
function breakout(f) { f.observe(0, 11.49); f.observe(10, 11.53); return f.observe(70, 11.54); }

test('真实回踩、回升和站稳满60秒才通过，盘中high/low不能替代观察', () => {
  const f = fixture();
  let seen = f.observe(0, 10.1, 'swing', { low: 9.9, high: 10.5 });
  seen = f.observe(70, 10.1);
  assert.equal(seen.proof.status, 'pending');
  assert.equal(f.evaluate(seen.proof, seen.q).buyable, false);
  f.tracker.clear();
  f.observe(80, 9.96); f.observe(90, 10.08);
  seen = f.observe(149, 10.1); assert.equal(seen.proof.status, 'pending');
  seen = f.observe(150, 10.1);
  assert.equal(seen.proof.status, 'confirmed'); assert.equal(seen.proof.path, 'pullback');
  assert.equal(f.validate(seen.proof, seen.q).valid, true);
  const plan = f.evaluate(seen.proof, seen.q);
  assert.equal(plan.buyable, true, plan.reasons.join('；'));
  assert.equal(plan.plan.entryMode, 'pullback'); assert.ok(plan.economics.rewardRisk >= 2);
  assert.equal(plan.plan.stop, 9.6); assert.equal(plan.plan.target, 11.5);
});

test('下跌途中、跌回锚点和重复缓存不推进确认', () => {
  const f = fixture();
  f.observe(0, 9.98); f.observe(40, 9.96);
  assert.equal(f.observe(80, 9.94).proof.status, 'pending');
  f.tracker.clear(); f.observe(90, 9.96); const rising = f.observe(100, 10.08);
  f.at(160);
  assert.equal(f.tracker.observe(symbol, 'swing', rising.q, f.technical, f.regime, f.now()).status, 'pending');
  f.observe(170, 9.98);
  assert.equal(f.observe(180, 10.1).proof.status, 'pending', '重新站回锚点须重计60秒');
});

test('确认严格绑定源报价、股票、技术基准与市场状态并重放证据', () => {
  const f = fixture(), { q, proof } = pullback(f);
  for (const changed of [{ price: 10.11 }, { timestamp: q.timestamp + 1 }, { source: '其他来源' }, { symbol: 'sh600000' }]) {
    assert.equal(f.validate(proof, { ...q, ...changed }).valid, false);
  }
  const forged = structuredClone(proof); forged.observations[0].price = 10.1;
  assert.equal(f.validate(forged, q).valid, false);
  f.technical.ma20 += 0.01; assert.equal(f.validate(proof, q).valid, false); f.technical.ma20 -= 0.01;
  f.regime.status = 'neutral'; f.regime.allowBreakout = false; f.regime.riskMultiplier = 0.5;
  assert.equal(f.validate(proof, q).valid, false);
  assert.equal(f.observe(80, 10.1).proof.status, 'pending');
});

test('断线、过期、跨日、旧报价及相同时间戳变化使确认失效', () => {
  for (const seconds of [161, 86470]) {
    const f = fixture(), { q, proof } = pullback(f); f.at(seconds);
    assert.equal(f.validate(proof, q).valid, false); assert.equal(f.tracker.get(symbol, 'swing', f.now()), null);
  }
  const f = fixture(); const seen = pullback(f);
  assert.equal(f.observe(170, 10.1).proof.status, 'pending');
  const g = fixture(), valid = pullback(g);
  assert.equal(g.tracker.observe(symbol, 'swing', { ...valid.q, price: 10.11 }, g.technical, g.regime, g.now()).status, 'pending');
  assert.equal(g.tracker.get(symbol, 'swing', g.now()), null);
  assert.equal(f.validate(seen.proof, seen.q).valid, false);
});

test('批量送入过去报价不能冒充程序已经连续观察60秒', () => {
  const f = fixture(); f.at(80);
  const observePast = (seconds, price) => f.tracker.observe(symbol, 'swing', f.quote(price, { timestamp: f.started + seconds * 1000 }), f.technical, f.regime, f.now());
  observePast(0, 9.96); observePast(10, 10.08);
  assert.equal(observePast(70, 10.1).status, 'pending');
});

test('强市突破必须从下方实际穿越后站稳，采用固定ATR止损与模型目标', () => {
  const f = fixture(), { q, proof } = breakout(f), plan = f.evaluate(proof, q);
  assert.equal(proof.path, 'breakout'); assert.equal(plan.buyable, true, plan.reasons.join('；'));
  assert.equal(plan.plan.stop, 11.3); assert.equal(plan.plan.target, 12.7);
  assert.equal(plan.plan.entryHigh, 11.7); assert.match(plan.plan.targetBasis, /非历史阻力/);
  assert.match(plan.plan.entryConfirmation.limitation, /未完成样本外验证/);
  const g = fixture(); g.observe(0, 11.53); g.observe(10, 11.55);
  assert.equal(g.observe(70, 11.56).proof.status, 'pending');
});

test('突破不向中性市、长线开放，超买和追价上限不能绕过', () => {
  const neutral = fixture(); neutral.regime.status = 'neutral'; neutral.regime.allowBreakout = false;
  assert.equal(breakout(neutral).proof.status, 'pending');
  const long = fixture(); long.observe(0, 11.49, 'long'); long.observe(10, 11.53, 'long');
  assert.equal(long.observe(70, 11.54, 'long').proof.status, 'pending');
  const f = fixture(); f.observe(0, 11.49); f.observe(10, 11.53); const chased = f.observe(70, 11.69, 'swing', { ask: 11.7 });
  assert.equal(chased.proof.status, 'confirmed'); assert.equal(f.evaluate(chased.proof, chased.q).buyable, false, '含滑点价格也须受追价上限约束');
  assert.equal(f.observe(80, 11.71).proof.status, 'pending');
  const overbought = fixture(); overbought.technical.rsi = 76; const seen = breakout(overbought);
  assert.equal(overbought.evaluate(seen.proof, seen.q).status, '等待趋势');
});

test('市场gate或自动facade任一未启用都保留旧规则，持仓始终不加仓不换计划', () => {
  const f = fixture(), q = f.quote();
  assert.equal(f.evaluate(null, q).buyable, false);
  f.engine.s.marketAdaptiveEntry = false; assert.equal(f.evaluate(null, q).buyable, true);
  f.engine.s.marketAdaptiveEntry = true; f.engine.s.agency.marketPolicy.enabled = false;
  assert.equal(f.evaluate(null, q).buyable, true);
  f.engine.strategyEntry({ symbol, quantity: 100 }, q, f.snapshot(null));
  const original = structuredClone(f.engine.s.risks[symbol]);
  f.engine.s.agency.marketPolicy.enabled = true; f.regime.status = 'weak'; f.regime.allowEntry = false;
  const held = f.evaluate(null, q); assert.equal(held.status, '持仓跟踪'); assert.equal(held.buyable, false);
  assert.equal(held.plan.stop, original.stop); assert.equal(held.plan.target, original.target);
  assert.deepEqual(f.engine.s.risks[symbol], original);
});

test('时序通过仍复核公告、费用、资金与一档流动性', () => {
  const f = fixture(), { q, proof } = pullback(f);
  assert.equal(f.evaluate(proof, { ...q, askSize: 99 }).buyable, false);
  f.engine.s.settings.commission = 0.01; f.engine.s.strategySettings.minRewardRisk = 5;
  assert.equal(f.evaluate(proof, q).buyable, false);
  f.engine.s.settings.commission = 0.00025; f.engine.s.strategySettings.minRewardRisk = 2;
  const snap = f.snapshot(proof); snap.notices.status = 'error';
  assert.equal(evaluateEntry(f.engine, symbol, q, snap).buyable, false);
  f.engine.s.cash = 1; assert.equal(f.evaluate(proof, q).buyable, false);
});
