// Real source -> service -> IPC -> renderer checks, restricted to a fresh account.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function revealPoolControl(selector) {
  await page.locator(selector).evaluate(element => { for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
}
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-member-diagnostics-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'unexpected-network.jsonl'), evidenceLog = path.join(output, 'evidence-loads.jsonl'), poolLog = path.join(output, 'pool-requests.jsonl');
const control = { now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', corporateMode: 'ready', historyMode: 'ready', poolDelay: 150 };
const scenario = patch => { Object.assign(control, patch); fs.writeFileSync(controlPath, JSON.stringify(control)); };
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog, GUANLAN_TEST_EVIDENCE_LOG: evidenceLog, GUANLAN_TEST_POOL_LOG: poolLog };
delete env.ELECTRON_RUN_AS_NODE;
const symbol = 'sh600003', checks = [], errors = [];
let desktop, page;
const entries = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const group = current => current.agency.groups.find(item => item.id === 'swing');
const member = current => group(current).members.find(item => item.symbol === symbol);
const decision = current => current.agency.decisions.findLast(item => item.strategyId === 'swing' && item.symbol === symbol);
const row = () => page.locator('#agency-members tr').filter({ has: page.locator(`[data-agency-open="${symbol}"]`) });
async function call(name, payload) {
  return page.evaluate(async ({ name, payload }) => {
    const result = await window.guanlan.call(name, payload);
    if (!result.ok) throw Error(result.error);
    return result.data;
  }, { name, payload });
}
async function waitState(predicate) {
  const deadline = Date.now() + 20000; let current;
  while (Date.now() < deadline) {
    current = await call('state');
    if (predicate(current)) return current;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Member diagnostic timeout: ' + JSON.stringify({ member: member(current), decision: decision(current), runtime: current.agency.runtime }));
}
async function refresh() { await page.evaluate(async () => renderState(await api('state'))); }
async function idle() { await waitState(current => !current.agency.runtime.runningGroups.length); }
async function run() {
  await idle(); await call('agency:run', { strategyId: 'swing' }); await idle(); await refresh();
  return call('state');
}
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/agency-member-diagnostics-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  assert.equal(path.resolve((await call('state')).dataPath), path.resolve(accountPath));
  await page.locator('[data-page="agency"]').click(); await page.locator('[data-agency-tab="swing"]').click();
}
async function snapshot(name, dialog = false) {
  for (const size of [[1120, 760], [1536, 980]]) {
    await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), size);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: viewport overflow at ${size[0]}`);
    // State refreshes replace member rows; capture the stable table container.
    const target = dialog ? page.locator('#agency-reconcile-dialog') : page.locator('#agency-members');
    if (dialog) assert.equal(await target.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await target.screenshot({ path: path.join(output, `${name}-${size[0]}.png`) });
  }
}
function pending(current) {
  assert.equal(member(current).poolCheck.status, 'pending');
  const checked = current.agency.decisions.findLast(item => item.strategyId === 'swing' && item.symbol === symbol && item.entryConditionsCheck)?.entryConditionsCheck;
  assert.equal(checked.status, 'skipped');
  assert.equal(checked.skippedBy, 'pool-qualification');
  assert.deepEqual(checked.reasons, member(current).poolCheck.reasons);
  assert.equal(entries(evidenceLog).length, 0, 'Pending candidate must not load research');
  assert.equal(entries(poolLog).length, 2, 'Rule checks never run the candidate scanner');
}
function unchanged(current, initial) {
  assert.deepEqual(current.account.trades, initial.account.trades);
  assert.deepEqual(current.account.lots, initial.account.lots);
  assert.equal(current.account.cash, initial.account.cash);
  assert.equal(group(current).cash, 0);
}
(async () => {
  scenario({ retryResolves: true, poolOnlySwing: true, poolSymbols: [symbol] }); await launch(); const initial = await call('state');
  await revealPoolControl('#agency-pool-legacy'); await page.locator('#agency-pool-legacy').check();
  await page.locator('#agency-pool-run').click();
  await page.waitForFunction(() => state.agencyPool.lastResult && !state.agencyPool.running && !agencyUi.busy.has('pool-run'));
  assert.equal(member(await call('state')).selectionMode, 'strict');
  scenario({ retryResolves: false });
  await page.locator('#agency-pool-run').click();
  await page.waitForFunction(() => state.agencyPool.lastResult && !state.agencyPool.running && !agencyUi.busy.has('pool-run'));
  await call('agency:mode', { strategyId: 'swing', mode: 'running' }); await idle();
  await call('agency:verify', { strategyId: 'swing', symbol });
  const current = await run(); pending(current); unchanged(current, initial);
  assert.equal(member(current).automaticCheck.status, 'clear');
  await row().locator('.agency-pool-member > summary').click();
  const clearText = await row().innerText();
  assert.match(clearText, /价格与公司行为：通过/); assert.match(clearText, /严格研究资格：待核验/);
  assert.match(clearText, /持续开仓条件：本轮未检查/); assert.match(clearText, /公开披露资料不足以核验行业地位/);
  assert.doesNotMatch(clearText, /当前公开研究资料缺失或股票代码不符/);
  await snapshot('candidate-pending-price-clear');
  await run(); pending(await call('state'));
  checks.push('Manual pool result stays pending during repeated rule checks; price/company checks can pass while continuous entry checks explicitly remain skipped, with exact candidate reasons and no research load');

  scenario({ corporateMode: 'offline', now: '2026-09-29T10:02:00+08:00' });
  await call('agency:verify', { strategyId: 'swing', symbol }); await run();
  const failed = await waitState(current => member(current).corporateVerification.status === 'blocked');
  pending(failed); unchanged(failed, initial); await refresh();
  assert.match(await row().innerText(), /隔离公司行为来源暂不可用/);
  assert.doesNotMatch(await row().innerText(), /价格与公司行为：通过/);
  await row().locator('[data-agency-reconcile]').click();
  assert.match(await page.locator('#agency-reconcile-reason').innerText(), /隔离公司行为来源暂不可用/);
  await snapshot('corporate-source-block', true);

  scenario({ corporateMode: 'ready', historyMode: 'short', now: '2026-09-29T10:04:00+08:00' });
  await page.locator('#agency-reconcile-verify').click(); await page.waitForFunction(() => !agencyUi.busy.size);
  const short = await waitState(current => member(current).automaticCheck.status === 'waiting' && /不足 61 根/.test(member(current).automaticCheck.reason));
  assert.equal(short.agency.corporateChecks[symbol].status, 'clear');
  assert.match(await page.locator('#agency-reconcile-reason').innerText(), /完整未复权日线不足 61 根/);
  assert.doesNotMatch(await page.locator('#agency-reconcile-reason').innerText(), /隔离公司行为来源暂不可用/);
  await snapshot('corporate-recovered-daily-short', true);
  await page.locator('#agency-reconcile-cancel').click(); await run();
  pending(await call('state')); unchanged(await call('state'), initial);
  checks.push('Source failure remains a separate block; source recovery with insufficient daily bars reports the current daily-data reason without clearing candidate qualification');

  scenario({ historyMode: 'ready', now: '2026-09-29T10:06:00+08:00' });
  await call('agency:verify', { strategyId: 'swing', symbol }); await run();
  const recovered = await waitState(current => member(current).automaticCheck.status === 'clear');
  assert.equal(member(recovered).reconciliation.status, 'clear'); pending(recovered); unchanged(recovered, initial);
  await desktop.close(); desktop = null; await launch(); await idle(); await run();
  const restored = await call('state'); pending(restored); unchanged(restored, initial);
  assert.equal(await page.locator('#agency-pool-run').isEnabled(), true);
  assert.match(await row().innerText(), /持续开仓条件：本轮未检查/);
  await snapshot('pending-restored');
  checks.push('Full source and price recovery and restart preserve pending qualification; no automatic scan, trades, cash changes or holdings changes occur');
  assert.deepEqual(errors, []); assert.deepEqual(entries(networkLog), []);
  const report = { passed: true, output, checks, errors, networkRequests: 0, evidenceLoads: 0, manualPoolRuns: entries(poolLog).length };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors }, null, 2));
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error('Output:', output); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
