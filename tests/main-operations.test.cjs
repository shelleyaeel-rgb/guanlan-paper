'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const mainPath = path.join(__dirname, '../main.cjs'), source = fs.readFileSync(mainPath, 'utf8'), localRequire = createRequire(mainPath);
const NOW = new Date('2026-10-16T10:00:00+08:00');
const quote = { symbol: 'sz000001', name: '隔离操作测试', price: 10, open: 10, volume: 100000,
  bid: 9.99, ask: 10.01, bidSize: 10000, askSize: 10000, limitUp: 11, limitDown: 9,
  timestamp: +NOW, date: '2026-10-16' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-operations-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('guanlan-operations-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const engine = new Engine(initialState(), () => NOW); engine.s.watchlist = [];
  const store = new Store(directory); store.save(engine.s);
  const handlers = {}, webContents = { mainFrame: {}, send() { throw Error('isolated renderer failed'); } };
  const testing = { engine, quote, saveError: false, quoteCalls: [],
    store: { warning: '', save(s) { if (testing.saveError) throw Error('isolated disk failure'); store.save(s); }, backup: s => store.backup(s) },
    market: { async quotes(symbols) { testing.quoteCalls.push(symbols); return { [quote.symbol]: quote }; } },
    monitor: { snapshots: {}, async load() { return {}; } }, research: { assertNoticeCurrent() {} },
    win: { webContents, isDestroyed: () => false } };
  const context = vm.createContext({ testing, structuredClone, process: { argv: [] }, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'electron' ? { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
      app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }), getPath: () => directory } } : localRequire(name) });
  vm.runInContext(source, context, { filename: mainPath });
  vm.runInContext('engine = testing.engine; store = testing.store; market = testing.market; monitor = testing.monitor; research = testing.research; win = testing.win;', context);
  for (const [start, end] of [["  handler('operation:status'", "  handler('agency:configure'"], ["  handler('watch:add'", "  handler('strategy:select'"], ["  handler('reset'", "  handler('backup'"]]) {
    const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); vm.runInContext(source.slice(a, b), context);
  }
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { engine, store, testing, context,
    input: (extra = {}) => ({ symbol: quote.symbol, side: 'buy', quantity: 100, requestId: 'stable-request', accountCreatedAt: engine.s.createdAt, ...extra }),
    call: (channel, input) => handlers[channel](event, input),
    reload() { testing.engine = new Engine(store.load(), () => NOW); vm.runInContext('engine = testing.engine;', context); return testing.engine; } };
}
function holdQuotes(testing) {
  let release, arrive;
  const started = new Promise(resolve => { arrive = resolve; });
  testing.market.quotes = async symbols => { testing.quoteCalls.push(symbols); arrive(); await new Promise(resolve => { release = resolve; }); return { [quote.symbol]: quote }; };
  return { started, release: () => release() };
}
test('真实 IPC 的成交、委托、划拨广播失败仍成功，重启重试只落一笔流水', async t => {
  for (const channel of ['trade', 'order', 'agency:transfer']) await t.test(channel, async t => {
    const f = fixture(t), input = f.input(channel === 'order' ? { limit: 10 } : channel === 'agency:transfer' ? { strategyId: 'swing', amount: 1000 } : {});
    const result = await f.call(channel, input); assert.equal(result.ok, true, result.error);
    const committed = structuredClone(f.engine.s); assert.equal(validState(committed), true);
    f.reload(); f.testing.market.quotes = () => { throw Error('replay must not fetch quotes'); };
    const replay = await f.call(channel, input); assert.equal(replay.ok, true); assert.equal(replay.data.id, result.data.id);
    assert.deepEqual(f.store.load(), committed);
    const status = await f.call('operation:status', { channel, request: input }); assert.equal(status.data.status, 'committed');
    assert.equal((await f.call(channel, { ...input, quantity: 200 })).ok, false);
    assert.deepEqual(f.store.load(), committed);
  });
});
test('同编号并发请求合并，异内容拒绝；未完成请求可查询', async t => {
  const f = fixture(t), hold = holdQuotes(f.testing), input = f.input();
  const a = f.call('trade', input); await hold.started;
  const b = f.call('trade', input);
  assert.equal((await f.call('operation:status', { channel: 'trade', request: input })).data.status, 'pending');
  assert.equal((await f.call('trade', { ...input, quantity: 200 })).ok, false);
  hold.release(); const results = await Promise.all([a, b]);
  assert.equal(results[0].ok, true); assert.equal(results[1].data.id, results[0].data.id);
  assert.equal(f.engine.s.trades.length, 1); assert.equal(f.testing.quoteCalls.length, 1);
});
test('重置阻止等待报价的手动交易、策略买入和自选写入新账户', async t => {
  for (const channel of ['trade', 'strategy:buy', 'watch:add']) await t.test(channel, async t => {
    const f = fixture(t), hold = holdQuotes(f.testing);
    const input = channel === 'watch:add' ? quote.symbol : f.input({ strategyId: 'swing', expected: { strategyId: 'swing' } });
    const request = f.call(channel, input); await hold.started;
    assert.equal((await f.call('reset', { confirm: '重置', capital: 50000 })).ok, true);
    const clean = structuredClone(f.engine.s); hold.release();
    const result = await request; assert.equal(result.ok, false); assert.match(result.error, /重置/);
    assert.deepEqual(f.engine.s, clean); assert.deepEqual(f.store.load(), clean);
  });
});
test('保存失败回滚交易与请求回执，查询未落盘，重启后同请求只执行一次', async t => {
  const f = fixture(t), input = f.input(), before = structuredClone(f.engine.s);
  f.testing.saveError = true; const result = await f.call('trade', input);
  assert.equal(result.ok, false); assert.match(result.error, /保存失败/); assert.deepEqual(f.engine.s, before);
  assert.equal((await f.call('operation:status', { channel: 'trade', request: input })).data.status, 'absent');
  f.testing.saveError = false; f.reload(); vm.runInContext("fatal = '';", f.context);
  assert.equal((await f.call('trade', input)).ok, true); assert.equal((await f.call('trade', input)).ok, true);
  assert.equal(f.store.load().trades.length, 1);
});
test('连续重置及系统时钟回拨不复用旧账户身份', async t => {
  const f = fixture(t), input = f.input();
  f.engine.s.createdAt = '2099-10-16T00:00:00.000Z'; input.accountCreatedAt = f.engine.s.createdAt;
  for (let n = 1; n <= 3; n++) {
    assert.equal((await f.call('reset', { confirm: '重置', capital: 50000 })).ok, true);
    assert.equal(Date.parse(f.engine.s.createdAt), Date.parse(input.accountCreatedAt) + n);
    assert.equal((await f.call('trade', input)).ok, false);
  }
});
test('买入 IPC 获取所有持仓与目标报价；拒绝缺失编号及旧账户意图', async t => {
  const f = fixture(t);
  f.engine.execute({ symbol: quote.symbol, side: 'buy', quantity: 100 }, quote);
  const input = f.input({ symbol: 'sh600000' });
  await f.call('trade', input);
  assert.deepEqual(Array.from(f.testing.quoteCalls[0]).sort(), ['sh600000', 'sz000001']);
  const before = structuredClone(f.engine.s);
  for (const extra of [{ requestId: '' }, { accountCreatedAt: 'old' }]) assert.equal((await f.call('trade', f.input(extra))).ok, false);
  assert.deepEqual(f.engine.s, before);
});
test('重复或非法持久化回执使账户校验失败，旧账户无需回执仍兼容', async t => {
  const f = fixture(t); assert.equal(validState(f.engine.s), true);
  await f.call('trade', f.input()); const state = structuredClone(f.engine.s); assert.equal(validState(state), true);
  state.trades[0].clientRequest.channel = 'order'; assert.equal(validState(state), false);
  state.trades[0].clientRequest.channel = 'trade'; state.trades[0].clientRequest.accountCreatedAt = 'old'; assert.equal(validState(state), false);
  const malformed = structuredClone(f.engine.s); malformed.agency.transfers = {}; assert.equal(validState(malformed), false);
  const duplicate = structuredClone(f.engine.s); duplicate.trades.push(structuredClone(duplicate.trades[0])); assert.equal(validState(duplicate), false);
  const nullRecord = structuredClone(f.engine.s); nullRecord.trades.push(null); assert.equal(validState(nullRecord), false);
});
