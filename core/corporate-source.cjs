'use strict';
const { CorporateRequest, waitForCorporateRequest } = require('./corporate-request.cjs');
const { symbolOf, cnTime } = require('./common.cjs');
const { parseNotices, externalUrl } = require('./research.cjs');

const SOURCE = '东方财富公司行为及公告';
const TTL = 300000;
const FAILURE_TTL = 60000, MAX_CACHE_ENTRIES = 2048;
const MAIN_REPORT = 'RPT_F10_DIVIDEND_MAIN';
const DETAIL_REPORT = 'RPT_SHAREBONUS_DET';
// Verified 2026-10-09 against the tax authority and CSRC. This describes the
// simulator's domestic individual, exchange-traded unrestricted A-share account.
// It does not apply to Stock Connect, foreign institutions or restricted awards.
const TAX_POLICY = { taxPolicy: 'cn-individual-deferred-v1', taxPolicyCheckedAt: '2026-10-09',
  taxPolicyScope: '境内自然人通过沪深交易所买入的非限售人民币普通A股', taxPolicySources: [
    'https://www.chinatax.gov.cn/n810341/n810755/c1797427/content.html',
    'https://www.csrc.gov.cn/csrc/c100028/c1002394/content.shtml' ] };
const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : null;
const text = value => typeof value === 'string' ? value.trim() : '';
const securityCode = symbol => `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(value)) return null;
  const result = value.slice(0, 10), at = Date.parse(result);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === result ? result : null;
}
function noticeLink(symbol, id) {
  try { return externalUrl({ symbol, kind: 'notice', article: id }); } catch { return null; }
}
function stage(value) {
  const label = text(value);
  if (/取消|终止|不实施|不分配不转增/.test(label)) return 'cancelled';
  if (/更正|修正/.test(label)) return 'unsupported';
  if (/^实施(?:方案|分配)$/.test(label)) return 'implemented';
  if (/预案|预披露|股东大会|董事会/.test(label)) return 'planned';
  return 'unsupported';
}
function noticeStage(notice) {
  const title = notice.title;
  if (!/分红|分配|分派|送股|转增|除权|除息|配股|合并|分立/.test(title)) return null;
  if (/取消|终止/.test(title)) return 'cancelled';
  if (/更正|修正|调整|配股|合并|分立/.test(title)) return 'unsupported';
  if (/实施|除权|除息/.test(title)) return 'implemented';
  if (/预案|预披露|提议|提案|拟定|规划|计划/.test(title) || notice.categories?.some(c => /分配预案|分配方案决议/.test(c))) return 'planned';
  return 'unsupported';
}

// These provider fields are per TEN old shares. Null means unknown; a zero may
// only be inferred from a fully recognised, complete standard distribution plan.
function parsePlan(value) {
  const s = text(value).replace(/\s/g, '').replace(/（/g, '(').replace(/）/g, ')');
  if (s === '不分配不转增') return { cashPerShare: 0, bonusPerShare: 0, transferPerShare: 0 };
  const match = /^10(?:送(\d+(?:\.\d+)?)(?:股)?)?(?:转(?:增)?(\d+(?:\.\d+)?)(?:股)?)?(?:派(\d+(?:\.\d+)?)元)?(?:\(含税(?:,扣税后\d+(?:\.\d+)?元?)?\))?$/.exec(s);
  if (!match || match.slice(1).every(v => v === undefined)) return null;
  const perShare = value => value === undefined ? 0 : Number((Number(value) / 10).toFixed(12));
  return { cashPerShare: perShare(match[3]), bonusPerShare: perShare(match[1]), transferPerShare: perShare(match[2]) };
}
function same(a, b) { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9; }
function combineRows(mainRows, detailRows, symbol, fromDate, today) {
  const used = new Set(), events = [];
  for (const row of mainRows) {
    const noticeDate = dateOnly(row.NOTICE_DATE), reportDate = dateOnly(row.REPORT_TIME);
    const recordDate = dateOnly(row.EQUITY_RECORD_DATE), exDate = dateOnly(row.EX_DIVIDEND_DATE), payDate = dateOnly(row.PAY_CASH_DATE);
    if (noticeDate && noticeDate > today) continue;
    if (![noticeDate, recordDate, exDate, payDate].some(d => d && d >= fromDate)) continue;
    const noticeId = text(row.INFO_CODE), sourceUrl = noticeLink(symbol, noticeId);
    const profile = text(row.NEW_PROFILE) || text(row.IMPL_PLAN_PROFILE), plan = parsePlan(profile);
    const declaredStage = stage(row.IS_UNASSIGN === '1' && profile === '不分配不转增' ? profile : row.ASSIGN_PROGRESS);
    const event = { eventId: `${symbol}:${reportDate || 'unknown'}:${recordDate || noticeId || 'unknown'}`,
      symbol, reportDate, noticeDate, noticeIds: sourceUrl ? [noticeId] : [], sourceUrl,
      status: declaredStage, recordDate, exDate, payDate, listingDate: null,
      cashPerShare: plan?.cashPerShare ?? null, bonusPerShare: plan?.bonusPerShare ?? null,
      transferPerShare: plan?.transferPerShare ?? null, profile, reason: '' };
    const problems = [];
    if (!noticeDate || !reportDate || !sourceUrl) problems.push('实施资料缺少有效公告日期、报告期或原文编号');
    const matches = detailRows.filter(r => dateOnly(r.REPORT_DATE) === reportDate &&
      (!recordDate || !dateOnly(r.EQUITY_RECORD_DATE) || dateOnly(r.EQUITY_RECORD_DATE) === recordDate));
    matches.forEach(r => used.add(r));
    if (declaredStage === 'implemented') {
      if (!recordDate || !exDate || recordDate >= exDate) problems.push('登记日或除权日缺失、顺序异常');
      if (!plan) problems.push('不是可完整解析的标准人民币分配方案');
      if (event.cashPerShare > 0 && (!payDate || payDate < exDate)) problems.push('现金红利发放日缺失或早于除权日');
      if (matches.length !== 1) problems.push('结构化分红明细缺失或重复');
      if (matches.length === 1) {
        const d = matches[0], detailPlan = parsePlan(d.IMPL_PLAN_PROFILE);
        if (stage(d.ASSIGN_PROGRESS) !== 'implemented' || dateOnly(d.NOTICE_DATE) > today ||
            dateOnly(d.EQUITY_RECORD_DATE) !== recordDate || dateOnly(d.EX_DIVIDEND_DATE) !== exDate) problems.push('两份资料的实施状态或关键日期不一致');
        for (const [field, key] of [['PRETAX_BONUS_RMB', 'cashPerShare'], ['BONUS_RATIO', 'bonusPerShare'], ['IT_RATIO', 'transferPerShare']]) {
          const raw = number(d[field]);
          const amount = raw === null && detailPlan?.[key] === 0 ? 0 : raw === null ? null : raw / 10;
          if (!same(amount, event[key]) || !same(detailPlan?.[key], event[key])) problems.push(`${field} 与每十股分配方案不一致或缺失`);
        }
      }
      if (plan && event.cashPerShare + event.bonusPerShare + event.transferPerShare <= 0) problems.push('实施方案没有有效的分配数量');
    }
    if (declaredStage === 'unsupported') problems.push('公司行为状态待核实或包含更正');
    if (problems.length) { event.status = 'unsupported'; event.reason = problems.join('；'); }
    events.push(event);
  }
  // An implemented row which did not have a corresponding announcement record
  // must remain visible as an exception; an incomplete join is never "no event".
  for (const row of detailRows) {
    if (used.has(row) || stage(row.ASSIGN_PROGRESS) !== 'implemented') continue;
    const noticeDate = dateOnly(row.NOTICE_DATE), recordDate = dateOnly(row.EQUITY_RECORD_DATE), exDate = dateOnly(row.EX_DIVIDEND_DATE);
    if (noticeDate > today || ![noticeDate, recordDate, exDate].some(d => d && d >= fromDate)) continue;
    const reportDate = dateOnly(row.REPORT_DATE), plan = parsePlan(row.IMPL_PLAN_PROFILE);
    events.push({ eventId: `${symbol}:${reportDate || 'unknown'}:${recordDate || 'unmatched'}`, symbol, reportDate,
      noticeDate, noticeIds: [], sourceUrl: null, status: 'unsupported', recordDate, exDate, payDate: null, listingDate: null,
      cashPerShare: plan?.cashPerShare ?? null, bonusPerShare: plan?.bonusPerShare ?? null, transferPerShare: plan?.transferPerShare ?? null,
      profile: text(row.IMPL_PLAN_PROFILE), reason: '分红明细缺少可匹配的实施公告或派息资料' });
  }
  const counts = new Map();
  for (const e of events) counts.set(e.eventId, (counts.get(e.eventId) || 0) + 1);
  for (const e of events) if (counts.get(e.eventId) > 1) { e.status = 'unsupported'; e.reason = '同一公司行为存在重复或冲突记录'; }
  return events.sort((a, b) => (a.exDate || a.noticeDate || '').localeCompare(b.exDate || b.noticeDate || ''));
}
function chineseDate(value) {
  const m = /^(\d{4})(?:年|\/|-)(\d{1,2})(?:月|\/|-)(\d{1,2})日?$/.exec(value);
  return m ? dateOnly(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`) : null;
}
function sseDateTables(compact) {
  const results = [], date = '(\\d{4}(?:年|/|-)\\d{1,2}(?:月|/|-)\\d{1,2}日?)';
  for (const start of compact.matchAll(/相关日期/g)) {
    const part = compact.slice(start.index, start.index + 350), firstDate = new RegExp(date).exec(part);
    if (!firstDate) continue;
    const header = part.slice(0, firstDate.index);
    if (!/股权登记日/.test(header) || !/除权[（(]息[）)]/.test(header)) continue;
    const hasListing = /新增无限售条件流通股份上市日/.test(header), hasCash = /现金红利发放日/.test(header);
    if (!hasListing && !hasCash) continue;
    const pattern = new RegExp('^' + date + '[－—-]?' + date + (hasListing ? date : '') + (hasCash ? date : ''));
    const row = pattern.exec(part.slice(firstDate.index));
    if (!row) continue;
    results.push({ textStart: start.index, textEnd: start.index + firstDate.index + row[0].length,
      recordDate: chineseDate(row[1]), exDate: chineseDate(row[2]),
      listingDate: hasListing ? chineseDate(row[3]) : null, payDate: hasCash ? chineseDate(row[hasListing ? 4 : 3]) : null });
  }
  return results;
}
function noticeEvidence(content, event) {
  const compact = content.replace(/\s/g, '');
  const reason = [];
  if (/差异化(?:分红送转|权益分派)[：:]?是/.test(compact) || /虚拟分派|虚拟每股|总股本折算的每(?:10)?股(?:现金|转增|除权)/.test(compact)) reason.push('差异化分派需要核实除权参考价，暂不自动调整');
  if (/更正|修正|取消|终止/.test(event.title || '')) reason.push('实施公告发生更正或撤销');
  const listingDates = new Set();
  const date = '(\\d{4}(?:年|/|-)\\d{1,2}(?:月|/|-)\\d{1,2}日?)';
  const pattern = new RegExp('(?:本次所[送转][^。；]{0,30}(?:无限售条件流通股|新增股份)[^。；]{0,10}(?:起始交易日|上市(?:流通)?日)|新增无限售条件流通股份上市日|新增(?:可流通)?股份上市日)[为是：:]+' + date, 'g');
  for (const match of compact.matchAll(pattern)) { const d = chineseDate(match[1]); if (d) listingDates.add(d); }
  // SSE's compact standard date table gives explicit column order; only accept
  // all four dates with the other three exactly matching the structured record.
  for (const table of sseDateTables(compact)) {
    if (table.recordDate === event.recordDate && table.exDate === event.exDate && table.payDate === event.payDate && table.listingDate) listingDates.add(table.listingDate);
  }
  const listingDate = listingDates.size === 1 ? [...listingDates][0] : null;
  const taxFreeTransfer = /(?:本次|此次)[^。；]{0,100}(?:转增|资本公积)[^。；]{0,100}(?:股票|股份|股本)(?:发行)?溢价[^。；]{0,100}(?:不扣税|(?:不(?:需|须)?(?:缴纳|征收)|免征)[^。；]{0,20}个人所得税)/.test(compact);
  if (event.bonusPerShare > 0) reason.push('送红股票面税基和股份取得日期需要核实');
  if (event.transferPerShare > 0) {
    if (!listingDate || listingDate < event.exDate) reason.push('新增流通股份上市日期缺失或冲突');
    if (!taxFreeTransfer) reason.push('未明确证实本次转增来自股票发行溢价且个人免税');
  }
  return { listingDate, transferTaxExempt: taxFreeTransfer, reason: reason.join('；') };
}

function implementationFacts(content, event) {
  const compact = content.replace(/\s/g, ''), problems = [];
  // Restrict monetary checks to the actual implementation section when present:
  // older proposals and other taxpayer classes can contain different amounts.
  const implementation = compact.match(/(?:二、本次实施的[^。；]{0,30}方案|[（(]三[）)]分配方案)[：:]?([\s\S]*?)(?:三、|[（(]四[）)]|$)/)?.[1] || compact;
  const cash = [...implementation.matchAll(/每(10)?股(?:派(?:发)?(?:现金(?:红利|股利|分红|股息)?)?|现金红利)(?:人民币)?(\d+(?:\.\d+)?)元(?:人民币(?:现金)?)?[（(]含税/g)]
    .map(m => Number((Number(m[2]) / (m[1] ? 10 : 1)).toFixed(12)));
  if (event.cashPerShare > 0 && (!cash.length || cash.some(n => !same(n, event.cashPerShare)))) problems.push('公告正文税前派息金额缺失或与结构化资料不一致');
  if (event.cashPerShare === 0 && cash.some(n => n !== 0)) problems.push('公告正文存在结构化资料未载明的现金分红');
  const date = '(\\d{4}(?:年|/|-)\\d{1,2}(?:月|/|-)\\d{1,2}日?)';
  const dates = { recordDate: new Set(), exDate: new Set(), payDate: new Set() }, tables = sseDateTables(compact);
  const readDates = (key, label) => {
    for (const m of compact.matchAll(new RegExp(label + '(?:为|是)?[：:]?' + date, 'g'))) {
      // Whitespace removal joins the last table heading to the first column's
      // date. Read recognised table spans by column only; prose outside the
      // table still participates in conflict detection.
      if (tables.some(table => m.index >= table.textStart && m.index < table.textEnd)) continue;
      const value = chineseDate(m[1]); if (value) dates[key].add(value);
    }
  };
  readDates('recordDate', '股权登记日');
  readDates('exDate', '除权(?:(?:除息|[（(]息[）)])日|日[（(]除息日[）)])(?:及现金红利发放日)?');
  readDates('payDate', '(?:现金红利发放日|派息日|现金红利将于)');
  for (const table of tables) {
    dates.recordDate.add(table.recordDate); dates.exDate.add(table.exDate);
    if (table.payDate) dates.payDate.add(table.payDate);
  }
  for (const key of ['recordDate', 'exDate', ...(event.cashPerShare > 0 ? ['payDate'] : [])]) {
    if (dates[key].size !== 1 || !dates[key].has(event[key])) problems.push(`公告正文${({ recordDate: '股权登记日', exDate: '除权日', payDate: '派息日' })[key]}缺失或与结构化资料冲突`);
  }
  if (event.transferPerShare > 0) {
    const ratios = [...implementation.matchAll(/每(10)?股转增(\d+(?:\.\d+)?)股/g)].map(m => Number(m[2]) / (m[1] ? 10 : 1));
    if (!ratios.length || ratios.some(n => !same(n, event.transferPerShare))) problems.push('公告正文转增比例缺失或与结构化资料不一致');
  }
  return problems.join('；');
}

const { afterPending } = require('./fresh-request.cjs');
class CorporateSource {
  constructor(fetcher = fetch, { clock = Date.now, timeoutMs = 10000, pageSize = 100, maxPages = 100, transportOptions = {}, noticeSource = null } = {}) {
    this.noticeSource = noticeSource;
    Object.assign(this, { fetcher, clock, timeoutMs, pageSize, maxPages });
    this.transport = new CorporateRequest((...args) => this.fetcher(...args), { clock, timeoutMs, ...transportOptions });
    this.cache = new Map(); this.pending = new Map(); this.nextForced = new Map();
  }
  async request(url, options) { return this.transport.json(url, options); }
  async report(symbol, reportName, options) {
    const rows = [], ids = new Set(); let expectedCount = null, pages = 1;
    try {
    for (let page = 1; page <= pages; page++) {
      if (page > this.maxPages) throw Error('公司行为历史超过分页上限，覆盖不完整');
      const base = reportName === MAIN_REPORT ? 'https://datacenter.eastmoney.com/securities' : 'https://datacenter-web.eastmoney.com';
      const query = new URLSearchParams({ reportName, columns: 'ALL', filter: `(SECUCODE="${securityCode(symbol)}")`,
        pageSize: String(this.pageSize), pageNumber: String(page), sortColumns: 'NOTICE_DATE', sortTypes: '-1' });
      const json = await this.request(`${base}/api/data/v1/get?${query}`, { ...options, stage: 'corporate-report' });
      // This precise documented-by-live-response sentinel is an empty dataset,
      // unlike transport failures, malformed JSON, or arbitrary success:false.
      if (page === 1 && json?.success === false && json.code === 9201 && json.message === '返回数据为空' && json.result === null) return [];
      const r = json?.result;
      if (json?.success !== true || !Array.isArray(r?.data) || !Number.isInteger(r.count) || r.count < 0 ||
          !Number.isInteger(r.pages) || r.pages < 0 || (r.count > 0 && (r.pages < 1 || !r.data.length))) throw Error('公司行为报表返回格式异常');
      if (expectedCount !== null && (r.count !== expectedCount || r.pages !== pages)) throw Error('公司行为分页期间数据发生变化，请重新核验');
      expectedCount = r.count; pages = r.pages;
      for (const row of r.data) {
        if (row?.SECUCODE !== securityCode(symbol) || row.SECURITY_CODE !== symbol.slice(2)) throw Error('公司行为资料股票代码或市场不符');
        if (!dateOnly(row.NOTICE_DATE)) throw Error('公司行为资料缺少有效公告日期，无法确认历史覆盖');
        const key = JSON.stringify(row);
        if (ids.has(key)) throw Error('公司行为分页出现重复记录，覆盖不完整');
        ids.add(key); rows.push(row);
      }
    }
    if (rows.length !== expectedCount) throw Error('公司行为分页数量不完整');
    return rows;
    } catch (error) { error.partial = rows; throw error; }
  }
  async notices(symbol, fromDate, today, options) {
    try { return await this.eastmoneyNotices(symbol, fromDate, today, options); }
    catch (primary) {
      options?.signal?.throwIfAborted(); if (!this.noticeSource) throw primary;
      try {
        const result = await this.noticeSource.getIndex(symbol, fromDate, today, { signal: options?.signal, force: options?.force });
        if (!result.complete) throw Error('巨潮备用目录覆盖不完整');
        options?.onDiagnostic?.({ stage: 'corporate-index', recovered: true, source: '巨潮资讯', primaryError: primary.message });
        return result.items.map(row => ({ ...row, corporateStage: noticeStage(row) }));
      } catch (fallback) { options?.signal?.throwIfAborted(); primary.message += `；巨潮公告备用失败：${fallback.message}`; throw primary; }
    }
  }
  async eastmoneyNotices(symbol, fromDate, today, options) {
    const notices = [], ids = new Set(); let total = null;
    try {
    for (let page = 1; ; page++) {
      if (page > this.maxPages) throw Error('历史公告超过分页上限，覆盖不完整');
      const query = new URLSearchParams({ sr: '-1', page_size: String(this.pageSize), page_index: String(page), ann_type: 'A',
        stock_list: symbol.slice(2), begin_time: fromDate, end_time: today });
      const json = await this.request(`https://np-anotice-stock.eastmoney.com/api/security/ann?${query}`, { ...options, stage: 'corporate-index' });
      const parsed = parseNotices(json, symbol, this.clock());
      if (json.data.page_index != null && Number(json.data.page_index) !== page) throw Error('历史公告返回了错误页码');
      if (parsed.items.length !== json.data.list.length || parsed.items.some(n => n.date < fromDate || n.date > today)) throw Error('历史公告返回日期超出核验区间');
      if (total !== null && parsed.total !== total) throw Error('历史公告分页期间数量发生变化，请重新核验');
      total = parsed.total;
      for (const n of parsed.items) {
        if (ids.has(n.id)) throw Error('历史公告重复，覆盖不完整');
        ids.add(n.id); notices.push({ ...n, url: noticeLink(symbol, n.id), corporateStage: noticeStage(n) });
      }
      if (notices.length === total) return notices;
      if (!parsed.items.length || notices.length > total) throw Error('历史公告分页数量不完整');
    }
    } catch (error) { error.partial = notices; throw error; }
  }
  async implementation(event, today, options) {
    const chunks = []; let total = null, title = '';
    for (let page = 1; ; page++) {
      if (page > 20) throw Error('实施公告正文超出分页上限');
      const query = new URLSearchParams({ art_code: event.noticeIds[0], page_index: String(page), client_source: 'web', f_node: '0', s_node: '0' });
      const json = await this.request(`https://np-cnotice-stock.eastmoney.com/api/content/ann?${query}`, { ...options, stage: 'corporate-body', documentId: event.noticeIds[0] }), d = json?.data;
      if (json?.success !== 1 || d?.art_code !== event.noticeIds[0] || !Array.isArray(d.security) ||
          !d.security.some(s => s.stock === event.symbol.slice(2) && String(s.market_uni) === (event.symbol.startsWith('sh') ? '1' : '0')) ||
          !text(d.notice_content) || !dateOnly(d.notice_date) || dateOnly(d.notice_date) > today ||
          !Number.isInteger(Number(d.page_size)) || Number(d.page_size) < 1) throw Error('实施公告正文的身份、日期或完整性无法核实');
      if (total !== null && total !== Number(d.page_size)) throw Error('实施公告正文分页数量变化');
      total = Number(d.page_size); title = text(d.notice_title);
      if (chunks.includes(d.notice_content)) throw Error('实施公告正文分页重复');
      chunks.push(d.notice_content);
      if (page >= total) break;
    }
    const content = chunks.join('\n'), evidence = noticeEvidence(content, { ...event, title });
    const reason = [implementationFacts(content, event), evidence.reason].filter(Boolean).join('；');
    return { ...event, title, listingDate: evidence.listingDate, transferTaxExempt: evidence.transferTaxExempt,
      ...(event.cashPerShare > 0 && event.recordDate >= '2015-09-08' ? TAX_POLICY : {}),
      status: reason ? 'unsupported' : event.status, reason: reason || event.reason, bodyVerified: !reason };
  }
  async get(input) {
    input?.signal?.throwIfAborted();
    const symbol = symbolOf(input?.symbol), today = cnTime(this.clock()).date, fromDate = dateOnly(input?.fromDate);
    if (!fromDate || fromDate > today) throw Error('公司行为核验起始日期无效');
    const key = `${symbol}:${fromDate}:${today}`, previous = this.cache.get(key);
    if (this.nextForced.has(key)) return waitForCorporateRequest(this.nextForced.get(key), input.signal);
    // A queued refresh is shared work. Cancelling one waiter must not cancel the
    // successor needed by other callers; each waiter keeps its own abort gate.
    if (this.pending.has(key)) return waitForCorporateRequest(input.force
      ? afterPending(this.pending, this.nextForced, key, () => this.get({ ...input, signal: undefined, force: true })) : this.pending.get(key), input.signal);
    const age = this.clock() - previous?.fetchedAt;
    if (!input.force && previous && age >= 0 && age < (previous.status === 'ready' ? TTL : FAILURE_TTL)) {
      this.cache.delete(key); this.cache.set(key, previous);
      return { ...previous, cached: true };
    }
    const task = (async () => {
      const acquisition = { issues: [], events: [] }, options = { signal: input.signal, force: input.force, onDiagnostic: event => acquisition.events.push(event) };
      const responses = await Promise.allSettled([this.report(symbol, MAIN_REPORT, options), this.report(symbol, DETAIL_REPORT, options), this.notices(symbol, fromDate, today, options)]);
      input.signal?.throwIfAborted();
      const errors = responses.filter(r => r.status === 'rejected').map(r => r.reason?.message || '公司行为资料获取失败');
      acquisition.issues.push(...responses.filter(r => r.status === 'rejected' && r.reason?.acquisition).map(r => r.reason.acquisition));
      const value = i => responses[i].status === 'fulfilled' ? responses[i].value : responses[i].reason?.partial || [];
      const notices = value(2), events = combineRows(value(0), value(1), symbol, fromDate, today);
      const queue = events.map((e, i) => ({ e, i })).filter(({ e }) => e.status === 'implemented');
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length) {
          const { e, i } = queue.shift();
          try { events[i] = await this.implementation(e, today, options); }
          catch (error) { input.signal?.throwIfAborted(); if (error.acquisition) acquisition.issues.push(error.acquisition);
            events[i] = { ...e, status: 'unsupported', reason: error.message || '实施公告正文无法读取', ...(error.acquisition ? { acquisition: error.acquisition } : {}) }; }
        }
      }));
      // Match announcement corrections by the explicit implementation article.
      // Unmatched articles are intentionally retained for the engine to inspect.
      for (const e of events) {
        const related = notices.filter(n => e.noticeIds.includes(n.id));
        if (related.some(n => ['cancelled', 'unsupported'].includes(n.corporateStage))) {
          e.status = 'unsupported'; e.reason = '关联实施公告存在更正、撤销或非标准公司行为';
        }
      }
      // A later verified implementation supersedes earlier plans/adjustments
      // only when the announcement explicitly names the same fiscal period and
      // has a single possible implementation. A later correction stays open.
      for (const n of notices) {
        if (!n.corporateStage || n.corporateStage === 'implemented' || /配股|合并|分立|重组|更正|修正|取消|终止/.test(n.title) ||
            !/利润分配|权益分派|分红(?:方案|预案)/.test(n.title)) continue;
        const matches = events.filter(e => {
          if (e.status !== 'implemented' || !e.bodyVerified || n.date >= e.noticeDate || !e.reportDate) return false;
          const year = e.reportDate.slice(0, 4), end = e.reportDate.slice(5);
          const period = end === '12-31' ? `${year}年?(?:年度|年报)` : end === '06-30' ? `${year}年?(?:半年度|半年|中期|中报)` : null;
          return period && new RegExp(period).test(n.title);
        });
        if (matches.length === 1) {
          n.resolvedByEventId = matches[0].eventId;
          if (!matches[0].noticeIds.includes(n.id)) matches[0].noticeIds.push(n.id);
        }
      }
      input.signal?.throwIfAborted();
      const result = { symbol, source: notices.some(item => item.source === '巨潮资讯') ? '东方财富公司行为及巨潮资讯公告' : SOURCE, status: errors.length ? 'unavailable' : 'ready', fetchedAt: this.clock(), acquisition,
        coverageStart: fromDate, coverageEnd: today, coverageComplete: errors.length === 0, events, notices,
        ...(errors.length ? { error: errors.join('；') } : {}) };
      // Hundreds of strategy members share this source. Retain fresh evidence
      // across a whole scan instead of evicting it after only 100 stocks.
      this.cache.delete(key); this.cache.set(key, result);
      for (const [cachedKey, cached] of this.cache) {
        if (this.clock() - cached.fetchedAt >= (cached.status === 'ready' ? TTL : FAILURE_TTL)) this.cache.delete(cachedKey);
      }
      while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value);
      return result;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, task); return task;
  }
}
module.exports = { CorporateSource, parsePlan, combineRows, noticeEvidence, implementationFacts, noticeStage, TTL };
