const test = require('node:test');
const assert = require('node:assert/strict');
const { calendarSession, TRADING_CALENDARS } = require('../core/trading-calendar.cjs');
const at = (date, time = '10:00:00') => calendarSession(`${date}T${time}+08:00`);

test('2026全年七个假日区间全部闭市，公告明示恢复日期正常开市', () => {
  for (const holiday of TRADING_CALENDARS[2026].closures) {
    let stamp = Date.parse(holiday.from + 'T00:00:00Z');
    const end = Date.parse(holiday.through + 'T00:00:00Z');
    while (stamp <= end) {
      const day = new Date(stamp).toISOString().slice(0, 10), result = at(day);
      assert.equal(result.known, true, day); assert.equal(result.open, false, day); assert.match(result.label, /休市/);
      stamp += 86400000;
    }
    assert.equal(at(holiday.resumes).open, true, holiday.resumes);
  }
});
test('2026年10月8日为国庆后首个交易日，10月10日调休周六仍休市', () => {
  assert.equal(at('2026-10-07').open, false);
  assert.equal(at('2026-10-08').open, true);
  assert.equal(at('2026-10-09').open, true);
  assert.equal(at('2026-10-10').open, false);
  for (const date of TRADING_CALENDARS[2026].additionalWeekendClosures) assert.equal(at(date).open, false, date);
});
test('连续竞价窗口与现有模拟撮合一致，午休和集合竞价不开放代理撮合', () => {
  for (const time of ['09:30:00', '11:29:59', '13:00:00', '14:56:59']) assert.equal(at('2026-10-08', time).open, true, time);
  for (const time of ['09:14:59', '09:15:00', '09:25:00', '09:29:59', '11:30:00', '12:59:59', '14:57:00', '15:00:00']) assert.equal(at('2026-10-08', time).open, false, time);
});
test('未核验年份不会按周一至周五猜测开市，无效时间拒绝交易', () => {
  for (const date of ['2025-12-31', '2027-01-04', '2027-10-08']) {
    const result = at(date); assert.equal(result.known, false); assert.equal(result.open, false); assert.match(result.label, /未经核验/);
  }
  assert.equal(calendarSession('invalid-time').open, false); assert.equal(calendarSession('invalid-time').known, false);
});
test('上海日期不依赖执行主机时区，年份边界按东八区处理', () => {
  assert.equal(calendarSession('2026-10-08T02:00:00Z').date, '2026-10-08');
  assert.equal(calendarSession('2026-10-08T02:00:00Z').open, true);
  assert.equal(calendarSession('2025-12-31T16:00:00Z').known, true);
  assert.equal(calendarSession('2025-12-31T15:59:59Z').known, false);
  assert.equal(calendarSession('2026-12-31T16:00:00Z').known, false);
});
test('年度数据保存沪深官方出处、版本覆盖与核验日期，不能被调用方修改', () => {
  const calendar = TRADING_CALENDARS[2026];
  assert.equal(calendar.verifiedOn, '2026-10-08'); assert.equal(calendar.year, 2026);
  assert.equal(calendar.sources.filter(source => source.publishedOn === '2025-12-22').length, 2);
  assert.equal(calendar.sources.some(source => source.exchange === 'SZSE'), true);
  for (const source of calendar.sources) assert.match(source.url, /^https:\/\/www\.(sse\.com\.cn|szse\.cn)\//);
  assert.equal(Object.isFrozen(calendar.closures[0]), true); assert.equal(Object.isFrozen(calendar.sources[0]), true);
  assert.equal(at('2026-10-08').source, calendar.sources[0].url);
});
