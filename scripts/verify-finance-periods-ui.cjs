// Real financial gates and statement metadata, using deterministic synthetic
// statements in an isolated Electron account. No orders are submitted.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/finance-periods-ui-')), accountPath = path.join(output, 'account');
const controlPath = path.join(output, 'control.json'), networkLog = path.join(output, 'network.jsonl');
const control = { now: '2026-10-15T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', financeScenario: 'pass' };
const saveControl = () => fs.writeFileSync(controlPath, JSON.stringify(control)); saveControl();
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
const errors = [], checks = [], dimensions = [];
async function call(name, payload) { return page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload }); }
function financePanel() { return page.locator('#strategy-content > .finance-check').first(); }
async function expandFinance() { if (!(await financePanel().evaluate(element => element.open))) await financePanel().locator(':scope > summary').click(); }
async function capture(name, selector) {
  await page.locator('#toast').waitFor({ state: 'hidden' });
  for (const size of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(...value), size);
    const target = page.locator(selector).first(); await target.scrollIntoViewIfNeeded();
    dimensions.push({ name, window: size, viewport: await page.evaluate(() => [innerWidth, innerHeight]) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} viewport overflow ${size[0]}`);
    assert.equal(await target.evaluate(element => element.scrollWidth <= element.clientWidth), true, `${name} panel overflow ${size[0]}`);
    // Live quote publication can replace the panel between Playwright's layout
    // check and capture. Re-resolve the locator only for that transient race.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await target.screenshot({ path: path.join(output, `${name}-${size[0]}.png`) }); break; }
      catch (error) { if (attempt === 2 || !/not attached to the DOM/.test(error.message)) throw error; }
    }
  }
}
async function scenario(name, expected) {
  control.financeScenario = name; saveControl();
  await call('detail', { symbol: 'sh600519', force: true });
  await page.waitForFunction(expected);
  await expandFinance();
}
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/finance-periods-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  assert.doesNotMatch(await page.locator('#toast').innerText(), /not defined|not a function|Cannot read/i);
  const before = await call('state'); assert.equal(path.resolve(before.dataPath), path.resolve(accountPath));
  await page.evaluate(async () => { await selectStock('sh600519'); });
  await page.locator('#plan-strategy').selectOption('long');
  await page.waitForFunction(() => state.signals.sh600519?.financeCheck?.status === 'pass' && state.signals.sh600519.financeCheck.checks.some(item => item.field === 'annualRoeLatest'));
  await expandFinance();
  await page.evaluate(() => renderState(state));
  assert.equal(await financePanel().evaluate(element => element.open), true, 'State refresh must preserve an expanded financial review');
  const annual = financePanel().locator('[data-finance-field="annualRoeLatest"]');
  assert.match(await annual.innerText(), /2025-12-31/); assert.doesNotMatch(await annual.innerText(), /2026-06-30/);
  assert.match(await annual.innerText(), /原值 12%.*要求 ≥ 8%/s);
  const profit = financePanel().locator('[data-finance-field="latestAdjustedProfit"]');
  assert.match(await profit.innerText(), /2026-06-30/); assert.match(await profit.innerText(), /原值 1亿元.*要求 > 0亿元/s);
  const roe = financePanel().locator('[data-finance-field="roe"]');
  assert.match(await roe.innerText(), /2026-06-30/); assert.match(await roe.innerText(), /4%.*不作为开仓阈值/s); assert.doesNotMatch(await roe.innerText(), /要求.*8%/);
  assert.match(await financePanel().locator(':scope > summary').innerText(), /分项报告期.*财务通过/);
  await capture('annual-and-cumulative', '#strategy-content > .finance-check');
  const savedPlan = page.locator('#strategy-content .plan-finance-evidence .finance-check');
  assert.match(await savedPlan.locator(':scope > summary').innerText(), /本次计划财务依据/);
  await savedPlan.locator(':scope > summary').click();
  await page.evaluate(() => renderState(state));
  assert.equal(await savedPlan.evaluate(element => element.open), true, 'State refresh must preserve expanded plan evidence');
  assert.match(await savedPlan.locator('[data-finance-field="annualRoeLatest"]').innerText(), /2025-12-31/);
  assert.match(await savedPlan.locator('[data-finance-field="latestAdjustedProfit"]').innerText(), /2026-06-30/);
  await capture('plan-financial-basis', '#strategy-content .plan-finance-evidence');
  await page.waitForFunction(() => researchData.finance?.data?.latest?.roe === 4);
  assert.match(await page.locator('#research-finance').innerText(), /累计加权 ROE.*未年化/s);
  checks.push('Recent full-year ROE 12% meets 8% independently of half-year cumulative ROE 4%; each predicate and current plan evidence shows its own report and disclosure date; cumulative ROE is observation-only. No position evidence is persisted because the test does not submit a trade.');

  await scenario('loss', () => state.signals.sh600519.financeCheck.checks.some(item => item.field === 'latestAdjustedProfit' && item.value === -1));
  assert.equal(await page.evaluate(() => state.signals.sh600519.financeCheck.status), 'failed');
  assert.match(await profit.innerText(), /条件不符.*原值 -1亿元.*要求 > 0亿元/s);
  const growth = financePanel().locator('[data-finance-field="adjustedProfitYoY"]');
  assert.match(await growth.innerText(), /通过.*原值 20%.*要求 ≥ 0%/s);
  await capture('loss-with-positive-growth', '#strategy-content > .finance-check');
  checks.push('Negative adjusted profit remains a failed amount predicate even when its separately displayed growth is positive.');

  await scenario('sync', () => state.signals.sh600519.financeCheck.checks.some(item => item.field === 'latestAdjustedProfit' && item.status === 'pending') && state.signals.sh600519.financeCheck.pendingReport);
  assert.equal(await financePanel().locator(':scope > .finance-item-reason').count(), 1);
  assert.match(await profit.innerText(), /待核验.*已取得原值 1亿元.*已披露.*正式财报.*同步/s);
  assert.match(await annual.innerText(), /通过.*2025-12-31/s);
  await capture('new-quarter-awaiting-sync', '#strategy-content > .finance-check');
  await scenario('old', () => state.signals.sh600519.financeCheck.reportDate === '2025-12-31');
  assert.equal(await page.evaluate(() => state.signals.sh600519.financeCheck.status), 'pending');
  assert.match(await financePanel().innerText(), /2025-12-31/); assert.match(await financePanel().innerText(), /最低|过旧|报告期/);
  await capture('old-current-statement', '#strategy-content > .finance-check');
  await scenario('cash-missing', () => state.signals.sh600519.financeCheck.checks.some(item => item.field === 'operatingCash' && item.reportDate === '2026-06-30' && item.value === null && item.rawValue === null));
  assert.match(await financePanel().locator('[data-finance-field="operatingCash"]').innerText(), /未知（缺失不补零）/);
  await scenario('annual-missing', () => state.signals.sh600519.financeCheck.checks.some(item => item.field === 'annualRoeLatest' && item.status === 'pending' && item.value === null));
  assert.match(await annual.innerText(), /报告期尚未核实.*未知（缺失不补零）/s);
  assert.doesNotMatch(await annual.innerText(), /报告期 2026-06-30/);
  assert.match(await financePanel().locator(':scope > summary').innerText(), /分项报告期/);
  assert.match(await profit.innerText(), /通过.*2026-06-30/s);
  await capture('missing-annual-keeps-current-valid', '#strategy-content > .finance-check');
  await scenario('foreign-currency', () => state.signals.sh600519.financeCheck.checks.some(item => item.field === 'latestAdjustedProfit' && item.status === 'pending' && item.currency === 'USD'));
  assert.match(await profit.innerText(), /已取得原值 1亿原币（USD）（当前不可用于判断）/);
  assert.doesNotMatch(await profit.innerText(), /原值 1亿元/);
  await capture('unverified-currency', '#strategy-content > .finance-check');
  checks.push('Disclosed new quarter awaiting sync preserves the old value visibly while marking only affected current metrics pending; annual ROE remains valid. Old current reports and missing cash are pending, never zero. Missing annual ROE does not borrow the half-year date or block valid current predicates.');
  checks.push('Unavailable numeric originals are explicitly diagnostic only; USD amounts display in hundreds of millions of original currency rather than CNY and cannot pass amount predicates.');

  await scenario('low-annual', () => state.signals.sh600519.financeCheck.checks.some(item => item.field === 'annualRoeLatest' && item.value === 6));
  await page.locator('[data-page="screener"]').click(); await page.waitForFunction(() => screenInitialized && !screenBusy);
  await page.locator('#screen-strategy').selectOption('long');
  assert.match(await page.locator('#screen-strategy-info').innerText(), /最近完整年度.*8%.*累计.*仅作趋势观察/s);
  assert.match(await page.locator('#screen-strategy-info').innerText(), /放宽筛选阈值不能覆盖内置规则/);
  await page.locator('#screen-strategy').selectOption(''); await page.locator('#screen-reset').click();
  await page.locator('#screen-catalog > summary').click();
  await page.locator('#screen-fields [data-field="annualRoeLatest"]').click();
  await page.locator('#screen-rules [data-field="annualRoeLatest"] input').fill('5');
  await page.locator('#screen-fields [data-field="roe"]').click();
  await page.locator('#screen-rules [data-field="roe"] input').fill('3');
  assert.match(await page.locator('#screen-rules [data-field="roe"]').innerText(), /累计，未年化/);
  await capture('editable-financial-predicates', '.screen-condition-card');
  await page.locator('#screen-run').click(); await page.waitForFunction(() => !screenBusy);
  assert.equal(await page.locator('#screen-error').innerText(), '');
  assert.equal(await page.evaluate(() => screenResult.rows.length), 1);
  const saved = await page.evaluate(() => screenEntryConditions());
  assert.equal(saved.rules.find(rule => rule.field === 'annualRoeLatest').value, 5);
  assert.equal(saved.rules.find(rule => rule.field === 'roe').value, 3);
  await page.locator('#screen-table [data-screen-open="sh600519"]').click();
  await page.waitForFunction(() => page === 'market' && state.signals.sh600519.financeCheck.checks.some(item => item.field === 'annualRoeLatest' && item.value === 6));
  await expandFinance();
  assert.match(await annual.innerText(), /条件不符.*原值 6%.*要求 ≥ 8%/s);
  assert.equal(await page.locator('#strategy-buy').isDisabled(), true);
  checks.push('Personal annual ROE ≥5 and cumulative ROE ≥3 can be edited and screened independently. Opening the matching stock still shows built-in annual ROE ≥8 failing at 6%; the buy button stays disabled.');

  const after = await call('state');
  assert.deepEqual(after.account.trades, before.account.trades); assert.deepEqual(after.account.orders, before.account.orders);
  assert.deepEqual(after.agency.groups.map(group => group.mode), before.agency.groups.map(group => group.mode));
  assert.deepEqual(errors, []); assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8') : '', '');
  const report = { status: 'passed', output, scope: 'Actual financial evaluator, monitor, screener, renderer and IPC with synthetic statements; isolated account; no trade submission.', checks, dimensions, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(async error => {
  const observed = page ? await page.evaluate(() => ({
    selected: typeof selected === 'undefined' ? null : selected,
    signal: typeof state === 'undefined' ? null : state?.signals?.sh600519,
    screenResult: typeof screenResult === 'undefined' ? null : screenResult
  })).catch(() => null) : null;
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, checks, observed }, null, 2));
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.stderr.write(error.stack + '\n'); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
