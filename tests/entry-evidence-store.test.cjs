const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { EntryEvidenceStore } = require('../core/entry-evidence-store.cjs');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const now = new Date('2026-09-29T10:00:00+08:00');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-entry-archive-'));
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('guanlan-entry-archive-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const archive = new EntryEvidenceStore(path.join(directory, 'archive'), options);
  const payload = decisionId => ({ version: 1, symbol: 'sz000001', strategyId: 'swing', decisionId, createdAt: now.toISOString(),
    rulesVersion: '1', entryConditions: { rules: [], source: { kind: 'agency-pool', policyVersion: 2 } },
    snapshot: { automaticEvidence: companyBundle('sz000001', now), automaticEvidenceEvaluation: { status: 'pass', checks: [{ key: 'productOutlook', status: 'pass', reason: '隔离原始核验内容' }] } } });
  const tradedAccount = (extraEvidence = {}) => {
    const engine = new Engine(initialState(100000), () => now), symbol = 'sz000001';
    engine.agencyTransfer({ strategyId: 'swing', amount: 50000 }); engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' }); engine.agencyMode({ strategyId: 'swing', mode: 'running' });
    const quote = { symbol, name: '隔离存储测试', source: 'test', price: 10.1, prevClose: 10.05, open: 10, low: 10, high: 10.2, volume: 100000,
      bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05, timestamp: now.getTime(), date: '2026-09-29' };
    const snapshot = { ...payload('template').snapshot, source: 'test daily', fetchedAt: now.getTime(),
      notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } },
      technical: { asOf: '2026-09-28', close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true,
        breakout: false, support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-09-28'] } };
    Object.assign(snapshot.automaticEvidence, extraEvidence);
    const a = engine.s.agency;
    engine.agencyExecute({ strategyId: 'swing', symbol, action: 'buy', targetPercent: 30, decisionId: 'archived-buy', expectedEpoch: a.epoch,
      expectedRevision: a.revision, archiveEntryEvidence: input => archive.archive(input) }, quote, snapshot, { [symbol]: quote });
    assert.equal(validState(engine.s), true); return engine.s;
  };
  return { directory, archive, payload, tradedAccount };
}

test('可信解析器文件路径按1MiB块归档，read和audit不读取整份原件Buffer', t => {
  let artifact; const f = fixture(t, { resolveDocumentArtifact: () => artifact });
  const file = path.join(f.directory, 'source.pdf'), bytes = Buffer.alloc(8 * 1024 * 1024, 32); bytes.write('%PDF-1.7\n');
  fs.writeFileSync(file, bytes); artifact = { filePath: file, byteLength: bytes.length, sha256: hash(bytes), format: 'pdf' };
  const originalRead = fs.readFileSync; let forbiddenReads = 0;
  fs.readFileSync = function (input, ...args) {
    if (typeof input === 'string' && (input === file || path.dirname(input) === path.join(f.archive.directory, 'original'))) {
      forbiddenReads++; throw Error('原件不得全量readFileSync');
    }
    return originalRead.call(this, input, ...args);
  };
  try {
    const ref = f.archive.archive(f.payload('streamed-file')), restored = f.archive.read(ref);
    assert.equal(restored.snapshot.automaticEvidence.documents[0].archivedOriginal.bytes, bytes.length);
    assert.equal(f.archive.archive(f.payload('streamed-file')).hash, ref.hash); assert.equal(forbiddenReads, 0);
    assert.equal(fs.readdirSync(path.join(f.archive.directory, 'original')).length, 1);
  } finally { fs.readFileSync = originalRead; }
  assert.equal(hash(fs.readFileSync(f.archive.file('original', artifact.sha256))), artifact.sha256);
  const corrupted = fixture(t, { resolveDocumentArtifact: () => ({ ...artifact, sha256: '0'.repeat(64) }) });
  assert.throws(() => corrupted.archive.archive(corrupted.payload('bad-file')), /原件身份或内容/);
  assert.deepEqual(fs.readdirSync(path.join(corrupted.archive.directory, 'original')), []);
});

test('行业PDF与官方原始HTML同样归档并完整备份恢复，原件base64不混入元数据', t => {
  const pdf = Buffer.from('%PDF-1.7\nIndependent industry report original'), sourceHash = hash(pdf);
  const f = fixture(t, { resolveDocumentArtifact: document => document.kind === 'industry-report' && document.originalBase64
    ? { bytes: pdf, sha256: sourceHash, format: 'pdf' } : null });
  const input = f.payload('archived-buy'), rawSource = JSON.stringify({ title: '官方行业数据', value: 30 }), text = '全国全行业2025年度收入排名第三，来自独立公开报告。';
  input.snapshot.automaticEvidence.industryDocuments = [
    { id: 'industry-pdf', kind: 'industry-report', issuerSymbol: input.symbol, text, textHash: hash(text), sourceHash, complete: true, originalBase64: pdf.toString('base64') },
    { id: 'industry-html', kind: 'industry-report', issuerSymbol: input.symbol, text, textHash: hash(text), sourceHash: hash(rawSource), rawSource, complete: true }
  ];
  const ref = f.archive.archive(input), stored = f.archive.manifest(ref).snapshot.snapshot.automaticEvidence;
  assert.equal(stored.industryDocuments.length, 2); assert.equal(stored.industryDocuments[0].originalBase64, undefined);
  assert.equal(stored.industryDocuments[0].archivedOriginal.hash, sourceHash); assert.equal(stored.industryDocuments[1].rawSource, rawSource);
  const state = f.tradedAccount({ industryDocuments: input.snapshot.automaticEvidence.industryDocuments });
  const backup = f.archive.exportAccount(state), target = new EntryEvidenceStore(path.join(f.directory, 'industry-restored'));
  assert.equal(backup.objects.filter(object => object.kind === 'original').length, 1); assert.deepEqual(target.importAccount(backup), state);
  const restored = target.read(state.trades[0].entryEvidenceRef).snapshot.automaticEvidence.industryDocuments;
  assert.ok(restored.every(document => document.text === text)); assert.equal(restored[1].rawSource, rawSource);
  const bad = structuredClone(input); bad.snapshot.automaticEvidence.industryDocuments[1].rawSource += 'tampered';
  assert.throws(() => f.archive.archive(bad), /行业原始资料校验失败/);
  const missing = fixture(t); assert.throws(() => missing.archive.archive(input), /行业PDF原件缺失/);
});

test('永久归档按正文与原件hash去重，保留页级OCR及原始核验内容', t => {
  const bytes = Buffer.from('%PDF-1.4\nverified fixture bytes'), f = fixture(t, { resolveDocumentArtifact: () => ({ bytes, sha256: hash(bytes), format: 'pdf' }) });
  const payload = f.payload('first');
  payload.snapshot.automaticEvidence.documents[0].pageTexts = [{ page: 1, text: '报告页', method: 'ocr', confidence: 0.98, complete: true, numericEligible: false, textHash: hash('报告页') }];
  payload.snapshot.automaticEvidence.documents[0].parserVersion = 'pdf-ocr-v1';
  payload.snapshot.automaticEvidence.documents[0].originalFile = { cacheKey: 'safe-key', sha256: hash(bytes), format: 'pdf', bytes: bytes.length };
  const first = f.archive.archive(payload); assert.deepEqual(f.archive.archive(payload), first);
  const second = f.archive.archive({ ...payload, decisionId: 'second' }); assert.notEqual(first.hash, second.hash);
  assert.equal(fs.readdirSync(path.join(f.archive.directory, 'text')).length, 2);
  assert.equal(fs.readdirSync(path.join(f.archive.directory, 'original')).length, 1);
  assert.equal(fs.readdirSync(path.join(f.archive.directory, 'snapshots')).length, 2);
  const restored = f.archive.read(first);
  assert.deepEqual(restored.snapshot.automaticEvidence.documents[0].pageTexts, payload.snapshot.automaticEvidence.documents[0].pageTexts);
  assert.equal(restored.snapshot.automaticEvidence.documents[0].parserVersion, 'pdf-ocr-v1');
  assert.equal(restored.snapshot.automaticEvidenceEvaluation.checks[0].reason, '隔离原始核验内容');
  payload.snapshot.automaticEvidence.documents[0].text = '后来变化';
  assert.notEqual(f.archive.read(first).snapshot.automaticEvidence.documents[0].text, '后来变化');
});

test('合法PDF及各图片原件按magic验证并归档，任意路径字段不会被读取', t => {
  const samples = { pdf: Buffer.from('%PDF-1.4\n'), png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    jpeg: Buffer.from([255, 216, 255, 224]), webp: Buffer.from('RIFF0000WEBP'), bmp: Buffer.from('BM0000') };
  for (const [format, bytes] of Object.entries(samples)) {
    const f = fixture(t, { resolveDocumentArtifact: () => ({ bytes, sha256: hash(bytes), format }) }), payload = f.payload(format);
    payload.snapshot.automaticEvidence.documents[0].originalFile = { path: 'C:/must-not-read/account.json', cacheKey: '../../account.json' };
    const ref = f.archive.archive(payload), document = f.archive.read(ref).snapshot.automaticEvidence.documents[0];
    assert.equal(document.archivedOriginal.format, format); assert.deepEqual(f.archive.readBlob('original', document.archivedOriginal.hash), bytes);
  }
});

test('正文hash、原件magic与引用身份不符时拒绝归档或读取', t => {
  const f = fixture(t), payload = f.payload('hash-mismatch'); payload.snapshot.automaticEvidence.documents[0].textHash = '0'.repeat(64);
  assert.throws(() => f.archive.archive(payload), /正文 hash 不符/);
  const ref = f.archive.archive(f.payload('valid'));
  assert.throws(() => f.archive.read({ ...ref, symbol: 'sh600519' }), /身份不符/);
  assert.throws(() => f.archive.read({ ...ref, hash: '../../account.json' }), /引用格式/);
  const wrong = fixture(t, { resolveDocumentArtifact: () => ({ bytes: Buffer.from('not a pdf'), sha256: hash('not a pdf'), format: 'pdf' }) });
  assert.throws(() => wrong.archive.archive(wrong.payload('bad-pdf')), /原件身份或内容/);
});

test('完整备份可按原操作复制为account.json恢复，保存后仍为普通账户且正文可读取', t => {
  const f = fixture(t), state = f.tradedAccount(), backup = f.archive.exportAccount(state);
  const target = path.join(f.directory, 'restored'), archive = new EntryEvidenceStore(path.join(target, 'entry-evidence'));
  const store = new Store(target, { decode: value => value?.format === 'guanlan-account-with-entry-evidence' ? archive.importAccount(value) : value });
  fs.writeFileSync(store.file, JSON.stringify(backup));
  const restored = store.load(); assert.deepEqual(restored, state); assert.equal(archive.auditAccount(restored).verified, 1);
  store.save(restored); assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).format, undefined);
  assert.equal(archive.read(restored.trades[0].entryEvidenceRef).snapshot.automaticEvidence.documents.length, 2);
});

test('主文件失败回退的备份也能恢复证据封装，旧历史无档案明确计数不伪造', t => {
  const f = fixture(t), state = f.tradedAccount(), backup = f.archive.exportAccount(state);
  const target = path.join(f.directory, 'fallback'), archive = new EntryEvidenceStore(path.join(target, 'entry-evidence'));
  const store = new Store(target, { decode: value => value?.format === 'guanlan-account-with-entry-evidence' ? archive.importAccount(value) : value });
  fs.writeFileSync(store.file, '{ invalid'); fs.writeFileSync(store.file + '.bak', JSON.stringify(backup));
  assert.deepEqual(store.load(), state); assert.match(store.warning, /恢复上一份/); assert.equal(archive.auditAccount(state).verified, 1);
  const legacy = structuredClone(state); delete legacy.trades[0].entryEvidenceRef; delete legacy.trades[0].entryEvidenceRequired;
  const audit = archive.auditAccount(legacy); assert.equal(audit.historical, 1); assert.equal(audit.verified, 0);
});

test('无效账户、篡改对象或备份缺正文在写永久对象前拒绝', t => {
  const f = fixture(t), backup = f.archive.exportAccount(f.tradedAccount());
  for (const mode of ['account', 'hash', 'missing']) {
    const bad = structuredClone(backup), target = new EntryEvidenceStore(path.join(f.directory, mode));
    if (mode === 'account') bad.account.cash++;
    if (mode === 'hash') bad.objects[0].data = Buffer.from('篡改').toString('base64');
    if (mode === 'missing') bad.objects = bad.objects.filter(object => object.kind !== 'text');
    assert.throws(() => target.importAccount(bad), /校验失败|缺失或损坏/);
    for (const kind of ['snapshots', 'text', 'original']) assert.deepEqual(fs.readdirSync(path.join(target.directory, kind)), []);
  }
});

test('显式完整备份导入修复同目录损坏对象，保存原损坏内容且不覆盖正常对象', t => {
  const f = fixture(t), state = f.tradedAccount(), backup = f.archive.exportAccount(state), ref = state.trades[0].entryEvidenceRef;
  const document = f.archive.manifest(ref).snapshot.snapshot.automaticEvidence.documents[0], file = f.archive.file('text', document.archivedText.hash);
  const normalFile = f.archive.file('snapshots', ref.hash), normalBefore = fs.statSync(normalFile);
  fs.writeFileSync(file, '应保留的损坏正文');
  assert.throws(() => f.archive.writeBlob('text', Buffer.from(document.text || companyBundle('sz000001', now).documents[0].text)), /内容校验失败/);
  assert.deepEqual(f.archive.importAccount(backup), state); assert.equal(f.archive.auditAccount(state).status, 'ready');
  const preserved = fs.readdirSync(path.dirname(file)).filter(name => name.startsWith(path.basename(file) + '.corrupt-'));
  assert.equal(preserved.length, 1); assert.equal(fs.readFileSync(path.join(path.dirname(file), preserved[0]), 'utf8'), '应保留的损坏正文');
  assert.equal(fs.statSync(normalFile).mtimeMs, normalBefore.mtimeMs);
  assert.match(f.archive.read(ref).snapshot.automaticEvidence.documents[0].text, /2025年年度报告/);
});

test('备份恢复拒绝把对象写入符号链接或目录对象，不触及链接目标', t => {
  const f = fixture(t), backup = f.archive.exportAccount(f.tradedAccount());
  const target = new EntryEvidenceStore(path.join(f.directory, 'unsafe-restore')), textDirectory = path.join(target.directory, 'text');
  const external = path.join(f.directory, 'not-the-archive'); fs.mkdirSync(external);
  fs.rmdirSync(textDirectory); fs.symlinkSync(external, textDirectory, 'junction');
  assert.throws(() => target.importAccount(backup), /恢复目录位置或类型无效/);
  assert.deepEqual(fs.readdirSync(external), []); assert.deepEqual(fs.readdirSync(path.join(target.directory, 'snapshots')), []);
  fs.unlinkSync(textDirectory); fs.mkdirSync(textDirectory);
  const object = backup.objects.find(item => item.kind === 'text'); fs.mkdirSync(target.file('text', object.hash));
  assert.throws(() => target.importAccount(backup), /恢复对象类型无效/);
});
