'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const { CorporateService } = require('../core/corporate-service.cjs');
const { AgencyService } = require('../core/agency-service.cjs');
const { EntryEvidenceStore } = require('../core/entry-evidence-store.cjs');
const { prepareHistory } = require('../core/daily-history.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');
const { cnTime } = require('../core/common.cjs');

const SYMBOL = 'sz000001';

function completeBars() {
  const dates = [];
  for (let at = Date.parse('2026-10-21T10:00:00+08:00'); dates.length < 80; at -= 86400000)
    if (calendarSession(new Date(at)).open) dates.unshift(cnTime(at).date);
  const bars = dates.map((date, index) => {
    const base = index < 60 ? 10 + index * 0.004 : 10.24 + (index - 60) * 0.02;
    const close = Math.round((base + (index % 2 ? 0.04 : -0.04)) * 100) / 100;
    return { date, open: close, close, high: Math.round((close + (index === 62 ? 1.4 : 0.15)) * 100) / 100,
      low: Math.round((close - 0.15) * 100) / 100, volume: 100000 };
  });
  Object.assign(bars.at(-1), { open: 10.62, close: 10.62, high: 10.77, low: 10.47 });
  return bars;
}

test('旧v8公告错误留档后真实服务链路零研究首次开仓，持仓断线仍阻断退出并恢复权益核算', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-technical-lifecycle-'));
  let agency;
  t.after(() => {
    agency?.stop();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('guanlan-technical-lifecycle-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  let now = Date.parse('2026-10-22T10:00:00+08:00'), price = 10.63, previousClose = 10.62, corporateOnline = false;
  const bars = completeBars(), calls = { daily: 0, quotes: 0, research: 0, corporate: 0, applyCheck: 0, saves: 0 };
  let engine = new Engine(initialState(100000), () => new Date(now));
  const member = () => engine.s.agency.groups.find(group => group.id === 'swing').members[0];
  const legacyMonitoringCheck = { status: 'data',
    reason: '开仓资料未就绪：公告资料已过期或不可用，等待后台准备或手动核验',
    checkedAt: '2026-10-21T02:00:00.000Z' };
  const store = new Store(directory), evidence = new EntryEvidenceStore(path.join(directory, 'entry-evidence')), quotes = {};
  const transaction = mutate => {
    const before = structuredClone(engine.s);
    try { const result = mutate(); assert.equal(validState(engine.s), true); store.save(engine.s); calls.saves++; return result; }
    catch (error) { engine.s = before; throw error; }
  };
  transaction(() => {
    engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
    engine.agencyMember({ strategyId: 'swing', symbol: SYMBOL, action: 'add' });
    engine.agencyMode({ strategyId: 'swing', mode: 'running' });
    member().monitoringCheck = structuredClone(legacyMonitoringCheck);
  });
  // An ordinary v8 member has no removed personal predicates to trigger the
  // older v7 migration. Loading this saved account must retire its old result.
  const beforeReload = structuredClone(engine.s);
  assert.equal(beforeReload.agency.version, 8); assert.equal(member().entryConditions, undefined);
  engine = new Engine(store.load(), () => new Date(now));
  assert.equal(member().mode, 'active'); assert.equal(member().selectionMode, 'strategy');
  assert.equal(member().monitoringCheck, undefined, 'obsolete announcement failure is not a current entry check');
  assert.deepEqual(member().legacyMonitoringCheck, legacyMonitoringCheck);
  for (const key of ['cash', 'lots', 'trades', 'orders', 'risks']) assert.deepEqual(engine.s[key], beforeReload[key]);
  for (const key of ['mode', 'cash', 'netFunding']) assert.equal(engine.s.agency.groups.find(group => group.id === 'swing')[key],
    beforeReload.agency.groups.find(group => group.id === 'swing')[key]);
  const quote = () => ({ symbol: SYMBOL, name: '完整服务链路隔离样本', source: '隔离行情', provider: 'tencent', price,
    prevClose: previousClose, open: price, low: price - 0.05, high: price + 0.05, volume: 1000000,
    bid: price - 0.01, ask: price, bidSize: 20000, askSize: 20000, limitUp: 11.68, limitDown: 9.56,
    timestamp: now, date: cnTime(now).date });
  const market = {
    async strategyHistory(symbol) {
      calls.daily++; assert.equal(symbol, SYMBOL);
      const entry = prepareHistory(symbol, 'stock', { symbol, bars, source: '隔离完整未复权日线', provider: 'test', adjustment: '未复权', fetchedAt: now }, now);
      assert.ok(entry, 'only actual completed trading sessions enter the monitor');
      return entry;
    },
    async quotes(symbols) { calls.quotes++; return Object.fromEntries(symbols.map(symbol => { assert.equal(symbol, SYMBOL); return [symbol, quote()]; })); }
  };
  const disabledResearch = () => { calls.research++; throw Error('公告/财务/公司研究 provider 故障'); };
  const research = { get: disabledResearch, getFinanceWithIndustry: disabledResearch,
    noticeVersion: () => ({ version: 2, usable: false }) };
  const monitor = new StrategyMonitor(market, () => new Date(now), () => {}, research);
  const event = { eventId: 'integration-cash-20261022', noticeIds: ['AN20261022000001'],
    sourceUrl: 'https://example.test/isolated-dividend', status: 'implemented', recordDate: '2026-10-22',
    exDate: '2026-10-23', payDate: '2026-10-23', listingDate: null, cashPerShare: 0.1,
    bonusPerShare: 0, transferPerShare: 0, taxPolicy: 'cn-individual-deferred-v1' };
  const corporate = new CorporateService({
    getEngine: () => engine, transaction, market, getMonitor: () => monitor, clock: () => now,
    acceptQuotes: batch => Object.assign(quotes, batch), source: { async get({ symbol, fromDate }) {
      calls.corporate++; assert.equal(symbol, SYMBOL);
      if (!corporateOnline) throw Error('公司行为 provider 故障');
      return { symbol, status: 'ready', source: '隔离公司行为', fetchedAt: now,
        coverageStart: fromDate, coverageEnd: cnTime(now).date, coverageComplete: true, events: [event], notices: [] };
    } }
  });
  const applyCheck = corporate.applyCheck.bind(corporate);
  corporate.applyCheck = job => { calls.applyCheck++; return applyCheck(job); };
  monitor.corporate = corporate;
  agency = new AgencyService({ getEngine: () => engine, transaction, market, monitor,
    getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch), clock: () => now,
    getAutomaticEvidence: disabledResearch, getNoticeEvidence: disabledResearch, getSelectionEvidence: disabledResearch,
    archiveEntryEvidence: payload => evidence.archive(payload) });
  assert.equal(engine.agencyNeedsCorporateEvidence(SYMBOL), false);
  assert.deepEqual(corporate.symbols(), []); assert.deepEqual(corporate.preparationSymbols(), [SYMBOL]);
  await agency.prepareEntry(SYMBOL, 'swing');
  assert.equal(monitor.snapshots[SYMBOL].technical.asOf, '2026-10-21');
  assert.equal(monitor.snapshots[SYMBOL].dailyEvidence.count, 80);
  // Independently viewed research can leave failed data in the shared monitor.
  // The real automatic read/assert pair must ignore and strip these fields.
  Object.assign(monitor.snapshots[SYMBOL], { notices: { status: 'unavailable', noticeVersion: 1, error: '旧公告失败' },
    finance: { status: 'unavailable', error: '旧财报失败' }, automaticEvidence: { status: 'unavailable', error: '旧正文失败' } });
  const prepared = agency.readEntrySnapshot(SYMBOL, 'swing');
  for (const section of ['notices', 'finance', 'automaticEvidence']) assert.equal(prepared[section], undefined);
  assert.doesNotThrow(() => agency.assertEntrySnapshot(SYMBOL, 'swing', prepared));
  const beforeBuyCheck = await corporate.verifyOne(SYMBOL);
  assert.equal(beforeBuyCheck.status, 'clear'); assert.equal(calls.applyCheck, 1);
  assert.equal(member().corporateVerification.status, 'not-required');
  assert.equal(engine.s.trades.length, 0, 'background preparation never submits an order');
  assert.equal(calls.research, 0); assert.equal(calls.corporate, 0);

  await agency.poll({ force: true }); await agency.runner.drain();
  assert.equal(engine.s.trades.length, 1, JSON.stringify(engine.s.agency.decisions));
  const buy = engine.s.trades[0], cashAfterBuy = engine.s.cash, originalStop = engine.s.risks[SYMBOL].stop;
  assert.equal(buy.side, 'buy'); assert.equal(buy.owner, 'swing');
  assert.equal(member().monitoringCheck.entryPolicyVersion, 1);
  assert.equal(member().monitoringCheck.status, 'holding');
  assert.deepEqual(member().legacyMonitoringCheck, legacyMonitoringCheck);
  assert.equal(buy.strategyPlan.entryRiskEvidence.notices.status, 'disabled');
  assert.equal(calls.research, 0); assert.equal(calls.corporate, 0, 'first actual entry does not call the company-action provider');
  assert.equal(evidence.auditAccount(store.load()).verified, 1);
  const archived = evidence.read(buy.entryEvidenceRef);
  assert.equal(archived.snapshot.notices, undefined); assert.equal(archived.snapshot.finance, undefined);
  assert.equal(engine.agencyNeedsCorporateEvidence(SYMBOL), true); assert.deepEqual(corporate.symbols(), [SYMBOL]);

  const failedHolding = await corporate.verifyOne(SYMBOL, true);
  assert.equal(failedHolding.status, 'blocked'); assert.match(failedHolding.reason, /公司行为 provider 故障/);
  assert.equal(member().reconciliation.affectsEquity, true); assert.equal(calls.corporate, 1);
  assert.equal(engine.s.cash, cashAfterBuy); assert.equal(engine.s.agency.corporateEvents.length, 0);
  now = Date.parse('2026-10-23T10:00:00+08:00'); previousClose = 10.54; price = 10.1;
  bars.push({ date: '2026-10-22', open: 10.63, close: 10.64, high: 10.79, low: 10.49, volume: 100000 });
  await corporate.verifyOne(SYMBOL, true);
  assert.equal(engine.positions()[0].available, buy.quantity, 'T+1 has elapsed, so the exit is blocked by unresolved equity');
  engine.s.risks[SYMBOL].pendingExit = '隔离退出验证';
  transaction(() => assert.deepEqual(engine.tick({ [SYMBOL]: quote() }, monitor.snapshots), []));
  assert.equal(engine.s.trades.length, 1); assert.equal(engine.s.cash, cashAfterBuy);
  assert.equal(engine.s.risks[SYMBOL].stop, originalStop);

  corporateOnline = true; price = 10.55;
  const restored = await corporate.verifyOne(SYMBOL, true);
  assert.equal(restored.status, 'clear', restored.reason);
  assert.equal(member().reconciliation.status, 'clear');
  assert.equal(engine.s.cash, cashAfterBuy + buy.quantity * 10);
  assert.equal(engine.s.agency.corporateActions[0].entitlements[0].quantity, buy.quantity, 'registration-day purchase is replayed after delayed discovery');
  assert.equal(engine.s.risks[SYMBOL].stop, Math.round((originalStop - 0.1) * 100) / 100);
  assert.equal(engine.s.agency.corporateEvents.length, 1);
  const postedCash = engine.s.cash;
  await corporate.verifyOne(SYMBOL, true);
  assert.equal(engine.s.cash, postedCash); assert.equal(engine.s.agency.corporateEvents.length, 1, 'retry cannot double-post the dividend');
  const sells = transaction(() => engine.tick({ [SYMBOL]: quote() }, monitor.snapshots));
  assert.equal(sells.length, 1); assert.equal(sells[0].quantity, buy.quantity);
  assert.equal(engine.s.cash, postedCash + sells[0].gross - sells[0].fees.total - buy.quantity * 2);
  assert.equal(engine.s.agency.corporateActions[0].entitlements[0].taxPaid, buy.quantity * 2);
  assert.equal(engine.s.lots.length, 0); assert.equal(calls.research, 0);
  assert.equal(validState(store.load()), true);
  assert.deepEqual(new Engine(store.load(), () => new Date(now)).s, JSON.parse(JSON.stringify(engine.s)));
});
