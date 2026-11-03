'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { AgencyPoolService } = require('../core/agency-pool.cjs');
const { poolPolicy } = require('../core/agency-screening.cjs');
const { ACTIVE_CANDIDATE_LIMIT } = require('../core/agency-capacity.cjs');
const { composeStrategyQuery } = require('../core/strategy-presets.cjs');
const { cnTime } = require('../core/common.cjs');
const IDS = ['ultra-short', 'short', 'swing', 'long'];

test('四组各选20只，按均线距离及成交额排序；候补低频重筛替换且失败不占活跃额度', async t => {
  const f = fixture(t), symbols = Object.fromEntries(IDS.map((id, group) => [id, Array.from({ length: ACTIVE_CANDIDATE_LIMIT + 4 }, (_, i) => `sh${601000 + group * 100 + i}`)]));
  const personalSymbol = symbols.swing.at(-1); f.add(personalSymbol, 'swing', { rules: [{ field: 'price', op: 'lt', value: 100 }] });
  const personal = structuredClone(f.member(personalSymbol).entryConditions);
  let unavailable = false;
  f.screen(() => {
    const result = f.result(Object.fromEntries(IDS.map(id => [id, { pass: symbols[id].filter((_, i) => !unavailable || i !== 0),
      ...(unavailable ? { failed: [symbols[id][0]] } : {}) }])));
    for (const id of IDS) for (const row of result.strategies[id].pass) {
      const index = symbols[id].indexOf(row.symbol);
      Object.assign(row, { price: 10 + Math.floor(index / 2) * 0.1, ma5: 10, ma20: 10, ma60: 10, amount: index % 2 ? 10 : 5,
        technicalAsOf: '2026-09-28', timestamp: Date.parse('2026-09-29T10:00:00+08:00') });
    }
    return result;
  });
  const before = { cash: f.engine.s.cash, trades: structuredClone(f.engine.s.trades) };
  const result = await f.service.run();
  assert.equal(result.counts.added, IDS.length * ACTIVE_CANDIDATE_LIMIT); assert.equal(result.counts.standby, IDS.length * 4);
  assert.equal(result.selection.activeLimitPerGroup, ACTIVE_CANDIDATE_LIMIT);
  for (const group of f.engine.s.agency.groups) {
    assert.equal(group.members.filter(m => m.mode === 'active').length, ACTIVE_CANDIDATE_LIMIT);
    assert.deepEqual(result.added.filter(item => item.strategyId === group.id).map(item => item.symbol).sort(), symbols[group.id].slice(0, ACTIVE_CANDIDATE_LIMIT));
  }
  assert.deepEqual(f.member(personalSymbol).entryConditions, personal);
  assert.equal(f.member(personalSymbol).mode, 'standby');
  unavailable = true; const next = await f.service.run();
  for (const group of f.engine.s.agency.groups) {
    assert.equal(f.member(symbols[group.id][0]).mode, 'standby');
    assert.match(f.member(symbols[group.id][0]).standbyReason, /不符合/);
    assert.equal(f.member(symbols[group.id][ACTIVE_CANDIDATE_LIMIT + 1]).mode, 'active', '同距离下成交额较高者先补位');
    assert.equal(f.member(symbols[group.id][ACTIVE_CANDIDATE_LIMIT]).mode, 'standby');
    assert.equal(group.members.filter(m => m.mode === 'active').length, ACTIVE_CANDIDATE_LIMIT);
  }
  assert.equal(next.counts.standby, IDS.length * 4); assert.equal(f.engine.s.cash, before.cash); assert.deepEqual(f.engine.s.trades, before.trades);
  assert.equal(validState(f.engine.s), true); f.restart();
  assert.equal(f.member(personalSymbol).mode, 'standby'); assert.deepEqual(f.member(personalSymbol).entryConditions, personal);
});

test('未知排序数据排后、不把缺失补零；已有核验阻断不因筛选通过而解除', async t => {
  const f = fixture(t), symbols = Array.from({ length: ACTIVE_CANDIDATE_LIMIT + 2 }, (_, i) => `sh${603000 + i}`);
  for (const symbol of symbols) f.add(symbol);
  f.member(symbols[1]).reconciliation = { status: 'pending', reason: '除权基准尚未核验', affectsEquity: false };
  const latch = structuredClone(f.member(symbols[1]).reconciliation);
  f.screen(() => {
    const result = f.result({ swing: { pass: symbols } });
    for (const row of result.strategies.swing.pass.slice(1)) Object.assign(row, { price: 10, ma20: 10, amount: 5 });
    return result;
  });
  await f.service.run();
  assert.equal(f.member(symbols[0]).mode, 'standby'); assert.equal(f.member(symbols[0]).candidateRanking.distancePct, null);
  assert.equal(f.member(symbols[1]).mode, 'standby'); assert.match(f.member(symbols[1]).standbyReason, /核验阻断/);
  assert.deepEqual(f.member(symbols[1]).reconciliation, latch);
  assert.equal(f.engine.s.agency.groups.find(g => g.id === 'swing').members.filter(m => m.mode === 'active').length, ACTIVE_CANDIDATE_LIMIT);
});

test('自动筛选无确认通过且仍待核验时不替换已存名单、持仓或账务', async t => {
  const f = fixture(t); f.buy(); f.add('sz000002', 'swing', { rules: [{ field: 'price', op: 'lt', value: 20 }] });
  f.screen(() => ({ ...f.result({ swing: { pass: ['sz000001', 'sz000002'] } }), status: 'ready' }));
  await f.service.run({ automatic: true });
  const before = structuredClone(f.engine.s), file = fs.readFileSync(f.store.file, 'utf8'), count = f.transactions;
  f.screen(() => ({ ...f.result({ swing: { pending: ['sz000001', 'sz000002'] } }), status: 'unavailable' }));
  await assert.rejects(f.service.run({ automatic: true }), /没有已确认通过.*待核验.*保留原名单/);
  assert.equal(f.transactions, count); assert.deepEqual(f.engine.s, before); assert.equal(fs.readFileSync(f.store.file, 'utf8'), file);
  assert.equal(f.member('sz000002').mode, 'active'); assert.equal(f.service.publicState().lastResult.id, before.agency.pool.lastResult.id);
  assert.equal(f.service.publicState().running, false); assert.match(f.service.publicState().lastError, /等待重试/);
  assert.equal(validState(f.engine.s), true); f.restart(); assert.deepEqual(f.engine.s, before);
});

test('手动更新仍可保存全量待核验诊断，空仓成员按既有规则转候补', async t => {
  for (const options of [{}, { automatic: false }]) {
    const f = fixture(t); f.add('sz000001');
    f.screen(() => ({ ...f.result({ swing: { pass: ['sz000001'] } }), status: 'ready' }));
    await f.service.run(); const oldId = f.engine.s.agency.pool.lastResult.id, cash = f.engine.s.cash;
    f.screen(() => ({ ...f.result({ swing: { pending: ['sz000001', 'sz000002'] } }), status: 'unavailable' }));
    const result = await f.service.run(options);
    assert.equal(f.member('sz000001').mode, 'standby'); assert.equal(f.member('sz000001').poolCheck.status, 'pending');
    assert.equal(result.counts.standby, 1); assert.equal(result.counts.unassignedPending, 1); assert.notEqual(result.id, oldId);
    assert.equal(f.engine.s.cash, cash); assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.lots.length, 0);
    assert.equal(validState(f.engine.s), true);
  }
});

test('自动筛选确认全部不符时正常保存空活跃结果，不冒充资料故障', async t => {
  const f = fixture(t); f.add('sz000001');
  f.screen(() => ({ ...f.result({ swing: { pass: ['sz000001'] } }), status: 'ready' }));
  await f.service.run({ automatic: true }); const previous = f.engine.s.agency.pool.lastResult.id, cash = f.engine.s.cash;
  f.screen(() => ({ ...f.result({ swing: { failed: ['sz000001'] } }), status: 'empty' }));
  const result = await f.service.run({ automatic: true });
  assert.notEqual(result.id, previous); assert.equal(f.member('sz000001').mode, 'standby'); assert.equal(f.member('sz000001').poolCheck.status, 'failed');
  assert.equal(result.counts.added + result.counts.retained, 0); assert.equal(result.counts.standby, 1);
  assert.equal(f.engine.s.agency.groups.flatMap(group => group.members).filter(member => member.mode === 'active').length, 0);
  assert.equal(f.engine.s.cash, cash); assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.lots.length, 0);
  assert.equal(f.service.publicState().lastError, ''); assert.equal(validState(f.engine.s), true);
});

test('自动更新选项严格接受布尔值，无效输入不读取行情或修改账户', async t => {
  const f = fixture(t), before = structuredClone(f.engine.s);
  for (const automatic of ['true', 1, null, {}]) await assert.rejects(f.service.run({ automatic }), /自动候选池参数无效/);
  assert.equal(f.calls.length, 0); assert.equal(f.transactions, 0); assert.deepEqual(f.engine.s, before);
});

test('公开状态保存技术策略并明确研究停用，旧严格与研究选项不再保存门槛', async t => {
  const f = fixture(t); assert.equal(f.service.publicState().savedPolicy, null);
  f.screen(() => ({ ...f.result({ swing: { pass: ['sz000001'] } }), status: 'ready' }));
  await f.service.run({ screeningMode: 'strict', performance: { invalidLegacy: true }, research: { invalidLegacy: true }, industry: { invalidLegacy: true } }); f.restart();
  const state = f.service.publicState(); assert.equal(state.savedPolicy.screeningMode, 'strategy');
  assert.equal(state.savedPolicy.researchChecks.status, 'disabled'); assert.equal(state.savedPolicy.commonQuery.performance, undefined);
  assert.equal(f.member('sz000001').entryConditions, undefined); assert.equal(f.member('sz000001').selectionMode, 'strategy');
  assert.equal(state.lastResult.selection.mode, 'technical'); state.savedPolicy.commonQuery.excludeST = false;
  assert.equal(f.engine.s.agency.pool.policy.commonQuery.excludeST, true);
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-agency-pool-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('guanlan-agency-pool-')); fs.rmSync(directory, { recursive: true, force: true }); });
  let now = new Date('2026-09-29T10:00:00+08:00'), engine = new Engine(initialState(100000), () => now), fail = false, handler;
  let transactions = 0, calls = [], cancelled = 0;
  const store = new Store(directory);
  const transaction = fn => { const before = structuredClone(engine.s); transactions++; try { const value = fn(); if (fail) throw Error('模拟保存失败'); store.save(engine.s); return value; } catch (error) { engine.s = before; throw error; } };
  const screener = { progress: { stage: 'quotes', completed: 0, total: 0 }, cancel() { cancelled++; } };
  const service = new AgencyPoolService({ getEngine: () => engine, transaction, screener, clock: () => now.getTime(),
    screen: async (_screener, options) => { calls.push(options); return handler(options); } });
  const result = classifications => ({ startedAt: now.toISOString(), finishedAt: now.toISOString(), coverage: { complete: true }, sources: ['隔离测试'], commonQuery: poolPolicy().commonQuery,
    strategies: Object.fromEntries(IDS.map(id => [id, { query: composeStrategyQuery(id, poolPolicy().commonQuery),
      ...Object.fromEntries(['pass', 'failed', 'pending'].map(status => [status, (classifications[id]?.[status] || []).map(symbol => ({ symbol, name: '隔离候选', reasons: status === 'pass' ? [] : [status === 'pending' ? '资料不足' : '条件不符'] }))])) }])) });
  handler = () => result({});
  const add = (symbol, id = 'swing', entryConditions) => engine.agencyMember({ strategyId: id, symbol, action: 'add', entryConditions });
  const member = symbol => engine.s.agency.groups.flatMap(group => group.members).find(item => item.symbol === symbol);
  const owner = symbol => engine.s.agency.groups.find(group => group.members.some(item => item.symbol === symbol))?.id;
  const quote = (symbol = 'sz000001', extra = {}) => ({ symbol, name: '隔离持仓', price: 10.1, prevClose: 10.05, open: 10, low: 10, high: 10.2, volume: 100000,
    bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05, timestamp: now.getTime(), date: cnTime(now).date, ...extra });
  const snapshot = () => { const previous = cnTime(now.getTime() - 86400000).date; return { fetchedAt: now.getTime(),
    notices: { symbol: 'sz000001', section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } },
    technical: { asOf: previous, close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false,
      support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: [previous] } }; };
  const buy = () => {
    engine.agencyTransfer({ strategyId: 'swing', amount: 50000 }); add('sz000001'); engine.agencyMode({ strategyId: 'swing', mode: 'running' });
    return engine.agencyExecute({ strategyId: 'swing', symbol: 'sz000001', action: 'buy', targetPercent: 20, decisionId: 'isolated-buy',
      expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, quote(), snapshot(), { sz000001: quote() });
  };
  return { get engine() { return engine; }, service, store, calls, result, add, member, owner, quote, snapshot, buy, transaction,
    screen: next => { handler = next; }, saveFails: () => { fail = true; }, get transactions() { return transactions; }, get cancelled() { return cancelled; },
    day: date => { now = new Date(`${date}T10:00:00+08:00`); }, restart: () => { engine = new Engine(store.load(), () => now); }, reset: () => { engine = new Engine(initialState(), () => now); } };
}




test('默认筛选一次事务同步：去重分配，既有监控的归属、个人条件及失败诊断保留', async t => {
  const f = fixture(t); f.add('sz000001', 'long'); f.add('sz000002'); f.add('sz000003');
  f.screen(() => f.result({ 'ultra-short': { pass: ['sz000001', 'sz000004'] }, short: { pass: ['sz000004', 'sz000005'] },
    swing: { failed: ['sz000002'], pending: ['sz000003'] }, long: { pass: ['sz000001', 'sz000005'] } }));
  const outcome = await f.service.run();
  assert.equal(f.transactions, 1); assert.deepEqual(f.calls[0].requiredSymbols.sort(), ['sz000001', 'sz000002', 'sz000003']); assert.equal(f.calls[0].force, true);
  assert.equal(f.owner('sz000001'), 'long'); assert.equal(f.owner('sz000004'), 'ultra-short'); assert.equal(f.owner('sz000005'), 'short'); assert.equal(f.owner('sz000002'), 'swing');
  assert.equal(f.member('sz000002').poolCheck.status, 'failed');
  assert.equal(f.member('sz000003').mode, 'standby'); assert.equal(f.member('sz000003').poolCheck.status, 'pending');
  assert.equal(f.member('sz000002').mode, 'standby');
  assert.deepEqual(outcome.counts, { added: 2, retained: 1, removed: 0, pending: 0, held: 0, skipped: 0, standby: 2, unassignedPending: 0 });
  assert.deepEqual(f.member('sz000001').poolCheck.matchedStrategies, ['ultra-short', 'long']);
  assert.equal(f.member('sz000001').entryConditions, undefined); assert.equal(f.member('sz000004').entryConditions, undefined);
  assert.equal(f.member('sz000004').selectionMode, 'strategy'); assert.equal(outcome.screeningMode, 'strategy');
  assert.equal(validState(f.engine.s), true); f.restart(); assert.equal(f.service.publicState().lastResult.id, outcome.id);
  f.engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  assert.match(f.engine.agencyEvaluate('swing', 'sz000003', f.quote('sz000003'), f.snapshot()).reasons.join('；'), /候补/);
});

test('首次筛选缺少有效行情时保留未入池待核验摘要，跨策略去重且不伪造归属或实时报价', async t => {
  const f = fixture(t);
  f.screen(() => f.result({ 'ultra-short': { pending: ['sz000001'] }, swing: { pending: ['sz000001', 'sz000002'] }, long: { pass: ['sz000002'] } }));
  const outcome = await f.service.run();
  assert.equal(outcome.counts.unassignedPending, 1); assert.equal(outcome.counts.pending, 0); assert.equal(outcome.counts.added, 1);
  assert.deepEqual(outcome.unassignedPending[0].strategyIds, ['ultra-short', 'swing']); assert.deepEqual(outcome.unassignedPending[0].reasons, ['资料不足']);
  assert.equal(f.owner('sz000001'), undefined); assert.equal(f.member('sz000002').poolCheck.name, '隔离候选'); assert.equal(f.engine.s.marks.sz000002, undefined);
  assert.equal(validState(f.engine.s), true); f.restart(); assert.equal(f.service.publicState().lastResult.unassignedPending[0].symbol, 'sz000001');
});

test('可在休市重复筛选；原策略暂不匹配也不迁移已有归属或覆盖个人条件', async t => {
  const f = fixture(t); f.day('2026-10-04'); f.add('sz000001', 'long', { rules: [{ field: 'price', op: 'gt', value: 1 }] });
  const conditions = structuredClone(f.member('sz000001').entryConditions);
  f.screen(() => f.result({ long: { failed: ['sz000001'] }, short: { pass: ['sz000001'] } }));
  const first = await f.service.run(); assert.equal(f.owner('sz000001'), 'long'); assert.equal(first.removed.length, 0); assert.equal(first.added.length, 0);
  const second = await f.service.run(); assert.equal(f.calls.length, 2); assert.equal(second.added.length, 0); assert.equal(second.standby.length, 1);
  assert.notEqual(first.id, second.id); assert.deepEqual(f.member('sz000001').entryConditions, conditions);
});

test('持仓条件与风控不改写；筛选失配不会自动卖出或给默认监控添加资格门槛', async t => {
  const f = fixture(t); f.buy(); const before = structuredClone(f.member('sz000001')), risk = structuredClone(f.engine.s.risks.sz000001), trades = f.engine.s.trades.length;
  f.screen(() => f.result({ swing: { failed: ['sz000001'] }, short: { pass: ['sz000001'] } }));
  const outcome = await f.service.run();
  assert.equal(outcome.held.length, 1); assert.equal(f.owner('sz000001'), 'swing'); assert.deepEqual(f.member('sz000001').entryConditions, before.entryConditions);
  assert.deepEqual(f.engine.s.risks.sz000001, risk); assert.equal(f.engine.s.trades.length, trades); assert.equal(f.member('sz000001').poolCheck.status, 'failed');
  f.day('2026-09-30'); const sold = f.engine.tick({ sz000001: f.quote('sz000001', { price: 9.5, bid: 9.5 }) }, { sz000001: f.snapshot() });
  assert.equal(sold[0].side, 'sell'); assert.equal(f.engine.positions().length, 0); assert.equal(f.member('sz000001').poolCheck.status, 'failed');
  assert.doesNotMatch(f.engine.agencyEvaluate('swing', 'sz000001', f.quote(), f.snapshot()).reasons.join('；'), /候选池资格待核验/); assert.equal(validState(f.engine.s), true);
});

test('扫描期间原持仓退出继续执行，提交按当前持仓判断且不重新加入主动退出股票', async t => {
  const f = fixture(t); f.buy(); f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'close' });
  f.screen(() => { f.day('2026-09-30'); f.engine.tick({ sz000001: f.quote() }, { sz000001: f.snapshot() }); return f.result({ swing: { pass: ['sz000001'] } }); });
  const outcome = await f.service.run(); assert.equal(f.engine.positions().length, 0); assert.equal(f.member('sz000001'), undefined);
  assert.equal(outcome.skipped.length, 1); assert.match(outcome.skipped[0].reasons[0], /退出安排/); assert.equal(validState(f.engine.s), true);
});

test('首次同步后手动新增仍只保存个人条件，不继承全局研究门槛', async t => {
  const f = fixture(t); await f.service.run();
  const added = f.add('sz000001', 'swing', { rules: [{ field: 'price', op: 'lt', value: 100 }] });
  assert.equal(added.poolCheck, undefined); assert.equal(added.selectionMode, 'strategy');
  assert.deepEqual(added.entryConditions.rules, [{ field: 'price', op: 'lt', value: 100 }]);
  assert.equal(added.entryConditions.evidence, undefined);
  f.engine.agencyMode({ strategyId: 'swing', mode: 'running' }); assert.doesNotMatch(f.engine.agencyEvaluate('swing', 'sz000001', f.quote(), f.snapshot()).reasons.join('；'), /候选池资格待核验/);
  assert.equal(validState(f.engine.s), true);
});

test('手动持仓和待执行委托不被候选池接管，程序日志不使扫描失效', async t => {
  const f = fixture(t); f.engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 100 }, f.quote());
  f.engine.place({ symbol: 'sz000002', side: 'buy', quantity: 100, limit: 10 });
  f.screen(() => { f.engine.agencyLog({ message: '扫描期间普通日志' }); return f.result({ short: { pass: ['sz000001', 'sz000002', 'sz000003'] } }); });
  const outcome = await f.service.run(); assert.equal(outcome.skipped.length, 2); assert.equal(f.owner('sz000001'), undefined); assert.equal(f.owner('sz000002'), undefined);
  assert.equal(f.owner('sz000003'), 'short'); assert.equal(validState(f.engine.s), true);
});

test('整体数据失败、取消和保存失败都不改变原成员或上次成功结果', async t => {
  const f = fixture(t); f.screen(() => f.result({ long: { pass: ['sz000001'] } })); await f.service.run();
  const before = structuredClone(f.engine.s), file = fs.readFileSync(f.store.file, 'utf8');
  f.screen(() => { throw Error('全市场读取失败'); }); await assert.rejects(f.service.run(), /全市场读取失败/); assert.deepEqual(f.engine.s, before);
  f.screen(() => { f.service.cancel(); return f.result({}); }); await assert.rejects(f.service.run(), /已取消/); assert.equal(f.cancelled, 1); assert.deepEqual(f.engine.s, before);
  f.screen(() => f.result({ short: { pass: ['sz000002'] }, long: { failed: ['sz000001'] } })); f.saveFails();
  await assert.rejects(f.service.run(), /模拟保存失败/); assert.deepEqual(f.engine.s, before); assert.equal(fs.readFileSync(f.store.file, 'utf8'), file);
});

test('扫描期间账户重置或成员授权变化拒绝旧结果，不能覆盖用户新增移出和模式选择', async t => {
  for (const mutate of [f => f.reset(), f => f.add('sz000002'), f => f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'remove' }),
    f => f.engine.agencyMode({ strategyId: 'swing', mode: 'stopped' })]) {
    const f = fixture(t); f.add('sz000001'); let after;
    f.screen(() => { mutate(f); after = structuredClone(f.engine.s); return f.result({ swing: { pass: ['sz000003'] } }); });
    await assert.rejects(f.service.run(), /账户已重置|授权已变化/); assert.deepEqual(f.engine.s, after);
  }
});

test('重复运行互斥、取消后可重试，未知pool版本和降级账户拒绝恢复', async t => {
  const f = fixture(t); let resolve; f.screen(() => new Promise(done => { resolve = done; }));
  const pending = f.service.run(); assert.equal(f.service.publicState().running, true);
  await assert.rejects(f.service.run(), /正在更新/); f.service.cancel(); resolve(f.result({})); await assert.rejects(pending, /已取消/);
  f.screen(() => f.result({ long: { pass: ['sz000001'] } })); await f.service.run();
  for (const mutate of [a => { a.version = 3; }, a => { a.poolVersion = 2; }, a => { a.pool.policy.version = 99; },
    a => { a.groups.find(g => g.id === 'long').members[0].poolCheck.status = 'ignored'; }]) {
    const bad = structuredClone(f.engine.s); mutate(bad.agency); assert.equal(validState(bad), false); assert.throws(() => new Engine(bad), /格式/);
  }
});


test('重试重新量化筛选，不启动研究探针且互斥取消，不能使用旧资格直接放行', async t => {
  const f = fixture(t), batches = [];
  f.service.prepareSource = options => batches.push(options);
  await assert.rejects(f.service.run({ retryEvidence: true }), /先更新/);
  f.screen(() => f.result({ swing: { pending: ['sz000001'] } }));
  const first = await f.service.run({ screeningMode: 'strict' });
  assert.equal(first.operation, 'update'); assert.equal(f.owner('sz000001'), undefined);
  let resolve;
  f.screen(() => new Promise(done => { resolve = done; }));
  const retry = f.service.run({ retryEvidence: true });
  assert.equal(f.service.publicState().operation, 'retry');
  await assert.rejects(f.service.run(), /正在更新/);
  f.service.cancel(); resolve(f.result({ swing: { pass: ['sz000001'] } }));
  await assert.rejects(retry, /已取消/); assert.equal(f.owner('sz000001'), undefined);
  assert.equal(f.service.publicState().lastResult.id, first.id);
  f.screen(() => f.result({ swing: { failed: ['sz000001'] } }));
  const current = await f.service.run({ retryEvidence: true });
  assert.equal(current.operation, 'retry'); assert.equal(current.counts.added, 0);
  assert.ok(f.calls.every(call => call.force)); assert.equal(f.calls.at(-1).retryEvidence, true);
  assert.deepEqual(batches, []);
  assert.equal(f.engine.s.trades.length, 0); f.restart(); assert.equal(f.service.publicState().lastResult.operation, 'retry');
});

test('逐股阶段与日线实际日期跨策略聚合且重启保留', async t => {
  const f = fixture(t);
  f.screen(() => {
    const scan = f.result({ short: { pending: ['sz000001'] }, swing: { pending: ['sz000001'] } });
    for (const id of ['short', 'swing']) Object.assign(scan.strategies[id].pending[0], { stage: 'daily', technicalAsOf: '2026-09-28', technicalError: 'stale',
      diagnostics: { stage: 'daily', code: 'daily-date', label: '日线日期异常', stages: [{ stage: 'daily', code: 'daily-date', label: '日线日期异常' }], researchAttempted: false, researchComplete: false } });
    return scan;
  });
  const result = await f.service.run(), item = result.unassignedPending[0];
  assert.equal(item.technicalAsOf, '2026-09-28'); assert.equal(item.diagnostics.stages.length, 1);
  assert.equal(item.diagnostics.researchAttempted, false); f.restart();
  assert.deepEqual(f.service.publicState().lastResult.unassignedPending[0], item);
});

test('只有持仓待核验的旧结果也可重试，持仓与退出计划仍保持', async t => {
  const f = fixture(t); f.buy();
  f.screen(() => f.result({ swing: { pending: ['sz000001'] } }));
  const original = await f.service.run(), before = structuredClone(f.engine.s.risks.sz000001), trades = f.engine.s.trades.length;
  assert.equal(original.counts.pending + original.counts.unassignedPending, 0); assert.equal(original.held[0].status, 'pending');
  f.screen(() => f.result({ swing: { failed: ['sz000001'] } }));
  const retried = await f.service.run({ retryEvidence: true });
  assert.equal(retried.held.length, 1); assert.deepEqual(f.engine.s.risks.sz000001, before); assert.equal(f.engine.s.trades.length, trades);
});


test('旧严格入口统一技术模式，也不覆盖个人附加条件', async t => {
  const f = fixture(t);
  f.add('sz000001', 'swing', { rules: [{ field: 'price', op: 'lt', value: 15 }] });
  const before = structuredClone(f.member('sz000001'));
  f.screen(() => f.result({ swing: { pass: ['sz000001'] } }));
  await f.service.run({ screeningMode: 'strict' });
  assert.equal(f.member('sz000001').selectionMode, before.selectionMode);
  assert.deepEqual(f.member('sz000001').entryConditions, before.entryConditions);
  assert.equal(f.member('sz000001').poolCheck.screeningMode, 'strategy');
  assert.equal(validState(f.engine.s), true);
});

test('默认及旧严格模式重试均不启动研究采集批次，非法模式不变更账户', async t => {
  const f = fixture(t); let prepared = 0; f.service.prepareSource = () => { prepared++; };
  f.screen(() => f.result({ swing: { pending: ['sz000001'] } }));
  await f.service.run(); await f.service.run({ retryEvidence: true });
  assert.equal(prepared, 0); assert.deepEqual(f.calls.map(call => call.screeningMode), ['strategy', 'strategy']);
  await f.service.run({ screeningMode: 'strict' }); await f.service.run({ retryEvidence: true });
  assert.equal(prepared, 0); assert.equal(f.calls.at(-1).screeningMode, 'strategy');
  const before = structuredClone(f.engine.s);
  await assert.rejects(f.service.run({ screeningMode: 'other' }), /模式无效/); assert.deepEqual(f.engine.s, before);
});


test('旧严格成员在新技术扫描后解除研究资格门槛，但行情pending仍留候补', async t => {
  const f = fixture(t); f.add('sz000001'); const member = f.member('sz000001');
  member.selectionMode = 'strict'; member.poolCheck = { policyVersion: 3, screeningMode: 'strict', status: 'pending',
    checkedAt: '2026-09-29T02:00:00.000Z', matchedStrategies: [], reasons: ['公告获取失败'] };
  f.screen(() => f.result({ swing: { pass: ['sz000001'], pending: ['sz000002'] } }));
  const result = await f.service.run({ screeningMode: 'strict' });
  assert.equal(member.selectionMode, 'strategy'); assert.equal(member.poolCheck.status, 'pass'); assert.equal(member.mode, 'active');
  assert.equal(result.unassignedPending[0].symbol, 'sz000002'); assert.equal(result.screeningMode, 'strategy');
  assert.equal(validState(f.engine.s), true); f.restart(); assert.equal(f.member('sz000001').mode, 'active');
});
