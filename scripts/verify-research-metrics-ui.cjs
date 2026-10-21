// Isolated UI checks: source metrics are synthetic; no company eligibility claim.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/research-metrics-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json'), networkLog = path.join(output, 'network.jsonl'), callsPath = path.join(output, 'calls.jsonl');
const now = '2026-09-29T10:00:00+08:00', stamp = Date.parse(now), checks = [], errors = [], dimensions = [];
const injection = '<img src=x onerror="window.researchInjected=true"> & <script>bad</script>';
const source = { sourceTitle: '隔离产品半年报', source: '隔离公司财务', reportDate: '2026-06-30', publishedAt: '2026-08-20', fetchedAt: stamp,
  quote: `产品甲本期收入 200 元，上期收入 100 元。${injection}`, url: 'https://example.com/isolated-report', locations: [{ page: 25, method: 'pdf-text', lineStart: 11, lineEnd: 14 }] };
const cell = (value, unit, extra = {}) => ({ value, unit, status: 'available', usable: true, verification: 'source-verified', reason: '', sourceRefs: [source], ...extra });
const researchReview = { version: 1, symbol: 'sh600009', checkedAt: now,
  productMetrics: { version: 1, symbol: 'sh600009', checkedAt: now, reportDate: '2026-06-30', products: [{ subject: `产品甲 ${injection}`, reportDate: '2026-06-30', metrics: {
    currentRevenue: cell(200, '元', { rawValue: 0.02, rawUnit: '万元' }), revenueGrowthPct: cell(100, '%', { verification: 'calculated', formula: '(200 − 100) / 100 × 100' }),
    revenueSharePct: cell(50, '%', { verification: 'calculated' }), currentSalesVolume: cell(4.7, '百万桶'),
    salesGrowthPct: cell(null, '%', { status: 'not-extracted', usable: false, verification: null, reason: '已取得报告，但销量基期尚未可靠解析；不能据此认定未披露', reasonCode: 'not-extracted' }),
    grossMarginPct: cell(20, '%', { reportedValue: 30, status: 'conflict', verification: 'mismatch', usable: false, reason: '按原始收入成本计算为20%，与披露30%不一致' }), grossMarginChangePp: cell(null, '百分点', { status: 'not-extracted', usable: false, reason: '上年同期毛利率口径不足' }) } }] },
  companyMetrics: { version: 1, symbol: 'sh600009', checkedAt: now, reportDate: '2026-06-30', metrics: { revenueYoY: cell(12, '%', { verification: 'provider-reported' }), adjustedProfitYoY: cell(7, '%', { verification: 'provider-reported' }), latestAdjustedProfit: cell(3, '亿元', { verification: 'provider-reported' }), operatingCash: cell(4, '亿元', { verification: 'provider-reported' }) }, limitation: '公司整体指标不能代替产品指标' },
  acquisition: [{ code: 'parse-failed', label: '原文解析未完成', reason: '隔离附件销量比较表尚未解析', action: '重试缺失资料', retryable: true }],
  limitations: ['公司数据不补填产品缺项', '数值条件由用户设置，未经策略效果验证'] };
researchReview.productMetrics.products[0].observations = [{ subject: '产品甲', reportDate: '2026-06-30', unit: '万元', cells: ['0.02', '0.01'], columns: ['currentRevenue', 'previousRevenue'], fields: { currentRevenue: { rawValue: '0.02', rawUnit: '万元' }, previousRevenue: { rawValue: '0.01', rawUnit: '万元' } }, issues: [], sourceRef: { ...source, tableScope: { headings: [{ text: '管理层讨论与分析' }, { text: '主营产品情况' }] }, accountingScope: { text: '合并财务报表项目注释' } } }];
fs.writeFileSync(controlPath, JSON.stringify({ now, price: 10.17, financeMode: 'ready', valuationMode: 'ready', researchReview }));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog, GUANLAN_TEST_RESEARCH_CALLS: callsPath }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
const calls = () => fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function call(name, payload) { return page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload }); }
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/research-metrics-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  assert.equal(path.resolve((await call('state')).dataPath), path.resolve(accountPath));
  await page.locator('[data-page="agency"]').click();
}
async function poolRun() { await page.locator('#agency-pool-run').click(); await page.waitForFunction(() => !state.agencyPool.running && !agencyUi.busy.has('pool-run')); assert.equal(await page.locator('#agency-pool-error').innerText(), ''); }
async function inspectDone() { await page.waitForFunction(() => researchRulesUi.inspection && !researchRulesUi.inspection.busy); assert.equal(await page.locator('#research-metrics-error').innerText(), ''); }
async function addRule(rootId, field, value) {
  const editor = page.locator(`#${rootId}`); await editor.locator('[data-research-add]').click();
  await editor.locator('[data-research-edit="field"]').last().selectOption(field);
  await editor.locator('[data-research-edit="value"]').last().fill(String(value));
}
async function snapshot(name, selector) {
  for (const size of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows()[0].setSize(...dimensions), size);
    const target = page.locator(selector); await target.scrollIntoViewIfNeeded();
    if (selector === '#research-metrics-dialog') await target.evaluate(element => { element.scrollTop = 0; });
    dimensions.push({ name, requested: size, viewport: await page.evaluate(() => [innerWidth, innerHeight]) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await target.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await target.screenshot({ path: path.join(output, `${name}-${size[0]}.png`) });
  }
}
(async () => {
  await launch(); const before = await call('state');
  assert.ok((await call('screener:meta')).research.fields.product.currentRevenue);
  await page.locator('#agency-pool-mode').selectOption('product');
  assert.equal(await page.locator('#agency-research-controls [data-research-edit="enabled"]').inputValue(), 'observe');
  assert.equal(await page.locator('#agency-research-controls input').count(), 0);
  await page.locator('#agency-research-controls [data-research-edit="enabled"]').selectOption('filter');
  await page.locator('#agency-pool-run').click(); assert.match(await page.locator('#agency-pool-error').innerText(), /至少添加一项条件/);
  assert.equal(calls().filter(call => call.name === 'agency:pool:run').length, 0);
  await addRule('agency-research-controls', 'salesGrowthPct', 0);
  await addRule('agency-research-controls', 'currentSalesVolume', 1);
  await page.locator('#agency-pool-run').click(); assert.match(await page.locator('#agency-pool-error').innerText(), /精确单位/);
  await page.locator('#agency-research-controls [data-research-edit="unit"]').selectOption('百万桶');
  await poolRun();
  const first = (await call('state')).agencyPool.lastResult;
  assert.equal(first.research.path, 'product'); assert.equal(first.unassignedPending.length, 1);
  assert.equal(first.research.rules[1].unit, '百万桶');
  assert.equal(first.unassignedPending[0].researchReview.assessment.status, 'pending');
  await page.locator('#agency-pool-items > details > summary').click();
  await page.locator('#agency-pool-items [data-research-symbol]').click(); await inspectDone();
  const content = page.locator('#research-metrics-content');
  assert.equal(await content.locator('input,select,textarea,[contenteditable="true"]').count(), 0);
  assert.equal(await content.locator('img,script,a').count(), 0);
  assert.equal(await page.evaluate(() => !!window.researchInjected), false);
  for (const phrase of ['产品原始指标', '公司经营 · 独立替代路径', '原始值：0.02 万元', '按原始值计算', '计算值与披露值不一致', '披露值：30 %', '原文解析未完成', '销量基期尚未可靠解析', '未抓到、未解析或口径不能比较']) assert.ok((await content.innerText()).includes(phrase), phrase);
  await content.locator('[data-research-metric="currentRevenue"] details').first().locator('summary').click();
  assert.match(await content.innerText(), /第 25 页.*第 11—14 行/);
  assert.ok((await content.innerText()).includes(injection));
  await content.locator('.research-raw-observations > summary').click();
  assert.match(await content.innerText(), /原始单元格顺序：0.02 ｜ 0.01/);
  assert.match(await content.innerText(), /管理层讨论与分析 → 主营产品情况/);
  assert.doesNotMatch(await content.innerText(), /\[object Object\]/);
  await snapshot('product-raw-and-gaps', '#research-metrics-dialog');
  checks.push('Product path defaults to observation; missing thresholds cannot submit; explicit product rule stays pending for a missing base period; raw/derived values and gaps are read-only.');
  await page.locator('#research-inspect-rules [data-research-edit="path"]').selectOption('company');
  await addRule('research-inspect-rules', 'revenueYoY', 10);
  await page.locator('#research-metrics-evaluate').click(); await inspectDone();
  assert.match(await content.locator('[data-research-path="company"]').innerText(), /经营判断：条件通过/);
  assert.match(await content.locator('[data-research-path="product"]').innerText(), /未按产品条件判断/);
  assert.match(await content.innerText(), /不表示某一产品前景已通过/);
  await page.locator('#research-metrics-retry').click(); await inspectDone();
  assert.equal(calls().filter(item => item.name === 'research:inspect').at(-1).payload.force, true);
  await snapshot('company-alternative', '#research-metrics-dialog');
  await page.locator('#research-metrics-apply').click();
  assert.equal(await page.locator('#agency-pool-mode').inputValue(), 'company');
  await poolRun();
  const pooled = await call('state'), member = pooled.agency.groups.flatMap(group => group.members).find(member => member.symbol === 'sh600009');
  assert.equal(member.entryConditions.research.path, 'company'); assert.equal(member.entryConditions.research.rules[0].value, 10);
  await page.evaluate(() => openResearchMetrics('sz000001', 'agency')); await inspectDone();
  assert.equal(calls().filter(item => item.name === 'research:inspect').at(-1).payload.includeProducts, false);
  assert.match(await content.innerText(), /产品未知/); assert.match(await content.innerText(), /经营判断：条件通过/);
  await page.locator('#research-metrics-products').click(); await inspectDone();
  assert.equal(calls().filter(item => item.name === 'research:inspect').at(-1).payload.includeProducts, true);
  await page.locator('#research-metrics-close').click();
  checks.push('Company conditions pass independently while product evidence stays unknown; explicit product fetch and retries send the intended IPC arguments; adoption persists the new member snapshot.');
  await page.locator('[data-page="screener"]').click(); await page.waitForFunction(() => screenInitialized && !screenBusy);
  await page.locator('[data-evidence-condition="productOutlook"]').check();
  await page.locator('#screen-research-controls [data-research-edit="path"]').selectOption('company');
  await addRule('screen-research-controls', 'revenueYoY', 10);
  await page.locator('#screen-description').fill('需求增长有依据，股价大于1'); await page.locator('#screen-parse').click(); await page.waitForFunction(() => !screenBusy);
  const retained = await page.evaluate(() => ({ evidence: screenQuery.evidence, research: screenQuery.research }));
  assert.ok(retained.evidence.conditions.includes('productOutlook')); assert.ok(retained.evidence.conditions.includes('demand')); assert.equal(retained.research.rules[0].value, 10);
  await page.locator('#screen-reset').click();
  await page.locator('#screen-research-controls [data-research-edit="path"]').selectOption('company');
  await addRule('screen-research-controls', 'revenueYoY', 10); await page.locator('#screen-run').click(); await page.waitForFunction(() => !screenBusy);
  assert.equal(await page.locator('#screen-error').innerText(), '');
  assert.ok(await page.evaluate(() => screenResult.researchScreen.passed > 0));
  const selectedConditions = await page.evaluate(() => screenEntryConditions()); assert.equal(selectedConditions.research.rules[0].value, 10);
  await page.locator('#screen-research-controls [data-research-edit="value"]').fill('100');
  await page.locator('#screen-run').click(); await page.waitForFunction(() => !screenBusy);
  assert.ok(await page.evaluate(() => screenResult.researchFailedRows.length > 0));
  assert.match(await page.locator('#screen-research-results').innerText(), /经营研究条件不符/);
  await snapshot('screener-rules', '.screen-condition-card');
  checks.push('Text parsing preserves legacy productOutlook and new research rules; screener compares company metrics and separates failed rows; added entry conditions retain the exact research snapshot.');
  await desktop.close(); desktop = null; await launch();
  const restored = (await call('state')).agency.groups.flatMap(group => group.members).find(member => member.symbol === 'sh600009');
  assert.equal(restored.entryConditions.research.rules[0].value, 10);
  const after = await call('state'); assert.deepEqual(after.account.trades, before.account.trades); assert.deepEqual(after.account.risks, before.account.risks);
  assert.deepEqual(after.agency.groups.map(group => group.mode), before.agency.groups.map(group => group.mode));
  assert.deepEqual(errors, []); assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8') : '', '');
  checks.push('Restart preserves research snapshots; HTML remains text; both window sizes fit; no external requests, trades or strategy-mode changes.');
  const report = { status: 'passed', scope: 'Isolated UI/IPC and persistence checks using synthetic product metrics; actual company screener fixture data; no real-company eligibility conclusion.', output, dimensions, checks, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
