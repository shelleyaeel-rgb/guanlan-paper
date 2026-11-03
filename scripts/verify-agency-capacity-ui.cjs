// Real Electron, IPC, pool synchronization and persistence with isolated data.
// The existing fixture supplies deterministic scanner/provider responses.
'use strict';
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-capacity-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'unexpected-network.jsonl'), poolLog = path.join(output, 'pool-requests.jsonl');
const symbols = Array.from({ length: 30 }, (_, index) => `sh${601800 + index}`);
const scenario = { now: '2026-09-29T08:45:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready',
  poolDelay: 150, poolOnlySwing: true, poolSymbols: symbols };
fs.writeFileSync(controlPath, JSON.stringify(scenario));
const engine = new Engine(initialState(), () => new Date(scenario.now));
engine.s.watchlist = [];
for (const symbol of symbols) engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' });
// Older current checks must never be presented as a standby member's state.
for (const member of engine.s.agency.groups.find(group => group.id === 'swing').members) {
  member.mode = 'active'; delete member.standbyReason;
  member.monitoringCheck = { status: 'eligible', reason: '旧版已通过记录，不应显示为候补当前状态', checkedAt: new Date(scenario.now).toISOString() };
}
engine.s.agency.version = 5; // Exercise the real one-time upgrade before screening.
fs.mkdirSync(accountPath);
fs.writeFileSync(path.join(accountPath, 'account.json'), JSON.stringify(engine.s, null, 2));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog, GUANLAN_TEST_POOL_LOG: poolLog };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [], checks = [], screenshots = [];
let desktop, page;
const group = value => value.agency.groups.find(item => item.id === 'swing');
const entries = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function current() {
  return page.evaluate(async () => { const result = await window.guanlan.call('state'); if (!result.ok) throw Error(result.error); return result.data; });
}
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'),
    args: [path.join(root, 'tests/fixtures/agency-capacity-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  assert.equal(path.resolve((await current()).dataPath), path.resolve(accountPath));
  await page.locator('[data-page="agency"]').click();
  await page.locator('[data-agency-tab="swing"]').click();
}
function verifyMembers(value) {
  assert.equal(group(value).members.length, 30);
  assert.equal(group(value).members.filter(member => member.mode === 'active').length, 6);
  assert.equal(group(value).members.filter(member => member.mode === 'standby').length, 24);
  assert.ok(group(value).members.filter(member => member.mode === 'standby').every(member => member.standbyReason));
  assert.equal(value.account.trades.length, 0); assert.equal(value.account.orders.length, 0); assert.equal(value.account.lots.length, 0);
}
async function capture(width, name, selector) {
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 850), width);
  await page.setViewportSize({ width, height: 850 });
  await page.locator(selector).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} fits ${width}px`);
  const file = path.join(output, `${name}-${width}.png`);
  await page.screenshot({ path: file }); screenshots.push(file);
}
(async () => {
  await launch();
  const migrated = await current();
  assert.equal(migrated.agency.version, 6);
  assert.equal(group(migrated).members.filter(member => member.mode === 'standby').length, 30);
  assert.match(await page.locator('#agency-migration-note').innerText(), /30.*候补/);
  assert.match(await page.locator('#agency-runtime-coverage').innerText(), /当前 30 只成员均为候补/);
  assert.equal(await page.locator('[data-monitoring-count="eligible"] strong').innerText(), '0');
  checks.push('Opening an isolated version-five account migrates thirty unheld members to standby, shows the upgrade/reselection explanation, and excludes their old eligible checks from current totals.');
  await page.locator('#agency-pool-run').click();
  await page.waitForFunction(() => !state.agencyPool.running && !agencyUi.busy.has('pool-run') && state.agencyPool.lastResult);
  const afterUpdate = await current(); verifyMembers(afterUpdate);
  const result = afterUpdate.agencyPool.lastResult;
  assert.equal(result.selection.activeLimitPerGroup, 6);
  assert.equal(result.counts.standby, 24);
  assert.equal(Object.values(result.counts).reduce((sum, count) => sum + count, 0), 30);
  for (const [key, count] of Object.entries(result.counts)) {
    assert.equal(result[key].length, count);
    assert.equal(await page.locator(`[data-pool-count="${key}"] strong`).innerText(), String(count));
  }
  assert.equal(await page.locator('[data-member-count="active"] strong').innerText(), '6');
  assert.equal(await page.locator('[data-member-count="held"] strong').innerText(), '0');
  assert.equal(await page.locator('[data-member-count="standby"] strong').innerText(), '24');
  checks.push('Thirty existing candidates pass the isolated scan; real synchronization persists six active and twenty-four standby, and every result category count matches its rows.');

  await page.locator('#agency-member-filter').selectOption('active');
  assert.equal(await page.locator('#agency-members tbody tr').count(), 6);
  await page.locator('#agency-member-filter').selectOption('standby');
  assert.equal(await page.locator('#agency-members tbody tr').count(), 24);
  assert.equal(await page.locator('#agency-members [data-monitoring-status="standby"]').count(), 24);
  assert.equal(await page.locator('#agency-members [data-monitoring-status="eligible"]').count(), 0);
  assert.doesNotMatch(await page.locator('#agency-members').innerText(), /旧版已通过记录|本轮开仓检查通过|正在准备交易资料/);
  assert.match(await page.locator('#agency-members').innerText(), /不参与高频刷新/);
  await page.locator('#agency-member-search').fill(symbols.at(-1));
  assert.equal(await page.locator('#agency-members tbody tr').count(), 1);
  await page.locator('#agency-member-search').fill('');
  await page.locator('#agency-member-held').check();
  assert.match(await page.locator('#agency-members').innerText(), /没有匹配/);
  await page.locator('#agency-member-held').uncheck();
  await page.locator('#agency-pool-filter').selectOption('standby');
  assert.match(await page.locator('#agency-pool-page-info').innerText(), /24 条/);
  assert.equal(await page.locator('#agency-pool-items details').count(), 20);
  await page.locator('#agency-pool-next').click();
  assert.equal(await page.locator('#agency-pool-items details').count(), 4);
  checks.push('Member active/standby/search/held filters and result pagination work; standby shows its capacity reason and excludes historical current-check/preparation claims.');
  // Compatibility states are renderer-only and cannot alter the account.
  const compatibility = await page.evaluate(() => {
    const saved = state, savedRenderKey = agencyUi.poolRenderKey;
    state = structuredClone(state);
    try {
      const result = state.agencyPool.lastResult;
      delete result.selection;
      result.coverage.diagnostics.pendingCompanies = 0;
      result.pending = []; result.unassignedPending = [];
      result.counts.pending = 0; result.counts.unassignedPending = 0;
      result.standby[0].status = 'pending';
      agencyUi.poolRenderKey = null; renderAgencyPool();
      return { retryVisible: !document.querySelector('#agency-pool-retry').classList.contains('hidden'),
        scope: document.querySelector('#agency-pool-result-scope').textContent };
    } finally { state = saved; agencyUi.poolRenderKey = savedRenderKey; renderAgencyPool(); }
  });
  assert.equal(compatibility.retryVisible, true);
  assert.doesNotMatch(compatibility.scope, /undefined/);
  checks.push('Renderer-only compatibility fixtures show retry for pending standby alone and safely render older pool results without selection metadata.');
  for (const width of [1120, 1536]) {
    await capture(width, 'member-summary', '#agency-monitoring-summary');
    await page.locator('#agency-member-search').fill(symbols.at(-1));
    await capture(width, 'standby-member', '#agency-members');
    await page.locator('#agency-member-search').fill('');
    await capture(width, 'pool-result', '#agency-pool-metrics');
  }
  checks.push('Real Electron page fits narrow 1120px and 1536px desktop widths; screenshots capture counts, standby explanation and pool results.');

  await desktop.close(); desktop = null;
  await launch();
  const restarted = await current(); verifyMembers(restarted);
  assert.deepEqual(group(restarted).members.map(member => [member.symbol, member.mode, member.standbyReason]),
    group(afterUpdate).members.map(member => [member.symbol, member.mode, member.standbyReason]));
  assert.deepEqual(errors, []); assert.deepEqual(entries(networkLog), []);
  checks.push('Restart preserves all thirty memberships and the six/twenty-four split; zero unintended network, orders, fills or renderer errors.');
  const report = { status: 'passed', output, checks, screenshots, errors, isolation: { accountPath, unexpectedNetwork: 0 },
    afterUpdate, restarted };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, checks, screenshots }, null, 2));
})().catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(output); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
