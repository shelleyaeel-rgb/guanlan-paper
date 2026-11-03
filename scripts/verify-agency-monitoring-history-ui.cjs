// Real Electron startup migration, service checks and restart with a test account.
// No renderer state is fabricated; every displayed state comes from production IPC.
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-monitoring-history-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'unexpected-network.jsonl'), sourceLog = path.join(output, 'sources.jsonl');
const poolLog = path.join(output, 'pool-requests.jsonl');
const symbols = ['sh601800', 'sh601801', 'sh601802'];
const oldReason = '开仓资料未就绪：公告资料已过期或不可用，等待后台准备或手动核验';
const oldTime = '2026-09-28T02:00:00.000Z';
const scenario = { now: '2026-09-29T08:46:00+08:00', price: 10.17, dailyMode: 'offline',
  financeMode: 'offline', valuationMode: 'offline', noticeMode: 'offline', poolOnlySwing: true, poolSymbols: symbols, poolDelay: 50 };
const saveScenario = () => fs.writeFileSync(controlPath, JSON.stringify(scenario));
saveScenario();
const engine = new Engine(initialState(), () => new Date(scenario.now));
engine.s.watchlist = [];
for (const [index, symbol] of symbols.entries()) {
  engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' });
  const member = engine.s.agency.groups.find(group => group.id === 'swing').members.at(-1);
  member.monitoringCheck = { status: index === 1 ? 'eligible' : 'data', reason: oldReason, checkedAt: oldTime };
  engine.agencyLog({ strategyId: 'swing', symbol, action: 'wait', status: 'blocked', decisionSource: 'rules', time: oldTime, reason: oldReason });
}
assert.equal(engine.s.agency.version, 8);
assert.equal(validState(engine.s), true);
fs.mkdirSync(accountPath);
fs.writeFileSync(path.join(accountPath, 'account.json'), JSON.stringify(engine.s, null, 2));
const initialLedger = JSON.stringify({ cash: engine.s.cash, lots: engine.s.lots, trades: engine.s.trades, orders: engine.s.orders });
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog,
  GUANLAN_TEST_SOURCE_LOG: sourceLog, GUANLAN_TEST_POOL_LOG: poolLog };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [], screenshots = [], errors = [];
const entries = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const persisted = () => JSON.parse(fs.readFileSync(path.join(accountPath, 'account.json'), 'utf8'));
const members = snapshot => snapshot.agency.groups.find(group => group.id === 'swing').members;
let desktop, page;
async function call(name, input) {
  return page.evaluate(async ({ name, input }) => { const result = await window.guanlan.call(name, input); if (!result.ok) throw Error(result.error); return result.data; }, { name, input });
}
async function refresh() { await page.evaluate(async () => renderState(await api('state'))); }
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'),
    args: [path.join(root, 'tests/fixtures/monitoring-history-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4
    && !state.agencyPool?.running && state.agencyPool?.automation?.status === 'completed', null, { timeout: 30000 });
  assert.equal(path.resolve((await call('state')).dataPath), path.resolve(accountPath));
  await page.locator('[data-page="agency"]').click();
  await page.locator('[data-agency-overview="swing"] [data-agency-select="swing"]').first().click();
  await page.locator('#agency-member-filter').selectOption('active');
  await page.locator('#agency-logs > summary').click();
}
async function count(status, value) { assert.equal(await page.locator(`[data-monitoring-count="${status}"] strong`).innerText(), String(value)); }
async function capture(width, name) {
  await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 950), width);
  await page.setViewportSize({ width, height: 950 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} fits ${width}px`);
  for (const [suffix, selector] of [['summary', '#agency-monitoring-summary'], ['members', '#agency-members']]) {
    const target = page.locator(selector); await target.scrollIntoViewIfNeeded();
    const file = path.join(output, `${name}-${suffix}-${width}.png`); await target.screenshot({ path: file }); screenshots.push(file);
  }
}
(async () => {
  await launch();
  const migrated = await call('state');
  assert.equal(members(migrated).length, 3);
  for (const member of members(migrated)) {
    assert.equal(member.mode, 'active'); assert.equal(member.monitoringCheck, undefined);
    assert.equal(member.legacyMonitoringCheck.reason, oldReason); assert.equal(member.legacyMonitoringCheck.checkedAt, oldTime);
  }
  await count('recheck', 3); await count('data', 0); await count('eligible', 0);
  assert.equal(await page.locator('#agency-members [data-monitoring-status="recheck"]').count(), 3);
  assert.match(await page.locator('#agency-members').innerText(), /未开仓原因：本策略已暂停新开仓/);
  assert.doesNotMatch(await page.locator('#agency-members').innerText(), /公告资料已过期或不可用/);
  assert.equal(await page.locator('#agency-members [data-detail-key="legacy-monitoring"]').count(), 0);
  assert.doesNotMatch(await page.locator('#agency-members').innerText(), /旧版检查记录/);
  assert.match(await page.locator('#agency-overview-note').innerText(), /最多 20 只/);
  for (const width of [1120, 1536]) await capture(width, 'migrated-recheck');
  const detail = page.locator('#agency-members .agency-member-details').first();
  await detail.locator(':scope > summary').click();
  assert.match(await detail.locator('.agency-member-decision').innerText(), /历史决策记录.*公告资料已过期/s);
  for (const width of [1120, 1536]) await capture(width, 'historical-disclosed');
  await detail.locator(':scope > summary').click();
  checks.push('Old checks remain in account archives but have no history disclosure in the recent-check column. Current paused mode explains why no position has opened. Historical decisions remain separately labeled and the 20-candidate limit is unchanged.');

  await call('agency:mode', { strategyId: 'swing', mode: 'running' }); await refresh();
  assert.match(await page.locator('#agency-members [data-unopened-reason]').first().innerText(), /等待连续竞价时段重新检查/);
  checks.push('A running strategy before market open displays the current session reason instead of an obsolete check.');

  scenario.now = '2026-09-29T10:00:00+08:00'; saveScenario();
  await page.waitForFunction(() => state.agency.groups.find(group => group.id === 'swing').members.every(member => member.monitoringCheck?.entryPolicyVersion === 1), null, { timeout: 30000 });
  await refresh();
  const checked = await call('state');
  for (const member of members(checked)) {
    assert.equal(member.monitoringCheck.entryPolicyVersion, 1); assert.equal(member.monitoringCheck.status, 'data');
    assert.doesNotMatch(member.monitoringCheck.reason, /公告/);
    assert.match(member.monitoringCheck.reason, /日线|历史|准备/);
    assert.equal(member.legacyMonitoringCheck.reason, oldReason);
  }
  await count('recheck', 0); await count('data', 3); await count('eligible', 0);
  assert.equal(await page.locator('#agency-members [data-monitoring-status="data"]').count(), 3);
  assert.match(await page.locator('#agency-members [data-unopened-reason]').first().innerText(), /未开仓原因：.*(日线|历史|准备)/);
  assert.doesNotMatch(await page.locator('#agency-members').innerText(), /公告资料已过期或不可用/);
  assert.ok(entries(sourceLog).some(entry => entry.kind === 'real-monitoring-check' && entry.check?.entryPolicyVersion === 1));
  assert.ok(entries(sourceLog).some(entry => entry.kind === 'daily-history'));
  for (const width of [1120, 1536]) await capture(width, 'current-technical-data');
  checks.push('The real AgencyService records current technical data failures from the unavailable daily provider. Recent checks show current preparation/check reasons; obsolete announcement failures are absent.');

  await call('agency:mode', { strategyId: 'swing', mode: 'paused' }); await refresh();
  assert.match(await page.locator('#agency-members [data-unopened-reason]').first().innerText(), /本策略已暂停新开仓/);
  assert.match(await page.locator('#agency-members [data-monitoring-status="data"]').first().innerText(), /最近检查结果：.*(日线|历史|准备)/);
  await call('agency:mode', { strategyId: 'swing', mode: 'stopped' }); await refresh();
  assert.match(await page.locator('#agency-members [data-unopened-reason]').first().innerText(), /本策略已全部停止/);
  await call('agency:mode', { strategyId: 'swing', mode: 'paused' }); await refresh();
  checks.push('Mode changes immediately update the unopened reason while retaining the timestamped last check result.');

  const beforeRestart = persisted(); await desktop.close(); desktop = null; await launch();
  const restarted = await call('state');
  assert.deepEqual(members(restarted).map(member => member.monitoringCheck), members(beforeRestart).map(member => member.monitoringCheck));
  assert.deepEqual(members(restarted).map(member => member.legacyMonitoringCheck), members(beforeRestart).map(member => member.legacyMonitoringCheck));
  await count('recheck', 0); await count('data', 3); await count('eligible', 0);
  assert.doesNotMatch(await page.locator('#agency-members').innerText(), /公告资料已过期或不可用/);
  const finalLedger = persisted();
  assert.equal(JSON.stringify({ cash: finalLedger.cash, lots: finalLedger.lots, trades: finalLedger.trades, orders: finalLedger.orders }), initialLedger);
  assert.deepEqual(errors, []); assert.deepEqual(entries(networkLog), []);
  const sourceEntries = entries(sourceLog);
  assert.equal(sourceEntries.filter(entry => /unexpected-research|unexpected-corporate/.test(entry.kind)).length, 0);
  checks.push('Restart preserves the new technical checks and archived old checks separately. No external network, research/corporate requests, trades, orders, positions, cash changes or renderer errors occurred.');
  const report = { status: 'passed', output, checks, screenshots, errors, isolation: { accountPath, externalRequests: 0, researchRequests: 0,
    corporateRequests: 0, trades: 0, orders: 0, seededVersion: 8, newCheckSource: 'real AgencyService with isolated unavailable daily provider' }, migrated, checked, restarted };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, checks, screenshots }, null, 2));
})().catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(output); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
