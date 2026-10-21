'use strict';
// Read-only packaged smoke check. All account files are seeded beneath work/;
// a local rejecting proxy prevents live traffic from the first process start.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const asar = require('@electron/asar');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const root = path.resolve(__dirname, '..');
const audit = path.join(root, 'work/audit-6a9aec1-417e20');
const executable = process.env.GUANLAN_PACKAGE_EXE ? path.resolve(process.env.GUANLAN_PACKAGE_EXE)
  : path.join(audit, 'build-final/win-unpacked/Guanlan.exe');
const archive = path.join(path.dirname(executable), 'resources/app.asar');
fs.mkdirSync(audit, { recursive: true });
const output = fs.mkdtempSync(path.join(audit, 'package-smoke-'));
const dataPath = path.join(output, 'account');
assert.equal(path.dirname(output), audit); assert.equal(path.dirname(dataPath), output);
fs.mkdirSync(dataPath);
const seed = new Engine(initialState(10000)).s;
seed.watchlist = [];
assert.ok(validState(seed)); assert.ok(seed.agency.groups.every(group => group.mode === 'paused'));
fs.writeFileSync(path.join(dataPath, 'account.json'), JSON.stringify(seed, null, 2));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('GUANLAN_TEST_')) delete env[key];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const report = { status: 'running', checkedAt: new Date().toISOString(), executable, archive, output, dataPath,
  scope: 'unpacked packaged application startup, packaged source integrity, local resources, read-only IPC and navigation',
  limitations: ['Portable self-extracting wrapper not exercised by this smoke check.',
    'Live market providers and real orders are intentionally unavailable; this is not an end-to-end trading validation.'],
  pageErrors: [], failedLocalResources: [], rejectingProxyRequests: [], sessions: [], pages: [] };
let desktop, page, proxy;
function verifyArchive() {
  assert.ok(fs.existsSync(executable)); assert.ok(fs.existsSync(archive));
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json'));
  assert.equal(manifest.version, require('../package.json').version);
  const files = ['main.cjs', 'preload.cjs', ...['core', 'ui'].flatMap(directory => fs.readdirSync(path.join(root, directory), { recursive: true })
    .filter(file => fs.statSync(path.join(root, directory, file)).isFile()).map(file => `${directory}/${file.replaceAll('\\', '/')}`))];
  report.packagedFiles = files.map(file => {
    const bundled = asar.extractFile(archive, path.normalize(file)), workspace = fs.readFileSync(path.join(root, file));
    assert.ok(bundled.equals(workspace), `Packaged source differs from workspace: ${file}`);
    return { file, bytes: bundled.length, sha256: sha256(bundled), matchesWorkspace: true };
  });
  for (const file of ['core/account-operations.cjs', 'core/holding-valuation.cjs', 'core/order-quantity.cjs', 'ui/operations.js']) {
    assert.ok(report.packagedFiles.some(item => item.file === file));
  }
  report.version = manifest.version; report.executableSha256 = sha256(fs.readFileSync(executable));
  report.archiveSha256 = sha256(fs.readFileSync(archive));
}
function inactive(state, expected = seed, directory = dataPath, mode = 'paused') {
  assert.equal(path.resolve(state.dataPath), directory);
  assert.equal(state.account.createdAt, expected.createdAt);
  assert.equal(state.account.cash, expected.cash);
  assert.deepEqual(state.account.watchlist, []);
  for (const key of ['trades', 'orders', 'lots']) assert.equal(state.account[key].length, 0);
  assert.equal(state.account.agency.transfers.length, 0);
  assert.ok(state.agency.groups.every(group => group.mode === mode && group.cash === 0));
  assert.equal(state.agencyPool.running, false);
}
async function call(name, payload) {
  return page.evaluate(async ({ name, payload }) => {
    const response = await window.guanlan.call(name, payload);
    if (!response.ok) throw Error(response.error);
    return response.data;
  }, { name, payload });
}
async function launch(directory = dataPath, expected = seed, mode = 'paused') {
  const port = proxy.address().port;
  desktop = await _electron.launch({ executablePath: executable, cwd: root, env, timeout: 45000,
    args: [`--user-data-dir=${directory}`, `--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-quic', '--disable-background-networking'] });
  const actual = await desktop.evaluate(({ app, net, session }) => {
    net.fetch = async () => new Response('Isolated package smoke: no live data', { status: 503 });
    globalThis.fetch = net.fetch;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    return { appPath: app.getAppPath(), userData: app.getPath('userData'), packaged: app.isPackaged, executable: process.execPath };
  });
  assert.equal(path.resolve(actual.appPath), archive); assert.equal(path.resolve(actual.userData), directory);
  assert.equal(actual.packaged, true); assert.equal(path.resolve(actual.executable), executable);
  report.sessions.push(actual);
  page = await desktop.firstWindow();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('requestfailed', request => { if (request.url().startsWith('file:')) report.failedLocalResources.push({ url: request.url(), error: request.failure()?.errorText }); });
  await page.reload();
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4 && state?.agencyPool, null, { timeout: 20000 });
  const state = await call('state'); inactive(state, expected, directory, mode); return state;
}
async function close() { if (desktop) { await desktop.close(); desktop = null; page = null; } }
(async () => {
  verifyArchive();
  proxy = http.createServer((request, response) => {
    report.rejectingProxyRequests.push({ method: request.method, url: request.url });
    response.writeHead(503, { 'Content-Type': 'text/plain' }); response.end('No live network in packaged smoke check');
  });
  proxy.on('connect', (request, socket) => {
    report.rejectingProxyRequests.push({ method: 'CONNECT', url: request.url });
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const first = await launch();
  report.resourceGlobals = await page.evaluate(() => ({ operations: typeof GuanlanOperations?.OperationClient,
    client: typeof operationClient?.query, bridge: typeof window.guanlan?.call,
    scripts: [...document.scripts].map(script => script.src), styleSheets: document.styleSheets.length,
    pendingOperation: operationClient.pending(), pendingPanelHidden: document.getElementById('pending-operation')?.classList.contains('hidden'),
    documentRequire: typeof window.require }));
  assert.equal(report.resourceGlobals.operations, 'function'); assert.equal(report.resourceGlobals.client, 'function');
  assert.equal(report.resourceGlobals.bridge, 'function'); assert.equal(report.resourceGlobals.documentRequire, 'undefined');
  assert.ok(report.resourceGlobals.scripts.some(source => source.endsWith('/ui/operations.js')));
  assert.ok(report.resourceGlobals.styleSheets > 0); assert.equal(report.resourceGlobals.pendingOperation, null);
  assert.equal(report.resourceGlobals.pendingPanelHidden, true);
  report.readOnlyOperationStatus = await call('operation:status', { channel: 'trade', request: { requestId: 'package-readonly-status', accountCreatedAt: first.account.createdAt } });
  assert.equal(report.readOnlyOperationStatus.status, 'absent');
  for (const name of ['market', 'screener', 'agency', 'portfolio', 'stats', 'settings']) {
    await page.locator(`[data-page="${name}"]`).click();
    await page.locator(`#page-${name}`).waitFor({ state: 'visible' });
    const title = await page.locator('#page-title').innerText();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `Horizontal overflow on ${name}`);
    report.pages.push({ name, title, visible: true, horizontalOverflow: overflow });
    if (['market', 'agency', 'settings'].includes(name)) await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  }
  const final = await call('state'); inactive(final);
  report.account = { createdAt: final.account.createdAt, cash: final.account.cash, trades: final.account.trades.length,
    orders: final.account.orders.length, lots: final.account.lots.length, transfers: final.account.agency.transfers.length,
    groups: final.agency.groups.map(({ id, mode, cash }) => ({ id, mode, cash })) };
  await close(); await launch();
  report.restartPreservedAccount = true;
  await close();
  const recoveryPath = path.join(output, 'missing-primary-recovery');
  fs.mkdirSync(recoveryPath);
  const recoveryEngine = new Engine(initialState(54321)); recoveryEngine.s.watchlist = [];
  recoveryEngine.agencyMode({ strategyId: 'swing', mode: 'running' });
  assert.ok(validState(recoveryEngine.s));
  const backupPath = path.join(recoveryPath, 'account.json.bak'), primaryPath = path.join(recoveryPath, 'account.json');
  fs.writeFileSync(backupPath, JSON.stringify(recoveryEngine.s, null, 2));
  assert.equal(fs.existsSync(primaryPath), false);
  const restored = await launch(recoveryPath, recoveryEngine.s, 'stopped');
  assert.match(restored.warning, /主文件缺失.*恢复/);
  assert.equal(restored.account.initialCash, recoveryEngine.s.initialCash);
  assert.equal(fs.existsSync(primaryPath), true);
  const persisted = JSON.parse(fs.readFileSync(primaryPath, 'utf8'));
  assert.equal(persisted.initialCash, recoveryEngine.s.initialCash);
  assert.equal(persisted.cash, recoveryEngine.s.cash);
  assert.equal(persisted.createdAt, recoveryEngine.s.createdAt);
  assert.ok(persisted.agency.groups.every(group => group.mode === 'stopped'));
  await page.locator('[data-page="agency"]').click();
  await page.locator('#warning').waitFor({ state: 'visible' });
  assert.match(await page.locator('#warning').innerText(), /主文件缺失.*恢复/);
  await page.screenshot({ path: path.join(output, 'missing-primary-recovery.png'), fullPage: true });
  report.missingPrimaryRecovery = { directory: recoveryPath, seededOnlyAutomaticBackup: true,
    startingMode: 'swing=running', primaryRecreated: true, initialCash: restored.account.initialCash,
    cash: restored.account.cash, accountIdentityPreserved: true, warning: restored.warning,
    persistedModes: persisted.agency.groups.map(({ id, mode }) => ({ id, mode })),
    trades: restored.account.trades.length, orders: restored.account.orders.length };
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.failedLocalResources, []);
  report.status = 'passed';
})().catch(async error => {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {});
}).finally(async () => {
  await close(); if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, comparedFiles: report.packagedFiles?.length,
    pages: report.pages, errors: report.pageErrors, error: report.error }, null, 2));
});
