const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { AgencyService } = require('../core/agency-service.cjs');
const { EntryEvidenceStore } = require('../core/entry-evidence-store.cjs');
const { addAgencyMembers } = require('../core/agency-members.cjs');
const { cnTime } = require('../core/common.cjs');

const roeCondition = () => ({ rules: [{ field: 'roe', op: 'gt', value: 10 }] });

const priceCondition = (value = 10) => ({ rules: [{ field: 'price', op: 'gt', value }] });
function fixture(t, entryConditions = priceCondition()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-entry-conditions-'));
  t.after(() => {
    service.stop();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('guanlan-entry-conditions-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let now = Date.parse('2026-09-29T10:00:00+08:00'), price = 10.1, roe = 11, missingFinance = false;
  let loadHook = null, refreshHook = null, evidenceLoader = () => [], extraFinance = {};
  let engine = new Engine(initialState(100000), () => new Date(now));
  const store = new Store(directory), entryEvidence = new EntryEvidenceStore(path.join(directory, 'entry-evidence')), quotes = {}, loads = [], marketCalls = [], evidenceCalls = [];
  const transaction = fn => {
    const before = structuredClone(engine.s);
    try { const result = fn(); store.save(engine.s); return result; }
    catch (error) { engine.s = before; throw error; }
  };
  const quote = symbol => ({ symbol, name: '持续开仓条件隔离测试', source: 'test', price, prevClose: 10.05, open: 10, low: 10,
    high: Math.max(10.2, price), volume: 100000, bid: price - 0.01, ask: price, bidSize: 20000, askSize: 20000,
    limitUp: 11.05, limitDown: 9.05, timestamp: now, date: cnTime(now).date });
  const snapshot = symbol => {
    const asOf = cnTime(now - 86400000).date;
    return { source: 'test daily', fetchedAt: now,
      notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now, data: { items: [], total: 0 } },
      technical: { asOf, close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, previousMa20: 9.9, previousMa60: 9.4,
        atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false, support: 9.7,
        resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: [asOf] },
      ...(missingFinance ? {} : { finance: { symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: now,
        data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', updateDate: '2026-08-20', currency: 'CNY', roe, ...extraFinance } } } }) };
  };
  const market = { quotes: async symbols => {
    marketCalls.push([...symbols]);
    if (refreshHook) await refreshHook(symbols, marketCalls.length);
    return Object.fromEntries(symbols.map(symbol => [symbol, quote(symbol)]));
  } };
  const createService = () => new AgencyService({ getEngine: () => engine, transaction, market,
    archiveEntryEvidence: payload => entryEvidence.archive(payload),
    getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch), clock: () => now,
    getSelectionEvidence: symbol => { evidenceCalls.push(symbol); return evidenceLoader(symbol); },
    monitor: {
      snapshots: {},
      load: async (symbol, force, financial, notices) => {
        loads.push({ symbol, force, financial, notices });
        if (loadHook) await loadHook(symbol, loads.length);
        return snapshot(symbol);
      },
      async prepare(symbol, financial, notices) { return this.snapshots[symbol] = structuredClone(await this.load(symbol, false, financial, notices)); },
      readPrepared(symbol) { if (!this.snapshots[symbol]) throw Error('开仓资料未就绪：尚未准备'); return structuredClone(this.snapshots[symbol]); },
      assertPrepared(symbol, value) {
        const current = this.readPrepared(symbol);
        for (const key of ['technical']) if (JSON.stringify(current[key]) !== JSON.stringify(value[key])) throw Error('开仓资料未就绪：已准备资料发生变化');
        return value;
      }
    } });
  let service = createService();
  transaction(() => {
    engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
    engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'add', ...(entryConditions ? { entryConditions } : {}) });
    engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  });
  // Prepare fixture inputs before running the trading lane; production schedules
  // these independently. Tests can use poll() alone to assert that separation.
  const prepare = async () => {
    for (const group of service.groups().filter(group => group.enabled)) {
      const cycle = service.cycles.get(group.id);
      for (const symbol of cycle.symbols) await service.prepareEntry(symbol, group.id);
    }
  };
  const poll = async () => { await service.poll({ force: true }); await service.runner.drain(); };
  return { get engine() { return engine; }, get service() { return service; }, store, entryEvidence, transaction, quote, snapshot, loads, marketCalls, evidenceCalls, prepare, poll,
    publishSnapshot: (symbol = 'sz000001', value = snapshot(symbol)) => { service.monitor.snapshots[symbol] = structuredClone(value); },
    member: (symbol = 'sz000001') => engine.s.agency.groups.find(group => group.id === 'swing').members.find(member => member.symbol === symbol),
    run: async () => { await prepare(); await poll(); },
    addBatch: (symbols, conditions) => addAgencyMembers({ strategyId: 'swing', symbols, entryConditions: conditions },
      { getEngine: () => engine, transaction, market, acceptQuotes: batch => Object.assign(quotes, batch) }),
    roe: value => { roe = value; }, finance: value => { extraFinance = value; }, missingFinance: value => { missingFinance = value; }, price: value => { price = value; },
    loading: callback => { loadHook = callback; }, refreshing: callback => { refreshHook = callback; },
    evidence: callback => { evidenceLoader = callback; }, setTime: value => { now = Date.parse(value); },
    restart: () => { service.stop(); engine = new Engine(store.load(), () => new Date(now)); service = createService(); } };
}

test('行情条件冻结当次输入，重复加入和重启不放宽已保存条件', async t => {
  const input = priceCondition(), f = fixture(t, input), saved = structuredClone(f.member().entryConditions);
  assert.equal(saved.version, 1); assert.ok(saved.savedAt); assert.ok(saved.labels.some(label => /最新价/.test(label)));
  input.rules[0].value = 0;
  const returned = f.transaction(() => f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'add', entryConditions: input }));
  returned.entryConditions.rules[0].value = 100;
  assert.deepEqual(f.member().entryConditions, saved);
  f.restart(); assert.deepEqual(f.member().entryConditions, saved); assert.equal(validState(f.store.load()), true);
  f.price(9.9); await f.run(); assert.equal(f.engine.s.trades.length, 0);
});

test('批量加入保留技术条件并剔除财务研究，等待行情时修改输入不改变已捕获条件', async t => {
  const f = fixture(t), input = { rules: [...priceCondition().rules, ...roeCondition().rules], evidence: { conditions: ['demand'] } };
  f.refreshing(() => { input.rules[0].value = 0; });
  const result = await f.addBatch(['000001', '600000', '600001'], input);
  assert.deepEqual(result.added, ['sh600000', 'sh600001']); assert.equal(result.skipped.length, 1);
  for (const symbol of ['sz000001', 'sh600000', 'sh600001']) assert.deepEqual(f.member(symbol).entryConditions.rules, priceCondition().rules);
  assert.notEqual(f.member('sh600000').entryConditions.rules, f.member('sh600001').entryConditions.rules);
  f.refreshing(null); f.restart(); assert.equal(validState(f.store.load()), true);
});

test('内置波段通过仍须满足附加行情条件，更新报价后才可开仓', async t => {
  const f = fixture(t, priceCondition(10.11));
  const blocked = f.engine.agencyEvaluate('swing', 'sz000001', f.quote('sz000001'), f.snapshot('sz000001'));
  assert.equal(blocked.buyable, false); assert.equal(blocked.entryConditionsCheck.passed, false); assert.match(blocked.reasons.join('；'), /最新价/);
  await f.run(); assert.equal(f.engine.s.trades.length, 0);
  f.price(10.12); await f.run(); assert.equal(f.engine.s.trades.length, 1);
  assert.ok(f.loads.every(load => load.financial === false && load.notices === false));
  const executed = f.engine.s.agency.decisions.find(decision => decision.status === 'executed');
  assert.equal(executed.executionCheck.entryConditionsCheck.passed, true);
});

test('研究和财务条件全部停用，缺失财报及正文接口抛错均不阻断首次开仓', async t => {
  const inputs = [roeCondition(), { rules: [{ field: 'pe', op: 'lt', value: 10 }] },
    { evidence: { conditions: ['demand'] } }, { research: { version: 1, enabled: true, path: 'company', rules: [{ field: 'revenueYoY', op: 'gt', value: 0 }] } },
    { research: { version: 1, enabled: true, path: 'product', rules: [{ field: 'currentRevenue', op: 'gt', value: 100000 }] } }];
  for (const conditions of inputs) {
    const f = fixture(t, conditions); f.missingFinance(true); let calls = 0;
    const disabled = () => { calls++; throw Error('已取消的研究服务不能调用'); };
    f.service.getAutomaticEvidence = disabled; f.service.getNoticeEvidence = disabled; f.service.getSelectionEvidence = disabled;
    assert.equal(f.member().entryConditions, undefined);
    await f.run(); assert.equal(f.engine.s.trades.length, 1); assert.equal(calls, 0);
    assert.ok(f.loads.every(load => load.financial === false && load.notices === false));
    assert.equal(validState(f.store.load()), true);
  }
});

test('财务和公告快照变化不撤销技术买点，日线变化仍在成交前阻断', async t => {
  for (const part of ['finance', 'notices', 'technical']) {
    const f = fixture(t);
    f.refreshing((_symbols, calls) => {
      if (calls !== 2) return;
      const next = f.snapshot('sz000001');
      if (part === 'technical') next.technical.ma20 = 20;
      else next[part] = { status: 'unavailable', error: '接口失败' };
      f.publishSnapshot('sz000001', next);
    });
    await f.run(); assert.equal(f.engine.s.trades.length, part === 'technical' ? 0 : 1, part);
    assert.equal(f.loads.length, 1, '成交前只本地核验已准备资料');
  }
});

test('技术附加条件数据缺失不得默认为通过，补齐后重新检查', async t => {
  const f = fixture(t, { rules: [{ field: 'rsi', op: 'gt', value: 50 }] });
  const load = f.service.monitor.load; let missing = true;
  f.service.monitor.load = async (...args) => { const snapshot = await load(...args); if (missing) delete snapshot.technical.rsi; return snapshot; };
  await f.run(); assert.equal(f.engine.s.trades.length, 0);
  missing = false; await f.run(); assert.equal(f.engine.s.trades.length, 1);
});

test('持仓技术条件失效只作提示，退出仍按原计划和 T+1 管理', async t => {
  const f = fixture(t); await f.run(); const quantity = f.engine.s.lots[0].quantity, risk = structuredClone(f.engine.s.risks.sz000001);
  f.price(9.9); await f.run();
  assert.equal(f.engine.s.trades.length, 1); assert.equal(f.engine.s.lots[0].quantity, quantity);
  assert.deepEqual(f.engine.s.risks.sz000001, risk); assert.equal(f.engine.s.agency.executionIntents.length, 0);
  const hold = f.engine.s.agency.decisions.find(decision => decision.action === 'hold');
  assert.equal(hold.entryConditionsCheck.passed, false); assert.match(hold.reason, /最新价/);
  f.price(9.5); f.transaction(() => f.engine.tick({ sz000001: f.quote('sz000001') }, { sz000001: f.snapshot('sz000001') }));
  assert.equal(f.engine.s.trades.length, 1);
  f.setTime('2026-09-30T10:00:00+08:00');
  f.transaction(() => f.engine.tick({ sz000001: f.quote('sz000001') }, { sz000001: f.snapshot('sz000001') }));
  assert.equal(f.engine.s.trades[1].side, 'sell');
});

test('直接成交与手动策略接口不能绕过已保存的行情条件', t => {
  const f = fixture(t, priceCondition(10.2)), quote = f.quote('sz000001'), snapshot = f.snapshot('sz000001');
  const executeAutomatic = () => f.engine.agencyExecute({ strategyId: 'swing', symbol: 'sz000001', action: 'buy', targetPercent: 20,
    decisionId: 'isolated-direct-entry', expectedEpoch: f.engine.s.agency.epoch, expectedRevision: f.engine.s.agency.revision }, quote, snapshot);
  assert.throws(() => f.transaction(executeAutomatic), /最新价/);
  assert.throws(() => f.transaction(() => f.engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 100 }, quote)), /已授权策略自动交易/);
  assert.throws(() => f.transaction(() => f.engine.strategyEntry({ symbol: 'sz000001', strategyId: 'swing', quantity: 100 }, quote, snapshot)), /已授权策略自动交易/);
  assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.lots.length, 0);
});

test('旧 v7 研究条件留档并迁移为技术条件，资金成交保留且旧版本不得读取新状态', t => {
  const f = fixture(t, null), old = structuredClone(f.engine.s);
  old.agency.version = 7; delete old.agency.technicalTradingVersion;
  const original = require('../core/entry-conditions.cjs').createEntryConditions({ rules: [...priceCondition().rules, ...roeCondition().rules], evidence: { conditions: ['demand'] } }, f.engine.clock());
  old.agency.groups.find(group => group.id === 'swing').members[0].entryConditions = original;
  assert.equal(validState(old), true);
  const migrated = new Engine(old, f.engine.clock), member = migrated.s.agency.groups.find(group => group.id === 'swing').members[0];
  assert.equal(migrated.s.agency.version, 8); assert.deepEqual(member.legacyResearchConditions, original);
  assert.deepEqual(member.entryConditions.rules, priceCondition().rules); assert.equal(member.entryConditions.evidence, undefined);
  assert.equal(migrated.s.cash, f.engine.s.cash); assert.deepEqual(migrated.s.trades, f.engine.s.trades);
  for (const mutate of [state => { state.agency.version = 7; }, state => { state.agency.technicalTradingVersion = 99; },
    state => { state.agency.groups.find(group => group.id === 'swing').members[0].legacyResearchConditions.rules[0].value = 'bad'; }]) {
    const invalid = structuredClone(migrated.s); mutate(invalid); assert.equal(validState(invalid), false); assert.throws(() => new Engine(invalid), /账户数据格式/);
  }
});

test('后台准备、候选报价和执行报价等待期间暂停策略都撤销开仓权限', async t => {
  for (const phase of ['preparation', 'candidate-quote', 'execution-quote']) {
    const f = fixture(t), pause = () => f.transaction(() => f.engine.agencyMode({ strategyId: 'swing', mode: 'paused' }));
    if (phase === 'preparation') f.loading(pause);
    else f.refreshing((_symbols, calls) => { if (calls === (phase === 'candidate-quote' ? 1 : 2)) pause(); });
    await f.run(); assert.equal(f.engine.s.trades.length, 0, phase);
    assert.equal(f.engine.s.agency.groups.find(group => group.id === 'swing').mode, 'paused');
  }
});

test('技术成交依据仍在写盘后关联成交持仓及周期，独立读取不能改写冻结快照', async t => {
  const f = fixture(t), conditions = structuredClone(f.member().entryConditions), archive = f.service.archiveEntryEvidence;
  f.service.archiveEntryEvidence = payload => { assert.equal(f.engine.s.trades.length, 0); return archive(payload); };
  await f.run();
  const trade = f.engine.s.trades[0], ref = trade.entryEvidenceRef, saved = f.entryEvidence.read(ref);
  assert.equal(trade.entryEvidenceRequired, true); assert.deepEqual(f.engine.s.lots[0].entryEvidenceRef, ref);
  assert.deepEqual(f.engine.s.agency.groups.find(group => group.id === 'swing').cycles[0].entryEvidenceRef, ref);
  assert.deepEqual(saved.entryConditions, conditions); assert.equal(saved.execution.quantity, trade.quantity);
  assert.equal(saved.snapshot.automaticEvidence, undefined);
  saved.snapshot.technical.close = 1; assert.equal(f.entryEvidence.read(ref).snapshot.technical.close, 10.05);
  assert.equal(f.entryEvidence.auditAccount(f.store.load()).verified, 1);
});

test('配置的成交归档写盘失败或返回无效引用时不消耗资金和盘口', async t => {
  for (const archive of [() => { throw Error('永久目录只读'); }, async () => { throw Error('错误异步归档'); }, () => ({ version: 1, hash: '0'.repeat(64) })]) {
    const f = fixture(t); f.service.archiveEntryEvidence = archive; const before = structuredClone(f.engine.s);
    await f.run(); assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.lots.length, 0);
    assert.equal(f.engine.s.cash, before.cash); assert.deepEqual(f.engine.s.consumed, before.consumed);
    assert.equal(f.store.load().trades.length, 0);
  }
});

test('归档后账户保存失败回滚成交并停止服务，孤立依据仍可审计', async t => {
  const f = fixture(t), save = f.store.save.bind(f.store); let ref;
  f.service.archiveEntryEvidence = payload => (ref = f.entryEvidence.archive(payload));
  f.store.save = state => { if (state.trades.length) throw Error('归档后的账户保存失败'); return save(state); };
  await f.run(); assert.ok(ref); assert.equal(f.entryEvidence.read(ref).symbol, 'sz000001');
  assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.cash, 10000000); assert.deepEqual(f.engine.s.consumed, {});
  assert.match(f.service.storageError, /账户保存失败/);
});

test('清仓和移除成员保留原成交依据，归档服务故障不阻断退出', async t => {
  const f = fixture(t); await f.run(); const ref = structuredClone(f.engine.s.trades[0].entryEvidenceRef);
  f.service.archiveEntryEvidence = () => { throw Error('退出不应归档'); };
  f.setTime('2026-09-30T10:00:00+08:00'); f.price(9.5);
  f.transaction(() => f.engine.tick({ sz000001: f.quote('sz000001') }, { sz000001: f.snapshot('sz000001') }));
  f.transaction(() => { f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'remove' });
    for (let index = 0; index < 520; index++) f.engine.agencyLog({ status: 'waiting', message: '滚动日志' }); });
  assert.equal(f.engine.s.trades[1].side, 'sell'); assert.equal(f.engine.s.lots.length, 0); assert.equal(f.member(), undefined);
  assert.deepEqual(f.engine.s.trades[0].entryEvidenceRef, ref); assert.equal(f.entryEvidence.auditAccount(f.store.load()).verified, 1);
});

test('技术成交依据可备份到另一目录，丢失或串股引用不能静默通过账户校验', async t => {
  const f = fixture(t); await f.run(); const backup = f.entryEvidence.exportAccount(f.engine.s);
  const restored = new EntryEvidenceStore(path.join(path.dirname(f.store.file), 'restored-evidence'));
  assert.equal(restored.auditAccount(f.engine.s).status, 'missing');
  const account = restored.importAccount(backup); assert.equal(validState(account), true); assert.deepEqual(account, f.engine.s);
  assert.equal(restored.auditAccount(account).verified, 1);
  const missing = structuredClone(account); delete missing.trades[0].entryEvidenceRef; assert.equal(validState(missing), false);
  const wrong = structuredClone(account); wrong.trades[0].entryEvidenceRef.symbol = 'sh600519'; assert.equal(validState(wrong), false);
});

test('科创板缺选股专用指标的截断报价不能把股当手放大成交量并通过门禁', () => {
  const { parseQuotes } = require('../core/market-parsers.cjs');
  const { createEntryConditions, evaluateEntryConditions } = require('../core/entry-conditions.cjs');
  const now = new Date('2026-09-29T10:00:00+08:00'), fields = Array(53).fill('');
  Object.assign(fields, { 0: '1', 1: '隔离科创样本', 2: '688001', 3: '10', 4: '10', 5: '10', 6: '2000000',
    9: '10', 10: '1000', 19: '10', 20: '1000', 30: '20260929100000', 31: '0', 32: '0', 33: '10', 34: '10',
    36: '2000000', 37: '2000', 38: '1', 47: '12', 48: '8' });
  const quote = parseQuotes(`v_sh688001="${fields.join('~')}";`, now.getTime()).sh688001;
  assert.equal(quote.screeningMetrics, undefined);
  const conditions = createEntryConditions({ rules: [{ field: 'volume', op: 'gt', value: 10 }] }, now);
  const check = evaluateEntryConditions(conditions, 'sh688001', quote, {}, now);
  assert.equal(check.passed, false, '2,000,000 股只有 2 万手，不能通过成交量大于 10 万手；口径未核验也不得放行');
});

test('真实腾讯解析器贯通科创板股单位、动态 PE 和盘中量比，不与完整日量比混用', () => {
  const { parseQuotes } = require('../core/market-parsers.cjs');
  const { createEntryConditions, evaluateEntryConditions } = require('../core/entry-conditions.cjs');
  const now = new Date('2026-09-29T10:00:00+08:00'), fields = Array(88).fill('');
  Object.assign(fields, { 0: '1', 1: '隔离科创样本', 2: '688001', 3: '10', 4: '10', 5: '10', 6: '2000000',
    9: '10', 10: '1000', 19: '10', 20: '1000', 30: '20260929100000', 31: '0', 32: '0', 33: '10', 34: '10',
    36: '2000000', 37: '2000', 38: '1', 39: '99', 47: '12', 48: '8', 49: '1.2', 52: '15', 61: 'GP-A-KCB' });
  const quote = parseQuotes(`v_sh688001="${fields.join('~')}";`, now.getTime()).sh688001;
  assert.equal(quote.pe, 99); assert.equal(quote.screeningMetrics.pe, 15); assert.equal(quote.screeningMetrics.volume, 2);
  const snapshot = { fetchedAt: now.getTime(), technical: { asOf: '2026-09-28', close: 10, volumeRatio: 0.5 } };
  const rules = [{ field: 'volume', op: 'lt', value: 10 }, { field: 'pe', op: 'lt', value: 20 },
    { field: 'volumeRatio', op: 'gt', value: 1 }, { field: 'dailyVolumeRatio', op: 'lt', value: 1 }];
  const check = evaluateEntryConditions(createEntryConditions({ rules }, now), 'sh688001', quote, snapshot, now);
  assert.equal(check.passed, true, check.reasons.join('；'));
});

test('旧渲染器不能通过单只加入接口人工指定股票，拒绝前不请求行情或改写条件', () => {
  const vm = require('node:vm');
  const { symbolOf } = require('../core/common.cjs');
  const mainPath = path.join(__dirname, '../main.cjs'), source = fs.readFileSync(mainPath, 'utf8');
  const start = source.indexOf("  handler('agency:member',"), end = source.indexOf("  handler('agency:reconcile',", start);
  assert.ok(start >= 0 && end > start);
  const now = new Date('2026-09-29T10:00:00+08:00'); let add;
  // Execute the actual IPC callback against in-memory dependencies. Electron,
  // network access and user account paths are never loaded by this test.
  const context = vm.createContext({ symbolOf, structuredClone,
    handler: (_name, callback) => { add = callback; }, engine: new Engine(initialState(100000), () => now), quotes: {},
    market: { quotes: () => { throw Error('拒绝人工加入前不得查询行情'); } }, transaction: () => { throw Error('拒绝人工加入前不得改写账户'); },
    publish: () => { throw Error('拒绝人工加入前不得广播'); }, monitor: { load: () => { throw Error('拒绝人工加入前不得准备资料'); } } });
  vm.runInContext(source.slice(start, end), context, { filename: mainPath });
  const before = structuredClone(context.engine.s);
  assert.throws(() => add({ strategyId: 'swing', symbol: '000001', action: 'add', entryConditions: roeCondition() }), /只由策略筛选生成候选/);
  assert.deepEqual(context.engine.s, before);
  assert.equal(context.engine.s.agency.groups.flatMap(group => group.members).length, 0);
  assert.equal(Object.keys(context.engine.s.marks).length, 0); assert.equal(Object.keys(context.quotes).length, 0);
});
