// Real renderer/IPC and saved conditions; isolated synthetic ranking evidence.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { evaluateEntryConditions } = require('../core/entry-conditions.cjs');
const { companyBundle } = require('../tests/fixtures/company-evidence-data.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/industry-ui-')), accountPath = path.join(output, 'account');
const control = path.join(output, 'control.json'), callsPath = path.join(output, 'calls.jsonl'), networkLog = path.join(output, 'network.jsonl');
const now = '2026-10-15T10:00:00+08:00', stamp = Date.parse(now), errors = [], checks = [], dimensions = [];
const injection = '<img src=x onerror="window.industryInjected=true">';
fs.writeFileSync(control, JSON.stringify({ now, price: 10.17, financeMode: 'ready', valuationMode: 'ready' }));
const env = { ...process.env, GUANLAN_TEST_CONTROL: control, GUANLAN_TEST_INDUSTRY_CALLS: callsPath, GUANLAN_TEST_NETWORK_LOG: networkLog }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
const calls = () => fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function call(name, payload) { return page.evaluate(async ({ name, payload }) => { const response = await window.guanlan.call(name, payload); if (!response.ok) throw Error(response.error); return response.data; }, { name, payload }); }
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/industry-ui-desktop.cjs'), `--test-data-dir=${accountPath}`], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agencyPool && state.agency.groups.length === 4);
  assert.doesNotMatch(await page.locator('#toast').innerText(), /not defined|not a function|Cannot read/i);
  assert.equal(path.resolve((await call('state')).dataPath), path.resolve(accountPath));
}
async function capture(name, selector) {
  await page.locator('#toast').waitFor({ state: 'hidden' });
  for (const size of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), size);
    const target = page.locator(selector); await target.scrollIntoViewIfNeeded();
    dimensions.push({ name, requested: size, viewport: await page.evaluate(() => [innerWidth, innerHeight]) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} document width`);
    assert.equal(await target.evaluate(element => element.scrollWidth <= element.clientWidth), true, `${name} content width`);
    await target.screenshot({ path: path.join(output, `${name}-${size[0]}.png`) });
  }
}
async function poolRun() { await page.locator('#agency-pool-run').click(); await page.waitForFunction(() => !state.agencyPool.running && !agencyUi.busy.has('pool-run')); assert.equal(await page.locator('#agency-pool-error').innerText(), ''); }
async function screenRun() { await page.locator('#screen-run').click(); await page.waitForFunction(() => !screenBusy); assert.equal(await page.locator('#screen-error').isVisible(), false); }
const record = (symbol, rank, extra = {}) => ({ symbol, kind: 'mainRank', value: 'ranked', rank, market: '隔离行业产品市场', geography: '中国', metric: 'sales', statisticYear: 2025, coverage: 'allCompetitors',
  subject: '隔离产品', sourceTitle: '隔离行业统计报告', url: 'https://example.com/research', quote: '2025年全国销售额排名，覆盖全部竞争者。' + injection,
  period: '2025年度', publishedAt: '2026-08-01', reviewedAt: '2026-10-01', validUntil: '2026-12-31', reviewState: 'confirmed', ...extra });
(async () => {
  await launch(); const before = await call('state');
  assert.ok((await call('screener:meta')).industry.fields.mainRankMax);
  await page.locator('[data-page="agency"]').click(); const editor = page.locator('#agency-industry-controls');
  assert.equal(await editor.locator('[data-industry-edit="mode"]').inputValue(), 'observe');
  assert.equal(await editor.locator('input').count(), 0);
  await editor.locator('[data-industry-edit="mode"]').selectOption('filter');
  await editor.locator('[data-industry-edit="mainRankMax"]').fill('');
  await page.locator('#agency-pool-run').click(); assert.match(await page.locator('#agency-pool-error').innerText(), /整数/);
  assert.equal(calls().filter(item => item.name === 'agency:pool:run').length, 0);
  await editor.locator('[data-industry-edit="mainRankMax"]').fill('3');
  await editor.locator('[data-industry-edit="scope"]').selectOption('segment');
  await editor.locator('[data-industry-edit="segmentRankMax"]').fill('2');
  await editor.locator('[data-industry-edit="minSegmentRevenuePct"]').fill('32');
  const query = { version: 1, scope: 'segment', mainRankMax: 3, segmentRankMax: 2, minSegmentRevenuePct: 32 };
  await capture('pool-editor', '#agency-industry-controls'); await poolRun();
  assert.deepEqual(calls().filter(item => item.name === 'agency:pool:run').at(-1).payload.industry, query);
  let account = await call('state'), member = account.agency.groups.flatMap(group => group.members).find(member => member.symbol === 'sh600010');
  assert.deepEqual(member.entryConditions.evidence.industry, query);
  assert.deepEqual(account.agencyPool.lastResult.industry, query);
  assert.equal(account.agencyPool.lastResult.unassignedPending[0].symbol, 'sh600009');
  await page.locator('#agency-pool-filter').selectOption('added');
  await page.locator('#agency-pool-items > details > summary').first().click();
  await page.locator('#agency-pool-items .agency-pool-evidence-detail > summary').first().click();
  await page.locator('#agency-pool-items .industry-review > summary').first().click();
  let text = await page.locator('#agency-pool-items').innerText();
  for (const phrase of ['行业原始指标', '2025', '汽车扬声器', '中国', '市场份额', '全部竞争者', '35%', '未独立取得第三方全文']) assert.ok(text.includes(phrase), phrase);
  await capture('pool-original-indicators', '#agency-pool-items .industry-review');
  const entry = evaluateEntryConditions(member.entryConditions, member.symbol, { symbol: member.symbol, name: '隔离测试', timestamp: stamp, date: '2026-10-15', price: 10.17 }, { automaticEvidence: companyBundle(member.symbol, new Date(now)) }, new Date(now));
  assert.equal(entry.status, 'pass');
  assert.equal(entry.industryReview?.status || entry.selectionEvidence?.industryReview?.status, 'pass');
  await editor.locator('[data-industry-edit="minSegmentRevenuePct"]').fill('50'); await poolRun();
  account = await call('state'); assert.equal(account.agency.groups.flatMap(group => group.members).find(member => member.symbol === 'sh600010').entryConditions.evidence.industry.minSegmentRevenuePct, 32);
  await page.locator('#agency-pool-mode').selectOption('strict'); assert.equal(await editor.isVisible(), false);
  await poolRun(); assert.equal(Object.hasOwn(calls().filter(item => item.name === 'agency:pool:run').at(-1).payload, 'industry'), false);
  await page.locator('#agency-pool-mode').selectOption('strategy'); assert.equal(await editor.locator('[data-industry-edit="minSegmentRevenuePct"]').inputValue(), '50');
  checks.push('Pool UI defaults to observation, rejects incomplete ranks before IPC, sends editable rules, renders original public-source values, persists new member rules, rechecks them, preserves member snapshots, and excludes industry from strict-mode payload while retaining draft.');

  await page.locator('[data-page="screener"]').click(); await page.waitForFunction(() => screenInitialized && !screenBusy);
  const screen = page.locator('#screen-industry-controls');
  assert.equal(await screen.locator('[data-industry-edit="mode"]').inputValue(), 'observe');
  await call('evidence:save', record('sh600010', 2));
  await call('evidence:save', record('sh600011', 6));
  await call('evidence:save', record('sh600012', 1, { coverage: 'listedOnly' }));
  await screen.locator('[data-industry-edit="mode"]').selectOption('filter');
  await screen.locator('[data-industry-edit="scope"]').selectOption('main');
  await screen.locator('[data-industry-edit="mainRankMax"]').fill('3');
  await page.locator('[data-evidence-condition="commercialization"]').check();
  assert.equal(await page.evaluate(() => screenQuery.evidence.industry.mainRankMax), 3);
  await page.locator('[data-evidence-condition="commercialization"]').uncheck();
  await page.locator('#screen-description').fill('股价大于1'); await page.locator('#screen-parse').click(); await page.waitForFunction(() => !screenBusy);
  assert.equal(await page.locator('#screen-error').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => screenResult.rows.map(row => row.symbol)), ['sh600010']);
  assert.ok(await page.evaluate(() => screenResult.evidenceFailedRows.some(row => row.symbol === 'sh600011')));
  assert.ok(await page.evaluate(() => screenResult.evidencePendingRows.some(row => row.symbol === 'sh600012')));
  await page.locator('[data-evidence-group="failed"] > summary').click();
  await page.locator('[data-evidence-group="failed"] .industry-review > summary').click();
  await page.locator('[data-evidence-group="failed"] .industry-review tbody details > summary').click();
  text = await page.locator('[data-evidence-group="failed"]').innerText(); assert.ok(text.includes(injection)); assert.ok(text.includes('排名：6'));
  assert.equal(await page.locator('.industry-review img,.industry-review script').count(), 0); assert.equal(await page.evaluate(() => !!window.industryInjected), false);
  await capture('screen-failed-raw-indicators', '[data-evidence-group="failed"] .industry-review');
  await capture('screen-editor', '#screen-industry-controls');
  await screen.locator('[data-industry-edit="mainRankMax"]').fill('6'); await screenRun();
  await page.locator('#screen-agency-all').click();
  assert.match(await page.locator('#screen-agency-conditions').innerText(), /主营行业排名 ≤ 6/);
  await page.locator('#screen-agency-strategy').selectOption('swing'); await page.locator('#screen-agency-submit').click();
  await page.waitForFunction(() => screenAgencyBatch?.completed && !screenAgencyBusy);
  assert.equal(await page.locator('#screen-agency-error').innerText(), ''); await page.locator('#screen-agency-close').click();
  assert.equal((await call('state')).agency.groups.flatMap(group => group.members).find(member => member.symbol === 'sh600011').entryConditions.evidence.industry.mainRankMax, 6);
  await screen.locator('[data-industry-edit="mainRankMax"]').fill('3');
  await page.locator('#screen-quality-template').click(); assert.equal(await page.evaluate(() => screenQuery.evidence.industry.mainRankMax), 3); assert.equal(await page.evaluate(() => screenQuery.evidence.leadership), undefined);
  await page.locator('#screen-evidence-leadership').selectOption('segmentLeader');
  assert.equal(await page.evaluate(() => screenQuery.evidence.industry), undefined); assert.equal(await screen.locator('[data-industry-edit="mode"]').inputValue(), 'legacy');
  await screen.locator('[data-industry-edit="mode"]').selectOption('filter'); assert.equal(await page.evaluate(() => screenQuery.evidence.leadership), undefined);
  await screen.locator('[data-industry-edit="mode"]').selectOption('observe'); assert.equal(await page.evaluate(() => screenQuery.evidence.industry), undefined);
  checks.push('Ordinary screening uses saved manual rankings, preserves numeric industry through checkbox and text changes, separates failed and pending evidence, escapes source HTML, preserves numeric rules when adding the finance template, and explicitly switches old/new/observation modes.');
  await desktop.close(); desktop = null; await launch(); const after = await call('state');
  assert.deepEqual(after.agency.groups.flatMap(group => group.members).find(member => member.symbol === 'sh600010').entryConditions.evidence.industry, query);
  assert.equal(after.agency.groups.flatMap(group => group.members).find(member => member.symbol === 'sh600011').entryConditions.evidence.industry.mainRankMax, 6);
  assert.deepEqual(after.account.trades, before.account.trades); assert.deepEqual(after.account.risks, before.account.risks);
  assert.deepEqual(after.agency.groups.map(group => group.mode), before.agency.groups.map(group => group.mode));
  assert.deepEqual(errors, []); assert.equal(fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8') : '', '');
  checks.push('Restart preserves saved member thresholds; both 1120/1536 window widths fit. No external request, trade, risk or group-mode change.');
  const report = { status: 'passed', output, scope: 'Synthetic universe and pool strategy classification; actual industry source evaluation, ordinary screener, IPC, renderer, and isolated persistence.', checks, dimensions, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(error => { fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2)); process.stderr.write(error.stack + '\n'); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
