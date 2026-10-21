// Launch the actual portable executable with an isolated account and verify
// its extracted archive plus a complete live screen. Never submit orders.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), net = require('node:net'), crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { fileURLToPath } = require('node:url');
const { chromium } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), asar = require('@electron/asar'), version = require('../package.json').version;
const { TENCENT_SCREEN_SOURCE } = require('../core/screener-tencent.cjs');
const output = fs.mkdtempSync(path.join(root, 'work/free-screener-package-')), dataPath = path.join(output, 'account');
const executable = process.env.GUANLAN_PACKAGE_EXE || path.join(root, `dist/Guanlan-${version}-screener-win-x64.exe`);
const files = ['main.cjs', 'preload.cjs', ...['core', 'ui', 'assets'].flatMap(dir => fs.readdirSync(path.join(root, dir), { recursive: true })
  .filter(file => fs.statSync(path.join(root, dir, file)).isFile()).map(file => `${dir}/${file.replaceAll('\\', '/')}`))];
function verifyArchive(archive) {
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
  for (const file of files) assert.ok(asar.extractFile(archive, file).equals(fs.readFileSync(path.join(root, file))), file);
  const packaged = asar.listPackage(archive).map(f => f.replaceAll('\\', '/').replace(/^\//, '')).filter(f => !asar.statFile(archive, f).files).sort();
  assert.deepEqual(packaged, [...files, 'package.json'].sort());
  return { archive, files: files.length, byteComparison: 'passed', fileAllowlist: 'passed' };
}
const report = { checkedAt: new Date().toISOString(), output, executable, version };
let child, browser, page;
(async () => {
  report.unpacked = verifyArchive(path.join(root, 'dist/win-unpacked/resources/app.asar'));
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.GUANLAN_TEST_CONTROL;
  child = spawn(executable, [`--user-data-dir=${dataPath}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  let exited = false; child.on('exit', () => { exited = true; });
  let connected = false;
  for (let n = 0; n < 150; n++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { connected = true; break; } } catch {}
    if (exited) throw Error('Portable exited before opening the isolated window');
    await delay(300);
  }
  assert.ok(connected);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts()[0].pages()[0]; const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), dataPath);
  report.portable = verifyArchive(path.resolve(path.dirname(fileURLToPath(page.url())), '..'));
  await page.locator('[data-page="screener"]').click();
  await page.waitForFunction(() => typeof screenBusy !== 'undefined' && !screenBusy && (!!screenResult || !document.querySelector('#screen-error').classList.contains('hidden')), null, { timeout: 150000 });
  report.live = await page.evaluate(() => screenResult ? { source: screenResult.source, eligibleCount: screenResult.eligibleCount, matched: screenResult.matched,
    dataMode: screenResult.dataMode, startedAt: screenResult.startedAt, fetchedAt: screenResult.fetchedAt, missing: screenResult.missingByField } : { error: document.querySelector('#screen-error').textContent });
  assert.equal(report.live.source, TENCENT_SCREEN_SOURCE, report.live.error);
  assert.ok(report.live.eligibleCount > 5000); assert.equal(report.live.dataMode, 'latest');
  await page.screenshot({ path: path.join(output, 'portable-latest.png'), fullPage: true });
  report.account = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length }));
  assert.deepEqual(report.account, { trades: 0, orders: 0 }); assert.deepEqual(errors, []); report.errors = errors;
  report.bytes = fs.statSync(executable).size;
  report.sha256 = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  report.ok = true;
})().catch(async e => { report.ok = false; report.error = e.message; process.exitCode = 1; if (page) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {}); })
  .finally(async () => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
    if (browser) { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close').catch(() => {}); await browser.close(); }
    if (child && !browser) child.kill();
  });
