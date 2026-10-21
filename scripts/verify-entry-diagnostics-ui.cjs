// Verify actual source data -> business calculations -> IPC -> Electron DOM.
// Main flows use real IPC; final display boundaries use an explicit copied state.
// No writes to the user's normal account.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/entry-diagnostics-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'unexpected-network.jsonl');
const control = { now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', corporateMode: 'offline', historyMode: 'short' };
const scenario = patch => { Object.assign(control, patch); fs.writeFileSync(controlPath, JSON.stringify(control)); };
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog };
delete env.ELECTRON_RUN_AS_NODE;
const trendSymbol = 'sh600519', dailySymbol = 'sz001395', sourceError = '隔离公司行为来源暂不可用';
const checks = [], errors = [];
let desktop, page;
async function call(name, payload) {
  return page.evaluate(async ({ name, payload }) => {
    if (['trade', 'order', 'strategy:buy', 'agency:transfer'].includes(name)) payload = { ...payload, requestId: crypto.randomUUID(), accountCreatedAt: (await window.guanlan.call('state')).data.account.createdAt }; const result = await window.guanlan.call(name, payload);
    if (!result.ok) throw Error(result.error);
    return result.data;
  }, { name, payload });
}
const groupOf = state => state.agency.groups.find(group => group.id === 'long');
const memberOf = (state, symbol = dailySymbol) => groupOf(state).members.find(member => member.symbol === symbol);
const decisionOf = (state, symbol) => state.agency.decisions.findLast(item => item.strategyId === 'long' && item.symbol === symbol);
async function waitState(predicate, timeout = 20000) {
  const until = Date.now() + timeout;
  let state;
  while (Date.now() < until) {
    state = await call('state');
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Entry diagnostics state timeout: ' + JSON.stringify({ group: groupOf(state), runtime: state?.agency.runtime, recent: state?.agency.decisions.slice(-8) }));
}
const row = symbol => page.locator('#agency-members tr').filter({ has: page.locator(`[data-agency-open="${symbol}"]`) });
async function idle() {
  await waitState(state => !state.agency.runtime.runningGroups.length);
  await page.waitForFunction(() => !agencyUi.busy.size);
}
async function run() {
  await idle();
  await call('agency:run', { strategyId: 'long' });
  await idle();
}
async function renderedDecision(state, symbol) {
  const id = decisionOf(state, symbol).id;
  await page.waitForFunction(id => state.agency.decisions.some(item => item.id === id), id);
}
async function snapshot(name, dialog = false) {
  for (const [width, height] of [[1120, 760], [1536, 980]]) {
    await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: viewport overflow at ${width}`);
    if (dialog) assert.equal(await page.locator('#agency-reconcile-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), true, `${name}: dialog overflow at ${width}`);
    await (dialog ? page.locator('#agency-reconcile-dialog') : page.locator('#agency-members')).screenshot({ path: path.join(output, `${name}-${width}.png`) });
  }
}
async function verifyInDialog() {
  await page.locator('#agency-reconcile-verify').click();
  await page.waitForFunction(() => !agencyUi.busy.size);
  return call('state');
}
function unchanged(state, initialCash) {
  assert.equal(state.account.trades.length, 0);
  assert.equal(state.account.lots.length, 0);
  assert.equal(state.account.cash, initialCash);
  assert.equal(groupOf(state).cash, 50000000);
}
(async () => {
  scenario({});
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/entry-diagnostics-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  const initial = await call('state'), initialCash = initial.account.cash;
  assert.equal(path.resolve(initial.dataPath), path.resolve(accountPath));
  await call('agency:transfer', { strategyId: 'long', amount: 500000 });
  for (const symbol of [trendSymbol, dailySymbol]) await call('agency:member', { strategyId: 'long', symbol, action: 'add' });
  await call('agency:mode', { strategyId: 'long', mode: 'running' });
  await idle();
  await call('agency:verify', { strategyId: 'long' });
  await run();
  await page.locator('[data-page="agency"]').click();
  await page.locator('[data-agency-tab="long"]').click();

  const trend = await waitState(state => /MA20 10 < MA60 16\.666667/.test(decisionOf(state, trendSymbol)?.reason));
  const decision = decisionOf(trend, trendSymbol);
  assert.equal(decision.status, 'waiting');
  assert.match(decision.reason, /MA60 16\.666667 < 前一日 MA60 16\.833333/);
  assert.match(decision.reason, /完整日线收盘价 10 < MA60 16\.666667/);
  assert.doesNotMatch(decision.reason, /ROE|动态 PE|经营现金流|财务门槛/);
  assert.equal(decision.inputSources.find(source => source.kind === 'finance').status, 'ready');
  assert.equal(decision.inputSources.find(source => source.kind === 'valuation').status, 'ready');
  await page.waitForFunction(() => document.querySelector('#agency-members').textContent.includes('MA20 10 < MA60 16.666667'));
  const trendText = await row(trendSymbol).innerText();
  assert.match(trendText, /MA20 10 < MA60 16\.666667/);
  assert.doesNotMatch(trendText, /ROE|动态 PE|经营现金流/);
  unchanged(trend, initialCash);
  checks.push('Real completed bars produce three specific long-trend failures; ready finance and valuation are not repeated as failure reasons in the saved decision or member row');

  assert.match(memberOf(trend).reconciliation.reason, new RegExp(sourceError));
  await row(dailySymbol).locator('[data-agency-reconcile]').click();
  assert.match(await page.locator('#agency-reconcile-reason').innerText(), new RegExp(sourceError));
  await snapshot('source-unavailable', true);

  scenario({ corporateMode: 'ready', now: '2026-09-29T10:02:00+08:00' });
  await verifyInDialog();
  const short = await waitState(state => memberOf(state)?.automaticCheck?.status === 'waiting' && /不足 61 根/.test(memberOf(state).automaticCheck.reason));
  assert.equal(short.agency.corporateChecks[dailySymbol].status, 'clear');
  assert.match(await page.locator('#agency-reconcile-reason').innerText(), /完整未复权日线不足 61 根/);
  assert.doesNotMatch(await page.locator('#agency-reconcile-reason').innerText(), new RegExp(sourceError));
  assert.match(await page.locator('#agency-reconcile-dialog').innerText(), /公司行为资料[：: ]*已核验/);
  assert.match(await page.locator('#agency-reconcile-auto-result').innerText(), /等待 1 只.*异常 0 只/);
  unchanged(short, initialCash);
  await snapshot('daily-insufficient', true);
  await page.locator('#agency-reconcile-cancel').click();
  await run();
  const blocked = await waitState(state => /不足 61 根/.test(decisionOf(state, dailySymbol)?.reason));
  await renderedDecision(blocked, dailySymbol);
  assert.equal(decisionOf(blocked, dailySymbol).status, 'blocked');
  assert.match(await row(dailySymbol).innerText(), /完整未复权日线不足 61 根/);
  assert.doesNotMatch(await row(dailySymbol).innerText(), new RegExp(sourceError));
  unchanged(blocked, initialCash);
  await snapshot('member-diagnostics');
  checks.push('Actual source recovery with only 23 completed bars shows the current 61-bar failure in row and live verification dialog, reports company data verified, and still blocks opening with no cash or holdings changes');

  await row(dailySymbol).locator('[data-agency-reconcile]').click();
  scenario({ historyMode: 'ready', now: '2026-09-29T10:04:00+08:00' });
  await verifyInDialog();
  const recovered = await waitState(state => memberOf(state)?.automaticCheck?.status === 'clear');
  assert.equal(memberOf(recovered).reconciliation.status, 'clear');
  assert.equal(memberOf(recovered).awaitingVerification, false);
  assert.doesNotMatch(await page.locator('#agency-reconcile-reason').innerText(), /不足 61 根|隔离公司行为来源暂不可用/);
  await snapshot('daily-restored', true);
  await page.locator('#agency-reconcile-cancel').click();
  await run();
  const final = await waitState(state => /回踩区域/.test(decisionOf(state, dailySymbol)?.reason));
  await renderedDecision(final, dailySymbol);
  assert.equal(decisionOf(final, dailySymbol).status, 'waiting');
  assert.doesNotMatch(await row(dailySymbol).innerText(), /不足 61 根|隔离公司行为来源暂不可用/);
  unchanged(final, initialCash);
  assert.ok(final.agency.decisions.some(item => item.symbol === dailySymbol && item.reason?.includes(sourceError)), 'Historical source-failure audit remains available');
  checks.push('Restored full history clears current diagnostics and old reconciliation while preserving audit history; the real price rule still rejects opening outside its entry range');

  // A separate display-only boundary: company evidence can update before the
  // next automatic check. Never let an older clear result hide a new block.
  // Freeze publishes for this last rendered copy; production state stays intact.
  await desktop.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents, send = contents.send.bind(contents);
    contents.send = (channel, ...args) => { if (channel !== 'state') send(channel, ...args); };
  });
  const updatedError = '新的公司行为来源异常，待补齐实施依据';
  await page.evaluate(({ symbol, reason }) => {
    const fixture = structuredClone(state), member = fixture.agency.groups.find(group => group.id === 'long').members.find(member => member.symbol === symbol);
    member.automaticCheck = { status: 'clear', reason: '', checkedAt: '2026-09-29T02:04:00.000Z' };
    member.corporateVerification = { ...member.corporateVerification, status: 'blocked', reason, checkedAt: '2026-09-29T02:06:00.000Z' };
    fixture.agency.corporateChecks[symbol] = { ...member.corporateVerification };
    renderState(fixture);
  }, { symbol: dailySymbol, reason: updatedError });
  assert.match(await row(dailySymbol).innerText(), new RegExp(updatedError));
  assert.doesNotMatch(await row(dailySymbol).innerText(), /价格与公司行为：通过/);
  await row(dailySymbol).locator('[data-agency-reconcile]').click();
  assert.match(await page.locator('#agency-reconcile-reason').innerText(), new RegExp(updatedError));
  assert.doesNotMatch(await page.locator('#agency-reconcile-status').innerText(), /价格与公司行为：通过|当前资料已核验/);
  await snapshot('new-corporate-block-overrides-old-clear', true);
  checks.push('Display-only copied-state boundary: newer blocked company evidence overrides an older clear automatic check in both member row and verification dialog');
  await page.locator('#agency-reconcile-cancel').click();
  await page.evaluate(symbol => {
    const fixture = structuredClone(state), member = fixture.agency.groups.find(group => group.id === 'long').members.find(member => member.symbol === symbol);
    member.corporateVerification = { ...member.corporateVerification, status: 'clear', reason: '' };
    fixture.agency.corporateChecks[symbol] = { ...member.corporateVerification };
    member.awaitingVerification = true;
    renderState(fixture);
  }, dailySymbol);
  assert.match(await row(dailySymbol).innerText(), /等待[^\n]*核验/);
  assert.doesNotMatch(await row(dailySymbol).innerText(), /价格与公司行为：通过/);
  await row(dailySymbol).locator('[data-agency-reconcile]').click();
  assert.match(await page.locator('#agency-reconcile-status').innerText(), /等待[^\n]*核验/);
  assert.doesNotMatch(await page.locator('#agency-reconcile-status').innerText(), /价格与公司行为：通过|当前资料已核验/);
  await snapshot('awaiting-recheck-overrides-old-clear', true);
  checks.push('Display-only copied-state boundary: awaitingVerification remains waiting in row and dialog despite older clear automatic/company results');
  checks.push('1120px and 1536px member-table and verification-dialog layouts have no viewport or dialog horizontal overflow');
  assert.deepEqual(errors, []);
  assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8').trim() : '', '', 'Unexpected external network request');
  await desktop.close(); desktop = null;
  const saved = JSON.parse(fs.readFileSync(path.join(accountPath, 'account.json'), 'utf8'));
  assert.equal(saved.trades.length, 0);
  assert.equal(saved.agency.groups.find(group => group.id === 'long').members.find(member => member.symbol === dailySymbol).automaticCheck.status, 'clear');
  checks.push('Fresh isolated account persists the verified state; zero external requests, zero renderer errors and zero trades');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, output, accountPath, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, output, checks }, null, 2));
})().catch(async error => {
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors }, null, 2));
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  if (desktop) await desktop.close().catch(() => {});
  console.error(error); console.error('Output:', output); process.exitCode = 1;
});
