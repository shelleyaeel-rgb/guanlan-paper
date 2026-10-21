const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { Engine, initialState } = require('../core/engine.cjs');

test('大量自动成员不进入常规行情或日线全量扫描，慢速资料不会阻塞持仓tick与批次调度', async () => {
  const mainPath = path.join(__dirname, '../main.cjs'), localRequire = createRequire(mainPath);
  const engine = new Engine(initialState()), members = Array.from({ length: 101 }, (_, index) => `sh${600101 + index}`);
  for (const symbol of members) engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' });
  // The test only needs a holding symbol for orchestration; execution remains stubbed.
  engine.s.lots.push({ symbol: 'sh601000', quantity: 100, owner: 'manual' });
  const calls = { quotes: [], scans: [], ticks: 0, polls: 0, samples: 0, preparation: 0 };
  const testing = { engine: { s: engine.s, tick: () => { calls.ticks++; }, stats: () => ({}), agencyState: () => ({ groups: [] }), selectedStrategy: () => 'swing' },
    market: { quotes: async symbols => { calls.quotes.push([...symbols]); return {}; } },
    monitor: { snapshots: {}, scan: (...args) => { calls.scans.push(args); return new Promise(() => {}); } },
    marketRegime: { poll: async () => { calls.preparation++; } },
    agency: { publicState: () => ({}), poll: async () => { calls.polls++; }, sampleEntries: () => { calls.samples++; return new Promise(() => {}); } }, store: { save: () => {}, warning: '' } };
  const context = vm.createContext({ testing, structuredClone, process: { argv: [] }, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'electron' ? { app: { requestSingleInstanceLock: () => true, on: () => {}, whenReady: () => ({ then: () => {} }), getPath: () => 'isolated-memory' } }
      : name === './core/strategy.cjs' ? { ...localRequire(name), evaluateEntry: () => ({ reasons: [] }) }
      : name === './core/common.cjs' ? { ...localRequire(name), session: () => ({ open: false, known: true }) } : localRequire(name) });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context, { filename: mainPath });
  vm.runInContext('engine = testing.engine; market = testing.market; monitor = testing.monitor; agency = testing.agency; store = testing.store; marketRegime = testing.marketRegime;', context);
  const result = await vm.runInContext('refresh()', context);
  assert.equal(calls.ticks, 1); assert.equal(calls.polls, 1); assert.equal(calls.samples, 1);
  assert.equal(calls.preparation, 1, '盘前也自动准备公共市场资料');
  assert.ok(calls.quotes[0].includes('sh601000'));
  assert.ok(members.every(symbol => !calls.quotes[0].includes(symbol)));
  assert.equal(calls.scans.length, 2); assert.deepEqual(Array.from(calls.scans[0][0]), ['sh601000']); assert.equal(calls.scans[0][3], 'holdings');
  assert.ok(members.every(symbol => !calls.scans[1][0].includes(symbol)));
  assert.ok(members.every(symbol => !Object.hasOwn(result.signals, symbol)));
});
