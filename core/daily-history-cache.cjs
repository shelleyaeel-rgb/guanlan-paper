'use strict';
const { randomUUID } = require('node:crypto');
const { prepareHistory, preparedHistoryValid, registerDailyRevision } = require('./daily-history.cjs');
const { afterPending } = require('./fresh-request.cjs');
const DOWNLOAD_CONCURRENCY = 3;

function waitFor(work, signal, onAbort) {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); onAbort?.(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

class DailyHistoryCache {
  constructor({ store = null, clock = Date.now, refreshMs = 1800000, retryMs = 60000, onChange = () => {} } = {}) {
    Object.assign(this, { store, clock, refreshMs, retryMs, onChange });
    this.runtimeId = randomUUID();
    this.entries = new Map(); this.loaded = new Set(); this.pending = new Map(); this.nextForced = new Map();
    this.attempts = new Map(); this.errors = new Map(); this.warnings = new Map();
    this.users = new Map(); this.controllers = new Map(); this.background = new Set();
    this.activeDownloads = 0; this.downloadQueue = [];
  }
  get(key, symbol, kind) {
    if (!this.loaded.has(key)) {
      this.loaded.add(key);
      try { const entry = this.store?.read(key); if (entry) this.entries.set(key, entry); }
      catch (error) { this.warnings.set(key, `本地日线缓存读取失败，需重新获取：${error.message}`); }
    }
    const entry = this.entries.get(key);
    if (!preparedHistoryValid(entry, symbol, kind, this.clock())) return null;
    registerDailyRevision(this.runtimeId, kind, symbol, entry.dailyEvidence.barsHash);
    return entry;
  }
  view(key, entry, fresh = false) {
    const refreshError = this.errors.get(key) || '', cacheWarning = this.warnings.get(key) || '';
    return { ...structuredClone(entry), dailyEvidence: { ...entry.dailyEvidence, runtimeId: this.runtimeId },
      historyStatus: refreshError ? 'degraded' : fresh ? 'fresh' : this.pending.has(key) ? 'refreshing' : 'cached', refreshError, cacheWarning };
  }
  async fetch(key, symbol, kind, loader, signal) {
    this.attempts.set(key, this.clock());
    try {
      // Shared public-data downloads own their deadline. A cancelled screener
      // stops only its wait, never another strategy's use of the same download.
      signal.throwIfAborted();
      const value = await loader(AbortSignal.any([signal, AbortSignal.timeout(12000)]));
      signal.throwIfAborted();
      const prepared = prepareHistory(symbol, kind, value, this.clock());
      if (!prepared) {
        if (this.get(key, symbol, kind)) throw Error('日线刷新未取得覆盖最近完整交易日的完整未复权数据');
        // Legacy callers can still display short/new listings; they never earn
        // the completed-history reuse permission and cannot replace good data.
        return { ...value, dailyEvidence: null };
      }
      const previous = this.entries.get(key);
      this.entries.set(key, prepared); this.errors.delete(key);
      registerDailyRevision(this.runtimeId, kind, symbol, prepared.dailyEvidence.barsHash);
      try { this.store?.write(key, prepared); this.warnings.delete(key); }
      catch (error) { this.warnings.set(key, `日线缓存保存失败，本次仅在内存可用：${error.message}`); }
      if (previous?.dailyEvidence?.barsHash !== prepared.dailyEvidence.barsHash) {
        try { this.onChange({ symbol, kind, entry: structuredClone(prepared) }); } catch {}
      }
      return this.view(key, prepared, true);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      this.errors.set(key, error.message || '日线刷新失败');
      const cached = this.get(key, symbol, kind);
      if (cached) return this.view(key, cached);
      throw error;
    }
  }
  scheduleDownload(key, load, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const job = { key, load, signal, resolve, reject, abort: null };
      job.abort = () => {
        const index = this.downloadQueue.indexOf(job);
        if (index !== -1) this.downloadQueue.splice(index, 1);
        signal.removeEventListener('abort', job.abort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', job.abort, { once: true });
      this.downloadQueue.push(job); this.drainDownloads();
    });
  }
  drainDownloads() {
    while (this.activeDownloads < DOWNLOAD_CONCURRENCY && this.downloadQueue.length) {
      // Cold/explicit callers take the next free slot ahead of refreshes whose
      // completed history is already usable. Preserve FIFO within each lane.
      const urgent = this.downloadQueue.findIndex(job => !this.background.has(job.key) || this.users.has(job.key));
      const [job] = this.downloadQueue.splice(urgent === -1 ? 0 : urgent, 1);
      job.signal.removeEventListener('abort', job.abort);
      if (job.signal.aborted) { job.reject(job.signal.reason); continue; }
      this.activeDownloads++;
      // fetch is async; start it in this turn, just as an unqueued download.
      Promise.resolve(job.load()).then(job.resolve, job.reject).finally(() => {
        this.activeDownloads--; this.drainDownloads();
      });
    }
  }
  start(key, symbol, kind, loader, background = false) {
    if (this.pending.has(key)) return this.pending.get(key);
    const controller = new AbortController(); this.controllers.set(key, controller);
    if (background) this.background.add(key);
    // The download deadline is created by fetch only after obtaining a slot;
    // time spent waiting behind other symbols must not consume that deadline.
    const task = Promise.resolve().then(() => this.scheduleDownload(key,
      () => this.fetch(key, symbol, kind, loader, controller.signal), controller.signal)).finally(() => {
      if (this.pending.get(key) === task) { this.pending.delete(key); this.controllers.delete(key); this.background.delete(key); }
    });
    this.pending.set(key, task); return task;
  }
  async load(symbol, kind, loader, { force = false, signal = null } = {}) {
    signal?.throwIfAborted();
    const key = `${kind}:${symbol}`, cached = this.get(key, symbol, kind);
    if (!force && cached) {
      const lastAttempt = this.attempts.get(key) ?? cached.fetchedAt;
      const interval = this.errors.has(key) ? this.retryMs : this.refreshMs;
      if (this.clock() - lastAttempt >= interval && !this.pending.has(key)) this.start(key, symbol, kind, loader, true).catch(() => {});
      return this.view(key, cached);
    }
    this.users.set(key, (this.users.get(key) || 0) + 1);
    let released = false;
    const release = () => {
      if (released) return; released = true;
      const count = (this.users.get(key) || 1) - 1;
      if (count) this.users.set(key, count);
      else { this.users.delete(key); if (!this.background.has(key)) this.controllers.get(key)?.abort(); }
    };
    const work = force && this.pending.has(key)
      ? afterPending(this.pending, this.nextForced, key, () => {
        if (!this.users.has(key)) throw new DOMException('所有日线请求均已取消', 'AbortError');
        return this.start(key, symbol, kind, loader);
      })
      : this.start(key, symbol, kind, loader);
    try {
      const result = await waitFor(work, signal, release);
      signal?.throwIfAborted();
      return structuredClone(result);
    } finally { release(); }
  }
}
module.exports = { DailyHistoryCache };
