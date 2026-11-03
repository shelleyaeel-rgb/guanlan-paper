const { technicals } = require('./strategy.cjs');
const { latestDisclosedReport } = require('./financial-report-status.cjs');
const { INDUSTRY_PROFILE_MAX_AGE_MS } = require('./industry-applicability.cjs');
const { afterPending } = require('./fresh-request.cjs');
const { preparedTechnicalValid } = require('./daily-history.cjs');
const { cnTime } = require('./common.cjs');
const { calendarSession } = require('./trading-calendar.cjs');

const validAge = (time, now, ttl) => Number.isFinite(time) && time > 0 && time <= now && now - time <= ttl;
const recentAttempt = (time, now) => validAge(time, now, 60000) && now - time < 60000;
function fundamentalReusable(snapshot, section, now, ahead = 0) {
    const response = snapshot[section];
    if (!response) return false;
    if (response.status !== 'ready') {
      const attemptedAt = snapshot.fundamentalsAttempts?.[section] ?? snapshot.fundamentalsAttemptedAt;
      return recentAttempt(attemptedAt, now);
    }
    const industryReusable = section !== 'finance' || (response.industryProfile?.status === 'ready'
      ? validAge(response.industryProfile.fetchedAt, now, INDUSTRY_PROFILE_MAX_AGE_MS - ahead)
      : recentAttempt(snapshot.fundamentalsAttempts?.finance ?? snapshot.fundamentalsAttemptedAt, now));
    return validAge(response.fetchedAt, now, (section === 'finance' ? 21600000 : 90000) - ahead)
      && (section !== 'valuation' || validAge(response.data?.quoteTime, now, 90000 - ahead))
      && industryReusable;
}
function noticesReusable(snapshot, now, ahead = 0) {
  const response = snapshot.notices;
  if (!response) return false;
  if (!['ready', 'empty'].includes(response.status) || response.error) return recentAttempt(snapshot.noticesAttemptedAt, now);
  return validAge(response.fetchedAt, now, 300000 - ahead);
}
function dailyReusable(snapshot, now, symbol) {
  return !!snapshot && !snapshot.error && (snapshot.dailyEvidence !== undefined
    ? preparedTechnicalValid(snapshot, now, symbol) : !!snapshot.technical && validAge(snapshot.fetchedAt, now, 180000));
}
function corporateReusable(snapshot, now, symbol, corporate, ahead = 0) {
  const evidence = snapshot?.corporateActions;
  const latest = corporate?.latestEvidence?.get(symbol);
  const sameContents = value => {
    if (!value) return null;
    const { fetchedAt, checkedAt, cached, acquisition, ...contents } = value;
    return JSON.stringify(contents);
  };
  // Completion of a corporate fetch revokes known older terms immediately,
  // even if the monitor is still waiting on another module before publishing.
  const current = !latest || latest === evidence || sameContents(latest) === sameContents(evidence);
  return evidence?.status === 'ready' && evidence.coverageComplete === true
    && current
    && validAge(evidence.fetchedAt, now, 300000 - ahead)
    && evidence.symbol === symbol && evidence.coverageEnd === cnTime(now).date
    && (!corporate?.fromDate || evidence.coverageStart <= corporate.fromDate(symbol));
}
function fundamentalPrepared(snapshot, section, now) {
  return snapshot?.[section]?.status === 'ready' && fundamentalReusable(snapshot, section, now)
    && (section !== 'finance' || snapshot.finance.industryProfile?.status === 'ready'
      && validAge(snapshot.finance.industryProfile.fetchedAt, now, INDUSTRY_PROFILE_MAX_AGE_MS));
}
// Renewing transport metadata does not change the facts used to make a decision.
// Each held response still has to pass its own original timestamp checks.
function evidenceContents(value) {
  if (Array.isArray(value)) return value.map(evidenceContents);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter(key => !['fetchedAt', 'checkedAt', 'cached', 'acquisition'].includes(key))
    .map(key => [key, evidenceContents(value[key])]));
}
const sameEvidence = (left, right) => JSON.stringify(evidenceContents(left)) === JSON.stringify(evidenceContents(right));
const dailyContents = snapshot => ({ technical: snapshot?.technical, source: snapshot?.source, provider: snapshot?.provider, dailyEvidence: snapshot?.dailyEvidence });
function preparedRequirements(value) {
  if (typeof value === 'boolean') return { finance: value, valuation: value, industry: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([key, enabled]) => !['finance', 'valuation', 'industry'].includes(key) || typeof enabled !== 'boolean'))
    throw Error('开仓资料需求格式无效');
  return { finance: value.finance === true, valuation: value.valuation === true, industry: value.industry === true };
}
function preparedResponse(snapshot, section) {
  if (section === 'profile') return snapshot?.finance?.industryProfile;
  if (section !== 'finance' || !snapshot?.finance) return snapshot?.[section];
  const { industryProfile, ...finance } = snapshot.finance;
  return finance;
}

// Independent of the displayed stock/page. Slow history requests never block quote/risk polling.
class StrategyMonitor {
  constructor(market, clock = () => new Date(), onChange = () => {}, research = null, corporate = null) { this.market = market; this.clock = clock; this.onChange = onChange; this.research = research; this.corporate = corporate; this.snapshots = {}; this.inflight = new Map(); this.nextForced = new Map(); }
  noticesCurrent(symbol, snapshot) {
    if (!this.research?.noticeVersion) return true;
    const current = this.research.noticeVersion(symbol);
    return (current?.usable !== false || !['ready', 'empty'].includes(snapshot?.notices?.status))
      && current?.version === snapshot?.notices?.noticeVersion;
  }
  requiresCorporate(symbol, includeNotices = false) {
    return !!this.corporate && (typeof this.corporate.requiresEvidence === 'function'
      ? this.corporate.requiresEvidence(symbol) : includeNotices && this.corporate.symbols().includes(symbol));
  }
  verificationSnapshot(symbol, snapshot, includeNotices = true) {
    let current = this.snapshots[symbol] || snapshot;
    if (includeNotices && current?.notices && !this.noticesCurrent(symbol, current)) {
      const error = '公告目录已变化或最新查新失败，等待重新核验';
      current = { ...current, error: current.error || error, notices: { ...current.notices, status: 'unavailable', error } };
    }
    return current;
  }
  peekPrepared(symbol, includeFundamentals = false, includeNotices = true) {
    const snapshot = this.snapshots[symbol], now = this.clock().getTime();
    if (!dailyReusable(snapshot, now, symbol)) return null;
    if (includeFundamentals && (snapshot.financeReportSync?.status === 'pending' || !['finance', 'valuation'].every(section => fundamentalPrepared(snapshot, section, now)))) return null;
    if (includeNotices && (!['ready', 'empty'].includes(snapshot.notices?.status) || snapshot.notices.error || !this.noticesCurrent(symbol, snapshot) || !noticesReusable(snapshot, now))) return null;
    if (this.requiresCorporate(symbol, includeNotices) && !corporateReusable(snapshot, now, symbol, this.corporate)) return null;
    return snapshot;
  }
  readPrepared(symbol, requirements = false, includeNotices = true) {
    const snapshot = this.snapshots[symbol];
    this.assertPrepared(symbol, snapshot, requirements, includeNotices);
    return structuredClone(snapshot);
  }
  assertPrepared(symbol, snapshot, requirements = false, includeNotices = true) {
    const current = this.snapshots[symbol], now = this.clock().getTime();
    const required = preparedRequirements(requirements);
    const fundamentalSections = [...(required.finance ? ['finance'] : []), ...(required.valuation ? ['valuation'] : []), ...(required.industry ? ['profile'] : [])];
    const fail = reason => { throw Error(`开仓资料未就绪：${reason}，等待后台准备或手动核验`); };
    const validate = value => {
      if (!value) fail('尚未准备');
      if (!dailyReusable(value, now, symbol)) fail(value.error || '日线已过期或版本已更新');
      if (required.finance) {
        if (value.financeReportSync?.status === 'pending') fail('已发现新财报，等待财务指标同步');
        if (value.finance?.status !== 'ready' || value.finance.error || !validAge(value.finance.fetchedAt, now, 21600000)) fail('财务资料已过期或不可用');
      }
      if (required.valuation && (!fundamentalPrepared(value, 'valuation', now) || value.valuation?.error)) fail('估值行情已过期或不可用');
      const industry = value.finance?.industryProfile;
      if (required.industry && (industry?.status !== 'ready' || industry.error || !validAge(industry.fetchedAt, now, INDUSTRY_PROFILE_MAX_AGE_MS))) fail('行业资料已过期或不可用');
      if (includeNotices) {
        if (!['ready', 'empty'].includes(value.notices?.status) || value.notices.error || !noticesReusable(value, now)) fail('公告资料已过期或不可用');
        if (!this.noticesCurrent(symbol, value)) fail('公告目录已变化或最新查新失败');
      }
      if (this.requiresCorporate(symbol, includeNotices)
        && (!corporateReusable(value, now, symbol, this.corporate) || value.corporateActions?.error)) fail('公司行为资料已过期、发生变化或最新查新失败');
    };
    // Recheck both the held decision and the currently published local facts.
    // Never replace a stale held response with a newer one after a decision.
    validate(snapshot);
    validate(current);
    if (!sameEvidence(dailyContents(snapshot), dailyContents(current))) fail('日线资料已更新');
    const sections = [...fundamentalSections, ...(includeNotices ? ['notices'] : []),
      ...(this.requiresCorporate(symbol, includeNotices) ? ['corporateActions'] : [])];
    for (const section of sections) if (!sameEvidence(preparedResponse(snapshot, section), preparedResponse(current, section))) fail('已准备资料发生变化或最新获取失败');
    // Research publishes each module before a slow monitor batch can finish.
    // Its cache is read only here, so an independently observed correction or
    // failure revokes the old decision immediately without any provider call.
    for (const section of fundamentalSections) {
      const latest = this.research?.cache?.get(`${symbol}:${section}`);
      if (!latest) continue;
      const held = preparedResponse(snapshot, section);
      if (!sameEvidence(held, latest)) fail('财务、行业或估值资料发生变化或最新获取失败');
    }
    return snapshot;
  }
  prepare(symbol, includeFundamentals = false, includeNotices = true) {
    return this.load(symbol, false, includeFundamentals, includeNotices, { refreshDaily: false, refreshAheadMs: 30000 });
  }
  preparationState(symbol, includeFundamentals = false, includeNotices = true) {
    const snapshot = this.snapshots[symbol], now = this.clock().getTime(), components = [];
    const component = (id, ready, response, ttl, reason, waitingLive = false) => {
      const fetchedAt = Number.isFinite(response?.fetchedAt) ? response.fetchedAt : null;
      components.push({ id, status: ready ? 'ready' : waitingLive ? 'waiting-live' : response?.error || response?.status === 'unavailable' ? 'error' : 'preparing',
        fetchedAt, expiresAt: fetchedAt && ttl ? fetchedAt + ttl : null, reason: ready ? '' : reason });
    };
    component('daily', dailyReusable(snapshot, now, symbol), snapshot, snapshot?.dailyEvidence ? null : 180000, snapshot?.error || '等待最近完整交易日日线');
    if (includeFundamentals) for (const section of ['finance', 'valuation']) {
      const response = snapshot?.[section], pendingReport = section === 'finance' && snapshot?.financeReportSync?.status === 'pending', ready = !pendingReport && fundamentalPrepared(snapshot, section, now);
      const waitingLive = section === 'valuation' && response?.status === 'ready' && validAge(response.fetchedAt, now, 90000) && !validAge(response.data?.quoteTime, now, 90000) && !calendarSession(new Date(now)).open;
      component(section, ready, response, section === 'finance' ? 21600000 : 90000, pendingReport ? '已发现新财报，等待财务指标同步' : waitingLive ? '财务资料已准备，等待当日有效估值行情' : response?.error || (section === 'finance' ? '等待有效财务与行业资料' : '等待有效估值行情'), waitingLive);
    }
    if (includeNotices) component('notices', !!snapshot && ['ready', 'empty'].includes(snapshot.notices?.status) && !snapshot.notices.error && this.noticesCurrent(symbol, snapshot) && noticesReusable(snapshot, now), snapshot?.notices, 300000, snapshot?.notices?.error || '等待有效公告核验');
    if (this.requiresCorporate(symbol, includeNotices)) component('corporate', corporateReusable(snapshot, now, symbol, this.corporate), snapshot?.corporateActions, 300000, snapshot?.corporateActions?.error || '等待有效公司行为资料');
    const pending = components.filter(item => item.status !== 'ready'), status = !pending.length ? 'prepared' : pending.some(item => item.status === 'error') ? 'error' : pending.every(item => item.status === 'waiting-live') ? 'waiting-live' : 'preparing';
    return { status, reason: pending.length ? pending.map(item => item.reason).join('；') : '所需历史资料已准备', preparedAt: !pending.length ? Math.max(...components.map(item => item.fetchedAt || 0)) : null, checkedAt: now, components };
  }
  async loadFinance(symbol, force) {
    if (typeof this.research?.getFinanceWithIndustry === 'function') return this.research.getFinanceWithIndustry({ symbol, force });
    if (!this.research) throw Error('财务与行业服务未配置');
    const results = await Promise.allSettled(['finance', 'profile'].map(section => this.research.get({ symbol, section, force })));
    const response = (result, section) => result.status === 'fulfilled' ? result.value : {
      symbol, section, source: '东方财富', status: 'unavailable', fetchedAt: null, checkedAt: this.clock().getTime(), error: result.reason?.message || '资料获取失败' };
    return { ...response(results[0], 'finance'), industryProfile: response(results[1], 'profile') };
  }
  async load(symbol, force = false, includeFundamentals = false, includeNotices = false, { refreshDaily = force, refreshAheadMs = 0 } = {}) {
    const needsCorporate = this.requiresCorporate(symbol, includeNotices);
    const missing = pending => (force && !pending.forced) || (refreshDaily && !pending.dailyForced) || (includeFundamentals && !pending.fundamentalsAttemptedAt) || (includeNotices && !pending.noticesAttemptedAt) || (needsCorporate && !pending.corporateActions);
    if (this.nextForced.has(symbol)) {
      const pending = await this.nextForced.get(symbol);
      return missing(pending) ? this.load(symbol, force, includeFundamentals, includeNotices, { refreshDaily, refreshAheadMs }) : pending;
    }
    if (this.inflight.has(symbol)) {
      if (force || refreshDaily) {
        const pending = await afterPending(this.inflight, this.nextForced, symbol, () => this.load(symbol, force, includeFundamentals, includeNotices, { refreshDaily, refreshAheadMs }));
        return missing(pending) ? this.load(symbol, force, includeFundamentals, includeNotices, { refreshDaily, refreshAheadMs }) : pending;
      }
      const pending = await this.inflight.get(symbol);
      if (missing(pending)) return this.load(symbol, force, includeFundamentals, includeNotices, { refreshDaily, refreshAheadMs });
      return pending;
    }
    const previous = this.snapshots[symbol], now = this.clock().getTime();
    const ahead = Math.min(30000, Math.max(0, Number(refreshAheadMs) || 0)), currentNotices = this.noticesCurrent(symbol, previous);
    const reuseDaily = !refreshDaily && previous && (dailyReusable(previous, now, symbol)
      ? recentAttempt(previous.dailyCheckedAt ?? previous.attemptedAt, now) : !!previous.error && previous.dailyEvidence === undefined && recentAttempt(previous.dailyCheckedAt ?? previous.attemptedAt, now));
    const staleValuation = previous?.valuation?.status === 'ready' && validAge(previous.valuation.fetchedAt, now, 90000) && !validAge(previous.valuation.data?.quoteTime, now, 90000);
    const reuseFundamental = section => {
      if (force || !previous) return false;
      const attemptedAt = previous.fundamentalsAttempts?.[section] ?? previous.fundamentalsAttemptedAt;
      // A normal response with yesterday's quote is not ready evidence. Avoid
      // polling it on every UI tick, but allow its first opening refresh at once.
      if (section === 'valuation' && staleValuation && previous.valuationAwaitingQuote && recentAttempt(attemptedAt, now)
          && !(calendarSession(new Date(now)).open && !calendarSession(new Date(attemptedAt)).open)) return true;
      return fundamentalReusable(previous, section, now, ahead);
    };
    const reuseNotices = !force && previous && currentNotices && noticesReusable(previous, now, ahead);
    const reuseCorporate = !force && previous && (corporateReusable(previous, now, symbol, this.corporate, ahead)
      || previous.corporateActions?.status !== 'ready' && recentAttempt(previous.corporateAttemptedAt, now));
    const syncDue = previous?.financeReportSync?.status === 'pending' && !validAge(previous.financeReportSync.attemptedAt, now, 299999);
    if (!force && reuseDaily && (!includeFundamentals || ['finance', 'valuation'].every(reuseFundamental)) && (!includeNotices || reuseNotices) && (!needsCorporate || reuseCorporate) && !syncDue) return previous;
    const work = (async () => {
      const snapshot = { attemptedAt: this.clock().getTime() };
      for (const field of [...(!includeFundamentals ? ['finance', 'valuation', 'valuationAwaitingQuote', 'fundamentalsAttempts', 'fundamentalsAttemptedAt', 'financeReportSync'] : []),
        ...(!includeNotices ? ['notices', 'noticesAttemptedAt'] : []), ...(!needsCorporate ? ['corporateActions', 'corporateAttemptedAt'] : [])])
        if (previous && Object.hasOwn(previous, field)) snapshot[field] = previous[field];
      const loadDaily = async () => {
        if (reuseDaily) {
          for (const field of ['technical', 'source', 'provider', 'fetchedAt', 'dailyEvidence', 'historyStatus', 'refreshError', 'cacheWarning', 'error', 'dailyCheckedAt'])
            if (Object.hasOwn(previous, field)) snapshot[field] = previous[field];
          snapshot.dailyCheckedAt ??= previous.attemptedAt;
          return;
        }
        try {
        const data = await this.market.strategyHistory(symbol, null, true, refreshDaily), legacy = Array.isArray(data), bars = legacy ? data : data.bars;
        Object.assign(snapshot, { technical: technicals(bars, this.clock()), source: data.source || '来源未标注', provider: data.provider || null,
          fetchedAt: legacy ? this.clock().getTime() : data.fetchedAt,
          ...(!legacy && Object.hasOwn(data, 'dailyEvidence') ? { dailyEvidence: structuredClone(data.dailyEvidence) } : {}),
          ...(!legacy && data.historyStatus ? { historyStatus: data.historyStatus } : {}),
          ...(!legacy && data.refreshError ? { refreshError: data.refreshError } : {}),
          ...(!legacy && data.cacheWarning ? { cacheWarning: data.cacheWarning } : {}) });
        } catch (e) { snapshot.error = `策略日线不可用：${e.message}`; }
        snapshot.dailyCheckedAt = this.clock().getTime();
      };
      const loadFundamentals = async () => {
      if (includeFundamentals) {
        snapshot.fundamentalsAttempts = {};
        const results = await Promise.allSettled(['finance', 'valuation'].map(async section => {
          const now = this.clock().getTime(), priorAttempt = previous?.fundamentalsAttempts?.[section] ?? previous?.fundamentalsAttemptedAt;
          if (reuseFundamental(section)) {
            snapshot.fundamentalsAttempts[section] = priorAttempt;
            return previous[section];
          }
          snapshot.fundamentalsAttempts[section] = now;
          if (!this.research) throw Error('财务与估值服务未配置');
          const sectionForce = force || ahead > 0 && previous?.[section]?.status === 'ready' && fundamentalReusable(previous, section, now)
            || section === 'valuation' && staleValuation;
          try { return section === 'finance' ? await this.loadFinance(symbol, sectionForce) : await this.research.get({ symbol, section, force: sectionForce }); }
          finally { snapshot.fundamentalsAttempts[section] = this.clock().getTime(); }
        }));
        ['finance', 'valuation'].forEach((section, index) => {
          const result = results[index];
          snapshot[section] = result.status === 'fulfilled' ? result.value : { symbol, section, status: 'unavailable', error: result.reason?.message || '资料获取失败' };
        });
        snapshot.valuationAwaitingQuote = snapshot.valuation?.status === 'ready' && validAge(snapshot.valuation.fetchedAt, this.clock().getTime(), 90000)
          && Number.isFinite(snapshot.valuation.data?.quoteTime) && snapshot.valuation.data.quoteTime > 0
          && snapshot.valuation.data.quoteTime < this.clock().getTime() - 90000;
        snapshot.fundamentalsAttemptedAt = this.clock().getTime();
      }
      };
      const loadNotices = async () => {
      if (includeNotices) {
        if (reuseNotices) {
          snapshot.notices = previous.notices;
          snapshot.noticesAttemptedAt = previous.noticesAttemptedAt;
        } else {
          try {
            if (!this.research) throw Error('公告服务未配置');
            const renewBeforeExpiry = ahead > 0 && previous && currentNotices && ['ready', 'empty'].includes(previous.notices?.status) && noticesReusable(previous, this.clock().getTime());
            snapshot.notices = await this.research.get({ symbol, section: 'notices', force: force || !!renewBeforeExpiry });
          } catch (e) { snapshot.notices = { symbol, section: 'notices', status: 'unavailable', error: e.message || '公告获取失败',
            ...(this.research?.noticeVersion ? { noticeVersion: this.research.noticeVersion(symbol)?.version } : {}) }; }
          snapshot.noticesAttemptedAt = this.clock().getTime();
        }
      }
      };
      const loadCorporate = async () => {
        if (!needsCorporate) return;
        const renewBeforeExpiry = ahead > 0 && corporateReusable(previous, this.clock().getTime(), symbol, this.corporate);
        snapshot.corporateActions = reuseCorporate ? previous.corporateActions : await this.corporate.getSnapshot(symbol, force || renewBeforeExpiry);
        snapshot.corporateAttemptedAt = reuseCorporate ? previous.corporateAttemptedAt : this.clock().getTime();
      };
      // Slow history and notice providers do not serialize independent modules.
      await Promise.all([loadDaily(), loadFundamentals(), loadNotices(), loadCorporate()]);
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
      if (snapshot.dailyEvidence && !preparedTechnicalValid(snapshot, this.clock().getTime(), symbol))
        snapshot.error = '日线版本已更新或已失效，等待重新核验最近完整交易日';
      snapshot.forced = force;
      snapshot.dailyForced = refreshDaily;
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
