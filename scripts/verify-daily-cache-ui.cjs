// Renderer-only verification with synthetic, paused accounts. Production IPC is
// never loaded, all network is blocked, and each run gets a fresh Electron profile.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Engine, initialState } = require('../core/engine.cjs');
const { STRATEGY_PROFILES } = require('../core/strategy-profiles.cjs');

const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/daily-cache-ui-'));
const now = Date.parse('2026-10-22T10:05:00+08:00');
const fetchedAt = Date.parse('2026-10-21T16:05:00+08:00');
const symbol = 'sh600001';
const engine = new Engine(initialState(), () => new Date(now));
engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' });
engine.s.watchlist = [symbol];
const state = { account: engine.s, stats: engine.stats(), quotes: {}, signals: {}, planSelections: {}, strategyProfiles: STRATEGY_PROFILES,
  agency: { ...engine.agencyState(), marketPolicy: { version: 1, enabled: true }, runtime: {
    decisionMode: 'rules', rulesVersion: '1', intervalSeconds: 300, runningGroups: [], online: true,
    session: { open: true, known: true, label: '隔离测试时段' }
  } }, connection: { ok: true, at: now, message: '隔离测试数据', sources: ['本地合成数据'] },
  session: { open: true, label: '隔离测试时段' }, now, date: '2026-10-22', dataPath: output };
const history = { asOf: '2026-10-21', fetchedAt, status: 'degraded', refreshError: '行情服务 HTTP 501（隔离测试）', cacheWarning: '' };
state.signals[symbol] = { symbol, strategyId: 'swing', status: '等待买点', buyable: false, reasons: ['实时条件尚未满足'], dailyHistory: history, quantity: 0 };
const member = state.agency.groups.find(group => group.id === 'swing').members.find(item => item.symbol === symbol);
member.automaticCheck = { status: 'clear', checkedAt: now, reason: '限定公告窗口与价格基准已检查', dailyHistory: history };
member.corporateVerification = { status: 'clear', checkedAt: now };
member.reconciliation = { status: 'clear' }; member.awaitingVerification = false; member.lastVerifiedAt = now;
state.agency.runtime.marketRegime = { version: 1, policyVersion: 1, date: '2026-10-22', status: 'unknown', label: '待核验',
  riskMultiplier: 0, allowEntry: false, allowBreakout: false, checkedAt: now, expiresAt: now + 90000,
  reason: '改善等待持续确认', metrics: { indices: ['sh000001', 'sz399001', 'sz399006'].map(index => ({
    symbol: index, asOf: history.asOf, dailyHistory: history, quoteTime: now, trend: 'up', ma20Slope5: 0.003, atrRatio: 0.012
  })) } };

const entry = path.join(output, 'renderer.cjs');
fs.writeFileSync(entry, `
const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(output, 'isolated-profile'))});
app.disableHardwareAcceleration();
global.blockedNetwork = [];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const blocked = /^https?:/.test(details.url);
    if (blocked) global.blockedNetwork.push(details.url);
    callback({ cancel: blocked });
  });
  const win = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: {
    preload: ${JSON.stringify(path.join(root, 'tests/fixtures/market-regime-ui-preload.cjs'))},
    contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true
  } });
  await win.loadFile(${JSON.stringify(path.join(root, 'ui/index.html'))});
});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
const checks = [], screenshots = [], errors = [];
async function capture(name, selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const filename = path.join(output, `${name}.png`);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  fs.writeFileSync(filename, Buffer.from(png, 'base64')); screenshots.push(filename);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
async function setHistory(patch) {
  await page.evaluate(({ symbol, patch }) => {
    const history = { ...state.signals[symbol].dailyHistory, ...patch };
    state.signals[symbol].dailyHistory = history;
    state.agency.groups.find(group => group.id === 'swing').members[0].automaticCheck.dailyHistory = history;
    for (const index of state.agency.runtime.marketRegime.metrics.indices) index.dailyHistory = history;
    renderState(state);
  }, { symbol, patch });
}

(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [entry], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof renderState === 'function' && typeof renderAgency === 'function');
  await page.evaluate(({ snapshot, symbol }) => { selected = symbol; agencyUi.strategyId = 'swing'; renderState(snapshot); }, { snapshot: state, symbol });
  const plan = await page.locator('#strategy-content').innerText();
  assert.match(plan, /刷新失败，继续使用有效日线缓存/);
  assert.match(plan, /完整日线截至 2026-10-21 · 原始获取 2026\/10\/21 16:05:00/);
  assert.match(plan, /HTTP 501/); assert.match(plan, /实时条件尚未满足/);
  assert.equal(await page.locator('#strategy-buy').isDisabled(), true);
  await capture('strategy-retained-cache', '#strategy-content');
  checks.push('strategy retains original acquisition time and displays refresh failure alongside unchanged entry restrictions');

  await page.locator('[data-page="agency"]').click();
  const members = await page.locator('#agency-members').innerText();
  assert.match(members, /价格与公司行为：通过/); assert.match(members, /刷新失败，继续使用有效日线缓存/);
  assert.match(members, /原始获取 2026\/10\/21 16:05:00/);
  await capture('members-retained-cache', '#agency-members');
  await page.locator('[data-agency-reconcile="sh600001"]').click();
  assert.match(await page.locator('#agency-reconcile-daily').innerText(), /HTTP 501/);
  assert.match(await page.locator('#agency-reconcile-daily').innerText(), /原始获取 2026\/10\/21 16:05:00/);
  await capture('reconcile-retained-cache', '#agency-reconcile-dialog');
  await page.evaluate(() => $('agency-reconcile-dialog').close());
  checks.push('member row and actual verification dialog show retained data and the failure separately from corporate verification');

  await page.locator('#agency-market-regime details summary').click();
  assert.equal(await page.locator('#agency-market-indices [data-daily-status="degraded"]').count(), 3);
  assert.match(await page.locator('#agency-market-badge').innerText(), /暂停新开仓/);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 850));
  await page.setViewportSize({ width: 1120, height: 850 });
  await capture('indices-retained-cache-1120', '#agency-market-regime');
  const summary = await page.evaluate(() => agencyVerificationSummary({ summary: { checked: 4, clear: 4, waiting: 0, blocked: 0, cached: 3, degraded: 2 }, marketRegime: state.agency.runtime.marketRegime }));
  assert.match(summary, /复用有效日线 3 只（其中刷新失败 2 只）/);
  assert.match(summary, /市场环境：待核验（暂停新开仓）/);
  checks.push('all index sources and aggregate verification preserve failure visibility without granting market permission');

  for (const [status, label] of [['cached', '有效日线已缓存'], ['refreshing', '正在刷新完整日线'], ['fresh', '完整日线已获取']]) {
    await setHistory({ status, refreshError: '', cacheWarning: '' });
    assert.match(await page.locator('#agency-members').innerText(), new RegExp(label));
    assert.doesNotMatch(await page.locator('#agency-members').innerText(), /HTTP 501/);
  }
  await setHistory({ status: 'cached', cacheWarning: '缓存写入失败，当前进程保留有效日线' });
  assert.match(await page.locator('#agency-members').innerText(), /缓存写入失败/);
  await capture('cache-persistence-warning-1120', '#agency-members');
  checks.push('cached, refreshing and recovered states have distinct labels; successful recovery clears stale transport errors; persistence warnings remain visible');

  const final = await page.evaluate(() => ({ orders: state.account.orders.length, trades: state.account.trades.length,
    lots: state.account.lots.length, modes: state.agency.groups.map(group => group.mode), marketPermission: state.agency.runtime.marketRegime.allowEntry }));
  assert.equal(final.orders, 0); assert.equal(final.trades, 0); assert.equal(final.lots, 0);
  assert.ok(final.modes.every(mode => mode === 'paused')); assert.equal(final.marketPermission, false);
  assert.deepEqual(errors, []);
  const blockedNetwork = await desktop.evaluate(() => global.blockedNetwork);
  assert.deepEqual(blockedNetwork, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, output, checks, screenshots, errors, blockedNetwork, final }, null, 2));
  console.log(JSON.stringify({ passed: true, output, checks, screenshots }, null, 2));
})().catch(async error => {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, output, checks, screenshots, errors, error: error.stack }, null, 2));
  console.error(error); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
