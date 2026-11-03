'use strict';
const { createHash } = require('node:crypto');
const CHANNELS = ['trade', 'order', 'strategy:buy', 'agency:transfer', 'legacy:exit'];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
function requestOf(channel, input, state) {
  if (!CHANNELS.includes(channel) || !input || typeof input.requestId !== 'string' || !/^[\w-]{1,128}$/.test(input.requestId)) throw Error('缺少有效操作编号，请刷新后重试');
  if (input.accountCreatedAt !== state.createdAt) throw Error('模拟账户已变更，请刷新后重新确认');
  const { requestId, accountCreatedAt, ...payload } = input;
  return { id: requestId, channel, accountCreatedAt, digest: createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex') };
}
function entries(state) {
  return [...(state.trades || []).map(record => [record, ['trade', 'strategy:buy', 'legacy:exit']]),
    ...(state.orders || []).map(record => [record, ['order']]),
    ...(state.agency?.transfers || []).map(record => [record, ['agency:transfer']])];
}
function validClientRequests(state) {
  if (!Array.isArray(state.trades) || !Array.isArray(state.orders)
    || state.agency?.transfers !== undefined && !Array.isArray(state.agency.transfers)) return false;
  const seen = new Set();
  for (const [record, channels] of entries(state)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const r = record.clientRequest;
    if (r === undefined) continue;
    if (!r || typeof r.id !== 'string' || !/^[\w-]{1,128}$/.test(r.id) || seen.has(r.id)
      || !channels.includes(r.channel) || r.accountCreatedAt !== state.createdAt || typeof r.digest !== 'string' || !/^[a-f0-9]{64}$/.test(r.digest)) return false;
    seen.add(r.id);
  }
  return true;
}
function sameRequest(a, b) {
  if (a.channel !== b.channel || a.digest !== b.digest) throw Error('操作编号已用于不同内容，请先核对原操作结果');
}
class AccountOperations {
  constructor(getState, transaction) { this.getState = getState; this.transaction = transaction; this.pending = new Map(); }
  capture() { const s = this.getState(); return { createdAt: s.createdAt, epoch: s.agency?.epoch }; }
  assertCurrent(identity) {
    const s = this.getState();
    if (s.createdAt !== identity.createdAt || s.agency?.epoch !== identity.epoch) throw Error('模拟账户已重置，本次操作取消，请重新确认');
  }
  receipt(request) {
    const record = entries(this.getState()).find(([record]) => record.clientRequest?.id === request.id)?.[0];
    if (record) sameRequest(record.clientRequest, request);
    return record;
  }
  key(request) { return `${this.getState().agency?.epoch}:${request.accountCreatedAt}:${request.id}`; }
  status(channel, input) {
    const request = requestOf(channel, input, this.getState()), record = this.receipt(request);
    if (record) return { status: 'committed', result: structuredClone(record) };
    const pending = this.pending.get(this.key(request));
    if (pending) sameRequest(pending.request, request);
    return { status: pending ? 'pending' : 'absent' };
  }
  run(channel, input, perform) {
    const request = requestOf(channel, input, this.getState()), record = this.receipt(request);
    if (record) return Promise.resolve(structuredClone(record));
    const key = this.key(request), prior = this.pending.get(key);
    if (prior) { sameRequest(prior.request, request); return prior.promise; }
    const identity = this.capture();
    const context = {
      assertCurrent: () => this.assertCurrent(identity),
      commit: mutate => this.transaction(() => {
        this.assertCurrent(identity);
        const result = mutate();
        if (!entries(this.getState()).some(([item]) => item === result)) throw Error('操作结果未写入账户流水');
        result.clientRequest = request;
        return structuredClone(result);
      })
    };
    const promise = Promise.resolve().then(() => { context.assertCurrent(); return perform(context); }).finally(() => this.pending.delete(key));
    this.pending.set(key, { request, promise });
    return promise;
  }
}
module.exports = { AccountOperations, validClientRequests };
