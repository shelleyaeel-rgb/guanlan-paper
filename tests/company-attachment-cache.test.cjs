const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { createHash } = require('node:crypto');
const { CompanyAttachmentCache, attachmentInfo } = require('../core/company-attachment-cache.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const ID = 'AN202608250006749206', URL = `https://pdf.dfcfw.com/pdf/H2_${ID}_1.pdf`;
const pdf = Buffer.from('%PDF-1.4\n' + 'verified public attachment '.repeat(3));
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-attachment-test-')), directory = path.join(root, 'attachments-v1');
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^guanlan-attachment-test-/); fs.rmSync(root, { recursive: true, force: true }); });
  let now = Date.now(), calls = 0;
  const cache = new CompanyAttachmentCache({ directory, clock: () => now, ...options });
  const input = { id: ID, fingerprint: hash('identity'), url: URL, maxFileBytes: 1024, fetcher: async () => { calls++; return new Response(pdf, { headers: { 'content-length': String(pdf.length) } }); } };
  return { root, directory, cache, input, get calls() { return calls; }, advance: ms => { now += ms; } };
}
const rawFiles = f => fs.readdirSync(f.directory).filter(name => /^attachment-.*\.(pdf|png|jpg|jpeg|webp|docx|xlsx)$/.test(name));
const unfinished = f => fs.readdirSync(f.directory).filter(name => /\.(part|tmp)$/.test(name));

test('声明及流式超限准确报告字节，释放所有预留与活动引用', async t => {
  for (const declared of [true, false]) {
    const f = fixture(t), limit = pdf.length - 1;
    await assert.rejects(f.cache.obtain({ ...f.input, maxFileBytes: limit, fetcher: async () => new Response(pdf, declared ? { headers: { 'content-length': String(pdf.length) } } : {}) }),
      error => error.code === 'size-limit' && error.limitBytes === limit && error.actualBytes === pdf.length);
    assert.equal(f.cache.registry.reservations.size, 0); assert.equal(f.cache.registry.pins.size, 0);
    assert.equal(f.cache.registry.activeParts.size, 0); assert.deepEqual(unfinished(f), []); assert.deepEqual(rawFiles(f), []);
  }
});

test('正在解析的原件严格保留，候选原件优先保留但不能突破总容量', async t => {
  const f = fixture(t, { maxBytes: pdf.length * 2 + 1 });
  const first = await f.cache.obtain(f.input); f.advance(1);
  const second = await f.cache.obtain({ ...f.input, fingerprint: hash('second') }); f.advance(1);
  const release = f.cache.hold(first.key); f.cache.retainReferences([second.key]);
  const third = await f.cache.obtain({ ...f.input, fingerprint: hash('third') });
  assert.equal(fs.existsSync(first.filePath), true, '活动解析不能被淘汰');
  assert.equal(fs.existsSync(second.filePath), false, '候选原件优先级不能突破总容量');
  assert.equal(fs.existsSync(third.filePath), true); release(); release(); assert.equal(f.cache.registry.pins.size, 0);
  f.cache.retainReferences([first.key]); f.advance(1);
  const fourth = await f.cache.obtain({ ...f.input, fingerprint: hash('fourth') });
  assert.equal(fs.existsSync(first.filePath), true); assert.equal(fs.existsSync(third.filePath), false);
  assert.equal(fs.existsSync(fourth.filePath), true); assert.equal(rawFiles(f).length, 2);
  f.cache.releaseRetention(); assert.equal(f.cache.registry.retained.size, 0);
});

test('原附件原子落盘后按身份和内容hash复用，归档只读取匹配引用不接受任意路径', async t => {
  const f = fixture(t), first = await f.cache.obtain(f.input), second = await f.cache.obtain(f.input);
  assert.equal(f.calls, 1); assert.equal(first.cached, false); assert.equal(second.cached, true); assert.equal(first.sha256, hash(pdf));
  assert.deepEqual(fs.readFileSync(first.filePath), pdf); assert.deepEqual(unfinished(f), []);
  const ref = { cacheKey: first.key, sha256: first.sha256, bytes: first.bytes, format: first.format };
  const identity = { id: ID, fingerprint: f.input.fingerprint };
  assert.deepEqual(f.cache.readReference(ref, identity).bytes, pdf);
  assert.equal(f.cache.readReference({ ...ref, cacheKey: '../account' }, identity), null);
  assert.equal(f.cache.readReference(ref, { ...identity, id: 'AN202608250006749207' }), null);
  const changed = Buffer.from(pdf); changed[changed.length - 1] ^= 1; fs.writeFileSync(first.filePath, changed);
  assert.equal(f.cache.referenceState(ref, identity), 'mismatch');
  await f.cache.obtain(f.input); assert.equal(f.calls, 2, '被修改文件不得复用');
  await f.cache.obtain({ ...f.input, fingerprint: hash('revised identity') }); assert.equal(f.calls, 3, '修订元数据需重新取得文件');
});

test('取消、网络失败、伪文件和声明长度不完整均不保留可用半文件', async t => {
  for (const variant of ['cancel', 'network', 'magic', 'short']) {
    const f = fixture(t), controller = new AbortController(); let started;
    const downloading = new Promise(resolve => { started = resolve; });
    const fetcher = async () => {
      if (variant === 'network') throw Error('offline');
      if (variant === 'magic') return new Response('not a PDF');
      if (variant === 'short') return new Response(pdf, { headers: { 'content-length': String(pdf.length + 10) } });
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(Buffer.from('%PDF-1.4')); started(); } }));
    };
    const task = f.cache.obtain({ ...f.input, fetcher, signal: controller.signal });
    if (variant === 'cancel') { await downloading; controller.abort(); }
    await assert.rejects(task); assert.deepEqual(unfinished(f), []); assert.deepEqual(rawFiles(f), []);
    assert.equal(f.cache.registry.reservations.size, 0);
  }
});

test('容量与30天时限只清理自己的完整缓存，不触碰旁边账本、证据和未知文件', async t => {
  const f = fixture(t, { maxBytes: pdf.length + 1 }), account = path.join(f.root, 'account.json'), evidence = path.join(f.directory, 'evidence-archive.json');
  fs.writeFileSync(account, 'DO NOT CHANGE ACCOUNT'); fs.writeFileSync(evidence, 'DO NOT CHANGE EVIDENCE');
  const first = await f.cache.obtain(f.input); f.advance(1000);
  const second = await f.cache.obtain({ ...f.input, fingerprint: hash('next report') });
  assert.equal(fs.existsSync(first.filePath), false); assert.equal(fs.existsSync(second.filePath), true);
  assert.equal(rawFiles(f).length, 1);
  f.advance(31 * 86400000); f.cache.prune(); assert.deepEqual(rawFiles(f), []);
  assert.equal(fs.readFileSync(account, 'utf8'), 'DO NOT CHANGE ACCOUNT'); assert.equal(fs.readFileSync(evidence, 'utf8'), 'DO NOT CHANGE EVIDENCE');
});

test('并发下载提前预留磁盘上限，不能靠多个未完成文件绕过总容量', async t => {
  const f = fixture(t, { maxBytes: pdf.length + 1 }), controller = new AbortController(); let began;
  const started = new Promise(resolve => { began = resolve; });
  const first = f.cache.obtain({ ...f.input, signal: controller.signal, fetcher: async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(pdf.subarray(0, 10)); }, pull() { began(); }
  }), { headers: { 'content-length': String(pdf.length) } }) });
  await started; await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.cache.obtain({ ...f.input, fingerprint: hash('other') }), /并发容量不足/);
  controller.abort(); await assert.rejects(first, /取消/); assert.deepEqual(unfinished(f), []);
});

test('重启留下的近期下载半文件计入容量，超期才清理且不会把有效下载挤出预算', async t => {
  const f = fixture(t, { maxBytes: pdf.length + 1 }), part = path.join(f.directory, `download-${hash('crashed')}-00000000-0000-0000-0000-000000000000.part`);
  fs.writeFileSync(part, pdf);
  const restart = new CompanyAttachmentCache({ directory: f.directory, maxBytes: pdf.length + 1 });
  await assert.rejects(restart.obtain(f.input), /并发容量不足/);
  assert.equal(fs.existsSync(part), true); assert.deepEqual(rawFiles(f), []);
  f.advance(31 * 86400000); f.cache.prune(); assert.equal(fs.existsSync(part), false);
  assert.equal((await f.cache.obtain(f.input)).sha256, hash(pdf));
});

test('只允许明确受信域名及公告编号匹配的附件类型，不生成猜测路径或执行文件', async t => {
  for (const format of ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'docx', 'xlsx']) assert.equal(attachmentInfo(URL.replace(/pdf$/, format), ID).format, format);
  for (const url of [URL.replace('https:', 'http:'), URL.replace('pdf.dfcfw.com', 'example.com'), URL.replace('.pdf', '.exe'), URL.replace(ID, ID + '1'), URL.replace('https://', 'https://user:pass@')]) {
    assert.equal(attachmentInfo(url, ID), null);
  }
  const f = fixture(t);
  await assert.rejects(f.cache.obtain({ ...f.input, fetcher: async () => {
    const value = new Response(pdf); Object.defineProperty(value, 'url', { value: URL.replace('pdf.dfcfw.com', 'example.com') }); return value;
  } }), /重定向/);
  assert.deepEqual(rawFiles(f), []);
});

test('缓存目录符号链接不能获得清理其他目录的权限', t => {
  const f = fixture(t), other = path.join(f.root, 'other'), link = path.join(f.root, 'linked-cache');
  fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'account.json'), 'preserved');
  fs.symlinkSync(other, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new CompanyAttachmentCache({ directory: link }), /符号链接/);
  assert.equal(fs.readFileSync(path.join(other, 'account.json'), 'utf8'), 'preserved');
});

test('文件模式下载、缓存复用与归档核验只用固定分块，不产生完整附件Buffer', async t => {
  const f = fixture(t), chunkLimit = 1024 * 1024, originalReadFileSync = fs.readFileSync, originalReadSync = fs.readSync;
  const payload = Buffer.concat([pdf, Buffer.alloc(chunkLimit * 2 + 7, 32)]);
  const input = { ...f.input, mode: 'file', maxFileBytes: payload.length, fetcher: async () => {
    f.fetches = (f.fetches || 0) + 1; return new Response(payload, { headers: { 'content-length': String(payload.length) } });
  } };
  let checkedChunks = 0;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    assert.doesNotMatch(String(file), /attachment-[a-f0-9]{64}\.pdf$/, '不得整份读取原件');
    return originalReadFileSync.call(this, file, ...args);
  });
  t.mock.method(fs, 'readSync', function (descriptor, buffer, offset, length, position) {
    assert.ok(length <= chunkLimit); checkedChunks++;
    return originalReadSync.call(this, descriptor, buffer, offset, length, position);
  });
  const first = await f.cache.obtain(input), second = await f.cache.obtain(input);
  assert.equal(f.fetches, 1); assert.equal(first.cached, false); assert.equal(second.cached, true);
  assert.equal(first.bytesData, undefined); assert.equal(second.bytesData, undefined);
  assert.equal(first.bytes, payload.length); assert.equal(first.sha256, hash(payload));
  const ref = { cacheKey: first.key, sha256: first.sha256, bytes: first.bytes, format: first.format };
  const identity = { id: ID, fingerprint: input.fingerprint };
  const archived = f.cache.readReference(ref, identity, { mode: 'file', maxFileBytes: payload.length });
  assert.equal(archived.filePath, first.filePath); assert.equal(archived.byteLength, payload.length); assert.equal(archived.bytes, undefined);
  assert.equal(f.cache.referenceState(ref, identity), 'valid'); assert.ok(checkedChunks >= 9);
  const descriptor = fs.openSync(first.filePath, 'r+');
  try { fs.writeSync(descriptor, Buffer.from('!'), 0, 1, payload.length - 1); } finally { fs.closeSync(descriptor); }
  assert.equal(f.cache.readReference(ref, identity, { mode: 'file' }), null);
  assert.equal(f.cache.referenceState(ref, identity), 'mismatch');
  assert.deepEqual(unfinished(f), []);
});

test('290MiB附件可按独立384MiB文件预算流式取得，普通模式及512MiB硬限不被放宽', async t => {
  const f = fixture(t), actualBytes = 304342284, chunk = Buffer.alloc(1024 * 1024, 32);
  pdf.copy(chunk); let remaining = actualBytes, calls = 0;
  const expected = createHash('sha256');
  const fetcher = async () => {
    calls++;
    return { ok: true, url: URL, headers: { get: () => String(actualBytes) }, body: { getReader: () => ({
      async read() {
        if (!remaining) return { done: true };
        const value = chunk.subarray(0, Math.min(remaining, chunk.length));
        expected.update(value); remaining -= value.length; return { done: false, value };
      }, async cancel() {}
    }) } };
  };
  await assert.rejects(f.cache.obtain({ ...f.input, maxFileBytes: 384 * 1024 * 1024, fetcher }), /单文件上限无效/);
  await assert.rejects(f.cache.obtain({ ...f.input, mode: 'file', maxFileBytes: 512 * 1024 * 1024 + 1, fetcher }), /单文件上限无效/);
  assert.equal(calls, 0);
  const result = await f.cache.obtain({ ...f.input, mode: 'file', maxFileBytes: 384 * 1024 * 1024, fetcher });
  assert.equal(result.bytes, actualBytes); assert.equal(result.bytesData, undefined); assert.equal(result.sha256, expected.digest('hex'));
  assert.equal(fs.statSync(result.filePath).size, actualBytes);
  const ref = { cacheKey: result.key, sha256: result.sha256, bytes: result.bytes, format: result.format };
  const identity = { id: ID, fingerprint: f.input.fingerprint };
  assert.equal(f.cache.readReference(ref, identity), null, '归档读取不能借文件模式绕过普通Buffer上限');
  assert.equal(f.cache.referenceState(ref, identity), 'valid');
  assert.equal(f.cache.registry.reservations.size, 0); assert.equal(f.cache.registry.pins.size, 0);
});

test('文件模式继续校验身份、大小和完整性，并拒绝无法有界接收的非流式响应', async t => {
  const f = fixture(t); let materialized = false, cancelled = false;
  await assert.rejects(f.cache.obtain({ ...f.input, mode: 'file', fetcher: async () => ({ ok: true,
    headers: { get: () => String(pdf.length) }, async arrayBuffer() { materialized = true; return pdf; }
  }) }), error => error.code === 'stream-unavailable');
  assert.equal(materialized, false);
  await assert.rejects(f.cache.obtain({ ...f.input, mode: 'file', maxFileBytes: pdf.length - 1, fetcher: async () => ({ ok: true,
    headers: { get: () => String(pdf.length) }, body: { getReader() { throw Error('超限响应不应读取'); }, async cancel() { cancelled = true; } }
  }) }), error => error.code === 'size-limit' && error.actualBytes === pdf.length);
  assert.equal(cancelled, true);
  await assert.rejects(f.cache.obtain({ ...f.input, mode: 'file', maxFileBytes: pdf.length - 1,
    fetcher: async () => new Response(pdf)
  }), error => error.code === 'size-limit');
  assert.deepEqual(unfinished(f), []); assert.deepEqual(rawFiles(f), []);
  assert.equal(f.cache.registry.reservations.size, 0); assert.equal(f.cache.registry.activeParts.size, 0); assert.equal(f.cache.registry.pins.size, 0);
});
