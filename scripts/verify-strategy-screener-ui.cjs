// Optional integration check: uses actual Electron UI and IPC, never live accounts/data.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/strategy-screener-ui-')), control = path.join(output, 'control.json');
const accountPath = path.join(output, 'account');
const env = { ...process.env, GUANLAN_TEST_CONTROL: control }; delete env.ELECTRON_RUN_AS_NODE;
const scenario = financeMode => fs.writeFileSync(control, JSON.stringify({ now: '2026-09-30T10:00:00+08:00', price: 10.08, dailyMode: 'ready', financeMode }));
let desktop, page; const errors = [], checks = [];
async function idle() {
  await page.waitForFunction(() => !screenBusy && (screenResult || !document.querySelector('#screen-error').classList.contains('hidden')), null, { timeout: 90000 });
}
async function run() { await page.locator('#screen-run').click(); await idle(); }
async function submit(text) { await page.locator('#screen-description').fill(text); await page.locator('#screen-parse').click(); await idle(); }
async function rules() { return page.evaluate(() => ({ strategy: screenStrategyRules, personal: screenPersonalRules, combined: screenQuery.rules })); }
async function choose(id) {
  await page.locator('#screen-strategy').selectOption(id);
  await page.waitForFunction(id => document.querySelector('#screen-strategy').value === id && !screenBusy, id);
}
async function noOverflow() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
async function ruleFor(field, origin = 'personal') {
  const index = await page.evaluate(({ field, origin }) => {
    return screenRuleEntries.findIndex(entry => entry.rule.field === field && entry.refs.some(ref => ref.origin === origin));
  }, { field, origin });
  assert.ok(index >= 0, `missing ${origin} ${field} rule`);
  return page.locator(`#screen-rules .screen-rule[data-rule="${index}"]`);
}
(async () => {
  scenario('ready');
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/strategy-screener-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), path.resolve(accountPath));
  await page.locator('[data-page="settings"]').click();
  await page.locator('#investment-strategies [data-use-strategy]').first().waitFor();
  assert.equal(await page.locator('#investment-strategies [data-use-strategy]').count(), 4);
  await noOverflow();
  await page.locator('#investment-strategies').screenshot({ path: path.join(output, 'strategy-library.png') });
  await page.locator('#investment-strategies [data-use-strategy="ultra-short"]').click();
  await page.waitForFunction(() => page === 'screener' && !screenBusy && screenMeta);
  assert.equal(await page.locator('#screen-strategy').inputValue(), 'ultra-short');
  assert.ok((await rules()).strategy.length > 0);
  assert.match(await page.locator('#screen-strategy-info').innerText(), /T\+1|当日.*卖/);
  for (const id of ['ultra-short', 'short', 'swing', 'long']) assert.equal(await page.locator(`#screen-strategy option[value="${id}"]`).count(), 1);
  checks.push('four strategy cards and direct entry with ultra-short T+1 explanation');

  await choose('swing');
  const swing = (await rules()).strategy;
  const pendingDescription = 'ROE不低于12%，资产负债率不高于60%';
  await page.locator('#screen-description').fill(pendingDescription);
  await choose('short');
  assert.equal(await page.locator('#screen-description').inputValue(), pendingDescription);
  assert.equal(await page.locator('#screen-run').isDisabled(), true);
  assert.deepEqual((await rules()).personal, []);
  await choose('swing');
  assert.equal(await page.locator('#screen-description').inputValue(), pendingDescription);
  assert.equal(await page.locator('#screen-run').isDisabled(), true);
  checks.push('unapplied text survives strategy changes and blocks running stale conditions');
  await submit('ROE不低于12%，资产负债率不高于60%');
  assert.equal(await page.locator('#screen-error').isVisible(), false);
  let current = await rules();
  assert.deepEqual(current.strategy, swing); assert.equal(current.personal.length, 2);
  assert.equal(current.combined.length, swing.length + 2);
  assert.ok(await page.evaluate(() => screenResult.matched > 0 && screenResult.rows.every(row => row.roe >= 12 && row.debtRatio <= 60)));
  assert.match(await page.locator('#screen-table').innerText(), /2026-06-30/);
  assert.match(await page.locator('#screen-table').innerText(), /16\.75/);
  checks.push('strategy plus ROE and debt conditions, financial values and report dates');

  const stock = page.locator('#screen-table [data-screen-open]').first();
  const symbol = await stock.getAttribute('data-screen-open');
  await stock.click();
  await page.waitForFunction(symbol => page === 'market' && selected === symbol && researchSymbol === symbol && !researchLoading.size, symbol);
  await page.locator('#research-evidence summary').click();
  const evidence = await page.locator('#research-evidence').innerText();
  assert.match(evidence, /波段.*趋势预筛/);
  assert.match(evidence, /加权净资产收益率.*16\.75.*≥.*12/);
  assert.match(evidence, /资产负债率.*15\.19.*≤.*60/);
  assert.match(evidence, /东方财富 · 财报 2026-06-30 · 公告 2026-08-15 · 获取/);
  assert.match(evidence, /完整日线 2026-09-29/);
  await page.locator('#research-evidence').screenshot({ path: path.join(output, 'financial-selection-evidence.png') });
  await page.locator('[data-page="screener"]').click();
  assert.deepEqual(await rules(), current);
  checks.push('opening a screened stock retains strategy, condition values and dated financial evidence');

  await submit('ROE不低于12%，资产负债率不高于60%');
  assert.deepEqual(await rules(), current);
  await submit('营收同比大于0%');
  current = await rules(); assert.equal(current.personal.length, 3);
  const personal = current.personal;
  await choose('long');
  current = await rules(); assert.deepEqual(current.personal, personal); assert.notDeepEqual(current.strategy, swing);
  assert.equal(current.combined.length, new Set([...current.strategy, ...current.personal].map(rule => JSON.stringify(rule))).size);
  await run();
  assert.ok(await page.evaluate(() => screenResult.finance && !screenResult.technical && screenResult.matched > 0));
  await choose('short'); assert.deepEqual((await rules()).personal, personal);
  await choose('swing'); assert.deepEqual((await rules()).strategy, swing);
  checks.push('text conditions append and deduplicate; switching preserves personal conditions');

  const roeRule = await ruleFor('roe');
  await roeRule.locator('[data-part="value"]').fill('18'); await run();
  assert.equal(await page.evaluate(() => screenResult.matched), 0);
  await (await ruleFor('roe')).locator('[data-part="value"]').fill('12'); await run();
  assert.ok(await page.evaluate(() => screenResult.matched > 0));
  const before = await rules(), beforeMatched = await page.evaluate(() => screenResult.matched);
  await submit('ROE小于10%');
  assert.match(await page.locator('#screen-error').innerText(), /矛盾|冲突/);
  assert.deepEqual(await rules(), before);
  assert.equal(await page.evaluate(() => screenResult.matched), beforeMatched);
  await submit('ROE大于12%，MACD金叉');
  assert.match(await page.locator('#screen-error').innerText(), /未应用/);
  assert.deepEqual(await rules(), before); assert.equal(await page.locator('#screen-run').isDisabled(), true);
  await submit('ROE不低于12%');
  assert.equal(await page.locator('#screen-error').isVisible(), false);
  checks.push('editing changes actual results; conflicts and unsupported text preserve conditions/results');

  const strategyCount = (await rules()).strategy.length;
  await page.locator('#screen-rules .screen-rule[data-origin="strategy"] [data-remove]').first().click();
  assert.equal((await rules()).strategy.length, strategyCount - 1);
  assert.deepEqual((await rules()).personal, personal);
  await choose('short'); await choose('swing');
  await (await ruleFor('revenueYoY')).locator('[data-remove]').click();
  assert.equal((await rules()).personal.length, 2);
  await page.locator('#screen-catalog summary').click();
  await page.locator('#screen-field-search').fill('营收');
  await page.locator('#screen-fields [data-field="revenueYoY"]').click();
  await (await ruleFor('revenueYoY')).locator('[data-part="op"]').selectOption('gt');
  await (await ruleFor('revenueYoY')).locator('[data-part="value"]').fill('0');
  await page.locator('#screen-catalog summary').click(); await run();
  assert.ok(await page.evaluate(() => screenResult.matched > 0));
  checks.push('strategy removal and reset on switch; individual personal removal and catalog addition');

  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1536, 960));
  await noOverflow(); await page.screenshot({ path: path.join(output, 'strategy-wide.png'), fullPage: true });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
  await noOverflow(); await page.screenshot({ path: path.join(output, 'strategy-small.png'), fullPage: true });
  checks.push('1120px and 1536px layout without document overflow');

  const history = await page.evaluate(() => screenHistory[0].id);
  const historyResult = await page.evaluate(() => screenResult.matched);
  await page.locator('#screen-data-source').selectOption(history); await run();
  assert.match(await page.locator('#screen-error').innerText(), /历史快照.*(?:日线|财务|财报|公告)/);
  assert.equal(await page.evaluate(() => screenResult.matched), historyResult);
  await page.locator('#screen-reset').click();
  assert.deepEqual(await rules(), { strategy: [], personal: [], combined: [] });
  assert.equal(await page.locator('#screen-strategy').inputValue(), '');
  await submit('ROE不低于12%');
  assert.match(await page.locator('#screen-error').innerText(), /历史快照.*(?:财务|财报)/);
  await page.locator('#screen-data-source').selectOption('latest');
  scenario('slow'); await page.locator('#screen-run').click();
  await page.waitForFunction(() => screenBusy && /财务|财报/.test(document.querySelector('#screen-progress').textContent));
  assert.equal(await page.locator('#screen-strategy').isDisabled(), true);
  assert.equal(await page.locator('#screen-parse').isDisabled(), true);
  await idle(); assert.ok(await page.evaluate(() => screenResult.matched > 0));
  checks.push('historical technical and financial conditions rejected; financial scan progress');

  scenario('partial'); await run();
  assert.equal(await page.evaluate(() => screenResult.matched), 133);
  assert.equal(await page.evaluate(() => screenResult.missingByField.roe), 2);
  assert.match(await page.locator('#screen-result-count').innerText(), /部分股票未判定/);
  scenario('offline'); await run();
  assert.equal(await page.evaluate(() => screenResult.status), 'unavailable');
  assert.equal(await page.evaluate(() => screenResult.matched), null);
  assert.match(await page.locator('#screen-data-message').innerText(), /获取失败 135 只/);
  scenario('ready'); await run();
  assert.equal(await page.evaluate(() => screenResult.matched), 135);
  checks.push('partial financial reports remain unknown; offline does not report zero; recovery');

  await page.locator('#screen-reset').click(); await choose('swing');
  await submit('ROE不低于10%，ROE不低于12%，资产负债率不高于60%');
  await (await ruleFor('roe')).locator('[data-part="value"]').fill('12');
  assert.equal(await page.locator('#screen-rules .screen-rule').count(), swing.length + 2);
  await (await ruleFor('debtRatio')).locator('[data-part="value"]').fill('55');
  assert.equal((await rules()).personal.find(rule => rule.field === 'debtRatio').value, 55);
  await (await ruleFor('debtRatio')).locator('[data-remove]').click();
  assert.equal((await rules()).personal.some(rule => rule.field === 'debtRatio'), false);
  const uniqueBefore = (await rules()).combined.length;
  await submit('MACD大于0');
  assert.equal((await rules()).combined.length, uniqueBefore);
  assert.ok((await rules()).personal.some(rule => rule.field === 'macd'));
  await (await ruleFor('macd')).locator('[data-remove]').click();
  current = await rules();
  assert.equal(current.strategy.some(rule => rule.field === 'macd'), false);
  assert.equal(current.personal.some(rule => rule.field === 'macd'), false);
  await (await ruleFor('roe')).locator('[data-part="value"]').fill('11');
  assert.ok((await rules()).personal.filter(rule => rule.field === 'roe').every(rule => rule.value === 11));
  await (await ruleFor('roe')).locator('[data-remove]').click();
  assert.deepEqual((await rules()).personal, []);
  checks.push('merged duplicate rule editing keeps indices correct; removing shared rule updates both origins');

  await page.locator('#screen-reset').click();
  assert.deepEqual(await rules(), { strategy: [], personal: [], combined: [] });
  assert.equal(await page.locator('#screen-strategy').inputValue(), '');
  assert.equal(await page.locator('#screen-description').inputValue(), '');
  await run(); assert.equal(await page.evaluate(() => screenResult.matched), 135);
  const account = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length }));
  assert.deepEqual(account, { trades: 0, orders: 0 }); assert.deepEqual(errors, []);
  checks.push('clear removes strategy and personal conditions; account never trades');
  const report = { output, errors, account, checks };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  console.error(error); console.error('Output:', output);
  if (page) { console.error(await page.locator('#screen-error').textContent()); await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }); }
  process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
