'use strict';
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/operations-ui-')), account = path.join(output, 'account');
const controlFile = path.join(output, 'control.json'), logFile = path.join(output, 'operations.jsonl');
const scenario = { now: '2026-10-16T10:00:00+08:00', operationMode: 'after' };
const update = mode => { scenario.operationMode = mode; fs.writeFileSync(controlFile, JSON.stringify(scenario)); }; update('after');
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlFile, GUANLAN_OPERATION_LOG: logFile }; delete env.ELECTRON_RUN_AS_NODE;
const disk = () => JSON.parse(fs.readFileSync(path.join(account, 'account.json'), 'utf8'));
const requests = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
const errors = [], checks = []; let desktop, page;
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/operations-desktop.cjs'), `--test-data-dir=${account}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.connection?.ok);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), account);
}
async function failedCall(channel, payload) {
  const result = await page.evaluate(async ({ channel, payload }) => { try { await api(channel, payload); return null; } catch (e) { return e.message; } }, { channel, payload });
  assert.match(result, /尚未收到/);
}
async function settled() { await page.waitForFunction(() => !operationClient.pending()); }
(async () => {
  await launch();
  await page.locator('#order-type').selectOption('limit'); await page.locator('#limit-price').fill('1'); await page.locator('#quantity').fill('100');
  await page.locator('#trade-submit').click(); await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => operationClient.pending() && !operationClient.inflight.size);
  assert.equal(disk().orders.length, 1); const orderId = requests()[0].payload.requestId;
  await page.reload(); await page.waitForFunction(() => typeof state !== 'undefined' && state?.connection?.ok);
  assert.equal(await page.evaluate(() => operationClient.pending().request.requestId), orderId);
  for (const width of [1120, 1536]) {
    await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 850), width);
    await page.locator('#pending-operation').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `pending-${width}.png`) });
  }
  update('ready'); await page.locator('[data-operation="query"]').click(); await settled();
  assert.equal(disk().orders.length, 1); assert.equal(requests().length, 1);
  checks.push('条件单丢失回复后跨页面重载保留编号，查询已保存结果不重发；1120/1536宽度无溢出');
  update('after'); await failedCall('trade', { symbol: 'sz000001', side: 'buy', quantity: 100 });
  assert.equal(disk().trades.length, 1); const tradeRequest = requests().at(-1).payload.requestId;
  await desktop.close(); desktop = null; update('ready'); await launch();
  assert.equal(await page.evaluate(() => operationClient.pending().request.requestId), tradeRequest);
  await page.locator('[data-operation="retry"]').click(); await page.locator('#confirm-ok').click(); await settled();
  assert.equal(disk().trades.length, 1); assert.equal(requests().at(-1).payload.requestId, tradeRequest);
  checks.push('真实成交丢失回复后跨应用重启重试原编号，仅保存一笔成交');
  update('before'); await failedCall('agency:transfer', { strategyId: 'swing', amount: 1000 });
  const before = disk().agency.transfers.length;
  update('ready'); await page.locator('[data-operation="discard"]').click(); await settled();
  assert.equal(disk().agency.transfers.length, before);
  checks.push('未到达后台的划拨仅在查询确认未执行后取消，无账务变动');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, output, checks, errors }, null, 2)); console.log(JSON.stringify({ ok: true, output, checks }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
