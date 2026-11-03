'use strict';
// Packaged source integrity and hidden desktop smoke using a fresh, paused
// account. A refused loopback proxy blocks startup traffic before net is stubbed.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const asar = require('@electron/asar');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { INDEX_CATALOG } = require('../core/index-market.cjs');
const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.env.GUANLAN_PACKAGE_EXE || path.join(root, 'work/index-board-final-build/win-unpacked/Guanlan.exe'));
const archive = path.join(path.dirname(executable), 'resources/app.asar');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/index-package-'));
const dataPath = path.join(output, 'account'), fixture = path.join(output, 'network-fixture.cjs');
const logPath = path.join(output, 'intercepted-network.jsonl');
assert.equal(path.dirname(output), path.join(root, 'work'));
fs.mkdirSync(dataPath);
const engine = new Engine(initialState(10000)); engine.s.watchlist = []; engine.s.settings.refreshSeconds = 60;
for (const group of engine.s.agency.groups) engine.agencyMode({ strategyId: group.id, mode: 'paused' });
assert.equal(validState(engine.s), true);
const original = structuredClone(engine.s);
fs.writeFileSync(path.join(dataPath, 'account.json'), JSON.stringify(original, null, 2));
fs.writeFileSync(fixture, `
const fs = require('node:fs');
module.exports = ({ app, net, session, BrowserWindow }, config) => {
  const hide = win => { win.webContents.setBackgroundThrottling(false); win.hide(); win.on('show', () => win.hide()); };
  app.on('browser-window-created', (_event, win) => hide(win));
  for (const win of BrowserWindow.getAllWindows()) hide(win);
  net.fetch = async (input, options = {}) => {
    options.signal?.throwIfAborted();
    const url = new URL(String(input));
    const allowed = url.hostname === 'push2.eastmoney.com' && url.pathname === '/api/qt/ulist.np/get';
    const requested = (url.searchParams.get('secids') || '').split(',');
    const matched = allowed && requested.length === config.catalog.length && config.catalog.every(item => requested.includes(item.eastmoney));
    fs.appendFileSync(config.logPath, JSON.stringify({ url: String(url), mockedIndices: matched, at: Date.now() }) + '\\n');
    if (matched) return new Response(JSON.stringify({ rc: 0, data: { diff: config.catalog.map((item, index) => {
      const [market, code] = item.eastmoney.split('.'), price = 3000 + index * 100 + 0.25, prevClose = price - 10;
      return { f12: code, f13: Number(market), f14: item.name, f2: price, f3: 10 / prevClose * 100,
        f4: 10, f15: price + 5, f16: prevClose - 5, f17: prevClose, f18: prevClose, f124: Math.floor(Date.now() / 1000) - 60 };
    }) } }), { headers: { 'content-type': 'application/json' } });
    return new Response('Isolated packaged index smoke: upstream unavailable; no network request made', { status: 503 });
  };
  globalThis.fetch = net.fetch;
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^(https?|wss?):/.test(details.url) });
  }));
};
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('GUANLAN_TEST_')) delete env[key];
const comparedFiles = ['main.cjs', 'preload.cjs', 'core/index-market.cjs',
  'ui/index.html', 'ui/app.js', 'ui/market-indices.js', 'ui/market-indices.css', 'ui/market-search.js', 'ui/style.css'];
const report = { status: 'running', output, executable, archive, dataPath, comparedFiles, checks: [], errors: [], failedLocalResources: [] };
let desktop, page;
const requests = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function call(name, payload) {
  return page.evaluate(async ({ name, payload }) => {
    const result = await window.guanlan.call(name, payload);
    if (!result.ok) throw Error(result.error); return result.data;
  }, { name, payload });
}
function unchanged(current) {
  assert.equal(path.resolve(current.dataPath), dataPath);
  assert.equal(current.account.createdAt, original.createdAt);
  assert.equal(current.account.cash, original.cash);
  for (const key of ['watchlist', 'orders', 'trades', 'lots']) assert.deepEqual(current.account[key], original[key]);
  assert.deepEqual(current.account.agency.transfers, original.agency.transfers);
  assert.ok(current.agency.groups.every(group => group.mode === 'paused' && group.cash === 0 && group.members.length === 0));
}
(async () => {
  assert.ok(fs.existsSync(executable)); assert.ok(fs.existsSync(archive));
  const bundledManifest = JSON.parse(asar.extractFile(archive, 'package.json')), sourceManifest = require('../package.json');
  for (const field of ['name', 'version', 'main', 'dependencies']) assert.deepEqual(bundledManifest[field], sourceManifest[field], `package manifest mismatch: ${field}`);
  for (const file of comparedFiles) assert.ok(asar.extractFile(archive, path.normalize(file)).equals(fs.readFileSync(path.join(root, file))), `package/source mismatch: ${file}`);
  report.checks.push('Nine packaged source files match the workspace byte for byte; the builder-normalized manifest preserves version, entry point, name and runtime dependencies.');
  desktop = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${dataPath}`,
    '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND',
    '--disable-quic', '--disable-background-networking'], cwd: root, env, timeout: 45000 });
  report.launch = await desktop.evaluate(({ app, net, session, BrowserWindow }, config) => {
    process.mainModule.require(config.fixture)({ app, net, session, BrowserWindow }, config);
    return { appPath: app.getAppPath(), userData: app.getPath('userData'), version: app.getVersion(), packaged: app.isPackaged };
  }, { fixture, logPath, catalog: INDEX_CATALOG });
  assert.equal(path.resolve(report.launch.appPath), archive);
  assert.equal(path.resolve(report.launch.userData), dataPath); assert.equal(report.launch.packaged, true);
  page = await desktop.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('requestfailed', request => { if (request.url().startsWith('file:')) report.failedLocalResources.push(request.url()); });
  // Timer polling also works when the hidden window suspends animation frames.
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4, null, { polling: 100 });
  unchanged(await call('state'));
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win => win.isVisible())), false);
  await page.locator('[data-page="market"]').dispatchEvent('click');
  await page.waitForFunction(() => document.querySelectorAll('#index-board [data-index-id]').length === 22 && !indexUi.busy, null, { polling: 100 });
  assert.equal(await page.locator('#market-index-panel').isVisible(), true);
  assert.equal(await page.locator('#market-stock-panel').isVisible(), false);
  assert.equal(await page.evaluate(() => selected), '');
  assert.equal(await page.locator('#index-board [data-index-status="ok"]').count(), 22);
  assert.match(await page.locator('[data-index-id="cn-shanghai"]').innerText(), /3,?000\.25/);
  assert.match(await page.locator('#index-board').innerText(), /东方财富/);
  assert.doesNotMatch(await page.locator('#index-board').innerHTML(), /NaN|Infinity/);
  report.checks.push('The packaged app opens the correct isolated account, remains hidden and displays all 22 indices through the real parser, IPC and renderer.');
  const groupCounts = { cn: 8, hk: 2, us: 4, asia: 4, europe: 4 };
  for (const [group, count] of Object.entries(groupCounts)) {
    await page.locator(`[data-index-group="${group}"]`).dispatchEvent('click');
    assert.equal(await page.locator('#index-board [data-index-id]').count(), count);
  }
  await page.locator('[data-index-group="all"]').dispatchEvent('click');
  const beforeRefresh = requests().filter(request => request.mockedIndices).length;
  await page.locator('#index-refresh').dispatchEvent('click');
  await page.waitForFunction(() => !indexUi.busy && document.querySelectorAll('#index-board [data-index-status="ok"]').length === 22, null, { polling: 100 });
  assert.ok(requests().filter(request => request.mockedIndices).length > beforeRefresh);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  report.screenshot = path.join(output, 'packaged-index-overview.png');
  // Playwright's full-page screenshot waits on animation frames in a hidden
  // window; Electron can capture the current viewport without showing it.
  const screenshot = await desktop.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    return image.toPNG().toString('base64');
  });
  fs.writeFileSync(report.screenshot, Buffer.from(screenshot, 'base64'));
  const current = await call('state'); unchanged(current);
  assert.deepEqual(report.errors, []); assert.deepEqual(report.failedLocalResources, []);
  report.checks.push('Region filters and forced refresh work; cash, holdings, trades, orders, strategy modes and member lists are unchanged, with no renderer or local-resource errors.');
  report.account = { cash: current.account.cash, trades: current.account.trades.length, orders: current.account.orders.length,
    lots: current.account.lots.length, strategyModes: current.agency.groups.map(group => group.mode) };
  report.mockedIndexRequests = requests().filter(request => request.mockedIndices).length;
  report.blockedOtherRequests = requests().filter(request => !request.mockedIndices).length;
  report.network = 'Refused loopback proxy and DNS block from startup; net.fetch serves only the synthetic 22-index batch, all other requests receive local HTTP 503.';
  report.limitations = ['This checks the unpacked packaged executable; the portable self-extracting wrapper is not exercised.'];
  report.status = 'passed';
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  report.status = 'failed'; report.error = error.stack;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error(error); console.error(output); process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
