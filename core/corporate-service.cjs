'use strict';
const { symbolOf, cnTime } = require('./common.cjs');
const { calendarSession } = require('./trading-calendar.cjs');
const { entryConditionNeedsFundamentals } = require('./entry-conditions.cjs');
const COMMIT_BATCH_SIZE = 5;

// Fetch evidence outside account transactions. Only the engine may interpret it
// or change the ledger; checking company actions never submits an order.
class CorporateService {
  constructor({ source, getEngine, transaction, market, getMonitor, acceptQuotes = () => {}, onChange = () => {},
    isAvailable = () => true, clock = Date.now, intervalMs = 300000, retryMs = 60000,
    calendar = calendarSession, scheduleCommit = setImmediate } = {}) {
    Object.assign(this, { source, getEngine, transaction, market, getMonitor, acceptQuotes, onChange, isAvailable, clock, intervalMs, retryMs, calendar, scheduleCommit });
    this.lastAttempt = new Map(); this.lastCheck = new Map(); this.inflight = new Map(); this.polling = null;
    this.ready = []; this.commitScheduled = false; this.storageError = null;
  }
  available() { return !this.storageError && this.isAvailable(); }
  syncEpoch() {
    const epoch = this.getEngine().s.agency.epoch;
    if (this.epoch !== epoch) {
      this.epoch = epoch; this.lastAttempt.clear(); this.lastCheck.clear(); this.inflight.clear(); this.polling = null;
    }
    return epoch;
  }
  sessionKey(now = this.clock()) {
    const at = this.calendar(new Date(now));
    if (!at.open || at.known === false) return null;
    const time = cnTime(now);
    return `${time.date}:${time.minutes < 780 ? 'morning' : 'afternoon'}`;
  }
  prioritize(symbols) {
    const held = new Set(this.getEngine().s.lots.map(lot => lot.symbol));
    return symbols.slice().sort((left, right) => Number(held.has(right)) - Number(held.has(left)));
  }
  symbols() {
    if (this.getEngine().agencyCorporateSymbols) return this.getEngine().agencyCorporateSymbols();
    const s = this.getEngine().s;
    return [...new Set([
      ...s.lots.filter(l => l.owner && l.owner !== 'manual').map(l => l.symbol),
      ...s.trades.filter(t => t.owner && t.owner !== 'manual').map(t => t.symbol),
      ...s.agency.groups.flatMap(g => g.members.map(m => m.symbol))
    ])];
  }
  fromDate(symbol) {
    const s = this.getEngine().s, today = cnTime(this.clock()).date;
    const dates = s.trades.filter(t => t.symbol === symbol && t.owner && t.owner !== 'manual')
      .map(t => cnTime(t.time).date).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date));
    const member = s.agency.groups.flatMap(g => g.members).find(m => m.symbol === symbol);
    if (member?.lastVerifiedDate) dates.push(member.lastVerifiedDate);
    // An unheld candidate needs recent evidence, not the account's entire history.
    dates.push(new Date(Date.parse(today) - 14 * 86400000).toISOString().slice(0, 10));
    return dates.sort()[0];
  }
  async getSnapshot(symbol, force = false) {
    symbol = symbolOf(symbol);
    if (!this.symbols().includes(symbol)) return null;
    const fromDate = this.fromDate(symbol);
    try { return await this.source.get({ symbol, fromDate, force }); }
    catch (error) {
      return { symbol, status: 'unavailable', fetchedAt: this.clock(), coverageStart: fromDate,
        coverageComplete: false, events: [], notices: [], error: error.message || '公司行为资料获取失败' };
    }
  }
  async verifyOne(symbol, force = false) {
    symbol = symbolOf(symbol);
    const epoch = this.syncEpoch();
    if (this.inflight.has(symbol)) {
      const pending = this.inflight.get(symbol);
      const result = await pending.promise;
      return force && !pending.force && this.getEngine().s.agency.epoch === epoch ? this.verifyOne(symbol, true) : result;
    }
    const session = this.sessionKey();
    const remember = result => {
      if (this.getEngine().s.agency.epoch !== epoch || result.status === 'skipped') return;
      this.lastAttempt.set(symbol, this.clock()); this.lastCheck.set(symbol, { ...result, session });
    };
    const task = (async () => {
      if (this.storageError) throw this.storageError;
      if (!this.available() || !this.symbols().includes(symbol)) return { symbol, status: 'skipped' };
      this.lastAttempt.set(symbol, this.clock());
      this.lastCheck.set(symbol, { status: 'waiting', session });
      const monitor = this.getMonitor(), group = this.getEngine().s.agency.groups.find(g => g.members.some(m => m.symbol === symbol));
      const member = group?.members.find(item => item.symbol === symbol);
      const snapshot = await monitor.load(symbol, force, group?.id === 'long' || entryConditionNeedsFundamentals(member?.entryConditions), true);
      if (!this.available() || this.getEngine().s.agency.epoch !== epoch || !this.symbols().includes(symbol)) return { symbol, status: 'skipped' };
      // Custom/older monitors may not have the corporate evidence extension.
      if (!snapshot.corporateActions) snapshot.corporateActions = await this.getSnapshot(symbol, force);
      const fresh = await this.market.quotes([symbol]).catch(() => ({}));
      if (this.storageError) throw this.storageError;
      if (!this.available() || this.getEngine().s.agency.epoch !== epoch || !this.symbols().includes(symbol)) return { symbol, status: 'skipped' };
      return this.enqueueCheck({ symbol, epoch, fresh, snapshot });
    })().then(result => { remember(result); return result; }, error => {
      remember({ symbol, status: 'waiting' }); throw error;
    }).finally(() => { if (this.inflight.get(symbol)?.promise === task) this.inflight.delete(symbol); });
    this.inflight.set(symbol, { promise: task, force }); return task;
  }
  enqueueCheck(input) {
    return new Promise((resolve, reject) => {
      this.ready.push({ ...input, resolve, reject }); this.scheduleReady();
    });
  }
  scheduleReady() {
    if (this.commitScheduled || !this.ready.length) return;
    this.commitScheduled = true;
    this.scheduleCommit(() => this.flushReady());
  }
  current(job) {
    return this.available() && this.getEngine().s.agency.epoch === job.epoch && this.symbols().includes(job.symbol);
  }
  applyCheck({ symbol, fresh, snapshot }) {
    const engine = this.getEngine(), member = engine.s.agency.groups.flatMap(g => g.members).find(m => m.symbol === symbol);
    if (member) {
      const previousCheck = member.automaticCheck;
      // The engine checks source age at commit time, after any queue delay.
      const reason = typeof engine.agencyPrepare === 'function'
        ? engine.agencyPrepare(symbol, fresh[symbol], snapshot) : engine.agencyAutomaticBlock(symbol, fresh[symbol], snapshot);
      const current = engine.s.agency.groups.flatMap(g => g.members).find(m => m.symbol === symbol);
      const check = current?.automaticCheck;
      // A retained reconciliation latch may coexist with a current data wait.
      const freshCheck = check && check !== previousCheck && check.reason === (reason || '')
        && ['clear', 'waiting', 'blocked'].includes(check.status);
      const status = freshCheck ? check.status
        : reason ? (current?.reconciliation.status === 'pending' ? 'blocked' : 'waiting') : 'clear';
      return { symbol, status, reason: reason || '', ...(freshCheck && check.phase ? { phase: check.phase } : {}) };
    }
    const checked = engine.agencyProcessCorporateActions(symbol, fresh[symbol], snapshot);
    return { symbol, ...checked, status: checked.status === 'unavailable' ? 'waiting' : checked.status };
  }
  flushReady() {
    this.commitScheduled = false;
    const held = new Set(this.getEngine().s.lots.map(lot => lot.symbol));
    this.ready.sort((left, right) => Number(held.has(right.symbol)) - Number(held.has(left.symbol)));
    const jobs = this.ready.splice(0, COMMIT_BATCH_SIZE), active = [];
    for (const job of jobs) {
      if (this.storageError) job.reject(this.storageError);
      else if (!this.current(job)) job.resolve({ symbol: job.symbol, status: 'skipped' });
      else active.push(job);
    }
    if (active.length) {
      let entered = false, completed = false, writing = false, results, failure;
      try {
        for (const job of active) this.acceptQuotes(job.fresh);
        // Only ready evidence is batched. No network wait or partially saved
        // success is exposed inside this synchronous account transaction.
        writing = true;
        results = this.transaction(() => {
          entered = true;
          const values = active.map(job => this.current(job) ? this.applyCheck(job) : { symbol: job.symbol, status: 'skipped' });
          completed = true; return values;
        });
      } catch (error) {
        failure = error;
        if (writing && (!entered || completed)) this.storageError = error;
      }
      if (failure) for (const job of active) job.reject(failure);
      else {
        active.forEach((job, index) => job.resolve(results[index]));
        this.onChange();
      }
    }
    this.scheduleReady();
  }
  async verify(input) {
    const group = this.getEngine().s.agency.groups.find(g => g.id === input?.strategyId);
    if (!group) throw Error('自动交易策略无效');
    let symbols = [...new Set([...group.members.map(m => m.symbol),
      ...this.getEngine().s.trades.filter(t => t.owner === group.id).map(t => t.symbol)])];
    if (input?.symbol != null) {
      const symbol = symbolOf(input.symbol);
      if (!symbols.includes(symbol)) throw Error('股票不属于该策略的成员或历史权益');
      symbols = [symbol];
    }
    return this.checkMany(symbols, true);
  }
  async checkMany(symbols, force) {
    if (this.storageError) throw this.storageError;
    const epoch = this.syncEpoch();
    const queue = this.prioritize(symbols), results = [];
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length && this.available() && this.getEngine().s.agency.epoch === epoch) {
        const symbol = queue.shift();
        try { results.push(await this.verifyOne(symbol, force)); }
        catch (error) {
          if (this.storageError) throw this.storageError;
          // A failed symbol remains pending and must not prevent the rest of
          // the candidate list from preparing or recovering automatically.
          results.push({ symbol, status: 'waiting', reason: error.message || '自动核验资料暂不可用' });
        }
      }
    }));
    return { checked: results.length, ...Object.fromEntries(['clear', 'waiting', 'blocked', 'skipped'].map(status => [status, results.filter(r => r.status === status).length])), results };
  }
  poll() {
    this.syncEpoch();
    if (this.polling) return this.polling;
    const now = this.clock(), session = this.sessionKey(now);
    const symbols = this.prioritize(this.symbols().filter(symbol => {
      const previous = this.lastCheck.get(symbol);
      const interval = previous?.phase === 'prepared' || previous?.status === 'clear' ? this.intervalMs : this.retryMs;
      return (session && previous?.session !== session) || now - (this.lastAttempt.get(symbol) ?? -Infinity) >= interval;
    })).sort((left, right) => (this.lastAttempt.get(left) ?? -Infinity) - (this.lastAttempt.get(right) ?? -Infinity)).slice(0, 20);
    // Old account work may still settle after a reset starts a new poll.
    const polling = this.checkMany(symbols, false).finally(() => { if (this.polling === polling) this.polling = null; });
    this.polling = polling; return polling;
  }
}
module.exports = { CorporateService };
