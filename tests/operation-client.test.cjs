'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { OperationClient } = require('../ui/operations.js');
function fixture() {
  const saved = new Map(), account = { createdAt: 'original', dataPath: 'isolated' }, sent = []; let id = 0;
  const opts = { storage: { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) }, account: () => account,
    uuid: () => `request-${++id}`, call: async (channel, payload) => { sent.push({ channel, payload }); throw Error('lost reply'); } };
  return { account, sent, opts, client: new OperationClient(opts) };
}
test('丢失回复后跨重载保留同一请求，成功核对后才清除', async () => {
  const f = fixture(); await assert.rejects(f.client.send('trade', { symbol: 'sz000001', quantity: 100 }), /尚未收到/);
  const id = f.client.pending().request.requestId, reloaded = new OperationClient(f.opts);
  await assert.rejects(reloaded.send('trade', { symbol: 'sz000001', quantity: 200 }), /待核对/);
  reloaded.call = async (channel, request) => { assert.equal(request.requestId, id); return { ok: true, data: { id: 'original-trade' } }; };
  assert.equal((await reloaded.send('trade', { quantity: 100, symbol: 'sz000001' })).id, 'original-trade'); assert.equal(reloaded.pending(), null);
});
test('查询已提交不重发；只能在确认未执行后放弃，传输失败不清除', async () => {
  const f = fixture(); await assert.rejects(f.client.send('order', { quantity: 100 }));
  await assert.rejects(f.client.query({ discardAbsent: true })); assert.ok(f.client.pending());
  f.client.call = async channel => { assert.equal(channel, 'operation:status'); return { ok: true, data: { status: 'pending' } }; };
  await f.client.query({ discardAbsent: true }); assert.ok(f.client.pending());
  f.client.call = async () => ({ ok: true, data: { status: 'absent' } });
  await f.client.query(); assert.ok(f.client.pending()); await f.client.query({ discardAbsent: true }); assert.equal(f.client.pending(), null);
  await assert.rejects(new OperationClient(f.opts).send('trade', {}));
  f.client.call = async () => ({ ok: true, data: { status: 'committed', result: { id: 'saved' } } });
  assert.equal((await f.client.query()).result.id, 'saved'); assert.equal(f.client.pending(), null);
});
test('并发提交共用编号和请求；执行期间不能取消待核对记录', async () => {
  const f = fixture(); let release;
  f.client.call = () => new Promise(resolve => { release = resolve; });
  const first = f.client.send('trade', { quantity: 100 }), second = f.client.send('trade', { quantity: 100 });
  assert.equal((await f.client.query({ discardAbsent: true })).status, 'pending'); assert.ok(f.client.pending());
  release({ ok: true, data: 1 }); assert.deepEqual(await Promise.all([first, second]), [1, 1]);
});
test('账户及数据目录隔离，确认前账户身份失效不提交；存储失败不发请求', async () => {
  const f = fixture(); await assert.rejects(f.client.send('trade', {})); const pending = f.client.pending();
  f.account.createdAt = 'new'; assert.equal(f.client.pending(), null);
  await assert.rejects(f.client.send('trade', { accountCreatedAt: 'original' }), /账户已变更/);
  assert.equal(f.sent.length, 1); f.account.createdAt = 'original'; assert.deepEqual(f.client.pending(), pending);
  f.account.dataPath = 'other'; assert.equal(f.client.pending(), null);
  f.opts.storage.setItem = () => { throw Error('storage unavailable'); };
  await assert.rejects(f.client.send('trade', {}), /storage unavailable/); assert.equal(f.sent.length, 1);
});
