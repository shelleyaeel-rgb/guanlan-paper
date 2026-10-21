// Real verification IPC and DOM, paused isolated accounts, controlled sources.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { CorporateRequest } = require('../core/corporate-request.cjs');
const root = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(root, 'work/corporate-recovery-ui-'));
const accountPath = path.join(output, 'account'), control = path.join(output, 'control.json');
const sourceError = '公告目录接口拒绝请求（np-anotice-stock.eastmoney.com，HTTP 567）；已暂停快速重试，等待来源恢复';
const scenario = { now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', corporateMode: 'offline', corporateError: sourceError };
const saveScenario = patch => { Object.assign(scenario, patch); fs.writeFileSync(control, JSON.stringify(scenario)); };
saveScenario({});
const env = { ...process.env, GUANLAN_TEST_CONTROL: control, GUANLAN_TEST_NETWORK_LOG: path.join(output, 'network.jsonl'), GUANLAN_TEST_EXTERNAL_LOG: path.join(output, 'external.jsonl') };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, page; const errors = [], checks = [];
async function call(name, payload) {
  return page.evaluate(async ({ name, payload }) => {
    const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data;
  }, { name, payload });
}
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/corporate-ui-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  assert.equal(path.resolve((await call('state')).dataPath), accountPath);
  await call('agency:member', { strategyId: 'short', symbol: 'sh600519', action: 'add' });
  await call('agency:verify', { strategyId: 'short' });
  await page.locator('[data-page="agency"]').click();
  await page.locator('[data-agency-tab="short"]').click();
  await page.waitForFunction(() => !agencyUi.busy.size);
  await page.locator('#agency-members [data-agency-reconcile="sh600519"]').click();
  assert.match(await page.locator('#agency-reconcile-reason').innerText(), /公告目录接口拒绝请求.*HTTP 567/);
  await page.locator('#agency-reconcile-dialog').screenshot({ path: path.join(output, 'source-rejected.png') });
  checks.push('source rejection is visible in verification details through real IPC');
  const transport = new CorporateRequest(async () => ({ ok: false, status: 567 }), { clock: () => Date.parse(scenario.now), minIntervalMs: 0 });
  const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann?stock_list=600519';
  await assert.rejects(transport.json(url, { stage: 'corporate-index' }));
  const local = await transport.json(url, { stage: 'corporate-index' }).catch(error => error);
  assert.equal(local.acquisition.code, 'source-cooldown'); assert.equal(local.acquisition.attempts, 0);
  saveScenario({ corporateError: local.message });
  await page.locator('#agency-reconcile-verify').click();
  await page.waitForFunction(() => !agencyUi.busy.size && document.getElementById('agency-reconcile-reason').textContent.includes('本次未发送'));
  const localText = await page.locator('#agency-reconcile-reason').innerText();
  assert.match(localText, /本地.*本次未发送/); assert.match(localText, /2026-09-29.*10:01:00/);
  assert.doesNotMatch(localText, /\d+ 秒后再试/);
  await page.locator('#agency-reconcile-dialog').screenshot({ path: path.join(output, 'local-request-cooldown.png') });
  checks.push('local cooldown shows no request was sent and an absolute retry time');
  saveScenario({ corporateMode: 'empty' });
  await page.locator('#agency-reconcile-verify').click();
  await page.waitForFunction(() => !agencyUi.busy.size && /已检查 1 只/.test(document.getElementById('agency-reconcile-auto-result').textContent));
  const current = await call('state'), member = current.agency.groups.find(g => g.id === 'short').members[0];
  assert.equal(member.corporateVerification.status, 'clear'); assert.equal(member.automaticCheck.status, 'clear');
  assert.doesNotMatch(await page.locator('#agency-reconcile-reason').innerText(), /HTTP 567|拒绝请求/);
  assert.match(await page.locator('#agency-reconcile-auto-result').innerText(), /通过 1 只/);
  await page.setViewportSize({ width: 1120, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#agency-reconcile-dialog').screenshot({ path: path.join(output, 'source-recovered.png') });
  assert.equal(current.account.trades.length, 0); assert.equal(current.account.orders.length, 0);
  assert.ok(current.agency.groups.every(group => group.mode === 'paused'));
  assert.deepEqual(errors, []);
  checks.push('retry button refreshes recovered evidence and removes stale rejection', 'paused account has no trades or orders', '1120px details fit without horizontal overflow');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, output, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, output, checks }, null, 2));
})().catch(async error => {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(error); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
