// Optional real Electron UI check. Uses existing Playwright and fixture-only HTTP.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/screener-agency-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'unexpected-network.jsonl'), batchLog = path.join(output, 'batch-requests.jsonl');
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog, GUANLAN_TEST_BATCH_LOG: batchLog };
delete env.ELECTRON_RUN_AS_NODE;
const scenarioState = { now: '2026-09-30T10:00:00+08:00', price: 10.08, dailyMode: 'ready', financeMode: 'ready' };
const scenario = patch => { Object.assign(scenarioState, patch); fs.writeFileSync(controlPath, JSON.stringify(scenarioState)); };
const entries = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const group = (current, id = 'swing') => current.agency.groups.find(item => item.id === id);
const checks = [], errors = []; let desktop, page;
async function call(name, payload) {
  return page.evaluate(async ({ name, payload }) => {
    if (['trade', 'order', 'strategy:buy', 'agency:transfer'].includes(name)) payload = { ...payload, requestId: crypto.randomUUID(), accountCreatedAt: (await window.guanlan.call('state')).data.account.createdAt }; const result = await window.guanlan.call(name, payload);
    if (!result.ok) throw Error(result.error);
    return result.data;
  }, { name, payload });
}
async function idle() {
  await page.waitForFunction(() => !screenBusy && (screenResult || !document.querySelector('#screen-error').classList.contains('hidden')), null, { timeout: 90000 });
}
async function run() { await page.locator('#screen-run').click(); await idle(); }
async function clear() { await page.locator('#screen-reset').click(); await run(); }
async function query(text) { await page.locator('#screen-description').fill(text); await page.locator('#screen-parse').click(); await idle(); }
async function open() { await page.locator('#screen-agency-all').click(); await page.waitForFunction(() => document.querySelector('#screen-agency-dialog').open); }
async function close() { await page.locator('#screen-agency-close').click(); await page.waitForFunction(() => !document.querySelector('#screen-agency-dialog').open); }
async function done() { await page.waitForFunction(() => !screenAgencyBusy && document.querySelector('#screen-agency-submit').classList.contains('hidden'), null, { timeout: 90000 }); }
async function snapshot(label) {
  for (const [width, height] of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows()[0].setSize(...dimensions), [width, height]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label} document fits ${width}px`);
    assert.equal(await page.evaluate(() => {
      const dialog = document.querySelector('#screen-agency-dialog');
      return !dialog.open || dialog.scrollWidth <= dialog.clientWidth;
    }), true, `${label} dialog fits ${width}px`);
    await page.screenshot({ path: path.join(output, `${label}-${width}.png`), fullPage: true });
  }
}
function untouched(before, after) {
  assert.equal(after.account.cash, before.account.cash);
  assert.equal(after.agency.manualCash, before.agency.manualCash);
  assert.deepEqual(after.account.trades, before.account.trades);
  // Background quote refresh may update a pending order's explanatory note.
  const orders = current => current.account.orders.map(({ note, ...order }) => order);
  assert.deepEqual(orders(after), orders(before));
  assert.deepEqual(after.account.agency.transfers, before.account.agency.transfers);
  assert.deepEqual(after.agency.groups.map(item => ({ id: item.id, mode: item.mode, cash: item.cash })), before.agency.groups.map(item => ({ id: item.id, mode: item.mode, cash: item.cash })));
}
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/screener-agency-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), path.resolve(accountPath));
  await page.locator('[data-page="screener"]').click(); await idle();
}
(async () => {
  scenario({}); await launch(); await clear();
  assert.equal(await page.evaluate(() => screenResult.rows.length), 135);
  assert.equal(await page.locator('#screen-table tbody tr').count(), 30);
  assert.match(await page.locator('#screen-agency-all').innerText(), /全部加入自动交易.*135/);
  const original = await call('state');
  await open(); assert.equal(await page.locator('#screen-agency-strategy').inputValue(), 'swing');
  assert.match(await page.locator('#screen-agency-summary').innerText(), /135/);
  await close(); assert.equal(entries(batchLog).length, 0); untouched(original, await call('state'));
  checks.push('custom selection defaults to swing; cancelling does not call the batch API or mutate the account');

  await page.locator('#screen-next').click(); assert.match(await page.locator('#screen-page-info').innerText(), /第 2/);
  await page.locator('#screen-result-search').fill('600519');
  assert.equal(await page.locator('#screen-table tbody tr').count(), 1);
  assert.match(await page.locator('#screen-agency-all').innerText(), /135/);
  await open(); assert.match(await page.locator('#screen-agency-summary').innerText(), /135/);
  await snapshot('confirm-all-results');
  scenario({ quoteDelay: 600 });
  await page.locator('#screen-agency-submit').click();
  assert.equal(await page.locator('#screen-agency-submit').isDisabled(), true);
  await page.locator('#screen-agency-submit').evaluate(button => { button.click(); button.click(); });
  await done(); scenario({ quoteDelay: 0 });
  let current = await call('state');
  assert.equal(group(current).members.length, 135); untouched(original, current);
  assert.equal(entries(batchLog).length, 1); assert.equal(entries(batchLog)[0].symbols.length, 135);
  assert.equal(new Set(entries(batchLog)[0].symbols).size, 135);
  assert.equal(await page.locator('#screen-agency-result').innerText(), '共 135 只：已加入 135 只 · 跳过 0 只 · 未加入 0 只。');
  checks.push('one batch adds all 135 results across pages despite a one-row search; rapid repeat clicks send one request; cash, funding, group modes and orders stay unchanged');
  await snapshot('all-results-added');
  await close(); await open(); await page.locator('#screen-agency-submit').click(); await done();
  assert.equal(group(await call('state')).members.length, 135);
  assert.equal(await page.locator('#screen-agency-result').innerText(), '共 135 只：已加入 0 只 · 跳过 135 只 · 未加入 0 只。');
  assert.match(await page.locator('#screen-agency-details').innerText(), /已在|已加入|已有/);
  checks.push('a repeated complete submission skips existing members and explains the reason without duplicates');
  await page.locator('#screen-agency-view').click();
  await page.waitForFunction(() => page === 'agency');
  assert.match(await page.locator('#agency-members').innerText(), /600519/);
  assert.equal(await page.locator('#agency-members tbody tr').count(), 30);
  for (let index = 0; index < 4; index++) await page.locator('#agency-member-next').click();
  assert.match(await page.locator('#agency-member-page-info').innerText(), /第 5 \/ 5 页/);
  assert.equal(await page.locator('#agency-members tbody tr').count(), 15);
  const lastSymbol = group(await call('state')).members.at(-1).symbol;
  assert.ok((await page.locator('#agency-members').innerText()).includes(lastSymbol.slice(2)));
  await page.locator('#agency-member-search').fill(lastSymbol);
  assert.equal(await page.locator('#agency-members tbody tr').count(), 1);
  await page.locator('#agency-member-held').check();
  assert.equal(await page.locator('#agency-members tbody tr').count(), 0);
  await page.locator('#agency-member-held').uncheck(); await page.locator('#agency-member-search').fill('');
  await snapshot('agency-members');
  checks.push('the destination paginates 135 members over five pages, reaches the final member, searches by symbol and filters to held positions');
  await call('refresh'); current = await call('state'); assert.equal(group(current).members.length, 135); untouched(original, current);
  await desktop.close(); desktop = null; await launch();
  current = await call('state'); assert.equal(group(current).members.length, 135); untouched(original, current);
  checks.push('view strategy opens the destination; 135 memberships survive market refresh and a full Electron restart');

  await clear();
  await page.locator('#screen-exclude-st').check(); assert.equal(await page.locator('#screen-agency-all').isDisabled(), true);
  await run(); assert.equal(await page.locator('#screen-agency-all').isDisabled(), false);
  await page.locator('#screen-description').fill('股价大于1元'); assert.equal(await page.locator('#screen-agency-all').isDisabled(), true);
  await page.locator('#screen-parse').click(); await idle();
  scenario({ screenDelay: 1200 }); await page.locator('#screen-run').click();
  await page.waitForFunction(() => screenBusy); assert.equal(await page.locator('#screen-agency-all').isDisabled(), true);
  await idle(); scenario({ screenDelay: 0 });
  scenario({ screenFail: true }); await run();
  assert.match(await page.locator('#screen-error').innerText(), /上次结果/); assert.equal(await page.locator('#screen-agency-all').isDisabled(), true);
  scenario({ screenFail: false }); await run(); assert.equal(await page.locator('#screen-agency-all').isDisabled(), false);
  await query('股价大于100000元'); assert.equal(await page.evaluate(() => screenResult.rows.length), 0);
  assert.equal(await page.locator('#screen-agency-all').isDisabled(), true);
  scenario({ screenMode: 'missing-pe' }); await query('市盈率小于20');
  assert.equal(await page.evaluate(() => screenResult.status), 'unavailable'); assert.equal(await page.locator('#screen-agency-all').isDisabled(), true);
  scenario({ screenMode: null }); await clear();
  checks.push('dirty conditions, unapplied text, in-progress scan, failed refresh, empty and unavailable results disable batch addition; successful rerun recovers');

  await page.locator('#screen-strategy').selectOption('long'); await run();
  assert.ok(await page.evaluate(() => screenResult.rows.length > 0));
  await open(); assert.equal(await page.locator('#screen-agency-strategy').inputValue(), 'long'); await close();
  checks.push('a completed strategy screening defaults the destination to its result strategy');

  await call('reset', { confirm: '重置', capital: 1000000 }); await clear();
  await call('order', { symbol: 'sh600001', side: 'buy', quantity: 100, limit: 1 });
  await call('agency:member', { strategyId: 'short', symbol: 'sh600003', action: 'add' });
  const beforePartial = await call('state');
  scenario({ quoteMissing: ['sh600002'] });
  await open(); await page.locator('#screen-agency-submit').click(); await done();
  current = await call('state');
  assert.equal(group(current).members.length, 132); assert.equal(group(current, 'short').members.length, 1); untouched(beforePartial, current);
  const resultText = await page.locator('#screen-agency-result').innerText(), details = await page.locator('#screen-agency-details').innerText();
  assert.equal(resultText, '共 135 只：已加入 132 只 · 跳过 2 只 · 未加入 1 只。');
  for (const symbol of ['600001', '600002', '600003']) assert.ok(details.includes(symbol), `missing failure detail for ${symbol}`);
  assert.match(details, /手动委托/); assert.match(details, /行情/); assert.match(details, /短线|其他策略|重复归属/);
  await snapshot('partial-result'); await close(); scenario({ quoteMissing: [] });
  await open(); await page.locator('#screen-agency-submit').click(); await done();
  current = await call('state'); assert.equal(group(current).members.length, 133); untouched(beforePartial, current);
  checks.push('partial batch adds valid members, reports each missing quote/manual-order conflict/cross-strategy owner, and retries only the newly available member');
  await close(); await call('refresh'); await desktop.close(); desktop = null; await launch();
  current = await call('state'); assert.equal(group(current).members.length, 133); assert.equal(group(current, 'short').members.length, 1); untouched(beforePartial, current);
  assert.deepEqual(errors, []); assert.equal(entries(networkLog).length, 0);
  checks.push('partial memberships and original ownership persist after restart; no unhandled renderer errors or live network requests');
  const report = { output, accountPath, errors, checks, memberCount: current.agency.groups.reduce((sum, item) => sum + item.members.length, 0), tradeCount: current.account.trades.length, unexpectedNetworkRequests: entries(networkLog).length };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  console.error(error); console.error('Output:', output);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
