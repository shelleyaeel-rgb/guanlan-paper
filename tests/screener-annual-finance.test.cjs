const test = require('node:test');
const assert = require('node:assert/strict');
const { Screener, defaults, parseDescription, financialQualityRules } = require('../core/screener.cjs');
const now = new Date('2026-10-08T10:00:00+08:00');
const annual = (year, extra = {}) => ({ reportDate: `${year}-12-31`, noticeDate: `${year + 1}-03-30`, updateDate: `${year + 1}-04-01`, currency: 'CNY', roe: 12, adjustedProfit: 2e8, operatingCash: 3e8, ...extra });
function report(extra = {}) {
  return { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', currency: 'CNY', roe: 3, debtRatio: 50, adjustedProfit: 1e8, adjustedProfitYoY: -90, operatingCash: 0.1e8 }, annual: [annual(2025), annual(2024), annual(2023)], ...extra };
}
function scanner(data, date = now) {
  const service = new Screener(null, null, null, () => date, symbol => ({ symbol, section: 'finance', status: 'ready', fetchedAt: date.getTime(), source: '东方财富', data }));
  service.snapshot = { rows: [{ symbol: 'sh600001', name: '隔离样本', board: 'sh', isST: false, price: 10 }], fetchedAt: date.getTime() };
  service.load = async () => service.snapshot;
  return service;
}
const query = (field, op = 'gt', value = 0) => ({ ...defaults(), rules: [{ field, op, value }] });

test('三年财务使用连续完整年报，最新季度 ROE 和同比不能替代年度或扣非金额', async () => {
  const data = report(), before = structuredClone(data), service = scanner(data);
  const result = await service.run({ ...defaults(), rules: financialQualityRules() }, []);
  assert.equal(result.matched, 1);
  const row = result.rows[0];
  assert.equal(row.annualProfitableYears, 3); assert.equal(row.annualRoeAverage, 12); assert.equal(row.annualRoeLatest, 12);
  assert.equal(row.annualCashPositiveYears, 3); assert.equal(row.annualCashSum, 9); assert.equal(row.latestAdjustedProfit, 1);
  assert.equal(row.roe, 3); assert.equal(row.adjustedProfitYoY, -90); assert.equal(row.financeAnnualStatus, 'ready');
  assert.deepEqual(row.financeAnnualReports.map(item => item.reportDate), ['2025-12-31', '2024-12-31', '2023-12-31']);
  assert.equal(row.financeAnnualReports[0].noticeDate, '2026-03-30');
  assert.deepEqual(data, before); assert.equal(service.snapshot.rows[0].annualProfitableYears, undefined);
  assert.equal((await service.run(query('roe', 'gte', 8), [])).matched, 0);
  assert.equal((await service.run(query('adjustedProfitYoY'), [])).matched, 0);
});

test('缺年、重复年、季度冒充年报、未来或无公告时点均不能计算三年指标', async () => {
  const changes = [
    [annual(2025), annual(2023), annual(2022)], [annual(2025), annual(2024)],
    [annual(2025), annual(2024), annual(2024)], [annual(2025), annual(2024), annual(2023, { reportDate: '2023-09-30' })],
    [annual(2025), annual(2024), annual(2023, { noticeDate: null })],
    [annual(2025), annual(2024), annual(2023, { noticeDate: '2026-10-09' })],
    [annual(2025), annual(2024), annual(2023, { noticeDate: '2023-12-30' })],
    [annual(2025), annual(2024), annual(2023, { updateDate: '2026-10-09' })],
    [annual(2026), annual(2025), annual(2024)]
  ];
  for (const reports of changes) {
    const result = await scanner(report({ annual: reports })).run(query('annualRoeAverage', 'gte', 0), []);
    assert.equal(result.status, 'unavailable', JSON.stringify(reports)); assert.equal(result.matched, null);
    assert.equal(result.missingByField.annualRoeAverage, 1); assert.equal(result.partial, true);
  }
});

test('年度金额缺失不能补零，非人民币金额不能参与扣非盈利和现金流统计', async () => {
  for (const changed of [{ adjustedProfit: null }, { adjustedProfit: '' }, { currency: 'USD' }, { currency: null }]) {
    const result = await scanner(report({ annual: [annual(2025), annual(2024, changed), annual(2023)] })).run(query('annualProfitableYears', 'gte', 0), []);
    assert.equal(result.matched, null); assert.equal(result.missingByField.annualProfitableYears, 1);
  }
  const cashMissing = scanner(report({ annual: [annual(2025), annual(2024, { operatingCash: null }), annual(2023)] }));
  assert.equal((await cashMissing.run(query('annualCashSum', 'gte', 0), [])).status, 'unavailable');
  assert.equal((await cashMissing.run(query('annualCashPositiveYears', 'gte', 0), [])).status, 'unavailable');
  assert.equal((await cashMissing.run(query('annualProfitableYears', 'gte', 3), [])).matched, 1);
  const roeMissing = scanner(report({ annual: [annual(2025), annual(2024, { roe: null }), annual(2023)] }));
  assert.equal((await roeMissing.run(query('annualRoeAverage'), [])).status, 'unavailable');
  assert.equal((await roeMissing.run(query('annualRoeLatest'), [])).matched, 1);
});

test('年度盈利与现金流保留零和负值，仅严格正数计入年数，三年合计允许负值', async () => {
  const data = report({ annual: [annual(2025, { adjustedProfit: 0, operatingCash: -8e8 }), annual(2024), annual(2023, { adjustedProfit: -1e8, operatingCash: 0 })] });
  const service = scanner(data);
  const result = await service.run({ ...defaults(), rules: [{ field: 'annualProfitableYears', op: 'eq', value: 1 }, { field: 'annualCashPositiveYears', op: 'eq', value: 1 }, { field: 'annualCashSum', op: 'eq', value: -5 }] }, []);
  assert.equal(result.matched, 1);
  assert.equal((await service.run({ ...defaults(), rules: financialQualityRules() }, [])).matched, 0);
});

test('最新扣非利润采用人民币金额并保留亏损，不把同比或缺失值当利润', async () => {
  for (const latestChange of [{ adjustedProfit: null }, { adjustedProfit: undefined }, { currency: 'USD' }, { currency: null }]) {
    const data = report(); Object.assign(data.latest, latestChange, { adjustedProfitYoY: 99 });
    assert.equal((await scanner(data).run(query('latestAdjustedProfit', 'gte', 0), [])).matched, null);
  }
  const data = report(); data.latest.adjustedProfit = -1e8; data.latest.adjustedProfitYoY = 99;
  assert.equal((await scanner(data).run(query('latestAdjustedProfit', 'eq', -1), [])).matched, 1);
});

test('年度新鲜度为产品规则：4月底前可用前年，5月起须上一年度，旧数据不默认可用', async () => {
  const data = report({ latest: { reportDate: '2025-09-30', noticeDate: '2025-10-25', currency: 'CNY' }, annual: [annual(2024), annual(2023), annual(2022)] });
  const april = await scanner(data, new Date('2026-04-30T23:59:00+08:00')).run(query('annualRoeAverage'), []);
  assert.equal(april.matched, 1);
  const may = await scanner(data, new Date('2026-05-01T00:00:00+08:00')).run(query('annualRoeAverage'), []);
  assert.equal(may.status, 'unavailable'); assert.equal(may.matched, null);
  const latest = await scanner(data, new Date('2026-05-01T00:00:00+08:00')).run(query('annualRoeLatest'), []);
  assert.equal(latest.status, 'unavailable');
});

test('最新年度ROE不要求凑齐三年，但季度报告永远不能替代缺失年报', async () => {
  const service = scanner(report({ annual: [annual(2025)] }));
  assert.equal((await service.run(query('annualRoeLatest'), [])).matched, 1);
  assert.equal((await service.run(query('annualRoeAverage'), [])).matched, null);
  const quarterly = scanner(report({ annual: [] }));
  assert.equal((await quarterly.run(query('annualRoeLatest'), [])).matched, null);
  assert.equal((await quarterly.run(query('roe'), [])).matched, 1);
});

test('年度字段文本保留明确年报口径与单位，不能将半年 ROE 年化', () => {
  const parsed = parseDescription('近三年扣非盈利年数至少3年，近三年平均年度ROE不低于10%，最近一年年度ROE不低于8%，近三年经营现金流为正年数至少2年，近三年经营现金流合计大于0亿元，最新报告期扣非净利润大于0亿元');
  assert.equal(parsed.query.rules.length, 6); assert.match(parsed.notes.join(''), /完整年报/); assert.match(parsed.notes.join(''), /不是交易所交易约束/);
  assert.throws(() => parseDescription('半年ROE年化大于10%'));
});
