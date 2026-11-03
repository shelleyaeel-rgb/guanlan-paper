'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { ACTIVE_CANDIDATE_LIMIT, STANDBY_CAPACITY_REASON, STANDBY_MIGRATION_REASON, activeCandidateCount, setStandby, activateCandidate } = require('../core/agency-capacity.cjs');

function fixture() {
  let now = new Date('2026-09-29T10:00:00+08:00');
  const engine = new Engine(initialState(100000), () => now);
  engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const group = () => engine.s.agency.groups.find(item => item.id === 'swing');
  const add = (symbol, entryConditions) => engine.agencyMember({ strategyId: 'swing', symbol, action: 'add', entryConditions });
  const quote = () => ({ symbol: 'sz000001', name: '候补容量隔离样本', price: 10.1, prevClose: 10.05, open: 10,
    low: 10, high: 10.2, volume: 100000, bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000,
    limitUp: 11.05, limitDown: 9.05, timestamp: now.getTime(), date: now.toISOString().slice(0, 10) });
  const snapshot = () => ({ fetchedAt: now.getTime(), notices: { symbol: 'sz000001', section: 'notices', source: '东方财富',
    status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } }, technical: { asOf: '2026-09-28', close: 10.05,
    ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true,
    support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-09-28'] } });
  const buy = () => engine.agencyExecute({ strategyId: 'swing', symbol: 'sz000001', action: 'buy', targetPercent: 20,
    decisionId: 'capacity-buy', expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, quote(), snapshot());
  return { engine, group, add, buy, quote, snapshot, nextDay: () => { now = new Date('2026-09-30T10:00:00+08:00'); } };
}

test('每组20只未持仓活跃候选，第21只候补保留个人条件且重复加入不提升，保存重启不变', t => {
  const f = fixture(), cash = f.engine.s.cash;
  assert.equal(ACTIVE_CANDIDATE_LIMIT, 20);
  const conditions = { rules: [{ field: 'price', op: 'lt', value: 30 }] };
  for (const [index, group] of f.engine.s.agency.groups.entries()) {
    for (let i = 0; i <= ACTIVE_CANDIDATE_LIMIT; i++) f.engine.agencyMember({ strategyId: group.id, symbol: `sh${600000 + index * 100 + i}`, action: 'add', entryConditions: conditions });
    assert.equal(activeCandidateCount(f.engine.s, group), ACTIVE_CANDIDATE_LIMIT);
    assert.equal(group.members[ACTIVE_CANDIDATE_LIMIT].mode, 'standby'); assert.equal(group.members[ACTIVE_CANDIDATE_LIMIT].standbyReason, STANDBY_CAPACITY_REASON);
    assert.deepEqual(group.members[ACTIVE_CANDIDATE_LIMIT].entryConditions.rules, conditions.rules);
    const prior = structuredClone(group.members[ACTIVE_CANDIDATE_LIMIT]);
    f.engine.agencyMember({ strategyId: group.id, symbol: prior.symbol, action: 'add', entryConditions: { rules: [] } });
    assert.deepEqual(group.members[ACTIVE_CANDIDATE_LIMIT], prior);
  }
  assert.equal(f.engine.s.agency.version, 8); assert.equal(f.engine.s.cash, cash);
  assert.deepEqual(f.engine.s.lots, []); assert.deepEqual(f.engine.s.trades, []); assert.equal(validState(f.engine.s), true);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-capacity-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('guanlan-capacity-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = new Store(directory); store.save(f.engine.s);
  assert.deepEqual(new Engine(store.load(), f.engine.clock).s, f.engine.s);
  const standby = f.group().members[ACTIVE_CANDIDATE_LIMIT];
  const evaluation = f.engine.agencyEvaluate('swing', standby.symbol, undefined, {});
  assert.equal(evaluation.buyable, false); assert.match(evaluation.reasons[0], /当前为候补/);
});

test('v8拒绝超额活跃、候补无原因、候补持仓及向v5伪降级', () => {
  const f = fixture(); f.add('sz000001'); f.buy();
  for (let i = 0; i <= ACTIVE_CANDIDATE_LIMIT; i++) f.add(`sh${600000 + i}`);
  assert.equal(activeCandidateCount(f.engine.s, f.group()), ACTIVE_CANDIDATE_LIMIT); assert.equal(validState(f.engine.s), true);
  for (const mutate of [
    state => { const member = state.agency.groups.find(g => g.id === 'swing').members.at(-1); member.mode = 'active'; delete member.standbyReason; },
    state => { delete state.agency.groups.find(g => g.id === 'swing').members.at(-1).standbyReason; },
    state => { Object.assign(state.agency.groups.find(g => g.id === 'swing').members[0], { mode: 'standby', standbyReason: '不能降级持仓' }); },
    state => { state.agency.version = 5; },
    state => { state.agency.version = 9; },
    state => { delete state.agency.technicalTradingVersion; }
  ]) {
    const invalid = structuredClone(f.engine.s); mutate(invalid);
    assert.equal(validState(invalid), false); assert.throws(() => new Engine(invalid), /账户数据格式/);
  }
});

test('v5迁移所有空仓active为候补，不借旧通过或待核验授权，保留持仓退出账务和个人条件', () => {
  for (const holdingMode of ['active', 'closing', 'removing']) {
    const f = fixture(); f.add('sz000001'); f.buy(); f.group().members[0].mode = holdingMode;
    for (let i = 0; i < 8; i++) f.add(`sh${600000 + i}`, { rules: [{ field: 'price', op: 'lt', value: 30 }] });
    const old = structuredClone(f.engine.s), members = old.agency.groups.find(g => g.id === 'swing').members;
    old.agency.version = 5; delete old.agency.legacyManual; delete old.agency.technicalTradingVersion;
    for (const member of members.slice(1)) { member.mode = 'active'; delete member.standbyReason; }
    members[1].poolCheck = { policyVersion: 3, screeningMode: 'strategy', status: 'pass', checkedAt: f.engine.clock().toISOString(), reasons: [], matchedStrategies: ['swing'] };
    members[2].poolCheck = { ...members[1].poolCheck, status: 'pending', reasons: ['公告事实尚待核验'], matchedStrategies: [] };
    members[3].mode = 'closing'; members[4].mode = 'removing';
    assert.equal(validState(old), true);
    const before = structuredClone(old), migrated = new Engine(old, f.engine.clock), group = migrated.s.agency.groups.find(g => g.id === 'swing');
    assert.equal(migrated.s.agency.version, 8); assert.equal(group.members[0].mode, holdingMode);
    assert.equal(group.members[3].mode, 'closing'); assert.equal(group.members[4].mode, 'removing');
    for (const index of [1, 2, 5, 6, 7, 8]) {
      assert.equal(group.members[index].mode, 'standby'); assert.equal(group.members[index].standbyReason, STANDBY_MIGRATION_REASON);
      assert.deepEqual(group.members[index].entryConditions, before.agency.groups.find(g => g.id === 'swing').members[index].entryConditions);
    }
    assert.equal(group.members[1].poolCheck.status, 'pass'); assert.equal(group.members[2].poolCheck.status, 'pending');
    assert.equal(migrated.agencyEvaluate('swing', group.members[1].symbol, undefined, {}).buyable, false);
    for (const key of ['cash', 'lots', 'trades', 'orders', 'risks']) assert.deepEqual(migrated.s[key], before[key]);
    assert.equal(group.cash, before.agency.groups.find(g => g.id === 'swing').cash);
    assert.equal(validState(migrated.s), true);
    assert.deepEqual(new Engine(structuredClone(migrated.s), f.engine.clock).s, migrated.s);
  }
});

test('容量helper不降级持仓或退出安排，满额不激活候补也不改候选资格', () => {
  const f = fixture(); f.add('sz000001'); f.buy();
  const held = structuredClone(f.group().members[0]);
  assert.equal(setStandby(f.engine.s, f.group().members[0], '容量满'), false); assert.deepEqual(f.group().members[0], held);
  for (let i = 0; i <= ACTIVE_CANDIDATE_LIMIT; i++) f.add(`sh${600000 + i}`);
  const standby = f.group().members.at(-1), before = structuredClone(standby);
  assert.equal(activateCandidate(f.engine.s, f.group(), standby), false); assert.deepEqual(standby, before);
  for (const mode of ['closing', 'removing']) {
    const member = { symbol: 'sh601000', mode };
    assert.equal(setStandby(f.engine.s, member), false); assert.equal(activateCandidate(f.engine.s, f.group(), member), false); assert.equal(member.mode, mode);
  }
  assert.equal(setStandby(f.engine.s, f.group().members[1], '等待重新筛选'), true);
  assert.equal(activateCandidate(f.engine.s, f.group(), standby), true);
  assert.equal(standby.mode, 'active'); assert.equal(standby.standbyReason, undefined); assert.equal(validState(f.engine.s), true);
});

test('持仓不占候选额度，满额时刚平仓成员回候补，历史成交权益仍继续追踪', () => {
  const f = fixture(); f.add('sz000001'); const buy = f.buy();
  for (let i = 0; i <= ACTIVE_CANDIDATE_LIMIT; i++) f.add(`sh${600000 + i}`);
  assert.equal(f.group().members[0].mode, 'active'); assert.equal(activeCandidateCount(f.engine.s, f.group()), ACTIVE_CANDIDATE_LIMIT);
  const standbySymbol = `sh${600000 + ACTIVE_CANDIDATE_LIMIT}`;
  assert.equal(f.group().members.at(-1).mode, 'standby');
  assert.equal(f.engine.agencyCorporateSymbols().includes(standbySymbol), false);
  f.nextDay(); f.engine.execute({ symbol: 'sz000001', side: 'sell', quantity: buy.quantity }, f.quote());
  assert.equal(f.group().members[0].mode, 'standby'); assert.equal(activeCandidateCount(f.engine.s, f.group()), ACTIVE_CANDIDATE_LIMIT);
  assert.equal(f.engine.s.lots.length, 0); assert.equal(f.engine.agencyCorporateSymbols().includes('sz000001'), true);
  assert.equal(f.engine.agencyCorporateSymbols().includes(standbySymbol), false); assert.equal(validState(f.engine.s), true);
});

test('候补公司行为追踪仅保留权益责任，不因无权益公告或仅核验记录继续刷新', () => {
  const f = fixture(); for (let i = 0; i < ACTIVE_CANDIDATE_LIMIT + 4; i++) f.add(`sh${600000 + i}`);
  const [noRights, entitlement, event, blocked] = f.group().members.slice(ACTIVE_CANDIDATE_LIMIT).map(member => member.symbol);
  assert.ok(f.group().members.slice(ACTIVE_CANDIDATE_LIMIT).every(member => member.mode === 'standby'));
  // Minimal read-only service inputs isolate symbol selection; no posting or persistence occurs.
  f.engine.s.agency.corporateActions = [{ symbol: noRights, entitlements: [] }, { symbol: entitlement, entitlements: [{ quantity: 100 }] }];
  f.engine.s.agency.corporateEvents = [{ symbol: noRights, confirmationOnly: true }, { symbol: event, confirmationOnly: false }];
  f.engine.s.agency.corporateChecks[blocked] = { status: 'blocked', affectsEquity: true };
  const symbols = f.engine.agencyCorporateSymbols();
  assert.equal(symbols.includes(noRights), false);
  for (const symbol of [entitlement, event, blocked]) assert.equal(symbols.includes(symbol), true);
});
