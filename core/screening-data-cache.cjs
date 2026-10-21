const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 1;
const FINANCE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DAILY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const recent = (timestamp, now, maxAge) => Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now && now - timestamp < maxAge;

// This is disposable provider data, never account state. A failed read/write
// falls back to acquisition, and successful data is flushed once per stage.
class ScreeningDataCache {
  constructor(directory = null, namespace = 'default') {
    this.file = directory ? path.join(directory, 'screening-data-v1.json') : null;
    this.namespace = namespace; this.finance = new Map(); this.daily = new Map(); this.warning = ''; this.dirty = false;
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      if (fs.statSync(this.file).size > 64 * 1024 * 1024) throw Error('缓存文件过大');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.schema !== SCHEMA || saved.namespace !== namespace) return;
      for (const kind of ['finance', 'daily']) for (const entry of Array.isArray(saved[kind]) ? saved[kind] : []) {
        if (entry && /^(sh|sz)\d{6}$/.test(entry.symbol)) this[kind].set(entry.symbol, entry);
      }
    } catch (error) { this.warning = `量化缓存读取失败，将重新获取：${error.message}`; }
  }
  get(kind, symbol) { return this[kind].get(symbol); }
  set(kind, symbol, entry) { this[kind].set(symbol, { ...entry, symbol }); this.dirty = true; }
  delete(kind, symbol) { if (this[kind].delete(symbol)) this.dirty = true; }
  async flush(now) {
    if (!this.file || !this.dirty) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      for (const kind of ['finance', 'daily']) for (const [symbol, entry] of this[kind]) {
        if (!recent(entry.loadedAt, now, kind === 'finance' ? FINANCE_MAX_AGE_MS : DAILY_MAX_AGE_MS)) this[kind].delete(symbol);
      }
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(temporary, JSON.stringify({ schema: SCHEMA, namespace: this.namespace,
        finance: [...this.finance.values()], daily: [...this.daily.values()] }), 'utf8');
      await fs.promises.rename(temporary, this.file);
      this.dirty = false; this.warning = '';
    } catch (error) {
      this.warning = `量化缓存保存失败，本次结果仍可使用：${error.message}`;
      try { await fs.promises.unlink(temporary); } catch {}
    }
  }
}

module.exports = { ScreeningDataCache, FINANCE_MAX_AGE_MS, DAILY_MAX_AGE_MS, recent };
