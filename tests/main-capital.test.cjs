'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { Engine, initialState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const mainPath = path.join(__dirname, '../main.cjs'), source = fs.readFileSync(mainPath, 'utf8'), localRequire = createRequire(mainPath);
const NOW = new Date('2026-10-16T10:00:00+08:00');
const quote = { symbol: 'sz000001', name: '隔离追加本金测试', price: 10, open: 10, volume: 100000,
  bid: 9.99, ask: 10.01, bidSize: 10000, askSize: 10000, limitUp: 11, limitDown: 9,
  timestamp: +NOW, date: '2026-10-16' };

function fixture(t, { holding = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-capital-ipc-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('guanlan-capital-ipc-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const account = initialState(); account.equity[0].time = +NOW - 86400000;
  const engine = new Engine(account, () => NOW);
  if (holding) engine.execute({ symbol: quote.symbol, side: 'buy', quantity: 1000 }, quote);
  engine.s.watchlist = [];
  const store = new Store(directory); store.save(engine.s);
  const webContents = { mainFrame: {}, send() { testing.publishes++; if (testing.publishError) throw testing.publishError; } }, handlers = {};
  const testing = { engine, quotes: { [quote.symbol]: quote }, saveError: null, saves: 0, invalidations: 0,
    publishEnabled: false, publishError: null, publishes: 0,
    win: { webContents, isDestroyed: () => !testing.publishEnabled },
    store: { warning: '', save(value) { testing.saves++; if (testing.saveError) throw testing.saveError; store.save(value); } },
    agency: { invalidate() { testing.invalidations++; }, publicState: () => ({}) }, monitor: { snapshots: {} } };
  const context = vm.createContext({ testing, structuredClone, process: { argv: [] }, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'electron' ? { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
      app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }), getPath: () => directory } } : localRequire(name) });
  vm.runInContext(source, context, { filename: mainPath });
  vm.runInContext('engine = testing.engine; store = testing.store; quotes = testing.quotes; win = testing.win; agency = testing.agency; monitor = testing.monitor;', context);
  const start = source.indexOf("  handler('capital:add'"), end = source.indexOf("  handler('reset'", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { testing, store, engine, event,
    input: (extra = {}) => ({ amount: 12345.67, requestId: 'stable-capital-request', accountCreatedAt: engine.s.createdAt, ...extra }),
    add: (input, sender = event) => handlers['capital:add'](sender, input),
    state: () => vm.runInContext('state()', context),
    reload() { testing.engine = new Engine(store.load(), () => NOW); vm.runInContext('engine = testing.engine;', context); } };
}

test('追加本金 IPC 保存独立流水，保留本金、持仓、成交和策略划拨，重启重试仅入账一次', async t => {
  const f = fixture(t, { holding: true });
  f.engine.agencyTransfer({ strategyId: 'swing', amount: 100000 });
  const before = structuredClone(f.engine.s), stats = f.engine.stats(f.testing.quotes), input = f.input();
  const response = await f.add(input);
  assert.equal(response.ok, true);
  assert.equal(response.data.amount, 1234567);
  assert.equal(f.engine.s.cash, before.cash + 1234567);
  assert.equal(f.engine.s.agency.manualCash, before.agency.manualCash + 1234567);
  assert.equal(f.engine.s.initialCash, before.initialCash);
  for (const key of ['lots', 'trades', 'orders']) assert.deepEqual(f.engine.s[key], before[key]);
  assert.deepEqual(f.engine.s.agency.transfers, before.agency.transfers);
  assert.equal(f.engine.stats().pnl, stats.pnl);
  const committed = structuredClone(f.engine.s);
  assert.equal((await f.add(input)).data.id, response.data.id);
  assert.deepEqual(f.engine.s, committed);
  f.reload();
  assert.equal((await f.add(input)).data.id, response.data.id);
  assert.deepEqual(f.testing.engine.s, committed);
  assert.equal(f.store.load().capitalFlows.length, 1);
});

test('追加本金 IPC 拒绝无效金额、缺失请求编号和已更换账户，拒绝不落盘', async t => {
  const f = fixture(t), before = structuredClone(f.engine.s);
  for (const input of [f.input({ amount: 0 }), f.input({ amount: 0.001 }), f.input({ amount: 100000001 }),
    f.input({ requestId: '' }), f.input({ accountCreatedAt: 'old-account' }), f.input({ accountCreatedAt: undefined }), undefined]) {
    assert.equal((await f.add(input)).ok, false);
    assert.deepEqual(f.engine.s, before);
  }
  assert.equal(f.testing.saves, 0);
  await f.add(f.input());
  const committed = structuredClone(f.engine.s);
  const mismatch = await f.add(f.input({ amount: 1 }));
  assert.equal(mismatch.ok, false); assert.match(mismatch.error, /不同金额/);
  assert.deepEqual(f.engine.s, committed); assert.equal(f.testing.saves, 1);
});

test('过期持仓报价不允许追加；刷新报价后同一请求成功，已入账重试不再要求新估值', async t => {
  const f = fixture(t, { holding: true }), before = structuredClone(f.engine.s), input = f.input();
  f.testing.quotes[quote.symbol] = { ...quote, timestamp: +NOW - 100000 };
  const stale = await f.add(input);
  assert.equal(stale.ok, false); assert.match(stale.error, /估值已过期/);
  assert.deepEqual(f.engine.s, before); assert.equal(f.testing.saves, 0);
  f.testing.quotes[quote.symbol] = quote;
  assert.equal((await f.add(input)).ok, true);
  f.testing.quotes[quote.symbol] = { ...quote, timestamp: +NOW - 100000 };
  assert.equal((await f.add(input)).ok, true);
  assert.equal(f.engine.s.capitalFlows.length, 1);
});

test('追加保存失败回滚账本并暂停，恢复磁盘后不会绕过账户暂停继续追加', async t => {
  const f = fixture(t), before = structuredClone(f.engine.s), disk = f.store.load();
  f.testing.saveError = Error('isolated disk failure');
  const result = await f.add(f.input());
  assert.equal(result.ok, false); assert.match(result.error, /账户保存失败，交易已暂停/);
  assert.deepEqual(f.engine.s, before); assert.deepEqual(f.store.load(), disk);
  assert.equal(f.state().accountPaused, true); assert.equal(f.testing.invalidations, 1);
  f.testing.saveError = null;
  assert.equal((await f.add(f.input())).error, result.error);
  assert.equal(f.testing.saves, 1); assert.deepEqual(f.engine.s, before);
});

test('追加已保存后广播失败仍返回成功，同一请求重试不会重复入账', async t => {
  const f = fixture(t), input = f.input(), beforeCash = f.engine.s.cash;
  f.testing.publishEnabled = true;
  f.testing.publishError = Error('isolated view broadcast failure');
  const result = await f.add(input);
  assert.equal(result.ok, true); assert.equal(result.data.amount, 1234567);
  assert.equal(f.testing.publishes, 1);
  assert.equal(f.store.load().cash, beforeCash + 1234567);
  assert.equal(f.store.load().capitalFlows.length, 1);
  assert.equal(f.state().accountPaused, false);
  const committed = structuredClone(f.store.load());
  const retry = await f.add(input);
  assert.equal(retry.ok, true); assert.equal(retry.data.id, result.data.id);
  assert.equal(f.testing.publishes, 2);
  assert.deepEqual(f.store.load(), committed);
  assert.deepEqual(f.engine.s, committed);
});

test('追加本金 IPC 仍只接受本窗口主框架', async t => {
  const f = fixture(t);
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: {} }]) {
    const result = await f.add(f.input(), event);
    assert.equal(result.ok, false); assert.match(result.error, /无效窗口来源/);
  }
  assert.equal(f.testing.saves, 0);
});

test('预加载白名单允许追加本金，保留未知操作阻断', async () => {
  let bridge, invoked;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_, value) => { bridge = value; } },
      ipcRenderer: { invoke: (name, input) => { invoked = { name, input }; return Promise.resolve({ ok: true }); } } })
  });
  const input = { amount: 100, requestId: 'bridge-request' };
  assert.equal((await bridge.call('capital:add', input)).ok, true);
  assert.deepEqual(invoked, { name: 'capital:add', input });
  await assert.rejects(bridge.call('untrusted:operation'), /未知操作/);
});
