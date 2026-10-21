const { setTimeout: delay } = require('node:timers/promises');
const { symbolOf, cnTime } = require('./common.cjs');
const { parseTencentScreenQuotes, TENCENT_SCREEN_SOURCE } = require('./screener-tencent.cjs');

const LIST_BASE = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.';
const PAGE_SIZE = 80, QUOTE_BATCH = 50, LIST_CONCURRENCY = 3, UNIVERSE_MAX_AGE_MS = 30 * 60000;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const invalid = message => Object.assign(Error(message), { code: 'invalid' });
const cancelled = () => Error('已取消选股，本次结果未应用');

// The list supplies symbols only. Every metric, name and timestamp comes from
// one Tencent quote; Sina's static PE and time-only ticks are never merged in.
class FreeScreenerSource {
  constructor(fetcher = fetch, { spacingMs = 150, requestTimeoutMs = 8000, deadlineMs = 120000, clock = Date.now, requestClock = Date.now } = {}) {
    this.fetcher = fetcher; this.spacingMs = spacingMs; this.requestTimeoutMs = requestTimeoutMs; this.deadlineMs = deadlineMs;
    this.clock = clock; this.requestClock = requestClock; this.universe = null; this.pendingLoad = null; this.hostQueues = new Map();
  }
  async requestSlot(host, signal) {
    let queue = this.hostQueues.get(host);
    if (!queue) { queue = { tail: Promise.resolve(), nextAt: this.requestClock() + this.spacingMs, retryAt: 0, retryStatus: null }; this.hostQueues.set(host, queue); }
    const prior = queue.tail; let release;
    queue.tail = new Promise(resolve => { release = resolve; });
    try {
      await prior; signal.throwIfAborted();
      for (;;) {
        const now = this.requestClock();
        if (queue.retryAt - now > 5000) {
          const retryTime = cnTime(Math.ceil(queue.retryAt / 1000) * 1000);
          throw Object.assign(Error(`选股行情来源暂缓请求（${host}）：HTTP ${queue.retryStatus} Retry-After，允许再次尝试时间：${retryTime.date} ${retryTime.time}（北京时间），本次未发送`), { code: 'source-cooldown', retryAt: queue.retryAt });
        }
        const wait = queue.nextAt - now;
        if (wait <= 0) break;
        await delay(wait, undefined, { signal }); signal.throwIfAborted();
      }
      signal.throwIfAborted(); queue.nextAt = this.requestClock() + this.spacingMs;
    } finally { release(); }
  }
  async request(url, signal, gbk = false, validate = null) {
    const host = new URL(url).hostname;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.requestSlot(host, signal);
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]);
      try {
        const response = await this.fetcher(url, { signal: requestSignal, cache: 'no-store', headers: {
          'User-Agent': 'Mozilla/5.0', Referer: host.includes('sina') ? 'https://finance.sina.com.cn/' : host.endsWith('eastmoney.com') ? 'https://quote.eastmoney.com/' : 'https://gu.qq.com/'
        } });
        if (!response.ok) {
          const retryAfter = response.headers?.get('retry-after');
          const parsedRetryAfter = retryAfter ? Math.max(0, /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - this.requestClock()) : 0;
          const retryAfterMs = Number.isFinite(parsedRetryAfter) ? parsedRetryAfter : 0;
          if (retryAfterMs > 0) {
            const queue = this.hostQueues.get(host), retryAt = this.requestClock() + retryAfterMs;
            // Retry-After governs every same-host worker and later loads, not
            // only the page that received it. Queued slots recheck nextAt.
            if (retryAt > queue.retryAt) { queue.retryAt = retryAt; queue.retryStatus = response.status; }
            queue.nextAt = Math.max(queue.nextAt, retryAt);
          }
          try { await response.body?.cancel(); } catch {}
          throw Object.assign(Error(`HTTP ${response.status}`), { status: response.status, retryAfterMs });
        }
        const body = gbk === true ? new TextDecoder('gb18030').decode(await response.arrayBuffer()) : await response.text();
        requestSignal.throwIfAborted();
        if (!gbk) {
          let value;
          try { value = JSON.parse(body); } catch { throw invalid('响应不是有效 JSON'); }
          if (validate) validate(value);
          return value;
        }
        return body;
      } catch (error) {
        signal.throwIfAborted();
        if (attempt === 1 || error.code === 'invalid' || (error.status && !RETRYABLE.has(error.status)) || error.retryAfterMs > 5000) {
          throw Error(`选股行情获取失败（${host}）：${error.message}`);
        }
        await delay(Math.max(800, error.retryAfterMs || 0), undefined, { signal });
      }
    }
  }
  load({ signal, onProgress = () => {} } = {}) {
    if (signal?.aborted) return Promise.reject(cancelled());
    let job = this.pendingLoad;
    if (!job || job.controller.signal.aborted) {
      job = { controller: new AbortController(), subscribers: new Set(), progress: null };
      this.pendingLoad = job;
      // Attach all callers before the shared work starts. A caller's abort
      // releases only that subscription; the last departure cancels the work.
      Promise.resolve().then(() => this.loadShared({ signal: job.controller.signal, onProgress: progress => {
        job.progress = progress;
        for (const subscriber of [...job.subscribers]) subscriber.progress(progress);
      } })).then(value => {
        if (this.pendingLoad === job) this.pendingLoad = null;
        for (const subscriber of [...job.subscribers]) subscriber.finish(null, value);
      }, error => {
        if (this.pendingLoad === job) this.pendingLoad = null;
        for (const subscriber of [...job.subscribers]) subscriber.finish(error);
      });
    }
    return new Promise((resolve, reject) => {
      const subscriber = {
        finish: (error, value) => {
          if (!job.subscribers.delete(subscriber)) return;
          signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(value);
        },
        progress: value => {
          if (!job.subscribers.has(subscriber)) return;
          try { onProgress({ ...value }); }
          catch (error) { subscriber.finish(error); if (!job.subscribers.size) job.controller.abort(); }
        }
      };
      const abort = () => { subscriber.finish(cancelled()); if (!job.subscribers.size) job.controller.abort(); };
      job.subscribers.add(subscriber); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else if (job.progress) subscriber.progress(job.progress);
    });
  }
  loadBreadth(options = {}) {
    if (!this.breadthSource) {
      const { MarketBreadthSource } = require('./market-breadth-source.cjs');
      const { EastmoneyStockUniverseSource } = require('./stock-universe-source.cjs');
      this.breadthSource = new MarketBreadthSource(this, {
        clock: this.clock, deadlineMs: this.deadlineMs,
        universeLoader: new EastmoneyStockUniverseSource(this.request.bind(this), { clock: this.clock })
      });
    }
    return this.breadthSource.load(options);
  }
  async universeCount(signal) {
    const value = await this.request(LIST_BASE + 'getHQNodeStockCount?node=hs_a', signal);
    if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 15000) throw invalid('新浪股票列表总数无效');
    return Number(value);
  }
  async validateUniverse(universe, { signal } = {}) {
    if (await this.universeCount(signal) !== universe.sourceCount) {
      this.universe = null;
      throw invalid('股票池在报价获取期间发生变化，请重新选股');
    }
  }
  async loadUniverse({ signal, onProgress = () => {} } = {}) {
    onProgress({ loading: true, stage: 'universe', completed: 0, total: 0 });
    const total = await this.universeCount(signal), now = this.clock(), cached = this.universe;
    if (!cached || cached.sourceCount !== total || now < cached.validatedAt || now - cached.validatedAt >= UNIVERSE_MAX_AGE_MS || cached.date !== cnTime(now).date) {
      this.universe = null;
      const lists = await this.listPages(total, signal, onProgress), symbols = [], seen = new Set();
      let prior = '', excludedCount = 0;
      // Completion order may differ, but identity and ordering checks always
      // use the provider's page order before any universe can be cached.
      for (const list of lists) for (const row of list) {
        if (seen.has(row.symbol) || row.symbol <= prior) throw invalid('新浪股票列表重复或排序变化，请重新选股');
        seen.add(row.symbol); prior = row.symbol;
        try { if (symbolOf(row.symbol) !== row.symbol) throw Error(); symbols.push(row.symbol); }
        catch { excludedCount++; }
      }
      if (seen.size !== total || await this.universeCount(signal) !== total) throw invalid('股票池在获取期间发生变化，请重新选股');
      if (!symbols.length) throw invalid('新浪股票列表未返回支持的沪深 A 股');
      signal.throwIfAborted();
      const validatedAt = this.clock();
      this.universe = { symbols, sourceCount: total, excludedCount, validatedAt, date: cnTime(validatedAt).date, source: '新浪财经沪深证券列表' };
    } else {
      onProgress({ loading: true, stage: 'universe', completed: Math.ceil(total / PAGE_SIZE), total: Math.ceil(total / PAGE_SIZE), cached: true, validatedAt: cached.validatedAt });
    }
    return this.universe;
  }
  async listPages(total, signal, onProgress) {
    const pages = Math.ceil(total / PAGE_SIZE), results = Array(pages), controller = new AbortController();
    const pageSignal = AbortSignal.any([signal, controller.signal]);
    let nextPage = 1, completed = 0, firstError;
    onProgress({ loading: true, stage: 'universe', completed: 0, total: pages });
    const worker = async () => {
      while (!pageSignal.aborted && nextPage <= pages) {
        const page = nextPage++;
        try {
          results[page - 1] = await this.request(LIST_BASE + `getHQNodeData?node=hs_a&num=${PAGE_SIZE}&sort=symbol&asc=1&page=${page}`, pageSignal, false, value => {
            if (!Array.isArray(value)) throw invalid(`新浪股票列表第 ${page} 页格式无效`);
            if (value.length !== Math.min(PAGE_SIZE, total - (page - 1) * PAGE_SIZE)) throw Error(`新浪股票列表第 ${page} 页不完整（返回 ${value.length} 条）`);
            for (const row of value) if (!row || typeof row.symbol !== 'string' || !/^(sh|sz|bj)\d{6}$/.test(row.symbol) || row.code !== row.symbol.slice(2)) throw invalid('新浪股票列表代码格式无效');
          });
          pageSignal.throwIfAborted();
          onProgress({ loading: true, stage: 'universe', completed: ++completed, total: pages });
        } catch (error) { firstError ||= error; controller.abort(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, pages) }, worker));
    if (firstError) throw firstError;
    signal.throwIfAborted();
    return results;
  }
  async loadShared({ signal: parentSignal, onProgress }) {
    const deadline = AbortSignal.timeout(this.deadlineMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
    const startedAt = this.clock();
    try {
      const universe = await this.loadUniverse({ signal, onProgress }), { symbols, excludedCount, sourceCount: total } = universe;
      const rows = [];
      onProgress({ loading: true, stage: 'screen-quotes', completed: 0, total: symbols.length });
      for (let offset = 0; offset < symbols.length; offset += QUOTE_BATCH) {
        const batch = symbols.slice(offset, offset + QUOTE_BATCH);
        const body = await this.request(`https://qt.gtimg.cn/q=${batch.join(',')}`, signal, true);
        signal.throwIfAborted();
        rows.push(...parseTencentScreenQuotes(body, batch, this.clock()));
        onProgress({ loading: true, stage: 'screen-quotes', completed: rows.length, total: symbols.length });
      }
      await this.validateUniverse(universe, { signal });
      signal.throwIfAborted();
      return { rows, source: TENCENT_SCREEN_SOURCE, sourceCount: total, excludedCount, universeSource: universe.source, universeValidatedAt: universe.validatedAt, startedAt, fetchedAt: this.clock() };
    } catch (error) {
      if (parentSignal?.aborted) throw Error('已取消选股，本次结果未应用');
      if (deadline.aborted) throw Error('选股行情获取超时，未使用不完整股票池');
      throw error;
    }
  }
}
module.exports = { FreeScreenerSource };
