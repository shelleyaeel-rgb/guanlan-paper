'use strict';
const { cnTime, symbolOf } = require('./common.cjs');
const { MARKET_REGIME_POLICY } = require('./market-regime.cjs');

const SINA_BATCH_SIZE = 80;
const PRIMARY_LABEL = '腾讯财经';
const FALLBACK_LABEL = '新浪财经';
const invalid = message => Object.assign(Error(message), { code: 'invalid-breadth' });

function abortError(signal) { return signal.reason instanceof Error ? signal.reason : Error('已取消市场广度获取'); }
function waitFor(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(abortError(signal)); }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortError(signal));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
async function budgeted(load, parent, milliseconds, message) {
  parent.throwIfAborted();
  const controller = new AbortController(), signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => controller.abort(Error(message)), milliseconds);
  try { return await waitFor(Promise.resolve().then(() => load(signal)), signal); }
  finally { clearTimeout(timer); controller.abort(); }
}

function validUniverse(universe, now) {
  if (!universe || !Array.isArray(universe.symbols) || !universe.source || !Number.isInteger(universe.sourceCount)
    || !Number.isInteger(universe.excludedCount) || universe.excludedCount < 0
    || universe.symbols.length !== universe.sourceCount - universe.excludedCount
    || universe.symbols.length < MARKET_REGIME_POLICY.minBreadthCount || !Number.isFinite(universe.validatedAt)
    || universe.validatedAt > now || now - universe.validatedAt >= 30 * 60000 || universe.date !== cnTime(now).date) throw invalid('市场广度证券名单不完整、过期或跨日');
  const seen = new Set();
  for (const symbol of universe.symbols) {
    let normalized;
    try { normalized = symbolOf(symbol); } catch { throw invalid('市场广度证券名单包含无效代码'); }
    if (normalized !== symbol || seen.has(symbol)) throw invalid('市场广度证券名单包含重复或无效代码');
    seen.add(symbol);
  }
  return universe;
}

// Success means every requested security has a row. Suspensions may retain an
// old quote; the existing market policy still requires >=80% fresh coverage.
function validateBreadth(snapshot, now) {
  const policy = MARKET_REGIME_POLICY, date = cnTime(now).date;
  const expected = snapshot?.sourceCount - snapshot?.excludedCount;
  if (!snapshot?.source || !Array.isArray(snapshot.rows) || !Number.isInteger(snapshot.sourceCount)
    || !Number.isInteger(snapshot.excludedCount) || snapshot.excludedCount < 0 || expected < policy.minBreadthCount
    || snapshot.rows.length !== expected || !Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt > now
    || now - snapshot.fetchedAt > policy.breadthMaxAgeMs || cnTime(snapshot.fetchedAt).date !== date) throw invalid('市场广度快照不完整、过期或跨日');
  const seen = new Set(); let valid = 0;
  for (const row of snapshot.rows) {
    let symbol;
    try { symbol = symbolOf(row?.symbol); } catch { throw invalid('市场广度快照包含无效股票代码'); }
    if (symbol !== row.symbol || seen.has(symbol)) throw invalid('市场广度快照包含重复或无效股票代码');
    seen.add(symbol);
    if (Number.isFinite(row.timestamp) && row.timestamp > 0 && row.timestamp <= now
      && now - row.timestamp <= policy.breadthMaxAgeMs && cnTime(row.timestamp).date === date
      && (row.date == null || row.date === date) && row.price > 0 && Number.isFinite(row.changePct) && row.changePct > -100) valid++;
  }
  if (valid < policy.minBreadthCount || valid / expected < policy.minBreadthCoverage) throw invalid(`市场广度有效同日报价不足：${valid}/${expected}，要求至少 ${policy.minBreadthCount} 只且覆盖 ${policy.minBreadthCoverage * 100}%`);
  return snapshot;
}

// Sina's real-time quote carries its own complete date and time. Its list API
// does not. Only price/previous-close/time are used here, never PE or volume ratio.
function parseSinaBreadth(text, expectedSymbols) {
  if (typeof text !== 'string' || !Array.isArray(expectedSymbols)) throw invalid('新浪市场广度响应格式无效');
  const expected = new Set(expectedSymbols), rows = new Map();
  if (expected.size !== expectedSymbols.length) throw invalid('新浪市场广度请求代码重复');
  const number = value => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  for (const match of text.matchAll(/\bvar\s+hq_str_([a-zA-Z0-9_]+)\s*=\s*"([^"\r\n]*)"/g)) {
    const symbol = match[1];
    if (!expected.has(symbol) || rows.has(symbol)) throw invalid('新浪市场广度包含未请求或重复代码');
    const fields = match[2].split(',');
    if (fields.length < 32 || !fields[0].trim()) throw invalid(`新浪市场广度字段截断：${symbol}`);
    const date = fields[30], time = fields[31];
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) throw invalid(`新浪市场广度缺少有效原始日期时间：${symbol}`);
    const price = number(fields[3]), prevClose = number(fields[2]);
    rows.set(symbol, { symbol, price, prevClose, changePct: price > 0 && prevClose > 0 ? (price / prevClose - 1) * 100 : null,
      timestamp: Date.parse(`${date}T${time}+08:00`), date });
  }
  const missing = expectedSymbols.filter(symbol => !rows.has(symbol));
  if (missing.length) throw invalid(`新浪市场广度缺少 ${missing.length} 只股票：${missing.slice(0, 3).join('、')}`);
  return expectedSymbols.map(symbol => rows.get(symbol));
}

class MarketBreadthSource {
  constructor(primarySource, { clock = Date.now, deadlineMs = 120000, primaryBudgetMs = 55000,
    universeBudgetMs = 12000, universeLoader = null, primaryCooldownMs = 30000 } = {}) {
    if (!primarySource?.load || !primarySource?.request || !primarySource?.loadUniverse || !primarySource?.validateUniverse) throw Error('市场广度主源未配置');
    for (const value of [deadlineMs, primaryBudgetMs, universeBudgetMs, primaryCooldownMs]) if (!Number.isSafeInteger(value) || value < 1) throw Error('市场广度获取预算无效');
    Object.assign(this, { primarySource, clock, deadlineMs, primaryBudgetMs: Math.min(primaryBudgetMs, Math.max(1, Math.floor(deadlineMs / 2))),
      universeBudgetMs, universeLoader, primaryCooldownMs });
    this.pending = null; this.primaryFailure = null;
  }
  load({ signal, onProgress = () => {}, force = false } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    let job = this.pending;
    if (!job || job.controller.signal.aborted) {
      job = { controller: new AbortController(), subscribers: new Set(), progress: null };
      this.pending = job;
      Promise.resolve().then(() => this.run({ signal: job.controller.signal, force, onProgress: progress => {
        job.progress = progress;
        for (const subscriber of [...job.subscribers]) subscriber.progress(progress);
      } })).then(value => finish(null, value), error => finish(error));
      const finish = (error, value) => {
        if (this.pending === job) this.pending = null;
        for (const subscriber of [...job.subscribers]) subscriber.finish(error, value);
      };
    }
    return new Promise((resolve, reject) => {
      const subscriber = {
        finish: (error, value) => {
          if (!job.subscribers.delete(subscriber)) return;
          signal?.removeEventListener('abort', cancel);
          if (error) reject(error); else resolve(value);
        },
        progress: value => {
          if (!job.subscribers.has(subscriber)) return;
          try { onProgress({ ...value }); }
          catch (error) { subscriber.finish(error); if (!job.subscribers.size) job.controller.abort(); }
        }
      };
      const cancel = () => { subscriber.finish(abortError(signal)); if (!job.subscribers.size) job.controller.abort(); };
      job.subscribers.add(subscriber); signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel(); else if (job.progress) subscriber.progress(job.progress);
    });
  }
  async run({ signal: parent, onProgress, force }) {
    return budgeted(async signal => {
      const startedAt = this.clock(), diagnostics = [];
      const record = (provider, error) => diagnostics.push({ provider, message: error.message, at: this.clock() });
      if (!force && this.primaryFailure && this.primaryFailure.retryAt > this.clock()) {
        record('tencent', Error(`腾讯主源暂缓重试：${this.primaryFailure.message}`));
      } else {
        try {
          const snapshot = await budgeted(primarySignal => this.primarySource.load({ signal: primarySignal,
            onProgress: progress => onProgress({ ...progress, provider: 'tencent', providerLabel: PRIMARY_LABEL, fallbackReason: null }) }),
          signal, this.primaryBudgetMs, '腾讯市场广度本轮获取预算已用完，转用备用来源');
          validateBreadth(snapshot, this.clock());
          this.primaryFailure = null;
          return { ...snapshot, provider: 'tencent', providerLabel: PRIMARY_LABEL, acquisitionDiagnostics: [] };
        } catch (error) {
          signal.throwIfAborted(); record('tencent', error);
          this.primaryFailure = { message: error.message, retryAt: this.clock() + this.primaryCooldownMs };
        }
      }
      const fallbackReason = diagnostics.map(item => item.message).join('；');
      const progress = value => onProgress({ ...value, provider: 'sina', providerLabel: FALLBACK_LABEL, fallbackReason });
      progress({ loading: true, stage: 'universe', completed: 0, total: 0 });
      let universe, validator;
      try {
        universe = await budgeted(universeSignal => this.primarySource.loadUniverse({ signal: universeSignal, onProgress: progress }),
          signal, this.universeBudgetMs, '新浪证券名单获取预算已用完');
        validUniverse(universe, this.clock());
        validator = options => this.primarySource.validateUniverse(universe, options);
      } catch (error) {
        signal.throwIfAborted(); record('sina-universe', error);
        if (!this.universeLoader) throw Error(`市场广度全部来源获取失败：${diagnostics.map(item => item.message).join('；')}`);
        try {
          universe = await this.universeLoader.load({ signal, onProgress: progress });
          validUniverse(universe, this.clock());
          validator = options => this.universeLoader.validate(universe, options);
        } catch (error) {
          signal.throwIfAborted(); record('fallback-universe', error);
          throw Error(`市场广度全部来源获取失败：${diagnostics.map(item => item.message).join('；')}`);
        }
      }
      try {
        const rows = [], symbols = universe.symbols;
        progress({ loading: true, stage: 'breadth-quotes', completed: 0, total: symbols.length });
        for (let offset = 0; offset < symbols.length; offset += SINA_BATCH_SIZE) {
          const batch = symbols.slice(offset, offset + SINA_BATCH_SIZE);
          const body = await this.primarySource.request(`https://hq.sinajs.cn/list=${batch.join(',')}`, signal, true);
          signal.throwIfAborted();
          rows.push(...parseSinaBreadth(body, batch));
          progress({ loading: true, stage: 'breadth-quotes', completed: rows.length, total: symbols.length });
        }
        await validator({ signal }); signal.throwIfAborted();
        return validateBreadth({ rows, source: `${FALLBACK_LABEL}公开行情（${universe.source}）`, provider: 'sina', providerLabel: FALLBACK_LABEL,
          sourceCount: universe.sourceCount, excludedCount: universe.excludedCount, universeSource: universe.source,
          universeValidatedAt: universe.validatedAt, startedAt, fetchedAt: this.clock(), acquisitionDiagnostics: diagnostics }, this.clock());
      } catch (error) {
        signal.throwIfAborted(); record('sina', error);
        throw Error(`市场广度全部来源获取失败：${diagnostics.map(item => item.message).join('；')}`);
      }
    }, parent, this.deadlineMs, '市场广度获取超时，未使用不完整股票池');
  }
}

module.exports = { MarketBreadthSource, parseSinaBreadth, validateBreadth, SINA_BATCH_SIZE };
