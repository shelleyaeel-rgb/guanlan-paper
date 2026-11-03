// Real Electron/IPC, synchronization and persistence with an isolated account.
// The inherited fixture blocks network and mocks screening outcomes. This checks
// technical-only configuration, transport, persistence and history presentation.
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const { Engine, initialState } = require('../core/engine.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-selection-options-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'unexpected-network.jsonl'), poolLog = path.join(output, 'pool-requests.jsonl');
const sourceLog = path.join(output, 'sources.jsonl');
const scenario = { now: '2026-09-29T08:46:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready',
  poolDelay: 120, poolOnlySwing: true, poolSymbols: Array.from({ length: 22 }, (_, index) => `sh${601800 + index}`) };
const writeScenario = () => fs.writeFileSync(controlPath, JSON.stringify(scenario));
writeScenario();
const engine = new Engine(initialState(), () => new Date(scenario.now));
engine.s.watchlist = [];
fs.mkdirSync(accountPath);
fs.writeFileSync(path.join(accountPath, 'account.json'), JSON.stringify(engine.s, null, 2));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog,
  GUANLAN_TEST_POOL_LOG: poolLog, GUANLAN_TEST_SOURCE_LOG: sourceLog };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [], checks = [], screenshots = [];
let desktop, page;
const entries = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const persisted = () => JSON.parse(fs.readFileSync(path.join(accountPath, 'account.json'), 'utf8'));
const memberFor = (snapshot, symbol) => snapshot.agency.groups.flatMap(group => group.members).find(member => member.symbol === symbol);
async function current() {
  return page.evaluate(async () => { const result = await window.guanlan.call('state'); if (!result.ok) throw Error(result.error); return result.data; });
}
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'),
    args: [path.join(root, 'tests/fixtures/auto-only-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups.length === 4
    && !state.agencyPool?.running && state.agencyPool?.automation?.status === 'completed', null, { timeout: 30000 });
  assert.equal(path.resolve((await current()).dataPath), path.resolve(accountPath));
}
async function disclose(id, open = true) {
  const locator = page.locator(`#${id}`);
  assert.equal(await locator.evaluate(node => node.tagName), 'DETAILS', `${id} is a native disclosure`);
  if (await locator.evaluate(node => node.open) !== open) await locator.locator(':scope > summary').click();
}
async function capture(width, name, selector = '#agency-pool-settings') {
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 10000 });
  await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 850), width);
  await page.setViewportSize({ width, height: 850 });
  await page.locator(selector).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} fits ${width}px`);
  const file = path.join(output, `${name}-${width}.png`);
  await page.locator(selector).screenshot({ path: file });
  screenshots.push(file);
}
async function save() {
  const previous = (await current()).agencyPool.lastResult.id, requestCount = entries(poolLog).length;
  await page.locator('#agency-pool-run').click();
  await page.waitForFunction(id => !state.agencyPool?.running && state.agencyPool?.lastResult?.id !== id
    && !document.getElementById('agency-pool-run').disabled, previous, { timeout: 30000 });
  assert.equal(await page.locator('#agency-pool-error').isVisible(), false, 'successful save has no error');
  assert.equal(entries(poolLog).length, requestCount + 1, 'exactly one real IPC update reaches the scanner');
  const saved = await current();
  assert.deepEqual(persisted().agency.pool.policy, saved.agencyPool.savedPolicy, 'successful update persists the exact public saved policy');
  return { saved, request: entries(poolLog).at(-1) };
}
async function verifyCapacity(snapshot) {
  const group = snapshot.agency.groups.find(group => group.id === 'swing');
  assert.equal(group.members.filter(member => member.mode === 'active').length, 20);
  assert.equal(group.members.filter(member => member.mode === 'standby').length, 2);
  assert.equal(group.positions.length, 0);
  assert.equal(snapshot.agencyPool.policy.candidateSelection.activeLimitPerGroup, 20);
  assert.equal(snapshot.agencyPool.lastResult.selection.activeLimitPerGroup, 20);
  const card = page.locator('[data-agency-overview="swing"]');
  assert.match(await card.locator('.agency-overview-count').innerText(), /20\s*\/\s*20/);
  assert.equal(await card.locator('.agency-overview-stocks [data-agency-open]').count(), 20);
  assert.match(await card.locator('[data-agency-phase="standby"]').innerText(), /候补 2/);
  assert.match(await page.locator('#agency-overview-note').innerText(), /最多 20 只.*持仓另计/);
  await card.locator('[data-agency-phase="standby"]').click();
  assert.equal(await page.locator('#agency-members [data-agency-open]').count(), 2);
  await page.locator('#agency-member-filter').selectOption('active');
  assert.equal(await page.locator('#agency-members [data-agency-open]').count(), 20);
}
(async () => {
  await launch();
  const initial = await current();
  await verifyCapacity(initial);
  assert.equal(initial.agencyPool.lastResult.counts.added, 20);
  assert.equal(initial.agencyPool.lastResult.counts.standby, 2);
  for (const width of [1120, 1536]) {
    await capture(width, 'twenty-candidate-overview', '.agency-overview-section');
    const list = page.locator('[data-agency-overview="swing"] .agency-overview-stocks');
    assert.equal(await list.evaluate(node => node.scrollHeight > node.clientHeight), true, 'twenty candidates have a scrollable overview list');
    await list.locator('[data-agency-open]').last().scrollIntoViewIfNeeded();
    assert.equal(await list.evaluate(node => node.scrollTop > 0), true, 'the final candidate remains reachable');
    await list.evaluate(node => { node.scrollTop = 0; });
  }
  checks.push('Twenty-two qualified isolated candidates synchronize as 20 active plus 2 standby. Overview shows 20/20, lists all 20 candidates in a scrollable card, and active/standby filters show the correct membership at 1120/1536 pixels.');
  assert.equal(await page.locator('#agency-pool-settings').evaluate(node => node.open), false);
  await disclose('agency-pool-settings');
  for (const id of ['agency-pool-mode', 'agency-pool-legacy', 'agency-research-controls', 'agency-performance-controls', 'agency-industry-controls']) {
    assert.equal(await page.locator('#' + id).count(), 0, id + ' is removed');
  }
  assert.match(await page.locator('#agency-pool-workflow').innerText(), /行情.*完整日线.*技术/);
  assert.doesNotMatch(await page.locator('#agency-pool-workflow').innerText(), /公告|财务|研究/);
  assert.match(await page.locator('#agency-research-disabled').innerText(), /已停用.*未作核验/);
  assert.equal(await page.locator('#page-agency [data-research-symbol]').count(), 0);
  for (const width of [1120, 1536]) await capture(width, 'technical-only');
  checks.push('The automatic page exposes only market and technical rules, removes every research selector and research-inspection action, and explicitly labels all three cancelled checks disabled and unverified.');

  await page.evaluate(() => {
    agencyUi.screeningMode = 'strict';
    agencyUi.performance = { enabled: true, rules: [] };
    agencyUi.researchDrafts = { company: { enabled: true, path: 'company', rules: [] } };
  });
  const technicalSave = await save();
  await verifyCapacity(technicalSave.saved);
  assert.equal(technicalSave.request.screeningMode, 'strategy');
  for (const key of ['research', 'performance', 'industry']) assert.equal(technicalSave.request[key], undefined, key);
  assert.equal(technicalSave.saved.agencyPool.savedPolicy.researchChecks.status, 'disabled');
  assert.equal(technicalSave.saved.agencyPool.savedPolicy.evidenceMode, 'none');
  assert.equal(technicalSave.saved.agencyPool.savedPolicy.commonQuery.research, undefined);
  await disclose('agency-pool-report');
  assert.match(await page.locator('#agency-pool-evidence-summary').innerText(), /研究筛查已停用.*未核验/);
  assert.doesNotMatch(await page.locator('#agency-pool-evidence-summary').innerText(), /核验通过/);
  assert.equal(await page.locator('#agency-pool-items [data-research-symbol]').count(), 0);
  checks.push('An update with stale renderer research drafts sends no research fields through the real IPC route; the isolated account persists the disabled technical policy and the resulting page does not claim research passed.');

  await page.evaluate(() => {
    // These two presentation-only states must remain stable while screenshots
    // run; restore normal rendering before refreshing from the real backend.
    window.technicalTestRenderState = renderState; renderState = () => {};
    const group = state.agency.groups.find(group => group.id === 'swing');
    const member = group.members.find(member => member.mode === 'active');
    agencyUi.strategyId = group.id;
    member.corporateVerification = { status: 'not-required', affectsEquity: false };
    member.automaticCheck = { status: 'clear', checkedAt: Date.now() };
    member.reconciliation = { status: 'clear', reason: '' }; member.awaitingVerification = false;
    member.lastVerifiedAt = new Date().toISOString();
    delete state.agency.corporateChecks?.[member.symbol];
    openAgencyReconcile(member.symbol);
  });
  assert.match(await page.locator('#agency-reconcile-status').innerText(), /价格基准已核验.*公司行为资料未核验/);
  assert.match(await page.locator('#agency-reconcile-evidence-list').innerText(), /首次开仓无需公司行为公告前置.*未收集公告/);
  for (const width of [1120, 1536]) await capture(width, 'first-entry-price-basis', '#agency-reconcile-dialog');
  assert.match(await page.locator('#agency-reconcile-status').innerText(), /价格基准已核验.*公司行为资料未核验/);
  await page.locator('#agency-reconcile-cancel').click();
  checks.push('A renderer-only not-required corporate status displays validated price basis separately from unverified corporate documents and does not ask first-entry users to fetch announcements.');

  await page.evaluate(() => {
    const old = structuredClone(state.agencyPool.lastResult);
    old.id += '-historical'; old.screeningMode = 'strict'; delete old.selection; delete old.researchChecks; delete old.evidenceMode;
    old.selection = { activeLimitPerGroup: 6, criteria: { version: 2, name: '历史六只名额' } };
    if (old.coverage) { delete old.coverage.researchChecks; old.coverage.researchRequired = true; }
    state.agencyPool.lastResult = old; agencyUi.poolRenderKey = null; renderAgencyPool();
  });
  assert.match(await page.locator('#agency-pool-evidence-summary').innerText(), /历史筛选结果.*仅留档/);
  assert.match(await page.locator('#agency-pool-evidence-summary').innerText(), /不代表当前开仓要求/);
  assert.match(await page.locator('#agency-overview-note').innerText(), /最多 20 只/);
  assert.match(await page.locator('#agency-pool-result-scope').innerText(), /活跃上限 6 只/, 'historical result keeps its own previous capacity');
  for (const width of [1120, 1536]) await capture(width, 'historical-result', '#agency-pool-evidence-summary');
  await page.evaluate(() => { renderState = window.technicalTestRenderState; delete window.technicalTestRenderState; });
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  checks.push('A renderer-only old research result is clearly marked historical and inactive; it is never relabelled as a completed technical scan.');

  const beforeRestart = persisted();
  await desktop.close(); desktop = null;
  await launch();
  const restarted = await current();
  await verifyCapacity(restarted);
  assert.equal(restarted.agencyPool.savedPolicy.researchChecks.status, 'disabled');
  assert.equal(await page.locator('#agency-pool-legacy').count(), 0);
  assert.deepEqual(persisted().agency.groups.map(group => ({ id: group.id, cash: group.cash, mode: group.mode })), beforeRestart.agency.groups.map(group => ({ id: group.id, cash: group.cash, mode: group.mode })));
  assert.equal(await page.locator('#agency-reconcile-dialog').count(), 1);
  const final = await current();
  assert.equal(final.account.orders.length, 0); assert.equal(final.account.trades.length, 0); assert.equal(final.account.lots.length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(entries(networkLog), []);
  assert.deepEqual(restarted.agency.groups.map(group => group.members.map(member => ({ symbol: member.symbol, mode: member.mode }))), technicalSave.saved.agency.groups.map(group => group.members.map(member => ({ symbol: member.symbol, mode: member.mode }))));
  checks.push('Restart retains the 20 active/2 standby membership, technical policy, cash and group modes. An old six-candidate result remains historical and cannot lower the current UI capacity. Corporate reconciliation remains available. No renderer errors, external network, orders, trades or holdings were created.');
  const report = { status: 'passed', output, checks, screenshots, errors,
    isolation: { accountPath, unexpectedNetwork: 0, scanner: 'deterministic mocked results; no numerical screening or execution claim' }, initial, technicalSave, restarted, final };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, checks, screenshots }, null, 2));
})().catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(output); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
