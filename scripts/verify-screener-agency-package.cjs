// Starts the real portable build with a new account. Screening rows below are
// explicitly renderer-only fixtures: never fetch a screener universe or submit them.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), net = require('node:net'), crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { fileURLToPath } = require('node:url');
const { chromium } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), asar = require('@electron/asar'), version = require('../package.json').version;
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/screener-agency-package-')), dataPath = path.join(output, 'account');
assert.equal(path.dirname(output), path.join(root, 'work'));
const executable = process.env.GUANLAN_PACKAGE_EXE ? path.resolve(process.env.GUANLAN_PACKAGE_EXE) : path.join(root, `dist/Guanlan-${version}-batch-win-x64.exe`);
const sourceFiles = ['main.cjs', 'preload.cjs', ...['core', 'ui', 'assets'].flatMap(dir => fs.readdirSync(path.join(root, dir), { recursive: true })
  .filter(file => fs.statSync(path.join(root, dir, file)).isFile()).map(file => `${dir}/${file.replaceAll('\\', '/')}`))];
function verifyArchive(archive) {
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
  for (const file of sourceFiles) assert.ok(asar.extractFile(archive, file).equals(fs.readFileSync(path.join(root, file))), `packaged file differs: ${file}`);
  const actual = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')).filter(file => !asar.statFile(archive, file).files).sort();
  assert.deepEqual(actual, [...sourceFiles, 'package.json'].sort());
  return { archive, sourceFiles: sourceFiles.length, byteComparison: 'passed', fileAllowlist: 'passed' };
}
let child, browser, page; const errors = [], checks = [];
(async () => {
  assert.ok(fs.existsSync(executable), `Build the portable executable first: ${executable}`);
  const unpacked = verifyArchive(path.join(root, 'dist/win-unpacked/resources/app.asar'));
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('GUANLAN_TEST_')) delete env[key];
  child = spawn(executable, [`--user-data-dir=${dataPath}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  let exited = false; child.on('exit', () => { exited = true; });
  let connected = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { connected = true; break; } } catch {}
    if (exited) throw Error('Portable exited before the isolated window started');
    await delay(300);
  }
  assert.ok(connected, 'portable exposes its isolated local debugging endpoint');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts()[0].pages()[0]; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), dataPath);
  assert.ok((await page.locator('.version').innerText()).includes(`v${version}`));
  const portable = verifyArchive(path.resolve(path.dirname(fileURLToPath(page.url())), '..'));
  checks.push('unpacked and actual portable archives match every current application source file byte for byte and contain only packaged application files');

  assert.equal(await page.locator('#screen-agency-all').isDisabled(), true);
  for (const selector of ['#screen-agency-dialog', '#screen-agency-strategy', '#screen-agency-submit', '#screen-agency-result', '#screen-agency-details']) {
    assert.equal(await page.locator(selector).count(), 1, `${selector} is packaged`);
  }
  const validation = await page.evaluate(() => window.guanlan.call('agency:members:add', { strategyId: 'swing', symbols: [] }));
  assert.equal(validation.ok, false); assert.match(validation.error, /1.*15000.*批量加入/);
  checks.push('batch controls are present and initially disabled; the production preload exposes the batch IPC and empty input reaches business validation');

  await page.locator('[data-page="agency"]').click();
  assert.equal(await page.locator('#agency-tabs [data-agency-tab]').count(), 4);
  for (const selector of ['#agency-member-search', '#agency-member-held', '#agency-member-prev', '#agency-member-next', '#agency-member-page-info']) {
    assert.equal(await page.locator(selector).count(), 1, `${selector} is packaged`);
  }
  assert.equal(await page.locator('#agency-member-prev').isDisabled(), true);
  assert.equal(await page.locator('#agency-member-next').isDisabled(), true);
  assert.match(await page.locator('#agency-member-page-info').innerText(), /第 1 \/ 1 页.*0 只/);
  const runtime = await page.evaluate(() => state.agency.runtime);
  assert.equal(runtime.decisionMode, 'rules'); assert.equal(runtime.intervalSeconds, 300); assert.equal(runtime.batchSize, 20);
  assert.ok(runtime.coverage && typeof runtime.coverage === 'object' && !Array.isArray(runtime.coverage));
  checks.push('member paging, search and held-position controls load; production runtime exposes 20-member checking batches and coverage');
  await page.screenshot({ path: path.join(output, 'portable-empty-agency.png'), fullPage: true });

  // Suppress first-entry automatic screening, then render an explicit in-memory
  // fixture. This exercises packaged handlers/layout without requesting live rows.
  await page.evaluate(async () => { await loadScreenMeta(); screenInitialized = true; });
  await page.locator('[data-page="screener"]').click();
  assert.equal(await page.locator('#screen-agency-all').isDisabled(), true);
  await page.evaluate(() => {
    const now = Date.now();
    screenResult = {
      status: 'ready', matched: 135, dataMode: 'historical', strategyId: 'long', strategyName: '隔离验证 fixture',
      source: '仅用于便携版界面验证的内存 fixture，不代表真实选股结果', labels: ['隔离验证 fixture'],
      startedAt: now, fetchedAt: now, oldestQuote: now, newestQuote: now, eligibleCount: 135, poolCount: 135, evaluatedCount: 135,
      missing: 0, missingByField: {}, requiredFields: [], query: { scope: 'all', boards: [], excludeST: false, rules: [] },
      dataMessage: '此处为界面验证 fixture，仅打开并取消弹窗，不提交股票。',
      rows: Array.from({ length: 135 }, (_, index) => ({ symbol: 'sh' + String(600001 + index), name: '隔离界面验证 ' + (index + 1), board: 'sh', price: 10, changePct: 0, turnover: 1, volumeRatio: 1, marketCap: 100, timestamp: now }))
    };
    screenDirty = false; screenBusy = false; screenTextPending = false; screenRequestFailed = false;
    renderScreenResults();
  });
  assert.equal(await page.locator('#screen-agency-all').isDisabled(), false);
  assert.match(await page.locator('#screen-agency-all').innerText(), /135/);
  await page.locator('#screen-result-search').fill('600001');
  assert.equal(await page.locator('#screen-table tbody tr').count(), 1);
  await page.locator('#screen-agency-all').click();
  assert.equal(await page.locator('#screen-agency-strategy').inputValue(), 'long');
  const summary = await page.locator('#screen-agency-summary').innerText();
  assert.match(summary, /135/); assert.match(summary, /所有分页/); assert.match(summary, /历史快照/);
  for (const [width, height] of [[1120, 760], [1536, 960]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(() => { const dialog = document.querySelector('#screen-agency-dialog'); return dialog.scrollWidth <= dialog.clientWidth; }), true);
    await page.screenshot({ path: path.join(output, `portable-batch-confirm-${width}.png`) });
  }
  await page.locator('#screen-agency-close').click();
  assert.equal(await page.evaluate(() => document.querySelector('#screen-agency-dialog').open), false);
  checks.push('an explicitly labelled renderer fixture opens the all-135 dialog despite one searched row, selects the result strategy, identifies historical data, fits both widths and cancels');

  const account = await page.evaluate(async () => {
    const result = await window.guanlan.call('state'); if (!result.ok) throw Error(result.error);
    const current = result.data;
    return { trades: current.account.trades.length, orders: current.account.orders.length, transfers: current.account.agency.transfers.length,
      cash: current.account.cash, manualCash: current.agency.manualCash,
      groups: current.agency.groups.map(group => ({ id: group.id, cash: group.cash, mode: group.mode, members: group.members.length })),
      decisionMode: current.agency.runtime.decisionMode, intervalSeconds: current.agency.runtime.intervalSeconds, batchSize: current.agency.runtime.batchSize };
  });
  assert.equal(account.trades, 0); assert.equal(account.orders, 0); assert.equal(account.transfers, 0);
  assert.equal(account.cash, account.manualCash); assert.ok(account.groups.every(group => group.cash === 0 && group.mode === 'paused' && group.members === 0));
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), version, output, dataPath, executable, bytes: fs.statSync(executable).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), unpacked, portable, account, runtime, errors, checks };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  console.error(error); console.error('Output:', output);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  if (browser) { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close').catch(() => {}); await browser.close(); }
  if (child && !browser) child.kill();
});
