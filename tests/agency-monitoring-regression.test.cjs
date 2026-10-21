const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { AgencyService } = require('../core/agency-service.cjs');
const { addAgencyMembers } = require('../core/agency-members.cjs');
const { cnTime } = require('../core/common.cjs');

// Isolated synthetic data only: this fixture never opens a stored account or
// calls a market/research provider. Its successful setup is a real engine buy.
function fixture(strategyId = 'swing', funding = 50000) {
  let now = Date.parse('2026-09-29T10:00:00+08:00');
  const engine = new Engine(initialState(100000), () => new Date(now));
  engine.agencyTransfer({ strategyId, amount: funding });
  engine.agencyMode({ strategyId, mode: 'running' });
  const quote = (symbol = 'sz000001', extra = {}) => ({ symbol, name: '监控回归隔离样本', source: 'test',
    price: 10.1, prevClose: 10.05, open: 10, high: 10.2, low: 10, volume: 100000,
    bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05,
    timestamp: now, date: cnTime(now).date, ...extra });
  const snapshot = (symbol = 'sz000001') => {
    const asOf = cnTime(now - 86400000).date;
    return { source: 'test daily', fetchedAt: now,
      notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now, data: { items: [], total: 0 } },
      technical: { asOf, close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1,
        trend: true, breakout: false, support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3,
        stop: 9.6, target: 11.5, dates: [asOf] } };
  };
  const add = (symbol = 'sz000001') => engine.agencyMember({ strategyId, symbol, action: 'add' });
  const execute = (q = quote(), data = snapshot(), action = 'buy') => engine.agencyExecute({ strategyId,
    symbol: q.symbol, action, targetPercent: action === 'buy' ? 30 : undefined,
    decisionId: `monitor-review-${engine.s.trades.length}-${action}`,
    expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, q, data, { [q.symbol]: q });
  return { engine, quote, snapshot, add, execute, now: () => now, advance: ms => { now += ms; } };
}

test('默认监控批量加入300只后全量轮检，缺资料和行情的首批不阻塞后续280只', async () => {
  const f = fixture(), symbols = Array.from({ length: 300 }, (_, i) => `sh${600000 + i}`), quotes = {}, loads = [];
  let adding = true, evidenceCalls = 0;
  const market = { quotes: async selected => Object.fromEntries(selected.filter(symbol => adding || !symbols.slice(0, 20).includes(symbol))
    .map(symbol => [symbol, f.quote(symbol, { price: 9.9, ask: 9.9, bid: 9.89 })])) };
  const transaction = fn => fn();
  const added = await addAgencyMembers({ strategyId: 'swing', symbols }, {
    getEngine: () => f.engine, transaction, market, acceptQuotes: batch => Object.assign(quotes, batch) });
  assert.equal(added.added.length, 300); assert.deepEqual(added.failed, []); assert.deepEqual(added.skipped, []);
  adding = false;
  const service = new AgencyService({ getEngine: () => f.engine, transaction, market,
    getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch), clock: f.now,
    getAutomaticEvidence: async () => { evidenceCalls++; throw Error('默认监控不应请求研究资料'); },
    monitor: { load: async (symbol, force, financial, notices) => {
      loads.push({ symbol, financial, notices });
      return symbols.slice(0, 20).includes(symbol) ? { error: '隔离样本日线暂不可用', fetchedAt: f.now() } : f.snapshot(symbol);
    } } });
  try {
    for (let batch = 1; batch <= 15; batch++) {
      await service.poll(); await service.runner.drain();
      const progress = service.publicState().coverage.swing;
      assert.equal(progress.total, 300); assert.equal(progress.processed, batch * 20);
      assert.equal(progress.remaining, 300 - batch * 20);
    }
    assert.deepEqual(loads.map(load => load.symbol), symbols);
    assert.ok(loads.every(load => load.financial === false && load.notices === true));
    assert.equal(evidenceCalls, 0); assert.equal(f.engine.s.trades.length, 0);
    const blocked = f.engine.s.agency.decisions.filter(item => item.status === 'blocked' && item.symbol);
    assert.deepEqual(blocked.map(item => item.symbol), symbols.slice(0, 20));
    assert.ok(blocked.every(item => /日线暂不可用/.test(item.message)));
    assert.equal(f.engine.s.agency.decisions.filter(item => item.status === 'waiting').length, 280);
    assert.equal(service.publicState().coverage.swing.status, 'complete');
    await service.poll(); await service.runner.drain(); assert.equal(loads.length, 300);
    assert.equal(validState(f.engine.s), true);
  } finally { service.stop(); }
});

test('默认监控仅放宽研究准入，缺公告、明确风险、过期行情、资金和盘口限制继续阻止开仓', () => {
  const baseline = fixture(); baseline.add(); assert.ok(baseline.execute().quantity >= 100);
  const cases = [
    { label: '公告缺失', change: (_f, _q, data) => { delete data.notices; }, reason: /公告/ },
    { label: '明确公告风险', change: (f, _q, data) => { data.notices.status = 'ready'; data.notices.data = {
      total: 1, items: [{ id: 'AN202609290001', date: cnTime(f.now()).date, title: '公司被立案调查公告' }] }; }, reason: /风险|公告/ },
    { label: '行情过期', change: (_f, q) => { q.timestamp -= 90001; }, reason: /行情|过期/ },
    { label: '盘口不足', change: (_f, q) => { q.askSize = 1; }, reason: /盘口|一档|数量|预算/ },
    { label: '资金不足', funding: 100, change: () => {}, reason: /资金|数量|预算/ }
  ];
  for (const item of cases) {
    const f = fixture('swing', item.funding); f.add(); const q = f.quote(), data = f.snapshot(); item.change(f, q, data);
    assert.throws(() => f.execute(q, data), item.reason, item.label);
    assert.equal(f.engine.s.trades.length, 0, item.label); assert.equal(validState(f.engine.s), true, item.label);
  }
  const long = fixture('long'); long.add(); const data = long.snapshot();
  data.technical.levels = { long: { support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5 } };
  assert.throws(() => long.execute(long.quote(), data), /财务|估值/); assert.equal(long.engine.s.trades.length, 0);
});

test('默认监控成功开仓后退出仍遵守T+1并保留原退出目标', () => {
  const f = fixture(); f.add(); const buy = f.execute();
  const exit = f.execute(f.quote(), f.snapshot(), 'sell');
  assert.equal(exit.pending, true); assert.equal(f.engine.s.trades.length, 1);
  assert.equal(f.engine.s.lots[0].quantity, buy.quantity);
  assert.equal(f.engine.s.agency.executionIntents[0].status, 'pending');
  f.advance(86400000);
  f.engine.tick({ sz000001: f.quote() }, { sz000001: f.snapshot() });
  assert.equal(f.engine.s.trades.length, 2); assert.equal(f.engine.s.trades[1].side, 'sell');
  assert.equal(f.engine.s.agency.executionIntents[0].status, 'completed');
  assert.equal(f.engine.s.lots.length, 0); assert.equal(validState(f.engine.s), true);
});

test('单只资料服务抛错仍完成当前批次并继续下一批监控', async () => {
  const f = fixture(), symbols = Array.from({ length: 25 }, (_, i) => `sh${600000 + i}`), quotes = {}, loads = [];
  for (const symbol of symbols) f.add(symbol);
  const service = new AgencyService({ getEngine: () => f.engine, transaction: fn => fn(), clock: f.now,
    getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch),
    market: { quotes: async selected => Object.fromEntries(selected.map(symbol => [symbol, f.quote(symbol, { price: 9.9, ask: 9.9, bid: 9.89 })])) },
    monitor: { load: async symbol => {
      loads.push(symbol);
      if (symbol === symbols[0]) throw Error('隔离样本资料获取失败');
      return f.snapshot(symbol);
    } } });
  try {
    await service.poll(); await service.runner.drain();
    assert.equal(service.publicState().coverage.swing.processed, 20);
    await service.poll(); await service.runner.drain();
    assert.deepEqual(loads, symbols);
    assert.equal(service.publicState().coverage.swing.status, 'complete');
    const member = f.engine.s.agency.groups.find(group => group.id === 'swing').members[0];
    assert.equal(member.monitoringCheck.status, 'data');
    assert.match(member.monitoringCheck.reason, /资料获取失败/);
    assert.equal(f.engine.s.trades.length, 0); assert.equal(validState(f.engine.s), true);
  } finally { service.stop(); }
});

test('买点通过后执行前取数抛错，将条件通过状态更新为数据待补齐且不成交', async () => {
  const f = fixture(), quotes = {}; f.add();
  const member = f.engine.s.agency.groups.find(group => group.id === 'swing').members[0];
  let loads = 0, observedEligible = false;
  const service = new AgencyService({ getEngine: () => f.engine, transaction: fn => fn(), clock: f.now,
    getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch),
    onChange: () => { observedEligible ||= member.monitoringCheck?.status === 'eligible'; },
    market: { quotes: async selected => Object.fromEntries(selected.map(symbol => [symbol, f.quote(symbol)])) },
    monitor: { load: async symbol => {
      if (++loads === 2) throw Error('执行前日线获取失败');
      return f.snapshot(symbol);
    } } });
  try {
    await service.poll(); await service.runner.drain();
    assert.equal(loads, 2); assert.equal(observedEligible, true);
    assert.equal(member.monitoringCheck.status, 'data');
    assert.equal(member.monitoringCheck.reason, '执行前日线获取失败');
    assert.ok(f.engine.s.agency.decisions.some(item => item.status === 'blocked' && item.message === '执行前日线获取失败'));
    assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.lots.length, 0);
    assert.equal(service.publicState().coverage.swing.status, 'complete'); assert.equal(validState(f.engine.s), true);
  } finally { service.stop(); }
});
