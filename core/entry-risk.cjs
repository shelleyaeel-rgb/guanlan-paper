'use strict';
const { cnTime, symbolOf } = require('./common.cjs');

// These are conservative product filters, not exchange rules or a loss guarantee.
const SHORT_RISK_POLICY = Object.freeze({
  maxDailyLossPct: 5,
  quoteMaxAgeMs: 90000
});
// Announcement evidence is shared by every strategy, independent of its horizon.
const NOTICE_RISK_POLICY = Object.freeze({
  noticeMaxAgeMs: 300000,
  noticeLookbackDays: 14,
  noticeLimit: 30
});
const validTime = value => Number.isFinite(value) && value > 0 && value <= 8640000000000000;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const nowTime = now => now instanceof Date ? now.getTime() : now;
const result = (status, reasons, checkedAt, metadata = {}) => ({ status, reasons, checkedAt, ...metadata });

function checkMarketRisk(row, now = new Date()) {
  const at = nowTime(now), quoteTime = row?.timestamp;
  const price = row?.price;
  const derivedChange = Number.isFinite(price) && price > 0 && Number.isFinite(row?.prevClose) && row.prevClose > 0
    ? (price / row.prevClose - 1) * 100 : null;
  const changePct = Number.isFinite(row?.changePct) ? row.changePct : derivedChange;
  const metadata = { quoteTime: validTime(quoteTime) ? quoteTime : null, changePct,
    price: Number.isFinite(price) && price > 0 ? price : null,
    source: typeof row?.source === 'string' && row.source.trim() ? row.source : null,
    policy: SHORT_RISK_POLICY, policyNote: '当日跌幅达到 5% 为保守观察阈值，不是交易所制度，也不代表可控制最大损失' };
  const unknown = reason => result('unverified', [reason], validTime(at) ? at : null, metadata);
  if (!validTime(at)) return unknown('风险核验时间无效，暂停进入短线候选');
  if (!Number.isFinite(price) || price <= 0) return unknown('当前价格缺失或无效，无法核验当日风险');
  if (!Number.isFinite(changePct) || changePct <= -100) return unknown('当日涨跌幅缺失或无效，无法核验当日风险');
  if (!validTime(quoteTime)) return unknown('行情时间缺失或无效，无法核验当日风险');
  if (quoteTime > at) return unknown('行情时间晚于当前时间，无法核验当日风险');
  const today = cnTime(at), quoteDate = cnTime(quoteTime).date;
  if (quoteDate !== today.date) return unknown('行情不是当日报价，暂停进入短线候选');
  if (row.date != null && row.date !== quoteDate) return unknown('行情日期与时间戳不一致，无法核验当日风险');
  if ([0, 6].includes(today.day)) return unknown('周末休市，无法确认当日报价有效性，暂停进入短线候选');
  // During breaks a quote must represent the latest completed session. Merely
  // sharing today's date would let morning prices conceal an afternoon crash.
  const lunchBreak = today.minutes >= 690 && today.minutes < 780;
  const afterClose = today.minutes >= 900;
  const referenceTime = lunchBreak ? Date.parse(`${today.date}T11:30:00+08:00`)
    : afterClose ? Date.parse(`${today.date}T15:00:00+08:00`) : at;
  if (quoteTime < referenceTime - SHORT_RISK_POLICY.quoteMaxAgeMs) {
    return unknown(lunchBreak ? '午间报价早于 11:28:30，无法确认上午收盘附近风险'
      : afterClose ? '盘后报价早于 14:58:30，无法确认当日收盘附近风险'
        : '盘前或交易时段行情超过 90 秒，等待有效报价');
  }
  if (derivedChange != null && Math.abs(derivedChange - changePct) > 0.05) return unknown('当日涨跌幅与昨收价格不一致，等待有效报价');
  const reasons = [];
  const atLimitDown = Number.isFinite(row.limitDown) && row.limitDown > 0
    && Math.round(price * 100) <= Math.round(row.limitDown * 100);
  const hasBidFields = Object.hasOwn(row, 'bid') || Object.hasOwn(row, 'bidSize');
  const noBid = hasBidFields && Number.isFinite(row.bid) && Number.isFinite(row.bidSize)
    && (row.bid <= 0 || row.bidSize <= 0);
  if (atLimitDown) reasons.push(noBid ? '当前已到跌停且无有效买盘，触发止损也可能无法卖出' : '当前已到跌停价，暂停进入短线候选');
  else if (noBid) reasons.push('当前无有效买盘，无法确认退出流动性，暂停进入短线候选');
  if (changePct <= -SHORT_RISK_POLICY.maxDailyLossPct + 1e-8) reasons.push(`当日跌幅 ${Math.abs(changePct).toFixed(2)}% 已达到短线保守观察阈值 5%，暂停进入候选`);
  if (reasons.length) return result('blocked', reasons, at, { ...metadata, atLimitDown, noBid });
  if (hasBidFields && (!Number.isFinite(row.bid) || !Number.isFinite(row.bidSize))) return unknown('买盘信息不完整，无法核验退出流动性');
  if (row.canTrade === false) return unknown(row.tradeBlockedReason || '当前行情不支持交易核验，暂停进入短线候选');
  return result('clear', ['当日行情风险规则通过；不构成买入建议或损失上限保证'], at, { ...metadata, atLimitDown, noBid });
}

// Only classify explicit wording as adverse. General progress and even positive
// announcements require review; matching a title cannot establish the full facts.
const ADVERSE_TITLE = /未达(?:到|成)?[^，。；]{0,16}终点|(?:临床|试验)[^，。；]{0,20}失败|(?:决定|被|将被|实施)[^，。；]{0,8}(?:终止上市|退市风险警示)|(?:被立案|涉嫌[^，。；]{0,12}违法)/;
const SENSITIVE_TITLE = /临床|试验|研究终点|主要终点|重大诉讼|仲裁|立案|处罚|退市|业绩预告|业绩快报|减持|解禁|解除限售|终止|重大资产|重大事项|风险提示|盈利预警|亏损|诉讼|审计意见|非标(?:准)?审计|保留意见|无法表示意见|否定意见|(?:更正|修正)[^，。；]{0,20}(?:业绩|财务)|(?:业绩|财务)[^，。；]{0,20}(?:更正|修正)/;

function checkNoticeRisk(response, symbol, now = new Date()) {
  const at = nowTime(now);
  const base = { notices: [], policy: NOTICE_RISK_POLICY, source: response?.source || null,
    fetchedAt: validTime(response?.fetchedAt) ? response.fetchedAt : null, coverageComplete: false,
    scope: '各策略统一检索最近 14 个自然日内最多 30 条公告的标题；标题规则通过不等于没有重大风险，窗口之外或未命中关键词的事件未经核验，不能据此认定风险已经消除；买入前仍须阅读公告原文' };
  const unknown = (reason, metadata = {}) => result('unverified', [reason], validTime(at) ? at : null, { ...base, ...metadata });
  if (!validTime(at)) return unknown('公告风险核验时间无效');
  let expected;
  try { expected = symbolOf(symbol); } catch { return unknown('公告对应股票代码无法验证'); }
  const windowEnd = cnTime(at).date;
  const windowStart = new Date(Date.parse(`${windowEnd}T00:00:00Z`) - (NOTICE_RISK_POLICY.noticeLookbackDays - 1) * 86400000).toISOString().slice(0, 10);
  Object.assign(base, { symbol: expected, windowStart, windowEnd });
  if (!response || response.symbol !== expected || response.section !== 'notices' || !['东方财富', '巨潮资讯'].includes(response.source)) return unknown('公告的股票、模块或来源无法验证，等待公告核验');
  if (!['ready', 'empty'].includes(response.status) || response.error) return unknown('公告获取失败或缓存失效，等待公告核验');
  if (!validTime(response.fetchedAt) || response.fetchedAt > at || at - response.fetchedAt > NOTICE_RISK_POLICY.noticeMaxAgeMs) return unknown('公告获取时间未知、超过 5 分钟或无效，等待重新核验');
  const items = response.data?.items, total = response.data?.total;
  if (response.source === '巨潮资讯' && (response.data?.source !== '巨潮资讯' || response.data.symbol !== expected
    || !validDate(response.data.fromDate) || response.data.fromDate > windowStart || response.data.toDate !== windowEnd || total === 0))
    return unknown('巨潮公告目录期间或证券身份无法核验；空结果不能据此认定无风险');
  if (!Array.isArray(items) || items.length > NOTICE_RISK_POLICY.noticeLimit || !Number.isSafeInteger(total) || total < items.length
    || (total > 0 && !items.length) || (response.status === 'ready' && !items.length)
    || (response.status === 'empty' && (items.length || total !== 0))) return unknown('公告列表或总数异常，无法确认核验范围');
  const ids = new Set();
  for (const item of items) {
    const cninfo = response.source === '巨潮资讯';
    if (!item || typeof item.id !== 'string' || !(cninfo ? /^CN\d{10,30}$/ : /^AN\d{10,30}$/).test(item.id) || ids.has(item.id)
      || cninfo && (item.source !== '巨潮资讯' || item.issuerSymbol !== expected || !require('./cninfo-notice-source.cjs').cninfoAttachment(item.attachmentUrl, item.id, item.date))
      || !validDate(item.date) || item.date > windowEnd || typeof item.title !== 'string' || !item.title.trim() || ['-', '--'].includes(item.title.trim())
      || (item.categories != null && (!Array.isArray(item.categories) || item.categories.some(c => typeof c !== 'string')))) return unknown('公告编号、标题或日期异常，等待公告核验');
    ids.add(item.id);
  }
  const ordered = [...items].sort((a, b) => b.date.localeCompare(a.date));
  const coverageComplete = total === items.length || ordered.at(-1)?.date < windowStart;
  const notices = ordered.filter(item => item.date >= windowStart).filter(item => SENSITIVE_TITLE.test(item.title) || ADVERSE_TITLE.test(item.title)).map(item => ({
    id: item.id, date: item.date, title: item.title, categories: [...(item.categories || [])],
    ...(response.source === '巨潮资讯' ? { source: item.source, attachmentUrl: item.attachmentUrl, issuerSymbol: item.issuerSymbol, orgId: item.orgId } : {}),
    status: ADVERSE_TITLE.test(item.title) ? 'blocked' : 'unverified',
    reason: ADVERSE_TITLE.test(item.title) ? '公告标题出现不利风险信号，暂停建仓并核对原文' : '公告涉及敏感事件，须核验原文和实际影响；标题正面也不自动放行'
  }));
  const metadata = { ...base, notices, total, scannedCount: ordered.filter(item => item.date >= windowStart).length, returnedCount: items.length, coverageComplete };
  const reasons = [];
  if (!coverageComplete) reasons.push('最新公告列表未覆盖完整 14 日范围，等待补充核验');
  if (notices.some(item => item.status === 'blocked')) {
    reasons.unshift('近期公告标题出现不利风险信号，暂停建仓并核验公告原文');
    return result('blocked', reasons, at, metadata);
  }
  if (notices.length) reasons.unshift('近期公告涉及敏感事件，等待核验公告原文和实际影响');
  if (reasons.length) return result('unverified', reasons, at, metadata);
  return result('clear', ['已完成限定范围的公告标题核验，未命中已设风险关键词；不代表没有重大风险'], at, metadata);
}

const isSensitiveNoticeTitle = title => typeof title === 'string' && (SENSITIVE_TITLE.test(title) || ADVERSE_TITLE.test(title));
module.exports = { checkMarketRisk, checkNoticeRisk, isSensitiveNoticeTitle, SHORT_RISK_POLICY, NOTICE_RISK_POLICY };
