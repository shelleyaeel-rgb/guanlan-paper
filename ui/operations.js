(function(root) {
  'use strict';
  const channels = ['trade', 'order', 'strategy:buy', 'agency:transfer'];
  const stable = value => JSON.stringify(value, function(key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item;
  });
  class OperationClient {
    constructor({ storage, account, call, uuid, onChange = () => {} }) {
      Object.assign(this, { storage, account, call, uuid, onChange }); this.inflight = new Map();
    }
    scope() {
      const account = this.account();
      if (!account?.createdAt || !account?.dataPath) throw Error('账户尚未就绪');
      return { ...account, key: `guanlan-operation:${account.dataPath}:${account.createdAt}` };
    }
    pending(scope = this.scope()) { return JSON.parse(this.storage.getItem(scope.key) || 'null'); }
    clear(scope, id) {
      if (this.pending(scope)?.request.requestId === id) this.storage.removeItem(scope.key);
      this.onChange();
    }
    async send(channel, payload) {
      const scope = this.scope();
      if (payload?.accountCreatedAt && payload.accountCreatedAt !== scope.createdAt) throw Error('模拟账户已变更，请重新确认');
      const business = { ...payload, accountCreatedAt: scope.createdAt }; delete business.requestId;
      let pending = this.pending(scope);
      if (pending) {
        const previous = { ...pending.request }; delete previous.requestId;
        if (pending.channel !== channel || stable(previous) !== stable(business)) throw Error('有一笔操作结果待核对，请先处理页面上方的待核对操作');
      } else {
        pending = { channel, request: { ...business, requestId: this.uuid() } };
        // If durable retry identity cannot be stored, do not send the operation.
        this.storage.setItem(scope.key, JSON.stringify(pending)); this.onChange();
      }
      return this.submit(scope, pending);
    }
    submit(scope, pending) {
      const id = pending.request.requestId;
      if (this.inflight.has(id)) return this.inflight.get(id);
      const promise = Promise.resolve().then(async () => {
        let response;
        try { response = await this.call(pending.channel, pending.request); }
        catch { throw Error('尚未收到操作结果，请在待核对操作中查询或重试同一笔'); }
        if (!response || typeof response.ok !== 'boolean') throw Error('操作结果不完整，请核对同一笔操作');
        this.clear(scope, id);
        if (!response.ok) throw Error(response.error);
        return response.data;
      }).finally(() => { this.inflight.delete(id); this.onChange(); });
      this.inflight.set(id, promise); return promise;
    }
    async query({ discardAbsent = false } = {}) {
      const scope = this.scope(), pending = this.pending(scope);
      if (!pending) return { status: 'none' };
      if (this.inflight.has(pending.request.requestId)) return { status: 'pending' };
      const response = await this.call('operation:status', pending);
      if (!response?.ok) throw Error(response?.error || '暂时无法核对操作');
      if (this.inflight.has(pending.request.requestId)) return { status: 'pending' };
      if (response.data.status === 'committed' || (discardAbsent && response.data.status === 'absent')) this.clear(scope, pending.request.requestId);
      return response.data;
    }
    retry() {
      const scope = this.scope(), pending = this.pending(scope);
      if (!pending) throw Error('没有待核对操作');
      return this.submit(scope, pending);
    }
  }
  const api = { OperationClient, channels };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GuanlanOperations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
