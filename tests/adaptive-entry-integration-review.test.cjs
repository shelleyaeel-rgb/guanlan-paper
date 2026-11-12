const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { EntryConfirmationTracker } = require('../core/entry-confirmation.cjs');
const { enableMarketPolicy } = require('../core/market-policy.cjs');
const { cnTime } = require('../core/common.cjs');
const { MARKET_REGIME_POLICY } = require('../core/market-regime.cjs');

const symbol = 'sz000001';
function fixture() {
  const start = Date.parse('2026-10-15T10:00:00+08:00'); let now = start;
  const engine = new Engine(initialState(1000000), () => new Date(now));
  engine.agencyTransfer({ strategyId: 'swing', amount: 500000 });
  engine.agencyConfigure({ strategyId: 'swing', limits: { riskPercent: 0.1 } });
  engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  enableMarketPolicy(engine.s);
  const tracker = new EntryConfirmationTracker();
  const technical = { asOf: '2026-10-14', close: 10.05, ma5: 10.02, ma20: 10, ma60: 9.5, atr: 0.4,
    macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false, support: 9.7, resistance: 11.5,
    entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-10-14'] };
  const regime = (status = 'neutral') => ({ version: 1, policyVersion: MARKET_REGIME_POLICY.version, status, label: status, riskMultiplier: status === 'weak' ? 0 : status === 'strong' ? 1 : 0.5,
    allowEntry: status !== 'weak', allowBreakout: status === 'strong', checkedAt: now, expiresAt: now + 90000, date: cnTime(now).date, reasons: ['隔离市场状态'],
    metrics: { highVolatility: false }, evidence: { quoteTime: now, indexQuoteTimes: { sh000001: now, sz399001: now, sz399006: now }, breadthQuoteTime: now, breadthFetchedAt: now } });
  const quote = price => ({ symbol, name: '隔离测试', source: 'test', price, ask: price, bid: price - 0.01, prevClose: 10.05, open: 10,
    low: 9.9, high: 10.3, volume: 100000, askSize: 50000, bidSize: 50000, timestamp: now, date: cnTime(now).date, limitUp: 11.05, limitDown: 9.05 });
  const observe = (seconds, price) => {
    now = start + seconds * 1000; const q = quote(price), marketRegime = regime();
    return { q, snap: { technical, source: 'test daily', fetchedAt: now, marketRegime,
      entryConfirmation: tracker.observe(symbol, 'swing', q, technical, marketRegime, now),
      notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now, data: { items: [], total: 0 } } } };
  };
  const confirmed = () => { observe(0, 9.96); observe(10, 10.08); return observe(70, 10.1); };
  const execute = (q, snap, action = 'buy') => {
    const before = structuredClone(engine.s);
    try { return engine.agencyExecute({ symbol, strategyId: 'swing', action, targetPercent: action === 'buy' ? 20 : undefined,
      decisionId: `review-${action}-${engine.s.trades.length}`, expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, q, snap, { [symbol]: q }); }
    catch (error) { engine.s = before; throw error; }
  };
  return { engine, regime, quote, observe, confirmed, execute, advance: ms => { now += ms; } };
}

test('集成：中性市实际使用0.05%计划风险，不被配置层0.1%下限抬高', () => {
  const f = fixture(), { q, snap } = f.confirmed();
  const result = f.engine.agencyEvaluate('swing', symbol, q, snap, undefined, { [symbol]: q });
  assert.equal(result.buyable, true, result.reasons.join('；'));
  assert.equal(result.plan.config.riskPercent, 0.05);
  assert.equal(result.budget, 25000, '50万元策略权益×0.05%=250元（25000分）');
  assert.ok(result.economics.loss <= 25000);
  const trade = f.execute(q, snap);
  assert.equal(trade.strategyPlan.config.riskPercent, 0.05);
  assert.ok(trade.strategyPlan.economics.loss <= 25000);
  assert.equal(validState(f.engine.s), true);
});

test('集成：已获可买评估不能绕过成交事务内的新市场状态或过期证据', () => {
  for (const scenario of ['weak', 'expired', 'missing']) {
    const f = fixture(), { q, snap } = f.confirmed();
    assert.equal(f.engine.agencyEvaluate('swing', symbol, q, snap).buyable, true);
    const before = structuredClone(f.engine.s);
    if (scenario === 'weak') snap.marketRegime = f.regime('weak');
    else if (scenario === 'expired') f.advance(90001);
    else delete snap.marketRegime;
    assert.throws(() => f.execute(q, snap));
    assert.deepEqual(f.engine.s, before);
  }
});

test('集成：市场证据缺失不阻断已持仓T+1退出，也不新增仓位', () => {
  const f = fixture(), { q, snap } = f.confirmed(); f.execute(q, snap);
  const risk = structuredClone(f.engine.s.risks[symbol]);
  const held = f.engine.agencyEvaluate('swing', symbol, q, { ...snap, marketRegime: undefined });
  assert.equal(held.status, '持仓跟踪'); assert.equal(held.buyable, false);
  assert.deepEqual(f.engine.s.risks[symbol], risk);
  f.advance(86400000);
  const exitSnapshot = { ...snap, fetchedAt: +f.engine.clock(), marketRegime: undefined, entryConfirmation: undefined,
    technical: { ...snap.technical, asOf: '2026-10-15', dates: ['2026-10-14', '2026-10-15'] }, notices: { ...snap.notices, fetchedAt: +f.engine.clock() } };
  const [sell] = f.engine.tick({ [symbol]: f.quote(9.5) }, { [symbol]: exitSnapshot });
  assert.equal(sell.side, 'sell'); assert.equal(f.engine.s.lots.length, 0);
  assert.equal(validState(f.engine.s), true);
});

test('集成：启用幂等且导入旧账户与reset新账户可安全启用并使旧授权失效', () => {
  const f = fixture(), revision = f.engine.s.agency.revision;
  assert.equal(enableMarketPolicy(f.engine.s), false); assert.equal(f.engine.s.agency.revision, revision);
  const imported = new Engine(structuredClone(f.engine.s)); delete imported.s.agency.marketPolicy;
  const importedRevision = imported.s.agency.revision;
  assert.equal(enableMarketPolicy(imported.s), true); assert.equal(imported.s.agency.revision, importedRevision + 1);
  assert.equal(validState(imported.s), true);
  const reset = new Engine(initialState(20000)); assert.equal(enableMarketPolicy(reset.s), true);
  assert.equal(reset.s.agency.marketPolicy.enabled, true); assert.equal(validState(reset.s), true);
});
