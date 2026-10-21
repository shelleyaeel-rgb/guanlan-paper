'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const { PERFORMANCE_METADATA, validatePerformanceRules } = require('../core/performance-rules.cjs');
const { INDUSTRY_METADATA } = require('../core/selection-evidence.cjs');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { addAgencyMembers } = require('../core/agency-members.cjs');
const NOW = new Date('2026-10-15T10:00:00+08:00');
const performance = (value = -10, enabled = true) => ({ version: 1, enabled, rules: [{ field: 'netProfitGrowthMinPct', op: 'gte', value }] });
const mainSource = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');

// Exercise the production handler bodies in an isolated host; Electron startup,
// background market requests and the user's account directory are not needed.
function poolRoutes(run) {
  const handlers = {}, calls = { invalidated: 0, polled: 0, started: 0, cleared: 0 };
  const start = mainSource.indexOf('  const updateCandidatePool = async '), end = mainSource.indexOf("  handler('research:get'", start);
  assert.ok(start >= 0 && end > start);
  const context = { fatal: '', handler: (name, callback) => { handlers[name] = callback; }, agencyPool: { run },
    agency: { invalidate() { calls.invalidated++; }, poll: async () => { calls.polled++; } }, publishAgencyPoolProgress: () => {},
    setInterval: () => { calls.started++; return 1; }, clearInterval: () => { calls.cleared++; } };
  vm.runInNewContext(mainSource.slice(start, end), context, { filename: 'main.cjs:pool-routes' });
  return { handlers, calls };
}

test('pool run and retry IPC preserve enabled, disabled, omitted and invalid forecast conditions', async () => {
  const received = [], { handlers, calls } = poolRoutes(async input => {
    received.push(input);
    validatePerformanceRules(input.performance);
    return { ok: true };
  });
  const selected = performance();
  await handlers['agency:pool:run']({ performance: selected, screeningMode: 'strategy' });
  assert.equal(received[0].performance, selected); assert.equal(received[0].retryEvidence, false);
  await handlers['agency:pool:retry']({ performance: performance(-30, false) });
  assert.equal(received[1].performance.enabled, false); assert.equal(received[1].retryEvidence, true);
  await handlers['agency:pool:retry'](); assert.equal(Object.hasOwn(received[2], 'performance'), false);
  await assert.rejects(handlers['agency:pool:run']({ performance: { ...selected, version: 9 } }), /版本/);
  assert.equal(received.length, 4); assert.equal(calls.invalidated, 3); assert.equal(calls.polled, 3);
  assert.equal(calls.started, 4); assert.equal(calls.cleared, 4);
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

test('performance-only single and batch additions persist across restart without mutating earlier member conditions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-performance-save-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('guanlan-performance-save-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let engine = new Engine(initialState(), () => NOW);
  const store = new Store(directory), input = { performance: performance() };
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
  assert.deepEqual(members.find(member => member.symbol === 'sh600002').entryConditions.performance, performance(-20));
  assert.deepEqual(members.find(member => member.symbol === 'sh600003').entryConditions.performance, performance(-20));
  assert.equal(members[0].entryConditions.rules.length, 0);
});
