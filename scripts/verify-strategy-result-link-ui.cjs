// Verify applied screener results carry their strategy through the real UI and IPC.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/strategy-result-link-ui-'));
const controlPath = path.join(output, 'control.json'), accountPath = path.join(output, 'account');
fs.writeFileSync(controlPath, JSON.stringify({ now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready' }));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page; const errors = [], checks = [];
async function state() { return page.evaluate(async () => { const result = await window.guanlan.call('state'); if (!result.ok) throw Error(result.error); return result.data; }); }
async function run(strategyId) {
  await page.locator('#screen-strategy').selectOption(strategyId);
  await page.locator('#screen-run').click();
  await page.waitForFunction(id => !screenBusy && screenResult?.strategyId === id && screenResult?.matched > 0, strategyId);
}
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/strategy-modes-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.strategyProfiles?.length === 4);
  assert.equal(path.resolve((await state()).dataPath), path.resolve(accountPath));
  await page.locator('[data-page="screener"]').click();
  await page.waitForFunction(() => typeof screenMeta !== 'undefined' && screenMeta?.strategies?.length === 4);
  await run('short');
  assert.equal(await page.evaluate(() => screenResult.matched), 4);
  const applied = await page.evaluate(() => ({ strategyId: screenResult.strategyId, query: screenResult.query, rows: screenResult.rows.map(row => row.symbol) }));
  await page.locator('#screen-strategy').selectOption('long');
  assert.equal(await page.evaluate(() => screenStrategyId), 'long');
  assert.equal(await page.evaluate(() => screenResult.strategyId), 'short');
  assert.deepEqual(await page.evaluate(() => ({ strategyId: screenResult.strategyId, query: screenResult.query, rows: screenResult.rows.map(row => row.symbol) })), applied);
  await page.locator('#screen-table [data-screen-open="sh600519"]').click();
  await page.waitForFunction(() => page === 'market' && selected === 'sh600519' && document.querySelector('#plan-strategy').value === 'short' && state.signals.sh600519?.strategyId === 'short');
  assert.equal((await state()).planSelections.sh600519, 'short');
  await page.locator('#research-evidence summary').click();
  assert.match(await page.locator('#research-evidence').innerText(), /短线.*动量跟踪/);
  await page.locator('.strategy-card').screenshot({ path: path.join(output, 'opened-applied-short-result.png') });
  checks.push('opening a short result after changing the unapplied dropdown to long uses the saved short result strategy');

  await page.waitForFunction(() => !document.querySelector('#strategy-buy').disabled);
  await page.locator('#strategy-buy').click(); await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => state.account.risks.sh600519?.strategyId === 'short');
  const before = (await state()).account.risks.sh600519;
  assert.equal(await page.locator('#plan-strategy').isDisabled(), true);
  await page.locator('[data-page="screener"]').click(); await run('long');
  assert.equal(await page.evaluate(() => screenResult.matched), 4);
  assert.equal(await page.evaluate(() => screenResult.strategyId), 'long');
  await page.locator('#screen-strategy').selectOption('ultra-short');
  assert.equal(await page.evaluate(() => screenStrategyId), 'ultra-short');
  assert.equal(await page.evaluate(() => screenResult.strategyId), 'long');
  await page.locator('#screen-table [data-screen-open="sh600519"]').click();
  await page.waitForFunction(() => page === 'market' && selected === 'sh600519' && document.querySelector('#plan-strategy').value === 'short' && document.querySelector('#plan-strategy').disabled);
  const after = (await state()).account.risks.sh600519;
  assert.equal(after.strategyId, 'short'); assert.equal(after.entryTradeId, before.entryTradeId);
  assert.equal(after.stop, before.stop); assert.equal(after.target, before.target); assert.deepEqual(after.config, before.config);
  assert.equal((await state()).account.trades.length, 1);
  assert.match(await page.locator('#plan-strategy-lock').innerText(), /短线/);
  if (!(await page.locator('#research-evidence').evaluate(element => element.open))) await page.locator('#research-evidence summary').click();
  assert.match(await page.locator('#research-evidence').innerText(), /长线.*质量估值/);
  await page.locator('.strategy-card').screenshot({ path: path.join(output, 'existing-short-holding-from-long-result.png') });
  checks.push('opening a long result for an existing short holding keeps its original strategy, prices, config and locked selector');
  assert.deepEqual(errors, []);
  const report = { output, accountPath, errors, checks };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  console.error(error); console.error('Output:', output);
  if (page && !page.isClosed()) { console.error(await page.locator('#screen-error').innerText()); await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }); }
  process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
