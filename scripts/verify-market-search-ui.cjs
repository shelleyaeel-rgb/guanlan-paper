// Real Electron/preload/IPC with isolated providers, account and outbound traffic.
'use strict';
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/market-search-ui-'));
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
const requests = () => entries(sourceLog).filter(row => row.kind === 'search-start');
const details = () => entries(sourceLog).filter(row => row.kind === 'detail-request');
async function current() { return page.evaluate(async () => { const result = await window.guanlan.call('state'); if (!result.ok) throw Error(result.error); return result.data; }); }
async function waitForLog(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate(entries(sourceLog))) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error('Expected isolated provider/IPC log entry did not arrive');
}
async function candidateSymbols() { return page.locator('#market-search-results [data-market-result]').evaluateAll(nodes => nodes.map(node => node.dataset.marketResult)); }
async function search(query, symbols) {
  await page.locator('#market-symbol').fill(query);
  await page.waitForFunction(expected => {
    const list = document.getElementById('market-search-results');
    return !!list && !list.classList.contains('hidden') && JSON.stringify([...list.querySelectorAll('[data-market-result]')].map(node => node.dataset.marketResult)) === JSON.stringify(expected);
  }, symbols);
}
async function selectedStock(symbol) { await page.waitForFunction(symbol => selected === symbol && !detailBusy && detail?.symbol === symbol, symbol); }
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
  assert.equal(await page.locator('#page-title').innerText(), '自动交易');
  await page.locator('[data-page="market"]').click();
  await page.locator('#market-tab-stocks').click();
  assert.equal(await page.locator('#market-empty').isVisible(), true);
  assert.equal(await page.locator('#market-search-results').isVisible(), false);
  assert.equal(requests().length, 0); assert.equal(details().length, 0);
  await capture('empty');
  checks.push('Opening the market panel shows an empty query and makes no search or stock detail request.');

  // A real input sequence must collapse to one search, even before Enter/click.
  const debounceStart = requests().length;
  await page.locator('#market-symbol').pressSequentially('GZMT', { delay: 35 });
  await page.waitForFunction(() => !!document.querySelector('[data-market-result="sh600519"]'));
  assert.deepEqual(requests().slice(debounceStart).map(row => row.query), ['GZMT']);
  assert.equal(await page.evaluate(() => selected), ''); assert.equal(details().length, 0);
  assert.match(await page.locator('#market-search-results').innerText(), /贵州茅台/);
  assert.match(await page.locator('#market-search-results').innerText(), /600519/);
  assert.equal(await page.locator('#market-symbol').getAttribute('aria-expanded'), 'true');
  checks.push('Typing initials is debounced to one search; candidates show the name/code without automatically selecting a stock.');

  await search('600', ['sh600519', 'sh600036', 'sh600000']);
  await search('茅台', ['sh600519']);
  const submitDetails = details().length;
  await page.locator('#market-search-submit').click();
  await page.waitForTimeout(350);
  assert.equal(details().length, submitDetails); assert.equal(await page.evaluate(() => selected), '');
  await page.locator('[data-market-result="sh600519"]').click(); await selectedStock('sh600519');
  assert.equal(await page.locator('#market-search-results').isVisible(), false);
  assert.equal(await page.locator('#stock-symbol').innerText(), 'SH600519');
  assert.equal(await page.locator('#chart [data-bar]').count(), 90);
  checks.push('Partial codes and Chinese names show matching options; submitting a fuzzy term keeps candidates, and clicking one explicitly loads its daily chart.');

  const bankSymbols = ['sz000001', 'sh600036', 'sh600000'];
  await search('银行', bankSymbols);
  const chartBeforeKeys = await page.locator('#chart').innerHTML(), beforeKeys = details().length;
  await page.locator('#market-symbol').press('ArrowDown');
  await page.locator('#market-symbol').press('ArrowDown');
  await page.locator('#market-symbol').press('ArrowUp');
  assert.equal(details().length, beforeKeys); assert.equal(await page.locator('#chart').innerHTML(), chartBeforeKeys);
  const activeId = await page.locator('#market-symbol').getAttribute('aria-activedescendant');
  assert.ok(activeId); assert.equal(await page.locator(`[id="${activeId}"]`).getAttribute('data-market-result'), 'sz000001');
  await page.locator('#market-symbol').press('Enter'); await selectedStock('sz000001');
  assert.equal(await page.locator('#market-search-results').isVisible(), false);
  await search('银行', bankSymbols); await page.locator('#market-symbol').press('Escape');
  assert.equal(await page.locator('#market-search-results').isVisible(), false);
  assert.equal(await page.evaluate(() => selected), 'sz000001');
  await search('银行', bankSymbols); await page.locator('#refresh').focus();
  assert.equal(await page.locator('#market-search-results').isVisible(), false);
  await search('银行', bankSymbols); await page.locator('#page-title').click();
  assert.equal(await page.locator('#market-search-results').isVisible(), false);
  assert.equal(await page.evaluate(() => selected), 'sz000001');
  checks.push('Arrow keys move the accessible active option without loading it; Enter selects that stock. Escape, moving focus outside the search card and clicking outside close candidates without changing the chart.');

  // Browsers dispatch composition input events before the committed Chinese text.
  await page.locator('#market-symbol').fill('');
  const compositionStart = requests().length;
  await page.locator('#market-symbol').evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    input.value = '招'; input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '招', isComposing: true, inputType: 'insertCompositionText' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', isComposing: true }));
  });
  await page.waitForTimeout(400); assert.equal(requests().length, compositionStart);
  await page.locator('#market-symbol').evaluate(input => {
    input.value = '招商'; input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '招商' }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '招商', inputType: 'insertText' }));
  });
  await page.waitForFunction(() => !!document.querySelector('[data-market-result="sh600036"]'));
  assert.deepEqual(requests().slice(compositionStart).map(row => row.query), ['招商']);
  assert.deepEqual(await candidateSymbols(), ['sh600036']);
  checks.push('Chinese IME composition does not search unfinished text; committing the text makes one debounced search.');

  scenario.searchDelays = { '茅台': 900 }; saveScenario();
  const beforeRace = entries(sourceLog).length;
  await page.locator('#market-symbol').fill('茅台');
  await waitForLog(rows => rows.slice(beforeRace).some(row => row.kind === 'search-start' && row.query === '茅台'));
  await search('银行', bankSymbols);
  await waitForLog(rows => rows.slice(beforeRace).some(row => row.kind === 'search-complete' && row.query === '茅台'));
  await page.waitForTimeout(100); assert.deepEqual(await candidateSymbols(), bankSymbols);
  assert.equal(await page.locator('#market-symbol').inputValue(), '银行');
  const beforeBlur = entries(sourceLog).length;
  await page.locator('#market-symbol').fill('茅台');
  await waitForLog(rows => rows.slice(beforeBlur).some(row => row.kind === 'search-start' && row.query === '茅台'));
  await page.locator('#refresh').focus();
  await waitForLog(rows => rows.slice(beforeBlur).some(row => row.kind === 'search-complete' && row.query === '茅台'));
  assert.equal(await page.locator('#market-search-results').isVisible(), false);
  assert.equal(await page.locator('#market-symbol').getAttribute('aria-expanded'), 'false');
  scenario.searchDelays = {}; saveScenario();
  checks.push('A delayed result for an earlier query cannot overwrite newer candidates or reopen the list after focus has moved away.');

  await page.locator('#market-symbol').fill('不存在的证券');
  await page.waitForFunction(() => /未找到|没有.*匹配|无匹配/.test(document.getElementById('market-search-status').textContent));
  assert.equal(await page.locator('#market-search-results [data-market-result]').count(), 0);
  assert.equal(await page.evaluate(() => selected), 'sz000001');
  await capture('no-results');
  scenario.searchFailures = ['茅台']; saveScenario();
  await page.locator('#market-symbol').fill('茅台');
  await page.waitForFunction(() => /隔离证券搜索暂时不可用/.test(document.getElementById('market-search-status').textContent + document.getElementById('market-search-error').textContent));
  assert.equal(await page.locator('#market-search-results [data-market-result]').count(), 0);
  assert.equal(await page.evaluate(() => selected), 'sz000001');
  await capture('search-failure');
  scenario.searchFailures = []; saveScenario();
  await page.locator('#market-search-submit').click();
  await page.waitForFunction(() => !!document.querySelector('[data-market-result="sh600519"]'));
  assert.equal(await page.locator('#market-search-error').isVisible(), false);
  checks.push('No match and search failure clear stale candidates while retaining the current chart; retrying the same term after recovery restores results.');

  await page.locator('#market-symbol').fill(''); const emptyRequests = requests().length;
  await page.waitForTimeout(350);
  assert.equal(requests().length, emptyRequests); assert.equal(await page.locator('#market-search-results').isVisible(), false);
  await page.locator('#market-search-submit').click(); assert.equal(await page.locator('#market-search-error').isVisible(), true);
  const invalidDetails = details().length;
  for (const invalid of ['sh000001', 'sz600519', '920001']) {
    await page.locator('#market-symbol').fill(invalid); await page.locator('#market-symbol').press('Enter');
    assert.equal(await page.locator('#market-search-error').isVisible(), true);
  }
  assert.equal(details().length, invalidDetails); assert.equal(await page.evaluate(() => selected), 'sz000001');
  for (const [input, symbol] of [['600519', 'sh600519'], [' Sz000001 ', 'sz000001']]) {
    await page.locator('#market-symbol').fill(input); await page.locator('#market-symbol').press('Enter'); await selectedStock(symbol);
    assert.equal(await page.locator('#market-search-error').isVisible(), false);
  }
  checks.push('Empty/unsupported full codes retain inline validation, and full valid Shanghai/Shenzhen codes still open directly with Enter.');

  await search('银行', bankSymbols); await capture('candidates', 1120); await capture('candidates', 1536);
  scenario.searchDelays = { '茅台': 700 }; saveScenario();
  const beforeLeave = entries(sourceLog).length;
  await page.locator('#market-symbol').fill('茅台');
  await waitForLog(rows => rows.slice(beforeLeave).some(row => row.kind === 'search-start' && row.query === '茅台'));
  await page.locator('[data-page="agency"]').click();
  await waitForLog(rows => rows.slice(beforeLeave).some(row => row.kind === 'search-complete' && row.query === '茅台'));
  await page.locator('[data-page="market"]').click();
  await page.locator('#market-tab-stocks').click();
  assert.equal(await page.locator('#market-search-results').isVisible(), false);
  assert.equal(await page.evaluate(() => selected), '');
  assert.equal(await page.locator('#market-empty').isVisible(), true);
  assert.equal(await page.locator('#market-symbol').inputValue(), '');
  checks.push('At 1120px and 1536px the candidate list remains usable without horizontal overflow; leaving hides late responses and returning starts empty.');

  const final = await current();
  for (const key of ['watchlist', 'trades', 'orders', 'lots']) assert.deepEqual(final.account[key], initial.account[key], key);
  assert.deepEqual(final.agency.groups.map(group => group.members.map(member => member.symbol)), initial.agency.groups.map(group => group.members.map(member => member.symbol)));
  const writes = ['watch:add', 'watch:remove', 'trade', 'order', 'strategy:buy', 'agency:members:add'];
  assert.ok(!entries(sourceLog).some(row => row.kind === 'ipc' && writes.includes(row.name)));
  assert.deepEqual(errors, []); assert.deepEqual(entries(networkLog), []);
  checks.push('Search and preview leave watchlists, trades, orders, holdings and strategy membership untouched; there are no renderer exceptions or external network calls.');
  const report = { status: 'passed', output, checks, screenshots, errors, isolation: { accountPath, unexpectedNetwork: 0 } };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(output); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
