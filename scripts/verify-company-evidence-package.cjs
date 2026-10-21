// Packaged Electron + ASAR dependency integration. Uses a new paused virtual
// account and local HTTP responses containing real PDF bytes. PDF.js parsing,
// source completeness checks, disk caching and renderer IPC are production code.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const asar = require('@electron/asar');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { createEntryConditions } = require('../core/entry-conditions.cjs');
const { poolPolicy } = require('../core/agency-screening.cjs');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const executable = process.env.GUANLAN_PACKAGE_EXE ? path.resolve(process.env.GUANLAN_PACKAGE_EXE)
  : path.join(root, 'releases/automatic-research/win-unpacked/Guanlan.exe');
const archive = path.join(path.dirname(executable), 'resources/app.asar');
const NOW = '2026-10-13T02:00:00.000Z', symbol = 'sh600519';
const item = { id: 'AN20260915000001', title: '隔离样本：主要产品经营情况公告', date: '2026-09-15', kind: 'notice', period: '2026-09-15' };
const blankItem = { ...item, id: 'AN20260915000002' };
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/company-evidence-package-'));
const dataPath = path.join(output, 'account'), cachePath = path.join(output, 'pdf-cache');
const accountFile = path.join(dataPath, 'account.json');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('GUANLAN_TEST_')) delete env[key];
const errors = [], checks = [], sessions = []; let desktop, page;

function textPdf(lines) {
  // A complete deterministic PDF with a cross-reference table, standard font,
  // and one text stream per page. No parser/text-output mocks are used.
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pages = [];
  for (const line of lines) {
    const pageId = objects.length + 1, streamId = pageId + 1; pages.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    const escaped = line.replace(/[\\()]/g, char => '\\' + char), stream = line ? `BT /F1 12 Tf 36 720 Td (${escaped}) Tj ET` : 'BT ET';
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.join(' ')}] >>`;
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}
const expectedLines = ['Package PDF evidence page 1: issuer stock 600519, complete original disclosure text.',
  'Package PDF evidence page 2: the final page is parsed by the bundled PDF.js runtime.'];
const pdfBytes = textPdf(expectedLines), blankPdfBytes = textPdf([expectedLines[0], '']);

function seedLegacyAccount() {
  fs.mkdirSync(dataPath, { recursive: true });
  const engine = new Engine(initialState(), () => new Date(NOW));
  engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' });
  const policy = poolPolicy(); policy.version = 1; delete policy.evidenceMode;
  const member = engine.s.agency.groups.find(group => group.id === 'swing').members[0];
  member.entryConditions = createEntryConditions({ ...policy.commonQuery, source: { kind: 'agency-pool', policyVersion: 1, selectedAt: NOW } }, new Date(NOW));
  member.poolCheck = { policyVersion: 1, status: 'pass', checkedAt: NOW, name: '隔离旧版成员', matchedStrategies: ['swing'], reasons: ['旧版人工研究记录筛选通过，未执行新版程序核验'] };
  const retained = { symbol, name: '隔离旧版成员', strategyId: 'swing', status: 'pass', matchedStrategies: ['swing'], reasons: [...member.poolCheck.reasons] };
  engine.s.agency.pool = { policy, lastResult: { id: 'package-legacy-policy-1', startedAt: NOW, finishedAt: NOW, policyVersion: 1,
    priority: [...policy.priority], coverage: { universeComplete: true, universeCount: 1, requiredMissing: [], partial: false },
    sources: { quotes: { source: '旧版隔离行情', oldestQuote: NOW, newestQuote: NOW }, evidence: '本地已人工核验研究证据' },
    added: [], retained: [retained], removed: [], pending: [], held: [], skipped: [], unassignedPending: [],
    counts: { added: 0, retained: 1, removed: 0, pending: 0, held: 0, skipped: 0, unassignedPending: 0 },
    strategies: Object.fromEntries(policy.priority.map(id => [id, { pass: id === 'swing' ? 1 : 0, failed: 0, pending: 0 }])) } };
  engine.s.agency.poolAuthorizationRevision++;
  assert.equal(validState(engine.s), true, 'legacy policy fixture must be a valid account');
  assert.equal(path.dirname(accountFile), dataPath); assert.equal(path.dirname(dataPath), output);
  fs.writeFileSync(accountFile, JSON.stringify(engine.s, null, 2));
  fs.writeFileSync(path.join(output, 'two-page-original.pdf'), pdfBytes);
  fs.writeFileSync(path.join(output, 'missing-page-text.pdf'), blankPdfBytes);
  return structuredClone(engine.s);
}
function verifyArchive() {
  assert.ok(fs.existsSync(executable), `Build the package first: ${executable}`);
  assert.ok(fs.existsSync(archive), `The packaged ASAR is missing: ${archive}`);
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json'));
  assert.equal(manifest.version, version); assert.equal(manifest.dependencies['pdfjs-dist'], '6.4.299');
  const files = ['core/company-evidence-source.cjs', 'core/company-evidence.cjs', 'core/company-document-parser.cjs',
    'core/company-document-pool.cjs', 'core/company-document-worker.cjs', 'core/agency-pool.cjs', 'core/agency-screening.cjs', 'main.cjs', 'ui/agency.js', 'ui/index.html'];
  for (const file of files) assert.ok(asar.extractFile(archive, path.normalize(file)).equals(fs.readFileSync(path.join(root, file))), `packaged source differs: ${file}`);
  const pdfManifest = JSON.parse(asar.extractFile(archive, path.normalize('node_modules/pdfjs-dist/package.json')));
  assert.equal(pdfManifest.version, '6.4.299');
  for (const file of ['node_modules/pdfjs-dist/legacy/build/pdf.mjs', 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf']) assert.ok(asar.statFile(archive, path.normalize(file)).size > 0, `packaged PDF runtime resource is missing: ${file}`);
  return { archive, comparedFiles: files, dependency: `pdfjs-dist@${pdfManifest.version}` };
}
async function call(name) { return page.evaluate(async name => { const result = await window.guanlan.call(name); if (!result.ok) throw Error(result.error); return result.data; }, name); }
function inactive(current, legacy) {
  assert.equal(path.resolve(current.dataPath), path.resolve(dataPath));
  assert.equal(current.account.cash, legacy.cash); assert.equal(current.account.trades.length, 0); assert.equal(current.account.orders.length, 0); assert.equal(current.account.lots.length, 0);
  assert.equal(current.account.agency.transfers.length, 0);
  assert.ok(current.agency.groups.every(group => group.mode === 'paused' && group.cash === 0));
  assert.equal(current.agencyPool.running, false);
  assert.equal(current.agencyPool.policy.version, 2); assert.equal(current.agencyPool.policy.evidenceMode, 'automatic');
  assert.equal(current.agencyPool.lastResult.policyVersion, 1); assert.equal(current.agencyPool.lastResult.id, legacy.agency.pool.lastResult.id);
  assert.deepEqual(current.account.agency.pool.lastResult, legacy.agency.pool.lastResult);
}
async function launch() {
  desktop = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${dataPath}`], cwd: root, env, timeout: 60000 });
  const applicationPath = await desktop.evaluate(({ app, net }) => {
    // Market traffic in this isolated process is intentionally unavailable;
    // the separate CompanyEvidenceSource instance below receives its own bytes.
    net.fetch = async () => new Response('Isolated package check: no live data', { status: 503 });
    return app.getAppPath();
  });
  assert.equal(path.resolve(applicationPath), path.resolve(archive)); sessions.push(applicationPath);
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4, null, { timeout: 30000 });
  await page.locator('[data-page="agency"]').click();
  return call('state');
}
async function close() { if (desktop) { await desktop.close(); desktop = null; page = null; } }

(async () => {
  const packaged = verifyArchive(), legacy = seedLegacyAccount();
  let current = await launch(); inactive(current, legacy);
  assert.match(await page.locator('#agency-pool-evidence-summary').innerText(), /旧版研究证据结果/);
  assert.doesNotMatch(await page.locator('#agency-pool-evidence-summary').innerText(), /已核验 \d+ 只/);
  await page.locator('#agency-pool-policy summary').click();
  assert.match(await page.locator('#agency-pool-policy-content').innerText(), /财务质量与行业龙头 · 2/);
  assert.equal(await page.locator('#agency-pool-run').isEnabled(), true);
  checks.push('packaged startup loads a real policy-1 account, exposes policy-2 for the next run and clearly keeps the historical result separate; no scan, funding or trade occurs');

  const parsed = await desktop.evaluate(async ({ app }, input) => {
    const mainRequire = process.mainModule.require.bind(process.mainModule), path = mainRequire('node:path');
    const bundledRequire = mainRequire('node:module').createRequire(path.join(app.getAppPath(), 'package.json'));
    const sourcePath = bundledRequire.resolve('./core/company-evidence-source.cjs');
    const pdfPath = bundledRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfVersion = bundledRequire('pdfjs-dist/package.json').version;
    const { CompanyEvidenceSource } = bundledRequire(sourcePath), { CompanyDocumentPool } = bundledRequire('./core/company-document-pool.cjs'), calls = [], progress = [];
    const pool = new CompanyDocumentPool({ maxBytes: 128 * 1024 * 1024 });
    const fetcher = async value => {
      const url = new URL(value); calls.push(url.href);
      if (url.hostname === 'np-cnotice-stock.eastmoney.com' && url.searchParams.get('art_code') === input.item.id) return new Response(JSON.stringify({ success: 1, data: {
        art_code: input.item.id, notice_title: input.item.title, notice_date: input.item.date, page_index: 1, page_size: 1,
        security: [{ stock: input.symbol.slice(2), market_uni: '1' }], notice_content: '详见附件', is_ai_summary: 0,
        attach_url: `https://pdf.dfcfw.com/pdf/H2_${input.item.id}_1.pdf`
      } }), { headers: { 'content-type': 'application/json' } });
      if (url.hostname === 'pdf.dfcfw.com') {
        const bytes = Buffer.from(url.pathname.includes(input.blankItem.id) ? input.blankPdf : input.pdf, 'base64');
        return new Response(bytes, { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) } });
      }
      throw Error(`Unexpected fixture request: ${url.href}`);
    };
    const service = new CompanyEvidenceSource(fetcher, { parser: pool, directory: input.cachePath, clock: () => Date.parse(input.now), onProgress: item => progress.push(item) });
    try {
    const document = await service.body(input.item, input.symbol);
    let blankError = '';
    try { await service.pdf(input.blankItem, input.symbol, `https://pdf.dfcfw.com/pdf/H2_${input.blankItem.id}_1.pdf`); }
    catch (error) { blankError = error.message; }
    let mainTicks = 0; const heartbeat = setInterval(() => mainTicks++, 10);
    let nativeCheckboxes, ocr;
    try {
      [nativeCheckboxes, ocr] = await Promise.all([
        service.parser.parse(Buffer.from(input.nativeCheckboxes, 'base64')),
        service.parser.parse(Buffer.from(input.ocr, 'base64'))
      ]);
    } finally { clearInterval(heartbeat); }
    const nativeSymbols = await service.parser.parse(Buffer.from(input.nativeSymbols, 'base64'));
    const nativeOptions = await service.parser.parse(Buffer.from(input.nativeOptions, 'base64'));
    const nativeEmbedded = await service.parser.parse(Buffer.from(input.nativeEmbedded, 'base64'));
    const children = [...pool.workers].map(slot => slot.child);
    await service.destroy();
    const aliveAfterDestroy = children.filter(child => { try { process.kill(child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }).map(child => child.pid);
    return { sourcePath, pdfPath, pdfVersion, document, calls, progress, blankError,
      pool: { mainPid: process.pid, mainTicks, workerPath: pool.workerPath, execPath: pool.execPath,
        workerPids: [nativeCheckboxes.timings.workerPid, ocr.timings.workerPid], documentPid: document.timings.workerPid,
        workersAfterDestroy: pool.workers.size, retiringAfterDestroy: pool.retiring.size, aliveAfterDestroy,
        exitStatuses: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })) },
      ocr: { complete: ocr.complete, hasOcrPages: ocr.hasOcrPages, numericEligible: ocr.numericEligible,
        text: ocr.text, page: ocr.pageTexts[0], sourceHash: ocr.sourceHash },
      native: { checkboxes: { complete: nativeCheckboxes.complete, ocr: nativeCheckboxes.hasOcrPages,
        mapped: nativeCheckboxes.pageTexts[0].verifiedCheckboxes.length, text: nativeCheckboxes.pageTexts[0].text },
        options: { complete: nativeOptions.complete, ocr: nativeOptions.hasOcrPages, pages: nativeOptions.pages, text: nativeOptions.text },
        embedded: { complete: nativeEmbedded.complete, ocr: nativeEmbedded.hasOcrPages, numericEligible: nativeEmbedded.numericEligible,
          parserVersion: nativeEmbedded.parserVersion, mapped: nativeEmbedded.pageTexts.map(row => row.verifiedCheckboxes?.length || 0),
          fontIdentities: nativeEmbedded.pageTexts.flatMap(row => row.verifiedCheckboxes || []).map(proof => proof.fontIdentity) },
        symbols: { complete: nativeSymbols.complete, ocr: nativeSymbols.hasOcrPages,
          mapped: nativeSymbols.pageTexts.reduce((sum, page) => sum + (page.verifiedGlyphs?.length || 0), 0) } } };
    } finally { await service.destroy(); }
  }, { item, blankItem, symbol, now: NOW, cachePath, pdf: pdfBytes.toString('base64'), blankPdf: blankPdfBytes.toString('base64'),
    nativeCheckboxes: fs.readFileSync(path.join(root, 'tests/fixtures/company-native-checkboxes.pdf')).toString('base64'),
    nativeOptions: fs.readFileSync(path.join(root, 'tests/fixtures/company-native-option-variants.pdf')).toString('base64'),
    nativeEmbedded: fs.readFileSync(path.join(root, 'tests/fixtures/company-native-embedded-checkboxes.pdf')).toString('base64'),
    nativeSymbols: fs.readFileSync(path.join(root, 'tests/fixtures/company-native-symbols.pdf')).toString('base64'),
    ocr: fs.readFileSync(path.join(root, 'tests/fixtures/company-ocr-page.png')).toString('base64') });
  assert.ok(parsed.sourcePath.startsWith(archive + path.sep)); assert.ok(parsed.pdfPath.startsWith(archive + path.sep));
  assert.equal(parsed.pdfVersion, '6.4.299'); assert.equal(parsed.document.format, 'pdf-text'); assert.equal(parsed.document.pages, 2);
  assert.equal(parsed.document.complete, true);
  for (const line of expectedLines) assert.ok(parsed.document.text.includes(line), `PDF text missing: ${line}`);
  assert.ok(parsed.progress.some(item => item.format === 'pdf' && item.page === 2 && item.pages === 2));
  assert.match(parsed.blankError, /第 2 页.*(?:有效文字过少|置信度)/);
  assert.equal(parsed.calls.filter(url => new URL(url).hostname === 'np-cnotice-stock.eastmoney.com').length, 1);
  assert.equal(parsed.calls.filter(url => new URL(url).hostname === 'pdf.dfcfw.com').length, 2);
  assert.equal(parsed.native.checkboxes.complete, true); assert.equal(parsed.native.checkboxes.ocr, false);
  assert.equal(parsed.native.checkboxes.mapped, 7); assert.match(parsed.native.checkboxes.text, /44,034\.73 元/);
  assert.equal(parsed.native.symbols.complete, true); assert.equal(parsed.native.symbols.ocr, false); assert.ok(parsed.native.symbols.mapped >= 6);
  assert.equal(parsed.native.options.complete, true); assert.equal(parsed.native.options.ocr, false); assert.equal(parsed.native.options.pages, 2);
  assert.match(parsed.native.options.text.replace(/\s/g, ''), /口适用☑不适用/); assert.match(parsed.native.options.text.replace(/\s/g, ''), /□适用□☑不适用/);
  assert.match(parsed.native.options.text, /45,015,274,477\.23/); assert.match(parsed.native.options.text, /13,213,250\.21/);
  assert.equal(parsed.native.embedded.complete, true); assert.equal(parsed.native.embedded.ocr, false);
  assert.equal(parsed.native.embedded.numericEligible, true); assert.equal(parsed.native.embedded.parserVersion, require('../core/company-document-parser.cjs').PARSER_VERSION);
  assert.deepEqual(parsed.native.embedded.mapped, [6, 1]);
  assert.ok(parsed.native.embedded.fontIdentities.every(proof => proof.originalFontName === 'CIDFont+F5'
    && proof.basis === 'pdfjs-embedded-sfnt-name-table' && /^[a-f0-9]{64}$/.test(proof.decodedFontSha256)));
  assert.ok(parsed.pool.workerPath.startsWith(archive + path.sep)); assert.equal(path.resolve(parsed.pool.execPath), executable);
  assert.equal(new Set(parsed.pool.workerPids).size, 2); assert.ok(parsed.pool.workerPids.every(pid => Number.isSafeInteger(pid) && pid !== parsed.pool.mainPid));
  assert.ok(Number.isSafeInteger(parsed.pool.documentPid) && parsed.pool.documentPid !== parsed.pool.mainPid);
  assert.ok(parsed.pool.mainTicks >= 2); assert.equal(parsed.pool.workersAfterDestroy, 0); assert.equal(parsed.pool.retiringAfterDestroy, 0);
  assert.deepEqual(parsed.pool.aliveAfterDestroy, []); assert.ok(parsed.pool.exitStatuses.every(child => child.exitCode !== null || child.signalCode !== null));
  assert.equal(parsed.ocr.complete, true); assert.equal(parsed.ocr.hasOcrPages, true); assert.equal(parsed.ocr.numericEligible, false);
  assert.ok(parsed.ocr.page.confidence >= 85); assert.equal(parsed.ocr.page.numericEligible, false);
  assert.match(parsed.ocr.text.replace(/\s/g, ''), /本地识别测试报告/); assert.match(parsed.ocr.text, /Company annual report/i);
  assert.match(parsed.ocr.page.issues.join(';'), /ocr-numbers-unverified/);
  checks.push('production source falls back from short nonempty notice text to the complete two-page PDF; an unverified textless page still cannot pass completeness');
  checks.push('ASAR parser preserves reviewed real native checkbox and list-symbol pages, their checked alternatives and financial amount without OCR');
  checks.push('packaged parser 4 verifies the embedded Wingdings2 identity of two real anonymous-CID pages, preserving all seven choices without OCR');
  checks.push('the production process pool runs real native PDF and local Chinese/English OCR concurrently in two packaged child processes, keeps the main process responsive and destroys both processes completely');

  for (const [width, height] of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#agency-pool-card').screenshot({ path: path.join(output, `packaged-legacy-pool-${width}.png`) });
  }
  current = await call('state'); inactive(current, legacy);
  await close(); current = await launch(); inactive(current, legacy);
  const restored = await desktop.evaluate(async ({ app }, input) => {
    const mainRequire = process.mainModule.require.bind(process.mainModule), path = mainRequire('node:path');
    const bundledRequire = mainRequire('node:module').createRequire(path.join(app.getAppPath(), 'package.json'));
    const { CompanyEvidenceSource } = bundledRequire('./core/company-evidence-source.cjs'), { CompanyDocumentPool } = bundledRequire('./core/company-document-pool.cjs');
    let requests = 0;
    const pool = new CompanyDocumentPool(), service = new CompanyEvidenceSource(async () => { requests++; throw Error('Restart must use the verified immutable PDF cache'); },
      { parser: pool, directory: input.cachePath, clock: () => Date.parse(input.now) });
    try { const document = await service.body(input.item, input.symbol); return { document, requests, spawnedWorkers: pool.workers.size }; }
    finally { await service.destroy(); }
  }, { item, symbol, cachePath, now: NOW });
  assert.equal(restored.requests, 0); assert.equal(restored.spawnedWorkers, 0); assert.equal(restored.document.cached, true); assert.equal(restored.document.text, parsed.document.text);
  assert.equal(restored.document.textHash, parsed.document.textHash); assert.equal(restored.document.fetchedAt, parsed.document.fetchedAt);
  assert.match(await page.locator('#agency-pool-evidence-summary').innerText(), /旧版研究证据结果/);
  checks.push('full packaged restart restores PDF text/hash/time from the isolated disk cache without fetching or falsely refreshing evidence, and preserves historical policy-1 results');
  assert.equal(parsed.document.downloadBytes, pdfBytes.length, 'download size must be preserved when PDF.js transfers its input buffer');
  assert.deepEqual(errors, []);
  const report = { status: 'passed', checkedAt: new Date().toISOString(), version, output, dataPath, cachePath, executable, packaged, sessions,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
    pdf: { resolvedModule: parsed.pdfPath, version: parsed.pdfVersion, bytes: pdfBytes.length, downloadBytes: parsed.document.downloadBytes, pages: parsed.document.pages,
      text: parsed.document.text, textHash: parsed.document.textHash, format: parsed.document.format, completeness: parsed.document.completeness,
      cacheRestored: true, blankPageError: parsed.blankError, fixtureRequests: parsed.calls, nativeGlyphs: parsed.native, pool: parsed.pool, ocr: parsed.ocr },
    account: { oldPolicy: current.agencyPool.lastResult.policyVersion, nextPolicy: current.agencyPool.policy.version, cash: current.account.cash,
      trades: current.account.trades.length, orders: current.account.orders.length, positions: current.account.lots.length,
      modes: current.agency.groups.map(group => ({ id: group.id, mode: group.mode, cash: group.cash })) }, errors, checks };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  console.error(error.stack); console.error('Output:', output);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(close);
