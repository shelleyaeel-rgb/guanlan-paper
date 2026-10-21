const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const PARSER_VERSION = '4';
const FILE_CHUNK_BYTES = 1024 * 1024;
const FILE_HARD_LIMIT = 512 * 1024 * 1024;
const RANGE_HARD_LIMIT = 16 * 1024 * 1024;
const PAGE_AUDITS = require('./company-document-page-audits.json');
const hash = text => createHash('sha256').update(text).digest('hex');
const unpacked = filename => filename.replace(/\.asar([\\/])/g, '.asar.unpacked$1');
// PDF.js constructs native Path2D values using its own canvas dependency.
// Its context must come from that same package instance/version.
const pdfRequire = createRequire(require.resolve('pdfjs-dist/package.json'));
const normalize = text => String(text || '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[\t \u3000]+/g, ' ').trim();
function abortError() { const error = Error('文档解析已取消'); error.name = 'AbortError'; return error; }
function active(signal) { if (signal?.aborted) throw abortError(); }
function cancellable(promise, signal, cancel) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => { try { cancel?.(); } catch {} reject(abortError()); };
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function positive(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw Error(`${name}必须是正整数`);
  return result;
}
async function measured(timings, key, operation) {
  const startedAt = performance.now();
  try { return await operation(); }
  finally { timings[key] += Math.round(performance.now() - startedAt); }
}
function isFileInput(input) { return input && typeof input === 'object' && typeof input.filePath === 'string'; }
function fileError(message, code = 'invalid-document') { return Object.assign(Error(message), { code }); }
async function openVerifiedPdfFile(input, limit, signal) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FILE_HARD_LIMIT) throw Error('文件范围解析字节上限无效');
  if (!path.isAbsolute(input.filePath) || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || !/^[a-f0-9]{64}$/.test(input.sha256)) throw fileError('文件路径、大小或 SHA-256 身份无效');
  if (input.bytes > limit) throw Object.assign(fileError('文档大小超过文件范围解析上限', 'size-limit'), { limitBytes: limit, actualBytes: input.bytes });
  active(signal);
  const named = await fs.promises.lstat(input.filePath); active(signal);
  if (!named.isFile() || named.isSymbolicLink()) throw fileError('原始文档必须是普通文件，不能为符号链接');
  const handle = await fs.promises.open(input.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat(); active(signal);
    if (!stat.isFile() || stat.dev !== named.dev || stat.ino !== named.ino || stat.size !== input.bytes) throw fileError('原始文档文件身份或大小已变化');
    const unchanged = async () => {
      active(signal); const current = await handle.stat(); active(signal);
      if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw fileError('解析期间原始文档内容已变化');
    };
    const read = async (target, start, length, position, readingSignal = signal) => {
      let received = 0;
      while (received < length) {
        active(readingSignal);
        const value = await handle.read(target, start + received, Math.min(FILE_CHUNK_BYTES, length - received), position + received);
        active(readingSignal);
        if (!value.bytesRead) throw fileError('原始文档读取不完整');
        received += value.bytesRead;
      }
    };
    const chunk = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, stat.size)), hasher = createHash('sha256'); let prefix;
    for (let position = 0; position < stat.size; position += chunk.length) {
      const length = Math.min(chunk.length, stat.size - position);
      await read(chunk, 0, length, position); hasher.update(chunk.subarray(0, length));
      if (!prefix) prefix = Buffer.from(chunk.subarray(0, Math.min(16, length)));
    }
    await unchanged();
    if (hasher.digest('hex') !== input.sha256) throw fileError('原始文档 SHA-256 与缓存身份不符');
    return { length: stat.size, prefix, sourceHash: input.sha256, unchanged,
      async readRange(begin, end, readingSignal) {
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > stat.size || end - begin > RANGE_HARD_LIMIT) {
          throw fileError('PDF 文件范围请求超过 16 MiB 上限或范围无效', 'document-range-limit');
        }
        active(readingSignal); await unchanged();
        // PDF.js expects exactly one complete block for each requested range.
        // Coalesced requests have a separate hard cap; physical reads stay 1 MiB.
        const bytes = new Uint8Array(end - begin);
        await read(bytes, 0, bytes.length, begin, readingSignal); await unchanged();
        return bytes;
      }, close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}
function textQuality(input, minimum) {
  const text = normalize(input), assessment = text.replace(/[.．·…_-]{3,}/g, ''), chars = [...assessment.replace(/\s/g, '')];
  const useful = chars.filter(character => /[\p{L}\p{N}]/u.test(character)).length;
  const invalid = chars.filter(character => /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\uE000-\uF8FF]/.test(character)).length;
  const repeated = assessment.match(/([\p{L}\p{N}])\1{9,}/gu)?.reduce((sum, item) => sum + item.length, 0) || 0;
  const issues = [];
  if (useful < minimum) issues.push('text-insufficient: 有效文字过少或页面为空');
  if (/[\uE000-\uF8FF]/.test(text) || invalid > Math.max(1, chars.length * 0.02) || (chars.length >= minimum && useful / chars.length < 0.35) || repeated > Math.max(20, chars.length * 0.4)) issues.push('text-garbled: 文字含乱码、异常字符或重复噪声');
  return { text, issues, usable: issues.length === 0 };
}
function formatOf(bytes, requested) {
  const magic = Buffer.from(bytes.subarray(0, 16));
  let actual = '';
  if (magic.subarray(0, 5).toString('ascii') === '%PDF-') actual = 'pdf';
  else if (magic.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) actual = 'png';
  else if (magic[0] === 255 && magic[1] === 216 && magic[2] === 255) actual = 'jpeg';
  else if (magic.subarray(0, 4).toString() === 'RIFF' && magic.subarray(8, 12).toString() === 'WEBP') actual = 'webp';
  else if (magic.subarray(0, 2).toString() === 'BM') actual = 'bmp';
  const declared = String(requested || '').toLowerCase().replace(/^application\//, '').replace(/^image\//, '').replace(/^\./, '').replace('jpg', 'jpeg');
  if (!actual) throw Error('不支持的文档格式：仅支持 PDF、PNG、JPEG、WebP、BMP');
  if (declared && !['image', 'pdf-text', 'pdf-ocr', 'application/octet-stream', 'octet-stream', actual].includes(declared)) throw Error('声明格式与文档实际内容不一致');
  return actual;
}
function imageSize(bytes, format) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === 'png' && data.length >= 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (format === 'bmp' && data.length >= 26) return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
  if (format === 'webp' && data.length >= 30 && data.subarray(12, 16).toString() === 'VP8X') return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  if (format === 'jpeg') {
    for (let offset = 2; offset + 8 < data.length;) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
      offset += length;
    }
  }
  return null;
}
function pdfText(items) {
  return items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
}
function sparseNativeBody(items, view) {
  const [left, bottom, right, top] = view, height = top - bottom;
  let characters = 0; const lines = new Set();
  for (const item of items) {
    if (!item.str || !Array.isArray(item.transform)) continue;
    const [a, b, c, d, x, y] = item.transform, advance = Math.hypot(a, b), ascent = Math.hypot(c, d);
    if (!advance || !ascent || !item.width || !item.height) continue;
    const dx = a / advance * item.width, dy = b / advance * item.width, hx = c / ascent * item.height, hy = d / ascent * item.height;
    const x0 = Math.min(x, x + dx, x + hx, x + dx + hx), x1 = Math.max(x, x + dx, x + hx, x + dx + hx);
    const centerY = y + (dy + hy) / 2;
    // A searchable header/footer is not evidence that the report body was
    // extracted. Count only text placed inside the printable body region.
    if (centerY < bottom + height * 0.12 || centerY > top - height * 0.12) continue;
    const overlap = Math.max(0, Math.min(right, x1) - Math.max(left, x0)) / Math.max(1, x1 - x0);
    characters += [...item.str].filter(character => /[\p{L}\p{N}]/u.test(character)).length * overlap;
    if (overlap > 0 && item.str.trim()) lines.add(Math.round((centerY - bottom) / Math.max(1, height / 60)));
  }
  return characters < 200 || lines.size < 6 || (Math.max(...lines) - Math.min(...lines)) / 60 < 0.45;
}
function scannedBodyImage(operators, items, view, OPS) {
  const [left, bottom, right, top] = view, pageArea = (right - left) * (top - bottom);
  const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  let matrix = [1, 0, 0, 1, 0, 0]; const stack = [], images = [];
  const large = transform => {
    const [a, b, c, d, e, f] = transform;
    const x0 = Math.max(left, Math.min(e, a + e, c + e, a + c + e)), x1 = Math.min(right, Math.max(e, a + e, c + e, a + c + e));
    const y0 = Math.max(bottom, Math.min(f, b + f, d + f, b + d + f)), y1 = Math.min(top, Math.max(f, b + f, d + f, b + d + f));
    // Use the determinant as well as clipped bounds so a skewed logo cannot
    // become a whole-page image merely because its bounding box is large.
    const area = Math.min(Math.abs(a * d - b * c), Math.max(0, x1 - x0) * Math.max(0, y1 - y0));
    if (area / pageArea >= 0.01) images.push({ bounds: [x0, y0, x1, y1], area });
    return images.length > 500 || area / pageArea >= 0.35
      && sparseNativeBody(items, [x0, y0, x1, y1]);
  };
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index], args = operators.argsArray[index] || [];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin || op === OPS.beginGroup) {
      stack.push(matrix);
      const transform = op === OPS.paintFormXObjectBegin ? args[0] : op === OPS.beginGroup ? args[0]?.matrix : null;
      if (transform) matrix = multiply(matrix, transform);
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd || op === OPS.endGroup) matrix = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (op === OPS.transform) matrix = multiply(matrix, args);
    else if ([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(op)) {
      if (large(matrix)) return true;
    } else if (op === OPS.paintInlineImageXObjectGroup || op === OPS.paintImageMaskXObjectGroup) {
      const images = op === OPS.paintInlineImageXObjectGroup ? args[1] : args[0];
      if (images?.some(entry => large(multiply(matrix, entry.transform)))) return true;
    } else if (op === OPS.paintImageXObjectRepeat || op === OPS.paintImageMaskXObjectRepeat) {
      const mask = op === OPS.paintImageMaskXObjectRepeat, positions = args[mask ? 5 : 3];
      for (let i = 0; i < positions?.length; i += 2) {
        if (large(multiply(matrix, mask ? [args[1], args[2], args[3], args[4], positions[i], positions[i + 1]]
          : [args[1], 0, 0, args[2], positions[i], positions[i + 1]]))) return true;
      }
    }
  }
  // Some report generators split one scanned sheet into adjacent image tiles.
  // Merge only substantially aligned neighbours with a small placement gap;
  // isolated logos/charts must not add up across unrelated parts of the page.
  const adjacent = (a, b) => {
    const x = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), y = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    return x >= Math.min(a[2] - a[0], b[2] - b[0]) * 0.5 && y >= -(top - bottom) * 0.03
      || y >= Math.min(a[3] - a[1], b[3] - b[1]) * 0.5 && x >= -(right - left) * 0.03;
  };
  const unionArea = rectangles => {
    const xs = [...new Set(rectangles.flatMap(rect => [rect[0], rect[2]]))].sort((a, b) => a - b); let area = 0;
    for (let i = 1; i < xs.length; i++) {
      const intervals = rectangles.filter(rect => rect[0] < xs[i] && rect[2] > xs[i - 1]).map(rect => [rect[1], rect[3]]).sort((a, b) => a[0] - b[0]);
      let length = 0, end = -Infinity;
      for (const [start, finish] of intervals) { length += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish); }
      area += (xs[i] - xs[i - 1]) * length;
    }
    return area;
  };
  const remaining = new Set(images);
  while (remaining.size) {
    const group = [remaining.values().next().value]; remaining.delete(group[0]);
    for (let index = 0; index < group.length; index++) {
      for (const image of remaining) if (adjacent(group[index].bounds, image.bounds)) { group.push(image); remaining.delete(image); }
    }
    if (group.length < 2 || group.reduce((sum, image) => sum + image.area, 0) / pageArea < 0.35) continue;
    const rectangles = group.map(image => image.bounds);
    if (unionArea(rectangles) / pageArea < 0.35) continue;
    const bounds = [Math.min(...rectangles.map(rect => rect[0])), Math.min(...rectangles.map(rect => rect[1])),
      Math.max(...rectangles.map(rect => rect[2])), Math.max(...rectangles.map(rect => rect[3]))];
    if (sparseNativeBody(items, bounds)) return true;
  }
  return false;
}
function verifiedEmbeddedWingdings2(font) {
  // Reviewed Focus Media uses an anonymous PDF CID name but embeds Wingdings
  // 2. The alias itself proves nothing; only bounded, consistent SFNT names
  // from the actual embedded bytes may supply the missing font identity.
  if (!/^CIDFont\+F\d+$/.test(font?.name || '') || font.missingFile || font.isType3Font || font.isInvalidPDFjsFont
    || !(font.data instanceof Uint8Array) || font.data.byteLength < 12 || font.data.byteLength > 16 * 1024 * 1024) return null;
  const bytes = Buffer.from(font.data.buffer, font.data.byteOffset, font.data.byteLength);
  if (bytes.readUInt32BE(0) !== 0x00010000) return null;
  const tables = bytes.readUInt16BE(4), directoryEnd = 12 + tables * 16;
  if (!tables || tables > 128 || directoryEnd > bytes.length) return null;
  let nameTable;
  for (let index = 0; index < tables; index++) {
    const row = 12 + index * 16, offset = bytes.readUInt32BE(row + 8), length = bytes.readUInt32BE(row + 12);
    if (offset < directoryEnd || offset % 4 || offset + length > bytes.length) return null;
    if (bytes.toString('ascii', row, row + 4) !== 'name') continue;
    if (nameTable || length < 6 || length > 65535) return null;
    nameTable = bytes.subarray(offset, offset + length);
  }
  if (!nameTable || nameTable.readUInt16BE(0) !== 0) return null;
  const count = nameTable.readUInt16BE(2), strings = nameTable.readUInt16BE(4);
  if (!count || count > 256 || 6 + count * 12 > nameTable.length || strings < 6 + count * 12 || strings > nameTable.length) return null;
  const records = [], expected = { 1: 'Wingdings 2', 4: 'Wingdings 2', 6: 'Wingdings2' };
  for (let index = 0; index < count; index++) {
    const row = 6 + index * 12, platform = nameTable.readUInt16BE(row), encoding = nameTable.readUInt16BE(row + 2), language = nameTable.readUInt16BE(row + 4);
    const nameId = nameTable.readUInt16BE(row + 6), length = nameTable.readUInt16BE(row + 8), offset = strings + nameTable.readUInt16BE(row + 10);
    if (offset + length > nameTable.length) return null;
    if (!Object.hasOwn(expected, nameId)) continue;
    if (!length || length > 128) return null;
    let value = '';
    if (platform === 1 && encoding === 0) value = nameTable.toString('latin1', offset, offset + length);
    else if (platform === 3 && [0, 1, 10].includes(encoding) && length % 2 === 0) {
      for (let position = offset; position < offset + length; position += 2) value += String.fromCharCode(nameTable.readUInt16BE(position));
    } else return null;
    // Do not trim, Unicode-normalize, match substrings, or choose one "good"
    // record among conflicting platform/language names.
    if (value !== expected[nameId]) return null;
    records.push({ platform, encoding, language, nameId, value });
  }
  if (![1, 4, 6].every(id => records.some(record => record.nameId === id))) return null;
  return { name: 'Wingdings2', proof: { basis: 'pdfjs-embedded-sfnt-name-table', originalFontName: font.name,
    decodedFontSha256: hash(bytes), nameTableSha256: hash(nameTable), records } };
}
// Wingdings 2's U+F052/F0A3 are checked/empty boxes in reviewed issuer PDFs. Font
// identity alone is insufficient: require the exact mutually exclusive choice
// pair as well. Unknown PUA glyphs remain unresolved, even in long paragraphs.
function verifiedPdfText(items, fontNames = {}, fontProofs = {}) {
  const rawText = items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join(''), verifiedCheckboxes = [], verifiedGlyphs = [], offsets = [];
  let cursor = 0;
  for (const item of items.filter(item => typeof item.str === 'string')) {
    offsets.push({ start: cursor, end: cursor + item.str.length, item });
    cursor += item.str.length + 1;
  }
  let text = rawText;
  const fontKeyAt = offset => offsets.find(entry => entry.start <= offset && offset < entry.end)?.item.fontName;
  const fontAt = offset => fontNames[fontKeyAt(offset)] || '';
  const proofAt = offset => fontProofs[fontKeyAt(offset)] ? { fontIdentity: fontProofs[fontKeyAt(offset)] } : {};
  const choice = /([□☐☑\uF052\uF0A3])[ \t]*(适用|不适用|是|否)[ \t]*([□☐☑\uF052\uF0A3])[ \t]*(适用|不适用|是|否)/g;
  for (const match of rawText.matchAll(choice)) {
    if (!['适用,不适用', '是,否'].includes(`${match[2]},${match[4]}`)
      || [match[1], match[3]].filter(glyph => ['☑', '\uF052'].includes(glyph)).length !== 1) continue;
    const glyphs = [...match[0].matchAll(/[\uF052\uF0A3]/g)].map(glyph => ({ sourceOffset: match.index + glyph.index, original: glyph[0] }));
    if (glyphs.some(glyph => fontAt(glyph.sourceOffset).replace(/^[A-Z]{6}\+/, '') !== 'Wingdings2')) continue;
    for (const glyph of glyphs) {
      const offset = glyph.sourceOffset, replacement = glyph.original === '\uF052' ? '☑' : '□';
      text = text.slice(0, offset) + replacement + text.slice(offset + 1);
      const proof = { ...glyph, replacement, font: fontAt(offset), ...proofAt(offset), context: match[0], rule: 'wingdings2-exclusive-choice-v1' };
      verifiedCheckboxes.push(proof); verifiedGlyphs.push(proof);
    }
  }
  // Reviewed Shenhuo p25 and NHU p175: an empty option can be printed as 口,
  // or an extra empty box can precede the checked box. Preserve those glyphs;
  // only decode the known Wingdings tick in a whole, unambiguous option line.
  const extraChoice = /^[ \t]*([□☐口])[ \t]*适用[ \t]*(?:([□☐])[ \t]*)?\uF052[ \t]*不适用[ \t]*$/gm;
  for (const match of rawText.matchAll(extraChoice)) {
    if (match[1] !== '口' && !match[2]) continue;
    const offset = match.index + match[0].indexOf('\uF052'), font = fontAt(offset);
    if (font.replace(/^[A-Z]{6}\+/, '') !== 'Wingdings2') continue;
    text = text.slice(0, offset) + '☑' + text.slice(offset + 1);
    const proof = { sourceOffset: offset, original: '\uF052', replacement: '☑', font, ...proofAt(offset), context: match[0], rule: 'wingdings2-exclusive-choice-extra-empty-v1' };
    verifiedCheckboxes.push(proof); verifiedGlyphs.push(proof);
  }
  // SymbolMT U+F0B7 is the visually verified bullet. Permit only a line-start
  // list marker followed by text; do not reinterpret mid-sentence symbols.
  for (const match of rawText.matchAll(/^[ \t]*\uF0B7[ \t]+(?=[\p{L}\p{N}])/gmu)) {
    const offset = match.index + match[0].indexOf('\uF0B7'), font = fontAt(offset);
    if (font.replace(/^[A-Z]{6}\+/, '') !== 'SymbolMT') continue;
    text = text.slice(0, offset) + '•' + text.slice(offset + 1);
    verifiedGlyphs.push({ sourceOffset: offset, original: '\uF0B7', replacement: '•', font, context: rawText.slice(match.index, rawText.indexOf('\n', offset) < 0 ? rawText.length : rawText.indexOf('\n', offset)), rule: 'symbolmt-line-bullet-v1' });
  }
  return { text, rawText, rawTextHash: hash(rawText), verifiedCheckboxes, verifiedGlyphs };
}
function auditedPageClassification(sourceHash, pages, page) {
  const audit = PAGE_AUDITS.find(entry => entry.sourceSha256 === sourceHash && entry.pages === pages && entry.pageNumbers.includes(page));
  return audit ? { kind: 'decorative-cover', verified: true, basis: 'exact-source-page-audit', sourceHash, pages, page,
    auditId: audit.id, reviewedAt: audit.reviewedAt, reviewMethod: audit.reviewMethod, description: audit.description } : null;
}
function nonContentPage(page, text, classification, method = 'pdf-text') {
  return { page, text, method, confidence: null, complete: true, numericEligible: false, tableLike: false,
    contentRole: 'non-content', classification, issues: [], characters: text.length, textHash: hash(text) };
}
function isVerifiedNonContentPage(page, document) {
  const proof = page?.classification;
  if (page?.contentRole !== 'non-content' || page.numericEligible !== false || page.complete !== true || proof?.verified !== true
    || proof.sourceHash !== document?.sourceHash || proof.pages !== document?.pages || proof.page !== page.page) return false;
  if (proof.kind === 'decorative-cover' && proof.basis === 'exact-source-page-audit') {
    return page.method === 'page-audit' && auditedPageClassification(document.sourceHash, document.pages, page.page)?.auditId === proof.auditId;
  }
  return proof.kind === 'blank' && proof.basis === 'empty-pdf-operator-list' && proof.operatorCount === 0
    && proof.nativeItemCount === 0 && proof.annotationCount === 0 && page.method === 'pdf-text' && page.text === '';
}
function nativeReauditEligible(page) {
  return page?.method === 'ocr' && page.complete === true && page.numericEligible === false
    && Array.isArray(page.issues) && page.issues.some(issue => /^text-layer-replaced: text-garbled:/.test(issue));
}
function checkpointPages(resume, sourceHash, pages, parser) {
  if (!resume) return [];
  const rows = resume.pageTexts;
  const sparse = resume.checkpointLayout === 'sparse-pages-v1';
  const valid = ['parse-timeout', 'parse-retry'].includes(resume.checkpoint) && resume.sourceHash === sourceHash && resume.parserVersion === PARSER_VERSION
    && resume.format === 'pdf' && resume.pages === pages && resume.complete === false && resume.numericEligible === false
    && Array.isArray(resume.issues) && Array.isArray(rows) && rows.length <= pages
    && (!resume.checkpointLayout || sparse) && (resume.checkpoint !== 'parse-retry' || Array.isArray(resume.missingPages))
    && resume.text === rows.map(row => row?.text).join('\n\n') && resume.hasOcrPages === rows.some(row => row?.method === 'ocr')
    && (!(sparse || resume.missingPages !== undefined) || Array.isArray(resume.missingPages) && JSON.stringify(resume.missingPages) === JSON.stringify(
      Array.from({ length: pages }, (_, index) => index + 1).filter(number => !rows.some(row => row?.page === number))))
    && rows.every((row, index) => row && (sparse ? Number.isSafeInteger(row.page) && row.page > (rows[index - 1]?.page || 0) && row.page <= pages : row.page === index + 1)
      && row.complete === true && typeof row.text === 'string'
      && row.characters === row.text.length && row.textHash === hash(row.text) && Array.isArray(row.issues)
      && (row.nativeReauditFromVersion === undefined || row.nativeReauditFromVersion === '3' && nativeReauditEligible(row))
      && (row.rawText === undefined || typeof row.rawText === 'string' && row.rawTextHash === hash(row.rawText))
      && (row.contentRole === 'non-content' || row.classification || row.method === 'page-audit'
        ? isVerifiedNonContentPage(row, resume)
        : textQuality(row.text, parser.minTextCharacters).usable && (row.method === 'pdf-text' && row.numericEligible === true
          || row.method === 'ocr' && row.numericEligible === false && Number.isFinite(row.confidence) && row.confidence >= parser.minOcrConfidence && row.confidence <= 100)));
  if (!valid) throw fileError('解析断点的原件、版本或完整页记录无法核验', 'invalid-checkpoint');
  return structuredClone(rows);
}
function documentCheckpoint(sourceHash, pageCount, rows, reason = 'parse-timeout') {
  if (!['parse-timeout', 'parse-retry'].includes(reason)) throw fileError('解析断点原因无效', 'invalid-checkpoint');
  const completeRows = rows.filter(row => row?.complete).sort((a, b) => a.page - b.page);
  if (!completeRows.length) return null;
  const sparse = completeRows.some((row, index) => row.page !== index + 1), present = new Set(completeRows.map(row => row.page));
  return { text: completeRows.map(row => row.text).join('\n\n'), pages: pageCount, pageTexts: completeRows, format: 'pdf', complete: false,
    numericEligible: false, hasOcrPages: completeRows.some(row => row.method === 'ocr'), parserVersion: PARSER_VERSION, sourceHash, checkpoint: reason,
    ...(sparse ? { checkpointLayout: 'sparse-pages-v1' } : {}),
    missingPages: Array.from({ length: pageCount }, (_, index) => index + 1).filter(number => !present.has(number)),
    issues: [reason === 'parse-timeout' ? 'document-parse-timeout: 文档执行预算已用尽，仅保留已完成页，缺页及全文仍待核验'
      : 'document-parse-retry: 显式重试未完成页面，已核验完整页复用；缺页及全文仍待核验',
      ...completeRows.flatMap(row => row.issues.map(issue => `第 ${row.page} 页 ${issue}`))] };
}
function looksTabular(text, blocks) {
  if (Array.isArray(blocks) && blocks.some(block => /table/i.test(block.blocktype || ''))) return true;
  const numericRows = text.split('\n').filter(line => (line.match(/[-+]?\d+(?:[,.]\d+)*(?:[%％])?/g) || []).length >= 3);
  return numericRows.length >= 2 || /(?:项目|科目).{0,20}(?:本期|上期|期初|期末)/.test(text);
}

// Tesseract.js 7.0.0's public createWorker wrapper can throw from a message
// listener and leave initialization pending after a language-load rejection.
// Use that pinned version's official Node worker protocol so every job has a
// rejection path and even a worker still initializing can be terminated.
class LocalOcrWorker {
  constructor({ workerPath, onProgress }) {
    const { Worker } = require('node:worker_threads');
    this.jobs = new Map(); this.sequence = 0; this.failure = null; this.termination = null;
    this.thread = new Worker(workerPath);
    this.thread.on('message', message => {
      const job = this.jobs.get(message.jobId);
      if (!job || message.action !== job.action) return;
      if (message.status === 'progress') { try { onProgress?.(message.data); } catch {} return; }
      this.jobs.delete(message.jobId);
      if (message.status === 'resolve') job.resolve({ data: message.data });
      else job.reject(Error(`本地 OCR ${job.action} 失败：${String(message.data || '未知工作线程错误')}`));
    });
    this.thread.on('error', error => this.fail(error));
    this.thread.on('exit', code => this.fail(Error(`本地 OCR 工作线程已退出（${code}）`)));
  }
  fail(error) {
    this.failure ||= error;
    for (const job of this.jobs.values()) job.reject(this.failure);
    this.jobs.clear();
  }
  job(action, payload) {
    if (this.failure) return Promise.reject(this.failure);
    const jobId = `company-ocr-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.jobs.set(jobId, { action, resolve, reject });
      try { this.thread.postMessage({ workerId: 'company-local-ocr', jobId, action, payload }); }
      catch (error) { this.jobs.delete(jobId); reject(error); }
    });
  }
  recognize(bytes, options = {}, output = { text: true, blocks: true }) {
    // Same binary conversion as Tesseract's Node loadImage, without accepting
    // filenames or URLs that could bypass this parser's local-file boundary.
    return this.job('recognize', { image: new Uint8Array(bytes), options, output });
  }
  terminate() {
    if (!this.termination) {
      this.fail(Error('本地 OCR 工作线程已终止'));
      this.termination = Promise.resolve(this.thread.terminate()).then(() => {});
    }
    return this.termination;
  }
}

class CompanyDocumentParser {
  constructor(options = {}) {
    this.recognizer = options.recognize;
    this.languagePath = unpacked(path.resolve(options.languagePath || path.join(__dirname, '..', 'assets', 'ocr')));
    this.ocrLanguages = options.ocrLanguages || ['chi_sim', 'eng'];
    if (!Array.isArray(this.ocrLanguages) || !this.ocrLanguages.length || this.ocrLanguages.some(language => !/^[a-z_]+$/.test(language))) throw Error('OCR 语言配置不正确');
    this.minOcrConfidence = options.minOcrConfidence ?? 85;
    if (!Number.isFinite(this.minOcrConfidence) || this.minOcrConfidence < 0 || this.minOcrConfidence > 100) throw Error('OCR 置信度须在 0 至 100 之间');
    this.minTextCharacters = positive(options.minTextCharacters, 12, '最小有效文字数');
    this.maxPixels = positive(options.maxPixels, 24000000, '页面像素上限');
    this.maxBytes = positive(options.maxBytes, 134217728, '文件字节上限');
    this.ocrTimeoutMs = positive(options.ocrTimeoutMs, 120000, '单页 OCR 超时');
    this.renderScale = options.renderScale ?? 2;
    if (!Number.isFinite(this.renderScale) || this.renderScale < 1 || this.renderScale > 4) throw Error('PDF 渲染倍率须在 1 至 4 之间');
    this.queue = Promise.resolve(); this.parseQueue = Promise.resolve(); this.worker = null; this.workerHandle = null; this.workerDisposal = Promise.resolve(); this.closed = false;
  }
  progress(callback, value) { try { callback?.(value); } catch {} }
  async getWorker() {
    if (!this.worker) {
      // Verify local models before constructing the worker. Never fall back to
      // Tesseract's default remote language URL or write a cwd language cache.
      const gzipped = this.ocrLanguages.every(language => fs.existsSync(path.join(this.languagePath, `${language}.traineddata.gz`)));
      const plain = this.ocrLanguages.every(language => fs.existsSync(path.join(this.languagePath, `${language}.traineddata`)));
      if (!gzipped && !plain) throw Error('本地 OCR 中英文语言包缺失或格式不一致');
      if (require('tesseract.js/package.json').version !== '7.0.0') throw Error('本地 OCR 工作线程协议尚未验证此运行库版本');
      const workerPath = unpacked(require.resolve('tesseract.js/src/worker-script/node/index.js'));
      const corePath = unpacked(path.dirname(require.resolve('tesseract.js-core/package.json')));
      if (!fs.existsSync(workerPath) || !fs.existsSync(path.join(corePath, 'tesseract-core-lstm.wasm.js')) || !fs.existsSync(path.join(corePath, 'tesseract-core-lstm.wasm'))) throw Error('本地 OCR 工作线程或 WASM 运行文件缺失');
      const handle = this.workerHandle = new LocalOcrWorker({ workerPath, onProgress: message => this.ocrProgress?.(message) });
      this.worker = (async () => {
        await handle.job('load', { options: { lstmOnly: true, corePath, logging: false } });
        await handle.job('loadLanguage', { langs: this.ocrLanguages, options: { langPath: this.languagePath, gzip: gzipped, cacheMethod: 'none', lstmOnly: true } });
        await handle.job('initialize', { langs: this.ocrLanguages, oem: 1, config: {} });
        return handle;
      })();
      const pending = this.worker;
      pending.catch(() => {
        if (this.worker === pending) return this.disposeWorker();
        return handle.terminate();
      }).catch(() => {});
    }
    return this.worker;
  }
  disposeWorker() {
    const handle = this.workerHandle; this.worker = null; this.workerHandle = null;
    if (handle) this.workerDisposal = Promise.all([this.workerDisposal, handle.terminate().catch(() => {})]).then(() => {});
    return this.workerDisposal;
  }
  async recognize(bytes, metadata) {
    const operation = this.queue.catch(() => {}).then(async () => {
      active(metadata.signal);
      if (this.closed) throw Error('文档解析器已关闭');
      const timeout = AbortSignal.timeout(this.ocrTimeoutMs);
      const signal = metadata.signal ? AbortSignal.any([metadata.signal, timeout]) : timeout;
      const onAbort = () => { if (!this.recognizer) void this.disposeWorker(); };
      this.ocrProgress = event => this.progress(metadata.onProgress, { stage: 'ocr', page: metadata.page, pages: metadata.pages, progress: event.progress, status: event.status });
      try {
        const input = { ...metadata, signal };
        if (this.recognizer) return await cancellable(this.recognizer(bytes, input), signal);
        const worker = await cancellable(this.getWorker(), signal, onAbort);
        return await cancellable(worker.recognize(bytes, {}, { text: true, blocks: true }), signal, onAbort);
      } catch (error) {
        if (!this.recognizer) await this.disposeWorker();
        active(metadata.signal);
        if (timeout.aborted) throw Error('OCR 单页识别超时');
        throw error;
      } finally { this.ocrProgress = null; }
    });
    this.queue = operation.catch(() => {});
    return cancellable(operation, metadata.signal);
  }
  async ocrPage(bytes, metadata, originalIssues = []) {
    const issues = [...originalIssues], page = metadata.page;
    try {
      const response = await this.recognize(bytes, metadata), data = response?.data || response || {};
      const quality = textQuality(data.text, this.minTextCharacters);
      const confidence = Number.isFinite(data.confidence) && data.confidence >= 0 && data.confidence <= 100 ? data.confidence : null;
      issues.push(...quality.issues);
      if (confidence === null || confidence < this.minOcrConfidence) issues.push(`ocr-confidence-low: OCR 置信度 ${confidence ?? '未知'}，低于 ${this.minOcrConfidence}`);
      const tableLike = looksTabular(quality.text, data.blocks);
      issues.push(tableLike ? 'ocr-table-unverified: OCR 表格未验证行列对应关系，不能用于自动数值判断' : 'ocr-numbers-unverified: OCR 字符未独立核对，不能用于自动数值判断');
      return { page, text: quality.text, method: 'ocr', confidence, complete: quality.usable && confidence !== null && confidence >= this.minOcrConfidence,
        numericEligible: false, tableLike, issues, characters: quality.text.length, textHash: hash(quality.text) };
    } catch (error) {
      active(metadata.signal);
      issues.push(`ocr-failed: ${error.message}`);
      return { page, text: '', method: 'ocr', confidence: null, complete: false, numericEligible: false, tableLike: false, issues, characters: 0, textHash: hash('') };
    }
  }
  result(format, pages, pageTexts, issues = []) {
    const complete = pageTexts.length === pages && pageTexts.every(page => page.complete && !page.nativeReauditFromVersion) && !issues.length;
    return { text: pageTexts.map(page => page.text).join('\n\n'), pages, pageTexts, format, complete,
      hasOcrPages: pageTexts.some(page => page.method === 'ocr'), numericEligible: complete && pageTexts.every(page => page.numericEligible),
      issues: [...issues, ...pageTexts.flatMap(page => page.issues.map(issue => `第 ${page.page} 页 ${issue}`))], parserVersion: PARSER_VERSION };
  }
  async parse(input, { signal, onProgress, parseTimeoutMs = 120000, ...options } = {}) {
    active(signal);
    if (this.closed) throw Error('文档解析器已关闭');
    parseTimeoutMs = positive(parseTimeoutMs, 120000, '文档解析执行超时');
    const fileInput = isFileInput(input) ? { filePath: input.filePath, bytes: input.bytes, sha256: input.sha256 } : null;
    if (fileInput && parseTimeoutMs > 300000) throw Error('文件范围解析执行超时上限无效');
    const queuedAt = performance.now();
    this.progress(onProgress, { stage: 'parser-queue', status: 'waiting', queuedMs: 0 });
    const operation = this.parseQueue.catch(() => {}).then(async () => {
      active(signal);
      if (this.closed) throw Error('文档解析器已关闭');
      const startedAt = performance.now(), timings = { queuedMs: Math.round(startedAt - queuedAt), parseMs: 0, textMs: 0, renderMs: 0, ocrMs: 0 };
      const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), parseTimeoutMs); timer.unref?.();
      const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      const update = () => { timings.parseMs = Math.round(performance.now() - startedAt); timings.totalMs = timings.queuedMs + timings.parseMs; };
      this.progress(onProgress, { stage: 'parser-queue', status: 'started', queuedMs: timings.queuedMs });
      try {
        const result = await this.parseNow(fileInput || input, { ...options, signal: combined, onProgress, timings }); update();
        return { ...result, sourceHash: fileInput ? fileInput.sha256 : hash(input instanceof ArrayBuffer ? new Uint8Array(input) : input), timings: { ...timings } };
      } catch (error) {
        update();
        if (timeout.signal.aborted && !signal?.aborted) {
          const timedOut = Error('原始附件解析执行超时'); timedOut.code = 'parse-timeout'; timedOut.timings = { ...timings };
          if (error.partialResult) timedOut.partialResult = { ...error.partialResult, timings: { ...timings } };
          throw timedOut;
        }
        // Cancellation and other errors must never publish a partial document.
        delete error.partialResult;
        error.timings = { ...timings }; throw error;
      } finally { clearTimeout(timer); }
    });
    this.parseQueue = operation.catch(() => {});
    return cancellable(operation, signal);
  }
  async parseNow(input, { format, signal, onProgress, onPage, maxPages = 600, maxChars = 4000000, fileMaxBytes = this.maxBytes, resume, timings } = {}) {
    active(signal);
    if (this.closed) throw Error('文档解析器已关闭');
    maxPages = positive(maxPages, 600, '页数上限'); maxChars = positive(maxChars, 4000000, '文字上限');
    const fileInput = isFileInput(input);
    if (fileInput && (maxPages > 1600 || maxChars > 4000000)) throw Error('文件范围解析页数或文字上限无效');
    const localFile = fileInput ? await openVerifiedPdfFile(input, fileMaxBytes, signal) : null;
    let rangeFailure = null, rangeQueue = Promise.resolve();
    const rangeAbort = localFile ? new AbortController() : null;
    if (rangeAbort) signal = signal ? AbortSignal.any([signal, rangeAbort.signal]) : rangeAbort.signal;
    try {
    const bytes = localFile?.prefix || (input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null);
    if (!bytes?.byteLength) throw Error('文档内容为空或不是二进制数据');
    if (!localFile && bytes.byteLength > this.maxBytes) throw Error('文档大小超过解析上限');
    const actual = formatOf(bytes, format), canvas = pdfRequire('@napi-rs/canvas');
    if (localFile && actual !== 'pdf') throw Error('文件范围解析仅支持 PDF 原件');
    if (resume && actual !== 'pdf') throw fileError('解析断点仅适用于 PDF 原件', 'invalid-checkpoint');
    if (actual !== 'pdf') {
      const dimensions = imageSize(bytes, actual);
      if (dimensions && (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > this.maxPixels)) return this.result(actual, 1, [], ['page-pixel-limit: 图片声明像素超过安全渲染上限或尺寸无效']);
      const picture = await cancellable(canvas.loadImage(Buffer.from(bytes)), signal);
      if (!picture.width || !picture.height || picture.width * picture.height > this.maxPixels) return this.result(actual, 1, [], ['page-pixel-limit: 图片像素超过安全渲染上限或尺寸无效']);
      const output = canvas.createCanvas(picture.width, picture.height), ctx = output.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, picture.width, picture.height); ctx.drawImage(picture, 0, 0);
      const page = await measured(timings, 'ocrMs', () => this.ocrPage(output.toBuffer('image/png'), { page: 1, pages: 1, signal, onProgress }));
      output.width = output.height = 1;
      if (page.characters > maxChars) return this.result(actual, 1, [], ['document-char-limit: 识别文字超过上限，未使用截断正文']);
      this.progress(onProgress, { stage: 'parsed', page: 1, pages: 1, method: page.method, complete: page.complete });
      return this.result(actual, 1, [page]);
    }
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'), dependency = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const sourceHash = localFile?.sourceHash || hash(bytes);
    let range, endRanges;
    if (localFile) {
      range = new pdfjs.PDFDataRangeTransport(localFile.length, new Uint8Array(0), true);
      const pendingRanges = new Set();
      // PDF.js waits for its page tasks before cancelling range readers during
      // destroy(). End outstanding readers first on an aborted parse, otherwise
      // a failed file read leaves both page termination and destroy waiting.
      endRanges = () => {
        for (const begin of pendingRanges) { try { range.onDataRange(begin, new Uint8Array(0)); } catch {} }
        pendingRanges.clear();
      };
      signal.addEventListener('abort', endRanges, { once: true });
      range.requestDataRange = (begin, end) => {
        pendingRanges.add(begin);
        rangeQueue = rangeQueue.then(async () => {
          active(signal); const chunk = await localFile.readRange(begin, end, signal); active(signal); range.onDataRange(begin, chunk); pendingRanges.delete(begin);
        }).catch(error => {
          if (!signal?.aborted) { rangeFailure = error; rangeAbort.abort(); }
        });
      };
      range.abort = () => { endRanges(); rangeAbort.abort(); };
    }
    const fileWorker = range ? new pdfjs.PDFWorker() : null;
    const task = pdfjs.getDocument({ ...(range ? { range, worker: fileWorker, length: localFile.length, rangeChunkSize: FILE_CHUNK_BYTES, disableAutoFetch: true, disableStream: true }
      : { data: new Uint8Array(bytes) }), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, fontExtraProperties: true, verbosity: 0,
      cMapUrl: path.join(dependency, 'cmaps').replaceAll('\\', '/') + '/', cMapPacked: true,
      standardFontDataUrl: path.join(dependency, 'standard_fonts').replaceAll('\\', '/') + '/' });
    const cancel = () => { Promise.resolve(task.destroy()).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    let document, pages = [];
    try {
      document = await cancellable(task.promise, signal, cancel);
      if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) throw Error('PDF 页数无效');
      if (document.numPages > maxPages) return this.result('pdf', document.numPages, [], ['document-page-limit: PDF 页数超过上限，未使用截断正文']);
      const restored = checkpointPages(resume, sourceHash, document.numPages, this);
      pages = new Array(document.numPages);
      for (const row of restored) { pages[row.page - 1] = row; this.progress(onPage, { sourceHash, pages: document.numPages, page: row }); }
      let chars = restored.reduce((sum, page) => sum + page.characters, 0), completed = restored.length;
      if (chars > maxChars) return this.result('pdf', document.numPages, [], ['document-char-limit: 已完成断点文字超过本次上限，未使用截断正文']);
      if (restored.length) this.progress(onProgress, { stage: 'parser-resume', completed: restored.length, pages: document.numPages });
      const deferred = [];
      const unresolved = (number, issues) => ({ page: number, text: '', method: 'ocr', confidence: null, complete: false,
        numericEligible: false, tableLike: false, issues, characters: 0, textHash: hash('') });
      const rows = () => Array.from({ length: document.numPages }, (_, index) => pages[index]
        || unresolved(index + 1, ['page-not-read: 页面尚未完整读取']));
      const keepPage = row => {
        const previous = pages[row.page - 1];
        chars -= previous?.characters || 0; if (previous?.complete) completed--;
        pages[row.page - 1] = row; chars += row.characters;
        if (row.complete) { completed++; this.progress(onPage, { sourceHash, pages: document.numPages, page: row }); }
        this.progress(onProgress, { stage: 'parsed', phase: row.method === 'ocr' ? 'deep-read' : 'native-text', page: row.page,
          pages: document.numPages, completed, method: row.method, complete: row.complete });
      };
      // Cover every native text layer before rendering any page. A difficult
      // early scan must not prevent later searchable pages from being cached.
      for (let number = 1; number <= document.numPages; number++) {
        active(signal);
        const previous = pages[number - 1];
        if (previous?.complete && !previous.nativeReauditFromVersion) continue;
        const page = await cancellable(document.getPage(number), signal), viewport = page.getViewport({ scale: this.renderScale });
        let row;
        try {
          let quality, extracted, mapped, operators;
          const audited = auditedPageClassification(sourceHash, document.numPages, number);
          const textAt = performance.now();
          try {
            extracted = await cancellable(page.getTextContent(), signal);
            const fonts = {}, fontProofs = {};
            if (extracted.items.some(item => /[\uE000-\uF8FF]/.test(item.str || ''))) {
              operators = await cancellable(page.getOperatorList(), signal);
              for (const item of extracted.items.filter(item => /[\uE000-\uF8FF]/.test(item.str || ''))) {
                if (Object.hasOwn(fonts, item.fontName)) continue;
                if (page.commonObjs.has(item.fontName)) {
                  const font = page.commonObjs.get(item.fontName); fonts[item.fontName] = font.name;
                  const embedded = verifiedEmbeddedWingdings2(font);
                  if (embedded) { fonts[item.fontName] = embedded.name; fontProofs[item.fontName] = embedded.proof; }
                }
              }
            }
            mapped = verifiedPdfText(extracted.items, fonts, fontProofs); quality = textQuality(mapped.text, this.minTextCharacters);
            // Audit each substantial image's own text coverage, not the page's
            // total character count: a native paragraph above a scanned audit
            // opinion must not hide the missing body. Logos/small charts and
            // images with a substantive native overlay keep the text path.
            if (!audited && quality.usable
              && scannedBodyImage(operators ||= await cancellable(page.getOperatorList(), signal), extracted.items, page.view, pdfjs.OPS)) {
              quality.usable = false;
              quality.issues.push('pdf-scanned-body: 文字层仅覆盖少量正文，主体图像仍需完整识别');
            }
          }
          catch (error) { active(signal); quality = { usable: false, issues: [`pdf-text-failed: ${error.message}`] }; }
          finally { timings.textMs += Math.round(performance.now() - textAt); }
          if (audited) row = nonContentPage(number, quality.text || '', audited, 'page-audit');
          else if (extracted && !extracted.items.length && !(operators ||= await cancellable(page.getOperatorList(), signal)).fnArray.length
            && !(await cancellable(page.getAnnotations(), signal)).length) {
            row = nonContentPage(number, '', { kind: 'blank', verified: true, basis: 'empty-pdf-operator-list',
              sourceHash, pages: document.numPages, page: number, operatorCount: 0, nativeItemCount: 0, annotationCount: 0 });
          }
          else if (quality.usable) row = { page: number, text: quality.text, method: 'pdf-text', confidence: null, complete: true,
            numericEligible: true, tableLike: false, issues: [], characters: quality.text.length, textHash: hash(quality.text),
            ...(mapped.verifiedGlyphs.length ? { rawText: mapped.rawText, rawTextHash: mapped.rawTextHash, verifiedCheckboxes: mapped.verifiedCheckboxes, verifiedGlyphs: mapped.verifiedGlyphs } : {}) };
          else if (previous?.nativeReauditFromVersion) {
            // A version-3 garbled native layer may now be decoded precisely.
            // If it still cannot, retain its already completed OCR without
            // another render/recognize pass. Unvisited rows keep the marker
            // through both parser and worker-pool timeout checkpoints.
            row = { ...previous }; delete row.nativeReauditFromVersion;
          }
          else if (viewport.width * viewport.height > this.maxPixels) row = unresolved(number, ['page-pixel-limit: PDF 页面像素超过安全渲染上限']);
          else {
            const issues = quality.issues.map(issue => `text-layer-replaced: ${issue}`);
            deferred.push({ number, issues }); pages[number - 1] = unresolved(number, [...issues, 'ocr-pending: 页面仍需深度识别']);
            this.progress(onProgress, { stage: 'native-scan', page: number, pages: document.numPages, completed, needsOcr: true });
          }
          if (row) {
            if (chars - (previous?.characters || 0) + row.characters > maxChars) return this.result('pdf', document.numPages, rows(), [`document-char-limit: 第 ${number} 页使文字超过上限，未使用截断正文`]);
            keepPage(row);
          }
        } finally { page.cleanup(); }
        if (number % 5 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      this.progress(onProgress, { stage: 'native-scan-complete', pages: document.numPages, completed, ocrPages: deferred.length });
      for (const { number, issues } of deferred) {
        active(signal);
        const page = await cancellable(document.getPage(number), signal), viewport = page.getViewport({ scale: this.renderScale });
        let output;
        try {
          output = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const rendering = page.render({ canvasContext: output.getContext('2d'), viewport, background: '#fff' });
          await measured(timings, 'renderMs', () => cancellable(rendering.promise, signal, () => rendering.cancel()));
          const row = await measured(timings, 'ocrMs', () => this.ocrPage(output.toBuffer('image/png'), { page: number, pages: document.numPages, signal, onProgress }, issues));
          if (chars + row.characters > maxChars) return this.result('pdf', document.numPages, rows(), [`document-char-limit: 第 ${number} 页使文字超过上限，未使用截断正文`]);
          keepPage(row);
        } finally { page.cleanup(); if (output) output.width = output.height = 1; }
      }
      if (localFile) await localFile.unchanged();
      return this.result('pdf', document.numPages, rows());
    } catch (error) {
      if (signal?.aborted && document && pages.length) {
        const checkpoint = documentCheckpoint(sourceHash, document.numPages, pages);
        if (checkpoint) error.partialResult = checkpoint;
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel); if (endRanges) signal.removeEventListener('abort', endRanges);
      endRanges?.();
      const disposal = Promise.resolve(task.destroy()).catch(() => {});
      if (fileWorker) {
        // In PDF.js 6.4.299 a failed range can leave text tasks waiting while
        // destroy waits for those tasks. Own this worker so the failure path
        // has a bounded shutdown rather than blocking the document queue.
        let timer;
        try { await Promise.race([disposal, new Promise(resolve => { timer = setTimeout(resolve, 250); })]); }
        finally { clearTimeout(timer); fileWorker.destroy(); }
      } else await disposal;
    }
    } catch (error) { throw rangeFailure || error; }
    finally { if (localFile) { rangeAbort.abort(); await rangeQueue; await localFile.close(); } }
  }
  async destroy() { this.closed = true; await this.disposeWorker(); await this.parseQueue; await this.queue; }
}

async function parseCompanyDocument({ filePath, mimeType, signal, onProgress, limits = {}, parser }) {
  active(signal);
  const owned = !parser, instance = parser || new CompanyDocumentParser();
  try { return await instance.parse(await fs.promises.readFile(filePath, { signal }), { format: mimeType, signal, onProgress, ...limits }); }
  finally { if (owned) await instance.destroy(); }
}
module.exports = { CompanyDocumentParser, LocalOcrWorker, parseCompanyDocument, verifiedPdfText, verifiedEmbeddedWingdings2, isVerifiedNonContentPage, nativeReauditEligible, documentCheckpoint, PARSER_VERSION, COMPANY_DOCUMENT_PARSER_VERSION: PARSER_VERSION };
