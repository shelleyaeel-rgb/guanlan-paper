const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { cnTime } = require('../core/common.cjs');

function fixture() {
  let now = new Date('2026-09-28T10:00:00+08:00');
  const engine = new Engine(initialState(100000), () => now);
  const quote = () => ({ symbol: 'sz000001', name: '独立账务检查', price: 10.1, prevClose: 10.05, open: 10, low: 10, high: 10.2,
    volume: 100000, bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05,
    timestamp: now.getTime(), date: cnTime(now).date });
  const snapshot = () => ({ fetchedAt: now.getTime(), technical: { asOf: '2026-09-27', close: 10.05, ma5: 10, ma20: 10, ma60: 9.5,
    atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false, support: 9.7, resistance: 11.5,
    entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-09-27'] },
    notices: { symbol: 'sz000001', section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } } });
  engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
  engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'add' }); engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const trade = engine.agencyExecute({ strategyId: 'swing', symbol: 'sz000001', action: 'buy', targetPercent: 20,
    decisionId: 'review-buy', expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, quote(), snapshot());
  const event = extra => ({ eventId: 'cash-20260929', noticeIds: ['AN123456789012'], sourceUrl: 'https://example.test/implementation',
    status: 'implemented', recordDate: '2026-09-29', exDate: '2026-09-30', payDate: '2026-10-08', listingDate: null,
    cashPerShare: 0.1, bonusPerShare: 0, transferPerShare: 0, taxPolicy: 'cn-individual-deferred-v1', ...extra });
  const source = events => ({ corporateActions: { symbol: 'sz000001', status: 'ready', fetchedAt: now.getTime(), coverageComplete: true,
    coverageStart: '2026-01-01', coverageEnd: cnTime(now).date, events: events || [event()], notices: [] } });
  const process = events => engine.agencyProcessCorporateActions('sz000001', quote(), source(events));
  return { engine, trade, quote, event, source, process, day: date => { now = new Date(`${date}T10:00:00+08:00`); } };
}

test('persisted completed cash action cannot omit payment stage and count posted cash again as receivable', () => {
  const f = fixture(); f.day('2026-10-08'); f.process();
  const broken = structuredClone(f.engine.s); delete broken.agency.corporateActions[0].paymentAppliedAt;
  assert.equal(validState(broken), false);
});

test('persisted cash journal cannot lose entitlements and silently release all deferred tax reserve', () => {
  const f = fixture(); f.day('2026-10-08'); f.process();
  assert.ok(f.engine.stats().taxReserve > 0);
  const broken = structuredClone(f.engine.s); broken.agency.corporateActions[0].entitlements = [];
  assert.equal(validState(broken), false);
});

test('manual same-batch adjustment cannot duplicate automatic dividend receivables before payment', () => {
  const f = fixture(); f.day('2026-09-30'); f.process();
  const cash = f.engine.s.cash, receivable = f.engine.stats().receivable;
  assert.throws(() => f.engine.agencyReconcile({ strategyId: 'swing', symbol: 'sz000001', eventId: 'manual-same-batch',
    evidence: '已核验同一权益登记日与派息方案原文', recordDate: '2026-09-29', effectiveDate: '2026-09-30',
    cashAmount: f.trade.quantity * 0.1, riskPriceFactor: 0.99 }));
  assert.equal(f.engine.s.cash, cash); assert.equal(f.engine.stats().receivable, receivable);
});

test('a second capital transfer never reallocates every entitlement from the same original physical lot', () => {
  const f = fixture(), cost = f.engine.s.lots[0].cost;
  const first = f.event({ eventId: 'transfer-first', cashPerShare: 0, payDate: null, transferPerShare: 1,
    transferTaxExempt: true, listingDate: '2026-10-08' });
  f.day('2026-09-30'); assert.equal(f.process([first]).status, 'clear');
  const before = structuredClone(f.engine.s.lots);
  const second = f.event({ eventId: 'transfer-second', noticeIds: ['AN123456789013'], recordDate: '2026-10-08', exDate: '2026-10-09',
    payDate: null, cashPerShare: 0, transferPerShare: 1, transferTaxExempt: true, listingDate: '2026-10-09' });
  f.day('2026-10-09'); const result = f.process([first, second]);
  if (result.status === 'blocked') { assert.deepEqual(f.engine.s.lots, before); return; }
  assert.equal(f.engine.s.lots.reduce((sum, lot) => sum + lot.cost, 0), cost);
  const unitCosts = f.engine.s.lots.map(lot => lot.cost / lot.quantity);
  assert.ok(Math.max(...unitCosts) - Math.min(...unitCosts) <= 1 / f.trade.quantity,
    'equal original-priced entitlements require equal per-share costs after two identical transfers');
});
