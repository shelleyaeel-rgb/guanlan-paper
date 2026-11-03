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
  const prior = new Date('2026-10-15T10:00:00+08:00');
  const engine = new Engine(initialState(), () => prior);
  engine.execute({ symbol: quote.symbol, side: 'buy', quantity: 100 }, { ...quote, timestamp: +prior, date: '2026-10-15' });
  engine.clock = () => NOW;
  const store = new Store(directory); store.save(engine.s);
  const handlers = {}, webContents = { mainFrame: {}, send() { throw Error('isolated renderer failed'); } };
  const testing = { engine, quote, saveError: false, quoteCalls: [],
    store: { warning: '', save(s) { if (testing.saveError) throw Error('isolated disk failure'); store.save(s); }, backup: s => store.backup(s) },
    market: { async quotes(symbols) { testing.quoteCalls.push(symbols); return { [quote.symbol]: quote }; } },
    monitor: { snapshots: {}, readPrepared() { return {}; }, assertPrepared() {} }, research: { assertNoticeCurrent() {} },
    win: { webContents, isDestroyed: () => false } };
  const context = vm.createContext({ testing, structuredClone, process: { argv: [] }, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'electron' ? { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
      app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }), getPath: () => directory } } : localRequire(name) });
  vm.runInContext(source, context, { filename: mainPath });
  vm.runInContext('engine = testing.engine; store = testing.store; market = testing.market; monitor = testing.monitor; research = testing.research; win = testing.win;', context);
  for (const [start, end] of [["  handler('operation:status'", "  handler('agency:configure'"], ["  // Retire write endpoints", "  handler('strategy:settings'"], ["  handler('agency:member'", "  handler('agency:reconcile'"], ["  handler('reset'", "  handler('backup'"]]) {
    const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); vm.runInContext(source.slice(a, b), context);
  }
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { engine, store, testing, context,
    input: (extra = {}) => ({ symbol: quote.symbol, requestId: 'stable-request', accountCreatedAt: engine.s.createdAt, ...extra }),
    call: (channel, input) => handlers[channel](event, input),
    reload() { testing.engine = new Engine(store.load(), () => NOW); vm.runInContext('engine = testing.engine;', context); return testing.engine; } };
}
function holdQuotes(testing) {
  let release, arrive;
  const started = new Promise(resolve => { arrive = resolve; });
  testing.market.quotes = async symbols => { testing.quoteCalls.push(symbols); arrive(); await new Promise(resolve => { release = resolve; }); return { [quote.symbol]: quote }; };
  return { started, release: () => release() };
}
test('真实 IPC 的历史持仓退出与划拨广播失败仍成功，重启重试只落一笔流水', async t => {
  for (const channel of ['legacy:exit', 'agency:transfer']) await t.test(channel, async t => {
    const f = fixture(t), input = f.input(channel === 'agency:transfer' ? { strategyId: 'swing', amount: 1000 } : {});
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
  const a = f.call('legacy:exit', input); await hold.started;
  const b = f.call('legacy:exit', input);
  assert.equal((await f.call('operation:status', { channel: 'legacy:exit', request: input })).data.status, 'pending');
  assert.equal((await f.call('legacy:exit', { ...input, quantity: 200 })).ok, false);
  hold.release(); const results = await Promise.all([a, b]);
  assert.equal(results[0].ok, true); assert.equal(results[1].data.id, results[0].data.id);
  assert.equal(f.engine.s.trades.length, 2); assert.equal(f.testing.quoteCalls.length, 1);
});
test('重置阻止等待报价的历史持仓退出写入新账户', async t => {
  for (const channel of ['legacy:exit']) await t.test(channel, async t => {
    const f = fixture(t), hold = holdQuotes(f.testing);
    const input = f.input();
    const request = f.call(channel, input); await hold.started;
    assert.equal((await f.call('reset', { confirm: '重置', capital: 50000 })).ok, true);
    const clean = structuredClone(f.engine.s); hold.release();
    const result = await request; assert.equal(result.ok, false); assert.match(result.error, /重置/);
    assert.deepEqual(f.engine.s, clean); assert.deepEqual(f.store.load(), clean);
  });
});
test('保存失败回滚交易与请求回执，查询未落盘，重启后同请求只执行一次', async t => {
  const f = fixture(t), input = f.input(), before = structuredClone(f.engine.s);
  f.testing.saveError = true; const result = await f.call('legacy:exit', input);
  assert.equal(result.ok, false); assert.match(result.error, /保存失败/); assert.deepEqual(f.engine.s, before);
  assert.equal((await f.call('operation:status', { channel: 'legacy:exit', request: input })).data.status, 'absent');
  f.testing.saveError = false; f.reload(); vm.runInContext("fatal = '';", f.context);
  assert.equal((await f.call('legacy:exit', input)).ok, true); assert.equal((await f.call('legacy:exit', input)).ok, true);
  assert.equal(f.store.load().trades.length, 2);
});
test('连续重置及系统时钟回拨不复用旧账户身份', async t => {
  const f = fixture(t), input = f.input();
  f.engine.s.createdAt = '2099-10-16T00:00:00.000Z'; input.accountCreatedAt = f.engine.s.createdAt;
  for (let n = 1; n <= 3; n++) {
    assert.equal((await f.call('reset', { confirm: '重置', capital: 50000 })).ok, true);
    assert.equal(Date.parse(f.engine.s.createdAt), Date.parse(input.accountCreatedAt) + n);
    assert.equal((await f.call('legacy:exit', input)).ok, false);
  }
});
test('历史退出只获取目标报价；拒绝缺失编号及旧账户意图', async t => {
  const f = fixture(t);
  await f.call('legacy:exit', f.input());
  assert.deepEqual(Array.from(f.testing.quoteCalls[0]), ['sz000001']);
  const before = structuredClone(f.engine.s);
  for (const extra of [{ requestId: '' }, { accountCreatedAt: 'old' }]) assert.equal((await f.call('legacy:exit', f.input(extra))).ok, false);
  assert.deepEqual(f.engine.s, before);
});
test('重复或非法持久化回执使账户校验失败，旧账户无需回执仍兼容', async t => {
  const f = fixture(t); assert.equal(validState(f.engine.s), true);
  await f.call('legacy:exit', f.input()); const state = structuredClone(f.engine.s); assert.equal(validState(state), true);
  state.trades.at(-1).clientRequest.channel = 'order'; assert.equal(validState(state), false);
  state.trades.at(-1).clientRequest.channel = 'legacy:exit'; state.trades.at(-1).clientRequest.accountCreatedAt = 'old'; assert.equal(validState(state), false);
  const malformed = structuredClone(f.engine.s); malformed.agency.transfers = {}; assert.equal(validState(malformed), false);
  const duplicate = structuredClone(f.engine.s); duplicate.trades.push(structuredClone(duplicate.trades.at(-1))); assert.equal(validState(duplicate), false);
  const nullRecord = structuredClone(f.engine.s); nullRecord.trades.push(null); assert.equal(validState(nullRecord), false);
});

test('退役人工入口后端拒绝且不获取报价、不修改账户', async t => {
  const f = fixture(t), before = structuredClone(f.engine.s);
  for (const channel of ['watch:add', 'watch:remove', 'trade', 'order', 'strategy:buy', 'strategy:select', 'agency:members:add',
    'screener:parse', 'screener:run', 'screener:history', 'screener:status', 'screener:cancel', 'screener:open', 'risk']) {
    const result = await f.call(channel, f.input({ side: 'buy', quantity: 100, symbol: 'sh600000' }));
    assert.equal(result.ok, false, channel); assert.match(result.error, /人工操作已移除/);
  }
  const manualCandidate = await f.call('agency:member', { action: 'add', strategyId: 'swing', symbol: 'sh600000' });
  assert.equal(manualCandidate.ok, false); assert.match(manualCandidate.error, /人工指定/);
  assert.equal(f.testing.quoteCalls.length, 0); assert.deepEqual(f.engine.s, before); assert.deepEqual(f.store.load(), before);
});

test('preload仅暴露自动管理、只读详情和历史退出，不暴露退役人工入口', async () => {
  let bridge; const invoked = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (name, payload) => { invoked.push({ name, payload }); return { ok: true }; } } })
  });
  for (const channel of ['watch:add', 'watch:remove', 'trade', 'order', 'risk', 'strategy:buy', 'strategy:select', 'agency:members:add', 'screener:run', 'screener:open'])
    await assert.rejects(bridge.call(channel, {}), /未知操作/);
  assert.equal(invoked.length, 0);
  for (const channel of ['detail:close', 'legacy:exit', 'agency:pool:run', 'agency:member']) await bridge.call(channel, {});
  assert.deepEqual(invoked.map(item => item.name), ['detail:close', 'legacy:exit', 'agency:pool:run', 'agency:member']);
});
