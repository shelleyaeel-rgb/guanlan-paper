// Optional desktop test. All accounts and screenshots stay in ignored work/.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/screener-ui-')), control = path.join(output, 'control.json');
const env = { ...process.env, GUANLAN_TEST_CONTROL: control }; delete env.ELECTRON_RUN_AS_NODE;
const scenario = screenFail => fs.writeFileSync(control, JSON.stringify({ now: '2026-09-29T10:00:00+08:00', price: 10.08, screenFail }));
let desktop; const errors = [];
async function launch(entry, directory) {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [entry, `--test-data-dir=${path.join(output, directory)}`], cwd: root, env });
  const page = await desktop.firstWindow(); page.on('pageerror', e => errors.push(e.message)); return page;
}
async function idle(page) {
  await page.waitForFunction(() => !screenBusy && (screenResult || !document.querySelector('#screen-error').classList.contains('hidden')), null, { timeout: 90000 });
  if (!await page.evaluate(() => !!screenResult)) throw Error(await page.locator('#screen-error').innerText());
}
async function textQuery(page, description) { await page.locator('#screen-description').fill(description); await page.locator('#screen-parse').click(); await idle(page); }
async function noOverflow(page) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
(async () => {
  scenario(false);
  let page = await launch(path.join(root, 'tests/fixtures/screener-desktop.cjs'), 'fixture-account');
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account);
  await page.locator('[data-page="screener"]').click(); await idle(page);
  assert.equal(await page.locator('#screen-catalog').getAttribute('open'), null);
  assert.equal(await page.evaluate(() => screenResult.matched), 134);
  assert.equal(await page.locator('#screen-table tbody tr').count(), 30);
  await page.locator('#screen-next').click(); assert.match(await page.locator('#screen-page-info').innerText(), /第 2/);
  await textQuery(page, '主板，排除ST，股价10到20元，总市值50到300亿');
  assert.equal(await page.locator('#screen-rules .screen-rule').count(), 4);
  assert.equal(await page.evaluate(() => screenResult.rows.every(r => ['sh', 'sz'].includes(r.board) && r.price >= 10 && r.price <= 20 && !r.isST)), true);
  const before = await page.evaluate(() => screenResult.matched);
  await page.locator('#screen-description').fill('银行股，市盈率小于20'); await page.locator('#screen-parse').click();
  await page.waitForFunction(() => !screenBusy && !document.querySelector('#screen-error').classList.contains('hidden'));
  assert.match(await page.locator('#screen-error').innerText(), /无法确定/); assert.equal(await page.evaluate(() => screenResult.matched), before); assert.equal(await page.locator('#screen-run').isDisabled(), true);
  await page.screenshot({ path: path.join(output, 'unsupported.png'), fullPage: true });
  await page.locator('#screen-reset').click(); await page.locator('#screen-run').click(); await idle(page);
  await page.locator('#screen-catalog summary').click(); await page.locator('#screen-field-search').fill('换手');
  await page.locator('[data-field="turnover"]').click(); await page.locator('[data-part="op"]').selectOption('gt'); await page.locator('[data-part="value"]').fill('8');
  await page.locator('#screen-run').click(); await idle(page); assert.equal(await page.evaluate(() => screenResult.rows.every(r => r.turnover > 8)), true);
  await page.locator('#screen-catalog summary').click();
  await page.locator('#screen-sort').selectOption('price:asc'); await noOverflow(page);
  const add = page.locator('[data-screen-watch]:not([disabled])').first(), symbol = await add.getAttribute('data-screen-watch');
  await add.click(); await page.waitForFunction(symbol => state.account.watchlist.includes(symbol), symbol);
  assert.equal(await page.locator(`[data-screen-watch="${symbol}"]`).innerText(), '已自选');
  await page.locator(`[data-screen-open="${symbol}"]`).click(); await page.waitForFunction(symbol => selected === symbol && page === 'market', symbol);
  assert.equal(await page.locator('#remove-watch').getAttribute('title'), '移出自选');
  await page.locator('[data-page="screener"]').click();
  scenario(true); await page.locator('#screen-run').click();
  await page.waitForFunction(() => !screenBusy && !document.querySelector('#screen-error').classList.contains('hidden'));
  assert.match(await page.locator('#screen-error').innerText(), /上次结果/); assert.ok(await page.locator('#screen-table tbody tr').count());
  scenario(false); await page.locator('#screen-run').click(); await idle(page);
  await textQuery(page, '股价大于100000元'); assert.equal(await page.evaluate(() => screenResult.matched), 0); assert.match(await page.locator('#screen-table').innerText(), /暂无符合/);
  await textQuery(page, '我的自选股，排除ST'); assert.equal(await page.evaluate(() => screenResult.rows.every(r => state.account.watchlist.includes(r.symbol))), true);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760)); await noOverflow(page);
  await page.screenshot({ path: path.join(output, 'fixture-small.png'), fullPage: true });
  const account = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length })); assert.deepEqual(account, { trades: 0, orders: 0 });
  await desktop.close(); desktop = null;
  delete env.GUANLAN_TEST_CONTROL;
  page = await launch(root, 'live-account'); await page.waitForFunction(() => typeof state !== 'undefined' && state?.account);
  await page.locator('[data-page="screener"]').click(); await idle(page);
  const live = await page.evaluate(() => ({ total: screenResult.sourceCount, eligible: screenResult.eligibleCount, matched: screenResult.matched, source: screenResult.source, dataPath: state.dataPath })); assert.ok(live.total > 5000);
  await textQuery(page, '主板，排除ST，股价10到30元，总市值50到300亿');
  await noOverflow(page); await page.screenshot({ path: path.join(output, 'live-screener.png'), fullPage: true });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760)); await noOverflow(page);
  await page.screenshot({ path: path.join(output, 'live-small.png'), fullPage: true });
  const preview = page.locator('[data-screen-open]').first(), liveSymbol = await preview.getAttribute('data-screen-open');
  await preview.click(); await page.waitForFunction(symbol => selected === symbol && page === 'market', liveSymbol);
  assert.equal(await page.locator('#remove-watch').getAttribute('title'), '加入自选');
  assert.equal(await page.evaluate(() => state.account.trades.length), 0);
  let packageChecked = false;
  if (process.env.GUANLAN_PACKAGE_EXE) {
    await desktop.close(); desktop = null;
    const dataPath = path.join(output, 'packaged-account');
    desktop = await _electron.launch({ executablePath: path.resolve(process.env.GUANLAN_PACKAGE_EXE), args: [`--user-data-dir=${dataPath}`], cwd: root, env });
    page = await desktop.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => typeof state !== 'undefined' && state?.account);
    assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), path.resolve(dataPath));
    assert.equal(await desktop.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    await page.locator('[data-page="screener"]').click(); await idle(page);
    await textQuery(page, '主板，排除ST，股价10到30元，总市值50到300亿');
    assert.ok(await page.evaluate(() => screenResult.eligibleCount > 5000 && screenResult.matched > 0));
    assert.equal(await page.evaluate(() => state.account.trades.length), 0);
    await noOverflow(page); await page.screenshot({ path: path.join(output, 'packaged-screener.png'), fullPage: true }); packageChecked = true;
  }
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), output, errors, account, live, packageChecked, checks: ['full market pages', 'text and manual filters', 'unsupported text blocks application', 'add/remove conditions', 'pagination and sorting', 'add watchlist', 'open analysis', 'refresh failure preserves result', 'empty results', 'watchlist scope', '1120px and 1536px layout', 'live data without trades'] };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async e => { console.error(e); console.error('Output:', output); if (desktop) { const page = await desktop.firstWindow(); console.error(await page.locator('#screen-error').textContent()); await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }); } process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
