const test = require('node:test');
const assert = require('node:assert/strict');
const { CorporateService } = require('../core/corporate-service.cjs');
const { createEntryConditions } = require('../core/entry-conditions.cjs');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { setStandby } = require('../core/agency-capacity.cjs');

function fixture() {
  let time = Date.parse('2026-10-09T10:00:00+08:00');
  const calls = { requests: [], saves: 0, checks: [], publishes: 0, quotes: [] };
  const engine = { s: { lots: [], trades: [], agency: { epoch: 'account-a', groups: [{ id: 'swing', members: [{ symbol: 'sz000001', reconciliation: { status: 'clear' } }] }] } },
    agencyAutomaticBlock(symbol, quote, snapshot) { calls.checks.push({ symbol, quote, snapshot }); return null; },
    agencyProcessCorporateActions(symbol, quote, snapshot) { calls.checks.push({ symbol, quote, snapshot, historical: true }); return { status: 'clear' }; } };
  const source = { async get(input) { calls.requests.push(input); return { symbol: input.symbol, status: 'ready', fetchedAt: time, coverageStart: input.fromDate, coverageComplete: true, events: [] }; } };
  const monitor = { async load() { return { technical: { asOf: '2026-10-08' } }; } };
  const service = new CorporateService({ source, getEngine: () => engine, transaction: fn => { const result = fn(); calls.saves++; return result; },
    market: { async quotes(symbols) { calls.quotes.push(symbols); return {}; } }, getMonitor: () => monitor,
    onChange: () => calls.publishes++, clock: () => time });
  return { service, engine, source, monitor, calls, advance: amount => { time += amount; } };
}
test('自动核验收集证据并持久化，不要求交易时段、行情成功或新开仓授权', async () => {
  const f = fixture();
  const result = await f.service.verify({ strategyId: 'swing', symbol: '000001' });
  assert.equal(result.clear, 1); assert.equal(f.calls.saves, 1); assert.equal(f.calls.publishes, 1);
  assert.deepEqual(f.calls.requests, [{ symbol: 'sz000001', fromDate: '2026-09-25', force: true }]);
  assert.equal(f.calls.checks[0].snapshot.corporateActions.coverageComplete, true);
  assert.equal(f.engine.s.trades.length, 0);
});
test('登记后清仓并移出成员仍检查历史权益，查询范围覆盖最早自动成交', async () => {
  const f = fixture();
  f.engine.s.agency.groups[0].members = [];
  f.engine.s.trades.push({ symbol: 'sz000001', owner: 'swing', side: 'buy', time: '2026-06-01T02:00:00Z' },
    { symbol: 'sh600519', owner: 'manual', side: 'buy', time: '2025-01-01T02:00:00Z' });
  assert.deepEqual(f.service.symbols(), ['sz000001']);
  await f.service.verify({ strategyId: 'swing' });
  assert.equal(f.calls.requests[0].fromDate, '2026-06-01'); assert.equal(f.calls.checks[0].historical, true);
});
test('取证中重置账户丢弃旧结果，不修改新账户', async () => {
  const f = fixture(); let resolve;
  f.monitor.load = () => new Promise(done => { resolve = done; });
  const pending = f.service.verify({ strategyId: 'swing' });
  f.engine.s.agency.epoch = 'account-b'; resolve({});
  assert.equal((await pending).skipped, 1); assert.equal(f.calls.saves, 0); assert.equal(f.calls.checks.length, 0);
});
test('资料失败保留unavailable状态，不以空事件列表代表检查通过', async () => {
  const f = fixture(); f.source.get = async () => { throw Error('离线'); };
  f.engine.agencyAutomaticBlock = (symbol, quote, snapshot) => {
    assert.equal(snapshot.corporateActions.status, 'unavailable');
    assert.equal(snapshot.corporateActions.coverageComplete, false);
    return '等待有效公司行为资料';
  };
  const result = await f.service.verify({ strategyId: 'swing' });
  assert.equal(result.waiting, 1); assert.equal(result.clear, 0);
});

test('旧引擎没有本次诊断时沿用对账拦截，不采信以前残留的诊断', async () => {
  for (const diagnostic of [undefined, { status: 'waiting', reason: '等待资料', checkedAt: '2026-10-09T02:00:00.000Z' }]) {
    const f = fixture(), member = f.engine.s.agency.groups[0].members[0];
    member.reconciliation = { status: 'pending', reason: '尚未核实的权益' };
    if (diagnostic) member.automaticCheck = diagnostic;
    f.engine.agencyAutomaticBlock = () => '等待资料';
    const result = await f.service.verify({ strategyId: 'swing', symbol: '000001' });
    assert.equal(result.blocked, 1); assert.equal(result.waiting, 0); assert.equal(result.clear, 0);
    assert.equal(member.automaticCheck, diagnostic);
  }
});
test('并发核验同一股票共享请求，定时检查有五分钟冷却', async () => {
  const f = fixture(); let resolve;
  f.monitor.load = () => new Promise(done => { resolve = done; });
  const first = f.service.verifyOne('000001'), second = f.service.verifyOne('000001');
  resolve({}); await Promise.all([first, second]);
  assert.equal(f.calls.saves, 1);
  assert.equal((await f.service.poll()).checked, 0);
  f.advance(300000); f.monitor.load = async () => ({});
  assert.equal((await f.service.poll()).checked, 1);
});
test('错误策略或非所属股票不能从核验入口写入账户', async () => {
  const f = fixture();
  await assert.rejects(f.service.verify({ strategyId: 'invalid' }), /策略无效/);
  await assert.rejects(f.service.verify({ strategyId: 'swing', symbol: '600519' }), /不属于/);
  assert.equal(f.calls.requests.length, 0); assert.equal(f.calls.saves, 0);
});
test('手动重新核验会升级在途普通检查，强制取得新证据', async () => {
  const f = fixture(); let release; const forces = [];
  f.monitor.load = async (symbol, force) => { forces.push(force); if (!force) await new Promise(resolve => { release = resolve; }); return {}; };
  const automatic = f.service.verifyOne('000001', false), explicit = f.service.verifyOne('000001', true);
  release(); await Promise.all([automatic, explicit]);
  assert.deepEqual(forces, [false, true]); assert.equal(f.calls.requests.at(-1).force, true);
});
test('保存失败向上传递且不宣称已核验', async () => {
  const f = fixture(); f.service.transaction = () => { throw Error('磁盘不可写'); };
  await assert.rejects(f.service.verify({ strategyId: 'swing' }), /磁盘不可写/);
  assert.equal(f.calls.publishes, 0);
});

const settlePreparation = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function scheduled(f) {
  const callbacks = []; f.service.scheduleCommit = callback => callbacks.push(callback);
  return { callbacks, flush() { assert.ok(callbacks.length); callbacks.shift()(); } };
}
function addMembers(f, symbols) {
  for (const symbol of symbols) f.engine.s.agency.groups[0].members.push({ symbol, reconciliation: { status: 'clear' } });
}

test('同轮已就绪核验合并保存，慢资料不拖住已就绪持仓', async () => {
  const f = fixture(), queue = scheduled(f); addMembers(f, ['sh600000', 'sh600001']);
  f.engine.s.lots.push({ symbol: 'sh600000' }); let release;
  f.monitor.load = async symbol => symbol === 'sh600001' ? new Promise(resolve => { release = resolve; }) : {};
  const first = f.service.verifyOne('sz000001'), held = f.service.verifyOne('sh600000'), slow = f.service.verifyOne('sh600001');
  await settlePreparation(); assert.equal(f.service.ready.length, 2); assert.equal(f.calls.saves, 0);
  queue.flush(); await Promise.all([first, held]);
  assert.equal(f.calls.saves, 1); assert.deepEqual(f.calls.checks.map(item => item.symbol), ['sh600000', 'sz000001']);
  assert.equal(f.service.inflight.has('sh600001'), true);
  release({}); await settlePreparation(); queue.flush(); await slow; assert.equal(f.calls.saves, 2);
});

test('单次同步提交最多5只且后续批次让出事件循环', async () => {
  const f = fixture(), queue = scheduled(f), symbols = ['sz000001', ...Array.from({ length: 6 }, (_, index) => `sh${600000 + index}`)];
  addMembers(f, symbols.slice(1));
  const pending = Promise.all(symbols.map(symbol => f.service.verifyOne(symbol)));
  await settlePreparation(); assert.equal(queue.callbacks.length, 1); assert.equal(f.service.ready.length, 7);
  queue.flush(); assert.equal(f.calls.checks.length, 5); assert.equal(f.calls.saves, 1); assert.equal(queue.callbacks.length, 1);
  queue.flush(); await pending; assert.equal(f.calls.checks.length, 7); assert.equal(f.calls.saves, 2);
});

test('等待提交时重置账户、移除成员或停用服务不会提交旧核验', async () => {
  for (const invalidate of [f => { f.engine.s.agency.epoch = 'new-account'; },
    f => { f.engine.s.agency.groups[0].members = []; }, f => { f.service.isAvailable = () => false; }]) {
    const f = fixture(), queue = scheduled(f), pending = f.service.verifyOne('sz000001');
    await settlePreparation(); assert.equal(f.service.ready.length, 1); invalidate(f); queue.flush();
    assert.equal((await pending).status, 'skipped'); assert.equal(f.calls.saves, 0); assert.equal(f.calls.checks.length, 0); assert.equal(f.calls.publishes, 0);
  }
});

test('已就绪普通核验和强制核验同股串行，强制请求在首次保存后再取证', async () => {
  const f = fixture(), queue = scheduled(f), forces = [];
  f.monitor.load = async (_symbol, force) => { forces.push(force); return {}; };
  const first = f.service.verifyOne('sz000001'); await settlePreparation();
  const second = f.service.verifyOne('sz000001', true); await settlePreparation();
  assert.deepEqual(forces, [false]); assert.equal(f.service.ready.length, 1);
  queue.flush(); await first; await settlePreparation(); assert.deepEqual(forces, [false, true]);
  queue.flush(); await second; assert.equal(f.calls.saves, 2); assert.equal(f.service.inflight.size, 0);
});

test('20只后台检查先取证持仓，只合并已就绪的两路结果', async () => {
  const f = fixture(), symbols = ['sz000001', ...Array.from({ length: 20 }, (_, index) => `sh${600000 + index}`)];
  addMembers(f, symbols.slice(1)); f.engine.s.lots.push({ symbol: symbols.at(-1) });
  const loaded = []; f.monitor.load = async symbol => { loaded.push(symbol); return {}; };
  const result = await f.service.poll();
  assert.equal(result.checked, 20); assert.equal(loaded[0], symbols.at(-1)); assert.equal(f.calls.saves, 10);
  assert.equal(f.calls.publishes, 10); assert.equal(f.calls.checks.length, 20);
});

test('合并保存失败回滚全批并拒绝剩余已就绪核验和后续请求', async () => {
  const f = fixture(), queue = scheduled(f), symbols = ['sz000001', ...Array.from({ length: 5 }, (_, index) => `sh${600000 + index}`)];
  addMembers(f, symbols.slice(1)); const before = structuredClone(f.engine.s); let attempts = 0;
  f.engine.agencyAutomaticBlock = symbol => { f.engine.s.agency.groups[0].members.find(member => member.symbol === symbol).checked = true; return null; };
  f.service.transaction = fn => { attempts++; const rollback = structuredClone(f.engine.s); try { fn(); throw Error('磁盘保存失败'); } catch (error) { f.engine.s = rollback; throw error; } };
  const outcomes = Promise.allSettled(symbols.map(symbol => f.service.verifyOne(symbol)));
  await settlePreparation(); queue.flush(); assert.equal(attempts, 1); assert.deepEqual(f.engine.s, before);
  queue.flush(); const results = await outcomes;
  assert.ok(results.every(result => result.status === 'rejected' && /磁盘保存失败/.test(result.reason.message)));
  assert.equal(attempts, 1); assert.equal(f.calls.publishes, 0); assert.equal(f.service.inflight.size, 0);
  await assert.rejects(f.service.verifyOne('sz000001'), /磁盘保存失败/); await assert.rejects(f.service.poll(), /磁盘保存失败/);
});

test('取证超时拒绝核验且清除在途记录，不产生成功通知或空资料放行', async () => {
  const f = fixture(); f.monitor.load = async () => { throw Error('资料请求超时'); };
  await assert.rejects(f.service.verifyOne('sz000001'), /资料请求超时/);
  assert.equal(f.service.inflight.size, 0); assert.equal(f.service.ready.length, 0); assert.equal(f.calls.saves, 0); assert.equal(f.calls.publishes, 0);
  f.monitor.load = async () => ({});
  assert.equal((await f.service.verifyOne('sz000001', true)).status, 'clear'); assert.equal(f.calls.saves, 1);
});

test('盘前调用准备入口，完成资料准备后保持五分钟检查而非反复按失败重试', async () => {
  const f = fixture(), member = f.engine.s.agency.groups[0].members[0];
  f.advance(-3600000); let preparations = 0;
  f.engine.agencyPrepare = () => {
    preparations++;
    const reason = '盘前资料准备完成，等待开盘行情';
    member.automaticCheck = { status: 'waiting', phase: 'prepared', reason };
    return reason;
  };
  const first = await f.service.poll();
  assert.equal(first.waiting, 1); assert.equal(first.results[0].phase, 'prepared');
  assert.equal(f.calls.checks.length, 0); assert.equal(preparations, 1);
  f.advance(60000); assert.equal((await f.service.poll()).checked, 0);
  f.advance(240000); assert.equal((await f.service.poll()).checked, 1); assert.equal(preparations, 2);
});

test('暂时取证失败在一分钟后自动恢复，不需要手动重新核验', async () => {
  const f = fixture(); let requests = 0;
  f.monitor.load = async () => { if (++requests === 1) throw Error('接口返回 501'); return {}; };
  const first = await f.service.poll();
  assert.equal(first.waiting, 1); assert.match(first.results[0].reason, /501/); assert.equal(f.calls.saves, 0);
  f.advance(59999); assert.equal((await f.service.poll()).checked, 0);
  f.advance(1); assert.equal((await f.service.poll()).clear, 1); assert.equal(requests, 2);
  f.advance(60000); assert.equal((await f.service.poll()).checked, 0);
});

test('尚未准备好与资料拦截均一分钟自动复核，冷却从请求完成时计算', async () => {
  for (const status of ['waiting', 'blocked']) {
    const f = fixture(), member = f.engine.s.agency.groups[0].members[0]; let requests = 0;
    f.monitor.load = async () => { requests++; f.advance(30000); return {}; };
    f.engine.agencyPrepare = () => {
      member.automaticCheck = { status, reason: '等待有效资料' }; return '等待有效资料';
    };
    assert.equal((await f.service.poll())[status], 1);
    f.advance(59999); assert.equal((await f.service.poll()).checked, 0);
    f.advance(1); assert.equal((await f.service.poll())[status], 1); assert.equal(requests, 2);
  }
});

test('开盘立即复核盘前结果，午间后也重检且不强制绕过上游冷却', async () => {
  for (const start of ['2026-10-09T09:29:50+08:00', '2026-10-09T12:59:50+08:00']) {
    const f = fixture(), member = f.engine.s.agency.groups[0].members[0], loads = [];
    f.advance(Date.parse(start) - Date.parse('2026-10-09T10:00:00+08:00'));
    f.monitor.load = async (_symbol, force) => { loads.push(force); return {}; };
    f.engine.agencyPrepare = () => {
      const prepared = loads.length === 1, reason = prepared ? '盘前资料准备完成' : '';
      member.automaticCheck = { status: prepared ? 'waiting' : 'clear', ...(prepared ? { phase: 'prepared' } : {}), reason };
      return reason || null;
    };
    assert.equal((await f.service.poll()).waiting, 1);
    f.advance(10000); assert.equal((await f.service.poll()).clear, 1);
    assert.deepEqual(loads, [false, false]); assert.equal((await f.service.poll()).checked, 0);
  }
});

test('持续失败的前二十只不会饿死后续候选', async () => {
  const f = fixture(), symbols = ['sz000001', ...Array.from({ length: 40 }, (_, index) => `sh${600000 + index}`)], loads = [];
  addMembers(f, symbols.slice(1)); f.engine.s.lots.push({ symbol: symbols[0] });
  f.monitor.load = async symbol => { loads.push(symbol); throw Error('接口暂不可用'); };
  assert.equal((await f.service.poll()).waiting, 20);
  f.advance(60000); assert.equal((await f.service.poll()).waiting, 20);
  assert.equal(new Set(loads).size, 40);
  f.advance(60000); await f.service.poll(); assert.equal(new Set(loads).size, 41);
});

test('单只资料异常与单只引擎核验异常都不打断后续股票', async () => {
  for (const failsInEngine of [false, true]) {
    const f = fixture(); addMembers(f, ['sh600000', 'sh600001', 'sh600002', 'sh600003']);
    if (failsInEngine) f.engine.agencyPrepare = symbol => { if (symbol === 'sz000001') throw Error('单股核验异常'); return null; };
    else f.monitor.load = async symbol => { if (symbol === 'sz000001') throw Error('单股资料异常'); return {}; };
    const result = await f.service.poll();
    assert.equal(result.checked, 5); assert.ok(result.waiting >= 1);
    assert.equal(result.results.find(item => item.symbol === 'sh600003').status, 'clear');
    assert.equal(f.service.storageError, null);
  }
});

test('进入事务前即保存不可用会停止整批及后续自动核验', async () => {
  const f = fixture(); addMembers(f, ['sh600000', 'sh600001']); let loads = 0;
  f.monitor.load = async () => { loads++; return {}; };
  f.service.transaction = () => { throw Error('账户存储不可用'); };
  await assert.rejects(f.service.poll(), /账户存储不可用/); assert.equal(loads, 2);
  await assert.rejects(f.service.poll(), /账户存储不可用/); assert.equal(loads, 2);
  assert.equal(f.calls.publishes, 0);
});

test('新账户不用旧账户冷却或在途结果，旧请求结束不清除新请求', async () => {
  const f = fixture(), releases = [];
  f.monitor.load = () => new Promise(resolve => releases.push(resolve));
  const oldPoll = f.service.poll(); assert.equal(releases.length, 1);
  f.advance(10000); f.engine.s.agency.epoch = 'account-b';
  const newPoll = f.service.poll(); assert.notEqual(oldPoll, newPoll); assert.equal(releases.length, 2);
  const newInflight = f.service.inflight.get('sz000001');
  releases[0]({}); assert.equal((await oldPoll).skipped, 1);
  assert.equal(f.service.poll(), newPoll); assert.equal(f.service.inflight.get('sz000001'), newInflight);
  assert.equal(f.calls.saves, 0);
  releases[1]({}); assert.equal((await newPoll).clear, 1); assert.equal(f.calls.saves, 1);
  assert.equal((await f.service.poll()).checked, 0);
  f.engine.s.agency.epoch = 'account-c'; f.monitor.load = async () => ({});
  assert.equal((await f.service.poll()).clear, 1);
});

test('账户切换后旧批次不再启动尚未取证的股票', async () => {
  const f = fixture(), releases = [], loads = []; addMembers(f, ['sh600000', 'sh600001']);
  f.monitor.load = symbol => { loads.push(symbol); return new Promise(resolve => releases.push(resolve)); };
  const oldPoll = f.service.poll(); assert.equal(loads.length, 2);
  f.engine.s.agency.epoch = 'account-b'; releases.forEach(resolve => resolve({}));
  assert.equal((await oldPoll).skipped, 2); assert.equal(loads.length, 2); assert.equal(f.calls.saves, 0);
  f.monitor.load = async () => ({}); assert.equal((await f.service.poll()).clear, 3);
});

test('自动交易盘前不再为附加财务条件或长线组预取财务及风险公告', async () => {
  const f = fixture(), loads = []; f.advance(-3600000); addMembers(f, ['sh600000']);
  f.engine.s.agency.groups[0].members[0].entryConditions = createEntryConditions({ rules: [{ field: 'roe', op: 'gt', value: 10 }] });
  f.engine.s.agency.groups.push({ id: 'long', members: [{ symbol: 'sh600001', reconciliation: { status: 'clear' } }] });
  f.monitor.load = async (symbol, force, fundamentals, notices) => { loads.push({ symbol, force, fundamentals, notices }); return {}; };
  await f.service.poll();
  assert.deepEqual(loads, [
    { symbol: 'sz000001', force: false, fundamentals: false, notices: false },
    { symbol: 'sh600000', force: false, fundamentals: false, notices: false },
    { symbol: 'sh600001', force: false, fundamentals: false, notices: false }
  ]);
});

test('两只冷资料等待不会占用已准备成员开盘核验通道', async () => {
  const f = fixture(); addMembers(f, ['sh600000', 'sh600001']);
  const releases = [], prepared = { corporateActions: { status: 'ready' } };
  f.monitor.peekPrepared = symbol => symbol === 'sh600001' ? prepared : null;
  f.monitor.load = () => new Promise(resolve => releases.push(resolve));
  const pending = f.service.poll();
  await settlePreparation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2);
  assert.deepEqual(f.calls.checks.map(item => item.symbol), ['sh600001']);
  assert.equal(f.calls.checks[0].snapshot, prepared);
  releases.forEach(resolve => resolve({})); assert.equal((await pending).clear, 3);
});

test('前轮慢请求未完成时，新就绪成员可在下一次poll独立核验', async () => {
  const f = fixture(); let release, coldCalls = 0;
  const prepared = { corporateActions: { status: 'ready' } };
  f.monitor.peekPrepared = symbol => symbol === 'sh600001' ? prepared : null;
  f.monitor.load = () => { coldCalls++; return new Promise(resolve => { release = resolve; }); };
  const old = f.service.poll();
  addMembers(f, ['sh600001']);
  const current = f.service.poll(); assert.notEqual(current, old);
  assert.equal((await current).clear, 1); assert.deepEqual(f.calls.checks.map(item => item.symbol), ['sh600001']);
  addMembers(f, ['sh600002']);
  assert.equal(f.service.poll(), old); assert.equal(f.service.poll(), old); assert.equal(coldCalls, 1, '快批次完成不释放旧冷批次并发锁');
  release({}); assert.equal((await old).clear, 1);
});

test('后台提前续验不阻塞尚在TTL内的开盘快速复用，账户重置丢弃旧准备队列', async () => {
  const f = fixture(), prepared = { corporateActions: { status: 'ready' } }; let release, prepareCalls = 0;
  f.monitor.snapshots = { sz000001: prepared };
  f.monitor.peekPrepared = () => prepared;
  f.monitor.prepare = () => { prepareCalls++; return new Promise(resolve => { release = resolve; }); };
  f.monitor.load = () => assert.fail('已经准备的成员无需等待整体load');
  assert.equal((await f.service.poll()).clear, 1);
  assert.equal(prepareCalls, 1); assert.equal(f.service.preparing.size, 1);
  f.engine.s.agency.epoch = 'new-preparation-account';
  f.service.syncEpoch(); release(prepared); await settlePreparation();
  assert.equal(f.service.preparing.size, 0); assert.equal(f.service.lastPreparation.size, 0);
});

test('等待报价期间已知公司行为更新或失败，提交使用最新证据而非旧快照', async () => {
  for (const failed of [false, true]) {
    const f = fixture(), prepared = { corporateActions: { status: 'ready', revision: 1 } }; let release;
    f.monitor.peekPrepared = () => prepared;
    f.service.market.quotes = () => new Promise(resolve => { release = resolve; });
    f.engine.agencyAutomaticBlock = (_symbol, _quote, snapshot) => {
      assert.notEqual(snapshot.corporateActions, prepared.corporateActions);
      assert.equal(snapshot.corporateActions.status, failed ? 'unavailable' : 'ready');
      return '等待新公司行为复核';
    };
    const pending = f.service.verifyOne('sz000001');
    f.source.get = async () => { if (failed) throw Error('公司行为查新失败'); return { status: 'ready', revision: 2 }; };
    await f.service.getSnapshot('sz000001', true); release({});
    assert.equal((await pending).status, 'waiting');
  }
});

function standbyFixture() {
  const now = new Date('2026-10-21T10:00:00+08:00'), symbol = 'sz000001';
  const engine = new Engine(initialState(100000), () => now), calls = { loads: 0, sources: 0, quotes: 0, saves: 0 };
  engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const group = engine.s.agency.groups.find(item => item.id === 'swing'), member = group.members[0];
  setStandby(engine.s, member, '等待重新筛选');
  member.reconciliation = { status: 'pending', reason: '等待公司行为资料重新核验' };
  const source = { async get(input) {
    calls.sources++; assert.equal(input.force, true);
    return { symbol, status: 'ready', fetchedAt: now.getTime(), coverageStart: '2026-01-01',
      coverageEnd: '2026-10-21', coverageComplete: true, events: [], notices: [] };
  } };
  const snapshot = { source: '隔离日线', fetchedAt: now.getTime(), technical: { asOf: '2026-10-20', close: 10 },
    notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } },
    corporateActions: { symbol, status: 'unavailable', fetchedAt: now.getTime() - 600000, coverageComplete: false, events: [] } };
  const monitor = { snapshots: { [symbol]: snapshot }, async load() { calls.loads++; return snapshot; },
    prepare() { assert.fail('候补不可进入常规提前续验'); } };
  const service = new CorporateService({ source, getEngine: () => engine, getMonitor: () => monitor,
    clock: () => now.getTime(), transaction: fn => { const result = fn(); calls.saves++; return result; },
    market: { async quotes() { calls.quotes++; return { [symbol]: { symbol, price: 10.1, prevClose: 10,
      timestamp: now.getTime(), date: '2026-10-21' } }; } } });
  return { service, source, monitor, engine, calls, group, member, symbol, snapshot };
}

test('未持仓活跃候选仍自动准备日线，不进入公司行为下载队列', async () => {
  const f = standbyFixture(), loads = [];
  f.member.mode = 'active'; delete f.member.standbyReason;
  f.monitor.prepare = async (...args) => { loads.push(['prepare', ...args]); return f.snapshot; };
  f.monitor.load = async (...args) => { f.calls.loads++; loads.push(['load', ...args]); return f.snapshot; };
  assert.deepEqual(f.service.symbols(), []);
  assert.deepEqual(f.service.preparationSymbols(), [f.symbol]);
  assert.equal(f.service.requiresEvidence(f.symbol), false);
  const result = await f.service.poll();
  assert.equal(result.clear, 1);
  assert.deepEqual(loads, [['prepare', f.symbol, false, false], ['load', f.symbol, false, false, false]]);
  assert.equal(f.calls.sources, 0); assert.equal(f.calls.quotes, 1); assert.equal(f.calls.saves, 1);
  assert.equal(f.member.corporateVerification.status, 'not-required');
  assert.equal(validState(f.engine.s), true);
});

test('纯候补不轮询，显式核验用行情和日线解除无权益阻断且不下载公告，仍需重新筛选激活', async () => {
  const f = standbyFixture(), before = { cash: f.engine.s.cash, lots: structuredClone(f.engine.s.lots), trades: structuredClone(f.engine.s.trades) };
  assert.deepEqual(f.service.symbols(), []); assert.equal((await f.service.poll()).checked, 0);
  assert.equal(await f.service.getSnapshot(f.symbol, true), null);
  assert.deepEqual(f.calls, { loads: 0, sources: 0, quotes: 0, saves: 0 });
  const result = await f.service.verify({ strategyId: 'swing', symbol: f.symbol });
  assert.equal(result.clear, 1); assert.equal(result.skipped, 0);
  assert.deepEqual(f.calls, { loads: 1, sources: 0, quotes: 1, saves: 1 });
  assert.equal(f.member.reconciliation.status, 'clear'); assert.equal(f.member.mode, 'standby');
  assert.equal(f.snapshot.corporateActions.status, 'unavailable', '单次核验不改写旧监控快照');
  assert.equal(f.engine.agencyEvaluate('swing', f.symbol, {}, {}).buyable, false);
  assert.deepEqual({ cash: f.engine.s.cash, lots: f.engine.s.lots, trades: f.engine.s.trades }, before);
  assert.equal(validState(f.engine.s), true); assert.equal((await f.service.poll()).checked, 0);
});

test('无权益候补不受公司行为来源失败阻断，但当日价格基准不匹配仍阻断', async () => {
  const f = standbyFixture(); f.source.get = async () => { throw Error('隔离资料源离线'); };
  f.snapshot.technical.close = 9;
  const result = await f.service.verify({ strategyId: 'swing', symbol: f.symbol });
  assert.equal(result.clear, 0); assert.equal(result.blocked, 1); assert.match(result.results[0].reason, /价格基准不一致/);
  assert.equal(f.member.reconciliation.status, 'pending'); assert.equal(f.member.mode, 'standby');
  assert.equal(f.engine.s.trades.length, 0); assert.equal(validState(f.engine.s), true);
});

test('候补显式核验在取证或等待提交期间失效，不写入已移除成员或新账户', async () => {
  for (const phase of ['load', 'source', 'commit']) for (const reset of [false, true]) {
    const f = standbyFixture(); let release, queue;
    f.member.reconciliation.affectsEquity = true;
    if (phase === 'load') f.monitor.load = () => new Promise(resolve => { release = () => resolve(f.snapshot); });
    if (phase === 'source') { const get = f.source.get; f.source.get = input => new Promise(resolve => { release = async () => resolve(await get(input)); }); }
    if (phase === 'commit') queue = scheduled(f);
    const pending = f.service.verify({ strategyId: 'swing', symbol: f.symbol });
    await settlePreparation();
    if (reset) f.engine.s.agency.epoch = 'reset-standby-account';
    else f.group.members = [];
    if (queue) queue.flush(); else await release();
    assert.equal((await pending).skipped, 1, `${phase}/${reset}`);
    assert.equal(f.calls.saves, 0); assert.equal(f.engine.s.trades.length, 0);
    assert.equal(f.service.latestEvidence.size, phase === 'commit' ? 1 : 0);
  }
});
