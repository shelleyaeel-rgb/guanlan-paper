'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { AgencyService } = require('../core/agency-service.cjs');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const { enableMarketPolicy } = require('../core/market-policy.cjs');
const { ACTIVE_CANDIDATE_LIMIT } = require('../core/agency-capacity.cjs');
const { cnTime } = require('../core/common.cjs');
const { MARKET_REGIME_POLICY } = require('../core/market-regime.cjs');

const SYMBOL = 'sz000001';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  let now = Date.parse('2026-10-16T10:00:00+08:00'), price = 10.1, status = 'strong';
  let sampleHook = null, mainHook = null;
  const engine = new Engine(initialState(1000000), () => new Date(now));
  const quotes = {}, mainCalls = [], sampleCalls = [], accepted = [], decisions = [];
  engine.agencyTransfer({ strategyId: 'swing', amount: 500000 });
  engine.agencyMember({ strategyId: 'swing', symbol: SYMBOL, action: 'add' });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  enableMarketPolicy(engine.s);
  const transaction = fn => {
    const before = structuredClone(engine.s);
    try { const value = fn(); assert.equal(validState(engine.s), true); return value; }
    catch (error) { engine.s = before; throw error; }
  };
  const quote = (symbol = SYMBOL, extra = {}) => ({ symbol, name: '采样隔离测试', source: 'test', price,
    prevClose: 10.05, open: 10, low: 9.9, high: 10.3, volume: 100000, bid: price - 0.01,
    ask: price, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05,
    timestamp: now, date: cnTime(now).date, ...extra });
  const snapshot = (symbol = SYMBOL) => ({ source: 'test daily', fetchedAt: now,
    notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now, data: { items: [], total: 0 } },
    technical: { asOf: '2026-10-15', close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4, macd: 0.1,
      rsi: 55, volumeRatio: 1, trend: true, breakout: false, support: 9.7, resistance: 11.5,
      entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-10-15'] } });
  const regime = () => ({ version: 1, policyVersion: MARKET_REGIME_POLICY.version, status, label: status,
    riskMultiplier: status === 'weak' ? 0 : status === 'strong' ? 1 : 0.5,
    allowEntry: status !== 'weak', allowBreakout: status === 'strong', checkedAt: now,
    expiresAt: now + 90000, date: cnTime(now).date, reasons: ['隔离行情'],
    metrics: { highVolatility: false }, evidence: { quoteTime: now,
      indexQuoteTimes: { sh000001: now, sz399001: now, sz399006: now }, breadthQuoteTime: now, breadthFetchedAt: now } });
  const monitor = new StrategyMonitor({ strategyHistory: async () => { throw Error('交易不可获取日线'); } }, () => new Date(now));
  monitor.snapshots[SYMBOL] = snapshot();
  const service = new AgencyService({ getEngine: () => engine, transaction, getQuotes: () => quotes,
    acceptQuotes: batch => { accepted.push(structuredClone(batch)); Object.assign(quotes, batch); },
    market: { quotes: async symbols => { mainCalls.push([...symbols]); if (mainHook) await mainHook(symbols, mainCalls.length); return Object.fromEntries(symbols.map(symbol => [symbol, quote(symbol)])); } },
    entryMarket: { quotes: async symbols => { sampleCalls.push([...symbols]); return sampleHook ? sampleHook(symbols) : Object.fromEntries(symbols.map(symbol => [symbol, quote(symbol)])); } },
    monitor, getMarketRegime: regime, clock: () => now });
  const evaluate = service.runner.evaluateRules;
  service.runner.evaluateRules = input => { const result = evaluate(input); decisions.push(...result.decisions); return result; };
  return { engine, service, quotes, mainCalls, sampleCalls, accepted, decisions, quote, snapshot, regime,
    add: symbol => { monitor.snapshots[symbol] = snapshot(symbol); return engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' }); },
    track: (symbol = SYMBOL, snap = snapshot(symbol), q = quote(symbol)) => service.trackEntry(symbol, 'swing', q, snap),
    advance: ms => { now += ms; }, setPrice: value => { price = value; }, setRegime: value => { status = value; },
    samples: fn => { sampleHook = fn; }, main: fn => { mainHook = fn; },
    run: async () => { await service.poll({ force: true }); await service.runner.drain(); } };
}

test('候选采样使用独立行情通道，慢采样不阻塞主轮询，也不并发重复采样', async () => {
  const f = fixture(), wait = deferred(); f.track(); f.samples(() => wait.promise);
  let sampled = false;
  const pending = f.service.sampleEntries().then(() => { sampled = true; });
  try {
    assert.equal(f.sampleCalls.length, 1); assert.equal(f.mainCalls.length, 0);
    const repeated = f.service.sampleEntries();
    await f.run();
    assert.equal(sampled, false, '主轮询已完成时采样仍在等待自己的数据源');
    assert.ok(f.mainCalls.length > 0); assert.equal(f.sampleCalls.length, 1);
    assert.equal(f.service.publicState().coverage.swing.processed, 1);
    wait.resolve({ [SYMBOL]: f.quote() }); await Promise.all([pending, repeated]);
  } finally { wait.resolve({}); await pending; }
});

test('仅采样20只活跃候选，65只候补不采样，轻量快照不复制公告及研究正文', async () => {
  const f = fixture(), symbols = [SYMBOL, ...Array.from({ length: 84 }, (_, index) => `sh${600001 + index}`)];
  for (const [index, symbol] of symbols.entries()) {
    if (symbol !== SYMBOL) f.add(symbol);
    const snapshot = { ...f.snapshot(symbol), automaticEvidence: { documents: [{ text: '大量研究正文'.repeat(1000) }] },
      selectionEvidence: { records: [{ text: '研究' }] }, marketRegime: f.regime(), entryConfirmation: { status: 'old' } };
    f.track(symbol, snapshot, f.quote(symbol, { price: index < 80 ? 10.1 : 10.7 }));
  }
  assert.equal(f.service.entryContexts.size, 80);
  for (const context of f.service.entryContexts.values()) {
    assert.deepEqual(Object.keys(context.snapshot).sort(), ['fetchedAt', 'source', 'technical']);
    assert.equal(context.snapshot.technical.asOf, '2026-10-15');
  }
  await f.service.sampleEntries();
  assert.equal(f.service.entryContexts.size, ACTIVE_CANDIDATE_LIMIT, '采样前清除候补上下文');
  assert.equal(f.engine.s.agency.groups.find(group => group.id === 'swing').members.filter(member => member.mode === 'standby').length, symbols.length - ACTIVE_CANDIDATE_LIMIT);
  assert.equal(f.sampleCalls.length, 1); assert.equal(f.sampleCalls[0].length, ACTIVE_CANDIDATE_LIMIT);
  assert.deepEqual(new Set(f.sampleCalls[0]), new Set(symbols.slice(0, ACTIVE_CANDIDATE_LIMIT)));
  assert.equal(f.mainCalls.length, 0);
  f.track(SYMBOL, f.snapshot(), f.quote(SYMBOL, { price: 15 }));
  assert.equal(f.service.entryContexts.has(SYMBOL), false);
});

test('四组80只活跃候选均进入独立采样通道，第21只候补不采样且采样不下单', async () => {
  const f = fixture(), activeSymbols = [], standbySymbols = [];
  for (const [groupIndex, group] of f.engine.s.agency.groups.entries()) {
    f.engine.agencyMode({ strategyId: group.id, mode: 'running' });
    for (let index = group.members.length; index <= ACTIVE_CANDIDATE_LIMIT; index++)
      f.engine.agencyMember({ strategyId: group.id, symbol: `sh${601000 + groupIndex * 100 + index}`, action: 'add' });
    for (const member of group.members) {
      if (member.mode === 'standby') { standbySymbols.push(member.symbol); continue; }
      activeSymbols.push(member.symbol);
      f.service.trackEntry(member.symbol, group.id, f.quote(member.symbol), f.snapshot(member.symbol));
    }
  }
  assert.equal(activeSymbols.length, 80); assert.equal(standbySymbols.length, f.engine.s.agency.groups.length);
  assert.equal(f.service.entryContexts.size, activeSymbols.length);
  await f.service.sampleEntries();
  assert.equal(f.sampleCalls.length, 1);
  assert.deepEqual(new Set(f.sampleCalls[0]), new Set(activeSymbols));
  assert.ok(standbySymbols.every(symbol => !f.sampleCalls[0].includes(symbol)));
  assert.equal(f.service.entryContexts.size, activeSymbols.length);
  assert.equal(f.mainCalls.length, 0); assert.equal(f.engine.s.trades.length, 0); assert.equal(validState(f.engine.s), true);
});

test('慢采样返回时身份、持仓或权限已变化，不能写回行情或重建旧确认', async () => {
  for (const change of ['replaced', 'removed', 'paused', 'holding', 'invalidated', 'stopped']) {
    const f = fixture(), wait = deferred(); f.track(); f.samples(() => wait.promise);
    const pending = f.service.sampleEntries();
    if (change === 'replaced') { f.advance(1); f.track(); }
    if (change === 'removed') f.engine.agencyMember({ strategyId: 'swing', symbol: SYMBOL, action: 'remove' });
    if (change === 'paused') f.engine.agencyMode({ strategyId: 'swing', mode: 'paused' });
    if (change === 'holding') f.engine.s.lots.push({ symbol: SYMBOL, owner: 'swing', quantity: 100, cost: 100000, date: '2026-10-16' });
    if (change === 'invalidated') f.service.invalidate();
    if (change === 'stopped') f.service.stop();
    wait.resolve({ [SYMBOL]: f.quote() }); await pending;
    assert.equal(f.quotes[SYMBOL], undefined, change);
    assert.equal(f.service.entryTracker.get(SYMBOL, 'swing', f.service.clock()), null, change);
    assert.equal(f.service.entrySampling, null, change);
  }
});

test('采样旧时间戳不能覆盖主轮询更新的行情，更新或相同时间戳可正常接收', async () => {
  for (const lag of [-1, 0, 1]) {
    const f = fixture(), wait = deferred(); f.track(); f.samples(() => wait.promise);
    const pending = f.service.sampleEntries(), sampled = f.quote();
    f.quotes[SYMBOL] = f.quote(SYMBOL, { timestamp: sampled.timestamp - lag, price: 10.2, ask: 10.2 });
    const current = structuredClone(f.quotes[SYMBOL]);
    wait.resolve({ [SYMBOL]: sampled }); await pending;
    if (lag < 0) {
      assert.deepEqual(f.quotes[SYMBOL], current);
      assert.equal(f.service.entryTracker.get(SYMBOL, 'swing', f.service.clock()), null);
    } else assert.deepEqual(f.quotes[SYMBOL], sampled);
  }
});

test('弱市转强后使用最新市场快照并重新累计回踩，弱市旧价格不能生成确认', async () => {
  const f = fixture(); f.setRegime('weak'); f.setPrice(9.96);
  f.track(SYMBOL, { ...f.snapshot(), marketRegime: f.regime() });
  await f.service.sampleEntries();
  assert.equal(f.service.entryTracker.get(SYMBOL, 'swing', f.service.clock()), null);
  f.setRegime('strong'); f.advance(10000); f.setPrice(10.08); await f.service.sampleEntries();
  f.advance(60000); f.setPrice(10.1); await f.service.sampleEntries();
  let proof = f.service.entryTracker.get(SYMBOL, 'swing', f.service.clock());
  assert.equal(proof.marketStatus, 'strong'); assert.equal(proof.status, 'pending');
  f.advance(1000); f.setPrice(9.98); await f.service.sampleEntries();
  f.advance(10000); f.setPrice(10.08); await f.service.sampleEntries();
  f.advance(60000); f.setPrice(10.1); await f.service.sampleEntries();
  proof = f.service.entryTracker.get(SYMBOL, 'swing', f.service.clock());
  assert.equal(proof.status, 'confirmed'); assert.equal(proof.path, 'pullback'); assert.equal(proof.marketStatus, 'strong');
  assert.equal(proof.observations[0].price, 10.08, '弱市价格未进入强市确认的原始时序');
});

test('候选在强市通过但提交前转弱，事务重新记录市场权限并拒绝成交', async () => {
  const f = fixture(); f.track();
  f.setPrice(9.96); await f.service.sampleEntries();
  f.advance(10000); f.setPrice(10.08); await f.service.sampleEntries();
  f.advance(60000); f.setPrice(10.1); await f.service.sampleEntries();
  assert.equal(f.service.entryTracker.get(SYMBOL, 'swing', f.service.clock()).status, 'confirmed');
  f.main((_symbols, count) => { if (count === 2) f.setRegime('weak'); });
  await f.run();
  assert.ok(f.decisions.some(decision => decision.symbol === SYMBOL && decision.action === 'buy'), '候选阶段确实产生了买入意向');
  assert.equal(f.mainCalls.length, 2); assert.equal(f.engine.s.trades.length, 0);
  const blocked = f.engine.s.agency.decisions.find(entry => entry.status === 'blocked' && entry.executionCheck);
  assert.ok(blocked); assert.equal(blocked.executionCheck.buyable, false);
  assert.equal(blocked.executionCheck.marketRegime.status, 'weak');
  assert.equal(blocked.executionCheck.marketRegime.allowEntry, false);
  assert.equal(f.service.entryTracker.get(SYMBOL, 'swing', f.service.clock()), null);
  assert.equal(validState(f.engine.s), true);
});
