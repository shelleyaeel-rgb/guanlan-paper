const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SNAPSHOT_FIELDS: FIELDS, BOARDS, fieldAvailable, quoteTimeAvailable, quoteRange } = require('./screener.cjs');
const { cnTime, symbolOf } = require('./common.cjs');
const { TENCENT_SCREEN_SOURCE } = require('./screener-tencent.cjs');
const SOURCES = new Set(['东方财富公开行情', TENCENT_SCREEN_SOURCE]);
const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
function validSnapshot(s) {
  if (!s || !SOURCES.has(s.source) || !validTime(s.startedAt) || !validTime(s.fetchedAt) || s.startedAt > s.fetchedAt || !Number.isInteger(s.sourceCount) || s.sourceCount < 1 || s.sourceCount > 15000 || !Number.isInteger(s.excludedCount) || s.excludedCount < 0 || !Array.isArray(s.rows) || !s.rows.length || s.rows.length + s.excludedCount !== s.sourceCount) return false;
  const seen = new Set();
  for (const row of s.rows) {
    try { if (symbolOf(row.symbol) !== row.symbol || seen.has(row.symbol)) return false; } catch { return false; }
    seen.add(row.symbol);
    if (typeof row.name !== 'string' || !row.name || row.name.length > 100 || !Object.hasOwn(BOARDS, row.board) || typeof row.isST !== 'boolean' || (row.timestamp !== null && !quoteTimeAvailable(row))) return false;
    if (Object.keys(FIELDS).some(field => row[field] !== null && !fieldAvailable(row, field))) return false;
  }
  return true;
}
// A complete universe can still have individual missing values. Preserve the older
// generation when any entire metric disappears, as can happen before the open.
function usableSnapshot(s) {
  return validSnapshot(s) && s.rows.some(quoteTimeAvailable) && Object.keys(FIELDS).every(field => s.rows.some(row => fieldAvailable(row, field)));
}
class ScreenerStore {
  constructor(directory) {
    this.file = path.join(directory, 'screener-snapshots.json');
    this.snapshots = []; this.warning = '';
    this.load();
  }
  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      if (fs.statSync(this.file).size > 40 * 1024 * 1024) throw Error('文件过大');
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.snapshots) || data.snapshots.length > 3 || !data.snapshots.every(s => typeof s.id === 'string' && /^[a-f0-9-]{36}$/.test(s.id) && usableSnapshot(s)) || new Set(data.snapshots.map(s => s.id)).size !== data.snapshots.length) throw Error('格式或指标校验失败');
      this.snapshots = data.snapshots.sort((a, b) => b.fetchedAt - a.fetchedAt);
    } catch (e) { this.warning = `历史选股快照无法读取：${e.message}；可重新获取行情，账户数据不受影响`; }
  }
  list() {
    return this.snapshots.map(s => ({ id: s.id, source: s.source, startedAt: s.startedAt, fetchedAt: s.fetchedAt, count: s.rows.length, ...quoteRange(s.rows) }));
  }
  get(id) { return this.snapshots.find(s => s.id === id) || null; }
  remember(snapshot) {
    if (!usableSnapshot(snapshot)) return false;
    const date = cnTime(snapshot.fetchedAt).date;
    const next = [{ ...snapshot, id: randomUUID() }, ...this.snapshots.filter(s => cnTime(s.fetchedAt).date !== date)].sort((a, b) => b.fetchedAt - a.fetchedAt).slice(0, 3);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    const fd = fs.openSync(temporary, 'w');
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, snapshots: next }), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    this.snapshots = next; this.warning = ''; return true;
  }
}
module.exports = { ScreenerStore, validSnapshot, usableSnapshot };
