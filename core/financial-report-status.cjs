'use strict';
const { cnTime } = require('./common.cjs');
const { checkNoticeRisk } = require('./entry-risk.cjs');

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

// A forecast or an express report does not supersede the last formal filing.
// Only an explicitly named periodic report in a validated current directory
// establishes that a newer reporting period has already been disclosed.
function reportPeriodFromTitle(input) {
  if (typeof input !== 'string') return null;
  const title = input.replace(/\s+/g, '').replace(/：/g, ':');
  if (/业绩预告|业绩快报|预披露|预约|延期|取消|提示|关于|审议|议案|决议|意见|更正公告|更正说明/.test(title)) return null;
  const match = /(?:^|[^0-9])(20\d{2})年?(第?[一三]季度报告|半年度报告|中期报告|年度报告)(?:[_-]?(?:全文|正文|摘要))?(?:[（(](?:全文|(?:修订|更新|更正)(?:版|稿|后)?)[）)])?$/.exec(title);
  if (!match) return null;
  return `${match[1]}-${/一季度/.test(match[2]) ? '03-31' : /三季度/.test(match[2]) ? '09-30' : /半年度|中期/.test(match[2]) ? '06-30' : '12-31'}`;
}

function latestDisclosedReport(noticeResponse, symbol, now = new Date(), currentReportDate = null, { annualOnly = false } = {}) {
  const assessment = checkNoticeRisk(noticeResponse, symbol, now);
  // returnedCount is only emitted after every directory item has passed the
  // source, identity, timestamp, identifier and date checks. Incomplete coverage
  // cannot establish absence, but an observed valid filing remains evidence.
  if (!Number.isSafeInteger(assessment.returnedCount)) return null;
  const today = cnTime(now).date;
  return noticeResponse.data.items.map(item => ({ id: item.id, title: item.title, date: item.date, reportDate: reportPeriodFromTitle(item.title) }))
    .filter(item => validDate(item.reportDate) && item.reportDate <= item.date && item.date <= today
      && (!annualOnly || item.reportDate.endsWith('-12-31'))
      && (!validDate(currentReportDate) || item.reportDate > currentReportDate))
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.date.localeCompare(a.date))[0] || null;
}

function pendingFinanceReport(noticeResponse, symbol, now, normalized, field) {
  const annualOnly = typeof field === 'string' && field.startsWith('annual');
  const reportDate = annualOnly ? normalized?.financeAnnualReports?.[0]?.reportDate : normalized?.financeReportDate;
  return latestDisclosedReport(noticeResponse, symbol, now, reportDate, { annualOnly });
}

const reportSyncReason = report => `已披露 ${report.reportDate} 正式财报，财务接口仍未同步该报告期，等待重新获取；业绩预告或快报不替代正式财报`;

module.exports = { reportPeriodFromTitle, latestDisclosedReport, pendingFinanceReport, reportSyncReason };
