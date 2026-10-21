'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { buildFinanceSnapshot, refreshFinanceSnapshot, minimumFinanceReportDate } = require('../core/finance-validity.cjs');
const { normalizeFinance, Screener, defaults } = require('../core/screener.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');
const symbol = 'sh600001', NOW = new Date('2026-10-15T10:00:00+08:00');
const annual = year => ({ reportDate: `${year}-12-31`, noticeDate: `${year + 1}-03-28`, currency: 'CNY', roe: 12, adjustedProfit: 1e8, operatingCash: 2e8 });
function response(now = NOW) { return { symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: +now, industryProfile: ordinaryProfile(symbol, now),
  data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-20', currency: 'CNY', roe: 2, debtRatio: 40, revenueYoY: 10, adjustedProfitYoY: 50, adjustedProfit: -1e8, operatingCash: 0 }, annual: [annual(2025)] } }; }
const notices = title => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW,
  data: { items: [{ id: 'AN20261013000001', date: '2026-10-13', title }], total: 1 } });

test('统一来源、身份、抓取六小时边界校验，失效值保留观察但不可参与比较', () => {
  for (const mutate of [r => { r.symbol = 'sh600002'; }, r => { r.section = 'valuation'; }, r => { r.source = '未知来源'; },
    r => { r.status = 'stale'; }, r => { r.fetchedAt = +NOW + 1; }, r => { r.fetchedAt = +NOW - 21600001; }]) {
    const data = response(); mutate(data);
    const row = buildFinanceSnapshot(data, symbol, NOW);
    assert.equal(row.annualRoeLatest, null); assert.equal(row.latestAdjustedProfit, null);
    assert.equal(row.financeFieldChecks.latestAdjustedProfit.rawValue, -1);
    assert.equal(row.financeFieldChecks.annualRoeLatest.status, 'pending');
    assert.throws(() => normalizeFinance(data, symbol, NOW));
  }
  const data = response(); data.fetchedAt = +NOW - 21600000;
  assert.equal(normalizeFinance(data, symbol, NOW).annualRoeLatest, 12);
});

test('累计报表日期无效不误伤独立年度，最新年度ROE不依赖三年链，零与负值不丢失', () => {
  const data = response(), before = structuredClone(data), row = normalizeFinance(data, symbol, NOW);
  assert.equal(row.annualRoeLatest, 12); assert.equal(row.annualRoeAverage, null);
  assert.equal(row.latestAdjustedProfit, -1); assert.equal(row.operatingCash, 0);
  assert.deepEqual(data, before);
  for (const change of [{ reportDate: '2020-12-31', noticeDate: '2021-03-28' }, { reportDate: '2026-02-30' },
    { reportDate: 20260630 }, { reportDate: 'bad-12-31' }, { reportDate: '2027-12-31', noticeDate: '2028-03-28' },
    { noticeDate: null }, { updateDate: '2026-01-01' }]) {
    const changed = structuredClone(data); Object.assign(changed.data.latest, change);
    const checked = normalizeFinance(changed, symbol, NOW);
    assert.equal(checked.annualRoeLatest, 12); assert.equal(checked.latestAdjustedProfit, null);
    assert.equal(checked.financeFieldChecks.latestAdjustedProfit.rawValue, -1);
  }
});

test('刷新保留扫描观察截止，跨日不能使初始未来报告生效，但必须执行发布日最低报告期', () => {
  const observed = new Date('2026-10-13T23:59:55+08:00'), finished = new Date('2026-10-14T00:00:05+08:00');
  const data = response(finished); data.data.latest.noticeDate = '2026-10-14';
  const row = normalizeFinance(data, symbol, observed, finished);
  const refreshed = refreshFinanceSnapshot(row, symbol, finished);
  assert.equal(refreshed.revenueYoY, null); assert.equal(refreshed.financeFieldChecks.revenueYoY.reasonCode, 'invalid');
  assert.equal(refreshed.financeObservedAt, +observed); assert.equal(refreshed.financeFieldChecks.revenueYoY.rawValue, 10);
  assert.equal(refreshed.annualRoeLatest, 12); assert.equal(normalizeFinance(data, symbol, finished).revenueYoY, 10);
  const deadline = new Date('2026-10-31T23:59:55+08:00'), cutoff = normalizeFinance(response(deadline), symbol, deadline);
  const expired = refreshFinanceSnapshot(cutoff, symbol, new Date('2026-11-01T00:00:05+08:00'));
  assert.equal(expired.revenueYoY, null); assert.equal(expired.financeFieldChecks.revenueYoY.reasonCode, 'stale-period');
  assert.equal(expired.annualRoeLatest, 12);
});

test('普通筛选和公司经营发布复核均使用新正式公告，预告与快报不替代财报', async () => {
  for (const title of ['2026年第三季度报告', '2026年前三季度业绩预告', '2026年前三季度业绩快报']) {
    for (const company of [false, true]) {
      const service = new Screener(null, null, null, () => NOW, async () => response(), async () => notices(title));
      service.noticeEvidenceLoader = async () => {
        const text = title.includes('快报')
          ? '本报告期指年初至本季度末9个月期间。\n单位：万元\n项目  本报告期  上年同期  增减变动幅度（%）\n归属于上市公司股东的净利润  110  100  10\n扣除非经常性损益后的净利润  105  100  5'
          : '业绩预告期间：2026年1月1日至2026年9月30日。\n项目  年初至报告期末  上年同期\n归属于上市公司股东的净利润  盈利：120万元  盈利：100万元\n比上年同期增长：20%\n扣除非经常性损益后的净利润  盈利：110万元  盈利：100万元\n比上年同期增长：10%\n二、与会计师事务所沟通情况\n本次业绩预告未经会计师事务所审计。';
        return { symbol, fetchedAt: +NOW, documents: [{ id: 'AN20261013000001', kind: 'notice', issuerSymbol: symbol, title,
          publishedAt: '2026-10-13', fetchedAt: +NOW, complete: true, text, pages: 1,
          url: 'https://data.eastmoney.com/notices/detail/600001/AN20261013000001.html',
          pageTexts: [{ page: 1, text, method: 'provider-text', numericEligible: true, complete: true }] }] };
      };
      service.load = async () => ({ rows: [{ symbol, name: '隔离正式报告测试', board: 'sh', price: 10, timestamp: +NOW }], fetchedAt: +NOW });
      const rule = { field: 'revenueYoY', op: 'gt', value: 0 }, query = { ...defaults(), rules: company ? [] : [rule],
        ...(company ? { research: { version: 1, enabled: true, path: 'company', rules: [rule] } } : {}) };
      const result = await service.run(query, [], false, null, 'swing');
      const formal = title === '2026年第三季度报告';
      assert.equal(result.status, formal ? 'unavailable' : 'ready', `${company}/${title}`);
      assert.equal(result.matched, formal ? null : 1, `${company}/${title}`);
      if (formal && company) assert.equal(result.researchPendingRows[0].researchReview.companyMetrics.metrics.revenueYoY.usable, false);
      if (formal && !company) assert.equal(result.financePendingRows[0].financeFieldChecks.revenueYoY.pendingReport.reportDate, '2026-09-30');
    }
  }
});

test('公司累计期和年度期独立下限，正式新期优先而预告不使半年报失效', () => {
  assert.equal(minimumFinanceReportDate('2026-04-30'), '2025-09-30'); assert.equal(minimumFinanceReportDate('2026-05-01'), '2026-03-31');
  assert.equal(minimumFinanceReportDate('2026-08-31'), '2026-03-31'); assert.equal(minimumFinanceReportDate('2026-09-01'), '2026-06-30');
  assert.equal(minimumFinanceReportDate('2026-10-31'), '2026-06-30'); assert.equal(minimumFinanceReportDate('2026-11-01'), '2026-09-30');
  assert.equal(minimumFinanceReportDate('2026-04-30', true), '2024-12-31'); assert.equal(minimumFinanceReportDate('2026-05-01', true), '2025-12-31');
  const old = buildFinanceSnapshot(response(), symbol, NOW, { notices: notices('2026年第三季度报告') });
  assert.equal(old.latestAdjustedProfit, null); assert.equal(old.financeFieldChecks.latestAdjustedProfit.pendingReport.reportDate, '2026-09-30');
  assert.equal(old.annualRoeLatest, 12);
  const forecast = buildFinanceSnapshot(response(), symbol, NOW, { notices: notices('2026年前三季度业绩预告') });
  assert.equal(forecast.latestAdjustedProfit, -1); assert.equal(forecast.annualRoeLatest, 12);
});

test('发布刷新用原获取时间，旧数值保持可查看，金额币种不明只影响金额字段', () => {
  const original = normalizeFinance(response(), symbol, NOW), later = new Date(+NOW + 21600001);
  const refreshed = refreshFinanceSnapshot(original, symbol, later);
  assert.equal(refreshed.latestAdjustedProfit, null); assert.equal(refreshed.financeFieldChecks.latestAdjustedProfit.rawValue, -1);
  assert.equal(refreshed.financeFetchedAt, +NOW); assert.equal(original.latestAdjustedProfit, -1);
  const data = response(); data.data.latest.currency = 'USD';
  const currency = normalizeFinance(data, symbol, NOW);
  assert.equal(currency.latestAdjustedProfit, null); assert.equal(currency.revenueYoY, 10); assert.equal(currency.annualRoeLatest, 12);
});

test('交互60秒缓存不能延长财报6小时有效期，慢后续核验发布前也重新检查', async () => {
  let now = new Date(NOW), calls = 0;
  const service = new Screener(null, null, null, () => now, async () => { calls++; const r = response(now); r.fetchedAt = +NOW - 21600000 + 30000; return r; });
  service.load = async () => ({ rows: [{ symbol, name: '隔离有效期测试', board: 'sh', price: 10, timestamp: +now }], fetchedAt: +now });
  const query = { ...defaults(), rules: [{ field: 'revenueYoY', op: 'gt', value: 0 }] };
  assert.equal((await service.run(query, [])).rows.length, 1);
  now = new Date(+NOW + 40000);
  assert.equal((await service.run(query, [])).rows.length, 0); assert.equal(calls, 1);
  now = new Date(NOW); service.financeCache.clear();
  service.financeLoader = async () => response(now);
  service.screenNoticeRisk = async result => { now = new Date(+now + 21600001); return result; };
  const result = await service.run(query, [], false, null, 'long');
  assert.equal(result.rows.length, 0); assert.equal(result.status, 'unavailable');
  assert.equal(result.financePendingRows[0].financeFieldChecks.revenueYoY.rawValue, 10);
});
