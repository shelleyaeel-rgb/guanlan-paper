'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const { PERFORMANCE_METADATA } = require('../core/performance-rules.cjs');
const { INDUSTRY_METADATA } = require('../core/selection-evidence.cjs');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { addAgencyMembers } = require('../core/agency-members.cjs');
const { AgencyPoolScheduler } = require('../core/agency-pool-scheduler.cjs');
const NOW = new Date('2026-10-15T10:00:00+08:00');
const performance = (value = -10, enabled = true) => ({ version: 1, enabled, rules: [{ field: 'netProfitGrowthMinPct', op: 'gte', value }] });
const mainSource = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');

// Exercise the production handler bodies in an isolated host; Electron startup,
// background market requests and the user's account directory are not needed.
function poolRoutes(run) {
  const handlers = {}, calls = { invalidated: 0, polled: 0, prepared: 0, started: 0, cleared: 0 };
  const start = mainSource.indexOf('  const updateCandidatePool = async '), end = mainSource.indexOf("  handler('research:get'", start);
  assert.ok(start >= 0 && end > start);
  const context = { fatal: '', handler: (name, callback) => { handlers[name] = callback; }, agencyPool: { run },
    AgencyPoolScheduler, engine: new Engine(initialState(), () => NOW), screener: { activeRun: null }, schedulePublish: () => {},
    agency: { invalidate() { calls.invalidated++; }, poll: async () => { calls.polled++; }, prepareEntries: async () => { calls.prepared++; } }, publishAgencyPoolProgress: () => {},
    setInterval: () => { calls.started++; return 1; }, clearInterval: () => { calls.cleared++; } };
  vm.runInNewContext(mainSource.slice(start, end), context, { filename: 'main.cjs:pool-routes' });
  return { handlers, calls, scheduler: context.poolScheduler };
}

test('自动池运行与重试接口忽略旧研究、行业和业绩草稿，始终使用技术筛选', async () => {
  const received = [], { handlers, calls } = poolRoutes(async input => {
    received.push(input);
    return { ok: true };
  });
  const selected = performance();
  await handlers['agency:pool:run']({ performance: selected, screeningMode: 'strict', research: { enabled: true }, industry: { enabled: true } });
  assert.deepEqual(JSON.parse(JSON.stringify(received[0])), { screeningMode: 'strategy', retryEvidence: false, automatic: false });
  await handlers['agency:pool:retry']({ performance: performance(-30, false) });
  assert.equal(received[1].performance, undefined); assert.equal(received[1].retryEvidence, true);
  await handlers['agency:pool:retry'](); assert.equal(Object.hasOwn(received[2], 'performance'), false);
  await handlers['agency:pool:run']({ performance: { ...selected, version: 9 } });
  assert.equal(received[3].performance, undefined);
  assert.equal(received.length, 4); assert.equal(calls.invalidated, 4); assert.equal(calls.prepared, 4); assert.equal(calls.polled, 0);
  assert.equal(calls.started, 4); assert.equal(calls.cleared, 4);
});

test('automatic pool callback enables unavailable-result protection and prepares without starting a trade cycle', async () => {
  let received;
  const host = poolRoutes(async input => { received = input; return { ok: true }; });
  await host.scheduler.run({ screeningMode: 'strict', performance: performance(-5) });
  assert.equal(received.automatic, true); assert.equal(received.retryEvidence, false); assert.equal(received.screeningMode, 'strategy');
  assert.equal(received.performance, undefined); assert.equal(host.calls.prepared, 1); assert.equal(host.calls.polled, 0);
});

test('screener metadata exposes forecast fields separately from actual financial fields', () => {
  const line = mainSource.split('\n').find(line => line.includes("handler('screener:meta'"));
  assert.ok(line);
  let output;
  vm.runInNewContext(line, { handler: (_name, load) => { output = load(); }, FIELDS: { roe: { unit: '%' } }, BOARDS: {}, OPS: {},
    STRATEGY_PRESETS: {}, EVIDENCE_KINDS: {}, EVIDENCE_CONDITIONS: {}, INDUSTRY_METADATA, financialQualityRules: () => [], RESEARCH_METADATA: {}, PERFORMANCE_METADATA });
  assert.equal(output.performance, PERFORMANCE_METADATA);
  assert.deepEqual(Object.keys(output.performance.fields), ['netProfitGrowthMinPct', 'recurringProfitGrowthMinPct']);
  assert.equal(Object.hasOwn(output.fields, 'netProfitGrowthMinPct'), false);
});

test('自动成员忽略新增业绩条件，单只及批量重启后仅保留原技术条件', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-performance-save-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('guanlan-performance-save-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let engine = new Engine(initialState(), () => NOW);
  const store = new Store(directory), input = { rules: [{ field: 'price', op: 'gt', value: 5 }], performance: performance() };
  engine.agencyMember({ strategyId: 'swing', symbol: 'sh600001', action: 'add', entryConditions: input });
  const first = structuredClone(engine.s.agency.groups.find(group => group.id === 'swing').members[0].entryConditions);
  input.performance.rules[0].value = -50;
  engine.agencyMember({ strategyId: 'swing', symbol: 'sh600001', action: 'add', entryConditions: input });
  await addAgencyMembers({ strategyId: 'swing', symbols: ['sh600002', 'sh600003'], entryConditions: { performance: performance(-20) } }, {
    getEngine: () => engine, transaction: fn => { const result = fn(); store.save(engine.s); return result; },
    market: { quotes: async symbols => Object.fromEntries(symbols.map(symbol => [symbol, { symbol, name: '隔离测试', price: 10, timestamp: +NOW, date: '2026-10-15' }])) },
    acceptQuotes: () => {}
  });
  engine = new Engine(store.load(), () => NOW);
  assert.equal(validState(engine.s), true);
  const members = engine.s.agency.groups.find(group => group.id === 'swing').members;
  assert.deepEqual(members.find(member => member.symbol === 'sh600001').entryConditions, first);
  assert.equal(members.find(member => member.symbol === 'sh600002').entryConditions, undefined);
  assert.equal(members.find(member => member.symbol === 'sh600003').entryConditions, undefined);
  assert.equal(members[0].entryConditions.performance, undefined);
  assert.deepEqual(members[0].entryConditions.rules, [{ field: 'price', op: 'gt', value: 5 }]);
});
