const test = require('node:test');
const assert = require('node:assert/strict');
const { Screener, classifyScreenRow, defaults } = require('../core/screener.cjs');
const { runAgencyScreening: screenAgency, poolPolicy, AGENCY_POOL_POLICY } = require('../core/agency-screening.cjs');
// Existing research regressions explicitly exercise the optional strict mode.
const runAgencyScreening = (screener, options = {}) => screenAgency(screener, { screeningMode: 'strict', ...options });
const { composeStrategyQuery } = require('../core/strategy-presets.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');

const NOW = new Date('2026-10-13T10:00:00+08:00');
const IDS = ['ultra-short', 'short', 'swing', 'long'];
function bars(end = '2026-10-12') {
  const dates = []; let day = Date.parse(`${end}T10:00:00+08:00`);
  while (dates.length < 120) {
    const session = calendarSession(new Date(day));
    if (session.open) dates.unshift(session.date);
    day -= 86400000;
  }
  return dates.map((date, i) => {
    const close = 10 + i * 0.008 + Math.sin(i / 4 + 1.6) * 0.12;
    return { date, open: close, close, high: close + 0.1, low: close - 0.1, volume: i === 119 ? 150 : 100 };
  });
}
const row = (symbol = 'sh600001', extra = {}) => ({ symbol, name: '隔离测试', board: 'sh', isST: false,
  timestamp: NOW.getTime(), price: 11.05, prevClose: 10.94, changePct: 1, amount: 3, turnover: 3, pe: 20, pb: 2, ...extra });
const annual = year => ({ reportDate: `${year}-12-31`, noticeDate: `${year + 1}-03-30`, currency: 'CNY', roe: 12, adjustedProfit: 2e8, operatingCash: 3e8 });
const report = (extra = {}) => ({ latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', currency: 'CNY', roe: 9,
  debtRatio: 40, adjustedProfit: 1e8, revenueYoY: 10, adjustedProfitYoY: 10, operatingCash: 2e8, ...extra }, annual: [annual(2025), annual(2024), annual(2023)] });
function scanner({ rows = [row()], now = NOW, finance, daily, automatic, notices, load } = {}) {
  const calls = { snapshot: 0, finance: [], daily: [], evidence: [], notices: [], risk: 0 };
  const s = new Screener(null, null, async (symbol, signal) => {
    calls.daily.push(symbol); return daily ? daily(symbol, signal) : { bars: bars(), source: '隔离未复权日线' };
  }, () => now, async (symbol, signal, force) => {
    calls.finance.push({ symbol, force });
    const response = finance ? await finance(symbol, signal) : { symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: now.getTime(), data: report() };
    return { industryProfile: ordinaryProfile(symbol, now), ...response };
  }, async (symbol, signal, force) => {
    calls.notices.push({ symbol, force }); return notices ? notices(symbol, signal) : { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } };
  }, async () => { calls.risk++; throw Error('候选扫描不可调用盘中90秒风险报价'); }, null, () => { throw Error('自动候选不能依赖人工证据库'); }, async (symbol, { signal }) => {
    calls.evidence.push(symbol); return automatic ? automatic(symbol, signal) : companyBundle(symbol, now);
  });
  s.load = async force => { calls.snapshot++; return load ? load(force) : { rows: structuredClone(rows), source: '隔离行情', fetchedAt: now.getTime(), sourceCount: rows.length, excludedCount: 0 }; };
  return { s, calls };
}
const state = (result, id, symbol) => ['pass', 'failed', 'pending'].find(key => result.strategies[id][key].some(item => item.symbol === symbol));

test('公司经营指标独立核验，公告待核验不隐藏经营通过或不符且始终阻断总体入围', async () => {
  const research = { version: 1, enabled: true, path: 'company', rules: [{ field: 'revenueYoY', op: 'gte', value: 0 }] };
  for (const revenueYoY of [10, -1]) {
    const { s } = scanner({ finance: symbol => ({ symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: +NOW, data: report({ revenueYoY }) }),
      notices: symbol => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW,
        data: { items: [{ id: 'AN20261013000001', date: '2026-10-13', title: '2026年前三季度业绩预告' }], total: 1 } }) });
    const result = await screenAgency(s, { research });
    assert.equal(result.strategies.swing.pass.length, 0);
    const candidate = [...result.strategies.swing.pending, ...result.strategies.swing.failed][0];
    assert.equal(candidate.researchReview.status, revenueYoY > 0 ? 'pass' : 'failed');
    assert.equal(candidate.researchReview.companyMetrics.reportDate, '2026-06-30');
    assert.equal(result.coverage.operatingResearch.evaluated, 1);
    const long = [...result.strategies.long.pending, ...result.strategies.long.failed][0];
    assert.equal(long.financeCheck.status, revenueYoY > 0 ? 'pass' : 'failed');
    assert.equal(long.financeCheck.reportDate, '2026-06-30');
  }
});

test('明确正式新报触发财务单次重取，同步成功用新报、仍旧报待同步，预告不触发', async () => {
  for (const sync of [false, true]) {
    let financeCount = 0;
    const { s, calls } = scanner({ finance: symbol => ({ symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: +NOW,
      data: report(++financeCount > 1 && sync ? { reportDate: '2026-09-30', noticeDate: '2026-10-13' } : {}) }),
      notices: symbol => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW,
        data: { items: [{ id: 'AN20261013000001', date: '2026-10-13', title: '测试公司：2026年第三季度报告' }], total: 1 } }) });
    const research = { version: 1, enabled: true, path: 'company', rules: [{ field: 'revenueYoY', op: 'gte', value: 0 }] };
    const result = await screenAgency(s, { research });
    assert.equal(calls.finance.length, 2); assert.equal(calls.finance[1].force, true);
    const candidate = [...result.strategies.long.pass, ...result.strategies.long.pending][0];
    assert.equal(candidate.status, sync ? 'pass' : 'pending');
    assert.equal(candidate.researchReview.status, sync ? 'pass' : 'pending');
    assert.equal(candidate.financeReportDate, sync ? '2026-09-30' : '2026-06-30');
    if (!sync) assert.equal(candidate.pendingReport.reportDate, '2026-09-30');
  }
  const { s, calls } = scanner({ notices: symbol => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW,
    data: { items: [{ id: 'AN20261013000001', date: '2026-10-13', title: '2026年前三季度业绩预告' }], total: 1 } }) });
  await screenAgency(s); assert.equal(calls.finance.length, 1);
});

test('业绩附加条件默认不启用，显式启用无公告时独立待核验并保留查询', async () => {
  const disabled = { version: 1, enabled: false, rules: [] };
  assert.deepEqual(poolPolicy('strategy', undefined, disabled).commonQuery.performance, disabled);
  const observed = await screenAgency(scanner().s, { performance: disabled });
  assert.equal(observed.strategies.swing.pass.length, 1); assert.equal(observed.strategies.swing.pass[0].performanceReview.status, 'observing');
  const performance = { version: 1, enabled: true, rules: [{ field: 'netProfitGrowthMinPct', op: 'gte', value: -10 }] };
  const result = await screenAgency(scanner().s, { performance });
  assert.equal(result.strategies.swing.pass.length, 0); assert.equal(result.strategies.swing.pending[0].performanceReview.status, 'pending');
  assert.deepEqual(result.strategies.swing.query.performance, performance);
  assert.equal(result.coverage.performance.pending, 1);
});

test('候选池按明确预告条件判断同比下界，数值通过不能覆盖另一公告待核验', async () => {
  const item = { id: 'AN20261013000001', date: '2026-10-13', title: '2026年前三季度业绩预告' };
  const text = '业绩预告期间：2026年1月1日至2026年9月30日。\n项目  年初至报告期末  上年同期\n归属于上市公司股东的净利润  盈利：90万元  盈利：100万元\n比上年同期下降：10%\n扣除非经常性损益后的净利润  盈利：110万元  盈利：100万元\n比上年同期增长：10%\n二、与会计师事务所沟通情况\n本次业绩预告未经会计师事务所审计。';
  for (const [minimum, otherNotice, expected] of [[-10, false, 'pass'], [-9, false, 'failed'], [-10, true, 'pending']]) {
    const items = [item, ...(otherNotice ? [{ id: 'AN20261013000002', date: '2026-10-13', title: '关于重大诉讼进展的公告' }] : [])];
    const { s } = scanner({ notices: symbol => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW, data: { items, total: items.length } }) });
    s.noticeEvidenceLoader = async symbol => ({ symbol, fetchedAt: +NOW, documents: [{ id: item.id, title: item.title, publishedAt: item.date, issuerSymbol: symbol, kind: 'notice', complete: true,
      fetchedAt: +NOW, url: `https://data.eastmoney.com/notices/detail/${symbol.slice(2)}/${item.id}.html`, text, pages: 1,
      pageTexts: [{ page: 1, text, method: 'provider-text', numericEligible: true, complete: true }] }] });
    const performance = { version: 1, enabled: true, rules: [{ field: 'netProfitGrowthMinPct', op: 'gte', value: minimum }] };
    const result = await screenAgency(s, { performance });
    const candidate = result.strategies.swing[expected][0]; assert.ok(candidate, expected);
    assert.equal(candidate.performanceReview.status, minimum === -9 ? 'failed' : 'pass');
    assert.equal(candidate.performanceReview.checks[0].actual, -10);
  }
});

test('默认候选筛选仅采集敏感公告正文，通过后仍不附加共同研究条件', async () => {
  const item = { id: 'AN20261013000001', date: '2026-10-13', title: '关于诉讼结案的公告' };
  const { s, calls } = scanner({ notices: symbol => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW, data: { items: [item], total: 1 } }) });
  let bodyCalls = 0;
  s.noticeEvidenceLoader = async (symbol, { noticeResponse }) => {
    bodyCalls++; assert.equal(noticeResponse.data.items[0].id, item.id);
    const text = '本次诉讼已结案，相关义务已全部履行完毕。本次诉讼对公司生产经营未造成重大不利影响。';
    return { symbol, fetchedAt: +NOW, documents: [{ id: item.id, title: item.title, publishedAt: item.date, issuerSymbol: symbol, kind: 'notice', complete: true,
      fetchedAt: +NOW, url: `https://data.eastmoney.com/notices/detail/${symbol.slice(2)}/${item.id}.html`, text, pages: 1,
      pageTexts: [{ page: 1, text, method: 'provider-text', numericEligible: true, complete: true }] }] };
  };
  const result = await screenAgency(s);
  assert.equal(bodyCalls, 1); assert.equal(calls.evidence.length, 0);
  assert.equal(result.coverage.noticeFulltextChecked, 1); assert.equal(result.coverage.researchRequired, false);
  for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pass');
  assert.equal(result.strategies.swing.pass[0].noticeReview.status, 'clear');
  assert.equal(result.strategies.swing.pass[0].selectionEvidence, undefined);
  s.noticeEvidenceLoader = async () => { throw Error('原文请求失败'); };
  const failed = await screenAgency(s); assert.equal(state(failed, 'swing', 'sh600001'), 'pending');
  const pending = failed.strategies.swing.pending[0];
  assert.match(pending.noticeReview.notices[0].reason, /原文请求失败/);
  assert.equal(pending.noticeReview.notices[0].acquisition.stage, 'body');
  assert.equal(pending.noticeReview.notices[0].acquisition.documentId, item.id);
  assert.ok(pending.diagnostics.stages.some(item => item.code === 'notice-body-fetch'));
  assert.ok(!pending.diagnostics.stages.some(item => ['notice-risk', 'notice-index-fetch'].includes(item.code)));
});

test('标题已阻断和目录覆盖不足仍保存公告逐条依据，不伪装原文已核验', async () => {
  const { s } = scanner({ notices: symbol => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW,
    data: { items: [{ id: 'AN20261013000001', date: '2026-10-13', title: '公司被立案调查公告' }], total: 1 } }) });
  const result = await screenAgency(s), row = result.strategies.swing.failed[0];
  assert.equal(row.noticeReview.status, 'blocked'); assert.equal(row.noticeReview.notices[0].title, '公司被立案调查公告');
  assert.notEqual(row.noticeReview.mode, 'automatic-fulltext');
  assert.deepEqual(row.diagnostics.stages.map(item => item.code), ['notice-blocked']);
});

test('默认按策略筛选不要求公司研究，财务失败只影响长线而不阻断技术策略', async () => {
  for (const finance of [() => { throw Error('财务接口离线'); }, symbol => ({ symbol, section: 'finance', status: 'ready',
    source: '东方财富', fetchedAt: +NOW, data: report({ debtRatio: 80 }) })]) {
    const { s, calls } = scanner({ finance, automatic: () => { throw Error('默认模式不得获取公司报告'); } });
    const result = await screenAgency(s);
    for (const id of IDS.slice(0, 3)) assert.equal(state(result, id, 'sh600001'), 'pass');
    assert.notEqual(state(result, 'long', 'sh600001'), 'pass');
    assert.equal(calls.evidence.length, 0); assert.equal(calls.notices.length, 1); assert.equal(calls.daily.length, 1);
    assert.equal(result.screeningMode, 'strategy'); assert.equal(result.policyVersion, 3); assert.equal(result.coverage.researchRequired, false);
    assert.equal(result.coverage.evidenceChecked, 0); assert.equal(result.strategies.swing.pass[0].selectionEvidence, undefined);
  }
});

test('默认策略模式仍阻断敏感公告和明确风险，不用未加载报告作为通过依据', async () => {
  for (const title of ['关于重大诉讼进展的公告', '关于被立案调查的公告']) {
    const { s, calls } = scanner({ notices: symbol => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW,
      data: { items: [{ id: 'AN20261013000001', date: '2026-10-13', title }], total: 1 } }) });
    const result = await screenAgency(s);
    for (const id of IDS) assert.notEqual(state(result, id, 'sh600001'), 'pass');
    assert.equal(calls.evidence.length, 0);
  }
});

test('两种筛选模式隔离，严格模式仍需财务质量和研究证据全部满足', async () => {
  const { s, calls } = scanner({ automatic: symbol => ({ symbol, status: 'unavailable', documents: [], errors: ['行业原文缺失'] }) });
  const strategy = await screenAgency(s);
  assert.equal(strategy.strategies.swing.pass.length, 1); assert.equal(calls.evidence.length, 0);
  const strict = await screenAgency(s, { screeningMode: 'strict' });
  assert.equal(strict.strategies.swing.pass.length, 0); assert.equal(strict.strategies.swing.pending.length, 1);
  assert.equal(strict.coverage.researchRequired, true); assert.equal(calls.evidence.length, 1);
  assert.equal(poolPolicy().commonQuery.evidence, undefined); assert.ok(poolPolicy('strict').commonQuery.evidence);
  await assert.rejects(screenAgency(s, { screeningMode: 'unknown' }), /模式无效/);
});

test('默认长线只要求自身财务口径，三年年度质量资料缺项属于可选严格筛选', async () => {
  const { s, calls } = scanner({ finance: symbol => ({ symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: +NOW,
    data: { latest: report().latest, annual: [annual(2025)] } }) });
  const strategy = await screenAgency(s);
  assert.equal(strategy.strategies.long.pass.length, 1); assert.equal(calls.evidence.length, 0);
  const strict = await screenAgency(s, { screeningMode: 'strict' });
  assert.equal(strict.strategies.long.pending.length, 1); assert.equal(strict.strategies.long.pass.length, 0);
  assert.match(strict.strategies.long.pending[0].reasons.join('；'), /数据缺失/);
});

test('一次共享全市场、证据、财报、日线及公告，四策略分别匹配且不修改快照', async () => {
  const rows = [row(), row('sh600002')], before = structuredClone(rows), { s, calls } = scanner({ rows });
  const result = await runAgencyScreening(s);
  assert.equal(result.status, 'ready'); assert.equal(calls.snapshot, 1);
  assert.equal(calls.evidence.length, 2); assert.equal(calls.finance.length, 2); assert.equal(calls.daily.length, 2); assert.equal(calls.notices.length, 2); assert.equal(calls.risk, 0);
  for (const id of IDS) {
    assert.equal(result.strategies[id].pass.length, 2, id);
    assert.deepEqual(result.strategies[id].query, composeStrategyQuery(id, result.commonQuery));
    assert.equal(result.strategies[id].pass[0].technicalAsOf, '2026-10-12');
    assert.equal(result.strategies[id].pass[0].financeReportDate, '2026-06-30');
  }
  assert.equal(result.coverage.universeComplete, true); assert.deepEqual(rows, before);
  assert.equal(s.activeRun, null); assert.equal(s.progress.loading, false);
});

test('先筛量化条件，只有至少一种策略入围者进入程序核验，不依赖人工记录', async () => {
  const rows = [row('sh600001'), row('sh600002'), row('sh600003')];
  const { s, calls } = scanner({ rows, finance: symbol => ({ symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: NOW.getTime(),
    data: report(symbol === 'sh600002' ? { debtRatio: 80 } : symbol === 'sh600003' ? { debtRatio: null } : {}) }) });
  const result = await runAgencyScreening(s);
  assert.equal(result.status, 'ready'); assert.deepEqual(calls.evidence, ['sh600001']);
  assert.equal(calls.finance.length, 3); assert.deepEqual(calls.daily, ['sh600001']);
  assert.equal(result.coverage.quantitativeCandidates, 1); assert.equal(result.coverage.evidenceChecked, 1);
  assert.equal(result.coverage.evidenceSummary.pass, 1);
  for (const id of IDS) { assert.equal(state(result, id, 'sh600001'), 'pass'); assert.equal(state(result, id, 'sh600002'), 'failed'); assert.equal(state(result, id, 'sh600003'), 'pending'); }
});

test('入围后原文缺失明确资料不足，量化失败不能被研究缺项覆盖', async () => {
  const { s, calls } = scanner({ automatic: symbol => ({ symbol, checkedAt: NOW.getTime(), status: 'unavailable', documents: [], errors: ['离线'] }) });
  const result = await runAgencyScreening(s);
  assert.equal(calls.finance.length, 1); assert.equal(calls.daily.length, 1); assert.equal(calls.evidence.length, 1);
  for (const id of IDS) { assert.equal(state(result, id, 'sh600001'), 'pending'); assert.equal(result.strategies[id].pending[0].stage, 'evidence'); }
  assert.equal(result.coverage.evidenceSummary.pending, 1);
});

test('共同ST、确实财务不合格、财务缺失和池外既有候选分别明确分类', async () => {
  const rows = [row('sh600001', { isST: true }), row('sh600002'), row('sh600003'), row('sh600004')];
  const { s } = scanner({ rows, finance: symbol => ({ symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: NOW.getTime(),
    data: report(symbol === 'sh600002' ? { debtRatio: 80 } : symbol === 'sh600003' ? { debtRatio: null } : {}) }) });
  const result = await runAgencyScreening(s, { requiredSymbols: ['600099'] });
  for (const id of IDS) {
    assert.equal(state(result, id, 'sh600001'), 'failed'); assert.equal(state(result, id, 'sh600002'), 'failed');
    assert.equal(state(result, id, 'sh600003'), 'pending'); assert.equal(state(result, id, 'sh600004'), 'pass'); assert.equal(state(result, id, 'sh600099'), 'pending');
    assert.equal(result.strategies[id].pass.length + result.strategies[id].failed.length + result.strategies[id].pending.length, 5);
  }
  assert.deepEqual(result.coverage.requiredMissing, ['sh600099']);
});

test('早盘累计成交额与换手不足只待核验，完整收盘数据才可明确不合格', async () => {
  const low = row('sh600001', { amount: 0.1, turnover: 0.1 });
  const intraday = await runAgencyScreening(scanner({ rows: [low] }).s);
  assert.equal(state(intraday, 'ultra-short', low.symbol), 'pending'); assert.equal(state(intraday, 'short', low.symbol), 'pending');
  assert.equal(state(intraday, 'swing', low.symbol), 'pass'); assert.equal(state(intraday, 'long', low.symbol), 'pass');
  const now = new Date('2026-10-13T19:00:00+08:00'), closed = row(low.symbol, { amount: 0.1, turnover: 0.1, price: 10.94, timestamp: Date.parse('2026-10-13T15:00:00+08:00') });
  const result = await runAgencyScreening(scanner({ rows: [closed], now, daily: () => ({ bars: bars('2026-10-13') }) }).s);
  assert.equal(state(result, 'ultra-short', low.symbol), 'failed'); assert.equal(state(result, 'short', low.symbol), 'failed');
});

test('周末与盘前使用最近完整交易日，可重复手动更新且无次数限制', async () => {
  for (const now of [new Date('2026-10-10T08:00:00+08:00'), new Date('2026-10-12T08:00:00+08:00')]) {
    const { s, calls } = scanner({ now, rows: [row('sh600001', { price: 10.94, timestamp: Date.parse('2026-10-09T15:00:00+08:00') })], daily: () => ({ bars: bars('2026-10-09') }) });
    for (let i = 0; i < 2; i++) {
      const result = await runAgencyScreening(s);
      for (const id of IDS) assert.equal(result.strategies[id].pass.length, 1, `${now.toISOString()} ${id}`);
      assert.equal(result.sources.expectedQuoteDate, now.getUTCDate() === 10 ? '2026-10-09' : '2026-10-12');
      assert.deepEqual(result.sources.allowedQuoteDates, now.getUTCDate() === 10 ? ['2026-10-09'] : ['2026-10-12', '2026-10-09']);
      assert.equal(result.sources.expectedDailyDate, '2026-10-09');
    }
    assert.equal(calls.snapshot, 2); assert.equal(calls.finance.length, 1); assert.equal(calls.notices.length, 2);
  }
});

test('真实形状盘前和集合竞价当日报价可核验；昨日收盘也有效，当天累计额仍未完成', async () => {
  for (const time of ['09:11:40', '09:25:00']) {
    const now = new Date(`2026-10-13T${time}+08:00`);
    const current = row('sh600001', { timestamp: now.getTime(), amount: 0, turnover: 0 });
    const previous = row('sh600002', { timestamp: Date.parse('2026-10-12T15:00:00+08:00'), price: 10.94, prevClose: null });
    const previousLow = { ...previous, symbol: 'sh600003', amount: 0.1, turnover: 0.1 };
    const { s, calls } = scanner({ now, rows: [current, previous, previousLow] });
    const result = await runAgencyScreening(s);
    assert.equal(calls.evidence.length, 3); assert.equal(result.sources.expectedQuoteDate, '2026-10-13');
    assert.deepEqual(result.sources.allowedQuoteDates, ['2026-10-13', '2026-10-12']);
    assert.equal(result.sources.expectedDailyDate, '2026-10-12');
    for (const id of IDS) assert.equal(state(result, id, previous.symbol), 'pass');
    for (const id of ['ultra-short', 'short']) {
      assert.equal(state(result, id, current.symbol), 'pending');
      assert.match(result.strategies[id].pending.find(item => item.symbol === current.symbol).reasons.join(''), /累计值尚未完成/);
      assert.equal(state(result, id, previousLow.symbol), 'failed');
    }
    for (const id of ['swing', 'long']) assert.equal(state(result, id, current.symbol), 'pass');
  }
});

test('交易日09:30起及盘后不沿用前日行情，节假日继续允许最近完整交易日', async () => {
  for (const time of ['09:30:00', '10:00:00', '16:00:00']) {
    const now = new Date(`2026-10-13T${time}+08:00`), { s, calls } = scanner({ now,
      rows: [row('sh600001', { timestamp: Date.parse('2026-10-12T15:00:00+08:00'), price: 10.94 })] });
    const result = await runAgencyScreening(s);
    assert.deepEqual(result.sources.allowedQuoteDates, ['2026-10-13']);
    for (const id of IDS) { assert.equal(state(result, id, 'sh600001'), 'pending'); assert.equal(result.strategies[id].pending[0].stage, 'quotes'); }
    assert.equal(calls.finance.length, 0);
  }
  const now = new Date('2026-10-06T09:11:40+08:00');
  const result = await runAgencyScreening(scanner({ now, rows: [row('sh600001', { timestamp: Date.parse('2026-09-30T15:00:00+08:00'), price: 10.94 })], daily: () => ({ bars: bars('2026-09-30') }) }).s);
  assert.deepEqual(result.sources.allowedQuoteDates, ['2026-09-30']);
  for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pass');
});

test('旧行情、未来报价与旧日线均不能误作明确失败或有效候选', async () => {
  for (const timestamp of [null, NOW.getTime() + 1000, Date.parse('2026-10-09T15:00:00+08:00')]) {
    const { s, calls } = scanner({ rows: [row('sh600001', { timestamp, amount: 0 })] });
    const result = await runAgencyScreening(s);
    for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pending');
    assert.equal(calls.finance.length, 0);
  }
  const result = await runAgencyScreening(scanner({ daily: () => ({ bars: bars('2026-10-09') }) }).s);
  for (const id of IDS.slice(0, 3)) assert.equal(state(result, id, 'sh600001'), 'pending');
  assert.equal(state(result, 'long', 'sh600001'), 'pass');
});

test('旧行情上的ST名称不能作为本次明确剔除依据，日期检查先于ST和研究证据', async () => {
  const { s, calls } = scanner({ rows: [row('sh600001', { isST: true, name: '*ST旧名称', timestamp: Date.parse('2026-10-09T15:00:00+08:00') })] });
  const result = await runAgencyScreening(s);
  for (const id of IDS) { assert.equal(state(result, id, 'sh600001'), 'pending'); assert.equal(result.strategies[id].pending[0].stage, 'quotes'); }
  assert.equal(calls.evidence.length, 0); assert.equal(calls.finance.length, 0);
});

test('跨日日线比对同源昨收，同日完整日线比对收盘报价，缺失或错配只待核验', async () => {
  for (const prevClose of [null, 20]) {
    const result = await runAgencyScreening(scanner({ rows: [row('sh600001', { prevClose })] }).s);
    for (const id of IDS.slice(0, 3)) { assert.equal(state(result, id, 'sh600001'), 'pending'); assert.match(result.strategies[id].pending[0].reasons.join(''), /价格基准/); }
  }
  const now = new Date('2026-10-10T08:00:00+08:00');
  for (const price of [10.94, 20]) {
    const result = await runAgencyScreening(scanner({ now, rows: [row('sh600001', { timestamp: Date.parse('2026-10-09T15:00:00+08:00'), price, prevClose: null })], daily: () => ({ bars: bars('2026-10-09') }) }).s);
    for (const id of IDS.slice(0, 3)) assert.equal(state(result, id, 'sh600001'), price === 10.94 ? 'pass' : 'pending');
  }
});

test('跨15点的同轮财务和日线使用行情完成时固定的观察时点，不混入刚完成或未来日线', async () => {
  const now = new Date('2026-10-13T14:59:50+08:00'), observedAt = now.toISOString(), observedMs = now.getTime();
  const previous = bars(), future = date => ({ date, open: 999, high: 1000, low: 998, close: 999, volume: 100 });
  const { s } = scanner({ now, rows: [row('sh600001', { timestamp: observedMs })], finance: symbol => {
    now.setTime(Date.parse('2026-10-13T15:00:05+08:00'));
    return { symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: now.getTime(), data: report() };
  }, daily: () => ({ bars: [...previous, future('2026-10-13'), future('2026-10-14')] }) });
  const result = await runAgencyScreening(s);
  for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pass');
  assert.equal(result.sources.scanTime, observedAt); assert.equal(result.sources.expectedDailyDate, '2026-10-12');
  assert.equal(result.sources.finance.asOfCutoff, observedAt); assert.equal(result.sources.technical.asOfCutoff, observedAt);
  assert.equal(result.sources.finance.startedAt, observedMs); assert.equal(result.sources.technical.startedAt, now.getTime());
  assert.equal(result.strategies.swing.pass[0].technicalAsOf, '2026-10-12');
  assert.equal(result.strategies.swing.pass[0].close, previous.at(-1).close);
  assert.equal(result.strategies.swing.pass[0].technicalFetchedAt, now.getTime());
  assert.equal(s.dailyCache.get('sh600001').cutoff, '2026-10-13:intraday');
});

test('快照加载跨收盘时以加载完成时为基准，允许已完整的当日日线', async () => {
  const now = new Date('2026-10-13T14:59:50+08:00');
  const { s } = scanner({ now, load: () => {
    now.setTime(Date.parse('2026-10-13T15:00:05+08:00'));
    return { rows: [row('sh600001', { timestamp: Date.parse('2026-10-13T15:00:00+08:00'), price: 10.94 })], sourceCount: 1, excludedCount: 0 };
  }, daily: () => ({ bars: bars('2026-10-13') }) });
  const result = await runAgencyScreening(s);
  for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pass');
  assert.equal(result.sources.scanTime, now.toISOString()); assert.equal(result.sources.expectedDailyDate, '2026-10-13');
});

test('跨午夜或盘前跨开盘不改变本轮日期基准，实际获取时间仍持续前进', async () => {
  for (const [start, finish, end, cutoff] of [
    ['2026-10-13T23:59:55+08:00', '2026-10-14T00:00:05+08:00', '2026-10-13', '2026-10-13:closed'],
    ['2026-10-13T09:29:55+08:00', '2026-10-13T09:30:05+08:00', '2026-10-12', '2026-10-13:intraday']
  ]) {
    const now = new Date(start), observedAt = now.toISOString();
    const { s } = scanner({ now, rows: [row('sh600001', { timestamp: Date.parse(`${end}T15:00:00+08:00`), price: 10.94, prevClose: null })],
      finance: symbol => { now.setTime(Date.parse(finish)); return { symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: now.getTime(), data: report() }; },
      daily: () => ({ bars: bars(end) }) });
    const result = await runAgencyScreening(s);
    for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pass', `${start} ${id}`);
    assert.equal(result.sources.scanTime, observedAt); assert.equal(result.sources.finance.asOfCutoff, observedAt);
    assert.equal(result.sources.technical.asOfCutoff, observedAt); assert.equal(result.sources.expectedDailyDate, end);
    assert.equal(s.dailyCache.get('sh600001').cutoff, cutoff); assert.equal(s.financeCache.get('sh600001').cutoff, '2026-10-13');
    assert.equal(result.sources.technical.startedAt, now.getTime()); assert.equal(result.finishedAt, now.getTime());
  }
});

test('技术根数不足、数据无效、获取失败、旧日线及价格错配分别保留可统计原因', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(`sh60000${i + 1}`, i === 4 ? { prevClose: 20 } : {}));
  const { s } = scanner({ rows, daily: symbol => {
    if (symbol.endsWith('1')) return { bars: bars().slice(-60) };
    if (symbol.endsWith('2')) return { bars: [...bars(), bars().at(-1)] };
    if (symbol.endsWith('3')) throw Error('isolated net::ERR_HTTP2_PROTOCOL_ERROR');
    return { bars: bars(symbol.endsWith('4') ? '2026-10-09' : '2026-10-12') };
  } });
  const result = await runAgencyScreening(s), kinds = ['insufficient', 'invalid', 'fetch', 'stale', 'mismatch'];
  for (const id of IDS.slice(0, 3)) for (let i = 0; i < rows.length; i++) {
    const item = result.strategies[id].pending.find(item => item.symbol === rows[i].symbol);
    assert.ok(item); assert.equal(item.stage, 'daily'); assert.equal(item.technicalError, kinds[i]);
  }
  assert.deepEqual(result.coverage.technicalFailures, { insufficient: 1, invalid: 1, fetch: 1 });
  assert.match(result.strategies.swing.pending[2].technicalErrorDetail, /ERR_HTTP2_PROTOCOL_ERROR/);
  assert.doesNotMatch(result.strategies.swing.pending[0].reasons.join(''), /日期 未知/);
});

test('技术日期比本轮允许日期更晚也只能待核验，不能用日期大于等于条件放行', async () => {
  const { s } = scanner(), original = s.scanDaily.bind(s);
  s.scanDaily = async (...args) => {
    const result = await original(...args);
    return { ...result, rows: result.rows.map(item => ({ ...item, technicalAsOf: '2026-10-13' })) };
  };
  const result = await runAgencyScreening(s);
  for (const id of IDS.slice(0, 3)) { assert.equal(state(result, id, 'sh600001'), 'pending'); assert.equal(result.strategies[id].pending[0].technicalError, 'mismatch'); }
});

test('年度ROE合格时累计ROE较低不再阻断长线，年度条件仍独立于技术策略', async () => {
  const result = await runAgencyScreening(scanner({ finance: symbol => ({ symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: NOW.getTime(), data: report({ roe: 3 }) }) }).s);
  for (const id of IDS.slice(0, 3)) assert.equal(state(result, id, 'sh600001'), 'pass');
  assert.equal(state(result, 'long', 'sh600001'), 'pass');
});

test('程序资料读取失败、串股和公告敏感事项分开归类，有效敏感目录继续取得原文', async () => {
  for (const automatic of [() => { throw Error('离线'); }, () => companyBundle('sh600002', NOW)]) {
    const unavailable = await runAgencyScreening(scanner({ automatic }).s);
    for (const id of IDS) assert.equal(state(unavailable, id, 'sh600001'), 'pending');
  }
  const b = scanner({ notices: symbol => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: NOW.getTime(),
    data: { items: [{ id: 'AN20261013000001', date: '2026-10-13', title: '关于重大诉讼进展的公告' }], total: 1 } }) });
  const sensitive = await runAgencyScreening(b.s);
  for (const id of IDS) { assert.equal(state(sensitive, id, 'sh600001'), 'pending'); assert.equal(sensitive.strategies[id].pending[0].stage, 'notices'); }
  assert.equal(b.calls.notices.length, 1); assert.equal(b.calls.evidence.length, 1);
  assert.match(sensitive.strategies.long.pending[0].evidenceReview.checks.find(check => check.key === 'noticeBodyReview').reason, /尚未取得/);
});

test('量化入围后的敏感公告读取原文；完整已解决事件通过，缓存保留生命周期完成', async () => {
  const item = { id: 'AN20261013000001', date: '2026-10-13', title: '关于诉讼结案的公告' };
  const { s, calls } = scanner({ notices: symbol => ({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW,
    data: { items: [item], total: 1 } }), automatic: symbol => {
    const bundle = companyBundle(symbol, NOW), text = '本次诉讼已结案，相关义务已全部履行完毕。本次诉讼对公司生产经营未造成重大不利影响。';
    bundle.documents.push({ id: item.id, issuerSymbol: symbol, kind: 'notice', publishedAt: item.date, title: item.title,
      url: 'https://example.com/notice', fetchedAt: +NOW, complete: true, pages: 1, text,
      pageTexts: [{ page: 1, text, complete: true, method: 'provider-text', numericEligible: true }] });
    return bundle;
  } });
  let retained, ended = 0; s.evidenceRetention = symbols => { retained = symbols; }; s.endEvidenceBatch = () => { ended++; };
  const result = await runAgencyScreening(s, { requiredSymbols: ['sh600009'] });
  assert.deepEqual(retained, ['sh600009', 'sh600001']); assert.equal(ended, 1); assert.equal(calls.evidence.length, 1);
  for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pass');
  assert.equal(result.strategies.long.pass[0].entryRisk.notices.mode, 'automatic-fulltext');
  assert.equal(result.coverage.evidenceSummary.checks.noticeBodyReview.pass, 1);
});

test('快照失败、不完整和重复均抛错，不能发布空成功；忙碌不可覆盖锁', async () => {
  for (const load of [() => { throw Error('离线'); }, () => ({ rows: [], sourceCount: 0 }), () => ({ rows: [row()], sourceCount: 2 }), () => ({ rows: [row(), row()] })]) {
    const { s } = scanner({ load }); await assert.rejects(runAgencyScreening(s)); assert.equal(s.activeRun, null); assert.equal(s.progress.loading, false);
  }
  const { s } = scanner(); const active = new AbortController(); s.activeRun = active;
  await assert.rejects(runAgencyScreening(s), /已有选股任务/); assert.equal(s.activeRun, active);
});

test('公告批次超过五分钟仍研究先返回的有效候选，并在入池前刷新过期公告', async () => {
  const now = new Date(NOW), rows = Array.from({ length: 6 }, (_, index) => row(`sh60000${index + 1}`));
  const seen = new Map();
  const { s, calls } = scanner({ now, rows, notices: async symbol => {
    const count = (seen.get(symbol) || 0) + 1; seen.set(symbol, count);
    if (symbol === 'sh600006' && count === 1) {
      await new Promise(resolve => setImmediate(resolve));
      now.setTime(now.getTime() + 300001);
    }
    return { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } };
  } });
  const result = await runAgencyScreening(s);
  assert.deepEqual(calls.evidence.sort(), rows.map(item => item.symbol));
  for (const item of rows.slice(0, -1)) assert.equal(seen.get(item.symbol), 2, '先返回的公告应在最终入池前刷新');
  assert.equal(seen.get('sh600006'), 1);
  for (const id of IDS) assert.equal(result.strategies[id].pass.length, rows.length);
});

test('全文采集耗时超过公告有效期时重新取公告，新增敏感事项阻断入池', async () => {
  const now = new Date(NOW); let notices = 0;
  const { s, calls } = scanner({ now, automatic: symbol => {
    const bundle = companyBundle(symbol, now); now.setTime(now.getTime() + 360000); return bundle;
  }, notices: symbol => ({ symbol, section: 'notices', source: '东方财富', status: ++notices === 1 ? 'empty' : 'ready', fetchedAt: now.getTime(),
    data: notices === 1 ? { items: [], total: 0 } : { items: [{ id: 'AN20261013000001', date: '2026-10-13', title: '关于重大诉讼的公告' }], total: 1 } }) });
  const result = await runAgencyScreening(s);
  assert.equal(calls.notices.length, 2); assert.equal(calls.evidence.length, 1);
  for (const id of IDS) { assert.equal(state(result, id, 'sh600001'), 'pending'); assert.equal(result.strategies[id].pending[0].stage, 'notices'); }
  assert.equal(result.finishedAt, now.getTime());
});

test('最终刷新批次耗时过长时，早期目录再次过期仅待核验，不循环重试或误放行', async () => {
  const now = new Date(NOW), seen = new Map(); let advanced = false;
  const { s } = scanner({ now, rows: [row('sh600001'), row('sh600002')], automatic: symbol => {
    const bundle = companyBundle(symbol, now);
    if (!advanced) { advanced = true; now.setTime(+now + 300001); }
    return bundle;
  }, notices: async symbol => {
    const count = (seen.get(symbol) || 0) + 1; seen.set(symbol, count);
    if (symbol === 'sh600002' && count === 2) { await new Promise(resolve => setImmediate(resolve)); now.setTime(+now + 300001); }
    return { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: +now, data: { items: [], total: 0 } };
  } });
  const result = await runAgencyScreening(s);
  for (const id of IDS) {
    assert.equal(state(result, id, 'sh600001'), 'pending');
    assert.match(result.strategies[id].pending.find(row => row.symbol === 'sh600001').reasons.join('；'), /超过 5 分钟/);
    assert.equal(state(result, id, 'sh600002'), 'pass');
  }
  assert.equal(seen.get('sh600001'), 2); assert.equal(seen.get('sh600002'), 2);
});

test('财报、日线与公告服务忽略signal时仍能立即取消，不发布部分扫描', async () => {
  for (const stage of ['finance', 'daily', 'notices', 'automatic']) {
    let began; const started = new Promise(resolve => { began = resolve; });
    const { s } = scanner({ [stage]: () => { began(); return new Promise(() => {}); } });
    const running = runAgencyScreening(s); await started; s.cancel();
    await assert.rejects(running, /取消/); assert.equal(s.activeRun, null); assert.equal(s.progress.loading, false);
  }
});

test('普通数值筛选与执行时行情校验未被候选扫描语义放宽，策略快照隔离', async () => {
  const query = { ...defaults(), rules: [{ field: 'amount', op: 'gte', value: 2 }] };
  assert.equal(classifyScreenRow(row('sh600001', { amount: 0.1 }), query).status, 'failed');
  assert.equal(classifyScreenRow(row('sh600001', { amount: null }), query).status, 'pending');
  assert.equal(classifyScreenRow(row('sh600001', { amount: 0.1 }), query, { deferMinimumFields: ['amount'] }).status, 'pending');
  const policy = poolPolicy('strict'); policy.commonQuery.rules[0].value = 0; policy.priority.reverse();
  assert.equal(poolPolicy('strict').commonQuery.rules[0].value, 3); assert.deepEqual(poolPolicy().priority, IDS);
  assert.equal(AGENCY_POOL_POLICY.version, 3); assert.deepEqual(AGENCY_POOL_POLICY.commonQuery.rules, []);
  const { s } = scanner({ now: new Date('2026-10-10T08:00:00+08:00'), rows: [row('sh600001', { timestamp: Date.parse('2026-10-09T15:00:00+08:00') })] });
  const ordinary = await s.run(defaults(), [], false, null, 'short');
  assert.equal(ordinary.rows.length, 0); assert.equal(ordinary.riskExcluded[0].entryRisk.status, 'unverified');
});
