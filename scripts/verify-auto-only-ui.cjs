// Real Electron, IPC, migration and persistence; isolated data and providers only.
'use strict';
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const root = path.resolve(__dirname, '..');
async function revealPoolControl(selector) {
  await page.locator(selector).evaluate(element => { for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
}
const output = fs.mkdtempSync(path.join(root, 'work/auto-only-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'unexpected-network.jsonl'), poolLog = path.join(output, 'pool-requests.jsonl');
const sourceLog = path.join(output, 'sources.jsonl');
const symbols = Array.from({ length: 8 }, (_, index) => `sh${601800 + index}`);
const scenario = { now: '2026-09-29T08:46:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', poolDelay: 100, poolOnlySwing: true, poolSymbols: symbols };
fs.writeFileSync(controlPath, JSON.stringify(scenario));
const engine = new Engine(initialState(), () => new Date(scenario.now));
// Simulate the previous release on disk. This never invokes removed manual IPC.
engine.s.agency.version = 6;
delete engine.s.agency.legacyManual;
engine.s.watchlist = ['sh600519', 'sh600001'];
engine.s.lots.push({ id: 'legacy-lot', symbol: 'sh600001', name: '隔离历史持仓', quantity: 100, cost: 100000, date: '2026-09-28' });
engine.s.cash -= 100000; engine.s.agency.manualCash -= 100000;
engine.s.orders.push({ id: 'legacy-order', symbol: 'sh600002', side: 'buy', quantity: 100, limit: 10.3, status: 'pending', createdAt: new Date(scenario.now).getTime(), note: '旧版未完成委托' });
fs.mkdirSync(accountPath); fs.writeFileSync(path.join(accountPath, 'account.json'), JSON.stringify(engine.s, null, 2));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog, GUANLAN_TEST_POOL_LOG: poolLog, GUANLAN_TEST_SOURCE_LOG: sourceLog };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [], checks = [], screenshots = [];
let desktop, page;
const entries = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function current() { return page.evaluate(async () => { const value = await window.guanlan.call('state'); if (!value.ok) throw Error(value.error); return value.data; }); }
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/auto-only-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
}
async function capture(name, selector, width = 1120) {
  await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 850), width);
  await page.setViewportSize({ width, height: 850 });
  await page.locator(selector).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const file = path.join(output, `${name}-${width}.png`); await page.screenshot({ path: file }); screenshots.push(file);
}
(async () => {
  await launch();
  const initial = await current();
  assert.equal(path.resolve(initial.dataPath), path.resolve(accountPath));
  assert.equal(initial.agency.version, 7);
  assert.equal(await page.locator('#page-title').innerText(), '自动交易');
  assert.equal(await page.evaluate(() => selected), '');
  for (const selector of ['#watchlist', '#watch-form', '#trade-form', '#risk-form', '#strategy-buy', '#agency-add', '#agency-assign-dialog', '#page-screener', '#screen-agency-dialog']) assert.equal(await page.locator(selector).count(), 0, selector);
  assert.equal(await page.locator('[data-page="market"]').count(), 1);
  assert.equal(initial.account.orders[0].status, 'cancelled');
  assert.equal(initial.account.lots[0].quantity, 100);
  assert.ok(entries(sourceLog).filter(row => row.kind === 'quotes').every(row => !row.symbols.includes('sh600519')));
  assert.ok(!entries(sourceLog).some(row => row.kind === 'ipc' && ['detail', 'research:get'].includes(row.name)));
  checks.push('Version-six isolated account upgrades to seven; default automatic page has no selected stock, watchlist, manual trade, risk editor, member assignment or independent screener. Legacy pending order is cancelled and holding preserved.');
  await page.waitForFunction(() => !state.agencyPool.running && state.agencyPool.lastResult && state.agencyPool.automation?.status === 'completed', null, { timeout: 30000 });
  assert.match(await page.locator('#agency-pool-automation-status').innerText(), /今日已完成更新/);
  const afterPool = await current(), swing = afterPool.agency.groups.find(group => group.id === 'swing');
  assert.equal(swing.members.filter(member => member.mode === 'active').length, 6);
  assert.equal(swing.members.filter(member => member.mode === 'standby').length, 2);
  assert.equal(afterPool.account.trades.length, 0);
  checks.push('Startup automatically refreshes current-day pool without clicking; eight deterministic matches produce six active and two standby, with no trades.');
  await capture('automatic-home', '#agency-pool-automation');
  await page.locator('[data-agency-tab="swing"]').click();
  await page.locator('#agency-members [data-agency-open]').first().click();
  await page.waitForFunction(() => typeof detail !== 'undefined' && detail?.bars?.length);
  await page.waitForFunction(() => state.quotes[selected]?.price > 0);
  assert.notEqual(await page.locator('#stock-price').innerText(), '—');
  assert.equal(await page.locator('#page-title').innerText(), '个股详情');
  await capture('readonly-detail', '.chart-card');
  await page.locator('#detail-back').click();
  assert.equal(await page.evaluate(() => selected), '');
  assert.ok(entries(sourceLog).some(row => row.kind === 'ipc' && row.name === 'detail:close'));
  checks.push('Candidate opens real read-only K-line/F10 detail; returning clears selected stock and closes preview subscription.');
  await page.locator('[data-page="portfolio"]').click();
  assert.match(await page.locator('#positions-table').innerText(), /历史持仓/);
  assert.equal(await page.locator('[data-legacy-exit]').count(), 1);
  assert.match(await page.locator('#orders-table').innerText(), /已撤销/);
  await capture('legacy-portfolio', '#positions-table');
  await page.locator('[data-legacy-exit]').click();
  await page.locator('#confirm-cancel').click();
  assert.equal((await current()).account.trades.length, 0);
  // An isolated market session is necessary for the exit IPC's real business checks.
  scenario.now = '2026-09-29T10:00:00+08:00'; fs.writeFileSync(controlPath, JSON.stringify(scenario));
  await page.locator('#refresh').click();
  await page.locator('[data-legacy-exit]').click(); await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => state.account.trades.some(trade => trade.side === 'sell' && trade.symbol === 'sh600001'));
  const exited = await current(); assert.equal(exited.account.lots.length, 0); assert.equal(exited.account.trades.length, 1);
  checks.push('Legacy exit can be cancelled without mutation; during an isolated valid trading session it sells the entire available historical holding through real IPC.');
  await page.locator('[data-page="settings"]').click();
  await page.waitForSelector('.investment-strategy');
  assert.equal(await page.locator('.investment-strategy').count(), 4);
  assert.equal(await page.locator('[data-use-strategy]').count(), 0);
  assert.doesNotMatch(await page.locator('#page-settings').innerText(), /手动可用|手动账户|用此策略选股/);
  checks.push('Settings retains four read-only strategy explanations and uses unallocated-funds wording.');
  await page.locator('[data-page="agency"]').click();
  await revealPoolControl('#agency-pool-legacy'); await page.locator('#agency-pool-legacy').check();
  await page.locator('#agency-pool-run').click();
  await page.waitForFunction(() => !state.agencyPool.running && !agencyUi.busy.has('pool-run') && state.agencyPool.savedPolicy?.screeningMode === 'strict');
  await capture('automatic-home', '#agency-pool-automation', 1536);
  const runsBeforeRestart = entries(poolLog).length;
  await desktop.close(); desktop = null;
  await launch();
  assert.equal(await page.locator('#agency-pool-legacy').isChecked(), true);
  assert.equal(await page.evaluate(() => selected), '');
  assert.equal(entries(poolLog).length, runsBeforeRestart);
  assert.equal((await current()).account.trades.length, 1);
  checks.push('Applying strict pool mode persists it; restart restores the same visible mode and historical exit, and does not repeat a completed same-day scan. Both 1120px and 1536px layouts fit.');
  assert.deepEqual(errors, []); assert.deepEqual(entries(networkLog), []);
  const report = { status: 'passed', output, checks, screenshots, errors, isolation: { accountPath, unexpectedNetwork: 0 }, initial, afterPool, exited };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, checks, screenshots }, null, 2));
})().catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(output); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
