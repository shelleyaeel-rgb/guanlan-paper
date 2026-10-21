// End-to-end UI and production IPC, using isolated files and fixture-only HTTP.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-ui-'));
const controlPath = path.join(output, 'control.json'), accountPath = path.join(output, 'account'), networkLog = path.join(output, 'unexpected-network.jsonl');
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog }; delete env.ELECTRON_RUN_AS_NODE;
const scenarioState = { now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready' };
const scenario = patch => { Object.assign(scenarioState, patch); fs.writeFileSync(controlPath, JSON.stringify(scenarioState)); };
const checks = [], errors = []; let desktop, page;
const group = (state, id = 'swing') => state.agency.groups.find(item => item.id === id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(name, payload) { return page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload }); }
async function waitState(predicate, timeout = 20000) {
  const start = Date.now(); let current;
  while (Date.now() - start < timeout) { current = await call('state'); if (predicate(current)) return current; await sleep(100); }
  throw Error('Agency state timeout: ' + JSON.stringify({ warning: current.warning, groups: current.agency.groups.map(g => ({ id: g.id, mode: g.mode, members: g.members, positions: g.positions })), decisions: current.agency.decisions.slice(-8), runtime: current.agency.runtime }));
}
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/agency-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  const current = await call('state'); assert.equal(path.resolve(current.dataPath), path.resolve(accountPath));
  await page.locator('[data-page="agency"]').click();
  await page.locator('[data-agency-tab="swing"]').click();
  return current;
}
async function add(symbol, strategyId = 'swing') {
  await page.locator('#agency-add').click(); await page.locator('#agency-assign-symbol').fill(symbol); await page.locator('#agency-assign-strategy').selectOption(strategyId);
  await page.locator('#agency-assign-submit').click(); await page.waitForFunction(() => !document.querySelector('#agency-assign-dialog').open);
}
async function chooseMode(mode) {
  await page.locator(`[data-agency-mode="${mode}"]`).click();
  if (mode === 'stopped') await page.locator('#confirm-ok').click();
  await waitState(s => group(s).mode === mode);
}
async function settle() { await waitState(s => s.agency.runtime.runningGroups.length === 0); await sleep(100); }
(async () => {
  fs.mkdirSync(accountPath, { recursive: true });
  const obsoleteSettings = 'obsolete-model-config-is-intentionally-not-valid-json';
  fs.writeFileSync(path.join(accountPath, 'agency-model.json'), obsoleteSettings);
  scenario({}); const initial = await launch();
  assert.equal(initial.agency.runtime.decisionMode, 'rules');
  assert.equal(initial.agency.runtime.intervalSeconds, 300);
  assert.equal(initial.agentModel, undefined);
  assert.equal(await page.locator('#agency-model-form').count(), 0);
  assert.equal(await page.evaluate(async () => {
    try { await window.guanlan.call('agency:model:test'); return false; } catch { return true; }
  }), true, 'old model IPC is inaccessible');
  assert.equal(await page.locator('#agency-tabs button').count(), 4);
  for (const profile of initial.strategyProfiles) {
    await page.locator(`[data-agency-tab="${profile.id}"]`).click();
    assert.ok((await page.locator('#agency-rule-details').innerText()).includes(profile.entryDescription));
    assert.ok((await page.locator('#agency-rule-details').innerText()).includes(profile.exitDescription));
  }
  await page.locator('[data-agency-tab="swing"]').click();
  await page.locator('#agency-transfer-amount').fill('200000'); await page.locator('#agency-transfer-form button').click();
  const funded = await waitState(s => group(s).cash === 20000000);
  assert.equal(funded.account.cash, initial.account.cash); assert.equal(funded.agency.manualCash, initial.account.cash - 20000000);
  checks.push('UI funding transfers 200,000 yuan into the strategy ledger without creating account capital');
  assert.equal(fs.readFileSync(path.join(accountPath, 'agency-model.json'), 'utf8'), obsoleteSettings);
  checks.push('fixed rules require no model/key/settings; even an invalid legacy model file is ignored and unchanged; old model IPC is unavailable');
  await add('sh600519'); await settle();
  assert.equal((await call('state')).account.trades.length, 0, 'paused group does not open a position');
  await chooseMode('running');
  const bought = await waitState(s => s.account.trades.some(t => t.owner === 'swing' && t.side === 'buy'));
  await settle();
  assert.equal(bought.account.trades.length, 1); assert.equal(group(bought).completedCycles, 0); assert.equal(group(bought).cycles.length, 1);
  assert.equal(bought.account.trades[0].strategyId, 'swing'); assert.ok(bought.account.trades[0].decisionId);
  assert.ok(bought.agency.decisions.some(d => d.symbol === 'sh600519' && d.status === 'executed'));
  await page.waitForFunction(() => document.querySelector('#agency-metrics').textContent.includes('0 个完整交易轮次'));
  assert.ok(bought.agency.decisions.some(d => d.status === 'executed' && d.decisionSource === 'rules'));
  await page.waitForFunction(() => document.querySelector('#agency-decisions').textContent.includes('实际模拟成交'));
  const fillLog = page.locator('.agency-decision').filter({ hasText: '实际模拟成交' }).first();
  await fillLog.locator('summary').click();
  assert.ok((await fillLog.innerText()).includes('执行前复核依据'));
  assert.ok((await fillLog.innerText()).includes('仓位上限'));
  await fillLog.screenshot({ path: path.join(output, 'agency-rule-fill.png') });
  checks.push('enabling the strategy automatically buys through fixed rules, execution revalidation, IPC and account persistence; open cycle is not counted as completed');
  await chooseMode('paused'); await add('sh600036'); await settle();
  assert.equal((await call('state')).account.trades.filter(t => t.side === 'buy').length, 1);
  await page.locator('[data-agency-member="remove"][data-agency-symbol="sh600036"]').click();
  await waitState(s => !group(s).members.some(m => m.symbol === 'sh600036'));
  await page.locator('[data-agency-member="remove"][data-agency-symbol="sh600519"]').click();
  const removing = await waitState(s => group(s).members.find(m => m.symbol === 'sh600519')?.mode === 'removing');
  assert.equal(group(removing).positions.length, 1);
  checks.push('pause prevents new entries; removing an empty member is immediate while removing a held stock keeps its exit management');
  for (const [width, height] of [[1120,760],[1536,980]]) {
    await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width,height]);
    await page.waitForTimeout(150); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `agency-${width}.png`), fullPage: true });
  }
  await desktop.close(); desktop = null; await launch(); await settle();
  const restored = await call('state'); assert.equal(restored.account.trades.length, 1); assert.equal(group(restored).mode, 'paused');
  assert.equal(group(restored).members[0].mode, 'removing'); assert.equal(restored.agency.runtime.decisionMode, 'rules');
  assert.equal(fs.readFileSync(path.join(accountPath, 'agency-model.json'), 'utf8'), obsoleteSettings);
  checks.push('restart restores funding, ownership and paused/removing state without a duplicate buy or model access');
  await page.locator('[data-agency-member="close"][data-agency-symbol="sh600519"]').click(); await page.locator('#confirm-ok').click();
  await call('refresh');
  const closePending = await waitState(s => s.account.risks.sh600519?.pendingExit === '用户要求尽快平仓');
  assert.equal(closePending.account.trades.length, 1); assert.match(closePending.account.risks.sh600519.note, /T\+1/);
  scenario({ now: '2026-09-30T10:00:00+08:00', advanceDaily: true });
  await call('refresh'); await sleep(200); await call('refresh');
  const exited = await waitState(s => s.account.trades.some(t => t.owner === 'swing' && t.side === 'sell'));
  assert.equal(group(exited).positions.length, 0); assert.equal(group(exited).members.length, 0); assert.equal(group(exited).completedCycles, 1);
  assert.equal(exited.account.trades[1].owner, 'swing');
  checks.push('close request latches under T+1, then executes on next valid trading day; completed cycle and member removal persist');
  await settle();
  scenario({ price: 9.8, now: '2026-09-30T10:02:00+08:00' });
  await add('sh600036'); await settle(); const beforeWaiting = await call('state');
  await chooseMode('running');
  await settle();
  const waiting = await call('state');
  assert.equal(waiting.account.trades.length, beforeWaiting.account.trades.length); assert.equal(group(waiting).cash, group(beforeWaiting).cash);
  assert.ok(waiting.agency.decisions.some(d => d.symbol === 'sh600036' && ['waiting', 'blocked'].includes(d.status)));
  await page.screenshot({ path: path.join(output, 'agency-rule-wait.png'), fullPage: true });
  checks.push('an enabled group waits when price/entry rules fail, leaving trades and cash unchanged and recording the reason');
  scenario({ companyAction: true, now: '2026-09-30T10:03:00+08:00' });
  await call('detail', { symbol: 'sh600036', force: true }); await sleep(100); await call('agency:run', { strategyId: 'swing' });
  const pending = await waitState(s => group(s).comparable === true && group(s).members[0]?.reconciliation.status === 'pending');
  assert.equal(pending.account.trades.length, 2);
  assert.equal(group(pending).positions.length, 0, 'an unheld candidate exception does not invalidate group equity');
  await page.locator('[data-agency-reconcile="sh600036"]').click();
  await page.locator('#agency-reconcile-manual summary').click();
  assert.equal(await page.locator('#agency-reconcile-kind').inputValue(), '');
  await page.locator('#agency-reconcile-kind').selectOption('event');
  assert.equal(await page.locator('#agency-reconcile-riskPriceFactor').inputValue(), '');
  assert.equal(await page.locator('#agency-reconcile-riskPriceFactor').getAttribute('required'), '');
  await page.screenshot({ path: path.join(output, 'agency-reconciliation.png') });
  await page.locator('#agency-reconcile-cancel').click();
  assert.equal(group(await call('state')).comparable, true);
  assert.equal(group(await call('state')).members[0].reconciliation.status, 'pending');
  checks.push('company-action exception on an unheld candidate blocks that stock while preserving valid group equity; manual fallback requires an explicit conclusion and factor, closing never clears the block');
  assert.deepEqual(errors, []);
  let final = await call('state'); assert.equal(JSON.stringify(final).includes(obsoleteSettings), false);
  assert.equal(final.account.cash, final.agency.manualCash + final.agency.groups.reduce((sum,g) => sum + g.cash,0));
  await settle(); await desktop.close(); desktop = null;
  const accountFile = path.join(accountPath, 'account.json');
  assert.equal(path.dirname(path.dirname(accountFile)), output);
  const legacy = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
  delete legacy.agency.decisionMode; delete legacy.agency.rulesVersion;
  legacy.agency.groups.find(g => g.id === 'short').mode = 'running';
  legacy.agency.groups.find(g => g.id === 'long').mode = 'stopped';
  legacy.agency.decisions.push({ strategyId: 'swing', model: 'legacy-fixture', action: 'wait', status: 'waiting', message: '历史模型测试记录，保留原来源' });
  fs.writeFileSync(accountFile, JSON.stringify(legacy, null, 2));
  await launch(); await settle();
  const migrated = await call('state');
  assert.equal(group(migrated).mode, 'paused'); assert.equal(group(migrated, 'short').mode, 'paused');
  assert.equal(group(migrated, 'long').mode, 'stopped');
  assert.equal(migrated.account.cash, legacy.cash); assert.deepEqual(migrated.account.trades, legacy.trades);
  assert.equal(migrated.account.agency.decisionMode, 'rules');
  const backups = fs.readdirSync(accountPath).filter(name => /^account-backup-.*\.json$/.test(name));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(accountPath, backups[0]), 'utf8')), legacy);
  await page.waitForSelector('#agency-migration:not(.hidden)');
  assert.ok((await page.locator('#agency-decisions').innerText()).includes('历史模型决策'));
  await page.screenshot({ path: path.join(output, 'agency-migration.png'), fullPage: true });
  await page.locator('#agency-migration-dismiss').click();
  await call('agency:mode', { strategyId: 'short', mode: 'running' }); await settle();
  await desktop.close(); desktop = null; await launch(); await settle();
  final = await call('state');
  assert.equal(group(final, 'short').mode, 'running'); assert.equal(await page.locator('#agency-migration').isVisible(), false);
  assert.equal(fs.readdirSync(accountPath).filter(name => /^account-backup-.*\.json$/.test(name)).length, 1);
  assert.equal(fs.readFileSync(path.join(accountPath, 'agency-model.json'), 'utf8'), obsoleteSettings);
  checks.push('legacy model accounts receive an exact pre-upgrade backup and one-time entry pause; old decisions retain their source; re-enabling survives restart and dismissal persists');
  assert.deepEqual(errors, []);
  const unexpectedNetworkRequests = fs.existsSync(networkLog) ? fs.readFileSync(networkLog,'utf8').trim().split('\n').length : 0;
  assert.equal(unexpectedNetworkRequests, 0);
  const report = { output, accountPath, errors, checks, tradeCount: final.account.trades.length, completedCycles: group(final).completedCycles, unexpectedNetworkRequests };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
})().catch(async error => {
  console.error(error); console.error('Output:', output);
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output,'failed.png'), fullPage:true }).catch(()=>{}); }
  process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
