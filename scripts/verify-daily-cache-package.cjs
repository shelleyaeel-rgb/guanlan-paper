// Real main-process startup/IPC/cache persistence smoke. This creates an empty,
// paused account under work/, stubs net.fetch, and never submits an order.
// Optional: GUANLAN_PACKAGE_EXE points at a built win-unpacked/Guanlan.exe.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { expectedDailyDate, preparedHistoryValid } = require('../core/daily-history.cjs');
const { DailyHistoryStore } = require('../core/daily-history-store.cjs');

const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/daily-cache-package-'));
const dataPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const logPath = path.join(output, 'intercepted-network.jsonl');
const symbol = 'sh600001', asOf = expectedDailyDate(Date.now());
const dates = [], cursor = new Date(`${asOf}T00:00:00Z`);
while (dates.length < 121) {
  if (![0, 6].includes(cursor.getUTCDay())) dates.unshift(cursor.toISOString().slice(0, 10));
  cursor.setUTCDate(cursor.getUTCDate() - 1);
}
const bars = dates.map((date, index) => {
  const close = +(10 + index * 0.01).toFixed(2);
  return [date, close.toFixed(2), close.toFixed(2), (close + .1).toFixed(2), (close - .1).toFixed(2), '10000'];
});
fs.mkdirSync(dataPath);
const engine = new Engine(initialState()); engine.s.watchlist = [symbol]; engine.s.settings.refreshSeconds = 60;
for (const group of engine.s.agency.groups) engine.agencyMode({ strategyId: group.id, mode: 'paused' });
assert.equal(validState(engine.s), true);
fs.writeFileSync(path.join(dataPath, 'account.json'), JSON.stringify(engine.s, null, 2));
const original = structuredClone(engine.s);
const update = mode => fs.writeFileSync(controlPath, JSON.stringify({ mode, bars }));
update('ready');
const fixture = path.join(output, 'network-fixture.cjs'), bootstrap = path.join(output, 'bootstrap.cjs');
fs.writeFileSync(fixture, `
const fs = require('node:fs');
module.exports = ({ app, net, session }, config) => {
  net.fetch = async (input, options = {}) => {
    options.signal?.throwIfAborted();
    const url = new URL(String(input)), scenario = JSON.parse(fs.readFileSync(config.controlPath, 'utf8'));
    fs.appendFileSync(config.logPath, JSON.stringify({ url: String(url), mode: scenario.mode, at: Date.now() }) + '\\n');
    if (scenario.mode === 'ready' && url.pathname.endsWith('/fqkline/get')) {
      const symbol = url.searchParams.get('param')?.split(',')[0];
      if (/^(sh|sz)\\d{6}$/.test(symbol || '')) return new Response(JSON.stringify({ code: 0, data: {
        [symbol]: { day: scenario.bars, qfqday: scenario.bars }
      } }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('Isolated fixture: upstream unavailable; no network request made', { status: scenario.mode === 'offline' ? 501 : 503 });
  };
  app.on('browser-window-created', (_event, win) => win.hide());
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) });
  }));
};
`);
fs.writeFileSync(bootstrap, `
require(${JSON.stringify(fixture)})(require('electron'), ${JSON.stringify({ controlPath, logPath })});
require(${JSON.stringify(path.join(root, 'main.cjs'))});
`);

const packaged = !!process.env.GUANLAN_PACKAGE_EXE;
const executable = packaged ? path.resolve(process.env.GUANLAN_PACKAGE_EXE) : require('electron');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('GUANLAN_TEST_')) delete env[key];
const checks = [], errors = [], launches = [];
let desktop, page;
async function call(name, payload, allowFailure = false) {
  const response = await page.evaluate(({ name, payload }) => window.guanlan.call(name, payload), { name, payload });
  if (!response.ok && !allowFailure) throw Error(`${name}: ${response.error}`);
  return allowFailure ? response : response.data;
}
function unchanged(current) {
  assert.equal(path.resolve(current.dataPath), path.resolve(dataPath));
  assert.equal(current.account.cash, original.cash);
  assert.deepEqual(current.account.orders, original.orders); assert.deepEqual(current.account.trades, original.trades);
  assert.deepEqual(current.account.lots, original.lots); assert.deepEqual(current.account.agency.transfers, original.agency.transfers);
  assert.ok(current.agency.groups.every(group => group.mode === 'paused'));
  assert.equal(current.signals[symbol]?.buyable, false);
  assert.notEqual(current.agency.runtime.marketRegime?.allowEntry, true);
}
function verifyPackage() {
  if (!packaged) return [];
  const asar = require('@electron/asar'), archive = path.join(path.dirname(executable), 'resources/app.asar');
  const files = ['main.cjs', 'core/daily-history.cjs', 'core/daily-history-cache.cjs', 'core/daily-history-store.cjs',
    'core/market.cjs', 'core/strategy-monitor.cjs', 'core/strategy.cjs', 'core/corporate-service.cjs',
    'core/market-regime.cjs', 'core/market-regime-service.cjs', 'core/agency-service.cjs',
    'core/preparation-state.cjs', 'core/shared-source-job.cjs', 'core/engine.cjs', 'core/screener-sources.cjs',
    'core/stock-universe-source.cjs', 'core/market-breadth-source.cjs',
    'ui/app.js', 'ui/agency.js', 'ui/index.html', 'ui/style.css'];
  for (const file of files) assert.ok(asar.extractFile(archive, path.normalize(file)).equals(fs.readFileSync(path.join(root, file))), `package/source mismatch: ${file}`);
  return files;
}
async function launch() {
  // The refused loopback proxy also covers any packaged startup request before
  // Playwright installs the fixture; no request can reach an upstream provider.
  const networkArgs = ['--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>'];
  desktop = await _electron.launch({ executablePath: executable,
    args: packaged ? [`--user-data-dir=${dataPath}`, ...networkArgs] : [bootstrap, `--test-data-dir=${dataPath}`, ...networkArgs], cwd: root, env, timeout: 60000 });
  const info = await desktop.evaluate(({ app, net, session, BrowserWindow }, config) => {
    process.mainModule.require(config.fixture)({ app, net, session }, config);
    for (const win of BrowserWindow.getAllWindows()) win.hide();
    return { appPath: app.getAppPath(), userData: app.getPath('userData'), version: app.getVersion() };
  }, { fixture, controlPath, logPath });
  assert.equal(path.resolve(info.userData), path.resolve(dataPath)); launches.push(info);
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  // Hidden Electron windows may suspend animation frames; poll state by timer.
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account, null, { polling: 100 });
  await call('refresh');
  // Real detail IPC forces the strategy monitor even when every quote/notice
  // source is unavailable. The chart itself may fail in the offline phase.
  await call('detail', { symbol, force: true }, true);
  await page.waitForFunction(symbol => !!state.signals?.[symbol]?.dailyHistory, symbol, { timeout: 30000, polling: 100 });
  return call('state');
}
async function close() { if (desktop) { await desktop.close(); desktop = null; page = null; } }

(async () => {
  const comparedFiles = verifyPackage();
  let current = await launch(); unchanged(current);
  const dailyDirectory = path.join(dataPath, 'daily-history'), store = new DailyHistoryStore(dailyDirectory);
  const first = current.signals[symbol].dailyHistory;
  assert.equal(first.asOf, asOf); assert.ok(['fresh', 'cached'].includes(first.status));
  assert.ok(first.fetchedAt > Date.parse(original.createdAt) - 60000); assert.equal(first.refreshError, '');
  assert.equal(preparedHistoryValid(store.read(`stock:${symbol}`), symbol, 'stock', Date.now()), true);
  assert.equal(store.read(`stock:${symbol}`).fetchedAt, first.fetchedAt);
  const savedFile = store.fileFor(`stock:${symbol}`), saved = fs.readFileSync(savedFile);
  checks.push('real main creates daily-history in the isolated profile, persists checked raw daily bars, and exposes original acquisition time through state IPC');

  update('offline');
  const chartFailure = await call('detail', { symbol, force: true }, true);
  assert.equal(chartFailure.ok, true);
  assert.deepEqual(chartFailure.data.bars, []); assert.match(chartFailure.data.dailyError, /501/);
  assert.equal(chartFailure.data.minute, null); assert.ok(chartFailure.data.minuteError);
  assert.ok(chartFailure.data.quoteError);
  await page.waitForFunction(symbol => state.signals?.[symbol]?.dailyHistory?.status === 'degraded', symbol, { timeout: 30000, polling: 100 });
  current = await call('state'); unchanged(current);
  const degraded = current.signals[symbol].dailyHistory;
  assert.equal(degraded.fetchedAt, first.fetchedAt); assert.equal(degraded.asOf, first.asOf); assert.match(degraded.refreshError, /501/);
  assert.ok(fs.readFileSync(savedFile).equals(saved));
  checks.push('forced refresh returns HTTP 501 while valid daily data and its timestamp survive; the failed request does not replace the persisted series or allow entry');

  await close();
  current = await launch(); unchanged(current);
  await page.waitForFunction(symbol => state.signals?.[symbol]?.dailyHistory?.status === 'degraded', symbol, { timeout: 30000, polling: 100 });
  current = await call('state'); unchanged(current);
  const restored = current.signals[symbol].dailyHistory;
  assert.equal(restored.fetchedAt, first.fetchedAt); assert.equal(restored.asOf, first.asOf); assert.match(restored.refreshError, /501/);
  assert.ok(fs.readFileSync(savedFile).equals(saved));
  checks.push('restart of the same isolated profile with every upstream unavailable restores persisted data through real main wiring and preserves original timestamps and permission restrictions');
  assert.deepEqual(errors, []);
  const requests = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(requests.some(item => item.mode === 'ready' && item.url.includes('/fqkline/get')));
  assert.ok(requests.some(item => item.mode === 'offline' && item.url.includes('/fqkline/get')));
  const report = { passed: true, output, packaged, comparedFiles, launches, checks, errors, asOf, first, degraded, restored,
    mockedRequests: requests.length, network: 'net.fetch stub; refused loopback proxy and renderer network block; no live upstream calls',
    account: { orders: current.account.orders.length, trades: current.account.trades.length, lots: current.account.lots.length, modes: current.agency.groups.map(group => group.mode) } };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  const renderer = page ? await page.evaluate(() => ({ url: location.href, title: document.title,
    ready: document.readyState, statePresent: typeof state !== 'undefined' && !!state,
    bridgePresent: !!window.guanlan, text: document.body?.innerText.slice(0, 2000) })).catch(problem => ({ error: problem.message })) : null;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, output, packaged, checks, errors, launches, renderer, error: error.stack }, null, 2));
  console.error(error); console.error('Output:', output); process.exitCode = 1;
}).finally(close);
