'use strict';
const { symbolOf, cnTime } = require('./common.cjs');
const { isCninfoId, cninfoUrl } = require('./cninfo-notice-source.cjs');

const SOURCE = '东方财富';
const PROFILE_COLUMNS = 'SECUCODE,SECURITY_NAME_ABBR,ORG_NAME,MAIN_BUSINESS,EM2016,CSRC_INDUSTRY_NAME,ORG_TYPE,ORG_TYPE_CODE,LISTING_DATE,ORG_PROFILE';
const FINANCE_COLUMNS = 'SECUCODE,REPORT_DATE,REPORT_TYPE,REPORT_DATE_NAME,NOTICE_DATE,UPDATE_DATE,CURRENCY,TOTALOPERATEREVE,PARENTNETPROFIT,KCFJCXSYJLR,TOTALOPERATEREVETZ,PARENTNETPROFITTZ,KCFJCXSYJLRTZ,NETCASH_OPERATE_PK,ROEJQ,ZCFZL';
const TTL = { profile: 86400000, finance: 21600000, valuation: 60000, notices: 300000 };
const METRICS = { revenue: 'TOTALOPERATEREVE', profit: 'PARENTNETPROFIT', adjustedProfit: 'KCFJCXSYJLR', revenueYoY: 'TOTALOPERATEREVETZ', profitYoY: 'PARENTNETPROFITTZ', adjustedProfitYoY: 'KCFJCXSYJLRTZ', operatingCash: 'NETCASH_OPERATE_PK', roe: 'ROEJQ', debtRatio: 'ZCFZL' };
const numeric = value => !['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const plain = value => typeof value === 'string' && value.trim() && !['-', '--'].includes(value.trim()) ? value.trim() : null;
const securityCode = symbol => `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(value)) return null;
  const date = value.slice(0, 10), time = Date.parse(date);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? date : null;
}
function dataRows(json, symbol) {
  if (json?.success !== true || !Array.isArray(json.result?.data)) throw Error('资料服务返回格式异常');
  const rows = json.result.data;
  if (rows.some(row => !row || row.SECUCODE !== securityCode(symbol))) throw Error('资料返回股票代码不符');
  return rows;
}
function parseProfile(json, symbol) {
  const rows = dataRows(json, symbol);
  if (rows.length > 1) throw Error('公司资料存在重复记录');
  const r = rows[0];
  return r ? { name: plain(r.SECURITY_NAME_ABBR), company: plain(r.ORG_NAME), business: plain(r.MAIN_BUSINESS), industry: plain(r.EM2016), regulatoryIndustry: plain(r.CSRC_INDUSTRY_NAME),
    orgType: plain(r.ORG_TYPE), orgTypeCode: plain(r.ORG_TYPE_CODE), listedAt: dateOnly(r.LISTING_DATE), summary: plain(r.ORG_PROFILE) } : null;
}
function parseFinance(json, symbol, now = Date.now()) {
  const today = cnTime(now).date, dates = new Set();
  const reports = dataRows(json, symbol).map(r => {
    const reportDate = dateOnly(r.REPORT_DATE);
    if (!reportDate || !/-(03-31|06-30|09-30|12-31)$/.test(reportDate) || dates.has(reportDate)) throw Error('财务报告期无效或重复');
    dates.add(reportDate);
    return { reportDate, noticeDate: dateOnly(r.NOTICE_DATE), updateDate: dateOnly(r.UPDATE_DATE), currency: plain(r.CURRENCY),
      ...Object.fromEntries(Object.entries(METRICS).map(([key, field]) => [key, numeric(r[field])])) };
  }).filter(r => r.reportDate <= today && (!r.noticeDate || r.noticeDate <= today) && (!r.updateDate || r.updateDate <= today))
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  return { latest: reports[0] || null, annual: reports.filter(r => r.reportDate.endsWith('-12-31')).slice(0, 3) };
}
function parseValuation(json, symbol, now = Date.now()) {
  const rows = json?.data?.diff;
  if (json?.rc !== 0 || !Array.isArray(rows) || rows.length !== 1 || rows[0]?.f12 !== symbol.slice(2) || rows[0]?.f13 !== (symbol.startsWith('sh') ? 1 : 0)) throw Error('估值行情返回股票代码或格式不符');
  const r = rows[0], at = numeric(r.f124), positive = field => numeric(r[field]) > 0 ? numeric(r[field]) : null;
  return { marketCap: positive('f20'), floatCap: positive('f21'), pe: numeric(r.f9), pb: numeric(r.f23), quoteTime: at > 0 && at * 1000 <= now + 60000 ? at * 1000 : null };
}
function noticeUrl(symbol, article) {
  symbol = symbolOf(symbol);
  if (isCninfoId(article)) return cninfoUrl(symbol, article);
  if (typeof article !== 'string' || !/^AN\d{10,30}$/.test(article)) throw Error('公告编号无效');
  return `https://data.eastmoney.com/notices/detail/${symbol.slice(2)}/${article}.html`;
}
function externalUrl(input) {
  const symbol = symbolOf(input?.symbol);
  if (input?.kind === 'notice') return noticeUrl(symbol, input.article);
  if (input?.kind === 'notices') return `https://data.eastmoney.com/notices/stock/${symbol.slice(2)}.html`;
  if (input?.kind === 'profile') return `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/Index?type=web&code=${symbol.toUpperCase()}`;
  throw Error('资料链接类型无效');
}
function parseNotices(json, symbol, now = Date.now()) {
  const d = json?.data, today = cnTime(now).date;
  if (json?.success !== 1 || !Array.isArray(d?.list) || !Number.isInteger(d.total_hits) || d.total_hits < d.list.length || (d.total_hits > 0 && !d.list.length)) throw Error('公告服务返回格式异常');
  const ids = new Set();
  const items = d.list.map(r => {
    if (!r || !Array.isArray(r.codes) || !r.codes.some(c => c.stock_code === symbol.slice(2) && String(c.market_code) === (symbol.startsWith('sh') ? '1' : '0'))) throw Error('公告返回股票代码或市场不符');
    noticeUrl(symbol, r.art_code);
    const date = dateOnly(r.notice_date), title = plain(r.title);
    if (!date || !title || ids.has(r.art_code)) throw Error('公告标题、日期或编号异常');
    ids.add(r.art_code);
    return { id: r.art_code, date, title, categories: Array.isArray(r.columns) ? r.columns.map(c => plain(c?.column_name)).filter(Boolean) : [] };
  }).filter(r => r.date <= today).sort((a, b) => b.date.localeCompare(a.date));
  return { items, total: d.total_hits };
}
function reportUrl(reportName, columns, symbol, pageSize) {
  return 'https://datacenter.eastmoney.com/securities/api/data/v1/get?' + new URLSearchParams({ reportName, columns, filter: `(SECUCODE="${securityCode(symbol)}")`, pageSize: String(pageSize), pageNumber: '1', ...(reportName.includes('FINANCE') ? { sortColumns: 'REPORT_DATE', sortTypes: '-1' } : {}) });
}
const { afterPending } = require('./fresh-request.cjs');
const { createHash } = require('node:crypto');
class Research {
  constructor(fetcher = fetch, { clock = Date.now, timeoutMs = 8000, noticeSource = null } = {}) {
    this.noticeSource = noticeSource;
    this.fetcher = fetcher; this.clock = clock; this.timeoutMs = timeoutMs;
    this.cache = new Map(); this.pending = new Map(); this.nextForced = new Map(); this.noticeVersions = new Map();
  }
  async request(url) {
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(this.timeoutMs), cache: 'no-store', headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://emweb.securities.eastmoney.com/' } });
    if (!response.ok) throw Error(`资料服务 HTTP ${response.status}`);
    return response.json();
  }
  async getFinanceWithIndustry({ symbol: inputSymbol, force = false } = {}) {
    const symbol = symbolOf(inputSymbol);
    const results = await Promise.allSettled(['finance', 'profile'].map(section => this.get({ symbol, section, force })));
    const response = (result, section) => result.status === 'fulfilled' ? result.value : {
      symbol, section, source: SOURCE, status: 'unavailable', fetchedAt: null, checkedAt: this.clock(), error: result.reason?.message || '资料获取失败' };
    return { ...response(results[0], 'finance'), industryProfile: response(results[1], 'profile') };
  }
  async fetchSection(symbol, section, { force = false } = {}) {
    if (section === 'profile') return parseProfile(await this.request(reportUrl('RPT_F10_ORG_BASICINFO', PROFILE_COLUMNS, symbol, 1)), symbol);
    if (section === 'finance') return parseFinance(await this.request(reportUrl('RPT_F10_FINANCE_MAINFINADATA', FINANCE_COLUMNS, symbol, 20)), symbol, this.clock());
    if (section === 'notices') {
      try { return parseNotices(await this.request('https://np-anotice-stock.eastmoney.com/api/security/ann?' + new URLSearchParams({ sr: '-1', page_size: '30', page_index: '1', ann_type: 'A', stock_list: symbol.slice(2) })), symbol, this.clock()); }
      catch (primary) {
        if (!this.noticeSource) throw primary;
        try { return await this.noticeSource.getIndex(symbol, '1990-01-01', cnTime(this.clock()).date, { firstPageOnly: true, force }); }
        catch (fallback) { throw Error(`东方财富公告获取失败：${primary.message}；巨潮备用失败：${fallback.message}`); }
      }
    }
    const query = new URLSearchParams({ secids: `${symbol.startsWith('sh') ? 1 : 0}.${symbol.slice(2)}`, fields: 'f12,f13,f9,f23,f20,f21,f124', fltt: '2' });
    let error;
    for (const host of ['push2.eastmoney.com', '82.push2.eastmoney.com']) {
      try { return parseValuation(await this.request(`https://${host}/api/qt/ulist.np/get?${query}`), symbol, this.clock()); } catch (e) { error = e; }
    }
    throw error;
  }
  async get(input) {
    const symbol = symbolOf(input?.symbol), section = input?.section;
    if (!Object.hasOwn(TTL, section)) throw Error('资料模块无效');
    const key = `${symbol}:${section}`, previous = this.cache.get(key);
    if (this.nextForced.has(key)) return this.nextForced.get(key);
    if (this.pending.has(key)) return input.force
      ? afterPending(this.pending, this.nextForced, key, () => this.get({ ...input, force: true })) : this.pending.get(key);
    if (!input.force && previous && previous.status !== 'stale' && this.clock() - previous.fetchedAt < TTL[section]) return { ...previous, cached: true };
    const task = (async () => {
      try {
        const data = await this.fetchSection(symbol, section, { force: input.force === true }), fetchedAt = section === 'notices' && data?.source === '巨潮资讯' ? data.fetchedAt : this.clock();
        const empty = data == null || (section === 'finance' && !data.latest) || (section === 'notices' && !data.items.length) || (section === 'valuation' && ['marketCap', 'floatCap', 'pe', 'pb'].every(k => data[k] === null));
        const result = { symbol, section, source: section === 'notices' && data?.source || SOURCE, fetchedAt, checkedAt: this.clock(), status: empty ? 'empty' : 'ready', data };
        if (section === 'notices') this.observeNotices(result);
        this.cache.delete(key); this.cache.set(key, result);
        if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
        return result;
      } catch (e) {
        // Failed refreshes never replace a usable snapshot or its original timestamp.
        const failed = { symbol, section, source: previous?.source || SOURCE, fetchedAt: previous?.fetchedAt || null, checkedAt: this.clock(), status: previous ? 'stale' : 'unavailable', data: previous?.data ?? null, error: e.message };
        if (section === 'notices') this.observeNotices(failed);
        if (previous) this.cache.set(key, failed);
        return failed;
      } finally { this.pending.delete(key); }
    })();
    this.pending.set(key, task); return task;
  }
  observeNotices(response) {
    const previous = this.noticeVersions.get(response.symbol);
    const usable = ['ready', 'empty'].includes(response.status) && !response.error;
    const fingerprint = usable ? createHash('sha256').update(JSON.stringify({ source: response.source, status: response.status, data: response.data })).digest('hex') : null;
    const changed = !previous || !usable || !previous.usable || previous.fingerprint !== fingerprint;
    const version = (previous?.version || 0) + (changed ? 1 : 0);
    response.noticeVersion = version;
    this.noticeVersions.set(response.symbol, { version, fingerprint, usable, checkedAt: response.checkedAt, fetchedAt: response.fetchedAt,
      failureGeneration: (previous?.failureGeneration || 0) + (usable ? 0 : 1), error: response.error || '' });
    return response;
  }
  noticeVersion(symbol) { const value = this.noticeVersions.get(symbolOf(symbol)); return value ? { ...value } : null; }
  assertNoticeCurrent(symbol, response) {
    symbol = symbolOf(symbol);
    const current = this.noticeVersions.get(symbol), now = this.clock();
    if (!current || !current.usable || !response || response.symbol !== symbol || response.noticeVersion !== current.version)
      throw Error('公告目录已变化或最新查新失败，本次买入依据失效，等待重新核验');
    if (!['ready', 'empty'].includes(response.status) || response.error || !Number.isFinite(response.fetchedAt)
      || response.fetchedAt > now || now - response.fetchedAt > TTL.notices)
      throw Error('买入前公告资料已过期或无效，等待重新核验');
    return true;
  }
}
module.exports = { Research, parseProfile, parseFinance, parseValuation, parseNotices, externalUrl, TTL };
