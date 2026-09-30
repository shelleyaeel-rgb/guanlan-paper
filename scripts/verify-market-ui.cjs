// Optional Electron integration check; all account files stay under work/market-ui-*.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'work/market-ui-'));
const dataPath = path.join(output, 'account');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.GUANLAN_TEST_CONTROL;
const packaged = !!process.env.GUANLAN_PACKAGE_EXE;
let desktop;
(async () => {
  desktop = await _electron.launch({
    executablePath: packaged ? path.resolve(process.env.GUANLAN_PACKAGE_EXE) : require('electron'),
    args: packaged ? [`--user-data-dir=${dataPath}`] : [root, `--test-data-dir=${dataPath}`], cwd: root, env,
  });
  const page = await desktop.firstWindow(), errors = [], samples = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account && !detailBusy);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), dataPath);
  for (const symbol of ['sh688533', 'sh688065', 'sh603325']) {
    await page.evaluate(symbol => selectStock(symbol), symbol);
    const sample = await page.evaluate(() => ({ symbol: selected, detailSymbol: detail?.symbol, bars: detail?.bars.length, adjustment: detail?.adjustment, minuteDate: detail?.minute?.date, points: detail?.minute?.points.length, analysisDate: detail?.analysis?.asOf }));
    assert.equal(sample.detailSymbol, symbol); assert.ok(sample.bars >= 30); assert.ok(sample.points > 0); assert.equal(sample.adjustment, '前复权');
    assert.equal(await page.locator('#chart [data-bar]').count(), Math.min(sample.bars, 90));
    await page.locator('#tab-minute').click();
    assert.equal(await page.locator('#chart [data-point]').count(), sample.points);
    await page.locator('#tab-day').click();
    samples.push(sample);
  }
  await page.screenshot({ path: path.join(output, 'live-kline.png'), fullPage: true });
  // Force every daily endpoint to fail inside this isolated process to check the IPC/error display.
  await desktop.evaluate(({ app }) => {
    const { Market } = process.mainModule.require(app.getAppPath() + '/core/market.cjs');
    global.marketRequestBeforeTest = Market.prototype.request;
    Market.prototype.request = async function(url, ...args) {
      if (url.includes('fqkline/get?param=sz000001,') || (url.includes('/kline/get?') && new URL(url).searchParams.get('secid') === '0.000001')) {
        const error = Error(`行情服务 HTTP 501（${new URL(url).hostname}）`); error.status = 501; throw error;
      }
      return global.marketRequestBeforeTest.call(this, url, ...args);
    };
  });
  await page.evaluate(() => selectStock('sz000001'));
  const failureText = await page.locator('#chart').innerText();
  assert.match(failureText, /前复权日线获取失败/); assert.match(failureText, /HTTP 501/);
  assert.match(failureText, /proxy\.finance\.qq\.com/); assert.match(failureText, /web\.ifzq\.gtimg\.cn/);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, 'error-small.png'), fullPage: true });
  await desktop.evaluate(({ app }) => {
    const { Market } = process.mainModule.require(app.getAppPath() + '/core/market.cjs');
    Market.prototype.request = global.marketRequestBeforeTest; delete global.marketRequestBeforeTest;
  });
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !detailBusy && detail?.symbol === 'sz000001');
  assert.equal(await page.locator('#chart [data-bar]').count(), 90);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, 'recovered-small.png'), fullPage: true });
  const account = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length }));
  assert.deepEqual(account, { trades: 0, orders: 0 }); assert.deepEqual(errors, []);
  const version = await desktop.evaluate(({ app }) => app.getVersion());
  const report = { checkedAt: new Date().toISOString(), output, packaged, version, samples, failureText, account, errors, checks: ['live qfq K-line and intraday through preload/IPC', 'explicit all-endpoint failure', 'manual refresh recovers', '1120px error and chart layout'] };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); console.error('Output:', output); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
