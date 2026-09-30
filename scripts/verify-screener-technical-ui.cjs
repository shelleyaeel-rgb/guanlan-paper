// Runs the actual Electron UI and IPC with isolated accounts and deterministic data.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/screener-technical-ui-')), control = path.join(output, 'control.json');
const env = { ...process.env, GUANLAN_TEST_CONTROL: control }; delete env.ELECTRON_RUN_AS_NODE;
const scenario = dailyMode => fs.writeFileSync(control, JSON.stringify({ now: '2026-09-30T10:00:00+08:00', price: 10.08, dailyMode }));
const original = '需要 MA20 向上且高于 MA60、收盘在 MA20 上方、MACD 为正、RSI 40–75、日量比不低于 0.6';
let desktop, page; const errors = [];
const idle = () => page.waitForFunction(() => !screenBusy && (screenResult || !document.querySelector('#screen-error').classList.contains('hidden')));
async function submit(text) { await page.locator('#screen-description').fill(text); await page.locator('#screen-parse').click(); await idle(); }
async function noOverflow() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
(async () => {
  scenario('ready');
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/screener-technical-desktop.cjs'), `--test-data-dir=${path.join(output, 'account')}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account);
  await page.locator('[data-page="screener"]').click(); await idle();
  await submit(original);
  assert.equal(await page.locator('#screen-error').isVisible(), false);
  assert.equal(await page.locator('#screen-rules .screen-rule').count(), 7);
  assert.equal(await page.locator('#screen-rules [data-part="target"]').count(), 3);
  assert.equal(await page.evaluate(() => screenResult.matched), 135);
  assert.ok((await page.locator('#screen-table').innerText()).includes('2026-09-29'));
  await page.locator('.screen-checks summary').first().click();
  assert.match(await page.locator('.screen-checks').first().innerText(), /前一日 MA20/);
  assert.match(await page.locator('.screen-checks').first().innerText(), /日量比/);
  await noOverflow();
  await page.screenshot({ path: path.join(output, 'technical-wide.png'), fullPage: true });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
  await noOverflow(); await page.screenshot({ path: path.join(output, 'technical-small.png'), fullPage: true });
  // Edit a field reference, then switch that operand to a number and back.
  await page.locator('[data-rule="0"] [data-part="target"]').selectOption('number');
  await page.locator('[data-rule="0"] [data-part="value"]').fill('0');
  await page.locator('#screen-run').click(); await idle(); assert.equal(await page.evaluate(() => screenResult.matched), 135);
  await page.locator('[data-rule="0"] [data-part="target"]').selectOption('previousMa20');
  await page.locator('#screen-run').click(); await idle(); assert.equal(await page.evaluate(() => screenResult.matched), 135);
  await submit('RSI40–75，MACD金叉');
  assert.match(await page.locator('#screen-error').innerText(), /未应用/);
  assert.equal(await page.locator('#screen-run').isDisabled(), true);
  assert.equal(await page.evaluate(() => screenResult.matched), 135);
  await submit(original);
  const id = await page.evaluate(() => screenHistory[0].id);
  await page.locator('#screen-data-source').selectOption(id); await page.locator('#screen-run').click(); await idle();
  assert.match(await page.locator('#screen-error').innerText(), /历史快照未保存技术日线/);
  assert.equal(await page.evaluate(() => screenResult.matched), 135);
  await submit('市盈率小于20'); assert.equal(await page.evaluate(() => screenResult.dataMode), 'historical');
  await page.locator('#screen-data-source').selectOption('latest'); await submit(original);
  scenario('partial'); await page.locator('#screen-run').click(); await idle();
  assert.equal(await page.evaluate(() => screenResult.matched), 132);
  assert.match(await page.locator('#screen-data-message').innerText(), /日线不足 1 只，日线无效 1 只，获取失败 1 只/);
  assert.match(await page.locator('#screen-result-count').innerText(), /部分股票未判定/);
  await page.screenshot({ path: path.join(output, 'technical-partial.png'), fullPage: true });
  scenario('slow'); await page.locator('#screen-run').click();
  await page.waitForFunction(() => document.querySelector('#screen-progress').textContent.includes('完整日线指标'));
  assert.equal(await page.locator('#screen-run').isDisabled(), true);
  assert.equal(await page.locator('#screen-parse').isDisabled(), true);
  assert.equal(await page.locator('#screen-data-source').isDisabled(), true);
  await page.locator('#screen-cancel').click(); await idle();
  assert.match(await page.locator('#screen-error').innerText(), /取消/);
  assert.equal(await page.evaluate(() => screenResult.matched), 132);
  assert.equal(await page.locator('#screen-run').isEnabled(), true);
  scenario('offline'); await page.locator('#screen-run').click(); await idle();
  assert.equal(await page.evaluate(() => screenResult.status), 'unavailable');
  assert.equal(await page.evaluate(() => screenResult.matched), null);
  assert.match(await page.locator('#screen-data-message').innerText(), /获取失败 135 只/);
  scenario('ready'); await page.locator('#screen-run').click(); await idle();
  assert.equal(await page.evaluate(() => screenResult.matched), 135);
  const account = await page.evaluate(() => ({ trades: state.account.trades.length, orders: state.account.orders.length }));
  assert.deepEqual(account, { trades: 0, orders: 0 }); assert.deepEqual(errors, []);
  const report = { output, errors, account, matched: 135, checks: ['original sentence', 'editable field and numeric operands', 'actual indicator values and dates', '1120px and wide layout', 'unsupported text preserved', 'historical rejection and legacy filters', 'partial data counts', 'cancellation preserves result', 'offline does not report zero', 'recovery'] };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  console.error(error); console.error('Output:', output);
  if (page) { console.error(await page.locator('#screen-error').textContent()); await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }); }
  process.exitCode = 1;
}).finally(async () => { if (desktop) await desktop.close(); });
