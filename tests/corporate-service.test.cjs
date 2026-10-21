const test = require('node:test');
const assert = require('node:assert/strict');
const { CorporateService } = require('../core/corporate-service.cjs');
const { createEntryConditions } = require('../core/entry-conditions.cjs');

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

test('盘前也为短线附加财务条件预取财务资料，普通成员不多取', async () => {
  const f = fixture(), loads = []; f.advance(-3600000); addMembers(f, ['sh600000']);
  f.engine.s.agency.groups[0].members[0].entryConditions = createEntryConditions({ rules: [{ field: 'roe', op: 'gt', value: 10 }] });
  f.engine.s.agency.groups.push({ id: 'long', members: [{ symbol: 'sh600001', reconciliation: { status: 'clear' } }] });
  f.monitor.load = async (symbol, force, fundamentals, notices) => { loads.push({ symbol, force, fundamentals, notices }); return {}; };
  await f.service.poll();
  assert.deepEqual(loads, [
    { symbol: 'sz000001', force: false, fundamentals: true, notices: true },
    { symbol: 'sh600000', force: false, fundamentals: false, notices: true },
    { symbol: 'sh600001', force: false, fundamentals: true, notices: true }
  ]);
});
