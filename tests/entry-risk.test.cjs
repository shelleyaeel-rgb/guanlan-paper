const test = require('node:test');
const assert = require('node:assert/strict');
const { checkMarketRisk, checkNoticeRisk, SHORT_RISK_POLICY, NOTICE_RISK_POLICY } = require('../core/entry-risk.cjs');

const NOW = Date.parse('2026-10-08T10:36:00+08:00');
const symbol = 'sh688578';
const row = extra => ({ symbol, price: 111.58, changePct: 0, timestamp: NOW, ...extra });
const notice = (title = '关于召开董事会会议的公告', date = '2026-10-08', id = 'AN2026100800000001') => ({ id, date, title, categories: [] });
const notices = (items = [], extra = {}) => ({
  symbol, section: 'notices', source: '东方财富', status: items.length ? 'ready' : 'empty',
  fetchedAt: NOW, checkedAt: NOW, data: { items, total: items.length }, ...extra
});

test('the observed 20 percent limit-down is excluded despite passing historical indicators', () => {
  const result = checkMarketRisk(row({ price: 89.26, changePct: -20, prevClose: 111.58, limitDown: 89.26, bid: 0, bidSize: 0 }), NOW);
  assert.equal(result.status, 'blocked');
  assert.equal(result.atLimitDown, true);
  assert.match(result.reasons.join('；'), /跌停且无有效买盘/);
  assert.match(result.reasons.join('；'), /20.00%/);
  assert.match(result.policyNote, /不是交易所制度/);
});

test('a conservative daily-loss threshold applies to short candidates on all supported boards', () => {
  for (const board of ['科创板', '创业板', '主板']) {
    assert.equal(checkMarketRisk(row({ board, changePct: -5 }), NOW).status, 'blocked');
    assert.equal(checkMarketRisk(row({ board, changePct: -4.99 }), NOW).status, 'clear');
  }
  assert.equal(checkMarketRisk(row({ changePct: 3.2 }), new Date(NOW)).status, 'clear');
  assert.equal(SHORT_RISK_POLICY.maxDailyLossPct, 5);
});

test('strategy quotes may derive change from the previous close while contradictions remain unverified', () => {
  const quote = { symbol, price: 95, prevClose: 100, timestamp: NOW, date: '2026-10-08', bid: 95, bidSize: 200 };
  assert.equal(checkMarketRisk(quote, NOW).status, 'blocked');
  assert.equal(checkMarketRisk({ ...quote, price: 99.99 }, NOW).status, 'clear');
  assert.equal(checkMarketRisk({ ...quote, changePct: 0 }, NOW).status, 'unverified');
});

test('missing, stale, future, cross-day and contradictory market data never pass', () => {
  const invalid = [
    null, row({ price: null }), row({ price: '111.58' }), row({ price: 0 }),
    row({ changePct: null }), row({ changePct: false }), row({ changePct: -100 }),
    row({ timestamp: null }), row({ timestamp: NOW - 90001 }), row({ timestamp: NOW + 1 }),
    row({ timestamp: Date.parse('2026-09-30T15:00:00+08:00') }), row({ date: '2026-09-30' }),
    row({ bid: 100 }), row({ canTrade: false, tradeBlockedReason: '停牌或无有效成交' })
  ];
  for (const input of invalid) assert.equal(checkMarketRisk(input, NOW).status, 'unverified', JSON.stringify(input));
  assert.equal(checkMarketRisk(row({ timestamp: NOW - 90000 }), NOW).status, 'clear');
  assert.equal(checkMarketRisk(row(), new Date('invalid')).status, 'unverified');
});

test('same-day quotes remain observable after hours but never accept future or prior-day quotes', () => {
  const afterClose = Date.parse('2026-10-08T19:00:00+08:00');
  const closeQuote = row({ timestamp: Date.parse('2026-10-08T15:00:00+08:00') });
  assert.equal(checkMarketRisk(closeQuote, afterClose).status, 'clear');
  assert.equal(checkMarketRisk(closeQuote, Date.parse('2026-10-09T08:00:00+08:00')).status, 'unverified');
  assert.equal(checkMarketRisk(closeQuote, Date.parse('2026-10-08T08:00:00+08:00')).status, 'unverified');
  const closingAuction = Date.parse('2026-10-08T14:59:00+08:00');
  assert.equal(checkMarketRisk(row({ timestamp: closingAuction - 90001 }), closingAuction).status, 'unverified');
});

test('morning quotes cannot conceal later losses during lunch breaks or after closing', () => {
  const lunch = Date.parse('2026-10-08T12:00:00+08:00');
  const evening = Date.parse('2026-10-08T19:00:00+08:00');
  const morningQuote = row({ timestamp: Date.parse('2026-10-08T09:31:00+08:00') });
  for (const at of [lunch, evening]) assert.equal(checkMarketRisk(morningQuote, at).status, 'unverified');
  for (const [at, boundary] of [[lunch, '11:28:30'], [evening, '14:58:30']]) {
    const timestamp = Date.parse(`2026-10-08T${boundary}+08:00`);
    assert.equal(checkMarketRisk(row({ timestamp }), at).status, 'clear');
    assert.equal(checkMarketRisk(row({ timestamp: timestamp - 1 }), at).status, 'unverified');
    assert.equal(checkMarketRisk(row({ timestamp, changePct: -20 }), at).status, 'blocked');
  }
  const noonQuote = row({ timestamp: Date.parse('2026-10-08T11:30:00+08:00') });
  assert.equal(checkMarketRisk(noonQuote, lunch).status, 'clear');
  assert.equal(checkMarketRisk(noonQuote, evening).status, 'unverified');
});

test('pre-market quotes use the 90-second bound and weekend same-day quotes are unverified', () => {
  const preOpen = Date.parse('2026-10-08T09:10:00+08:00');
  assert.equal(checkMarketRisk(row({ timestamp: preOpen - 90000 }), preOpen).status, 'clear');
  assert.equal(checkMarketRisk(row({ timestamp: preOpen - 90001 }), preOpen).status, 'unverified');
  for (const day of ['2026-10-10', '2026-10-11']) {
    const at = Date.parse(`${day}T10:00:00+08:00`);
    assert.equal(checkMarketRisk(row({ timestamp: at }), at).status, 'unverified');
  }
});

test('market review metadata retains the price and source used by the check', () => {
  const result = checkMarketRisk(row({ source: '腾讯财经' }), NOW);
  assert.equal(result.price, 111.58);
  assert.equal(result.source, '腾讯财经');
  assert.equal(result.quoteTime, NOW);
});

test('missing exit liquidity is excluded independently of the size of the fall', () => {
  const result = checkMarketRisk(row({ changePct: -1, bid: 0, bidSize: 0 }), NOW);
  assert.equal(result.status, 'blocked');
  assert.match(result.reasons.join('；'), /无有效买盘/);
  const stLimit = checkMarketRisk(row({ price: 95, prevClose: 100, changePct: -5, limitDown: 95, bid: 95, bidSize: 100 }), NOW);
  assert.equal(stLimit.atLimitDown, true);
  assert.match(stLimit.reasons.join('；'), /跌停价/);
});

test('an authenticated empty notice response passes only the bounded title check', () => {
  const result = checkNoticeRisk(notices(), symbol, NOW);
  assert.equal(result.status, 'clear');
  assert.equal(result.coverageComplete, true);
  assert.equal(result.windowStart, '2026-09-25');
  assert.equal(result.windowEnd, '2026-10-08');
  assert.match(result.reasons[0], /不代表没有重大风险/);
  assert.match(result.scope, /公告原文/);
});

test('notice policy metadata is shared across strategies and independent of short-term market thresholds', () => {
  assert.deepEqual(NOTICE_RISK_POLICY, { noticeMaxAgeMs: 300000, noticeLookbackDays: 14, noticeLimit: 30 });
  assert.deepEqual(SHORT_RISK_POLICY, { maxDailyLossPct: 5, quoteMaxAgeMs: 90000 });
  assert.equal(Object.isFrozen(NOTICE_RISK_POLICY), true);
  assert.equal(Object.isFrozen(SHORT_RISK_POLICY), true);
  assert.equal(checkMarketRisk(row(), NOW).policy, SHORT_RISK_POLICY);
  for (const input of [notices(), notices([notice('临床试验进展')]), null]) {
    const result = checkNoticeRisk(input, symbol, NOW);
    assert.equal(result.policy, NOTICE_RISK_POLICY);
    assert.equal(result.policy.maxDailyLossPct, undefined);
    assert.match(result.scope, /各策略统一/);
    assert.match(result.scope, /不能据此认定风险已经消除/);
  }
});

test('the actual clinical-progress wording and even positive progress require original-notice review', () => {
  const title = '关于伏美替尼用于EGFR 20外显子插入突变NSCLC一线治疗的关键性临床试验进展的公告';
  for (const text of [title, '关于临床试验达到主要研究终点的公告', '关于临床试验因疗效显著提前终止的公告', '关于减持计划提前终止的公告']) {
    const result = checkNoticeRisk(notices([notice(text, '2026-09-30')]), symbol, NOW);
    assert.equal(result.status, 'unverified');
    assert.equal(result.notices[0].title, text);
    assert.equal(result.notices[0].status, 'unverified');
    assert.match(result.notices[0].reason, /标题正面也不自动放行/);
  }
});

test('explicit adverse title wording prevents entry and preserves the source for review', () => {
  const item = notice('关于临床试验未达到主要研究终点的公告', '2026-09-30');
  const result = checkNoticeRisk(notices([item]), symbol, NOW);
  assert.equal(result.status, 'blocked');
  assert.equal(result.notices[0].id, item.id);
  assert.equal(result.notices[0].date, item.date);
  assert.equal(result.notices[0].status, 'blocked');
});

test('legal, financial and supply events require review without claiming the titles prove adverse impact', () => {
  for (const title of ['重大诉讼进展', '收到立案告知书', '行政处罚事先告知', '退市风险提示', '2026年第三季度业绩预告', '业绩快报', '股东减持计划', '限售股解禁', '解除限售', '终止资产收购']) {
    assert.equal(checkNoticeRisk(notices([notice(title)]), symbol, NOW).status, 'unverified', title);
  }
});

test('audit opinions and financial performance corrections require original-notice review', () => {
  for (const title of ['审计意见说明', '非标审计相关事项说明', '非标准审计报告说明', '保留意见涉及事项', '无法表示意见审计报告', '否定意见事项说明', '关于更正公司经营业绩的公告', '关于公司经营业绩修正的公告', '财务报告更正公告', '关于修正财务数据的公告']) {
    const result = checkNoticeRisk(notices([notice(title)]), symbol, NOW);
    assert.equal(result.status, 'unverified', title);
    assert.equal(result.notices[0].title, title);
  }
});

test('the 14 calendar-day window includes holiday disclosures and excludes older events', () => {
  const included = checkNoticeRisk(notices([notice('关于重大诉讼的公告', '2026-09-25')]), symbol, NOW);
  const excluded = checkNoticeRisk(notices([notice('关于重大诉讼的公告', '2026-09-24')]), symbol, NOW);
  assert.equal(included.status, 'unverified');
  assert.equal(excluded.status, 'clear');
  assert.deepEqual(excluded.notices, []);
});

test('truncated latest notices cannot silently claim coverage, including same-day boundary ties', () => {
  const short = notices([notice()], { data: { items: [notice()], total: 40 } });
  const result = checkNoticeRisk(short, symbol, NOW);
  assert.equal(result.status, 'unverified');
  assert.equal(result.coverageComplete, false);
  assert.match(result.reasons[0], /未覆盖完整 14 日/);
  const boundary = notice('普通公告', '2026-09-25');
  assert.equal(checkNoticeRisk(notices([boundary], { data: { items: [boundary], total: 31 } }), symbol, NOW).status, 'unverified');
  const old = notice('普通公告', '2026-09-24');
  assert.equal(checkNoticeRisk(notices([old], { data: { items: [old], total: 31 } }), symbol, NOW).status, 'clear');
});

test('failed, mismatched and stale notice data never pass as no adverse events', () => {
  for (const input of [
    null, notices([], { symbol: 'sz000001' }), notices([], { section: 'finance' }),
    notices([], { source: 'unknown' }), notices([], { status: 'stale' }), notices([], { status: 'unavailable' }),
    notices([], { error: 'network offline' }), notices([], { fetchedAt: null }),
    notices([], { fetchedAt: NOW + 1 }), notices([], { fetchedAt: NOW - 300001 })
  ]) assert.equal(checkNoticeRisk(input, symbol, NOW).status, 'unverified', JSON.stringify(input));
  assert.equal(checkNoticeRisk(notices([], { fetchedAt: NOW - 300000 }), symbol, NOW).status, 'clear');
  assert.equal(checkNoticeRisk(notices(), 'invalid', NOW).status, 'unverified');
});

test('malformed, future-dated, duplicate or oversized notice lists remain unverified', () => {
  const invalidLists = [
    [notice('普通公告', '2026-02-30')], [notice('普通公告', '2026-10-09')],
    [notice('')], [notice('普通公告', '2026-10-08', 'https://evil.test')], [notice(), notice()],
    [{ ...notice(), categories: [null] }], Array.from({ length: 31 }, (_, i) => notice('普通公告', '2026-10-08', `AN2026100800${String(i).padStart(4, '0')}`))
  ];
  for (const items of invalidLists) assert.equal(checkNoticeRisk(notices(items), symbol, NOW).status, 'unverified');
  for (const data of [{ items: [], total: 1 }, { items: [notice()], total: 0 }, { items: [], total: null }]) {
    assert.equal(checkNoticeRisk(notices([], { data }), symbol, NOW).status, 'unverified');
  }
  assert.equal(checkNoticeRisk(notices([notice()], { status: 'empty' }), symbol, NOW).status, 'unverified');
  assert.equal(checkNoticeRisk(notices([], { status: 'ready' }), symbol, NOW).status, 'unverified');
});

test('risk checks do not modify provider data or caller-owned arrays', () => {
  const response = notices([notice('临床试验进展')]);
  const before = structuredClone(response);
  const checked = checkNoticeRisk(response, symbol, NOW);
  checked.notices[0].categories.push('本地备注');
  assert.deepEqual(response, before);
  const quote = row(), quoteBefore = structuredClone(quote);
  checkMarketRisk(quote, NOW);
  assert.deepEqual(quote, quoteBefore);
});
