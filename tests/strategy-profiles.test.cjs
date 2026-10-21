const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const { cnTime } = require('../core/common.cjs');
const { STRATEGY_PROFILES, strategyProfile, technicals, evaluateEntry, updateDynamicRisk, longFinanceCheck } = require('../core/strategy.cjs');
const { createEntryConditions, evaluateEntryConditions } = require('../core/entry-conditions.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');

const symbol = 'sz000001';
function fixture() {
  const now = new Date('2026-09-29T10:00:00+08:00');
  const engine = new Engine(initialState(100000), () => now);
  const quote = { symbol, name: '隔离策略样本', price: 10.1, prevClose: 10.08, open: 10, low: 10, high: 10.2, volume: 100000,
    bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000, limitUp: 11.09, limitDown: 9.07,
    amount: 2e8, turnover: 2, timestamp: now.getTime(), date: cnTime(now).date };
  const level = (stop, target) => ({ entryLow: 9.9, entryHigh: 10.3, support: stop + 0.1, resistance: target, stop, target, breakout: false });
  const snapshot = { source: '隔离未复权日线', fetchedAt: now.getTime(),
    notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), checkedAt: now.getTime(), data: { items: [], total: 0 } }, technical: {
    asOf: '2026-09-28', dates: ['2026-09-28'], close: 10.08, ma5: 10.05, previousMa5: 10.02,
    ma20: 10, previousMa20: 9.99, ma60: 9.95, previousMa60: 9.94,
    atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1.5, trend: true, ...level(9.6, 11.5),
    levels: { 'ultra-short': level(9.8, 11.2), short: level(9.7, 11.4), swing: level(9.6, 11.5), long: level(9.5, 12) }
  }, finance: { symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: now.getTime(), checkedAt: now.getTime(), industryProfile: ordinaryProfile(symbol, now),
    data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', updateDate: '2026-08-20', currency: 'CNY', roe: 8, debtRatio: 60, revenueYoY: 0, adjustedProfitYoY: 0, adjustedProfit: 1e8, operatingCash: 1e8 },
      annual: [{ reportDate: '2025-12-31', noticeDate: '2026-03-20', currency: 'CNY', roe: 8 }] }
  }, valuation: { symbol, section: 'valuation', source: '东方财富', status: 'ready', fetchedAt: now.getTime(), checkedAt: now.getTime(),
    data: { pe: 30, pb: 4, quoteTime: now.getTime(), marketCap: 1e11, floatCap: 8e10 }
  } };
  const evaluate = (strategyId, snap = snapshot, q = quote) => evaluateEntry(engine, symbol, q, snap, 100, strategyId);
  return { now, engine, quote, snapshot, evaluate };
}

test('四周期生成各自的买卖价位，策略标识不接受未知值', () => {
  assert.deepEqual(STRATEGY_PROFILES.map(p => p.id), ['ultra-short', 'short', 'swing', 'long']);
  for (const profile of STRATEGY_PROFILES) {
    for (const field of ['name', 'horizon', 'entryDescription', 'exitDescription', 'dataDescription']) assert.ok(profile[field]);
  }
  const data = Array.from({ length: 80 }, (_, i) => {
    const close = 10 + Math.sin(i / 2) * 0.08 + i * 0.002;
    return { date: new Date(Date.UTC(2026, 6, 11 + i)).toISOString().slice(0, 10), open: close, close, high: close + 0.2, low: close - 0.2, volume: 10000 };
  });
  data.at(-3).high = 11; data.at(-10).high = 12; data.at(-40).high = 13;
  data.at(-3).low = 9.8; data.at(-5).low = 9.6; data.at(-20).low = 9.4;
  const t = technicals(data, fixture().now);
  assert.deepEqual(Object.fromEntries(Object.entries(t.levels).map(([id, l]) => [id, l.target])), { 'ultra-short': 11, short: 12, swing: 12, long: 13 });
  assert.equal(t.levels['ultra-short'].support, 9.8); assert.equal(t.levels.short.support, 9.6); assert.equal(t.levels.long.support, 9.4);
  assert.equal(t.levels.swing.entryLow, t.entryLow); assert.equal(t.levels.swing.stop, t.stop); assert.equal(t.levels.swing.target, t.target);
  assert.notEqual(t.levels.long.entryLow, t.levels.short.entryLow);
  assert.throws(() => technicals(data.slice(-60), fixture().now), /不足/);
  assert.throws(() => strategyProfile('unknown'), /不存在/);
  assert.throws(() => fixture().evaluate(''), /不存在/);
});

test('四类计划实际按各自止损目标建仓并冻结策略、费用预算和财务证据', () => {
  for (const id of STRATEGY_PROFILES.map(p => p.id)) {
    const f = fixture(), result = f.evaluate(id);
    assert.equal(result.buyable, true, `${id}: ${result.reasons.join('；')}`);
    assert.equal(result.strategyId, id); assert.equal(result.plan.strategyId, id);
    assert.deepEqual(result.plan.config, f.engine.s.strategySettings);
    assert.ok(result.economics.loss <= result.budget); assert.ok(result.economics.rewardRisk >= 2);
    f.engine.selectStrategy(symbol, id);
    const trade = f.engine.strategyEntry({ symbol, strategyId: id, quantity: 100, expected: result.plan }, f.quote, f.snapshot);
    assert.equal(trade.strategyPlan.strategyId, id);
    assert.equal(f.engine.s.risks[symbol].strategyId, id);
    assert.equal(trade.strategyPlan.stop, f.snapshot.technical.levels[id].stop);
    if (id === 'long') {
      assert.deepEqual(trade.strategyPlan.financeEvidence.finance, f.snapshot.finance);
      assert.deepEqual(trade.strategyPlan.financeEvidence.valuation, f.snapshot.valuation);
      f.snapshot.finance.data.latest.roe = -1;
      assert.equal(trade.strategyPlan.financeEvidence.finance.data.latest.roe, 8);
    }
  }
});

test('超短、短线、波段预筛阈值有实际差异并拒绝缺失成交活跃数据', () => {
  const f = fixture();
  for (const id of ['ultra-short', 'short', 'swing']) assert.equal(f.evaluate(id).buyable, true);
  for (const [technical, rejected, accepted] of [
    [{ volumeRatio: 1.1 }, ['ultra-short'], ['short', 'swing']],
    [{ volumeRatio: 0.8 }, ['ultra-short', 'short'], ['swing']],
    [{ rsi: 42 }, ['ultra-short', 'short'], ['swing']],
    [{ previousMa5: 10.05 }, ['ultra-short'], ['short', 'swing']]
  ]) {
    const snap = structuredClone(f.snapshot); Object.assign(snap.technical, technical);
    for (const id of rejected) assert.equal(f.evaluate(id, snap).status, '等待趋势');
    for (const id of accepted) assert.equal(f.evaluate(id, snap).buyable, true);
  }
  for (const q of [{ amount: 1.5e8 }, { turnover: 1.99 }, { turnover: 15.01 }, { turnover: null }]) {
    assert.equal(f.evaluate('ultra-short', f.snapshot, { ...f.quote, ...q }).status, '等待成交活跃');
    assert.equal(f.evaluate('short', f.snapshot, { ...f.quote, ...q }).buyable, true);
  }
  for (const amount of [null, undefined, NaN, 99999999]) assert.equal(f.evaluate('short', f.snapshot, { ...f.quote, amount }).status, '等待成交活跃');
  assert.equal(f.evaluate('short', f.snapshot, { ...f.quote, amount: 1e8 }).buyable, true);
});

test('金融模板不适用与行业未知分别阻断新建仓，财务数字只作观察', () => {
  for (const unavailable of [false, true]) {
    const f = fixture(), snapshot = structuredClone(f.snapshot);
    snapshot.finance.industryProfile = unavailable ? null : {
      ...ordinaryProfile(symbol, f.now), data: { industry: '金融-银行', regulatoryIndustry: '金融业-货币金融服务', orgType: '银行', orgTypeCode: '3' }
    };
    snapshot.finance.data.latest.debtRatio = 90;
    const result = f.evaluate('long', snapshot);
    assert.equal(result.status, unavailable ? '等待行业核验' : '财务模板不适用');
    assert.equal(result.buyable, false); assert.equal(result.financeCheck.checks.length, 0);
    assert.equal(result.financeCheck.observations.find(item => item.field === 'debtRatio').value, 90);
    assert.doesNotMatch(result.reasons.join(''), /要求.*60/);
    f.engine.selectStrategy(symbol, 'long'); const before = structuredClone(f.engine.s);
    assert.throws(() => f.engine.strategyEntry({ symbol, strategyId: 'long', quantity: 100 }, f.quote, snapshot), /行业|模板/);
    assert.deepEqual(f.engine.s, before);
  }
});

test('长线使用财报和东方财富动态估值，不能以腾讯报价估值替代', () => {
  const f = fixture();
  for (const change of [{ debtRatio: 60.01 }, { debtRatio: -1 }, { revenueYoY: -0.01 }, { adjustedProfitYoY: -0.01 }, { adjustedProfit: 0 }, { adjustedProfit: null }, { operatingCash: 0 }, { operatingCash: null }, { currency: 'USD' }]) {
    const snap = structuredClone(f.snapshot); Object.assign(snap.finance.data.latest, change);
    assert.equal(f.evaluate('long', snap).status, '等待财务估值', JSON.stringify(change));
  }
  for (const change of [{ pe: 0 }, { pe: -1 }, { pe: 30.01 }, { pe: null }, { pb: 0 }, { pb: 4.01 }]) {
    const snap = structuredClone(f.snapshot); Object.assign(snap.valuation.data, change);
    assert.equal(f.evaluate('long', snap, { ...f.quote, pe: 5, pb: 1 }).status, '等待财务估值');
  }
  const missing = structuredClone(f.snapshot); delete missing.valuation;
  assert.equal(f.evaluate('long', missing, { ...f.quote, pe: 5, pb: 1 }).buyable, false);
  const falling = structuredClone(f.snapshot); falling.technical.previousMa60 = 10;
  assert.equal(f.evaluate('long', falling).status, '等待趋势');
  for (const roe of [7.99, null]) {
    const snap = structuredClone(f.snapshot); snap.finance.data.annual[0].roe = roe;
    assert.equal(f.evaluate('long', snap).status, '等待财务估值');
  }
});

test('年度ROE门槛与低季度累计ROE观察分开，不依赖三年链且不改旧个人累计ROE规则', () => {
  const f = fixture(); f.snapshot.finance.data.latest.roe = 2;
  const result = f.evaluate('long');
  assert.equal(result.buyable, true); assert.equal(result.financeCheck.annualReportDate, '2025-12-31');
  const annual = result.financeCheck.checks.find(check => check.field === 'annualRoeLatest');
  assert.equal(annual.value, 8); assert.equal(annual.status, 'pass'); assert.equal(annual.reportDate, '2025-12-31'); assert.equal(annual.noticeDate, '2026-03-20');
  assert.match(annual.basis, /完整年度/); assert.ok(!result.financeCheck.checks.some(check => check.field === 'roe'));
  const observation = result.financeCheck.observations.find(item => item.field === 'roe');
  assert.equal(observation.value, 2); assert.equal(observation.status, 'available'); assert.equal(observation.reportDate, '2026-06-30'); assert.match(observation.basis, /仅观察/);
  assert.equal(result.plan.financeEvidence.financeCheck.checks.find(check => check.field === 'annualRoeLatest').reportDate, '2025-12-31');
  const personal = createEntryConditions({ rules: [{ field: 'roe', op: 'gte', value: 8 }] }, f.now);
  assert.equal(evaluateEntryConditions(personal, symbol, f.quote, f.snapshot, f.now).status, 'failed', '原有个人roe条件继续检查累计值，不偷换为年度ROE');
  f.snapshot.finance.data.latest.roe = null;
  assert.equal(f.evaluate('long').financeCheck.status, 'pass', '未选择的累计ROE观察缺项不阻断年度门槛');
  f.snapshot.finance.data.annual = [];
  const missing = f.evaluate('long').financeCheck;
  assert.equal(missing.checks.find(check => check.field === 'annualRoeLatest').status, 'pending');
  assert.equal(missing.checks.find(check => check.field === 'annualRoeLatest').reportDate, null);
});

test('亏损收窄不能冒充盈利，累计利润金额与同比及现金流分别核验', () => {
  const f = fixture(); Object.assign(f.snapshot.finance.data.latest, { adjustedProfitYoY: 50, adjustedProfit: -1e8, operatingCash: 2e8 });
  const result = f.evaluate('long');
  assert.equal(result.buyable, false); assert.equal(result.financeCheck.status, 'failed');
  assert.equal(result.financeCheck.checks.find(check => check.field === 'adjustedProfitYoY').status, 'pass');
  const profit = result.financeCheck.checks.find(check => check.field === 'latestAdjustedProfit');
  assert.equal(profit.status, 'failed'); assert.equal(profit.value, -1); assert.equal(profit.unit, '亿元'); assert.equal(profit.reportDate, '2026-06-30');
  const cash = result.financeCheck.checks.find(check => check.field === 'operatingCash');
  assert.equal(cash.value, 2); assert.equal(cash.status, 'pass'); assert.match(cash.basis, /非 TTM/);
  delete f.snapshot.finance.data.latest.adjustedProfit;
  const missing = f.evaluate('long').financeCheck;
  assert.equal(missing.status, 'pending'); assert.equal(missing.checks.find(check => check.field === 'latestAdjustedProfit').value, null);
  assert.equal(missing.checks.find(check => check.field === 'adjustedProfitYoY').status, 'pass');
});

test('旧累计报告重新抓取不能通过，最新有效年度仍单独显示', () => {
  const f = fixture(); Object.assign(f.snapshot.finance.data.latest, { reportDate: '2026-03-31', noticeDate: '2026-04-20', updateDate: '2026-04-20' });
  f.snapshot.finance.fetchedAt = +f.now;
  const result = f.evaluate('long');
  assert.equal(result.buyable, false); assert.equal(result.financeCheck.status, 'pending');
  assert.equal(result.financeCheck.checks.find(check => check.field === 'annualRoeLatest').status, 'pass');
  const cash = result.financeCheck.checks.find(check => check.field === 'operatingCash');
  assert.equal(cash.status, 'pending'); assert.equal(cash.value, null); assert.equal(cash.rawValue, 1); assert.match(cash.reason, /新抓取时间不能使旧报告重新有效/);
});

test('新年度报告已披露时年度门槛等待对应年报，不能沿用旧年度或用最新季度ROE补齐', () => {
  const f = fixture(), at = new Date('2027-03-20T10:00:00+08:00');
  Object.assign(f.snapshot.finance, { fetchedAt: +at, industryProfile: ordinaryProfile(symbol, at) });
  Object.assign(f.snapshot.finance.data.latest, { reportDate: '2026-09-30', noticeDate: '2026-10-20', updateDate: '2026-10-20', roe: 15 });
  f.snapshot.notices = { symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +at,
    data: { items: [{ id: 'AN20270319000001', date: '2027-03-19', title: '2026年度报告' }], total: 1 } };
  const result = longFinanceCheck(f.snapshot, symbol, at), annual = result.checks.find(check => check.field === 'annualRoeLatest');
  assert.equal(result.status, 'pending'); assert.equal(annual.status, 'pending'); assert.equal(annual.value, null);
  assert.equal(annual.rawValue, 8); assert.equal(annual.reportDate, '2025-12-31'); assert.equal(annual.pendingReport.reportDate, '2026-12-31');
  assert.equal(result.evidence, undefined);
});

test('长线财务与估值缺失、过期、未来、未知披露日期和身份错配均拒绝新建仓', () => {
  const f = fixture(), at = f.now.getTime();
  const mutate = [
    s => { delete s.finance; }, s => { s.finance.status = 'stale'; }, s => { s.valuation.status = 'unavailable'; },
    s => { s.finance.symbol = 'sh600000'; }, s => { s.valuation.symbol = 'sh600000'; },
    s => { s.finance.section = 'profile'; }, s => { s.valuation.source = '腾讯'; },
    s => { s.finance.fetchedAt = at - 21600001; }, s => { s.valuation.fetchedAt = at - 90001; },
    s => { s.finance.fetchedAt = at + 1; }, s => { s.valuation.fetchedAt = at + 1; },
    s => { s.valuation.data.quoteTime = null; }, s => { s.valuation.data.quoteTime = at + 1; }, s => { s.valuation.data.quoteTime = at - 90001; },
    s => { s.finance.data.latest.noticeDate = null; }, s => { s.finance.data.latest.noticeDate = '2026-09-30'; },
    s => { s.finance.data.latest.noticeDate = '2026-06-29'; }, s => { s.finance.data.latest.noticeDate = '2026-02-30'; },
    s => { s.finance.data.latest.reportDate = '2026-06-29'; }, s => { s.finance.data.latest.reportDate = '2026-12-31'; },
    s => { s.finance.data.latest.updateDate = '2026-09-30'; }
  ];
  for (const change of mutate) {
    const snap = structuredClone(f.snapshot); change(snap);
    assert.equal(f.evaluate('long', snap).status, '等待财务估值', change.toString());
    assert.equal(f.evaluate('swing', snap).buyable, true, '财务失败不改变原波段规则');
  }
  const boundary = structuredClone(f.snapshot);
  boundary.finance.fetchedAt = at - 21600000; boundary.valuation.fetchedAt = at - 90000; boundary.valuation.data.quoteTime = at - 90000;
  assert.equal(f.evaluate('long', boundary).buyable, true);
});

function riskFixture(strategyId, heldBars = 0) {
  const f = fixture();
  const risk = { strategy: 'plan-v1', strategyId, dynamic: true, enabled: true, stop: 9.4, target: 12, entryPrice: 10.11,
    entryDate: '2026-01-01', heldBars, lastReviewAsOf: '2026-09-27', config: { adjustmentAtr: 0.25 }, history: [] };
  f.snapshot.technical.close = 10.5; f.quote.prevClose = 10.5; f.quote.price = 10.6;
  return { ...f, risk };
}

test('公告和技术待核验不会隐藏长线财务独立结果，财务通过也不能绕过公告', () => {
  const f = fixture();
  f.snapshot.notices = { ...f.snapshot.notices, status: 'ready', data: { items: [{ id: 'AN20260929000001', date: '2026-09-29', title: '2026年前三季度业绩预告' }], total: 1 } };
  const result = f.evaluate('long');
  assert.equal(result.status, '等待公告核验'); assert.equal(result.buyable, false);
  assert.equal(result.financeCheck.status, 'pass'); assert.equal(result.financeCheck.reportDate, '2026-06-30');
  assert.equal(result.valuationCheck.status, 'pass'); assert.deepEqual(result.financeEvidence.finance, f.snapshot.finance);
  f.snapshot.finance.data.annual[0].roe = 7;
  const failed = f.evaluate('long');
  assert.equal(failed.status, '等待公告核验'); assert.equal(failed.financeCheck.status, 'failed');
  assert.equal(failed.financeCheck.checks.find(check => check.field === 'annualRoeLatest').value, 7);
  assert.equal(failed.financeEvidence, undefined);
  delete f.snapshot.technical;
  assert.equal(f.evaluate('long').financeCheck.status, 'failed');
  assert.equal(f.evaluate('swing').financeCheck, undefined);
});

test('新正式财报待同步不会以旧报通过，预告、快报和未来正式报告不能冒充新财报', () => {
  const f = fixture();
  // A third-quarter report cannot have been disclosed before its period ends.
  f.snapshot.notices = { ...f.snapshot.notices, status: 'ready', data: { items: [{ id: 'AN20260929000001', date: '2026-09-29', title: '2026年第三季度报告' }], total: 1 } };
  assert.equal(f.evaluate('long').financeCheck.status, 'pass');
  f.snapshot.finance.data.latest.reportDate = '2026-03-31';
  f.snapshot.finance.data.latest.noticeDate = '2026-04-29';
  f.snapshot.notices.data.items[0].title = '2026年半年度报告';
  const pending = f.evaluate('long');
  assert.equal(pending.financeCheck.status, 'pending'); assert.equal(pending.financeCheck.pendingReport.reportDate, '2026-06-30');
  assert.equal(pending.financeCheck.checks.find(check => check.field === 'annualRoeLatest').status, 'pass');
  assert.equal(pending.buyable, false); assert.equal(pending.financeEvidence, undefined);
  f.snapshot.finance.data.latest.reportDate = '2026-06-30';
  f.snapshot.finance.data.latest.noticeDate = '2026-08-15';
  for (const title of ['2026年半年度业绩预告', '2026年半年度业绩快报', '关于2026年半年度报告的董事会决议公告']) {
    f.snapshot.notices.data.items[0].title = title;
    assert.equal(f.evaluate('long').financeCheck.status, 'pass', title);
  }
});

test('超短、短线、长线按不同持有上限退出，盈利不会豁免硬期限；波段仍保留未涨条件', () => {
  for (const [id, days] of [['ultra-short', 3], ['short', 10], ['long', 120]]) {
    const f = riskFixture(id, days - 2);
    updateDynamicRisk(f.risk, f.snapshot, f.quote, f.now);
    assert.equal(f.risk.heldBars, days - 1); assert.equal(f.risk.pendingExit, undefined);
    const before = structuredClone(f.risk);
    updateDynamicRisk(f.risk, f.snapshot, f.quote, f.now);
    assert.deepEqual(f.risk, before, '相同日线不重复计数或改价');
    f.risk = JSON.parse(JSON.stringify(f.risk));
    f.now.setTime(Date.parse('2026-09-30T10:00:00+08:00'));
    f.snapshot.fetchedAt = f.now.getTime(); f.snapshot.technical.asOf = '2026-09-29';
    f.snapshot.technical.dates = ['2026-09-29'];
    f.quote.timestamp = f.now.getTime(); f.quote.date = cnTime(f.now).date;
    updateDynamicRisk(f.risk, f.snapshot, f.quote, f.now);
    assert.equal(f.risk.pendingExit, `${strategyProfile(id).name}持有超时`);
    assert.equal(f.risk.heldBars, days);
  }
  const swing = riskFixture(undefined, 119);
  updateDynamicRisk(swing.risk, swing.snapshot, swing.quote, swing.now);
  assert.equal(swing.risk.pendingExit, undefined);
  const flat = riskFixture(undefined, 14); flat.snapshot.technical.close = 10.08; flat.quote.prevClose = 10.08;
  updateDynamicRisk(flat.risk, flat.snapshot, flat.quote, flat.now);
  assert.equal(flat.risk.pendingExit, '波段持有超时');
});

test('每类持仓只按建仓策略趋势退出，长线不受短期均线或财报断线影响', () => {
  const ultra = riskFixture('ultra-short'); ultra.snapshot.technical.ma5 = 9.99;
  updateDynamicRisk(ultra.risk, ultra.snapshot, ultra.quote, ultra.now);
  assert.equal(ultra.risk.pendingExit, '超短线趋势失效');
  const short = riskFixture('short'); short.snapshot.technical.ma5 = 9.99;
  updateDynamicRisk(short.risk, short.snapshot, short.quote, short.now);
  assert.equal(short.risk.pendingExit, '短线趋势失效');
  const long = riskFixture('long'); long.snapshot.technical.ma5 = 9.8;
  long.snapshot.finance.status = 'stale'; long.snapshot.valuation.status = 'unavailable';
  updateDynamicRisk(long.risk, long.snapshot, long.quote, long.now);
  assert.equal(long.risk.pendingExit, undefined);
  assert.ok(long.risk.stop >= 9.4);
  const broken = riskFixture('long'); broken.snapshot.technical.ma20 = 9.9;
  updateDynamicRisk(broken.risk, broken.snapshot, broken.quote, broken.now);
  assert.equal(broken.risk.pendingExit, '长线趋势失效');
});

test('短长计划价位不足时不回退波段，未知持仓规则和过期日线不修改原风险边界', () => {
  for (const id of ['ultra-short', 'short', 'long']) {
    const f = fixture(); delete f.snapshot.technical.levels[id];
    assert.equal(f.evaluate(id).buyable, false); assert.match(f.evaluate(id).reasons.join(''), /价位不足/);
  }
  for (const change of [f => { f.risk.strategyId = 'unknown'; }, f => { f.snapshot.fetchedAt = 0; }, f => { f.snapshot.technical.close = 20; }]) {
    const f = riskFixture('long'); change(f);
    updateDynamicRisk(f.risk, f.snapshot, f.quote, f.now);
    assert.equal(f.risk.stop, 9.4); assert.equal(f.risk.target, 12); assert.equal(f.risk.history.length, 0); assert.ok(f.risk.reviewNote);
  }
});
