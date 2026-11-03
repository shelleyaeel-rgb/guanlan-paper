'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { Screener } = require('../core/screener.cjs');
const { AgencyPoolService } = require('../core/agency-pool.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');

const NOW = new Date('2026-10-13T10:00:00+08:00');
function bars(end = '2026-10-12') {
  const dates = []; let day = Date.parse(`${end}T10:00:00+08:00`);
  while (dates.length < 120) { const session = calendarSession(new Date(day)); if (session.open) dates.unshift(session.date); day -= 86400000; }
  const level = index => index * 0.008 + Math.sin(index / 4 + 1.6) * 0.12 + (index % 2 === 0 ? 0.02 : -0.02);
  return dates.map((date, index) => {
    const close = 10.94 + level(index) - level(119);
    return { date, open: close, close, high: close + 0.1, low: close - 0.1, volume: index === 119 ? 150 : 100 };
  });
}
function report(overrides = {}) {
  return { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', currency: 'CNY', roe: 9, debtRatio: 40, adjustedProfit: 1e8,
    revenueYoY: 10, adjustedProfitYoY: 10, operatingCash: 2e8, ...overrides }, annual: [2025, 2024, 2023].map(year => ({ reportDate: `${year}-12-31`,
      noticeDate: `${year + 1}-03-30`, currency: 'CNY', roe: 12, adjustedProfit: 2e8, operatingCash: 3e8 })) };
}
function fixture(t, symbols) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-pool-integration-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('guanlan-pool-integration-')); fs.rmSync(directory, { recursive: true, force: true }); });
  let engine = new Engine(initialState(100000), () => NOW), transactions = 0;
  const store = new Store(directory), missingEvidence = new Set(), financial = new Map(), daily = new Map(), calls = { quotes: 0, evidence: 0, finance: [], daily: [], notices: [] };
  const quoteRows = symbols.map(symbol => ({ symbol, name: `隔离 ${symbol}`, board: 'sh', isST: false, timestamp: NOW.getTime(),
    price: 11.05, prevClose: 10.94, changePct: 1, amount: 3, turnover: 3, pe: 20, pb: 2 }));
  let snapshotFailure = '', financeHook = null;
  const scanner = new Screener(null, null, async symbol => { calls.daily.push(symbol); return { bars: bars(daily.get(symbol)), source: '隔离完整未复权日线' }; }, () => NOW,
    async (symbol, signal, force) => {
      calls.finance.push({ symbol, force }); if (financeHook) return financeHook(symbol, signal);
      return { symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: NOW.getTime(), industryProfile: ordinaryProfile(symbol, NOW), data: report(financial.get(symbol)) };
    }, async symbol => { calls.notices.push(symbol); return { symbol, section: 'notices', status: 'empty', source: '东方财富', fetchedAt: NOW.getTime(), data: { items: [], total: 0 } }; },
    async () => { throw Error('候选刷新不可冒用盘中执行接口'); },
    async () => { calls.quotes++; if (snapshotFailure) throw Error(snapshotFailure); return { rows: structuredClone(quoteRows), source: '隔离完整行情源', fetchedAt: NOW.getTime(), sourceCount: quoteRows.length, excludedCount: 0 }; },
    null, async symbol => { calls.evidence++; return missingEvidence.has(symbol) ? { symbol, checkedAt: NOW.getTime(), status: 'unavailable', documents: [], errors: ['资料不足'] } : companyBundle(symbol, NOW); });
  const transaction = fn => { const before = structuredClone(engine.s); transactions++; try { const result = fn(); store.save(engine.s); return result; } catch (error) { engine.s = before; throw error; } };
  const service = new AgencyPoolService({ getEngine: () => engine, transaction, screener: scanner, clock: () => NOW.getTime() });
  const member = symbol => engine.s.agency.groups.flatMap(group => group.members).find(item => item.symbol === symbol);
  const owner = symbol => engine.s.agency.groups.find(group => group.members.some(item => item.symbol === symbol))?.id;
  return { get engine() { return engine; }, service, scanner, store, calls, missingEvidence, financial, daily, member, owner,
    get transactions() { return transactions; }, add: symbol => engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' }),
    failSnapshots: value => { snapshotFailure = value; }, financeHook: hook => { financeHook = hook; }, restart: () => { engine = new Engine(store.load(), () => NOW); } };
}

test('纯技术候选入池贯通：财务公告与研究不可用不影响，日线缺失仍待核验', async t => {
  const f = fixture(t, ['sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh600005']);
  f.add('sh600002'); f.add('sh600003'); f.financial.set('sh600002', { debtRatio: 80 });
  f.financial.set('sh600003', { debtRatio: null }); f.missingEvidence.add('sh600004'); f.daily.set('sh600005', '2026-10-09');
  const result = await f.service.run({ screeningMode: 'strict' });
  assert.equal(f.calls.quotes, 1); assert.equal(f.calls.evidence, 0); assert.equal(f.calls.finance.length + f.calls.notices.length, 0);
  assert.equal(f.calls.daily.length, 5); assert.equal(result.coverage.universeComplete, true);
  assert.equal(f.owner('sh600001'), 'ultra-short'); assert.equal(f.owner('sh600002'), 'swing');
  assert.equal(f.member('sh600002').mode, 'active'); assert.equal(f.member('sh600003').mode, 'active');
  assert.deepEqual(result.unassignedPending.map(item => item.symbol), ['sh600005']);
  assert.match(result.unassignedPending[0].reasons.join(''), /日线/); assert.equal(f.member('sh600001').entryConditions, undefined);
  assert.equal(f.transactions, 1); assert.equal(f.engine.s.trades.length + f.engine.s.orders.length, 0); assert.equal(validState(f.engine.s), true);
  f.restart(); assert.equal(f.service.publicState().lastResult.id, result.id); assert.equal(f.member('sh600003').poolCheck.status, 'pass');
});
test('日线重试从待核验转为通过并保留归属，缓存复用不启动研究请求', async t => {
  const f = fixture(t, ['sh600001']); f.add('sh600001'); f.daily.set('sh600001', '2026-10-09');
  const missing = await f.service.run({ screeningMode: 'strict' }); assert.equal(missing.counts.standby, 1);
  assert.equal(f.member('sh600001').poolCheck.status, 'pending'); f.daily.clear();
  const retry = await f.service.run({ retryEvidence: true });
  assert.equal(retry.counts.retained, 1); assert.equal(f.member('sh600001').mode, 'active'); assert.equal(f.owner('sh600001'), 'swing');
  assert.equal(f.calls.finance.length + f.calls.notices.length + f.calls.evidence, 0);
  const cached = await f.service.run(); assert.equal(cached.coverage.cache.daily.hits, 1);
  assert.equal(f.calls.daily.length, 2); f.restart(); assert.equal(f.member('sh600001').poolCheck.status, 'pass');
});
test('真实扫描读取失败和取消均保留上次成功成员及磁盘结果，取消后可以重新点击并重启恢复', async t => {
  const f = fixture(t, ['sh600001']); const original = await f.service.run();
  const saved = structuredClone(f.engine.s), file = fs.readFileSync(f.store.file, 'utf8');
  f.failSnapshots('隔离行情源离线'); await assert.rejects(f.service.run(), /行情源离线/);
  assert.deepEqual(f.engine.s, saved); assert.equal(fs.readFileSync(f.store.file, 'utf8'), file); assert.equal(f.service.publicState().lastResult.id, original.id);
  f.failSnapshots(''); let began; const started = new Promise(resolve => { began = resolve; });
  const originalDailyLoader = f.scanner.dailyLoader; f.scanner.dailyLoader = () => { began(); return new Promise(() => {}); };
  const running = f.service.run({ refreshQuantitative: true }); await started; assert.equal(f.service.publicState().running, true); f.service.cancel(); await assert.rejects(running, /取消/);
  assert.equal(f.scanner.activeRun, null); assert.equal(f.service.publicState().running, false); assert.deepEqual(f.engine.s, saved);
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), file); f.restart(); assert.equal(f.service.publicState().lastResult.id, original.id);
  f.scanner.dailyLoader = originalDailyLoader; const repeated = await f.service.run(); assert.equal(repeated.counts.retained, 1); assert.notEqual(repeated.id, original.id);
  assert.equal(f.transactions, 2); assert.equal(validState(f.engine.s), true); f.restart(); assert.equal(f.service.publicState().lastResult.id, repeated.id);
});

test('公告协议错误不会阻断技术入池，也不伪造公告核验通过', async t => {
  const f = fixture(t, ['sh600001']); let noticeRequests = 0;
  f.scanner.noticeLoader = async () => { noticeRequests++; throw Error('net::ERR_HTTP2_PROTOCOL_ERROR'); };
  const result = await f.service.run(); assert.equal(noticeRequests, 0); assert.equal(f.calls.evidence, 0);
  assert.equal(result.counts.added, 1); assert.equal(result.counts.unassignedPending, 0);
  assert.equal(result.coverage.researchStatus, 'disabled'); assert.equal(result.added[0].noticeReview, undefined);
});