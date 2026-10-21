// Actual Electron UI and IPC against deterministic data in a fresh, isolated account.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/strategy-modes-ui-'));
const controlPath = path.join(output, 'control.json'), accountPath = path.join(output, 'account');
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath }; delete env.ELECTRON_RUN_AS_NODE;
const control = { now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready' };
const scenario = patch => { Object.assign(control, patch); fs.writeFileSync(controlPath, JSON.stringify(control)); };
let desktop, page; const errors = [], checks = [];
async function call(name, payload) { return page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload }); }
async function waitState(predicate) {
  const start = Date.now();
  while (Date.now() - start < 30000) { const current = await call('state'); if (predicate(current)) return current; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Desktop state timeout: ' + JSON.stringify(await call('state')));
}
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/strategy-modes-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.strategyProfiles?.length === 4);
  assert.equal(path.resolve((await call('state')).dataPath), path.resolve(accountPath));
}
async function choose(strategyId) {
  await page.locator('#plan-strategy').selectOption(strategyId);
  await page.waitForFunction(id => document.querySelector('#plan-strategy').value === id && !document.querySelector('#plan-strategy').disabled && state.signals.sh600519?.strategyId === id, strategyId);
  return waitState(s => s.signals.sh600519?.plan && s.signals.sh600519.strategyId === strategyId && s.signals.sh600519.status !== '等待财务估值');
}
async function noOverflow() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
(async () => {
  scenario({}); await launch();
  assert.equal(await page.locator('#plan-strategy option').count(), 4);
  const plans = {};
  for (const strategyId of ['ultra-short', 'short', 'swing', 'long']) {
    const current = await choose(strategyId), signal = current.signals.sh600519;
    assert.equal(signal.buyable, true, strategyId + ': ' + signal.reasons.join('；'));
    assert.equal(signal.entryRisk.notices.status, 'clear');
    if (['swing', 'long'].includes(strategyId)) assert.equal(signal.entryRisk.market, null);
    assert.equal(await page.locator('#strategy-buy').isDisabled(), false);
    const profile = current.strategyProfiles.find(item => item.id === strategyId);
    assert.match(await page.locator('#plan-strategy-description').innerText(), new RegExp(profile.maxHeldBars));
    plans[strategyId] = { stop: signal.plan.stop, target: signal.plan.target, entryLow: signal.plan.entryLow, entryHigh: signal.plan.entryHigh };
    await page.locator('.strategy-card').screenshot({ path: path.join(output, `plan-${strategyId}.png`) });
  }
  assert.notDeepEqual(plans['ultra-short'], plans.long);
  assert.match(await page.locator('#strategy-content').innerText(), /2026-06-30/);
  assert.match(await page.locator('#strategy-content').innerText(), /动态.*PE|PE.*动态/);
  checks.push('four strategies calculate distinct real daily plans and show rules; long plan shows dated financial evidence');
  await choose('short');
  await page.locator('#strategy-buy').click();
  assert.match(await page.locator('#confirm-title').innerText(), /短线/);
  await page.locator('#confirm-cancel').click(); assert.equal((await call('state')).account.trades.length, 0);
  await page.locator('#strategy-buy').click();
  await call('strategy:select', { symbol: 'sh600519', strategyId: 'ultra-short' });
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => /策略.*变化|变化.*策略/.test(document.querySelector('#toast').textContent));
  assert.equal((await call('state')).account.trades.length, 0);
  checks.push('cancel leaves account untouched; switching strategy while confirmation is open rejects original buy');
  await page.locator('#watchlist [data-symbol="sz000001"]').click();
  await page.locator('#plan-strategy').selectOption('swing');
  await page.locator('#watchlist [data-symbol="sh600519"]').click();
  await page.waitForFunction(() => selected === 'sh600519' && document.querySelector('#plan-strategy').value === 'ultra-short');
  checks.push('selection belongs to each stock and survives switching stocks');
  await choose('long');
  scenario({ financeMode: 'offline' });
  await page.locator('#strategy-buy').click(); await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => /财务/.test(document.querySelector('#toast').textContent) && document.querySelector('#toast').classList.contains('error'));
  assert.equal((await call('state')).account.trades.length, 0);
  scenario({ financeMode: 'ready', now: '2026-09-29T10:02:00+08:00' });
  await page.locator('#refresh').click();
  await waitState(s => s.signals.sh600519?.buyable);
  await page.waitForFunction(() => !document.querySelector('#strategy-buy').disabled);
  checks.push('forced financial refresh at confirmation rejects offline long entry and recovers without account changes');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
  await noOverflow(); await page.screenshot({ path: path.join(output, 'long-small.png'), fullPage: true });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1536, 980));
  await noOverflow(); await page.screenshot({ path: path.join(output, 'long-wide.png'), fullPage: true });
  checks.push('1120px and 1536px layouts without horizontal overflow');
  await page.locator('#strategy-buy').click(); await page.locator('#confirm-ok').click();
  const bought = await waitState(s => s.account.trades.length === 1), risk = bought.account.risks.sh600519;
  assert.equal(risk.strategyId, 'long'); assert.equal(bought.account.trades[0].strategyPlan.strategyId, 'long');
  assert.equal(bought.account.trades[0].strategyPlan.entryRiskEvidence.notices.status, 'clear');
  await page.waitForFunction(() => document.querySelector('#plan-strategy').disabled);
  assert.match(await page.locator('#plan-strategy-lock').innerText(), /持仓.*长线|长线.*规则/);
  assert.match(await page.locator('#strategy-history').innerText(), /长线/);
  await page.locator('.strategy-card').screenshot({ path: path.join(output, 'long-holding.png') });
  const frozen = await page.evaluate(() => window.guanlan.call('strategy:select', { symbol: 'sh600519', strategyId: 'short' }));
  assert.equal(frozen.ok, false); assert.match(frozen.error, /持仓|平仓/);
  checks.push('confirmed long fill retains strategy/evidence; holding selector and backend prevent changing the entry strategy');
  await page.locator('[data-page="portfolio"]').click();
  scenario({ now: '2026-09-29T10:03:00+08:00', price: Math.round((risk.stop - 0.02) * 100) / 100, financeMode: 'offline', dailyMode: 'offline', noticeMode: 'offline' });
  await page.locator('#refresh').click();
  const latched = await waitState(s => s.account.risks.sh600519?.pendingExit === '止损触发');
  assert.equal(latched.account.trades.length, 1); assert.match(latched.account.risks.sh600519.note, /T\+1/);
  await desktop.close(); desktop = null;
  scenario({ now: '2026-09-30T10:00:00+08:00', price: 10.17 }); await launch();
  const sold = await waitState(s => s.account.trades.length === 2);
  assert.equal(sold.stats.positions.length, 0); assert.equal(sold.account.trades[1].reason, '止损触发');
  assert.equal(sold.account.trades[1].riskSnapshot.strategyId, 'long');
  assert.equal(sold.planSelections.sh600519, 'long');
  await page.waitForFunction(() => document.querySelector('#strategy-history').textContent.includes('最近已退出交易'));
  assert.match(await page.locator('#strategy-history').innerText(), /长线/);
  checks.push('off-page stop loss works despite financial/daily/notice outages; T+1 latch exits after restart and saved strategy remains');
  assert.deepEqual(errors, []);
  const report = { output, accountPath, errors, plans, checks };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  console.error(error); console.error('Output:', output);
  if (page && !page.isClosed()) { console.error(await page.locator('#strategy-content').innerText()); await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }); }
  process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
