// Fresh paused account, real fallback/ledger/IPC and DOM; no actual browser opens.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { cninfoUrl } = require('../core/cninfo-notice-source.cjs');
const root = path.resolve(__dirname, '..'); fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/cninfo-notice-ui-')), accountPath = path.join(output, 'account');
const control = path.join(output, 'control.json'), externalLog = path.join(output, 'external.jsonl'), ipcLog = path.join(output, 'ipc.jsonl'), networkLog = path.join(output, 'network.jsonl');
fs.writeFileSync(control, JSON.stringify({ now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', marketMode: 'offline', marketHold: false }));
const env = { ...process.env, GUANLAN_TEST_CONTROL: control, GUANLAN_TEST_NETWORK_LOG: networkLog,
  GUANLAN_TEST_MARKET_LOG: path.join(output, 'market.jsonl'), GUANLAN_TEST_EXTERNAL_LOG: externalLog, GUANLAN_TEST_IPC_LOG: ipcLog };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, page; const errors = [], checks = [], screenshots = [];
const readLines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const call = (name, payload) => page.evaluate(async ({name,payload}) => { const result = await window.guanlan.call(name,payload); if (!result.ok) throw Error(result.error); return result.data; }, {name,payload});
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root,'tests/fixtures/cninfo-notice-ui-desktop.cjs'),`--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  const before = await call('state'); assert.equal(path.resolve(before.dataPath), accountPath);
  await call('agency:member', { strategyId: 'short', symbol: 'sz000001', action: 'add' });
  await call('agency:verify', { strategyId: 'short' });
  await page.locator('[data-page="agency"]').click(); await page.locator('[data-agency-tab="short"]').click();
  await page.waitForFunction(() => !agencyUi.busy.size);
  await page.locator('#agency-members [data-agency-reconcile="sz000001"]').click();
  await page.locator('#agency-reconcile-evidence-list [data-agency-notice]').waitFor();
  const evidenceText = await page.locator('#agency-reconcile-evidence-list').innerText();
  assert.match(evidenceText, /CN1225601360/); assert.match(evidenceText, /巨潮资讯/); assert.doesNotMatch(evidenceText, /AN1225601360/);
  checks.push('Real EM-directory failure uses the CN source; ledger evidence and visible UI preserve CN id and 巨潮资讯 source.');
  for (const width of [1120,1536]) {
    await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const file = path.join(output, `cninfo-source-${width}.png`); await page.locator('#agency-reconcile-dialog').screenshot({ path: file }); screenshots.push(file);
  }
  await page.locator('#agency-reconcile-evidence-list [data-agency-notice]').click();
  await page.waitForFunction(() => !document.querySelector('#toast')?.textContent?.includes('失败'));
  await page.waitForTimeout(100);
  const invocations = readLines(ipcLog), external = readLines(externalLog), expected = cninfoUrl('sz000001','CN1225601360');
  assert.deepEqual(invocations, [{ name: 'research:open', payload: { symbol: 'sz000001', kind: 'notice', article: 'CN1225601360' } }]);
  assert.deepEqual(external, [{ url: expected }]);
  checks.push('Clicking the actual CN announcement button sends research:open with CN id; the production URL builder resolves the official cninfo.com.cn URL. shell.openExternal is intercepted.');
  const after = await call('state'), member = after.agency.groups.find(group => group.id === 'short').members.find(member => member.symbol === 'sz000001');
  assert.equal(member.corporateVerification.status, 'blocked');
  assert.equal(after.account.trades.length, 0); assert.equal(after.account.orders.length, 0); assert.equal(after.account.lots.length, 0);
  assert.ok(after.agency.groups.every(group => group.mode === 'paused')); assert.equal(after.account.cash, before.account.cash);
  assert.deepEqual(errors, []); assert.deepEqual(readLines(networkLog), []);
  checks.push('Unmatched implementation notice remains blocked; no permission relaxation, trades, orders, holdings, mode changes, or actual network/external-open activity. 1120/1536 layouts fit.');
  const report = { passed: true, output, accountPath, checks, evidenceText, invocations, interceptedExternal: external, screenshots, errors };
  fs.writeFileSync(path.join(output,'report.json'), JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
})().catch(async error => {
  if (page) await page.screenshot({ path: path.join(output,'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(output,'failure.json'), JSON.stringify({ error: error.stack, errors },null,2)); console.error(error); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
