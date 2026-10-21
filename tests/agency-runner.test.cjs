const test = require('node:test');
const assert = require('node:assert/strict');
const { AgencyRunner } = require('../core/agency-runner.cjs');
const { AgencyRulesError } = require('../core/agency-rules.cjs');
const START = Date.parse('2026-10-08T10:00:00+08:00');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
function fixture(options = {}) {
  let now = START, groups = options.groups || [{ id: 'swing', token: 'account1:revision1', enabled: true }];
  const requests = [], commits = [], logs = [];
  const runner = new AgencyRunner({ clock: () => now, getGroups: () => groups,
    getCandidates: options.getCandidates || (async group => ({ token: group.token, candidates: [{ symbol: 'sh600519' }], context: {} })),
    evaluateRules: async input => { requests.push(input); return options.evaluateRules ? options.evaluateRules(input) : { decisions: [], expiresAt: now + 120000 }; },
    commit: options.commit || (async (...args) => { commits.push(args); }), log: item => logs.push(item) });
  return { runner, requests, commits, logs, advance: ms => { now += ms; }, groups: () => groups, replace: value => { groups = value; } };
}
test('显式调度按五分钟间隔，无重复在途调用且事件可提前触发', async () => {
  const pending = deferred(), f = fixture({ evaluateRules: async () => pending.promise });
  assert.equal((await f.runner.poll()).started, 1); await tick();
  assert.equal((await f.runner.poll({ force: true })).started, 0); assert.equal(f.requests.length, 1);
  pending.resolve({ decisions: [], expiresAt: START + 120000 }); await f.runner.drain(); assert.equal(f.commits.length, 1);
  assert.equal((await f.runner.poll()).started, 0); f.advance(299999); assert.equal((await f.runner.poll()).started, 0);
  f.advance(1); assert.equal((await f.runner.poll()).started, 1); await f.runner.drain();
});
test('每次最多并行两组，完成后的下一次轮询可调度其余策略', async () => {
  const pending = deferred(), f = fixture({ groups: ['ultra-short', 'short', 'swing', 'long'].map(id => ({ id, token: '1', enabled: true })), evaluateRules: async () => pending.promise });
  assert.equal((await f.runner.poll()).started, 2); await tick(); assert.equal(f.requests.length, 2);
  assert.equal((await f.runner.poll()).started, 0);
  pending.resolve({ decisions: [], expiresAt: START + 120000 }); await f.runner.drain();
  assert.equal((await f.runner.poll()).started, 2); await f.runner.drain(); assert.equal(f.requests.length, 4);
});
test('账户重置、策略暂停、成员移出或版本改变后，迟到响应不能提交', async () => {
  for (const change of [groups => { groups[0].token = 'account2:revision1'; }, groups => { groups[0].enabled = false; }, groups => { groups.length = 0; }, groups => { groups[0].token = 'account1:revision2'; }]) {
    const pending = deferred(), f = fixture({ evaluateRules: () => pending.promise }); await f.runner.poll(); await tick();
    change(f.groups()); pending.resolve({ decisions: [], expiresAt: START + 120000 }); await f.runner.drain();
    assert.equal(f.commits.length, 0); assert.equal(f.logs.at(-1).type, 'stale');
  }
});
test('准备数据过程中状态改变则不继续本地规则检查，已过期决策也不提交', async () => {
  const pending = deferred(), f = fixture({ getCandidates: async group => { await pending.promise; return { token: group.token, candidates: [{}] }; } });
  await f.runner.poll(); await tick(); f.groups()[0].token = 'new'; pending.resolve(); await f.runner.drain();
  assert.equal(f.requests.length, 0); assert.equal(f.commits.length, 0);
  const expired = fixture({ evaluateRules: async () => ({ decisions: [], expiresAt: START }) }); await expired.runner.poll(); await expired.runner.drain(); assert.equal(expired.commits.length, 0);
});
test('规则检查失败不产生交易，受信错误可见而外部异常细节不进入日志', async () => {
  const f = fixture({ evaluateRules: async () => { throw Error('secret-key in upstream response'); } }); await f.runner.poll(); await f.runner.drain();
  assert.equal(f.commits.length, 0); assert.doesNotMatch(JSON.stringify(f.runner.status()), /secret-key/); assert.equal(f.logs.at(-1).type, 'error');
  const safe = fixture({ evaluateRules: async () => { throw new AgencyRulesError('规则检查输入无效，本次不交易'); } }); await safe.runner.poll(); await safe.runner.drain(); assert.match(safe.runner.status().lastError, /输入无效/);
});
test('停止或使在途检查失效后不提交；可恢复并重新检查', async () => {
  const pending = deferred(), f = fixture({ evaluateRules: () => pending.promise }); await f.runner.poll(); await tick(); f.runner.stop();
  pending.resolve({ decisions: [], expiresAt: START + 120000 }); await f.runner.drain(); assert.equal(f.commits.length, 0); assert.equal((await f.runner.poll({ force: true })).started, 0);
  f.runner.resume(); assert.equal((await f.runner.poll({ force: true })).started, 1); await f.runner.drain(); assert.equal(f.commits.length, 1);
  const invalidated = fixture(); await invalidated.runner.poll(); invalidated.runner.invalidate(); await invalidated.runner.drain(); assert.equal(invalidated.commits.length, 0);
});
test('候选快照缺少一致token时拒绝检查，日志有界', async () => {
  const f = fixture({ getCandidates: async () => ({ token: 'wrong', candidates: [{}] }) });
  for (let index = 0; index < 205; index++) { await f.runner.poll({ force: true }); await f.runner.drain(); }
  assert.equal(f.requests.length, 0); assert.equal(f.runner.status().logs.length, 200);
});
test('调度间隔固定五分钟，手动触发把强制刷新标记传递给取数', async () => {
  const groups = [], f = fixture({ getCandidates: async group => { groups.push(group); return { token: group.token, candidates: [{}] }; } });
  await f.runner.poll({ force: true }); await f.runner.drain();
  assert.equal(groups[0].forceRefresh, true); assert.equal(f.runner.intervalMs, 300000);
  assert.equal(Object.getOwnPropertyDescriptor(f.runner, 'intervalMs').writable, false);
});

test('全轮未完成的组可连续分批检查，多个大组公平轮转而不是前两组占满槽位', async () => {
  const groups = ['ultra-short', 'short', 'swing', 'long'].map(id => ({ id, token: '1', enabled: true, continueCycle: true }));
  const f = fixture({ groups });
  for (let i = 0; i < 4; i++) { assert.equal((await f.runner.poll()).started, 2); await f.runner.drain(); }
  assert.deepEqual(f.requests.map(request => request.strategyId), ['ultra-short', 'short', 'swing', 'long', 'ultra-short', 'short', 'swing', 'long']);
  for (const group of groups) group.continueCycle = false;
  assert.equal((await f.runner.poll()).started, 0);
});

test('完整检查的五分钟等待从完成时计，不被本次慢速取数耗时缩短', async () => {
  const pending = deferred(), f = fixture({ getCandidates: async group => { await pending.promise; return { token: group.token, candidates: [{}] }; } });
  await f.runner.poll(); await tick(); f.advance(60000); pending.resolve(); await f.runner.drain();
  f.advance(240000); assert.equal((await f.runner.poll()).started, 0);
  f.advance(59999); assert.equal((await f.runner.poll()).started, 0);
  f.advance(1); assert.equal((await f.runner.poll()).started, 1); await f.runner.drain();
});
