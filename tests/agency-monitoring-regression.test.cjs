const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { AgencyService } = require('../core/agency-service.cjs');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const { addAgencyMembers } = require('../core/agency-members.cjs');
const { ACTIVE_CANDIDATE_LIMIT } = require('../core/agency-capacity.cjs');
const { TECHNICAL_ENTRY_POLICY } = require('../core/strategy-profiles.cjs');
const { cnTime } = require('../core/common.cjs');

function preparedMonitor(clock, snapshots) {
  const calls = [], monitor = new StrategyMonitor({ strategyHistory: async () => { throw Error('交易不可获取日线'); } }, () => new Date(clock()));
  monitor.snapshots = snapshots;
  const read = monitor.readPrepared.bind(monitor);
  monitor.readPrepared = (symbol, financial, notices) => { calls.push({ symbol, financial, notices }); return read(symbol, financial, notices); };
  return { monitor, calls };
}

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

test('批量加入300只仅刷新20只活跃候选，280只候补保留且缺资料不阻塞其他活跃成员', async () => {
  const f = fixture(), symbols = Array.from({ length: 300 }, (_, i) => `sh${600000 + i}`), quotes = {};
  let adding = true, evidenceCalls = 0;
  const market = { quotes: async selected => Object.fromEntries(selected.filter(symbol => adding || !symbols.slice(0, 2).includes(symbol))
    .map(symbol => [symbol, f.quote(symbol, { price: 9.9, ask: 9.9, bid: 9.89 })])) };
  const transaction = fn => fn();
  const added = await addAgencyMembers({ strategyId: 'swing', symbols }, {
    getEngine: () => f.engine, transaction, market, acceptQuotes: batch => Object.assign(quotes, batch) });
  assert.equal(added.added.length, 300); assert.deepEqual(added.failed, []); assert.deepEqual(added.skipped, []);
  adding = false;
  const { monitor, calls: reads } = preparedMonitor(f.now, Object.fromEntries(symbols.map(symbol => [symbol,
    symbols.slice(0, 2).includes(symbol) ? { error: '隔离样本日线暂不可用', fetchedAt: f.now() } : f.snapshot(symbol)])));
  const service = new AgencyService({ getEngine: () => f.engine, transaction, market,
    getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch), clock: f.now,
    getAutomaticEvidence: async () => { evidenceCalls++; throw Error('默认监控不应请求研究资料'); },
    monitor });
  try {
    await service.poll(); await service.runner.drain();
    const progress = service.publicState().coverage.swing;
    assert.equal(progress.total, ACTIVE_CANDIDATE_LIMIT); assert.equal(progress.processed, ACTIVE_CANDIDATE_LIMIT); assert.equal(progress.remaining, 0);
    assert.deepEqual(reads.map(read => read.symbol), symbols.slice(0, ACTIVE_CANDIDATE_LIMIT));
    const members = f.engine.s.agency.groups.find(group => group.id === 'swing').members;
    assert.equal(members.filter(member => member.mode === 'standby').length, symbols.length - ACTIVE_CANDIDATE_LIMIT);
    assert.ok(members.slice(ACTIVE_CANDIDATE_LIMIT).every(member => member.monitoringCheck === undefined));
    assert.ok(reads.every(read => read.financial === false && read.notices === false));
    assert.equal(evidenceCalls, 0); assert.equal(f.engine.s.trades.length, 0);
    const blocked = f.engine.s.agency.decisions.filter(item => item.status === 'blocked' && item.symbol);
    assert.deepEqual(blocked.map(item => item.symbol), symbols.slice(0, 2));
    assert.ok(blocked.every(item => /日线暂不可用/.test(item.message)));
    assert.equal(f.engine.s.agency.decisions.filter(item => item.status === 'waiting').length, ACTIVE_CANDIDATE_LIMIT - 2);
    assert.equal(service.publicState().coverage.swing.status, 'complete');
    await service.poll(); await service.runner.drain(); assert.equal(reads.length, ACTIVE_CANDIDATE_LIMIT);
    assert.equal(validState(f.engine.s), true);
  } finally { service.stop(); }
});

test('技术监控停用公告财务准入，日线价格基准行情资金与盘口限制仍阻止开仓', () => {
  const baseline = fixture(); baseline.add(); assert.ok(baseline.execute().quantity >= 100);
  const cases = [
    { label: '日线缺失', change: (_f, _q, data) => { delete data.technical; }, reason: /日线/ },
    { label: '价格基准不符', change: (_f, q) => { q.prevClose = 20; }, reason: /价格基准|除权/ },
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
  data.technical.previousMa60 = 9.4; delete data.notices;
  assert.ok(long.execute(long.quote(), data).quantity >= 100); assert.equal(long.engine.s.trades.length, 1);
  assert.equal(long.engine.s.trades[0].strategyPlan.financeEvidence, undefined);
  assert.equal(long.engine.s.trades[0].strategyPlan.entryPolicy.finance, 'disabled');
  for (const mutate of [snapshot => { delete snapshot.notices; }, snapshot => { snapshot.notices.status = 'ready'; snapshot.notices.data = { total: 1, items: [{ id: 'AN202609290001', date: '2026-09-29', title: '公司被立案调查公告' }] }; }]) {
    const f = fixture(); f.add(); const snapshot = f.snapshot(); mutate(snapshot);
    const trade = f.execute(f.quote(), snapshot); assert.ok(trade.quantity >= 100);
    assert.equal(trade.strategyPlan.entryRiskEvidence.notices.status, 'disabled');
  }
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

test('单只后台资料获取失败仍完成其余19只活跃候选检查，不启动5只候补', async () => {
  const f = fixture(), symbols = Array.from({ length: 25 }, (_, i) => `sh${600000 + i}`), quotes = {};
  for (const symbol of symbols) f.add(symbol);
  const { monitor, calls: reads } = preparedMonitor(f.now, Object.fromEntries(symbols.map(symbol => [symbol,
    symbol === symbols[0] ? { error: '隔离样本资料获取失败', fetchedAt: f.now() } : f.snapshot(symbol)])));
  const service = new AgencyService({ getEngine: () => f.engine, transaction: fn => fn(), clock: f.now,
    getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch),
    market: { quotes: async selected => Object.fromEntries(selected.map(symbol => [symbol, f.quote(symbol, { price: 9.9, ask: 9.9, bid: 9.89 })])) },
    monitor });
  try {
    await service.poll(); await service.runner.drain();
    assert.equal(service.publicState().coverage.swing.processed, ACTIVE_CANDIDATE_LIMIT);
    await service.poll(); await service.runner.drain();
    assert.deepEqual(reads.map(read => read.symbol), symbols.slice(0, ACTIVE_CANDIDATE_LIMIT));
    assert.equal(service.publicState().coverage.swing.status, 'complete');
    const member = f.engine.s.agency.groups.find(group => group.id === 'swing').members[0];
    assert.equal(member.monitoringCheck.status, 'data');
    assert.match(member.monitoringCheck.reason, /资料获取失败/);
    assert.equal(f.engine.s.trades.length, 0); assert.equal(validState(f.engine.s), true);
  } finally { service.stop(); }
});

test('买点通过后后台资料变为失败，将条件通过状态更新为数据待补齐且不成交', async () => {
  const f = fixture(), quotes = {}; f.add();
  const member = f.engine.s.agency.groups.find(group => group.id === 'swing').members[0];
  let quoteCalls = 0, observedEligible = false;
  const { monitor } = preparedMonitor(f.now, { sz000001: f.snapshot() });
  const service = new AgencyService({ getEngine: () => f.engine, transaction: fn => fn(), clock: f.now,
    getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch),
    onChange: () => { observedEligible ||= member.monitoringCheck?.status === 'eligible'; },
    market: { quotes: async selected => {
      if (++quoteCalls === 2) monitor.snapshots.sz000001 = { error: '执行前日线获取失败', fetchedAt: f.now() };
      return Object.fromEntries(selected.map(symbol => [symbol, f.quote(symbol)]));
    } }, monitor });
  try {
    await service.poll(); await service.runner.drain();
    assert.equal(quoteCalls, 2); assert.equal(observedEligible, true);
    assert.equal(member.monitoringCheck.status, 'data');
    assert.equal(member.monitoringCheck.entryPolicyVersion, TECHNICAL_ENTRY_POLICY.version);
    assert.match(member.monitoringCheck.reason, /执行前日线获取失败/);
    assert.ok(f.engine.s.agency.decisions.some(item => item.status === 'blocked' && /执行前日线获取失败/.test(item.message)));
    assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.lots.length, 0);
    assert.equal(service.publicState().coverage.swing.status, 'complete'); assert.equal(validState(f.engine.s), true);
  } finally { service.stop(); }
});

test('v8旧eligible重启后重新检查资料，失败写入当前政策结果且不沿用旧通过成交', async () => {
  const f = fixture(); f.add();
  const oldCheck = { status: 'eligible', reason: '旧规则曾通过', checkedAt: new Date(f.now() - 86400000).toISOString() };
  f.engine.s.agency.groups.find(group => group.id === 'swing').members[0].monitoringCheck = oldCheck;
  const engine = new Engine(structuredClone(f.engine.s), f.engine.clock);
  const member = engine.s.agency.groups.find(group => group.id === 'swing').members[0];
  assert.equal(member.monitoringCheck, undefined); assert.deepEqual(member.legacyMonitoringCheck, oldCheck);
  const { monitor, calls } = preparedMonitor(f.now, { sz000001: { error: '重新检查时日线获取失败', fetchedAt: f.now() } });
  let quoteRequests = 0;
  const service = new AgencyService({ getEngine: () => engine, transaction: fn => fn(), clock: f.now,
    getQuotes: () => ({}), acceptQuotes: () => {}, monitor,
    market: { quotes: async () => { quoteRequests++; return { sz000001: f.quote() }; } } });
  try {
    await service.poll(); await service.runner.drain();
    assert.equal(calls.length, 1); assert.equal(quoteRequests, 0, '资料未就绪不进入提交行情获取');
    assert.equal(member.monitoringCheck.status, 'data'); assert.match(member.monitoringCheck.reason, /重新检查时日线获取失败/);
    assert.equal(member.monitoringCheck.entryPolicyVersion, TECHNICAL_ENTRY_POLICY.version);
    assert.deepEqual(member.legacyMonitoringCheck, oldCheck);
    assert.equal(engine.s.trades.length, 0); assert.equal(engine.s.lots.length, 0); assert.equal(validState(engine.s), true);
    assert.deepEqual(new Engine(structuredClone(engine.s), f.engine.clock).s, engine.s);
  } finally { service.stop(); }
});
