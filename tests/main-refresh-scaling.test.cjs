const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { Engine, initialState } = require('../core/engine.cjs');

test('大量自动成员不进入常规行情或日线全量扫描，慢速资料不会阻塞持仓tick与批次调度', async () => {
  const mainPath = path.join(__dirname, '../main.cjs'), localRequire = createRequire(mainPath);
  const engine = new Engine(initialState()), members = Array.from({ length: 101 }, (_, index) => `sh${600101 + index}`);
  engine.s.watchlist = ['sh600519']; // Even an injected legacy personal list is ignored.
  for (const symbol of members) engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' });
  // The test only needs a holding symbol for orchestration; execution remains stubbed.
  engine.s.lots.push({ symbol: 'sh601000', quantity: 100, owner: 'manual' });
  const calls = { quotes: [], scans: [], ticks: 0, polls: 0, samples: 0, preparation: 0, entryPreparation: 0, poolPolls: 0 };
  let releaseQuotes;
  const waitingQuotes = new Promise(resolve => { releaseQuotes = resolve; });
  const testing = { engine: { s: engine.s, tick: () => { calls.ticks++; }, stats: () => ({}), agencyState: () => ({ groups: [] }), selectedStrategy: () => 'swing' },
    market: { quotes: async symbols => { calls.quotes.push([...symbols]); await waitingQuotes; return {}; } },
    monitor: { snapshots: {}, scan: (...args) => { calls.scans.push(args); return new Promise(() => {}); } },
    marketRegime: { poll: async () => { calls.preparation++; } },
    poolScheduler: { poll: async () => { calls.poolPolls++; }, publicState: () => ({ status: 'waiting' }) },
    agency: { publicState: () => ({}), poll: async () => { calls.polls++; }, sampleEntries: () => { calls.samples++; return new Promise(() => {}); },
      prepareEntries: () => { calls.entryPreparation++; return new Promise(() => {}); } }, store: { save: () => {}, warning: '' } };
  const context = vm.createContext({ testing, structuredClone, process: { argv: [] }, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'electron' ? { app: { requestSingleInstanceLock: () => true, on: () => {}, whenReady: () => ({ then: () => {} }), getPath: () => 'isolated-memory' } }
      : name === './core/strategy.cjs' ? { ...localRequire(name), evaluateEntry: () => ({ reasons: [] }) }
      : name === './core/common.cjs' ? { ...localRequire(name), session: () => ({ open: false, known: true }) } : localRequire(name) });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context, { filename: mainPath });
  vm.runInContext('engine = testing.engine; market = testing.market; monitor = testing.monitor; agency = testing.agency; store = testing.store; marketRegime = testing.marketRegime; poolScheduler = testing.poolScheduler;', context);
  const refreshing = vm.runInContext('refresh()', context);
  assert.equal(calls.preparation, 1, '报价仍在等待时，准备任务已经独立开始');
  assert.equal(calls.entryPreparation, 1, '报价仍在等待时，候选资料也独立开始准备');
  assert.equal(calls.poolPolls, 1, '自动候选更新不依赖常规报价返回');
  assert.equal(calls.ticks, 0);
  releaseQuotes();
  const result = await refreshing;
  assert.equal(calls.ticks, 1); assert.equal(calls.polls, 1); assert.equal(calls.samples, 1);
  assert.equal(calls.preparation, 1, '盘前也自动准备公共市场资料');
  assert.equal(calls.entryPreparation, 1, '候选资料仍未返回，不阻塞本轮持仓和行情处理');
  assert.ok(calls.quotes[0].includes('sh601000'));
  assert.ok(members.every(symbol => !calls.quotes[0].includes(symbol)));
  assert.equal(calls.quotes[0].includes('sh600519'), false, '旧个人自选不消耗常规报价');
  assert.equal(calls.scans.length, 2); assert.deepEqual(Array.from(calls.scans[0][0]), ['sh601000']); assert.equal(calls.scans[0][3], 'holdings');
  assert.ok(members.every(symbol => !calls.scans[1][0].includes(symbol)));
  assert.ok(members.every(symbol => !Object.hasOwn(result.signals, symbol)));
  assert.equal(Object.hasOwn(result.signals, 'sh600519'), false);
  assert.equal(calls.scans[1][0].includes('sh600519'), false);
  vm.runInContext("previewSymbol = 'sh600519'", context);
  assert.ok(vm.runInContext('strategySymbols()', context).includes('sh600519'), '主动详情仍可按需刷新');
  const handlers = {};
  context.testing.handlers = handlers;
  const source = fs.readFileSync(mainPath, 'utf8'), start = source.indexOf("  handler('detail:close'"), end = source.indexOf('  // Retire write endpoints', start);
  vm.runInContext('handler = (name, callback) => { testing.handlers[name] = callback; };', context);
  vm.runInContext(source.slice(start, end), context);
  handlers['detail:close']();
  assert.equal(vm.runInContext('strategySymbols()', context).includes('sh600519'), false, '离开详情释放临时订阅');
});

test('详情即时行情不恢复已关闭订阅、不覆盖较新报价或写入重置后的账户', async () => {
  const mainPath = path.join(__dirname, '../main.cjs'), localRequire = createRequire(mainPath);
  const testing = { engine: new Engine(initialState()), release: null };
  testing.market = { quotes: () => new Promise(resolve => { testing.release = resolve; }) };
  const context = vm.createContext({ testing, structuredClone, process: { argv: [] }, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'electron' ? { app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) } } : localRequire(name) });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context);
  vm.runInContext('engine = testing.engine; market = testing.market; publish = () => {};', context);
  for (const scenario of ['closed', 'newer', 'reset', 'current']) {
    vm.runInContext("previewSymbol = 'sh600519'; quotes = {};", context);
    const pending = vm.runInContext("refreshPreviewQuote('sh600519')", context);
    if (scenario === 'closed') vm.runInContext('previewSymbol = null', context);
    if (scenario === 'newer') vm.runInContext("quotes.sh600519 = { timestamp: 200, price: 20 }", context);
    if (scenario === 'reset') testing.engine.s.agency.epoch += '-reset';
    testing.release({ sh600519: { symbol: 'sh600519', timestamp: 100, price: 10 } });
    if (scenario === 'reset') await assert.rejects(pending, /重置/); else await pending;
    const value = vm.runInContext('quotes.sh600519', context);
    if (['closed', 'reset'].includes(scenario)) assert.equal(value, undefined);
    else assert.equal(value.price, scenario === 'newer' ? 20 : 10);
  }
});
