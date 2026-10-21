// Exercise the installed Electron/ASAR parser with real, offline OCR. The
// worker preload only records filesystem access and rejects network access;
// it does not replace parsing, rendering, recognition or confidence results.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const executable = process.env.GUANLAN_PACKAGE_EXE ? path.resolve(process.env.GUANLAN_PACKAGE_EXE)
  : path.join(root, 'releases/automatic-research/win-unpacked/Guanlan.exe');
const archive = path.join(path.dirname(executable), 'resources/app.asar');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/local-ocr-package-'));
const dataPath = path.join(output, 'account'), auditPath = path.join(output, 'worker-audit.jsonl');
const preloadPath = path.join(output, 'offline-worker-preload.cjs');
const corruptPath = path.join(output, 'corrupt-models');
const png = fs.readFileSync(path.join(root, 'tests/fixtures/company-ocr-page.png'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('GUANLAN_TEST_')) delete env[key];
let desktop;

async function mixedPdf() {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const picture = await loadImage(png), canvas = createCanvas(picture.width, picture.height);
  canvas.getContext('2d').drawImage(picture, 0, 0); const jpeg = canvas.toBuffer('image/jpeg');
  const text = 'Package original native text must remain available without OCR.';
  const nativeStream = `BT /F1 14 Tf 20 150 Td (${text}) Tj ET`, imageStream = 'q 900 0 0 360 0 0 cm /Im0 Do Q';
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 180] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from(`<< /Length ${nativeStream.length} >>\nstream\n${nativeStream}\nendstream`),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 360] /Resources << /XObject << /Im0 8 0 R >> >> /Contents 7 0 R >>'),
    Buffer.from(`<< /Length ${imageStream.length} >>\nstream\n${imageStream}\nendstream`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')])];
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = chunks[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length); const object = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]);
    chunks.push(object); length += object.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
  return { bytes: Buffer.concat(chunks), text };
}

function verifyArchive() {
  assert.ok(fs.existsSync(executable), `Build the package first: ${executable}`);
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json'));
  assert.equal(manifest.version, version); assert.equal(manifest.dependencies['tesseract.js'], '7.0.0');
  const parserFile = 'core/company-document-parser.cjs';
  assert.ok(asar.extractFile(archive, path.normalize(parserFile)).equals(fs.readFileSync(path.join(root, parserFile))), 'Packaged parser differs from current source');
  const models = ['chi_sim', 'eng'].map(language => {
    const relative = path.join('assets', 'ocr', `${language}.traineddata`), filename = path.join(archive + '.unpacked', relative);
    const bytes = fs.readFileSync(filename);
    assert.ok(bytes.equals(fs.readFileSync(path.join(root, relative))), `Packaged ${language} language model differs`);
    return { language, filename, bytes: bytes.length, sha256: sha256(bytes) };
  });
  for (const file of ['node_modules/tesseract.js/src/worker-script/node/index.js', 'node_modules/tesseract.js-core/package.json']) {
    assert.ok(fs.statSync(path.join(archive + '.unpacked', file)).size > 0, `Unpacked OCR runtime resource missing: ${file}`);
  }
  return { archive, models, parserSha256: sha256(fs.readFileSync(path.join(root, parserFile))) };
}

function writeWorkerPreload() {
  fs.writeFileSync(preloadPath, `const fs = require('node:fs');
const append = fs.appendFileSync.bind(fs), audit = ${JSON.stringify(auditPath)};
const record = value => append(audit, JSON.stringify(value) + '\\n');
record({ kind: 'start', worker: process.argv[1], threadId: require('node:worker_threads').threadId });
for (const operation of ['readFile', 'readFileSync']) {
  const original = fs[operation];
  fs[operation] = function (filename, ...args) {
    if (typeof filename === 'string' && /\\.(?:traineddata(?:\\.gz)?|wasm)$/.test(filename)) record({ kind: 'read', operation, filename });
    return original.call(this, filename, ...args);
  };
}
const denied = (method, value) => { record({ kind: 'network', method, value: String(value) }); throw Error('OCR package verification forbids network access'); };
global.fetch = async value => denied('fetch', value);
for (const protocol of ['http', 'https']) {
  const module = require('node:' + protocol);
  for (const operation of ['request', 'get']) module[operation] = value => denied(protocol + '.' + operation, value);
}
`);
}

function verifyOcr(result) {
  assert.equal(result.complete, true, result.issues.join('; '));
  assert.equal(result.hasOcrPages, true); assert.equal(result.numericEligible, false);
  const page = result.pageTexts.find(page => page.method === 'ocr');
  assert.ok(page); assert.ok(page.confidence >= 85); assert.equal(page.numericEligible, false);
  assert.match(page.text.replace(/\s/g, ''), /本地识别测试报告/);
  assert.match(page.text, /Company annual report/i);
  assert.match(page.issues.join(';'), /ocr-numbers-unverified/);
  assert.equal(result.text, result.pageTexts.map(page => page.text).join('\n\n'));
}

(async () => {
  const packaged = verifyArchive(), pdf = await mixedPdf(); writeWorkerPreload();
  fs.writeFileSync(path.join(output, 'mixed-native-scanned.pdf'), pdf.bytes);
  fs.mkdirSync(corruptPath);
  for (const language of ['chi_sim', 'eng']) fs.writeFileSync(path.join(corruptPath, `${language}.traineddata`), Buffer.alloc(32));
  desktop = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${dataPath}`], cwd: root, env, timeout: 60000 });
  const result = await desktop.evaluate(async ({ app, net }, input) => {
    net.fetch = async () => new Response('Isolated OCR package check: no live data', { status: 503 });
    const mainRequire = process.mainModule.require.bind(process.mainModule), path = mainRequire('node:path');
    const bundledRequire = mainRequire('node:module').createRequire(path.join(app.getAppPath(), 'package.json'));
    const threads = mainRequire('node:worker_threads'), OriginalWorker = threads.Worker, workerPaths = [];
    threads.Worker = class OfflineAuditedWorker extends OriginalWorker {
      constructor(filename, options = {}) {
        workerPaths.push(String(filename));
        super(filename, { ...options, execArgv: [...(options.execArgv || []), '--require', input.preloadPath] });
      }
    };
    const { CompanyDocumentParser } = bundledRequire('./core/company-document-parser.cjs');
    const parser = new CompanyDocumentParser(), progress = [], started = Date.now();
    try {
      const image = await parser.parse(Buffer.from(input.png, 'base64'), { format: 'png', onProgress: item => progress.push(item) });
      const workerAfterImage = parser.worker;
      const mixed = await parser.parse(Buffer.from(input.pdf, 'base64'), { format: 'pdf', onProgress: item => progress.push(item) });
      const workerAfterPdf = parser.worker;
      const repeatedImage = await parser.parse(Buffer.from(input.png, 'base64'), { format: 'png' });
      const reusedWorkerCount = workerPaths.length;
      const recoveryParser = new CompanyDocumentParser({ languagePath: input.corruptPath, ocrTimeoutMs: 10000 });
      let corrupted, recovered, corruptWorkerReleased;
      try {
        corrupted = await recoveryParser.parse(Buffer.from(input.png, 'base64'), { format: 'png' });
        corruptWorkerReleased = recoveryParser.worker === null && recoveryParser.workerHandle === null;
        recoveryParser.languagePath = parser.languagePath;
        recovered = await recoveryParser.parse(Buffer.from(input.png, 'base64'), { format: 'png' });
      } finally { await recoveryParser.destroy(); }
      return { applicationPath: app.getAppPath(), dataPath: app.getPath('userData'), image, mixed, repeatedImage, progress, workerPaths,
        reusedWorkerCount, corrupted, recovered, corruptWorkerReleased,
        workerReused: workerAfterImage === workerAfterPdf && workerAfterPdf === parser.worker,
        languagePath: parser.languagePath, parserPath: bundledRequire.resolve('./core/company-document-parser.cjs'),
        elapsedMs: Date.now() - started, tesseractVersion: bundledRequire('tesseract.js/package.json').version };
    } finally { await parser.destroy(); threads.Worker = OriginalWorker; }
  }, { preloadPath, corruptPath, png: png.toString('base64'), pdf: pdf.bytes.toString('base64') });
  assert.equal(path.resolve(result.applicationPath), path.resolve(archive));
  assert.equal(path.resolve(result.dataPath), path.resolve(dataPath));
  assert.equal(result.tesseractVersion, '7.0.0');
  for (const document of [result.image, result.mixed, result.repeatedImage, result.recovered]) verifyOcr(document);
  assert.equal(result.corrupted.complete, false); assert.match(result.corrupted.issues.join(';'), /ocr-failed/);
  assert.equal(result.corruptWorkerReleased, true);
  assert.equal(result.image.pages, 1); assert.equal(result.mixed.pages, 2);
  assert.deepEqual(result.mixed.pageTexts.map(page => page.method), ['pdf-text', 'ocr']);
  assert.equal(result.mixed.pageTexts[0].text, pdf.text); assert.equal(result.mixed.pageTexts[0].numericEligible, true);
  assert.equal(result.repeatedImage.text, result.image.text); assert.equal(result.workerReused, true);
  assert.equal(result.reusedWorkerCount, 1, 'The parser must reuse its initialized worker');
  assert.equal(result.workerPaths.length, 3, 'The separate corrupt-model probe must discard and recreate its worker');
  assert.ok(result.workerPaths.every(filename => filename.startsWith(archive + '.unpacked' + path.sep)));
  assert.equal(result.languagePath, path.join(archive + '.unpacked', 'assets', 'ocr'));
  const audit = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(audit.filter(item => item.kind === 'start').length, 3);
  assert.deepEqual(audit.filter(item => item.kind === 'network'), [], 'OCR attempted a network request');
  for (const model of packaged.models) assert.ok(audit.some(item => item.kind === 'read' && path.resolve(item.filename) === path.resolve(model.filename)), `No local read recorded for ${model.language}`);
  const coreReads = audit.filter(item => item.kind === 'read' && item.filename.endsWith('.wasm'));
  assert.ok(coreReads.some(item => item.filename.startsWith(path.join(archive + '.unpacked', 'node_modules', 'tesseract.js-core'))), 'No local OCR WASM core read recorded');
  const report = { status: 'passed', checkedAt: new Date().toISOString(), version, executable, output, packaged, result, audit,
    checks: ['Real Chinese/English image OCR runs with bundled local models and WASM core while worker network is forbidden.',
      'Mixed PDF retains native page text and uses real OCR only for the scanned page; OCR text cannot support automatic numeric judgments.',
      'Three document parses reuse one initialized worker and repeated recognition is stable in the packaged Electron application.',
      'A separate parser rejects corrupt local models without crashing the application, releases the failed thread and succeeds after the model path is corrected.'] };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, elapsedMs: result.elapsedMs, workerPaths: result.workerPaths,
    imageConfidence: result.image.pageTexts[0].confidence, pdfConfidence: result.mixed.pageTexts[1].confidence, checks: report.checks }, null, 2));
})().catch(error => { console.error(error.stack); console.error('Output:', output); process.exitCode = 1; })
  .finally(async () => { if (desktop) await desktop.close(); });
