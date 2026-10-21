// F10/F11: real Electron renderer and IPC, fixture-only market data, isolated account.
'use strict';
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/screen-audit-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'network.jsonl'), ipcLog = path.join(output, 'ipc.jsonl');
const fixturePath = path.join(output, 'desktop.cjs');
fs.writeFileSync(controlPath, JSON.stringify({ now: '2026-09-30T10:00:00+08:00', price: 10.08, dailyMode: 'ready', financeMode: 'ready' }));
fs.writeFileSync(fixturePath, `
const fs = require('node:fs');
const { ipcMain } = require('electron');
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, listener) => handle(name, async (event, payload) => {
  if (['screener:parse', 'screener:run'].includes(name)) fs.appendFileSync(${JSON.stringify(ipcLog)}, JSON.stringify({ name, payload }) + '\\n');
  return listener(event, payload);
});
require(${JSON.stringify(path.join(root, 'tests/fixtures/screener-agency-desktop.cjs'))});
const { Market } = require(${JSON.stringify(path.join(root, 'core/market.cjs'))});
Market.prototype.indexHistory = async function(symbol) { return { symbol, bars: await this.strategyHistory('sh600002'), source: '隔离指数日线', fetchedAt: Date.now(), adjustment: '未复权' }; };
const { CorporateSource } = require(${JSON.stringify(path.join(root, 'core/corporate-source.cjs'))});
CorporateSource.prototype.get = async function(input) { return { symbol: input.symbol, source: '隔离公司行为样本', status: 'ready', fetchedAt: Date.now(), coverageStart: input.fromDate, coverageEnd: '2026-09-30', coverageComplete: true, events: [], notices: [] }; };
`);
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog }; delete env.ELECTRON_RUN_AS_NODE;
const entries = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
let desktop, page; const errors = [], checks = [], screenshots = [], dimensions = [];
async function call(name, payload) { return page.evaluate(async ({ name, payload }) => { const response = await window.guanlan.call(name, payload); if (!response.ok) throw Error(response.error); return response.data; }, { name, payload }); }
async function idle() { await page.waitForFunction(() => typeof screenInitialized !== 'undefined' && screenInitialized && !screenBusy); }
async function run() { await page.locator('#screen-run').click(); await idle(); assert.equal(await page.locator('#screen-error').isVisible(), false); }
async function textRun(text) { await page.locator('#screen-description').fill(text); await page.locator('#screen-parse').click(); await idle(); }
async function capture(name, selector) {
  await page.locator('#toast').waitFor({ state: 'hidden' });
  for (const [width, height] of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    const target = page.locator(selector); await target.scrollIntoViewIfNeeded();
    dimensions.push({ name, requested: [width, height], viewport: await page.evaluate(() => [innerWidth, innerHeight]), devicePixelRatio: await page.evaluate(() => devicePixelRatio) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: document fits ${width}`);
    assert.equal(await target.evaluate(element => element.scrollWidth <= element.clientWidth), true, `${name}: content fits ${width}`);
    const file = path.join(output, `${name}-${width}.png`); await target.screenshot({ path: file }); screenshots.push(file);
  }
}
const record = symbol => ({ symbol, subject: '隔离测试产品', reviewState: 'confirmed', sourceTitle: '隔离测试统计', url: 'https://example.com/fixture', publishedAt: '2026-08-01', period: '2025年度', reviewedAt: '2026-09-20', validUntil: '2026-12-31', quote: '隔离样本：2025年中国市场销售额排名，覆盖全部竞争者。' });
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [fixturePath, `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  assert.equal(path.resolve((await call('state')).dataPath), path.resolve(accountPath));
  const accountBefore = await call('state');
  await page.locator('[data-page="settings"]').click();
  assert.match(await page.locator('.investment-library').innerText(), /策略模板行及其阈值修改仅用于本次筛选/);
  assert.doesNotMatch(await page.locator('.investment-library').innerText(), /个人条件及修改后的实际阈值一并保存/);
  await capture('template-explanation', '.investment-library');
  await page.locator('[data-page="screener"]').click(); await idle();
  for (const symbol of ['sh600002', 'sh600003', 'sh600004']) {
    await call('evidence:save', { ...record(symbol), kind: 'demand', value: 'supported' });
    await call('evidence:save', { ...record(symbol), kind: 'mainRank', value: 'ranked', rank: 2, market: '隔离测试产品市场', geography: '中国', metric: 'sales', statisticYear: 2025, coverage: 'allCompetitors' });
  }
  await page.locator('#screen-strategy').selectOption('long');
  assert.match(await page.locator('#screen-personal-rule-note').innerText(), /阈值修改只影响本次筛选/);
  assert.match(await page.locator('#screen-strategy-info').innerText(), /模板行的阈值修改仅用于本次筛选/);
  await page.locator('#screen-rules [data-field="annualRoeLatest"] [data-part="value"]').fill('10');
  await page.locator('#screen-exclude-st').check();
  await page.locator('[data-evidence-condition="demand"]').check();
  await textRun('市盈率小于20');
  assert.equal(await page.locator('#screen-error').isVisible(), false);
  const selection = await page.evaluate(() => structuredClone(screenResult));
  assert.deepEqual(selection.rows.map(row => row.symbol).sort(), ['sh600002', 'sh600003', 'sh600004']);
  assert.ok(selection.query.rules.some(rule => rule.field === 'annualRoeLatest' && rule.value === 10));
  assert.deepEqual(selection.personalRules, [{ field: 'pe', op: 'lt', value: 20 }]);
  await capture('personal-condition-explanation', '#screen-personal-rule-note');
  await page.locator('[data-screen-agency="sh600002"]').click();
  const confirmation = await page.locator('#agency-assign-conditions').innerText();
  assert.doesNotMatch(confirmation, /年度 ROE|10%|10 %/); assert.match(confirmation, /20/);
  await capture('saved-conditions-confirmation', '#agency-assign-dialog');
  await page.locator('#agency-assign-submit').click(); await page.waitForFunction(() => !document.querySelector('#agency-assign-dialog').open);
  const saved = (await call('state')).agency.groups.flatMap(group => group.members).find(member => member.symbol === 'sh600002').entryConditions;
  assert.deepEqual(saved.rules, selection.personalRules); assert.equal(saved.excludeST, true); assert.deepEqual(saved.evidence, selection.query.evidence);
  checks.push('F10: revised template and editor wording matches real confirmation and persisted member conditions; modified annual ROE is screening-only, added PE/ST/evidence persist.');

  await page.locator('[data-page="screener"]').click(); await idle();
  await page.locator('#screen-reset').click(); await textRun('股价大于1');
  const industryEditor = page.locator('#screen-industry-controls');
  await industryEditor.locator('[data-industry-edit="mode"]').selectOption('filter');
  await industryEditor.locator('[data-industry-edit="scope"]').selectOption('main');
  await industryEditor.locator('[data-industry-edit="mainRankMax"]').fill('3');
  await page.locator('[data-evidence-condition="demand"]').check(); await run();
  const before = await page.evaluate(() => structuredClone({ query: screenQuery, personal: screenPersonalRules, strategy: screenStrategyRules, result: screenResult }));
  assert.deepEqual(before.result.rows.map(row => row.symbol).sort(), ['sh600002', 'sh600003', 'sh600004']);
  const runsBefore = entries(ipcLog).filter(entry => entry.name === 'screener:run').length;
  await textRun('主行业前三，市盈率小于20');
  assert.deepEqual(await page.evaluate(() => structuredClone({ query: screenQuery, personal: screenPersonalRules, strategy: screenStrategyRules, result: screenResult })), before);
  assert.equal(await page.locator('#screen-description').inputValue(), '主行业前三，市盈率小于20');
  assert.match(await page.locator('#screen-error').innerText(), /行业.*不能隐式合并/);
  assert.match(await page.locator('#screen-result-count').innerText(), /上次结果，文字未应用/);
  assert.equal(await page.locator('#screen-run').isDisabled(), true);
  assert.equal(entries(ipcLog).filter(entry => entry.name === 'screener:run').length, runsBefore);
  await capture('industry-conflict-input', '.screen-intro');
  await capture('industry-conflict-result', '.screen-results-card');
  await page.locator('#screen-description').fill(''); await run();
  assert.deepEqual(await page.evaluate(() => screenResult.rows.map(row => row.symbol).sort()), ['sh600002', 'sh600003', 'sh600004']);
  assert.deepEqual(await page.evaluate(() => structuredClone(screenQuery)), before.query);
  checks.push('F11: conflicting custom industry text causes no screening IPC, preserves query/rule ownership/results/input, and original query remains runnable after clearing text.');

  await industryEditor.locator('[data-industry-edit="mode"]').selectOption('observe');
  await textRun('主行业前三，市盈率小于20');
  assert.equal(await page.locator('#screen-error').isVisible(), false);
  assert.equal(await page.locator('#screen-description').inputValue(), '');
  assert.deepEqual(await page.evaluate(() => screenQuery.rules), [{ field: 'pe', op: 'lt', value: 20 }]);
  assert.equal(await page.evaluate(() => screenQuery.evidence.leadership), 'mainTop3');
  assert.equal(await page.evaluate(() => screenQuery.evidence.industry), undefined);
  assert.deepEqual(await page.evaluate(() => screenQuery.evidence.conditions), ['demand']);
  assert.deepEqual(await page.evaluate(() => screenResult.rows.map(row => row.symbol).sort()), ['sh600002', 'sh600003', 'sh600004']);
  await capture('industry-explicit-retry', '.screen-intro');
  checks.push('F11: explicit removal of numeric industry mode permits retry; PE replaces prior numeric condition while demand evidence survives and the real screener returns matching rows.');
  const accountAfter = await call('state');
  assert.deepEqual(accountAfter.account.trades, accountBefore.account.trades);
  assert.deepEqual(accountAfter.agency.groups.map(group => group.mode), accountBefore.agency.groups.map(group => group.mode));
  assert.deepEqual(errors, []); assert.deepEqual(entries(networkLog), []);
  const report = { status: 'passed', output, accountPath, checks, errors, unexpectedNetworkRequests: entries(networkLog).length, screenshots, dimensions };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
  console.error(error); console.error('Output:', output);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
