// Isolated Electron IPC plus render-only stage fixtures; never opens a live account.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function revealPoolControl(selector) {
  await page.locator(selector).evaluate(element => { for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
}
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-monitoring-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'unexpected-network.jsonl'), poolLog = path.join(output, 'pool-requests.jsonl');
fs.writeFileSync(controlPath, JSON.stringify({ now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', poolDelay: 150 }));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog, GUANLAN_TEST_POOL_LOG: poolLog }; delete env.ELECTRON_RUN_AS_NODE;
const errors = [], checks = []; let desktop, page;
const entries = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const members = current => current.agency.groups.flatMap(group => group.members);
async function call(name, payload) {
  return page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload });
}
async function refresh() { await page.evaluate(async () => renderState(await api('state'))); }
async function run() { await page.locator('#agency-pool-run').click(); await page.waitForFunction(() => !state.agencyPool.running && !agencyUi.busy.has('pool-run')); return call('state'); }
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/agency-pool-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  assert.equal(path.resolve((await call('state')).dataPath), path.resolve(accountPath));
  await page.locator('[data-page="agency"]').click();
  assert.equal(await page.locator('#agency-pool-mode').inputValue(), 'strategy');
  await call('agency:member', { strategyId: 'swing', symbol: 'sh600003', action: 'add' });
  await refresh();
  assert.match(await page.locator('#agency-monitoring-summary').innerText(), /已纳入监控 1 只/);
  let current = await run();
  assert.equal(current.agencyPool.lastResult.screeningMode, 'strategy');
  assert.equal(current.agencyPool.lastResult.coverage.researchRequired, false);
  assert.equal(members(current).every(member => member.selectionMode === 'strategy' && !member.entryConditions), true);
  assert.doesNotMatch(await page.locator('#agency-pool-diagnostics').innerText(), /尚未进入研究|研究证据不足/);
  assert.match(await page.locator('#agency-pool-evidence-summary').innerText(), /无需产品前景/);
  const inheritance = await page.evaluate(() => {
    const preset = { field: 'roe', op: 'gte', value: 5 }, personal = { field: 'debtRatio', op: 'lte', value: 50 };
    const result = { strategyId: 'long', personalRules: [personal], query: { rules: [preset, personal], excludeST: true, evidence: { conditions: ['demand'] } }, fetchedAt: Date.now() };
    return { selected: screenEntryConditions(result), custom: screenEntryConditions({ ...result, strategyId: '' }) };
  });
  assert.deepEqual(inheritance.selected.rules, [{ field: 'debtRatio', op: 'lte', value: 50 }]);
  assert.equal(inheritance.custom.rules.length, 2);
  assert.equal(inheritance.selected.excludeST, true); assert.deepEqual(inheritance.selected.evidence.conditions, ['demand']);
  checks.push('strategy presets are not duplicated as continuing conditions; personal additions, ST exclusion and research selections are preserved');
  checks.push('default scan creates strategy monitors without common research conditions or misleading missing-research counts');

  await call('agency:member', { strategyId: 'ultra-short', symbol: 'sh600006', action: 'remove' });
  await refresh(); await revealPoolControl('#agency-pool-legacy'); await page.locator('#agency-pool-legacy').check();
  current = await run();
  assert.equal(members(current).find(member => member.symbol === 'sh600006').selectionMode, 'strict');
  const retained = members(current).find(member => member.symbol === 'sh600003');
  assert.equal(retained.selectionMode, 'strategy'); assert.equal(retained.entryConditions, undefined);
  assert.equal(retained.poolCheck.status, 'pending');
  assert.match(await page.locator('#agency-members').innerText(), /历史筛选记录：待核验/);
  assert.doesNotMatch(await page.locator('#agency-members').innerText(), /暂停新开仓，重新更新并通过后才恢复候选资格/);
  assert.match(await page.locator('#agency-pool-evidence-summary').innerText(), /资料收集完整（仍需内容核验）/);
  await revealPoolControl('#agency-pool-legacy'); await page.locator('#agency-pool-legacy').uncheck();
  await page.locator('#agency-pool-mode').selectOption('strategy');
  await page.locator('#agency-pool-retry').click();
  await page.waitForFunction(() => !state.agencyPool.running && !agencyUi.busy.has('pool-retry'));
  assert.equal(entries(poolLog).at(-1).screeningMode, 'strict');
  checks.push('strict screening affects newly discovered members only; retry keeps the previous mode even when the selector changes');

  await page.locator('#agency-add').click();
  assert.match(await page.locator('#agency-assign-policy').innerText(), /纳入策略监控/);
  assert.doesNotMatch(await page.locator('#agency-assign-conditions').innerText(), /共同选股标准将自动附加/);
  await page.locator('#agency-assign-symbol').fill('sh600008');
  await page.locator('#agency-assign-submit').click();
  await page.waitForFunction(() => !document.querySelector('#agency-assign-dialog').open);
  const added = members(await call('state')).find(member => member.symbol === 'sh600008');
  assert.equal(added.selectionMode, 'strategy'); assert.equal(added.entryConditions, undefined);
  checks.push('manual addition after strict screening remains ordinary strategy monitoring');

  // Stage rendering uses a local view only, leaving the isolated engine/account unchanged.
  await page.evaluate(() => {
    const current = structuredClone(state), view = structuredClone(state), group = view.agency.groups.find(group => group.id === 'swing');
    const statuses = ['eligible', 'holding', 'paused', 'data', 'risk', 'funds', 'conditions', 'unchecked'];
    group.members = statuses.map((status, index) => ({ symbol: `sh${601800 + index}`, mode: 'active', selectionMode: 'strategy', reconciliation: { status: 'clear' }, ...(status === 'unchecked' ? {} : { monitoringCheck: { status, reason: `隔离阶段原因 ${status}`, checkedAt: Date.now() } }) }));
    window.__monitoringActual = current;
    window.__monitoringRender = renderAgency;
    renderAgency = () => { const latest = state; state = view; try { window.__monitoringRender(); } finally { state = latest; } };
    renderAgency();
  });
  for (const status of ['eligible', 'holding', 'paused', 'data', 'risk', 'funds', 'conditions', 'unchecked']) {
    assert.equal(await page.locator(`[data-monitoring-count="${status}"] strong`).innerText(), '1');
    assert.equal(await page.locator(`[data-monitoring-status="${status}"]`).count(), 1);
  }
  for (const width of [1120, 1536]) {
    await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 980), width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#agency-monitoring-summary').screenshot({ path: path.join(output, `monitoring-summary-${width}.png`) });
    await page.locator('#agency-pool-card').screenshot({ path: path.join(output, `pool-modes-${width}.png`) });
  }
  await page.evaluate(() => { renderAgency = window.__monitoringRender; renderState(window.__monitoringActual); delete window.__monitoringActual; delete window.__monitoringRender; });
  checks.push('eight current monitoring stages have distinct counts and member reasons; both desktop widths fit without viewport overflow');
  assert.deepEqual((await call('state')).account.trades, []);
  assert.deepEqual(errors, []); assert.deepEqual(entries(networkLog), []);
  const report = { status: 'passed', output, checks, errors }; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => { if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error(error); console.error(output); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
