const crypto = require('node:crypto');
const money = n => Math.round((Number(n) + Number.EPSILON) * 100);
const yuan = n => n / 100;
const id = () => crypto.randomUUID();
function cnTime(now = new Date()) {
  const d = new Date(new Date(now).getTime() + 8 * 3600000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 19), day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function session(now = new Date()) {
  const t = cnTime(now), m = t.minutes;
  if ([0, 6].includes(t.day)) return { open: false, label: '周末休市' };
  if ((m >= 570 && m < 690) || (m >= 780 && m < 897)) return { open: true, label: '连续竞价时段' };
  if (m >= 690 && m < 780) return { open: false, label: '午间休市' };
  if (m >= 897 && m < 900) return { open: false, label: '收盘集合竞价 · 暂停撮合' };
  return { open: false, label: m >= 900 ? '已收盘' : '未开盘' };
}
function symbolOf(input) {
  const s = String(input || '').trim().toLowerCase();
  const code = s.replace(/^(sh|sz)/, '');
  const exchange = /^(600|601|603|605|688)\d{3}$/.test(code) ? 'sh' : /^(000|001|002|003|300|301)\d{3}$/.test(code) ? 'sz' : null;
  if (!exchange || (s.length !== 6 && s !== exchange + code)) throw Error('请输入沪深 A 股六位代码，例如 600519、000001、300750。首版不支持北交所、基金、债券。');
  return exchange + code;
}
function numberIn(value, min, max, label) {
  const n = Number(value);
  if (value === '' || value === null || !Number.isFinite(n) || n < min || n > max) throw Error(`${label}应在 ${min} 至 ${max} 之间`);
  return n;
}
module.exports = { money, yuan, id, cnTime, session, symbolOf, numberIn };
