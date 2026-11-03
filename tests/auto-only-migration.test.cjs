'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { AccountOperations } = require('../core/account-operations.cjs');
const { Store } = require('../core/store.cjs');

function fixture(capital = 100000) {
  let now = new Date('2026-10-20T10:00:00+08:00');
  const engine = new Engine(initialState(capital), () => now);
  const quote = (extra = {}) => ({ symbol: 'sz000001', name: '历史持仓隔离样本', price: 10, open: 10, volume: 100000,
    bid: 9.99, ask: 10.01, bidSize: 10000, askSize: 10000, limitUp: 11, limitDown: 9,
    timestamp: +now, date: now.toISOString().slice(0, 10), ...extra });
  const buy = quantity => engine.execute({ symbol: 'sz000001', side: 'buy', quantity }, quote());
  return { engine, quote, buy, nextDay: () => { now = new Date('2026-10-21T10:00:00+08:00'); } };
}
function entrySnapshot(f) {
  return { fetchedAt: +f.engine.clock(), notices: { symbol: 'sz000001', section: 'notices', source: '东方财富', status: 'empty', fetchedAt: +f.engine.clock(), data: { items: [], total: 0 } },
    technical: { asOf: '2026-10-19', close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1,
      trend: true, support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-10-19'] } };
}

test('新账户不初始化人工自选且直接使用自动专用 v8 账本，重启不产生迁移变化', () => {
  const initial = initialState(); assert.deepEqual(initial.watchlist, []);
  const engine = new Engine(initial);
  assert.equal(engine.s.agency.version, 8); assert.deepEqual(engine.s.agency.legacyManual.watchlist, []);
  assert.deepEqual(engine.s.agency.legacyManual.cancelledOrderIds, []);
  assert.equal(engine.agencyState().migrationNotice.kind, 'technical-trading-upgrade'); assert.equal(validState(engine.s), true);
  assert.deepEqual(new Engine(structuredClone(engine.s)).s, engine.s);
});

test('v6一次归档人工自选并撤销所有旧待执行条件单，账户事实和原风险完整保留', () => {
  const f = fixture(); f.buy(200); f.engine.setRisk('sz000001', { stop: 9, target: 11, enabled: false });
  f.engine.agencyTransfer({ strategyId: 'swing', amount: 20000 });
  const buyOrder = f.engine.place({ symbol: 'sh600000', side: 'buy', quantity: 100, limit: 10.5 });
  const sellOrder = f.engine.place({ symbol: 'sz000001', side: 'sell', quantity: 100, limit: 9 });
  const ended = f.engine.place({ symbol: 'sh600001', side: 'buy', quantity: 100, limit: 10 }); f.engine.cancel(ended.id);
  const old = structuredClone(f.engine.s); old.agency.version = 6; delete old.agency.legacyManual; delete old.agency.technicalTradingVersion;
  old.watchlist = ['sz000001', 'sh600000'];
  old.agency.migrationNotice = { kind: 'candidate-capacity-upgrade', changedMembers: 23, message: '每组最多 6 只活跃候选，个人条件保留', time: f.engine.clock().toISOString() };
  const before = structuredClone(old), upgraded = new Engine(old, f.engine.clock);
  assert.equal(upgraded.s.agency.version, 8); assert.deepEqual(upgraded.s.watchlist, []);
  assert.deepEqual(upgraded.s.agency.legacyManual, { watchlist: before.watchlist, migratedAt: f.engine.clock().toISOString(), cancelledOrderIds: [buyOrder.id, sellOrder.id] });
  for (const order of upgraded.s.orders.slice(0, 2)) {
    assert.equal(order.status, 'cancelled'); assert.equal(order.cancelledAt, f.engine.clock().toISOString());
    assert.match(order.cancelReason, /升级自动交易专用版/); assert.equal(order.note, order.cancelReason);
  }
  assert.deepEqual(upgraded.s.orders[2], before.orders[2]);
  for (const key of ['cash', 'lots', 'trades', 'risks', 'settings', 'strategySettings', 'planSelections']) assert.deepEqual(upgraded.s[key], before[key]);
  for (const key of ['manualCash', 'groups', 'transfers', 'executionIntents']) assert.deepEqual(upgraded.s.agency[key], before.agency[key]);
  assert.equal(upgraded.s.agency.migrationNotice.kind, 'technical-trading-upgrade');
  assert.match(upgraded.s.agency.migrationNotice.message, /每组最多 6 只/); assert.match(upgraded.s.agency.migrationNotice.message, /撤销 2 条/);
  assert.equal(validState(upgraded.s), true);
  assert.deepEqual(new Engine(structuredClone(upgraded.s), f.engine.clock).s, upgraded.s, '重启不能重复迁移或改变已归档的记录');
  f.nextDay(); const orders = structuredClone(upgraded.s.orders), count = upgraded.s.trades.length;
  assert.deepEqual(upgraded.tick({ sz000001: f.quote(), sh600000: f.quote({ symbol: 'sh600000' }) }), []);
  assert.deepEqual(upgraded.s.orders, orders); assert.equal(upgraded.s.trades.length, count);
});

test('v6运行组的无筛选记录成员先转候补，无候选池时也不能在首次自动扫描前开仓', () => {
  const f = fixture(); f.engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
  f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'add', entryConditions: { rules: [{ field: 'price', op: 'lt', value: 30 }] } });
  f.engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const old = structuredClone(f.engine.s); old.agency.version = 6; delete old.agency.legacyManual; delete old.agency.technicalTradingVersion;
  assert.equal(old.agency.pool, null); const conditions = structuredClone(old.agency.groups.find(group => group.id === 'swing').members[0].entryConditions);
  const engine = new Engine(old, f.engine.clock), group = engine.s.agency.groups.find(item => item.id === 'swing'), member = group.members[0];
  assert.equal(group.mode, 'running'); assert.equal(member.mode, 'standby'); assert.match(member.standbyReason, /等待自动策略筛选/);
  assert.deepEqual(member.entryConditions, conditions); assert.equal(engine.s.agency.migrationNotice.autoOnly.changedMembers, 1);
  const quote = f.quote({ price: 10.1, prevClose: 10.05, ask: 10.1, bid: 10.09, low: 10, high: 10.2 }), snapshot = entrySnapshot(f);
  assert.equal(engine.agencyEvaluate('swing', member.symbol, quote, snapshot).buyable, false);
  assert.throws(() => engine.agencyExecute({ strategyId: 'swing', symbol: member.symbol, action: 'buy', targetPercent: 20,
    decisionId: 'must-not-buy-before-first-scan', expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, quote, snapshot), /候补|暂停/);
  assert.equal(engine.s.trades.length, 0); assert.equal(engine.s.lots.length, 0); assert.equal(validState(engine.s), true);
  assert.deepEqual(new Engine(structuredClone(engine.s), f.engine.clock).s, engine.s);
});

test('v6仅保留本策略当前pass资格，严格成员须严格pass，退出安排和原候补原因不变', () => {
  const f = fixture(), check = (strategyId, extra = {}) => ({ policyVersion: 3, screeningMode: 'strategy', status: 'pass',
    checkedAt: f.engine.clock().toISOString(), matchedStrategies: [strategyId], reasons: [], ...extra });
  const add = (strategyId, symbol, extra = {}) => {
    f.engine.agencyMember({ strategyId, symbol, action: 'add' });
    return Object.assign(f.engine.s.agency.groups.find(group => group.id === strategyId).members.at(-1), extra);
  };
  add('swing', 'sz000001', { poolCheck: check('swing') });
  add('swing', 'sh600000');
  add('swing', 'sh600001', { poolCheck: check('swing', { policyVersion: 2 }) });
  add('swing', 'sh600002', { poolCheck: check('swing', { status: 'failed' }) });
  add('swing', 'sh600003', { poolCheck: check('short') });
  add('swing', 'sh600004', { poolCheck: check('swing', { status: 'pending' }) });
  add('short', 'sh600100', { selectionMode: 'strict', poolCheck: check('short', { screeningMode: 'strict' }) });
  add('short', 'sh600101', { selectionMode: 'strict', poolCheck: check('short') });
  add('short', 'sh600102', { mode: 'closing' }); add('short', 'sh600103', { mode: 'removing' });
  add('short', 'sh600104', { mode: 'standby', standbyReason: '保留已有候补原因' });
  const old = structuredClone(f.engine.s); old.agency.version = 6; delete old.agency.legacyManual; delete old.agency.technicalTradingVersion;
  old.agency.migrationNotice = { kind: 'candidate-capacity-upgrade', time: f.engine.clock().toISOString(), changedMembers: 23, message: '容量升级原提示保留' };
  const before = structuredClone(old), engine = new Engine(old, f.engine.clock);
  const member = symbol => engine.s.agency.groups.flatMap(group => group.members).find(item => item.symbol === symbol);
  for (const symbol of ['sh600000', 'sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh600101']) {
    assert.equal(member(symbol).mode, 'standby', symbol); assert.match(member(symbol).standbyReason, /等待自动策略筛选/);
  }
  for (const symbol of ['sz000001', 'sh600100', 'sh600102', 'sh600103', 'sh600104']) {
    const prior = structuredClone(before.agency.groups.flatMap(group => group.members).find(item => item.symbol === symbol));
    if (prior.selectionMode === 'strict') prior.selectionMode = 'strategy';
    assert.deepEqual(member(symbol), prior);
  }
  assert.equal(engine.s.agency.migrationNotice.changedMembers, 2); assert.equal(engine.s.agency.migrationNotice.autoOnly.changedMembers, 6);
  assert.match(engine.s.agency.migrationNotice.message, /容量升级原提示保留/); assert.equal(validState(engine.s), true);
  assert.deepEqual(new Engine(structuredClone(engine.s), f.engine.clock).s, engine.s);
});

test('v6自动持仓即使没有筛选记录也保留原成员模式、退出安排及账务', () => {
  for (const mode of ['active', 'closing', 'removing']) {
    const f = fixture(); f.engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
    f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'add' }); f.engine.agencyMode({ strategyId: 'swing', mode: 'running' });
    const quote = f.quote({ price: 10.1, prevClose: 10.05, ask: 10.1, bid: 10.09, low: 10, high: 10.2 }), snapshot = entrySnapshot(f);
    f.engine.agencyExecute({ strategyId: 'swing', symbol: 'sz000001', action: 'buy', targetPercent: 20, decisionId: `holding-${mode}`,
      expectedEpoch: f.engine.s.agency.epoch, expectedRevision: f.engine.s.agency.revision }, quote, snapshot);
    f.engine.s.agency.groups.find(group => group.id === 'swing').members[0].mode = mode;
    const old = structuredClone(f.engine.s); old.agency.version = 6; delete old.agency.legacyManual; delete old.agency.technicalTradingVersion;
    const before = structuredClone(old), engine = new Engine(old, f.engine.clock);
    assert.deepEqual(engine.s.agency.groups, before.agency.groups);
    for (const key of ['cash', 'lots', 'trades', 'risks']) assert.deepEqual(engine.s[key], before[key]);
    assert.deepEqual(engine.s.agency.executionIntents, before.agency.executionIntents);
    assert.equal(engine.s.agency.migrationNotice.autoOnly.changedMembers, 0); assert.equal(validState(engine.s), true);
    assert.deepEqual(new Engine(structuredClone(engine.s), f.engine.clock).s, engine.s);
  }
});

test('无自动账本的旧账户同样归档自选和撤单，原手动持仓不被策略接管', () => {
  const f = fixture(); f.buy(100); f.engine.place({ symbol: 'sh600000', side: 'buy', quantity: 100, limit: 11 });
  const old = structuredClone(f.engine.s); delete old.agency; old.watchlist = ['sz000001'];
  const next = new Engine(old, f.engine.clock);
  assert.equal(next.s.agency.version, 8); assert.deepEqual(next.s.watchlist, []);
  assert.deepEqual(next.s.agency.legacyManual.watchlist, ['sz000001']); assert.equal(next.s.orders[0].status, 'cancelled');
  assert.equal(next.s.lots[0].owner, 'manual'); assert.equal(next.s.agency.manualCash, next.s.cash); assert.equal(validState(next.s), true);
});

test('v8归档格式损坏、撤单记录缺失和伪降级拒绝恢复', () => {
  const f = fixture(); f.engine.place({ symbol: 'sh600000', side: 'buy', quantity: 100, limit: 11 });
  const old = structuredClone(f.engine.s); old.agency.version = 6; delete old.agency.legacyManual; delete old.agency.technicalTradingVersion;
  const state = new Engine(old, f.engine.clock).s;
  for (const change of [
    s => { delete s.agency.legacyManual; },
    s => { s.agency.legacyManual.watchlist = 'sh600000'; },
    s => { s.agency.legacyManual.migratedAt = 'bad-time'; },
    s => { s.agency.legacyManual.cancelledOrderIds.push('missing-order'); },
    s => { s.orders[0].status = 'pending'; },
    s => { s.orders[0].cancelledAt = '2026-10-19T02:00:00.000Z'; },
    s => { s.agency.version = 6; },
    s => { s.agency.version = 7; },
    s => { s.agency.version = 9; }
  ]) {
    const broken = structuredClone(state); change(broken);
    assert.equal(validState(broken), false); assert.throws(() => new Engine(broken), /格式/);
  }
});

test('历史持仓退出按全部当前可卖量成交，保留当日不可卖持仓、原费用与资金归属', () => {
  const f = fixture(), first = f.buy(300); f.nextDay(); const second = f.buy(100);
  f.engine.agencyTransfer({ strategyId: 'swing', amount: 20000 });
  const groupCash = f.engine.s.agency.groups.find(group => group.id === 'swing').cash, cash = f.engine.s.cash;
  const trade = f.engine.legacyExit({ symbol: 'sz000001' }, f.quote());
  assert.equal(trade.quantity, 300); assert.equal(trade.side, 'sell'); assert.equal(trade.owner, 'manual'); assert.equal(trade.reason, '历史手动持仓退出');
  assert.equal(trade.cost, first.gross + first.fees.total); assert.equal(trade.pnl, trade.gross - trade.fees.total - trade.cost);
  assert.equal(f.engine.s.cash, cash + trade.gross - trade.fees.total); assert.equal(f.engine.s.agency.manualCash, f.engine.s.cash - groupCash);
  assert.equal(f.engine.s.agency.groups.find(group => group.id === 'swing').cash, groupCash);
  assert.equal(f.engine.positions()[0].quantity, 100); assert.equal(f.engine.positions()[0].available, 0); assert.equal(f.engine.s.lots[0].cost, second.gross + second.fees.total);
  assert.equal(validState(f.engine.s), true); assert.deepEqual(new Engine(structuredClone(f.engine.s), f.engine.clock).s, f.engine.s);
});

test('历史退出不能买入、自选数量、接管自动成员或绕过T+1、停牌和盘口校验', () => {
  const f = fixture(); f.buy(300);
  for (const input of [{ side: 'buy' }, { side: 'sell' }, { quantity: 100 }, { limit: 1 }, {}]) {
    const before = structuredClone(f.engine.s);
    assert.throws(() => f.engine.legacyExit({ symbol: 'sz000001', ...input }, f.quote()), /不能指定|T\+1/);
    assert.deepEqual(f.engine.s, before);
  }
  f.nextDay();
  for (const quote of [f.quote({ bidSize: 99 }), f.quote({ bidSize: 0 }), f.quote({ volume: 0 }), f.quote({ timestamp: +f.engine.clock() - 91000 })]) {
    const before = structuredClone(f.engine.s);
    assert.throws(() => f.engine.legacyExit({ symbol: 'sz000001' }, quote), /数量不足|停牌|报价过期/); assert.deepEqual(f.engine.s, before);
  }
  f.engine.agencyMember({ strategyId: 'swing', symbol: 'sh600000', action: 'add' });
  assert.throws(() => f.engine.legacyExit({ symbol: 'sh600000' }, f.quote({ symbol: 'sh600000' })), /自动策略持仓/);
  f.engine.s.lots[0].owner = 'swing';
  assert.throws(() => f.engine.legacyExit({ symbol: 'sz000001' }, f.quote()), /自动策略持仓/);
});

test('历史退出按主板整手和可见盘口分笔，同一报价已用数量不能重复卖出', () => {
  const f = fixture(), buy = f.buy(500); f.nextDay();
  const q = f.quote({ bidSize: 250 }), beforeCash = f.engine.s.cash;
  const first = f.engine.legacyExit({ symbol: 'sz000001' }, q);
  assert.equal(first.quantity, 200); assert.equal(f.engine.positions()[0].available, 300);
  const remaining = structuredClone(f.engine.s);
  assert.throws(() => f.engine.legacyExit({ symbol: 'sz000001' }, q), /数量不足/);
  assert.deepEqual(f.engine.s, remaining);
  const second = f.engine.legacyExit({ symbol: 'sz000001' }, f.quote({ bidSize: 350, timestamp: q.timestamp + 1 }));
  assert.equal(second.quantity, 300); assert.equal(f.engine.positions().length, 0);
  assert.equal(first.cost + second.cost, buy.gross + buy.fees.total);
  assert.equal(f.engine.s.cash, beforeCash + first.gross + second.gross - first.fees.total - second.fees.total);
  assert.equal(f.engine.s.agency.manualCash, f.engine.s.cash); assert.equal(validState(f.engine.s), true);
});

test('科创板历史持仓按5万股申报上限分笔，最终不足200股可卖余额一次退出', () => {
  const f = fixture(5000000), symbol = 'sh688001';
  const buyQuote = f.quote({ symbol, askSize: 200000 });
  f.engine.execute({ symbol, side: 'buy', quantity: 99900, limit: 10.1 }, buyQuote);
  f.engine.execute({ symbol, side: 'buy', quantity: 201, limit: 10.1 }, buyQuote);
  f.nextDay(); const quote = f.quote({ symbol, bidSize: 200000 });
  const quantities = [];
  for (let i = 0; i < 3; i++) quantities.push(f.engine.legacyExit({ symbol }, quote).quantity);
  assert.deepEqual(quantities, [50000, 50000, 101]); assert.equal(f.engine.positions().length, 0);
  assert.equal(validState(f.engine.s), true);
});

test('科创板部分退出至少200股、允许逐股递增，盘口不足时完整保留剩余持仓', () => {
  const f = fixture(), symbol = 'sh688001';
  f.engine.execute({ symbol, side: 'buy', quantity: 500 }, f.quote({ symbol })); f.nextDay();
  const before = structuredClone(f.engine.s);
  assert.throws(() => f.engine.legacyExit({ symbol }, f.quote({ symbol, bidSize: 199 })), /数量不足/);
  assert.deepEqual(f.engine.s, before);
  assert.equal(f.engine.legacyExit({ symbol }, f.quote({ symbol, bidSize: 201 })).quantity, 201);
  assert.equal(f.engine.positions()[0].available, 299); assert.equal(validState(f.engine.s), true);
});

test('历史部分退出按交易流水持久化请求回执，重复、并发及重启重试不再卖剩余持仓', async t => {
  const f = fixture(); f.buy(300); f.nextDay(); let engine = f.engine;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-auto-only-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('guanlan-auto-only-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = new Store(directory); store.save(engine.s);
  const operations = new AccountOperations(() => engine.s, mutate => { const result = mutate(); store.save(engine.s); return result; });
  const input = { symbol: 'sz000001', requestId: 'legacy-exit-once', accountCreatedAt: engine.s.createdAt };
  let performs = 0;
  const run = () => operations.run('legacy:exit', input, context => { performs++; return context.commit(() => engine.legacyExit(input, f.quote({ bidSize: 100 }))); });
  const [first, duplicate] = await Promise.all([run(), run()]);
  assert.equal(first.id, duplicate.id); assert.equal(performs, 1); assert.equal(first.clientRequest.channel, 'legacy:exit');
  assert.equal(engine.s.trades.length, 2); assert.equal(first.quantity, 100); assert.equal(engine.positions()[0].quantity, 200); assert.equal(validState(engine.s), true);
  engine = new Engine(store.load(), f.engine.clock);
  const resumed = new AccountOperations(() => engine.s, () => { throw Error('重放不能再提交成交'); });
  assert.deepEqual(await resumed.run('legacy:exit', input, () => { throw Error('重放不能再执行卖出'); }), first);
  assert.equal(resumed.status('legacy:exit', input).status, 'committed'); assert.equal(engine.s.trades.length, 2); assert.equal(engine.positions()[0].quantity, 200);
  assert.throws(() => resumed.run('legacy:exit', { ...input, symbol: 'sh600000' }, () => {}), /不同内容/);
});
