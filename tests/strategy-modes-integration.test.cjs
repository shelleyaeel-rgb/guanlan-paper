const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { cnTime } = require('../core/common.cjs');
const { evaluateEntry } = require('../core/strategy.cjs');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');

const modes = ['ultra-short', 'short', 'swing', 'long'];
function fixture() {
  let now = new Date('2026-09-29T10:00:00+08:00');
  const engine = new Engine(initialState(100000), () => now);
  const quote = (overrides = {}) => ({ symbol: 'sz000001', name: '独立策略测试', price: 10.1, prevClose: 10.05, open: 10, low: 10, high: 10.2,
    volume: 100000, amount: 3e8, turnover: 4, bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000,
    limitUp: 11.05, limitDown: 9.05, timestamp: now.getTime(), date: cnTime(now).date, ...overrides });
  const snapshot = (overrides = {}) => {
    const level = { entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, support: 9.7, resistance: 11.5, breakout: false };
    const response = section => ({ symbol: 'sz000001', section, source: '东方财富', status: 'ready', fetchedAt: now.getTime(), checkedAt: now.getTime() });
    return {
      fetchedAt: now.getTime(), source: '测试未复权行情', technical: { asOf: '2026-09-28', close: 10.05, ma5: 10.02, previousMa5: 10.01, ma20: 10, previousMa20: 9.99,
        ma60: 9.5, previousMa60: 9.49, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1.5, trend: true, dates: ['2026-09-28'], ...level,
        levels: Object.fromEntries(modes.map(id => [id, { ...level }])), ...overrides },
      finance: { ...response('finance'), industryProfile: ordinaryProfile('sz000001', now), data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', updateDate: '2026-08-20', currency: 'CNY', roe: 12, debtRatio: 45,
        revenueYoY: 8, adjustedProfitYoY: 10, adjustedProfit: 1e8, operatingCash: 1e8 },
        annual: [{ reportDate: '2025-12-31', noticeDate: '2026-03-20', currency: 'CNY', roe: 12 }] } },
      valuation: { ...response('valuation'), data: { quoteTime: now.getTime(), pe: 15, pb: 2 } },
      notices: { ...response('notices'), status: 'empty', data: { items: [], total: 0 } }
    };
  };
  const buy = (strategyId, quantity = 100) => { engine.selectStrategy('000001', strategyId); return engine.strategyEntry({ symbol: '000001', strategyId, quantity }, quote(), snapshot()); };
  return { engine, quote, snapshot, buy, day: value => { now = new Date(value); } };
}

test('四种计划实际成交关联独立策略、含费预算与冻结配置，重启后保持', () => {
  for (const strategyId of modes) {
    const f = fixture(), signal = evaluateEntry(f.engine, 'sz000001', f.quote(), f.snapshot(), 100, strategyId);
    assert.equal(signal.buyable, true, strategyId + ': ' + signal.reasons.join('；'));
    const trade = f.buy(strategyId), risk = f.engine.s.risks.sz000001;
    assert.equal(trade.strategyPlan.strategyId, strategyId);
    assert.equal(risk.strategyId, strategyId); assert.ok(risk.strategyName);
    assert.equal(risk.entryTradeId, trade.id); assert.equal(risk.entryPrice, trade.price);
    assert.ok(trade.strategyPlan.economics.loss <= signal.budget);
    const original = structuredClone(risk);
    f.engine.s.strategySettings.riskPercent = 0.7;
    f.engine.selectStrategy('600519', strategyId === 'long' ? 'short' : 'long');
    assert.deepEqual(risk, original);
    assert.throws(() => f.engine.selectStrategy('000001', strategyId === 'swing' ? 'short' : 'swing'), /持仓|平仓|冻结/);
    const restored = new Engine(JSON.parse(JSON.stringify(f.engine.s)), f.engine.clock);
    assert.equal(restored.selectedStrategy('000001'), strategyId);
    assert.deepEqual(restored.s.risks.sz000001, original);
    if (strategyId === 'long') assert.equal(trade.strategyPlan.financeEvidence.finance.data.latest.reportDate, '2026-06-30');
  }
});

test('切换策略后拒绝原确认，错误策略标识不会改变现金与交易记录', () => {
  const f = fixture();
  f.engine.selectStrategy('000001', 'short');
  const short = evaluateEntry(f.engine, 'sz000001', f.quote(), f.snapshot(), 100, 'short');
  f.engine.selectStrategy('000001', 'ultra-short');
  const before = structuredClone(f.engine.s);
  assert.throws(() => f.engine.strategyEntry({ symbol: '000001', strategyId: 'short', quantity: 100, expected: short.plan }, f.quote(), f.snapshot()), /策略|变化/);
  assert.throws(() => f.engine.strategyEntry({ symbol: '000001', strategyId: 'ultra-short', quantity: 100, expected: short.plan }, f.quote(), f.snapshot()), /策略|变化/);
  assert.throws(() => f.engine.selectStrategy('000001', 'intraday-t0'), /策略/);
  assert.throws(() => f.engine.strategyEntry({ symbol: '000001', strategyId: 'intraday-t0', quantity: 100 }, f.quote(), f.snapshot()), /策略/);
  assert.deepEqual(f.engine.s, before);
});

test('原波段账户无新字段可恢复且继续按原计划卖出', () => {
  const f = fixture(); f.buy('swing');
  const legacy = JSON.parse(JSON.stringify(f.engine.s)), oldRisk = legacy.risks.sz000001;
  delete legacy.planSelections; delete oldRisk.strategyId; delete oldRisk.strategyName;
  oldRisk.strategy = 'swing-pullback-v1';
  delete legacy.trades[0].strategyPlan.strategyId; delete legacy.trades[0].strategyPlan.strategyName;
  const restored = new Engine(legacy, f.engine.clock);
  assert.equal(restored.selectedStrategy('000001'), 'swing');
  assert.equal(restored.s.risks.sz000001.stop, 9.6);
  f.day('2026-09-30T10:00:00+08:00');
  restored.tick({ sz000001: f.quote({ price: 9.5, bid: 9.49 }) }, { sz000001: { error: '日线服务断线' } });
  assert.equal(restored.positions().length, 0); assert.equal(restored.s.trades.at(-1).reason, '止损触发');
});

test('四种策略均受T+1和一档部分成交约束，锁存信号跨重启继续退出', () => {
  for (const strategyId of modes) {
    const f = fixture(); f.buy(strategyId, 300);
    f.engine.tick({ sz000001: f.quote({ price: 9.5, bid: 9.49, bidSize: 100 }) });
    assert.equal(f.engine.s.trades.length, 1); assert.match(f.engine.s.risks.sz000001.note, /T\+1/);
    const restored = new Engine(JSON.parse(JSON.stringify(f.engine.s)), f.engine.clock);
    f.day('2026-09-30T10:00:00+08:00');
    const first = f.quote({ price: 10.1, bidSize: 100 });
    restored.tick({ sz000001: first });
    assert.equal(restored.positions()[0].quantity, 200);
    assert.equal(restored.s.trades.at(-1).reason, '止损触发');
    assert.equal(restored.s.trades.at(-1).riskSnapshot.strategyId, strategyId);
    restored.tick({ sz000001: first }); assert.equal(restored.positions()[0].quantity, 200);
    restored.tick({ sz000001: f.quote({ timestamp: first.timestamp + 1000, bidSize: 200 }) });
    assert.equal(restored.positions().length, 0);
    assert.equal(restored.stats().pnl, restored.stats().realized);
  }
});

test('长线财报或估值失败不允许新建仓，原有止损在数据失败时仍可执行', () => {
  const failures = [s => { s.finance.status = 'stale'; }, s => { s.valuation.status = 'unavailable'; }, s => { s.finance.symbol = 'sh600519'; },
    s => { s.valuation.data.quoteTime -= 91000; }, s => { s.finance.data.latest.noticeDate = '2026-10-20'; }];
  for (const fail of failures) {
    const f = fixture(); f.engine.selectStrategy('000001', 'long');
    const broken = f.snapshot(); fail(broken); const before = structuredClone(f.engine.s);
    assert.equal(evaluateEntry(f.engine, 'sz000001', f.quote(), broken, 100, 'long').buyable, false);
    assert.throws(() => f.engine.strategyEntry({ symbol: '000001', strategyId: 'long', quantity: 100 }, f.quote(), broken));
    assert.deepEqual(f.engine.s, before);
  }
  const f = fixture(); f.buy('long'); f.day('2026-09-30T10:00:00+08:00');
  f.engine.tick({ sz000001: f.quote({ price: 9.5, bid: 9.49 }) }, { sz000001: { error: '断线', finance: { status: 'unavailable' }, valuation: { status: 'unavailable' } } });
  assert.equal(f.engine.positions().length, 0); assert.equal(f.engine.s.trades.at(-1).reason, '止损触发');
  assert.equal(f.engine.s.trades.at(-1).riskSnapshot.strategyId, 'long');
});

test('长线确认后财报关键值变化要求重新确认且不会先成交', () => {
  const f = fixture(); f.engine.selectStrategy('000001', 'long');
  const signal = evaluateEntry(f.engine, 'sz000001', f.quote(), f.snapshot(), 100, 'long');
  const next = f.snapshot(); next.finance.data.latest.roe = 13;
  const before = structuredClone(f.engine.s);
  assert.throws(() => f.engine.strategyEntry({ symbol: '000001', strategyId: 'long', quantity: 100, expected: signal.plan }, f.quote(), next), /变化|确认/);
  assert.deepEqual(f.engine.s, before);
});

test('策略后台监控仅按需载入财报，断线保留技术数据与明确失败响应', async () => {
  let historyCalls = 0; const researchCalls = [];
  const now = new Date('2026-09-29T10:00:00+08:00');
  const bars = Array.from({ length: 80 }, (_, i) => { const close = 9 + i * 0.01 + Math.sin(i / 2) * 0.1; return {
    date: new Date(Date.UTC(2026, 6, 11 + i)).toISOString().slice(0, 10), close, open: close - 0.02, high: close + 0.2, low: close - 0.2, volume: 100000
  }; });
  const research = { get: async input => { researchCalls.push(input); return { symbol: input.symbol, section: input.section, source: '东方财富', status: 'unavailable', error: '测试断线', fetchedAt: null }; } };
  const monitor = new StrategyMonitor({ strategyHistory: async () => { historyCalls++; return bars; } }, () => now, () => {}, research);
  await monitor.scan(['sz000001', 'sh600519'], ['sh600519']);
  assert.equal(historyCalls, 2);
  assert.deepEqual(researchCalls.map(i => `${i.symbol}:${i.section}`).sort(), ['sh600519:finance', 'sh600519:profile', 'sh600519:valuation']);
  assert.ok(monitor.snapshots.sh600519.technical);
  assert.equal(monitor.snapshots.sh600519.finance.status, 'unavailable');
  assert.equal(monitor.snapshots.sh600519.valuation.status, 'unavailable');
  await monitor.load('sz000001', true, true);
  assert.ok(researchCalls.some(i => i.symbol === 'sz000001' && i.section === 'finance'));
});

test('长线提交撞上后台在途请求后必须再强刷财报，普通并发仍合并', async () => {
  let release, historyCalls = 0; const requests = [];
  const gate = new Promise(resolve => { release = resolve; });
  const now = new Date('2026-09-29T10:00:00+08:00');
  const bars = Array.from({ length: 80 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 11 + i)).toISOString().slice(0, 10), open: 10, close: 10, high: 10.2, low: 9.8, volume: 100 }));
  const research = { get: async input => { requests.push(input); return { symbol: input.symbol, section: input.section, status: 'ready', fetchedAt: now.getTime(), data: {} }; } };
  const monitor = new StrategyMonitor({ strategyHistory: async () => { historyCalls++; if (historyCalls === 1) await gate; return bars; } }, () => now, () => {}, research);
  const first = monitor.load('sz000001', false, true), ordinary = monitor.load('sz000001', false, true), submitted = monitor.load('sz000001', true, true);
  release();
  const [background, combined, refreshed] = await Promise.all([first, ordinary, submitted]);
  assert.equal(background, combined); assert.notEqual(refreshed, background);
  assert.equal(historyCalls, 2);
  assert.deepEqual(requests.map(input => input.force), [false, false, false, true, true, true]);
  assert.equal(refreshed.forced, true);
});

test('四类策略选择经独立账户文件恢复；损坏选择回退备份并保留异常原件', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-strategy-modes-'));
  // Only remove the exact temporary directory created above, never an account supplied by a user.
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('guanlan-strategy-modes-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const f = fixture(), store = new Store(directory);
  const symbols = ['sh600519', 'sz000001', 'sz300750', 'sh600036'];
  modes.forEach((id, index) => f.engine.selectStrategy(symbols[index], id));
  store.save(f.engine.s); store.save(f.engine.s);
  const restored = new Engine(store.load(), f.engine.clock);
  modes.forEach((id, index) => assert.equal(restored.selectedStrategy(symbols[index]), id));
  assert.equal(restored.s.cash, f.engine.s.cash);
  for (const planSelections of [null, [], { sz000001: 'unknown' }, { '000001': 'short' }]) {
    const invalid = { ...structuredClone(f.engine.s), planSelections };
    assert.equal(validState(invalid), false); assert.throws(() => new Engine(invalid), /格式/);
    assert.throws(() => store.save(invalid), /无效/);
  }
  const corrupted = { ...structuredClone(f.engine.s), planSelections: { sz000001: 'unknown' } };
  fs.writeFileSync(store.file, JSON.stringify(corrupted));
  const recovered = store.load();
  assert.deepEqual(recovered.planSelections, f.engine.s.planSelections);
  assert.equal(recovered.cash, f.engine.s.cash); assert.match(store.warning, /恢复.*备份/);
  const preserved = fs.readdirSync(directory).find(file => file.startsWith('account.json.corrupt-'));
  assert.ok(preserved); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, preserved), 'utf8')), corrupted);
  store.save(recovered);
  assert.deepEqual(store.load().planSelections, f.engine.s.planSelections);
});
