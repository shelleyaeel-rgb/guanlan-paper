const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { AgencyService } = require('../core/agency-service.cjs');
const { EntryEvidenceStore } = require('../core/entry-evidence-store.cjs');
const { addAgencyMembers } = require('../core/agency-members.cjs');
const { cnTime } = require('../core/common.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');

const roeCondition = () => ({ rules: [{ field: 'roe', op: 'gt', value: 10 }] });
const demandEvidence = value => ({ symbol: 'sz000001', kind: 'demand', value, subject: '隔离产品', reviewState: 'confirmed',
  sourceTitle: '隔离证据样本', url: 'https://example.com/report', publishedAt: '2026-04-01', period: '2025年度',
  reviewedAt: '2026-05-01', validUntil: '2027-05-01', quote: '可核实的测试事实', notes: '' });

function fixture(t, entryConditions = roeCondition()) {
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
    monitor: { load: async (symbol, force, financial, notices) => {
      loads.push({ symbol, force, financial, notices });
      if (loadHook) await loadHook(symbol, loads.length);
      return snapshot(symbol);
    } } });
  let service = createService();
  transaction(() => {
    engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
    engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'add', ...(entryConditions ? { entryConditions } : {}) });
    engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  });
  return { get engine() { return engine; }, get service() { return service; }, store, entryEvidence, transaction, quote, snapshot, loads, marketCalls, evidenceCalls,
    member: (symbol = 'sz000001') => engine.s.agency.groups.find(group => group.id === 'swing').members.find(member => member.symbol === symbol),
    run: async () => { await service.poll({ force: true }); await service.runner.drain(); },
    addBatch: (symbols, conditions) => addAgencyMembers({ strategyId: 'swing', symbols, entryConditions: conditions },
      { getEngine: () => engine, transaction, market, acceptQuotes: batch => Object.assign(quotes, batch) }),
    roe: value => { roe = value; }, finance: value => { extraFinance = value; }, missingFinance: value => { missingFinance = value; }, price: value => { price = value; },
    loading: callback => { loadHook = callback; }, refreshing: callback => { refreshHook = callback; },
    evidence: callback => { evidenceLoader = callback; }, setTime: value => { now = Date.parse(value); },
    restart: () => { service.stop(); engine = new Engine(store.load(), () => new Date(now)); service = createService(); } };
}

test('单只加入冻结当次条件，调用方修改、重复加入和重启都不改写原条件', async t => {
  const input = roeCondition(), f = fixture(t, input), saved = structuredClone(f.member().entryConditions);
  assert.equal(saved.version, 1); assert.ok(saved.savedAt); assert.ok(saved.labels.some(label => /ROE|净资产收益率/.test(label)));
  input.rules[0].value = 0;
  const returned = f.transaction(() => f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'add', entryConditions: input }));
  returned.entryConditions.rules[0].value = 100;
  assert.deepEqual(f.member().entryConditions, saved);
  f.restart(); assert.deepEqual(f.member().entryConditions, saved); assert.equal(validState(f.store.load()), true);
  f.roe(9); await f.run(); assert.equal(f.engine.s.trades.length, 0);
});

test('批量成员各自保存同次条件，等待行情时编辑输入和重复加入不会放宽已有成员', async t => {
  const f = fixture(t), input = roeCondition();
  f.refreshing(() => { input.rules[0].value = 0; });
  const result = await f.addBatch(['000001', '600000', '600001'], input);
  assert.deepEqual(result.added, ['sh600000', 'sh600001']); assert.equal(result.skipped.length, 1);
  for (const symbol of ['sz000001', 'sh600000', 'sh600001']) assert.equal(f.member(symbol).entryConditions.rules[0].value, 10);
  const first = f.member('sh600000').entryConditions, second = f.member('sh600001').entryConditions;
  assert.notEqual(first, second); assert.notEqual(first.rules, second.rules);
  f.refreshing(null); f.restart();
  for (const symbol of ['sz000001', 'sh600000', 'sh600001']) assert.equal(f.member(symbol).entryConditions.rules[0].value, 10);
});

test('波段内置条件通过仍受追加 ROE 门禁约束，最新财报达标后才能开仓', async t => {
  const f = fixture(t); f.roe(9);
  const blocked = f.engine.agencyEvaluate('swing', 'sz000001', f.quote('sz000001'), f.snapshot('sz000001'));
  assert.equal(blocked.buyable, false); assert.ok(blocked.entryConditionsCheck); assert.match(blocked.reasons.join('；'), /ROE|净资产收益率/);
  await f.run(); assert.equal(f.engine.s.trades.length, 0);
  assert.ok(f.engine.s.agency.decisions.some(decision => decision.action === 'wait' && /ROE|净资产收益率/.test(decision.reason)));
  f.roe(11); await f.run(); assert.equal(f.engine.s.trades.length, 1); assert.equal(f.engine.s.trades[0].side, 'buy');
  assert.ok(f.loads.length >= 3); assert.ok(f.loads.every(load => load.financial === true), '追加财务条件后波段也必须重新读取财务');
  const executed = f.engine.s.agency.decisions.find(decision => decision.status === 'executed');
  assert.ok(executed.entryConditionsCheck); assert.ok(executed.executionCheck.entryConditionsCheck);
});

test('内置买点未满足也保留额外条件检查及具体差距', t => {
  const f = fixture(t); f.price(9.9); f.roe(9);
  const evaluation = f.engine.agencyEvaluate('swing', 'sz000001', f.quote('sz000001'), f.snapshot('sz000001'));
  assert.equal(evaluation.buyable, false); assert.ok(evaluation.entryConditionsCheck);
  assert.match(evaluation.reasons.join('；'), /ROE|净资产收益率/);
});

test('执行前最新财务不再达标或缺失，已通过的买入意向也不得成交', async t => {
  for (const change of ['lower', 'missing']) {
    const f = fixture(t);
    f.loading((_symbol, calls) => { if (calls === 2) { if (change === 'lower') f.roe(9); else f.missingFinance(true); } });
    await f.run(); assert.equal(f.engine.s.trades.length, 0, change);
    const decision = f.engine.s.agency.decisions.find(item => item.action === 'buy' && item.status === 'blocked');
    assert.ok(decision, change); assert.equal(decision.executionCheck.buyable, false); assert.ok(decision.executionCheck.entryConditionsCheck);
    assert.equal(f.engine.s.agency.executionIntents.length, 0);
  }
});

test('缺失追加条件数据时不默认为通过，补齐后下一轮重新检查', async t => {
  const f = fixture(t); f.missingFinance(true); await f.run(); assert.equal(f.engine.s.trades.length, 0);
  assert.ok(f.engine.s.agency.decisions.some(decision => decision.action === 'wait'));
  f.missingFinance(false); await f.run(); assert.equal(f.engine.s.trades.length, 1);
});

test('已有持仓的附加条件失效只提示，退出仍由原计划及 T+1 管理', async t => {
  const f = fixture(t); await f.run(); const quantity = f.engine.s.lots[0].quantity, originalRisk = structuredClone(f.engine.s.risks.sz000001);
  f.roe(9); await f.run();
  assert.equal(f.engine.s.trades.length, 1); assert.equal(f.engine.s.lots[0].quantity, quantity);
  assert.equal(f.engine.s.agency.executionIntents.length, 0); assert.deepEqual(f.engine.s.risks.sz000001, originalRisk);
  const hold = f.engine.s.agency.decisions.find(decision => decision.action === 'hold');
  assert.ok(hold.entryConditionsCheck); assert.match(hold.reason, /ROE|净资产收益率/);
  f.price(9.5); f.transaction(() => f.engine.tick({ sz000001: f.quote('sz000001') }, { sz000001: f.snapshot('sz000001') }));
  assert.equal(f.engine.s.trades.length, 1);
  f.setTime('2026-09-30T10:00:00+08:00');
  f.transaction(() => f.engine.tick({ sz000001: f.quote('sz000001') }, { sz000001: f.snapshot('sz000001') }));
  assert.equal(f.engine.s.trades.length, 2); assert.equal(f.engine.s.trades[1].side, 'sell');
});

test('未保存选股条件的旧成员仍按内置策略正常开仓', async t => {
  const f = fixture(t, null); f.missingFinance(true); f.restart(); await f.run();
  assert.equal(f.engine.s.trades.length, 1); assert.ok(f.loads.every(load => load.financial === false));
});

test('直接成交与手动策略接口不能绕过已保存的附加新开仓条件', t => {
  const f = fixture(t); f.roe(9); const quote = f.quote('sz000001'), snapshot = f.snapshot('sz000001');
  const executeAutomatic = () => {
    const { epoch, revision } = f.engine.s.agency;
    return f.engine.agencyExecute({ strategyId: 'swing', symbol: 'sz000001', action: 'buy', targetPercent: 20,
      decisionId: 'isolated-direct-entry', expectedEpoch: epoch, expectedRevision: revision }, quote, snapshot);
  };
  assert.throws(() => f.transaction(executeAutomatic), /ROE|净资产收益率/);
  assert.throws(() => f.transaction(() => f.engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 100 }, quote)), /已授权策略自动交易/);
  assert.throws(() => f.transaction(() => f.engine.strategyEntry({ symbol: 'sz000001', strategyId: 'swing', quantity: 100 }, quote, snapshot)), /已授权策略自动交易/);
  assert.throws(() => f.transaction(() => f.engine.place({ symbol: 'sz000001', side: 'buy', quantity: 100, limit: 10.1 })), /不能添加手动委托/);
  assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.orders.length, 0); assert.equal(f.engine.s.lots.length, 0);
});

test('旧 v2 账户迁移保留资金和成员，新条件禁止降级到旧版本或静默丢失', t => {
  const legacy = fixture(t, null), old = structuredClone(legacy.engine.s);
  old.agency.version = 2; delete old.agency.entryConditionsVersion; delete old.agency.monitoringVersion;
  delete old.agency.poolVersion; delete old.agency.pool; delete old.agency.poolAuthorizationRevision;
  assert.equal(validState(old), true);
  const migrated = new Engine(old, () => new Date('2026-09-29T10:00:00+08:00'));
  assert.equal(migrated.s.agency.version, 5); assert.equal(migrated.s.agency.entryConditionsVersion, 1);
  assert.equal(migrated.s.cash, legacy.engine.s.cash);
  assert.deepEqual(migrated.s.agency.groups, legacy.engine.s.agency.groups);
  const current = fixture(t), before = structuredClone(current.engine.s);
  for (const change of [state => { state.agency.version = 2; delete state.agency.entryConditionsVersion; },
    state => { state.agency.entryConditionsVersion = 99; },
    state => { state.agency.groups.find(group => group.id === 'swing').members[0].entryConditions.rules[0].value = 'bad'; }]) {
    const invalid = structuredClone(before); change(invalid);
    assert.equal(validState(invalid), false); assert.throws(() => new Engine(invalid), /账户数据格式不正确/);
  }
});

test('候选和执行阶段每次异步取数后都重新检查授权，追加规则不能恢复暂停权限', async t => {
  for (const phase of ['candidate-data', 'candidate-quote', 'execution-data', 'execution-quote']) {
    const f = fixture(t), pause = () => f.transaction(() => f.engine.agencyMode({ strategyId: 'swing', mode: 'paused' }));
    if (phase.endsWith('data')) f.loading((_symbol, calls) => { if (calls === (phase.startsWith('candidate') ? 1 : 2)) pause(); });
    else f.refreshing((_symbols, calls) => { if (calls === (phase.startsWith('candidate') ? 1 : 2)) pause(); });
    await f.run(); assert.equal(f.engine.s.trades.length, 0, phase);
    assert.equal(f.engine.s.agency.groups.find(group => group.id === 'swing').mode, 'paused', phase);
    assert.ok(f.engine.s.agency.decisions.some(decision => decision.status === 'stale'), phase);
  }
});

test('证据条件保存条件定义，每轮从当前证据库重读，不冻结选股时肯定结论', async t => {
  const f = fixture(t, { rules: [], evidence: { conditions: ['demand'] } });
  let current = [demandEvidence('unsupported')]; f.evidence(() => current);
  await f.run(); assert.equal(f.engine.s.trades.length, 0);
  current = [demandEvidence('supported')]; await f.run(); assert.equal(f.engine.s.trades.length, 1);
  assert.ok(f.evidenceCalls.length >= 3); assert.ok(f.evidenceCalls.every(symbol => symbol === 'sz000001'));
});

test('自动研究条件无需人工记录即可通过，执行前重新取得正文并复算，缺失则拦截', async t => {
  for (const revoke of [false, true]) {
    const f = fixture(t, { rules: [], evidence: { conditions: ['productOutlook', 'financialReview'], leadership: 'either', minSegmentRevenuePct: 30 }, source: { kind: 'agency-pool', policyVersion: 2 } });
    let calls = 0;
    f.evidence(() => { throw Error('自动路径不能读取人工库'); });
    f.service.getAutomaticEvidence = async symbol => {
      calls++;
      const now = new Date('2026-09-29T10:00:00+08:00');
      return revoke && calls > 1 ? { symbol, checkedAt: now.getTime(), status: 'unavailable', documents: [], errors: ['执行前资料失效'] } : companyBundle(symbol, now);
    };
    await f.run();
    assert.ok(calls >= 2); assert.equal(f.evidenceCalls.length, 0);
    assert.equal(f.engine.s.trades.length, revoke ? 0 : 1);
    const decision = f.engine.s.agency.decisions.find(item => item.action === 'buy');
    assert.equal(decision.status, revoke ? 'blocked' : 'executed');
    assert.ok(decision.executionCheck.entryConditionsCheck);
  }
});

test('自动资料不能借用人工通过记录或保存的肯定结论，旧检查时间和串股均阻断', () => {
  const { createEntryConditions, evaluateEntryConditions } = require('../core/entry-conditions.cjs');
  const now = new Date('2026-09-29T10:00:00+08:00'), symbol = 'sz000001';
  const saved = createEntryConditions({ rules: [], evidence: { conditions: ['demand'] }, source: { kind: 'agency-pool', policyVersion: 2 } }, now);
  for (const bundle of [null, { ...companyBundle(symbol, now), checkedAt: now.getTime() - 21600001 }, companyBundle('sh600001', now)]) {
    const checked = evaluateEntryConditions(saved, symbol, {}, { automaticEvidence: bundle, selectionEvidence: { checkedAt: now.getTime(), records: [demandEvidence('supported')] } }, now);
    assert.equal(checked.status, 'pending');
  }
});

function automaticArchiveFixture(t) {
  const f = fixture(t, { rules: [], evidence: { conditions: ['productOutlook', 'financialReview'], leadership: 'either', minSegmentRevenuePct: 30 }, source: { kind: 'agency-pool', policyVersion: 2 } });
  f.service.getAutomaticEvidence = async symbol => companyBundle(symbol, new Date('2026-09-29T10:00:00+08:00'));
  return f;
}

test('公司经营条件保存重启后仍复核；不取产品文档，候选通过后数值撤销也不能开仓', async t => {
  for (const revoke of [false, true]) {
    const research = { version: 1, enabled: true, path: 'company', rules: [{ field: 'revenueYoY', op: 'gt', value: 0 }] };
    const f = fixture(t, { research }); f.finance({ revenueYoY: 10 });
    f.restart(); assert.deepEqual(f.member().entryConditions.research, research);
    f.service.getAutomaticEvidence = () => { throw Error('公司指标不应获取产品报告'); };
    if (revoke) f.loading((_symbol, calls) => { if (calls === 2) f.finance({ revenueYoY: -10 }); });
    await f.run();
    assert.equal(f.engine.s.trades.length, revoke ? 0 : 1);
    assert.ok(f.loads.every(call => call.financial));
    const decision = f.engine.s.agency.decisions.find(item => item.action === 'buy');
    assert.equal(decision.status, revoke ? 'blocked' : 'executed');
    assert.equal(decision.executionCheck.entryConditionsCheck.researchReview.status, revoke ? 'failed' : 'pass');
  }
});

test('经营条件和已有个人研究条件同时生效，不能用公司通过抵消个人缺项', async t => {
  const f = fixture(t, { research: { version: 1, enabled: true, path: 'company', rules: [{ field: 'revenueYoY', op: 'gt', value: 0 }] }, evidence: { conditions: ['demand'] } });
  f.finance({ revenueYoY: 10 }); await f.run();
  assert.equal(f.engine.s.trades.length, 0);
  f.evidence(() => [demandEvidence('supported')]); await f.run();
  assert.equal(f.engine.s.trades.length, 1);
});

test('产品指标新开仓读取原始报告并复核：无需行业排名且执行前资料失效会拦截', async t => {
  for (const revoke of [false, true]) {
    const f = fixture(t, { research: { version: 1, enabled: true, path: 'product', rules: [{ field: 'currentRevenue', op: 'gt', value: 100000 }] } });
    let calls = 0;
    f.service.getAutomaticEvidence = async (symbol, options) => {
      calls++; assert.equal(options.includeIndustry, false);
      if (revoke && calls > 1) return { symbol, documents: [], errors: ['执行前资料不可用'] };
      const b = companyBundle(symbol, new Date('2026-09-29T10:00:00+08:00'));
      const text = '主要产品为汽车扬声器\n营业收入构成\n单位：万元\n本报告期 上年同期 同比增减\n金额 占营业收入比重 金额 占营业收入比重\n营业收入合计 200 100% 160 100% 25%\n分产品\n汽车扬声器 120 60% 80 50% 50%';
      Object.assign(b.documents[1], { text, fullText: text, pageTexts: [{ page: 1, text, method: 'provider-text', complete: true, numericEligible: true }] });
      return b;
    };
    await f.run(); assert.ok(calls >= 2);
    assert.equal(f.engine.s.trades.length, revoke ? 0 : 1);
    const decision = f.engine.s.agency.decisions.find(item => item.action === 'buy');
    assert.equal(decision.status, revoke ? 'blocked' : 'executed');
  }
});

test('仅观察经营指标不持久化为门槛、不新增财务或产品取数', async t => {
  const f = fixture(t, { research: { version: 1, enabled: false, path: 'product', rules: [] } });
  assert.equal(f.member().entryConditions, undefined);
  f.service.getAutomaticEvidence = () => { throw Error('仅观察不应取产品资料'); };
  await f.run(); assert.equal(f.engine.s.trades.length, 1);
  assert.ok(f.loads.every(call => call.financial === false));
});

test('真实自动成交写前归档，成交、持仓与周期引用同一冻结依据且原文不受后来修改影响', async t => {
  const f = automaticArchiveFixture(t), conditions = structuredClone(f.member().entryConditions);
  const save = f.service.archiveEntryEvidence;
  f.service.archiveEntryEvidence = payload => {
    assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.lots.length, 0);
    assert.equal(f.engine.s.cash, 10000000); assert.equal(payload.execution.quantity > 0, true);
    return save(payload);
  };
  await f.run();
  const trade = f.engine.s.trades[0], ref = trade.entryEvidenceRef, archived = f.entryEvidence.read(ref);
  assert.equal(trade.entryEvidenceRequired, true);
  assert.deepEqual(f.engine.s.lots[0].entryEvidenceRef, ref);
  assert.deepEqual(f.engine.s.agency.groups.find(group => group.id === 'swing').cycles[0].entryEvidenceRef, ref);
  assert.deepEqual(archived.entryConditions, conditions); assert.equal(archived.rulesVersion, '1');
  assert.equal(archived.execution.quantity, trade.quantity); assert.equal(archived.execution.evaluation.plan.entry, trade.price);
  assert.equal(archived.snapshot.automaticEvidenceEvaluation.status, 'pass');
  assert.equal(archived.snapshot.automaticEvidence.documents.length, 2);
  assert.match(archived.snapshot.automaticEvidence.documents[1].text, /2026年半年度报告/);
  assert.equal(archived.snapshot.automaticEvidence.documents[1].publishedAt, '2026-08-15');
  assert.match(archived.snapshot.automaticEvidence.documents[1].textHash, /^[a-f0-9]{64}$/);
  f.member().entryConditions.evidence.conditions = ['leadership']; archived.snapshot.automaticEvidence.documents[0].text = '被调用方改写';
  assert.deepEqual(f.entryEvidence.read(ref).entryConditions, conditions);
  assert.notEqual(f.entryEvidence.read(ref).snapshot.automaticEvidence.documents[0].text, '被调用方改写');
  assert.equal(f.entryEvidence.auditAccount(f.store.load()).verified, 1);
});

test('归档不可用、写盘失败或异步回调均在买入前拦截，不消耗资金、盘口或生成持仓', async t => {
  for (const archive of [null, () => { throw Error('永久目录只读'); }, async () => { throw Error('错误异步归档'); }, () => ({ version: 1, hash: '0'.repeat(64) })]) {
    const f = automaticArchiveFixture(t); f.service.archiveEntryEvidence = archive;
    const before = structuredClone(f.engine.s); await f.run();
    assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.lots.length, 0);
    assert.equal(f.engine.s.cash, before.cash); assert.deepEqual(f.engine.s.consumed, before.consumed);
    assert.equal(f.store.load().trades.length, 0);
    assert.ok(f.engine.s.agency.decisions.some(decision => decision.action === 'buy' && decision.status === 'blocked'));
    assert.equal(f.service.storageError, '', 'an archive rejection is not a post-trade account-save failure');
  }
});

test('归档成功而账户保存失败仅留下孤立依据，原子回滚成交并暂停服务', async t => {
  const f = automaticArchiveFixture(t), save = f.store.save.bind(f.store); let archivedRef;
  f.service.archiveEntryEvidence = payload => (archivedRef = f.entryEvidence.archive(payload));
  f.store.save = state => { if (state.trades.length) throw Error('归档后的账户保存失败'); return save(state); };
  await f.run();
  assert.ok(archivedRef); assert.equal(f.entryEvidence.read(archivedRef).symbol, 'sz000001');
  assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.lots.length, 0); assert.equal(f.engine.s.cash, 10000000);
  assert.deepEqual(f.engine.s.consumed, {}); assert.equal(f.store.load().trades.length, 0);
  assert.match(f.service.storageError, /账户保存失败/);
});

test('平仓、移出候选及日志滚动保留原开仓档案，归档服务故障不阻断持仓退出', async t => {
  const f = automaticArchiveFixture(t); await f.run(); const ref = structuredClone(f.engine.s.trades[0].entryEvidenceRef);
  f.service.archiveEntryEvidence = () => { throw Error('退出不应调用归档'); };
  f.setTime('2026-09-30T10:00:00+08:00'); f.price(9.5);
  f.transaction(() => f.engine.tick({ sz000001: f.quote('sz000001') }, { sz000001: f.snapshot('sz000001') }));
  assert.equal(f.engine.s.trades.length, 2); assert.equal(f.engine.s.trades[1].side, 'sell'); assert.equal(f.engine.s.lots.length, 0);
  f.transaction(() => {
    f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'remove' });
    for (let index = 0; index < 520; index++) f.engine.agencyLog({ status: 'waiting', message: '隔离滚动日志' });
  });
  assert.equal(f.engine.s.agency.decisions.length, 500); assert.equal(f.member(), undefined);
  assert.deepEqual(f.engine.s.trades[0].entryEvidenceRef, ref); assert.equal(f.entryEvidence.read(ref).symbol, 'sz000001');
  assert.equal(f.entryEvidence.auditAccount(f.store.load()).verified, 1);
});

test('账户备份携带去重正文，异目录恢复可核验；缺失或篡改的开仓依据不能静默有效', async t => {
  const f = automaticArchiveFixture(t); await f.run();
  const trade = f.engine.s.trades[0], ref = trade.entryEvidenceRef, backup = f.entryEvidence.exportAccount(f.engine.s);
  const restored = new EntryEvidenceStore(path.join(path.dirname(f.store.file), 'restored-evidence'));
  assert.equal(restored.auditAccount(f.engine.s).status, 'missing');
  const account = restored.importAccount(backup); assert.equal(validState(account), true);
  assert.deepEqual(account, f.engine.s); assert.equal(restored.auditAccount(account).verified, 1);
  const missingRef = structuredClone(account); delete missingRef.trades[0].entryEvidenceRef;
  assert.equal(validState(missingRef), false);
  const wrongRef = structuredClone(account); wrongRef.trades[0].entryEvidenceRef.symbol = 'sh600519';
  assert.equal(validState(wrongRef), false);
  const text = restored.manifest(ref).snapshot.snapshot.automaticEvidence.documents[0].archivedText;
  fs.writeFileSync(restored.file('text', text.hash), '篡改后的文件');
  assert.equal(restored.auditAccount(account).status, 'missing');
  assert.throws(() => restored.exportAccount(account), /不能导出完整备份/);
  assert.throws(() => restored.archive(f.entryEvidence.read(ref)), /内容校验失败/, 'normal archive never overwrites corruption');
  assert.deepEqual(restored.importAccount(backup), account);
  assert.equal(restored.auditAccount(account).status, 'ready');
});

test('执行前证据失效或证据库读取失败时阻断，不能复用上一轮肯定结论', async t => {
  for (const failure of ['revoked', 'unavailable']) {
    const f = fixture(t, { rules: [], evidence: { conditions: ['demand'] } }); let calls = 0;
    f.evidence(() => {
      if (++calls === 1) return [demandEvidence('supported')];
      if (failure === 'unavailable') throw Error('隔离证据库暂不可用');
      return [demandEvidence('unsupported')];
    });
    await f.run(); assert.equal(f.engine.s.trades.length, 0, failure); assert.ok(calls >= 2, failure);
    assert.ok(f.engine.s.agency.decisions.some(decision => decision.action === 'buy' && decision.status === 'blocked'), failure);
  }
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

test('单只加入等待行情时重置账户，旧请求不能把股票和规则写入新账户', async () => {
  const vm = require('node:vm');
  const { symbolOf } = require('../core/common.cjs');
  const { createEntryConditions } = require('../core/entry-conditions.cjs');
  const mainPath = path.join(__dirname, '../main.cjs'), source = fs.readFileSync(mainPath, 'utf8');
  const start = source.indexOf("  handler('agency:member',"), end = source.indexOf("  handler('agency:members:add',");
  assert.ok(start >= 0 && end > start);
  const now = new Date('2026-09-29T10:00:00+08:00'); let add, release;
  // Execute the actual IPC callback against in-memory dependencies. Electron,
  // network access and user account paths are never loaded by this test.
  const context = vm.createContext({ symbolOf, createEntryConditions, structuredClone,
    handler: (_name, callback) => { add = callback; }, engine: new Engine(initialState(100000), () => now), quotes: {},
    market: { quotes: () => new Promise(resolve => { release = resolve; }) }, transaction: callback => callback(),
    publish: () => {}, monitor: { load: async () => ({}) }, needsFundamentals: () => false, agency: null });
  vm.runInContext(source.slice(start, end), context, { filename: mainPath });
  const pending = add({ strategyId: 'swing', symbol: '000001', action: 'add', entryConditions: roeCondition() });
  context.engine = new Engine(initialState(200000), () => now);
  release({ sz000001: { symbol: 'sz000001', price: 10, timestamp: now.getTime() } });
  await assert.rejects(pending, /账户已重置/);
  assert.equal(context.engine.s.agency.groups.flatMap(group => group.members).length, 0);
  assert.equal(Object.keys(context.engine.s.marks).length, 0); assert.equal(Object.keys(context.quotes).length, 0);
});
