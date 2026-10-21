'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CompanyEvidenceTransport } = require('../core/company-evidence-transport.cjs');
const URL = 'https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=AN202608250006749206';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const protocolError = () => Error('net::ERR_HTTP2_PROTOCOL_ERROR');

test('证书库临时变化沿用同一安全传输有限重试，实际证书校验失败立即停止', async () => {
  const options = [], events = []; let calls = 0;
  const fetcher = async (url, request) => { options.push(request); if (++calls === 1) throw Error('net::ERR_CERT_DATABASE_CHANGED'); return json({ ready: true }); };
  const service = new CompanyEvidenceTransport(fetcher, { retryBaseMs: 0 });
  assert.deepEqual(await service.json(URL, { onDiagnostic: event => events.push(event) }), { ready: true });
  assert.equal(calls, 2); assert.equal(service.fetcher, fetcher);
  assert.ok(events.some(event => event.code === 'retrying' && event.underlyingCode === 'certificate-store-changed'));
  assert.ok(options.every(request => Object.keys(request).every(key => ['signal','cache','headers'].includes(key))));
  calls = 0; const repeated = new CompanyEvidenceTransport(async () => { calls++; throw Error('net::ERR_CERT_DATABASE_CHANGED'); }, { retryBaseMs: 0 });
  await assert.rejects(repeated.json(URL), error => error.acquisition.code === 'certificate-store-changed' && error.acquisition.attempts === 3);
  assert.equal(calls, 3);
  for (const code of ['ERR_CERT_AUTHORITY_INVALID', 'CERT_HAS_EXPIRED', 'ERR_SSL_PROTOCOL_ERROR']) {
    let invalidCalls = 0;
    const invalid = new CompanyEvidenceTransport(async () => { invalidCalls++; throw Error('fetch failed', { cause: { code } }); }, { retryBaseMs: 0 });
    await assert.rejects(invalid.json(URL), error => error.acquisition.code === 'certificate-invalid' && !error.acquisition.retryable);
    assert.equal(invalidCalls, 1);
  }
});

test('幂等GET协议错误有限重试及指数退避，恢复过程与当前失败分开标记', async () => {
  let calls = 0; const sleeps = [], events = [], requests = [];
  const service = new CompanyEvidenceTransport(async (url, options) => { calls++; requests.push({ url, options }); if (calls < 3) throw protocolError(); return json({ ok: true }); },
    { sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(await service.json(URL, { stage: 'body', documentId: 'AN202608250006749206', onDiagnostic: event => events.push(event) }), { ok: true });
  assert.equal(calls, 3); assert.deepEqual(sleeps, [300, 600]); assert.equal(events.at(-1).code, 'recovered'); assert.equal(events.at(-1).recovered, true);
  assert.equal(events.at(-1).attempts, 3); assert.equal(events.at(-1).transport, 'electron-net');
  assert.ok(requests.every(request => request.url === URL && request.options.signal && request.options.cache === 'no-store'));
});

test('HTTP429立即尊重Retry-After暂停同host，本批不绕过；手动新批只允许一个失败探针', async () => {
  let calls = 0, now = 100000;
  const service = new CompanyEvidenceTransport(async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); }, { clock: () => now, retryBaseMs: 0 });
  await assert.rejects(service.json(URL), error => error.acquisition.code === 'http-429' && error.acquisition.retryAt === 220000 && error.acquisition.attempts === 1);
  service.beginBatch({ retry: false });
  await assert.rejects(service.json(URL), error => error.acquisition.code === 'service-paused' && error.acquisition.attempts === 0);
  assert.equal(calls, 1);
  service.beginBatch({ retry: true });
  await assert.rejects(service.json(URL), error => error.acquisition.code === 'service-paused'); assert.equal(calls, 1, '手动重试也遵守服务器Retry-After');
  now = 220001; service.beginBatch({ retry: true });
  const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () => service.json(URL)));
  assert.equal(calls, 2); assert.ok(outcomes.every(result => result.status === 'rejected'));
  assert.equal(outcomes.filter(result => result.reason.acquisition.code === 'http-429').length, 1);
  assert.equal(outcomes.filter(result => result.reason.acquisition.code === 'service-paused').length, 2);
  now += 120001; service.fetcher = async () => { calls++; return json({ recovered: true }); }; service.beginBatch({ retry: true });
  assert.deepEqual(await service.json(URL), { recovered: true }); assert.deepEqual(await service.json(URL), { recovered: true }); assert.equal(calls, 4);
});

test('三并发连续网络失败后暂停后续公司，错误保留host阶段重试次数且不共用伪成功', async () => {
  let calls = 0;
  const service = new CompanyEvidenceTransport(async () => { calls++; throw protocolError(); }, { retryBaseMs: 0 });
  const failed = await Promise.allSettled(Array.from({ length: 3 }, (_, i) => service.json(URL + '&page=' + i, { stage: 'body' })));
  assert.equal(calls, 3); assert.ok(failed.every(result => result.status === 'rejected'));
  for (let i = 0; i < 20; i++) await assert.rejects(service.json(URL + '&later=' + i), error => error.acquisition.code === 'service-paused' && error.acquisition.host === 'np-cnotice-stock.eastmoney.com');
  assert.equal(calls, 3);
  service.fetcher = async () => { calls++; return json({ ok: true }); }; service.beginBatch({ retry: true });
  assert.deepEqual(await service.json(URL), { ok: true }); assert.equal(calls, 4, '纯本地网络冷却允许手动新批恢复探测');
});

test('单次500可恢复；404和无效JSON不反复请求或熔断其他股票', async () => {
  let calls = 0;
  const service = new CompanyEvidenceTransport(async () => ++calls === 1 ? new Response('', { status: 503 }) : json({ ready: true }), { retryBaseMs: 0 });
  assert.deepEqual(await service.json(URL), { ready: true }); assert.equal(calls, 2);
  service.fetcher = async () => { calls++; return new Response('', { status: 404 }); };
  await assert.rejects(service.json(URL), error => error.acquisition.code === 'http-404' && !error.acquisition.retryable && error.acquisition.attempts === 1);
  service.fetcher = async () => { calls++; return new Response('broken JSON'); };
  await assert.rejects(service.json(URL), error => error.acquisition.code === 'invalid-json' && !error.acquisition.retryable);
  service.fetcher = async () => { calls++; return json({ later: true }); };
  assert.deepEqual(await service.json(URL), { later: true }); assert.equal(calls, 5);
});

test('取消退避及忽略signal的请求立即返回，总期限包含读取正文和退避', async () => {
  const controller = new AbortController(); let calls = 0;
  const service = new CompanyEvidenceTransport(async () => { calls++; throw protocolError(); }, { sleep: async () => { controller.abort(); } });
  await assert.rejects(service.json(URL, { signal: controller.signal }), error => error.name === 'AbortError'); assert.equal(calls, 1);
  const keeper = setInterval(() => {}, 1000);
  try {
    const timeout = new CompanyEvidenceTransport(async () => ({ ok: true, json: () => new Promise(() => {}) }), { timeoutMs: 100, deadlineMs: 15 });
    await assert.rejects(timeout.json(URL), error => error.acquisition.code === 'deadline' && error.acquisition.attempts === 1);
  } finally { clearInterval(keeper); }
});

test('gate微任务期间取消不启动fetch，operation同步取消也不会泄漏未处理拒绝', async () => {
  const controller = new AbortController(); let calls = 0;
  const service = new CompanyEvidenceTransport(async (url, { signal }) => { calls++; throw signal.reason; });
  const pending = service.json(URL, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError'); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
  const second = new AbortController();
  service.fetcher = async () => { second.abort(); throw second.signal.reason; };
  await assert.rejects(service.json(URL, { signal: second.signal }), error => error.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve));
});

test('不接受其他协议域名或错误重定向，不切换直连传输', async () => {
  let calls = 0; const service = new CompanyEvidenceTransport(async () => { calls++; const response = json({}); Object.defineProperty(response, 'url', { value: 'https://example.com/data' }); return response; });
  await assert.rejects(service.json(URL.replace('https:', 'http:')), /域名/);
  await assert.rejects(service.json('https://example.com/data'), /域名/); assert.equal(calls, 0);
  await assert.rejects(service.json(URL), error => error.acquisition.code === 'invalid-response' && !error.acquisition.retryable); assert.equal(calls, 1);
});

test('同批延期等待冷却后才探测恢复，等待预算不足不请求也不提前结束冷却', async () => {
  let now = 100000, calls = 0; const sleeps = [], events = [];
  const service = new CompanyEvidenceTransport(async () => {
    if (++calls === 1) throw protocolError(); return json({ recovered: true });
  }, { clock: () => now, failureThreshold: 1, cooldownMs: 30000, retryBaseMs: 0,
    sleep: async ms => { sleeps.push(ms); now += ms; } });
  const failure = await service.json(URL).catch(error => error.acquisition);
  assert.equal(failure.code, 'http2-protocol'); assert.equal(failure.retryAt, 130000);
  assert.equal(await service.waitForRecovery(failure, { maxWaitMs: 29999 }), false);
  assert.equal(calls, 1); assert.deepEqual(sleeps, []);
  assert.equal(await service.waitForRecovery(failure, { maxWaitMs: 30000 }), true);
  assert.deepEqual(sleeps, [30000]); assert.equal(calls, 1, '等待本身不额外发起网络请求');
  assert.deepEqual(await service.json(URL, { onDiagnostic: event => events.push(event) }), { recovered: true });
  assert.equal(calls, 2); assert.equal(service.generation, 0, '自动恢复不伪造手动新批次');
  assert.equal(events.at(-1).code, 'recovered'); assert.equal(service.state('np-cnotice-stock.eastmoney.com').until, 0);
});

test('延期恢复遵守当前host的Retry-After，过期诊断和手动标志都不能提前探测', async () => {
  let now = 100000, calls = 0; const sleeps = [];
  const service = new CompanyEvidenceTransport(async () => {
    calls++; return new Response('', { status: 429, headers: { 'retry-after': '120' } });
  }, { clock: () => now, sleep: async ms => { sleeps.push(ms); now += ms; } });
  const failure = await service.json(URL).catch(error => error.acquisition);
  service.beginBatch({ retry: true });
  assert.equal(await service.waitForRecovery({ ...failure, retryAt: now + 1000 }, { maxWaitMs: 65000 }), false);
  assert.equal(calls, 1); assert.deepEqual(sleeps, []);
  await assert.rejects(service.json(URL), error => error.acquisition.code === 'service-paused' && error.acquisition.attempts === 0);
  assert.equal(calls, 1);
  assert.equal(await service.waitForRecovery(failure, { maxWaitMs: 120000 }), true);
  assert.deepEqual(sleeps, [120000]); assert.equal(now, 220000);
  service.fetcher = async () => { calls++; return json({ ready: true }); };
  assert.deepEqual(await service.json(URL), { ready: true }); assert.equal(calls, 2);
});

test('取消延期等待立即退出，忽略signal的sleep不能继续触发恢复请求', async () => {
  let now = 100000, calls = 0, started;
  const began = new Promise(resolve => { started = resolve; }), controller = new AbortController();
  const service = new CompanyEvidenceTransport(async () => { calls++; throw protocolError(); }, {
    clock: () => now, failureThreshold: 1, sleep: () => { started(); return new Promise(() => {}); }
  });
  const failure = await service.json(URL).catch(error => error.acquisition);
  const pending = service.waitForRecovery(failure, { maxWaitMs: 65000, signal: controller.signal });
  await began; controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(calls, 1);
  assert.equal(service.state('np-cnotice-stock.eastmoney.com').until, now + 30000);
});

function movingCooldown(t, sleep) {
  let now = 100000, monotonic = 0, calls = 0;
  t.mock.method(require('node:perf_hooks').performance, 'now', () => monotonic);
  const service = new CompanyEvidenceTransport(async () => { calls++; throw protocolError(); }, {
    clock: () => now, failureThreshold: 1,
    sleep: async ms => sleep(ms, { advance: value => { now += value; monotonic += value; },
      jumpWall: value => { now += value; }, state: service.state('np-cnotice-stock.eastmoney.com'), now: () => now })
  });
  const state = service.state('np-cnotice-stock.eastmoney.com');
  Object.assign(state, { failures: 3, until: now + 30000, lastCode: 'http2-protocol' });
  return { service, state, calls: () => calls, now: () => now, elapsed: () => monotonic,
    issue: { host: 'np-cnotice-stock.eastmoney.com', retryable: true, retryAt: now + 30000, code: 'service-paused' } };
}

test('并发公司延长host冷却后仍使用原有等待预算，不增加请求次数或重置截止时间', async t => {
  const sleeps = [];
  const f = movingCooldown(t, async (ms, clock) => {
    sleeps.push(ms); clock.advance(ms);
    if (sleeps.length === 1) clock.state.until = clock.now() + 30000;
  });
  assert.equal(await f.service.waitForRecovery(f.issue, { maxWaitMs: 65000 }), true);
  assert.deepEqual(sleeps, [30000, 30000]); assert.equal(f.elapsed(), 60000); assert.equal(f.calls(), 0);
  assert.equal(f.service.maxAttempts, 3); assert.equal(f.service.generation, 0);
});

test('持续移动的冷却只能消耗原预算，下一次等待放不下就结束且不发请求', async t => {
  const sleeps = [];
  const f = movingCooldown(t, async (ms, clock) => {
    sleeps.push(ms); clock.advance(ms); clock.state.until = clock.now() + 30000;
  });
  assert.equal(await f.service.waitForRecovery(f.issue, { maxWaitMs: 65000 }), false);
  assert.deepEqual(sleeps, [30000, 30000]); assert.equal(f.elapsed(), 60000); assert.equal(f.calls(), 0);
  assert.equal(f.state.until - f.now(), 30000, '不为符合预算而缩短当前冷却');
});

test('延长后的Retry-After超出剩余预算时不等待、不绕过服务器要求', async t => {
  const sleeps = [];
  const f = movingCooldown(t, async (ms, clock) => {
    sleeps.push(ms); clock.advance(ms); clock.state.retryAfterUntil = clock.now() + 120000;
    clock.state.until = clock.state.retryAfterUntil;
  });
  f.service.beginBatch({ retry: true });
  assert.equal(await f.service.waitForRecovery(f.issue, { maxWaitMs: 65000 }), false);
  assert.deepEqual(sleeps, [30000]); assert.equal(f.elapsed(), 30000); assert.equal(f.calls(), 0);
  await assert.rejects(f.service.json(URL), error => error.acquisition.code === 'service-paused');
  assert.equal(f.calls(), 0);
});

test('墙上时钟回拨不补充延期等待的单调时间预算', async t => {
  const sleeps = [];
  const f = movingCooldown(t, async (ms, clock) => {
    sleeps.push(ms); clock.advance(ms);
    if (sleeps.length === 1) clock.jumpWall(-30000);
    else clock.state.until = clock.now() + 10000;
  });
  assert.equal(await f.service.waitForRecovery(f.issue, { maxWaitMs: 65000 }), false);
  assert.deepEqual(sleeps, [30000, 30000]); assert.equal(f.elapsed(), 60000); assert.equal(f.calls(), 0);
});

test('取消移动冷却后的第二次等待立即结束，忽略signal的sleep也不继续循环', async t => {
  const sleeps = [], controller = new AbortController(); let entered;
  const secondSleep = new Promise(resolve => { entered = resolve; });
  const f = movingCooldown(t, async (ms, clock) => {
    sleeps.push(ms);
    if (sleeps.length === 1) { clock.advance(ms); clock.state.until = clock.now() + 30000; return; }
    entered(); return new Promise(() => {});
  });
  const pending = f.service.waitForRecovery(f.issue, { maxWaitMs: 65000, signal: controller.signal });
  await secondSleep; controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.deepEqual(sleeps, [30000, 30000]); assert.equal(f.calls(), 0); assert.equal(f.elapsed(), 30000);
});

test('多个延期等待同时恢复后仍只有一个host探针，探针失败不会让等待者重复请求', async t => {
  let now = 100000, monotonic = 0, calls = 0, releaseSleep, startedProbe, rejectProbe;
  t.mock.method(require('node:perf_hooks').performance, 'now', () => monotonic);
  const sleep = new Promise(resolve => { releaseSleep = resolve; });
  const started = new Promise(resolve => { startedProbe = resolve; });
  const service = new CompanyEvidenceTransport(async () => { calls++; startedProbe(); return new Promise((_, reject) => { rejectProbe = reject; }); },
    { clock: () => now, sleep: () => sleep, failureThreshold: 1 });
  const state = service.state('np-cnotice-stock.eastmoney.com');
  Object.assign(state, { failures: 3, until: now + 30000, lastCode: 'http2-protocol' });
  const issue = { host: 'np-cnotice-stock.eastmoney.com', retryable: true, retryAt: state.until };
  const waits = Promise.all([service.waitForRecovery(issue, { maxWaitMs: 65000 }), service.waitForRecovery(issue, { maxWaitMs: 65000 })]);
  now += 30000; monotonic += 30000; releaseSleep(); assert.deepEqual(await waits, [true, true]);
  const probes = Promise.allSettled([service.json(URL + '&company=1'), service.json(URL + '&company=2')]);
  await started; assert.equal(calls, 1); rejectProbe(protocolError());
  const outcomes = await probes;
  assert.equal(calls, 1); assert.deepEqual(outcomes.map(item => item.status), ['rejected', 'rejected']);
  assert.deepEqual(outcomes.map(item => item.reason.acquisition.code).sort(), ['http2-protocol', 'service-paused']);
  assert.equal(state.until, now + 30000);
});
