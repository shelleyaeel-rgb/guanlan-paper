// Validate the real packaged renderer/IPC and persisted history in an isolated profile.
// The three seeded rows are explicitly synthetic; live availability is reported separately.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { ScreenerStore } = require('../core/screener-store.cjs');
const { normalize } = require('../core/screener.cjs');
const root = path.resolve(__dirname, '..'); fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/screener-package-fix-')), dataPath = path.join(output, 'account');
const fetchedAt = Date.parse('2026-09-29T15:10:00+08:00'), history = new ScreenerStore(dataPath);
history.remember({ source: '东方财富公开行情', sourceCount: 3, excludedCount: 0, startedAt: fetchedAt - 1000, fetchedAt, rows: [12, 40, null].map((pe, i) => normalize({ f12: String(600001 + i), f13: 1, f14: `离线回归样本${i}`, f2: 10, f3: 2, f5: 10000, f6: 1e8, f7: 2, f8: 3, f9: pe, f10: 1, f20: 100e8, f21: 80e8, f23: 1, f124: fetchedAt / 1000 })) });
const historicalId = history.list()[0].id, env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.GUANLAN_TEST_CONTROL;
let desktop; const errors = [];
(async () => {
  desktop = await _electron.launch({ executablePath: process.env.GUANLAN_PACKAGE_EXE || path.join(root, 'dist/win-unpacked/Guanlan.exe'), args: [`--user-data-dir=${dataPath}`], cwd: root, env });
  const page = await desktop.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), path.resolve(dataPath));
  const version = await desktop.evaluate(({ app }) => app.getVersion()); assert.equal(version, require('../package.json').version);
  await page.locator('[data-page="screener"]').click();
  await page.waitForFunction(() => screenMeta && !screenBusy && (!!screenResult || !document.querySelector('#screen-error').classList.contains('hidden')), null, { timeout: 120000 });
  const live = await page.evaluate(() => screenResult ? { status: screenResult.status, eligibleCount: screenResult.eligibleCount, missingByField: screenResult.missingByField } : { error: document.querySelector('#screen-error').textContent });
  await page.locator('#screen-data-source').selectOption(historicalId);
  await page.locator('#screen-description').fill('动态市盈率小于40倍'); await page.locator('#screen-parse').click();
  await page.waitForFunction(() => !screenBusy && screenResult?.dataMode === 'historical');
  assert.equal(await page.evaluate(() => screenResult.matched), 1); assert.equal(await page.evaluate(() => screenResult.missing), 1);
  assert.match(await page.locator('#screen-result-labels').innerText(), /历史快照/);
  assert.match(await page.locator('#screen-source').innerText(), /2026\/9\/29/);
  await page.screenshot({ path: path.join(output, 'packaged-history.png'), fullPage: true });
  const original = '需要 MA20 向上且高于 MA60、收盘在 MA20 上方、MACD 为正、RSI 40–75、日量比不低于 0.6';
  const parsed = await page.evaluate(text => api('screener:parse', text), original);
  assert.equal(parsed.query.rules.length, 7);
  assert.equal(await page.evaluate(() => screenMeta.fields.dailyVolumeRatio.source), 'daily');
  await page.locator('#screen-description').fill(original); await page.locator('#screen-parse').click();
  await page.waitForFunction(() => !screenBusy && !document.querySelector('#screen-error').classList.contains('hidden'));
  assert.match(await page.locator('#screen-error').innerText(), /历史快照未保存技术日线/);
  assert.equal(await page.evaluate(() => screenResult.matched), 1);
  let technicalLive = { skipped: 'latest quote universe unavailable' };
  if (!live.error) {
    await page.locator('#screen-data-source').selectOption('latest');
    await page.locator('#screen-description').fill('我的自选，' + original.replace(/^需要 /, '')); await page.locator('#screen-parse').click();
    await page.waitForFunction(() => !screenBusy, null, { timeout: 120000 });
    technicalLive = await page.evaluate(() => screenResult?.technical ? { status: screenResult.status, matched: screenResult.matched, candidates: screenResult.technicalCandidates, evaluated: screenResult.technicalEvaluatedCount, scan: screenResult.technicalScan, message: screenResult.dataMessage, rows: screenResult.rows.map(r => ({ symbol: r.symbol, asOf: r.technicalAsOf, ma20: r.ma20, ma60: r.ma60, macd: r.macd, rsi: r.rsi, dailyVolumeRatio: r.dailyVolumeRatio })) } : { error: document.querySelector('#screen-error').textContent });
    await page.screenshot({ path: path.join(output, 'packaged-technical-live.png'), fullPage: true });
  }
  // Probe the packaged daily adapter independently if the universe source fails.
  // This reports only three public samples, never a completed market screen.
  const dailySamples = await desktop.evaluate(async ({ app, net }) => {
    const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/main.cjs');
    const path = require('node:path');
    const { Market } = require(path.join(app.getAppPath(), 'core/market.cjs'));
    const { dailyIndicators } = require(path.join(app.getAppPath(), 'core/daily-indicators.cjs'));
    const market = new Market((url, options) => net.fetch(url, options));
    return Promise.all(['sh600519', 'sz000001', 'sh601318'].map(async symbol => {
      try { const d = dailyIndicators(await market.strategyHistory(symbol)); return { symbol, asOf: d.asOf, ma20: d.ma20, ma60: d.ma60, macd: d.macd, rsi: d.rsi, dailyVolumeRatio: d.dailyVolumeRatio }; }
      catch (e) { return { symbol, error: e.message }; }
    }));
  });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const account = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length }));
  assert.deepEqual(account, { trades: 0, orders: 0 }); assert.deepEqual(errors, []);
  const report = { output, version, errors, account, historicalRegression: 'passed with isolated synthetic rows', technicalParsing: 'original seven rules and historical rejection passed', live, technicalLive, dailySamples };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error(e); console.error('Output:', output); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
