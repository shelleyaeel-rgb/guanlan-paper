// Real Electron UI/IPC with deterministic data and a new isolated account.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/entry-risk-ui-'));
const controlPath = path.join(output, 'control.json'), accountPath = path.join(output, 'account');
const control = { now: '2026-10-08T10:36:32+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', noticeMode: 'ready', includeLimitDownCase: true };
const scenario = patch => { Object.assign(control, patch); fs.writeFileSync(controlPath, JSON.stringify(control)); };
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page; const errors = [], checks = [];
async function state() { return page.evaluate(async () => { const r = await window.guanlan.call('state'); if (!r.ok) throw Error(r.error); return r.data; }); }
async function screen() { await page.locator('#screen-run').click(); await page.waitForFunction(() => !screenBusy && !screenDirty && !screenRequestFailed); }
async function noOverflow() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
(async () => {
  scenario({});
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/strategy-modes-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.strategyProfiles?.length === 4);
  assert.equal(path.resolve((await state()).dataPath), path.resolve(accountPath));
  await page.locator('[data-page="screener"]').click();
  await page.waitForFunction(() => typeof screenMeta !== 'undefined' && screenMeta?.strategies?.length === 4 && !screenBusy);
  await page.locator('#screen-strategy').selectOption('short');
  await page.getByRole('button', { name: '基本面 · 盈利与成长', exact: true }).click();
  await page.waitForFunction(() => !screenBusy && screenResult?.riskScreen && screenResult.query.rules.length === 11);
  let result = await page.evaluate(() => screenResult);
  assert.equal(result.matched, 4);
  assert.equal(result.rows.some(row => row.symbol === 'sh688578'), false);
  assert.equal(result.riskExcluded.find(row => row.symbol === 'sh688578').entryRisk.status, 'blocked');
  assert.match(await page.locator('#screen-risk-excluded').innerText(), /艾力斯[\s\S]*20\.00%[\s\S]*5%/);
  assert.equal(result.rows[0].entryRisk.market.basis, 'risk-refresh');
  assert.match(await page.locator('#screen-table').innerText(), /公告仅标题检查[\s\S]*复核报价/);
  await noOverflow(); await page.locator('.screen-results-card').screenshot({ path: path.join(output, 'limit-down-excluded-wide.png') });
  checks.push('short plus profitability/growth excludes the limit-down regression case and shows fresh risk quotation separately');

  await page.locator('#screen-result-search').fill('688578');
  assert.equal(await page.locator('#screen-table [data-screen-open]').count(), 0);
  await page.locator('#screen-risk-excluded [data-screen-open="sh688578"]').click();
  await page.waitForFunction(() => page === 'market' && selected === 'sh688578' && state.signals.sh688578?.entryRisk?.status === 'blocked');
  assert.equal(await page.locator('#strategy-buy').isDisabled(), true);
  assert.match(await page.locator('#strategy-content').innerText(), /跌停[\s\S]*无有效买盘/);
  await page.locator('#research-evidence summary').click();
  assert.match(await page.locator('#research-evidence').innerText(), /风险排除依据[\s\S]*未列为正常候选/);
  assert.equal(await page.locator('#research-tab-notices').getAttribute('aria-selected'), 'true');
  await page.locator('.strategy-card').screenshot({ path: path.join(output, 'limit-down-plan-blocked.png') });
  checks.push('opening an excluded row preserves exclusion evidence, selects the short plan and disables its buy action');

  await page.locator('[data-page="screener"]').click(); await page.locator('#screen-result-search').fill('');
  while (await page.locator('#screen-rules [data-remove]').count()) await page.locator('#screen-rules [data-remove]').first().click();
  await screen(); result = await page.evaluate(() => screenResult);
  assert.equal(result.query.rules.length, 0); assert.equal(result.matched, 4);
  assert.equal(result.riskExcluded.find(row => row.symbol === 'sh688578').entryRisk.status, 'blocked');
  checks.push('removing every editable indicator leaves short-template risk checks active');

  scenario({ noticeMode: 'event' }); await screen(); result = await page.evaluate(() => screenResult);
  assert.equal(result.status, 'unavailable'); assert.equal(result.matched, null);
  assert.equal(result.riskScreen.unverified, 4); assert.equal(result.missing, 0);
  assert.match(await page.locator('#screen-risk-excluded').innerText(), /临床试验进展/);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
  await noOverflow(); await page.locator('.screen-results-card').screenshot({ path: path.join(output, 'event-review-small.png') });
  checks.push('clinical progress titles remain unverified, with unknown matching count and no fabricated indicator-missing count');

  scenario({ noticeMode: 'offline' }); await screen(); result = await page.evaluate(() => screenResult);
  assert.equal(result.matched, null); assert.equal(result.riskScreen.unverified, 4);
  assert.match(await page.locator('#screen-risk-excluded').innerText(), /公告获取失败|公告资料获取失败/);
  scenario({ noticeMode: 'ready' });
  await page.locator('#screen-strategy').selectOption(''); await screen();
  assert.equal((await page.evaluate(() => screenResult)).rows.some(row => row.symbol === 'sh688578'), true);
  assert.equal(await page.locator('#screen-risk-excluded').isVisible(), false);
  assert.equal(await page.locator('#screen-notice-status').isVisible(), true);
  assert.match(await page.locator('#screen-notice-status').innerText(), /公告未核验.*打开股票后/);
  await page.locator('.screen-results-card').screenshot({ path: path.join(output, 'custom-notices-unverified.png') });
  checks.push('announcement failure never falls back to prior clear results; custom screening explicitly labels notices unverified');

  for (const strategyId of ['swing', 'long']) {
    scenario({ noticeMode: 'event' });
    await page.locator('#screen-strategy').selectOption(strategyId); await screen();
    result = await page.evaluate(() => screenResult);
    assert.equal(result.status, 'unavailable'); assert.equal(result.matched, null);
    assert.equal(result.riskScreen.marketEnabled, false);
    assert.equal(result.riskScreen.marketChecked, 0); assert.equal(result.riskScreen.marketExcluded, 0);
    assert.ok(result.riskScreen.unverified >= 4);
    assert.ok(result.riskExcluded.every(row => row.entryRisk.market === null));
    assert.match(await page.locator('#screen-risk-excluded').innerText(), /各策略共用的公告检查[\s\S]*临床试验进展/);
    assert.doesNotMatch(await page.locator('#screen-risk-excluded').innerText(), /跌幅达到 5%/);
    assert.equal(await page.locator('#screen-notice-status').isVisible(), false);
    await noOverflow(); await page.locator('.screen-results-card').screenshot({ path: path.join(output, `${strategyId}-event-review.png`) });

    scenario({ noticeMode: 'ready' }); await screen();
    result = await page.evaluate(() => screenResult);
    assert.ok(result.matched >= 4);
    assert.ok(result.rows.every(row => row.entryRisk.market === null && row.entryRisk.notices.status === 'clear'));
    await page.locator('#screen-table [data-screen-open="sh600519"]').click();
    // A failed monitor attempt is intentionally cached for one minute; explicitly refresh after recovery.
    await page.locator('#refresh').click();
    await page.waitForFunction(id => selected === 'sh600519' && state.signals.sh600519?.strategyId === id && state.signals.sh600519?.buyable, strategyId);
    assert.equal((await state()).signals.sh600519.entryRisk.market, null);
    assert.match(await page.locator('#strategy-content').innerText(), /公告/);
    await page.locator('#strategy-buy').click();
    scenario({ noticeMode: 'offline' }); await page.locator('#confirm-ok').click();
    await page.waitForFunction(() => state.signals.sh600519?.entryRisk?.notices?.status === 'unverified' && !state.signals.sh600519.buyable);
    assert.equal((await state()).account.trades.length, 0);
    assert.equal(await page.locator('#strategy-buy').isDisabled(), true);
    await page.locator('.strategy-card').screenshot({ path: path.join(output, `${strategyId}-confirmation-blocked.png`) });
    checks.push(`${strategyId} screens out announcement events, keeps market checks out of scope, and blocks confirmed entry after forced notice failure`);
    scenario({ noticeMode: 'ready' });
    await page.locator('[data-page="screener"]').click();
  }

  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1536, 980));
  await page.locator('#screen-strategy').selectOption('short'); await screen();
  await page.locator('#screen-table [data-screen-open="sh600519"]').click();
  await page.locator('#refresh').click();
  await page.waitForFunction(() => selected === 'sh600519' && state.signals.sh600519?.buyable);
  assert.match(await page.locator('#strategy-content').innerText(), /规则通过 · 可模拟/);
  await page.locator('#strategy-buy').click();
  scenario({ noticeMode: 'offline' });
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => document.querySelector('#toast').classList.contains('error') && /公告/.test(document.querySelector('#toast').textContent));
  assert.equal((await state()).account.trades.length, 0);
  assert.equal(await page.locator('#strategy-buy').isDisabled(), true);
  scenario({ noticeMode: 'event', now: '2026-10-08T10:39:00+08:00' });
  await page.locator('#refresh').click();
  await page.waitForFunction(() => state.signals.sh600519?.entryRisk?.notices?.notices?.length > 0);
  assert.match(await page.locator('#strategy-content').innerText(), /等待公告核验[\s\S]*临床试验进展/);
  assert.equal(await page.locator('#strategy-content [data-risk-notice]').count(), 1);
  await page.locator('.strategy-card').screenshot({ path: path.join(output, 'announcement-plan-blocked.png') });
  checks.push('confirmation re-fetches announcements and rejects a newly failed service; event state shows dated original-notice access');
  assert.deepEqual(errors, []);
  const report = { output, accountPath, checks, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  console.error(error); console.error('Output:', output);
  if (page && !page.isClosed()) { console.error(await page.locator('#screen-error').innerText()); await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }); }
  process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
