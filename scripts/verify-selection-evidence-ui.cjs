// Real Electron and IPC against synthetic research and an isolated account only.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/selection-evidence-ui-'));
const accountPath = path.join(output, 'account'), control = path.join(output, 'control.json');
fs.writeFileSync(control, JSON.stringify({ now: '2026-10-08T10:00:00+08:00', price: 10.08, dailyMode: 'ready', financeMode: 'ready' }));
const env = { ...process.env, GUANLAN_TEST_CONTROL: control }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page; const errors = [], checks = [];
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/strategy-screener-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), path.resolve(accountPath));
  await page.locator('[data-page="screener"]').click(); await idle();
}
async function idle() {
  await page.waitForFunction(() => typeof screenResult !== 'undefined' && !screenBusy && (screenResult || !document.querySelector('#screen-error').classList.contains('hidden')), null, { timeout: 90000 });
}
async function run() { await page.locator('#screen-run').click(); await idle(); }
async function noOverflow() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
const base = symbol => ({ symbol, subject: '隔离样本核心产品', reviewState: 'confirmed', sourceTitle: '隔离测试行业报告', url: 'https://example.com/research', publishedAt: '2026-08-20', period: '2025年度及2026—2028年前景', reviewedAt: '2026-10-01', validUntil: '2026-12-31', quote: '这是隔离测试事实，不代表真实公司情况。', notes: '测试已核对口径。' });
const rank = (symbol, kind = 'mainRank', position = 2) => ({ ...base(symbol), kind, value: 'ranked', rank: position, market: '隔离样本产品市场', geography: '中国', metric: 'sales', coverage: 'allCompetitors', statisticYear: 2025, ...(kind === 'segmentRank' ? { revenueSharePct: 55 } : {}) });
async function seed(records) { return page.evaluate(async records => { const saved = []; for (const record of records) saved.push(await api('evidence:save', record)); return saved; }, records); }
async function editor(symbol) {
  await page.locator('#screen-evidence-manage').click();
  await page.locator('#selection-evidence-symbol').fill(symbol);
  await page.locator('#selection-evidence-load').click();
  await page.waitForFunction(symbol => !selectionEvidenceUi.busy && selectionEvidenceUi.symbol === symbol, symbol);
}
(async () => {
  await launch();
  await page.locator('#screen-quality-template').click();
  assert.equal(await page.evaluate(() => screenQuery.rules.length), 7);
  assert.deepEqual(await page.evaluate(() => screenQuery.evidence.conditions), ['productOutlook', 'financialReview']);
  assert.equal(await page.evaluate(() => screenQuery.evidence.leadership), 'either');
  await run();
  assert.equal(await page.evaluate(() => screenResult.matched), null);
  assert.ok(await page.evaluate(() => screenResult.evidencePendingRows.length > 0 && screenResult.rows.length === 0));
  assert.equal(await page.locator('#screen-agency-all').isDisabled(), true);
  checks.push('quality template includes annual thresholds and evidence OR; missing evidence remains pending');

  await editor('sh600519'); await page.locator('#selection-evidence-new').click();
  assert.equal(await page.locator('#selection-evidence-review-state').inputValue(), 'draft');
  const input = base('sh600519');
  await page.locator('#selection-evidence-kind').selectOption('demand');
  await page.locator('#selection-evidence-value').selectOption('supported');
  await page.locator('#selection-evidence-review-state').selectOption('confirmed');
  for (const [id, value] of Object.entries({ subject: input.subject, 'source-title': input.sourceTitle, url: input.url, 'published-at': input.publishedAt, period: input.period, 'reviewed-at': input.reviewedAt, 'valid-until': input.validUntil, quote: '<img src=x onerror="window.badEvidence=true">隔离需求证据', notes: input.notes })) await page.locator('#selection-evidence-' + id).fill(value);
  await page.locator('#selection-evidence-save').click();
  await page.waitForFunction(() => !selectionEvidenceUi.busy && selectionEvidenceUi.records.length === 1);
  assert.equal(await page.evaluate(() => window.badEvidence), undefined);
  assert.match(await page.locator('#selection-evidence-list').innerText(), /<img src=x/);
  assert.equal(await page.evaluate(() => screenDirty), true);
  await noOverflow(); await page.locator('#selection-evidence-dialog').screenshot({ path: path.join(output, 'evidence-manager.png') });
  await page.locator('#selection-evidence-close').click();
  checks.push('manual evidence form defaults to draft, saves provenance through IPC, escapes HTML, invalidates previous results');

  const productKinds = [['demand', 'supported'], ['commercialization', 'revenue'], ['advantage', 'verified'], ['outlookRisk', 'clear'], ['financialReview', 'clear']];
  await seed(['sh600519', 'sh600003', 'sh600004'].flatMap(symbol => productKinds.filter(([kind]) => symbol !== 'sh600519' || kind !== 'demand').map(([kind, value]) => ({ ...base(symbol), kind, value: symbol === 'sh600003' && kind === 'demand' ? 'unsupported' : value }))));
  await seed([rank('sh600519'), rank('sh600003'), rank('sh600004', 'mainRank', 5), rank('sh600004', 'segmentRank', 1), { ...base('sh600002'), kind: 'demand', value: 'supported' }]);
  await run();
  assert.deepEqual(await page.evaluate(() => screenResult.rows.map(row => row.symbol).sort()), ['sh600004', 'sh600519']);
  assert.ok(await page.evaluate(() => screenResult.evidencePendingRows.some(row => row.symbol === 'sh600002')));
  assert.ok(await page.evaluate(() => screenResult.evidenceFailedRows.some(row => row.symbol === 'sh600003')));
  assert.ok(await page.evaluate(() => screenResult.rows.every(row => row.financeAnnualReports.length === 3 && row.selectionEvidence.status === 'pass')));
  const savedQuery = await page.evaluate(() => structuredClone(screenQuery));
  checks.push('financial AND product conditions; main-rank and segment-rank OR; pending and fail are separate and excluded from normal candidates');

  await page.locator('#screen-table [data-screen-open="sh600519"]').click();
  await page.waitForFunction(() => page === 'market' && researchEvidence?.symbol === 'sh600519');
  await page.locator('#research-evidence > details > summary').click();
  assert.match(await page.locator('#research-evidence').innerText(), /产品前景有证据支持/);
  assert.match(await page.locator('#research-evidence').innerText(), /当次年度财务依据/);
  await page.locator('#research-evidence').screenshot({ path: path.join(output, 'research-evidence.png') });
  await page.locator('[data-page="screener"]').click();
  for (const width of [1120, 1536]) {
    await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 960), width);
    await noOverflow(); await page.screenshot({ path: path.join(output, `screener-${width}.png`), fullPage: true });
  }
  checks.push('selection and annual evidence survive opening stock detail; 1120px and 1536px layouts have no document overflow');

  await editor('sh600519');
  const demand = await page.evaluate(() => selectionEvidenceUi.records.find(record => record.kind === 'demand'));
  await page.locator(`[data-evidence-edit="${demand.id}"]`).click();
  await page.locator('#selection-evidence-valid-until').fill('2026-10-07');
  await page.locator('#selection-evidence-save').click();
  await page.waitForFunction(() => !selectionEvidenceUi.busy && document.querySelector('#selection-evidence-form').classList.contains('hidden'));
  await page.locator('#selection-evidence-close').click();
  assert.equal(await page.locator('#screen-agency-all').isDisabled(), true);
  await run();
  assert.deepEqual(await page.evaluate(() => screenResult.rows.map(row => row.symbol)), ['sh600004']);
  assert.ok(await page.evaluate(() => screenResult.evidencePendingRows.some(row => row.symbol === 'sh600519')));
  checks.push('editing expiry invalidates previous bulk action and moves formerly passing company to pending');

  await page.locator('#screen-reset').click();
  assert.equal(await page.evaluate(() => screenQuery.evidence), undefined);
  await page.locator('#screen-description').fill('产品已商业化，主行业前三或细分龙头');
  await page.locator('#screen-parse').click(); await idle();
  assert.deepEqual(await page.evaluate(() => screenQuery.evidence.conditions), ['commercialization']);
  assert.equal(await page.evaluate(() => screenQuery.evidence.leadership), 'either');
  assert.equal(await page.evaluate(() => screenQuery.rules.length), 0);
  const snapshotId = await page.evaluate(() => screenHistory[0].id);
  const historic = await page.evaluate(async snapshotId => window.guanlan.call('screener:run', { query: screenQuery, snapshotId, force: false }), snapshotId);
  assert.equal(historic.ok, false); assert.match(historic.error, /历史快照.*证据/);
  checks.push('reset clears labels, text builds explicit categorical rules, historical evidence screening is refused');

  await page.locator('#screen-reset').click();
  await page.locator('#screen-description').fill('近三年平均年度ROE不低于15%');
  await page.locator('#screen-parse').click(); await idle();
  await page.locator('#screen-evidence-leadership').selectOption('segmentLeader');
  await page.locator('#screen-evidence-share').fill('75'); await page.locator('#screen-evidence-share').press('Tab');
  await page.locator('#screen-quality-template').click();
  assert.ok(await page.evaluate(() => screenPersonalRules.some(rule => rule.field === 'annualRoeAverage' && rule.value === 15)));
  assert.equal(await page.evaluate(() => screenQuery.evidence.leadership), 'segmentLeader');
  assert.equal(await page.evaluate(() => screenQuery.evidence.minSegmentRevenuePct), 75);
  checks.push('adding the quality template preserves existing stricter quantitative and leadership conditions');

  const before = await page.evaluate(async () => api('evidence:list'));
  await desktop.close(); desktop = null; await launch();
  const after = await page.evaluate(async () => api('evidence:list'));
  assert.deepEqual(after, before);
  const rerun = await page.evaluate(async query => api('screener:run', { query, force: true }), savedQuery);
  assert.deepEqual(rerun.rows.map(row => row.symbol), ['sh600004']);
  assert.equal((await page.evaluate(async () => api('state'))).account.trades.length, 0);
  checks.push('evidence persists across restart; saved expiry still applies and isolated account has no trades');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, errors, accountPath }, null, 2));
  console.log(JSON.stringify({ output, checks, errors }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
