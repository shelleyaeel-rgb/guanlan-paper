const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { AgencyService } = require('../core/agency-service.cjs');
const { cnTime } = require('../core/common.cjs');
const { AgencyPoolService } = require('../core/agency-pool.cjs');
const { poolPolicy } = require('../core/agency-screening.cjs');
const { ACTIVE_CANDIDATE_LIMIT } = require('../core/agency-capacity.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-agency-service-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('guanlan-agency-service-')); fs.rmSync(directory, { recursive: true, force: true }); });
  // Old provider configuration is deliberately invalid. The rules service must not read or modify it.
  const legacyFile = path.join(directory, 'agency-model.json'), legacyContent = '{ broken legacy credential data'; fs.writeFileSync(legacyFile, legacyContent);
  let now = Date.parse('2026-09-29T10:00:00+08:00'), failSave = false, failAnySave = false, refreshHook = null, loadHook = null, price = 10.1;
  let engine = new Engine(initialState(100000), () => new Date(now));
  const store = new Store(directory), quotes = {}, marketCalls = [], loads = [], omitted = new Set(), quoteOverrides = {};
  const transaction = fn => { const before = structuredClone(engine.s); try { const value = fn(); if (failAnySave || failSave && engine.s.trades.length) throw Error('模拟保存失败'); store.save(engine.s); return value; } catch (e) { engine.s = before; throw e; } };
  const quote = symbol => ({ symbol, name: '服务隔离测试', source: 'test', price, prevClose: 10.05, open: 10, low: 10, high: Math.max(10.2, price), volume: 100000,
    bid: price - 0.01, ask: price, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05, timestamp: now, date: cnTime(now).date, ...quoteOverrides[symbol] });
  const snapshot = symbol => {
    const asOf = cnTime(now - 86400000).date;
    return { source: 'test daily', fetchedAt: now,
      notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now, data: { items: [], total: 0 } },
      technical: { asOf, close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true,
        breakout: false, support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: [asOf] } };
  };
  const createService = () => {
    const options = { getEngine: () => engine, transaction, getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch),
      market: { quotes: async symbols => { marketCalls.push(symbols); if (refreshHook) await refreshHook(symbols, marketCalls.length); return Object.fromEntries(symbols.filter(symbol => !omitted.has(symbol)).map(s => [s, quote(s)])); } },
      monitor: {
        snapshots: {},
        load: async (symbol, force, financial, notices) => { loads.push({ symbol, force, financial, notices }); if (loadHook) await loadHook(symbol, loads.length); return snapshot(symbol); },
        async prepare(symbol, financial, notices) { return this.snapshots[symbol] = structuredClone(await this.load(symbol, false, financial, notices)); },
        readPrepared(symbol) { if (!this.snapshots[symbol]) throw Error('开仓资料未就绪：尚未准备'); return structuredClone(this.snapshots[symbol]); },
        assertPrepared(symbol, value) {
          const current = this.readPrepared(symbol);
          for (const key of ['technical']) if (JSON.stringify(current[key]) !== JSON.stringify(value[key])) throw Error('开仓资料未就绪：已准备资料发生变化');
          return value;
        }
      }, clock: () => now };
    for (const name of ['dir', 'safeStorage', 'fetchImpl', 'model', 'settingsStore']) Object.defineProperty(options, name, { get() { throw Error('不应读取旧模型依赖'); } });
    return new AgencyService(options);
  };
  let service = createService();
  transaction(() => { engine.agencyTransfer({ strategyId: 'swing', amount: 50000 }); engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'add' }); engine.agencyMode({ strategyId: 'swing', mode: 'running' }); });
  // Most business tests start with completed background preparation. poll()
  // remains separate so acquisition/latency tests exercise the trading lane alone.
  const prepare = async () => {
    const queue = service.groups().filter(group => group.enabled).flatMap(group => {
      const cycle = service.cycles.get(group.id), start = cycle.cursor >= cycle.symbols.length ? 0 : cycle.cursor;
      return cycle.symbols.slice(start, start + 20).map(symbol => ({ symbol, strategyId: group.id }));
    });
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { while (queue.length) { const item = queue.shift(); await service.prepareEntry(item.symbol, item.strategyId); } }));
  };
  const poll = async (options = { force: true }) => { await service.poll(options); await service.runner.drain(); };
  const run = async (options = { force: true }) => { await prepare(); await poll(options); };
  return { get engine() { return engine; }, get service() { return service; }, store, quotes, transaction, marketCalls, loads, prepare, poll, run, quote, snapshot, legacyFile, legacyContent,
    publishSnapshot: (symbol, value = snapshot(symbol)) => { service.monitor.snapshots[symbol] = structuredClone(value); },
    add: symbol => transaction(() => engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' })),
    refreshing: fn => { refreshHook = fn; }, loading: fn => { loadHook = fn; }, price: v => { price = v; },
    omit: symbols => { omitted.clear(); for (const symbol of symbols) omitted.add(symbol); }, overrideQuote: (symbol, change) => { quoteOverrides[symbol] = change; },
    setTime: v => { now = Date.parse(v); }, advance: ms => { now += ms; }, failSave: () => { failSave = true; }, failAnySave: () => { failAnySave = true; },
    restart: () => { service.stop(); engine = new Engine(store.load(), () => new Date(now)); service = createService(); },
    reset: () => transaction(() => { engine.s = new Engine(initialState(100000), () => new Date(now)).s; }) };
}

function resolvedNoticeSnapshot(snapshot, now) {
  const notice = { id: 'AN20260929000001', date: cnTime(now).date, title: '关于诉讼结案的公告' };
  snapshot.notices = { symbol: snapshot.notices.symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: now, data: { items: [notice], total: 1 } };
  return snapshot;
}
test('未准备成员只记录跳过，候选及成交不调用资料接口，其他已准备成员仍可成交', async t => {
  const f = fixture(t); f.add('sh600000'); f.publishSnapshot('sh600000');
  let requested = 0;
  f.service.monitor.load = async () => { requested++; throw Error('交易流程不应下载资料'); };
  f.service.monitor.prepare = async () => { requested++; throw Error('交易流程不应等待准备'); };
  f.service.getAutomaticEvidence = async () => { requested++; throw Error('交易流程不应下载研究'); };
  f.service.getNoticeEvidence = async () => { requested++; throw Error('交易流程不应下载正文'); };
  await f.poll();
  assert.equal(requested, 0); assert.deepEqual(f.engine.s.trades.map(trade => trade.symbol), ['sh600000']);
  assert.equal(f.marketCalls.length, 2, '只请求候选及成交所需的当前报价');
  const skipped = f.engine.s.agency.decisions.find(item => item.symbol === 'sz000001' && item.status === 'blocked');
  assert.match(skipped.message, /资料.*未就绪|尚未准备/); assert.equal(validState(f.store.load()), true);
});

test('后台准备并发有界且逐槽轮转，慢资料请求不阻断其他股票开仓', async t => {
  const f = fixture(t); f.add('sh600000'); f.add('sh600001');
  let release, active = 0, peak = 0;
  const slow = new Promise(resolve => { release = resolve; });
  f.loading(async symbol => {
    active++; peak = Math.max(peak, active);
    try { if (symbol === 'sz000001') await slow; } finally { active--; }
  });
  const first = f.service.prepareEntries();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.loads.map(item => item.symbol), ['sz000001', 'sh600000', 'sh600001'], '空闲槽完成后立即补位，不等下个定时器');
    assert.equal(f.service.preparingEntries.size, 1);
    const second = f.service.prepareEntries();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.loads.map(item => item.symbol), ['sz000001', 'sh600000', 'sh600001']);
    assert.equal(peak, 2); assert.equal(active, 1, '慢资料仍在后台等待');
    await f.poll();
    assert.deepEqual(f.engine.s.trades.map(trade => trade.symbol), ['sh600000', 'sh600001']);
    assert.equal(active, 1, '交易完成不依赖慢资料返回');
    release(); await Promise.all([first, second]);
    assert.equal(f.service.preparingEntries.size, 0); assert.equal(validState(f.store.load()), true);
  } finally { release(); await first; }
});

test('四组80只活跃候选连续补位完成准备，大量候补不取资料且准备本身不触发成交', async t => {
  const f = fixture(t);
  f.transaction(() => {
    for (const [groupIndex, group] of f.engine.s.agency.groups.entries()) {
      f.engine.agencyMode({ strategyId: group.id, mode: 'running' });
      for (let i = 0; i < 30; i++) f.engine.agencyMember({ strategyId: group.id, symbol: `sh${600000 + groupIndex * 100 + i}`, action: 'add' });
    }
  });
  const members = f.engine.s.agency.groups.flatMap(group => group.members), activeSymbols = members.filter(member => member.mode === 'active').map(member => member.symbol);
  const totalActive = f.engine.s.agency.groups.length * ACTIVE_CANDIDATE_LIMIT;
  assert.equal(totalActive, 80);
  assert.equal(activeSymbols.length, totalActive); assert.equal(members.filter(member => member.mode === 'standby').length, members.length - totalActive);
  let release, inflight = 0, peak = 0;
  const slow = new Promise(resolve => { release = resolve; });
  f.loading(async symbol => { inflight++; peak = Math.max(peak, inflight); try { if (symbol === activeSymbols[0]) await slow; } finally { inflight--; } });
  const preparing = f.service.prepareEntries();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(new Set(f.loads.map(item => item.symbol)), new Set(activeSymbols));
    assert.equal(peak, 2); assert.equal(inflight, 1, '其余79只连续使用空闲槽，不等待慢成员或下一个5秒定时器');
    assert.equal(Object.keys(f.service.monitor.snapshots).length, totalActive - 1);
    assert.equal(f.marketCalls.length, 0); assert.equal(f.engine.s.trades.length, 0);
    release(); await preparing; await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.preparingEntries.size, 0); assert.equal(Object.keys(f.service.monitor.snapshots).length, totalActive);
    assert.equal(validState(f.store.load()), true);
  } finally { release(); await preparing; f.service.stop(); }
});

test('资料从未就绪恢复后下一次普通轮询立即重检，资料准备不下单且已就绪刷新不重复唤醒', async t => {
  const f = fixture(t); f.price(9.9);
  await f.poll({});
  assert.equal(f.service.publicState().coverage.swing.processed, 1);
  assert.equal(f.engine.s.agency.groups.find(group => group.id === 'swing').members[0].monitoringCheck.status, 'data');
  await f.service.prepareEntries(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.engine.s.trades.length, 0); assert.equal(f.marketCalls.length, 0);
  await f.poll({});
  assert.equal(f.marketCalls.length, 1, '无需等待完整5分钟，普通poll重新检查恢复的候选');
  assert.equal(f.engine.s.agency.groups.find(group => group.id === 'swing').members[0].monitoringCheck.status, 'conditions');
  const completed = f.service.runner.lastCompleted.get('swing');
  f.advance(60000); await f.service.prepareEntries(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.runner.lastCompleted.get('swing'), completed, '原本可用的资料刷新不反复解除规则节流');
  await f.poll({}); assert.equal(f.marketCalls.length, 1); assert.equal(f.engine.s.trades.length, 0);
});

test('后台准备、候选和成交完全不读取风险公告及财报研究，失效接口不妨碍技术成交', async t => {
  const f = fixture(t); let researchCalls = 0;
  const disabled = () => { researchCalls++; throw Error('自动交易已取消研究接口'); };
  f.service.getAutomaticEvidence = disabled; f.service.getNoticeEvidence = disabled; f.service.getSelectionEvidence = disabled;
  f.service.getEvidenceVersion = disabled;
  const load = f.service.monitor.load;
  f.service.monitor.load = async (...args) => {
    assert.equal(args[2], false); assert.equal(args[3], false);
    const snapshot = await load(...args);
    snapshot.notices = { status: 'unavailable', error: 'HTTP/2 protocol error' };
    snapshot.finance = { status: 'unavailable', error: '财报失败' };
    return snapshot;
  };
  await f.run(); assert.equal(researchCalls, 0); assert.equal(f.engine.s.trades.length, 1);
  const plan = f.engine.s.trades[0].strategyPlan;
  assert.equal(plan.entryRiskEvidence.notices.status, 'disabled');
  assert.equal(plan.entryRiskEvidence.notices.mode, undefined);
  assert.equal(validState(f.store.load()), true);
});

test('候选或执行等待期间公告新增更正或失败均不改变已停用的研究筛查', async t => {
  for (const stage of [1, 2]) for (const failure of [false, true]) {
    const f = fixture(t); let calls = 0;
    f.service.getNoticeEvidence = () => { calls++; throw Error('不应读取正文'); };
    f.refreshing((_symbols, count) => {
      if (count !== stage) return;
      const next = f.snapshot('sz000001');
      next.notices = failure ? { status: 'unavailable', error: '离线' }
        : { status: 'ready', data: { total: 1, items: [{ id: 'new-risk', title: '重大诉讼公告' }] } };
      f.publishSnapshot('sz000001', next);
    });
    await f.run(); assert.equal(f.engine.s.trades.length, 1); assert.equal(calls, 0);
    assert.equal(validState(f.store.load()), true);
  }
});

test('后台准备慢日线仍可取消，账户切换或停止后不发布旧准备完成通知', async t => {
  for (const change of ['reset', 'stop']) {
    const f = fixture(t); let release, notifications = 0;
    f.service.onChange = () => notifications++;
    f.loading(() => new Promise(resolve => { release = resolve; }));
    const preparing = f.service.prepareEntry('sz000001', 'swing');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof release, 'function');
    if (change === 'reset') f.reset(); else f.service.stop();
    release(); await preparing;
    assert.equal(notifications, 0); assert.equal(f.service.preparingEntries.size, 0);
    assert.equal(f.engine.s.trades.length, 0); assert.equal(validState(f.store.load()), true);
  }
});

test('兼容的研究包装入口不下载资料也不伪造研究通过结论', async t => {
  const f = fixture(t), snapshot = f.snapshot('sz000001');
  let calls = 0; const disabled = () => { calls++; throw Error('不可调用研究'); };
  f.service.getAutomaticEvidence = disabled; f.service.getNoticeEvidence = disabled; f.service.getSelectionEvidence = disabled;
  assert.equal(await f.service.withAutomaticEvidence('sz000001', snapshot), snapshot);
  assert.equal(await f.service.withNoticeEvidence('sz000001', snapshot), snapshot);
  assert.equal(f.service.withSelectionEvidence('sz000001', snapshot), snapshot);
  assert.equal(snapshot.automaticEvidenceLoad, undefined); assert.equal(calls, 0);
});

test('严格候选资格待核验时转候补，轮询及重启不下载资料或自行恢复资格', async t => {
  const f = fixture(t), policy = poolPolicy('strict'); let status = 'pending', evidenceCalls = 0;
  const original = f.engine.s.agency.groups.find(group => group.id === 'swing').members[0];
  original.selectionMode = 'strict';
  original.entryConditions = require('../core/entry-conditions.cjs').createEntryConditions({ ...policy.commonQuery, source: { kind: 'agency-pool', policyVersion: 3, screeningMode: 'strict' } });
  const pool = new AgencyPoolService({ getEngine: () => f.engine, transaction: f.transaction, screener: {}, clock: f.service.clock,
    screen: async () => ({ startedAt: f.service.clock(), finishedAt: f.service.clock(), strategies: Object.fromEntries(policy.priority.map(id => [id, {
      query: policy.commonQuery, pass: status === 'pass' ? [{ symbol: 'sz000001', reasons: [] }] : [], failed: [],
      pending: status === 'pending' ? [{ symbol: 'sz000001', reasons: ['隔离候选：报告解析尚未完整'] }] : [] }])) }) });
  await pool.run({ screeningMode: 'strict' });
  const before = structuredClone(f.engine.s.agency.pool), member = () => f.engine.s.agency.groups.find(group => group.id === 'swing').members[0];
  f.service.getAutomaticEvidence = async symbol => { evidenceCalls++; return { symbol, checkedAt: f.service.clock(), status: 'unavailable', documents: [], errors: ['isolated actual source failure'] }; };
  const load = await f.service.withAutomaticEvidence('sz000001', f.snapshot('sz000001'));
  assert.equal(load.automaticEvidenceLoad, undefined);
  await f.poll();
  const cold = f.engine.s.agency.decisions.findLast(item => item.symbol === 'sz000001');
  assert.equal(cold, undefined, '候补不进入规则轮检，不虚构持续条件检查记录');
  assert.equal(member().mode, 'standby'); assert.match(member().standbyReason, /资料待核验/);
  assert.deepEqual(member().poolCheck.reasons, ['隔离候选：报告解析尚未完整']);
  assert.equal(f.loads.length, 0); assert.equal(evidenceCalls, 0);
  for (let run = 0; run < 2; run++) { await f.run(); f.advance(300001); }
  assert.equal(f.engine.s.agency.decisions.findLast(item => item.symbol === 'sz000001'), undefined);
  assert.deepEqual(f.engine.s.agency.pool, before);
  assert.equal(member().automaticCheck, undefined, '资格尚未通过且未进行资料检查时，不虚构自动核验通过记录');
  assert.equal(evidenceCalls, 0);
  assert.equal(f.engine.s.trades.length, 0); assert.equal(validState(f.store.load()), true);
  f.restart(); await f.run(); assert.equal(member().poolCheck.status, 'pending');
  assert.equal(member().mode, 'standby'); assert.equal(f.engine.s.agency.decisions.findLast(item => item.symbol === 'sz000001'), undefined);
  // Only the separate manual pool operation changes candidate authorization.
  status = 'pass'; await pool.run({ screeningMode: 'strict' });
  f.service.getAutomaticEvidence = async symbol => { evidenceCalls++; return { symbol, checkedAt: f.service.clock(), status: 'unavailable', documents: [], errors: ['isolated actual source failure'] }; };
  await f.run(); assert.equal(member().poolCheck.status, 'pass'); assert.equal(evidenceCalls, 0);
  assert.equal(f.engine.s.trades.length, 1, '候选已通过时财报研究接口失败不阻断行情技术开仓');
});

test('旧严格研究资格停用后不再阻断技术条件，也不读取伪造的研究通过状态', async t => {
  const f = fixture(t), policy = poolPolicy('strict'), { createEntryConditions } = require('../core/entry-conditions.cjs');
  const member = f.engine.s.agency.groups.find(group => group.id === 'swing').members[0];
  member.selectionMode = 'strict';
  f.engine.s.agency.pool = { policy }; member.poolCheck = { status: 'pass', policyVersion: 1, reasons: ['旧标准结果'] };
  member.entryConditions = createEntryConditions({ ...policy.commonQuery, source: { kind: 'agency-pool', policyVersion: 2 } }); let calls = 0;
  f.service.getAutomaticEvidence = async () => { calls++; throw Error('不应调用'); };
  assert.equal((await f.service.withAutomaticEvidence(member.symbol, {})).automaticEvidenceLoad, undefined); assert.equal(calls, 0);
  const result = f.engine.agencyEvaluate('swing', member.symbol, f.quote(member.symbol), { ...f.snapshot(member.symbol), automaticEvidenceLoad: { status: 'ready' } });
  assert.equal(result.buyable, true); assert.notEqual(result.entryConditionsCheck?.status, 'skipped'); assert.doesNotMatch(result.reasons.join('；'), /候选池资格/);
});

test('无密钥和第三方服务即可按固定规则成交，旧配置不读取、不改写', async t => {
  const f = fixture(t); f.add('sh600000'); await f.run();
  assert.equal(f.engine.s.trades.length, 2); assert.ok(f.engine.s.trades.every(trade => trade.owner === 'swing' && trade.decisionId));
  const group = f.engine.agencyState().groups.find(g => g.id === 'swing');
  assert.equal(f.engine.s.agency.manualCash, 5000000); assert.equal(f.engine.s.cash, 5000000 + group.cash);
  const entries = f.engine.s.agency.decisions.filter(d => d.status === 'executed');
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.targetPercent, group.limits.maxPosition * 100); assert.equal(entry.decisionSource, 'rules'); assert.equal(entry.rulesVersion, '1');
    assert.ok(entry.inputSources.length && entry.evidence.length); assert.ok(entry.executionCheck.plan && entry.executionCheck.inputSources.length);
    const trade = f.engine.s.trades.find(trade => trade.id === entry.tradeId);
    assert.equal(entry.execution.price, trade.price); assert.deepEqual(entry.execution.plan, trade.strategyPlan);
  }
  assert.ok(f.engine.s.agency.decisions.every(d => d.decisionSource === 'rules' && d.rulesVersion === '1'));
  assert.equal(validState(f.store.load()), true); assert.equal(fs.readFileSync(f.legacyFile, 'utf8'), f.legacyContent);
  const runtime = f.service.publicState(); assert.equal(runtime.decisionMode, 'rules'); assert.equal(runtime.rulesVersion, '1'); assert.equal(runtime.intervalSeconds, 300);
  assert.equal(runtime.hasKey, undefined); assert.equal(runtime.endpoint, undefined); assert.equal(runtime.model, undefined);
  assert.equal(f.service.saveModel, undefined); assert.equal(f.service.testModel, undefined);
});
test('规则未全部满足只保留等待理由，后续全部通过才能成交', async t => {
  const f = fixture(t); f.price(9.9); await f.run(); assert.equal(f.engine.s.trades.length, 0);
  const wait = f.engine.s.agency.decisions.find(d => d.action === 'wait'); assert.equal(wait.status, 'waiting'); assert.ok(wait.reason && wait.inputSources.length && wait.evidence.length);
  f.price(10.1); await f.run(); assert.equal(f.engine.s.trades.length, 1);
});
test('调度、候选和成交不请求完整历史快照，暂停组仍只检查归属持仓', async t => {
  const f = fixture(t);
  f.engine.agencyState = () => { throw Error('后台检查不得全量复制历史记录'); };
  await f.run();
  assert.equal(f.engine.s.trades.length, 1, '候选和成交复核仍能按实时单组估值执行');
  f.add('sh600000');
  f.transaction(() => f.engine.agencyMode({ strategyId: 'swing', mode: 'paused' }));
  const beforeLoads = f.loads.length;
  await f.run();
  assert.deepEqual(f.loads.slice(beforeLoads).map(load => load.symbol), ['sz000001']);
  assert.equal(f.engine.s.trades.length, 1);
  assert.ok(f.engine.s.agency.decisions.some(item => item.symbol === 'sz000001' && item.action === 'hold'));
  assert.equal(f.service.publicState().coverage.swing.total, 1);
  f.transaction(() => f.engine.agencyMode({ strategyId: 'swing', mode: 'stopped' }));
  const stoppedLoads = f.loads.length;
  await f.run(); assert.equal(f.loads.length, stoppedLoads);
  assert.equal(validState(f.store.load()), true);
});

test('行情取数期间暂停策略，使在途检查失效且不恢复权限', async t => {
  const f = fixture(t); f.refreshing(() => f.transaction(() => f.engine.agencyMode({ strategyId: 'swing', mode: 'paused' })));
  await f.run(); assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.agency.groups.find(g => g.id === 'swing').mode, 'paused');
  assert.ok(f.engine.s.agency.decisions.some(d => d.status === 'stale'));
});
test('成交前行情刷新过程中移出股票，已通过规则的意图失效', async t => {
  const f = fixture(t);
  f.refreshing((_symbols, calls) => { if (calls === 2) f.transaction(() => f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'remove' })); });
  await f.run(); assert.equal(f.engine.s.trades.length, 0); assert.ok(f.engine.s.agency.decisions.some(d => d.status === 'stale'));
});
test('强制刷新后使用最新通过规则的计划，保存实际价格、计划和输入依据', async t => {
  const f = fixture(t); f.refreshing((_symbols, calls) => { if (calls === 2) f.price(10.12); }); await f.run();
  assert.equal(f.engine.s.trades.length, 1); assert.equal(f.engine.s.trades[0].price, 10.13);
  const entry = f.engine.s.agency.decisions.find(d => d.status === 'executed');
  assert.equal(entry.inputSources[0].data.ask, 10.1); assert.equal(entry.executionCheck.quote.ask, 10.12);
  assert.equal(entry.execution.plan.entry, 10.13); assert.equal(f.loads.length, 1);
  assert.ok(f.loads.every(load => load.force === false && load.financial === false && load.notices === false), '后台准备遵循缓存，成交不强制下载资料');
});
test('强制刷新后条件不满足不得使用此前通过的检查结果', async t => {
  const f = fixture(t); f.refreshing((_symbols, calls) => { if (calls === 2) f.price(9.9); }); await f.run();
  assert.equal(f.engine.s.trades.length, 0); const entry = f.engine.s.agency.decisions.find(d => d.action === 'buy' && d.status === 'blocked');
  assert.equal(entry.executionCheck.buyable, false); assert.ok(entry.executionCheck.reasons.length);
});
test('账户保存失败原子回滚成交、资金、盘口和成交日志，并停止后续自动交易', async t => {
  const f = fixture(t); f.add('sh600000'); f.refreshing((_symbols, calls) => { if (calls === 2) f.failSave(); }); const before = f.engine.s.cash; await f.run();
  assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.cash, before); assert.deepEqual(f.engine.s.consumed, {});
  assert.equal(f.store.load().trades.length, 0); assert.ok(!f.engine.s.agency.decisions.some(d => d.status === 'executed'));
  assert.match(f.service.publicState().lastError, /保存失败/); assert.equal(f.service.publicState().online, false);
  const calls = f.marketCalls.length; await f.run(); assert.equal(f.marketCalls.length, calls);
});
test('检查日志保存失败也不能绕过持久化继续执行', async t => {
  const f = fixture(t); f.failAnySave(); await f.run(); assert.equal(f.engine.s.trades.length, 0); assert.match(f.service.publicState().lastError, /保存失败/);
});
test('已有持仓只记录hold，不加仓也不由规则检查创建退出意向', async t => {
  const f = fixture(t); await f.run(); const quantity = f.engine.s.lots[0].quantity; await f.run();
  assert.equal(f.engine.s.trades.length, 1); assert.equal(f.engine.s.lots[0].quantity, quantity); assert.equal(f.engine.s.agency.executionIntents.length, 0);
  assert.ok(f.engine.s.agency.decisions.some(d => d.action === 'hold' && d.status === 'waiting' && d.decisionSource === 'rules'));
});
test('固定退出仍由tick独立管理，遵守T+1且无需等待下轮规则检查', async t => {
  const f = fixture(t); await f.run(); f.price(9.5);
  f.transaction(() => f.engine.tick({ sz000001: f.quote('sz000001') }, { sz000001: f.snapshot('sz000001') }));
  assert.equal(f.engine.s.trades.length, 1);
  f.setTime('2026-09-30T10:00:00+08:00');
  f.transaction(() => f.engine.tick({ sz000001: f.quote('sz000001') }, { sz000001: f.snapshot('sz000001') }));
  assert.equal(f.engine.s.trades.length, 2); assert.equal(f.engine.s.trades[1].side, 'sell');
});
test('重启重新检查最新数据，已有持仓不会重放旧买入', async t => {
  const f = fixture(t); await f.run(); const decisionId = f.engine.s.trades[0].decisionId; f.restart(); await f.run();
  assert.equal(f.engine.s.trades.length, 1); assert.equal(f.engine.s.trades[0].decisionId, decisionId);
  assert.ok(f.engine.s.agency.decisions.some(d => d.action === 'hold')); assert.equal(fs.readFileSync(f.legacyFile, 'utf8'), f.legacyContent);
});
test('过期检查和账户重置均拒绝在途成交', async t => {
  const expired = fixture(t); expired.refreshing((_symbols, calls) => { if (calls === 2) expired.advance(120001); }); await expired.run();
  assert.equal(expired.engine.s.trades.length, 0); assert.ok(expired.engine.s.agency.decisions.some(d => d.status === 'stale'));
  const reset = fixture(t); reset.refreshing((_symbols, calls) => { if (calls === 2) reset.reset(); }); await reset.run();
  assert.equal(reset.engine.s.trades.length, 0); assert.equal(reset.engine.s.agency.groups.flatMap(group => group.members).length, 0);
});
test('休市和未知年份不进行候选取数，五分钟节流固定且可以手动立即检查', async t => {
  const f = fixture(t); f.setTime('2026-10-01T10:00:00+08:00'); await f.run(); assert.equal(f.marketCalls.length, 0);
  f.setTime('2027-01-04T10:00:00+08:00'); await f.run(); assert.equal(f.marketCalls.length, 0);
  f.setTime('2026-09-29T10:00:00+08:00'); await f.run(); const calls = f.marketCalls.length;
  await f.run({}); assert.equal(f.marketCalls.length, calls); f.advance(299999); await f.run({}); assert.equal(f.marketCalls.length, calls);
  f.advance(1); await f.run({}); assert.equal(f.marketCalls.length, calls + 1);
});
test('手动策略计划只能使用未分配现金，代理预算不受手动现金掏空影响', async t => {
  const f = fixture(t); f.transaction(() => f.engine.agencyTransfer({ strategyId: 'swing', amount: 49999 }));
  const { evaluateEntry } = require('../core/strategy.cjs');
  assert.equal(evaluateEntry(f.engine, 'sh600000', f.quote('sh600000'), f.snapshot('sh600000')).buyable, false); assert.equal(f.engine.stats().manualCash, 100);
  await f.run(); assert.equal(f.engine.s.trades.length, 1); assert.equal(f.engine.s.agency.manualCash, 100);
});
test('待对账股票保留阻断依据，收益口径继续隐藏且禁止自动买卖', async t => {
  const f = fixture(t); await f.run(); const q = { ...f.quote('sz000001'), prevClose: 8, price: 8, bid: 8 };
  f.transaction(() => f.engine.tick({ sz000001: q }, { sz000001: f.snapshot('sz000001') }));
  const stats = f.engine.stats(); assert.equal(stats.comparable, false); assert.equal(stats.returnPct, null); assert.equal(stats.drawdown, null);
  await f.run(); assert.equal(f.engine.s.trades.length, 1);
  const entry = f.engine.s.agency.decisions.find(d => d.status === 'blocked' && /待对账/.test(d.message)); assert.ok(entry?.inputSources.length); assert.equal(entry.decisionSource, 'rules');
});
test('代理成员策略归属与直接交易日历校验保持有效', t => {
  const f = fixture(t); f.transaction(() => f.engine.agencyMember({ strategyId: 'long', symbol: 'sh600000', action: 'add' })); assert.equal(f.engine.selectedStrategy('sh600000'), 'long');
  f.setTime('2026-10-01T10:00:00+08:00'); const a = f.engine.s.agency;
  assert.throws(() => f.engine.agencyExecute({ strategyId: 'swing', symbol: 'sz000001', action: 'buy', targetPercent: 10,
    decisionId: 'holiday-direct', expectedEpoch: a.epoch, expectedRevision: a.revision }, f.quote('sz000001'), f.snapshot('sz000001')), /休市/);
});
test('候选及成交前刷新全账户持仓，估值证据使用新报价但不在事务外覆盖marks', async t => {
  const f = fixture(t);
  f.transaction(() => f.engine.execute({ symbol: 'sh600000', side: 'buy', quantity: 1000 }, f.quote('sh600000')));
  const savedMark = structuredClone(f.engine.s.marks.sh600000); f.advance(600000);
  f.overrideQuote('sh600000', { price: 10.8, bid: 10.79, ask: 10.8 }); await f.run();
  assert.equal(f.engine.s.trades.length, 2);
  assert.ok(f.marketCalls.every(symbols => symbols.includes('sz000001') && symbols.includes('sh600000')));
  const entry = f.engine.s.agency.decisions.find(d => d.status === 'executed'), valuation = entry.executionCheck.valuation;
  assert.deepEqual(valuation.holdingQuotes.map(item => item.symbol), ['sh600000']);
  assert.equal(valuation.holdingQuotes[0].price, 10.8); assert.equal(valuation.holdingQuotes[0].origin, 'refreshed');
  assert.equal(valuation.accountEquity, f.engine.s.initialCash - f.engine.s.trades[0].gross - f.engine.s.trades[0].fees.total + 1080000);
  assert.deepEqual(f.engine.s.marks.sh600000, savedMark);
});
test('持仓报价缺失且marks过期时不建仓，恢复全持仓报价后才允许买入', async t => {
  const f = fixture(t);
  f.transaction(() => f.engine.execute({ symbol: 'sh600000', side: 'buy', quantity: 1000 }, f.quote('sh600000')));
  f.advance(600000); f.omit(['sh600000']); await f.run();
  assert.equal(f.engine.s.trades.length, 1);
  const wait = f.engine.s.agency.decisions.find(d => d.action === 'wait' && d.symbol === 'sz000001'); assert.match(wait.reason, /持仓|估值/);
  f.omit([]); await f.run(); assert.equal(f.engine.s.trades.length, 2);
  assert.equal(f.engine.s.agency.decisions.find(d => d.status === 'executed').executionCheck.valuation.holdingQuotes[0].origin, 'refreshed');
});
test('成交复核阶段缺少新鲜持仓估值也不能沿用候选阶段通过的资金预算', async t => {
  const f = fixture(t);
  f.transaction(() => f.engine.execute({ symbol: 'sh600000', side: 'buy', quantity: 1000 }, f.quote('sh600000')));
  f.advance(600000); f.refreshing((_symbols, calls) => { if (calls === 2) f.omit(['sh600000']); }); await f.run();
  assert.equal(f.engine.s.trades.length, 1);
  const entry = f.engine.s.agency.decisions.find(d => d.action === 'buy' && d.status === 'blocked');
  assert.match(entry.message, /持仓|估值/); assert.equal(entry.executionCheck.buyable, false);
  assert.equal(entry.executionCheck.valuation.holdingQuotes[0].origin, 'saved-mark');
});
test('其他持仓的新价格改变策略权益与买入上限，实际成交不使用旧marks预算', async t => {
  const f = fixture(t); await f.run(); const priorTrade = f.engine.s.trades[0], oldMark = structuredClone(f.engine.s.marks.sz000001);
  assert.equal(priorTrade.quantity, 400); f.add('sh600000');
  f.transaction(() => f.engine.agencyConfigure({ strategyId: 'swing', limits: { maxPosition: 0.06072 } }));
  const cashBefore = f.engine.s.agency.groups.find(group => group.id === 'swing').cash;
  f.advance(600000); f.overrideQuote('sz000001', { price: 9.1, bid: 9.09, ask: 9.1, low: 9.1 }); await f.run();
  assert.equal(f.engine.s.trades.length, 2); const trade = f.engine.s.trades[1]; assert.equal(trade.symbol, 'sh600000'); assert.equal(trade.quantity, 200);
  const entry = f.engine.s.agency.decisions.find(d => d.tradeId === trade.id);
  assert.equal(entry.executionCheck.valuation.strategyEquity, cashBefore + 910 * priorTrade.quantity);
  assert.equal(entry.executionCheck.valuation.holdingQuotes[0].price, 9.1); assert.equal(entry.executionCheck.maxQuantity, 200);
  assert.deepEqual(f.engine.s.marks.sz000001, oldMark);
});

test('65只成员只检查20只活跃候选，45只候补保留且正常完成后仍按五分钟节流', async t => {
  const f = fixture(t), symbols = ['sz000001', ...Array.from({ length: 64 }, (_, i) => `sh${600001 + i}`)];
  f.transaction(() => { for (const symbol of symbols.slice(1)) f.engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' }); });
  f.price(9.9);
  let active = 0, peak = 0;
  f.loading(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; });
  await f.run({});
  const progress = f.service.publicState().coverage.swing;
  assert.equal(progress.total, ACTIVE_CANDIDATE_LIMIT); assert.equal(progress.processed, ACTIVE_CANDIDATE_LIMIT); assert.equal(progress.remaining, 0);
  assert.equal(f.engine.s.agency.groups.find(group => group.id === 'swing').members.filter(member => member.mode === 'standby').length, symbols.length - ACTIVE_CANDIDATE_LIMIT);
  assert.equal(peak, 3); assert.deepEqual(f.marketCalls.flat(), symbols.slice(0, ACTIVE_CANDIDATE_LIMIT));
  assert.deepEqual(f.loads.map(load => load.symbol), symbols.slice(0, ACTIVE_CANDIDATE_LIMIT)); assert.equal(f.engine.s.trades.length, 0);
  const completed = f.service.publicState().coverage.swing;
  assert.equal(completed.status, 'complete'); assert.ok(completed.completedAt);
  await f.run({}); assert.equal(f.marketCalls.length, 1);
  f.advance(300000); await f.run({}); assert.equal(f.marketCalls.length, 2);
  assert.equal(f.service.publicState().coverage.swing.cycle, completed.cycle + 1);
});

test('活跃候选全部缺行情仍完成本轮，授权变化保留当前批重检且候补不请求行情', async t => {
  const f = fixture(t), symbols = ['sz000001', ...Array.from({ length: 24 }, (_, i) => `sh${600001 + i}`)];
  f.transaction(() => { for (const symbol of symbols.slice(1)) f.engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' }); });
  f.price(9.9); f.omit(symbols.slice(0, ACTIVE_CANDIDATE_LIMIT));
  await f.run({}); assert.equal(f.service.publicState().coverage.swing.processed, ACTIVE_CANDIDATE_LIMIT);
  assert.equal(f.engine.s.agency.decisions.filter(item => item.status === 'blocked' && item.symbol).length, ACTIVE_CANDIDATE_LIMIT);
  f.advance(300000); f.omit([]);
  f.refreshing(() => f.service.invalidate());
  await f.run({}); assert.equal(f.service.publicState().coverage.swing.processed, 0);
  f.refreshing(null); await f.run();
  assert.equal(f.service.publicState().coverage.swing.processed, ACTIVE_CANDIDATE_LIMIT);
  assert.deepEqual(f.marketCalls.at(-1), symbols.slice(0, ACTIVE_CANDIDATE_LIMIT)); assert.equal(f.engine.s.trades.length, 0);
});

test('同批等待记录完整保留但只合并保存一次，日志保存失败时不推进覆盖进度', async t => {
  const prepare = () => {
    const f = fixture(t); f.price(9.9);
    f.transaction(() => { for (let i = 0; i < ACTIVE_CANDIDATE_LIMIT - 1; i++) f.engine.agencyMember({ strategyId: 'swing', symbol: `sh${600001 + i}`, action: 'add' }); });
    return f;
  };
  const f = prepare(), save = f.store.save.bind(f.store); let saves = 0;
  f.store.save = state => { saves++; return save(state); };
  await f.run({});
  assert.equal(f.engine.s.agency.decisions.filter(item => item.status === 'waiting').length, ACTIVE_CANDIDATE_LIMIT);
  assert.equal(saves, 2, '批开始并入候选核验，批完成并入等待日志，均保留原子保存');
  assert.equal(f.engine.s.agency.decisions.filter(item => item.status === 'request').length, 1);
  assert.equal(f.engine.s.agency.decisions.filter(item => item.status === 'complete').length, 1);
  assert.equal(f.service.publicState().coverage.swing.processed, ACTIVE_CANDIDATE_LIMIT);
  const failed = prepare(), safeSave = failed.store.save.bind(failed.store);
  failed.store.save = state => { if (state.agency.decisions.some(item => item.status === 'waiting')) throw Error('合并日志保存失败'); return safeSave(state); };
  await failed.run({});
  assert.equal(failed.engine.s.agency.decisions.filter(item => item.status === 'waiting').length, 0);
  assert.equal(failed.service.publicState().coverage.swing.processed, 0);
  assert.equal(failed.service.publicState().online, false); assert.match(failed.service.publicState().lastError, /保存失败/);
  const calls = failed.marketCalls.length; await failed.run({}); assert.equal(failed.marketCalls.length, calls);
});

test('停用公告筛查后新增更正撤回及查新失败不会废弃技术买点', async t => {
  const { Research } = require('../core/research.cjs');
  for (const stage of ['candidate-quote', 'execution-quote']) for (const change of ['added', 'corrected', 'withdrawn', 'failed']) {
    const f = fixture(t); let failed = false;
    let data = { items: [{ id: 'AN20260929000001', date: '2026-09-29', title: '关于召开股东大会的公告' }], total: 1 };
    const research = new Research(() => { throw Error('隔离测试不访问网络'); }, { clock: f.service.clock });
    research.fetchSection = async () => { if (failed) throw Error('隔离公告接口失败'); return structuredClone(data); };
    f.service.noticeGuard = research;
    const load = f.service.monitor.load;
    f.service.monitor.load = async (...args) => ({ ...await load(...args), notices: await research.get({ symbol: args[0], section: 'notices', force: args[1] }) });
    const invalidate = async () => {
      if (stage === 'execution-quote') assert.ok(f.service.pendingBuySymbols().includes('sz000001'));
      if (change === 'added') { data.items.push({ id: 'AN20260929000002', date: '2026-09-29', title: '新增重大诉讼公告' }); data.total++; }
      if (change === 'corrected') data.items[0].title = '原公告更正：重大诉讼风险';
      if (change === 'withdrawn') data = { items: [], total: 0 };
      if (change === 'failed') failed = true;
      await research.get({ symbol: 'sz000001', section: 'notices', force: true });
    };
    f.refreshing(async (_symbols, count) => { if (count === (stage === 'candidate-quote' ? 1 : 2)) await invalidate(); });
    await f.run();
    assert.equal(f.engine.s.trades.length, 1, `${stage}/${change}`);
    assert.equal(f.engine.s.agency.decisions.some(entry => entry.status === 'blocked' && /公告目录.*失效/.test(entry.message)), false);
    assert.deepEqual(f.service.pendingBuySymbols(), []); assert.equal(validState(f.store.load()), true);
  }
});

test('并行查新得到同一成功公告版本不误拦；生命周期日志随最后成交原子保存', async t => {
  const { Research } = require('../core/research.cjs'), f = fixture(t);
  const research = new Research(() => { throw Error('隔离测试不访问网络'); }, { clock: f.service.clock });
  research.fetchSection = async () => ({ items: [], total: 0 }); f.service.noticeGuard = research;
  const load = f.service.monitor.load;
  f.service.monitor.load = async (...args) => ({ ...await load(...args), notices: await research.get({ symbol: args[0], section: 'notices', force: args[1] }) });
  f.refreshing(async (_symbols, count) => { if (count === 2) await research.get({ symbol: 'sz000001', section: 'notices', force: true }); });
  const save = f.store.save.bind(f.store), writes = [];
  f.store.save = state => { writes.push({ trades: state.trades.length, statuses: state.agency.decisions.map(entry => entry.status) }); return save(state); };
  await f.run(); assert.equal(f.engine.s.trades.length, 1); assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].statuses, ['request']); assert.equal(writes[0].trades, 0);
  assert.ok(writes[1].statuses.includes('executed')); assert.ok(writes[1].statuses.includes('complete')); assert.equal(writes[1].trades, 1);
});

test('规则计算失败保留已保存request及error；最后完成日志保存失败回滚成交且不推进覆盖', async t => {
  const failedRules = fixture(t);
  failedRules.service.runner.evaluateRules = () => { throw Error('隔离规则失败'); };
  await failedRules.run();
  assert.ok(failedRules.store.load().agency.decisions.some(entry => entry.status === 'request'));
  assert.ok(failedRules.store.load().agency.decisions.some(entry => entry.status === 'error'));
  assert.ok(!failedRules.store.load().agency.decisions.some(entry => entry.status === 'complete'));
  assert.equal(failedRules.service.publicState().coverage.swing.processed, 0);
  const failedSave = fixture(t), save = failedSave.store.save.bind(failedSave.store), cash = failedSave.engine.s.cash;
  failedSave.store.save = state => { if (state.agency.decisions.some(entry => entry.status === 'complete')) throw Error('隔离完成日志保存失败'); return save(state); };
  await failedSave.run();
  assert.equal(failedSave.engine.s.trades.length, 0); assert.equal(failedSave.engine.s.cash, cash);
  assert.ok(failedSave.store.load().agency.decisions.some(entry => entry.status === 'request'));
  assert.ok(!failedSave.store.load().agency.decisions.some(entry => entry.status === 'complete'));
  assert.equal(failedSave.service.publicState().coverage.swing.processed, 0); assert.equal(failedSave.service.publicState().online, false);
});
