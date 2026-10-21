// Isolated Electron UI + production IPC/service; scanner logic is covered by
// agency-screening.test.cjs, while this fixture controls result and timing.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-pool-ui-'));
const controlPath = path.join(output, 'control.json'), accountPath = path.join(output, 'account');
const networkLog = path.join(output, 'unexpected-network.jsonl'), poolLog = path.join(output, 'pool-requests.jsonl');
const settings = { now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', poolDelay: 150 };
const scenario = patch => { Object.assign(settings, patch); fs.writeFileSync(controlPath, JSON.stringify(settings)); };
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog, GUANLAN_TEST_POOL_LOG: poolLog }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page; const errors = [], checks = [];
const group = (current, id = 'swing') => current.agency.groups.find(item => item.id === id);
const logEntries = () => fs.existsSync(poolLog) ? fs.readFileSync(poolLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function call(name, payload) { return page.evaluate(async ({ name, payload }) => { if (['trade', 'order', 'strategy:buy', 'agency:transfer'].includes(name)) payload = { ...payload, requestId: crypto.randomUUID(), accountCreatedAt: (await window.guanlan.call('state')).data.account.createdAt }; const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload }); }
async function refresh() { await page.evaluate(async () => renderState(await api('state'))); }
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/agency-pool-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  assert.equal(path.resolve((await call('state')).dataPath), path.resolve(accountPath));
  await page.locator('[data-page="agency"]').click();
}
async function idle() { await page.waitForFunction(() => !state.agencyPool.running && !agencyUi.busy.has('pool-run') && !agencyUi.busy.has('pool-retry'), null, { timeout: 30000 }); }
async function run() { await page.locator('#agency-pool-run').click(); await idle(); return (await call('state')).agencyPool.lastResult; }
async function capture(name) {
  await page.locator('#toast').waitFor({ state: 'hidden' });
  for (const [width, height] of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} fits ${width}px`);
    await page.locator('#agency-pool-card').screenshot({ path: path.join(output, `${name}-${width}.png`) });
  }
}
(async () => {
  scenario({}); await launch();
  assert.equal(await page.locator('#agency-pool-retry').isVisible(), false);
  assert.equal(await page.locator('#agency-pool-mode').inputValue(), 'strategy');
  await page.locator('#agency-pool-mode').selectOption('strict');
  await page.locator('#agency-pool-policy summary').click();
  assert.match(await page.locator('#agency-pool-policy').innerText(), /近三年平均年度 ROE（%） ≥ 10/);
  assert.match(await page.locator('#agency-pool-policy').innerText(), /主行业前三或重要细分行业龙头/);
  assert.match(await page.locator('.agency-pool-description').innerText(), /先对沪深全部 A 股进行财务与四策略数值筛选，再由程序/);
  assert.match(await page.locator('#agency-pool-policy').innerText(), /严格研究筛选无需手工填写研究证据/);
  await call('agency:transfer', { strategyId: 'swing', amount: 200000 });
  await call('agency:member', { strategyId: 'swing', symbol: 'sh600519', action: 'add' });
  await call('agency:mode', { strategyId: 'swing', mode: 'running' });
  await page.waitForFunction(() => state.account.trades.some(trade => trade.symbol === 'sh600519' && trade.side === 'buy'), null, { timeout: 20000 });
  await call('agency:mode', { strategyId: 'swing', mode: 'stopped' });
  for (const symbol of ['sh600036', 'sh600002', 'sh600003']) await call('agency:member', { strategyId: 'swing', symbol, action: 'add' });
  await call('trade', { symbol: 'sh600005', side: 'buy', quantity: 100 });
  scenario({ now: '2026-10-03T21:00:00+08:00', poolDelay: 2400 }); await refresh();
  const before = await call('state'), risk = structuredClone(before.account.risks.sh600519), modes = before.agency.groups.map(item => item.mode);
  assert.equal(await page.locator('#agency-run').isDisabled(), true);
  assert.equal(await page.locator('#agency-pool-run').isEnabled(), true);
  await page.locator('#agency-pool-run').click();
  await page.waitForFunction(() => state.agencyPool.running);
  assert.equal(await page.locator('#agency-pool-run').isDisabled(), true);
  assert.equal(await page.locator('#agency-pool-cancel').isVisible(), true);
  assert.equal(await page.locator('#confirm-dialog').getAttribute('open'), null);
  await idle();
  let current = await call('state'), result = current.agencyPool.lastResult;
  assert.equal(result.counts.added, 24); assert.equal(result.counts.retained, 2); assert.equal(result.counts.removed, 0);
  assert.equal(result.counts.pending, 1); assert.equal(result.counts.held, 1); assert.equal(result.counts.skipped, 1);
  assert.equal(result.counts.unassignedPending, 1);
  assert.equal(result.policyVersion, 3); assert.equal(result.screeningMode, 'strict'); assert.equal(current.agencyPool.policies.strict.evidenceMode, 'automatic');
  assert.equal(group(current).members.some(item => item.symbol === 'sh600036'), true);
  assert.equal(group(current, 'ultra-short').members.some(item => item.symbol === 'sh600006'), true);
  assert.deepEqual(current.agency.groups.map(item => item.mode), modes);
  assert.deepEqual(current.account.risks.sh600519, risk); assert.deepEqual(current.account.trades, before.account.trades);
  assert.match(await page.locator('#agency-pool-result-scope').innerText(), /隔离 UI 行情样本/);
  assert.match(await page.locator('#agency-pool-result-scope').innerText(), /2026\/9\/30/);
  assert.match(await page.locator('#agency-pool-result-scope').innerText(), /公开披露资料程序核验/);
  assert.match(await page.locator('#agency-pool-evidence-summary').innerText(), /量化入围 28 家/);
  assert.match(await page.locator('#agency-pool-evidence-summary').innerText(), /尝试核验\s+28 家.*资料收集完整（仍需内容核验）\s+28 家.*核验通过\s+26 家/s);
  assert.match(await page.locator('#agency-pool-evidence-summary').innerText(), /核验不符 0 家 · 资料不足 2 家/);
  assert.match(await page.locator('#agency-pool-diagnostics').innerText(), /扫描 30 家 · 待核验 2 家/);
  assert.match(await page.locator('#agency-pool-diagnostics').innerText(), /阶段数量不可相加/);
  assert.equal(await page.locator('#agency-pool-retry').isEnabled(), true);
  assert.match(await page.locator('#agency-pool-retry-note').innerText(), /先刷新全市场数值筛选，再复用仍然有效的资料/);
  await page.locator('#agency-pool-evidence-summary summary').click();
  assert.match(await page.locator('.agency-pool-evidence-checks').innerText(), /行业地位\s+通过 26 · 不符 0 · 资料不足 2/);
  assert.match(await page.locator('#agency-pool-strategies').innerText(), /超短线.*通过/s);
  await page.locator('#agency-pool-filter').selectOption('unassignedPending');
  assert.equal(await page.locator('#agency-pool-evidence-summary details').getAttribute('open'), '');
  await page.locator('#agency-pool-items > details > summary').first().click();
  assert.match(await page.locator('#agency-pool-items').innerText(), /公开披露资料不足以核验行业地位 <隔离样本>/);
  assert.match(await page.locator('#agency-pool-items').innerText(), /未分配策略/);
  assert.match(await page.locator('#agency-pool-items').innerText(), /待核验策略/);
  await page.locator('.agency-pool-evidence-detail > summary').click();
  assert.match(await page.locator('.agency-pool-evidence-detail').innerText(), /行业地位 · 资料不足/);
  await page.locator('.agency-pool-evidence-detail section details summary').first().click();
  assert.match(await page.locator('.agency-pool-evidence-detail').innerText(), /隔离原文摘录 <不是人工审核>/);
  assert.match(await page.locator('.agency-pool-evidence-detail').innerText(), /原文来源：https:\/\/example.com\/company\/report/);
  assert.match(await page.locator('.agency-pool-evidence-detail').innerText(), /第 3 页 · PDF 文字/);
  assert.match(await page.locator('.agency-pool-evidence-detail').innerText(), /第 4 页 · 扫描识别 · 待核对 · 识别置信度 91%/);
  assert.equal(await page.locator('.agency-pool-evidence-detail a').count(), 0);
  assert.doesNotMatch(await page.locator('.agency-pool-evidence-detail').innerText(), /已人工核验/);
  checks.push('automatic public-source review shows deduplicated quantitative/review counts, three condition summaries, missing evidence and read-only excerpts without claiming human approval');
  await capture('pool-results');
  checks.push('weekend button uses real IPC/service, requires no confirmation, keeps strategy modes/trades/held exit plan and separates unassigned evidence cases');
  await page.locator('#agency-pool-filter').selectOption('added');
  assert.equal(await page.locator('#agency-pool-items > details').count(), 20);
  await page.locator('#agency-pool-next').click(); assert.equal(await page.locator('#agency-pool-items > details').count(), 4);
  await page.locator('#agency-pool-search').fill('600006'); assert.equal(await page.locator('#agency-pool-items > details').count(), 1);
  await page.locator('#agency-pool-search').fill(''); await page.locator('#agency-pool-filter').selectOption('all');
  scenario({ poolDelay: 150 }); const firstId = result.id;
  result = await run(); assert.notEqual(result.id, firstId); assert.equal(result.counts.added, 0); assert.equal(result.counts.retained, 26);
  assert.equal(logEntries().length, 2); assert.equal(logEntries().every(item => item.force === true), true);
  checks.push('same-day rerun refreshes existing members without duplicates; results paginate and filter by category/name/code');
  scenario({ poolDelay: 10000 }); const completedId = result.id;
  await page.locator('#agency-pool-run').click(); await page.waitForFunction(() => state.agencyPool.running);
  await page.locator('#agency-pool-cancel').click(); await idle();
  assert.equal((await call('state')).agencyPool.lastResult.id, completedId);
  assert.match(await page.locator('#agency-pool-error').innerText(), /取消/);
  assert.equal(await page.locator('#agency-pool-run').isEnabled(), true);
  scenario({ poolDelay: 150, poolFailure: true }); await run();
  assert.equal((await call('state')).agencyPool.lastResult.id, completedId);
  assert.match(await page.locator('#agency-pool-error').innerText(), /行情获取失败/);
  checks.push('cancel and acquisition failure leave previous completed results and candidate membership unchanged; button remains available');
  scenario({ poolFailure: false }); await desktop.close(); desktop = null; await launch();
  assert.equal((await call('state')).agencyPool.lastResult.id, completedId);
  await page.locator('[data-agency-tab="swing"]').click();
  assert.match(await page.locator('#agency-members').innerText(), /历史筛选记录：待核验/);
  assert.equal(await page.locator('#agency-pool-run').isEnabled(), true);
  await capture('pool-restored');
  checks.push('restart restores persisted result and member quality gates without rerunning a scheduled update');
  await page.locator('#agency-add').click();
  assert.match(await page.locator('#agency-assign-policy').innerText(), /纳入策略监控/);
  assert.match(await page.locator('#agency-assign-conditions').innerText(), /不额外附加共同财务或行业研究条件/);
  await page.locator('#agency-assign-symbol').fill('sh600008');
  await page.locator('#agency-assign-submit').click();
  await page.waitForFunction(() => !document.querySelector('#agency-assign-dialog').open);
  current = await call('state');
  const manuallyAdded = group(current).members.find(item => item.symbol === 'sh600008');
  assert.equal(manuallyAdded.selectionMode, 'strategy');
  assert.equal(manuallyAdded.entryConditions, undefined);
  assert.match(await page.locator('#toast').innerText(), /已纳入策略监控/);
  await page.evaluate(() => renderScreenAgencyMode());
  assert.match(await page.locator('#screen-agency-policy').textContent(), /新增股票纳入策略监控/);
  assert.equal(logEntries().length, 4, 'manual addition/restart never schedule a pool run');
  checks.push('manual and batch additions remain strategy monitors after a strict scan and do not inherit common research gates');
  const historicalText = await page.evaluate(() => {
    // Render-only compatibility case. The real engine/account stays untouched.
    const actual = structuredClone(state), historical = structuredClone(state);
    historical.agencyPool.lastResult.id += '-legacy-view'; historical.agencyPool.lastResult.policyVersion = 1;
    delete historical.agencyPool.lastResult.coverage.evidenceSummary;
    delete historical.agencyPool.lastResult.coverage.quantitativeCandidates;
    delete historical.agencyPool.lastResult.coverage.evidenceChecked;
    delete historical.agencyPool.lastResult.coverage.diagnostics;
    historical.agencyPool.lastResult.sources.evidence = '本地已人工核验研究证据';
    renderState(historical);
    const result = document.querySelector('#agency-pool-evidence-summary').textContent;
    renderState(actual); return result;
  });
  assert.match(historicalText, /旧版研究证据结果/);
  assert.doesNotMatch(historicalText, /已核验 \d+ 只/);
  const diagnosticReason = '已找到2026年半年度报告公告，披露日期 2026-08-26，但全文尚未完整取得或未通过校验：PDF 下载超时；暂不能用作核验依据';
  const retrievalReason = '资料获取：2026年半年度报告全文读取失败：PDF 下载超时';
  const diagnosticBefore = await call('state');
  await page.locator('#agency-pool-mode').selectOption('strict');
  scenario({ diagnosticEvidenceReview: { mode: 'automatic', status: 'pending', checkedAt: Date.parse(settings.now),
    checks: [{ key: 'sourceIntegrity', label: '全文来源与时点核验', status: 'pending', reason: diagnosticReason, records: [] }],
    reasons: [retrievalReason] } });
  result = await run();
  assert.equal(result.unassignedPending.find(item => item.symbol === 'sh600009').evidenceReview.checks[0].reason, diagnosticReason);
  await page.locator('#agency-pool-filter').selectOption('unassignedPending');
  await page.locator('#agency-pool-items > details > summary').first().click();
  await page.locator('.agency-pool-evidence-detail > summary').click();
  const diagnosticText = await page.locator('.agency-pool-evidence-detail').innerText();
  assert.match(diagnosticText, /全文来源与时点核验 · 资料不足/);
  assert.ok(diagnosticText.includes(diagnosticReason), 'the complete check reason, publication date and body failure must be visible');
  assert.ok(diagnosticText.includes(retrievalReason), 'the separate source acquisition reasons must also be visible');
  assert.doesNotMatch(diagnosticText, /未披露|缺少2026年完整半年度报告/);
  current = await call('state');
  assert.deepEqual(current.account.trades, diagnosticBefore.account.trades);
  assert.deepEqual(current.account.risks, diagnosticBefore.account.risks);
  assert.deepEqual(current.agency.groups.map(item => item.mode), diagnosticBefore.agency.groups.map(item => item.mode));
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await capture('pool-report-fulltext-failure');
  checks.push('a found 2026 semiannual report shows its 2026-08-26 publication date and full-text read failure in both the full source-integrity reason and separate acquisition reasons, without calling it undisclosed');
  const retryBefore = await call('state'), retryStartId = retryBefore.agencyPool.lastResult.id;
  scenario({ poolDelay: 10000 });
  await page.locator('#agency-pool-retry').click();
  await page.waitForFunction(() => state.agencyPool.running && state.agencyPool.operation === 'retry');
  assert.equal(await page.locator('#agency-pool-run').isDisabled(), true);
  assert.equal(await page.locator('#agency-pool-retry').isDisabled(), true);
  assert.match(await page.locator('#agency-pool-retry').innerText(), /正在重试/);
  assert.match(await page.locator('#agency-pool-progress-label').innerText(), /重试资料/);
  assert.equal(await page.locator('#agency-pool-cancel').isVisible(), true);
  assert.equal(await page.locator('#confirm-dialog').getAttribute('open'), null);
  await page.locator('#agency-pool-cancel').click(); await idle();
  assert.equal((await call('state')).agencyPool.lastResult.id, retryStartId);
  assert.equal(await page.locator('#agency-pool-retry').isEnabled(), true);
  scenario({ poolDelay: 300, diagnosticEvidenceReview: null });
  await page.locator('#agency-pool-retry').click(); await idle();
  current = await call('state');
  assert.equal(current.agencyPool.lastResult.operation, 'retry');
  assert.notEqual(current.agencyPool.lastResult.id, retryStartId);
  assert.match(await page.locator('#agency-pool-status').innerText(), /最近重试/);
  assert.deepEqual(current.account.trades, retryBefore.account.trades);
  assert.deepEqual(current.account.risks, retryBefore.account.risks);
  assert.deepEqual(current.agency.groups.map(item => item.mode), retryBefore.agency.groups.map(item => item.mode));
  assert.equal(logEntries().slice(-2).every(item => item.retryEvidence === true && item.force === true), true);
  checks.push('retry uses production IPC, reruns quantitative screening, mutually excludes full update, cancels without replacing results and preserves strategy modes/trades/held exits');
  const diagnosticRendering = await page.evaluate(() => {
    const actual = structuredClone(state), view = structuredClone(state), result = view.agencyPool.lastResult;
    const stages = [
      ['daily-insufficient', 'daily', '完整日线不足', false], ['daily-date', 'daily', '日线日期或价格基准异常', false],
      ['document-download', 'download', '资料下载失败', true], ['document-parse', 'parse', '报告解析待核验', true],
      ['report-directory', 'directory', '报告目录待补齐', true], ['notice-risk', 'notices', '公告风险待核验', false],
      ['evidence-incomplete', 'evidence', '研究证据不足', true]
    ];
    result.id += '-diagnostic-view'; result.added = []; result.retained = []; result.removed = []; result.pending = []; result.held = []; result.skipped = [];
    result.unassignedPending = stages.map(([code, stage, label, attempted], index) => ({ symbol: 'sh' + (601800 + index), name: '隔离阶段样本 ' + (index + 1), strategyIds: ['swing'], reasons: ['隔离样本：' + label], diagnostics: { stage, code, label, stages: [{ stage, code, label }], researchAttempted: attempted, researchComplete: code === 'evidence-incomplete' } }));
    result.counts = { added: 0, retained: 0, removed: 0, pending: 0, held: 0, skipped: 0, unassignedPending: 7 };
    result.strategies = Object.fromEntries(Object.keys(result.strategies).map(id => [id, { pass: 0, failed: 23, pending: 7 }]));
    result.coverage.universeCount = 30;
    result.coverage.diagnostics = { uniqueCompanies: 30, eligibleCompanies: 0, failedCompanies: 23, pendingCompanies: 7, researchAttempted: 4, researchComplete: 1, researchNotStarted: 3, stages: Object.fromEntries(stages.map(([code,,label])=>[code,{label,count:1}]).concat([['research-not-started',{label:'尚未进入研究核验',count:3}]])) };
    result.coverage.quantitativeCandidates = 5; result.coverage.evidenceChecked = 4; result.coverage.evidenceSummary = { pass: 0, failed: 0, pending: 4, checks: {} };
    // Keep the render-only diagnostic fixture stable while ordinary IPC state
    // notifications arrive. The main process and isolated account are untouched.
    window.__poolDiagnosticRender = renderAgencyPool;
    renderAgencyPool = () => {
      const latest = state; state = view;
      try { window.__poolDiagnosticRender(); } finally { state = latest; }
    };
    renderState(view);
    const labels = [...document.querySelectorAll('.agency-pool-stage-tags')].map(node => node.textContent);
    return { actual, labels, unknown: agencyPoolItemStages({symbol:'sh600999',category:'unassignedPending',reasons:[]}), fallback: agencyPoolItemStages({category:'unassignedPending',reasons:['完整日线日期 2026-10-13 未覆盖最近完整交易日 2026-10-12','PDF 下载超时']}), historical: agencyPoolEvidenceSummaryHtml({policyVersion:2,coverage:{evidenceChecked:74,evidenceSummary:{pass:0,pending:74}}}) };
  });
  assert.equal(diagnosticRendering.labels.length, 7);
  assert.ok(diagnosticRendering.labels.some(value => /未进入研究/.test(value)));
  for (const label of ['完整日线不足','日线日期或价格基准异常','资料下载失败','报告解析待核验','报告目录待补齐','公告风险待核验','研究证据不足']) assert.ok(diagnosticRendering.labels.some(value=>value.includes(label)));
  assert.deepEqual(diagnosticRendering.unknown, [], 'absent historical fields do not manufacture a missing-data diagnosis');
  assert.deepEqual(diagnosticRendering.fallback.map(value=>value.label).sort(), ['下载失败','日线日期异常'].sort());
  assert.match(diagnosticRendering.historical, /资料收集完整（仍需内容核验） <b>未记录/);
  await capture('pool-diagnostic-stages');
  await page.evaluate(actual => { renderAgencyPool = window.__poolDiagnosticRender; delete window.__poolDiagnosticRender; renderState(actual); }, diagnosticRendering.actual);
  checks.push('stage counts and seven row labels distinguish daily, download, parse, directory, notice and research issues; historical absent fields are shown as unrecorded rather than zero or failures');
  scenario({ retryResolves: true });
  await page.locator('#agency-pool-retry').click(); await idle();
  assert.equal((await call('state')).agencyPool.lastResult.coverage.diagnostics.pendingCompanies, 0);
  assert.equal(await page.locator('#agency-pool-retry').isVisible(), false);
  assert.equal(await page.locator('#agency-pool-run').isEnabled(), true);
  checks.push('retry entry disappears when the latest completed result has no pending companies');
  assert.deepEqual(errors, []);
  assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8') : '', '');
  const report = { status: 'passed', output, checks, errors }; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
