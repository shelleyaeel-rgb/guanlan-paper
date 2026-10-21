const test = require('node:test');
const assert = require('node:assert/strict');
const { CorporateSource, parsePlan, combineRows, noticeEvidence, noticeStage, TTL } = require('../core/corporate-source.cjs');
const NOW = Date.parse('2026-10-09T10:00:00+08:00');
const SYMBOL = 'sh600519', ID = 'AN202606211823708334';
const response = data => ({ ok: true, json: async () => data });
const main = (overrides = {}) => ({ SECUCODE: '600519.SH', SECURITY_CODE: '600519', REPORT_TIME: '2025-12-31 00:00:00',
  NOTICE_DATE: '2026-06-22 00:00:00', EQUITY_RECORD_DATE: '2026-06-25 00:00:00', EX_DIVIDEND_DATE: '2026-06-26 00:00:00',
  PAY_CASH_DATE: '2026-06-26 00:00:00', ASSIGN_PROGRESS: '实施方案', INFO_CODE: ID, IS_UNASSIGN: '0',
  NEW_PROFILE: '10派280.2423元(含税)', IMPL_PLAN_PROFILE: '10派280.2423元', ...overrides });
const detail = (overrides = {}) => ({ SECUCODE: '600519.SH', SECURITY_CODE: '600519', REPORT_DATE: '2025-12-31 00:00:00',
  NOTICE_DATE: '2026-06-22 00:00:00', EQUITY_RECORD_DATE: '2026-06-25 00:00:00', EX_DIVIDEND_DATE: '2026-06-26 00:00:00',
  ASSIGN_PROGRESS: '实施分配', PRETAX_BONUS_RMB: 280.2423, BONUS_RATIO: null, IT_RATIO: null,
  IMPL_PLAN_PROFILE: '10派280.2423元(含税)', ...overrides });
const announcement = (id = ID, title = '贵州茅台:2025年年度权益分派实施公告', date = '2026-06-22') => ({
  art_code: id, title, notice_date: date, codes: [{ stock_code: '600519', market_code: '1' }], columns: [] });
const body = (overrides = {}) => ({ success: 1, data: { art_code: ID, security: [{ stock: '600519', market_uni: '1' }],
  notice_date: '2026-06-22', notice_title: '贵州茅台:2025年年度权益分派实施公告', page_size: 1,
  notice_content: '每股派发现金红利28.02423元（含税）。股权登记日为2026年6月25日，除权除息日为2026年6月26日，现金红利发放日为2026年6月26日。差异化分红送转：否。', ...overrides } });
function fixture({ mainRows = [main()], detailRows = [detail()], notices = [announcement()], content = body(), pageSize = 100,
  override = () => null } = {}) {
  const calls = [];
  const fetcher = async url => {
    calls.push(url); const u = new URL(url), q = u.searchParams, other = override(u, calls);
    if (other) return other;
    if (u.hostname === 'np-cnotice-stock.eastmoney.com') return response(content);
    const page = Number(q.get('pageNumber') || q.get('page_index'));
    if (u.hostname === 'np-anotice-stock.eastmoney.com') return response({ success: 1,
      data: { list: notices.slice((page - 1) * pageSize, page * pageSize), total_hits: notices.length, page_index: page } });
    const rows = q.get('reportName') === 'RPT_F10_DIVIDEND_MAIN' ? mainRows : detailRows;
    return response({ success: true, result: { count: rows.length, pages: Math.ceil(rows.length / pageSize), data: rows.slice((page - 1) * pageSize, page * pageSize) } });
  };
  return { calls, service: new CorporateSource(fetcher, { clock: () => NOW, pageSize, transportOptions: { retryBaseMs: 0 } }) };
}
const input = { symbol: SYMBOL, fromDate: '2026-06-01' };

test('公司行为正文临时失败恢复后仍核验金额日期，诊断不伪造成功', async () => {
  let attempts = 0;
  const f = fixture({ override: u => { if (u.hostname === 'np-cnotice-stock.eastmoney.com' && ++attempts < 3) throw Error('net::ERR_HTTP2_PROTOCOL_ERROR'); return null; } });
  const result = await f.service.get(input);
  assert.equal(attempts, 3); assert.equal(result.events[0].status, 'implemented'); assert.equal(result.events[0].cashPerShare, 28.02423);
  assert.deepEqual(result.acquisition.issues, []); assert.equal(result.acquisition.events.at(-1).code, 'recovered');
  const mismatched = fixture({ content: body({ notice_content: body().data.notice_content.replace('28.02423', '1.00') }) });
  assert.equal((await mismatched.service.get(input)).events[0].status, 'unsupported');
});

test('取消公司行为采集不保存不完整结果，取消等待共享请求不影响原调用', async () => {
  const controller = new AbortController(), service = new CorporateSource(async () => new Promise(() => {}));
  const pending = service.get({ ...input, signal: controller.signal }); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(service.cache.size, 0); assert.equal(service.pending.size, 0);
  let resume; const f = fixture({ override: u => u.hostname === 'np-cnotice-stock.eastmoney.com' ? new Promise(resolve => { resume = resolve; }) : null });
  const original = f.service.get(input); while (!resume) await new Promise(resolve => setImmediate(resolve));
  const waiting = new AbortController(), observer = f.service.get({ ...input, signal: waiting.signal }); waiting.abort();
  await assert.rejects(observer, error => error.name === 'AbortError'); resume(response(body()));
  assert.equal((await original).events[0].status, 'implemented'); assert.equal(f.service.pending.size, 0);
});

test('standard plans normalise per-ten gross RMB and share ratios without guessing unknown fields', () => {
  assert.deepEqual(parsePlan('10派2.49元(含税,扣税后2.241元)'), { cashPerShare: 0.249, bonusPerShare: 0, transferPerShare: 0 });
  assert.deepEqual(parsePlan('10送2转增3派1元(含税)'), { cashPerShare: 0.1, bonusPerShare: 0.2, transferPerShare: 0.3 });
  for (const plan of ['', '10', '拟派10元', '10派2美元', '10派2元，配股3股', '10派2元(税后)', '转增待定']) assert.equal(parsePlan(plan), null);
});

test('cash distribution requires matching structure, gross rate, payment date and announcement identity', async () => {
  const { service } = fixture(), result = await service.get(input), event = result.events[0];
  assert.equal(result.status, 'ready'); assert.equal(result.coverageComplete, true);
  assert.equal(event.status, 'implemented'); assert.equal(event.cashPerShare, 28.02423);
  assert.equal(event.recordDate, '2026-06-25'); assert.equal(event.payDate, '2026-06-26');
  assert.equal(event.bodyVerified, true); assert.equal(event.bonusPerShare, 0); assert.equal(event.listingDate, null);
  assert.equal(event.taxPolicy, 'cn-individual-deferred-v1'); assert.equal(event.taxPolicySources.length, 2);
  assert.equal(event.sourceUrl, `https://data.eastmoney.com/notices/detail/600519/${ID}.html`);
  assert.equal(result.notices[0].url, event.sourceUrl);
});

test('missing rates, dates and disagreement remain explicit exceptions, never zero-value automatic events', () => {
  for (const [m, d] of [
    [main(), detail({ PRETAX_BONUS_RMB: null })], [main({ PAY_CASH_DATE: null }), detail()],
    [main(), detail({ PRETAX_BONUS_RMB: 28.02423 })], [main(), detail({ EQUITY_RECORD_DATE: '2026-06-24' })],
    [main({ NEW_PROFILE: '10派280.2423美元' }), detail()], [main({ INFO_CODE: 'https://example.com' }), detail()],
    [main(), detail({ ASSIGN_PROGRESS: '董事会预案' })]
  ]) {
    const events = combineRows([m], [d], SYMBOL, input.fromDate, '2026-10-09');
    assert.equal(events[0].status, 'unsupported'); assert.ok(events[0].reason);
  }
});

test('future implementation is retained as a schedule and a proposal cannot be used as implementation', () => {
  const future = main({ EQUITY_RECORD_DATE: '2026-10-15', EX_DIVIDEND_DATE: '2026-10-16', PAY_CASH_DATE: '2026-10-16' });
  const d = detail({ EQUITY_RECORD_DATE: '2026-10-15', EX_DIVIDEND_DATE: '2026-10-16' });
  assert.equal(combineRows([future], [d], SYMBOL, input.fromDate, '2026-10-09')[0].status, 'implemented');
  const planned = main({ ASSIGN_PROGRESS: '董事会预案', EQUITY_RECORD_DATE: null, EX_DIVIDEND_DATE: null, PAY_CASH_DATE: null });
  assert.equal(combineRows([planned], [], SYMBOL, input.fromDate, '2026-10-09')[0].status, 'planned');
  assert.equal(combineRows([main({ ASSIGN_PROGRESS: '终止分配' })], [], SYMBOL, input.fromDate, '2026-10-09')[0].status, 'cancelled');
});

test('unmatched implementation detail and duplicate records cannot disappear from review', () => {
  assert.equal(combineRows([], [detail()], SYMBOL, input.fromDate, '2026-10-09')[0].status, 'unsupported');
  const events = combineRows([main(), main({ NEW_PROFILE: '10派280元(含税)' })], [detail()], SYMBOL, input.fromDate, '2026-10-09');
  assert.equal(events.length, 2); assert.ok(events.every(e => e.status === 'unsupported'));
});

test('historical notices are paged beyond the first page and queried with explicit offline coverage dates', async () => {
  const notices = [announcement(), announcement('AN202606151823708331', '普通公告1', '2026-06-15'), announcement('AN202606141823708332', '普通公告2', '2026-06-14')];
  const { service, calls } = fixture({ notices, pageSize: 1 }), result = await service.get(input);
  assert.equal(result.coverageComplete, true); assert.equal(result.notices.length, 3);
  const urls = calls.filter(u => u.includes('security/ann')).map(u => new URL(u));
  assert.equal(urls.length, 3); assert.ok(urls.every(u => u.searchParams.get('begin_time') === input.fromDate && u.searchParams.get('end_time') === '2026-10-09'));
});

test('a late page failure preserves already found announcement links while keeping coverage incomplete', async () => {
  const { service } = fixture({ pageSize: 1, notices: [announcement(), announcement('AN202606201823708331')],
    override: u => u.pathname.includes('security/ann') && u.searchParams.get('page_index') === '2' ? { ok: false, status: 503 } : null });
  const result = await service.get(input);
  assert.equal(result.status, 'unavailable'); assert.equal(result.coverageComplete, false);
  assert.equal(result.notices.length, 1); assert.ok(result.notices[0].url.endsWith(`${ID}.html`));
});

test('report pagination verifies all rows, symbol identity and total count', async () => {
  const oldMain = main({ REPORT_TIME: '2024-12-31', NOTICE_DATE: '2025-06-22', EQUITY_RECORD_DATE: '2025-06-25', EX_DIVIDEND_DATE: '2025-06-26', PAY_CASH_DATE: '2025-06-26', INFO_CODE: 'AN202506211823708330' });
  const oldDetail = detail({ REPORT_DATE: '2024-12-31', NOTICE_DATE: '2025-06-22', EQUITY_RECORD_DATE: '2025-06-25', EX_DIVIDEND_DATE: '2025-06-26' });
  const { service, calls } = fixture({ mainRows: [main(), oldMain], detailRows: [detail(), oldDetail], pageSize: 1 });
  assert.equal((await service.get(input)).coverageComplete, true);
  assert.equal(calls.filter(u => u.includes('pageNumber=2')).length, 2);
  const bad = fixture({ mainRows: [main({ SECUCODE: '000001.SZ' })] });
  const result = await bad.service.get(input); assert.equal(result.status, 'unavailable'); assert.match(result.error, /代码或市场/);
});

test('network failure preserves source links but cannot claim complete history or reuse a fresh success', async () => {
  let fail = false;
  const { service } = fixture({ override: u => fail && u.searchParams.get('reportName') === 'RPT_SHAREBONUS_DET' ? { ok: false, status: 503 } : null });
  assert.equal((await service.get(input)).status, 'ready'); fail = true;
  const result = await service.get({ ...input, force: true });
  assert.equal(result.status, 'unavailable'); assert.equal(result.coverageComplete, false);
  assert.ok(result.notices[0].url); assert.equal(result.events[0].status, 'unsupported');
  assert.equal((await service.get(input)).status, 'unavailable');
});

test('truncated, repeated, changing and out-of-window announcement pages do not prove no event', async () => {
  for (const mode of ['repeat', 'changing', 'outside']) {
    const { service } = fixture({ pageSize: 1, override: u => {
      if (!u.pathname.includes('security/ann')) return null;
      const page = Number(u.searchParams.get('page_index'));
      const item = mode === 'outside' ? announcement(ID, '旧公告', '2026-05-30') : announcement();
      return response({ success: 1, data: { list: [item], total_hits: mode === 'outside' ? 1 : mode === 'changing' && page === 2 ? 3 : 2, page_index: page } });
    } });
    const result = await service.get(input);
    assert.equal(result.status, 'unavailable'); assert.equal(result.coverageComplete, false);
  }
});

test('only the recognised provider empty sentinel is an empty report; arbitrary failure is unavailable', async () => {
  for (const recognised of [true, false]) {
    const { service } = fixture({ mainRows: [], notices: [], override: u => u.searchParams.get('reportName') === 'RPT_SHAREBONUS_DET' ?
      response({ success: false, result: null, code: recognised ? 9201 : 9501, message: recognised ? '返回数据为空' : '服务异常' }) : null });
    const result = await service.get(input);
    assert.equal(result.status, recognised ? 'ready' : 'unavailable'); assert.equal(result.coverageComplete, recognised);
  }
});

test('missing announcement dates and capped history fail closed', async () => {
  const malformed = fixture({ mainRows: [main({ NOTICE_DATE: null })] });
  assert.equal((await malformed.service.get(input)).coverageComplete, false);
  const capped = fixture({ notices: [announcement(), announcement('AN202606201823708331')], pageSize: 1 });
  capped.service.maxPages = 1;
  assert.equal((await capped.service.get(input)).coverageComplete, false);
});

test('an implementation body from a different stock, truncated pages or differential distribution remains unsupported', async () => {
  for (const content of [body({ security: [{ stock: '000001', market_uni: '0' }] }), body({ page_size: 2 }),
    body({ notice_content: '差异化权益分派：是。虚拟每股现金红利0.1元。' })]) {
    const result = await fixture({ content }).service.get(input);
    assert.equal(result.events[0].status, 'unsupported'); assert.ok(result.events[0].reason);
  }
});

test('completed standard capital-reserve transfers require an explicit tradable listing date and source tax evidence', () => {
  const event = { recordDate: '2026-06-25', exDate: '2026-06-26', payDate: '2026-06-26', bonusPerShare: 0, transferPerShare: 0.3 };
  const listing = '本次所转的无限售条件流通股的起始交易日为2026年6月29日。';
  const tax = '本次用于转增的资本公积属于股票发行溢价形成的资本公积，不需缴纳个人所得税。';
  const result = noticeEvidence(listing + tax, event);
  assert.equal(result.listingDate, '2026-06-29'); assert.equal(result.transferTaxExempt, true); assert.equal(result.reason, '');
  assert.match(noticeEvidence(tax, event).reason, /上市日期/);
  assert.match(noticeEvidence(listing, event).reason, /股票发行溢价/);
  assert.match(noticeEvidence(listing + tax, { ...event, bonusPerShare: 0.1 }).reason, /票面税基/);
  assert.match(noticeEvidence(listing + tax + '本次所转的无限售条件流通股的起始交易日为2026年6月30日。', event).reason, /冲突/);
});

test('pure capital-premium transfer supports explicit Shanghai table dates without assuming same-day listing', async () => {
  const m = main({ NEW_PROFILE: '10转3股', IMPL_PLAN_PROFILE: '10转3股', PAY_CASH_DATE: null });
  const d = detail({ IMPL_PLAN_PROFILE: '10转3股', PRETAX_BONUS_RMB: null, IT_RATIO: 3 });
  const content = body({ notice_content: '每股转增0.3股，不派发现金。相关日期 股权登记日 除权（息）日 新增无限售条件流通股份上市日 2026/6/25 2026/6/26 2026/6/29。公司本次资本公积转增来源为股票溢价发行收入形成的资本公积金，本次转增不扣税。' });
  const result = await fixture({ mainRows: [m], detailRows: [d], content }).service.get(input);
  assert.equal(result.events[0].status, 'implemented'); assert.equal(result.events[0].bodyVerified, true);
  assert.equal(result.events[0].listingDate, '2026-06-29'); assert.equal(result.events[0].transferTaxExempt, true);
  assert.equal(result.events[0].cashPerShare, 0);
});

test('verified implementation supersedes same-period older proposals, never later corrections', async () => {
  const oldId = 'AN202606031823708331', newId = 'AN202606271823708332';
  const notices = [announcement(newId, '贵州茅台:2025年年度权益分派更正公告', '2026-06-27'), announcement(),
    announcement(oldId, '贵州茅台:关于调整2025年年度利润分配方案的公告', '2026-06-03')];
  const { events, notices: found } = await fixture({ notices }).service.get(input);
  assert.ok(events[0].noticeIds.includes(oldId)); assert.ok(!events[0].noticeIds.includes(newId));
  assert.equal(found.find(n => n.id === oldId).resolvedByEventId, events[0].eventId);
  assert.equal(found.find(n => n.id === newId).corporateStage, 'unsupported');
  assert.equal(noticeStage({ title: '2026年中期分红方案', categories: ['分配预案'] }), 'planned');
});

test('an annual distribution must not swallow the same-year rights issue, merger, split or corrected announcement', async () => {
  const titles = ['关于2025年度配股利润分配的公告', '关于2025年度合并利润分配的公告', '关于2025年度分立利润分配的公告', '关于2025年度权益分派方案更正的公告'];
  const old = titles.map((title, i) => announcement(`AN20260603182370833${i}`, title, '2026-06-03'));
  const result = await fixture({ notices: [announcement(), ...old] }).service.get(input);
  assert.deepEqual(result.events[0].noticeIds, [ID]);
  assert.ok(result.notices.slice(1).every(n => !n.resolvedByEventId));
});

test('original notice gross cash and every critical date must agree, including missing and contradictory text', async () => {
  const original = body().data.notice_content;
  for (const content of [
    original.replace('28.02423', '28.0'), original.replace('6月25日', '6月24日'),
    original.replace('除权除息日为2026年6月26日', '除权除息日为2026年6月29日'),
    original.replace('现金红利发放日为2026年6月26日', '现金红利发放日为2026年6月29日'),
    '正文只说明权益分派，不含实施日期和金额', original + '股权登记日为2026年6月24日。',
    original + '按公司现有A股总股本折算的每10股现金分红为270元。'
  ]) {
    const result = await fixture({ content: body({ notice_content: content }) }).service.get(input);
    assert.equal(result.events[0].status, 'unsupported'); assert.equal(result.events[0].bodyVerified, false);
  }
});

test('工商银行真实公告的现金股息措辞可核验，金额冲突或仅税后金额仍阻断', async () => {
  // Public notice excerpt: https://data.eastmoney.com/notices/detail/601398/AN202610141830463887.html
  const event = { symbol: 'sh601398', noticeIds: ['AN202610141830463887'], status: 'implemented',
    recordDate: '2026-10-20', exDate: '2026-10-21', payDate: '2026-10-21',
    cashPerShare: 0.1511, bonusPerShare: 0, transferPerShare: 0 };
  const original = `二、 分配方案
    (三) 分配方案：
    本次利润分配以截至分红派息股权登记日2026年10月20日的本行
    356,406,257,089普通股为基数，每股派发现金股息人民币0.1511元（含税）。
    三、 相关日期
    股份类别 股权登记日 最后交易日 除权（息）日 现金红利发放日
    Ａ股 2026/10/20 － 2026/10/21 2026/10/21
    四、 分配实施办法
    每股实际派发现金股息人民币0.12088元。`;
  const verify = async notice_content => fixture({ content: body({ art_code: event.noticeIds[0],
    security: [{ stock: '601398', market_uni: '1' }], notice_date: '2026-10-15',
    notice_title: '工商银行A股2026年半年度分红派息实施公告', notice_content })
  }).service.implementation(event, '2026-10-19');
  const verified = await verify(original);
  assert.equal(verified.status, 'implemented'); assert.equal(verified.bodyVerified, true);
  for (const content of [original.replace('0.1511', '0.1512'), original.replace('（含税）', '（税后）'),
    original.replace('三、 相关日期', '每股派发现金股息人民币0.2元（含税）。三、 相关日期')]) {
    const result = await verify(content);
    assert.equal(result.status, 'unsupported'); assert.equal(result.bodyVerified, false);
    assert.match(result.reason, /税前派息金额/);
  }
});

test('时代电气真实公告的日期表头不误作派息日，表格与正文真实冲突仍阻断', async () => {
  // Public notice excerpt: https://data.eastmoney.com/notices/detail/688187/AN202610091830263198.html
  const event = { symbol: 'sh688187', noticeIds: ['AN202610091830263198'], status: 'implemented',
    recordDate: '2026-10-15', exDate: '2026-10-16', payDate: '2026-10-16',
    cashPerShare: 0.46, bonusPerShare: 0, transferPerShare: 0 };
  const table = `相关日期
    股权登记日 除权（息）日 现金红利发放日
    2026/10/15 2026/10/16 2026/10/16`;
  const original = `重要内容提示：是否涉及差异化分红送转：否
    每股分配比例 每股现金红利0.46元（含税）
    ${table}
    二、 分配方案
    3. 分配方案：本次利润分配以方案实施前的公司总股本1,330,703,412股为基数，
    每股派发现金红利0.46元（含税），共计派发现金红利612,123,569.52元。
    三、 ${table}
    四、 分配实施办法`;
  const verify = async notice_content => fixture({ content: body({ art_code: event.noticeIds[0],
    security: [{ stock: '688187', market_uni: '1' }], notice_date: '2026-10-10',
    notice_title: '株洲中车时代电气股份有限公司2026年半年度权益分派实施公告', notice_content })
  }).service.implementation(event, '2026-10-19');
  const verified = await verify(original);
  assert.equal(verified.status, 'implemented'); assert.equal(verified.bodyVerified, true);
  for (const content of [original + '现金红利发放日为2026年10月15日。',
    original.replace('2026/10/15 2026/10/16 2026/10/16', '2026/10/15 2026/10/16 2026/10/19'),
    original.replaceAll('2026/10/15 2026/10/16 2026/10/16', '2026/10/15 2026/10/16')]) {
    const result = await verify(content);
    assert.equal(result.status, 'unsupported'); assert.equal(result.bodyVerified, false);
    assert.match(result.reason, /派息日/);
  }
});

test('cache is interval-specific and does not extend history; expired snapshots are fetched again', async () => {
  const { service, calls } = fixture(); let now = NOW; service.clock = () => now;
  await service.get(input); const first = calls.length;
  assert.equal((await service.get(input)).cached, true); assert.equal(calls.length, first);
  now += TTL + 1; await service.get(input); assert.ok(calls.length > first);
  const second = calls.length; await service.get({ ...input, fromDate: '2026-01-01' }); assert.ok(calls.length > second);
  await assert.rejects(service.get({ ...input, fromDate: '2026-02-30' }), /日期无效/);
  await assert.rejects(service.get({ ...input, symbol: 'https://evil.test' }));
});
