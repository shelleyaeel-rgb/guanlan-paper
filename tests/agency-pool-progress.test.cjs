'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { Engine, initialState } = require('../core/engine.cjs');
const { AgencyPoolService } = require('../core/agency-pool.cjs');
const { poolPolicy } = require('../core/agency-screening.cjs');
const { composeStrategyQuery } = require('../core/strategy-presets.cjs');

function emptyResult(now) {
  const policy = poolPolicy();
  return { startedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(),
    strategies: Object.fromEntries(policy.priority.map(id => [id, { query: composeStrategyQuery(id, policy.commonQuery), pass: [], failed: [], pending: [] }])) };
}

test('进度不读取账户或复制历史结果，生命周期包含唯一运行标识与稳定耗时', async () => {
  const engine = new Engine(initialState()); let now = 10000, release, reads = 0;
  const changes = [], screener = { progress: {}, cancel() {} };
  const service = new AgencyPoolService({ getEngine: () => { reads++; return engine; }, transaction: fn => fn(), screener,
    clock: () => now, onChange: event => changes.push({ event, ...service.progressState() }),
    screen: () => new Promise(resolve => { release = resolve; }) });
  const first = service.run(), firstId = service.progressState().runId;
  assert.ok(firstId); assert.equal(service.progressState().progress.stage, 'preparing');
  screener.progress = { stage: 'evidence', completed: 2, total: 8, detail: { documentId: 'doc', page: 3, pages: 100 } };
  now += 1500; const before = reads, progress = service.progressState();
  assert.equal(reads, before); assert.equal(progress.elapsedMs, 1500); assert.equal(progress.running, true);
  assert.deepEqual(Object.keys(progress).sort(), ['elapsedMs', 'lastError', 'operation', 'progress', 'runId', 'running'].sort());
  progress.progress.detail.page = 99; assert.equal(screener.progress.detail.page, 3);
  release(emptyResult(now)); await first;
  now += 60000; assert.equal(service.progressState().elapsedMs, 1500);
  assert.equal(service.publicState().runId, firstId); assert.equal(service.publicState().running, false);
  assert.equal(changes.length, 2); assert.equal(changes[0].running, true); assert.equal(changes[1].running, false);
  const savedResult = engine.s.agency.pool.lastResult;
  const second = service.run(); assert.notEqual(service.progressState().runId, firstId);
  service.cancel(); release(emptyResult(now)); await assert.rejects(second, /已取消/);
  assert.equal(engine.s.agency.pool.lastResult, savedResult); assert.equal(changes[3].event.progressOnly, true);
  assert.match(service.progressState().lastError, /已取消/);
});

test('主进程每秒进度只发送小消息，结束时清理定时器而不重复发布完整账户', async () => {
  const mainPath = path.join(__dirname, '../main.cjs'), source = fs.readFileSync(mainPath, 'utf8'), localRequire = createRequire(mainPath);
  let resolveRun, timerCallback, cleared = 0, stateReads = 0; const sent = [];
  const testing = { win: { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } },
    agencyPool: { progressState: () => ({ runId: 'isolated-run', running: true, progress: { stage: 'evidence', completed: 4, total: 9 }, elapsedMs: 1200 }),
      publicState: () => { stateReads++; throw Error('不应复制完整结果'); }, run: () => new Promise(resolve => { resolveRun = resolve; }) } };
  const context = vm.createContext({ testing, structuredClone, process: { argv: [] }, setTimeout, clearTimeout,
    setInterval: (callback, milliseconds) => { assert.equal(milliseconds, 1000); timerCallback = callback; return 7; },
    clearInterval: id => { assert.equal(id, 7); cleared++; },
    require: name => name === 'electron' ? { app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) } } : localRequire(name) });
  vm.runInContext(source, context, { filename: mainPath });
  vm.runInContext('win = testing.win; agencyPool = testing.agencyPool;', context);
  const start = source.indexOf('  const updateCandidatePool = async ');
  const end = source.indexOf("  handler('agency:pool:run'", start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const running = vm.runInContext('updateCandidatePool(false)', context);
  timerCallback(); timerCallback();
  assert.equal(stateReads, 0); assert.equal(sent.length, 2);
  assert.ok(sent.every(item => item.channel === 'agency:pool:progress'));
  assert.ok(sent.every(item => !Object.hasOwn(item.payload, 'account') && !Object.hasOwn(item.payload, 'lastResult')));
  resolveRun({ counts: {} }); await running; assert.equal(cleared, 1); assert.equal(sent.length, 2);
});

test('界面保留历史结果引用，旧运行或结束后的进度不能重新激活任务', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ui/agency.js'), 'utf8');
  const start = source.indexOf('function applyAgencyPoolProgress('), end = source.indexOf('function agencyPoolElapsed(', start);
  const lastResult = { id: 'old-result', unassignedPending: ['历史核验结果'] }, account = { sentinel: true };
  const context = vm.createContext({ state: { account, agencyPool: { runId: 'run-two', running: true, lastResult, policy: { version: 2 } } },
    renders: 0, renderAgencyPool: () => { context.renders++; } });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(vm.runInContext("applyAgencyPoolProgress({ runId: 'run-one', running: true })", context), false);
  assert.equal(vm.runInContext("applyAgencyPoolProgress({ runId: 'run-two', running: true, progress: { completed: 3 }, elapsedMs: 2000 })", context), true);
  assert.equal(context.state.agencyPool.lastResult, lastResult); assert.equal(context.state.account, account);
  assert.equal(context.state.agencyPool.progress.completed, 3); assert.equal(context.renders, 1);
  context.state.agencyPool.running = false;
  assert.equal(vm.runInContext("applyAgencyPoolProgress({ runId: 'run-two', running: true })", context), false);
  assert.equal(context.state.agencyPool.running, false); assert.equal(context.renders, 1);
});
