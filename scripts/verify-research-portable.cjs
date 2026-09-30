// Verify the actual portable launcher and its extracted archive using a local CDP connection.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { setTimeout: delay } = require('node:timers/promises');
const { fileURLToPath } = require('node:url'), net = require('node:net'), crypto = require('node:crypto');
const { chromium } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), asar = require(path.join(root, 'node_modules/@electron/asar'));
const version = require(path.join(root, 'package.json')).version;
const output = process.env.GUANLAN_PORTABLE_ATTACH || fs.mkdtempSync(path.join(root, 'work/research-portable-')), dataPath = path.join(output, 'account');
if (!path.resolve(output).startsWith(path.join(root, 'work') + path.sep)) throw Error('An isolated workspace test directory is required');
const executable = path.join(root, `dist/Guanlan-${version}-win-x64.exe`);
const sourceFiles = ['main.cjs', 'preload.cjs', ...['core', 'ui', 'assets'].flatMap(dir => fs.readdirSync(path.join(root, dir), { recursive: true }).filter(f => fs.statSync(path.join(root, dir, f)).isFile()).map(f => `${dir}/${f.replaceAll('\\', '/')}`))];
function verifyArchive(archive) {
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
  for (const f of sourceFiles) assert.ok(asar.extractFile(archive, f).equals(fs.readFileSync(path.join(root, f))), f);
  const files = asar.listPackage(archive).map(f => f.replaceAll('\\', '/').replace(/^\//, '')).filter(f => !asar.statFile(archive, f).files).sort();
  assert.deepEqual(files, [...sourceFiles, 'package.json'].sort());
  return { archive, sourceFiles: sourceFiles.length, byteComparison: 'passed', fileAllowlist: 'passed' };
}
let child, browser;
(async () => {
  const unpacked = verifyArchive(path.join(root, 'dist/win-unpacked/resources/app.asar'));
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = process.env.GUANLAN_PORTABLE_ATTACH ? Number(fs.readFileSync(path.join(dataPath, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]) : server.address().port; await new Promise(resolve => server.close(resolve));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.GUANLAN_TEST_CONTROL;
  if (!process.env.GUANLAN_PORTABLE_ATTACH) child = spawn(executable, [`--user-data-dir=${dataPath}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  let exited = false; child?.on('exit', () => { exited = true; });
  let connected = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { connected = true; break; } } catch {}
    if (exited) throw Error('Portable exited before startup');
    await delay(300);
  }
  assert.ok(connected, 'portable debugger available');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0], errors = [], samples = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account && !detailBusy);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), dataPath);
  assert.ok((await page.locator('.version').innerText()).includes(`v${version}`));
  const portable = verifyArchive(path.resolve(path.dirname(fileURLToPath(page.url())), '..'));
  for (const symbol of ['sh600519', 'sz000001', 'sz300750', 'sh688981']) {
    await page.evaluate(symbol => selectStock(symbol), symbol);
    await page.locator('#research-tab-company').click();
    await page.waitForFunction(() => !researchLoading.size);
    await page.locator('#research-tab-notices').click();
    await page.waitForFunction(() => !researchLoading.size);
    const sample = await page.evaluate(() => ({ symbol: researchSymbol, data: researchData }));
    assert.equal(sample.symbol, symbol);
    for (const section of ['profile', 'finance', 'valuation', 'notices']) assert.equal(sample.data[section].status, 'ready', symbol + ' ' + section + ': ' + sample.data[section].error);
    samples.push(sample); console.log('Portable research verified:', symbol);
  }
  await page.locator('#research-tab-company').click(); await page.waitForFunction(() => !researchLoading.size);
  await page.locator('.research-card').screenshot({ path: path.join(output, 'portable-company.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, 'portable-research.png'), fullPage: true });
  const account = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length }));
  assert.deepEqual(account, { trades: 0, orders: 0 }); assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), version, output, executable, bytes: fs.statSync(executable).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), unpacked, portable, samples, errors, account };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, version, unpacked, portable, account, errors, stocks: samples.length, sha256: report.sha256 }, null, 2));
})().catch(error => { console.error(error); console.error('Output:', output); process.exitCode = 1; }).finally(async () => {
  if (browser) { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close').catch(() => {}); await browser.close(); }
  if (child && !browser) child.kill();
});
