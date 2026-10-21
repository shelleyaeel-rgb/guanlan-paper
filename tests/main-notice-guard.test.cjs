'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { Engine, initialState } = require('../core/engine.cjs');
const { Research } = require('../core/research.cjs');
const mainPath = path.join(__dirname, '../main.cjs'), mainSource = fs.readFileSync(mainPath, 'utf8'), localRequire = createRequire(mainPath);
const START = Date.parse('2026-10-16T10:00:00+08:00'), symbol = 'sz000001';
const notice = title => ({ id: 'AN20261016000001', date: '2026-10-16', title, categories: [] });
const input = { symbol, strategyId: 'swing', expected: { strategyId: 'swing' } };

// Execute the production state/transaction functions and strategy:buy handler
// in memory. Only the market, Electron host and final trade are test doubles.
async function host(items = []) {
  let now = START, data = { items, total: items.length }, failure = '';
  const research = new Research(() => { throw Error('不允许网络'); }, { clock: () => now });
  research.fetchSection = async () => { if (failure) throw Error(failure); return structuredClone(data); };
  const snapshot = { notices: await research.get({ symbol, section: 'notices', force: true }) };
  const engine = new Engine(initialState(), () => new Date(now)); engine.s.watchlist = [symbol];
  const calls = { entries: 0, saves: 0, loads: [] }, handlers = {};
  engine.strategyEntry = () => { calls.entries++; return { id: 'isolated-entry', symbol }; };
  const testing = { engine, research, snapshot, handlers, calls, beforeClone: null,
    store: { warning: '', save() { calls.saves++; } },
    monitor: { snapshots: { [symbol]: snapshot }, async load(...args) { calls.loads.push(args); return snapshot; } },
    market: { quotes: async () => ({ [symbol]: { symbol, price: 10, timestamp: now } }) } };
  const context = vm.createContext({ testing, process: { argv: [] }, setTimeout, clearTimeout, setInterval, clearInterval,
    structuredClone(value) { testing.beforeClone?.(); return structuredClone(value); },
    require: name => name === 'electron' ? { app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }), getPath: () => 'isolated-memory' } }
      : name === './core/strategy.cjs' ? { ...localRequire(name), evaluateEntry: () => ({ buyable: true, quantity: 100, economics: { gross: 1000 }, status: '规则通过 · 可模拟', reasons: [] }) }
        : localRequire(name) });
  vm.runInContext(mainSource, context, { filename: mainPath });
  vm.runInContext('engine = testing.engine; research = testing.research; monitor = testing.monitor; market = testing.market; store = testing.store; connection = { ok: true }; handler = (name, callback) => { testing.handlers[name] = callback; };', context);
  const start = mainSource.indexOf("  handler('strategy:buy'"), end = mainSource.indexOf("  handler('strategy:select'", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(mainSource.slice(start, end), context, { filename: 'main.cjs:strategy-buy' });
  return { testing, engine, research, snapshot, calls,
    buy: () => handlers['strategy:buy'](input),
    signal: () => vm.runInContext('state().signals["sz000001"]', context),
    async refresh(nextItems = data.items, error = '') {
      now += 1000; data = { items: nextItems, total: nextItems.length }; failure = error;
      return research.get({ symbol, section: 'notices', force: true });
    } };
}

function holdQuotes(testing) {
  let release, arrived;
  const started = new Promise(resolve => { arrived = resolve; });
  testing.market.quotes = async () => { arrived(); await new Promise(resolve => { release = resolve; }); return { [symbol]: { symbol, price: 10 } }; };
  return { started, release: () => release() };
}

test('策略买入IPC在等待行情期间出现新增、更正、撤回或查新失败时不进入交易与保存', async t => {
  for (const scenario of [
    { name: '新增', before: [], after: [notice('重大诉讼公告')] },
    { name: '更正', before: [notice('原公告')], after: [notice('更正公告')] },
    { name: '撤回', before: [notice('原公告')], after: [] },
    { name: '查新失败', before: [], after: [], error: '资料服务暂不可用' }
  ]) await t.test(scenario.name, async () => {
    const h = await host(scenario.before), before = structuredClone(h.engine.s), quote = holdQuotes(h.testing);
    const pending = h.buy(); await quote.started;
    await h.refresh(scenario.after, scenario.error); quote.release();
    await assert.rejects(pending, /公告目录已变化或最新查新失败/);
    assert.equal(h.calls.entries, 0); assert.equal(h.calls.saves, 0); assert.deepEqual(h.engine.s, before);
    assert.deepEqual(h.calls.loads[0], [symbol, true, false, true]);
  });
});

test('策略买入IPC允许等待行情期间成功刷新到相同公告内容', async () => {
  const h = await host([notice('原公告')]), quote = holdQuotes(h.testing), version = h.snapshot.notices.noticeVersion;
  const pending = h.buy(); await quote.started;
  const refreshed = await h.refresh(); assert.equal(refreshed.noticeVersion, version); quote.release();
  assert.equal((await pending).id, 'isolated-entry'); assert.equal(h.calls.entries, 1); assert.equal(h.calls.saves, 1);
});

test('策略买入IPC在事务内再次核对公告版本，入口检查后的变化也不会执行或保存', async () => {
  const h = await host(), before = structuredClone(h.engine.s);
  h.testing.beforeClone = () => {
    h.testing.beforeClone = null;
    h.research.observeNotices({ ...h.snapshot.notices, data: { items: [notice('新公告')], total: 1 }, status: 'ready' });
  };
  await assert.rejects(h.buy(), /公告目录已变化或最新查新失败/);
  assert.equal(h.calls.entries, 0); assert.equal(h.calls.saves, 0); assert.deepEqual(h.engine.s, before);
});

test('state清除过期公告依据的可买显示、数量和预计成本，相同内容刷新保留可买显示', async t => {
  for (const scenario of [
    { name: '内容变化', items: [notice('新公告')], error: '' },
    { name: '最新查新失败', items: [], error: '资料服务暂不可用' }
  ]) await t.test(scenario.name, async () => {
    const h = await host(); assert.equal(h.signal().buyable, true);
    await h.refresh(scenario.items, scenario.error);
    const signal = h.signal();
    assert.equal(signal.buyable, false); assert.equal(signal.quantity, 0); assert.equal(signal.economics, null);
    assert.equal(signal.status, '等待公告重新核验'); assert.match(signal.reasons[0], /失效/);
    assert.equal(h.calls.entries, 0); assert.equal(h.calls.saves, 0);
  });
  const unchanged = await host([notice('原公告')]); await unchanged.refresh();
  assert.equal(unchanged.signal().buyable, true); assert.equal(unchanged.signal().quantity, 100);
});
