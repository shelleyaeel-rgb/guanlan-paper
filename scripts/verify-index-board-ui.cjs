// Real Electron/preload/IPC; deterministic providers and an isolated account.
'use strict';
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/index-board-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const sourceLog = path.join(output, 'sources.jsonl'), networkLog = path.join(output, 'unexpected-network.jsonl');
const scenario = { now: '2026-09-29T08:46:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready',
  poolDelay: 100, poolOnlySwing: true, poolSymbols: ['sh601800', 'sh601801'] };
const saveScenario = () => fs.writeFileSync(controlPath, JSON.stringify(scenario)); saveScenario();
const entries = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_SOURCE_LOG: sourceLog, GUANLAN_TEST_NETWORK_LOG: networkLog };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
const checks = [], screenshots = [], errors = [];
async function current() { return page.evaluate(async () => { const result = await window.guanlan.call('state'); if (!result.ok) throw Error(result.error); return result.data; }); }
async function waitForLog(predicate) {
  for (let attempt = 0; attempt < 150; attempt++) { if (predicate(entries(sourceLog))) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error('Expected isolated provider/IPC log entry did not arrive');
}
const card = id => page.locator(`[data-index-id="${id}"]`);
async function refresh() {
  const before = entries(sourceLog).filter(row => ['index-complete', 'index-failed'].includes(row.kind)).length;
  await page.locator('#index-refresh').click();
  await waitForLog(rows => rows.filter(row => ['index-complete', 'index-failed'].includes(row.kind)).length > before);
  await page.waitForFunction(() => !document.getElementById('index-refresh').disabled);
}
async function capture(name, width = 1120) {
  await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await page.setViewportSize({ width, height: 900 }); await page.locator('#market-tab-indices').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px page overflows`);
  const file = path.join(output, `${name}-${width}.png`); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file);
}
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/index-board-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  await page.waitForFunction(() => !state.agencyPool.running && state.agencyPool.automation?.status === 'completed');
  const initial = await current(); assert.equal(path.resolve(initial.dataPath), path.resolve(accountPath));
  assert.equal(await page.locator('#page-title').innerText(), '自动交易');
  assert.ok(!entries(sourceLog).some(row => row.kind === 'index-start'));
  await page.locator('[data-page="market"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#index-board [data-index-id]').length === 8);
  assert.equal(await page.locator('#market-index-panel').isVisible(), true);
  assert.equal(await page.locator('#market-stock-panel').isVisible(), false);
  assert.equal(await page.evaluate(() => selected), '');
  assert.ok(!entries(sourceLog).some(row => row.kind === 'detail-request'));
  assert.match(await card('cn-shanghai').innerText(), /3,?210\.25/);
  assert.match(await card('cn-shanghai').innerText(), /隔离指数行情/);
  assert.match(await card('us-sp500').innerText(), /04:00:00/);
  assert.match(await card('us-sp500').innerText(), /北京时间/);
  await card('us-sp500').locator('summary').click();
  assert.match(await card('us-sp500').innerText(), /2026-09-28/);
  assert.match(await card('us-sp500').innerText(), /16:00:00/);
  assert.match(await card('us-sp500').innerText(), /America\/New_York|纽约|当地/);
  await card('us-sp500').locator('summary').click();
  assert.match(await card('us-nasdaq').innerText(), /0\.00%/);
  assert.doesNotMatch(await page.locator('#index-board').innerHTML(), /NaN|Infinity/);
  checks.push('Opening the market starts the independent index board without a stock subscription; quotes include source and each market’s dated local time, with zero change preserved.');

  const expectedGroups = { cn: ['cn-shanghai', 'cn-shenzhen'], hk: ['hk-hsi'], us: ['us-sp500', 'us-nasdaq'],
    asia: ['asia-nikkei'], europe: ['europe-dax', 'europe-ftse'] };
  for (const [group, expected] of Object.entries(expectedGroups)) {
    await page.locator(`[data-index-group="${group}"]`).click();
    assert.deepEqual(await page.locator('#index-board [data-index-id]:visible').evaluateAll(nodes => nodes.map(node => node.dataset.indexId)), expected);
  }
  await page.locator('[data-index-group="all"]').click();
  assert.equal(await page.locator('#index-board [data-index-id]:visible').count(), 8);
  await capture('overview', 1536); await capture('overview', 1120); await capture('overview-narrow', 800);
  checks.push('China, Hong Kong, US, Asia and Europe filters show only their indices; the overview fits 800px, 1120px and 1536px without page overflow.');

  scenario.indexUnavailable = ['us-sp500']; scenario.indexStale = ['hk-hsi']; saveScenario(); await refresh();
  assert.match(await card('us-sp500').innerText(), /隔离指数未返回有效报价/);
  assert.match(await card('us-sp500').innerText(), /—/);
  assert.doesNotMatch(await card('us-sp500').innerText(), /0\.00%|6,?500\.25/);
  assert.match(await card('hk-hsi').innerText(), /22,?120\.75/);
  assert.match(await card('hk-hsi').innerText(), /隔离指数刷新失败|保留|上次/);
  assert.match(await card('cn-shanghai').innerText(), /3,?210\.25/);
  await capture('partial-failure');
  checks.push('Missing index values remain absent with their provider error; a stale quote retains its value with an explicit failure notice and does not hide healthy indices.');

  scenario.indexFailure = true; saveScenario(); await refresh();
  assert.match(await page.locator('#index-status').innerText(), /隔离指数接口暂时不可用/);
  assert.match(await card('cn-shanghai').innerText(), /3,?210\.25/);
  scenario.indexFailure = false; scenario.indexUnavailable = []; scenario.indexStale = []; saveScenario(); await refresh();
  assert.doesNotMatch(await page.locator('#index-status').innerText(), /隔离指数接口暂时不可用/);
  assert.match(await card('us-sp500').innerText(), /6,?500\.25/);
  const beforeHeader = entries(sourceLog).length;
  await page.locator('#refresh').click();
  await waitForLog(rows => rows.slice(beforeHeader).some(row => row.kind === 'index-complete' && row.force));
  assert.ok(!entries(sourceLog).slice(beforeHeader).some(row => row.kind === 'ipc' && ['view:refresh', 'refresh', 'detail'].includes(row.name)));
  checks.push('A whole-board failure retains the last displayed data with an error; retry recovers. Header refresh on the index page requests only index data.');

  await page.locator('#market-tab-stocks').click();
  assert.equal(await page.locator('#market-stock-panel').isVisible(), true);
  assert.equal(await page.locator('#market-index-panel').isVisible(), false);
  await page.locator('#market-symbol').fill('600519'); await page.locator('#market-search-submit').click();
  await page.waitForFunction(() => selected === 'sh600519' && !detailBusy && detail?.symbol === 'sh600519');
  assert.equal(await page.locator('#chart [data-bar]').count(), 90);
  const closeBefore = entries(sourceLog).filter(row => row.kind === 'ipc' && row.name === 'detail:close').length;
  await page.locator('#market-tab-indices').click();
  await waitForLog(rows => rows.filter(row => row.kind === 'ipc' && row.name === 'detail:close').length > closeBefore);
  assert.equal(await page.evaluate(() => selected), '');
  assert.equal(await page.locator('#market-search-results').isVisible(), false);
  checks.push('The stock tab preserves search and charts; returning to indices closes the stock preview and clears selection.');

  scenario.indexDelay = 700; saveScenario();
  const delayedBefore = entries(sourceLog).length;
  await page.locator('#index-refresh').click();
  await waitForLog(rows => rows.slice(delayedBefore).some(row => row.kind === 'index-start'));
  await page.locator('[data-page="agency"]').click();
  await waitForLog(rows => rows.slice(delayedBefore).some(row => row.kind === 'index-complete'));
  assert.equal(await page.locator('#page-market').isVisible(), false);
  assert.equal(await page.evaluate(() => selected), '');
  scenario.indexDelay = 0; saveScenario();
  await page.locator('[data-agency-tab="swing"]').click();
  await page.locator('#agency-members [data-agency-open]').first().click();
  await page.waitForFunction(() => detail?.bars?.length && !detailBusy);
  assert.equal(await page.locator('#page-title').innerText(), '个股详情');
  assert.equal(await page.locator('#market-stock-panel').isVisible(), true);
  assert.equal(await page.locator('#market-index-panel').isVisible(), false);
  assert.equal(await page.locator('#detail-back').isVisible(), true);
  await page.locator('#market-symbol').fill('600519'); await page.locator('#market-search-submit').click();
  await page.waitForFunction(() => selected === 'sh600519' && !detailBusy && detail?.symbol === 'sh600519');
  assert.equal(await page.locator('#market-stock-panel').isVisible(), true);
  assert.equal(await page.locator('#market-index-panel').isVisible(), false);
  assert.equal(await page.locator('#page-title').innerText(), '看盘');
  await page.locator('[data-page="agency"]').click();
  await page.locator('#agency-members [data-agency-open]').first().click();
  await page.waitForFunction(() => detail?.bars?.length && !detailBusy);
  await page.locator('#detail-back').click();
  assert.equal(await page.locator('#page-title').innerText(), '自动交易');
  checks.push('A delayed index response cannot reopen a page after leaving. Strategy members still open stock details; searching another stock there keeps the stock tab, and the member detail return action works.');

  const final = await current();
  for (const key of ['watchlist', 'trades', 'orders', 'lots']) assert.deepEqual(final.account[key], initial.account[key], key);
  assert.deepEqual(final.agency.groups.map(group => group.members.map(member => member.symbol)), initial.agency.groups.map(group => group.members.map(member => member.symbol)));
  const writes = ['watch:add', 'watch:remove', 'trade', 'order', 'strategy:buy', 'agency:members:add'];
  assert.ok(!entries(sourceLog).some(row => row.kind === 'ipc' && writes.includes(row.name)));
  assert.deepEqual(errors, []); assert.deepEqual(entries(networkLog), []);
  checks.push('Index and stock browsing preserve account holdings, trades, orders and strategy members, with no renderer exceptions or external requests.');
  const report = { status: 'passed', output, checks, screenshots, errors, isolation: { accountPath, unexpectedNetwork: 0 } };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(output); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
