// Deterministic statement source parsing, real renderer/IPC and isolated account.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { evaluateEntryConditions } = require('../core/entry-conditions.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/performance-ui-')), accountPath = path.join(output, 'account');
const controlPath = path.join(output, 'control.json'), networkLog = path.join(output, 'network.jsonl'), callsPath = path.join(output, 'calls.jsonl');
const now = '2026-10-15T10:00:00+08:00', stamp = Date.parse(now), checks = [], errors = [], dimensions = [];
const injection = '<img src=x onerror="window.performanceInjected=true"> & <script>bad</script>';
function sample(symbol, incomplete = false) {
  const id = `AN20261013${symbol.slice(2)}01`, title = '2026年前三季度业绩预告', date = '2026-10-13';
  const text = `业绩预告期间：2026年1月1日至2026年9月30日。\n项目  年初至报告期末  上年同期\n${incomplete ? '' : '归属于上市公司股东的净利润  盈利：90万元  盈利：100万元\n比上年同期下降：10%\n'}扣除非经常性损益后的净利润  盈利：80万元  盈利：100万元\n比上年同期下降：20%\n二、与会计师事务所沟通情况\n本次业绩预告未经会计师事务所审计。`;
  const document = { id, title, publishedAt: date, kind: 'notice', issuerSymbol: symbol, fetchedAt: stamp, complete: true, pages: 1, text,
    url: `https://data.eastmoney.com/notices/detail/${symbol.slice(2)}/${id}.html`, pageTexts: [{ page: 1, text, method: 'provider-text', numericEligible: true, complete: true }] };
  return { response: { symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: stamp, data: { items: [{ id, date, title }], total: 1 } },
    bundle: { symbol, fetchedAt: stamp, documents: [document] } };
}
const samples = { sh600009: sample('sh600009', true), sh600010: sample('sh600010'), sh600011: sample('sh600011') };
const financeCheck = { status: 'pass', source: '东方财富', fetchedAt: stamp, reportDate: '2026-06-30', noticeDate: '2026-08-15',
  reasons: ['半年报财务指标独立通过，预告尚未形成正式三季报'], checks: [{ label: '营收同比', status: 'pass', value: 12, op: 'gt', expected: 0, unit: '%' }] };
fs.writeFileSync(controlPath, JSON.stringify({ now, price: 10.17, financeMode: 'ready', valuationMode: 'ready', samples, financeCheck, injection }));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog, GUANLAN_TEST_PERFORMANCE_CALLS: callsPath }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
const calls = () => fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function call(name, payload) { return page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload }); }
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/performance-ui-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  assert.doesNotMatch(await page.locator('#toast').innerText(), /not defined|not a function|Cannot read/i, 'startup should not swallow renderer errors into a toast');
  assert.equal(path.resolve((await call('state')).dataPath), path.resolve(accountPath));
}
async function capture(name, selector) {
  await page.locator('#toast').waitFor({ state: 'hidden' });
  for (const size of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(...value), size);
    const target = page.locator(selector); await target.scrollIntoViewIfNeeded();
    dimensions.push({ name, requested: size, viewport: await page.evaluate(() => [innerWidth, innerHeight]) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} viewport at ${size[0]}`);
    assert.equal(await target.evaluate(element => element.scrollWidth <= element.clientWidth), true, `${name} content at ${size[0]}`);
    await target.screenshot({ path: path.join(output, `${name}-${size[0]}.png`) });
  }
}
async function addRule(id, value) {
  const editor = page.locator(`#${id}`); await editor.locator('[data-performance-add]').click();
  await editor.locator('[data-performance-edit="value"]').last().fill(String(value));
}
async function poolRun() {
  await page.locator('#agency-pool-run').click();
  await page.waitForFunction(() => !state.agencyPool.running && !agencyUi.busy.has('pool-run'));
  assert.equal(await page.locator('#agency-pool-error').innerText(), '');
}
(async () => {
  await launch(); const before = await call('state');
  assert.ok((await call('screener:meta')).performance.fields.netProfitGrowthMinPct);
  await page.locator('[data-page="agency"]').click();
  const poolEditor = page.locator('#agency-performance-controls');
  assert.equal(await poolEditor.locator('[data-performance-edit="enabled"]').inputValue(), 'observe');
  assert.equal(await poolEditor.locator('input').count(), 0);
  await poolEditor.locator('[data-performance-edit="enabled"]').selectOption('filter');
  await page.locator('#agency-pool-run').click(); assert.match(await page.locator('#agency-pool-error').innerText(), /添加指标和阈值/);
  assert.equal(calls().filter(item => item.name === 'agency:pool:run').length, 0);
  await addRule('agency-performance-controls', -20); await capture('pool-performance-editor', '#agency-performance-controls');
  await poolRun();
  let account = await call('state');
  const member = account.agency.groups.flatMap(group => group.members).find(member => member.symbol === 'sh600010');
  assert.equal(member.entryConditions.performance.rules[0].value, -20);
  assert.equal(account.agencyPool.lastResult.performance.rules[0].value, -20);
  assert.equal(account.agencyPool.lastResult.unassignedPending[0].symbol, 'sh600009');
  await page.locator('#agency-pool-filter').selectOption('unassignedPending');
  await page.locator('#agency-pool-items > details > summary').click();
  await page.locator('#agency-pool-items .finance-check > summary').click();
  await page.locator('#agency-pool-items .performance-review > summary').click();
  await page.locator('#agency-pool-items .agency-notice-review > summary').click();
  const body = await page.locator('#agency-pool-items').innerText();
  for (const phrase of ['半年报', '财务通过', '2026-06-30', '资料待补', '归母净利润', injection]) assert.ok(body.includes(phrase), phrase);
  assert.equal(await page.locator('#agency-pool-items img, #agency-pool-items script').count(), 0);
  assert.equal(await page.evaluate(() => !!window.performanceInjected), false);
  await capture('independent-finance-and-forecast', '#agency-pool-items');
  await page.locator('#agency-pool-items .agency-notice-review').scrollIntoViewIfNeeded();
  await capture('forecast-source-warning', '#agency-pool-items .agency-notice-review');
  checks.push('Candidate editor defaults to observation; incomplete enabled rules cannot submit; negative lower bound is submitted and saved; half-year financial pass appears alongside forecast gaps and escaped warnings.');

  const source = samples.sh600010;
  const quote = { symbol: 'sh600010', name: '隔离测试', timestamp: stamp, date: '2026-10-15', price: 10.17 };
  const rechecked = evaluateEntryConditions(member.entryConditions, 'sh600010', quote, { notices: source.response, automaticEvidence: source.bundle }, new Date(now));
  assert.equal(rechecked.status, 'pass'); assert.equal(rechecked.performanceReview.status, 'pass');
  const missing = evaluateEntryConditions(member.entryConditions, 'sh600010', quote, {}, new Date(now));
  assert.equal(missing.performanceReview.status, 'pending');
  const decision = { id: 'isolated-performance-decision', strategyId: 'swing', symbol: 'sh600010', status: 'waiting', action: 'wait',
    createdAt: stamp, decisionMode: 'rules', reason: '业绩条件已经复核，等待策略买点', financeCheck, entryConditionsCheck: rechecked, evidence: [], inputSources: [] };
  await page.evaluate(decision => {
    window.__performanceDecisionRenderer = agencyDecisionsHtml;
    agencyDecisionsHtml = group => { const previous = state.agency.decisions; state.agency.decisions = [decision]; try { return window.__performanceDecisionRenderer(group); } finally { state.agency.decisions = previous; } };
    renderAgency();
  }, decision);
  await page.locator('#agency-decisions .finance-check > summary').click();
  await page.locator('#agency-decisions .performance-review > summary').click();
  assert.match(await page.locator('#agency-decisions').innerText(), /半年报.*财务通过/s);
  assert.match(await page.locator('#agency-decisions').innerText(), /预告 \/ 快报条件：通过/);
  await capture('entry-condition-review', '#agency-decisions');
  await page.evaluate(() => { agencyDecisionsHtml = window.__performanceDecisionRenderer; delete window.__performanceDecisionRenderer; renderAgency(); });
  await poolEditor.locator('[data-performance-edit="value"]').fill('-5'); await poolRun();
  account = await call('state'); assert.equal(account.agencyPool.lastResult.performance.rules[0].value, -5);
  assert.equal(account.agency.groups.flatMap(group => group.members).find(member => member.symbol === 'sh600010').entryConditions.performance.rules[0].value, -20);
  checks.push('Production entry-condition evaluator reparses source and passes -10 >= -20, then returns pending without source; subsequent candidate threshold edits preserve existing member snapshots.');

  await page.locator('[data-page="screener"]').click(); await page.waitForFunction(() => screenInitialized && !screenBusy);
  const screenEditor = page.locator('#screen-performance-controls');
  assert.equal(await screenEditor.locator('[data-performance-edit="enabled"]').inputValue(), 'observe');
  await addRule('screen-performance-controls', -20);
  await page.locator('#screen-description').fill('股价大于1'); await page.locator('#screen-parse').click(); await page.waitForFunction(() => !screenBusy);
  assert.equal(await page.evaluate(() => screenQuery.performance.rules[0].value), -20);
  assert.equal(await page.locator('#screen-error').innerText(), '');
  assert.equal(await page.evaluate(() => screenResult.performanceScreen.passed), 2);
  await capture('screener-performance-editor', '#screen-performance-controls');
  await page.locator('#screen-agency-all').click();
  assert.match(await page.locator('#screen-agency-conditions').innerText(), /同比下界.*-20/s);
  await page.locator('#screen-agency-strategy').selectOption('swing'); await page.locator('#screen-agency-submit').click();
  await page.waitForFunction(() => screenAgencyBatch?.completed && !screenAgencyBusy);
  assert.equal(await page.locator('#screen-agency-error').innerText(), ''); await page.locator('#screen-agency-close').click();
  account = await call('state'); assert.equal(account.agency.groups.flatMap(group => group.members).find(member => member.symbol === 'sh600011').entryConditions.performance.rules[0].value, -20);
  await screenEditor.locator('[data-performance-edit="value"]').fill('-5'); await page.locator('#screen-run').click(); await page.waitForFunction(() => !screenBusy);
  assert.equal(await page.evaluate(() => screenResult.performanceFailedRows.length), 2);
  await page.locator('#screen-performance-results details > summary').first().click();
  await page.locator('#screen-performance-results .performance-review > summary').first().click();
  assert.match(await page.locator('#screen-performance-results').innerText(), /条件不符/);
  await capture('screener-performance-failed', '#screen-performance-results');
  await screenEditor.locator('[data-performance-add]').click();
  await screenEditor.locator('[data-performance-edit="enabled"]').selectOption('observe');
  assert.equal(await screenEditor.locator('input').count(), 0);
  await page.locator('#screen-run').click(); await page.waitForFunction(() => !screenBusy);
  assert.equal(await page.locator('#screen-error').innerText(), '');
  checks.push('Ordinary screener preserves predicates through text input, reads real synthetic notice sources, separates failed conditions, saves batch member predicates, and clears incomplete thresholds when returned to observation.');

  await desktop.close(); desktop = null; await launch();
  const after = await call('state');
  for (const symbol of ['sh600010', 'sh600011']) assert.equal(after.agency.groups.flatMap(group => group.members).find(member => member.symbol === symbol).entryConditions.performance.rules[0].value, -20);
  assert.deepEqual(after.account.trades, before.account.trades); assert.deepEqual(after.account.risks, before.account.risks);
  assert.deepEqual(after.agency.groups.map(group => group.mode), before.agency.groups.map(group => group.mode));
  assert.deepEqual(errors, []); assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8') : '', '');
  checks.push('Restart preserves source condition snapshots; 1120/1536 window widths fit with no markup execution, external requests, trades or mode changes.');
  const report = { status: 'passed', output, scope: 'Synthetic statement sources and pool classification; actual parser, screener, IPC, renderer and isolated persistence. Decision display is a renderer-only fixture with a production condition evaluation.', checks, dimensions, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(error => { fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, checks }, null, 2)); process.stderr.write(error.stack + '\n'); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
