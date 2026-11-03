const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { cnTime } = require('../core/common.cjs');

const SYMBOL = 'sz000001';
function fixture() {
  let now = Date.parse('2026-09-29T10:00:00+08:00');
  let engine = new Engine(initialState(100000), () => new Date(now));
  const quote = (extra = {}) => ({ symbol: SYMBOL, name: '退出数据测试', price: 10.1, prevClose: 10.05,
    open: 10, low: 10, high: 10.2, volume: 100000, bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000,
    limitUp: 11.05, limitDown: 9.05, timestamp: now, date: cnTime(now).date, ...extra });
  const snapshot = (extra = {}) => {
    const previous = cnTime(now - 86400000).date;
    return { fetchedAt: now, technical: { asOf: previous, close: 10.05, ma5: 10, ma20: 10, ma60: 9.5,
      atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false,
      support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: [previous] },
    notices: { symbol: SYMBOL, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now, data: { items: [], total: 0 } },
    corporateActions: { symbol: SYMBOL, status: 'ready', source: 'test', fetchedAt: now, coverageStart: '2026-09-15',
      coverageEnd: cnTime(now).date, coverageComplete: true, events: [], notices: [] }, ...extra };
  };
  const member = () => engine.s.agency.groups.find(g => g.id === 'swing').members[0];
  const execute = (action = 'buy', q = quote(), snap = snapshot()) => engine.agencyExecute({ strategyId: 'swing', symbol: SYMBOL,
    action, targetPercent: action === 'buy' ? 20 : undefined, decisionId: `${action}-${engine.s.trades.length}`,
    expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, q, snap, { [SYMBOL]: q });
  engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
  engine.agencyMember({ strategyId: 'swing', symbol: SYMBOL, action: 'add' });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const buy = execute();
  const tick = (snap, q = quote()) => engine.tick({ [SYMBOL]: q }, snap === undefined ? {} : { [SYMBOL]: snap });
  const verify = () => assert.equal(engine.agencyAutomaticBlock(SYMBOL, quote(), snapshot()), null);
  const sellable = () => { now = Date.parse('2026-09-30T10:00:00+08:00'); verify(); };
  return { get engine() { return engine; }, quote, snapshot, member, execute, tick, verify, sellable, buy,
    advance: ms => { now += ms; }, day: date => { now = Date.parse(`${date}T10:00:00+08:00`); },
    restart: () => { engine = new Engine(JSON.parse(JSON.stringify(engine.s)), () => new Date(now)); } };
}

for (const unavailable of ['failed', 'missing-technical', 'missing-snapshot', 'expired', 'invalid-time', 'future-time']) {
  test(`已锁定退出在日线 ${unavailable} 时沿当日已核验基准成交`, () => {
    const f = fixture(); f.sellable();
    f.engine.s.risks[SYMBOL].pendingExit = '止损触发';
    let snap = f.snapshot();
    if (unavailable === 'failed') snap.error = '日线服务暂时失败';
    if (unavailable === 'missing-technical') delete snap.technical;
    if (unavailable === 'missing-snapshot') snap = undefined;
    if (unavailable === 'expired') snap.fetchedAt -= 180001;
    if (unavailable === 'invalid-time') snap.fetchedAt = NaN;
    if (unavailable === 'future-time') snap.fetchedAt += 15001;
    const [exit] = f.tick(snap);
    assert.ok(exit, f.engine.s.risks[SYMBOL]?.note);
    assert.equal(exit.reason, '止损触发'); assert.equal(exit.quantity, f.buy.quantity);
    assert.equal(f.engine.positions().length, 0); assert.equal(validState(f.engine.s), true);
  });
}

test('日线失效仍按原止损卖出，未触及原价位时不生成趋势退出或调价', () => {
  const f = fixture(); f.sellable();
  const risk = f.engine.s.risks[SYMBOL], before = structuredClone(risk), snap = f.snapshot();
  snap.fetchedAt -= 180001; snap.technical.close = 8; snap.technical.ma20 = 8;
  assert.equal(f.tick(snap).length, 0);
  assert.equal(risk.stop, before.stop); assert.equal(risk.target, before.target);
  assert.equal(risk.pendingExit, undefined); assert.deepEqual(risk.history, before.history);
  assert.equal(f.member().automaticCheck.status, 'waiting');
  assert.match(f.member().automaticCheck.reason, /日线复核暂停，已存价位和待完成退出目标继续监控/);
  assert.equal(f.member().reconciliation.status, 'clear');
  const [exit] = f.tick(f.snapshot({ error: '日线暂缺' }), f.quote({ price: 9.5, bid: 9.5 }));
  assert.equal(exit?.reason, '止损触发'); assert.equal(validState(f.engine.s), true);
});

test('原止盈和移动止损在日线失败时继续监控，暂停日线复核不暂停退出', () => {
  for (const trigger of ['target', 'trailing']) {
    const f = fixture(); f.sellable();
    const risk = f.engine.s.risks[SYMBOL]; risk.dynamic = false;
    if (trigger === 'target') risk.target = 10.2;
    else { risk.trailing = 5; risk.peak = 11; }
    const q = trigger === 'target' ? f.quote({ price: 10.3, bid: 10.3 }) : f.quote();
    const [exit] = f.tick(f.snapshot({ error: '日线暂缺' }), q);
    assert.equal(exit?.reason, trigger === 'target' ? '止盈触发' : '止损触发');
  }
});

test('待完成减仓目标在日线失败和重启后继续执行，保持原目标数量', () => {
  const f = fixture();
  assert.equal(f.execute('reduce').pending, true, '建仓当天保存T+1阻止的减仓目标');
  f.sellable();
  const target = f.engine.s.agency.executionIntents[0].targetQuantity;
  f.restart();
  const risk = f.engine.s.risks[SYMBOL], history = structuredClone(risk.history);
  const snap = f.snapshot({ error: '日线获取失败' });
  snap.technical.ma20 = 1;
  const [exit] = f.tick(snap);
  assert.equal(exit?.quantity, f.buy.quantity - target);
  assert.equal(f.engine.positions()[0].quantity, target);
  assert.equal(f.engine.s.agency.executionIntents[0].status, 'completed');
  assert.equal(risk.pendingExit, undefined); assert.deepEqual(risk.history, history);
  assert.equal(validState(f.engine.s), true);
});

test('日线回退路径仍保留T+1、部分成交、盘口去重和后续报价重试', () => {
  const f = fixture(); f.verify();
  f.engine.s.risks[SYMBOL].pendingExit = '止损触发';
  assert.equal(f.tick(f.snapshot({ error: '日线暂缺' })).length, 0);
  assert.match(f.engine.s.risks[SYMBOL].note, /T\+1/);
  f.sellable();
  const q = f.quote({ bidSize: 100 }), snap = f.snapshot({ error: '日线暂缺' });
  assert.equal(f.tick(snap, q)[0]?.quantity, 100);
  assert.equal(f.tick(snap, q).length, 0);
  assert.match(f.engine.s.risks[SYMBOL].note, /一档数量不足/);
  f.advance(1000);
  assert.equal(f.tick(f.snapshot({ error: '日线暂缺' }))[0]?.quantity, f.buy.quantity - 100);
  assert.equal(f.engine.positions().length, 0); assert.equal(validState(f.engine.s), true);
});

for (const constraint of ['quote-stale', 'suspended', 'no-book', 'stopped', 'risk-disabled', 'closed']) {
  test(`日线回退不绕过 ${constraint} 成交约束`, () => {
    const f = fixture(); f.sellable();
    f.engine.s.risks[SYMBOL].pendingExit = '止损触发';
    if (constraint === 'stopped') f.engine.agencyMode({ strategyId: 'swing', mode: 'stopped' });
    if (constraint === 'risk-disabled') f.engine.s.risks[SYMBOL].enabled = false;
    if (constraint === 'closed') f.advance(2 * 3600000);
    const q = f.quote();
    if (constraint === 'quote-stale') q.timestamp -= 90001;
    if (constraint === 'suspended') q.volume = 0;
    if (constraint === 'no-book') q.bidSize = 0;
    assert.equal(f.tick(f.snapshot({ error: '日线暂缺' }), q).length, 0);
    assert.equal(f.engine.positions()[0].quantity, f.buy.quantity);
    assert.equal(validState(f.engine.s), true);
  });
}

for (const failure of ['unavailable', 'coverage', 'expired']) {
  test(`日线失败时公司行为资料 ${failure} 仍阻断已锁定退出`, () => {
    const f = fixture(); f.sellable();
    f.engine.s.risks[SYMBOL].pendingExit = '止损触发';
    const snap = f.snapshot({ error: '日线暂缺' });
    if (failure === 'unavailable') snap.corporateActions.status = 'unavailable';
    if (failure === 'coverage') snap.corporateActions.coverageComplete = false;
    if (failure === 'expired') snap.corporateActions.fetchedAt -= 300001;
    assert.equal(f.tick(snap).length, 0);
    assert.match(f.engine.s.risks[SYMBOL].note, /公司行为实施资料/);
    assert.equal(f.member().reconciliation.status, 'pending');
  });
}

test('新的权益公告和已记录的价格基准异常不能被日线回退解除', () => {
  const f = fixture(); f.sellable(); f.engine.s.risks[SYMBOL].pendingExit = '止损触发';
  const snap = f.snapshot({ error: '日线暂缺' }); delete snap.corporateActions;
  snap.notices.status = 'ready'; snap.notices.data = { total: 1,
    items: [{ id: 'AN123456789012', date: '2026-09-30', title: '权益分派实施公告' }] };
  assert.equal(f.tick(snap).length, 0); assert.match(f.member().reconciliation.reason, /公司行为公告/);
  const pending = structuredClone(f.member().reconciliation);
  assert.equal(f.tick(f.snapshot({ error: '日线暂缺' })).length, 0);
  assert.deepEqual(f.member().reconciliation, pending);

  const price = fixture(); price.sellable(); price.engine.s.risks[SYMBOL].pendingExit = '止损触发';
  assert.equal(price.tick(price.snapshot({ error: '日线暂缺' }), price.quote({ prevClose: 8 })).length, 0);
  assert.match(price.member().reconciliation.reason, /价格基准不一致/);
  const blocked = structuredClone(price.member().reconciliation);
  assert.equal(price.tick(price.snapshot({ error: '日线暂缺' })).length, 0);
  assert.deepEqual(price.member().reconciliation, blocked);
});

test('旧账户、跨日及手工对账后的待核价不能复用旧退出基准', () => {
  for (const change of ['old-account', 'next-day', 'manual-reconcile']) {
    const f = fixture(); f.sellable(); f.engine.s.risks[SYMBOL].pendingExit = '止损触发';
    if (change === 'old-account') delete f.member().exitPriceBasis;
    if (change === 'next-day') f.day('2026-10-08');
    if (change === 'manual-reconcile') f.engine.agencyReconcile({ strategyId: 'swing', symbol: SYMBOL,
      eventId: 'manual-check', effectiveDate: '2026-09-30', confirmationOnly: true, evidence: '人工核对公司行为资料并等待当日价格核验' });
    assert.equal(f.tick(f.snapshot({ error: '日线暂缺' })).length, 0, change);
    assert.equal(f.engine.positions()[0].quantity, f.buy.quantity);
    assert.equal(validState(f.engine.s), true);
  }
});

test('迟到的除息实施资料改变价格基准，须重新核价后才恢复退出', () => {
  const f = fixture(); f.sellable(); f.engine.s.risks[SYMBOL].pendingExit = '止损触发';
  const oldStop = f.engine.s.risks[SYMBOL].stop, oldBasis = structuredClone(f.member().exitPriceBasis);
  const snap = f.snapshot({ error: '日线暂缺' });
  snap.corporateActions.events = [{ eventId: 'late-dividend', noticeIds: ['AN123456789012'], sourceUrl: 'https://example.test/implementation',
    status: 'implemented', recordDate: '2026-09-29', exDate: '2026-09-30', payDate: '2026-10-08',
    cashPerShare: 0.1, bonusPerShare: 0, transferPerShare: 0, taxPolicy: 'cn-individual-deferred-v1' }];
  assert.equal(f.tick(snap).length, 0);
  assert.equal(f.engine.s.risks[SYMBOL].stop, Math.round((oldStop - 0.1) * 100) / 100);
  assert.deepEqual(f.member().exitPriceBasis, oldBasis);
  assert.equal(f.tick(snap, f.quote({ prevClose: 9.95 })).length, 0);
  delete snap.error;
  assert.equal(f.tick(snap, f.quote({ prevClose: 9.95 }))[0]?.side, 'sell');
  assert.equal(validState(f.engine.s), true);
});

test('缺失全部快照时仍遵守独立公司资料5分钟期限，不能靠重复轮询续期', () => {
  const f = fixture(); f.sellable(); f.engine.s.risks[SYMBOL].pendingExit = '止损触发';
  const basis = structuredClone(f.member().exitPriceBasis);
  f.advance(180001);
  assert.equal(f.tick(undefined, f.quote({ bidSize: 0 })).length, 0);
  assert.match(f.engine.s.risks[SYMBOL].note, /一档数量不足/);
  assert.deepEqual(f.member().exitPriceBasis, basis);
  f.advance(120000);
  assert.equal(f.tick(undefined).length, 0);
  assert.match(f.engine.s.risks[SYMBOL].note, /公司行为公告资料尚未核验/);
  assert.equal(f.tick(f.snapshot({ error: '日线暂缺' }))[0]?.side, 'sell', '独立公司资料恢复后继续退出');
});

test('退出回退不放宽常规自动交易核验，损坏的基准记录拒绝加载', () => {
  const f = fixture(); f.sellable();
  assert.match(f.engine.agencyAutomaticBlock(SYMBOL, f.quote(), f.snapshot({ error: '日线暂缺' })), /日线暂缺/);
  for (const patch of [{ prevClose: NaN }, { date: 'bad' }, { dailyAsOf: '2026-09-30' }, { corporateBasis: null }]) {
    const state = structuredClone(f.engine.s);
    Object.assign(state.agency.groups.find(g => g.id === 'swing').members[0].exitPriceBasis, patch);
    assert.equal(validState(state), false);
  }
});
