const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { Engine, initialState } = require('../core/engine.cjs');

function fixture({ saveError = null, tickError = null } = {}) {
  const mainPath = path.join(__dirname, '../main.cjs'), localRequire = createRequire(mainPath);
  const account = new Engine(initialState()).s;
  account.watchlist = ['sh600519']; // Legacy field must not drive background work.
  const calls = { quotes: 0, ticks: 0, saves: 0, invalidations: 0 };
  const testing = {
    saveError, tickError, quoteError: null, quoteWait: null,
    engine: {
      s: account,
      tick(batch) {
        calls.ticks++;
        this.s.cash -= 100;
        this.s.marks.sh600519 = structuredClone(batch.sh600519);
        this.s.orders.push({ id: `test-${calls.ticks}`, symbol: 'sh600519', status: 'cancelled' });
        if (testing.tickError) throw testing.tickError;
      },
      stats: () => ({}), agencyState: () => ({ groups: [] }), selectedStrategy: () => 'swing'
    },
    market: { quotes: async () => {
      calls.quotes++;
      if (testing.quoteWait) await testing.quoteWait;
      if (testing.quoteError) throw testing.quoteError;
      return { sh600519: { symbol: 'sh600519', price: 100 + calls.quotes, source: 'isolated-test' } };
    } },
    monitor: { snapshots: {}, scan: async () => {} },
    agency: { publicState: () => ({}), poll: async () => {}, sampleEntries: async () => {}, prepareEntries: async () => {},
      invalidate: () => { calls.invalidations++; } },
    store: { warning: '', save: () => { calls.saves++; if (testing.saveError) throw testing.saveError; } }
  };
  const context = vm.createContext({ testing, structuredClone, process: { argv: [] }, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'electron' ? { app: { requestSingleInstanceLock: () => true, on: () => {}, whenReady: () => ({ then: () => {} }), getPath: () => 'isolated-memory' } }
      : name === './core/strategy.cjs' ? { ...localRequire(name), evaluateEntry: () => ({ buyable: true, status: '规则通过 · 可模拟', reasons: [] }) } : localRequire(name) });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context, { filename: mainPath });
  vm.runInContext("engine = testing.engine; market = testing.market; monitor = testing.monitor; agency = testing.agency; store = testing.store; previewSymbol = 'sh600519';", context);
  return { testing, calls, refresh: () => vm.runInContext('refresh()', context),
    transaction: fn => { testing.transactionBody = fn; return vm.runInContext('transaction(testing.transactionBody)', context); } };
}

test('正常行情刷新提交账户变化，继续执行后续刷新', async () => {
  const f = fixture(), cash = f.testing.engine.s.cash;
  for (let index = 1; index <= 2; index++) {
    const snapshot = await f.refresh();
    assert.equal(snapshot.warning, '');
    assert.equal(snapshot.connection.ok, true);
    assert.equal(snapshot.quotes.sh600519.price, 100 + index);
    assert.equal(snapshot.signals.sh600519.buyable, false);
    assert.match(snapshot.signals.sh600519.status, /只读分析/);
    assert.equal(f.testing.engine.s.cash, cash - 100 * index);
  }
  assert.deepEqual(f.calls, { quotes: 2, ticks: 2, saves: 2, invalidations: 0 });
});

test('一次保存失败回滚账户，后续刷新保留首个原因且不再 tick 或保存', async () => {
  const message = "EPERM: operation not permitted, rename 'account.json.tmp' -> 'account.json'";
  const f = fixture({ saveError: Error(message) }), before = structuredClone(f.testing.engine.s);
  const warning = `账户保存失败，交易已暂停：${message}`;
  for (let index = 1; index <= 4; index++) {
    const snapshot = await f.refresh();
    assert.equal(snapshot.warning, warning);
    assert.equal(snapshot.connection.ok, true);
    assert.equal(snapshot.quotes.sh600519.price, 100 + index);
    assert.equal(snapshot.signals.sh600519.buyable, false);
    assert.equal(snapshot.signals.sh600519.status, '交易已暂停');
    assert.deepEqual(f.testing.engine.s, before);
    // Even if the filesystem becomes writable, refreshing must not resume trading.
    f.testing.saveError = null;
  }
  assert.deepEqual(f.calls, { quotes: 4, ticks: 1, saves: 1, invalidations: 1 });
  let ran = false;
  assert.throws(() => f.transaction(() => { ran = true; }), error => error.message === warning);
  assert.equal(ran, false);
});

test('tick 业务异常回滚并暂停，不误报为账户保存失败', async () => {
  const f = fixture({ tickError: Error('账户计算校验失败') }), before = structuredClone(f.testing.engine.s);
  for (let index = 0; index < 3; index++) {
    const snapshot = await f.refresh();
    assert.equal(snapshot.warning, '交易处理失败，交易已暂停：账户计算校验失败');
    assert.equal(snapshot.connection.ok, true);
    assert.deepEqual(f.testing.engine.s, before);
    f.testing.tickError = null;
  }
  assert.deepEqual(f.calls, { quotes: 3, ticks: 1, saves: 0, invalidations: 1 });
});

test('等待行情时后台事务保存失败，刷新完成后保留后台原始错误且不执行 tick', async () => {
  const f = fixture({ saveError: Error('后台保存 EPERM') }), before = structuredClone(f.testing.engine.s);
  let releaseQuotes;
  f.testing.quoteWait = new Promise(resolve => { releaseQuotes = resolve; });
  const pending = f.refresh();
  const warning = '账户保存失败，交易已暂停：后台保存 EPERM';
  assert.throws(() => f.transaction(() => { f.testing.engine.s.cash -= 500; }), error => error.message === warning);
  f.testing.saveError = null;
  releaseQuotes();
  const first = await pending;
  assert.equal(first.warning, warning);
  assert.equal(first.connection.ok, true);
  assert.deepEqual(f.testing.engine.s, before);
  for (let index = 0; index < 2; index++) assert.equal((await f.refresh()).warning, warning);
  assert.deepEqual(f.calls, { quotes: 3, ticks: 0, saves: 1, invalidations: 1 });
});

test('暂停后的行情断线和恢复均不覆盖保存错误或恢复账户执行', async () => {
  const f = fixture({ saveError: Error('账户重命名失败') });
  const first = await f.refresh();
  f.testing.saveError = null;
  f.testing.quoteError = Error('测试行情断线');
  const offline = await f.refresh();
  assert.equal(offline.warning, first.warning);
  assert.equal(offline.connection.ok, false);
  assert.equal(offline.connection.message, '行情连接失败：测试行情断线');
  f.testing.quoteError = null;
  const online = await f.refresh();
  assert.equal(online.warning, first.warning);
  assert.equal(online.connection.ok, true);
  assert.deepEqual(f.calls, { quotes: 3, ticks: 1, saves: 1, invalidations: 1 });
});
