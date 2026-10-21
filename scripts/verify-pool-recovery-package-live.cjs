// Real public disclosure requests through the released Electron transport.
// Uses only a new, paused virtual account and a separate evidence cache.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.env.GUANLAN_PACKAGE_EXE || 'releases/pool-recovery/win-unpacked/Guanlan.exe');
const output = fs.mkdtempSync(path.join(root, 'work/pool-recovery-package-live-'));
const dataPath = path.join(output, 'account'), cachePath = path.join(output, 'research');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('GUANLAN_TEST_')) delete env[key];
const report = { startedAt: new Date().toISOString(), output, executable, scope: '仅一份曾失败的真实公告；隔离账户，未更新候选池' };
let desktop;
(async () => {
  const archive = path.join(path.dirname(executable), 'resources/app.asar');
  const files = ['core/agency-screening.cjs', 'core/screener.cjs', 'core/agency-pool.cjs', 'core/agency-pool-diagnostics.cjs',
    'core/company-evidence-source.cjs', 'core/company-evidence-transport.cjs', 'main.cjs', 'preload.cjs', 'ui/agency.js'];
  for (const file of files) if (fs.existsSync(path.join(root, file))) assert.ok(asar.extractFile(archive, path.normalize(file)).equals(fs.readFileSync(path.join(root, file))), file);
  report.comparedFiles = files;
  desktop = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${dataPath}`], cwd: root, env, timeout: 60000 });
  const page = await desktop.firstWindow();
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), dataPath);
  await page.locator('[data-page="agency"]').click();
  assert.equal(await page.locator('#agency-pool-retry').isVisible(), false);
  const before = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length, cash: state.account.cash,
    groups: state.agency.groups.map(g => ({ mode: g.mode, cash: g.cash })), pool: state.agencyPool.lastResult }));
  assert.equal(before.trades, 0); assert.equal(before.orders, 0); assert.equal(before.pool, null); assert.ok(before.groups.every(g => g.mode === 'paused'));
  report.disclosure = await desktop.evaluate(async ({ app, net }, { cachePath }) => {
    const mainRequire = process.mainModule.require.bind(process.mainModule), path = mainRequire('node:path');
    const bundledRequire = mainRequire('node:module').createRequire(path.join(app.getAppPath(), 'package.json'));
    const { CompanyEvidenceSource } = bundledRequire('./core/company-evidence-source.cjs');
    const requests = [], source = new CompanyEvidenceSource(async (url, options) => {
      const startedAt = Date.now(), record = { host: new URL(url).hostname, startedAt }; requests.push(record);
      try { const response = await net.fetch(url, options); record.status = response.status; record.elapsedMs = Date.now() - startedAt; return response; }
      catch (error) { record.error = error.message; record.elapsedMs = Date.now() - startedAt; throw error; }
    }, { directory: cachePath });
    const item = { id: 'AN202603261820773087', title: '中国海油:中国海洋石油有限公司2025年年度报告', date: '2026-03-27',
      kind: 'annual-report', reportDate: '2025-12-31', period: '2025年度' };
    const result = { symbol: 'sh600938', id: item.id, requests };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 180000);
    try {
      source.beginBatch({ retry: true });
      const document = await source.body(item, result.symbol, controller.signal);
      result.status = 'complete'; result.document = { id: document.id, issuer: document.issuerSymbol, format: document.format,
        pages: document.pages, complete: document.complete, characters: document.characters, hash: document.sourceHash,
        ocrPages: document.pageTexts.filter(page => page.method === 'ocr').length };
      const count = requests.length, cached = await source.body(item, result.symbol, controller.signal);
      result.cached = cached.cached === true; result.requestsForCachedRead = requests.length - count;
    } catch (error) { result.status = 'pending'; result.error = error.message; result.acquisition = error.acquisition; }
    finally { clearTimeout(timer); await source.destroy(); }
    return result;
  }, { cachePath });
  assert.ok(report.disclosure.requests.some(request => request.host === 'np-cnotice-stock.eastmoney.com' && request.status === 200), 'real body API must return successfully');
  assert.ok(report.disclosure.requests.some(request => request.host === 'pdf.dfcfw.com' && request.status === 200), 'real original PDF must download');
  if (report.disclosure.status === 'complete') { assert.equal(report.disclosure.document.issuer, 'sh600938'); assert.equal(report.disclosure.cached, true); assert.equal(report.disclosure.requestsForCachedRead, 0); }
  const after = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length, cash: state.account.cash,
    groups: state.agency.groups.map(g => ({ mode: g.mode, cash: g.cash })), pool: state.agencyPool.lastResult }));
  assert.deepEqual(after, before); report.accountUnchanged = true; report.ok = true;
})().catch(error => { report.ok = false; report.error = error.message; process.exitCode = 1; }).finally(async () => {
  if (desktop) await desktop.close();
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
