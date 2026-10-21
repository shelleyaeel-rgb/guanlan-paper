// Isolated Electron IPC/pool integration and renderer diagnostics. No real account
// is opened and the shared fixture rejects every unexpected network request.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-notice-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'unexpected-network.jsonl'), checks = [], errors = [];
const stamp = Date.parse('2026-09-29T10:00:00+08:00');
const quote = '预计归母净利润 100 至 120 万元；<img src=x onerror="window.noticeInjected=true"> & 未审计';
const notice = { id: 'AN202609290000000001', title: '隔离前三季度业绩预告 <测试>', date: '2026-09-29', status: 'unverified',
  fulltextStatus: 'verified', reason: '缺少扣非净利润上年同期值，尚不能核验同比口径',
  factReview: { type: 'forecast', label: '业绩预告', status: 'incomplete', data: { basis: 'forecast', basisLabel: '业绩预测，尚非实际业绩' },
    checks: [{ key: 'period', label: '报告期间', status: 'verified', value: '2026 年前三季度', reason: '完整期间已核验' },
      { key: 'recurringProfit', label: '扣非净利润', status: 'missing', reason: '上年同期值尚未确认' }],
    verifiedFields: ['period'], missingFields: ['recurringProfit'], eligibility: { status: 'pending', reason: '事实字段不完整，保持待核验' } },
  records: [{ sourceTitle: '隔离公告原文', publishedAt: '2026-09-29', quote, locations: [{ page: 1, method: 'provider-text' }],
    url: 'https://example.com/notices/AN202609290000000001?test=<script>' }] };
const clearNotice = structuredClone(notice);
Object.assign(clearNotice, { id: 'AN202609290000000002', title: '隔离业绩预告完整样本', status: 'clear', reason: '当前限定公告事实及准入口径核验通过' });
Object.assign(clearNotice.factReview, { status: 'verified', missingFields: [], checks: [{ key: 'period', label: '报告期间', status: 'verified', value: '2026 年前三季度' }], eligibility: { status: 'pass', reason: '通过限定公告准入口径' } });
const review = { status: 'unverified', checkedAt: stamp, mode: 'automatic-fulltext', notices: [notice, clearNotice,
  { id: 'AN202609290000000003', date: '2026-09-29', title: '隔离未取得原文公告', status: 'unverified', reason: '公告 PDF 下载超时', records: [] },
  { id: 'AN202609290000000004', date: '2026-09-29', title: '隔离不支持类型', status: 'unverified', reason: '尚未支持自动判断', records: [], factReview: { type: 'unsupported', label: '其他敏感公告', status: 'unsupported', checks: [], missingFields: [] } }], reasons: ['敏感公告仍有事实字段待核验'] };
const control = { now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready',
  poolDelay: 3000, poolOnlySwing: true, poolSymbols: ['sh600009', 'sh600010'], noticeReview: review };
fs.writeFileSync(controlPath, JSON.stringify(control));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
async function call(name, payload) {
  return page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload });
}
async function capture(name, selector) {
  for (const size of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(...value), size);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} viewport overflow at ${size[0]}`);
    const target = page.locator(selector);
    assert.equal(await target.evaluate(element => element.scrollWidth <= element.clientWidth), true, `${name} content overflow at ${size[0]}`);
    await target.screenshot({ path: path.join(output, `${name}-${size[0]}.png`) });
  }
}
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/agency-pool-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  const before = await call('state');
  assert.equal(path.resolve(before.dataPath), path.resolve(accountPath));
  await page.locator('[data-page="agency"]').click();
  assert.equal(await page.locator('#agency-pool-mode').inputValue(), 'strategy');
  await page.locator('#agency-pool-run').click();
  await page.waitForFunction(() => state.agencyPool.progress.stage === 'noticeEvidence');
  const progress = await page.locator('#agency-pool-progress-label').innerText();
  assert.match(progress, /按需读取敏感公告原文并核验.*隔离敏感公告 <样本>.*下载原始附件/);
  assert.equal(await page.locator('#agency-pool-progress-label img').count(), 0);
  checks.push('targeted notice progress shows company/detail and escapes markup');
  await page.waitForFunction(() => !state.agencyPool.running && !agencyUi.busy.has('pool-run'));
  const current = await call('state');
  assert.deepEqual(current.agencyPool.lastResult.unassignedPending[0].noticeReview, review);
  const summary = await page.locator('#agency-pool-evidence-summary').innerText();
  assert.match(summary, /尝试读取原文 1 家/); assert.match(summary, /不计作这三类研究完成/);
  assert.doesNotMatch(summary, /资料收集完整|核验通过\s+\d+ 家|研究资料核验与缺项/);
  await page.locator('#agency-pool-filter').selectOption('unassignedPending');
  await page.locator('#agency-pool-items > details > summary').click();
  await page.locator('#agency-pool-items .agency-notice-review > summary').click();
  await page.locator('#agency-pool-items .agency-notice-facts > summary').first().click();
  await page.locator('#agency-pool-items .agency-notice-excerpts > summary').first().click();
  const body = await page.locator('#agency-pool-items .agency-notice-review').innerText();
  for (const phrase of ['业绩预测，尚非实际业绩', '缺失事实字段：扣非净利润', '扣非净利润 · 待核验', '报告期间 · 已核验',
    '隔离业绩预告完整样本 · 核验通过', '公告 PDF 下载超时', '本公告尚无可展示的原文摘录', '第 1 页 · 公告正文', quote,
    '尚无可核验的结构化事实字段']) assert.ok(body.includes(phrase), phrase);
  assert.equal(await page.locator('#agency-pool-items .agency-notice-review img, #agency-pool-items .agency-notice-review script, #agency-pool-items .agency-notice-review a').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.noticeInjected)), false);
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await capture('notice-pool', '#agency-pool-card');
  checks.push('pool IPC persists per-notice results; expanded details separate forecast nature, fact gaps, admission, failures and safe source excerpts');
  const decision = { id: 'isolated-notice-decision', strategyId: 'swing', symbol: 'sh600009', status: 'waiting', action: 'wait',
    createdAt: stamp, decisionMode: 'rules', reason: '公告事实待核验', evidence: [{ sourceId: 'notice-body', detail: '敏感公告原文用于本轮风险检查' }],
    inputSources: [{ id: 'notice-body', kind: 'automaticEvidence', source: '敏感公告原文核验', fetchedAt: stamp, data: { evaluation: { noticeReview: review } } }] };
  await page.evaluate(decision => {
    // This diagnostic view never changes the service or persisted account.
    window.__noticeDecisionRenderer = agencyDecisionsHtml;
    agencyDecisionsHtml = group => {
      const actual = state.agency.decisions; state.agency.decisions = [decision];
      try { return window.__noticeDecisionRenderer(group); } finally { state.agency.decisions = actual; }
    };
    renderAgency();
  }, decision);
  await page.locator('#agency-decisions .agency-decision > details > summary').click();
  await page.locator('#agency-decisions .agency-notice-review > summary').click();
  await page.locator('#agency-decisions .agency-notice-excerpts > summary').first().click();
  assert.match(await page.locator('#agency-decisions').innerText(), /敏感公告原文核验.*来源编号：notice-body/s);
  assert.ok((await page.locator('#agency-decisions').innerText()).includes(quote));
  assert.equal(await page.locator('#agency-decisions .agency-notice-review').count(), 1);
  assert.equal(await page.locator('#agency-decisions img, #agency-decisions script').count(), 0);
  await capture('notice-decision', '#agency-decisions');
  const fallback = await page.evaluate(decision => {
    const direct = agencyEvidenceHtml({ ...decision, evidence: [] });
    const execution = agencyEvidenceHtml({ ...decision, executionCheck: { checkedAt: decision.createdAt, inputSources: decision.inputSources, evidence: [] } });
    const history = agencyPoolEvidenceSummaryHtml({ screeningMode: 'strategy', coverage: { researchRequired: false } });
    const holder = document.createElement('div'); holder.innerHTML = direct + execution;
    return { count: holder.querySelectorAll('.agency-notice-review').length, execution, history };
  }, decision);
  assert.equal(fallback.count, 2); assert.match(fallback.execution, /执行前复核依据/); assert.match(fallback.history, /尝试读取原文 未记录/);
  checks.push('member decisions render automaticEvidence details once, including execution-check and evidence-empty cases; absent historical counters remain unrecorded');
  const { reviewCorporateAction } = require('../core/company-notice-corporate-actions.cjs');
  const corporate = require('../tests/fixtures/notice-corporate-actions.json').documents;
  const factChecks = [
    reviewCorporateAction(corporate.find(item => item.name === '海顺新材').document, corporate.find(item => item.name === '海顺新材').notice).checks.find(check => check.key === 'transactions'),
    reviewCorporateAction(corporate.find(item => item.notice.id.endsWith('9762')).document, corporate.find(item => item.notice.id.endsWith('9762')).notice).checks.find(check => check.key === 'releases'),
    { key: 'stage', label: '本次解除限售阶段', status: 'verified', value: 'listing-scheduled' },
    { key: 'listingDate', label: '已披露的上市流通安排日期', status: 'verified', value: '2026-10-14' },
    { key: 'netProfit', label: '不可比利润金额', status: 'missing', amountStatus: 'verified', comparisonStatus: 'not-comparable',
      value: { current: { min: 100, max: 120 }, previous: 60, growthPct: { min: 66.67, max: 100 }, unit: '万元' } },
    { key: 'recurringProfit', label: '尚不可使用的原始金额', status: 'missing', amountStatus: 'verified', amountUsable: false,
      value: { current: { min: 50, max: 60 }, previous: 40, growthPct: { min: 25, max: 50 }, unit: '万元' } },
    { key: 'phase', label: '临床申请受理', status: 'verified', value: 'application-accepted' },
    { key: 'phase', label: '临床试验批准', status: 'verified', value: 'clinical-trial-approved' },
    { key: 'endpoint', label: '主要终点', status: 'verified', value: 'achieved' },
    { key: 'funded', label: '实际出资', status: 'verified', value: 0 },
    { key: 'term', label: '承诺期间', status: 'verified', value: { start: '2026-10-01', end: '2027-09-30' } },
  ];
  const displayValues = await page.evaluate(factChecks => {
    const panel = document.createElement('section'); panel.id = 'isolated-notice-facts'; panel.className = 'card';
    panel.innerHTML = agencyNoticeReviewHtml({ status: 'unverified', mode: 'automatic-fulltext', notices: [{
      title: '隔离事实展示验证', status: 'unverified', factReview: { label: '股份与金额事实展示', status: 'incomplete',
        checks: factChecks, missingFields: ['netProfit', 'recurringProfit'] }, records: [] }] });
    document.querySelector('#agency-pool-card').append(panel); panel.querySelectorAll('details').forEach(item => item.open = true);
    return factChecks.map(noticeFactValueText);
  }, factChecks);
  assert.match(displayValues[0], /股东 李俊.*披露计划内减持 271,560 股.*其他来源 60,500 股.*全部来源合计 332,060 股.*披露计划口径.*减持期间/s);
  assert.match(displayValues[0], /2026-\d\d-\d\d 至 2026-\d\d-\d\d/);
  assert.match(displayValues[1], /计划 .*411,795 股.*计划 .*475,080 股/s);
  assert.equal(displayValues[2], '已披露上市流通安排');
  assert.equal(displayValues[3], '2026-10-14');
  assert.match(displayValues[4], /原始金额已核验.*本期与上期不可比，不代算同比.*仅保留披露值/);
  assert.match(displayValues[5], /原始金额当前不可用于条件判断/);
  assert.deepEqual(displayValues.slice(6), ['申请已受理', '获准开展临床试验', '达到主要终点', '尚未出资', '2026-10-01 至 2027-09-30']);
  assert.doesNotMatch(displayValues.join(''), /\[object Object\]|"records"|"quantityShares"|"sourceKind"/);
  await capture('notice-fact-values', '#isolated-notice-facts');
  await page.locator('#isolated-notice-facts').evaluate(element => element.remove());
  checks.push('shareholder/plan/source/date quantities render as readable facts; incomparable profit retains disclosed amounts without implying usable growth, and unusable amounts are explicit');
  await page.evaluate(() => { agencyDecisionsHtml = window.__noticeDecisionRenderer; delete window.__noticeDecisionRenderer; renderAgency(); });
  const after = await call('state');
  assert.deepEqual(after.account.trades, before.account.trades);
  assert.deepEqual(after.account.risks, before.account.risks);
  assert.deepEqual(after.agency.groups.map(group => group.mode), before.agency.groups.map(group => group.mode));
  assert.deepEqual(errors, []);
  assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8') : '', '');
  checks.push('1120px and 1536px windows have no viewport/content overflow; no trades, mode changes or external requests');
  const report = { status: 'passed', output, checks, errors }; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
