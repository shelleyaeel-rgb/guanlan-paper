'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reportPeriodFromTitle, latestDisclosedReport } = require('../core/financial-report-status.cjs');
const symbol = 'sh600001', now = new Date('2026-10-15T10:00:00+08:00');
const response = title => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +now,
  data: { items: [{ id: 'AN20261013000001', date: '2026-10-13', title }], total: 1 } });

test('只识别已披露正式报告期，预告快报、董事会决议和说明公告不替代正式报告', () => {
  for (const [title, expected] of [['公司：2026年第三季度报告', '2026-09-30'], ['2026年半年度报告摘要', '2026-06-30'], ['2025年年度报告（修订版）', '2025-12-31'], ['2026年第一季度报告', '2026-03-31'],
    ['2025年度报告', '2025-12-31'], ['公司：2025年度报告摘要（更新稿）', '2025-12-31'], ['2026年半年度报告（修订稿）', '2026-06-30'], ['2025年年度报告（更正）', '2025-12-31'],
    ['2026中期报告_全文（修订后）', '2026-06-30'], ['2025年度报告（全文）', '2025-12-31']]) assert.equal(reportPeriodFromTitle(title), expected);
  for (const title of ['2026年前三季度业绩预告', '2026年第三季度业绩快报', '关于2026年第三季度报告的公告', '2026年第三季度报告披露提示', '审议2026年第三季度报告议案', '2026年第三季度报告更正公告']) assert.equal(reportPeriodFromTitle(title), null);
});

test('正式财报识别只使用有效股票身份、日期、来源和新鲜公告，旧报告不会强迫刷新', () => {
  const valid = response('2026年第三季度报告');
  assert.equal(latestDisclosedReport(valid, symbol, now, '2026-06-30').reportDate, '2026-09-30');
  assert.equal(latestDisclosedReport(valid, symbol, now, '2026-09-30'), null);
  for (const mutate of [r => { r.symbol = 'sh600002'; }, r => { r.source = 'unknown'; }, r => { r.fetchedAt = +now - 300001; },
    r => { r.data.items[0].date = '2026-09-29'; }, r => { r.data.items[0].date = '2026-10-16'; }, r => { r.data.items[0].id = 'invalid'; }]) {
    const r = structuredClone(valid); mutate(r); assert.equal(latestDisclosedReport(r, symbol, now, '2026-06-30'), null);
  }
});
