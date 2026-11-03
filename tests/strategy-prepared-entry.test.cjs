'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const { prepareHistory, registerDailyRevision } = require('../core/daily-history.cjs');
const { createEntryConditions, entryConditionDataRequirements, entryConditionNeedsFundamentals, evaluateEntryConditions } = require('../core/entry-conditions.cjs');

const SYMBOL = 'sh600519', START = Date.parse('2026-10-22T10:00:00+08:00');
let sequence = 0;
function fixture() {
  let now = START, version = 1, usable = true;
  const calls = [], runtimeId = `prepared-entry-${++sequence}`;
  const bars = Array.from({ length: 80 }, (_, index) => ({
    date: new Date(Date.parse('2026-10-21') - (79 - index) * 86400000).toISOString().slice(0, 10),
    open: 10, close: 10, high: 10.2, low: 9.8, volume: 10000
  }));
  const history = prepareHistory(SYMBOL, 'stock', { symbol: SYMBOL, bars, source: '隔离测试行情', provider: 'test', adjustment: '未复权', fetchedAt: START - 3600000 }, START);
  history.dailyEvidence.runtimeId = runtimeId;
  registerDailyRevision(runtimeId, 'stock', SYMBOL, history.dailyEvidence.barsHash);
  const research = {
    cache: new Map(),
    noticeVersion: () => ({ version, usable }),
    getFinanceWithIndustry: async () => {
      calls.push('finance');
      return { symbol: SYMBOL, section: 'finance', status: 'ready', fetchedAt: now, data: { latest: { reportDate: '2026-06-30', profit: 100 } },
        industryProfile: { symbol: SYMBOL, section: 'profile', status: 'ready', fetchedAt: now, data: { industry: '食品饮料' } } };
    },
    get: async ({ section }) => {
      calls.push(section);
      return { symbol: SYMBOL, section, status: section === 'notices' ? 'empty' : 'ready', fetchedAt: now,
        ...(section === 'notices' ? { noticeVersion: version, data: { items: [], total: 0 } } : { data: { quoteTime: now, pe: 20 } }) };
    }
  };
  const corporate = { symbols: () => [SYMBOL], fromDate: () => '2026-10-08', latestEvidence: new Map(), getSnapshot: async () => {
    calls.push('corporate');
    const value = { symbol: SYMBOL, status: 'ready', fetchedAt: now, coverageStart: '2026-10-08', coverageEnd: '2026-10-22', coverageComplete: true, events: [] };
    corporate.latestEvidence.set(SYMBOL, value);
    return value;
  } };
  const monitor = new StrategyMonitor({ strategyHistory: async () => { calls.push('daily'); return history; } }, () => new Date(now), () => {}, research, corporate);
  return { monitor, research, corporate, calls, history, now: () => now, advance: ms => { now += ms; },
    noticeState: (nextVersion, nextUsable = true) => { version = nextVersion; usable = nextUsable; },
    reviseDaily: () => registerDailyRevision(runtimeId, 'stock', SYMBOL, 'f'.repeat(64)) };
}

test('未准备资料同步拒绝开仓，不触发历史、研究或公司行为请求', () => {
  const f = fixture();
  assert.throws(() => f.monitor.readPrepared(SYMBOL, true, true), /尚未准备/);
  assert.throws(() => f.monitor.assertPrepared(SYMBOL, null, true, true), /尚未准备/);
  assert.deepEqual(f.calls, []);
});

test('准备成功后本地读取与提交核验零请求，快照独立且保留真实时间', async () => {
  const f = fixture(), original = await f.monitor.prepare(SYMBOL, true, true), initialCalls = [...f.calls];
  f.advance(1000);
  const held = f.monitor.readPrepared(SYMBOL, true, true);
  assert.deepEqual(held, original); assert.notEqual(held, original); assert.notEqual(held.finance, original.finance);
  assert.equal(held.fetchedAt, START - 3600000); assert.equal(held.notices.fetchedAt, START);
  assert.equal(f.monitor.assertPrepared(SYMBOL, held, true, true), held);
  held.finance.data.latest.profit = 999;
  assert.equal(original.finance.data.latest.profit, 100);
  assert.throws(() => f.monitor.assertPrepared(SYMBOL, held, true, true), /资料发生变化/);
  assert.deepEqual(f.calls, initialCalls);
});

test('开仓持有快照逐项遵守日线、财务、行业、估值、公告和公司行为有效期', async t => {
  for (const [name, invalidate] of [
    ['日线证据', value => { value.dailyEvidence = null; }],
    ['财务', value => { value.finance.fetchedAt = START - 21600001; }],
    ['行业', value => { value.finance.industryProfile.fetchedAt = START - 86400001; }],
    ['估值获取时间', value => { value.valuation.fetchedAt = START - 90001; }],
    ['估值报价时间', value => { value.valuation.data.quoteTime = START - 90001; }],
    ['公告', value => { value.notices.fetchedAt = START - 300001; }],
    ['公司行为时间', value => { value.corporateActions.fetchedAt = START - 300001; }],
    ['公司行为覆盖日期', value => { value.corporateActions.coverageEnd = '2026-10-21'; }]
  ]) await t.test(name, async () => {
    const f = fixture(); await f.monitor.prepare(SYMBOL, true, true);
    const held = f.monitor.readPrepared(SYMBOL, true, true), calls = [...f.calls];
    invalidate(held);
    assert.throws(() => f.monitor.assertPrepared(SYMBOL, held, true, true), /开仓资料未就绪/);
    assert.deepEqual(f.calls, calls);
  });
});

test('旧快照过期、隔夜或已知日线版本修正后同步拒绝，不自动刷新补齐', async t => {
  for (const [name, invalidate] of [
    ['估值在等待报价时过期', f => f.advance(90001)],
    ['跨到下一交易日', f => f.advance(86400000)],
    ['日线后台更正', f => f.reviseDaily()],
    ['准备资格撤销', f => { delete f.monitor.snapshots[SYMBOL]; }]
  ]) await t.test(name, async () => {
    const f = fixture(); await f.monitor.prepare(SYMBOL, true, true);
    const held = f.monitor.readPrepared(SYMBOL, true, true), calls = [...f.calls];
    invalidate(f);
    assert.throws(() => f.monitor.assertPrepared(SYMBOL, held, true, true), /开仓资料未就绪/);
    assert.throws(() => f.monitor.readPrepared(SYMBOL, true, true), /开仓资料未就绪/);
    assert.deepEqual(f.calls, calls);
  });
});

test('后台同内容续期允许仍有效的旧快照，不能把新获取时间移植给旧快照', async () => {
  const f = fixture(); await f.monitor.prepare(SYMBOL, true, true);
  const held = f.monitor.readPrepared(SYMBOL, true, true), initial = structuredClone(held), calls = [...f.calls];
  f.advance(1000);
  const renewed = structuredClone(held);
  for (const response of [renewed, renewed.dailyEvidence, renewed.finance, renewed.finance.industryProfile, renewed.valuation, renewed.notices, renewed.corporateActions]) {
    response.fetchedAt = f.now(); response.checkedAt = f.now(); response.cached = false; response.acquisition = { duration: 20 };
  }
  f.monitor.snapshots[SYMBOL] = renewed;
  f.corporate.latestEvidence.set(SYMBOL, renewed.corporateActions);
  assert.equal(f.monitor.assertPrepared(SYMBOL, held, true, true), held);
  assert.deepEqual(held, initial); assert.deepEqual(f.calls, calls);
  f.advance(89001);
  assert.throws(() => f.monitor.assertPrepared(SYMBOL, held, true, true), /估值行情已过期/);
});

test('公告版本变化或最新查新失败立即撤销旧快照，即使监控批次尚未发布', async () => {
  for (const [version, usable] of [[2, true], [1, false]]) {
    const f = fixture(); await f.monitor.prepare(SYMBOL, true, true);
    const held = f.monitor.readPrepared(SYMBOL, true, true), calls = [...f.calls];
    f.noticeState(version, usable);
    assert.throws(() => f.monitor.assertPrepared(SYMBOL, held, true, true), /公告目录已变化或最新查新失败/);
    assert.deepEqual(f.calls, calls);
  }
});

test('公司行为最新条款变化或查新失败立即撤销旧快照，同内容续期保持可用', async () => {
  const f = fixture(); await f.monitor.prepare(SYMBOL, true, true);
  const held = f.monitor.readPrepared(SYMBOL, true, true), calls = [...f.calls];
  f.advance(1000);
  f.corporate.latestEvidence.set(SYMBOL, { ...held.corporateActions, fetchedAt: f.now() });
  assert.equal(f.monitor.assertPrepared(SYMBOL, held, true, true), held);
  for (const update of [{ status: 'unavailable', error: '查新失败' }, { events: [{ eventId: 'corrected-cash', cashPerShare: 1 }] }]) {
    f.corporate.latestEvidence.set(SYMBOL, { ...held.corporateActions, ...update, fetchedAt: f.now() });
    assert.throws(() => f.monitor.assertPrepared(SYMBOL, held, true, true), /公司行为资料/);
  }
  assert.deepEqual(f.calls, calls);
});

test('已发布财务失败或新财报待同步拒绝旧决定，不借仍有效的旧财务放行', async () => {
  for (const update of [value => { value.finance = { ...value.finance, status: 'unavailable', error: '财务接口失败' }; },
    value => { value.financeReportSync = { status: 'pending' }; }, value => { value.finance.data.latest.profit = 1; }]) {
    const f = fixture(); await f.monitor.prepare(SYMBOL, true, true);
    const held = f.monitor.readPrepared(SYMBOL, true, true), current = structuredClone(held), calls = [...f.calls];
    update(current); f.monitor.snapshots[SYMBOL] = current;
    assert.throws(() => f.monitor.assertPrepared(SYMBOL, held, true, true), /开仓资料未就绪/);
    assert.deepEqual(f.calls, calls);
  }
});

test('独立财务行业或估值查新已完成时，不等监控慢批次发布就撤销失效依据', async () => {
  for (const section of ['finance', 'profile', 'valuation']) {
    const f = fixture(); await f.monitor.prepare(SYMBOL, true, true);
    const held = f.monitor.readPrepared(SYMBOL, true, true), calls = [...f.calls];
    const latest = structuredClone(section === 'profile' ? held.finance.industryProfile : held[section]);
    if (section === 'finance') delete latest.industryProfile;
    latest.fetchedAt += 1000; latest.checkedAt = latest.fetchedAt; f.advance(1000);
    f.research.cache.set(`${SYMBOL}:${section}`, latest);
    assert.equal(f.monitor.assertPrepared(SYMBOL, held, true, true), held);
    latest.status = 'stale'; latest.error = '独立刷新失败';
    assert.throws(() => f.monitor.assertPrepared(SYMBOL, held, true, true), /最新获取失败/);
    latest.status = 'ready'; delete latest.error; latest.data.corrected = true;
    assert.throws(() => f.monitor.assertPrepared(SYMBOL, held, true, true), /资料发生变化/);
    assert.deepEqual(f.calls, calls);
  }
});

test('个人条件按实际指标与经营研究路径选择财务或估值，不隐含行业要求', () => {
  const saved = input => createEntryConditions(input, new Date(START));
  const none = { finance: false, valuation: false, industry: false }, financeOnly = { ...none, finance: true }, valuationOnly = { ...none, valuation: true };
  assert.deepEqual(entryConditionDataRequirements(null), none);
  assert.deepEqual(entryConditionDataRequirements({ version: 99 }), none);
  for (const field of ['roe', 'revenueYoY', 'annualRoeAverage']) {
    const conditions = saved({ rules: [{ field, op: 'gte', value: 10 }] });
    assert.deepEqual(entryConditionDataRequirements(conditions), financeOnly);
    assert.equal(entryConditionNeedsFundamentals(conditions), true);
  }
  for (const field of ['pe', 'pb', 'marketCap', 'floatCap'])
    assert.deepEqual(entryConditionDataRequirements(saved({ rules: [{ field, op: 'lte', value: 100 }] })), valuationOnly);
  assert.deepEqual(entryConditionDataRequirements(saved({ rules: [{ field: 'ma20', op: 'gt', valueField: 'ma60' }] })), none);
  assert.deepEqual(entryConditionDataRequirements(saved({ rules: [{ field: 'roe', op: 'gte', value: 10 }, { field: 'pe', op: 'lte', value: 25 }] })), { finance: true, valuation: true, industry: false });
  assert.deepEqual(entryConditionDataRequirements(saved({ research: { version: 1, enabled: true, path: 'company', rules: [{ field: 'revenueYoY', op: 'gt', value: 0 }] } })), financeOnly);
  assert.deepEqual(entryConditionDataRequirements(saved({ research: { version: 1, enabled: true, path: 'product', rules: [{ field: 'currentRevenue', op: 'gt', value: 0 }] } })), none);
});

test('仅 ROE 条件的波段股不因无关估值或行业失败而失去准备资格', async () => {
  const f = fixture(), current = await f.monitor.prepare(SYMBOL, true, true), calls = [...f.calls];
  const conditions = createEntryConditions({ rules: [{ field: 'roe', op: 'gte', value: 10 }] }, new Date(START));
  const required = entryConditionDataRequirements(conditions);
  current.finance.source = '东方财富';
  Object.assign(current.finance.data.latest, { roe: 12, noticeDate: '2026-08-15', updateDate: '2026-08-15', currency: 'CNY' });
  current.finance.industryProfile = { status: 'unavailable', error: '行业接口失败' };
  current.valuation = { status: 'unavailable', error: '估值接口失败' };
  const held = f.monitor.readPrepared(SYMBOL, required, true);
  assert.equal(evaluateEntryConditions(conditions, SYMBOL, { symbol: SYMBOL, timestamp: START, date: '2026-10-22' }, held, new Date(START)).passed, true);
  current.finance.industryProfile = { status: 'unavailable', error: '行业再次失败' };
  f.research.cache.set(`${SYMBOL}:profile`, { status: 'stale', error: '行业查新失败' });
  f.research.cache.set(`${SYMBOL}:valuation`, { status: 'stale', error: '估值查新失败' });
  assert.equal(f.monitor.assertPrepared(SYMBOL, held, required, true), held);
  current.finance.data.latest.roe = 5;
  assert.throws(() => f.monitor.assertPrepared(SYMBOL, held, required, true), /资料发生变化/);
  assert.deepEqual(f.calls, calls);
});

test('仅估值条件使用有效估值时无需财务或行业，财报同步不阻塞无关条件', async () => {
  const f = fixture(), current = await f.monitor.prepare(SYMBOL, true, true), calls = [...f.calls];
  const conditions = createEntryConditions({ rules: [{ field: 'pe', op: 'lte', value: 25 }] }, new Date(START));
  const required = entryConditionDataRequirements(conditions);
  current.valuation.source = '东方财富'; current.finance = { status: 'unavailable', error: '财务接口失败' };
  current.financeReportSync = { status: 'pending' };
  const held = f.monitor.readPrepared(SYMBOL, required, true);
  assert.equal(evaluateEntryConditions(conditions, SYMBOL, { symbol: SYMBOL, timestamp: START, date: '2026-10-22' }, held, new Date(START)).passed, true);
  f.research.cache.set(`${SYMBOL}:finance`, { status: 'stale', error: '财务独立查新失败' });
  assert.equal(f.monitor.assertPrepared(SYMBOL, held, required, true), held);
  f.research.cache.set(`${SYMBOL}:valuation`, { ...current.valuation, data: { ...current.valuation.data, pe: 30 } });
  assert.throws(() => f.monitor.assertPrepared(SYMBOL, held, required, true), /资料发生变化/);
  assert.deepEqual(f.calls, calls);
});

test('长期策略保留三类资料完整要求，布尔 true 与显式要求一致', async t => {
  for (const [name, invalidate] of [
    ['财务', value => { value.finance.status = 'unavailable'; }],
    ['估值', value => { value.valuation.status = 'unavailable'; }],
    ['行业', value => { value.finance.industryProfile.status = 'unavailable'; }]
  ]) await t.test(name, async () => {
    const f = fixture(), current = await f.monitor.prepare(SYMBOL, true, true), calls = [...f.calls];
    const required = { finance: true, valuation: true, industry: true };
    assert.deepEqual(f.monitor.readPrepared(SYMBOL, true, true), f.monitor.readPrepared(SYMBOL, required, true));
    invalidate(current);
    assert.throws(() => f.monitor.readPrepared(SYMBOL, true, true), /开仓资料未就绪/);
    assert.throws(() => f.monitor.readPrepared(SYMBOL, required, true), /开仓资料未就绪/);
    assert.deepEqual(f.calls, calls);
  });
});
