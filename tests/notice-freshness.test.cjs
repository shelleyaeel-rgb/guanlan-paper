'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Research } = require('../core/research.cjs');
const { CorporateSource } = require('../core/corporate-source.cjs');
const { NoticeMonitor } = require('../core/notice-monitor.cjs');
const START = Date.parse('2026-10-16T10:00:00+08:00'), symbol = 'sz000001';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('强制公告请求等待旧请求完成后共享新轮次，已开始的新轮次不能被后来force复用', async () => {
  const service = new Research(() => { throw Error('不允许网络'); }, { clock: () => START });
  const requests = [];
  service.fetchSection = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
  const first = service.get({ symbol, section: 'notices', force: true });
  const nextA = service.get({ symbol, section: 'notices', force: true });
  const nextB = service.get({ symbol, section: 'notices', force: true });
  assert.equal(requests.length, 1);
  requests[0].resolve({ items: [], total: 0 }); await first; await tick();
  assert.equal(requests.length, 2);
  const third = service.get({ symbol, section: 'notices', force: true });
  requests[1].resolve({ items: [{ id: 'AN20261016000001', date: '2026-10-16', title: '新增公告' }], total: 1 });
  const [a, b] = await Promise.all([nextA, nextB]); assert.equal(a, b); assert.equal(a.data.total, 1);
  await tick(); assert.equal(requests.length, 3);
  requests[2].reject(Error('最新查新失败'));
  assert.equal((await third).status, 'stale'); assert.equal(service.noticeVersion(symbol).failureGeneration, 1);
  assert.throws(() => service.assertNoticeCurrent(symbol, a), /失效/);
  assert.equal(service.pending.size, 0); assert.equal(service.nextForced.size, 0);
});

test('公告新增、更正、撤回与失败代数使旧快照失效，相同成功目录可安全复用版本但不能续旧快照时间', async () => {
  let now = START, fail = false, data = { items: [], total: 0 };
  const service = new Research(() => { throw Error('不允许网络'); }, { clock: () => now });
  service.fetchSection = async () => { if (fail) throw Error('隔离失败'); return structuredClone(data); };
  const refresh = () => service.get({ symbol, section: 'notices', force: true });
  const first = await refresh(); now += 1000;
  assert.equal((await refresh()).noticeVersion, first.noticeVersion); assert.equal(service.assertNoticeCurrent(symbol, first), true);
  data = { items: [{ id: 'AN20261016000001', date: '2026-10-16', title: '重大诉讼公告' }], total: 1 };
  const added = await refresh(); assert.throws(() => service.assertNoticeCurrent(symbol, first), /失效/);
  data.items[0].title = '重大诉讼更正公告'; const corrected = await refresh();
  assert.throws(() => service.assertNoticeCurrent(symbol, added), /失效/);
  data = { items: [], total: 0 }; const withdrawn = await refresh();
  assert.throws(() => service.assertNoticeCurrent(symbol, corrected), /失效/);
  fail = true; await refresh(); fail = false; const recovered = await refresh();
  assert.throws(() => service.assertNoticeCurrent(symbol, withdrawn), /失效/);
  assert.equal(service.assertNoticeCurrent(symbol, recovered), true);
  now += 300001; await refresh();
  assert.throws(() => service.assertNoticeCurrent(symbol, recovered), /过期/);
});

test('公司行为force在旧请求之后重新查询，同一等待队列不扩散重复请求', async () => {
  const source = new CorporateSource(() => { throw Error('不允许网络'); }, { clock: () => START });
  const reports = [];
  source.report = () => new Promise(resolve => reports.push(resolve)); source.notices = async () => [];
  const input = { symbol, fromDate: '2026-10-01' };
  const first = source.get(input), a = source.get({ ...input, force: true }), b = source.get({ ...input, force: true });
  assert.equal(reports.length, 2);
  reports[0]([]); reports[1]([]); await first; await tick();
  assert.equal(reports.length, 4); reports[2]([]); reports[3]([]);
  const results = await Promise.all([a, b]); assert.equal(results[0], results[1]);
  assert.equal(source.pending.size, 0); assert.equal(source.nextForced.size, 0);
});

test('取消等待强制公司行为查新的调用，不取消其他等待者的下一轮核验', async () => {
  const source = new CorporateSource(() => { throw Error('不允许网络'); }, { clock: () => START });
  const reports = []; source.report = () => new Promise(resolve => reports.push(resolve)); source.notices = async () => [];
  const input = { symbol, fromDate: '2026-10-01' }, controller = new AbortController();
  const first = source.get(input), cancelled = source.get({ ...input, force: true, signal: controller.signal });
  const shared = source.get({ ...input, force: true });
  controller.abort(); await assert.rejects(cancelled, error => error.name === 'AbortError');
  reports[0]([]); reports[1]([]); await first; await tick();
  assert.equal(reports.length, 4); reports[2]([]); reports[3]([]);
  assert.equal((await shared).status, 'ready');
  assert.equal(source.pending.size, 0); assert.equal(source.nextForced.size, 0);
});

test('轻量公告查新优先待买入和持仓，候选公平轮转且并发有界，不触发成交或账户保存', async () => {
  let now = START, active = 0, peak = 0;
  const candidates = ['sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh600005'];
  const engine = { s: { lots: [{ symbol }], agency: { epoch: 'a', groups: [{ mode: 'running', members: candidates.map(symbol => ({ symbol, mode: 'active' })) }] } } };
  const before = structuredClone(engine.s), calls = [];
  const monitor = new NoticeMonitor({ getEngine: () => engine, getPendingSymbols: () => ['sz000002'], clock: () => now, batchSize: 4, maxConcurrency: 2,
    research: { async get(input) { calls.push(input); active++; peak = Math.max(peak, active); await tick(); active--; return { status: 'empty' }; } } });
  const first = monitor.poll(); assert.equal(monitor.poll(), first); await first;
  assert.deepEqual(calls.slice(0, 4).map(input => input.symbol), ['sz000002', symbol, ...candidates.slice(0, 2)]);
  await monitor.poll(); assert.deepEqual(calls.slice(4).map(input => input.symbol), candidates.slice(2));
  assert.equal(peak, 2); assert.ok(calls.every(input => input.section === 'notices' && input.force === true));
  assert.deepEqual(engine.s, before); assert.equal(monitor.publicState().checked, 7);
  now += 30000; await monitor.poll(); assert.deepEqual(calls.slice(7).map(input => input.symbol), ['sz000002', symbol]);
  monitor.stop(); assert.equal((await monitor.poll()).checked, 0);
});

test('大量优先股票不会饿死候选；账户epoch改变或停止时不再派发剩余请求', async () => {
  let release, starts = 0;
  const engine = { s: { lots: Array.from({ length: 5 }, (_, i) => ({ symbol: `sh${600010 + i}` })), agency: { epoch: 'a', groups: [{ mode: 'running', members: [{ symbol, mode: 'active' }] }] } } };
  const monitor = new NoticeMonitor({ getEngine: () => engine, batchSize: 3, maxConcurrency: 1, clock: () => START,
    research: { get: async () => { starts++; await new Promise(resolve => { release = resolve; }); return { status: 'empty' }; } } });
  assert.equal(monitor.selection().at(-1), symbol);
  const pending = monitor.poll(); engine.s.agency.epoch = 'b'; release();
  assert.equal((await pending).checked, 0); assert.equal(starts, 1); assert.equal(monitor.publicState().checked, 0);
});
