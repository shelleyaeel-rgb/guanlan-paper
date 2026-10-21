const { cnTime, session } = require('./common.cjs');

// Official annual notices read and cross-checked on 2026-10-08 (Asia/Shanghai).
// This finite calendar covers regular SSE/SZSE A-share sessions, not Stock Connect,
// individual security suspensions, exceptional future closures or other markets.
// Do not infer subsequent years from weekdays or government make-up workdays.
const CALENDAR_2026 = {
  year: 2026,
  verifiedOn: '2026-10-08',
  validFrom: '2026-01-01', validThrough: '2026-12-31',
  sources: [
    { exchange: 'SSE', title: '关于上海证券交易所2026年部分节假日休市安排的通知', document: '上证公告〔2025〕45号', publishedOn: '2025-12-22', url: 'https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml' },
    { exchange: 'SZSE', title: '关于2026年部分节假日休市安排的通知', document: '深证会〔2025〕481号', publishedOn: '2025-12-22', url: 'https://www.szse.cn/disclosure/notice/general/t20251222_618087.html' },
    { exchange: 'SSE', title: '关于2026年中秋节、国庆节休市安排的公告', document: '上证公告〔2026〕22号', publishedOn: '2026-09-17', url: 'https://www.sse.com.cn/disclosure/announcement/general/c/c_20260915_10832273.shtml' },
    { exchange: 'SZSE', title: '关于2026年中秋节、国庆节休市安排的通知', publishedOn: '2026-09-17', url: 'https://www.szse.cn/disclosure/notice/general/t20260917_622911.html' }
  ],
  closures: [
    { name: '元旦', from: '2026-01-01', through: '2026-01-03', resumes: '2026-01-05' },
    { name: '春节', from: '2026-02-15', through: '2026-02-23', resumes: '2026-02-24' },
    { name: '清明节', from: '2026-04-04', through: '2026-04-06', resumes: '2026-04-07' },
    { name: '劳动节', from: '2026-05-01', through: '2026-05-05', resumes: '2026-05-06' },
    { name: '端午节', from: '2026-06-19', through: '2026-06-21', resumes: '2026-06-22' },
    { name: '中秋节', from: '2026-09-25', through: '2026-09-27', resumes: '2026-09-28' },
    { name: '国庆节', from: '2026-10-01', through: '2026-10-07', resumes: '2026-10-08' }
  ],
  // Explicitly called out by both exchanges; these remain closed despite workday adjustments.
  additionalWeekendClosures: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']
};
for (const item of CALENDAR_2026.sources) Object.freeze(item);
for (const item of CALENDAR_2026.closures) Object.freeze(item);
Object.freeze(CALENDAR_2026.sources); Object.freeze(CALENDAR_2026.closures); Object.freeze(CALENDAR_2026.additionalWeekendClosures); Object.freeze(CALENDAR_2026);
const TRADING_CALENDARS = Object.freeze({ 2026: CALENDAR_2026 });

function calendarSession(now = new Date()) {
  const time = new Date(now);
  if (!Number.isFinite(time.getTime())) return { known: false, open: false, date: '', label: '时间无效，暂停自动交易', source: '' };
  const { date } = cnTime(time), calendar = TRADING_CALENDARS[Number(date.slice(0, 4))];
  if (!calendar || date < calendar.validFrom || date > calendar.validThrough) return { known: false, open: false, date, label: `${date.slice(0, 4)} 年交易日历未经核验，暂停自动交易`, source: '' };
  const source = calendar.sources[0].url;
  const holiday = calendar.closures.find(item => date >= item.from && date <= item.through);
  if (holiday) return { known: true, open: false, date, label: `${holiday.name}休市`, source };
  return { known: true, ...session(time), date, source };
}

module.exports = { calendarSession, TRADING_CALENDARS };
