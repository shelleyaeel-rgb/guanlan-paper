// Real Electron, preload, IPC and persistence; isolated account/providers only.
'use strict';
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/market-board-ui-'));
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
async function submit(value, symbol) {
  await page.locator('#market-symbol').fill(value); await page.locator('#market-search-submit').click();
  if (symbol) await page.waitForFunction(symbol => selected === symbol && !detailBusy && detail?.symbol === symbol, symbol);
}
async function waitForLog(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate(entries(sourceLog))) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error('Expected provider/IPC log entry did not arrive');
}
async function capture(name, width = 1120) {
  await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await page.setViewportSize({ width, height: 900 }); await page.locator('#market-search-form').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px page overflows`);
  const file = path.join(output, `${name}-${width}.png`); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file);
}
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/index-board-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  await page.waitForFunction(() => !state.agencyPool.running && state.agencyPool.automation?.status === 'completed');
  const initial = await current(); assert.equal(path.resolve(initial.dataPath), path.resolve(accountPath));
  assert.equal(await page.locator('#page-title').innerText(), '自动交易'); assert.equal(await page.evaluate(() => selected), '');
  assert.ok(!entries(sourceLog).some(row => row.kind === 'detail-request'));
  assert.ok(entries(sourceLog).filter(row => row.kind === 'quotes').every(row => !row.symbols.includes('sh600519')));
  await page.locator('[data-page="market"]').click();
  await page.locator('#market-tab-stocks').click();
  assert.equal(await page.locator('#page-title').innerText(), '看盘'); assert.equal(await page.locator('#market-empty').isVisible(), true);
  assert.equal(await page.locator('#market-content').isVisible(), false); assert.equal(await page.locator('#detail-back').isVisible(), false);
  assert.ok(!entries(sourceLog).some(row => row.kind === 'detail-request'));
  await capture('empty');
  checks.push('Application still opens automatic trading; the explicit market navigation opens a stock-free empty state without requesting a default stock.');

  for (const invalid of ['', 'sh000001', 'sz600519', '920001']) {
    const before = entries(sourceLog).filter(row => row.kind === 'detail-request').length;
    await submit(invalid); assert.equal(await page.locator('#market-search-error').isVisible(), true);
    assert.equal(await page.evaluate(() => selected), '');
    assert.equal(entries(sourceLog).filter(row => row.kind === 'detail-request').length, before);
  }
  await submit('600519', 'sh600519');
  await page.waitForFunction(() => state.quotes[selected]?.price === 1500.25);
  assert.equal(await page.locator('#market-empty').isVisible(), false); assert.equal(await page.locator('#market-content').isVisible(), true);
  assert.equal(await page.locator('#stock-symbol').innerText(), 'SH600519'); assert.match(await page.locator('#stock-price').innerText(), /1,?500\.25/);
  assert.equal(await page.locator('#chart [data-bar]').count(), 90);
  assert.match(await page.locator('#chart-source').innerText(), /隔离看盘日线 sh600519.*前复权/);
  assert.match(await page.locator('#indicator-row').innerText(), /MA5/); assert.match(await page.locator('#indicator-row').innerText(), /MA20/);
  assert.match(await page.locator('#indicator-date').innerText(), /2026-09-28/);
  assert.match(await page.locator('#market-quote-metrics').innerText(), /成交量/); assert.match(await page.locator('#market-quote-metrics').innerText(), /成交额/);
  assert.match(await page.locator('#market-quote-metrics').innerText(), /换手/);
  const beforeInvalid = await page.locator('#chart').innerHTML(), requestCount = entries(sourceLog).filter(row => row.kind === 'detail-request').length;
  await submit('600519junk'); assert.equal(await page.evaluate(() => selected), 'sh600519');
  assert.equal(await page.locator('#chart').innerHTML(), beforeInvalid); assert.equal(entries(sourceLog).filter(row => row.kind === 'detail-request').length, requestCount);
  checks.push('Empty, mismatched-market and unsupported full codes display inline errors without detail IPC; a fuzzy query preserves the currently displayed result until explicitly selected. Valid codes show a quote, 90 daily bars, volume/amount/turnover and dated basic indicators.');

  for (const [value, symbol] of [[' SH600519 ', 'sh600519'], ['000001', 'sz000001'], [' Sz000001 ', 'sz000001']]) {
    await submit(value, symbol); assert.equal(await page.locator('#market-search-error').isVisible(), false);
  }
  await page.waitForFunction(() => state.quotes[selected]?.price === 11.25);
  assert.equal(await page.locator('#stock-price').innerText(), '11.25');
  await page.locator('#tab-minute').click(); assert.equal(await page.locator('#chart [data-point]').count(), 2);
  assert.match(await page.locator('#chart-source').innerText(), /隔离看盘分时 sz000001.*分时/);
  await page.locator('#tab-day').click(); assert.equal(await page.locator('#chart [data-bar]').count(), 90);
  await capture('daily'); await capture('daily', 1536);
  checks.push('Six-digit Shanghai/Shenzhen codes and mixed-case prefixed codes with surrounding spaces normalize correctly; daily and intraday tabs render their respective data and sources at 1120px and 1536px.');

  scenario.historyFailures = ['sh600036']; saveScenario();
  await submit('600036'); await page.waitForFunction(() => selected === 'sh600036' && !detailBusy);
  assert.equal(await page.locator('#chart [data-bar]').count(), 0); assert.match(await page.locator('#chart').innerText(), /日 K 数据暂不可用/);
  assert.match(await page.locator('#chart').innerText(), /隔离看盘前复权日线获取失败/);
  assert.deepEqual(await page.locator('#indicator-row b').allTextContents(), ['—', '—', '—', '—', '—']);
  await capture('daily-failure');
  await page.locator('#tab-minute').click(); assert.equal(await page.locator('#chart [data-point]').count(), 2);
  await page.locator('#tab-day').click();
  scenario.historyFailures = []; scenario.minuteFailures = ['sh600036']; saveScenario();
  await submit('600036', 'sh600036'); await page.locator('#tab-minute').click();
  assert.match(await page.locator('#chart').innerText(), /分时数据暂不可用/); assert.match(await page.locator('#chart').innerText(), /隔离看盘分时获取失败/);
  await page.locator('#tab-day').click(); assert.equal(await page.locator('#chart [data-bar]').count(), 90);
  scenario.minuteFailures = []; saveScenario();
  checks.push('Daily failure removes old chart/indicators and shows the provider error; a separate intraday failure leaves daily K-lines available.');

  scenario.quoteFailures = ['sz000002']; saveScenario();
  await submit('000002', 'sz000002');
  assert.equal(await page.locator('#stock-price').innerText(), '—');
  assert.match(await page.locator('#market-data-status').innerText(), /隔离看盘报价获取失败/);
  assert.equal(await page.locator('#chart [data-bar]').count(), 90);
  scenario.quoteFailures = []; saveScenario();
  checks.push('A quote failure is explicitly shown without borrowing the previous stock price, while available historical bars remain usable.');

  scenario.historyLengths = { sh600036: 20 }; saveScenario();
  await submit('600036', 'sh600036');
  assert.equal(await page.locator('#chart [data-bar]').count(), 20);
  const shortIndicators = await page.locator('#indicator-row b').allTextContents();
  assert.notEqual(shortIndicators[0], '—'); assert.notEqual(shortIndicators[1], '—'); assert.equal(shortIndicators[2], '—');
  assert.match(await page.locator('#forecast-content').innerText(), /样本不足/);
  scenario.historyLengths = { sh600036: 1 }; scenario.unfinishedHistory = ['sh600036']; saveScenario();
  await submit('600036', 'sh600036');
  assert.equal(await page.locator('#chart [data-bar]').count(), 1);
  assert.deepEqual(await page.locator('#indicator-row b').allTextContents(), ['—', '—', '—', '—', '—']);
  assert.match(await page.locator('#indicator-date').innerText(), /暂无完整日线/);
  assert.doesNotMatch(await page.locator('#chart').innerHTML(), /NaN|Infinity/);
  await capture('single-unfinished');
  scenario.unfinishedHistory = [];
  scenario.historyLengths = {}; saveScenario();
  checks.push('Twenty available daily bars still render with MA5/MA20; unavailable MA60 and forecast statistics remain explicitly missing. One unfinished daily bar renders correctly while all closed-day indicators remain unavailable.');

  scenario.quoteFailures = ['sh600001']; scenario.historyFailures = ['sh600001']; scenario.minuteFailures = ['sh600001']; saveScenario();
  await submit('600001', 'sh600001');
  assert.equal(await page.locator('#stock-price').innerText(), '—'); assert.equal(await page.locator('#chart [data-bar]').count(), 0);
  const unavailable = await page.locator('#market-data-status').innerText();
  for (const error of ['隔离看盘报价获取失败', '隔离看盘前复权日线获取失败', '隔离看盘分时获取失败']) assert.ok(unavailable.includes(error));
  scenario.quoteFailures = []; scenario.historyFailures = []; scenario.minuteFailures = []; saveScenario();
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !detailBusy && detail?.symbol === 'sh600001' && detail.bars.length > 0 && !detail.quoteError && !detail.dailyError && !detail.minuteError);
  assert.equal(await page.locator('#chart [data-bar]').count(), 90); assert.equal(await page.locator('#market-data-status').isVisible(), false);
  assert.notEqual(await page.locator('#stock-price').innerText(), '—');
  checks.push('Failure of all three market sources is visible; refreshing after providers recover restores the same stock and clears the errors.');

  scenario.historyDelays = { sh600519: 1000 }; scenario.quoteDelays = { sh600519: 1000 }; saveScenario();
  const historyBefore = entries(sourceLog).filter(row => row.kind === 'history-complete' && row.symbol === 'sh600519').length;
  await submit('600519'); await submit('000001', 'sz000001');
  await waitForLog(rows => rows.filter(row => row.kind === 'history-complete' && row.symbol === 'sh600519').length > historyBefore);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => detail.symbol), 'sz000001'); assert.equal(await page.locator('#stock-symbol').innerText(), 'SZ000001');
  assert.equal(await page.locator('#stock-price').innerText(), '11.25'); assert.match(await page.locator('#chart-source').innerText(), /sz000001/);
  assert.doesNotMatch(await page.locator('#chart-source').innerText(), /sh600519/);
  checks.push('A delayed earlier stock response cannot replace the later selected stock, quote or chart.');

  const closeCount = entries(sourceLog).filter(row => row.kind === 'ipc' && row.name === 'detail:close').length;
  await page.locator('[data-page="agency"]').click(); await waitForLog(rows => rows.filter(row => row.kind === 'ipc' && row.name === 'detail:close').length > closeCount);
  assert.equal(await page.evaluate(() => selected), '');
  const afterClose = entries(sourceLog).length;
  await page.locator('#refresh').click();
  await waitForLog(rows => rows.slice(afterClose).some(row => row.kind === 'quotes-complete'));
  assert.ok(entries(sourceLog).slice(afterClose).filter(row => row.kind === 'quotes').every(row => !row.symbols.includes('sz000001')));
  await page.locator('[data-page="market"]').click(); await page.locator('#market-tab-stocks').click(); assert.equal(await page.locator('#market-empty').isVisible(), true);
  await page.locator('[data-page="agency"]').click(); await page.locator('[data-agency-tab="swing"]').click();
  await page.locator('#agency-members [data-agency-open]').first().click();
  await page.waitForFunction(() => detail?.bars?.length && !detailBusy);
  assert.equal(await page.locator('#page-title').innerText(), '个股详情'); assert.equal(await page.locator('#detail-back').isVisible(), true);
  await page.locator('#detail-back').click(); assert.equal(await page.locator('#page-title').innerText(), '自动交易'); assert.equal(await page.evaluate(() => selected), '');
  const final = await current();
  assert.deepEqual(final.account.watchlist, initial.account.watchlist); assert.deepEqual(final.account.trades, initial.account.trades);
  assert.deepEqual(final.account.orders, initial.account.orders); assert.deepEqual(final.account.lots, initial.account.lots);
  assert.deepEqual(final.agency.groups.map(group => group.members.map(member => member.symbol)), initial.agency.groups.map(group => group.members.map(member => member.symbol)));
  const retired = ['watch:add', 'watch:remove', 'trade', 'order', 'strategy:buy', 'agency:members:add'];
  assert.ok(!entries(sourceLog).some(row => row.kind === 'ipc' && retired.includes(row.name)));
  for (const selector of ['#watchlist', '#watch-form', '#trade-form', '#risk-form', '#strategy-buy']) assert.equal(await page.locator(selector).count(), 0, selector);
  checks.push('Leaving closes the preview subscription and clears selection; auto-trading member details retain their title/back link. Browsing does not modify watchlist, orders, trades, holdings or strategy membership, and invokes no retired write IPC.');
  assert.deepEqual(errors, []); assert.deepEqual(entries(networkLog), []);
  const report = { status: 'passed', output, checks, screenshots, errors, isolation: { accountPath, unexpectedNetwork: 0 } };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(output); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
