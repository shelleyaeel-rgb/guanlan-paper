const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { CompanyDocumentParser, LocalOcrWorker, verifiedPdfText, verifiedEmbeddedWingdings2, isVerifiedNonContentPage, documentCheckpoint, PARSER_VERSION } = require('../core/company-document-parser.cjs');
const { createCanvas } = require('@napi-rs/canvas');

function pdf(pages, padding = 0) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const ids = [];
  for (const text of pages) {
    const id = objects.length + 1; ids.push(id);
    const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    const stream = `BT /F1 14 Tf 20 150 Td (${escaped}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 180] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let output = '%PDF-1.4\n' + (padding ? '%' + ' '.repeat(padding) + '\n' : ''); const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}
function image(text = 'Isolated research document') {
  const canvas = createCanvas(800, 160), context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, 800, 160); context.fillStyle = '#000'; context.font = '32px sans-serif'; context.fillText(text, 20, 70);
  return canvas.toBuffer('image/png');
}
async function scannedPdf(png, { header = '', body = [], transform = [900, 0, 0, 360, 0, 0], transforms = [transform] } = {}) {
  const { loadImage } = require('@napi-rs/canvas'), picture = await loadImage(png), canvas = createCanvas(picture.width, picture.height);
  canvas.getContext('2d').drawImage(picture, 0, 0); const jpeg = canvas.toBuffer('image/jpeg');
  const literal = text => text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = transforms.map(matrix => `q ${matrix.join(' ')} cm /Im0 Do Q`).join('\n') + `\nBT /F1 12 Tf 20 345 Td (${literal(header)}) Tj ET\n`
    + body.map((text, index) => `BT /F1 12 Tf 20 ${280 - index * 25} Td (${literal(text)}) Tj ET`).join('\n');
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 360] /Resources << /XObject << /Im0 5 0 R >> /Font << /F1 6 0 R >> >> /Contents 4 0 R >>'),
    Buffer.from(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')];
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = chunks[0].length;
  for (let i = 0; i < objects.length; i++) { offsets.push(length); const object = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]); chunks.push(object); length += object.length; }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
  return Buffer.concat(chunks);
}
const accepted = () => ({ data: { text: '测试公司产品销量同比增长百分之十二，已完成商业化交付。', confidence: 96 } });
const embeddedNames = () => [1, 3].flatMap(platform => [[1, 'Wingdings 2'], [4, 'Wingdings 2'], [6, 'Wingdings2']]
  .map(([nameId, value]) => ({ platform, encoding: platform === 1 ? 0 : 1, language: platform === 1 ? 0 : 1033, nameId, value })));
function namedSfnt(records = embeddedNames(), { duplicateTable = false } = {}) {
  const encoded = records.map(record => record.bytes || (record.platform === 3 ? Buffer.from(record.value, 'utf16le').swap16() : Buffer.from(record.value, 'latin1')));
  const strings = 6 + records.length * 12, name = Buffer.alloc(strings + encoded.reduce((sum, bytes) => sum + bytes.length, 0));
  name.writeUInt16BE(records.length, 2); name.writeUInt16BE(strings, 4); let cursor = 0;
  records.forEach((record, i) => {
    const row = 6 + i * 12;
    for (const [j, value] of [record.platform, record.encoding, record.language, record.nameId, encoded[i].length, cursor].entries()) name.writeUInt16BE(value, row + j * 2);
    encoded[i].copy(name, strings + cursor); cursor += encoded[i].length;
  });
  const tableCount = duplicateTable ? 2 : 1, header = Buffer.alloc(12 + tableCount * 16);
  header.writeUInt32BE(0x00010000); header.writeUInt16BE(tableCount, 4);
  for (let i = 0; i < tableCount; i++) { const row = 12 + i * 16; header.write('name', row); header.writeUInt32BE(header.length, row + 8); header.writeUInt32BE(name.length, row + 12); }
  return Buffer.concat([header, name]);
}
function localPdf(t, bytes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-parser-file-')), filePath = path.join(directory, 'source.pdf');
  fs.writeFileSync(filePath, bytes);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^company-parser-file-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { filePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

test('verified local PDF uses bounded ranges without readFile and keeps the exact source hash', async t => {
  const input = localPdf(t, pdf(['Verified native first page of the original report.', 'Verified final page of the original report.'], 2 * 1024 * 1024));
  const originalOpen = fs.promises.open, originalReadFile = fs.promises.readFile, pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const originalRange = pdfjs.PDFDataRangeTransport.prototype.onDataRange; let reads = 0, ranges = 0;
  t.mock.method(fs.promises, 'readFile', function (filename, ...args) {
    assert.notEqual(filename, input.filePath, 'file input must never materialize the entire raw PDF'); return originalReadFile.call(this, filename, ...args);
  });
  t.mock.method(fs.promises, 'open', async function (filename, ...args) {
    const handle = await originalOpen.call(this, filename, ...args);
    if (filename === input.filePath) {
      const originalRead = handle.read;
      t.mock.method(handle, 'read', function (buffer, offset, length, position) {
        reads++; assert.ok(length <= 1024 * 1024); return originalRead.call(this, buffer, offset, length, position);
      });
    }
    return handle;
  });
  t.mock.method(pdfjs.PDFDataRangeTransport.prototype, 'onDataRange', function (begin, bytes) {
    ranges++; assert.ok(bytes.length <= 16 * 1024 * 1024); return originalRange.call(this, begin, bytes);
  });
  const parser = new CompanyDocumentParser({ maxBytes: 1024, recognize: () => { throw Error('native file must not use OCR'); } });
  try {
    const result = await parser.parse(input, { format: 'pdf', fileMaxBytes: 4 * 1024 * 1024 });
    assert.equal(result.complete, true, result.issues.join(';')); assert.equal(result.pages, 2); assert.equal(result.sourceHash, input.sha256);
    assert.match(result.pageTexts[1].text, /Verified final page/); assert.equal(result.hasOcrPages, false); assert.ok(reads >= 5); assert.ok(ranges >= 2);
    await assert.rejects(parser.parse(pdf(['A buffer still respects its ordinary byte limit.'], 1024)), /大小超过解析上限/);
  } finally { await parser.destroy(); }
});

test('file input validates expected hash, size, format and independent hard limits before parsing', async t => {
  const input = localPdf(t, pdf(['Identity validation must precede original document parsing.']));
  const parser = new CompanyDocumentParser({ recognize: () => { throw Error('invalid file must not use OCR'); } });
  try {
    await assert.rejects(parser.parse({ ...input, sha256: '0'.repeat(64) }), /SHA-256/);
    await assert.rejects(parser.parse({ ...input, bytes: input.bytes + 1 }), /大小已变化/);
    await assert.rejects(parser.parse({ ...input, filePath: 'relative.pdf' }), /身份无效/);
    await assert.rejects(parser.parse({ ...input, filePath: path.dirname(input.filePath) }), /普通文件/);
    await assert.rejects(parser.parse(input, { fileMaxBytes: input.bytes - 1 }), error => error.code === 'size-limit');
    await assert.rejects(parser.parse(input, { fileMaxBytes: 512 * 1024 * 1024 + 1 }), /字节上限无效/);
    await assert.rejects(parser.parse({ ...input, bytes: 512 * 1024 * 1024 + 1 }, { fileMaxBytes: 512 * 1024 * 1024 }), error => error.code === 'size-limit');
    await assert.rejects(parser.parse(input, { maxPages: 1601 }), /页数或文字上限无效/);
    await assert.rejects(parser.parse(input, { maxChars: 4000001 }), /页数或文字上限无效/);
    await assert.rejects(parser.parse(input, { parseTimeoutMs: 300001 }), /超时上限无效/);
    const picture = localPdf(t, image());
    await assert.rejects(parser.parse(picture), /仅支持 PDF/);
    assert.equal((await parser.parse(input)).complete, true, 'failed validation must release the parser queue');
  } finally { await parser.destroy(); }
});

test('file input rejects a symbolic link even when its contents and hash match', async t => {
  const input = localPdf(t, pdf(['A symbolic link does not grant a trusted file identity.'])), link = path.join(path.dirname(input.filePath), 'linked.pdf');
  try { fs.symlinkSync(input.filePath, link, 'file'); } catch (error) { if (error.code === 'EPERM') { t.skip('file symlinks require host privilege'); return; } throw error; }
  const parser = new CompanyDocumentParser();
  try { await assert.rejects(parser.parse({ ...input, filePath: link }), /符号链接/); }
  finally { await parser.destroy(); }
});

test('cancelling file hash validation closes the file and frees the serialized parser queue', async t => {
  const input = localPdf(t, pdf(['A cancelled hash must not produce complete document evidence.'], 2 * 1024 * 1024));
  const controller = new AbortController(), originalOpen = fs.promises.open; let opened;
  t.mock.method(fs.promises, 'open', async function (filename, ...args) {
    const handle = await originalOpen.call(this, filename, ...args);
    if (filename === input.filePath && !opened) {
      opened = handle; const originalRead = handle.read;
      t.mock.method(handle, 'read', async function (...values) { const result = await originalRead.apply(this, values); controller.abort(); return result; });
    }
    return handle;
  });
  const parser = new CompanyDocumentParser();
  try {
    await assert.rejects(parser.parse(input, { signal: controller.signal }), error => error.name === 'AbortError');
    await parser.parseQueue; assert.equal(opened.fd, -1);
    assert.equal((await parser.parse(input)).complete, true);
  } finally { await parser.destroy(); }
});

test('a 1033-page local report retains every page only within the independent long-report limits', async t => {
  const input = localPdf(t, pdf(Array.from({ length: 1033 }, (_, index) => `Issuer complete report original page ${index + 1}.`)));
  const parser = new CompanyDocumentParser({ recognize: () => { throw Error('native long report must not use OCR'); } });
  try {
    const ordinary = await parser.parse(input);
    assert.equal(ordinary.complete, false); assert.equal(ordinary.pages, 1033); assert.equal(ordinary.text, ''); assert.match(ordinary.issues.join(';'), /document-page-limit/);
    const result = await parser.parse(input, { fileMaxBytes: 384 * 1024 * 1024, maxPages: 1200, maxChars: 2000000, parseTimeoutMs: 300000 });
    assert.equal(result.complete, true, result.issues.join(';')); assert.equal(result.pages, 1033); assert.equal(result.pageTexts.length, 1033);
    assert.equal(result.pageTexts[1032].text, 'Issuer complete report original page 1033.'); assert.equal(result.sourceHash, input.sha256);
    assert.ok(result.pageTexts.every((page, index) => page.complete && page.page === index + 1 && page.method === 'pdf-text'));
  } finally { await parser.destroy(); }
});

test('oversized coalesced PDF ranges fail explicitly instead of allocating an unbounded request block', async t => {
  const input = localPdf(t, pdf(['A large content stream must not bypass the range allocation limit.' + ' '.repeat(20 * 1024 * 1024)]));
  const parser = new CompanyDocumentParser({ recognize: () => { throw Error('range failure must not reach OCR'); } });
  try { await assert.rejects(parser.parse(input), error => error.code === 'document-range-limit'); }
  finally { await parser.destroy(); }
});

test('a timeout checkpoints only complete prefix pages and resumes without repeating completed OCR', async t => {
  const input = localPdf(t, pdf(['', ''])), calls = []; let checkpoint;
  const parser = new CompanyDocumentParser({ recognize: (bytes, { page }) => {
    calls.push(page); return page === 1 ? accepted() : new Promise(() => {});
  } });
  const keeper = setInterval(() => {}, 100); t.after(() => clearInterval(keeper));
  try {
    await assert.rejects(parser.parse(input, { parseTimeoutMs: 500 }), error => {
      checkpoint = error.partialResult; return error.code === 'parse-timeout' && checkpoint?.checkpoint === 'parse-timeout';
    });
    assert.equal(checkpoint.complete, false); assert.equal(checkpoint.numericEligible, false); assert.equal(checkpoint.hasOcrPages, true);
    assert.equal(checkpoint.pages, 2); assert.equal(checkpoint.pageTexts.length, 1); assert.equal(checkpoint.pageTexts[0].complete, true);
    assert.equal(checkpoint.sourceHash, input.sha256); assert.equal(checkpoint.parserVersion, PARSER_VERSION);
    assert.deepEqual(calls, [1, 2]);
    parser.recognizer = (bytes, { page }) => { calls.push(page); return accepted(); };
    const progress = [], resumed = await parser.parse(input, { resume: checkpoint, onProgress: value => progress.push(value) });
    assert.equal(resumed.complete, true); assert.equal(resumed.pageTexts.length, 2); assert.equal(resumed.hasOcrPages, true); assert.equal(resumed.numericEligible, false);
    assert.deepEqual(resumed.pageTexts[0], checkpoint.pageTexts[0]); assert.deepEqual(calls, [1, 2, 2]);
    assert.ok(progress.some(value => value.stage === 'parser-resume' && value.completed === 1));
    for (const mutate of [
      value => { value.sourceHash = '0'.repeat(64); }, value => { value.parserVersion = 'future-version'; }, value => { value.parserVersion = '3'; },
      value => { value.pageTexts[0].textHash = '0'.repeat(64); }, value => { value.pageTexts[0].page = 2; },
      value => { value.hasOcrPages = false; }, value => { value.numericEligible = true; },
      value => { value.text += ' altered'; }, value => { value.pageTexts[0].complete = false; },
      value => { value.pageTexts[0].numericEligible = true; }, value => { value.pageTexts[0].confidence = 20; }
    ]) {
      const invalid = structuredClone(checkpoint); mutate(invalid);
      await assert.rejects(parser.parse(input, { resume: invalid }), error => error.code === 'invalid-checkpoint');
    }
    assert.deepEqual(calls, [1, 2, 2], 'invalid checkpoint metadata must not invoke OCR or be silently trusted');
  } finally { await parser.destroy(); }
});

test('a timeout cannot skip a low-confidence gap or publish its later pages as a resumable prefix', async () => {
  const bytes = pdf(['Native first page contains complete original evidence.', '', '']);
  const parser = new CompanyDocumentParser({ recognize: (input, { page }) => page === 2
    ? { data: { text: '本页识别文字完整但置信度不足仍然必须核验。', confidence: 42 } } : new Promise(() => {}) });
  const keeper = setInterval(() => {}, 100);
  try {
    await assert.rejects(parser.parse(bytes, { parseTimeoutMs: 500 }), error => {
      assert.equal(error.code, 'parse-timeout'); assert.equal(error.partialResult.pageTexts.length, 1);
      assert.equal(error.partialResult.pageTexts[0].page, 1); assert.equal(error.partialResult.pageTexts[0].method, 'pdf-text');
      assert.equal(error.partialResult.hasOcrPages, false); assert.equal(error.partialResult.numericEligible, false); return true;
    });
  } finally { clearInterval(keeper); await parser.destroy(); }
});

test('native coverage precedes OCR and timeout retains later complete pages without trusting the missing scan', async () => {
  const input = pdf(['', 'Searchable issuer revenue evidence on the second page.', 'Complete native audit evidence on the last page.']);
  const progress = [], calls = []; let checkpoint;
  const parser = new CompanyDocumentParser({ recognize: (bytes, { page }) => {
    calls.push(page);
    assert.ok(progress.some(value => value.stage === 'native-scan-complete' && value.completed === 2 && value.ocrPages === 1));
    return new Promise(() => {});
  } });
  const keeper = setInterval(() => {}, 100);
  try {
    await assert.rejects(parser.parse(input, { parseTimeoutMs: 400, onProgress: value => progress.push(value) }), error => {
      checkpoint = error.partialResult; return error.code === 'parse-timeout' && !!checkpoint;
    });
    assert.equal(checkpoint.complete, false); assert.equal(checkpoint.numericEligible, false);
    assert.equal(checkpoint.checkpointLayout, 'sparse-pages-v1'); assert.deepEqual(checkpoint.missingPages, [1]);
    assert.deepEqual(checkpoint.pageTexts.map(page => page.page), [2, 3]); assert.equal(checkpoint.hasOcrPages, false);
    for (const mutate of [
      value => { value.missingPages = []; }, value => { value.missingPages = [2]; },
      value => { value.pageTexts.reverse(); value.text = value.pageTexts.map(row => row.text).join('\n\n'); },
      value => { value.pageTexts[1].page = 2; }, value => { value.pageTexts[1].page = 4; }
    ]) {
      const invalid = structuredClone(checkpoint); mutate(invalid);
      await assert.rejects(parser.parse(input, { resume: invalid }), error => error.code === 'invalid-checkpoint');
    }
    const resumedProgress = [];
    parser.recognizer = (bytes, { page }) => { calls.push(page); return accepted(); };
    const result = await parser.parse(input, { resume: checkpoint, onProgress: value => resumedProgress.push(value) });
    assert.equal(result.complete, true); assert.equal(result.numericEligible, false);
    assert.deepEqual(result.pageTexts.map(page => page.page), [1, 2, 3]); assert.deepEqual(result.pageTexts.slice(1), checkpoint.pageTexts);
    assert.deepEqual(calls, [1, 1]);
    assert.deepEqual(resumedProgress.filter(value => value.stage === 'parsed').map(value => value.page), [1], 'completed later pages must not be extracted again');
  } finally { clearInterval(keeper); await parser.destroy(); }
});

test('a low-confidence early scan does not discard complete later text or become complete evidence', async () => {
  const parser = new CompanyDocumentParser({ recognize: () => ({ data: { text: '这页缺少可靠识别依据，不能认为已完整核验。', confidence: 20 } }) });
  try {
    const result = await parser.parse(pdf(['', 'Later native financial evidence remains complete and source matched.']));
    assert.equal(result.complete, false); assert.equal(result.numericEligible, false);
    assert.equal(result.pageTexts[0].complete, false); assert.equal(result.pageTexts[1].complete, true);
    assert.equal(result.pageTexts[1].method, 'pdf-text'); assert.match(result.issues.join(';'), /ocr-confidence-low/);
  } finally { await parser.destroy(); }
});

test('explicit retry checkpoints reuse verified pages, require a complete gap map and retain resumed pages on timeout', async () => {
  const input = pdf(['', 'Verified native original evidence on page two.', 'Verified native source on page three.']);
  const parser = new CompanyDocumentParser({ recognize: () => ({ data: { text: 'Low confidence page remains unresolved.', confidence: 20 } }) });
  const keeper = setInterval(() => {}, 100);
  try {
    const incomplete = await parser.parse(input), sourceHash = createHash('sha256').update(input).digest('hex');
    const resume = documentCheckpoint(sourceHash, incomplete.pages, incomplete.pageTexts, 'parse-retry');
    assert.equal(resume.checkpoint, 'parse-retry'); assert.deepEqual(resume.missingPages, [1]); assert.deepEqual(resume.pageTexts.map(page => page.page), [2, 3]);
    assert.match(resume.issues[0], /document-parse-retry/); assert.doesNotMatch(resume.issues[0], /timeout/);
    for (const change of [{ checkpoint: 'unknown' }, { missingPages: undefined }, { missingPages: [] }, { checkpointLayout: 'unknown' }, { sourceHash: '0'.repeat(64) }]) {
      await assert.rejects(parser.parse(input, { resume: { ...resume, ...change } }), error => error.code === 'invalid-checkpoint');
    }
    const emitted = []; parser.recognizer = () => new Promise(() => {});
    await assert.rejects(parser.parse(input, { resume, parseTimeoutMs: 200, onPage: value => emitted.push(value.page.page) }), error => {
      assert.equal(error.code, 'parse-timeout'); assert.equal(error.partialResult.checkpoint, 'parse-timeout');
      assert.deepEqual(error.partialResult.pageTexts, resume.pageTexts); assert.deepEqual(error.partialResult.missingPages, [1]); return true;
    });
    assert.deepEqual(emitted, [2, 3], 'pool receives verified resumed pages before any unfinished OCR');
    parser.recognizer = () => accepted();
    const result = await parser.parse(input, { resume });
    assert.equal(result.complete, true); assert.equal(result.numericEligible, false); assert.deepEqual(result.pageTexts.slice(1), resume.pageTexts);
  } finally { clearInterval(keeper); await parser.destroy(); }
});

test('user cancellation after a completed file page never exposes a timeout checkpoint', async t => {
  const input = localPdf(t, pdf(['Complete native original first page before a cancelled OCR page.', '']));
  const controller = new AbortController(); let started;
  const began = new Promise(resolve => { started = resolve; });
  const parser = new CompanyDocumentParser({ recognize: () => { started(); return new Promise(() => {}); } });
  try {
    const pending = parser.parse(input, { signal: controller.signal }); await began; controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError' && error.partialResult === undefined);
    await parser.parseQueue;
    assert.equal((await parser.parse(pdf(['The parser queue is usable after user cancellation.']))).complete, true);
  } finally { await parser.destroy(); }
});

test('native PDF text is extracted per page without OCR and keeps page hashes', async () => {
  let called = 0;
  const parser = new CompanyDocumentParser({ recognize: () => { called++; return accepted(); } });
  try {
    const input = pdf(['Issuer annual report complete native text.', 'Product sales rose twelve percent this year.']);
    const result = await parser.parse(input, { format: 'application/pdf' });
    assert.equal(called, 0); assert.equal(result.complete, true); assert.equal(result.pages, 2); assert.equal(result.parserVersion, PARSER_VERSION);
    assert.equal(result.numericEligible, true); assert.equal(result.hasOcrPages, false);
    assert.ok(result.pageTexts.every(page => page.method === 'pdf-text' && page.confidence === null && page.textHash.length === 64));
    assert.match(result.pageTexts[1].text, /Product sales/); assert.equal(input.subarray(0, 5).toString(), '%PDF-');
  } finally { await parser.destroy(); }
});

test('reviewed real native checkbox page keeps both checked alternatives and its financial amount without OCR', async () => {
  const bytes = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'company-native-checkboxes.pdf'));
  let calls = 0; const parser = new CompanyDocumentParser({ recognize: () => { calls++; throw Error('readable native page must not use OCR'); } });
  try {
    const result = await parser.parse(bytes), page = result.pageTexts[0];
    assert.equal(result.complete, true); assert.equal(calls, 0); assert.equal(page.numericEligible, true);
    assert.equal(page.verifiedCheckboxes.length, 7); assert.match(page.text, /☑ 适用 □ 不适用/); assert.match(page.text, /□ 适用 ☑ 不适用/);
    assert.match(page.text, /44,034\.73 元/); assert.match(page.rawText, /\uF052/); assert.doesNotMatch(page.text, /\uF052/);
    assert.equal(page.rawTextHash, require('node:crypto').createHash('sha256').update(page.rawText).digest('hex'));
    assert.ok(page.verifiedCheckboxes.every(entry => entry.font.endsWith('+Wingdings2') && entry.original === '\uF052' && entry.replacement === '☑'));
  } finally { await parser.destroy(); }
});

test('a real page with an unverified font identity keeps its PUA unresolved and goes to OCR', async () => {
  const bytes = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'company-native-checkboxes.pdf'));
  const changed = Buffer.from(bytes.toString('latin1').replaceAll('Wingdings2', 'OtherFontX'), 'latin1');
  let calls = 0; const parser = new CompanyDocumentParser({ recognize: () => { calls++; return { data: { text: '', confidence: 0 } }; } });
  try {
    const result = await parser.parse(changed); assert.equal(calls, 1); assert.equal(result.complete, false);
    assert.match(result.issues.join(';'), /text-garbled/); assert.equal(result.pageTexts[0].numericEligible, false);
  } finally { await parser.destroy(); }
});

test('reviewed real empty boxes and SymbolMT list bullets preserve native financial statements', async () => {
  const bytes = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'company-native-symbols.pdf'));
  const parser = new CompanyDocumentParser({ recognize: () => { throw Error('reviewed native symbols must not use OCR'); } });
  try {
    const result = await parser.parse(bytes); assert.equal(result.complete, true); assert.equal(result.hasOcrPages, false);
    assert.ok(result.pageTexts[0].verifiedGlyphs.some(glyph => glyph.original === '\uF0A3' && glyph.replacement === '□'));
    assert.match(result.pageTexts[0].text, /☑ 适用 □ 不适用/);
    assert.equal(result.pageTexts[1].verifiedGlyphs.filter(glyph => glyph.replacement === '•').length, 6);
    assert.equal(result.pageTexts[2].verifiedGlyphs.filter(glyph => glyph.replacement === '•').length, 4);
    assert.match(result.pageTexts[2].text, /债务人未能按合同到期日支付本金和利息/);
    assert.ok(result.pageTexts.every(page => page.numericEligible && /[\uE000-\uF8FF]/.test(page.rawText) && !/[\uE000-\uF8FF]/.test(page.text)));
  } finally { await parser.destroy(); }
});

test('reviewed real extra-empty checkbox variants preserve native amounts and all original option marks', async () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'company-native-option-variants.pdf')); let calls = 0;
  const parser = new CompanyDocumentParser({ recognize: () => { calls++; throw Error('verified native option line must not use OCR'); } });
  try {
    const result = await parser.parse(bytes); assert.equal(result.complete, true, result.issues.join(';')); assert.equal(calls, 0);
    assert.equal(result.pageTexts.length, 2); assert.ok(result.pageTexts.every(page => page.method === 'pdf-text' && page.numericEligible));
    assert.equal(result.pageTexts[0].verifiedCheckboxes.length, 3); assert.equal(result.pageTexts[1].verifiedCheckboxes.length, 5);
    assert.match(result.pageTexts[0].text.replace(/\s/g, ''), /口适用☑不适用/); assert.match(result.pageTexts[0].text, /45,015,274,477\.23/);
    assert.match(result.pageTexts[1].text.replace(/\s/g, ''), /□适用□☑不适用/); assert.match(result.pageTexts[1].text, /13,213,250\.21/);
  } finally { await parser.destroy(); }
});

test('extra-empty choice mapping requires the complete exclusive line and verified Wingdings2 font', () => {
  const map = (text, font = 'ABCDEF+Wingdings2') => verifiedPdfText([{ str: text, fontName: 'f1', hasEOL: true }], { f1: font });
  for (const text of ['口适用 \uF052 不适用', '□适用 □\uF052 不适用']) {
    assert.equal(map(text).verifiedCheckboxes.length, 1); assert.ok(map(text).text.includes('☑'));
    assert.equal(map(text, 'UnverifiedFont').verifiedCheckboxes.length, 0);
  }
  for (const text of ['口适用 \uF052 不适用 额外文字', '额外文字 口适用 \uF052 不适用', '□适用 □\uF052 不适用 额外文字',
    '口适用\n\uF052 不适用', '□适用 □\n\uF052 不适用', '口适用 \uF052 \uF052 不适用']) {
    const result = map(text); assert.equal(result.verifiedCheckboxes.length, 0); assert.ok(result.text.includes('\uF052'));
  }
});

test('anonymous CID font can use only consistent exact embedded SFNT family/full/PostScript names', () => {
  const data = namedSfnt(), identity = verifiedEmbeddedWingdings2({ name: 'CIDFont+F5', data });
  assert.equal(identity.name, 'Wingdings2'); assert.equal(identity.proof.basis, 'pdfjs-embedded-sfnt-name-table');
  assert.equal(identity.proof.originalFontName, 'CIDFont+F5'); assert.equal(identity.proof.decodedFontSha256, createHash('sha256').update(data).digest('hex'));
  assert.deepEqual(identity.proof.records, embeddedNames()); assert.match(identity.proof.nameTableSha256, /^[a-f0-9]{64}$/);
  const framed = Buffer.concat([Buffer.from([42, 43, 44]), data, Buffer.from([45])]);
  assert.deepEqual(verifiedEmbeddedWingdings2({ name: 'CIDFont+F5', data: new Uint8Array(framed.buffer, framed.byteOffset + 3, data.length) }), identity);
  for (const platform of [1, 3]) assert.equal(verifiedEmbeddedWingdings2({ name: 'CIDFont+F99', data: namedSfnt(embeddedNames().filter(row => row.platform === platform)) }).name, 'Wingdings2');
  for (const change of [{ name: 'Arial' }, { data: undefined }, { missingFile: true }, { isType3Font: true }, { isInvalidPDFjsFont: true }]) {
    assert.equal(verifiedEmbeddedWingdings2({ name: 'CIDFont+F5', data, ...change }), null);
  }
  for (const records of [
    embeddedNames().filter(row => row.nameId !== 6), [{ platform: 1, encoding: 0, language: 0, nameId: 0, value: 'Copyright Wingdings2' }],
    [...embeddedNames(), { platform: 3, encoding: 1, language: 1033, nameId: 6, value: 'UnrelatedFont' }],
    embeddedNames().map(row => row.nameId === 6 ? { ...row, value: 'Wingdings2-Fake' } : row),
    embeddedNames().map(row => row.nameId === 1 ? { ...row, value: 'Wingdings' } : row),
    embeddedNames().map(row => row.nameId === 4 ? { ...row, value: 'Wingdings 2\0' } : row),
    embeddedNames().map(row => row.platform === 3 ? { ...row, encoding: 2 } : row),
    embeddedNames().map(row => row.platform === 3 && row.nameId === 6 ? { ...row, bytes: Buffer.from([0, 87, 0]) } : row)
  ]) assert.equal(verifiedEmbeddedWingdings2({ name: 'CIDFont+F5', data: namedSfnt(records) }), null);
});

test('reviewed real anonymous CID checkboxes use embedded identity and retain complete native report text', async () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/company-native-embedded-checkboxes.pdf'));
  const source = require('./fixtures/company-native-embedded-checkboxes.source.json');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  let calls = 0; const parser = new CompanyDocumentParser({ recognize: () => { calls++; throw Error('verified embedded checkbox font must not use OCR'); } });
  try {
    const result = await parser.parse(bytes); assert.equal(result.complete, true, result.issues.join(';')); assert.equal(calls, 0);
    assert.equal(result.numericEligible, true); assert.deepEqual(result.pageTexts.map(row => row.verifiedCheckboxes.length), [6, 1]);
    for (const row of result.pageTexts) {
      assert.equal(row.method, 'pdf-text'); assert.ok(row.rawText.includes('\uF052')); assert.ok(!row.text.includes('\uF052'));
      for (const proof of row.verifiedCheckboxes) {
        assert.equal(proof.fontIdentity.originalFontName, 'CIDFont+F5'); assert.equal(proof.fontIdentity.basis, 'pdfjs-embedded-sfnt-name-table');
        assert.ok(proof.fontIdentity.records.some(record => record.nameId === 6 && record.value === 'Wingdings2'));
        assert.equal(row.rawText[proof.sourceOffset], proof.original); assert.match(proof.fontIdentity.decodedFontSha256, /^[a-f0-9]{64}$/);
      }
    }
  } finally { await parser.destroy(); }
});

test('embedded font parsing rejects malformed SFNT/name offsets, overlapping directories and truncated strings without throwing', () => {
  for (const corrupt of [
    bytes => bytes.subarray(0, 11), bytes => { bytes.writeUInt16BE(129, 4); return bytes; },
    bytes => { bytes.writeUInt32BE(12, 20); return bytes; }, bytes => { bytes.writeUInt32BE(29, 20); return bytes; },
    bytes => { bytes.writeUInt32BE(0xFFFFFFFC, 20); return bytes; }, bytes => { bytes.writeUInt32BE(65536, 24); return bytes; },
    bytes => { bytes.writeUInt16BE(1, 28); return bytes; }, bytes => { bytes.writeUInt16BE(257, 30); return bytes; },
    bytes => { bytes.writeUInt16BE(6, 32); return bytes; }, bytes => { bytes.writeUInt16BE(65535, 32); return bytes; },
    bytes => { bytes.writeUInt16BE(65535, 44); return bytes; }, bytes => bytes.subarray(0, bytes.length - 1),
    () => namedSfnt(embeddedNames(), { duplicateTable: true }), () => Buffer.alloc(16 * 1024 * 1024 + 1)
  ]) assert.equal(verifiedEmbeddedWingdings2({ name: 'CIDFont+F5', data: corrupt(namedSfnt()) }), null);
});

test('embedded font evidence preserves original glyph offsets and does not extend exclusive-choice syntax', () => {
  const identity = verifiedEmbeddedWingdings2({ name: 'CIDFont+F5', data: namedSfnt() });
  const map = text => verifiedPdfText([{ str: text, fontName: 'f1', hasEOL: true }], { f1: identity.name }, { f1: identity.proof });
  const input = '原文😀\n□ 适用 \uF052 不适用', mapped = map(input), proof = mapped.verifiedCheckboxes[0];
  assert.equal(proof.sourceOffset, input.indexOf('\uF052')); assert.equal(mapped.rawText[proof.sourceOffset], '\uF052');
  assert.equal(mapped.text[proof.sourceOffset], '☑'); assert.deepEqual(proof.fontIdentity, identity.proof);
  assert.ok(mapped.rawText.includes('\uF052')); assert.match(mapped.rawTextHash, /^[a-f0-9]{64}$/);
  for (const text of ['\uF052 单独字形', '\uF052 适用 \uF052 不适用', '□ 适用\n\uF052 不适用', '□ 适用 \uE123 不适用']) {
    assert.equal(map(text).verifiedCheckboxes.length, 0); assert.ok(map(text).text.includes(text));
  }
  const split = verifiedPdfText([{ str: '□ 适用 ', fontName: 'f1' }, { str: '\uF052', fontName: 'unknown' }, { str: ' 不适用', fontName: 'f1' }],
    { f1: identity.name }, { f1: identity.proof });
  assert.equal(split.verifiedCheckboxes.length, 0, 'an adjacent verified font cannot lend its identity to an unverified glyph');
});

test('Western Mining decorative-page audit applies only to its exact source, 194 pages and two registered covers', () => {
  const sourceHash = '7d630ca29015d851bdb8181b4ce14c6f66517b171af8f57fbe51a080aa63e390';
  const audit = require('../core/company-document-page-audits.json').find(value => value.sourceSha256 === sourceHash);
  assert.ok(audit); assert.equal(audit.pages, 194); assert.deepEqual(audit.pageNumbers, [1, 194]);
  const proof = (page, document = { sourceHash, pages: 194 }) => ({ page, text: '', method: 'page-audit', complete: true, numericEligible: false, contentRole: 'non-content',
    classification: { kind: 'decorative-cover', verified: true, basis: 'exact-source-page-audit', ...document, page, auditId: audit.id } });
  const document = { sourceHash, pages: 194 };
  for (const page of [1, 194]) assert.equal(isVerifiedNonContentPage(proof(page), document), true);
  for (const page of [2, 193]) assert.equal(isVerifiedNonContentPage(proof(page), document), false);
  for (const changed of [{ ...document, sourceHash: '0'.repeat(64) }, { ...document, pages: 193 }]) assert.equal(isVerifiedNonContentPage(proof(1, changed), changed), false);
});

test('checkbox conversion needs the reviewed font, exact same-line choice pair and one checked choice', () => {
  const map = (text, font = 'ABCDEF+Wingdings2') => verifiedPdfText([{ str: text, fontName: 'f1', hasEOL: true }], { f1: font });
  assert.equal(map('  □ 是 \uF052 否').verifiedCheckboxes.length, 1);
  for (const text of ['\uF052 单独字形', '\uF052 适用 \uF052 不适用', '□ 适用 \uF052 适用', '□ 适用\n\uF052 不适用', '□ 适用 \uE123 不适用']) {
    const result = map(text); assert.equal(result.verifiedCheckboxes.length, 0); assert.ok(result.text.includes(text));
  }
  assert.equal(map('□ 适用 \uF052 不适用', 'Wingdings').verifiedCheckboxes.length, 0);
  assert.equal(map('□ 适用 \uF052 不适用', '').verifiedCheckboxes.length, 0);
  assert.equal(map('☑ 适用 \uF0A3 不适用').text.trim(), '☑ 适用 □ 不适用');
  assert.equal(map('\uF052 适用 \uF0A3 不适用').verifiedCheckboxes.length, 2);
  assert.equal(map('\uF0B7 债务人未能支付本金', 'ABCDEF+SymbolMT').verifiedGlyphs.length, 1);
  assert.equal(map('文字 \uF0B7 债务人未能支付本金', 'ABCDEF+SymbolMT').verifiedGlyphs.length, 0);
  assert.equal(map('\uF0B7 债务人未能支付本金', 'UnverifiedSymbol').verifiedGlyphs.length, 0);
});

test('decorative-page proof is valid only for the registered source, page count and page number', () => {
  const audit = require('../core/company-document-page-audits.json')[0];
  const document = { sourceHash: audit.sourceSha256, pages: audit.pages };
  const page = { page: 1, text: '', method: 'page-audit', complete: true, numericEligible: false, contentRole: 'non-content',
    classification: { kind: 'decorative-cover', verified: true, basis: 'exact-source-page-audit', sourceHash: audit.sourceSha256,
      pages: audit.pages, page: 1, auditId: audit.id } };
  assert.equal(isVerifiedNonContentPage(page, document), true);
  const differentHash = require('node:crypto').createHash('sha256').update(Buffer.from([1])).digest('hex');
  assert.equal(isVerifiedNonContentPage({ ...page, classification: { ...page.classification, sourceHash: differentHash } }, { ...document, sourceHash: differentHash }), false);
  assert.equal(isVerifiedNonContentPage({ ...page, classification: { ...page.classification, pages: 143 } }, { ...document, pages: 143 }), false);
  assert.equal(isVerifiedNonContentPage({ ...page, page: 2, classification: { ...page.classification, page: 2 } }, document), false);
  assert.equal(isVerifiedNonContentPage({ ...page, classification: { ...page.classification, auditId: 'unreviewed' } }, document), false);
  assert.equal(isVerifiedNonContentPage({ ...page, numericEligible: true }, document), false);
});

test('an actually empty PDF page is retained with explicit non-content proof, while a scanned image is not exempt', async () => {
  const empty = pdf(['']).toString().replace('BT /F1 14 Tf 20 150 Td () Tj ET', ' '.repeat('BT /F1 14 Tf 20 150 Td () Tj ET'.length));
  let calls = 0; const parser = new CompanyDocumentParser({ recognize: () => { calls++; return { data: { text: '', confidence: 0 } }; } });
  try {
    const blank = await parser.parse(Buffer.from(empty));
    assert.equal(blank.complete, true); assert.equal(blank.pages, 1); assert.equal(blank.pageTexts.length, 1); assert.equal(calls, 0);
    assert.equal(isVerifiedNonContentPage(blank.pageTexts[0], blank), true); assert.equal(blank.pageTexts[0].numericEligible, false);
    for (const annotationCount of [undefined, 1]) {
      assert.equal(isVerifiedNonContentPage({ ...blank.pageTexts[0], classification: { ...blank.pageTexts[0].classification, annotationCount } }, blank), false);
    }
    const scanned = await parser.parse(await scannedPdf(image('Company annual report 2025')));
    assert.equal(scanned.complete, false); assert.equal(scanned.pageTexts[0].contentRole, undefined); assert.equal(calls, 1);
  } finally { await parser.destroy(); }
});

test('waiting for another document does not consume this document execution timeout', async () => {
  let started, release, calls = 0; const began = new Promise(resolve => { started = resolve; });
  const parser = new CompanyDocumentParser({ recognize: () => { if (++calls === 1) { started(); return new Promise(resolve => { release = () => resolve(accepted()); }); } return accepted(); } });
  try {
    const first = parser.parse(image()); await began;
    const progress = [], second = parser.parse(image(), { parseTimeoutMs: 500, onProgress: entry => progress.push(entry) });
    await new Promise(resolve => setTimeout(resolve, 600)); release(); await first;
    const result = await second; assert.equal(result.complete, true); assert.ok(result.timings.queuedMs >= 500);
    assert.ok(result.timings.parseMs < 500); assert.ok(progress.some(entry => entry.stage === 'parser-queue' && entry.status === 'started' && entry.queuedMs >= 500));
  } finally { await parser.destroy(); }
});

test('execution timeout reports timing diagnostics and releases the document queue', async () => {
  let calls = 0; const parser = new CompanyDocumentParser({ recognize: () => ++calls === 1 ? new Promise(() => {}) : accepted() });
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(parser.parse(image(), { parseTimeoutMs: 30 }), error => error.code === 'parse-timeout' && error.timings.parseMs >= 20 && error.timings.queuedMs >= 0 && error.timings.ocrMs > 0);
    assert.equal((await parser.parse(image())).complete, true);
  } finally { clearInterval(keepAlive); await parser.destroy(); }
});

test('mixed native and scanned PDF pages only OCR the page lacking a usable text layer', async () => {
  const called = [], progress = [];
  const parser = new CompanyDocumentParser({ recognize: (bytes, metadata) => { called.push(metadata.page); assert.equal(bytes.subarray(1, 4).toString(), 'PNG'); return accepted(); } });
  try {
    const result = await parser.parse(pdf(['Native text contains the issuer report identity.', '']), { onProgress: entry => progress.push(entry) });
    assert.deepEqual(called, [2]); assert.equal(result.complete, true); assert.equal(result.numericEligible, false); assert.equal(result.hasOcrPages, true);
    assert.deepEqual(result.pageTexts.map(page => page.method), ['pdf-text', 'ocr']); assert.equal(result.pageTexts[1].confidence, 96);
    assert.match(result.pageTexts[1].issues.join(';'), /text-layer-replaced/); assert.equal(progress.filter(item => item.stage === 'parsed').length, 2);
  } finally { await parser.destroy(); }
});

test('native page furniture above scanned audit text cannot be accepted as a complete numeric page', async () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/company-mixed-audit-pages.pdf'));
  const provenance = require('./fixtures/company-mixed-audit-pages.source.json');
  assert.equal(createHash('sha256').update(fixture).digest('hex'), provenance.fixtureSha256);
  const calls = [], parser = new CompanyDocumentParser({ recognize: (_bytes, metadata) => { calls.push(metadata.page); return accepted(); } });
  try {
    const result = await parser.parse(fixture);
    assert.deepEqual(calls, [2, 3]); assert.equal(result.complete, true); assert.equal(result.numericEligible, false);
    assert.deepEqual(result.pageTexts.map(row => row.method), ['pdf-text', 'ocr', 'ocr', 'pdf-text']);
    assert.match(result.pageTexts[1].issues.join(';'), /pdf-scanned-body/);
    assert.match(result.pageTexts[2].issues.join(';'), /pdf-scanned-body/);
    assert.ok(result.pageTexts.filter(row => row.method === 'ocr').every(row => row.numericEligible === false));
  } finally { await parser.destroy(); }
});

test('a searchable header cannot hide failed OCR of the dominant raster body', async () => {
  const bytes = await scannedPdf(image(), { header: 'Company annual report 2025 - audit section', transform: [650, 0, 0, 270, 120, 30] });
  let calls = 0; const parser = new CompanyDocumentParser({ recognize: () => { calls++; return { data: { text: 'An incomplete scanned audit opinion remains pending.', confidence: 40 } }; } });
  try {
    const result = await parser.parse(bytes);
    assert.equal(calls, 1); assert.equal(result.complete, false); assert.equal(result.numericEligible, false);
    assert.match(result.issues.join(';'), /pdf-scanned-body/); assert.match(result.issues.join(';'), /ocr-confidence-low/);
  } finally { await parser.destroy(); }
});

test('small logos, modest charts and substantive native body text retain the native path', async () => {
  const header = 'Company annual report 2025 - business review';
  const parser = new CompanyDocumentParser({ recognize: () => { throw Error('native page must not need OCR for this image'); } });
  try {
    for (const options of [{ header, transform: [100, 0, 0, 40, 740, 300] }, { header, transform: [400, 0, 0, 180, 250, 80] },
      { header, transform: [650, 0, 0, 270, 120, 30], body: Array.from({ length: 7 }, (_, i) => `Native body row ${i + 1}: the issuer reported complete business operating information for the period.`) }]) {
      const result = await parser.parse(await scannedPdf(image(), options));
      assert.equal(result.complete, true); assert.equal(result.numericEligible, true); assert.equal(result.pageTexts[0].method, 'pdf-text');
    }
  } finally { await parser.destroy(); }
});

test('mixed scanned body uses the same image area check when the placement is rotated', async () => {
  let calls = 0; const parser = new CompanyDocumentParser({ recognize: () => { calls++; return accepted(); } });
  try {
    const result = await parser.parse(await scannedPdf(image(), { header: 'Searchable header above rotated scanned report', transform: [0, 270, -650, 0, 770, 30] }));
    assert.equal(calls, 1); assert.equal(result.complete, true); assert.equal(result.numericEligible, false);
    assert.match(result.issues.join(';'), /pdf-scanned-body/);
  } finally { await parser.destroy(); }
});

test('dense native paragraphs elsewhere on the page cannot hide a separate scanned body region', async () => {
  const bytes = await scannedPdf(image(), { header: 'Native annual report header', transform: [650, 0, 0, 180, 120, 0],
    body: Array.from({ length: 7 }, (_, i) => `Native body row ${i + 1}: fully searchable paragraphs must not conceal the separate scanned audit opinion below.`) });
  let calls = 0; const parser = new CompanyDocumentParser({ recognize: () => { calls++; return accepted(); } });
  try {
    const result = await parser.parse(bytes);
    assert.equal(calls, 1); assert.equal(result.complete, true); assert.equal(result.numericEligible, false);
    assert.match(result.issues.join(';'), /pdf-scanned-body/);
  } finally { await parser.destroy(); }
});

test('adjacent scan tiles are checked as one body while isolated or duplicate small pictures do not accumulate', async () => {
  let calls = 0; const parser = new CompanyDocumentParser({ recognize: () => { calls++; return accepted(); } });
  const header = 'Native annual report header above raster pictures';
  try {
    const tiled = await parser.parse(await scannedPdf(image(), { header, transforms: [[650, 0, 0, 140, 120, 20], [650, 0, 0, 140, 120, 165]] }));
    assert.equal(calls, 1); assert.equal(tiled.complete, true); assert.equal(tiled.numericEligible, false);
    assert.match(tiled.issues.join(';'), /pdf-scanned-body/);
    for (const transforms of [[[350, 0, 0, 180, 20, 80], [350, 0, 0, 180, 530, 80]],
      [[650, 0, 0, 140, 120, 20], [650, 0, 0, 140, 120, 20]]]) {
      const result = await parser.parse(await scannedPdf(image(), { header, transforms }));
      assert.equal(result.complete, true); assert.equal(result.numericEligible, true); assert.equal(result.pageTexts[0].method, 'pdf-text');
    }
    assert.equal(calls, 1, 'separated charts and duplicate overlays must not be counted as a whole scanned page');
  } finally { await parser.destroy(); }
});

test('garbled PDF text triggers OCR instead of being accepted as a complete page', async () => {
  let called = 0;
  const parser = new CompanyDocumentParser({ recognize: () => { called++; return accepted(); } });
  try {
    const result = await parser.parse(pdf(['????????????????????????????????????????']));
    assert.equal(called, 1); assert.equal(result.complete, true); assert.equal(result.pageTexts[0].method, 'ocr');
  } finally { await parser.destroy(); }
});

test('contents-page dot leaders are legitimate native text and do not trigger OCR', async () => {
  let called = false;
  const parser = new CompanyDocumentParser({ recognize: () => { called = true; return accepted(); } });
  try {
    const result = await parser.parse(pdf(['Company annual report contents...................................................123.........................................................']));
    assert.equal(result.complete, true); assert.equal(result.pageTexts[0].method, 'pdf-text'); assert.equal(called, false);
  } finally { await parser.destroy(); }
});

for (const [name, data] of [
  ['low confidence', { text: '本段文字长度足够，但识别置信度不满足自动取证要求。', confidence: 42 }],
  ['empty page', { text: '', confidence: 99 }],
  ['missing confidence', { text: '本段文字长度足够，但来源没有返回识别置信度。' }],
  ['garbled recognition', { text: '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD公司财务报告产品商业化完成公开披露测试', confidence: 96 }]
]) test(`${name} cannot become complete evidence`, async () => {
  const parser = new CompanyDocumentParser({ recognize: () => ({ data }) });
  try {
    const result = await parser.parse(image());
    assert.equal(result.complete, false); assert.equal(result.numericEligible, false); assert.equal(result.pages, 1); assert.ok(result.issues.length);
  } finally { await parser.destroy(); }
});

test('OCR tables retain raw text but are explicitly ineligible for automatic numeric use', async () => {
  const table = '项目 本期 上期\n营业收入 100 90 80\n净利润 20 15 10';
  const parser = new CompanyDocumentParser({ recognize: () => ({ data: { text: table, confidence: 97 } }) });
  try {
    const result = await parser.parse(image());
    assert.equal(result.text, table); assert.equal(result.pageTexts[0].tableLike, true); assert.equal(result.numericEligible, false);
    assert.match(result.issues.join(';'), /ocr-table-unverified/);
  } finally { await parser.destroy(); }
});

test('OCR failure identifies the affected page and leaves the document incomplete', async () => {
  const parser = new CompanyDocumentParser({ recognize: () => { throw Error('isolated engine failure'); } });
  try {
    const result = await parser.parse(pdf(['']));
    assert.equal(result.complete, false); assert.equal(result.pageTexts[0].text, ''); assert.match(result.issues.join(';'), /第 1 页.*isolated engine failure/);
  } finally { await parser.destroy(); }
});

test('missing local models fail locally without constructing an online OCR worker', async () => {
  const parser = new CompanyDocumentParser({ languagePath: require('node:path').join(__dirname, 'fixtures', 'absent-ocr-models') });
  try {
    const result = await parser.parse(image());
    assert.equal(result.complete, false); assert.match(result.issues.join(';'), /本地 OCR 中英文语言包缺失/);
  } finally { await parser.destroy(); }
});

test('page and character limits never publish truncated complete text', async () => {
  let calls = 0; const parser = new CompanyDocumentParser({ recognize: () => { calls++; return accepted(); } });
  try {
    const tooMany = await parser.parse(pdf(['Native first page content.', 'Native second page content.']), { maxPages: 1 });
    assert.equal(tooMany.complete, false); assert.equal(tooMany.pages, 2); assert.equal(tooMany.text, '');
    const tooLong = await parser.parse(pdf(['Native complete text is longer than the allowed character budget.']), { maxChars: 15 });
    assert.equal(tooLong.complete, false); assert.equal(tooLong.text, ''); assert.equal(calls, 0);
  } finally { await parser.destroy(); }
});

test('image and PDF pixel limits stop rendering before OCR', async () => {
  let called = false; const parser = new CompanyDocumentParser({ maxPixels: 100, recognize: () => { called = true; return accepted(); } });
  try {
    for (const bytes of [image(), pdf([''])]) { const result = await parser.parse(bytes); assert.equal(result.complete, false); assert.match(result.issues.join(';'), /pixel-limit/); }
    assert.equal(called, false);
  } finally { await parser.destroy(); }
});

test('oversized PNG dimensions are rejected before attempting native image decoding', async () => {
  const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(100000, 16); bytes.writeUInt32BE(100000, 20);
  const parser = new CompanyDocumentParser({ recognize: () => { throw Error('must not recognize'); } });
  try { const result = await parser.parse(bytes); assert.equal(result.complete, false); assert.match(result.issues.join(';'), /图片声明像素/); }
  finally { await parser.destroy(); }
});

test('actual document signature must match the declared format', async () => {
  const parser = new CompanyDocumentParser({ recognize: accepted });
  try {
    await assert.rejects(parser.parse(Buffer.from('not a pdf'), { format: 'pdf' }), /不支持/);
    await assert.rejects(parser.parse(image(), { format: 'pdf' }), /实际内容不一致/);
  } finally { await parser.destroy(); }
});

test('simultaneous documents serialize OCR while preserving per-document results', async () => {
  let active = 0, maximum = 0;
  const parser = new CompanyDocumentParser({ recognize: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return accepted(); } });
  try {
    const results = await Promise.all([parser.parse(image()), parser.parse(image()), parser.parse(image())]);
    assert.equal(maximum, 1); assert.ok(results.every(result => result.complete));
  } finally { await parser.destroy(); }
});

test('abort during OCR rejects promptly and does not return partial evidence', async () => {
  const controller = new AbortController(); let started;
  const begun = new Promise(resolve => { started = resolve; });
  const parser = new CompanyDocumentParser({ recognize: () => { started(); return new Promise(() => {}); } });
  try {
    const operation = parser.parse(image(), { signal: controller.signal }); await begun; controller.abort();
    await assert.rejects(operation, error => error.name === 'AbortError');
  } finally { await parser.destroy(); }
});

test('a queued cancelled document cannot run OCR later', async () => {
  let release, started; let calls = 0;
  const begun = new Promise(resolve => { started = resolve; });
  const parser = new CompanyDocumentParser({ recognize: () => { calls++; started(); return new Promise(resolve => { release = () => resolve(accepted()); }); } });
  try {
    const first = parser.parse(image()); await begun;
    const controller = new AbortController(), second = parser.parse(image(), { signal: controller.signal }); controller.abort();
    await assert.rejects(second, error => error.name === 'AbortError'); release(); await first; assert.equal(calls, 1);
  } finally { await parser.destroy(); }
});

test('per-page OCR timeout leaves a pending-quality page and releases the queue', async () => {
  const parser = new CompanyDocumentParser({ ocrTimeoutMs: 15, recognize: () => new Promise(() => {}) });
  const keepAlive = setInterval(() => {}, 100);
  try { const result = await parser.parse(image()); assert.equal(result.complete, false); assert.match(result.issues.join(';'), /OCR 单页识别超时/); }
  finally { clearInterval(keepAlive); await parser.destroy(); }
});

test('real local Chinese/English OCR reads image attachments and rendered scanned PDF pages', { timeout: 60000 }, async () => {
  const png = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'company-ocr-page.png'));
  const parser = new CompanyDocumentParser();
  try {
    for (const [format, input] of [['png', png], ['pdf', await scannedPdf(png)]]) {
      const result = await parser.parse(input, { format });
      assert.equal(result.complete, true, result.issues.join(';')); assert.equal(result.hasOcrPages, true); assert.equal(result.numericEligible, false);
      assert.equal(result.pageTexts[0].method, 'ocr'); assert.ok(result.pageTexts[0].confidence >= 85);
      assert.match(result.text.replace(/\s/g, ''), /本地识别测试报告/); assert.match(result.text, /Company annual report/i);
    }
  } finally { await parser.destroy(); }
});

for (const [mode, reason] of [['throw', /isolated bootstrap failure/], ['exit', /工作线程已退出/], ['reject', /isolated language rejection/]]) {
  test(`real worker ${mode} rejects the pending initialization without an uncaught main-process error`, { timeout: 5000 }, async () => {
    const worker = new LocalOcrWorker({ workerPath: require('node:path').join(__dirname, 'fixtures', 'company-ocr-worker-failure.cjs') });
    try { await assert.rejects(worker.job('load', { mode }), reason); }
    finally { await worker.terminate(); }
    assert.equal(worker.thread.threadId, -1);
  });
}

function hangingParser(options = {}, onStarted = () => {}) {
  const parser = new CompanyDocumentParser(options);
  parser.getWorker = function () {
    const handle = this.workerHandle = new LocalOcrWorker({
      workerPath: require('node:path').join(__dirname, 'fixtures', 'company-ocr-worker-failure.cjs'),
      onProgress: onStarted
    });
    this.testThread = handle.thread;
    return this.worker = handle.job('load', { mode: 'hang' }).then(() => handle);
  };
  return parser;
}

test('cancelling hung worker initialization terminates its real thread promptly', { timeout: 5000 }, async () => {
  let started; const began = new Promise(resolve => { started = resolve; });
  const parser = hangingParser({}, started), controller = new AbortController();
  try {
    const operation = parser.parse(image(), { signal: controller.signal }); await began; controller.abort();
    await assert.rejects(operation, error => error.name === 'AbortError');
  } finally { await parser.destroy(); }
  assert.equal(parser.testThread.threadId, -1); assert.equal(parser.worker, null); assert.equal(parser.workerHandle, null);
});

test('hung worker initialization times out as incomplete evidence and releases the real thread', { timeout: 5000 }, async () => {
  const parser = hangingParser({ ocrTimeoutMs: 50 });
  try {
    const result = await parser.parse(image());
    assert.equal(result.complete, false); assert.match(result.issues.join(';'), /OCR 单页识别超时/);
  } finally { await parser.destroy(); }
  assert.equal(parser.testThread.threadId, -1); assert.equal(parser.worker, null); assert.equal(parser.workerHandle, null);
});

test('corrupt local models fail without crashing and can retry after a corrected model path', { timeout: 60000 }, async () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const parent = path.resolve(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'company-ocr-invalid-model-'));
  const parser = new CompanyDocumentParser({ languagePath: directory, ocrTimeoutMs: 10000 });
  try {
    for (const language of ['chi_sim', 'eng']) fs.writeFileSync(path.join(directory, `${language}.traineddata`), Buffer.alloc(32));
    const input = fs.readFileSync(path.join(__dirname, 'fixtures', 'company-ocr-page.png'));
    const rejected = await parser.parse(input);
    assert.equal(rejected.complete, false); assert.match(rejected.issues.join(';'), /ocr-failed/);
    assert.equal(parser.worker, null); assert.equal(parser.workerHandle, null);
    parser.languagePath = path.resolve(__dirname, '..', 'assets', 'ocr');
    const retried = await parser.parse(input);
    assert.equal(retried.complete, true, retried.issues.join(';'));
    assert.match(retried.text.replace(/\s/g, ''), /本地识别测试报告/);
  } finally {
    await parser.destroy();
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.ok(path.basename(directory).startsWith('company-ocr-invalid-model-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
