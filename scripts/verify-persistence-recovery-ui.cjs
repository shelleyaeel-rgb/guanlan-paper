// Real Electron IPC and Store retries, with faults restricted to a fresh paused
// test account. The production application and its user data are never opened.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/persistence-recovery-ui-'));
const accountPath = path.join(output, 'account'), accountFile = path.join(accountPath, 'account.json');
const control = path.join(output, 'control.json'), networkLog = path.join(output, 'network.jsonl');
const scenario = { now: '2026-09-29T10:00:00+08:00', price: 10.17, financeMode: 'ready', valuationMode: 'ready', corporateMode: 'empty' };
fs.mkdirSync(accountPath);
const seeded = new Engine(initialState()).s;
seeded.settings.refreshSeconds = 60;
seeded.watchlist = ['sh600519'];
assert.ok(seeded.agency.groups.every(group => group.mode === 'paused'));
fs.writeFileSync(accountFile, JSON.stringify(seeded, null, 2));
fs.writeFileSync(control, JSON.stringify(scenario));
const env = { ...process.env, GUANLAN_TEST_CONTROL: control, GUANLAN_TEST_NETWORK_LOG: networkLog,
  GUANLAN_TEST_EXTERNAL_LOG: path.join(output, 'external.jsonl') };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
const errors = [], checks = [], results = {};
async function rawCall(name, payload) {
  return page.evaluate(({ name, payload }) => window.guanlan.call(name, payload), { name, payload });
}
async function call(name, payload) {
  const response = await rawCall(name, payload);
  if (!response.ok) throw Error(response.error);
  return response.data;
}
const probe = () => desktop.evaluate(() => globalThis.__persistenceProbe.snapshot());
const arm = mode => desktop.evaluate((_, value) => globalThis.__persistenceProbe.arm(value), mode);
const noExecution = snapshot => {
  assert.equal(snapshot.account.trades.length, 0);
  assert.equal(snapshot.account.orders.length, 0);
  assert.equal(snapshot.account.lots.length, 0);
  assert.ok(snapshot.agency.groups.every(group => group.mode === 'paused'));
};

(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'),
    args: [path.join(root, 'tests/fixtures/corporate-ui-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4 && state.connection.ok);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 800));
  await page.setViewportSize({ width: 1120, height: 800 });
  const baseline = await call('refresh');
  assert.equal(path.resolve(baseline.dataPath), accountPath);
  assert.equal(baseline.warning, '');
  noExecution(baseline);

  await desktop.evaluate(({ app }, input) => {
    const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
    if (path.resolve(app.getPath('userData')) !== input.accountPath) throw Error('Unexpected user data directory; refusing fault injection');
    const load = process.getBuiltinModule('module').createRequire(path.join(input.root, 'main.cjs'));
    const { Engine } = load('./core/engine.cjs'), { Store } = load('./core/store.cjs');
    const target = path.join(input.accountPath, 'account.json'), original = {
      rename: fs.renameSync, save: Store.prototype.save, configure: Engine.prototype.configure, tick: Engine.prototype.tick
    };
    let counts = { mode: 'disabled', renames: 0, rejected: 0, saves: 0, configures: 0, ticks: 0 };
    const accountRename = (from, to) => typeof from === 'string' && typeof to === 'string'
      && path.resolve(from) === target + '.tmp' && path.resolve(to) === target;
    fs.renameSync = function(from, to) {
      if (counts.mode !== 'disabled' && accountRename(from, to)) {
        counts.renames++;
        if (counts.mode === 'persistent' || counts.mode === 'transient' && counts.renames <= 2) {
          counts.rejected++;
          const error = Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
          Object.assign(error, { code: 'EPERM', errno: -4048, syscall: 'rename', path: from, dest: to });
          throw error;
        }
      }
      return original.rename.apply(this, arguments);
    };
    Store.prototype.save = function() {
      if (counts.mode !== 'disabled' && path.resolve(this.file) === target) counts.saves++;
      return original.save.apply(this, arguments);
    };
    Engine.prototype.configure = function() {
      if (counts.mode !== 'disabled') counts.configures++;
      return original.configure.apply(this, arguments);
    };
    Engine.prototype.tick = function() {
      if (counts.mode !== 'disabled') counts.ticks++;
      return original.tick.apply(this, arguments);
    };
    globalThis.__persistenceProbe = {
      arm(mode) {
        if (!['disabled', 'transient', 'persistent', 'recovered'].includes(mode)) throw Error('Unknown fault mode');
        counts = { mode, renames: 0, rejected: 0, saves: 0, configures: 0, ticks: 0 };
      },
      snapshot: () => ({ ...counts }),
      restore() {
        fs.renameSync = original.rename; Store.prototype.save = original.save;
        Engine.prototype.configure = original.configure; Engine.prototype.tick = original.tick;
      }
    };
  }, { root, accountPath });
  checks.push('fault injection is restricted to the fresh isolated account rename');

  await arm('transient');
  let started = performance.now();
  await call('settings', { ...baseline.account.settings, minCommission: 6 });
  const transientElapsedMs = performance.now() - started, transient = await call('state');
  const transientCounts = await probe();
  assert.deepEqual(transientCounts, { mode: 'transient', renames: 3, rejected: 2, saves: 1, configures: 1, ticks: 0 });
  assert.ok(transientElapsedMs >= 140, 'two real retry delays must occur');
  assert.equal(transient.warning, '');
  assert.equal(transient.account.settings.minCommission, 6);
  assert.equal(JSON.parse(fs.readFileSync(accountFile)).settings.minCommission, 6);
  noExecution(transient);
  await page.locator('[data-page="agency"]').click();
  await page.waitForFunction(() => state.account.settings.minCommission === 6);
  assert.equal(await page.locator('#warning').isVisible(), false);
  await page.screenshot({ path: path.join(output, 'transient-save-recovered-1120.png') });
  results.transient = { counts: transientCounts, elapsedMs: transientElapsedMs, warning: transient.warning };
  checks.push('two EPERM failures recover on the third rename after real waits; settings and Store.save each execute once');

  const beforeMemory = structuredClone(transient.account), beforeDisk = fs.readFileSync(accountFile);
  await arm('persistent');
  started = performance.now();
  const failure = await rawCall('settings', { ...transient.account.settings, minCommission: 7 });
  const persistentElapsedMs = performance.now() - started;
  assert.equal(failure.ok, false);
  assert.ok(persistentElapsedMs >= 730, 'all four real retry delays must occur');
  const warning = failure.error;
  assert.equal(warning.split('账户保存失败，交易已暂停：').length - 1, 1);
  assert.match(warning, /EPERM.*rename/);
  const failed = await call('state');
  assert.equal(failed.warning, warning);
  assert.deepEqual(failed.account, beforeMemory);
  assert.ok(fs.readFileSync(accountFile).equals(beforeDisk));
  const persistentCounts = await probe();
  assert.deepEqual(persistentCounts, { mode: 'persistent', renames: 5, rejected: 5, saves: 1, configures: 1, ticks: 0 });
  for (let index = 0; index < 4; index++) {
    const snapshot = await call('refresh');
    assert.equal(snapshot.warning, warning);
    assert.deepEqual(snapshot.account, beforeMemory);
    assert.equal(snapshot.connection.ok, true);
    noExecution(snapshot);
  }
  assert.deepEqual(await probe(), persistentCounts);
  assert.ok(fs.readFileSync(accountFile).equals(beforeDisk));
  results.persistent = { counts: persistentCounts, elapsedMs: persistentElapsedMs, warning, refreshes: 4 };
  checks.push('five denied renames pause account changes; memory and committed account bytes stay unchanged across four refreshes');

  await arm('recovered');
  scenario.price = 10.18; fs.writeFileSync(control, JSON.stringify(scenario));
  const afterRecovery = await call('refresh');
  assert.equal(afterRecovery.warning, warning);
  assert.equal(afterRecovery.quotes.sh600519.price, 10.18);
  assert.deepEqual(afterRecovery.account, beforeMemory);
  const rejectedSettings = await rawCall('settings', { ...transient.account.settings, minCommission: 8 });
  assert.equal(rejectedSettings.ok, false); assert.equal(rejectedSettings.error, warning);
  assert.deepEqual(await probe(), { mode: 'recovered', renames: 0, rejected: 0, saves: 0, configures: 0, ticks: 0 });
  assert.ok(fs.readFileSync(accountFile).equals(beforeDisk));
  noExecution(afterRecovery);
  await page.waitForFunction(expected => document.querySelector('#warning').textContent === expected, warning);
  assert.equal(await page.locator('#warning').isVisible(), true);
  const layout = await page.evaluate(() => {
    const element = document.querySelector('#warning'), rect = element.getBoundingClientRect();
    return { width: innerWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth,
      warningOverflow: element.scrollWidth > element.clientWidth, warningHeight: rect.height,
      warningWithinViewport: rect.x >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
  });
  assert.equal(layout.width, 1120); assert.equal(layout.pageOverflow, false);
  assert.equal(layout.warningOverflow, false); assert.equal(layout.warningWithinViewport, true);
  assert.ok(layout.warningHeight < 160);
  await page.screenshot({ path: path.join(output, 'persistent-save-paused-1120.png') });
  results.layout = layout;
  checks.push('after the injected lock clears, fresh quotes still display but account execution stays paused',
    'the single original warning fits clearly at 1120px without horizontal overflow', 'no orders, trades or positions were created');
  assert.deepEqual(errors, []);
  const report = { passed: true, output, accountPath, checks, results, errors,
    networkRequestsBlocked: fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8').trim().split('\n').filter(Boolean).length : 0 };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, output, checks, results, errors, error: error.stack }, null, 2));
  console.error(error); process.exitCode = 1;
}).finally(async () => {
  if (desktop) {
    await desktop.evaluate(() => globalThis.__persistenceProbe?.restore()).catch(() => {});
    await desktop.close();
  }
});
