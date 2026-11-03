'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { cnTime } = require('../core/common.cjs');

const SYMBOL = 'sz000001';
function fixture(initialTime = '2026-10-21T09:00:00+08:00') {
  let now = new Date(initialTime);
  const engine = new Engine(initialState(100000), () => new Date(now));
  engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
  engine.agencyMember({ strategyId: 'swing', symbol: SYMBOL, action: 'add' });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const member = () => engine.s.agency.groups.find(group => group.id === 'swing').members[0];
  const quote = (extra = {}) => ({ symbol: SYMBOL, name: '盘前准备测试', source: 'test', price: 10.1,
    prevClose: 10.05, open: 10, low: 10, high: 10.2, volume: 100000, bid: 10.09, ask: 10.1,
    bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05,
    timestamp: now.getTime(), date: cnTime(now).date, ...extra });
  const snapshot = (asOf = '2026-10-20') => ({ source: 'test daily', fetchedAt: now.getTime(),
    technical: { asOf, close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4,
      macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false, support: 9.7, resistance: 11.5,
      entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: [asOf] },
    notices: { symbol: SYMBOL, section: 'notices', status: 'empty', source: '东方财富', fetchedAt: now.getTime(), data: { items: [], total: 0 } },
    corporateActions: { symbol: SYMBOL, status: 'ready', source: 'test corporate', fetchedAt: now.getTime(),
      coverageStart: '2026-01-01', coverageEnd: cnTime(now).date, coverageComplete: true, events: [], notices: [] } });
  const buy = asOf => engine.agencyExecute({ strategyId: 'swing', symbol: SYMBOL, action: 'buy', targetPercent: 20,
    decisionId: 'preparation-buy', expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, quote(), snapshot(asOf));
  return { engine, member, quote, snapshot, buy, setTime: value => { now = new Date(value); } };
}

test('盘前无报价或仅有昨日收盘报价时准备历史资料，但不确认当日价格或开放交易', () => {
  for (const previousQuote of [false, true]) {
    const f = fixture(), before = { cash: f.engine.s.cash, trades: structuredClone(f.engine.s.trades), revision: f.engine.s.agency.revision };
    const q = previousQuote ? f.quote({ date: '2026-10-20', timestamp: Date.parse('2026-10-20T15:00:00+08:00'), prevClose: 999 }) : undefined;
    const reason = f.engine.agencyPrepare(SYMBOL, q, f.snapshot());
    assert.match(reason, /等待开盘后实时行情、价格基准和入场校验/);
    assert.equal(f.member().automaticCheck.status, 'waiting');
    assert.equal(f.member().automaticCheck.phase, 'prepared');
    assert.equal(f.member().automaticCheck.dailyAsOf, '2026-10-20');
    assert.equal(f.member().lastVerifiedDate, undefined);
    assert.equal(f.member().corporateVerification, undefined);
    assert.equal(f.engine.agencyNeedsCorporateEvidence(SYMBOL), false);
    assert.equal(f.engine.s.agency.revision, before.revision);
    assert.equal(f.engine.s.cash, before.cash); assert.deepEqual(f.engine.s.trades, before.trades);
    assert.equal(f.engine.agencyEvaluate('swing', SYMBOL, q, f.snapshot()).buyable, false);
    assert.equal(validState(f.engine.s), true);
  }
});

test('盘前日线 HTTP 501 记录当前失败，恢复后重新准备，无需当日报价', () => {
  const f = fixture(), failed = f.snapshot();
  delete failed.technical; failed.error = '策略日线不可用：HTTP 501（test-source）';
  assert.match(f.engine.agencyPrepare(SYMBOL, undefined, failed), /HTTP 501/);
  assert.equal(f.member().automaticCheck.status, 'waiting');
  assert.equal(f.member().automaticCheck.phase, undefined);
  f.engine.agencyPrepare(SYMBOL, undefined, f.snapshot());
  assert.equal(f.member().automaticCheck.phase, 'prepared'); assert.equal(f.engine.s.trades.length, 0);
});

test('已有持仓公司行为获取失败不能标为准备完成，资料恢复不解除旧对账阻断', () => {
  const f = fixture('2026-10-20T10:00:00+08:00'); f.buy('2026-10-19'); f.setTime('2026-10-21T09:00:00+08:00');
  const failed = f.snapshot();
  Object.assign(failed.corporateActions, { status: 'unavailable', coverageComplete: false, error: 'HTTP 501' });
  assert.match(f.engine.agencyPrepare(SYMBOL, undefined, failed), /HTTP 501/);
  assert.equal(f.member().automaticCheck.status, 'blocked');
  assert.equal(f.member().automaticCheck.phase, undefined);
  const latch = structuredClone(f.member().reconciliation);
  f.engine.agencyPrepare(SYMBOL, undefined, f.snapshot());
  assert.equal(f.member().automaticCheck.phase, 'prepared');
  assert.deepEqual(f.member().reconciliation, latch);
});

test('首次开仓只准备日线，公告失败不阻断，旧无权益阻断须等当日价格基准通过才解除', () => {
  const f = fixture(), snapshot = f.snapshot();
  delete snapshot.notices;
  Object.assign(snapshot.corporateActions, { status: 'unavailable', coverageComplete: false, error: '公告连接失败' });
  f.member().reconciliation = { status: 'pending', reason: '旧公告获取失败', affectsEquity: false };
  f.engine.s.agency.corporateChecks[SYMBOL] = { status: 'blocked', reason: '旧公告获取失败', affectsEquity: false };
  f.engine.agencyPrepare(SYMBOL, undefined, snapshot);
  assert.equal(f.member().automaticCheck.phase, 'prepared');
  assert.equal(f.member().reconciliation.status, 'pending');
  assert.equal(f.engine.s.agency.corporateActions.length, 0);
  f.setTime('2026-10-21T10:00:00+08:00'); snapshot.fetchedAt = f.engine.clock().getTime();
  assert.match(f.engine.agencyAutomaticBlock(SYMBOL, f.quote({ prevClose: 9.95 }), snapshot), /价格基准不一致/);
  assert.equal(f.member().reconciliation.status, 'pending');
  assert.equal(f.engine.agencyAutomaticBlock(SYMBOL, f.quote(), snapshot), null);
  assert.equal(f.member().reconciliation.status, 'clear');
  assert.equal(f.member().corporateVerification.status, 'not-required');
  assert.equal(f.member().exitPriceBasis.corporateVerified, false);
  assert.equal(f.engine.s.agency.corporateChecks[SYMBOL], undefined);
  assert.equal(validState(f.engine.s), true);
});

test('真实权益待对账不能作为纯候选旧故障解除', () => {
  const f = fixture('2026-10-21T10:00:00+08:00'), snapshot = f.snapshot();
  f.member().reconciliation = { status: 'pending', reason: '尚有待核实股息权益', affectsEquity: true };
  delete snapshot.corporateActions; delete snapshot.notices;
  assert.equal(f.engine.agencyNeedsCorporateEvidence(SYMBOL), true);
  assert.match(f.engine.agencyAutomaticBlock(SYMBOL, f.quote(), snapshot), /尚有待核实股息权益/);
  assert.equal(f.member().reconciliation.status, 'pending');
});

test('盘前已有持仓的价格对账与待复核状态必须保留', () => {
  const f = fixture('2026-10-20T10:00:00+08:00'); f.buy('2026-10-19');
  assert.match(f.engine.agencyAutomaticBlock(SYMBOL, f.quote({ prevClose: 8 }), f.snapshot('2026-10-19')), /价格基准不一致/);
  f.member().awaitingVerification = true;
  const latch = structuredClone(f.member().reconciliation), lastVerifiedDate = f.member().lastVerifiedDate;
  const lots = structuredClone(f.engine.s.lots), cash = f.engine.s.cash;
  f.setTime('2026-10-21T09:00:00+08:00');
  assert.match(f.engine.agencyPrepare(SYMBOL, undefined, f.snapshot()), /原待对账状态保留/);
  assert.equal(f.member().automaticCheck.phase, 'prepared');
  assert.deepEqual(f.member().reconciliation, latch);
  assert.equal(f.member().awaitingVerification, true); assert.equal(f.member().lastVerifiedDate, lastVerifiedDate);
  assert.deepEqual(f.engine.s.lots, lots); assert.equal(f.engine.s.cash, cash); assert.equal(f.engine.s.trades.length, 1);
});

test('持仓盘前风险轮询保留同日准备事实与原时间，但仍阻止执行', () => {
  const f = fixture('2026-10-20T10:00:00+08:00'); f.buy('2026-10-19');
  f.setTime('2026-10-21T09:00:00+08:00');
  f.engine.agencyPrepare(SYMBOL, undefined, f.snapshot());
  const prepared = structuredClone(f.member().automaticCheck), cash = f.engine.s.cash, lots = structuredClone(f.engine.s.lots);
  f.setTime('2026-10-21T09:04:00+08:00');
  const q = f.quote({ price: 1, bid: 1 });
  assert.deepEqual(f.engine.tick({ [SYMBOL]: q }, { [SYMBOL]: f.snapshot() }), []);
  assert.deepEqual(f.member().automaticCheck, prepared, '超过交易日线180秒时效不刷新或删除准备事实');
  assert.equal(f.engine.agencyAutomaticBlock(SYMBOL, q, f.snapshot()), '未开盘');
  assert.deepEqual(f.member().automaticCheck, prepared);
  assert.equal(f.engine.s.cash, cash); assert.deepEqual(f.engine.s.lots, lots); assert.equal(f.engine.s.trades.length, 1);
});

test('未知日历、跨日、未来时间和最新完整交易日变化不能保留旧准备状态', () => {
  for (const nextTime of ['2026-10-22T09:00:00+08:00', '2027-01-04T09:00:00+08:00',
    '2026-10-21T08:59:59+08:00', '2026-10-21T15:00:00+08:00']) {
    const f = fixture(); f.engine.agencyPrepare(SYMBOL, undefined, f.snapshot());
    assert.equal(f.member().automaticCheck.phase, 'prepared');
    f.setTime(nextTime);
    assert.ok(f.engine.agencyAutomaticBlock(SYMBOL, f.quote(), f.snapshot()));
    assert.equal(f.member().automaticCheck.phase, undefined, nextTime);
  }
});

test('盘前日线必须覆盖最近完整交易日，来源和获取时间有效', () => {
  for (const change of [snapshot => { snapshot.technical.asOf = '2026-10-19'; },
    snapshot => { snapshot.technical.asOf = '2026-10-21'; }, snapshot => { snapshot.fetchedAt -= 180001; },
    snapshot => { snapshot.fetchedAt += 15001; }, snapshot => { snapshot.source = ''; }]) {
    const f = fixture(), snapshot = f.snapshot(); change(snapshot);
    assert.match(f.engine.agencyPrepare(SYMBOL, undefined, snapshot), /日线/);
    assert.equal(f.member().automaticCheck.phase, undefined); assert.equal(f.member().automaticCheck.status, 'waiting');
  }
});

test('盘中准备入口完全沿用原报价与权限核验，准备状态不成为放行凭证', () => {
  const f = fixture(); f.engine.agencyPrepare(SYMBOL, undefined, f.snapshot());
  f.setTime('2026-10-21T10:00:00+08:00');
  assert.match(f.engine.agencyPrepare(SYMBOL, undefined, f.snapshot()), /行情尚未获取/);
  assert.equal(f.member().automaticCheck.phase, undefined);
  assert.match(f.engine.agencyPrepare(SYMBOL, f.quote({ prevClose: 8 }), f.snapshot()), /价格基准不一致/);
  assert.equal(f.member().automaticCheck.status, 'blocked');
  assert.equal(f.engine.agencyPrepare(SYMBOL, f.quote(), f.snapshot()), null);
  assert.equal(f.member().automaticCheck.status, 'clear'); assert.equal(f.member().lastVerifiedDate, '2026-10-21');
  f.engine.agencyMode({ strategyId: 'swing', mode: 'stopped' });
  assert.match(f.engine.agencyPrepare(SYMBOL, f.quote(), f.snapshot()), /全部自动操作已停止/);
  assert.equal(f.engine.s.trades.length, 0);
});

test('未知日历不能标为准备完成；周末可以准备周五完整日线但不能交易', () => {
  const unknown = fixture('2027-01-04T09:00:00+08:00');
  assert.match(unknown.engine.agencyPrepare(SYMBOL, undefined, unknown.snapshot()), /交易日历未经核验/);
  assert.equal(unknown.member().automaticCheck.phase, undefined);
  assert.equal(unknown.member().corporateVerification, undefined);
  const weekend = fixture('2026-10-24T09:00:00+08:00');
  weekend.engine.agencyPrepare(SYMBOL, undefined, weekend.snapshot('2026-10-23'));
  assert.equal(weekend.member().automaticCheck.phase, 'prepared');
  assert.equal(weekend.member().automaticCheck.status, 'waiting');
  assert.equal(weekend.engine.agencyEvaluate('swing', SYMBOL, weekend.quote(), weekend.snapshot('2026-10-23')).buyable, false);
});

test('盘前权益入账沿用生效日期且重复准备不重复记账，登记日盘前不提前锁定权益', () => {
  const f = fixture('2026-10-19T10:00:00+08:00'), trade = f.buy('2026-10-16');
  const event = { eventId: 'cash-preparation', noticeIds: ['AN123456789012'], sourceUrl: 'https://example.test/implementation',
    status: 'implemented', recordDate: '2026-10-20', exDate: '2026-10-21', payDate: '2026-10-21', listingDate: null,
    cashPerShare: 0.1, bonusPerShare: 0, transferPerShare: 0, taxPolicy: 'cn-individual-deferred-v1' };
  const prepare = asOf => { const snapshot = f.snapshot(asOf); snapshot.corporateActions.events = [event]; return f.engine.agencyPrepare(SYMBOL, undefined, snapshot); };
  f.setTime('2026-10-20T09:00:00+08:00'); prepare('2026-10-19');
  assert.equal(f.engine.s.agency.corporateActions[0].registeredAt, undefined);
  const cash = f.engine.s.cash, stop = f.engine.s.risks[SYMBOL].stop;
  f.setTime('2026-10-21T09:00:00+08:00'); prepare('2026-10-20');
  assert.equal(f.member().automaticCheck.phase, 'prepared');
  assert.equal(f.engine.s.cash, cash + trade.quantity * 10);
  assert.equal(f.engine.s.risks[SYMBOL].stop, Math.round((stop - 0.1) * 100) / 100);
  const posted = structuredClone({ cash: f.engine.s.cash, lots: f.engine.s.lots, risks: f.engine.s.risks,
    events: f.engine.s.agency.corporateEvents, revision: f.engine.s.agency.revision });
  prepare('2026-10-20');
  assert.deepEqual({ cash: f.engine.s.cash, lots: f.engine.s.lots, risks: f.engine.s.risks,
    events: f.engine.s.agency.corporateEvents, revision: f.engine.s.agency.revision }, posted);
  assert.equal(f.engine.s.trades.length, 1); assert.equal(validState(f.engine.s), true);
});

test('竞价参考基准预检不解除旧对账、不确认当日执行权限且开盘仍重新比较参考价', () => {
  const f = fixture('2026-10-21T09:20:00+08:00');
  f.member().reconciliation = { status: 'pending', reason: '原价格基准待复核', affectsEquity: false };
  f.member().awaitingVerification = true;
  const latch = structuredClone(f.member().reconciliation), cash = f.engine.s.cash;
  const q = f.quote({ provider: 'tencent', source: '腾讯财经', price: 999, volume: 0, canTrade: false });
  f.engine.agencyPrepare(SYMBOL, q, f.snapshot());
  assert.equal(f.member().automaticCheck.reference.status, 'checked');
  assert.equal(f.member().automaticCheck.phase, 'prepared');
  assert.equal(f.member().automaticCheck.status, 'waiting');
  assert.equal(f.member().lastVerifiedDate, undefined); assert.equal(f.member().exitPriceBasis, undefined);
  assert.equal(f.member().awaitingVerification, true); assert.deepEqual(f.member().reconciliation, latch);
  assert.equal(f.engine.s.cash, cash); assert.equal(f.engine.s.trades.length, 0);
  f.setTime('2026-10-21T09:30:00+08:00');
  assert.match(f.engine.agencyPrepare(SYMBOL, f.quote({ prevClose: 8 }), f.snapshot()), /价格基准不一致/);
  assert.equal(f.member().automaticCheck.status, 'blocked'); assert.equal(f.engine.s.trades.length, 0);
});
