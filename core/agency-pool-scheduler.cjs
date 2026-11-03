'use strict';
const { cnTime } = require('./common.cjs');
const { calendarSession } = require('./trading-calendar.cjs');
const { ACTIVE_CANDIDATE_LIMIT } = require('./agency-capacity.cjs');

const RETRY_DELAY_MS = 15 * 60 * 1000;
const START_MINUTE = 8 * 60 + 45, END_MINUTE = 15 * 60;
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;

function savedOptions() { return { screeningMode: 'strategy' }; }

function completedToday(engine, now) {
  const pool = engine.s.agency.pool, result = pool?.lastResult, finished = Date.parse(result?.finishedAt);
  return result?.selection?.mode === 'technical' && result.selection.activeLimitPerGroup === ACTIVE_CANDIDATE_LIMIT
    && Number.isFinite(finished) && finished <= now && cnTime(finished).date === cnTime(now).date;
}

// This only schedules the existing transactional pool service. It never changes
// members, strategy permissions, account money, or submits a trading decision.
class AgencyPoolScheduler {
  constructor({ run, getEngine, isBusy = () => false, isAvailable = () => true, clock = Date.now, onChange = () => {} } = {}) {
    Object.assign(this, { run, getEngine, isBusy, isAvailable, clock, onChange });
    this.epoch = null; this.generation = 0; this.active = null;
    this.resetStatus();
  }
  resetStatus() {
    this.cancelledOn = null; this.lastAttemptAt = null; this.nextAttemptAt = null; this.lastError = '';
  }
  syncAccount() {
    const engine = this.getEngine(), epoch = engine.s.agency.epoch;
    if (epoch !== this.epoch) { this.generation++; this.resetStatus(); this.epoch = epoch; }
    return engine;
  }
  current(job) {
    return this.getEngine().s.agency.epoch === job.epoch && this.generation === job.generation;
  }
  invalidate() {
    this.generation++; this.epoch = null; this.resetStatus();
    // Keep the old promise as a physical scan lock until it settles. The pool
    // service independently rejects stale account results before applying them.
  }
  cancelToday() {
    this.syncAccount(); this.cancelledOn = cnTime(this.clock()).date;
    this.nextAttemptAt = null; this.lastError = '';
    this.onChange();
    // The owner must also call AgencyPoolService.cancel() to stop an active scan.
    return this.publicState();
  }
  publicState() {
    const engine = this.syncAccount(), now = Number(this.clock()), time = cnTime(now);
    // A fixed mid-session time asks the verified calendar about the trading day,
    // independently of whether it is currently pre-open or the lunch break.
    const day = calendarSession(new Date(`${time.date}T10:00:00+08:00`));
    const running = !!this.active && this.current(this.active), complete = completedToday(engine, now);
    let status = 'waiting';
    if (running) status = 'running';
    else if (complete) status = 'completed';
    else if (this.cancelledOn === time.date) status = 'cancelled';
    else if (!this.isAvailable()) status = 'unavailable';
    else if (!day.known) status = 'calendar-unverified';
    else if (!day.open) status = 'non-trading-day';
    else if (time.minutes < START_MINUTE || time.minutes >= END_MINUTE) status = 'outside-window';
    else if (this.nextAttemptAt > now) status = 'retry-wait';
    else if (this.active || this.isBusy()) status = 'waiting-busy';
    return { status, running, date: time.date, completedToday: complete, cancelledToday: this.cancelledOn === time.date,
      calendarKnown: day.known, tradingDay: !!day.open, window: '交易日 08:45–15:00', retryDelayMs: RETRY_DELAY_MS,
      lastAttemptAt: iso(this.lastAttemptAt), nextAttemptAt: complete ? null : iso(this.nextAttemptAt),
      lastSuccessAt: engine.s.agency.pool?.lastResult?.finishedAt || null, lastError: complete ? '' : this.lastError };
  }
  poll() {
    const engine = this.syncAccount();
    if (this.active && this.current(this.active)) return this.active.promise;
    if (this.publicState().status !== 'waiting') return Promise.resolve(this.publicState());
    const now = Number(this.clock());
    let finish;
    const promise = new Promise(resolve => { finish = resolve; });
    const job = { epoch: this.epoch, generation: this.generation, promise };
    this.active = job; this.lastAttemptAt = now; this.nextAttemptAt = null; this.lastError = '';
    let task;
    try { task = this.run(savedOptions(engine)); } catch (error) { task = Promise.reject(error); }
    this.onChange();
    Promise.resolve(task).then(() => {
      if (!this.current(job)) return;
      if (!completedToday(this.getEngine(), Number(this.clock()))) throw Error('自动候选池更新未保存当日完整结果，稍后重试');
      this.nextAttemptAt = null; this.lastError = '';
    }).catch(error => {
      if (!this.current(job)) return;
      if (this.cancelledOn === cnTime(this.clock()).date) return;
      this.lastError = error?.message || String(error);
      this.nextAttemptAt = Number(this.clock()) + RETRY_DELAY_MS;
    }).finally(() => {
      const notify = this.current(job);
      if (this.active === job) this.active = null;
      if (notify) this.onChange();
      finish(this.publicState());
    });
    return promise;
  }
}

module.exports = { AgencyPoolScheduler, RETRY_DELAY_MS };
