'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { cnTime } = require('../core/common.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');
const { prepareHistory } = require('../core/daily-history.cjs');
const { usableTechnical, evaluateEntry, technicals } = require('../core/strategy.cjs');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const { createEntryConditions, evaluateEntryConditions } = require('../core/entry-conditions.cjs');
const { AgencyService, candidateData } = require('../core/agency-service.cjs');
const { RULES_VERSION } = require('../core/agency-rules.cjs');

const SYMBOL = 'sz000001', NOW = Date.parse('2026-10-22T10:00:00+08:00');
const FETCHED = Date.parse('2026-10-22T09:00:00+08:00');
const condition = createEntryConditions({ rules: [{ field: 'ma20', op: 'gt', value: 9 }] }, new Date(NOW));
function bars() {
  const result = [];
  for (let cursor = Date.parse('2026-10-21T10:00:00+08:00'); result.length < 80; cursor -= 86400000) {
    if (calendarSession(new Date(cursor)).open) result.unshift({ date: cnTime(cursor).date, open: 10, close: 10.05, high: 10.2, low: 9.8, volume: 10000 });
  }
  return result;
}
function history(at = FETCHED) {
  const entry = prepareHistory(SYMBOL, 'stock', { bars: bars(), source: '腾讯财经', provider: 'tencent', adjustment: '未复权', fetchedAt: at }, at);
  assert.ok(entry, 'fixture has complete trading sessions through the latest completed trading day');
  return entry;
}
function snapshot(at = NOW) {
  const entry = history();
  return { ...entry, historyStatus: 'degraded', refreshError: 'HTTP 501', technical: {
    ...technicals(entry.bars, new Date(at)), ma5: 10, ma20: 10, ma60: 9.5,
    atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false,
    support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5 },
    notices: { symbol: SYMBOL, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: at, data: { items: [], total: 0 } },
    corporateActions: { symbol: SYMBOL, status: 'ready', source: '隔离测试公司行为', fetchedAt: at,
      coverageStart: '2026-01-01', coverageEnd: cnTime(at).date, coverageComplete: true, events: [], notices: [] } };
}
function quote(at = NOW, extra = {}) {
  return { symbol: SYMBOL, name: '日线缓存隔离测试', source: '腾讯财经', price: 10.1, prevClose: 10.05,
    open: 10, low: 10, high: 10.2, volume: 100000, bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000,
    limitUp: 11.05, limitDown: 9.05, timestamp: at, date: cnTime(at).date, ...extra };
}
function account(at = NOW) {
  const engine = new Engine(initialState(100000), () => new Date(at));
  engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
  engine.agencyMember({ strategyId: 'swing', symbol: SYMBOL, action: 'add' });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  return engine;
}
const member = engine => engine.s.agency.groups.find(group => group.id === 'swing').members[0];

test('已准备完整日线盘中超过三分钟仍可入场，刷新501作为降级诊断保留', () => {
  const snap = snapshot(), q = quote(), engine = account();
  assert.equal(usableTechnical(snap, q, new Date(NOW)), snap.technical);
  assert.equal(evaluateEntryConditions(condition, SYMBOL, q, snap, new Date(NOW)).passed, true);
  assert.equal(engine.agencyAutomaticBlock(SYMBOL, q, snap), null);
  const evaluation = engine.agencyEvaluate('swing', SYMBOL, q, snap);
  assert.equal(evaluation.buyable, true, evaluation.reasons.join('；'));
  assert.equal(evaluation.dailyHistory.fetchedAt, FETCHED);
  assert.equal(evaluation.dailyHistory.refreshError, 'HTTP 501');
  assert.equal(member(engine).automaticCheck.dailyHistory.status, 'degraded');
  assert.equal(validState(engine.s), true);
});

test('无日线证据的旧快照仍按三分钟过期，重新尝试时间不续期', () => {
  const snap = snapshot(); delete snap.dailyEvidence; snap.attemptedAt = NOW;
  const q = quote(), engine = account();
  assert.throws(() => usableTechnical(snap, q, new Date(NOW)), /过期/);
  assert.equal(evaluateEntryConditions(condition, SYMBOL, q, snap, new Date(NOW)).status, 'pending');
  assert.match(engine.agencyAutomaticBlock(SYMBOL, q, snap), /过期/);
  assert.equal(engine.agencyEvaluate('swing', SYMBOL, q, snap).buyable, false);
});

test('失效的新证据即使获取时间很新也不能回落三分钟兼容门槛', () => {
  for (const change of [snap => { snap.dailyEvidence = null; }, snap => { snap.dailyEvidence.symbol = 'sh600519'; },
    snap => { snap.dailyEvidence.asOf = '2026-10-20'; }, snap => { snap.dailyEvidence.close = 9; },
    snap => { snap.dailyEvidence.source = '其他来源'; }, snap => { snap.technical.dates.pop(); }]) {
    const snap = snapshot(); snap.fetchedAt = NOW; snap.dailyEvidence.fetchedAt = NOW; change(snap);
    const q = quote(), engine = account();
    assert.throws(() => usableTechnical(snap, q, new Date(NOW)), /证据已失效/);
    assert.equal(evaluateEntryConditions(condition, SYMBOL, q, snap, new Date(NOW)).status, 'pending');
    assert.match(engine.agencyAutomaticBlock(SYMBOL, q, snap), /日线证据无效/);
    assert.equal(member(engine).automaticCheck.dailyHistory, null);
    assert.equal(engine.agencyEvaluate('swing', SYMBOL, q, snap).buyable, false);
    const evaluation = evaluateEntry(engine, SYMBOL, q, snap);
    assert.equal(evaluation.buyable, false); assert.equal(evaluation.dailyHistory, null);
  }
});

test('盘中复用完整日线不放宽报价时效、盘口和价格基准', () => {
  for (const extra of [{ timestamp: NOW - 90001 }, { canTrade: false }, { askSize: 0 }, { prevClose: 9 }]) {
    const snap = snapshot(), q = quote(NOW, extra), engine = account();
    assert.equal(engine.agencyEvaluate('swing', SYMBOL, q, snap).buyable, false, JSON.stringify(extra));
    if (extra.timestamp || extra.prevClose) assert.equal(evaluateEntryConditions(condition, SYMBOL, q, snap, new Date(NOW)).passed, false);
    if (extra.prevClose) {
      assert.match(engine.agencyAutomaticBlock(SYMBOL, q, snap), /价格基准不一致/);
      assert.equal(member(engine).automaticCheck.dailyHistory.refreshError, 'HTTP 501');
    }
    assert.equal(engine.s.trades.length, 0);
  }
});

test('已有持仓的可用日线缓存不解除公司行为未核验与对账阻断', () => {
  const snap = snapshot(), q = quote(), engine = account();
  engine.agencyExecute({ strategyId: 'swing', symbol: SYMBOL, action: 'buy', targetPercent: 20,
    decisionId: 'held-before-corporate-failure', expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, q, snap);
  Object.assign(snap.corporateActions, { status: 'unavailable', coverageComplete: false, error: '公司行为来源断线' });
  assert.match(engine.agencyAutomaticBlock(SYMBOL, q, snap), /公司行为来源断线/);
  assert.equal(member(engine).automaticCheck.dailyHistory.refreshError, 'HTTP 501');
  assert.equal(member(engine).reconciliation.status, 'pending');
  assert.equal(engine.agencyEvaluate('swing', SYMBOL, q, snap).buyable, false);
  assert.equal(engine.s.trades.length, 1);
});

test('盘前复用有效日线只标记准备，跨交易日旧证据不能继续授权', () => {
  const beforeOpen = Date.parse('2026-10-22T09:10:00+08:00'), engine = account(beforeOpen), snap = snapshot(beforeOpen);
  assert.match(engine.agencyPrepare(SYMBOL, undefined, snap), /等待开盘后实时行情/);
  assert.equal(member(engine).automaticCheck.phase, 'prepared');
  assert.equal(member(engine).automaticCheck.dailyHistory.fetchedAt, FETCHED);
  assert.equal(member(engine).lastVerifiedDate, undefined);
  const nextDay = Date.parse('2026-10-23T10:00:00+08:00');
  assert.throws(() => usableTechnical(snap, quote(nextDay), new Date(nextDay)), /证据已失效/);
  assert.equal(evaluateEntryConditions(condition, SYMBOL, quote(nextDay), snap, new Date(nextDay)).status, 'pending');
});

test('监控保留上游原始获取时间与日线降级证据，失败不自行回退旧信号', async () => {
  const entry = { ...history(), historyStatus: 'degraded', refreshError: 'HTTP 501', cacheWarning: '持久化暂不可用' };
  let failed = false;
  const monitor = new StrategyMonitor({ strategyHistory: async () => { if (failed) throw Error('无有效缓存'); return entry; } }, () => new Date(NOW));
  const snap = await monitor.load(SYMBOL);
  assert.equal(snap.fetchedAt, FETCHED); assert.equal(snap.attemptedAt, NOW); assert.equal(snap.error, undefined);
  assert.deepEqual(snap.dailyEvidence, entry.dailyEvidence); assert.notEqual(snap.dailyEvidence, entry.dailyEvidence);
  assert.equal(snap.historyStatus, 'degraded'); assert.equal(snap.refreshError, 'HTTP 501'); assert.equal(snap.cacheWarning, entry.cacheWarning);
  failed = true;
  const unavailable = await monitor.load(SYMBOL, true);
  assert.match(unavailable.error, /无有效缓存/); assert.equal(unavailable.technical, undefined); assert.equal(unavailable.dailyEvidence, undefined);
});

test('旧数组测试替身仍生成本次时间，对象响应缺失获取时间不能被监控补新', async () => {
  const legacy = new StrategyMonitor({ strategyHistory: async () => bars() }, () => new Date(NOW));
  assert.equal((await legacy.load(SYMBOL)).fetchedAt, NOW);
  const monitor = new StrategyMonitor({ strategyHistory: async () => ({ bars: bars(), source: '腾讯财经' }) }, () => new Date(NOW));
  const snap = await monitor.load(SYMBOL);
  assert.equal(snap.fetchedAt, undefined); assert.throws(() => usableTechnical(snap, quote(), new Date(NOW)), /过期/);
});

test('监控保留显式无效日线标志，刚下载的滞后序列不会成为旧版兼容快照', async () => {
  const monitor = new StrategyMonitor({ strategyHistory: async () => ({ bars: bars(), source: '腾讯财经', fetchedAt: NOW, dailyEvidence: null }) }, () => new Date(NOW));
  const snap = await monitor.load(SYMBOL);
  assert.equal(snap.dailyEvidence, null); assert.equal(snap.fetchedAt, NOW);
  assert.throws(() => usableTechnical(snap, quote(), new Date(NOW)), /证据已失效/);
  assert.equal(evaluateEntryConditions(condition, SYMBOL, quote(), snap, new Date(NOW)).status, 'pending');
});

test('盘中采样上下文与决策来源保留完整日线证据及降级原因', () => {
  const engine = account(), snap = snapshot(), q = quote();
  engine.s.agency.marketPolicy = { enabled: true };
  const service = new AgencyService({ getEngine: () => engine, clock: () => NOW });
  service.trackEntry(SYMBOL, 'swing', q, snap);
  const context = service.entryContexts.get(SYMBOL).snapshot;
  assert.deepEqual(context.dailyEvidence, snap.dailyEvidence); assert.notEqual(context.dailyEvidence, snap.dailyEvidence);
  assert.equal(context.fetchedAt, FETCHED); assert.equal(context.provider, 'tencent'); assert.equal(context.historyStatus, 'degraded'); assert.equal(context.refreshError, 'HTTP 501');
  const candidate = candidateData(SYMBOL, q, snap, { buyable: false }, null, { equity: 5000000 });
  const source = candidate.sources.find(item => item.kind === 'completed-unadjusted-daily');
  assert.deepEqual(source.dailyEvidence, snap.dailyEvidence); assert.equal(source.status, 'degraded'); assert.equal(source.refreshError, 'HTTP 501');
  snap.dailyEvidence.source = '后来修改';
  assert.equal(context.dailyEvidence.source, '腾讯财经'); assert.equal(source.dailyEvidence.source, '腾讯财经');
});

test('显式资料刷新可复用有效日线并强制更新其他模块，完整手动重验仍刷新日线', async () => {
  const requests = [], entry = history();
  const research = {
    getFinanceWithIndustry: async input => { requests.push({ section: 'finance', force: input.force }); return { status: 'ready', fetchedAt: NOW }; },
    get: async input => { requests.push({ section: input.section, force: input.force }); return { symbol: SYMBOL, status: 'empty', fetchedAt: NOW, data: { items: [], total: 0 } }; }
  };
  const corporate = { symbols: () => [SYMBOL], getSnapshot: async (_symbol, force) => { requests.push({ section: 'corporate', force }); return snapshot().corporateActions; } };
  const market = { strategyHistory: async (_symbol, _signal, _metadata, force) => { requests.push({ section: 'daily', force }); return entry; } };
  const monitor = new StrategyMonitor(market, () => new Date(NOW), () => {}, research, corporate);
  const automatic = await monitor.load(SYMBOL, true, true, true, { refreshDaily: false });
  assert.equal(automatic.dailyForced, false); assert.equal(automatic.forced, true); assert.equal(automatic.fetchedAt, FETCHED);
  assert.deepEqual(requests.find(item => item.section === 'daily'), { section: 'daily', force: false });
  assert.ok(['finance', 'valuation', 'notices', 'corporate'].every(section => requests.some(item => item.section === section && item.force === true)));
  requests.length = 0;
  const manual = await monitor.load(SYMBOL, true, true, true);
  assert.equal(manual.dailyForced, true); assert.deepEqual(requests.find(item => item.section === 'daily'), { section: 'daily', force: true });
});

test('在途资料刷新不吞掉随后手动重验日线，手动请求等待独立强刷完成', async () => {
  const entry = history(), calls = [], releases = [];
  const monitor = new StrategyMonitor({ strategyHistory: (_symbol, _signal, _metadata, force) => {
    calls.push(force); return new Promise(resolve => releases.push(() => resolve(entry)));
  } }, () => new Date(NOW), () => {}, { get: async () => snapshot().notices });
  const ordinary = monitor.load(SYMBOL);
  const automatic = monitor.load(SYMBOL, true, false, true, { refreshDaily: false });
  const manual = monitor.load(SYMBOL, true, false, true);
  assert.deepEqual(calls, [false]); releases[0](); await ordinary;
  await new Promise(resolve => setImmediate(resolve));
  const automaticResult = await automatic;
  assert.equal(automaticResult.dailyForced, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [false, true], '资料刷新复用日线，手动重验仍独立强制请求'); releases[1]();
  const manualResult = await manual;
  assert.notEqual(manualResult, automaticResult); assert.equal(manualResult.dailyForced, true);
  assert.equal(monitor.inflight.size, 0); assert.equal(monitor.nextForced.size, 0);
});

test('自动买入提交只请求报价，使用已准备日线且零资料调用完成隔离模拟成交', async () => {
  const engine = account(), snap = snapshot(), q = quote(), loads = [], quotes = { [SYMBOL]: q };
  const monitor = new StrategyMonitor({ strategyHistory: async (...args) => { loads.push(args); throw Error('交易不可获取日线'); } }, () => new Date(NOW));
  monitor.snapshots[SYMBOL] = snap;
  let quoteCalls = 0;
  const service = new AgencyService({ getEngine: () => engine, clock: () => NOW, transaction: fn => fn(),
    getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch),
    market: { quotes: async () => { quoteCalls++; return quotes; } }, monitor });
  const evaluation = engine.agencyEvaluate('swing', SYMBOL, q, snap), group = { id: 'swing', token: service.token() };
  const candidate = candidateData(SYMBOL, q, snap, evaluation, null, engine.agencyGroupState('swing', quotes));
  const result = await service.commit(group, { decisionSource: 'rules', rulesVersion: RULES_VERSION, evaluatedAt: NOW,
    requestedAt: NOW, expiresAt: NOW + 60000,
    decisions: [{ symbol: SYMBOL, action: 'buy', targetPercent: 20, validForSeconds: 60, reason: '隔离测试规则通过', evidence: [] }] }, { candidates: [candidate] });
  assert.equal(result.completed, true);
  assert.deepEqual(loads, []); assert.equal(quoteCalls, 1);
  assert.equal(engine.s.trades.length, 1, engine.s.agency.decisions.map(item => item.message).join('；'));
  assert.equal(engine.s.trades[0].side, 'buy'); assert.equal(validState(engine.s), true);
});
