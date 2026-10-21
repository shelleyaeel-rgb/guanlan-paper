'use strict';
const { INDEX_SYMBOLS, MARKET_REGIME_POLICY, unknownMarketRegime, validateMarketRegimeSnapshot, evaluateMarketRegime, preparedIndexHistory } = require('./market-regime.cjs');
const { calendarSession } = require('./trading-calendar.cjs');

const level = snapshot => snapshot.riskMultiplier === 1 ? 2 : snapshot.riskMultiplier === 0.5 ? 1 : 0;
class MarketRegimeService {
  constructor({ indexHistory, getQuotes, loadBreadth, clock = Date.now, onChange = () => {}, calendar = calendarSession } = {}) {
    Object.assign(this, { indexHistory, getQuotes, loadBreadth, clock, onChange, calendar });
    this.snapshot = unknownMarketRegime('市场环境尚未完成持续确认', this.now());
    this.pending = null; this.confirmation = null; this.lastPollAt = null; this.lastPollSession = null;
    this.acquisition = { loading: false, stage: 'idle', completed: 0, total: 0,
      startedAt: null, finishedAt: null, lastError: '', lastErrorAt: null,
      provider: '', providerLabel: '', fallbackReason: '', source: '' };
  }
  now() { const value = this.clock(); return value instanceof Date ? value.getTime() : Number(value); }
  getSnapshot() {
    const now = this.now(), trading = this.calendar(new Date(now));
    const snapshot = (!trading.open || !trading.known) && this.snapshot.status !== 'unknown'
      ? unknownMarketRegime(`${trading.label}；等待开盘后重新核验市场环境`, now) : validateMarketRegimeSnapshot(this.snapshot, now);
    return structuredClone({ ...snapshot, acquisition: this.acquisition });
  }
  publicState() { return this.getSnapshot(); }
  publish() { try { this.onChange(this.getSnapshot()); } catch {} }
  apply(candidate) {
    const now = this.now(), policy = MARKET_REGIME_POLICY;
    const current = validateMarketRegimeSnapshot(this.snapshot, now);
    if (candidate.status === 'unknown') { this.confirmation = null; this.snapshot = candidate; return; }
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
    if (this.pending) return this.pending;
    const now = this.now(), trading = this.calendar(new Date(now));
    const live = trading.known && trading.open, sessionKey = `${trading.date}:${!!live}`;
    const interval = live ? MARKET_REGIME_POLICY.pollIntervalMs : this.acquisition.stage === 'prepared' ? 300000 : 60000;
    if (!force && this.lastPollSession === sessionKey && this.lastPollAt != null && now >= this.lastPollAt && now - this.lastPollAt < interval) return Promise.resolve(this.getSnapshot());
    this.lastPollAt = now; this.lastPollSession = sessionKey;
    if (!live) this.confirmation = null;
    const acquisition = this.acquisition = { ...this.acquisition, loading: true, stage: 'starting', completed: 0, total: 0,
      startedAt: now, finishedAt: null, provider: '', providerLabel: '', fallbackReason: '', source: '' };
    // Progress is separate from the permission snapshot. Starting/retrying a
    // request must never extend old evidence or manufacture trading permission.
    this.pending = (async () => {
      // Publish after pending is assigned, so observers cannot start a second run.
      await Promise.resolve(); this.publish();
      const signal = AbortSignal.timeout(125000);
      try {
        if (!trading.known) throw Error(trading.label);
        if (typeof this.indexHistory !== 'function' || typeof this.getQuotes !== 'function' || typeof this.loadBreadth !== 'function') throw Error('市场环境数据源未配置');
        // Complete historical preparation while closed. Previous-session quotes
        // cannot confirm today's breadth or advance the live confirmation clock.
        const outcomes = await Promise.allSettled([...INDEX_SYMBOLS.map(symbol => this.indexHistory(symbol, signal, force)), ...(live ? [this.loadBreadth({ signal, force,
          onProgress: progress => {
            if (this.acquisition !== acquisition || !acquisition.loading) return;
            for (const key of ['stage', 'completed', 'total']) if (progress?.[key] !== undefined) acquisition[key] = progress[key];
            for (const key of ['provider', 'providerLabel', 'fallbackReason']) if (typeof progress?.[key] === 'string') acquisition[key] = progress[key];
            this.publish();
          } })] : [])]);
        const failed = outcomes.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        const histories = Object.fromEntries(INDEX_SYMBOLS.map((symbol, index) => [symbol, outcomes[index].value]));
        const currentTrading = this.calendar(new Date(this.now()));
        if (!live) {
          const prepared = INDEX_SYMBOLS.map(symbol => ({ symbol, asOf: preparedIndexHistory(symbol, histories[symbol], this.now()).asOf,
            source: histories[symbol].source, fetchedAt: histories[symbol].fetchedAt }));
          this.snapshot = unknownMarketRegime('指数历史资料已准备；等待开盘后自动获取当日指数报价与市场广度，并完成持续确认', this.now());
          Object.assign(acquisition, { stage: 'prepared', completed: prepared.length, total: INDEX_SYMBOLS.length, prepared,
            lastError: '', lastErrorAt: null });
        } else if (!currentTrading.known || !currentTrading.open || currentTrading.date !== trading.date) {
          this.confirmation = null;
          this.snapshot = unknownMarketRegime(`${currentTrading.label}；等待开盘后重新核验市场环境`, this.now());
          Object.assign(acquisition, { stage: 'waiting-open', lastError: '', lastErrorAt: null });
        } else {
          // Read quotes after slow breadth work, so refresh loops supply current ticks.
          const quotes = await this.getQuotes();
          this.apply(evaluateMarketRegime({ histories, quotes, breadth: outcomes[3].value }, this.now()));
          Object.assign(acquisition, { stage: 'complete', lastError: '', lastErrorAt: null, source: outcomes[3].value.source || '' });
        }
      } catch (error) {
        this.confirmation = null;
        const reason = signal.aborted ? '市场环境获取超时，本次未取得完整有效资料' : `市场环境获取失败：${error?.message || String(error)}`;
        this.snapshot = unknownMarketRegime(reason, this.now());
        Object.assign(acquisition, { stage: 'failed', lastError: reason, lastErrorAt: this.now() });
      }
      Object.assign(acquisition, { loading: false, finishedAt: this.now() });
      const result = this.getSnapshot();
      this.publish();
      return result;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}
module.exports = { MarketRegimeService };
