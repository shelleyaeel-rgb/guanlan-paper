'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { Screener, defaults } = require('../core/screener.cjs');
const { AgencyPoolService } = require('../core/agency-pool.cjs');
const { poolPolicy } = require('../core/agency-screening.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');
const { composeStrategyQuery, parseStrategyDescription } = require('../core/strategy-presets.cjs');
const { evaluateEntryConditions, validEntryConditions, usesAutomaticEvidence } = require('../core/entry-conditions.cjs');
const { INDUSTRY_METADATA } = require('../core/selection-evidence.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');
const NOW = new Date('2026-10-13T10:00:00+08:00'), symbol = 'sh600001';
const rules = changes => ({ ...INDUSTRY_METADATA.defaults, ...changes });
function bars() {
  const dates = []; let day = Date.parse('2026-10-12T10:00:00+08:00');
  while (dates.length < 120) { const session = calendarSession(new Date(day)); if (session.open) dates.unshift(session.date); day -= 86400000; }
  return dates.map((date, index) => { const close = 10 + index * 0.008 + Math.sin(index / 4 + 1.6) * 0.12;
    return { date, open: close, close, high: close + 0.1, low: close - 0.1, volume: index === 119 ? 150 : 100 }; });
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-industry-pipeline-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('guanlan-industry-pipeline-')); fs.rmSync(directory, { recursive: true, force: true }); });
  let engine = new Engine(initialState(100000), () => NOW), unavailable = false, error = false;
  const store = new Store(directory), calls = { evidence: [], prepare: 0, finance: 0 };
  const quote = { symbol, name: '隔离行业流程', board: 'sh', isST: false, timestamp: +NOW, date: '2026-10-13',
    price: 11.05, prevClose: 10.94, changePct: 1, amount: 3, turnover: 3, pe: 20, pb: 2 };
  const scanner = new Screener(null, null, async () => ({ bars: bars(), source: '隔离未复权日线' }), () => NOW,
    async () => { calls.finance++; return { symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: +NOW,
      industryProfile: ordinaryProfile(symbol, NOW), data: {
        latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', currency: 'CNY', roe: 9, debtRatio: 40, adjustedProfit: 1e8, revenueYoY: 10, adjustedProfitYoY: 10, operatingCash: 2e8 },
        annual: [2025, 2024, 2023].map(year => ({ reportDate: `${year}-12-31`, noticeDate: `${year + 1}-03-28`, currency: 'CNY', roe: 12, adjustedProfit: 1e8, operatingCash: 2e8 })) } }; },
    async () => ({ symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: +NOW, data: { items: [], total: 0 } }),
    null, null, null, async (requested, options) => {
      calls.evidence.push({ symbol: requested, options }); if (error) throw Error('隔离行业网络错误');
      const bundle = companyBundle(requested, NOW); if (unavailable) bundle.documents[1].complete = false; return bundle;
    });
  scanner.load = async () => ({ rows: [structuredClone(quote)], source: '隔离行情', fetchedAt: +NOW, sourceCount: 1, excludedCount: 0 });
  const service = new AgencyPoolService({ getEngine: () => engine, transaction: fn => { const result = fn(); store.save(engine.s); return result; },
    screener: scanner, clock: () => +NOW, prepareSource: () => { calls.prepare++; } });
  return { service, scanner, calls, quote, get engine() { return engine; },
    unavailable: value => { unavailable = value; }, error: value => { error = value; },
    member: () => engine.s.agency.groups.flatMap(group => group.members).find(item => item.symbol === symbol),
    restart: () => { engine = new Engine(store.load(), () => NOW); } };
}

test('慢行业批次发布前撤销早期已过六小时的通过，不更新原采集时间续命', async t => {
  const f = fixture(t), second = 'sh600002'; let at = +NOW;
  f.scanner.clock = () => new Date(at);
  f.scanner.load = async () => ({ rows: [f.quote, { ...f.quote, symbol: second }], source: '隔离行情',
    fetchedAt: +NOW, sourceCount: 2, excludedCount: 0 });
  // Sequential completion through a microtask lets the first company's
  // evaluation finish before the second company's slow source completes.
  f.scanner.automaticEvidenceLoader = async requested => {
    if (requested === second) { await new Promise(resolve => setImmediate(resolve)); at += 21600001; }
    return companyBundle(requested, new Date(at));
  };
  f.scanner.noticeLoader = async requested => ({ symbol: requested, section: 'notices', source: '东方财富', status: 'empty',
    fetchedAt: at, data: { items: [], total: 0 } });
  const { runAgencyScreening } = require('../core/agency-screening.cjs');
  const scan = await runAgencyScreening(f.scanner, { industry: rules() });
  const row = scan.strategies.swing.pending.find(item => item.symbol === symbol);
  assert.ok(row); assert.equal(row.evidenceReview.industryReview.status, 'pending');
  assert.match(row.evidenceReview.industryReview.reason, /6小时/);
  assert.equal(row.evidenceReview.sourceValidity.fetchedAt, +NOW);
  assert.equal(scan.strategies.swing.pass.some(item => item.symbol === symbol), false);
});

test('行业数值筛选实际入池、持久化和开仓原文重核贯通，新不利排名不沿用旧通过', async t => {
  const f = fixture(t), industry = rules({ scope: 'segment', segmentRankMax: 2, minSegmentRevenuePct: 35 });
  const result = await f.service.run({ industry });
  assert.equal(result.counts.added, 1); assert.equal(f.calls.evidence.length, 1); assert.equal(f.calls.prepare, 1);
  assert.notEqual(f.calls.evidence[0].options.includeIndustry, false);
  assert.equal(result.added[0].evidenceReview.industryReview.status, 'pass');
  assert.deepEqual(result.industry, industry); assert.deepEqual(f.member().entryConditions.evidence.industry, industry);
  assert.equal(validState(f.engine.s), true); f.restart();
  const saved = f.member().entryConditions;
  assert.equal(validEntryConditions(saved), true); assert.equal(usesAutomaticEvidence(saved), true);
  const snapshot = { automaticEvidence: companyBundle(symbol, NOW) };
  const before = evaluateEntryConditions(saved, symbol, f.quote, snapshot, NOW);
  assert.equal(before.status, 'pass'); assert.equal(before.industryReview.status, 'pass');
  for (const document of snapshot.automaticEvidence.documents) document.text = document.fullText = document.text.replace('排名第1', '排名第5');
  const after = evaluateEntryConditions(saved, symbol, f.quote, snapshot, NOW);
  assert.equal(after.status, 'failed'); assert.equal(after.industryReview.status, 'fail');
  assert.ok(after.industryReview.rows.every(row => row.rank === 5));
  const missing = evaluateEntryConditions(saved, symbol, f.quote, {}, NOW);
  assert.equal(missing.status, 'pending'); assert.equal(missing.industryReview.status, 'pending');
  assert.equal(f.engine.s.trades.length, 0); assert.equal(f.engine.s.orders.length, 0);
});

test('未启用行业不获取行业报告；资料重试保留上次完整数字条件及自动证据来源', async t => {
  const ordinary = fixture(t); await ordinary.service.run();
  assert.equal(ordinary.calls.evidence.length, 0); assert.equal(ordinary.calls.prepare, 0);
  assert.equal(ordinary.member().entryConditions, undefined);
  const f = fixture(t), industry = rules({ scope: 'segment', segmentRankMax: 2, minSegmentRevenuePct: 35 }); f.unavailable(true);
  const initial = await f.service.run({ industry });
  assert.equal(initial.counts.unassignedPending, 1); assert.equal(initial.unassignedPending[0].evidenceReview.industryReview.status, 'pending');
  f.restart(); f.unavailable(false);
  const retried = await f.service.run({ retryEvidence: true });
  assert.equal(retried.counts.added, 1); assert.deepEqual(retried.industry, industry);
  assert.deepEqual(f.member().entryConditions.evidence.industry, industry); assert.equal(f.calls.evidence[1].options.retryFailed, true);
});

test('行业网络失败有明确原始指标待核验状态，严格模板拒绝叠加新行业配置', async t => {
  const f = fixture(t); f.error(true);
  const pending = await f.service.run({ industry: rules() });
  assert.equal(pending.counts.unassignedPending, 1);
  const review = pending.unassignedPending[0].evidenceReview.industryReview;
  assert.equal(review?.status, 'pending'); assert.match(review.reason, /隔离行业网络错误/); assert.deepEqual(review.rows, []);
  const callCount = f.calls.evidence.length;
  await assert.rejects(f.service.run({ screeningMode: 'strict', industry: rules() }), /旧严格研究/);
  assert.equal(f.calls.evidence.length, callCount);
  assert.throws(() => poolPolicy('strict', undefined, undefined, rules()), /旧严格研究/);
});

test('策略组合与自然语言追加保持原始行业数字，旧龙头标签不能静默覆盖', () => {
  const industry = rules({ scope: 'main', mainRankMax: 7 });
  const input = { ...defaults(), evidence: { conditions: [], industry } };
  assert.deepEqual(composeStrategyQuery('swing', input).evidence.industry, industry);
  assert.deepEqual(parseStrategyDescription({ text: '股价大于5元', baseQuery: input }).query.evidence.industry, industry);
  assert.throws(() => parseStrategyDescription({ text: '主行业前三', baseQuery: input }), /不能隐式合并/);
});
