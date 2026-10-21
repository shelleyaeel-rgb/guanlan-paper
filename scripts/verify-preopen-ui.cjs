// Exercise the real automatic refresh timer across a pre-open HTTP 501 recovery.
// Provider clock is controlled, while the Electron timer/IPC/renderer are real.
'use strict';
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const { STRATEGY_PROFILES } = require('../core/strategy-profiles.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/preopen-ui-'));
const accountPath = path.join(output, 'account'), control = path.join(output, 'control.json');
const sourceLog = path.join(output, 'sources.jsonl'), networkLog = path.join(output, 'network.jsonl');
const scenario = { now: '2026-09-29T09:28:00+08:00', price: 10.17, historyMode: 'offline',
  financeMode: 'ready', valuationMode: 'ready', corporateMode: 'empty' };
const update = patch => { Object.assign(scenario, patch); fs.writeFileSync(control, JSON.stringify(scenario)); };
const engine = new Engine(initialState(), () => new Date(scenario.now));
engine.s.settings.refreshSeconds = 5; // Smallest supported real timer; service throttles keep production intervals.
engine.s.watchlist = [];
for (const [index, profile] of STRATEGY_PROFILES.entries()) {
  engine.agencyMember({ strategyId: profile.id, symbol: `sh${600001 + index}`, action: 'add' });
}
fs.mkdirSync(accountPath); fs.writeFileSync(path.join(accountPath, 'account.json'), JSON.stringify(engine.s, null, 2)); update({});
const env = { ...process.env, GUANLAN_TEST_CONTROL: control, GUANLAN_TEST_SOURCE_LOG: sourceLog,
  GUANLAN_TEST_NETWORK_LOG: networkLog, GUANLAN_TEST_EXTERNAL_LOG: path.join(output, 'external.jsonl') };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, page; const checks = [], errors = [], screenshots = [], snapshots = {};
const sources = () => fs.existsSync(sourceLog) ? fs.readFileSync(sourceLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const members = state => state.agency.groups.flatMap(group => group.members);
async function current() {
  return page.evaluate(async () => {
    const response = await window.guanlan.call('state');
    if (!response.ok) throw Error(response.error);
    return response.data;
  });
}
async function waitState(predicate, description) {
  const start = Date.now(); let value;
  while (Date.now() - start < 20000) {
    value = await current(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`${description}: ${JSON.stringify({ members: members(value), market: value.agency.runtime.marketRegime, warning: value.warning })}`);
}
function noExecution(value) {
  assert.equal(value.account.orders.length, 0); assert.equal(value.account.trades.length, 0); assert.equal(value.account.lots.length, 0);
}
async function capture(name, selector = '#agency-market-regime') {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const filename = path.join(output, `${name}-1120.png`);
  await page.screenshot({ path: filename }); screenshots.push(filename);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page must fit 1120px');
  const box = await page.locator(selector).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 1120, `${selector} must fit 1120px`);
}

(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'),
    args: [path.join(root, 'tests/fixtures/preopen-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  assert.equal(path.resolve((await current()).dataPath), accountPath);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 800));
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.locator('[data-page="agency"]').click();
  snapshots.failed = await waitState(value => members(value).every(member => member.automaticCheck?.reason?.includes('HTTP 501'))
    && value.agency.runtime.marketRegime.acquisition?.stage === 'failed', 'initial pre-open 501');
  noExecution(snapshots.failed);
  await page.waitForFunction(() => document.querySelector('#agency-market-reason').textContent.includes('HTTP 501'));
  await capture('preopen-http-501');
  assert.equal(sources().filter(item => item.type === 'breadth').length, 0);
  checks.push('09:28 automatic startup records stock/index HTTP 501 failures, keeps permissions closed, and never requests live breadth');

  // No refresh IPC or retry-button click: the existing interval drives recovery.
  update({ now: '2026-09-29T09:29:01+08:00', historyMode: 'ready' });
  snapshots.prepared = await waitState(value => members(value).every(member => member.automaticCheck?.phase === 'prepared')
    && value.agency.runtime.marketRegime.acquisition?.stage === 'prepared', 'timer recovers historical preparation');
  noExecution(snapshots.prepared);
  assert.equal(snapshots.prepared.agency.runtime.marketRegime.allowEntry, false);
  assert.equal(sources().filter(item => item.type === 'breadth').length, 0);
  for (const member of members(snapshots.prepared)) {
    assert.equal(member.automaticCheck.status, 'waiting'); assert.equal(member.automaticCheck.dailyAsOf, '2026-09-28');
    assert.equal(member.lastVerifiedAt, undefined); assert.equal(member.lastVerifiedDate, undefined);
    assert.equal(member.reconciliation.status, 'clear', 'yesterday quote mismatch must not latch a corporate failure');
  }
  assert.ok(sources().some(item => item.type === 'quotes' && item.now === scenario.now && item.closed && item.timestamp < Date.parse('2026-09-29T00:00:00+08:00')));
  await page.waitForFunction(() => document.querySelector('#agency-market-time').textContent.includes('历史资料准备完成'));
  await capture('preopen-history-prepared');
  for (const profile of STRATEGY_PROFILES) {
    await page.locator(`[data-agency-tab="${profile.id}"]`).click();
    assert.match(await page.locator('#agency-members').innerText(), /盘前资料已准备.*等待开盘核验/);
  }
  await capture('preopen-member-prepared', '#agency-members');
  checks.push('09:29:01 actual refresh timer recovers all four strategies without manual verification; historical preparation uses no prior-session price reference');

  update({ now: '2026-09-29T09:30:00+08:00' });
  snapshots.open = await waitState(value => members(value).every(member => member.automaticCheck?.status === 'clear')
    && value.agency.runtime.marketRegime.acquisition?.stage === 'complete', 'opening session automatically verifies live evidence');
  noExecution(snapshots.open);
  assert.equal(snapshots.open.agency.runtime.marketRegime.status, 'unknown');
  assert.equal(snapshots.open.agency.runtime.marketRegime.allowEntry, false);
  assert.match(snapshots.open.agency.runtime.marketRegime.reason, /等待持续确认/);
  assert.equal(snapshots.open.agency.runtime.marketRegime.evidence.confirmation.firstQuoteTime, Date.parse(scenario.now));
  assert.ok(members(snapshots.open).every(member => member.lastVerifiedDate === '2026-09-29'));
  assert.equal(sources().filter(item => item.type === 'breadth').length, 1);
  await page.waitForFunction(() => document.querySelector('#agency-market-reason').textContent.includes('等待持续确认'));
  await capture('opening-awaiting-confirmation');
  checks.push('09:30 session change bypasses the five-minute preparation cadence, checks same-day prices and begins live breadth confirmation automatically');

  update({ now: '2026-09-29T09:31:00+08:00' });
  snapshots.oneMinute = await waitState(value => value.agency.runtime.marketRegime.evidence?.confirmation?.lastQuoteTime === Date.parse(scenario.now), 'second sample after one minute');
  assert.equal(snapshots.oneMinute.agency.runtime.marketRegime.allowEntry, false);
  update({ now: '2026-09-29T09:32:00+08:00' });
  snapshots.confirmed = await waitState(value => value.agency.runtime.marketRegime.status === 'strong'
    && value.agency.runtime.marketRegime.allowEntry === true, 'confirmation after two minutes');
  noExecution(snapshots.confirmed);
  assert.ok(snapshots.confirmed.agency.runtime.marketRegime.evidence.confirmation.lastQuoteTime
    - snapshots.confirmed.agency.runtime.marketRegime.evidence.confirmation.firstQuoteTime >= 120000);
  await page.waitForFunction(() => document.querySelector('#agency-market-badge').textContent.includes('正常风险预算'));
  await capture('market-confirmed-after-two-minutes');
  checks.push('09:31 still blocks entry; only distinct evidence spanning 120 seconds at 09:32 restores market permission');
  assert.deepEqual(errors, []);
  assert.equal(sources().filter(item => item.type === 'ipc' && ['refresh', 'agency:verify'].includes(item.name)).length, 0);
  assert.ok(sources().filter(item => ['strategy-history', 'index-history', 'breadth'].includes(item.type)).every(item => !item.force));
  assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8').trim() : '', '');
  const report = { passed: true, output, checks, screenshots, errors, snapshots, sourceCalls: sources(),
    isolation: { accountPath, unexpectedNetworkRequests: 0, manualRefreshOrVerificationCalls: 0, orders: 0, trades: 0, lots: 0 } };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, output, checks, screenshots }, null, 2));
})().catch(async error => {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, output, checks, screenshots, errors, snapshots, error: error.stack }, null, 2));
  console.error(error); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
