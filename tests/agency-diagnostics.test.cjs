const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { CorporateService } = require('../core/corporate-service.cjs');

const SYMBOL = 'sz301688';
const INSUFFICIENT = '策略日线不可用：完整未复权日线不足 61 根';

function fixture() {
  let now = Date.parse('2026-10-12T10:00:00+08:00');
  let engine = new Engine(initialState(100000), () => new Date(now));
  engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
  engine.agencyMember({ strategyId: 'swing', symbol: SYMBOL, action: 'add' });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const quote = (symbol = SYMBOL, extra = {}) => ({ symbol, name: '核验诊断测试', source: 'test', price: 10.1,
    prevClose: 10.05, open: 10, low: 10, high: 10.2, volume: 100000, bid: 10.09, ask: 10.1,
    bidSize: 20000, askSize: 20000, limitUp: 12.06, limitDown: 8.04,
    timestamp: now, date: '2026-10-12', ...extra });
  const snapshot = (symbol = SYMBOL, extra = {}) => ({ source: 'test daily', fetchedAt: now,
    technical: { asOf: '2026-10-09', close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4,
      macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false, support: 9.7, resistance: 11.5,
      entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-10-09'] },
    notices: { symbol, section: 'notices', status: 'empty', source: '东方财富', fetchedAt: now, data: { items: [], total: 0 } },
    corporateActions: { symbol, status: 'ready', source: 'test corporate', fetchedAt: now,
      coverageStart: '2026-09-28', coverageEnd: '2026-10-12', coverageComplete: true, events: [], notices: [] },
    ...extra });
  const missingDaily = () => snapshot(SYMBOL, { technical: undefined, fetchedAt: undefined, error: INSUFFICIENT });
  const member = () => engine.s.agency.groups.find(group => group.id === 'swing').members.find(item => item.symbol === SYMBOL);
  const group = () => engine.agencyState().groups.find(item => item.id === 'swing');
  const buy = (symbol = SYMBOL) => engine.agencyExecute({ strategyId: 'swing', symbol, action: 'buy',
    targetPercent: 20, decisionId: `buy-${symbol}-${engine.s.trades.length}`, expectedEpoch: engine.s.agency.epoch,
    expectedRevision: engine.s.agency.revision }, quote(symbol), snapshot(symbol));
  return { get engine() { return engine; }, quote, snapshot, missingDaily, member, group, buy,
    check: (snap = snapshot(), q = quote()) => engine.agencyAutomaticBlock(SYMBOL, q, snap),
    advance: ms => { now += ms; },
    restart: () => { engine = new Engine(JSON.parse(JSON.stringify(engine.s)), () => new Date(now)); } };
}

test('公司行为恢复后显示当前日线不足，完整价格核验通过前保留交易阻断', () => {
  const f = fixture(), failed = f.missingDaily();
  failed.corporateActions.status = 'unavailable'; failed.corporateActions.coverageComplete = false;
  assert.match(f.check(failed), /公司行为实施资料/);
  const previous = structuredClone(f.member().reconciliation);
  assert.equal(f.member().automaticCheck.status, 'blocked');

  assert.equal(f.check(f.missingDaily()), INSUFFICIENT);
  assert.equal(f.member().corporateVerification.status, 'clear');
  assert.deepEqual(f.member().reconciliation, previous, '诊断更新不能提前解除价格基准核验');
  assert.equal(f.member().automaticCheck.status, 'waiting');
  assert.equal(f.member().automaticCheck.reason, INSUFFICIENT);
  assert.equal(f.group().comparable, true);
  assert.equal(f.engine.stats().comparable, true);
  const evaluation = f.engine.agencyEvaluate('swing', SYMBOL, f.quote(), f.missingDaily());
  assert.equal(evaluation.buyable, false);
  assert.ok(evaluation.reasons.includes(INSUFFICIENT));
  assert.equal(f.engine.s.trades.length, 0);

  assert.equal(f.check(), null);
  assert.deepEqual(f.member().reconciliation, { status: 'clear', reason: '' });
  assert.equal(f.member().automaticCheck.status, 'clear');
  assert.equal(f.member().automaticCheck.reason, '');
  assert.equal(f.engine.agencyEvaluate('swing', SYMBOL, f.quote(), f.snapshot()).buyable, true);
  assert.equal(validState(f.engine.s), true);
});

test('空仓成员的日线不足不妨碍同策略其他满足规则的股票开仓', () => {
  const f = fixture(), failed = f.missingDaily();
  failed.corporateActions.status = 'unavailable'; failed.corporateActions.coverageComplete = false;
  f.check(failed); f.check(f.missingDaily());
  f.engine.agencyMember({ strategyId: 'swing', symbol: 'sh600000', action: 'add' });
  const trade = f.buy('sh600000');
  assert.equal(trade.side, 'buy'); assert.equal(trade.symbol, 'sh600000');
  assert.equal(f.member().automaticCheck.reason, INSUFFICIENT);
  assert.equal(f.group().comparable, true);
  assert.equal(f.engine.s.trades.length, 1);
});

test('持仓价格基准异常不因公司行为clear或日线暂缺而解除', () => {
  const f = fixture(); f.buy();
  const badQuote = f.quote(SYMBOL, { prevClose: 8 });
  assert.match(f.check(f.snapshot(), badQuote), /价格基准不一致/);
  const pending = structuredClone(f.member().reconciliation), lots = structuredClone(f.engine.s.lots), cash = f.engine.s.cash;
  assert.equal(f.member().corporateVerification.status, 'clear');
  assert.equal(f.group().comparable, false);

  assert.equal(f.check(f.missingDaily(), badQuote), INSUFFICIENT);
  assert.deepEqual(f.member().reconciliation, pending);
  assert.equal(f.group().comparable, false);
  assert.throws(() => f.engine.execute({ symbol: SYMBOL, side: 'sell', quantity: 100 }, f.quote()), /待对账/);
  assert.equal(f.engine.agencyEvaluate('swing', SYMBOL, badQuote, f.missingDaily()).buyable, false);
  assert.deepEqual(f.engine.s.lots, lots); assert.equal(f.engine.s.cash, cash);

  assert.match(f.check(f.snapshot(), badQuote), /价格基准不一致/);
  assert.equal(f.member().automaticCheck.status, 'blocked');
  assert.equal(f.member().reconciliation.status, 'pending');
  assert.equal(f.check(), null);
  assert.equal(f.member().reconciliation.status, 'clear');
  assert.equal(f.group().comparable, true);
});

test('公司行为真实异常优先于日线缺失，诊断不会清除有持仓的账务阻断', () => {
  const f = fixture(); f.buy();
  const failed = f.missingDaily(); failed.corporateActions.coverageComplete = false;
  const reason = f.check(failed);
  assert.match(reason, /公司行为实施资料/);
  assert.equal(f.member().automaticCheck.status, 'blocked');
  assert.equal(f.member().automaticCheck.reason, reason);
  assert.equal(f.member().reconciliation.affectsEquity, true);
  assert.equal(f.group().comparable, false);
  const pending = structuredClone(f.member().reconciliation);
  assert.equal(f.check(f.missingDaily()), INSUFFICIENT);
  assert.deepEqual(f.member().reconciliation, pending);
  assert.equal(f.group().comparable, false);
  assert.equal(f.engine.s.trades.length, 1);
});

test('当前诊断跨重启保留，重复核验更新时间但不反复改变授权版本', () => {
  const f = fixture(), failed = f.missingDaily();
  failed.corporateActions.status = 'unavailable'; f.check(failed); f.check(f.missingDaily());
  const revision = f.engine.s.agency.revision, diagnostic = structuredClone(f.member().automaticCheck);
  f.advance(1000); assert.equal(f.check(f.missingDaily()), INSUFFICIENT);
  assert.equal(f.engine.s.agency.revision, revision);
  assert.notEqual(f.member().automaticCheck.checkedAt, diagnostic.checkedAt);
  const before = structuredClone(f.member());
  f.restart(); assert.deepEqual(f.member(), before); assert.equal(validState(f.engine.s), true);
  assert.equal(f.check(f.missingDaily()), INSUFFICIENT);
  assert.equal(f.engine.s.agency.revision, revision);
  assert.equal(f.member().reconciliation.status, 'pending');

  assert.equal(f.check(), null);
  const recovered = f.engine.s.agency.revision;
  assert.ok(recovered > revision);
  f.advance(1000); assert.equal(f.check(), null);
  assert.equal(f.engine.s.agency.revision, recovered);
  f.restart(); assert.equal(f.member().automaticCheck.status, 'clear');
  assert.equal(f.member().reconciliation.status, 'clear');
});

test('缺少报价、日线时间过期及日期无效时分别保留当前原因和交易阻断', () => {
  const f = fixture();
  assert.match(f.check(f.snapshot(), null), /行情尚未获取/);
  assert.equal(f.member().automaticCheck.status, 'waiting');
  const stale = f.snapshot(); stale.fetchedAt -= 180001;
  assert.match(f.check(stale), /日线获取时间无效或已过期/);
  assert.equal(f.member().automaticCheck.status, 'waiting');
  const unfinished = f.snapshot(); unfinished.technical.asOf = '2026-10-12';
  assert.match(f.check(unfinished), /完整日线日期尚未核验/);
  assert.equal(f.member().automaticCheck.status, 'waiting');
  assert.equal(f.engine.s.trades.length, 0);
  assert.equal(f.check(), null);
  assert.equal(f.member().automaticCheck.status, 'clear');
});

test('公司行为核验汇总按本次诊断区分真实异常、日线等待与完整恢复', async () => {
  const f = fixture();
  let snapshot = f.missingDaily(); snapshot.corporateActions.coverageComplete = false;
  const service = new CorporateService({ getEngine: () => f.engine,
    transaction: fn => fn(), getMonitor: () => ({ load: async () => snapshot }),
    market: { quotes: async () => ({ [SYMBOL]: f.quote() }) }, clock: () => f.engine.clock().getTime() });
  const verify = () => service.verify({ strategyId: 'swing', symbol: SYMBOL });
  const blocked = await verify();
  assert.equal(blocked.blocked, 1); assert.equal(blocked.waiting, 0); assert.equal(blocked.clear, 0);
  assert.equal(f.member().reconciliation.status, 'pending');

  snapshot = f.missingDaily();
  const waiting = await verify();
  assert.equal(waiting.blocked, 0); assert.equal(waiting.waiting, 1); assert.equal(waiting.clear, 0);
  assert.equal(waiting.results[0].reason, INSUFFICIENT);
  assert.equal(f.member().reconciliation.status, 'pending');
  const revision = f.engine.s.agency.revision;
  const repeated = await verify();
  assert.equal(repeated.waiting, 1); assert.equal(f.engine.s.agency.revision, revision);

  snapshot = f.snapshot();
  const recovered = await verify();
  assert.equal(recovered.clear, 1); assert.equal(recovered.waiting, 0); assert.equal(recovered.blocked, 0);
  assert.equal(f.member().reconciliation.status, 'clear');
  assert.equal(f.engine.s.trades.length, 0);
});
