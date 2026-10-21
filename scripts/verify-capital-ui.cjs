'use strict';
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/capital-ui-'));
const accountPath = path.join(output, 'account'), accountFile = path.join(accountPath, 'account.json');
const controlFile = path.join(output, 'control.json'), capitalLog = path.join(output, 'capital.jsonl');
const scenario = { now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', capitalMode: 'ready' };
const update = extra => { Object.assign(scenario, extra); fs.writeFileSync(controlFile, JSON.stringify(scenario)); };
fs.mkdirSync(accountPath); update({});
const seeded = new Engine(initialState()).s;
seeded.settings.refreshSeconds = 60; seeded.watchlist = ['sh600519'];
fs.writeFileSync(accountFile, JSON.stringify(seeded, null, 2));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlFile, GUANLAN_CAPITAL_LOG: capitalLog,
  GUANLAN_TEST_NETWORK_LOG: path.join(output, 'network.jsonl') };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, page; const errors = [], checks = [];
const disk = () => JSON.parse(fs.readFileSync(accountFile, 'utf8'));
const requests = () => fs.existsSync(capitalLog) ? fs.readFileSync(capitalLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const pending = () => page.evaluate(() => capitalPending && { ...capitalPending });
async function call(name, payload) {
  return page.evaluate(async ({ name, payload }) => {
    const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data;
  }, { name, payload });
}
async function settings() {
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4 && state.connection.ok);
  await page.locator('[data-page="settings"]').click();
  await page.locator('#capital-amount').scrollIntoViewIfNeeded();
}
async function submit(amount, confirm = true) {
  await page.locator('#capital-amount').fill(String(amount));
  await page.locator('#capital-submit').click();
  await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#confirm-body').innerText(), /初始本金、持仓、委托和交易历史全部保留/);
  await page.locator(confirm ? '#confirm-ok' : '#confirm-cancel').click();
}
async function idle() { await page.waitForFunction(() => !capitalBusy); }
async function capture(name) {
  await page.locator('#capital-form').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, name + '.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/capital-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 800));
  await page.setViewportSize({ width: 1120, height: 800 });
}

(async () => {
  await launch();
  await settings(); assert.equal(path.resolve((await call('state')).dataPath), accountPath);
  const before = disk();
  await submit(123.45, false); await idle();
  assert.equal(requests().length, 0); assert.equal(disk().cash, before.cash);
  await page.locator('#capital-amount').fill('0.001');
  assert.equal(await page.locator('#capital-amount').evaluate(input => input.checkValidity()), false);
  await page.locator('#capital-submit').click();
  assert.equal(requests().length, 0);
  checks.push('cancel and invalid cent precision do not submit a capital request');

  await submit(123.45); await idle();
  assert.equal(disk().cash, before.cash + 12345); assert.equal(disk().initialCash, before.initialCash);
  assert.equal(disk().capitalFlows.length, 1); assert.equal(await pending(), null);
  assert.deepEqual(disk().trades, before.trades); assert.deepEqual(disk().orders, before.orders);
  await page.locator('#capital-history').locator('..').evaluate(details => { details.open = true; });
  assert.match(await page.locator('#capital-history').innerText(), /123\.45/);
  assert.match(await page.locator('#capital-summary').innerText(), /1,000,123\.45/);
  await capture('capital-added-1120');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1536, 980));
  await page.setViewportSize({ width: 1536, height: 980 });
  await capture('capital-added-1536');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 800));
  await page.setViewportSize({ width: 1120, height: 800 });
  checks.push('real form confirmation, preload, IPC and Store create one flow and retain account history');

  update({ capitalMode: 'before' });
  await submit(10); await idle();
  const interrupted = await pending(); assert.ok(interrupted?.requestId);
  assert.equal(await page.locator('#capital-amount').getAttribute('readonly'), '');
  assert.equal(disk().capitalFlows.length, 1);
  update({ capitalMode: 'ready' });
  await page.reload(); await settings();
  assert.equal((await pending()).requestId, interrupted.requestId);
  assert.equal(await page.locator('#capital-amount').inputValue(), '10');
  await page.locator('#capital-submit').click(); await idle();
  assert.equal(disk().capitalFlows.length, 2);
  const attempts = requests().filter(request => request.amount === 10);
  assert.equal(attempts.length, 2); assert.equal(attempts[0].requestId, attempts[1].requestId);
  checks.push('interrupted submission survives renderer reload and retries the same request exactly once');

  update({ capitalMode: 'after' });
  await submit(15); await idle();
  assert.equal(disk().capitalFlows.length, 3); assert.equal(await pending(), null);
  assert.match(await page.locator('#capital-status').innerText(), /已核对/);
  assert.doesNotMatch(await page.locator('#toast').innerText(), /暂未收到/);
  checks.push('a delivered account update takes precedence over a lost operation reply');

  update({ capitalMode: 'after', blockCapitalView: true });
  await submit(20); await idle();
  const lostReply = await pending(); assert.ok(lostReply?.requestId);
  assert.equal(disk().capitalFlows.length, 4);
  await capture('capital-interrupted-1120');
  update({ capitalMode: 'ready', blockCapitalView: false });
  await desktop.close(); desktop = null;
  await launch(); await settings();
  assert.equal(await pending(), null); assert.equal(disk().capitalFlows.length, 4);
  assert.equal(requests().filter(request => request.amount === 20).length, 1);
  assert.match(await page.locator('#capital-status').innerText(), /已核对/);
  checks.push('committed request with lost reply is reconciled from the persisted ledger after a full restart without resubmission');

  update({ capitalMode: 'save-failure' });
  const beforeFailure = disk();
  await submit(30); await idle();
  assert.deepEqual(disk(), beforeFailure);
  assert.equal(await page.locator('#capital-submit').isDisabled(), true);
  assert.match(await page.locator('#capital-status').innerText(), /账户保存失败，交易已暂停/);
  assert.equal((await call('state')).account.cash, beforeFailure.cash);
  await capture('capital-save-paused-1120');
  checks.push('failed persistence rolls back the account and disables further capital additions while paused');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, requests: requests(), errors }, null, 2));
  console.log(JSON.stringify({ output, checks, errors }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
