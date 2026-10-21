'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ViewStream } = require('../core/view-stream.cjs');
const { applyEnvelope } = require('../ui/view-stream.js');
const jsonCopy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return { account: { cash: 1000000, watchlist: ['sh600000'], agency: { epoch: 'account-a', revision: 7 } },
    agency: { revision: 7, groups: ['swing', 'long'].map((id, index) => ({ id, cash: 200000, mode: 'running',
      members: [{ symbol: `sh60000${index}`, reconciliation: { status: 'clear' } }], positions: [] })),
      decisions: [{ id: 'decision-1', symbol: 'sh600000', reason: '等待', executionCheck: { financeCheck: { status: 'pass' } } }],
      corporateChecks: { sh600000: { status: 'clear', checkedAt: 123 } }, runtime: { online: true } },
    agencyPool: { running: false, lastResult: { id: 'pool-a', pending: [] } }, now: 123, quotes: { sh600000: { price: 10 } } };
}
function transport() {
  const stream = new ViewStream(); let state, revision = 0;
  return { stream, get state() { return state; }, get revision() { return revision; },
    accept(packet) { const next = applyEnvelope(state, revision, packet); state = next.snapshot; revision = next.revision; return next; },
    send(snapshot, reset = false) {
      const packet = reset ? stream.reset(snapshot) : stream.next(snapshot);
      this.accept(packet); assert.deepEqual(state, jsonCopy(snapshot)); return packet;
    } };
}

test('真实sender和receiver往返保持原地修改、成员/策略增删及重排，不改上一帧', () => {
  const f = fixture(), t = transport(); t.send(f); const original = t.state, saved = jsonCopy(original);
  f.now++; f.account.cash -= 100; f.agency.groups[0].members[0].reconciliation.status = 'pending';
  f.agency.groups[0].members.push({ symbol: 'sh600100', monitoringCheck: { status: 'data' } });
  f.agency.groups[1].limits = { maxPositions: 3 }; t.send(f); assert.deepEqual(original, saved);
  f.agency.groups[0].members.shift(); f.agency.groups.reverse(); delete f.agency.groups[0].limits;
  f.agency.corporateChecks.sh600001 = { status: 'blocked' }; delete f.agency.corporateChecks.sh600000; t.send(f);
  f.agency.groups.splice(0, 1); t.send(f);
  f.agency.groups.push({ id: 'short', members: [], cash: 0 }); t.send(f);
  const unchanged = t.send(f); assert.deepEqual(unchanged.changes, []); assert.equal(unchanged.decisions, undefined);
});

test('缺基线、丢包和乱序会要求重同步，重置全量帧后旧包不能覆盖新账户', () => {
  const f = fixture(), stream = new ViewStream(), full = stream.next(f);
  f.now++; const second = stream.next(f); f.now++; const third = stream.next(f);
  assert.throws(() => applyEnvelope(undefined, 0, second), /baseline/);
  let current = applyEnvelope(undefined, 0, full), original = current.snapshot;
  assert.throws(() => applyEnvelope(current.snapshot, current.revision, third), /baseline/);
  assert.deepEqual(current.snapshot, original);
  current = applyEnvelope(current.snapshot, current.revision, second);
  const replay = applyEnvelope(current.snapshot, current.revision, second); assert.equal(replay.applied, false); assert.equal(replay.snapshot, current.snapshot);
  const fresh = fixture(); fresh.account.agency.epoch = 'account-b'; fresh.agency.groups = []; fresh.agency.decisions = [];
  current = applyEnvelope(current.snapshot, current.revision, stream.reset(fresh)); assert.deepEqual(current.snapshot, fresh);
  const late = applyEnvelope(current.snapshot, current.revision, third); assert.equal(late.applied, false); assert.equal(late.snapshot, current.snapshot);
  fresh.now++; current = applyEnvelope(current.snapshot, current.revision, stream.next(fresh)); assert.deepEqual(current.snapshot, fresh);
});

test('500条历史截断与追加发送小增量，历史内容更新和尾部删除仍精确还原', () => {
  const f = fixture(), t = transport();
  const entry = index => ({ id: `decision-${index}`, symbol: 'sh600000', reason: '完整依据'.repeat(250), financeCheck: { actual: index } });
  f.agency.decisions = Array.from({ length: 500 }, (_, index) => entry(index)); t.send(f);
  f.agency.decisions.splice(0, 20); f.agency.decisions.push(...Array.from({ length: 20 }, (_, index) => entry(index + 500)));
  const packet = t.send(f);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) < Buffer.byteLength(JSON.stringify(f)) / 10);
  f.agency.decisions[103].financeCheck.actual = -1; t.send(f);
  f.agency.decisions.splice(-3); t.send(f);
  f.agency.decisions.reverse(); t.send(f);
  f.agency.decisions = []; t.send(f);
  f.agency.decisions.push(entry(600)); t.send(f);
});

test('无ID、重复ID及null历史行保留JSON内容，不能复用错误历史片段', () => {
  const f = fixture(), t = transport();
  for (const rows of [[], [{ text: '旧记录' }, null, { id: 'same', text: '甲' }, { id: 'same', text: '乙' }],
    [{ id: 'same', text: '乙' }, { text: '无ID记录更新' }], [null, undefined], []]) {
    f.agency.decisions = rows; t.send(f);
  }
});

function setPath(value, path, replacement) {
  let target = value;
  for (const part of path.slice(0, -1)) target = target[part];
  if (replacement === undefined) delete target[path.at(-1)];
  else target[path.at(-1)] = structuredClone(replacement);
}
test('缺失、空对象、空数组、null及标量双向转换保留容器类型和所有子字段', () => {
  const paths = [['account'], ['agencyPool'], ['agency'], ['agency', 'groups'], ['agency', 'groups', 0],
    ['agency', 'groups', 0, 'members'], ['agency', 'corporateChecks'], ['agency', 'decisions']];
  const shapes = [undefined, null, {}, [], { length: 1, value: { nested: [] } }, [{ id: 'record', members: [{ symbol: 'sh600200' }] }], 0, '旧数据'];
  for (const path of paths) for (const previous of shapes) for (const next of shapes) {
    const initial = fixture(), target = fixture(), t = transport(); setPath(initial, path, previous); setPath(target, path, next);
    try { t.send(initial); t.send(target); }
    catch (error) { error.message += `\nPath: ${JSON.stringify(path)}; from ${JSON.stringify(previous)} to ${JSON.stringify(next)}`; throw error; }
  }
});

test('父容器形状变化先于子项设置，数组长度不会以删除操作传输', () => {
  const f = fixture(), t = transport(); f.agencyPool = null; f.agency.groups = null; t.send(f);
  f.agencyPool = { running: true, lastResult: {} }; f.agency.groups = [{ id: 'new', members: [{ symbol: 'sh600001' }] }];
  const patch = t.send(f), paths = patch.changes.map(change => JSON.stringify(change.path));
  assert.ok(paths.indexOf('["agencyPool"]') < paths.indexOf('["agencyPool","lastResult"]'));
  assert.ok(paths.indexOf('["agency","groups"]') < paths.indexOf('["agency","groups",0,"members",0]'));
  f.agency.groups = {}; const converted = t.send(f);
  assert.ok(converted.changes.every(change => !(change.remove && change.path.at(-1) === 'length')));
});

test('坏包不会部分修改已显示快照，非法路径与决策操作被拒绝', () => {
  const f = fixture(), t = transport(); t.send(f); const original = t.state, saved = jsonCopy(original);
  const packet = changes => ({ format: 'guanlan-view-v1', kind: 'patch', baseRevision: t.revision, revision: t.revision + 1, changes });
  for (const changes of [
    [{ path: ['account', 'cash'], json: '5' }, { path: ['agencyPool'], json: '{broken' }],
    [{ path: ['__proto__', 'polluted'], json: 'true' }],
    [{ path: ['agency', 'groups', '0'], json: '{}' }],
    [{ path: ['agency', 'groups', 'length'], remove: true }]
  ]) assert.throws(() => applyEnvelope(original, t.revision, packet(changes)));
  assert.throws(() => applyEnvelope(original, t.revision, { ...packet([{ path: ['account', 'cash'], json: '5' }]),
    decisions: [{ start: 999, deleteCount: 0, json: '[]' }] }), /splice/);
  assert.deepEqual(original, saved); assert.equal(Object.prototype.polluted, undefined);
});
