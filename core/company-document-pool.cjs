'use strict';
const path = require('node:path');
const { fork } = require('node:child_process');
const { documentCheckpoint } = require('./company-document-parser.cjs');
const MIB = 1024 * 1024;
function positive(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw Error(`${name}必须是正整数`);
  return result;
}
function aborted() { return Object.assign(Error('文档解析已取消'), { name: 'AbortError' }); }
function closed() { return Object.assign(Error('文档解析池已关闭'), { code: 'parser-pool-closed' }); }
function failure(message, code) { return Object.assign(Error(message), { code }); }

class CompanyDocumentPool {
  constructor(options = {}) {
    const { maxWorkers, maxWorkerRssBytes, maxTotalRssBytes, workerHeapMb, largeDocumentBytes,
      maxWorkerDocuments, idleTimeoutMs, startupTimeoutMs, hardTimeoutGraceMs, terminationTimeoutMs, workerPath, execPath, ...parserOptions } = options;
    this.maxWorkers = positive(maxWorkers, 2, '解析进程数');
    if (this.maxWorkers > 2) throw Error('解析进程数不得超过 2');
    this.maxWorkerRssBytes = positive(maxWorkerRssBytes, 768 * MIB, '解析进程内存预算');
    this.maxTotalRssBytes = positive(maxTotalRssBytes, 1536 * MIB, '解析池总内存预算');
    this.workerHeapMb = positive(workerHeapMb, 384, '解析进程堆上限');
    this.largeDocumentBytes = positive(largeDocumentBytes, 32 * MIB, '大文档字节阈值');
    this.maxWorkerDocuments = positive(maxWorkerDocuments, 25, '进程回收文档数');
    this.idleTimeoutMs = positive(idleTimeoutMs, 15000, '解析进程空闲回收时间');
    this.startupTimeoutMs = positive(startupTimeoutMs, 20000, '解析进程启动超时');
    this.hardTimeoutGraceMs = positive(hardTimeoutGraceMs, 3000, '解析进程超时回收宽限');
    this.terminationTimeoutMs = positive(terminationTimeoutMs, 3000, '解析进程退出宽限');
    if (this.maxTotalRssBytes < this.maxWorkerRssBytes) throw Error('解析池总内存预算不能小于单进程预算');
    // Functions cannot safely cross IPC; tests/custom providers should inject
    // their own parser into CompanyEvidenceSource instead of this pool.
    if (parserOptions.recognize) throw Error('独立解析进程不接受函数识别器');
    this.parserOptions = structuredClone(parserOptions);
    this.workerPath = workerPath || path.join(__dirname, 'company-document-worker.cjs');
    // Advanced IPC uses the current V8 serialization version. A different
    // Node/Electron executable can crash the receiving IPC channel before it
    // reaches an error handler, so never launch a different runtime here.
    if (execPath && path.resolve(execPath) !== path.resolve(process.execPath)) throw Error('解析进程必须使用当前运行时');
    this.execPath = process.execPath;
    this.queue = []; this.workers = new Set(); this.retiring = new Set(); this.sequence = 0; this.closed = false;
  }
  get queued() {
    return this.queue.filter(job => !job.settled).length
      + [...this.workers].filter(slot => slot.job && !slot.job.settled && slot.job.startedAt === null).length;
  }
  get queueDepth() { return this.queued; }
  progress(job, value) {
    const queued = this.queued, activeWorkers = [...this.workers].filter(slot => slot.job?.startedAt !== null && slot.job && !slot.job.settled).length;
    try { job.onProgress?.({ ...value, queued, queueDepth: queued, activeWorkers }); } catch {}
  }
  parse(input, { signal, onProgress, onPage, parseTimeoutMs = 120000, ...options } = {}) {
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.closed) return Promise.reject(closed());
    try { parseTimeoutMs = positive(parseTimeoutMs, 120000, '文档解析执行超时'); }
    catch (error) { return Promise.reject(error); }
    const bytes = input?.byteLength ?? input?.bytes ?? 0;
    const large = bytes >= this.largeDocumentBytes || (options.maxPages || 0) > 600 || !!input?.filePath;
    return new Promise((resolve, reject) => {
      const job = { id: ++this.sequence, input, options: { ...options, parseTimeoutMs }, signal, onProgress, onPage, resolve, reject,
        large, inputBytes: bytes, queuedAt: performance.now(), startedAt: null, slot: null, settled: false, pages: new Map(),
        queuedMs: 0, previousParseMs: 0, memoryRetries: 0, attempts: [] };
      job.waitStartedAt = job.queuedAt;
      job.abort = () => {
        const slot = job.slot;
        this.finish(job, aborted());
        if (slot) this.retire(slot); else this.drain();
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job); this.progress(job, { stage: 'parser-queue', status: 'waiting', queuedMs: 0 }); this.drain();
    });
  }
  finish(job, error, result) {
    if (job.settled) return;
    job.settled = true; job.signal?.removeEventListener('abort', job.abort); clearTimeout(job.timer);
    const slot = job.slot;
    if (slot?.job === job) slot.job = null;
    this.queue = this.queue.filter(value => value !== job);
    const queuedMs = Math.round(job.queuedMs + (job.startedAt === null ? performance.now() - job.waitStartedAt : 0));
    const timings = { ...(result?.timings || error?.timings || {}), queuedMs };
    const attemptParseMs = Number.isFinite(timings.parseMs) ? timings.parseMs : job.startedAt !== null ? performance.now() - job.startedAt : 0;
    timings.parseMs = Math.round(job.previousParseMs + attemptParseMs);
    if (job.attempt || error?.workerMemory) timings.workerMemory = { ...job.attempt, ...(error?.workerMemory || {}), parseMs: Math.round(attemptParseMs) };
    if (job.attempts.length) { timings.memoryRetries = job.memoryRetries; timings.previousAttempts = job.attempts; }
    timings.totalMs = timings.parseMs + timings.queuedMs;
    if (slot) timings.workerPid = slot.child.pid;
    job.input = null;
    if (error) { error.timings = timings; if (error.partialResult) error.partialResult.timings = timings; job.reject(error); }
    else job.resolve({ ...result, timings });
  }
  timeout(job) {
    if (job.settled) return;
    const error = failure('原始附件解析执行超时，已回收无响应解析进程', 'parse-timeout');
    if (job.sourceHash && job.pageCount) {
      error.partialResult = documentCheckpoint(job.sourceHash, job.pageCount, [...job.pages.values()]);
      if (!error.partialResult) delete error.partialResult;
    }
    const slot = job.slot; this.finish(job, error); this.retire(slot);
  }
  createWorker() {
    const child = fork(this.workerPath, [], { execPath: this.execPath, execArgv: [`--max-old-space-size=${this.workerHeapMb}`],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const slot = { child, ready: false, job: null, rss: 0, documents: 0, retired: false, stderr: '' };
    this.workers.add(slot);
    slot.exited = new Promise(resolve => { slot.onExit = () => { clearTimeout(slot.terminationTimer); resolve(); }; });
    slot.startupTimer = setTimeout(() => this.failWorker(slot, failure('文档解析进程启动超时', 'parser-worker-startup-timeout')), this.startupTimeoutMs);
    child.stderr.on('data', chunk => { slot.stderr = (slot.stderr + chunk.toString()).slice(-2000); });
    child.on('error', error => this.failWorker(slot, error));
    child.once('close', () => slot.onExit());
    child.on('exit', (code, signal) => {
      slot.onExit();
      if (!slot.retired) this.failWorker(slot, failure(`文档解析进程意外退出（${signal || code}）${slot.stderr ? '：' + slot.stderr.trim() : ''}`, 'parser-worker-exit'));
    });
    child.on('message', message => this.message(slot, message));
    this.send(slot, { type: 'init', options: this.parserOptions });
    return slot;
  }
  send(slot, message) {
    try { slot.child.send(message, error => { if (error) this.failWorker(slot, error); }); }
    catch (error) { this.failWorker(slot, error); }
  }
  message(slot, message) {
    if (slot.retired || !message) return;
    if (Number.isFinite(message.rss) && message.rss > 0) slot.rss = message.rss;
    if (message.type === 'started' && slot.job?.id === message.id && slot.job.attempt) slot.job.attempt.startRssBytes = slot.rss;
    if (!this.checkMemory(slot)) return;
    if (message.type === 'fatal') { this.failWorker(slot, Object.assign(Error(message.error?.message || '解析进程初始化失败'), { code: 'parser-worker-init' })); return; }
    if (message.type === 'ready') {
      clearTimeout(slot.startupTimer); slot.ready = true;
      if (slot.job) this.start(slot); else this.drain();
      return;
    }
    const job = slot.job;
    if (!job || job.id !== message.id) return;
    if (message.type === 'progress') {
      // Pool admission/worker startup is the queue; the worker-local queue is
      // always empty and must not overwrite its externally observed wait.
      if (message.progress?.stage !== 'parser-queue') this.progress(job, message.progress);
    } else if (message.type === 'page') {
      if (message.page?.complete) {
        // The parser validates the entire checkpoint before emitting its first
        // complete page. Preserve every verified resume row even if memory
        // recovery interrupts the individual page messages in transit.
        if (!job.resumePagesMerged) {
          const resume = job.options.resume;
          if (resume?.sourceHash === message.sourceHash && resume.pages === message.pages && Array.isArray(resume.pageTexts)) {
            for (const page of resume.pageTexts) if (page.complete) job.pages.set(page.page, page);
          }
          job.resumePagesMerged = true;
        }
        job.pages.set(message.page.page, message.page); job.sourceHash = message.sourceHash; job.pageCount = message.pages;
        try { job.onPage?.({ sourceHash: message.sourceHash, pages: message.pages, page: message.page }); } catch {}
      }
    } else if (message.type === 'result' || message.type === 'error') {
      const error = message.type === 'error' ? Object.assign(Error(message.error?.message || '原始附件解析失败'), message.error) : null;
      this.finish(job, error, message.result); slot.documents++;
      if (slot.documents >= this.maxWorkerDocuments || job.large || error?.code === 'parse-timeout') this.retire(slot);
      else {
        slot.idleTimer = setTimeout(() => this.retire(slot), this.idleTimeoutMs); slot.idleTimer.unref?.(); this.drain();
      }
    }
  }
  checkMemory(slot) {
    const total = [...this.workers].reduce((sum, worker) => sum + worker.rss, 0);
    if (slot.rss <= this.maxWorkerRssBytes && total <= this.maxTotalRssBytes) return true;
    const job = slot.job, error = failure('文档解析进程超过内存预算，已回收；资料仍待核验', 'parser-memory-limit');
    error.workerMemory = { ...(job?.attempt || {}), workerPid: slot.child.pid, attempt: (job?.memoryRetries || 0) + 1,
      startRssBytes: job?.startedAt != null ? job.attempt?.startRssBytes ?? null : null, failureRssBytes: slot.rss, totalRssBytes: total,
      workerLimitBytes: this.maxWorkerRssBytes, totalLimitBytes: this.maxTotalRssBytes, completedDocuments: slot.documents, inputBytes: job?.inputBytes || 0 };
    if (job?.sourceHash && job.pageCount) {
      error.partialResult = documentCheckpoint(job.sourceHash, job.pageCount, [...job.pages.values()], 'parse-retry');
      if (error.partialResult) error.partialResult.issues[0] = 'document-memory-limit: 内存预算回收，仅保留已完整核验页；其余页面及全文仍待核验';
      else delete error.partialResult;
    }
    const elapsed = job?.startedAt !== null && job?.startedAt !== undefined ? performance.now() - job.startedAt : 0;
    const remaining = job ? Math.floor(job.options.parseTimeoutMs - job.previousParseMs - elapsed) : 0;
    // The same RSS limit can be reached by retained allocations from earlier
    // documents. Retry that document once in a new process, within its original
    // execution budget. Fresh-process exhaustion remains a real hard failure.
    if (job && !this.closed && !job.signal?.aborted && !job.settled && job.attempt?.completedDocuments > 0
      && job.memoryRetries === 0 && job.input && remaining > 0) {
      clearTimeout(job.timer); job.previousParseMs += elapsed;
      job.attempts.push({ ...error.workerMemory, code: error.code, parseMs: Math.round(elapsed) });
      job.memoryRetries++; job.forceFresh = true; job.startedAt = null; job.waitStartedAt = performance.now();
      if (error.partialResult) job.options.resume = error.partialResult;
      slot.job = null; job.slot = null; this.queue.unshift(job); this.retire(slot);
      this.progress(job, { stage: 'parser-memory-retry', attempt: 2, remainingParseMs: remaining, workerMemory: error.workerMemory });
      return false;
    }
    this.failWorker(slot, error); return false;
  }
  failWorker(slot, error) {
    if (slot.retired) return;
    if (slot.job) this.finish(slot.job, error);
    this.retire(slot);
  }
  retire(slot) {
    if (!slot || slot.retired) return;
    slot.retired = true; clearTimeout(slot.startupTimer); clearTimeout(slot.idleTimer);
    this.workers.delete(slot);
    if (slot.job) this.finish(slot.job, closed());
    const disposal = slot.exited.finally(() => { this.retiring.delete(disposal); this.drain(); });
    this.retiring.add(disposal);
    // A parser blocked in native code must not keep shutdown/admission waiting
    // forever on platforms where SIGTERM can be intercepted.
    slot.terminationTimer = setTimeout(() => { try { slot.child.kill('SIGKILL'); } catch {} }, this.terminationTimeoutMs);
    slot.terminationTimer.unref?.();
    try { slot.child.kill(); } catch {}
  }
  start(slot) {
    const job = slot.job;
    if (!job || job.settled || slot.retired) return;
    job.startedAt = performance.now(); job.queuedMs += job.startedAt - job.waitStartedAt;
    job.resumePagesMerged = false;
    job.attempt = { workerPid: slot.child.pid, attempt: job.memoryRetries + 1, startRssBytes: slot.rss,
      completedDocuments: slot.documents, inputBytes: job.inputBytes, workerLimitBytes: this.maxWorkerRssBytes, totalLimitBytes: this.maxTotalRssBytes };
    const remaining = Math.max(1, Math.floor(job.options.parseTimeoutMs - job.previousParseMs));
    this.progress(job, { stage: 'parser-queue', status: 'started', queuedMs: Math.round(job.queuedMs), workerPid: slot.child.pid });
    // Progress callbacks may cancel synchronously. Never dispatch or arm a new
    // execution timer after cancellation has already settled this document.
    if (job.settled || slot.retired) return;
    job.timer = setTimeout(() => this.timeout(job), remaining + this.hardTimeoutGraceMs);
    this.send(slot, { type: 'parse', id: job.id, input: job.input, options: { ...job.options, parseTimeoutMs: remaining } });
    // Keep the existing reference only when this attempt may need one fresh
    // retry. Never clone the document to retain it, and release it on settle.
    if (!slot.documents || job.memoryRetries) job.input = null;
  }
  drain() {
    if (this.closed || this.retiring.size) return;
    while (this.queue.length) {
      const job = this.queue[0];
      if (job.settled) { this.queue.shift(); continue; }
      const active = [...this.workers].filter(slot => slot.job);
      if (active.some(slot => slot.job.large) || job.large && active.length) return;
      if (job.large || job.forceFresh) {
        const idle = [...this.workers].filter(slot => !slot.job);
        const fresh = idle.filter(slot => slot.documents === 0);
        for (const slot of idle.filter(slot => slot.documents > 0)) this.retire(slot);
        if (job.large) for (const slot of fresh.slice(1)) this.retire(slot);
        if (this.retiring.size) return;
      }
      let slot = [...this.workers].find(worker => !worker.job);
      if (!slot) {
        if (this.workers.size >= this.maxWorkers || (this.workers.size + 1) * this.maxWorkerRssBytes > this.maxTotalRssBytes) return;
        try { slot = this.createWorker(); }
        catch (error) { this.finish(job, error); continue; }
      }
      if (slot.retired) { this.finish(job, failure('文档解析进程未能启动', 'parser-worker-startup')); continue; }
      this.queue.shift(); clearTimeout(slot.idleTimer); slot.job = job; job.slot = slot;
      if (slot.ready) this.start(slot);
    }
  }
  async destroy() {
    this.closed = true;
    for (const job of [...this.queue]) this.finish(job, closed());
    for (const slot of [...this.workers]) this.retire(slot);
    await Promise.allSettled([...this.retiring]);
  }
}

module.exports = { CompanyDocumentPool };
