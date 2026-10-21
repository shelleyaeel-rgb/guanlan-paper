// Isolated desktop test: real Sina/EM minute fallback, synthetic EM daily fallback, then real recovery.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(root, 'work/market-routing-ui-'));
const dataPath = path.join(output, 'account'), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.GUANLAN_TEST_CONTROL;
const packaged = !!process.env.GUANLAN_PACKAGE_EXE;
let desktop;
(async () => {
  desktop = await _electron.launch({ executablePath: packaged ? path.resolve(process.env.GUANLAN_PACKAGE_EXE) : require('electron'), args: packaged ? [`--user-data-dir=${dataPath}`] : [root, `--test-data-dir=${dataPath}`], cwd: root, env });
  const page = await desktop.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account && !detailBusy);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), dataPath);
  await desktop.evaluate(({ app }) => {
    const { Market } = process.mainModule.require(app.getAppPath() + '/core/market.cjs');
    global.routingTest = { original: Market.prototype.request, mode: 'sina', instances: new Set(), requests: [] };
    Market.prototype.request = async function(url, ...args) {
      const control = global.routingTest; control.instances.add(this); control.requests.push({ url, mode: control.mode });
      if (url.includes('qt.gtimg.cn') || ((control.mode === 'eastmoney' || control.mode === 'all-fail') && (url.includes('gtimg.cn') || url.includes('proxy.finance.qq.com')))) {
        const error = Error('隔离测试：腾讯入口故障'); error.status = 501; throw error;
      }
      if (control.mode === 'all-fail' && url.includes('sinajs')) throw Error('隔离测试：新浪入口故障');
      if (control.mode === 'eastmoney' && url.includes('/kline/get?')) {
        // Explicit synthetic fixture; this does not establish availability of EM's live K-line API.
        const params = new URL(url).searchParams, [market, code] = params.get('secid').split('.');
        const klines = Array.from({ length: 100 }, (_, i) => { const close = 10 + i / 100; return [new Date(Date.UTC(2026, 5, 22 + i)).toISOString().slice(0, 10), close, close, close + .2, close - .2, 100 + i].join(','); });
        return { rc: 0, data: { code, market: Number(market), klines } };
      }
      return control.original.call(this, url, ...args);
    };
  });
  await page.evaluate(() => selectStock('sz000001'));
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !detailBusy && state.quotes.sz000001?.provider === 'sina');
  assert.match(await page.locator('#stock-time').innerText(), /新浪财经/);
  assert.match(await page.locator('#quote-capability').innerText(), /缺少涨跌停/);
  assert.equal(await page.locator('#trade-submit').isDisabled(), true);
  const rejectedTrade = await page.evaluate(() => window.guanlan.call('trade', { symbol: 'sz000001', side: 'buy', quantity: 100, requestId: crypto.randomUUID(), accountCreatedAt: state.account.createdAt }));
  assert.equal(rejectedTrade.ok, false); assert.match(rejectedTrade.error, /仅供展示/);
  const liveSina = await page.evaluate(() => ({ source: state.quotes.sz000001.source, quoteDate: state.quotes.sz000001.date, quoteTime: state.quotes.sz000001.time, canTrade: state.quotes.sz000001.canTrade }));
  await page.screenshot({ path: path.join(output, 'sina-display-only.png'), fullPage: true });
  await desktop.evaluate(() => { global.routingTest.mode = 'eastmoney'; for (const market of global.routingTest.instances) market.failures.clear(); });
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !detailBusy && detail?.provider === 'eastmoney');
  assert.match(await page.locator('#chart-source').innerText(), /东方财富.*前复权/);
  assert.equal(await page.locator('#chart [data-bar]').count(), 90);
  const daily = await page.evaluate(() => ({ source: detail.source, bars: detail.bars.length, adjustment: detail.adjustment }));
  await page.locator('#tab-minute').click();
  const minute = await page.evaluate(() => ({ source: detail.minute?.source, date: detail.minute?.date, points: detail.minute?.points.length, error: detail.minuteError }));
  assert.equal(minute.source, '东方财富'); assert.ok(minute.points > 0);
  assert.match(await page.locator('#chart-source').innerText(), /东方财富.*分时/);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'eastmoney-fallback-small.png'), fullPage: true });
  await desktop.evaluate(() => { global.routingTest.mode = 'all-fail'; for (const market of global.routingTest.instances) market.failures.clear(); });
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !state.connection.ok && !detailBusy);
  assert.equal(await page.locator('#trade-submit').isDisabled(), true);
  await desktop.evaluate(({ app }) => {
    const { Market } = process.mainModule.require(app.getAppPath() + '/core/market.cjs');
    Market.prototype.request = global.routingTest.original;
    for (const market of global.routingTest.instances) market.failures.clear();
  });
  await page.locator('#tab-day').click(); await page.locator('#refresh').click();
  await page.waitForFunction(() => state.connection.ok && state.quotes.sz000001?.provider === 'tencent' && !detailBusy && detail?.provider === 'tencent');
  assert.match(await page.locator('#stock-time').innerText(), /腾讯财经/);
  assert.equal(await page.locator('#quote-capability').innerText(), '');
  assert.equal(await page.locator('#trade-submit').isDisabled(), !(await page.evaluate(() => state.session.open)));
  await page.screenshot({ path: path.join(output, 'tencent-recovered.png'), fullPage: true });
  const account = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length }));
  assert.deepEqual(account, { trades: 0, orders: 0 }); assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), output, packaged, version: await desktop.evaluate(({ app }) => app.getVersion()), liveSina, syntheticEastmoneyDaily: daily, liveEastmoneyMinute: minute, rejectedTrade, account, errors, checks: ['source labels', 'display-only button and IPC trade rejection', 'whole-series daily fallback', 'minute fallback', 'all quote sources unavailable', 'primary recovers', '1120px layout'] };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); console.error('Output:', output); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
