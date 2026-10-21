'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { symbolOf } = require('./common.cjs');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashLike = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const MAX_ORIGINAL_BYTES = 512 * 1024 * 1024;
const documentGroups = evidence => ['documents', 'industryDocuments'].filter(key => evidence?.[key] !== undefined);
const documentsOf = snapshot => documentGroups(snapshot.snapshot?.automaticEvidence).flatMap(key => snapshot.snapshot.automaticEvidence[key]);
const serial = value => JSON.stringify(value, (_key, item) => plain(item)
  ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
function originalFormat(bytes) {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (bytes.subarray(0, 2).toString() === 'BM') return 'bmp';
  return null;
}
function validEntryEvidenceRef(ref) {
  try { return plain(ref) && ref.version === 1 && hashLike(ref.hash) && symbolOf(ref.symbol) === ref.symbol
    && typeof ref.decisionId === 'string' && ref.decisionId.length > 0 && ref.decisionId.length <= 200
    && ['ultra-short', 'short', 'swing', 'long'].includes(ref.strategyId)
    && typeof ref.createdAt === 'string' && Number.isFinite(Date.parse(ref.createdAt)); } catch { return false; }
}
function assertIdentity(ref, snapshot) {
  if (!validEntryEvidenceRef(ref) || ['symbol', 'decisionId', 'strategyId', 'createdAt'].some(key => ref[key] !== snapshot?.[key])) throw Error('开仓依据引用与归档身份不符');
}
function inspectOriginalFile(file, expected, output) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1
    || expected.bytes > MAX_ORIGINAL_BYTES || stat.size !== expected.bytes || !hashLike(expected.hash)) throw Error('开仓依据原件文件身份或大小无效');
  let fd; const digest = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024); let total = 0, format;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd); if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw Error('开仓依据原件文件已变化');
    while (total < stat.size) {
      const length = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - total), total);
      if (!length) throw Error('开仓依据原件读取不完整');
      const part = chunk.subarray(0, length); if (!total) format = originalFormat(part); digest.update(part);
      if (output !== undefined) { let written = 0; while (written < length) written += fs.writeSync(output, part, written, length - written); }
      total += length;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== opened.mtimeMs || digest.digest('hex') !== expected.hash
      || !format || expected.format && format !== expected.format) throw Error('开仓依据原件身份或内容校验失败');
    return { hash: expected.hash, bytes: total, format };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Separate from the bounded research cache. There is deliberately no eviction,
// remove-member or close-position API: account backups retain these references.
class EntryEvidenceStore {
  constructor(directory, { resolveDocumentArtifact = null } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) throw Error('开仓依据归档目录无效');
    this.directory = path.resolve(directory); this.resolveDocumentArtifact = resolveDocumentArtifact;
    for (const section of ['', 'snapshots', 'text', 'original']) fs.mkdirSync(path.join(this.directory, section), { recursive: true });
    this.realDirectory = fs.realpathSync.native(this.directory);
  }
  file(kind, hash) {
    if (!['snapshots', 'text', 'original'].includes(kind) || !hashLike(hash)) throw Error('开仓依据文件引用无效');
    return path.join(this.directory, kind, `${hash}.${kind === 'snapshots' ? 'json' : kind === 'text' ? 'txt' : 'bin'}`);
  }
  readBlob(kind, hash) {
    const file = this.file(kind, hash);
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw Error('开仓依据归档文件类型无效');
    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== hash) throw Error('开仓依据归档内容校验失败');
    return bytes;
  }
  assertRestoreLocation(kind, hash) {
    const file = this.file(kind, hash), directory = path.dirname(file);
    if (fs.lstatSync(this.directory).isSymbolicLink() || fs.realpathSync.native(this.directory) !== this.realDirectory
      || fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()
      || fs.realpathSync.native(directory) !== path.join(this.realDirectory, kind)) throw Error('开仓依据恢复目录位置或类型无效');
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile())) throw Error('开仓依据恢复对象类型无效');
    return file;
  }
  restoreBlob(kind, bytes) {
    const hash = sha256(bytes), file = this.assertRestoreLocation(kind, hash);
    if (!fs.existsSync(file)) return this.writeBlob(kind, bytes);
    try { this.readBlob(kind, hash); return { hash, bytes: bytes.length }; } catch (error) {
      // Only an explicit, fully validated backup import may repair a damaged
      // object. Normal archive writes remain append-only and reject corruption.
      if (sha256(fs.readFileSync(file)) === hash) throw error;
    }
    const temporary = `${file}.${randomUUID()}.tmp`, preserved = `${file}.corrupt-${randomUUID()}`; let fd;
    try {
      fd = fs.openSync(temporary, 'wx'); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      this.assertRestoreLocation(kind, hash);
      // Keep the damaged inode, then atomically replace the active pathname.
      // A failed rename leaves the original object and its preserved copy intact.
      fs.linkSync(file, preserved); fs.renameSync(temporary, file);
      this.readBlob(kind, hash); return { hash, bytes: bytes.length };
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  writeBlob(kind, bytes) {
    bytes = Buffer.from(bytes); const hash = sha256(bytes), file = this.file(kind, hash);
    if (fs.existsSync(file)) { this.readBlob(kind, hash); return { hash, bytes: bytes.length }; }
    const temporary = `${file}.${randomUUID()}.tmp`; let fd;
    try {
      fd = fs.openSync(temporary, 'wx'); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      // Never overwrite a content-addressed object, even if another writer won.
      try { fs.linkSync(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; this.readBlob(kind, hash); }
      return { hash, bytes: bytes.length };
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  writeOriginalFile(artifact) {
    const expected = { hash: artifact.sha256 || artifact.hash, bytes: artifact.byteLength ?? artifact.bytes, format: artifact.format };
    const file = this.assertRestoreLocation('original', expected.hash), temporary = `${file}.${randomUUID()}.tmp`; let fd;
    try {
      fd = fs.openSync(temporary, 'wx'); const verified = inspectOriginalFile(artifact.filePath, expected, fd);
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      this.assertRestoreLocation('original', expected.hash);
      try { fs.linkSync(temporary, file); } catch (error) {
        if (error.code !== 'EEXIST') throw error; inspectOriginalFile(file, verified);
      }
      return verified;
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  verifyOriginal(original) {
    if (original?.version !== 1 || original.kind !== 'original') throw Error('开仓依据原件描述不符');
    return inspectOriginalFile(this.file('original', original.hash), original);
  }
  archive(payload) {
    const snapshot = JSON.parse(serial(payload));
    const provisional = { version: 1, hash: '0'.repeat(64), ...Object.fromEntries(['symbol', 'decisionId', 'strategyId', 'createdAt'].map(key => [key, snapshot[key]])) };
    assertIdentity(provisional, snapshot);
    for (const key of documentGroups(payload.snapshot?.automaticEvidence)) {
    const original = payload.snapshot.automaticEvidence[key];
    if (!Array.isArray(original)) throw Error('开仓依据文档集合无效');
    snapshot.snapshot.automaticEvidence[key] = original.map(document => {
      const text = document.text ?? document.fullText;
      if (typeof text !== 'string' || !text.trim() || document.complete !== true || document.issuerSymbol !== snapshot.symbol) throw Error('开仓依据文档正文或发行人身份不完整');
      if (document.fullText !== undefined && document.fullText !== text) throw Error('开仓依据正文版本不一致');
      const textHash = sha256(text);
      if (document.textHash !== undefined && document.textHash !== textHash) throw Error('开仓依据正文 hash 不符');
      if (key === 'industryDocuments' && (document.kind !== 'industry-report' || !hashLike(document.sourceHash)
        || document.rawSource !== undefined && (typeof document.rawSource !== 'string' || sha256(document.rawSource) !== document.sourceHash))) throw Error('开仓依据行业原始资料校验失败');
      const metadata = JSON.parse(serial(document)); delete metadata.text; delete metadata.fullText; delete metadata.originalBase64;
      metadata.textHash = textHash; metadata.archivedText = { version: 1, ...this.writeBlob('text', Buffer.from(text, 'utf8')) };
      // The injected resolver owns cache identity/path verification. A snapshot
      // never supplies an arbitrary path for this store to read.
      const artifact = this.resolveDocumentArtifact?.(document);
      if (artifact?.then) { artifact.catch?.(() => {}); throw Error('开仓依据原件解析器必须同步'); }
      if (key === 'industryDocuments' && document.originalBase64 && !artifact) throw Error('开仓依据行业PDF原件缺失');
      if (artifact) {
        if (key === 'industryDocuments' && (artifact.sha256 || artifact.hash) !== document.sourceHash) throw Error('开仓依据行业PDF原件hash不符');
        if (typeof artifact.filePath === 'string') {
          const stored = this.writeOriginalFile(artifact);
          metadata.archivedOriginal = { version: 1, kind: 'original', ...stored };
          return metadata;
        }
        if (!Buffer.isBuffer(artifact.bytes) && !(artifact.bytes instanceof Uint8Array)) throw Error('开仓依据原件字节无效');
        const bytes = Buffer.from(artifact.bytes);
        const originalHash = artifact.sha256 || artifact.hash;
        const format = String(artifact.format || artifact.kind || '').replace(/^application\//, '').replace(/^image\//, '').replace(/^jpg$/, 'jpeg');
        if (!format || originalFormat(bytes) !== format || !hashLike(originalHash) || sha256(bytes) !== originalHash) throw Error('开仓依据原件身份或内容校验失败');
        metadata.archivedOriginal = { version: 1, kind: 'original', format, ...this.writeBlob('original', bytes) };
      }
      return metadata;
    });
    }
    const stored = this.writeBlob('snapshots', Buffer.from(serial({ version: 1, snapshot }), 'utf8'));
    const ref = { ...provisional, hash: stored.hash }; this.read(ref); return ref;
  }
  manifest(ref) {
    if (!validEntryEvidenceRef(ref)) throw Error('开仓依据引用格式无效');
    const stored = JSON.parse(this.readBlob('snapshots', ref.hash).toString('utf8'));
    if (stored.version !== 1) throw Error('开仓依据归档版本不支持');
    assertIdentity(ref, stored.snapshot); return stored;
  }
  read(ref) {
    const { snapshot } = this.manifest(ref);
    for (const document of documentsOf(snapshot)) {
      const textRef = document.archivedText;
      if (textRef?.version !== 1 || !hashLike(textRef.hash)) throw Error('开仓依据正文引用缺失');
      const bytes = this.readBlob('text', textRef.hash);
      if (bytes.length !== textRef.bytes || document.textHash !== textRef.hash) throw Error('开仓依据正文描述不符');
      document.text = bytes.toString('utf8'); document.fullText = document.text;
      if (document.rawSource !== undefined && (typeof document.rawSource !== 'string' || sha256(document.rawSource) !== document.sourceHash)) throw Error('开仓依据行业原始资料校验失败');
      if (document.archivedOriginal) {
        this.verifyOriginal(document.archivedOriginal);
      }
    }
    return snapshot;
  }
  auditAccount(account) {
    const issues = []; let verified = 0, historical = 0;
    for (const trade of account?.trades || []) {
      if (trade.side !== 'buy' || !trade.owner || trade.owner === 'manual') continue;
      if (!trade.entryEvidenceRef && !trade.entryEvidenceRequired) { historical++; continue; }
      try {
        if (!trade.entryEvidenceRef) throw Error('成交要求永久开仓依据，但引用缺失');
        const snapshot = this.read(trade.entryEvidenceRef);
        if (snapshot.symbol !== trade.symbol || snapshot.strategyId !== trade.owner || snapshot.decisionId !== trade.decisionId) throw Error('开仓依据与成交身份不符');
        verified++;
      } catch (error) { issues.push({ tradeId: trade.id, symbol: trade.symbol, reason: error.message }); }
    }
    return { status: issues.length ? 'missing' : 'ready', verified, historical, issues };
  }
  exportAccount(account) {
    if (!require('./engine.cjs').validState(account)) throw Error('账户数据校验失败，不能导出完整备份');
    const audit = this.auditAccount(account);
    if (audit.issues.length) throw Error(`开仓依据未完整归档，不能导出完整备份：${audit.issues[0].reason}`);
    const objects = new Map();
    const include = (kind, hash) => { const key = `${kind}:${hash}`; if (!objects.has(key)) {
      objects.set(key, { kind, hash, data: this.readBlob(kind, hash).toString('base64') });
    } };
    for (const trade of account.trades || []) if (trade.entryEvidenceRef) {
      const ref = trade.entryEvidenceRef, { snapshot } = this.manifest(ref); include('snapshots', ref.hash);
      for (const document of documentsOf(snapshot)) {
        include('text', document.archivedText.hash);
        if (document.archivedOriginal) include('original', document.archivedOriginal.hash);
      }
    }
    return { format: 'guanlan-account-with-entry-evidence', version: 1, account: structuredClone(account), objects: [...objects.values()] };
  }
  importAccount(backup) {
    if (backup?.format !== 'guanlan-account-with-entry-evidence' || backup.version !== 1 || !plain(backup.account) || !Array.isArray(backup.objects)) throw Error('开仓依据备份格式无效');
    // Validate the accounting schema before creating any permanent objects.
    if (!require('./engine.cjs').validState(backup.account)) throw Error('开仓依据备份账户数据校验失败');
    const objects = backup.objects.map(object => {
      if (!plain(object) || typeof object.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(object.data)) throw Error('开仓依据备份内容格式无效');
      this.file(object.kind, object.hash); const bytes = Buffer.from(object.data, 'base64');
      if (sha256(bytes) !== object.hash) throw Error('开仓依据备份内容校验失败');
      return { ...object, bytes };
    });
    const source = new Map(objects.map(object => [`${object.kind}:${object.hash}`, object.bytes]));
    const preview = Object.create(EntryEvidenceStore.prototype);
    preview.readBlob = (kind, hash) => { const bytes = source.get(`${kind}:${hash}`); if (!bytes) throw Error('备份未携带所需开仓依据文件'); return bytes; };
    preview.verifyOriginal = original => {
      const bytes = preview.readBlob('original', original.hash);
      if (original.version !== 1 || original.kind !== 'original' || bytes.length !== original.bytes || originalFormat(bytes) !== original.format) throw Error('开仓依据原件描述不符');
    };
    const account = structuredClone(backup.account), previewAudit = preview.auditAccount(account);
    if (previewAudit.issues.length) throw Error(`开仓依据备份缺失或损坏：${previewAudit.issues[0].reason}`);
    for (const object of objects) this.assertRestoreLocation(object.kind, object.hash);
    for (const object of objects) this.restoreBlob(object.kind, object.bytes);
    const audit = this.auditAccount(account);
    if (audit.issues.length) throw Error(`开仓依据备份缺失或损坏：${audit.issues[0].reason}`);
    return account;
  }
}
module.exports = { EntryEvidenceStore, validEntryEvidenceRef };
