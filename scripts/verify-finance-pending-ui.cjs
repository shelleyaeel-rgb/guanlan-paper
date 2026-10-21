// Focused ordinary-screener publication review, using real IPC and renderers.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/finance-pending-ui-'));
const account = path.join(output, 'account'), controlPath = path.join(output, 'control.json'), networkLog = path.join(output, 'network.jsonl');
const control = { now: '2026-10-15T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', financeScenario: 'pass', screenFinancePending: true };
const save = () => fs.writeFileSync(controlPath, JSON.stringify(control)); save();
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page; const errors = [];
const call = (name, payload) => page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload });
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/finance-periods-desktop.cjs'), `--test-data-dir=${account}`], cwd: root, env });
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  const before = await call('state'); assert.equal(path.resolve(before.dataPath), path.resolve(account));
  await page.locator('[data-page="screener"]').click(); await page.waitForFunction(() => screenInitialized && !screenBusy);
  await page.locator('#screen-strategy').selectOption('long');
  for (const field of await page.locator('#screen-rules .screen-rule').evaluateAll(elements => elements.map(element => element.dataset.field))) {
    if (!['annualRoeLatest', 'latestAdjustedProfit'].includes(field)) {
      const remove = page.locator(`#screen-rules [data-field="${field}"] [data-remove]`).first();
      if (await remove.count()) await remove.click();
    }
  }
  await page.locator('#screen-run').click(); await page.waitForFunction(() => !screenBusy && screenResult?.financePendingRows?.length === 1);
  assert.equal(await page.evaluate(() => screenResult.rows.length), 1);
  assert.equal(await page.evaluate(() => screenResult.financePendingRows[0].symbol), 'sh600010');
  const panel = page.locator('#screen-finance-pending > details');
  assert.match(await panel.locator(':scope > summary').innerText(), /财务待核验 · 1 只/);
  await panel.locator(':scope > summary').click();
  const stock = panel.locator('[data-finance-pending-symbol="sh600010"]');
  assert.match(await stock.locator(':scope > b').innerText(), /待同步样本 <财务>.*SH600010/);
  assert.equal(await stock.locator('财务').count(), 0);
  await stock.locator('.finance-check > summary').click();
  const amount = stock.locator('[data-finance-field="latestAdjustedProfit"]');
  assert.match(await amount.innerText(), /待核验.*2026-06-30.*已取得原值 1亿元（当前不可用于判断）.*2026-09-30.*未同步/s);
  assert.match(await amount.innerText(), /最新已披露累计财报指标/);
  const annual = stock.locator('[data-finance-field="annualRoeLatest"]');
  assert.match(await annual.innerText(), /通过.*2025-12-31.*完整年度财报指标.*原值 12%.*要求 ≥ 8%/s);
  assert.doesNotMatch(await stock.innerText(), /latest-disclosed-cumulative/);
  assert.equal(await stock.locator('[data-screen-agency]').count(), 0);
  for (const size of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(...value), size);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.screenshot({ path: path.join(output, `finance-pending-${size[0]}.png`) });
  }
  await page.locator('#screen-result-search').fill('600519');
  assert.match(await panel.locator(':scope > summary').innerText(), /财务待核验 · 0 只/);
  assert.equal(await panel.locator('[data-finance-pending-symbol]').count(), 0);
  await page.locator('#screen-result-search').fill('600010');
  assert.equal(await panel.locator('[data-finance-pending-symbol]').count(), 1);
  await panel.locator(':scope > summary').click();
  await panel.locator('[data-screen-open="sh600010"]').click();
  await page.waitForFunction(() => page === 'market' && selected === 'sh600010');
  assert.equal(await page.evaluate(() => screenEntryContext), null);
  control.screenFinancePending = false; save();
  await page.locator('[data-page="screener"]').click(); await page.locator('#screen-result-search').fill('');
  await page.locator('#screen-run').click(); await page.waitForFunction(() => !screenBusy && !screenResult?.financePendingRows?.length);
  assert.equal(await page.locator('#screen-finance-pending').innerHTML(), '');
  const after = await call('state');
  assert.deepEqual(after.account.trades, before.account.trades); assert.deepEqual(after.account.orders, before.account.orders);
  assert.deepEqual(after.agency.groups.map(group => group.mode), before.agency.groups.map(group => group.mode));
  assert.deepEqual(errors, []); assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8') : '', '');
  const report = { status: 'passed', output, scope: 'Real finance normalization, ordinary screener final publication review, IPC and render; synthetic sources; isolated account.',
    checks: ['One stock enters financePendingRows after the formal new-quarter notice; normal result retains the other stock.', 'Pending amount shows retained original, correct period, sync reason and Chinese basis; independent annual metric passes.', 'Name text is escaped, search filters pending records, stock detail opens without candidate-entry context, and fresh results clear stale pending records.', '1120/1536 screenshots; no external requests, page errors, trades, orders or agency mode changes.'], errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report, null, 2));
})().catch(async error => {
  const result = page ? await page.evaluate(() => typeof screenResult === 'undefined' ? null : screenResult).catch(() => null) : null;
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, result }, null, 2));
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.stderr.write(error.stack); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
