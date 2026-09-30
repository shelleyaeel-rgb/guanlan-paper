// Optional desktop integration check: set GUANLAN_PLAYWRIGHT_PATH to an installed Playwright module.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), output = fs.mkdtempSync(path.join(root, 'work/strategy-ui-'));
const control = path.join(output, 'control.json'), errors = [];
const env = { ...process.env, GUANLAN_TEST_CONTROL: control }; delete env.ELECTRON_RUN_AS_NODE;
const scenario = (now, price) => fs.writeFileSync(control, JSON.stringify({ now, price }));
const executablePath = require('electron');
let desktop;
async function launch(entry, directory) {
  desktop = await _electron.launch({ executablePath, args: [entry, `--test-data-dir=${path.join(output, directory)}`], cwd: root, env });
  const page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  return page;
}
const getState = page => page.evaluate(async () => { const result = await window.guanlan.call('state'); if (!result.ok) throw Error(result.error); return result.data; });
async function waitState(page, predicate) {
  const start = Date.now();
  while (Date.now() - start < 45000) { const state = await getState(page); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw Error('Timed out waiting for desktop state: ' + JSON.stringify(await getState(page)));
}
const noOverflow = async page => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
(async () => {
  scenario('2026-09-29T10:00:00+08:00', 10.08);
  let page = await launch(path.join(root, 'tests/fixtures/strategy-desktop.cjs'), 'simulated-account');
  await page.waitForFunction(() => document.querySelector('#strategy-buy')?.disabled === false);
  const ready = await getState(page); assert.equal(ready.signals.sh600519.buyable, true);
  await page.screenshot({ path: path.join(output, 'ready.png'), fullPage: true }); await noOverflow(page);
  await page.locator('#strategy-buy').click(); await page.locator('#confirm-cancel').click(); assert.equal((await getState(page)).account.trades.length, 0);
  await page.locator('#strategy-buy').click(); await page.locator('#confirm-ok').click();
  await waitState(page, s => s.account.trades.length === 1);
  const bought = await getState(page), risk = bought.account.risks.sh600519;
  assert.equal(risk.dynamic, true); assert.equal(risk.enabled, true); assert.equal(risk.entryPrice, bought.account.trades[0].price);
  assert.equal(await page.locator('#risk-stop').isDisabled(), true); assert.equal(await page.locator('#risk-dynamic').isChecked(), true);
  await page.screenshot({ path: path.join(output, 'holding.png'), fullPage: true });
  await page.locator('#risk-dynamic').uncheck(); await page.locator('#risk-form button[type="submit"], #risk-form button.outline').click();
  await waitState(page, s => !s.account.risks.sh600519.dynamic);
  await page.locator('#risk-dynamic').check(); await page.locator('#risk-form button.outline').click();
  await waitState(page, s => s.account.risks.sh600519.dynamic);
  await page.locator('[data-page="settings"]').click(); await page.locator('#strategy-riskPercent').fill('0.7'); await page.locator('#strategy-settings-form button').click();
  await waitState(page, s => s.account.strategySettings.riskPercent === 0.7);
  assert.equal((await getState(page)).account.risks.sh600519.config.riskPercent, 0.5);
  await page.screenshot({ path: path.join(output, 'settings.png'), fullPage: true }); await noOverflow(page);
  await page.locator('[data-page="portfolio"]').click();
  scenario('2026-09-29T10:10:00+08:00', 9.8); await page.locator('#refresh').click();
  await waitState(page, s => s.account.risks.sh600519.pendingExit === '止损触发');
  const pending = await getState(page); assert.match(pending.account.risks.sh600519.note, /T\+1/); assert.equal(pending.account.trades.length, 1);
  await desktop.close(); desktop = null;
  scenario('2026-09-30T10:00:00+08:00', 10.08);
  page = await launch(path.join(root, 'tests/fixtures/strategy-desktop.cjs'), 'simulated-account');
  await waitState(page, s => s.account.trades.length === 2);
  const sold = await getState(page); assert.equal(sold.stats.positions.length, 0); assert.equal(sold.account.trades[1].reason, '止损触发'); assert.ok(sold.account.trades[1].riskSnapshot.history.length >= 3);
  assert.equal(await page.locator('#strategy-history').innerText().then(s => s.includes('最近已退出交易')), true);
  await desktop.close(); desktop = null;
  // Real network validation uses a different empty account and never submits an order.
  delete env.GUANLAN_TEST_CONTROL;
  page = await launch(root, 'live-account');
  await waitState(page, s => s.connection.ok && Object.keys(s.signals).length === 6 && Object.values(s.signals).every(v => v.plan));
  const live = await getState(page); assert.equal(live.connection.ok, true); assert.equal(live.account.trades.length, 0);
  await page.screenshot({ path: path.join(output, 'live-market.png'), fullPage: true }); await noOverflow(page);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
  await noOverflow(page); await page.screenshot({ path: path.join(output, 'live-small.png'), fullPage: true });
  for (const name of ['settings', 'portfolio', 'stats', 'market']) { await page.locator(`[data-page="${name}"]`).click(); await noOverflow(page); }
  let packageChecked = false;
  if (process.env.GUANLAN_PACKAGE_EXE) {
    await desktop.close(); desktop = null;
    const dataPath = path.join(output, 'packaged-account');
    desktop = await _electron.launch({ executablePath: path.resolve(process.env.GUANLAN_PACKAGE_EXE), args: [`--user-data-dir=${dataPath}`], cwd: root, env });
    page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    const packaged = await waitState(page, s => s.connection.ok && Object.values(s.signals).every(v => v.plan));
    assert.equal(path.resolve(packaged.dataPath), path.resolve(dataPath)); assert.equal(packaged.account.trades.length, 0);
    assert.equal(await desktop.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    await page.screenshot({ path: path.join(output, 'packaged-market.png'), fullPage: true }); packageChecked = true;
  }
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), output, errors, packageChecked, quoteDate: live.quotes.sh600519.date, signals: Object.fromEntries(Object.entries(live.signals).map(([s, v]) => [s, { status: v.status, asOf: v.plan.asOf }])), checks: ['buy confirmation/cancel', 'strategy fill and saved risk', 'dynamic toggle', 'settings frozen per trade', 'background T+1 exit while portfolio displayed', 'restart and latched exit', 'closed trade audit', 'live unadjusted prices', '1120px layout', 'all pages'] };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
