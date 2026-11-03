// Isolated Electron product evidence UI checks. Research results are deterministic
// fixtures; this checks display/persistence, not real company eligibility.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function revealPoolControl(selector) {
  await page.locator(selector).evaluate(element => { for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
}
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-product-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json'), networkLog = path.join(output, 'unexpected-network.jsonl');
const stamp = Date.parse('2026-09-29T10:00:00+08:00'), checks = [], errors = [], dimensions = [];
const injection = '<img src=x onerror="window.productInjected=true"> & <script>test</script>';
const record = (subject, quote, extra = {}) => ({ sourceTitle: '隔离半年报原文', publishedAt: '2026-08-20', period: '2026 半年度', subject,
  sourceRelation: 'issuer-disclosure', quote, locations: [{ page: 3, method: 'pdf-text', lineStart: 12, lineEnd: 15 }], url: `https://example.com/product?value=${injection}`, ...extra });
const part = (key, status, reason, records = [], extra = {}) => ({ key, status, reason, records, ...extra });
const productReview = { mode: 'automatic', status: 'pending', checkedAt: stamp, collection: { complete: true, indexComplete: true, annualReport: 'ready', semiannualReport: 'ready', issues: [] }, checks: [{
  key: 'productOutlook', label: '产品前景', status: 'pending', reason: '产品甲尚缺行业比较和风险披露覆盖，产品乙存在明确销量下滑；不跨产品合并通过',
  productIdentification: { status: 'identified', count: 2, reason: '最新完整报告可靠识别两个产品' }, records: [], productCandidates: [
    { subject: '产品甲 <隔离样本>', status: 'pending', parts: [
      part('demand', 'pass', '同产品当期销量及上期值支持增长', [record('产品甲', `产品甲本期销量 120 台，上年同期 100 台；${injection}`)]),
      part('commercialization', 'pass', '本期形成产品收入', [record('产品甲', '产品甲本期营业收入 300 万元。')]),
      part('advantage', 'pending', '尚缺同产品可追溯的行业排名或同期间同口径量化比较'),
      part('outlookRisk', 'pending', '风险章节资料不完整，后续公告覆盖不足') ] },
    { subject: '产品乙', status: 'fail', parts: [
      part('demand', 'fail', '明确披露产品销量同比下降', [record('产品乙', '产品乙销量同比下降 10%。')]),
      part('commercialization', 'pass', '本期已形成产品收入', [record('产品乙', '产品乙实现销售收入 200 万元。')]),
      part('advantage', 'pass', '具名第三方给出同期间、同口径量化比较', [record('产品乙', '隔离研究机构披露产品乙效率 95%，同口径基准 90%。', {
        sourceRelation: 'issuer-cites-third-party', metric: '转换效率', comparisonPeriod: '2026 半年度', comparisonScope: '同工况、同测试方法', comparator: '隔离研究机构行业样本', ownValue: 95, benchmarkValue: 90, unit: '%', citedSource: '隔离检测研究所', citedReport: '2026 产品效率比较报告' })]),
      part('outlookRisk', 'pass', '限定披露材料复核未形成重大相反事实', [record('产品乙', '报告风险章节披露原材料与汇率风险。', { section: '可能面对的风险', excerptTruncated: true, sectionLocations: [{ page: 3, method: 'pdf-text', lineStart: 1, lineEnd: 40 }, { page: 4, method: 'pdf-text', lineStart: 1, lineEnd: 20 }] })], {
        basis: 'disclosure-scope-review', limitedScope: '仅覆盖已取得报告的完整风险章节及期间内相关公告，不代表不存在其他风险',
        scope: { reportId: 'isolated-report-2026H1', reportDate: '2026-06-30', fromDate: '2026-08-20', toDate: '2026-09-29', noticeSelection: 'risk-and-business-keywords' } }) ] }
  ] }] };
const settings = { now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', productReview };
const scenario = patch => { Object.assign(settings, patch); fs.writeFileSync(controlPath, JSON.stringify(settings)); };
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
async function call(name, payload) { return page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload }); }
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/agency-product-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  assert.equal(path.resolve((await call('state')).dataPath), path.resolve(accountPath));
  await page.locator('[data-page="agency"]').click();
}
async function run() {
  await revealPoolControl('#agency-pool-legacy'); await page.locator('#agency-pool-legacy').check(); await page.locator('#agency-pool-run').click();
  await page.waitForFunction(() => !state.agencyPool.running && !agencyUi.busy.has('pool-run'));
  await page.locator('#agency-pool-filter').selectOption('unassignedPending');
  await page.locator('#agency-pool-items > details > summary').click();
  await page.locator('#agency-pool-items .agency-pool-evidence-detail > summary').click();
}
async function snapshot(name, selector) {
  await page.locator('#toast').waitFor({ state: 'hidden' });
  for (const size of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(...value), size);
    dimensions.push({ name, requested: size, viewport: await page.evaluate(() => [innerWidth, innerHeight]) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const target = page.locator(selector); assert.equal(await target.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await target.screenshot({ path: path.join(output, `${name}-${size[0]}.png`) });
  }
}
(async () => {
  scenario({}); await launch(); const before = await call('state'); await run();
  const result = (await call('state')).agencyPool.lastResult;
  assert.deepEqual(result.unassignedPending[0].evidenceReview.checks[0].productCandidates, productReview.checks[0].productCandidates);
  const candidates = page.locator('#agency-pool-items .agency-product-candidate'); assert.equal(await candidates.count(), 2);
  await candidates.nth(0).locator(':scope > summary').click(); await candidates.nth(1).locator(':scope > summary').click();
  assert.equal(await page.locator('#agency-pool-items .agency-product-part').count(), 8);
  assert.equal(await candidates.nth(0).locator('[data-product-status="pending"]').count(), 2);
  assert.equal(await candidates.nth(1).locator('[data-product-part="demand"][data-product-status="fail"]').count(), 1);
  await candidates.nth(0).locator('[data-product-part="demand"] summary').click();
  await candidates.nth(1).locator('[data-product-part="advantage"] summary').click();
  await candidates.nth(1).locator('[data-product-part="outlookRisk"] summary').click();
  const visible = await page.locator('#agency-pool-items').innerText();
  for (const phrase of ['不代表未来增长或收益预测', '行业比较证据缺项', '风险披露覆盖不足', '需求事实 · 不符', injection,
    '第 12—15 行', '比较期间 2026 半年度', '比较口径 同工况、同测试方法', '产品指标 95%', '比较基准 90%', '未独立取得第三方全文',
    '范围限制：仅覆盖', '公告覆盖 2026-08-20 至 2026-09-29', '完整披露章节位置（可能面对的风险）', '第 1—40 行', '以下仅展示部分原文摘录',
    '风险及经营关键词匹配的相关公告', '引用机构 隔离检测研究所', '引用报告 2026 产品效率比较报告']) assert.ok(visible.includes(phrase), phrase);
  const stages = await page.locator('#agency-pool-items .agency-pool-stage-tags').innerText();
  for (const phrase of ['产品竞争优势比较待核验', '产品风险披露待核验']) assert.ok(stages.includes(phrase), phrase);
  assert.equal(await page.locator('#agency-pool-items img, #agency-pool-items script, #agency-pool-items a').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.productInjected)), false);
  await page.locator('#agency-pool-items').evaluate(element => { element.scrollTop = 0; });
  await snapshot('product-detail', '#agency-pool-card');
  await candidates.nth(1).locator('[data-product-part="outlookRisk"]').scrollIntoViewIfNeeded();
  await snapshot('product-risk-scope', '#agency-pool-items');
  checks.push('real pool IPC persists two products and eight independently attributed part statuses/excerpts; demand failure is not replaced by another product pass');
  checks.push('comparison period, scope, own/benchmark values and issuer-citation relationship are explicit; risk basis, date range, limitations and full-section locations are displayed');
  await desktop.close(); desktop = null; await launch();
  assert.deepEqual((await call('state')).agencyPool.lastResult.unassignedPending[0].evidenceReview.checks[0].productCandidates, productReview.checks[0].productCandidates);
  const unidentified = structuredClone(productReview); Object.assign(unidentified.checks[0], { reason: '最新完整报告未可靠识别同一产品', productCandidates: [], productIdentification: { status: 'unidentified', count: 0, reason: '产品名称与报告主体尚无法可靠绑定' } });
  scenario({ productReview: unidentified }); await run();
  assert.match(await page.locator('#agency-pool-items').innerText(), /未可靠识别产品.*产品名称与报告主体尚无法可靠绑定/s);
  assert.match(await page.locator('#agency-pool-items .agency-pool-stage-tags').innerText(), /产品尚未可靠识别/);
  assert.equal(await page.locator('#agency-pool-items .agency-product-part').count(), 0);
  const demandMissing = structuredClone(productReview); Object.assign(demandMissing.checks[0].productCandidates[0].parts[0], { status: 'pending', reason: '未找到对应产品可独立核实的需求事实', records: [] });
  Object.assign(demandMissing.checks[0].productCandidates[0].parts[1], { status: 'pending', reason: '缺少明确已发生收入或量产事实', records: [] });
  scenario({ productReview: demandMissing }); await run();
  await page.locator('#agency-pool-items .agency-product-candidate').first().locator(':scope > summary').click();
  assert.match(await page.locator('#agency-pool-items').innerText(), /未找到可核验的需求事实/);
  for (const phrase of ['产品需求事实待补齐', '产品商业化事实待补齐']) assert.ok((await page.locator('#agency-pool-items .agency-pool-stage-tags').innerText()).includes(phrase));
  checks.push('explicit unidentified products, demand gaps, commercialization gaps, comparison gaps and risk coverage gaps have distinct diagnostics; restart restores per-part evidence');
  const compatibility = await page.evaluate(review => {
    const historicalCheck = structuredClone(review.checks[0]); delete historicalCheck.productCandidates; delete historicalCheck.productIdentification;
    const partial = structuredClone(review.checks[0]); partial.productCandidates[0].parts = [{ key: 'demand', status: 'pass', reason: '历史结论' }];
    const source = { id: 'product-source', kind: 'automaticEvidence', source: '已披露经营证据核验', data: { evaluation: review } };
    return { historical: agencyProductEvidenceHtml(historicalCheck), partial: agencyProductEvidenceHtml(partial),
      summary: agencyPoolEvidenceSummaryHtml({ policyVersion: 2, coverage: { evidenceChecked: 1, evidenceSummary: { pending: 1, checks: {} } } }),
      decision: agencyEvidenceHtml({ decisionMode: 'rules', executionCheck: { evidence: [], inputSources: [source] } }) };
  }, productReview);
  assert.match(compatibility.historical, /历史结果未保存逐产品明细/); assert.doesNotMatch(compatibility.historical, /未可靠识别产品/);
  assert.match(compatibility.partial, /商业化事实 · 未记录/); assert.match(compatibility.partial, /历史结果未保存本项原文摘录/);
  assert.match(compatibility.summary, /历史结果，不等于当前默认策略监控的开仓门槛/);
  assert.match(compatibility.decision, /执行前复核依据/); assert.match(compatibility.decision, /agency-product-candidate/);
  checks.push('old policy 2 results are labeled historical rather than current monitoring gates; absent product/part fields remain unrecorded; execution-check source supports product detail');
  const after = await call('state'); assert.deepEqual(after.account.trades, before.account.trades); assert.deepEqual(after.account.risks, before.account.risks);
  assert.deepEqual(after.agency.groups.map(group => group.mode), before.agency.groups.map(group => group.mode));
  assert.deepEqual(errors, []); assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8') : '', '');
  checks.push('HTML injection remains plain text; no external requests, trades or mode changes; both requested window sizes fit without horizontal overflow');
  const report = { status: 'passed', scope: 'Synthetic research UI and IPC fixtures; not real company eligibility', output, dimensions, checks, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
