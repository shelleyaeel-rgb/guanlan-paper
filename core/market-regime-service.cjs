'use strict';
const { INDEX_SYMBOLS, MARKET_REGIME_POLICY, unknownMarketRegime, validateMarketRegimeSnapshot, evaluateMarketRegime, preparedIndexHistory } = require('./market-regime.cjs');
const { calendarSession } = require('./trading-calendar.cjs');
const { validUniverse } = require('./market-breadth-source.cjs');
const { cnTime } = require('./common.cjs');
const sessionKeyOf = (trading, now) => `${trading.date}:${trading.known && trading.open ? cnTime(now).minutes < 780 ? 'morning' : 'afternoon' : 'closed'}`;

const level = snapshot => snapshot.riskMultiplier === 1 ? 2 : snapshot.riskMultiplier === 0.5 ? 1 : 0;
class MarketRegimeService {
  constructor({ indexHistory, getQuotes, loadBreadth, prepareUniverse, clock = Date.now, onChange = () => {}, calendar = calendarSession } = {}) {
    Object.assign(this, { indexHistory, getQuotes, loadBreadth, prepareUniverse, clock, onChange, calendar });
    this.snapshot = unknownMarketRegime('市场环境尚未完成持续确认', this.now());
    this.pending = null; this.confirmation = null; this.lastPollAt = null; this.lastPollSession = null;
    this.job = null; this.preparedHistories = {}; this.preparedUniverse = null; this.preparationErrors = {}; this.preparedAt = null;
    this.acquisition = { loading: false, stage: 'idle', completed: 0, total: 0,
      startedAt: null, finishedAt: null, lastError: '', lastErrorAt: null,
      provider: '', providerLabel: '', fallbackReason: '', source: '' };
  }
  now() { const value = this.clock(); return value instanceof Date ? value.getTime() : Number(value); }
  getPreparation(now = this.now()) {
    const items = INDEX_SYMBOLS.map(symbol => {
      const history = this.preparedHistories[symbol];
      try {
        const daily = preparedIndexHistory(symbol, history, now);
        return { symbol, ready: true, asOf: daily.asOf, source: history.source, fetchedAt: history.fetchedAt, error: this.preparationErrors[symbol] || '' };
      } catch (error) { return { symbol, ready: false, error: this.preparationErrors[symbol] || (history ? error.message : '尚未准备指数历史') }; }
    });
    let universe;
    try {
      const value = validUniverse(this.preparedUniverse, now);
      universe = { ready: true, count: value.symbols.length, source: value.source, validatedAt: value.validatedAt,
        expiresAt: value.validatedAt + 1800000, error: this.preparationErrors.universe || '' };
    } catch (error) {
      universe = { ready: false, count: 0, source: this.preparedUniverse?.source || '', validatedAt: this.preparedUniverse?.validatedAt || null,
        expiresAt: this.preparedUniverse ? this.preparedUniverse.validatedAt + 1800000 : null,
        error: this.preparationErrors.universe || (this.preparedUniverse ? error.message : '尚未准备完整证券名单') };
    }
    const readyIndices = items.filter(item => item.ready).length, ready = readyIndices === INDEX_SYMBOLS.length && universe.ready;
    const missing = [...items.filter(item => !item.ready).map(item => `${item.symbol} 指数历史`), ...(!universe.ready ? ['完整证券名单'] : [])];
    const hasError = Object.values(this.preparationErrors).some(Boolean);
    return { status: this.acquisition.loading ? 'loading' : ready ? 'ready' : readyIndices || universe.ready ? 'partial' : hasError ? 'failed' : 'idle',
      ready, preparedAt: this.preparedAt, indices: { ready: readyIndices, total: INDEX_SYMBOLS.length, items }, universe, missing,
      liveRequired: ['当日连续交易指数报价', '当日市场广度', '120秒持续确认'] };
  }
  getSnapshot() {
    const now = this.now(), trading = this.calendar(new Date(now));
    const snapshot = (!trading.open || !trading.known) && this.snapshot.status !== 'unknown'
      ? unknownMarketRegime(`${trading.label}；等待开盘后重新核验市场环境`, now) : validateMarketRegimeSnapshot(this.snapshot, now);
    return structuredClone({ ...snapshot, acquisition: this.acquisition, preparation: this.getPreparation(now) });
  }
  publicState() { return this.getSnapshot(); }
  publish() { try { this.onChange(this.getSnapshot()); } catch {} }
  apply(candidate) {
    const now = this.now(), policy = MARKET_REGIME_POLICY;
    const current = validateMarketRegimeSnapshot(this.snapshot, now);
    if (candidate.status === 'unknown') { this.confirmation = null; this.snapshot = candidate; return; }
    // A successful opening fetch can still contain the auction's last tick.
    // Such ticks must not start the continuous-session confirmation clock.
    const openAt = Date.parse(`${candidate.date}T${cnTime(now).minutes < 780 ? '09:30' : '13:00'}:00+08:00`);
    if (!(candidate.evidence?.quoteTime >= openAt)) {
      this.confirmation = null; this.snapshot = unknownMarketRegime('等待开市后的连续交易指数报价与市场广度，竞价报价不计入持续确认', now); return;
    }
    if (level(candidate) <= level(current)) { this.confirmation = null; this.snapshot = candidate; return; }
    const quoteTime = candidate.evidence.quoteTime, key = `${candidate.date}:${candidate.status}:${candidate.riskMultiplier}`;
    const prior = this.confirmation;
    if (!prior || prior.key !== key || now - prior.lastSeenAt > policy.confirmationMaxGapMs || quoteTime < prior.lastQuoteTime) {
      this.confirmation = { key, firstQuoteTime: quoteTime, lastQuoteTime: quoteTime, count: 1, lastSeenAt: now };
    } else if (quoteTime > prior.lastQuoteTime) {
      prior.lastQuoteTime = quoteTime; prior.lastSeenAt = now; prior.count++;
    }
    const confirmation = this.confirmation;
    if (confirmation.count >= policy.confirmationSamples && quoteTime - confirmation.firstQuoteTime >= policy.confirmationMs) {
      this.snapshot = { ...candidate, evidence: { ...candidate.evidence, confirmation: { samples: confirmation.count, firstQuoteTime: confirmation.firstQuoteTime, lastQuoteTime: quoteTime } } };
      this.confirmation = null;
    } else {
      const reason = `市场环境改善等待持续确认：至少 ${policy.confirmationSamples} 份不同报价且间隔 ${policy.confirmationMs / 1000} 秒`;
      this.snapshot = { ...candidate, status: current.status, label: current.label, riskMultiplier: current.riskMultiplier,
        allowEntry: current.allowEntry, allowBreakout: current.allowBreakout, reason, reasons: [reason, ...candidate.reasons],
        metrics: { ...candidate.metrics, candidateStatus: candidate.status }, evidence: { ...candidate.evidence, confirmation: { samples: confirmation.count, firstQuoteTime: confirmation.firstQuoteTime, lastQuoteTime: quoteTime } } };
    }
  }
  poll({ force = false } = {}) {
    const now = this.now(), trading = this.calendar(new Date(now));
    const live = trading.known && trading.open, sessionKey = sessionKeyOf(trading, now);
    if (this.pending && this.job?.sessionKey === sessionKey) return this.pending;
    // A slow pre-open request must not occupy the live acquisition slot. Abort
    // only its subscriptions; shared history/list consumers retain their work.
    if (this.pending) { this.job?.controller.abort(Error('交易时段已切换，改用当前时段资料')); this.pending = null; this.confirmation = null; }
    const interval = live ? MARKET_REGIME_POLICY.pollIntervalMs : this.acquisition.stage === 'prepared' ? 300000 : 60000;
    if (!force && this.lastPollSession === sessionKey && this.lastPollAt != null && now >= this.lastPollAt && now - this.lastPollAt < interval) return Promise.resolve(this.getSnapshot());
    this.lastPollAt = now; this.lastPollSession = sessionKey;
    if (!live) this.confirmation = null;
    const acquisition = this.acquisition = { ...this.acquisition, loading: true, stage: 'starting', completed: 0, total: 0,
      startedAt: now, finishedAt: null, provider: '', providerLabel: '', fallbackReason: '', source: '' };
    const job = this.job = { controller: new AbortController(), sessionKey };
    // Progress is separate from the permission snapshot. Starting/retrying a
    // request must never extend old evidence or manufacture trading permission.
    const pending = (async () => {
      // Publish after pending is assigned, so observers cannot start a second run.
      await Promise.resolve(); this.publish();
      const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(125000)]);
      const progress = value => {
        if (this.job !== job || !acquisition.loading) return;
        for (const key of ['stage', 'completed', 'total']) if (value?.[key] !== undefined) acquisition[key] = value[key];
        for (const key of ['provider', 'providerLabel', 'fallbackReason']) if (typeof value?.[key] === 'string') acquisition[key] = value[key];
        this.publish();
      };
      const wait = promise => new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || Error('已取消市场环境获取'));
        if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      const readHistory = async (symbol, force) => {
        try {
          const history = await this.indexHistory(symbol, signal, force);
          signal.throwIfAborted();
          if (this.job === job) { this.preparedHistories[symbol] = history; this.preparationErrors[symbol] = ''; }
          return history;
        } catch (error) {
          if (this.job === job && !signal.aborted) this.preparationErrors[symbol] = error.message;
          throw error;
        }
      };
      try {
        if (!trading.known) throw Error(trading.label);
        if (typeof this.indexHistory !== 'function' || typeof this.getQuotes !== 'function' || typeof this.loadBreadth !== 'function') throw Error('市场环境数据源未配置');
        // Complete historical preparation while closed. Previous-session quotes
        // cannot confirm today's breadth or advance the live confirmation clock.
        const outcomes = await wait(Promise.allSettled([...INDEX_SYMBOLS.map(symbol => readHistory(symbol, force)),
          ...(live ? [this.loadBreadth({ signal, force, onProgress: progress })] : typeof this.prepareUniverse === 'function' ? [(async () => {
          try {
            const universe = await this.prepareUniverse({ signal, force, onProgress: progress });
            signal.throwIfAborted(); validUniverse(universe, this.now());
            if (this.job === job) { this.preparedUniverse = universe; this.preparationErrors.universe = ''; }
            return universe;
          } catch (error) { if (this.job === job && !signal.aborted) this.preparationErrors.universe = error.message; throw error; }
        })()] : [])]));
        signal.throwIfAborted();
        if (this.job !== job) return this.getSnapshot();
        const failed = outcomes.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        const histories = Object.fromEntries(INDEX_SYMBOLS.map((symbol, index) => [symbol, outcomes[index].value]));
        const currentTrading = this.calendar(new Date(this.now()));
        if (live && sessionKeyOf(currentTrading, this.now()) !== sessionKey) {
          this.confirmation = null;
          this.snapshot = unknownMarketRegime(`${currentTrading.label}；等待开盘后重新核验市场环境`, this.now());
          Object.assign(acquisition, { stage: 'waiting-open', lastError: '', lastErrorAt: null });
        } else {
          let quotes;
          if (live) {
            // Read quotes after slow breadth work, so refresh loops supply current ticks.
            quotes = await wait(this.getQuotes());
          }
          // A background correction can revoke history during any source await.
          // Read replacements at most twice, then validate and evaluate in this
          // same synchronous turn so no extra Promise boundary reopens the race.
          for (let attempt = 0; attempt <= 2; attempt++) {
            signal.throwIfAborted();
            if (this.job !== job) return this.getSnapshot();
            if (sessionKeyOf(this.calendar(new Date(this.now())), this.now()) !== sessionKey) throw Error('核验指数日线期间交易时段已切换，等待当前时段重新核验');
            const invalid = [];
            let validationError;
            for (const symbol of INDEX_SYMBOLS) {
              try { preparedIndexHistory(symbol, histories[symbol], this.now()); }
              catch (error) { invalid.push(symbol); validationError = error; this.preparationErrors[symbol] = error.message; }
            }
            if (!invalid.length) break;
            if (attempt === 2) throw validationError;
            const refreshed = await wait(Promise.allSettled(invalid.map(symbol => readHistory(symbol, false))));
            signal.throwIfAborted();
            if (this.job !== job) return this.getSnapshot();
            const failed = refreshed.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
            for (const [index, symbol] of invalid.entries()) histories[symbol] = refreshed[index].value;
          }
          if (!live) {
            const prepared = INDEX_SYMBOLS.map(symbol => ({ symbol, asOf: preparedIndexHistory(symbol, histories[symbol], this.now()).asOf,
              source: histories[symbol].source, fetchedAt: histories[symbol].fetchedAt }));
            this.snapshot = unknownMarketRegime('指数历史资料已准备；等待开盘后自动获取当日指数报价与市场广度，并完成持续确认', this.now());
            Object.assign(acquisition, { stage: 'prepared', completed: prepared.length, total: INDEX_SYMBOLS.length, prepared,
              lastError: '', lastErrorAt: null });
            if (this.getPreparation().ready) {
              this.preparedAt = this.now();
              this.snapshot = unknownMarketRegime('指数历史与完整证券名单已准备；等待开市后的实时行情和策略信号', this.now());
            }
          } else {
            const breadth = outcomes[3].value;
            if (breadth?.universeSource && Number.isFinite(breadth.universeValidatedAt)) {
              try {
                this.preparedUniverse = validUniverse({ symbols: breadth.rows.map(row => row.symbol), source: breadth.universeSource,
                  sourceCount: breadth.sourceCount, excludedCount: breadth.excludedCount, validatedAt: breadth.universeValidatedAt,
                  date: cnTime(breadth.universeValidatedAt).date }, this.now());
                this.preparationErrors.universe = '';
              } catch { /* A permission evaluation still performs its own full evidence checks below. */ }
            }
            if (this.getPreparation().ready) this.preparedAt = this.now();
            this.apply(evaluateMarketRegime({ histories, quotes, breadth }, this.now()));
            Object.assign(acquisition, { stage: 'complete', lastError: '', lastErrorAt: null, source: breadth.source || '' });
          }
        }
      } catch (error) {
        if (this.job !== job) return this.getSnapshot();
        this.confirmation = null;
        const reason = signal.aborted ? '市场环境获取超时，本次未取得完整有效资料' : `市场环境获取失败：${error?.message || String(error)}`;
        this.snapshot = unknownMarketRegime(reason, this.now());
        Object.assign(acquisition, { stage: 'failed', lastError: reason, lastErrorAt: this.now() });
      }
      Object.assign(acquisition, { loading: false, finishedAt: this.now() });
      const result = this.getSnapshot();
      this.publish();
      return result;
    })().finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }
}
module.exports = { MarketRegimeService };
