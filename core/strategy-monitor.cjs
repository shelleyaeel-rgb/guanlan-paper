const { technicals } = require('./strategy.cjs');
const { latestDisclosedReport } = require('./financial-report-status.cjs');
const { INDUSTRY_PROFILE_MAX_AGE_MS } = require('./industry-applicability.cjs');
const { afterPending } = require('./fresh-request.cjs');

const validAge = (time, now, ttl) => Number.isFinite(time) && time > 0 && time <= now && now - time <= ttl;
const recentAttempt = (time, now) => validAge(time, now, 60000) && now - time < 60000;
function fundamentalsReusable(snapshot, now) {
  return ['finance', 'valuation'].every(section => {
    const response = snapshot[section];
    if (!response) return false;
    if (response.status !== 'ready') {
      const attemptedAt = snapshot.fundamentalsAttempts?.[section] ?? snapshot.fundamentalsAttemptedAt;
      return recentAttempt(attemptedAt, now);
    }
    const industryReusable = section !== 'finance' || (response.industryProfile?.status === 'ready'
      ? validAge(response.industryProfile.fetchedAt, now, INDUSTRY_PROFILE_MAX_AGE_MS)
      : recentAttempt(snapshot.fundamentalsAttempts?.finance ?? snapshot.fundamentalsAttemptedAt, now));
    return validAge(response.fetchedAt, now, section === 'finance' ? 21600000 : 90000)
      && (section !== 'valuation' || validAge(response.data?.quoteTime, now, 90000))
      && industryReusable;
  });
}
function noticesReusable(snapshot, now) {
  const response = snapshot.notices;
  if (!response) return false;
  if (!['ready', 'empty'].includes(response.status) || response.error) return recentAttempt(snapshot.noticesAttemptedAt, now);
  return validAge(response.fetchedAt, now, 300000);
}

// Independent of the displayed stock/page. Slow history requests never block quote/risk polling.
class StrategyMonitor {
  constructor(market, clock = () => new Date(), onChange = () => {}, research = null, corporate = null) { this.market = market; this.clock = clock; this.onChange = onChange; this.research = research; this.corporate = corporate; this.snapshots = {}; this.inflight = new Map(); this.nextForced = new Map(); }
  async loadFinance(symbol, force) {
    if (typeof this.research?.getFinanceWithIndustry === 'function') return this.research.getFinanceWithIndustry({ symbol, force });
    if (!this.research) throw Error('财务与行业服务未配置');
    const results = await Promise.allSettled(['finance', 'profile'].map(section => this.research.get({ symbol, section, force })));
    const response = (result, section) => result.status === 'fulfilled' ? result.value : {
      symbol, section, source: '东方财富', status: 'unavailable', fetchedAt: null, checkedAt: this.clock().getTime(), error: result.reason?.message || '资料获取失败' };
    return { ...response(results[0], 'finance'), industryProfile: response(results[1], 'profile') };
  }
  async load(symbol, force = false, includeFundamentals = false, includeNotices = false) {
    const needsCorporate = includeNotices && this.corporate?.symbols().includes(symbol);
    const missing = pending => (includeFundamentals && !pending.fundamentalsAttemptedAt) || (includeNotices && !pending.noticesAttemptedAt) || (needsCorporate && !pending.corporateActions);
    if (this.nextForced.has(symbol)) {
      const pending = await this.nextForced.get(symbol);
      return missing(pending) ? this.load(symbol, force, includeFundamentals, includeNotices) : pending;
    }
    if (this.inflight.has(symbol)) {
      if (force) {
        const pending = await afterPending(this.inflight, this.nextForced, symbol, () => this.load(symbol, true, includeFundamentals, includeNotices));
        return missing(pending) ? this.load(symbol, true, includeFundamentals, includeNotices) : pending;
      }
      const pending = await this.inflight.get(symbol);
      if (missing(pending)) return this.load(symbol, force, includeFundamentals, includeNotices);
      return pending;
    }
    const previous = this.snapshots[symbol], now = this.clock().getTime();
    let currentNotices = true;
    if (includeNotices && previous?.notices && this.research?.noticeVersion)
      currentNotices = this.research.noticeVersion(symbol)?.version === previous.notices.noticeVersion;
    if (!force && previous && recentAttempt(previous.attemptedAt, now) && (!includeFundamentals || (recentAttempt(previous.fundamentalsAttemptedAt, now) && fundamentalsReusable(previous, now))) && (!includeNotices || (currentNotices && noticesReusable(previous, now))) && (!needsCorporate || validAge(previous.corporateActions?.fetchedAt, now, 60000))) return previous;
    const work = (async () => {
      let snapshot;
      try {
        const data = await this.market.strategyHistory(symbol, null, true, force), bars = Array.isArray(data) ? data : data.bars;
        snapshot = { technical: technicals(bars, this.clock()), source: data.source || '来源未标注', provider: data.provider || null, fetchedAt: this.clock().getTime(), attemptedAt: this.clock().getTime() };
      }
      catch (e) { snapshot = { error: `策略日线不可用：${e.message}`, attemptedAt: this.clock().getTime() }; }
      if (includeFundamentals) {
        snapshot.fundamentalsAttempts = {};
        const results = await Promise.allSettled(['finance', 'valuation'].map(async section => {
          const now = this.clock().getTime(), priorAttempt = previous?.fundamentalsAttempts?.[section] ?? previous?.fundamentalsAttemptedAt;
          // An expired ready section must not repeatedly retry another section's failed request.
          if (!force && previous?.[section] && previous[section].status !== 'ready' && recentAttempt(priorAttempt, now)) {
            snapshot.fundamentalsAttempts[section] = priorAttempt;
            return previous[section];
          }
          snapshot.fundamentalsAttempts[section] = now;
          if (!this.research) throw Error('财务与估值服务未配置');
          try { return section === 'finance' ? await this.loadFinance(symbol, force) : await this.research.get({ symbol, section, force }); }
          finally { snapshot.fundamentalsAttempts[section] = this.clock().getTime(); }
        }));
        ['finance', 'valuation'].forEach((section, index) => {
          const result = results[index];
          snapshot[section] = result.status === 'fulfilled' ? result.value : { symbol, section, status: 'unavailable', error: result.reason?.message || '资料获取失败' };
        });
        snapshot.fundamentalsAttemptedAt = this.clock().getTime();
      }
      if (includeNotices) {
        const now = this.clock().getTime();
        if (!force && currentNotices && previous?.notices && !['ready', 'empty'].includes(previous.notices.status) && recentAttempt(previous.noticesAttemptedAt, now)) {
          snapshot.notices = previous.notices;
          snapshot.noticesAttemptedAt = previous.noticesAttemptedAt;
        } else {
          try {
            if (!this.research) throw Error('公告服务未配置');
            snapshot.notices = await this.research.get({ symbol, section: 'notices', force });
          } catch (e) { snapshot.notices = { symbol, section: 'notices', status: 'unavailable', error: e.message || '公告获取失败' }; }
          snapshot.noticesAttemptedAt = this.clock().getTime();
        }
      }
      if (includeFundamentals && includeNotices && this.research) {
        const pendingForSnapshot = () => {
          const data = snapshot.finance?.data, annualDate = [...(data?.annual || []), ...(typeof data?.latest?.reportDate === 'string' && data.latest.reportDate.endsWith('-12-31') ? [data.latest] : [])]
            .map(report => report?.reportDate).filter(date => typeof date === 'string').sort().at(-1);
          return latestDisclosedReport(snapshot.notices, symbol, this.clock(), data?.latest?.reportDate)
            || latestDisclosedReport(snapshot.notices, symbol, this.clock(), annualDate, { annualOnly: true });
        };
        const at = this.clock().getTime(), pendingReport = pendingForSnapshot();
        if (pendingReport) {
          const prior = previous?.financeReportSync;
          const sameReport = prior?.reportDate === pendingReport.reportDate && prior?.noticeId === pendingReport.id;
          const throttled = sameReport && validAge(prior.attemptedAt, at, 300000) && at - prior.attemptedAt < 300000;
          let attemptedAt = prior?.attemptedAt;
          // Explicit force already fetched the finance section in this load.
          // Automatic observation retries a provider lag at most once per five
          // minutes for the same filing, independent of the 60-second scan.
          if (force) attemptedAt = snapshot.fundamentalsAttempts.finance;
          else if (!throttled) {
            try { snapshot.finance = await this.loadFinance(symbol, true); }
            catch (error) { snapshot.finance = { symbol, section: 'finance', status: 'unavailable', error: error.message || '新财报同步失败' }; }
            attemptedAt = this.clock().getTime();
            snapshot.fundamentalsAttempts.finance = attemptedAt;
          }
          const stillPending = pendingForSnapshot();
          snapshot.financeReportSync = { reportDate: pendingReport.reportDate, noticeId: pendingReport.id, title: pendingReport.title,
            noticeDate: pendingReport.date, attemptedAt, checkedAt: this.clock().getTime(), status: stillPending ? 'pending' : 'synced' };
        }
      }
      if (needsCorporate) snapshot.corporateActions = await this.corporate.getSnapshot(symbol, force);
      snapshot.forced = force;
      this.snapshots[symbol] = snapshot; this.onChange(); return snapshot;
    })().finally(() => this.inflight.delete(symbol));
    this.inflight.set(symbol, work); return work;
  }
  async scan(symbols, financialSymbols = [], noticeSymbols = [], lane = 'default') {
    this.scans ||= new Map();
    if (this.scans.has(lane)) return this.scans.get(lane);
    const queue = [...new Set(symbols)], financial = new Set(financialSymbols), notices = new Set(noticeSymbols);
    const scanning = Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { while (queue.length) { const symbol = queue.shift(); await this.load(symbol, false, financial.has(symbol), notices.has(symbol)); } })).finally(() => { this.scans.delete(lane); });
    this.scans.set(lane, scanning); return scanning;
  }
}
module.exports = { StrategyMonitor };
