'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { TECHNICAL_ENTRY_POLICY } = require('../core/strategy-profiles.cjs');
const { createEntryConditions, usesAutomaticEvidence, evaluateEntryConditions } = require('../core/entry-conditions.cjs');
const { technicals } = require('../core/strategy.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');
const { financialQualityRules } = require('../core/screener.cjs');
const { poolQualificationPending, monitoringCheck } = require('../core/agency-monitoring.cjs');
const now = new Date('2026-10-15T10:00:00+08:00');

function legacy() {
  const engine = new Engine(initialState(), () => now);
  engine.agencyTransfer({ strategyId: 'swing', amount: 500000 });
  engine.agencyMember({ strategyId: 'swing', symbol: 'sh600938', action: 'add' });
  engine.agencyMember({ strategyId: 'swing', symbol: 'sh600000', action: 'add', entryConditions: { rules: [{ field: 'roe', op: 'gte', value: 15 }] } });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const state = structuredClone(engine.s), member = state.agency.groups.find(group => group.id === 'swing').members[0];
  state.agency.version = 4; delete state.agency.monitoringVersion; delete state.agency.legacyManual; delete state.agency.technicalTradingVersion;
  state.agency.groups.find(group => group.id === 'swing').members[1].entryConditions = createEntryConditions({ rules: [{ field: 'roe', op: 'gte', value: 15 }] }, now);
  for (const group of state.agency.groups) for (const m of group.members) delete m.selectionMode;
  member.entryConditions = createEntryConditions({ rules: [...financialQualityRules(),
    { field: 'ma20', op: 'gt', valueField: 'previousMa20' },
    { field: 'ma20', op: 'gt', valueField: 'ma60' },
    { field: 'close', op: 'gte', valueField: 'ma20' },
    { field: 'macd', op: 'gt', value: 0 },
    { field: 'rsi', op: 'gte', value: 40 },
    { field: 'rsi', op: 'lte', value: 75 },
    { field: 'dailyVolumeRatio', op: 'gte', value: 0.6 },
    { field: 'price', op: 'lt', value: 50 }], excludeST: true,
    evidence: { conditions: ['productOutlook', 'financialReview'], leadership: 'either', minSegmentRevenuePct: 30 },
    source: { kind: 'agency-pool', policyVersion: 2, selectedAt: now.toISOString() } }, now);
  return state;
}

test('旧共同研究和预设门槛迁移为监控，保留个人额外条件、运行授权和账户事实，原条件留档', () => {
  const before = legacy(); assert.equal(validState(before), true);
  const original = structuredClone(before), upgraded = new Engine(before, () => now), s = upgraded.s;
  const [member, personal] = s.agency.groups.find(group => group.id === 'swing').members;
  assert.equal(s.agency.version, 8); assert.equal(s.agency.technicalTradingVersion, 1); assert.equal(s.agency.monitoringVersion, 1);
  assert.equal(member.mode, 'standby'); assert.match(member.standbyReason, /筛选规则已升级/);
  assert.equal(member.selectionMode, 'strategy'); assert.equal(member.entryConditions.evidence, undefined);
  assert.equal(usesAutomaticEvidence(member.entryConditions), false, '数值条件不应要求完整研究报告及永久研究归档');
  assert.deepEqual(member.entryConditions.rules, [{ field: 'price', op: 'lt', value: 50 }]);
  assert.deepEqual(member.legacyPoolConditions, original.agency.groups.find(group => group.id === 'swing').members[0].entryConditions);
  assert.equal(personal.entryConditions, undefined);
  assert.deepEqual(personal.legacyResearchConditions, original.agency.groups.find(group => group.id === 'swing').members[1].entryConditions);
  for (const key of ['cash', 'lots', 'trades', 'orders', 'risks']) assert.deepEqual(s[key], original[key]);
  assert.equal(s.agency.groups.find(group => group.id === 'swing').mode, 'running');
  assert.equal(s.agency.groups.find(group => group.id === 'swing').cash, 50000000);
  assert.equal(validState(s), true);
  const again = new Engine(structuredClone(s), () => now); assert.deepEqual(again.s, s);
});

test('旧额外财务和研究要求停止执行且完整留档，历史模板移除记录继续保留', () => {
  const state = legacy(), member = state.agency.groups.find(group => group.id === 'swing').members[0];
  member.entryConditions = createEntryConditions({ rules: [...financialQualityRules(), { field: 'annualRoeAverage', op: 'gte', value: 20 }],
    evidence: { conditions: ['productOutlook', 'financialReview', 'demand'], leadership: 'mainTop3', minSegmentRevenuePct: 50 },
    source: { kind: 'agency-pool', policyVersion: 2 } }, now);
  const original = structuredClone(member.entryConditions);
  const migrated = new Engine(state, () => now).s.agency.groups.find(group => group.id === 'swing').members[0];
  assert.equal(migrated.entryConditions, undefined);
  assert.deepEqual(migrated.legacyPoolConditions, original);
  assert.deepEqual(migrated.legacyResearchConditions.rules, [{ field: 'annualRoeAverage', op: 'gte', value: 20 }]);
  assert.deepEqual(migrated.legacyResearchConditions.evidence.conditions, ['demand']);
  assert.equal(migrated.legacyResearchConditions.evidence.leadership, 'mainTop3');
  assert.equal(migrated.legacyResearchConditions.evidence.minSegmentRevenuePct, 50);
});

test('v4字面旧预筛夹具按历史阈值迁移，新预筛同值的个人条件不被误删', () => {
  const cases = [
    { strategyId: 'short', generated: [
      { field: 'rsi', op: 'gte', value: 45 }, { field: 'rsi', op: 'lte', value: 75 }, { field: 'dailyVolumeRatio', op: 'gte', value: 1 }
    ], personal: [
      { field: 'rsi', op: 'gte', value: 50 }, { field: 'rsi', op: 'lte', value: 70 }, { field: 'dailyVolumeRatio', op: 'gte', value: 1.2 }
    ] },
    { strategyId: 'swing', generated: [
      { field: 'rsi', op: 'gte', value: 40 }, { field: 'rsi', op: 'lte', value: 75 }, { field: 'dailyVolumeRatio', op: 'gte', value: 0.6 }
    ], personal: [
      { field: 'rsi', op: 'gte', value: 45 }, { field: 'rsi', op: 'lte', value: 70 }, { field: 'dailyVolumeRatio', op: 'gte', value: 0.8 }
    ] },
    { strategyId: 'long', generated: [
      { field: 'annualRoeLatest', op: 'gte', value: 8 }, { field: 'pe', op: 'gt', value: 0 }, { field: 'pe', op: 'lte', value: 30 }
    ], personal: [
      { field: 'ma20', op: 'gte', valueField: 'ma60' }, { field: 'ma60', op: 'gte', valueField: 'previousMa60' }, { field: 'close', op: 'gte', valueField: 'ma60' }
    ] }
  ];
  for (const { strategyId, generated, personal } of cases) {
    const engine = new Engine(initialState(), () => now);
    engine.agencyMember({ strategyId, symbol: 'sh600938', action: 'add' });
    const before = structuredClone(engine.s);
    before.agency.version = 4; delete before.agency.monitoringVersion; delete before.agency.legacyManual; delete before.agency.technicalTradingVersion;
    for (const group of before.agency.groups) for (const member of group.members) delete member.selectionMode;
    const member = before.agency.groups.find(group => group.id === strategyId).members[0];
    member.entryConditions = createEntryConditions({ rules: [...generated, ...personal],
      source: { kind: 'agency-pool', policyVersion: 2, selectedAt: now.toISOString() } }, now);
    assert.equal(validState(before), true);
    const original = structuredClone(before), upgraded = new Engine(before, () => now);
    const migrated = upgraded.s.agency.groups.find(group => group.id === strategyId).members[0];
    assert.deepEqual(migrated.entryConditions.rules, personal, strategyId);
    assert.deepEqual(migrated.legacyPoolConditions, original.agency.groups.find(group => group.id === strategyId).members[0].entryConditions, strategyId);
    for (const key of ['cash', 'lots', 'trades', 'orders', 'risks']) assert.deepEqual(upgraded.s[key], original[key]);
    assert.equal(validState(upgraded.s), true);
    assert.deepEqual(new Engine(structuredClone(upgraded.s), () => now).s, upgraded.s);
  }
});

test('默认监控不受历史候选判定阻断，严格成员必须持有同模式当前版本资格', () => {
  const agency = { version: 5 }, member = { selectionMode: 'strategy', poolCheck: { status: 'pending', policyVersion: 2 } };
  assert.equal(poolQualificationPending(agency, member), false);
  member.selectionMode = 'strict'; assert.equal(poolQualificationPending(agency, member), true);
  member.poolCheck = { status: 'pass', policyVersion: 3, screeningMode: 'strategy' };
  assert.equal(poolQualificationPending(agency, member), true);
  member.poolCheck.screeningMode = 'strict'; assert.equal(poolQualificationPending(agency, member), false);
  member.poolCheck.status = 'pending';
  assert.equal(poolQualificationPending({ version: 8, technicalTradingVersion: 1 }, member), false, '技术模式不恢复旧研究资格门槛');
});

test('监控状态区分数据、明确风险、资金、买点及持仓，不把等待回踩描述为待核验', () => {
  for (const [evaluation, expected] of [
    [{ status: '等待回踩', reasons: ['价格尚未进入回踩区域'] }, 'conditions'],
    [{ status: '等待数据', reasons: ['完整日线不足 61 根'] }, 'data'],
    [{ entryRisk: { status: 'blocked' }, reasons: ['公司被立案调查'] }, 'risk'],
    [{ reasons: ['达到本策略持仓数量上限'] }, 'funds'],
    [{ buyable: true, reasons: ['条件通过'] }, 'eligible']
  ]) {
    const check = monitoringCheck(evaluation, {}, now);
    assert.equal(check.status, expected); assert.equal(check.entryPolicyVersion, TECHNICAL_ENTRY_POLICY.version);
  }
  assert.equal(monitoringCheck({ buyable: true }, { holding: true }, now).status, 'holding');
});

function technicalFixture() {
  const dates = [];
  for (let day = Date.parse('2026-10-14T10:00:00+08:00'); dates.length < 80; day -= 86400000) {
    const session = calendarSession(new Date(day)); if (session.open) dates.unshift(session.date);
  }
  const bars = dates.map((date, index) => ({ date, open: 10 + index * 0.01, close: 10 + index * 0.01,
    high: 10.2 + index * 0.01, low: 9.8 + index * 0.01, volume: 100 }));
  const snapshot = { technical: technicals(bars, now), fetchedAt: +now, source: '隔离完整日线' };
  const quote = { symbol: 'sh600001', name: '技术条件隔离样本', source: '隔离行情', timestamp: +now, date: '2026-10-15',
    price: 10.8, prevClose: snapshot.technical.close };
  const rules = [{ field: 'atrPct14', op: 'lte', value: 6 }, { field: 'biasMa5Pct', op: 'lte', value: 6 },
    { field: 'biasMa20Pct', op: 'lte', value: 8 }, { field: 'biasMa60Pct', op: 'lte', value: 12 },
    { field: 'ma20Change5Pct', op: 'gt', value: 0 }];
  return { snapshot, quote, rules };
}

test('执行技术快照提供波动率乖离和均线变化，真实条件可通过或失败且缺失不伪造通过', () => {
  const { snapshot, quote, rules } = technicalFixture();
  const saved = createEntryConditions({ rules }, now);
  const passed = evaluateEntryConditions(saved, quote.symbol, quote, snapshot, now);
  assert.equal(passed.status, 'pass'); assert.equal(passed.checks.length, 5);
  assert.ok(Math.abs(snapshot.technical.atrPct14 - 0.4 / 10.79 * 100) < 1e-8);
  for (const rule of rules) {
    const failing = createEntryConditions({ rules: [{ field: rule.field, op: 'lt', value: snapshot.technical[rule.field] - 0.001 }] }, now);
    assert.equal(evaluateEntryConditions(failing, quote.symbol, quote, snapshot, now).status, 'failed', rule.field);
    const missing = structuredClone(snapshot); delete missing.technical[rule.field];
    assert.equal(evaluateEntryConditions(saved, quote.symbol, quote, missing, now).status, 'pending', rule.field);
  }
});

test('v7升级v8保留并可执行个人技术条件，财务研究原件留档且恢复幂等', () => {
  const { snapshot, quote, rules } = technicalFixture();
  const engine = new Engine(initialState(), () => now);
  engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
  engine.agencyMember({ strategyId: 'swing', symbol: quote.symbol, action: 'add' });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const legacy = structuredClone(engine.s); legacy.agency.version = 7; delete legacy.agency.technicalTradingVersion;
  const member = legacy.agency.groups.find(group => group.id === 'swing').members[0];
  member.selectionMode = 'strict';
  member.poolCheck = { policyVersion: 3, screeningMode: 'strict', status: 'pending', checkedAt: now.toISOString(), matchedStrategies: [], reasons: ['公告获取失败'] };
  member.monitoringCheck = { status: 'data', reason: '公告获取失败：协议错误，保留原始故障', checkedAt: now.toISOString() };
  member.entryConditions = createEntryConditions({ rules: [...rules, { field: 'roe', op: 'gte', value: 50 }],
    evidence: { conditions: ['financialReview'], leadership: '', minSegmentRevenuePct: 30 } }, now);
  const original = structuredClone(legacy); assert.equal(validState(legacy), true);
  const upgraded = new Engine(legacy, () => now), current = upgraded.s.agency.groups.find(group => group.id === 'swing').members[0];
  assert.equal(upgraded.s.agency.version, 8); assert.equal(current.selectionMode, 'strategy');
  assert.deepEqual(current.entryConditions.rules, rules); assert.equal(current.entryConditions.evidence, undefined);
  assert.deepEqual(current.legacyResearchConditions, original.agency.groups.find(group => group.id === 'swing').members[0].entryConditions);
  assert.deepEqual(current.legacyMonitoringCheck, original.agency.groups.find(group => group.id === 'swing').members[0].monitoringCheck);
  assert.equal(current.monitoringCheck, undefined, '不以迁移提示覆盖旧检查，也不伪造当前规则结果');
  assert.deepEqual(current.poolCheck, member.poolCheck, '旧研究结果保留作历史，不能改写成通过');
  assert.equal(poolQualificationPending(upgraded.s.agency, current), false);
  assert.equal(evaluateEntryConditions(current.entryConditions, quote.symbol, quote, snapshot, now).status, 'pass');
  const evaluated = upgraded.agencyEvaluate('swing', quote.symbol, quote, snapshot);
  assert.equal(evaluated.entryConditionsCheck.status, 'pass', '真实自动执行入口应读取相同技术字段');
  for (const key of ['cash', 'lots', 'trades', 'orders', 'risks']) assert.deepEqual(upgraded.s[key], original[key]);
  assert.equal(validState(upgraded.s), true);
  assert.deepEqual(new Engine(structuredClone(upgraded.s), () => now).s, upgraded.s);
});

test('v7及已v8普通成员无个人条件也归档旧检查，活跃候补和旧通过均等待重新检查且保存恢复幂等', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-monitoring-policy-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('guanlan-monitoring-policy-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const repairTime = new Date('2026-10-26T10:00:00+08:00');
  for (const version of [7, 8]) {
    const engine = new Engine(initialState(), () => repairTime);
    engine.agencyMode({ strategyId: 'swing', mode: 'running' });
    const group = engine.s.agency.groups.find(item => item.id === 'swing');
    for (const [index, [mode, status]] of [['active', 'data'], ['standby', 'data'], ['active', 'eligible'], ['standby', 'eligible']].entries()) {
      engine.agencyMember({ strategyId: 'swing', symbol: `sh${600000 + index}`, action: 'add' });
      const member = group.members.at(-1); member.mode = mode;
      if (mode === 'standby') member.standbyReason = '保留原候补原因';
      member.monitoringCheck = { status, reason: status === 'eligible' ? '旧策略规则通过' : '获取公告失败：协议错误', checkedAt: '2026-10-23T02:00:00.000Z' };
      member.automaticCheck = { status: 'blocked', reason: '价格基准待核验', checkedAt: '2026-10-23T02:00:00.000Z' };
      member.reconciliation = { status: 'pending', reason: '历史权益待对账', affectsEquity: true };
      member.awaitingVerification = true;
      assert.equal(member.entryConditions, undefined);
    }
    engine.s.agency.version = version;
    if (version === 7) delete engine.s.agency.technicalTradingVersion;
    const original = structuredClone(engine.s), store = new Store(path.join(directory, `v${version}`));
    assert.equal(validState(original), true, '旧未stamp状态仍可读入以执行修复');
    store.save(original);
    const migrated = new Engine(store.load(), () => repairTime), members = migrated.s.agency.groups.find(item => item.id === 'swing').members;
    for (const [index, member] of members.entries()) {
      const previous = original.agency.groups.find(item => item.id === 'swing').members[index];
      const expected = { ...structuredClone(previous), legacyMonitoringCheck: previous.monitoringCheck };
      delete expected.monitoringCheck;
      assert.deepEqual(member, expected, `${version}/${member.mode}`);
      assert.equal(member.monitoringCheck, undefined);
    }
    for (const key of ['cash', 'lots', 'trades', 'orders', 'risks', 'consumed']) assert.deepEqual(migrated.s[key], original[key]);
    assert.deepEqual(migrated.s.agency.decisions, original.agency.decisions);
    assert.ok(migrated.s.agency.revision > original.agency.revision);
    assert.equal(validState(migrated.s), true); store.save(migrated.s);
    const restored = new Engine(store.load(), () => new Date(+repairTime + 60000));
    assert.deepEqual(restored.s, migrated.s, '保存后再启动不重复归档或更改revision');
    members[0].monitoringCheck = monitoringCheck({ reasons: ['当前技术价格尚未进入回踩区域'] }, {}, repairTime);
    store.save(migrated.s);
    assert.deepEqual(new Engine(store.load(), () => new Date(+repairTime + 60000)).s, migrated.s,
      '新政策检查保存重启后仍保留current及原历史归档');
  }
});

test('当前技术政策stamp检查及单份历史保持，未stamp后续旧记录覆盖历史而不追加嵌套', () => {
  const engine = new Engine(initialState(), () => now);
  engine.agencyMember({ strategyId: 'swing', symbol: 'sh600000', action: 'add' });
  const member = engine.s.agency.groups.find(item => item.id === 'swing').members[0];
  const legacy = { status: 'data', reason: '原公告失败', checkedAt: '2026-10-14T02:00:00.000Z' };
  member.legacyMonitoringCheck = structuredClone(legacy);
  for (const evaluation of [{ buyable: true, reasons: ['当前规则通过'] }, { reasons: ['当前行情过期'] }]) {
    member.monitoringCheck = monitoringCheck(evaluation, {}, now);
    const original = structuredClone(engine.s);
    assert.deepEqual(new Engine(structuredClone(original), () => new Date(+now + 60000)).s, original);
  }
  const lastOld = { status: 'eligible', reason: '另一次旧策略通过', checkedAt: now.toISOString() };
  member.monitoringCheck = { ...lastOld, obsoleteMetadata: { legacyMonitoringCheck: legacy } };
  assert.equal(validState(engine.s), true, '旧检查额外元数据不妨碍载入');
  const repaired = new Engine(structuredClone(engine.s), () => now);
  const current = repaired.s.agency.groups.find(item => item.id === 'swing').members[0];
  assert.equal(current.monitoringCheck, undefined); assert.deepEqual(current.legacyMonitoringCheck, lastOld);
  assert.deepEqual(Object.keys(current.legacyMonitoringCheck).sort(), ['checkedAt', 'reason', 'status']);
  assert.deepEqual(new Engine(structuredClone(repaired.s), () => now).s, repaired.s);
});

test('检查stamp与归档结构严格校验，未知政策、非法状态时间及嵌套历史不载入', () => {
  const engine = new Engine(initialState(), () => now);
  engine.agencyMember({ strategyId: 'swing', symbol: 'sh600000', action: 'add' });
  const check = { status: 'data', reason: '旧资料失败', checkedAt: now.toISOString() };
  const member = state => state.agency.groups.find(item => item.id === 'swing').members[0];
  for (const [field, values] of [
    ['monitoringCheck', [null, [], { ...check, status: 'unknown' }, { ...check, checkedAt: 'invalid' },
      ...[0, -1, 2, 1.5, '1', true, null].map(entryPolicyVersion => ({ ...check, entryPolicyVersion }))]],
    ['legacyMonitoringCheck', [null, [], { ...check, status: 'unknown' }, { ...check, reason: null }, { ...check, checkedAt: 'invalid' },
      { ...check, entryPolicyVersion: 1 }, { ...check, legacyMonitoringCheck: check }, { ...check, history: [check] }]]
  ]) for (const value of values) {
    const invalid = structuredClone(engine.s); member(invalid)[field] = value;
    assert.equal(validState(invalid), false, `${field}/${JSON.stringify(value)}`);
    assert.throws(() => new Engine(invalid, () => now), /账户数据格式/);
  }
  for (const value of [check, { ...check, entryPolicyVersion: TECHNICAL_ENTRY_POLICY.version }]) {
    const state = structuredClone(engine.s); member(state).monitoringCheck = value;
    member(state).legacyMonitoringCheck = check; assert.equal(validState(state), true);
  }
});

test('归档历史显示检查不清除真实持仓、退出意图、对账阻断及决策账务', () => {
  const engine = new Engine(initialState(100000), () => now), symbol = 'sh600001';
  engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
  engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' }); engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const quote = { symbol, name: '迁移持仓隔离样本', price: 10.1, prevClose: 10.05, open: 10, low: 10, high: 10.2,
    volume: 100000, bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05, timestamp: +now, date: '2026-10-15' };
  const snapshot = { source: '隔离完整日线', fetchedAt: +now, technical: { asOf: '2026-10-14', close: 10.05,
    ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true,
    support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-10-14'] } };
  const execute = action => engine.agencyExecute({ strategyId: 'swing', symbol, action, ...(action === 'buy' ? { targetPercent: 20 } : {}),
    decisionId: `monitoring-migration-${action}`, expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, quote, snapshot);
  execute('buy');
  snapshot.corporateActions = { symbol, status: 'ready', fetchedAt: +now, coverageStart: '2026-01-01', coverageEnd: '2026-10-15', coverageComplete: true, events: [], notices: [] };
  execute('sell');
  const member = engine.s.agency.groups.find(item => item.id === 'swing').members[0];
  member.monitoringCheck = { status: 'data', reason: '旧公告读取失败', checkedAt: now.toISOString() };
  member.reconciliation = { status: 'pending', reason: '真实公司行为权益待对账', affectsEquity: true };
  member.automaticCheck = { status: 'blocked', reason: member.reconciliation.reason, checkedAt: now.toISOString() };
  member.awaitingVerification = true;
  engine.agencyLog({ strategyId: 'swing', symbol, status: 'blocked', message: member.reconciliation.reason });
  assert.equal(engine.s.lots.length, 1); assert.equal(engine.s.agency.executionIntents.length, 1);
  for (const version of [7, 8]) {
    const before = structuredClone(engine.s); before.agency.version = version;
    if (version === 7) delete before.agency.technicalTradingVersion;
    assert.equal(validState(before), true);
    const repaired = new Engine(structuredClone(before), () => now);
    for (const key of ['cash', 'lots', 'trades', 'orders', 'risks', 'consumed']) assert.deepEqual(repaired.s[key], before[key]);
    for (const key of ['decisions', 'executionIntents', 'transfers', 'corporateActions', 'corporateEvents', 'corporateChecks']) assert.deepEqual(repaired.s.agency[key], before.agency[key]);
    const current = repaired.s.agency.groups.find(item => item.id === 'swing').members[0];
    for (const key of ['reconciliation', 'automaticCheck', 'awaitingVerification', 'exitPriceBasis', 'mode']) assert.deepEqual(current[key], member[key]);
    assert.equal(current.monitoringCheck, undefined); assert.deepEqual(current.legacyMonitoringCheck, member.monitoringCheck);
    assert.equal(repaired.agencyNeedsCorporateEvidence(symbol), true);
    assert.match(repaired.agencyAutomaticBlock(symbol, quote, { ...snapshot, corporateActions: undefined }), /待对账/);
    assert.equal(repaired.s.trades.length, before.trades.length); assert.equal(validState(repaired.s), true);
  }
});
