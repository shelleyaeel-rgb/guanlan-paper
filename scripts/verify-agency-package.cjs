// Actual portable startup and byte-for-byte archive verification. Uses a new
// isolated account; strategies paused, no simulated orders, no real execution.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), net = require('node:net'), crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { fileURLToPath } = require('node:url');
const { chromium } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), asar = require('@electron/asar'), version = require('../package.json').version;
const output = fs.mkdtempSync(path.join(root, 'work/agency-package-')), dataPath = path.join(output, 'account');
assert.equal(path.dirname(output), path.join(root, 'work'));
const executable = path.join(root, `dist/Guanlan-${version}-win-x64.exe`);
const sourceFiles = ['main.cjs', 'preload.cjs', ...['core', 'ui', 'assets'].flatMap(dir => fs.readdirSync(path.join(root, dir), { recursive: true })
  .filter(file => fs.statSync(path.join(root, dir, file)).isFile()).map(file => `${dir}/${file.replaceAll('\\', '/')}`))];
function verifyArchive(archive) {
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
  for (const file of sourceFiles) assert.ok(asar.extractFile(archive, file).equals(fs.readFileSync(path.join(root, file))), file);
  const actual = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')).filter(file => !asar.statFile(archive, file).files).sort();
  assert.deepEqual(actual, [...sourceFiles, 'package.json'].sort());
  return { archive, sourceFiles: sourceFiles.length, byteComparison: 'passed', fileAllowlist: 'passed' };
}
let child, browser;
(async () => {
  const unpacked = verifyArchive(path.join(root, 'dist/win-unpacked/resources/app.asar'));
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
  assert.equal(await page.evaluate(() => state.agency.runtime.decisionMode), 'rules');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'portable-rule-agency.png'), fullPage: true });
  const account = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length,
    cash: state.account.cash, manualCash: state.agency.manualCash, groups: state.agency.groups.map(g => ({ id: g.id, cash: g.cash, mode: g.mode })),
    decisionMode: state.agency.runtime.decisionMode, intervalSeconds: state.agency.runtime.intervalSeconds }));
  assert.equal(account.trades, 0); assert.equal(account.orders, 0); assert.equal(account.decisionMode, 'rules'); assert.equal(account.intervalSeconds, 300);
  assert.equal(account.cash, account.manualCash); assert.ok(account.groups.every(g => g.cash === 0 && g.mode === 'paused'));
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), version, output, dataPath, executable, bytes: fs.statSync(executable).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), unpacked, portable, account, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); console.error('Output:', output); process.exitCode = 1; }).finally(async () => {
  if (browser) { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close').catch(() => {}); await browser.close(); }
  if (child && !browser) child.kill();
});
