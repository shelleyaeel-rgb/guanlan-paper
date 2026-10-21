const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { classifyFinanceApplicability } = require('../core/industry-applicability.cjs');
const root = path.resolve(__dirname, '..'); fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/industry-finance-ui-')), account = path.join(output, 'account');
const controlPath = path.join(output, 'control.json'), networkLog = path.join(output, 'network.jsonl');
const control = { now: '2026-10-15T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', financeScenario: 'pass' };
fs.writeFileSync(controlPath, JSON.stringify(control));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog }; delete env.ELECTRON_RUN_AS_NODE;
const errors = [], checks = []; let desktop, page;
const call = (name, payload) => page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload });
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/industry-finance-ui-desktop.cjs'), `--test-data-dir=${account}`], cwd: root, env });
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  const before = await call('state'); assert.equal(path.resolve(before.dataPath), path.resolve(account));
  await page.locator('[data-page="screener"]').click(); await page.waitForFunction(() => screenInitialized && !screenBusy);
  await page.locator('#screen-strategy').selectOption('long');
  for (const field of await page.locator('#screen-rules .screen-rule').evaluateAll(elements => elements.map(element => element.dataset.field))) {
    if (!['annualRoeLatest', 'latestAdjustedProfit'].includes(field)) {
      const remove = page.locator(`#screen-rules [data-field="${field}"] [data-remove]`).first(); if (await remove.count()) await remove.click();
    }
  }
  await page.locator('#screen-run').click(); await page.waitForFunction(() => !screenBusy);
  assert.equal(await page.locator('#screen-error').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => screenResult.rows.map(row => row.symbol)), ['sh600519']);
  assert.equal(await page.evaluate(() => screenResult.financeTemplateRows.length), 2);
  const bank = page.locator('[data-finance-template-group="inapplicable"]'), unknown = page.locator('[data-finance-template-group="pending"]');
  await bank.locator(':scope > summary').click(); await unknown.locator(':scope > summary').click();
  assert.match(await bank.innerText(), /模板不适用.*隔离银行 <模板>.*金融业.*不表示公司财务不合格/s);
  assert.match(await unknown.innerText(), /行业分类待核验.*隔离行业未知.*行业分类缺失/s);
  assert.equal(await page.locator('[data-finance-template-symbol] [data-screen-agency]').count(), 0);
  assert.equal(await bank.locator('模板').count(), 0);
  for (const width of [1120, 1536]) {
    await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 960), width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#screen-finance-pending').screenshot({ path: path.join(output, `template-classes-${width}.png`) });
  }
  await page.locator('#screen-result-search').fill('600010'); assert.equal(await unknown.locator('[data-finance-template-symbol]').count(), 0); assert.equal(await bank.locator('[data-finance-template-symbol]').count(), 1);
  await page.locator('#screen-result-search').fill('');
  checks.push('Real long-screening excludes bank and unknown industry into separate applicability groups; ordinary issuer remains matched. Source classification, reasons and dates render, search works and no candidate add action is exposed.');
  const values = ['inapplicable', 'pending'].map(status => classifyFinanceApplicability({ symbol: 'sh600010', section: 'profile', source: '东方财富', status: 'ready', fetchedAt: Date.parse(control.now),
    data: status === 'inapplicable' ? { industry: '银行', orgType: '银行', orgTypeCode: '3' } : { industry: null, orgType: '通用', orgTypeCode: '4' } }, 'sh600010', new Date(control.now)));
  const rendered = await page.evaluate(values => values.map(applicability => financeCheckHtml({ status: applicability.status === 'inapplicable' ? 'failed' : 'pending', applicability, checks: [] })), values);
  assert.match(rendered[0], /<summary>.*模板不适用/); assert.doesNotMatch(rendered[0], /：条件不符/); assert.match(rendered[1], /<summary>.*行业分类待核验/);
  await page.locator('#screen-strategy').selectOption('');
  await page.locator('#screen-run').click(); await page.waitForFunction(() => !screenBusy);
  assert.equal(await page.locator('#screen-finance-pending').innerHTML(), '');
  assert.equal(await page.evaluate(() => screenResult.rows.length), 3);
  const after = await call('state'); assert.deepEqual(after.account.trades, before.account.trades); assert.deepEqual(after.account.orders, before.account.orders);
  assert.deepEqual(after.agency.groups.map(group => group.mode), before.agency.groups.map(group => group.mode));
  assert.deepEqual(errors, []); assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8') : '', '');
  checks.push('Finance summary distinguishes template incompatibility from unknown classification. Removing the long template clears stale groups; 1120/1536 layouts fit with no external requests, trades, orders or mode changes.');
  const report = { status: 'passed', output, scope: 'Real finance classification, screener, IPC and renderer with isolated synthetic profiles and statements.', checks, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report, null, 2));
})().catch(async error => {
  const result = page ? await page.evaluate(() => typeof screenResult === 'undefined' ? null : screenResult).catch(() => null) : null;
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, result }, null, 2)); process.stderr.write(error.stack); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
