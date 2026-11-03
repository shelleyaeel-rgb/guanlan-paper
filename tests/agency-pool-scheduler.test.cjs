'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AgencyPoolScheduler, RETRY_DELAY_MS } = require('../core/agency-pool-scheduler.cjs');
const { AgencyPoolService } = require('../core/agency-pool.cjs');
const { Engine, initialState } = require('../core/engine.cjs');
const { poolPolicy } = require('../core/agency-screening.cjs');
const { ACTIVE_CANDIDATE_LIMIT } = require('../core/agency-capacity.cjs');
const { composeStrategyQuery } = require('../core/strategy-presets.cjs');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(start = '2026-10-23T08:45:00+08:00') {
  let now = Date.parse(start), engine = { s: { agency: { epoch: 'isolated-1', pool: null }, trades: [], lots: [], cash: 100000 } };
  let busy = false, available = true, hook = null, changes = 0;
  const calls = [];
  function success(target = engine, finishedAt = now, selection = { mode: 'technical', activeLimitPerGroup: ACTIVE_CANDIDATE_LIMIT }) {
    target.s.agency.pool = { policy: target.s.agency.pool?.policy || { version: 3, screeningMode: 'strategy', commonQuery: {} },
      lastResult: { id: `scan-${calls.length}`, finishedAt: new Date(finishedAt).toISOString(), ...(selection ? { selection } : {}) } };
  }
  const scheduler = new AgencyPoolScheduler({ getEngine: () => engine, clock: () => now, isBusy: () => busy, isAvailable: () => available,
    onChange: () => { changes++; }, run: options => { calls.push(options); if (hook) return hook(options, engine); success(); return Promise.resolve(engine.s.agency.pool.lastResult); } });
  return { scheduler, calls, success, get engine() { return engine; }, get now() { return now; }, get changes() { return changes; },
    setTime: value => { now = Date.parse(value); }, advance: value => { now += value; }, setBusy: value => { busy = value; },
    setAvailable: value => { available = value; }, setRun: value => { hook = value; },
    reset: () => { engine = { s: { agency: { epoch: `${engine.s.agency.epoch}-reset`, pool: null }, trades: [], lots: [], cash: 100000 } }; } };
}

test('已核验交易日08:45开始补更，成功后当天仅一次，翌日重新运行', async () => {
  const f = fixture('2026-10-23T08:44:59+08:00');
  assert.equal((await f.scheduler.poll()).status, 'outside-window'); assert.equal(f.calls.length, 0);
  f.advance(1000); assert.equal((await f.scheduler.poll()).status, 'completed'); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { screeningMode: 'strategy' });
  f.setTime('2026-10-23T14:58:00+08:00'); await f.scheduler.poll(); assert.equal(f.calls.length, 1);
  f.setTime('2026-10-26T08:45:00+08:00'); await f.scheduler.poll(); assert.equal(f.calls.length, 2);
  assert.equal(f.scheduler.publicState().completedToday, true);
});

test('午间启动可补更，15:00及之后不自动发起扫描', async () => {
  const lunch = fixture('2026-10-23T12:00:00+08:00'); await lunch.scheduler.poll(); assert.equal(lunch.calls.length, 1);
  const beforeClose = fixture('2026-10-23T14:59:59+08:00'); await beforeClose.scheduler.poll(); assert.equal(beforeClose.calls.length, 1);
  for (const time of ['2026-10-23T15:00:00+08:00', '2026-10-23T20:00:00+08:00']) {
    const f = fixture(time); assert.equal((await f.scheduler.poll()).status, 'outside-window'); assert.equal(f.calls.length, 0);
  }
});

test('周末、交易所节假日与未知年份不自动扫', async () => {
  for (const [time, status] of [
    ['2026-10-24T10:00:00+08:00', 'non-trading-day'],
    ['2026-10-01T10:00:00+08:00', 'non-trading-day'],
    ['2026-10-10T10:00:00+08:00', 'non-trading-day'],
    ['2027-01-04T10:00:00+08:00', 'calendar-unverified']
  ]) {
    const f = fixture(time); assert.equal((await f.scheduler.poll()).status, status); assert.equal(f.calls.length, 0);
  }
});

test('同一在途扫描复用Promise，不并行发起或重复通知', async () => {
  const f = fixture(), wait = deferred(); f.setRun(async () => { await wait.promise; f.success(); });
  const first = f.scheduler.poll(), second = f.scheduler.poll();
  assert.equal(first, second); assert.equal(f.calls.length, 1); assert.equal(f.scheduler.publicState().status, 'running');
  assert.equal(f.changes, 1); wait.resolve(); await first;
  assert.equal(f.changes, 2); assert.equal(f.scheduler.publicState().status, 'completed');
});

test('其他全市场或候选池任务忙时等待下轮，应用未就绪不启动', async () => {
  const f = fixture(); f.setAvailable(false); assert.equal((await f.scheduler.poll()).status, 'unavailable');
  f.setAvailable(true); f.setBusy(true); assert.equal((await f.scheduler.poll()).status, 'waiting-busy');
  assert.equal(f.calls.length, 0); f.setBusy(false); await f.scheduler.poll(); assert.equal(f.calls.length, 1);
});

test('已保存的当日20只手动成功结果满足调度，旧版6只及无容量结果须重筛', async () => {
  const manual = fixture(); manual.success(); assert.equal((await manual.scheduler.poll()).status, 'completed'); assert.equal(manual.calls.length, 0);
  const old = fixture(); old.success(old.engine, old.now, null); await old.scheduler.poll(); assert.equal(old.calls.length, 1);
  const wrongCapacity = fixture(); wrongCapacity.success(wrongCapacity.engine, wrongCapacity.now, { mode: 'technical', activeLimitPerGroup: 6 });
  await wrongCapacity.scheduler.poll(); assert.equal(wrongCapacity.calls.length, 1);
  assert.equal(wrongCapacity.engine.s.agency.pool.lastResult.selection.activeLimitPerGroup, ACTIVE_CANDIDATE_LIMIT);
});

test('当日手动结果在重启调度器后仍生效，前日和未来时间结果不冒充今日完成', async () => {
  const f = fixture(); f.success();
  const restarted = new AgencyPoolScheduler({ getEngine: () => f.engine, clock: () => f.now, run: () => { throw Error('不可重复'); } });
  assert.equal((await restarted.poll()).completedToday, true);
  const yesterday = fixture(); yesterday.success(yesterday.engine, yesterday.now - 86400000); await yesterday.scheduler.poll(); assert.equal(yesterday.calls.length, 1);
  const future = fixture(); future.success(future.engine, future.now + 60000); await future.scheduler.poll(); assert.equal(future.calls.length, 1);
});

test('旧保存经营业绩行业条件不再传入自动扫描，历史配置不受调度读取修改', async () => {
  const f = fixture(), query = { research: { enabled: true }, performance: { enabled: true }, evidence: { industry: { rank: 1 } } };
  f.engine.s.agency.pool = { policy: { version: 3, screeningMode: 'strategy', commonQuery: structuredClone(query) }, lastResult: null };
  await f.scheduler.poll(); assert.deepEqual(f.calls[0], { screeningMode: 'strategy' });
  assert.deepEqual(f.engine.s.agency.pool.policy.commonQuery, query);
});
test('旧严格筛选统一自动刷新技术候选，当日旧研究结果不能抑制重新筛选', async () => {
  for (const policy of [{ version: 3, screeningMode: 'strict' }, { version: 2 }, { version: 1 }]) {
    const f = fixture(); f.success(f.engine, f.now, { activeLimitPerGroup: 6 }); f.engine.s.agency.pool.policy = policy;
    await f.scheduler.poll(); assert.deepEqual(f.calls[0], { screeningMode: 'strategy' });
    assert.equal(f.scheduler.publicState().completedToday, true);
  }
});
test('失败从完成时刻起至少15分钟重试，不修改原候选或账户', async () => {
  const f = fixture(), wait = deferred(), before = structuredClone(f.engine.s);
  f.setRun(() => wait.promise); const running = f.scheduler.poll(); f.advance(60000); wait.reject(Error('行情源离线'));
  const state = await running;
  assert.equal(state.status, 'retry-wait'); assert.equal(state.lastError, '行情源离线'); assert.deepEqual(f.engine.s, before);
  assert.equal(Date.parse(state.nextAttemptAt), f.now + RETRY_DELAY_MS);
  f.advance(RETRY_DELAY_MS - 1); await f.scheduler.poll(); assert.equal(f.calls.length, 1);
  f.advance(1); f.setRun(null); await f.scheduler.poll(); assert.equal(f.calls.length, 2); assert.equal(f.scheduler.publicState().lastError, '');
});

test('同步错误与未持久化成功同样进入重试等待，避免每五秒重扫', async () => {
  const f = fixture(); f.setRun(() => { throw Error('参数未就绪'); });
  assert.equal((await f.scheduler.poll()).lastError, '参数未就绪'); await f.scheduler.poll(); assert.equal(f.calls.length, 1);
  f.advance(RETRY_DELAY_MS); f.setRun(() => ({ finishedAt: new Date(f.now).toISOString() }));
  assert.match((await f.scheduler.poll()).lastError, /未保存当日完整结果/); await f.scheduler.poll(); assert.equal(f.calls.length, 2);
});

test('失败后的手动成功可满足当日完成，无须等待或重复自动更新', async () => {
  const f = fixture(); f.setRun(() => Promise.reject(Error('临时离线'))); await f.scheduler.poll();
  f.success(); const state = await f.scheduler.poll();
  assert.equal(state.status, 'completed'); assert.equal(state.nextAttemptAt, null); assert.equal(state.lastError, ''); assert.equal(f.calls.length, 1);
});

test('用户取消后当日停止自动重跑，翌日恢复调度且仍允许手动成功', async () => {
  const f = fixture(), wait = deferred(); f.setRun(() => wait.promise);
  const running = f.scheduler.poll(); f.scheduler.cancelToday(); wait.reject(Error('已取消候选池更新'));
  assert.equal((await running).status, 'cancelled'); f.advance(RETRY_DELAY_MS * 2); await f.scheduler.poll(); assert.equal(f.calls.length, 1);
  assert.equal(f.scheduler.publicState().nextAttemptAt, null); assert.equal(f.scheduler.publicState().lastError, '');
  f.success(); assert.equal((await f.scheduler.poll()).status, 'completed');
  f.setTime('2026-10-26T08:45:00+08:00'); f.setRun(null); await f.scheduler.poll(); assert.equal(f.calls.length, 2);
});

test('账户重置时不继承旧取消或重试状态，也不与旧在途扫描并行', async () => {
  const f = fixture(), wait = deferred(); f.setRun(() => wait.promise);
  const old = f.scheduler.poll(); f.scheduler.cancelToday(); f.reset();
  const state = await f.scheduler.poll(); assert.equal(state.status, 'waiting-busy'); assert.equal(state.cancelledToday, false);
  assert.equal(state.lastAttemptAt, null); assert.equal(f.calls.length, 1); const changes = f.changes;
  wait.reject(Error('旧账户请求失败')); await old;
  assert.equal(f.changes, changes); assert.equal(f.scheduler.publicState().lastError, ''); assert.equal(f.scheduler.publicState().nextAttemptAt, null);
  f.setRun(null); await f.scheduler.poll(); assert.equal(f.calls.length, 2); assert.equal(f.scheduler.publicState().status, 'completed');
});

test('显式失效后的旧成功回调不污染当前状态，扫描锁直到完成才释放', async () => {
  const f = fixture(), wait = deferred(); f.setRun(() => wait.promise);
  const old = f.scheduler.poll(); f.scheduler.invalidate(); assert.equal((await f.scheduler.poll()).status, 'waiting-busy');
  wait.resolve(); await old; assert.equal(f.scheduler.publicState().lastError, ''); assert.equal(f.scheduler.publicState().nextAttemptAt, null);
  assert.equal(f.scheduler.publicState().lastAttemptAt, null); f.setRun(null); await f.scheduler.poll(); assert.equal(f.calls.length, 2);
});

test('真实候选池服务的数据源失败不执行名单事务、不启用策略或交易', async () => {
  const now = Date.parse('2026-10-23T08:45:00+08:00'), engine = new Engine(initialState(100000), () => new Date(now));
  const before = structuredClone(engine.s); let transactions = 0;
  const service = new AgencyPoolService({ getEngine: () => engine, clock: () => now, screener: { activeRun: null },
    transaction: fn => { transactions++; return fn(); }, screen: async () => { throw Error('完整市场行情获取失败'); } });
  const scheduler = new AgencyPoolScheduler({ getEngine: () => engine, clock: () => now, isBusy: () => !!service.active,
    run: options => service.run(options) });
  const state = await scheduler.poll();
  assert.equal(state.status, 'retry-wait'); assert.match(state.lastError, /行情获取失败/);
  assert.equal(transactions, 0); assert.deepEqual(engine.s, before); assert.equal(engine.s.trades.length, 0);
});

test('自动全量待核验保留旧名单并延后重试，确认空结果可满足当日完成', async () => {
  let now = Date.parse('2026-10-22T10:00:00+08:00'), status = 'ready', transactions = 0;
  const engine = new Engine(initialState(100000), () => new Date(now));
  const service = new AgencyPoolService({ getEngine: () => engine, clock: () => now, screener: { activeRun: null },
    transaction: fn => { transactions++; return fn(); }, screen: async () => ({ status, startedAt: now, finishedAt: now,
      strategies: Object.fromEntries(['ultra-short', 'short', 'swing', 'long'].map(id => [id, {
        query: composeStrategyQuery(id, poolPolicy().commonQuery),
        pass: status === 'ready' && id === 'swing' ? [{ symbol: 'sz000001' }] : [],
        failed: status === 'empty' ? [{ symbol: 'sz000001', reasons: ['条件不符'] }] : [],
        pending: status === 'unavailable' ? [{ symbol: 'sz000001', reasons: ['行情资料待核验'] }] : []
      }])) }) });
  await service.run(); const before = structuredClone(engine.s);
  now = Date.parse('2026-10-23T08:45:00+08:00'); status = 'unavailable';
  const scheduler = new AgencyPoolScheduler({ getEngine: () => engine, clock: () => now, isBusy: () => !!service.active,
    run: options => service.run({ ...options, automatic: true }) });
  const pending = await scheduler.poll();
  assert.equal(pending.status, 'retry-wait'); assert.match(pending.lastError, /待核验/); assert.equal(pending.completedToday, false);
  assert.equal(Date.parse(pending.nextAttemptAt), now + RETRY_DELAY_MS); assert.equal(transactions, 1); assert.deepEqual(engine.s, before);
  now += RETRY_DELAY_MS - 1; await scheduler.poll(); assert.equal(transactions, 1);
  now++; status = 'empty'; const complete = await scheduler.poll();
  assert.equal(complete.status, 'completed'); assert.equal(complete.lastError, ''); assert.equal(transactions, 2);
  assert.equal(engine.s.agency.groups.flatMap(group => group.members).filter(member => member.mode === 'active').length, 0);
  assert.equal(engine.s.cash, before.cash); assert.deepEqual(engine.s.trades, before.trades); assert.deepEqual(engine.s.lots, before.lots);
});
