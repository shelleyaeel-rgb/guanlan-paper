const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'); fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/notice-diagnostics-ui-')), accountPath = path.join(output, 'account');
const controlPath = path.join(output, 'control.json'), networkLog = path.join(output, 'network.jsonl');
const at = Date.parse('2026-10-16T10:00:00+08:00'), codes = ['notice-index-fetch', 'notice-body-fetch', 'notice-page-parse', 'notice-facts-pending', 'notice-policy-missing', 'notice-event-pending', 'notice-blocked'];
const reviews = Object.fromEntries(codes.map((code, index) => {
  const symbol = `sh${600001 + index}`, status = code === 'notice-blocked' ? 'blocked' : 'unverified';
  const notice = { id: `AN2026101600000${index}`, title: `隔离公告 <${code}>`, date: '2026-10-16', status,
    diagnostic: { code, reason: '合成诊断，不代表实际公司' }, reason: '合成诊断，不代表实际公司', records: [] };
  if (code === 'notice-facts-pending') notice.factReview = { type: 'forecast', status: 'incomplete', checks: [], missingFields: ['period'], eligibility: { code: 'performance-period', status: 'pending' } };
  if (code === 'notice-policy-missing') notice.factReview = { type: 'unsupported', status: 'unsupported', checks: [], eligibility: { code: 'notice-risk-policy-missing', status: 'pending' } };
  return [symbol, { status, checkedAt: at, mode: index ? 'automatic-fulltext' : 'title', coverageComplete: index !== 0,
    ...(index === 0 ? { diagnostic: { code, reason: '隔离目录接口离线' } } : {}), notices: index === 0 ? [] : [notice, { ...notice, id: notice.id + '1' }], reasons: [notice.reason] }];
}));
fs.writeFileSync(controlPath, JSON.stringify({ now: '2026-10-16T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', reviews }));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page; const errors = [], checks = [];
const call = (name, payload) => page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload });
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/notice-diagnostics-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  const before = await call('state'); assert.equal(path.resolve(before.dataPath), path.resolve(accountPath));
  await call('agency:members:add', { strategyId: 'swing', symbols: ['sh600007'] });
  await page.locator('[data-page="agency"]').click(); await page.locator('#agency-pool-run').click();
  await page.waitForFunction(() => !state.agencyPool.running && !agencyUi.busy.has('pool-run'));
  assert.equal(await page.locator('#agency-pool-error').innerText(), '');
  const result = (await call('state')).agencyPool.lastResult;
  assert.equal(result.unassignedPending.length, 6); assert.equal(result.retained.length, 1);
  assert.equal(result.listedDiagnostics.uniqueCompanies, 7);
  for (const code of codes) {
    assert.equal(result.listedDiagnostics.stages[code].count, 1, code);
    const counter = page.locator(`[data-pool-stage="${code}"]`); assert.equal(await counter.count(), 1, code);
    assert.match(await counter.innerText(), /1\s*家/);
  }
  assert.equal(await page.locator('[data-pool-stage="notice-risk"]').count(), 0);
  assert.match(await page.locator('#agency-pool-diagnostics').innerText(), /本次列表按公司去重.*列表 7 家/s);
  assert.match(await page.locator('#agency-pool-diagnostics').innerText(), /明确阻断与待核验分别列示/);
  await page.locator('#agency-pool-filter').selectOption('retained');
  await page.locator('#agency-pool-items > details > summary').click();
  await page.locator('#agency-pool-items .agency-notice-review > summary').click();
  assert.match(await page.locator('#agency-pool-items').innerText(), /公告已明确阻断新开仓/);
  assert.equal(await page.locator('[data-notice-diagnostic="notice-blocked"]').count(), 2);
  assert.equal(await page.locator('#agency-pool-items img,#agency-pool-items script').count(), 0);
  for (const width of [1120, 1536]) {
    await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 960), width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#agency-pool-diagnostics').screenshot({ path: path.join(output, `diagnostics-${width}.png`) });
    await page.locator('#agency-pool-items').screenshot({ path: path.join(output, `blocked-${width}.png`) });
  }
  const legacy = await page.evaluate(result => {
    delete result.listedDiagnostics;
    result.coverage.diagnostics.stages = { 'notice-risk': { label: '旧统计不能用于新分类', count: 999 } };
    for (const key of Object.keys(agencyPoolCategories)) for (const row of result[key] || []) row.diagnostics = { stages: [{ code: 'notice-risk', label: '公告风险待核验' }] };
    const element = document.createElement('div'); element.innerHTML = agencyPoolDiagnosticsHtml(result);
    return { text: element.innerText || element.textContent, codes: [...element.querySelectorAll('[data-pool-stage]')].map(el => el.dataset.poolStage), counters: [...element.querySelectorAll('[data-pool-stage] strong')].map(el => el.textContent) };
  }, result);
  assert.doesNotMatch(legacy.text, /999|旧统计/); assert.deepEqual(legacy.codes.sort(), [...codes].sort()); assert.ok(legacy.counters.every(value => /^1/.test(value)));
  checks.push('Seven distinct notice causes render from structured reviews; repeated notices/four strategies count each company once. Blocked is distinct from pending. Historical summaries are rebuilt from the same displayed rows, ignoring incompatible old stage totals.');
  const after = await call('state'); assert.deepEqual(after.account.trades, before.account.trades); assert.deepEqual(after.account.orders, before.account.orders);
  assert.deepEqual(after.agency.groups.map(group => group.mode), before.agency.groups.map(group => group.mode));
  assert.deepEqual(errors, []); assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8') : '', '');
  checks.push('Actual pool IPC and isolated persistence; 1120/1536 layouts fit; no external requests, trades, orders or mode changes.');
  const report = { status: 'passed', output, scope: 'Synthetic notice assessments and strategy classifications; real diagnostics, pool synchronization, renderer and isolated account.', checks, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report, null, 2));
})().catch(error => { fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors }, null, 2)); process.stderr.write(error.stack); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
