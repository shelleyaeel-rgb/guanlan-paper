'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEntryConditions, validEntryConditions, entryConditionNeedsFundamentals, evaluateEntryConditions } = require('../core/entry-conditions.cjs');

const NOW = new Date('2026-10-09T10:00:00+08:00'), SYMBOL = 'sz000001';
const rules = (...values) => createEntryConditions({ rules: values }, NOW);
const numeric = (field, op, value) => ({ field, op, value });
const quote = (changes = {}) => ({ symbol: SYMBOL, name: '测试股票', timestamp: NOW.getTime(), date: '2026-10-09', price: 10.1, prevClose: 10, changePct: 1, turnover: 2, amount: 200000000, volume: 3000000, ...changes });
const annual = (year, changes = {}) => ({ reportDate: `${year}-12-31`, noticeDate: `${year + 1}-04-15`, updateDate: `${year + 1}-04-15`, currency: 'CNY', roe: 12, adjustedProfit: 100000000, operatingCash: 200000000, ...changes });
const finance = (changes = {}) => ({ symbol: SYMBOL, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: NOW.getTime(), data: {
  latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', updateDate: '2026-08-15', currency: 'CNY', roe: 11, debtRatio: 50, revenueYoY: 12, profitYoY: -4, adjustedProfitYoY: 6, adjustedProfit: 200000000, operatingCash: 500000000 }, annual: [annual(2025), annual(2024), annual(2023)] }, ...changes });
const snapshot = (changes = {}) => ({ fetchedAt: NOW.getTime(), technical: { asOf: '2026-10-08', close: 10, ma5: 10, ma20: 9.8, ma60: 9.7, previousMa5: 9.9, previousMa20: 9.7, previousMa60: 9.6, macd: 0.1, rsi: 55, volumeRatio: 1.2, dates: ['2026-10-08'] }, finance: finance(), ...changes });
const metrics = (changes = {}) => ({ symbol: SYMBOL, timestamp: NOW.getTime(), source: '腾讯财经', price: 10.1, changePct: 1, turnover: 2, amount: 2, volume: 3, pe: 18, pb: 2, volumeRatio: 1.5, amplitude: 3, marketCap: 100, floatCap: 80, ...changes });
const assess = (saved, q = quote(), snap = snapshot(), now = NOW) => evaluateEntryConditions(saved, SYMBOL, q, snap, now);
const demandRecord = (changes = {}) => ({ symbol: SYMBOL, kind: 'demand', subject: '产品A', value: 'supported', reviewState: 'confirmed', sourceTitle: '年度报告', url: 'https://example.com/report', period: '2025年度', quote: '产品需求持续增长', publishedAt: '2026-04-01', reviewedAt: '2026-09-01', validUntil: '2026-12-31', notes: '', ...changes });

test('加入时保存不可变谓词，范围不成为开仓门槛，重复保存保留原始时间', () => {
  const input = { scope: 'watchlist', boards: ['sh'], rules: [numeric('roe', 'gt', 10)], excludeST: true, evidence: { conditions: ['demand'] }, source: { queryAt: '2026-10-09', labels: ['测试'] } };
  const saved = createEntryConditions(input, NOW);
  input.rules[0].value = 1; input.evidence.conditions.push('advantage'); input.source.labels.push('变化');
  assert.equal(saved.version, 1); assert.equal(saved.rules[0].value, 10); assert.deepEqual(saved.evidence.conditions, ['demand']);
  assert.deepEqual(saved.source.labels, ['测试']); assert.equal(saved.scope, undefined); assert.equal(saved.boards, undefined);
  assert.ok(Object.isFrozen(saved.rules[0])); assert.ok(Object.isFrozen(saved.evidence.conditions));
  assert.throws(() => { saved.rules[0].value = 0; }, TypeError);
  assert.equal(validEntryConditions(saved), true); assert.equal(saved.savedAt, NOW.toISOString());
  const again = createEntryConditions(saved, new Date(NOW.getTime() + 1000));
  assert.deepEqual(again, saved); assert.notEqual(again, saved);
  assert.equal(createEntryConditions({ scope: 'all', boards: ['sh'], rules: [] }, NOW), null);
  assert.equal(validEntryConditions(null), true); assert.equal(assess(null).passed, true);
});

test('无效版本、未知字段、标签被篡改及非数值门槛不能静默丢失约束', () => {
  for (const input of [false, [], { rules: null }, { excludeST: null }, { mysterious: 1 }, { rules: [numeric('notAField', 'gt', 1)] }, { rules: [numeric('roe', 'oops', 1)] }, { rules: [numeric('roe', 'gt', '10')] }, { rules: [{ ...numeric('roe', 'gt', 10), optional: true }] }, { rules: [{ field: 'price', op: 'gte', valueField: 'ma20' }] }, { evidence: { conditions: ['unknown'] } }]) assert.throws(() => createEntryConditions(input, NOW));
  for (const change of [{ version: 2 }, { rules: [numeric('unknown', 'gt', 10)] }, { labels: ['伪造展示'] }, { excludeST: 'false' }, { savedAt: '2026-02-30' }, { ignoreFailure: true }]) {
    const invalid = { ...structuredClone(rules(numeric('roe', 'gt', 10))), ...change };
    assert.equal(validEntryConditions(invalid), false); assert.equal(assess(invalid).passed, false); assert.equal(assess(invalid).status, 'pending');
    assert.throws(() => createEntryConditions(invalid, NOW));
  }
  assert.equal(assess({ rules: [() => true] }).passed, false);
});

test('财务阈值边界与新报告变化逐次重新判断，负值不会补成零', () => {
  const saved = rules(numeric('roe', 'gt', 10), numeric('revenueYoY', 'gte', 12), numeric('profitYoY', 'lt', 0));
  assert.equal(entryConditionNeedsFundamentals(saved), true); assert.equal(assess(saved).passed, true);
  const changed = snapshot(); changed.finance.data.latest.roe = 10;
  const result = assess(saved, quote(), changed); assert.equal(result.status, 'failed'); assert.match(result.reasons[0], /当前 10 %.*> 10 %/);
  changed.finance.data.latest.roe = 9; assert.equal(assess(saved, quote(), changed).passed, false);
  changed.finance.data.latest.roe = null; assert.equal(assess(saved, quote(), changed).status, 'pending');
  assert.equal(saved.rules[0].value, 10);
});

test('财务身份、获取时间、报告日期与人民币金额缺失均拒绝判断', () => {
  const roe = rules(numeric('roe', 'gte', 10)), cash = rules(numeric('operatingCash', 'gt', 4.9));
  assert.equal(assess(cash).passed, true);
  for (const changes of [{ source: '未知' }, { symbol: 'sh600001' }, { section: 'valuation' }, { status: 'stale' }, { error: '断线' }, { fetchedAt: NOW.getTime() + 1 }, { fetchedAt: NOW.getTime() - 21600001 }]) assert.equal(assess(roe, quote(), snapshot({ finance: finance(changes) })).status, 'pending', JSON.stringify(changes));
  for (const changes of [{ currency: null }, { currency: 'USD' }, { operatingCash: null }]) {
    const s = snapshot(); Object.assign(s.finance.data.latest, changes); assert.equal(assess(cash, quote(), s).status, 'pending');
  }
  for (const changes of [{ noticeDate: '2026-10-10' }, { noticeDate: null }, { reportDate: '2026-02-30' }, { updateDate: '2026-10-10' }]) {
    const s = snapshot(); Object.assign(s.finance.data.latest, changes); assert.equal(assess(roe, quote(), s).status, 'pending');
  }
  assert.equal(assess(roe, quote(), snapshot({ finance: finance({ fetchedAt: NOW.getTime() - 21600000 }) })).passed, true);
});

test('年度指标复用连续完整年报和新鲜度规则，不用季度指标填补', () => {
  const saved = rules(numeric('annualProfitableYears', 'eq', 3), numeric('annualRoeAverage', 'gte', 12), numeric('annualRoeLatest', 'gte', 12), numeric('annualCashPositiveYears', 'eq', 3), numeric('annualCashSum', 'eq', 6), numeric('latestAdjustedProfit', 'eq', 2));
  assert.equal(assess(saved).passed, true);
  for (const reports of [[annual(2025), annual(2023), annual(2022)], [annual(2024), annual(2023), annual(2022)], [annual(2025), annual(2024)], [annual(2025), annual(2024), annual(2023, { currency: 'USD' })], [annual(2025), annual(2024), annual(2023, { operatingCash: null })]]) {
    const s = snapshot(); s.finance.data.annual = reports; assert.equal(assess(saved, quote(), s).status, 'pending');
  }
  const s = snapshot(); s.finance.data.annual[0].roe = 9;
  assert.equal(assess(saved, quote(), s).status, 'failed');
});

test('完整日线值和字段比较逐次检查，日量比与快照量比分离', () => {
  const saved = rules({ field: 'ma20', op: 'gte', valueField: 'ma60' }, { field: 'ma60', op: 'gt', valueField: 'previousMa60' }, numeric('rsi', 'lte', 55), numeric('macd', 'gt', 0), numeric('dailyVolumeRatio', 'gte', 1.2), numeric('volumeRatio', 'gte', 1.5));
  const q = quote({ screeningMetrics: metrics() }); assert.equal(assess(saved, q).passed, true);
  assert.equal(entryConditionNeedsFundamentals(saved), false);
  const s = snapshot(); s.technical.volumeRatio = 1.19; assert.equal(assess(saved, q, s).status, 'failed');
  s.technical.volumeRatio = 1.2; q.screeningMetrics.volumeRatio = 1.49; assert.equal(assess(saved, q, s).status, 'failed');
  const comparison = rules({ field: 'ma20', op: 'gt', valueField: 'ma60' }); s.technical.ma20 = s.technical.ma60;
  assert.equal(assess(comparison, quote(), s).status, 'failed');
  s.technical.ma20 = null; assert.equal(assess(comparison, quote(), s).status, 'pending');
});

test('日线过期、未收盘K线、无效日期或除权后基准错配拒绝通过', () => {
  const saved = rules(numeric('ma20', 'gt', 9));
  for (const changes of [{ fetchedAt: NOW.getTime() - 180001 }, { fetchedAt: NOW.getTime() + 1 }, { error: '断线' }]) assert.equal(assess(saved, quote(), snapshot(changes)).status, 'pending');
  for (const changes of [{ asOf: '2026-10-09' }, { asOf: '2026-10-10' }, { asOf: '2026-02-30' }, { close: 20 }, { dates: ['2026-10-10'] }]) {
    const s = snapshot(); Object.assign(s.technical, changes); assert.equal(assess(saved, quote(), s).status, 'pending');
  }
  assert.equal(assess(saved, quote(), snapshot({ fetchedAt: NOW.getTime() - 180000 })).passed, true);
});

test('行情金额与成交量单位正确换算，零涨跌幅可用，缺失不补零', () => {
  const saved = rules(numeric('amount', 'eq', 2), numeric('volume', 'eq', 3), numeric('changePct', 'eq', 0));
  assert.equal(assess(saved, quote({ changePct: 0 })).passed, true);
  assert.equal(assess(saved, quote({ changePct: null })).status, 'pending');
  assert.equal(assess(rules(numeric('amount', 'lte', 2)), quote({ amount: undefined })).status, 'pending');
  for (const changes of [{ timestamp: NOW.getTime() - 90001 }, { timestamp: NOW.getTime() + 1 }, { date: '2026-10-08' }, { symbol: 'sh600001' }]) assert.equal(assess(rules(numeric('price', 'gt', 1)), quote(changes)).status, 'pending');
  assert.equal(assess(rules(numeric('price', 'gt', 1)), quote({ timestamp: NOW.getTime() - 90000 })).passed, true);
});

test('动态估值取同一报价的筛选指标，不能使用普通quote.pe冒充', () => {
  const saved = rules(numeric('pe', 'lt', 20), numeric('pb', 'lte', 2), numeric('marketCap', 'gte', 100));
  assert.equal(assess(saved, quote({ pe: 10 })).status, 'pending');
  assert.equal(assess(saved, quote({ pe: 99, screeningMetrics: metrics() })).passed, true);
  assert.equal(assess(saved, quote({ screeningMetrics: metrics({ pe: 21 }) })).status, 'failed');
  for (const changes of [{ source: '未知' }, { source: '' }, { timestamp: NOW.getTime() - 1 }, { symbol: 'sh600001' }]) assert.equal(assess(saved, quote({ screeningMetrics: metrics(changes) })).status, 'pending');
  const valuation = { symbol: SYMBOL, section: 'valuation', source: '东方财富', status: 'ready', fetchedAt: NOW.getTime(), data: { pe: 18, pb: 2, marketCap: 10000000000, quoteTime: NOW.getTime() } };
  assert.equal(assess(saved, quote(), snapshot({ valuation })).passed, true);
  assert.equal(assess(saved, quote({ screeningMetrics: metrics({ pe: null }) }), snapshot({ valuation })).status, 'pending');
  for (const changes of [{ fetchedAt: NOW.getTime() - 90001 }, { source: '未知' }, { data: { ...valuation.data, quoteTime: NOW.getTime() - 90001 } }]) assert.equal(assess(saved, quote(), snapshot({ valuation: { ...valuation, ...changes } })).status, 'pending');
});

test('科创板缺少专用筛选量时不采用交易quote的旧成交量单位', () => {
  const saved = rules(numeric('volume', 'gt', 10)), symbol = 'sh688001';
  const q = quote({ symbol, volume: 12345600 });
  const missing = evaluateEntryConditions(saved, symbol, q, snapshot(), NOW);
  assert.equal(missing.status, 'pending'); assert.match(missing.reasons.join('；'), /科创板成交量单位未核验/);
  q.screeningMetrics = metrics({ symbol, volume: 0.123456 });
  assert.equal(evaluateEntryConditions(saved, symbol, q, snapshot(), NOW).status, 'failed');
  q.screeningMetrics.volume = 11;
  assert.equal(evaluateEntryConditions(saved, symbol, q, snapshot(), NOW).status, 'pass');
});

test('加入时只冻结研究查询，当前证据撤销、过期、缺失或跨股票时阻止新仓', () => {
  const saved = createEntryConditions({ evidence: { conditions: ['demand'] } }, NOW);
  const current = records => snapshot({ selectionEvidence: { records, checkedAt: NOW.getTime() } });
  assert.equal(assess(saved, quote(), current([demandRecord()])).passed, true);
  assert.equal(assess(saved, quote(), current([demandRecord({ value: 'unsupported' })])).status, 'failed');
  for (const records of [[], [demandRecord({ validUntil: '2026-10-08' })], [demandRecord({ reviewState: 'draft' })], [demandRecord({ symbol: 'sh600001' })]]) assert.equal(assess(saved, quote(), current(records)).status, 'pending');
  assert.equal(assess(saved).status, 'pending');
  assert.equal(assess(saved, quote(), snapshot({ selectionEvidence: { records: [demandRecord()], checkedAt: NOW.getTime() - 90001 } })).status, 'pending');
  assert.equal(assess(saved, quote(), snapshot({ selectionEvidence: { records: [demandRecord()], checkedAt: NOW.toISOString() } })).passed, true);
});

test('排除ST持续核验当前名称，评估结果是独立副本且不修改调用方', () => {
  const saved = createEntryConditions({ excludeST: true }, NOW), q = quote(), s = snapshot(), before = structuredClone({ saved, q, s });
  const result = assess(saved, q, s); assert.equal(result.passed, true);
  assert.deepEqual({ saved, q, s }, before); result.conditions.labels.push('外部修改'); assert.notDeepEqual(result.conditions, saved);
  assert.equal(assess(saved, quote({ name: '*ST测试' })).status, 'failed');
  assert.equal(assess(saved, quote({ name: '退市测试' })).status, 'failed');
  assert.equal(assess(saved, quote({ name: '' })).status, 'pending');
});
