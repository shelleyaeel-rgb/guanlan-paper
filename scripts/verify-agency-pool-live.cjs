// Real public data and production IPC. The temporary account has no research
// evidence, funds allocated to strategies, positions or trading authority.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-pool-live-'));
const dataPath = path.join(output, 'account'), packaged = process.env.GUANLAN_PACKAGE_EXE;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('GUANLAN_TEST_')) delete env[key];
const report = { output, checkedAt: new Date().toISOString(), packaged: !!packaged, errors: [] };
let desktop, page;
async function call(name) {
  return page.evaluate(async name => { const response = await window.guanlan.call(name); if (!response.ok) throw Error(response.error); return response.data; }, name);
}
(async () => {
  desktop = await _electron.launch({ executablePath: packaged || require('electron'),
    args: packaged ? [`--user-data-dir=${dataPath}`] : [root, `--test-data-dir=${dataPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state?.agencyPool);
  const initial = await call('state');
  assert.equal(path.resolve(initial.dataPath), dataPath);
  assert.equal(initial.agencyPool.lastResult, null);
  await page.locator('[data-page="agency"]').click();
  assert.equal(await page.locator('#agency-pool-run').isEnabled(), true);
  await page.locator('#agency-pool-run').click();
  await page.waitForFunction(() => !state.agencyPool.running && (!!state.agencyPool.lastResult || !!state.agencyPool.lastError), null, { timeout: 1800000 });
  const current = await call('state'), pool = current.agencyPool;
  if (pool.lastError) throw Error(pool.lastError);
  assert.ok(pool.lastResult.coverage.universeComplete);
  assert.ok(pool.lastResult.coverage.universeCount > 5000);
  const coverage = pool.lastResult.coverage;
  assert.equal(pool.lastResult.policyVersion, 2);
  assert.ok(coverage.financeChecked > 0);
  assert.ok(coverage.evidenceChecked <= coverage.quantitativeCandidates);
  assert.ok(coverage.quantitativeCandidates <= coverage.commonPassed);
  assert.equal(coverage.evidenceSummary.pass + coverage.evidenceSummary.failed + coverage.evidenceSummary.pending, coverage.evidenceChecked);
  assert.equal(current.account.trades.length, 0); assert.equal(current.account.orders.length, 0);
  assert.equal(current.account.lots.length, 0); assert.equal(current.account.agency.transfers.length, 0);
  assert.ok(current.agency.groups.every(group => group.mode === 'paused' && group.cash === 0));
  assert.equal(await page.locator('#agency-pool-run').isEnabled(), true, 'button is immediately available for another manual update');
  report.result = { counts: pool.lastResult.counts, coverage: pool.lastResult.coverage, sources: pool.lastResult.sources,
    pendingSample: pool.lastResult.unassignedPending.slice(0, 3) };
  report.account = { dataPath: current.dataPath, trades: 0, orders: 0, positions: 0, transfers: 0 };
  await page.screenshot({ path: path.join(output, 'live-result.png'), fullPage: true });
  assert.deepEqual(report.errors, []); report.ok = true;
})().catch(async error => {
  report.ok = false; report.error = error.message; process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {});
}).finally(async () => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (desktop) await desktop.close();
});
