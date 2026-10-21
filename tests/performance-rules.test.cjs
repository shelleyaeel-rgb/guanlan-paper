'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PERFORMANCE_METADATA, validatePerformanceRules, evaluatePerformanceRules } = require('../core/performance-rules.cjs');
const { checkNoticeWithEvidence } = require('../core/company-notice-review.cjs');
const { createEntryConditions, validEntryConditions, evaluateEntryConditions } = require('../core/entry-conditions.cjs');
const { defaults, validate, describe, Screener } = require('../core/screener.cjs');
const SYMBOL = 'sh600001', NOW = new Date('2026-10-15T10:00:00+08:00');
const rule = (field = 'netProfitGrowthMinPct', value = 0, op = 'gte') => ({ field, op, value });
const query = (rules = [rule()], enabled = true) => ({ version: 1, enabled, rules });
function fixture({ symbol = SYMBOL, id = 'AN20261013000001', date = '2026-10-13', start = '2026年1月1日', end = '2026年9月30日', tablePeriod = '年初至报告期末', title = '2026年前三季度业绩预告', profit = 120, recurring = 110 } = {}) {
  const line = (name, value) => `${name}  盈利：${value}万元  盈利：100万元\n比上年同期${value >= 100 ? '增长' : '下降'}：${Math.abs(value - 100)}%`;
  const text = `业绩预告期间：${start}至${end}。\n项目  ${tablePeriod}  上年同期\n${line('归属于上市公司股东的净利润', profit)}\n${line('扣除非经常性损益后的净利润', recurring)}\n二、与会计师事务所沟通情况\n本次业绩预告未经会计师事务所审计。`;
  const notice = { id, date, title };
  const document = { id, kind: 'notice', issuerSymbol: symbol, title, publishedAt: date, fetchedAt: +NOW,
    complete: true, text, pages: 1, url: `https://data.eastmoney.com/notices/detail/${symbol.slice(2)}/${id}.html`,
    pageTexts: [{ page: 1, text, method: 'provider-text', numericEligible: true, complete: true }] };
  const response = { symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW, data: { items: [notice], total: 1 } };
  return { notice, document, response, bundle: { symbol, fetchedAt: +NOW, documents: [document] } };
}
const reviewed = (f = fixture()) => checkNoticeWithEvidence(f.response, f.response.symbol, f.bundle, NOW);
const evaluate = (input = query(), review = reviewed(), now = NOW) => evaluatePerformanceRules(input, review, { symbol: SYMBOL, now });
function combine(...fixtures) {
  const first = structuredClone(fixtures[0]);
  first.response.data = { items: fixtures.map(f => f.notice), total: fixtures.length };
  first.bundle.documents = fixtures.map(f => f.document);
  return reviewed(first);
}

test('explicit optional forecast predicates validate, preserve unrelated conditions, and have no default threshold', () => {
  assert.equal(evaluatePerformanceRules(undefined, null, { symbol: SYMBOL, now: NOW }).blocksEntry, false);
  assert.equal(evaluate(query([], false), null).status, 'observing');
  assert.equal(Object.keys(PERFORMANCE_METADATA.fields).length, 2);
  const input = { ...defaults(), performance: query([rule('netProfitGrowthMinPct', -20)]), research: { version: 1, enabled: true, path: 'company', rules: [{ field: 'revenueYoY', op: 'gt', value: 0 }] } };
  const validated = validate(input);
  assert.deepEqual(validated.performance, input.performance); assert.deepEqual(validated.research, input.research);
  assert.match(describe(validated).join(''), /业绩预告\/快报条件.*-20/);
  for (const value of [query([], true), { ...query(), version: 2 }, query([{ ...rule(), extra: true }]), query([rule('notAField')]), query([rule(undefined, NaN)]), query([rule(undefined, 0, 'gt'), rule(undefined, 0, 'lte')])]) assert.throws(() => validatePerformanceRules(value));
});

test('verified forecast lower bounds support editable declines without treating them as actual statements', () => {
  const review = reviewed(fixture({ profit: 90, recurring: 80 }));
  const result = evaluate(query([rule('netProfitGrowthMinPct', -10), rule('recurringProfitGrowthMinPct', -20)]), review);
  assert.equal(result.status, 'pass'); assert.equal(result.selectedNotice.basis, 'forecast');
  assert.equal(result.checks[0].actual, -10); assert.equal(result.checks[0].period.end, '2026-09-30');
  assert.ok(result.checks[0].sourceRefs[0].url.includes('AN20261013000001'));
  assert.equal(evaluate(query([rule('netProfitGrowthMinPct', -9)]), review).status, 'failed');
  assert.match(result.limitation, /不替代正式财报和独立公告风险/);
});

test('巨潮已核验预告使用独立编号和原文链接，来源编号混用继续待核验', () => {
  const f = fixture({ id: 'CN122345678901', profit: 120 });
  f.response.source = '巨潮资讯';
  Object.assign(f.response.data, { source: '巨潮资讯', symbol: SYMBOL, fromDate: '1990-01-01', toDate: '2026-10-15', complete: true });
  Object.assign(f.notice, { source: '巨潮资讯', issuerSymbol: SYMBOL, orgId: 'gssh0600001',
    attachmentUrl: 'https://static.cninfo.com.cn/finalpage/2026-10-13/122345678901.pdf' });
  f.document.url = `https://www.cninfo.com.cn/new/disclosure/detail?stockCode=${SYMBOL.slice(2)}&announcementId=122345678901`;
  f.document.source = '巨潮资讯公告原文';
  const review = reviewed(f), result = evaluate(query(), review);
  assert.equal(result.status, 'pass'); assert.equal(result.checks[0].actual, 20);
  assert.ok(result.checks[0].sourceRefs.every(ref => ref.url === f.document.url));
  const wrongSource = structuredClone(review); wrongSource.source = '东方财富';
  assert.equal(evaluate(query(), wrongSource).status, 'pending');
  const partial = structuredClone(review); partial.coverageComplete = false;
  assert.equal(evaluate(query(), partial).status, 'pending');
});

test('fresh valid metrics never override independent announcement risks', () => {
  const review = reviewed(); review.status = 'blocked'; review.reasons = ['其他重大事项'];
  assert.equal(evaluate(query(), review).status, 'pass');
  assert.equal(review.status, 'blocked');
});

test('missing selected fields, provenance, stale timing and contradictory arithmetic remain pending', () => {
  const mutations = [
    review => { review.notices[0].factReview.checks.find(check => check.key === 'netProfit').value = null; },
    review => { review.notices[0].records = []; },
    review => { review.notices[0].records.find(record => record.id.includes(':netProfit:')).symbol = 'sh600002'; },
    review => { review.notices[0].factReview.checks.find(check => check.key === 'netProfit').value.current.min = 500; },
    review => { review.source = 'unknown'; }, review => { review.coverageComplete = false; },
    review => { review.fetchedAt = +NOW - 300001; }, review => { review.checkedAt = +NOW + 1; }
  ];
  for (const mutate of mutations) { const review = reviewed(); mutate(review); const result = evaluate(query(), review); assert.equal(result.status, 'pending'); assert.equal(result.checks[0].actual, null); }
  const review = reviewed(); review.notices[0].factReview.checks.find(check => check.key === 'recurringProfit').status = 'missing';
  assert.equal(evaluate(query(), review).status, 'pass');
  assert.equal(evaluate(query([rule('recurringProfitGrowthMinPct')]), review).status, 'pending');
});

test('latest period and latest announcement win; same-date versions cannot be selected by favorable result', () => {
  const old = fixture({ id: 'AN20261011000001', date: '2026-10-11', end: '2026年6月30日', title: '2026年半年度业绩预告', profit: 200 });
  const latest = fixture({ profit: 90 });
  assert.equal(evaluate(query(), combine(old, latest)).status, 'failed');
  const changed = fixture({ id: 'AN20261014000001', date: '2026-10-14', profit: 80 });
  assert.equal(evaluate(query([rule(undefined, -15)]), combine(latest, changed)).status, 'failed');
  const sameDay = fixture({ id: 'AN20261013000002', profit: 200 });
  assert.equal(evaluate(query(), combine(latest, sameDay)).status, 'pending');
  const unresolved = reviewed(); unresolved.notices.push({ id: 'AN20261014000002', title: '2026年前三季度业绩预告修正公告', date: '2026-10-14', status: 'unverified' });
  assert.equal(evaluate(query(), unresolved).status, 'pending');
});

test('newer flash remains preliminary actual and never fills its missing fields from an older forecast', () => {
  const old = fixture();
  const flash = fixture({ id: 'AN20261014000001', date: '2026-10-14', title: '2026年前三季度业绩快报' });
  const text = '本报告期指年初至本季度末9个月期间。\n单位：万元\n项目  本报告期  上年同期  增减变动幅度（%）\n归属于上市公司股东的净利润  110  100  10\n扣除非经常性损益后的净利润  105  100  5';
  flash.document.text = text; flash.document.pageTexts[0].text = text;
  const review = combine(old, flash), result = evaluate(query([rule(undefined, 10)]), review);
  assert.equal(result.status, 'pass'); assert.equal(result.selectedNotice.type, 'flash'); assert.equal(result.selectedNotice.basis, 'preliminary-actual');
  assert.equal(result.checks[0].actual, 10);
  review.notices.find(notice => notice.id === flash.notice.id).factReview.checks.find(check => check.key === 'recurringProfit').status = 'missing';
  assert.equal(evaluate(query([rule('recurringProfitGrowthMinPct')]), review).status, 'pending');
});

test('single-quarter and cumulative disclosures sharing an end date cannot silently replace each other', () => {
  const cumulative = fixture({ profit: 120 });
  const single = fixture({ id: 'AN20261014000001', date: '2026-10-14', title: '2026年第三季度业绩预告', start: '2026年7月1日', tablePeriod: '本报告期', profit: 160 });
  const threshold = query([rule(undefined, 50)]);
  assert.equal(evaluate(threshold, reviewed(cumulative)).status, 'failed');
  assert.equal(evaluate(threshold, reviewed(single)).status, 'pass');
  for (const review of [combine(cumulative, single), combine(single, cumulative)]) {
    assert.equal(review.status, 'clear', '两篇公告事实各自完整，冲突属于选定指标的期间口径');
    const result = evaluate(threshold, review);
    assert.equal(result.status, 'pending'); assert.equal(result.selectedNotice, null); assert.equal(result.checks[0].actual, null);
    assert.match(result.reasons.join('；'), /单季度.*累计口径.*2026-01-01.*2026-07-01|单季度.*累计口径.*2026-07-01.*2026-01-01/);
    assert.match(result.reasons.join('；'), /不能把较晚披露的单季数字当作累计数据的新版本/);
  }
  const laterCumulative = fixture({ id: 'AN20261015000001', date: '2026-10-15', profit: 170 });
  assert.equal(evaluate(threshold, combine(single, laterCumulative)).status, 'pending', '较晚累计数据同样不能隐式覆盖单季口径');
  const sameDatesDifferentBasis = combine(cumulative, laterCumulative);
  sameDatesDifferentBasis.notices.find(notice => notice.id === laterCumulative.notice.id).factReview.checks.find(check => check.key === 'period').value.aggregation = 'single-quarter';
  assert.equal(evaluate(threshold, sameDatesDifferentBasis).status, 'pending', '相同起止日仍须保留口径标记冲突');
  assert.equal(evaluate(threshold, combine(cumulative, laterCumulative)).status, 'pass', '同一完整期间仍使用最新披露版本');
});

test('conditions persist unchanged, validate on restore, and reparse current source before every entry', () => {
  const input = { rules: [{ field: 'roe', op: 'gte', value: 8 }], performance: query() };
  const saved = createEntryConditions(input, NOW);
  assert.deepEqual(saved.performance, input.performance); assert.equal(validEntryConditions(saved), true); assert.ok(Object.isFrozen(saved.performance.rules));
  const invalid = structuredClone(saved); invalid.performance.version = 2; assert.equal(validEntryConditions(invalid), false);
  const onlyForecast = createEntryConditions({ performance: query() }, NOW);
  const f = fixture(), snapshot = { notices: f.response, automaticEvidence: f.bundle };
  assert.equal(evaluateEntryConditions(onlyForecast, SYMBOL, null, snapshot, NOW).status, 'pass');
  const declining = fixture({ profit: 90 });
  assert.equal(evaluateEntryConditions(onlyForecast, SYMBOL, null, { notices: declining.response, automaticEvidence: declining.bundle }, NOW).status, 'failed');
  assert.equal(evaluateEntryConditions(onlyForecast, SYMBOL, null, { performanceReview: { status: 'pass' } }, NOW).status, 'pending');
  assert.equal(createEntryConditions({ performance: query([], false) }, NOW), null);
});

function scanner({ notices, evidence } = {}) {
  const service = new Screener(null, null, null, () => NOW, null, notices);
  service.noticeEvidenceLoader = evidence;
  service.snapshot = { rows: [{ symbol: SYMBOL, name: '隔离测试', board: 'sh', isST: false, price: 10, pe: 15, timestamp: +NOW }], fetchedAt: +NOW, source: '隔离行情' };
  service.load = async () => service.snapshot;
  return service;
}

test('ordinary screener collects notice sources for enabled predicates and returns independent performance failures', async () => {
  const f = fixture(); let collected = 0;
  const service = scanner({ notices: async () => f.response, evidence: async () => { collected++; return f.bundle; } });
  const result = await service.run({ ...defaults(), performance: query([rule(undefined, 25)]) }, []);
  assert.equal(collected, 1); assert.equal(result.rows.length, 0); assert.equal(result.performanceFailedRows.length, 1);
  assert.equal(result.performanceFailedRows[0].entryRisk.status, 'clear'); assert.equal(result.performanceScreen.failed, 1);
  const pass = await service.run({ ...defaults(), performance: query([rule(undefined, 20)]) }, []);
  assert.equal(pass.rows.length, 1); assert.equal(pass.rows[0].performanceReview.selectedNotice.type, 'forecast');
  assert.equal(service.snapshot.rows[0].performanceReview, undefined);
});

test('no recent forecast is pending only when explicitly enabled; historical predicates reject before fetching', async () => {
  const service = scanner({ notices: async () => ({ symbol: SYMBOL, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: +NOW, data: { items: [], total: 0 } }) });
  const result = await service.run({ ...defaults(), performance: query() }, []);
  assert.equal(result.performancePendingRows.length, 1); assert.match(result.performancePendingRows[0].performanceReview.reasons.join(''), /没有可供/);
  service.noticeLoader = () => { throw Error('must not fetch'); };
  const observed = await service.run({ ...defaults(), performance: query([], false) }, []);
  assert.equal(observed.rows.length, 1); assert.equal(observed.performanceScreen, undefined);
  await assert.rejects(service.run({ ...defaults(), performance: query() }, [], false, 'historic'), /历史快照.*业绩预告/);
});
