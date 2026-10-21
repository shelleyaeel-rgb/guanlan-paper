'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');

const HOSTS = new Set(['np-anotice-stock.eastmoney.com', 'np-cnotice-stock.eastmoney.com', 'pdf.dfcfw.com', 'www.cninfo.com.cn', 'static.cninfo.com.cn']);
const TRANSPORT = 'electron-net';
function abort(signal) { signal?.throwIfAborted(); }
function waiting(promise, signal) {
  const task = Promise.resolve(promise);
  if (signal?.aborted) { task.catch(() => {}); abort(signal); }
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason || Error('已取消资料请求'));
    signal.addEventListener('abort', cancel, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
function classify(error, timedOut = false) {
  if (['size-limit', 'cache-capacity'].includes(error?.code)) return { code: error.code, retryable: false,
    ...(Number.isFinite(error.limitBytes) ? { limitBytes: error.limitBytes } : {}), ...(Number.isFinite(error.actualBytes) ? { actualBytes: error.actualBytes } : {}) };
  const status = error?.status || Number(/HTTP\s+(\d{3})/.exec(error?.message || '')?.[1]);
  if (status) return { code: `http-${status}`, retryable: status === 408 || status === 429 || status >= 500 && status <= 599 };
  if (timedOut || ['TimeoutError', 'AbortError'].includes(error?.name)) return { code: 'timeout', retryable: true };
  const message = [error?.message, error?.code, error?.cause?.code].filter(Boolean).join(' ');
  if (/\bERR_CERT_DATABASE_CHANGED\b/.test(message)) return { code: 'certificate-store-changed', retryable: true };
  if (/\b(?:ERR_CERT_|ERR_SSL_|CERT_|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/.test(message)) return { code: 'certificate-invalid', retryable: false };
  if (/ERR_HTTP2_PROTOCOL_ERROR|HTTP2.*(?:ERROR|error)|ERR_HTTP2_STREAM_ERROR/.test(message)) return { code: 'http2-protocol', retryable: true };
  if (/ERR_(?:NETWORK_CHANGED|CONNECTION_(?:CLOSED|RESET|REFUSED|TIMED_OUT|ABORTED)|TIMED_OUT|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|EMPTY_RESPONSE)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET)|fetch failed|network (?:error|failure)|Failed to fetch/i.test(message)) return { code: 'network', retryable: true };
  return { code: error instanceof SyntaxError ? 'invalid-json' : 'invalid-response', retryable: false };
}
function retryAfter(response, now) {
  const value = response.headers?.get('retry-after');
  if (!value) return 0;
  const duration = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

/** Keeps Chromium's configured proxy path. There is no direct-network fallback. */
class CompanyEvidenceTransport {
  constructor(fetcher, { clock = Date.now, timeoutMs = 15000, deadlineMs = 45000, maxAttempts = 3,
    retryBaseMs = 300, cooldownMs = 30000, failureThreshold = 3, sleep = delay } = {}) {
    if (typeof fetcher !== 'function') throw Error('研究资料传输服务未配置');
    for (const [name, value, minimum, maximum] of [['timeoutMs', timeoutMs, 1, 120000], ['deadlineMs', deadlineMs, 1, 120000],
      ['maxAttempts', maxAttempts, 1, 4], ['retryBaseMs', retryBaseMs, 0, 10000], ['cooldownMs', cooldownMs, 1, 300000], ['failureThreshold', failureThreshold, 1, 10]]) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw Error(`研究资料传输${name}上限无效`);
    }
    Object.assign(this, { fetcher, clock, timeoutMs, deadlineMs, maxAttempts, retryBaseMs, cooldownMs, failureThreshold, sleep });
    this.hosts = new Map(); this.generation = 0; this.retryBatch = false;
  }
  beginBatch({ retry = false } = {}) {
    if (typeof retry !== 'boolean') throw Error('资料重试参数无效');
    this.generation++; this.retryBatch = retry;
    return { generation: this.generation, retry };
  }
  state(host) {
    if (!this.hosts.has(host)) this.hosts.set(host, { failures: 0, until: 0, retryAfterUntil: 0, lastCode: null, probe: null, probeGeneration: -1, failureRevision: 0 });
    return this.hosts.get(host);
  }
  diagnostic(error, context, attempts, extra = {}) {
    const detail = { ...context, ...classify(error), attempts, message: error.message, ...extra };
    const wrapped = Error(error.message, { cause: error }); wrapped.acquisition = detail; return wrapped;
  }
  paused(context, state, attempts = 0) {
    return this.diagnostic(Error(`资料服务暂缓请求，等待恢复探测（${state.lastCode || '网络连续失败'}）`), context, attempts,
      { code: 'service-paused', retryable: true, retryAt: state.until, underlyingCode: state.lastCode });
  }
  async waitForRecovery(issue, { signal, maxWaitMs } = {}) {
    abort(signal);
    if (!issue?.retryable || !HOSTS.has(issue.host) || !Number.isFinite(issue.retryAt)
      || !Number.isFinite(maxWaitMs) || maxWaitMs <= 0) return false;
    const state = this.state(issue.host), deadline = performance.now() + maxWaitMs;
    while (true) {
      abort(signal);
      const remaining = Math.ceil(deadline - performance.now());
      const waitMs = Math.max(0, state.until, state.retryAfterUntil, issue.retryAt) - this.clock();
      // Another company's probe can move this shared host cooldown while we
      // sleep. Recheck it within this call's original monotonic budget only.
      // Retry-After, request attempts and deferred-pass limits stay unchanged.
      if (remaining < 0 || waitMs > remaining) return false;
      if (waitMs <= 0) return true;
      await waiting(this.sleep(waitMs, undefined, { signal }), signal);
    }
  }
  async gate(state, context, signal, generation, retryBatch, attempts) {
    while (state.probe) { await waiting(state.probe.promise, signal); }
    const forced = retryBatch && state.probeGeneration !== generation && state.retryAfterUntil <= this.clock();
    if (state.until > this.clock() && !forced) throw this.paused(context, state, attempts);
    if (state.until || forced && state.failures) {
      state.probeGeneration = generation;
      let resolve; const promise = new Promise(done => { resolve = done; });
      state.probe = { promise, resolve }; return state.probe;
    }
    return null;
  }
  async run(url, { signal, stage = 'body', documentId, timeoutMs = this.timeoutMs, deadlineMs = this.deadlineMs, onDiagnostic } = {}, operation) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port && parsed.port !== '443' || !HOSTS.has(parsed.hostname)) throw Error('研究资料传输域名无法核验');
    abort(signal);
    const context = { stage, host: parsed.hostname, transport: TRANSPORT, ...(documentId ? { documentId } : {}) }, state = this.state(parsed.hostname);
    const total = AbortSignal.timeout(deadlineMs), combined = signal ? AbortSignal.any([signal, total]) : total;
    const generation = this.generation, retryBatch = this.retryBatch; let attempts = 0, last;
    const emit = detail => { try { onDiagnostic?.(detail); } catch {} };
    try {
      while (attempts < this.maxAttempts) {
        const probe = await this.gate(state, context, combined, generation, retryBatch, attempts);
        const timeout = AbortSignal.timeout(timeoutMs), attemptSignal = AbortSignal.any([combined, timeout]), revision = state.failureRevision;
        try {
          abort(attemptSignal);
          attempts++;
          const value = await waiting(operation(attemptSignal), attemptSignal); abort(attemptSignal);
          if (probe || revision === state.failureRevision) { state.failures = 0; state.until = 0; state.retryAfterUntil = 0; state.lastCode = null; }
          if (attempts > 1 || probe) emit({ ...context, code: 'recovered', recovered: true, retryable: false, attempts, message: '资料请求已恢复' });
          return value;
        } catch (error) {
          abort(signal); if (total.aborted) throw this.diagnostic(error, context, attempts, { code: 'deadline', retryable: true });
          const kind = classify(error, timeout.aborted);
          last = this.diagnostic(error, context, attempts, kind);
          if (!kind.retryable) throw last;
          state.failures++; state.failureRevision++; state.lastCode = kind.code;
          const after = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
          state.retryAfterUntil = Math.max(state.retryAfterUntil, this.clock() + after);
          if (kind.code === 'http-429' || state.failures >= this.failureThreshold || probe) {
            state.until = this.clock() + Math.max(this.cooldownMs, after); state.probeGeneration = generation;
            last.acquisition.retryAt = state.until; throw last;
          }
          if (attempts >= this.maxAttempts) throw last;
          const waitMs = Math.max(this.retryBaseMs * 2 ** (attempts - 1), after);
          emit({ ...last.acquisition, code: 'retrying', underlyingCode: kind.code, retryAfterMs: waitMs });
          await waiting(this.sleep(waitMs, undefined, { signal: combined }), combined);
        } finally {
          if (probe && state.probe === probe) { state.probe = null; probe.resolve(); }
        }
      }
      throw last;
    } catch (error) {
      abort(signal);
      if (error.acquisition) throw error;
      if (total.aborted) throw this.diagnostic(error, context, attempts, { code: 'deadline', retryable: true });
      throw this.diagnostic(error, context, attempts);
    }
  }
  async response(url, options) {
      const response = await this.fetcher(url, options);
      if (!response.ok) {
        const error = Object.assign(Error(`研究资料 HTTP ${response.status}`), { status: response.status, retryAfterMs: retryAfter(response, this.clock()) });
        try { await response.body?.cancel(); } catch {} throw error;
      }
      return response;
  }
  json(url, options = {}, request = {}) {
    return this.run(url, options, async signal => {
      const response = await this.response(url, { ...request, signal, cache: 'no-store', headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://data.eastmoney.com/', ...request.headers } });
      if (response.url) {
        const actual = new URL(response.url), expected = new URL(url);
        if (actual.protocol !== 'https:' || actual.hostname !== expected.hostname) throw Error('研究资料重定向后的来源域名无法验证');
      }
      return response.json();
    });
  }
}
module.exports = { CompanyEvidenceTransport, classifyAcquisitionError: classify };
