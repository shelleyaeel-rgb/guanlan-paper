'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { ViewStream } = require('../core/view-stream.cjs');
const receiver = require('../ui/view-stream.js');
const appPath = path.join(__dirname, '../ui/app.js'), source = fs.readFileSync(appPath, 'utf8');
const start = source.indexOf('let streamSnapshot'), end = source.indexOf('function toast', start);
assert.ok(start >= 0 && end > start);
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (epoch = 'account-a', cash = 100, now = 1) => ({ account: { cash, agency: { epoch } }, agency: { decisions: [] }, now });

// Use the real renderer subscribe, queue, retry and API functions with an
// in-memory bridge. The fake clock exercises backoff without elapsed sleeps.
function host(call) {
  let now = 10000, sequence = 0;
  const timers = new Map(), frames = [], errors = [], calls = [];
  const context = vm.createContext({ GuanlanViewReceiver: receiver, GuanlanOperations: require('../ui/operations.js'),
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    window: { guanlan: { subscribeView() {}, async call(name, payload) { calls.push(name); return call(name, payload); } } },
    renderState(value) { context.state = value; frames.push(value); },
    async action(fn) { try { return await fn(); } catch (error) { errors.push(error.message); } } });
  vm.runInContext(source.slice(start, end), context, { filename: appPath });
  return { context, frames, calls, errors, timers,
    invoke(code) { return vm.runInContext(code, context); },
    receive(envelope) { context.envelope = envelope; vm.runInContext('receiveViewEnvelope(envelope)', context); },
    async advance(milliseconds) {
      now += milliseconds;
      for (const [id, task] of [...timers]) if (task.at <= now) { timers.delete(id); task.callback(); }
      await tick();
    } };
}

test('首次订阅失败后后续patch启动有界重试，恢复基线后继续增量渲染', async () => {
  const stream = new ViewStream(), current = snapshot(); let failed = false;
  const h = host(async name => {
    assert.equal(name, 'view:subscribe');
    const data = stream.reset(current);
    if (!failed) { failed = true; throw Error('临时订阅失败'); }
    return { ok: true, data };
  });
  await assert.rejects(h.invoke('resyncView()'), /临时订阅失败/);
  current.now++; const patch = stream.next(current);
  for (let index = 0; index < 8; index++) h.receive(patch);
  assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 1, '重复patch只安排一次恢复');
  await h.advance(499); assert.equal(h.calls.length, 1);
  await h.advance(1); assert.equal(h.calls.length, 2);
  assert.deepEqual(h.frames.at(-1), current); assert.equal(h.invoke('pendingViewPatches.length'), 0);
  assert.equal(h.invoke('viewResyncPromise'), null); assert.equal(h.timers.size, 0);
  current.account.cash = 200; current.now++; h.receive(stream.next(current));
  assert.deepEqual(h.frames.at(-1), current); assert.equal(h.calls.length, 2);
});

test('丢包后的重同步失败不锁死已有基线，后续patch恢复并忽略旧账户迟到包', async () => {
  const stream = new ViewStream(); let current = snapshot(), failures = 0;
  const h = host(async () => {
    if (failures) { failures--; throw Error('临时恢复失败'); }
    return { ok: true, data: stream.reset(current) };
  });
  await h.invoke('resyncView()');
  current.now++; stream.next(current); current.now++; const late = stream.next(current);
  failures = 1; h.receive(late); await tick(); assert.equal(h.calls.length, 2);
  current = snapshot('account-b', 500, 4); h.receive(stream.next(current));
  assert.equal(h.timers.size, 1); await h.advance(500);
  assert.equal(h.calls.length, 3); assert.deepEqual(h.frames.at(-1), current);
  h.receive(late); assert.deepEqual(h.frames.at(-1), current);
  assert.equal(h.invoke('viewResyncPromise'), null);
});

test('独立全量render不覆盖stream基线，连续patch仍从正确版本计算', async () => {
  const stream = new ViewStream(), current = snapshot();
  const h = host(async () => ({ ok: true, data: stream.reset(current) }));
  await h.invoke('resyncView()');
  const external = snapshot('account-a', 999, 20); h.context.renderState(external);
  assert.equal(h.invoke('streamSnapshot.account.cash'), 100);
  current.now++; h.receive(stream.next(current));
  assert.deepEqual(h.frames.at(-1), current); assert.equal(external.account.cash, 999);
});

test('state与refresh主动读取均建立新版本基线，迟到旧账户patch不能覆盖API显示', async () => {
  for (const method of ['state', 'refresh']) {
    const stream = new ViewStream(); let current = snapshot();
    const oldApiResult = structuredClone(current);
    const h = host(async name => name === 'view:refresh' ? { ok: true, data: oldApiResult }
      : { ok: true, data: stream.reset(current) });
    await h.invoke('resyncView()');
    current.now++; const late = stream.next(current);
    current = snapshot('account-b', 500, 3);
    const result = await h.invoke(`api('${method}')`); h.context.renderState(result);
    assert.deepEqual(result, current); assert.equal(h.invoke('streamSnapshot.account.agency.epoch'), 'account-b');
    h.receive(late); assert.deepEqual(h.frames.at(-1), current);
    assert.deepEqual(h.calls, method === 'state' ? ['view:subscribe', 'view:subscribe'] : ['view:subscribe', 'view:refresh', 'view:subscribe']);
  }
});

test('主动全量读取等待旧订阅结束后重新取基线，不复用动作之前已在途的快照', async () => {
  const stream = new ViewStream(); let current = snapshot(), release, hold = false;
  const h = host(async () => {
    const data = stream.reset(current);
    if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
    return { ok: true, data };
  });
  await h.invoke('resyncView()');
  hold = true; const previous = h.invoke('resyncView()');
  current = snapshot('account-b', 500, 3);
  const pending = h.invoke("api('state')"); assert.equal(h.calls.length, 2);
  release(); await previous;
  assert.deepEqual(await pending, current); assert.equal(h.calls.length, 3);
  assert.deepEqual(h.frames.at(-1), current);
});
