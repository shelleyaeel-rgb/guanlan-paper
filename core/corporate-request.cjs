'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const HOSTS = new Set(['datacenter.eastmoney.com', 'datacenter-web.eastmoney.com', 'np-anotice-stock.eastmoney.com', 'np-cnotice-stock.eastmoney.com']);
function active(signal) { signal?.throwIfAborted(); }
function waiting(value, signal) {
  const task = Promise.resolve(value);
  if (signal?.aborted) { task.catch(() => {}); active(signal); }
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function classification(error, timedOut = false) {
  if (error?.code === 'source-cooldown') return { code: error.code, retryable: false, scope: error.scope, retryAt: error.retryAt, underlyingCode: `http-${error.status}` };
  if (timedOut || error?.name === 'TimeoutError') return { code: 'timeout', retryable: true };
  const status = error?.status;
  // The live announcement endpoint returns an EdgeOne rejection page with
  // status 567. Repeating it as a transient server error amplifies the failure.
  if (status) return { code: `http-${status}`, retryable: status !== 567 && (status === 408 || status === 429 || status >= 500 && status <= 599) };
  const message = [error?.message, error?.code, error?.cause?.code].filter(Boolean).join(' ');
  if (/\bERR_CERT_DATABASE_CHANGED\b/.test(message)) return { code: 'certificate-store-changed', retryable: true };
  if (/\b(?:ERR_CERT_|ERR_SSL_|CERT_|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/.test(message)) return { code: 'certificate-invalid', retryable: false };
  if (/ERR_HTTP2_PROTOCOL_ERROR|ERR_HTTP2_STREAM_ERROR/.test(message)) return { code: 'http2-protocol', retryable: true };
  if (/ERR_(?:NETWORK_CHANGED|CONNECTION_(?:CLOSED|RESET|REFUSED|TIMED_OUT|ABORTED)|TIMED_OUT|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|EMPTY_RESPONSE)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET)|fetch failed|network (?:error|failure)|Failed to fetch/i.test(message)) return { code: 'network', retryable: true };
  return { code: error instanceof SyntaxError ? 'invalid-json' : 'invalid-response', retryable: false };
}
function trustedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.has(url.hostname)) throw Error('公司行为资料来源域名无法核验');
  return url;
}
function retryAfter(response, now) {
  const text = response.headers?.get('retry-after');
  const ms = /^\d+$/.test(text || '') ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}
function requestKey(url) {
  const key = new URL(url); key.hash = ''; key.searchParams.sort(); return key.href;
}
function cooldownError(host, scope, state) {
  const retryAt = state.blockedUntil;
  const time = new Date(Math.ceil(retryAt / 1000) * 1000 + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const subject = scope === 'host' ? '同域名请求' : '该请求';
  return Object.assign(Error(`公司行为资料${subject}已在本地暂停，本次未发送（${host}；此前收到 HTTP ${state.blockedStatus}）；允许再次尝试时间：${time}（北京时间）`),
    { code: 'source-cooldown', scope, retryAt, status: state.blockedStatus });
}

// GET requests stay on the supplied Electron fetcher, including its proxy and
// certificate validation. Only transient failures receive bounded retries.
class CorporateRequest {
  constructor(fetcher, { clock = Date.now, timeoutMs = 10000, deadlineMs = 30000, maxAttempts = 3, retryBaseMs = 300, minIntervalMs = 250, rejectionCooldownMs = 60000, sleep = delay } = {}) {
    if (typeof fetcher !== 'function') throw Error('公司行为资料传输服务未配置');
    for (const [key, value, min, max] of [['timeoutMs', timeoutMs, 1, 120000], ['deadlineMs', deadlineMs, 1, 120000],
      ['maxAttempts', maxAttempts, 1, 3], ['retryBaseMs', retryBaseMs, 0, 10000],
      ['minIntervalMs', minIntervalMs, 0, 10000], ['rejectionCooldownMs', rejectionCooldownMs, 1000, 300000]]) {
      if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`公司行为请求 ${key} 上限无效`);
    }
    Object.assign(this, { fetcher, clock, timeoutMs, deadlineMs, maxAttempts, retryBaseMs, minIntervalMs, rejectionCooldownMs, sleep });
    this.hosts = new Map();
  }
  async onHost(host, key, signal, load) {
    let state = this.hosts.get(host);
    if (!state) this.hosts.set(host, state = { tail: Promise.resolve(), nextAt: 0, blockedUntil: 0, requests: new Map() });
    const previous = state.tail;
    let release;
    const ticket = new Promise(resolve => { release = resolve; });
    state.tail = previous.then(() => ticket);
    try {
      await waiting(previous, signal); active(signal);
      const now = this.clock();
      for (const [request, blocked] of state.requests) if (blocked.blockedUntil <= now) state.requests.delete(request);
      if (state.blockedUntil > now) throw cooldownError(host, 'host', state);
      const blocked = state.requests.get(key);
      if (blocked) throw cooldownError(host, 'request', blocked);
      const waitMs = state.nextAt - this.clock();
      if (waitMs > 0) await waiting(this.sleep(waitMs, undefined, { signal }), signal);
      active(signal);
      state.nextAt = this.clock() + this.minIntervalMs;
      return await load(state);
    } finally { release(); }
  }
  async json(url, { signal, stage = 'corporate', documentId, onDiagnostic } = {}) {
    const original = trustedUrl(url), key = requestKey(original); active(signal);
    const context = { stage, host: original.hostname, transport: 'electron-net', ...(documentId ? { documentId } : {}) };
    const emit = item => { try { onDiagnostic?.(item); } catch {} };
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new DOMException('公司行为资料请求超过总期限', 'TimeoutError')), this.deadlineMs);
    const totalSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let attempts = 0;
    const wrap = (error, detail) => Object.assign(Error(error.message, { cause: error }), { acquisition: { ...context, ...detail, attempts, message: error.message } });
    try {
      while (attempts < this.maxAttempts) {
        active(totalSignal);
        const timeout = new AbortController();
        let attemptTimer, failure, kind;
        try {
          return await this.onHost(original.hostname, key, totalSignal, async hostState => {
          attemptTimer = setTimeout(() => timeout.abort(new DOMException('公司行为资料请求超时', 'TimeoutError')), this.timeoutMs);
          const attemptSignal = AbortSignal.any([totalSignal, timeout.signal]);
          active(attemptSignal); attempts++;
          const response = await waiting(this.fetcher(url, { signal: attemptSignal, cache: 'no-store', headers: {
            'User-Agent': 'Mozilla/5.0', Referer: 'https://data.eastmoney.com/' } }), attemptSignal);
          if (response.url && trustedUrl(response.url).hostname !== original.hostname) throw Error('公司行为资料重定向来源不符');
          if (!response.ok) {
            const retryMs = retryAfter(response, this.clock());
            if (response.status === 429 || retryMs !== null) {
              hostState.blockedUntil = this.clock() + (retryMs ?? this.rejectionCooldownMs);
              hostState.blockedStatus = response.status;
            } else if (response.status === 567) {
              // A rejection can depend on this URL's parameters. Without a
              // Retry-After it is not evidence that every stock is unavailable.
              hostState.requests.set(key, { blockedUntil: this.clock() + this.rejectionCooldownMs, blockedStatus: response.status });
            }
            const label = ({ 'corporate-index': '公告目录', 'corporate-report': '分红报表', 'corporate-body': '实施公告正文' })[stage] || '公司行为资料';
            const error = Object.assign(Error(`${label}接口${response.status === 567 ? '拒绝请求' : '获取失败'}（${original.hostname}，HTTP ${response.status}）${response.status === 567 ? '；已在本地暂停该请求的快速重试' : ''}`), { status: response.status, retryAfterMs: retryMs ?? 0 });
            try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
            throw error;
          }
          const value = await waiting(response.json(), attemptSignal); active(attemptSignal);
          if (attempts > 1) emit({ ...context, code: 'recovered', attempts, retryable: false, recovered: true, message: '公司行为资料请求已恢复' });
          return value;
          });
        } catch (error) {
          active(signal);
          if (deadline.signal.aborted) throw wrap(error, { code: 'deadline', retryable: true });
          failure = error; kind = classification(error, timeout.signal.aborted);
        } finally { clearTimeout(attemptTimer); }
        if (!kind.retryable || attempts === this.maxAttempts) throw wrap(failure, kind);
        const retryAfterMs = Math.max(this.retryBaseMs * 2 ** (attempts - 1), failure.retryAfterMs || 0);
        emit({ ...context, code: 'retrying', underlyingCode: kind.code, attempts, retryable: true, retryAfterMs, message: failure.message });
        await waiting(this.sleep(retryAfterMs, undefined, { signal: totalSignal }), totalSignal);
      }
    } catch (error) {
      active(signal);
      if (error.acquisition) throw error;
      throw wrap(error, deadline.signal.aborted ? { code: 'deadline', retryable: true } : classification(error));
    } finally { clearTimeout(timer); }
  }
}
module.exports = { CorporateRequest, waitForCorporateRequest: waiting };
