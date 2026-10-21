// Packaged Electron/preload/IPC smoke check. Every account write is confined to
// a new work directory; strategy groups stay paused and receive no funding.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const asar = require('@electron/asar');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const executable = process.env.GUANLAN_PACKAGE_EXE ? path.resolve(process.env.GUANLAN_PACKAGE_EXE)
  : path.join(root, 'releases/entry-conditions/win-unpacked/Guanlan.exe');
const defaultArchive = path.join(root, 'releases/entry-conditions/win-unpacked/resources/app.asar');
const adjacentArchive = path.join(path.dirname(executable), 'resources/app.asar');
const sourceFiles = ['main.cjs', 'preload.cjs', ...['core', 'ui', 'assets'].flatMap(directory => fs.readdirSync(path.join(root, directory), { recursive: true })
  .filter(file => fs.statSync(path.join(root, directory, file)).isFile()).map(file => `${directory}/${file.replaceAll('\\', '/')}`))];
function verifyArchive(archive) {
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
  for (const file of sourceFiles) assert.ok(asar.extractFile(archive, file).equals(fs.readFileSync(path.join(root, file))), `packaged file differs: ${file}`);
  const actual = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')).filter(file => !asar.statFile(archive, path.normalize(file)).files).sort();
  assert.deepEqual(actual.filter(file => !file.startsWith('node_modules/')), [...sourceFiles, 'package.json'].sort());
  assert.ok(actual.includes('node_modules/pdfjs-dist/legacy/build/pdf.mjs'));
  assert.ok(actual.includes('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'));
  assert.ok(actual.filter(file => file.startsWith('node_modules/')).every(file => /^node_modules\/(?:pdfjs-dist|@napi-rs\/canvas(?:-win32-x64-msvc)?)\//.test(file)), 'only declared PDF runtime dependencies are bundled');
  return { archive, comparedFiles: sourceFiles.length, byteComparison: 'passed', fileAllowlist: 'passed' };
}
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/entry-conditions-package-')), dataPath = path.join(output, 'account');
assert.equal(path.dirname(output), path.join(root, 'work'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('GUANLAN_TEST_')) delete env[key];
const errors = [], checks = [], archives = []; let desktop, page, sessions = 0;
const member = (current, symbol) => current.agency.groups.flatMap(group => group.members).find(item => item.symbol === symbol);
async function call(name, payload) {
  return page.evaluate(async ({ name, payload }) => {
    const response = await window.guanlan.call(name, payload);
    if (!response.ok) throw Error(`${name}: ${response.error}`);
    return response.data;
  }, { name, payload });
}
function assertInactive(current) {
  assert.equal(current.account.trades.length, 0); assert.equal(current.account.orders.length, 0); assert.equal(current.account.lots.length, 0);
  assert.equal(current.account.agency.transfers.length, 0); assert.equal(current.account.cash, current.agency.manualCash);
  assert.ok(current.agency.groups.every(group => group.mode === 'paused' && group.cash === 0));
  assert.equal(current.account.agency.version, 4); assert.equal(current.account.agency.entryConditionsVersion, 1);
}
async function launch() {
  desktop = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${dataPath}`], cwd: root, env, timeout: 60000 });
  sessions++;
  const appPath = await desktop.evaluate(({ app }) => app.getAppPath());
  archives.push(verifyArchive(appPath));
  // Keep the production Market, parsers and IPC. Only this isolated process's
  // HTTP boundary gets explicit Tencent-format sample quotes; other data is
  // unavailable. No fixture code or test switch is inserted into the package.
  const fixtureInstalled = await desktop.evaluate(({ net }) => {
    const fetcher = async input => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'qt.gtimg.cn') {
        const stamp = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace(/[-:T]/g, '');
        const body = (url.searchParams.get('q') || url.pathname.replace(/^\/q=/, '')).split(',').filter(Boolean).map(symbol => {
          const fields = Array(88).fill('');
          Object.assign(fields, { 0: symbol.startsWith('sh') ? '1' : '51', 1: 'PackageFixture', 2: symbol.slice(2),
            3: '10.1', 4: '10.05', 5: '10', 6: '10000', 9: '10.09', 10: '200', 19: '10.1', 20: '200',
            30: stamp, 31: '0.05', 32: '0.5', 33: '10.2', 34: '10', 36: '10000', 37: '1010', 38: '1',
            39: '99', 43: '2', 44: '80', 45: '100', 46: '2', 47: '11.05', 48: '9.05', 49: '1.2', 52: '15',
            61: symbol.startsWith('sh688') ? 'GP-A-KCB' : /^sz30/.test(symbol) ? 'GP-A-CYB' : 'GP-A' });
          return `v_${symbol}="${fields.join('~')}";`;
        }).join('\n');
        return new Response(body, { status: 200 });
      }
      return new Response('Isolated package check: this source is intentionally unavailable', { status: 503 });
    };
    net.fetch = fetcher; return net.fetch === fetcher;
  });
  assert.equal(fixtureInstalled, true, 'isolated quote fixture is installed');
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), path.resolve(dataPath));
  assert.ok((await page.locator('.version').innerText()).includes(`v${version}`));
  return call('state');
}
async function close() { if (desktop) { await desktop.close(); desktop = null; page = null; } }

(async () => {
  assert.ok(fs.existsSync(executable), `Build the packaged application first: ${executable}`);
  const unpacked = verifyArchive(fs.existsSync(adjacentArchive) ? adjacentArchive : defaultArchive);
  let current = await launch(); assertInactive(current);
  assert.equal(current.agency.groups.flatMap(group => group.members).length, 0);
  checks.push('fresh packaged account defaults to four paused groups with zero group funding, orders, positions and trades');

  await call('agency:member', { strategyId: 'swing', symbol: '600000', action: 'add' });
  current = await call('state'); assertInactive(current); assert.equal(member(current, 'sh600000').entryConditions ?? null, null);
  await close();
  // Only this script's own constraint-free test account is changed to v2, to
  // exercise the actual packaged startup migration without using user data.
  const accountFile = path.join(dataPath, 'account.json');
  assert.equal(path.dirname(accountFile), dataPath); assert.equal(path.dirname(dataPath), output);
  const old = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
  assert.ok(old.agency.groups.flatMap(group => group.members).every(item => item.entryConditions == null));
  const oldCash = old.cash;
  old.agency.version = 2; delete old.agency.entryConditionsVersion;
  delete old.agency.poolVersion; delete old.agency.pool; delete old.agency.poolAuthorizationRevision;
  fs.writeFileSync(accountFile, JSON.stringify(old, null, 2));
  current = await launch(); assertInactive(current); assert.equal(current.account.cash, oldCash);
  assert.equal(member(current, 'sh600000').entryConditions ?? null, null);
  checks.push('real packaged startup migrates an isolated v2 account without changing its funding or inventing conditions for its existing member');

  const conditions = { rules: [{ field: 'roe', op: 'gt', value: 10 }, { field: 'close', op: 'gte', valueField: 'ma20' }],
    excludeST: true, evidence: { conditions: ['demand'] }, source: { kind: 'package-isolation', label: 'Packaged IPC fixture' },
    scope: 'watchlist', boards: ['sh'] };
  const added = await call('agency:member', { strategyId: 'long', symbol: '600001', action: 'add', entryConditions: conditions });
  const saved = structuredClone(added.entryConditions);
  assert.equal(saved.version, 1); assert.ok(Number.isFinite(Date.parse(saved.savedAt))); assert.ok(saved.labels.length >= 4);
  assert.deepEqual(saved.rules, conditions.rules); assert.equal(saved.excludeST, true); assert.deepEqual(saved.evidence.conditions, ['demand']);
  assert.equal(Object.hasOwn(saved, 'scope'), false); assert.equal(Object.hasOwn(saved, 'boards'), false);
  assert.deepEqual(saved.source, conditions.source);
  conditions.rules[0].value = 1; conditions.evidence.conditions = ['commercialization']; added.entryConditions.rules[0].value = 0;
  assert.deepEqual(member(await call('state'), 'sh600001').entryConditions, saved);
  await call('agency:member', { strategyId: 'long', symbol: '600001', action: 'add', entryConditions: conditions });
  assert.deepEqual(member(await call('state'), 'sh600001').entryConditions, saved);
  const invalid = await page.evaluate(() => window.guanlan.call('agency:member', { strategyId: 'long', symbol: '600010', action: 'add',
    entryConditions: { rules: [{ field: 'roe', op: 'gt', value: 'invalid' }] } }));
  assert.equal(invalid.ok, false); assert.equal(member(await call('state'), 'sh600010'), undefined);
  checks.push('single IPC saves versioned financial/technical/exclusion/evidence predicates; caller edits and repeat addition cannot overwrite the frozen snapshot; scope/boards are omitted and invalid predicates are rejected');

  const batchConditions = { rules: [{ field: 'price', op: 'gt', value: 5 }, { field: 'volumeRatio', op: 'gte', value: 1 }] };
  const batch = await call('agency:members:add', { strategyId: 'long', symbols: ['600001', '600002', '600003'], entryConditions: batchConditions });
  assert.deepEqual(batch.added, ['sh600002', 'sh600003']); assert.equal(batch.skipped.length, 1); assert.equal(batch.failed.length, 0);
  current = await call('state'); assert.deepEqual(member(current, 'sh600001').entryConditions, saved);
  for (const symbol of ['sh600002', 'sh600003']) assert.deepEqual(member(current, symbol).entryConditions.rules, batchConditions.rules);
  await call('agency:member', { strategyId: 'swing', symbol: '600004', action: 'add' });
  current = await call('state'); assertInactive(current); assert.equal(member(current, 'sh600004').entryConditions ?? null, null);
  const beforeRestart = current.agency.groups.flatMap(group => group.members).map(item => ({ symbol: item.symbol, entryConditions: item.entryConditions ?? null }));
  checks.push('batch IPC inherits the same predicates for new symbols while preserving existing ownership; ordinary additions save no screening conditions');

  await close(); current = await launch(); assertInactive(current);
  assert.deepEqual(current.agency.groups.flatMap(group => group.members).map(item => ({ symbol: item.symbol, entryConditions: item.entryConditions ?? null })), beforeRestart);
  await page.locator('[data-page="agency"]').click();
  await page.locator('[data-agency-tab="long"]').click();
  assert.match(await page.locator('#agency-members').innerText(), /已保存选股条件/);
  await page.screenshot({ path: path.join(output, 'packaged-saved-conditions.png'), fullPage: true });
  await page.locator('[data-agency-tab="swing"]').click();
  assert.match(await page.locator('#agency-members').innerText(), /未保存选股条件/);
  await page.screenshot({ path: path.join(output, 'packaged-unconditional-members.png'), fullPage: true });
  checks.push('a full packaged restart restores every snapshot unchanged; saved and legacy/plain members display their actual condition state');
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), version, output, dataPath, executable, sessions,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), unpacked, archives,
    fixture: 'Tencent-format quotes at the isolated Electron process HTTP boundary; other providers unavailable; no test code added to the package',
    account: { version: current.account.agency.version, cash: current.account.cash, trades: current.account.trades.length, orders: current.account.orders.length,
      groups: current.agency.groups.map(group => ({ id: group.id, mode: group.mode, cash: group.cash, members: group.members.length })) },
    savedMembers: beforeRestart, errors, checks };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  console.error(error); console.error('Output:', output);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(close);
