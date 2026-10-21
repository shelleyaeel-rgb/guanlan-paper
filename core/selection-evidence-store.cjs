const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { symbolOf } = require('./common.cjs');
const { validateRecord } = require('./selection-evidence.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
const MAX_RECORDS = 100000;
const MAX_BYTES = 64 * 1024 * 1024;
class SelectionEvidenceStore {
  constructor(directory, clock = () => new Date()) {
    this.file = path.join(directory, 'selection-evidence.json');
    this.clock = clock;
    this.records = [];
    this.warning = '';
    this.load();
  }
  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      if (fs.statSync(this.file).size > MAX_BYTES) throw Error('文件过大');
      const payload = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!payload || payload.version !== 1 || !Array.isArray(payload.records) || payload.records.length > MAX_RECORDS) throw Error('版本或记录格式不正确');
      const records = payload.records.map(validateRecord);
      if (records.some(record => !record.id) || new Set(records.map(record => record.id)).size !== records.length) throw Error('记录编号缺失或重复');
      this.records = records;
    } catch (error) { this.warning = `选股证据库无法读取：${error.message}。原文件已保留，请修复后重启；当前拒绝读取和写入。`; }
  }
  assertAvailable() { if (this.warning) throw Error(this.warning); }
  list(symbol) {
    this.assertAvailable();
    const normalized = symbol == null ? null : symbolOf(symbol);
    return clone(normalized ? this.records.filter(record => record.symbol === normalized) : this.records);
  }
  persist(records) {
    this.assertAvailable();
    const now = new Date(this.clock());
    if (!Number.isFinite(now.getTime())) throw Error('证据库时钟不正确');
    const serialized = JSON.stringify({ version: 1, updatedAt: now.toISOString(), records });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw Error('证据库大小超过 64 MiB 上限，请精简记录后重试');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx');
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
      this.records = records;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  save(input) {
    this.assertAvailable();
    const record = validateRecord(input);
    const index = record.id ? this.records.findIndex(existing => existing.id === record.id) : -1;
    if (record.id && index === -1) throw Error('证据记录不存在，请刷新列表；新记录无需提供编号');
    if (index !== -1 && this.records[index].symbol !== record.symbol) throw Error('不能更改已有证据所属股票，请新建记录');
    if (index === -1 && this.records.length >= MAX_RECORDS) throw Error('证据记录数量已达上限');
    const saved = { ...record, id: record.id || randomUUID() };
    const next = this.records.slice();
    if (index === -1) next.push(saved); else next[index] = saved;
    this.persist(next);
    return clone(saved);
  }
  remove(input) {
    this.assertAvailable();
    if (!input || typeof input.id !== 'string' || !input.id) throw Error('请提供证据编号');
    const next = this.records.filter(record => record.id !== input.id);
    if (next.length === this.records.length) return false;
    this.persist(next);
    return true;
  }
}
module.exports = { SelectionEvidenceStore, validateRecord };
