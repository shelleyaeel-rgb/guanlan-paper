'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cninfoAttachment, isCninfoId } = require('./cninfo-notice-source.cjs');
const { createHash, randomUUID } = require('node:crypto');

const CACHE_KIND = 'guanlan-company-attachments-v1';
const BUFFER_FILE_LIMIT = 256 * 1024 * 1024;
const STREAM_FILE_LIMIT = 512 * 1024 * 1024;
const IO_CHUNK_BYTES = 1024 * 1024;
const FORMATS = Object.freeze({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
const digest = value => createHash('sha256').update(value).digest('hex');
const registries = new Map();
const filePattern = /^attachment-([a-f0-9]{64})\.(pdf|png|jpg|jpeg|webp|bmp|docx|xlsx)$/;
const partPattern = /^download-[a-f0-9]{64}-[a-f0-9-]{36}\.part$/;
function active(signal) { if (signal?.aborted) { const error = Error('已取消公司附件下载'); error.name = 'AbortError'; throw error; } }
function cancellable(task, signal) {
  active(signal); if (!signal) return Promise.resolve(task);
  return new Promise((resolve, reject) => {
    const abort = () => { const error = Error('已取消公司附件下载'); error.name = 'AbortError'; reject(error); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function attachmentInfo(value, id) {
  if (isCninfoId(id)) return cninfoAttachment(value, id);
  if (typeof id !== 'string' || !/^AN\d{10,30}$/.test(id)) return null;
  try {
    const url = new URL(value), format = path.posix.extname(url.pathname).slice(1).toLowerCase();
    if (url.protocol !== 'https:' || url.hostname !== 'pdf.dfcfw.com' || url.username || url.password || !FORMATS[format]
      || !new RegExp(`(?:^|[/_])${id}(?:[_./-]|$)`).test(url.pathname)) return null;
    return { url: url.href, format, mimeType: FORMATS[format] };
  } catch { return null; }
}
function signature(bytes, format) {
  if (format === 'pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (format === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (['jpg', 'jpeg'].includes(format)) return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (format === 'webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (format === 'bmp') return bytes.subarray(0, 2).toString('ascii') === 'BM';
  return ['docx', 'xlsx'].includes(format) && bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]));
}
function capacityError(message, limitBytes, actualBytes, code = 'size-limit') {
  return Object.assign(Error(message), { code, limitBytes, actualBytes });
}
function fileBudget(mode, maxFileBytes = mode === 'file' ? STREAM_FILE_LIMIT : BUFFER_FILE_LIMIT) {
  if (!['buffer', 'file'].includes(mode)) throw Error('附件读取模式无效');
  const hardLimit = mode === 'file' ? STREAM_FILE_LIMIT : BUFFER_FILE_LIMIT;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > hardLimit) throw Error('附件单文件上限无效');
  return maxFileBytes;
}

class CompanyAttachmentCache {
  constructor({ directory = null, clock = Date.now, maxBytes = 512 * 1024 * 1024, maxAgeMs = 30 * 86400000 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024
      || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 90 * 86400000) throw Error('附件缓存上限无效');
    this.directory = directory ? path.resolve(directory) : path.join(os.tmpdir(), 'guanlan-company-attachments-v1');
    this.temporary = !directory; Object.assign(this, { clock, maxBytes, maxAgeMs });
    fs.mkdirSync(this.directory, { recursive: true });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw Error('附件缓存目录不能为符号链接');
    this.realDirectory = fs.realpathSync.native(this.directory);
    const marker = path.join(this.directory, '.cache-format');
    if (fs.existsSync(marker)) { if (fs.lstatSync(marker).isSymbolicLink() || fs.readFileSync(marker, 'utf8') !== CACHE_KIND) throw Error('附件缓存目录标识不符'); }
    else fs.writeFileSync(marker, CACHE_KIND, { flag: 'wx' });
    this.registry = registries.get(this.realDirectory) || { reservations: new Map(), activeParts: new Set(), pins: new Map(), retained: new Map() };
    this.owner = randomUUID();
    registries.set(this.realDirectory, this.registry);
    this.prune();
  }
  location(name) {
    if (path.basename(name) !== name || !name || name.includes('..')) throw Error('附件缓存文件名无效');
    if (fs.lstatSync(this.directory).isSymbolicLink() || fs.realpathSync.native(this.directory) !== this.realDirectory) throw Error('附件缓存目录位置已变化');
    const file = path.resolve(this.directory, name);
    if (path.dirname(file) !== this.directory) throw Error('附件缓存路径越界');
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile())) throw Error('附件缓存文件类型无效');
    return file;
  }
  remove(name) { const file = this.location(name); if (fs.existsSync(file)) fs.unlinkSync(file); }
  hold(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error('附件保留引用无效');
    this.registry.pins.set(key, (this.registry.pins.get(key) || 0) + 1);
    let released = false;
    return () => { if (released) return; released = true; const remaining = this.registry.pins.get(key) - 1;
      if (remaining) this.registry.pins.set(key, remaining); else this.registry.pins.delete(key); };
  }
  retainReferences(references = []) {
    const keys = references.map(reference => typeof reference === 'string' ? reference : reference?.cacheKey);
    if (keys.some(key => !/^[a-f0-9]{64}$/.test(key))) throw Error('附件保留引用无效');
    this.registry.retained.set(this.owner, new Set(keys));
  }
  releaseRetention() { this.registry.retained.delete(this.owner); }
  metadata(key) {
    try {
      const file = this.location(`attachment-${key}.json`);
      if (fs.statSync(file).size > 16384) return null;
      const meta = JSON.parse(fs.readFileSync(file, 'utf8')), info = attachmentInfo(meta.sourceUrl, meta.announcementId);
      if (meta.cacheKind !== CACHE_KIND || meta.key !== key || !info || meta.format !== info.format
        || meta.fileName !== `attachment-${key}.${meta.format}` || !/^[a-f0-9]{64}$/.test(meta.fingerprint)
        || digest(JSON.stringify([meta.announcementId, meta.fingerprint, meta.sourceUrl])) !== key
        || !/^[a-f0-9]{64}$/.test(meta.sha256) || !Number.isSafeInteger(meta.bytes) || meta.bytes < 1
        || !Number.isFinite(meta.downloadedAt) || !Number.isFinite(meta.lastUsedAt)) return null;
      const stat = fs.statSync(this.location(meta.fileName));
      return stat.size === meta.bytes ? meta : null;
    } catch { return null; }
  }
  save(meta) {
    const name = `attachment-${meta.key}.json`, temporary = `metadata-${meta.key}-${randomUUID()}.tmp`;
    try { fs.writeFileSync(this.location(temporary), JSON.stringify(meta), { flag: 'wx' }); fs.renameSync(this.location(temporary), this.location(name)); }
    finally { this.remove(temporary); }
  }
  prune(reservationKey, requestedBytes = 0) {
    const now = this.clock(), entries = [], names = fs.readdirSync(this.directory); let unknownBytes = 0;
    for (const name of names) {
      if (partPattern.test(name) && !this.registry.activeParts.has(name)) {
        try {
          const stat = fs.statSync(this.location(name));
          if (now - stat.mtimeMs > this.maxAgeMs) this.remove(name);
          else unknownBytes += stat.size;
        } catch {}
      }
      const match = filePattern.exec(name); if (!match) continue;
      const meta = this.metadata(match[1]);
      if (meta?.fileName === name) entries.push(meta);
      else { try { unknownBytes += fs.statSync(this.location(name)).size; } catch {} }
    }
    const retained = new Set([...this.registry.retained.values()].flatMap(keys => [...keys]));
    entries.sort((a, b) => Number(retained.has(a.key)) - Number(retained.has(b.key)) || a.lastUsedAt - b.lastUsedAt);
    let bytes = unknownBytes + entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const reserved = [...this.registry.reservations].reduce((sum, [key, size]) => sum + (key === reservationKey ? 0 : size), 0);
    for (const meta of entries) {
      if (this.registry.pins.has(meta.key)) continue;
      if (now - meta.downloadedAt <= this.maxAgeMs && bytes + reserved + requestedBytes <= this.maxBytes) continue;
      // Only a matching, validated sidecar grants cleanup authority for a raw file.
      this.remove(meta.fileName); this.remove(`attachment-${meta.key}.json`); bytes -= meta.bytes;
    }
    if (bytes + reserved + requestedBytes > this.maxBytes) throw capacityError('附件缓存并发容量不足，等待其他下载完成', this.maxBytes, bytes + reserved + requestedBytes, 'cache-capacity');
    if (reservationKey) this.registry.reservations.set(reservationKey, requestedBytes);
  }
  readValidated(meta, { mode = 'buffer', maxFileBytes, signal } = {}) {
    const limit = fileBudget(mode, maxFileBytes);
    if (meta.bytes > limit) return null;
    const filePath = this.location(meta.fileName), descriptor = fs.openSync(filePath, 'r');
    try {
      active(signal);
      if (fs.fstatSync(descriptor).size !== meta.bytes) return null;
      // File mode deliberately retains only one chunk. Hash verification must
      // not turn a streaming download or an archive check into a full Buffer.
      const bytes = mode === 'buffer' ? Buffer.allocUnsafe(meta.bytes) : null;
      const chunk = bytes || Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, meta.bytes));
      const hasher = createHash('sha256'); let offset = 0, prefix = Buffer.alloc(0);
      while (offset < meta.bytes) {
        active(signal);
        const start = bytes ? offset : 0, length = Math.min(IO_CHUNK_BYTES, meta.bytes - offset);
        const received = fs.readSync(descriptor, chunk, start, length, offset);
        if (!received) return null;
        const part = chunk.subarray(start, start + received);
        if (prefix.length < 12) prefix = Buffer.concat([prefix, part.subarray(0, 12 - prefix.length)]);
        hasher.update(part); offset += received;
      }
      if (fs.fstatSync(descriptor).size !== meta.bytes || hasher.digest('hex') !== meta.sha256 || !signature(prefix, meta.format)) return null;
      return { ...(bytes ? { bytes } : {}), filePath, byteLength: meta.bytes, sha256: meta.sha256, format: meta.format, sourceUrl: meta.sourceUrl, downloadedAt: meta.downloadedAt };
    } finally { fs.closeSync(descriptor); }
  }
  readReference(reference, { id, fingerprint } = {}, { mode = 'buffer', maxFileBytes, signal } = {}) {
    fileBudget(mode, maxFileBytes);
    if (!reference || !/^[a-f0-9]{64}$/.test(reference.cacheKey)) return null;
    try {
      const meta = this.metadata(reference.cacheKey);
      if (!meta || meta.announcementId !== id || meta.fingerprint !== fingerprint || meta.sha256 !== reference.sha256
        || meta.bytes !== reference.bytes || meta.format !== reference.format) return null;
      return this.readValidated(meta, { mode, maxFileBytes, signal });
    } catch (error) { if (error.name === 'AbortError') throw error; return null; }
  }
  referenceState(reference, identity) {
    if (!reference || !/^[a-f0-9]{64}$/.test(reference.cacheKey) || !FORMATS[reference.format]) return 'mismatch';
    try {
      const raw = this.location(`attachment-${reference.cacheKey}.${reference.format}`), meta = this.location(`attachment-${reference.cacheKey}.json`);
      if (!fs.existsSync(raw) && !fs.existsSync(meta)) return 'missing';
      return this.readReference(reference, identity, { mode: 'file' }) ? 'valid' : 'mismatch';
    } catch { return 'mismatch'; }
  }
  async obtain({ id, fingerprint, url, maxFileBytes, mode = 'buffer', signal, fetcher, onProgress = () => {} }) {
    const info = attachmentInfo(url, id);
    if (!info || !/^[a-f0-9]{64}$/.test(fingerprint)) throw Error('附件来源或缓存身份无法核验');
    if (maxFileBytes === undefined) throw Error('附件单文件上限无效');
    fileBudget(mode, maxFileBytes);
    active(signal);
    const key = digest(JSON.stringify([id, fingerprint, info.url])), now = this.clock(), previous = this.metadata(key);
    if (previous && previous.bytes <= maxFileBytes && now >= previous.downloadedAt && now - previous.downloadedAt <= this.maxAgeMs) {
      const raw = this.readValidated(previous, { mode, maxFileBytes, signal }); active(signal);
      if (raw) {
        previous.lastUsedAt = now; this.save(previous); return { ...previous, ...(raw.bytes ? { bytesData: raw.bytes } : {}), filePath: raw.filePath, cached: true };
      }
    }
    const temporary = `download-${key}-${randomUUID()}.part`, reservation = temporary;
    let descriptor = null, reader = null, response = null; const release = this.hold(key);
    try {
      response = await cancellable(fetcher(info.url, { signal, cache: 'no-store', headers: { 'User-Agent': 'Mozilla/5.0', Referer: isCninfoId(id) ? 'https://www.cninfo.com.cn/' : 'https://data.eastmoney.com/' } }), signal);
      if (!response.ok) throw Error(`原始附件 HTTP ${response.status}`);
      const final = attachmentInfo(response.url || info.url, id);
      if (!final || final.format !== info.format) throw Error('原始附件重定向后的域名、公告编号或类型不符');
      const header = response.headers?.get('content-length'), declared = header == null ? null : Number(header);
      if (Number.isFinite(declared) && declared > maxFileBytes) throw capacityError(`原始附件下载大小超过上限（${declared} > ${maxFileBytes} 字节）`, maxFileBytes, declared);
      // arrayBuffer() cannot enforce a limit while receiving an untrusted
      // response, even when Content-Length promises a small body.
      if (!response.body?.getReader) throw Object.assign(Error('原始附件响应不支持有界流式下载'), { code: 'stream-unavailable' });
      const allocation = Number.isSafeInteger(declared) && declared > 0 ? declared : maxFileBytes;
      this.prune(reservation, allocation); this.registry.activeParts.add(temporary);
      descriptor = fs.openSync(this.location(temporary), 'wx');
      const hasher = createHash('sha256'); let received = 0, prefix = Buffer.alloc(0);
      const append = chunk => {
        active(signal);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        received += bytes.length;
        if (received > maxFileBytes) throw capacityError(`原始附件下载大小超过上限（${received} > ${maxFileBytes} 字节）`, maxFileBytes, received);
        if (received > this.registry.reservations.get(reservation)) this.prune(reservation, received);
        if (prefix.length < 12) prefix = Buffer.concat([prefix, bytes.subarray(0, 12 - prefix.length)]);
        let offset = 0;
        while (offset < bytes.length) {
          const written = fs.writeSync(descriptor, bytes, offset, Math.min(IO_CHUNK_BYTES, bytes.length - offset));
          if (!written) throw Error('附件临时文件写入不完整'); offset += written;
        }
        hasher.update(bytes); onProgress({ receivedBytes: received, totalBytes: declared });
      };
      reader = response.body.getReader();
      while (true) { const value = await cancellable(reader.read(), signal); if (value.done) break; append(value.value); }
      active(signal);
      if (!received || !signature(prefix, info.format)) throw Error(`附件不是有效 ${info.format.toUpperCase()} 文件`);
      if (Number.isSafeInteger(declared) && declared > 0 && received !== declared) throw Error('附件实际下载长度与声明不符，未保留不完整文件');
      fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = null;
      const meta = { cacheKind: CACHE_KIND, key, announcementId: id, fingerprint, sourceUrl: info.url, finalUrl: final.url,
        format: info.format, mimeType: info.mimeType, fileName: `attachment-${key}.${info.format}`, bytes: received, sha256: hasher.digest('hex'), downloadedAt: this.clock(), lastUsedAt: this.clock() };
      fs.renameSync(this.location(temporary), this.location(meta.fileName)); this.save(meta);
      const bytesData = mode === 'buffer' ? this.readValidated(meta, { mode, maxFileBytes, signal })?.bytes : null; active(signal);
      if (mode === 'buffer' && !bytesData) throw Error('附件落盘后的内容校验失败');
      return { ...meta, ...(bytesData ? { bytesData } : {}), filePath: this.location(meta.fileName), cached: false };
    } catch (error) {
      try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel?.()).catch(() => {}); } catch {}
      throw error;
    }
    finally {
      try { if (descriptor !== null) fs.closeSync(descriptor); }
      finally { try { this.remove(temporary); } finally { this.registry.activeParts.delete(temporary); this.registry.reservations.delete(reservation); release(); } }
    }
  }
}
module.exports = { CompanyAttachmentCache, attachmentInfo, CACHE_KIND };
