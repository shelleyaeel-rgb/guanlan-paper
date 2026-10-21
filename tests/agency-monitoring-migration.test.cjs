'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { createEntryConditions, usesAutomaticEvidence } = require('../core/entry-conditions.cjs');
const { financialQualityRules } = require('../core/screener.cjs');
const { STRATEGY_PRESETS } = require('../core/strategy-presets.cjs');
const { poolQualificationPending, monitoringCheck } = require('../core/agency-monitoring.cjs');
const now = new Date('2026-10-15T10:00:00+08:00');

function legacy() {
  const engine = new Engine(initialState(), () => now);
  engine.agencyTransfer({ strategyId: 'swing', amount: 500000 });
  engine.agencyMember({ strategyId: 'swing', symbol: 'sh600938', action: 'add' });
  engine.agencyMember({ strategyId: 'swing', symbol: 'sh600000', action: 'add', entryConditions: { rules: [{ field: 'roe', op: 'gte', value: 15 }] } });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const state = structuredClone(engine.s), member = state.agency.groups.find(group => group.id === 'swing').members[0];
  state.agency.version = 4; delete state.agency.monitoringVersion;
  for (const group of state.agency.groups) for (const m of group.members) delete m.selectionMode;
  member.entryConditions = createEntryConditions({ rules: [...financialQualityRules(), ...STRATEGY_PRESETS.find(p => p.id === 'swing').rules,
    { field: 'price', op: 'lt', value: 50 }], excludeST: true,
    evidence: { conditions: ['productOutlook', 'financialReview'], leadership: 'either', minSegmentRevenuePct: 30 },
    source: { kind: 'agency-pool', policyVersion: 2, selectedAt: now.toISOString() } }, now);
  return state;
}

test('旧共同研究和预设门槛迁移为监控，保留个人额外条件、运行授权和账户事实，原条件留档', () => {
  const before = legacy(); assert.equal(validState(before), true);
  const original = structuredClone(before), upgraded = new Engine(before, () => now), s = upgraded.s;
  const [member, personal] = s.agency.groups.find(group => group.id === 'swing').members;
  assert.equal(s.agency.version, 5); assert.equal(s.agency.monitoringVersion, 1);
  assert.equal(member.selectionMode, 'strategy'); assert.equal(member.entryConditions.evidence, undefined);
  assert.equal(usesAutomaticEvidence(member.entryConditions), false, '数值条件不应要求完整研究报告及永久研究归档');
  assert.deepEqual(member.entryConditions.rules, [{ field: 'price', op: 'lt', value: 50 }]);
  assert.deepEqual(member.legacyPoolConditions, original.agency.groups.find(group => group.id === 'swing').members[0].entryConditions);
  assert.deepEqual(personal.entryConditions, original.agency.groups.find(group => group.id === 'swing').members[1].entryConditions);
  for (const key of ['cash', 'lots', 'trades', 'orders', 'risks']) assert.deepEqual(s[key], original[key]);
  assert.equal(s.agency.groups.find(group => group.id === 'swing').mode, 'running');
  assert.equal(s.agency.groups.find(group => group.id === 'swing').cash, 50000000);
  assert.equal(validState(s), true);
  const again = new Engine(structuredClone(s), () => now); assert.deepEqual(again.s, s);
});

test('旧额外更严格的财务和研究要求不因共同模板迁移丢失', () => {
  const state = legacy(), member = state.agency.groups.find(group => group.id === 'swing').members[0];
  member.entryConditions = createEntryConditions({ rules: [...financialQualityRules(), { field: 'annualRoeAverage', op: 'gte', value: 20 }],
    evidence: { conditions: ['productOutlook', 'financialReview', 'demand'], leadership: 'mainTop3', minSegmentRevenuePct: 50 },
    source: { kind: 'agency-pool', policyVersion: 2 } }, now);
  const migrated = new Engine(state, () => now).s.agency.groups.find(group => group.id === 'swing').members[0];
  assert.deepEqual(migrated.entryConditions.rules, [{ field: 'annualRoeAverage', op: 'gte', value: 20 }]);
  assert.deepEqual(migrated.entryConditions.evidence.conditions, ['demand']);
  assert.equal(migrated.entryConditions.evidence.leadership, 'mainTop3');
  assert.equal(migrated.entryConditions.evidence.minSegmentRevenuePct, 50);
});

test('默认监控不受历史候选判定阻断，严格成员必须持有同模式当前版本资格', () => {
  const agency = { version: 5 }, member = { selectionMode: 'strategy', poolCheck: { status: 'pending', policyVersion: 2 } };
  assert.equal(poolQualificationPending(agency, member), false);
  member.selectionMode = 'strict'; assert.equal(poolQualificationPending(agency, member), true);
  member.poolCheck = { status: 'pass', policyVersion: 3, screeningMode: 'strategy' };
  assert.equal(poolQualificationPending(agency, member), true);
  member.poolCheck.screeningMode = 'strict'; assert.equal(poolQualificationPending(agency, member), false);
});

test('监控状态区分数据、明确风险、资金、买点及持仓，不把等待回踩描述为待核验', () => {
  for (const [evaluation, expected] of [
    [{ status: '等待回踩', reasons: ['价格尚未进入回踩区域'] }, 'conditions'],
    [{ status: '等待数据', reasons: ['完整日线不足 61 根'] }, 'data'],
    [{ entryRisk: { status: 'blocked' }, reasons: ['公司被立案调查'] }, 'risk'],
    [{ reasons: ['达到本策略持仓数量上限'] }, 'funds'],
    [{ buyable: true, reasons: ['条件通过'] }, 'eligible']
  ]) assert.equal(monitoringCheck(evaluation, {}, now).status, expected);
  assert.equal(monitoringCheck({ buyable: true }, { holding: true }, now).status, 'holding');
});
