'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { Engine, initialState } = require('../core/engine.cjs');
const { Research } = require('../core/research.cjs');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const mainPath = path.join(__dirname, '../main.cjs'), mainSource = fs.readFileSync(mainPath, 'utf8'), localRequire = createRequire(mainPath);
const START = Date.parse('2026-10-16T10:00:00+08:00'), symbol = 'sz000001';
const notice = title => ({ id: 'AN20261016000001', date: '2026-10-16', title, categories: [] });
const input = { symbol, strategyId: 'swing', expected: { strategyId: 'swing' } };

// Execute the production state/transaction functions and strategy:buy handler
// in memory. Only the market, Electron host and final trade are test doubles.
async function host(items = []) {
  let now = START, data = { items, total: items.length }, failure = '';
  const calls = { entries: 0, saves: 0, research: 0, history: 0, quotes: [] }, handlers = {};
  const research = new Research(() => { throw Error('不允许网络'); }, { clock: () => now });
  research.fetchSection = async () => { calls.research++; if (failure) throw Error(failure); return structuredClone(data); };
  const snapshot = { technical: { close: 10 }, fetchedAt: now, notices: await research.get({ symbol, section: 'notices', force: true }) };
  calls.research = 0;
  const engine = new Engine(initialState(), () => new Date(now)); engine.s.watchlist = [symbol];
  engine.strategyEntry = () => { calls.entries++; const trade = { id: 'isolated-entry', symbol }; engine.s.trades.push(trade); return trade; };
  const testing = { engine, research, snapshot, handlers, calls, beforeClone: null,
    store: { warning: '', save() { calls.saves++; } },
    market: { async quotes(symbols) { calls.quotes.push(symbols); return { [symbol]: { symbol, price: 10, timestamp: now } }; },
      async strategyHistory() { calls.history++; throw Error('开仓不允许加载日线'); } } };
  testing.monitor = new StrategyMonitor(testing.market, () => new Date(now), () => {}, research);
  testing.monitor.snapshots[symbol] = snapshot;
  const context = vm.createContext({ testing, process: { argv: [] }, setTimeout, clearTimeout, setInterval, clearInterval,
    structuredClone(value) { testing.beforeClone?.(); return structuredClone(value); },
    require: name => name === 'electron' ? { app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }), getPath: () => 'isolated-memory' } }
      : name === './core/strategy.cjs' ? { ...localRequire(name), evaluateEntry: () => ({ buyable: true, quantity: 100, economics: { gross: 1000 }, status: '规则通过 · 可模拟', reasons: [] }) }
        : localRequire(name) });
  vm.runInContext(mainSource, context, { filename: mainPath });
  vm.runInContext('engine = testing.engine; research = testing.research; monitor = testing.monitor; market = testing.market; store = testing.store; connection = { ok: true }; previewSymbol = "sz000001"; handler = (name, callback) => { testing.handlers[name] = callback; };', context);
  const start = mainSource.indexOf("  // Retire write endpoints"), end = mainSource.indexOf("  operationHandler('legacy:exit'", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(mainSource.slice(start, end), context, { filename: 'main.cjs:strategy-buy' });
  return { testing, engine, research, snapshot, calls,
    buy: () => handlers['strategy:buy']({ ...input, requestId: 'notice-buy', accountCreatedAt: engine.s.createdAt }),
    signal: () => vm.runInContext('state().signals["sz000001"]', context),
    advance: milliseconds => { now += milliseconds; },
    async refresh(nextItems = data.items, error = '') {
      now += 1000; data = { items: nextItems, total: nextItems.length }; failure = error;
      return research.get({ symbol, section: 'notices', force: true });
    } };
}

test('人工策略买入即使资料已准备仍拒绝，零取数和账务写入', async () => {
  const h = await host(), before = structuredClone(h.engine.s);
  assert.throws(h.buy, /人工操作已移除/);
  assert.deepEqual(h.engine.s, before);
  assert.equal(h.calls.entries, 0); assert.equal(h.calls.saves, 0);
  assert.equal(h.calls.history, 0); assert.equal(h.calls.research, 0); assert.equal(h.calls.quotes.length, 0);
});

test('详情始终只读，公告变化和失败不恢复已停用的自动研究门槛', async t => {
  for (const scenario of [
    { name: '内容变化', items: [notice('新公告')], error: '' },
    { name: '最新查新失败', items: [], error: '资料服务暂不可用' }
  ]) await t.test(scenario.name, async () => {
    const h = await host(); assert.equal(h.signal().buyable, false);
    await h.refresh(scenario.items, scenario.error);
    const signal = h.signal();
    assert.equal(signal.buyable, false); assert.equal(signal.quantity, 0); assert.equal(signal.economics, null);
    assert.match(signal.status, /只读分析/); assert.equal(signal.reasons.some(reason => /公告|失效/.test(reason)), false);
    assert.equal(h.calls.entries, 0); assert.equal(h.calls.saves, 0);
  });
  const unchanged = await host([notice('原公告')]); await unchanged.refresh();
  assert.equal(unchanged.signal().buyable, false); assert.equal(unchanged.signal().quantity, 0);
  assert.match(unchanged.signal().status, /只读分析/);
});
