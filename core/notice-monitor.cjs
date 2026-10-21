'use strict';

// Only fetch the announcement index. This lane does not load reports, evaluate
// an entry or mutate account authorization. Intervals are polling targets, not
// guarantees about provider publication or detection time.
class NoticeMonitor {
  constructor({ research, getEngine, getPendingSymbols = () => [], isAvailable = () => true, onChange = () => {}, clock = Date.now,
    batchSize = 20, maxConcurrency = 2, priorityIntervalMs = 30000, candidateIntervalMs = 300000 } = {}) {
    if (!research?.get || typeof getEngine !== 'function') throw Error('公告查新缺少资料服务或账户');
    if (!Number.isInteger(batchSize) || batchSize < 2 || batchSize > 100 || !Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 3) throw Error('公告查新批次或并发参数无效');
    Object.assign(this, { research, getEngine, getPendingSymbols, isAvailable, onChange, clock, batchSize, maxConcurrency, priorityIntervalMs, candidateIntervalMs });
    this.lastAttempt = new Map(); this.errors = new Map(); this.polling = null; this.stopped = false; this.lastCheckedAt = null; this.lastError = ''; this.checked = 0; this.epoch = null;
  }
  selection() {
    const state = this.getEngine().s, now = this.clock();
    const priority = [...new Set([...this.getPendingSymbols(), ...state.lots.map(lot => lot.symbol)])];
    const prioritySet = new Set(priority);
    const candidates = [...new Set(state.agency.groups.filter(group => group.mode === 'running').flatMap(group => group.members.filter(member => member.mode === 'active').map(member => member.symbol)))].filter(symbol => !prioritySet.has(symbol));
    const due = (symbols, interval) => symbols.filter(symbol => now - (this.lastAttempt.get(symbol) ?? -Infinity) >= interval)
      .sort((a, b) => (this.lastAttempt.get(a) ?? -Infinity) - (this.lastAttempt.get(b) ?? -Infinity));
    const urgent = due(priority, this.priorityIntervalMs), ordinary = due(candidates, this.candidateIntervalMs);
    // Keep one candidate slot while priorities are busy, so a large holding set
    // cannot permanently starve the candidate rotation.
    const selected = urgent.slice(0, this.batchSize - (ordinary.length ? 1 : 0));
    return [...selected, ...ordinary.slice(0, this.batchSize - selected.length)];
  }
  poll() {
    if (this.polling) return this.polling;
    if (this.stopped || !this.isAvailable()) return Promise.resolve({ checked: 0 });
    const epoch = this.getEngine().s.agency.epoch;
    if (this.epoch !== epoch) { this.epoch = epoch; this.lastAttempt.clear(); this.errors.clear(); this.lastError = ''; this.lastCheckedAt = null; this.checked = 0; }
    const queue = this.selection();
    const live = () => !this.stopped && this.isAvailable() && this.getEngine().s.agency.epoch === epoch;
    const work = async () => {
      let checked = 0;
      await Promise.all(Array.from({ length: Math.min(this.maxConcurrency, queue.length) }, async () => {
        while (queue.length && live()) {
          const symbol = queue.shift(); this.lastAttempt.set(symbol, this.clock());
          try {
            const response = await this.research.get({ symbol, section: 'notices', force: true });
            if (!live()) return;
            const error = response.error || (!['ready', 'empty'].includes(response.status) ? '公告查新失败，等待重新核验' : '');
            if (error) this.errors.set(symbol, error); else this.errors.delete(symbol);
          } catch (error) { if (!live()) return; this.errors.set(symbol, error.message || '公告查新失败'); }
          this.lastError = [...this.errors.values()].at(-1) || '';
          this.lastCheckedAt = this.clock(); checked++; this.checked++;
        }
      }));
      if (live() && checked) this.onChange();
      return { checked };
    };
    this.polling = work().finally(() => { this.polling = null; }); return this.polling;
  }
  publicState() { return { running: !!this.polling, lastCheckedAt: this.lastCheckedAt, checked: this.checked, failedSymbols: this.errors.size, lastError: this.lastError,
    priorityIntervalSeconds: this.priorityIntervalMs / 1000, candidateIntervalSeconds: this.candidateIntervalMs / 1000 }; }
  stop() { this.stopped = true; }
}

module.exports = { NoticeMonitor };
