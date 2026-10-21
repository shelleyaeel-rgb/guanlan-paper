'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { CompanyDocumentPool } = require('../core/company-document-pool.cjs');
const { CompanyDocumentParser, documentCheckpoint } = require('../core/company-document-parser.cjs');
const MIB = 1024 * 1024;
function fixtureWorker(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-document-pool-')), workerPath = path.join(directory, 'worker.cjs');
  fs.writeFileSync(workerPath, `
    const send = value => process.send(value);
    let parsed = 0, rss = 32 * 1024 * 1024;
    process.on('disconnect', () => process.exit(0));
    process.on('message', message => {
      if (message.type === 'init') {
        if (message.options.fixtureInit === 'hang') return;
        setTimeout(() => send({ type: 'ready', rss: message.options.fixtureReadyRssBytes || 32 * 1024 * 1024 }), message.options.fixtureReadyDelay || 0); return;
      }
      if (message.type !== 'parse') return;
      const { id, options } = message;
      parsed++; send({ type: 'started', id, rss });
      send({ type: 'progress', id, progress: { stage: 'fixture-start', pid: process.pid } });
      if (options.fixturePage) send({ type: 'page', id, ...options.fixturePage });
      if (options.fixtureMode === 'exit') { process.exit(7); return; }
      if (options.fixtureMode === 'memory' || ['memory-on-reuse', 'memory-on-reuse-then-hang'].includes(options.fixtureMode) && parsed > 1) {
        setTimeout(() => send({ type: 'memory', id, rss: 200 * 1024 * 1024 }), options.fixtureMemoryDelay || 0); return;
      }
      if (options.fixtureMode === 'hang' || options.fixtureMode === 'memory-on-reuse-then-hang') { setInterval(() => {}, 1000); return; }
      setTimeout(() => { rss = options.fixtureResultRssBytes || 32 * 1024 * 1024;
        send({ type: 'result', id, result: { complete: true, fixturePid: process.pid, fixtureInput: Buffer.from(message.input).toString(),
          receivedBudgetMs: options.parseTimeoutMs, receivedResume: options.resume, timings: { parseMs: options.fixtureDelay || 10 } }, rss }); }, options.fixtureDelay || 10);
    });
  `);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^company-document-pool-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return workerPath;
}

test('two independent document processes preserve real native evidence and leave the caller responsive', { timeout: 15000 }, async () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'company-native-checkboxes.pdf'));
  const pool = new CompanyDocumentPool(), referenceParser = new CompanyDocumentParser();
  let ticks = 0; const heartbeat = setInterval(() => ticks++, 10);
  try {
    const results = await Promise.all([pool.parse(bytes), pool.parse(bytes)]), reference = await referenceParser.parse(bytes);
    assert.notEqual(results[0].timings.workerPid, results[1].timings.workerPid);
    assert.ok(results.every(result => result.timings.workerPid !== process.pid && result.complete));
    assert.deepEqual(results[0].pageTexts, reference.pageTexts); assert.deepEqual(results[1].pageTexts, reference.pageTexts);
    assert.equal(results[0].sourceHash, createHash('sha256').update(bytes).digest('hex')); assert.ok(ticks >= 2);
  } finally { clearInterval(heartbeat); await pool.destroy(); await referenceParser.destroy(); }
  assert.equal(pool.workers.size, 0); assert.equal(pool.retiring.size, 0);
});

test('pool queues use separate execution budgets, queued cancellation never reaches a worker, and workers are reusable', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, hardTimeoutGraceMs: 200 });
  let started; const began = new Promise(resolve => { started = resolve; }), controller = new AbortController();
  try {
    const first = pool.parse(Buffer.from('first'), { fixtureDelay: 250, onProgress: value => { if (value.stage === 'fixture-start') started(); } });
    await began;
    let cancelledStarted = false;
    const cancelled = pool.parse(Buffer.from('cancelled'), { signal: controller.signal, onProgress: value => { if (value.stage === 'fixture-start') cancelledStarted = true; } });
    const rejection = assert.rejects(cancelled, error => error.name === 'AbortError'); controller.abort(); await rejection;
    const next = pool.parse(Buffer.from('next'), { parseTimeoutMs: 30, fixtureDelay: 10 });
    const a = await first, b = await next;
    assert.equal(cancelledStarted, false); assert.equal(a.fixturePid, b.fixturePid);
    assert.ok(b.timings.queuedMs >= 180); assert.equal(b.timings.parseMs, 10);
  } finally { await pool.destroy(); }
});

test('cancelling active work kills its process and the replacement handles the next document', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1 });
  const controller = new AbortController(); let started, previousPid;
  const began = new Promise(resolve => { started = resolve; });
  try {
    const operation = pool.parse(Buffer.from('cancel'), { fixtureMode: 'hang', signal: controller.signal,
      onProgress: value => { if (value.stage === 'fixture-start') { previousPid = value.pid; started(); } } });
    const rejected = assert.rejects(operation, error => error.name === 'AbortError' && !error.partialResult);
    await began; controller.abort(); await rejected;
    const next = await pool.parse(Buffer.from('next')); assert.equal(next.complete, true); assert.notEqual(next.fixturePid, previousPid);
  } finally { await pool.destroy(); }
});

test('hard timeout retains only reported complete pages, kills a hung process and releases the queue', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, hardTimeoutGraceMs: 30 });
  const text = 'Complete source matched page two.', page = { page: 2, text, method: 'pdf-text', complete: true, numericEligible: true,
    confidence: null, tableLike: false, issues: [], characters: text.length, textHash: createHash('sha256').update(text).digest('hex') };
  try {
    await assert.rejects(pool.parse(Buffer.from('timeout'), { parseTimeoutMs: 50, fixtureMode: 'hang',
      fixturePage: { sourceHash: 'a'.repeat(64), pages: 3, page } }), error => {
      assert.equal(error.code, 'parse-timeout'); assert.equal(error.partialResult.complete, false); assert.equal(error.partialResult.numericEligible, false);
      assert.equal(error.partialResult.checkpointLayout, 'sparse-pages-v1'); assert.deepEqual(error.partialResult.missingPages, [1, 3]);
      assert.deepEqual(error.partialResult.pageTexts, [page]); return true;
    });
    assert.equal((await pool.parse(Buffer.from('next'))).complete, true);
  } finally { await pool.destroy(); }
});

for (const [mode, code] of [['exit', 'parser-worker-exit'], ['memory', 'parser-memory-limit']]) {
  test(`${mode} failure is isolated to its document and a replacement can retry`, async t => {
    const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, maxWorkerRssBytes: 100 * MIB, maxTotalRssBytes: 100 * MIB });
    try {
      await assert.rejects(pool.parse(Buffer.from(mode), { fixtureMode: mode }), error => error.code === code && !error.partialResult);
      assert.equal((await pool.parse(Buffer.from('retry'))).complete, true);
    } finally { await pool.destroy(); }
  });
}

test('large documents have exclusive admission and ordinary documents retain the two-process ceiling', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t) });
  const starts = [];
  const run = (name, large = false) => pool.parse(Buffer.from(name), { fixtureDelay: 50, ...(large ? { maxPages: 1200 } : {}),
    onProgress: value => { if (value.stage === 'parser-queue' && value.status === 'started') {
      const active = [...pool.workers].filter(slot => slot.job); assert.ok(active.length <= 2);
      if (large || active.some(slot => slot.job.large)) assert.equal(active.length, 1);
      starts.push(name);
    } } });
  try {
    await Promise.all([run('first'), run('second'), run('large', true), run('last')]);
    assert.equal(starts.length, 4); assert.ok(starts.indexOf('large') >= 2); assert.equal(starts.at(-1), 'last');
  } finally { await pool.destroy(); }
});

test('a reused worker memory failure gets exactly one fresh retry with retained input and remaining execution budget', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, maxWorkerRssBytes: 100 * MIB, maxTotalRssBytes: 100 * MIB });
  const input = Buffer.from('immutable retry input'); let previousSlot, retryJob, retainedInput, retiring, retired;
  try {
    const warm = await pool.parse(Buffer.from('warm'), { fixtureResultRssBytes: 80 * MIB }); previousSlot = [...pool.workers][0];
    const result = await pool.parse(input, { fixtureMode: 'memory-on-reuse', fixtureMemoryDelay: 60, fixtureDelay: 10, parseTimeoutMs: 300,
      onProgress: value => {
        if (value.stage === 'parser-memory-retry') {
          retryJob = pool.queue[0]; retainedInput = retryJob.input;
          retiring = pool.retiring.size; retired = previousSlot.retired;
        }
      } });
    assert.notEqual(result.fixturePid, warm.fixturePid); assert.equal(result.fixtureInput, input.toString());
    assert.equal(retainedInput, input, 'retain the original reference without copying');
    assert.equal(retiring, 1); assert.equal(retired, true);
    assert.equal(result.timings.memoryRetries, 1); assert.equal(result.timings.previousAttempts.length, 1);
    const first = result.timings.previousAttempts[0];
    assert.equal(first.startRssBytes, 80 * MIB); assert.equal(first.failureRssBytes, 200 * MIB);
    assert.equal(first.workerLimitBytes, 100 * MIB); assert.equal(first.completedDocuments, 1); assert.equal(first.inputBytes, input.length);
    assert.ok(result.receivedBudgetMs <= 240 && result.receivedBudgetMs > 0);
    assert.ok(result.timings.parseMs >= 60); assert.equal(result.timings.workerMemory.completedDocuments, 0);
    assert.equal(result.timings.workerMemory.startRssBytes, 32 * MIB); assert.equal(retryJob.input, null);
    assert.equal(pool.retiring.size, 0); await previousSlot.exited;
  } finally { await pool.destroy(); }
});

test('fresh-process exhaustion remains a hard failure with truthful memory diagnostics and a verified retry checkpoint', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, maxWorkerRssBytes: 100 * MIB, maxTotalRssBytes: 100 * MIB });
  const text = 'A complete source-matched original page before memory exhaustion.';
  const page = { page: 2, text, method: 'pdf-text', complete: true, numericEligible: true, confidence: null, tableLike: false,
    issues: [], characters: text.length, textHash: createHash('sha256').update(text).digest('hex') };
  let retries = 0;
  try {
    await pool.parse(Buffer.from('warm'));
    await assert.rejects(pool.parse(Buffer.from('still too large'), { fixtureMode: 'memory',
      fixturePage: { sourceHash: 'a'.repeat(64), pages: 3, page }, onProgress: value => { if (value.stage === 'parser-memory-retry') retries++; } }), error => {
      assert.equal(error.code, 'parser-memory-limit'); assert.equal(error.timings.memoryRetries, 1); assert.equal(retries, 1);
      assert.equal(error.timings.workerMemory.completedDocuments, 0); assert.equal(error.timings.workerMemory.failureRssBytes, 200 * MIB);
      assert.equal(error.partialResult.checkpoint, 'parse-retry'); assert.equal(error.partialResult.complete, false); assert.equal(error.partialResult.numericEligible, false);
      assert.deepEqual(error.partialResult.pageTexts, [page]); assert.deepEqual(error.partialResult.missingPages, [1, 3]);
      assert.match(error.partialResult.issues[0], /document-memory-limit/); return true;
    });
  } finally { await pool.destroy(); }
});

test('a fresh retry worker exceeding memory before dispatch reports its own PID without inheriting the prior start RSS', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, maxWorkerRssBytes: 100 * MIB, maxTotalRssBytes: 100 * MIB });
  let retryJob, starts = 0;
  try {
    const warm = await pool.parse(Buffer.from('warm'), { fixtureResultRssBytes: 80 * MIB });
    await assert.rejects(pool.parse(Buffer.from('retry fails before start'), { fixtureMode: 'memory-on-reuse', onProgress: value => {
      if (value.stage === 'fixture-start') starts++;
      if (value.stage === 'parser-memory-retry') { retryJob = pool.queue[0]; pool.parserOptions.fixtureReadyRssBytes = 200 * MIB; }
    } }), error => {
      assert.equal(error.code, 'parser-memory-limit'); assert.equal(starts, 1); assert.equal(error.timings.memoryRetries, 1);
      assert.notEqual(error.timings.workerPid, warm.fixturePid); assert.equal(error.timings.workerMemory.workerPid, error.timings.workerPid);
      assert.equal(error.timings.workerMemory.attempt, 2); assert.equal(error.timings.workerMemory.startRssBytes, null);
      assert.equal(error.timings.workerMemory.completedDocuments, 0); assert.equal(error.timings.workerMemory.parseMs, 0);
      assert.equal(error.timings.previousAttempts[0].workerPid, warm.fixturePid); assert.equal(error.timings.previousAttempts[0].startRssBytes, 80 * MIB);
      return true;
    });
    assert.equal(retryJob.input, null);
  } finally { await pool.destroy(); }
});

test('memory recovery retains all verified resume pages even when only the first page message has arrived', async () => {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'];
  for (let i = 0; i < 3; i++) {
    const content = `BT /F1 12 Tf 20 700 Td (Complete original source evidence with usable native text for page ${i + 1}.) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 9 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = Buffer.from(pdf), parser = new CompanyDocumentParser(), pool = new CompanyDocumentPool();
  let received = 0;
  try {
    const reference = await parser.parse(bytes);
    assert.equal(reference.complete, true);
    const retained = [reference.pageTexts[0], reference.pageTexts[2]];
    const resume = documentCheckpoint(reference.sourceHash, 3, retained, 'parse-retry');
    await assert.rejects(pool.parse(bytes, { resume, onPage: () => {
      received++;
      const slot = [...pool.workers].find(value => value.job);
      slot.rss = pool.maxWorkerRssBytes + 1; pool.checkMemory(slot);
    } }), error => {
      assert.equal(error.code, 'parser-memory-limit'); assert.equal(received, 1);
      assert.deepEqual(error.partialResult.pageTexts, retained); assert.deepEqual(error.partialResult.missingPages, [2]);
      assert.equal(error.partialResult.complete, false); return true;
    });
  } finally { await parser.destroy(); await pool.destroy(); }
});

test('cancellation or shutdown during memory recovery never dispatches the fresh retry', async t => {
  for (const close of [false, true]) {
    const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, maxWorkerRssBytes: 100 * MIB, maxTotalRssBytes: 100 * MIB });
    const controller = new AbortController(); let starts = 0, destruction;
    try {
      await pool.parse(Buffer.from('warm'));
      await assert.rejects(pool.parse(Buffer.from('cancel recovery'), { fixtureMode: 'memory-on-reuse', signal: controller.signal,
        onProgress: value => {
          if (value.stage === 'parser-queue' && value.status === 'started') starts++;
          if (value.stage === 'parser-memory-retry') { if (close) destruction = pool.destroy(); else controller.abort(); }
        } }), error => close ? error.code === 'parser-pool-closed' : error.name === 'AbortError' && !error.partialResult);
      await destruction; assert.equal(starts, 1); assert.equal(pool.queueDepth, 0);
    } finally { await pool.destroy(); }
  }
});

test('cancellation and shutdown in either execution attempt release input and never start another retry', async t => {
  for (const close of [false, true]) for (const cancelAt of [1, 2]) {
    const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, maxWorkerRssBytes: 100 * MIB, maxTotalRssBytes: 100 * MIB });
    const controller = new AbortController(); let starts = 0, retries = 0, cancelledJob, destruction;
    try {
      await pool.parse(Buffer.from('warm'));
      await assert.rejects(pool.parse(Buffer.from('cancel running attempt'), { fixtureMode: 'memory-on-reuse', fixtureDelay: 300,
        signal: controller.signal, onProgress: value => {
          if (value.stage === 'parser-memory-retry') retries++;
          if (value.stage === 'fixture-start' && ++starts === cancelAt) {
            cancelledJob = [...pool.workers].find(slot => slot.job).job;
            if (close) destruction = pool.destroy(); else controller.abort();
          }
        } }), error => (close ? error.code === 'parser-pool-closed' : error.name === 'AbortError') && !error.partialResult);
      await destruction;
      assert.equal(starts, cancelAt); assert.equal(retries, cancelAt - 1); assert.equal(cancelledJob.input, null);
      assert.equal(cancelledJob.settled, true); assert.equal(pool.queueDepth, 0);
      if (!close) assert.equal((await pool.parse(Buffer.from('recovered'))).complete, true);
    } finally { await pool.destroy(); }
  }
});

test('large work starts with a fresh process even when a reusable idle worker is available', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1 });
  try {
    const warm = await pool.parse(Buffer.from('warm'));
    const large = await pool.parse(Buffer.from('large'), { maxPages: 1200 });
    assert.notEqual(large.fixturePid, warm.fixturePid); assert.equal(large.timings.workerMemory.completedDocuments, 0);
  } finally { await pool.destroy(); }
});

test('a reused worker that has spent the execution budget cannot obtain another budget through memory recovery', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, maxWorkerRssBytes: 100 * MIB,
    maxTotalRssBytes: 100 * MIB, hardTimeoutGraceMs: 200 });
  let retries = 0;
  try {
    await pool.parse(Buffer.from('warm'));
    await assert.rejects(pool.parse(Buffer.from('spent budget'), { fixtureMode: 'memory-on-reuse', fixtureMemoryDelay: 60, parseTimeoutMs: 30,
      onProgress: value => { if (value.stage === 'parser-memory-retry') retries++; } }), error => {
      assert.equal(error.code, 'parser-memory-limit'); assert.ok(error.timings.parseMs >= 30); assert.equal(retries, 0); return true;
    });
  } finally { await pool.destroy(); }
});

test('the fresh attempt hard timeout uses only the execution budget left after the memory failure', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, maxWorkerRssBytes: 100 * MIB,
    maxTotalRssBytes: 100 * MIB, hardTimeoutGraceMs: 30 });
  let remaining;
  try {
    await pool.parse(Buffer.from('warm'));
    await assert.rejects(pool.parse(Buffer.from('shared budget'), { fixtureMode: 'memory-on-reuse-then-hang', fixtureMemoryDelay: 80,
      parseTimeoutMs: 220, onProgress: value => { if (value.stage === 'parser-memory-retry') remaining = value.remainingParseMs; } }), error => {
      assert.equal(error.code, 'parse-timeout'); assert.equal(error.timings.memoryRetries, 1);
      assert.ok(remaining > 0 && remaining <= 140);
      assert.ok(error.timings.workerMemory.parseMs <= remaining + 100, 'the fresh attempt must not receive another complete budget');
      assert.ok(error.timings.parseMs >= 220 && error.timings.parseMs <= 320);
      assert.equal(error.timings.totalMs, error.timings.parseMs + error.timings.queuedMs); return true;
    });
  } finally { await pool.destroy(); }
});

test('destroy rejects active and queued documents, waits for exit, and forbids new work', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1 });
  let started; const began = new Promise(resolve => { started = resolve; });
  const active = pool.parse(Buffer.from('active'), { fixtureMode: 'hang', onProgress: value => { if (value.stage === 'fixture-start') started(); } });
  const activeRejected = assert.rejects(active, error => error.code === 'parser-pool-closed');
  await began;
  const queued = pool.parse(Buffer.from('queued')), queuedRejected = assert.rejects(queued, error => error.code === 'parser-pool-closed');
  await pool.destroy(); await Promise.all([activeRejected, queuedRejected]);
  assert.equal(pool.workers.size, 0); assert.equal(pool.retiring.size, 0);
  await assert.rejects(pool.parse(Buffer.from('late')), error => error.code === 'parser-pool-closed');
});

test('a missing worker entry does not strand the queue or prevent destroy', { timeout: 5000 }, async () => {
  const pool = new CompanyDocumentPool({ workerPath: path.join(os.tmpdir(), 'missing-company-document-worker.cjs') });
  await assert.rejects(pool.parse(Buffer.from('launch')), error => error.code === 'parser-worker-exit'); await pool.destroy();
  assert.equal(pool.retiring.size, 0);
});

test('a foreign executable cannot create an incompatible V8 IPC channel', () => {
  assert.throws(() => new CompanyDocumentPool({ execPath: require('electron') }), /当前运行时/);
});

test('queue depth includes worker startup and excludes cancelled queued documents', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, fixtureReadyDelay: 100 });
  let began, activeProgress; const started = new Promise(resolve => { began = resolve; });
  const controller = new AbortController();
  try {
    const first = pool.parse(Buffer.from('first'), { fixtureDelay: 50,
      onProgress: value => { if (value.stage === 'parser-queue' && value.status === 'started') { activeProgress = value; began(); } } });
    assert.equal(pool.queued, 1, 'a worker that is still starting has not begun parsing');
    const second = pool.parse(Buffer.from('second'), { signal: controller.signal });
    const rejection = assert.rejects(second, error => error.name === 'AbortError');
    assert.equal(pool.queueDepth, 2); await started;
    assert.equal(activeProgress.queued, 1); assert.equal(activeProgress.queueDepth, 1); assert.equal(activeProgress.activeWorkers, 1);
    controller.abort(); await rejection; assert.equal(pool.queued, 0);
    await first;
  } finally { await pool.destroy(); }
  assert.equal(pool.queueDepth, 0);
});

test('synchronous cancellation from the started progress callback never dispatches or arms a timer', async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1 });
  const controller = new AbortController(); let cancelledJob, dispatched = false;
  try {
    await assert.rejects(pool.parse(Buffer.from('cancel-before-send'), { signal: controller.signal,
      onProgress: value => {
        if (value.stage === 'fixture-start') dispatched = true;
        if (value.stage === 'parser-queue' && value.status === 'started') {
          cancelledJob = [...pool.workers][0].job; controller.abort();
        }
      } }), error => error.name === 'AbortError');
    assert.equal(cancelledJob.settled, true); assert.equal(cancelledJob.timer, undefined); assert.equal(dispatched, false);
    assert.equal((await pool.parse(Buffer.from('recovered'))).complete, true);
  } finally { await pool.destroy(); }
});

test('startup timeout releases the unstarted job and a later worker can recover', { timeout: 5000 }, async t => {
  const pool = new CompanyDocumentPool({ workerPath: fixtureWorker(t), maxWorkers: 1, fixtureInit: 'hang', startupTimeoutMs: 250 });
  try {
    await assert.rejects(pool.parse(Buffer.from('startup-hang')), error => error.code === 'parser-worker-startup-timeout' && error.timings.parseMs === 0);
    delete pool.parserOptions.fixtureInit;
    assert.equal((await pool.parse(Buffer.from('recovered'))).complete, true);
  } finally { await pool.destroy(); }
});

test('document-count recycling and idle recycling both wait for process exit', async t => {
  const workerPath = fixtureWorker(t), pool = new CompanyDocumentPool({ workerPath, maxWorkers: 1, maxWorkerDocuments: 1 });
  try {
    const first = await pool.parse(Buffer.from('first')), second = await pool.parse(Buffer.from('second'));
    assert.notEqual(first.fixturePid, second.fixturePid);
  } finally { await pool.destroy(); }
  const idlePool = new CompanyDocumentPool({ workerPath, maxWorkers: 1, idleTimeoutMs: 20 });
  try {
    const first = await idlePool.parse(Buffer.from('first')), slot = [...idlePool.workers][0];
    await slot.exited;
    const second = await idlePool.parse(Buffer.from('second')); assert.notEqual(first.fixturePid, second.fixturePid);
  } finally { await idlePool.destroy(); }
});
