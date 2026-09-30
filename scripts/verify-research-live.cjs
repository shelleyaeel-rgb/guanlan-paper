// Read-only live research check. All account files remain in work/research-live-*.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'); fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/research-live-')), dataPath = path.join(output, 'account');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.GUANLAN_TEST_CONTROL;
const packaged = !!process.env.GUANLAN_PACKAGE_EXE;
if (packaged && path.basename(process.env.GUANLAN_PACKAGE_EXE) !== 'Guanlan.exe') throw Error('Use verify-research-portable.cjs for the portable launcher; this script accepts the unpacked Guanlan.exe');
let desktop, page; const errors = [], samples = [];
const idle = () => page.waitForFunction(() => typeof researchSymbol !== 'undefined' && researchSymbol && !researchLoading.size);
(async () => {
  desktop = await _electron.launch({ executablePath: packaged ? path.resolve(process.env.GUANLAN_PACKAGE_EXE) : require('electron'), args: packaged ? [`--user-data-dir=${dataPath}`] : [root, `--test-data-dir=${dataPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account); await idle();
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), dataPath);
  for (const symbol of ['sh600519', 'sz000001', 'sz300750', 'sh688981']) {
    await page.evaluate(symbol => selectStock(symbol), symbol); await page.locator('#research-tab-company').click(); await idle();
    await page.locator('#research-tab-notices').click(); await idle();
    const snapshot = await page.evaluate(() => ({ symbol: researchSymbol, data: researchData }));
    for (const section of ['profile', 'finance', 'valuation', 'notices']) assert.equal(snapshot.data[section].status, 'ready', `${symbol} ${section}: ${snapshot.data[section].error}`);
    assert.equal(snapshot.symbol, symbol); assert.equal(snapshot.data.finance.data.annual.length, 3);
    assert.ok(snapshot.data.notices.data.items.length > 0);
    samples.push(snapshot); console.log('Live research verified:', symbol);
  }
  await page.screenshot({ path: path.join(output, 'live-notices.png'), fullPage: true });
  await page.locator('#research-tab-company').click(); await idle();
  await page.locator('.research-card').screenshot({ path: path.join(output, 'live-company.png') });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.research-card').screenshot({ path: path.join(output, 'live-company-small.png') });
  const account = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length }));
  assert.deepEqual(account, { trades: 0, orders: 0 }); assert.deepEqual(errors, []);
  const version = await desktop.evaluate(({ app }) => app.getVersion());
  assert.equal(version, require('../package.json').version);
  let archive = null;
  if (packaged) {
    const crypto = require('node:crypto');
    const files = ['main.cjs', 'preload.cjs', ...['core', 'ui'].flatMap(dir => fs.readdirSync(path.join(root, dir)).map(file => `${dir}/${file}`))];
    const expected = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
    archive = await desktop.evaluate(({ app }, expected) => {
      const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path'), crypto = process.getBuiltinModule('node:crypto');
      const base = app.getAppPath();
      return { path: base, files: Object.keys(expected).length, mismatches: Object.entries(expected).filter(([file, hash]) => crypto.createHash('sha256').update(fs.readFileSync(path.join(base, file))).digest('hex') !== hash).map(([file]) => file), testsIncluded: fs.existsSync(path.join(base, 'tests')) };
    }, expected);
    assert.deepEqual(archive.mismatches, []); assert.equal(archive.testsIncluded, false);
  }
  const report = { checkedAt: new Date().toISOString(), output, packaged, version, samples, account, errors, archive };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, packaged, version, account, errors, stocks: samples.length, archive }, null, 2));
})().catch(async e => { console.error(e); console.error('Output:', output); if (page) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
