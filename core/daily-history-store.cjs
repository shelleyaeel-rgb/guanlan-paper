'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_DAILY_HISTORY_BYTES = 256 * 1024;
const KEY_PATTERN = /^(stock|index):(sh|sz)\d{6}$/;
const renameRetryDelays = [50, 100, 200, 400];
const renameRetryCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
const renameWait = new Int32Array(new SharedArrayBuffer(4));
const checksum = serialized => createHash('sha256').update(serialized, 'utf8').digest('hex');

function replaceFileSync(source, target) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, target); return; }
    catch (error) {
      if (process.platform !== 'win32' || !renameRetryCodes.has(error.code) || attempt >= renameRetryDelays.length) throw error;
      // Retry only the atomic replacement. Never unlink the last good cache.
      Atomics.wait(renameWait, 0, 0, renameRetryDelays[attempt]);
    }
  }
}

class DailyHistoryStore {
  constructor(directory) { this.directory = path.resolve(directory); }

  fileFor(key) {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw Error('日线缓存键无效');
    return path.join(this.directory, `${key.replace(':', '-')}.json`);
  }

  read(key) {
    const file = this.fileFor(key);
    let fd;
    try { fd = fs.openSync(file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw Error('日线缓存不是普通文件');
      if (stat.size > MAX_DAILY_HISTORY_BYTES) throw Error('日线缓存超过 256 KiB');
      // Bound the actual read as well as fstat: a file can grow after inspection.
      const bytes = Buffer.alloc(MAX_DAILY_HISTORY_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (read === 0) break;
        length += read;
      }
      if (length > MAX_DAILY_HISTORY_BYTES) throw Error('日线缓存超过 256 KiB');
      const envelope = JSON.parse(bytes.toString('utf8', 0, length));
      if (!envelope || envelope.version !== 1 || envelope.key !== key || !Object.hasOwn(envelope, 'entry')) throw Error('日线缓存版本或身份校验失败');
      if (typeof envelope.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.sha256) || checksum(JSON.stringify(envelope.entry)) !== envelope.sha256) throw Error('日线缓存校验和不匹配');
      // Each read parses fresh bytes; callers cannot mutate the stored entry.
      return envelope.entry;
    } finally { fs.closeSync(fd); }
  }

  write(key, entry) {
    const file = this.fileFor(key), serialized = JSON.stringify(entry);
    if (serialized === undefined) throw Error('日线缓存内容必须可序列化为 JSON');
    // Serialize the entry once so getters/toJSON cannot change it between the
    // checksum and disk write. Business validation belongs to the caller.
    const source = `{"version":1,"key":${JSON.stringify(key)},"sha256":"${checksum(serialized)}","entry":${serialized}}`;
    if (Buffer.byteLength(source, 'utf8') > MAX_DAILY_HISTORY_BYTES) throw Error('日线缓存超过 256 KiB');
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
    let created = false;
    try {
      const fd = fs.openSync(temporary, 'wx');
      created = true;
      try { fs.writeFileSync(fd, source, 'utf8'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      replaceFileSync(temporary, file);
    } finally {
      // Cleanup must not turn a successful rename into a reported write failure.
      if (created) try { fs.unlinkSync(temporary); } catch {}
    }
  }

  delete(key) {
    try { fs.unlinkSync(this.fileFor(key)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

module.exports = { DailyHistoryStore, MAX_DAILY_HISTORY_BYTES };
