'use strict';
const { symbolOf, cnTime } = require('./common.cjs');
const { calendarSession } = require('./trading-calendar.cjs');
const { publicDailyHistory } = require('./daily-history.cjs');
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
    this.preparing = new Map(); this.lastPreparation = new Map(); this.latestEvidence = new Map();
  }
  available() { return !this.storageError && this.isAvailable(); }
  syncEpoch() {
    const epoch = this.getEngine().s.agency.epoch;
    if (this.epoch !== epoch) {
      this.epoch = epoch; this.lastAttempt.clear(); this.lastCheck.clear(); this.inflight.clear(); this.polling = null;
      this.preparing.clear(); this.lastPreparation.clear(); this.latestEvidence.clear();
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
  preparationSymbols() {
    return [...new Set([...this.symbols(), ...this.getEngine().s.agency.groups.flatMap(group => group.members
      .filter(member => member.mode !== 'standby').map(member => member.symbol))])];
  }
  requiresEvidence(symbol) {
    const engine = this.getEngine();
    return typeof engine.agencyNeedsCorporateEvidence === 'function' ? engine.agencyNeedsCorporateEvidence(symbol) : true;
  }
  canVerify(symbol, explicitStrategyId) {
    return this.preparationSymbols().includes(symbol) || Boolean(explicitStrategyId
      && this.getEngine().s.agency.groups.some(group => group.id === explicitStrategyId
        && group.members.some(member => member.symbol === symbol)));
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
  async getSnapshot(symbol, force = false, explicitStrategyId) {
    symbol = symbolOf(symbol);
    if (!this.canVerify(symbol, explicitStrategyId) || !this.requiresEvidence(symbol)) return null;
    const fromDate = this.fromDate(symbol), epoch = this.getEngine().s.agency.epoch;
    let result;
    try { result = await this.source.get({ symbol, fromDate, force }); }
    catch (error) {
      result = { symbol, status: 'unavailable', fetchedAt: this.clock(), coverageStart: fromDate,
        coverageComplete: false, events: [], notices: [], error: error.message || '公司行为资料获取失败' };
    }
    if (this.getEngine().s.agency.epoch === epoch && this.canVerify(symbol, explicitStrategyId)) this.latestEvidence.set(symbol, result);
    return result;
  }
  preparedSnapshot(symbol) {
    return this.getMonitor()?.peekPrepared?.(symbol, false, false) || null;
  }
  prepareWarm() {
    const monitor = this.getMonitor();
    if (!this.available() || typeof monitor?.prepare !== 'function') return;
    const epoch = this.epoch, now = this.clock();
    // Refresh already assembled evidence ahead of expiry in its own lane. These
    // jobs never take an account transaction or gate the opening quote lane.
    const candidates = this.prioritize(this.preparationSymbols().filter(symbol => monitor.snapshots?.[symbol] && !this.preparing.has(symbol)
      && !this.inflight.has(symbol) && now - (this.lastPreparation.get(symbol) ?? -Infinity) >= 15000))
      .sort((left, right) => (this.lastPreparation.get(left) ?? -Infinity) - (this.lastPreparation.get(right) ?? -Infinity));
    for (const symbol of candidates.slice(0, Math.max(0, 2 - this.preparing.size))) {
      this.lastPreparation.set(symbol, now);
      const task = monitor.prepare(symbol, false, false).catch(() => {}).finally(() => {
        if (this.getEngine().s.agency.epoch === epoch && this.preparing.get(symbol) === task) this.preparing.delete(symbol);
      });
      this.preparing.set(symbol, task);
    }
  }
  async verifyOne(symbol, force = false, explicitStrategyId) {
    symbol = symbolOf(symbol);
    const epoch = this.syncEpoch();
    if (this.inflight.has(symbol)) {
      const pending = this.inflight.get(symbol);
      const result = await pending.promise;
      return force && (!pending.force || explicitStrategyId && pending.explicitStrategyId !== explicitStrategyId)
        && this.getEngine().s.agency.epoch === epoch ? this.verifyOne(symbol, true, explicitStrategyId) : result;
    }
    const session = this.sessionKey();
    const remember = result => {
      if (this.getEngine().s.agency.epoch !== epoch || result.status === 'skipped') return;
      this.lastAttempt.set(symbol, this.clock()); this.lastCheck.set(symbol, { ...result, session });
    };
    const task = (async () => {
      if (this.storageError) throw this.storageError;
      if (!this.available() || !this.canVerify(symbol, explicitStrategyId)) return { symbol, status: 'skipped' };
      const explicitStandby = explicitStrategyId && !this.preparationSymbols().includes(symbol);
      this.lastAttempt.set(symbol, this.clock());
      this.lastCheck.set(symbol, { status: 'waiting', session });
      const monitor = this.getMonitor();
      let snapshot = !force && this.preparedSnapshot(symbol)
        || await monitor.load(symbol, force, false, false);
      if (!this.available() || this.getEngine().s.agency.epoch !== epoch || !this.canVerify(symbol, explicitStrategyId)) return { symbol, status: 'skipped' };
      // Custom/older monitors may not have the corporate evidence extension.
      // A standby member is absent from normal monitor polling; an explicit
      // verification must replace any old corporate evidence it retained.
      if (this.requiresEvidence(symbol) && (!snapshot.corporateActions || explicitStandby)) snapshot = { ...snapshot,
        corporateActions: await this.getSnapshot(symbol, force, explicitStrategyId) };
      if (!this.available() || this.getEngine().s.agency.epoch !== epoch || !this.canVerify(symbol, explicitStrategyId)) return { symbol, status: 'skipped' };
      const fresh = await this.market.quotes([symbol]).catch(() => ({}));
      if (this.storageError) throw this.storageError;
      if (!this.available() || this.getEngine().s.agency.epoch !== epoch || !this.canVerify(symbol, explicitStrategyId)) return { symbol, status: 'skipped' };
      return this.enqueueCheck({ symbol, epoch, fresh, snapshot, explicitStrategyId });
    })().then(result => { remember(result); return result; }, error => {
      remember({ symbol, status: 'waiting' }); throw error;
    }).finally(() => { if (this.inflight.get(symbol)?.promise === task) this.inflight.delete(symbol); });
    this.inflight.set(symbol, { promise: task, force, explicitStrategyId }); return task;
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
    return this.available() && this.getEngine().s.agency.epoch === job.epoch && this.canVerify(job.symbol, job.explicitStrategyId);
  }
  applyCheck({ symbol, fresh, snapshot }) {
    snapshot = this.getMonitor()?.verificationSnapshot?.(symbol, snapshot, false) || snapshot;
    const latestCorporate = this.latestEvidence.get(symbol);
    if (this.requiresEvidence(symbol) && latestCorporate && latestCorporate !== snapshot.corporateActions) snapshot = { ...snapshot, corporateActions: latestCorporate };
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
      const dailyHistory = publicDailyHistory(snapshot, this.clock(), symbol);
      return { symbol, status, reason: reason || '', ...(freshCheck && check.phase ? { phase: check.phase } : {}), ...(dailyHistory ? { dailyHistory } : {}) };
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
    return this.checkMany(symbols, true, group.id);
  }
  async checkMany(symbols, force, explicitStrategyId) {
    if (this.storageError) throw this.storageError;
    const epoch = this.syncEpoch();
    const ordered = this.prioritize(symbols), prepared = force ? [] : ordered.filter(symbol => this.preparedSnapshot(symbol));
    const preparedSet = new Set(prepared), cold = ordered.filter(symbol => !preparedSet.has(symbol)), results = [];
    const run = (queue, concurrency) => Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length && this.available() && this.getEngine().s.agency.epoch === epoch) {
        const symbol = queue.shift();
        try { results.push(await this.verifyOne(symbol, force, explicitStrategyId)); }
        catch (error) {
          if (this.storageError) throw this.storageError;
          // A failed symbol remains pending and must not prevent the rest of
          // the candidate list from preparing or recovering automatically.
          results.push({ symbol, status: 'waiting', reason: error.message || '自动核验资料暂不可用' });
        }
      }
    }));
    await Promise.all([run(prepared, 5), run(cold, 2)]);
    return { checked: results.length, ...Object.fromEntries(['clear', 'waiting', 'blocked', 'skipped'].map(status => [status, results.filter(r => r.status === status).length])),
      cached: results.filter(r => r.dailyHistory && r.dailyHistory.status !== 'fresh').length,
      degraded: results.filter(r => r.dailyHistory?.refreshError).length, results };
  }
  poll() {
    this.syncEpoch();
    this.prepareWarm();
    const now = this.clock(), session = this.sessionKey(now);
    const symbols = this.prioritize(this.preparationSymbols().filter(symbol => {
      if (this.inflight.has(symbol)) return false;
      // A slow previous batch cannot hold already prepared members behind it.
      if (this.polling && !this.preparedSnapshot(symbol)) return false;
      const previous = this.lastCheck.get(symbol);
      const interval = previous?.phase === 'prepared' || previous?.status === 'clear' ? this.intervalMs : this.retryMs;
      return (session && previous?.session !== session) || now - (this.lastAttempt.get(symbol) ?? -Infinity) >= interval;
    })).sort((left, right) => (this.lastAttempt.get(left) ?? -Infinity) - (this.lastAttempt.get(right) ?? -Infinity)).slice(0, 20);
    if (this.polling && !symbols.length) return this.polling;
    // Old account work may still settle after a reset starts a new poll.
    const polling = this.checkMany(symbols, false).finally(() => { if (this.polling === polling) this.polling = null; });
    // A fast supplemental batch must not release the outstanding cold batch's
    // concurrency guard when it finishes before the older slow requests.
    if (!this.polling) this.polling = polling;
    return polling;
  }
}
module.exports = { CorporateService };
