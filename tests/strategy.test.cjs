const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const { cnTime } = require('../core/common.cjs');
const { technicals, evaluateEntry, configureStrategy, economics } = require('../core/strategy.cjs');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const { Market } = require('../core/market.cjs');

function fixture() {
  let now = new Date('2026-09-29T10:00:00+08:00');
  const engine = new Engine(initialState(100000), () => now);
  const q = (overrides = {}) => ({ symbol: 'sz000001', name: '策略测试', price: 10.1, prevClose: 10.05, open: 10, low: 10, high: 10.2, volume: 100000,
    bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05, timestamp: now.getTime(), date: cnTime(now).date, ...overrides });
  const snapshot = (overrides = {}) => ({ fetchedAt: now.getTime(),
    notices: { symbol: 'sz000001', section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), checkedAt: now.getTime(), data: { items: [], total: 0 } },
    technical: { asOf: '2026-09-28', close: 10.05, ma5: 10, ma20: 10, ma60: 9.5,
    atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false, support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-09-28'], ...overrides } });
  const buy = quantity => engine.strategyEntry({ symbol: '000001', quantity }, q(), snapshot());
  return { engine, q, snapshot, buy, day: date => { now = new Date(date); } };
}

function bars() {
  return Array.from({ length: 80 }, (_, i) => { const close = 10 + i * 0.015 + Math.sin(i / 2) * 0.08; return { date: new Date(Date.UTC(2026, 6, 11 + i)).toISOString().slice(0, 10), open: close - 0.03, close, high: close + 0.2, low: close - 0.2, volume: 10000 }; });
}

test('老账户补齐策略参数，保留持仓、现金与手动风控', () => {
  const f = fixture(); f.engine.execute({ symbol: '000001', side: 'buy', quantity: 100 }, f.q()); f.engine.setRisk('000001', { stop: 9, target: 12, enabled: true });
  const old = structuredClone(f.engine.s); delete old.strategySettings;
  const migrated = new Engine(old);
  assert.equal(migrated.s.strategySettings.minRewardRisk, 2); assert.equal(migrated.s.cash, f.engine.s.cash); assert.deepEqual(migrated.s.lots, f.engine.s.lots); assert.deepEqual(migrated.s.risks, f.engine.s.risks);
  assert.throws(() => configureStrategy({ minRewardRisk: 2, riskPercent: 5, adjustmentAtr: 0.25 }));
});

test('策略只用已收盘日线，盘中极值与未来数据不改变计划', () => {
  const data = bars(), now = new Date('2026-09-29T10:00:00+08:00');
  const a = technicals(data, now);
  const changed = [...data, { date: '2026-09-29', open: 100, close: 999, high: 1000, low: 1, volume: 1 }, { date: '2026-10-01', open: 1, close: 1, high: 1, low: 1, volume: 1 }];
  assert.deepEqual(technicals(changed, now), a);
  assert.throws(() => technicals(data.slice(0, 60), now), /不足/);
  assert.throws(() => technicals([...data, data.at(-1)], now), /重复/);
});

test('买入计划按费用、滑点、风险预算与申报数量计算，并原子关联成交', () => {
  const { engine, q, snapshot, buy } = fixture();
  const signal = evaluateEntry(engine, 'sz000001', q(), snapshot());
  assert.equal(signal.buyable, true); assert.ok(signal.quantity >= 100 && signal.quantity % 100 === 0);
  assert.ok(signal.economics.loss <= signal.budget); assert.ok(signal.economics.rewardRisk >= 2);
  assert.equal(signal.plan.entry, 10.11);
  const trade = buy(signal.quantity), risk = engine.s.risks.sz000001;
  assert.equal(risk.entryTradeId, trade.id); assert.equal(risk.entryPrice, trade.price); assert.equal(risk.stop, 9.6); assert.equal(risk.target, 11.5);
  assert.equal(trade.strategyPlan.economics.loss, economics(trade.price, risk.stop, risk.target, trade.quantity, engine.s.settings).loss);
  engine.s.strategySettings.adjustmentAtr = 0.5; assert.equal(risk.config.adjustmentAtr, 0.25);
});

test('趋势、回踩、盘中确认和含费空间分别阻止不合格买入', () => {
  const { engine, q, snapshot } = fixture();
  assert.equal(evaluateEntry(engine, 'sz000001', q(), snapshot({ trend: false })).status, '等待趋势');
  assert.equal(evaluateEntry(engine, 'sz000001', q({ ask: 10.8 }), snapshot()).status, '等待回踩');
  assert.equal(evaluateEntry(engine, 'sz000001', q({ open: 10.2 }), snapshot()).status, '等待确认');
  assert.equal(evaluateEntry(engine, 'sz000001', q(), snapshot({ target: 10.5 })).status, '空间不足');
  const before = structuredClone(engine.s);
  assert.throws(() => engine.strategyEntry({ symbol: '000001', quantity: 100 }, q(), snapshot({ target: 10.5 })), /空间不足/);
  assert.deepEqual(engine.s, before);
});

test('缺失、过期、基准错配日线及停牌/跨日报价不会放行模拟建仓', () => {
  const { engine, q, snapshot } = fixture();
  for (const snap of [null, { error: '断线' }, { ...snapshot(), fetchedAt: 0 }, snapshot({ close: 20 })]) assert.equal(evaluateEntry(engine, 'sz000001', q(), snap).buyable, false);
  for (const quote of [q({ timestamp: 0 }), q({ volume: 0 }), q({ date: '2026-09-28' }), q({ ask: 0 })]) assert.equal(evaluateEntry(engine, 'sz000001', quote, snapshot()).buyable, false);
});

test('一档数量、余额、单股仓位和科创板最低数量约束计划规模', () => {
  const { engine, q, snapshot } = fixture();
  assert.equal(evaluateEntry(engine, 'sz000001', q({ askSize: 100 }), snapshot()).quantity, 100);
  assert.equal(evaluateEntry(engine, 'sz000001', q({ askSize: 99 }), snapshot()).buyable, false);
  engine.s.cash = 100; assert.equal(evaluateEntry(engine, 'sz000001', q(), snapshot()).buyable, false);
  engine.s.cash = 10000000; engine.s.settings.maxPosition = 0.01;
  assert.equal(evaluateEntry(engine, 'sz000001', q(), snapshot()).buyable, false);
  engine.s.settings.maxPosition = 0.3;
  const starSnapshot = snapshot(); starSnapshot.notices.symbol = 'sh688001';
  const star = evaluateEntry(engine, 'sh688001', q({ symbol: 'sh688001', askSize: 201 }), starSnapshot);
  assert.equal(star.buyable, true); assert.equal(star.quantity, 201);
});

test('成交重验拒绝上涨买价、变化计划和超过预算数量，账户不受影响', () => {
  const { engine, q, snapshot } = fixture(), signal = evaluateEntry(engine, 'sz000001', q(), snapshot());
  const before = structuredClone(engine.s);
  assert.throws(() => engine.strategyEntry({ symbol: '000001', quantity: 300, expected: signal.plan }, q({ ask: 10.11 }), snapshot()), /变化/);
  assert.throws(() => engine.strategyEntry({ symbol: '000001', quantity: 300, expected: signal.plan }, q(), snapshot({ stop: 9.61 })), /变化/);
  assert.throws(() => engine.strategyEntry({ symbol: '000001', quantity: 10000 }, q(), snapshot()), /上限/);
  assert.deepEqual(engine.s, before);
});

test('待执行买单、已有持仓和策略加仓互斥', () => {
  const { engine, q, snapshot, buy } = fixture();
  const order = engine.place({ symbol: '000001', side: 'buy', quantity: 100, limit: 10 });
  assert.equal(evaluateEntry(engine, 'sz000001', q(), snapshot()).status, '已有买入委托');
  engine.cancel(order.id); buy(100);
  assert.equal(evaluateEntry(engine, 'sz000001', q(), snapshot()).status, '持仓跟踪');
  assert.throws(() => engine.execute({ symbol: '000001', side: 'buy', quantity: 100 }, q()), /不能加仓/);
});

test('每天新日线最多调整一次，止损只上移且止盈上调伴随保护', () => {
  const { engine, q, snapshot, buy, day } = fixture(); buy(100); day('2026-09-30T10:00:00+08:00');
  const quote = q({ prevClose: 10.4, price: 10.6 }), snap = snapshot({ asOf: '2026-09-29', close: 10.4, support: 10.2, breakout: true });
  engine.tick({ sz000001: quote }, { sz000001: snap });
  const risk = engine.s.risks.sz000001;
  assert.equal(risk.stop, 9.7); assert.equal(risk.target, 11.6); assert.equal(risk.history.length, 2);
  engine.tick({ sz000001: quote }, { sz000001: snap }); assert.equal(risk.history.length, 2);
  day('2026-10-01T10:00:00+08:00'); // Controlled quote, not a holiday-calendar assertion.
  engine.tick({ sz000001: q({ prevClose: 10.3, price: 10.4 }) }, { sz000001: snapshot({ asOf: '2026-09-30', close: 10.3, support: 9.1 }) });
  assert.equal(risk.stop, 9.7); assert.equal(risk.history.length, 3);
});

test('动能减弱时止盈小幅下调，不穿越止损', () => {
  const { engine, q, snapshot, buy, day } = fixture(); buy(100); day('2026-09-30T10:00:00+08:00');
  engine.tick({ sz000001: q({ prevClose: 10.2, price: 10.25 }) }, { sz000001: snapshot({ asOf: '2026-09-29', close: 10.2, ma5: 10.4 }) });
  const risk = engine.s.risks.sz000001;
  assert.equal(risk.stop, 9.6); assert.equal(risk.target, 11.4); assert.ok(risk.target > risk.stop);
});

test('触及旧止盈先退出，不能通过新日线把目标移走', () => {
  const { engine, q, snapshot, buy, day } = fixture(); buy(100); day('2026-09-30T10:00:00+08:00');
  engine.tick({ sz000001: q({ prevClose: 11.4, price: 11.6, bid: 11.59, limitUp: 12.5, limitDown: 10 }) }, { sz000001: snapshot({ asOf: '2026-09-29', close: 11.4, support: 11, breakout: true }) });
  assert.equal(engine.positions().length, 0); const trade = engine.s.trades.at(-1);
  assert.equal(trade.reason, '止盈触发'); assert.equal(trade.riskSnapshot.target, 11.5); assert.equal(trade.riskSnapshot.history.length, 1);
});

test('T+1 触发信号锁存，次日即使反弹也完成退出并禁止同信号再买', () => {
  const { engine, q, snapshot, buy, day } = fixture(); buy(100);
  engine.tick({ sz000001: q({ price: 9.5 }) });
  assert.equal(engine.s.risks.sz000001.pendingExit, '止损触发'); assert.match(engine.s.risks.sz000001.note, /T\+1/);
  const resumed = new Engine(JSON.parse(JSON.stringify(engine.s)), engine.clock);
  day('2026-09-30T10:00:00+08:00'); resumed.tick({ sz000001: q({ price: 10.1 }) });
  assert.equal(resumed.positions().length, 0); assert.equal(resumed.s.trades.at(-1).reason, '止损触发');
  assert.equal(evaluateEntry(resumed, 'sz000001', q(), snapshot()).status, '等待新日线');
});

test('盘口不足只部分退出，剩余计划和已触发信号重启后继续保留', () => {
  const { engine, q, buy, day } = fixture(); buy(300); day('2026-09-30T10:00:00+08:00');
  const quote = q({ price: 9.5, bid: 9.49, bidSize: 100 });
  engine.tick({ sz000001: quote }); assert.equal(engine.positions()[0].quantity, 200);
  const resumed = new Engine(JSON.parse(JSON.stringify(engine.s)), engine.clock);
  resumed.tick({ sz000001: quote }); assert.equal(resumed.positions()[0].quantity, 200);
  resumed.tick({ sz000001: q({ timestamp: quote.timestamp + 1000, bidSize: 200 }) });
  assert.equal(resumed.positions().length, 0); assert.equal(resumed.stats().pnl, resumed.stats().realized);
});

test('趋势失效与持有超时触发退出，失效不是放宽止损', () => {
  for (const timeExit of [false, true]) {
    const { engine, q, snapshot, buy, day } = fixture(); buy(100); day('2026-09-30T10:00:00+08:00');
    if (timeExit) engine.s.risks.sz000001.entryDate = '2026-08-01';
    const snap = snapshot({ asOf: '2026-09-29', close: timeExit ? 10.05 : 9.7, dates: bars().map(b => b.date), ma20: 10 });
    engine.tick({ sz000001: q({ prevClose: snap.technical.close }) }, { sz000001: snap });
    assert.equal(engine.positions().length, 0); assert.equal(engine.s.trades.at(-1).reason, timeExit ? '波段持有超时' : '波段趋势失效');
  }
});

test('暂停动态更新保留价位，暂停自动卖出仍记录触发，重新启用后退出', () => {
  const { engine, q, snapshot, buy, day } = fixture(); buy(100);
  engine.setRisk('000001', { enabled: false, dynamic: false, stop: 1, target: 99 });
  assert.equal(engine.s.risks.sz000001.stop, 9.6);
  day('2026-09-30T10:00:00+08:00');
  engine.tick({ sz000001: q({ prevClose: 10.4, price: 10.6 }) }, { sz000001: snapshot({ asOf: '2026-09-29', close: 10.4, support: 10.2 }) });
  assert.equal(engine.s.risks.sz000001.stop, 9.6);
  engine.tick({ sz000001: q({ price: 9.5 }) }); assert.equal(engine.positions().length, 1); assert.equal(engine.s.risks.sz000001.pendingExit, '止损触发');
  engine.setRisk('000001', { enabled: true, dynamic: true }); engine.tick({ sz000001: q() }); assert.equal(engine.positions().length, 0);
});

test('日线断线/价格基准变化不调整已存计划，原有止损继续执行', () => {
  const { engine, q, snapshot, buy, day } = fixture(); buy(100); day('2026-09-30T10:00:00+08:00');
  engine.tick({ sz000001: q() }, { sz000001: snapshot({ asOf: '2026-09-29', close: 20 }) });
  assert.equal(engine.s.risks.sz000001.stop, 9.6); assert.match(engine.s.risks.sz000001.reviewNote, /不一致/);
  engine.tick({ sz000001: q({ price: 9.5 }) }, { sz000001: { error: '断线' } }); assert.equal(engine.positions().length, 0);
});

test('未复权接口只接受 day 字段，不能回退前复权数据用于成交', async () => {
  const raw = bars().map(b => [b.date, b.open, b.close, b.high, b.low, b.volume / 100]);
  const market = new Market(async url => { assert.ok(url.endsWith('120,')); return { ok: true, json: async () => ({ data: { sz000001: { day: raw } } }) }; });
  assert.deepEqual(await market.strategyHistory('sz000001'), bars());
  market.fetcher = async () => ({ ok: true, json: async () => ({ data: { sz000001: { qfqday: raw } } }) });
  await assert.rejects(market.strategyHistory('sz000001'), /未复权/);
});

test('后台扫描覆盖全部标的、合并并发、缓存一分钟，失败后移除旧信号', async () => {
  let calls = 0, fail = false, now = new Date('2026-09-29T10:00:00+08:00');
  const monitor = new StrategyMonitor({ strategyHistory: async () => { calls++; if (fail) throw Error('断线'); return bars(); } }, () => now);
  await Promise.all([monitor.load('sz000001'), monitor.load('sz000001')]); assert.equal(calls, 1);
  await monitor.scan(['sz000001', 'sh600519', 'sz300750']); assert.equal(calls, 3); assert.equal(Object.keys(monitor.snapshots).length, 3);
  fail = true; now = new Date(now.getTime() + 61000); await monitor.scan(['sz000001']);
  assert.match(monitor.snapshots.sz000001.error, /断线/); assert.equal(monitor.snapshots.sz000001.technical, undefined);
});
