// Actual portable startup and byte-for-byte archive verification. Uses a new
// isolated account; strategies paused, no simulated orders, no real execution.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), net = require('node:net'), crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { fileURLToPath } = require('node:url');
const { chromium } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), asar = require('@electron/asar'), version = require('../package.json').version;
const output = fs.mkdtempSync(path.join(root, 'work/automatic-research-portable-')), dataPath = path.join(output, 'account');
assert.equal(path.dirname(output), path.join(root, 'work'));
const executable = process.env.GUANLAN_PORTABLE_EXE ? path.resolve(process.env.GUANLAN_PORTABLE_EXE)
  : path.join(root, `releases/industry-metrics/Guanlan-${version}-win-x64.exe`);
const sourceFiles = ['main.cjs', 'preload.cjs', ...['core', 'ui', 'assets'].flatMap(dir => fs.readdirSync(path.join(root, dir), { recursive: true })
  .filter(file => fs.statSync(path.join(root, dir, file)).isFile()).map(file => `${dir}/${file.replaceAll('\\', '/')}`))];
function verifyArchive(archive) {
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
  for (const file of sourceFiles) assert.ok(asar.extractFile(archive, path.normalize(file)).equals(fs.readFileSync(path.join(root, file))), file);
  const actual = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')).filter(file => !asar.statFile(archive, path.normalize(file)).files).sort();
  assert.deepEqual(actual.filter(file => !file.startsWith('node_modules/')), [...sourceFiles, 'package.json'].sort());
  assert.ok(actual.includes('node_modules/pdfjs-dist/legacy/build/pdf.mjs'));
  assert.ok(actual.includes('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'));
  const production = Object.entries(require('../package-lock.json').packages).filter(([name, info]) => name.startsWith('node_modules/') && info.dev !== true).map(([name]) => name + '/');
  assert.ok(actual.filter(file => file.startsWith('node_modules/')).every(file => production.some(prefix => file.startsWith(prefix))), 'only locked production runtime dependencies are bundled');
  for (const file of ['assets/ocr/chi_sim.traineddata', 'assets/ocr/eng.traineddata', 'node_modules/tesseract.js/src/worker-script/node/index.js', 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm']) assert.ok(asar.statFile(archive, path.normalize(file)).unpacked, `OCR needs an unpacked local resource: ${file}`);
  return { archive, sourceFiles: sourceFiles.length, byteComparison: 'passed', fileAllowlist: 'passed' };
}
let child, browser;
(async () => {
  const unpacked = verifyArchive(path.join(path.dirname(executable), 'win-unpacked/resources/app.asar'));
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.GUANLAN_TEST_CONTROL;
  child = spawn(executable, [`--user-data-dir=${dataPath}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  let exited = false; child.on('exit', () => { exited = true; });
  let connected = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { connected = true; break; } } catch {}
    if (exited) throw Error('Portable exited before the isolated window started');
    await delay(300);
  }
  assert.ok(connected);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0], errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), dataPath);
  assert.ok((await page.locator('.version').innerText()).includes(`v${version}`));
  const portable = verifyArchive(path.resolve(path.dirname(fileURLToPath(page.url())), '..'));
  await page.locator('[data-page="agency"]').click();
  await page.waitForSelector('#agency-tabs [data-agency-tab]'); assert.equal(await page.locator('#agency-tabs [data-agency-tab]').count(), 4);
  assert.equal(await page.locator('#agency-model-form').count(), 0);
  assert.equal(await page.locator('#agency-pool-run').isEnabled(), true);
  assert.equal(await page.evaluate(() => state.agencyPool.lastResult), null);
  assert.equal(await page.evaluate(() => state.agencyPool.running), false);
  assert.equal(await page.evaluate(() => state.agencyPool.policy.version), 3);
  assert.equal(await page.evaluate(() => state.agencyPool.policy.evidenceMode), 'none');
  assert.equal(await page.evaluate(() => state.agencyPool.policy.screeningMode), 'strategy');
  assert.equal(await page.evaluate(() => state.agencyPool.policies.strict.evidenceMode), 'automatic');
  assert.equal(await page.evaluate(() => state.account.agency.version), 5);
  assert.equal(await page.evaluate(() => state.agency.runtime.decisionMode), 'rules');
  assert.equal(await page.evaluate(() => state.account.version), 2);
  assert.deepEqual(await page.evaluate(() => state.agency.marketPolicy), { version: 1, enabled: true });
  assert.equal(await page.locator('#agency-market-regime').count(), 1);
  const operatingIpc = await page.evaluate(async () => {
    const meta = await window.guanlan.call('screener:meta');
    if (!meta.ok) throw Error(meta.error);
    const result = await window.guanlan.call('research:inspect', { symbol: 'sh600938', research: { version: 1, enabled: false, path: 'company', rules: [] } });
    if (!result.ok) throw Error(result.error);
    return { productFields: Object.keys(meta.data.research.fields.product), companyFields: Object.keys(meta.data.research.fields.company), performanceFields: Object.keys(meta.data.performance.fields),
      industry: meta.data.industry, longRules: meta.data.strategies.find(strategy => strategy.id === 'long').rules,
      cumulativeRoeDescription: meta.data.fields.roe.description,
      status: result.data.status, companyStatus: result.data.companyMetrics.status, companyReason: result.data.companyMetrics.error || result.data.companyMetrics.reason || null,
      reportDate: result.data.companyMetrics.reportDate, productRows: result.data.productMetrics.products.length,
      acquisitionCodes: result.data.acquisition.map(item => item.code) };
  });
  assert.equal(operatingIpc.productFields.length, 7); assert.equal(operatingIpc.companyFields.length, 4);
  assert.deepEqual(operatingIpc.performanceFields, ['netProfitGrowthMinPct', 'recurringProfitGrowthMinPct']);
  assert.equal(operatingIpc.industry.version, 1);
  assert.deepEqual(Object.keys(operatingIpc.industry.fields).sort(), ['mainRankMax', 'minSegmentRevenuePct', 'segmentRankMax']);
  assert.deepEqual(operatingIpc.industry.defaults, { version: 1, scope: 'either', mainRankMax: 3, segmentRankMax: 1, minSegmentRevenuePct: 30 });
  for (const field of Object.values(operatingIpc.industry.fields)) assert.ok(field.label && Number.isFinite(field.min) && Number.isFinite(field.max));
  assert.ok(operatingIpc.longRules.some(rule => rule.field === 'annualRoeLatest' && rule.op === 'gte' && rule.value === 8));
  assert.ok(operatingIpc.longRules.some(rule => rule.field === 'latestAdjustedProfit' && rule.op === 'gt' && rule.value === 0));
  assert.ok(!operatingIpc.longRules.some(rule => rule.field === 'roe'));
  assert.match(operatingIpc.cumulativeRoeDescription, /非年化|未年化/);
  assert.equal(await page.locator('#agency-performance-controls [data-performance-edit="enabled"]').inputValue(), 'observe');
  assert.equal(await page.locator('#agency-industry-controls').isVisible(), true);
  assert.equal(await page.locator('#agency-industry-controls [data-industry-edit="mode"]').inputValue(), 'observe');
  assert.equal(await page.locator('#agency-industry-controls input').count(), 0);
  assert.equal(await page.evaluate(() => agencyPoolIndustry()), undefined);
  assert.doesNotMatch(await page.locator('#toast').innerText(), /is not defined|Cannot read/);
  assert.equal(operatingIpc.status, 'observing'); assert.equal(operatingIpc.productRows, 0);
  assert.ok(operatingIpc.acquisitionCodes.includes('not-requested'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'portable-rule-agency.png'), fullPage: true });
  // Enter through an ordinary strategy-template button so the production
  // screener initializes without automatically starting an all-market scan.
  await page.locator('[data-page="settings"]').click();
  await page.locator('#investment-strategies [data-use-strategy="long"]').click();
  await page.waitForFunction(() => page === 'screener' && screenInitialized && !screenBusy);
  assert.equal(await page.locator('#screen-industry-controls').isVisible(), true);
  assert.equal(await page.locator('#screen-industry-controls [data-industry-edit="mode"]').inputValue(), 'observe');
  assert.equal(await page.locator('#screen-industry-controls input').count(), 0);
  assert.equal(await page.evaluate(() => screenQuery.evidence?.industry), undefined);
  assert.equal(await page.evaluate(() => screenResult), undefined, 'opening the editor must not execute a market scan');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'portable-industry-screener.png'), fullPage: true });
  const industryUi = { poolMode: 'observe', screenMode: 'observe', poolThresholdInputs: 0, screenThresholdInputs: 0, marketScanStarted: false };
  const account = await page.evaluate(async () => {
    const response = await window.guanlan.call('state'); if (!response.ok) throw Error(response.error);
    const current = response.data;
    return { trades: current.account.trades.length, orders: current.account.orders.length,
      cash: current.account.cash, manualCash: current.agency.manualCash, groups: current.agency.groups.map(g => ({ id: g.id, cash: g.cash, mode: g.mode })),
      decisionMode: current.agency.runtime.decisionMode, intervalSeconds: current.agency.runtime.intervalSeconds,
      poolRunning: current.agencyPool.running, poolResult: current.agencyPool.lastResult };
  });
  assert.equal(account.trades, 0); assert.equal(account.orders, 0); assert.equal(account.decisionMode, 'rules'); assert.equal(account.intervalSeconds, 300);
  assert.equal(account.cash, account.manualCash); assert.ok(account.groups.every(g => g.cash === 0 && g.mode === 'paused'));
  assert.equal(account.groups.length, 4); assert.equal(account.poolRunning, false); assert.equal(account.poolResult, null);
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), version, output, dataPath, executable, bytes: fs.statSync(executable).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), unpacked, portable, operatingIpc, industryUi, account, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); console.error('Output:', output); process.exitCode = 1; }).finally(async () => {
  if (browser) { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close').catch(() => {}); await browser.close(); }
  if (child && !browser) child.kill();
});
