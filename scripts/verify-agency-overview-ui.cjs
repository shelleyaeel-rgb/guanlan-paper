// Real Electron/IPC with an isolated account and deterministic, network-blocking
// providers. The scanner is mocked: this verifies UI, policy transport and pool
// persistence, not numerical screening outcomes. Edge-case snapshots below are
// renderer-only; they never reach IPC.
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const { Engine, initialState } = require('../core/engine.cjs');
const { agencySelectionPolicy, composeAgencySelectionQuery } = require('../core/agency-selection.cjs');
const { describe } = require('../core/screener.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-overview-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'unexpected-network.jsonl'), poolLog = path.join(output, 'pool-requests.jsonl');
const sourceLog = path.join(output, 'sources.jsonl');
const symbols = Array.from({ length: 8 }, (_, index) => `sh${601800 + index}`);
const scenario = { now: '2026-09-29T08:46:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready',
  poolDelay: 100, poolOnlySwing: true, poolSymbols: symbols };
fs.writeFileSync(controlPath, JSON.stringify(scenario));
const engine = new Engine(initialState(), () => new Date(scenario.now));
engine.s.watchlist = [];
fs.mkdirSync(accountPath);
fs.writeFileSync(path.join(accountPath, 'account.json'), JSON.stringify(engine.s, null, 2));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog,
  GUANLAN_TEST_POOL_LOG: poolLog, GUANLAN_TEST_SOURCE_LOG: sourceLog };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [], checks = [], screenshots = [];
const panels = ['agency-pool-settings', 'agency-pool-report', 'agency-diagnostics', 'agency-strategy-settings', 'agency-logs'];
let desktop, page;
const entries = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function current() {
  return page.evaluate(async () => { const result = await window.guanlan.call('state'); if (!result.ok) throw Error(result.error); return result.data; });
}
async function shownSymbols(selector) {
  return page.locator(`${selector} [data-agency-open]`).evaluateAll(nodes => nodes.map(node => node.dataset.agencyOpen));
}
async function capture(width, name, selector, element = false) {
  await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 850), width);
  await page.setViewportSize({ width, height: 850 });
  if (selector) await page.locator(selector).scrollIntoViewIfNeeded();
  else await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} fits ${width}px`);
  const file = path.join(output, `${name}-${width}.png`);
  if (element) await page.locator(selector).screenshot({ path: file });
  else await page.screenshot({ path: file });
  screenshots.push(file);
}

(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'),
    args: [path.join(root, 'tests/fixtures/auto-only-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups.length === 4
    && !state.agencyPool?.running && state.agencyPool?.automation?.status === 'completed', null, { timeout: 30000 });
  const initial = await current();
  assert.equal(path.resolve(initial.dataPath), path.resolve(accountPath));
  assert.equal(await page.locator('#page-title').innerText(), '自动交易');
  assert.equal(await page.locator('#agency-overview article[data-agency-overview]').count(), 4);
  assert.equal(await page.locator('#agency-member-filter').inputValue(), 'active');
  for (const id of panels) {
    assert.equal(await page.locator(`#${id}`).evaluate(node => node.tagName), 'DETAILS', id);
    assert.equal(await page.locator(`#${id}`).evaluate(node => node.open), false, `${id} is collapsed initially`);
  }
  const selection = initial.agencyPool.policy.candidateSelection;
  assert.deepEqual(selection, agencySelectionPolicy(), 'IPC exposes the actual core admission policy');
  assert.equal(selection.version, 1);
  assert.deepEqual(initial.agencyPool.lastResult.selection.criteria, selection, 'the scanner policy snapshot reaches the real pool result');
  const persisted = JSON.parse(fs.readFileSync(path.join(accountPath, 'account.json'), 'utf8'));
  assert.deepEqual(persisted.agency.pool.lastResult.selection.criteria, selection, 'the actual isolated account persists the admission-rule snapshot');
  assert.match(await page.locator('#agency-overview-note').innerText(), /^稳健精选/);
  assert.match(await page.locator('#agency-overview-note').innerText(), /不足不补齐/);
  assert.doesNotMatch(await page.locator('#agency-overview-note').innerText(), /尚未按新版/);
  assert.equal(await page.locator('#agency-selection-rules details').count(), 4);
  for (const strategy of selection.strategies) {
    const query = composeAgencySelectionQuery(strategy.id);
    assert.deepEqual(strategy.rules, query.rules, `${strategy.id}: displayed policy uses the actual composed admission thresholds`);
    assert.deepEqual(strategy.labels, describe(query).slice(1), `${strategy.id}: policy labels describe every actual admission condition`);
    const disclosure = page.locator(`#agency-selection-rules details[data-render-key="selection:${strategy.id}"]`);
    assert.equal(await disclosure.evaluate(node => node.open), false, `${strategy.id}: threshold details start collapsed`);
    assert.deepEqual(await disclosure.locator('li').allTextContents(), strategy.labels, `${strategy.id}: no threshold is omitted or changed by the renderer`);
    assert.match(await disclosure.locator('summary').textContent(), new RegExp(`${strategy.labels.length} 项条件`));
  }
  const selectionText = await page.locator('#agency-selection-rules').textContent();
  assert.ok(selectionText.includes(selection.limitations));
  assert.ok(selectionText.includes(selection.basis));
  checks.push('The IPC admission policy, persisted version-one result snapshot and all four strategy disclosures match the real composed core queries and every formatted threshold. Current results are labelled 稳健精选, with the unvalidated-threshold and insufficient-candidate explanations intact.');
  const swing = initial.agency.groups.find(group => group.id === 'swing');
  const active = swing.members.filter(member => member.mode === 'active').map(member => member.symbol);
  const standby = swing.members.filter(member => member.mode === 'standby').map(member => member.symbol);
  assert.equal(active.length, 6); assert.equal(standby.length, 2);
  assert.deepEqual(await shownSymbols('[data-agency-overview="swing"]'), active);
  assert.deepEqual(await shownSymbols('#agency-members'), active);
  for (const id of ['ultra-short', 'short', 'long']) assert.deepEqual(await shownSymbols(`[data-agency-overview="${id}"]`), []);
  for (const symbol of active) {
    const button = page.locator(`[data-agency-overview="swing"] [data-agency-open="${symbol}"]`);
    assert.equal(await button.isVisible(), true);
    assert.match(await button.innerText(), new RegExp(symbol.slice(2)));
    assert.ok((await button.innerText()).includes(initial.quotes[symbol]?.name || swing.members.find(member => member.symbol === symbol).poolCheck?.name));
  }
  checks.push('Real automatic pool synchronization of deterministic scanner results yields six active and two standby stocks. The initial four-strategy overview exposes all six names/codes without expanding settings; the default member list shows only active candidates. Numerical admission outcomes are covered separately by core tests.');

  for (const width of [1120, 1536]) await capture(width, 'automatic-home');
  for (const id of ['agency-pool-settings', 'agency-diagnostics']) {
    await page.locator(`[data-agency-disclosure="${id}"]`).click();
    assert.equal(await page.locator(`#${id}`).evaluate(node => node.open), true, `${id} shortcut expands its panel`);
    assert.equal(await page.locator(`#${id} > summary`).evaluate(node => {
      const box = node.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight && document.activeElement === node;
    }), true, `${id} shortcut scrolls and focuses its summary`);
    await page.locator(`#${id} > summary`).click();
  }
  checks.push('The top-level settings and runtime shortcuts expand the correct disclosure, scroll its summary into view and focus it.');
  await page.locator('[data-agency-disclosure="agency-pool-settings"]').click();
  for (const width of [1120, 1536]) await capture(width, 'selection-rules-collapsed', '#agency-selection-rules', true);
  for (const strategy of selection.strategies) {
    const disclosure = page.locator(`#agency-selection-rules details[data-render-key="selection:${strategy.id}"]`);
    await disclosure.locator('summary').click();
    assert.equal(await disclosure.locator('li').first().isVisible(), true);
    assert.equal(await disclosure.locator('li').last().isVisible(), true);
  }
  for (const width of [1120, 1536]) {
    await capture(width, 'selection-rules-expanded', '#agency-selection-rules', true);
    assert.equal(await page.locator('#agency-selection-rules').evaluate(node => node.scrollWidth <= node.clientWidth), true, `complete admission rules fit ${width}px without horizontal scrolling`);
  }
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  assert.equal(await page.locator('#agency-selection-rules details[open]').count(), 4, 'refresh preserves each expanded threshold disclosure');
  for (const strategy of selection.strategies) await page.locator(`#agency-selection-rules details[data-render-key="selection:${strategy.id}"] > summary`).click();
  await page.locator('#agency-pool-settings > summary').click();
  const selectionCompatibility = await page.evaluate(() => {
    const saved = state, previousKey = agencyUi.poolRenderKey;
    const read = () => ({ note: document.getElementById('agency-overview-note').textContent,
      scope: document.getElementById('agency-pool-result-scope').textContent,
      labels: [...document.querySelectorAll('#agency-selection-rules li')].map(node => node.textContent) });
    try {
      const old = structuredClone(saved); delete old.agencyPool.lastResult.selection.criteria;
      agencyUi.poolRenderKey = null; renderState(old); const historical = read();
      const outdated = structuredClone(saved); outdated.agencyPool.lastResult.selection.criteria.version = 0;
      agencyUi.poolRenderKey = null; renderState(outdated); const oldVersion = read();
      const empty = structuredClone(saved); empty.agencyPool.lastResult = null;
      agencyUi.poolRenderKey = null; renderState(empty); const noResult = read();
      return { historical, oldVersion, noResult };
    } finally { agencyUi.poolRenderKey = null; renderState(saved); agencyUi.poolRenderKey = previousKey; }
  });
  for (const view of [selectionCompatibility.historical, selectionCompatibility.oldVersion]) {
    assert.match(view.note, /尚未按新版稳健条件重筛/);
    assert.doesNotMatch(view.note, /^稳健精选/);
    assert.deepEqual(view.labels, selection.strategies.flatMap(strategy => strategy.labels), 'the next-run policy remains visible without relabelling a historical result');
  }
  assert.match(selectionCompatibility.historical.scope, /历史入池标准.*未按稳健精选重筛/);
  assert.doesNotMatch(selectionCompatibility.historical.scope, /稳健精选 v1/);
  assert.match(selectionCompatibility.noResult.note, /等待候选池更新/);
  checks.push('Complete rule panels were captured collapsed and fully expanded at 1120px and 1536px, with no horizontal overflow and expansion preserved on refresh. Renderer-only historical/mismatched-version/no-result snapshots explicitly distinguish the next-run policy from screening already performed.');
  await page.locator('[data-agency-select="ultra-short"]:not([data-agency-phase])').click();
  assert.equal(await page.evaluate(() => agencyUi.strategyId), 'ultra-short');
  assert.equal(await page.locator('#agency-members [data-agency-open]').count(), 0);
  await page.locator('[data-agency-select="swing"]:not([data-agency-phase])').click();
  assert.equal(await page.evaluate(() => agencyUi.strategyId), 'swing');
  await page.locator('[data-agency-tab="long"]').click();
  assert.equal(await page.evaluate(() => agencyUi.strategyId), 'long');
  await page.locator('[data-agency-tab="swing"]').click();
  await page.locator(`[data-agency-overview="swing"] [data-agency-open="${active[0]}"]`).click();
  await page.waitForFunction(() => typeof detail !== 'undefined' && detail?.bars?.length);
  assert.equal(await page.locator('#page-title').innerText(), '个股详情');
  await page.locator('#detail-back').click();
  assert.equal(await page.locator('#page-title').innerText(), '自动交易');
  assert.equal(await page.evaluate(() => selected), '');
  assert.deepEqual(await shownSymbols('[data-agency-overview="swing"]'), active);
  assert.ok(entries(sourceLog).some(row => row.kind === 'ipc' && row.name === 'detail:close'));
  checks.push('Both overview buttons and the retained tabs switch the detailed strategy. An overview stock opens real read-only detail and returns to the automatic page with its preview subscription closed.');

  await page.locator('[data-agency-select="swing"][data-agency-phase="standby"]').click();
  assert.equal(await page.locator('#agency-member-filter').inputValue(), 'standby');
  assert.deepEqual(await shownSymbols('#agency-members'), standby);
  await page.locator('#agency-member-search').fill(standby[0].slice(2));
  assert.deepEqual(await shownSymbols('#agency-members'), [standby[0]]);
  await page.locator('#agency-member-search').fill('不存在的隔离股票');
  assert.deepEqual(await shownSymbols('#agency-members'), []);
  await page.locator('#agency-member-search').fill('');
  await page.locator('#agency-member-filter').selectOption('all');
  assert.equal((await shownSymbols('#agency-members')).length, 8);
  await page.locator('#agency-member-filter').selectOption('active');
  assert.deepEqual(await shownSymbols('#agency-members'), active);
  checks.push('Active, standby and all-member filters and code/nonmatching searches stay usable while the overview remains a direct view of the active candidate list.');

  const firstRow = page.locator('#agency-members tbody tr').first();
  assert.ok(await firstRow.locator('details').count(), 'member diagnostics are in expandable details');
  assert.equal(await firstRow.locator('details').first().evaluate(node => node.open), false);
  const currentStatus = firstRow.locator('[data-monitoring-status]').first();
  assert.equal(await currentStatus.isVisible(), true, 'current monitoring status is visible without expanding details');
  await firstRow.locator('details').first().locator(':scope > summary').click();
  for (const id of panels) await page.locator(`#${id} > summary`).click();
  // Change the renderer snapshot enough to require row reconciliation. No IPC
  // mutation is involved, and the next real refresh restores production state.
  const preserved = await page.evaluate(({ ids, symbol }) => {
    const next = structuredClone(state);
    if (next.quotes[symbol]) next.quotes[symbol].price += 0.01;
    const member = next.agency.groups.find(group => group.id === 'swing').members.find(member => member.symbol === symbol);
    member.automaticCheck = { ...member.automaticCheck, status: 'waiting', reason: '隔离刷新说明', checkedAt: new Date(next.now).toISOString() };
    renderState(next);
    return { panels: ids.map(id => document.getElementById(id).open), row: document.querySelector('#agency-members tbody tr details').open };
  }, { ids: panels, symbol: active[0] });
  assert.deepEqual(preserved.panels, panels.map(() => true)); assert.equal(preserved.row, true);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  for (const id of panels) assert.equal(await page.locator(`#${id}`).evaluate(node => node.open), true, `${id} remains expanded on refresh`);
  assert.equal(await page.locator('#agency-members tbody tr details').first().evaluate(node => node.open), true);
  checks.push('Current monitoring status remains visible while complex row diagnostics start collapsed. Expanded row diagnostics and all five page panels survive changed content and an actual refresh.');
  for (const id of panels) await page.locator(`#${id} > summary`).click();
  await page.locator('#agency-members tbody tr details').first().locator(':scope > summary').click();
  for (const width of [1120, 1536]) await capture(width, 'active-members', '#agency-members');

  // Exercise view-only states without creating holdings, orders or a fake
  // scanner result in the account. All assertions are in one synchronous turn,
  // so a real background state publication cannot replace the test snapshot.
  const edgeCases = await page.evaluate(() => {
    const saved = state, savedStrategy = agencyUi.strategyId;
    const savedFilter = document.getElementById('agency-member-filter').value;
    const savedSearch = document.getElementById('agency-member-search').value;
    const sample = structuredClone(state), errors = [], results = {};
    const require = (condition, message) => { if (!condition) errors.push(message); };
    const target = sample.agency.groups.find(group => group.id === 'swing');
    const base = target.members.find(member => member.mode === 'active');
    const candidate = (symbol, name, mode = 'active') => ({ ...structuredClone(base), symbol, mode,
      poolCheck: { ...base.poolCheck, name }, ...(mode === 'standby' ? { standbyReason: '隔离容量候补' } : {}) });
    const ids = ['ultra-short', 'short', 'swing', 'long'], counts = [6, 3, 6, 0];
    for (let groupIndex = 0; groupIndex < ids.length; groupIndex++) {
      const group = sample.agency.groups.find(group => group.id === ids[groupIndex]);
      group.positions = [];
      group.members = Array.from({ length: counts[groupIndex] }, (_, index) => candidate(`sh${602100 + groupIndex * 100 + index}`, `无行情候选 ${groupIndex}-${index}`));
      for (const member of group.members) delete sample.quotes[member.symbol];
    }
    const held = 'sh609001', closing = 'sh609002', removing = 'sh609003', standby = 'sh609004';
    target.members.push(candidate(held, '隔离持仓'), candidate(closing, '隔离尽快退出', 'closing'),
      candidate(removing, '隔离退出后移除', 'removing'), candidate(standby, '隔离候补', 'standby'));
    target.positions = [held, closing, removing].map(symbol => ({ symbol, name: `隔离持仓 ${symbol.slice(2)}`, quantity: 100, available: 100, price: 10.17, pnl: 0 }));
    const stocks = selector => [...document.querySelectorAll(`${selector} [data-agency-open]`)].map(node => node.dataset.agencyOpen);
    const choose = value => { const select = document.getElementById('agency-member-filter'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); };
    const search = value => { const input = document.getElementById('agency-member-search'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
    try {
      agencyUi.strategyId = 'swing'; document.getElementById('agency-member-search').value = '';
      document.getElementById('agency-member-filter').value = 'active'; renderState(sample);
      results.overview = Object.fromEntries(ids.map(id => [id, stocks(`[data-agency-overview="${id}"]`)]));
      ids.forEach((id, index) => require(results.overview[id].length === counts[index], `${id}: expected exactly ${counts[index]} real candidates`));
      require(!Object.values(results.overview).flat().some(symbol => [held, closing, removing, standby].includes(symbol)), 'overview mixed in held, exiting or standby stocks');
      require(document.querySelector('[data-agency-overview="short"]').textContent.includes('3'), 'partial pool does not display its actual count');
      require(/暂无|没有|空|待补充|0/.test(document.querySelector('[data-agency-overview="long"]').textContent), 'empty pool lacks a truthful empty state');
      require(document.querySelector('[data-agency-overview="swing"]').textContent.includes('无行情候选 2-0'), 'overview omitted poolCheck.name when no quote exists');
      require(document.querySelector('#agency-members').textContent.includes('无行情候选 2-0'), 'member row omitted poolCheck.name when no quote exists');
      require(stocks('#agency-members').length === 6, 'active filter mixed in held members');
      choose('held'); results.held = stocks('#agency-members');
      require(results.held.includes(held) && results.held.every(symbol => [held, closing, removing].includes(symbol)), 'held filter includes an unheld member or excludes the active holding');
      choose('exiting'); results.exiting = stocks('#agency-members');
      require(results.exiting.length === 2 && results.exiting.includes(closing) && results.exiting.includes(removing), 'exiting filter does not cover both exit modes');
      choose('standby'); require(JSON.stringify(stocks('#agency-members')) === JSON.stringify([standby]), 'standby filter incorrect');
      choose('all'); require(stocks('#agency-members').length === 10, 'all-member filter loses a member');
      choose('active'); search('无行情候选 2-0');
      require(JSON.stringify(stocks('#agency-members')) === JSON.stringify(['sh602300']), 'name search does not use poolCheck.name without quotes');
      search('');
      results.currentStatusVisible = [...document.querySelectorAll('#agency-members [data-monitoring-status]')].every(node => !node.closest('details:not([open])'));
      require(results.currentStatusVisible, 'current status is hidden inside a collapsed details');
      return { ...results, errors };
    } finally {
      agencyUi.strategyId = savedStrategy;
      document.getElementById('agency-member-filter').value = savedFilter;
      document.getElementById('agency-member-search').value = savedSearch;
      renderState(saved);
    }
  });
  assert.deepEqual(edgeCases.errors, []);
  checks.push('Renderer-only edge snapshots cover six/three/zero real candidates, holding/standby/exit separation, both exit modes, missing-quote name fallback and name search. These cases do not create holdings or change the isolated account.');
  const final = await current();
  assert.deepEqual(final.agency.groups.find(group => group.id === 'swing').members.map(member => [member.symbol, member.mode]), swing.members.map(member => [member.symbol, member.mode]));
  assert.equal(final.account.trades.length, 0); assert.equal(final.account.orders.length, 0); assert.equal(final.account.lots.length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(entries(networkLog), []);
  checks.push('Both 1120px and 1536px layouts fit without document overflow. No renderer errors, unintended network requests, orders, trades or holdings occurred.');
  const report = { status: 'passed', output, checks, screenshots, errors, edgeCases, selectionCompatibility,
    isolation: { accountPath, unexpectedNetwork: 0, scanner: 'mocked deterministic results; numerical admission behavior requires core tests' }, initial, final };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, checks, screenshots }, null, 2));
})().catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(output); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
