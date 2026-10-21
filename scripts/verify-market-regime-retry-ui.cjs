// Isolated Electron proof: all four retry buttons refresh the shared market
// source, progress is visible, and refreshed data never bypasses confirmation.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const { STRATEGY_PROFILES } = require('../core/strategy-profiles.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/market-regime-retry-ui-'));
const accountPath = path.join(output, 'account'), control = path.join(output, 'control.json'), marketLog = path.join(output, 'market-source.jsonl');
const scenario = { now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', corporateMode: 'empty', marketMode: 'offline', marketHold: false };
const update = patch => { Object.assign(scenario, patch); fs.writeFileSync(control, JSON.stringify(scenario)); };
const engine = new Engine(initialState()); engine.s.settings.refreshSeconds = 60;
for (const [index, profile] of STRATEGY_PROFILES.entries()) engine.agencyMember({ strategyId: profile.id, symbol: `sh${600001 + index}`, action: 'add' });
fs.mkdirSync(accountPath); fs.writeFileSync(path.join(accountPath, 'account.json'), JSON.stringify(engine.s, null, 2)); update({});
const env = { ...process.env, GUANLAN_TEST_CONTROL: control, GUANLAN_TEST_MARKET_LOG: marketLog,
  GUANLAN_TEST_NETWORK_LOG: path.join(output, 'network.jsonl'), GUANLAN_TEST_EXTERNAL_LOG: path.join(output, 'external.jsonl') };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, page; const checks = [], errors = [], screenshots = [];
const sources = () => fs.existsSync(marketLog) ? fs.readFileSync(marketLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function call(name, payload) {
  return page.evaluate(async ({ name, payload }) => {
    const response = await window.guanlan.call(name, payload); if (!response.ok) throw Error(response.error); return response.data;
  }, { name, payload });
}
async function capture(name) {
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.locator('#agency-market-regime').scrollIntoViewIfNeeded();
  const filename = path.join(output, name + '-1120.png'); await page.screenshot({ path: filename }); screenshots.push(filename);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const box = await page.locator('#agency-market-regime').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 1120);
}
async function waitIdle() {
  await page.waitForFunction(() => !agencyUi.busy.size && state.agency.runtime.marketRegime.acquisition?.loading === false);
}

(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/market-regime-retry-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.runtime?.marketRegime?.acquisition?.lastError);
  assert.equal(path.resolve((await call('state')).dataPath), accountPath);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 800));
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.locator('[data-page="agency"]').click();
  await page.waitForSelector('#agency-tabs [data-agency-tab]');
  assert.match(await page.locator('#agency-market-reason').innerText(), /市场环境获取失败.*选股行情获取超时/);
  await capture('initial-source-timeout');

  for (const profile of STRATEGY_PROFILES) {
    await page.locator(`[data-agency-tab="${profile.id}"]`).click();
    const before = sources().length;
    update({ marketHold: true, marketMode: 'offline' });
    await page.locator('#agency-verify').click();
    await page.waitForFunction(() => state.agency.runtime.marketRegime.acquisition?.loading
      && document.querySelector('#agency-market-reason').textContent.includes('300 / 1,200'));
    assert.equal(sources().length, before + 1); assert.equal(sources().at(-1).force, true);
    const loading = await call('state');
    assert.equal(loading.agency.runtime.marketRegime.status, 'unknown'); assert.equal(loading.agency.runtime.marketRegime.allowEntry, false);
    const text = await page.locator('#agency-market-reason').innerText();
    assert.match(text, /正在重新获取市场环境.*全市场报价/); assert.match(text, /上次失败.*选股行情获取超时/);
    assert.match(await page.locator('#agency-market-badge').innerText(), /暂停新开仓/);
    if (profile.id === 'long') await capture('long-retry-progress');
    update({ marketHold: false }); await waitIdle();
    assert.match(await page.locator('#toast').innerText(), /市场环境：待核验（暂停新开仓）/);
    assert.match(await page.locator('#agency-market-reason').innerText(), /市场环境获取失败.*选股行情获取超时/);
    assert.doesNotMatch(await page.locator('#agency-market-reason').innerText(), /正在重新获取/);
    checks.push(`${profile.id}: real retry button starts one forced shared acquisition, exposes progress and keeps failed permissions closed`);
  }

  // A recovered source clears its old error, but the first fresh sample cannot
  // grant entry permission: the existing two-minute confirmation still applies.
  update({ marketMode: 'ready', marketHold: true });
  await page.locator('#agency-verify').click();
  await page.waitForFunction(() => state.agency.runtime.marketRegime.acquisition?.loading
    && document.querySelector('#agency-market-reason').textContent.includes('本轮切换原因'));
  assert.match(await page.locator('#agency-market-reason').innerText(), /新浪财经.*本轮切换原因.*测试主来源临时不可用/);
  await capture('fallback-source-progress');
  update({ marketHold: false }); await waitIdle();
  const first = await call('state');
  assert.equal(first.agency.runtime.marketRegime.status, 'unknown'); assert.equal(first.agency.runtime.marketRegime.allowEntry, false);
  assert.equal(first.agency.runtime.marketRegime.acquisition.lastError, '');
  assert.equal(first.agency.runtime.marketRegime.acquisition.source, '新浪财经（隔离备用样本）');
  assert.match(await page.locator('#agency-market-reason').innerText(), /本轮已使用备用来源.*新浪财经/);
  assert.match(await page.locator('#agency-market-time').innerText(), /广度来源：新浪财经/);
  assert.match(await page.locator('#agency-market-reason').innerText(), /改善等待持续确认/);
  assert.match(await page.locator('#toast').innerText(), /市场环境：待核验（暂停新开仓）/);
  assert.doesNotMatch(await page.locator('#agency-market-reason').innerText(), /选股行情获取超时|正在重新获取/);
  await capture('source-recovered-awaiting-confirmation');
  checks.push('fallback progress and final source are visible; recovered evidence clears the old timeout while the first sample still pauses all new entries');

  update({ now: '2026-09-29T10:02:00+08:00' });
  await call('refresh'); // Provide genuinely newer index quotes to the service.
  const final = await call('agency:verify', { strategyId: 'long', symbol: 'sh600004' });
  assert.equal(final.marketRegime.status, 'strong'); assert.equal(final.marketRegime.allowEntry, true);
  await page.waitForFunction(() => state.agency.runtime.marketRegime.status === 'strong');
  assert.match(await page.locator('#agency-market-badge').innerText(), /偏强.*正常风险预算/);
  await page.locator('#agency-verify').click(); await waitIdle();
  assert.match(await page.locator('#toast').innerText(), /市场环境：偏强（已确认）/);
  await capture('source-recovered-confirmed');
  checks.push('single-stock retry uses the same environment; only different evidence spanning 120 seconds restores permission');
  const current = await call('state');
  assert.equal(current.account.orders.length, 0); assert.equal(current.account.trades.length, 0); assert.equal(current.account.lots.length, 0);
  assert.ok(current.agency.groups.every(group => group.mode === 'paused'));
  assert.deepEqual(errors, []);
  const report = { passed: true, output, checks, screenshots, errors, sourceCalls: sources(), finalMarketRegime: current.agency.runtime.marketRegime,
    noExecution: { orders: current.account.orders.length, trades: current.account.trades.length, lots: current.account.lots.length } };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, output, checks, screenshots, sourceCalls: sources().length }, null, 2));
})().catch(async error => {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, output, checks, screenshots, errors, error: error.stack }, null, 2));
  console.error(error); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
