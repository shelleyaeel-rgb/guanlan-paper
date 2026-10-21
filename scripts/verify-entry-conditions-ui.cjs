// Real Electron/IPC, fixture-only data and a new isolated account for each run.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/entry-conditions-ui-'));
const accountPath = path.join(output, 'account'), controlPath = path.join(output, 'control.json');
const networkLog = path.join(output, 'unexpected-network.jsonl'), batchLog = path.join(output, 'batch-requests.jsonl');
fs.writeFileSync(controlPath, JSON.stringify({ now: '2026-09-30T10:00:00+08:00', price: 10.08, dailyMode: 'ready', financeMode: 'ready' }));
const env = { ...process.env, GUANLAN_TEST_CONTROL: controlPath, GUANLAN_TEST_NETWORK_LOG: networkLog, GUANLAN_TEST_BATCH_LOG: batchLog }; delete env.ELECTRON_RUN_AS_NODE;
const fixturePath = path.join(output, 'desktop.cjs');
fs.writeFileSync(fixturePath, `require(${JSON.stringify(path.join(root, 'tests/fixtures/screener-agency-desktop.cjs'))});
const { CorporateSource } = require(${JSON.stringify(path.join(root, 'core/corporate-source.cjs'))});
CorporateSource.prototype.get = async function(input) { return { symbol: input.symbol, source: '隔离公司行为样本', status: 'ready', fetchedAt: Date.now(), coverageStart: input.fromDate, coverageEnd: '2026-09-30', coverageComplete: true, events: [], notices: [] }; };\n`);
let desktop, page; const errors = [], checks = [];
const entries = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const member = (current, symbol) => current.agency.groups.flatMap(group => group.members).find(item => item.symbol === symbol);
async function call(name, payload) { return page.evaluate(async ({ name, payload }) => { const result = await window.guanlan.call(name, payload); if (!result.ok) throw Error(result.error); return result.data; }, { name, payload }); }
async function idle() { await page.waitForFunction(() => !screenBusy && (screenResult || !document.querySelector('#screen-error').classList.contains('hidden')), null, { timeout: 90000 }); }
async function run() { await page.locator('#screen-run').click(); await idle(); }
async function refresh() { await page.evaluate(async () => renderState(await api('state'))); }
async function launch() {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [fixturePath, `--test-data-dir=${accountPath}`], cwd: root, env });
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), path.resolve(accountPath));
  await page.locator('[data-page="screener"]').click(); await idle();
}
async function screenshot(label) {
  for (const [width, height] of [[1120, 760], [1536, 960]]) {
    await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: page fits ${width}px`);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('dialog[open]')].every(dialog => dialog.scrollWidth <= dialog.clientWidth)), true, `${label}: dialog fits ${width}px`);
    if (['saved-members', 'condition-checks'].includes(label)) await page.locator('#agency-members').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-${width}.png`) });
  }
}
async function submitSingle() { await page.locator('#agency-assign-submit').click(); await page.waitForFunction(() => !document.querySelector('#agency-assign-dialog').open); }
async function backToScreen() { await page.locator('[data-page="screener"]').click(); await idle(); }
(async () => {
  await launch();
  for (const symbol of ['sh600002', 'sh600003', 'sh600004']) await call('evidence:save', { symbol, subject: '隔离样本产品', kind: 'demand', value: 'supported', reviewState: 'confirmed', sourceTitle: '隔离测试行业报告', url: 'https://example.com/research', publishedAt: '2026-08-20', period: '2026年度', reviewedAt: '2026-09-20', validUntil: '2026-12-31', quote: '仅为自动化验证的隔离样本。' });
  await page.locator('#screen-strategy').selectOption('long');
  await page.locator('[data-rule="0"] [data-part="value"]').fill('10');
  await page.locator('#screen-exclude-st').check();
  await page.locator('#screen-boards input[value="sh"]').check();
  await page.locator('#screen-catalog summary').click();
  await page.locator('#screen-field-search').fill('MA20');
  await page.locator('#screen-fields [data-field="ma20"]').click();
  await page.locator('.screen-rule').last().locator('[data-part="target"]').selectOption('ma60');
  await page.locator('[data-evidence-condition="demand"]').check();
  await run();
  const original = await page.evaluate(() => structuredClone(screenResult));
  assert.deepEqual(original.rows.map(row => row.symbol).sort(), ['sh600002', 'sh600003', 'sh600004']);
  assert.ok(original.query.rules.some(rule => rule.field === 'roe' && rule.value === 10));
  assert.ok(original.query.rules.some(rule => rule.field === 'ma20' && rule.valueField === 'ma60'));
  await page.locator('[data-screen-agency="sh600002"]').click();
  assert.doesNotMatch(await page.locator('#agency-assign-conditions').innerText(), /10%|10 %/);
  assert.match(await page.locator('#agency-assign-conditions').innerText(), /MA20/);
  assert.match(await page.locator('#agency-assign-conditions').innerText(), /需求增长有依据/);
  assert.equal(await page.locator('#agency-assign-symbol').getAttribute('readonly'), '');
  await screenshot('single-confirmation'); await submitSingle();
  let current = await call('state'); const frozen = member(current, 'sh600002').entryConditions;
  assert.deepEqual(frozen.rules, original.personalRules); assert.deepEqual(frozen.evidence, original.query.evidence);
  assert.equal(frozen.excludeST, true); assert.equal(frozen.source.strategyId, 'long');
  assert.equal(Object.hasOwn(frozen, 'boards'), false); assert.equal(Object.hasOwn(frozen, 'scope'), false);
  checks.push('single result preserves personal field comparisons, exclusion and evidence without duplicating strategy thresholds or board/scope/sort constraints');
  await backToScreen(); await page.locator('[data-rule="0"] [data-part="value"]').fill('11');
  assert.deepEqual(member(await call('state'), 'sh600002').entryConditions, frozen);
  assert.equal(await page.locator('#screen-agency-all').isDisabled(), true);
  await run();
  const batchConditions = await page.evaluate(() => structuredClone(screenEntryConditions(screenResult)));
  await page.locator('#screen-result-search').fill('600003');
  await page.locator('#screen-agency-all').click();
  assert.match(await page.locator('#screen-agency-policy').innerText(), /不会覆盖原有模式和条件/);
  await screenshot('batch-confirmation');
  await page.locator('#screen-agency-submit').click();
  await page.waitForFunction(() => !screenAgencyBusy && screenAgencyBatch?.completed, null, { timeout: 90000 });
  assert.match(await page.locator('#screen-agency-result').innerText(), /已加入 2 只.*跳过 1 只/);
  current = await call('state');
  assert.deepEqual(member(current, 'sh600002').entryConditions, frozen);
  for (const symbol of ['sh600003', 'sh600004']) assert.deepEqual(member(current, symbol).entryConditions.rules, batchConditions.rules);
  assert.equal(entries(batchLog).at(-1).symbols.length, 3);
  assert.deepEqual(entries(batchLog).at(-1).entryConditions.rules, batchConditions.rules);
  checks.push('later screener edits leave an existing member unchanged; batch includes all results despite search and skips existing ownership without overwriting its conditions');
  await page.locator('#screen-agency-close').click();
  await call('agency:member', { strategyId: 'swing', symbol: 'sh600006', action: 'add' }); await refresh();
  const savedBeforeRestart = (await call('state')).agency.groups.flatMap(group => group.members).map(item => ({ symbol: item.symbol, entryConditions: item.entryConditions }));
  await desktop.close(); desktop = null; await launch();
  assert.deepEqual((await call('state')).agency.groups.flatMap(group => group.members).map(item => ({ symbol: item.symbol, entryConditions: item.entryConditions })), savedBeforeRestart);
  await page.locator('[data-page="agency"]').click(); await page.locator('[data-agency-tab="swing"]').click();
  assert.match(await page.locator('#agency-members').innerText(), /未保存选股条件/);
  await page.locator('[data-agency-tab="long"]').click();
  assert.match(await page.locator('#agency-members').innerText(), /已保存选股条件/);
  await screenshot('saved-members');
  checks.push('saved condition snapshots survive a full Electron restart; old/plain members explicitly say no selection conditions were saved');

  // Remove/re-add through real IPC; render an earlier membership's passing log against the new snapshot.
  const previousMembership = member(await call('state'), 'sh600004').entryConditions;
  await call('agency:member', { strategyId: 'long', symbol: 'sh600004', action: 'remove' });
  assert.equal(member(await call('state'), 'sh600004'), undefined);
  const updatedRules = [...previousMembership.rules, { field: 'roe', op: 'gte', value: 12 }];
  await call('agency:member', { strategyId: 'long', symbol: 'sh600004', action: 'add', entryConditions: { rules: updatedRules, excludeST: previousMembership.excludeST, evidence: previousMembership.evidence } });
  assert.deepEqual(member(await call('state'), 'sh600004').entryConditions.rules, updatedRules);
  await refresh();
  await page.evaluate(conditions => {
    const sample = structuredClone(state);
    sample.agency.decisions = [{ strategyId: 'long', symbol: 'sh600004', status: 'waiting', entryConditionsCheck: { conditions, status: 'pass', passed: true, checkedAt: '2026-09-30T02:00:00Z', reasons: [], checks: [] } }];
    renderState(sample);
  }, previousMembership);
  assert.doesNotMatch(await page.locator('#agency-members').innerText(), /持续开仓条件：通过/);
  assert.match(await page.locator('#agency-members').innerText(), /尚无持续条件检查记录/);
  await refresh();
  // Rendering-only fixture: assert single-stock reasons cannot be hidden by a later group record.
  await page.evaluate(() => {
    const sample = structuredClone(state), group = sample.agency.groups.find(group => group.id === 'long');
    group.positions = [{ symbol: 'sh600002', quantity: 100, available: 0, price: 10, pnl: 0 }];
    const conditions = group.members.find(member => member.symbol === 'sh600002').entryConditions;
    sample.agency.decisions = [{ strategyId: 'long', symbol: 'sh600002', status: 'waiting', decisionMode: 'rules', reason: '财务ROE当前9%，要求至少10%', message: '通用等待说明', entryConditionsCheck: { conditions, status: 'pass', passed: true, checkedAt: '2026-09-30T01:59:00Z', reasons: [], checks: [] }, executionCheck: { entryConditionsCheck: { conditions, status: 'failed', passed: false, checkedAt: '2026-09-30T02:00:00Z', reasons: ['ROE 9% < 10%'], checks: [{ label: 'ROE', status: 'failed', actual: '9%', expected: '≥ 10%', reason: '当前低于阈值' }] } } }, { strategyId: 'long', status: 'waiting', reason: '组级等待说明不得覆盖单股' }];
    renderState(sample);
  });
  const rendered = await page.locator('#agency-members').innerText();
  assert.match(rendered, /财务ROE当前9%/); assert.match(rendered, /不会因此直接卖出/);
  assert.match(rendered, /持续开仓条件：不满足/);
  assert.match(await page.locator('#agency-decisions').innerText(), /持续开仓条件：不满足/);
  assert.doesNotMatch(rendered, /持续开仓条件：通过/);
  assert.doesNotMatch(rendered, /组级等待说明不得覆盖单股/);
  await page.locator('#agency-members .agency-entry-check summary').first().click();
  assert.match(await page.locator('#agency-members').innerText(), /实际：9%/);
  await screenshot('condition-checks'); await refresh();
  checks.push('after real removal and re-addition with new conditions, member view rejects the previous membership snapshot; member view and logs prefer execution-time failure over an earlier passing candidate, show concrete failed predicates and holding-only warnings; a newer group log cannot overwrite the stock reason');

  await backToScreen(); await page.locator('#screen-reset').click();
  await page.locator('#screen-description').fill('股价大于1元'); await page.locator('#screen-parse').click(); await idle();
  await page.locator('#screen-result-search').fill('600007');
  await page.locator('[data-screen-open="sh600007"]').click();
  await page.waitForFunction(() => selected === 'sh600007' && page === 'market' && screenSelectedEntryConditions(selected) !== null);
  await page.locator('#agency-selected').click();
  assert.match(await page.locator('#agency-assign-conditions').innerText(), /最新价/); await submitSingle();
  assert.deepEqual(member(await call('state'), 'sh600007').entryConditions.rules, [{ field: 'price', op: 'gt', value: 1 }]);
  checks.push('opening a matching selection result then using the stock-level automatic trading button inherits that result snapshot');
  await backToScreen(); await page.locator('#screen-result-search').fill('600008');
  await page.locator('[data-screen-open="sh600008"]').click();
  await page.waitForFunction(() => selected === 'sh600008' && screenSelectedEntryConditions(selected) !== null);
  await page.locator('[data-page="agency"]').click(); await page.locator('[data-page="market"]').click();
  await page.locator('#agency-selected').click();
  assert.match(await page.locator('#agency-assign-conditions').innerText(), /未携带选股条件/); await submitSingle();
  assert.equal(member(await call('state'), 'sh600008').entryConditions ?? null, null);
  await backToScreen(); await page.locator('#screen-result-search').fill('600009');
  await page.locator('[data-screen-open="sh600009"]').click();
  await page.waitForFunction(() => selected === 'sh600009' && screenSelectedEntryConditions(selected) !== null);
  await page.locator('#remove-watch').click();
  await page.locator('[data-watch-agency="sh600009"]').click();
  assert.match(await page.locator('#agency-assign-conditions').innerText(), /未携带选股条件/);
  await page.locator('#agency-assign-cancel').click();
  await page.locator('[data-symbol="sh600009"]').click();
  await page.locator('#agency-selected').click();
  assert.match(await page.locator('#agency-assign-conditions').innerText(), /未携带选股条件/);
  await page.locator('#agency-assign-cancel').click();
  checks.push('leaving the selected stock page clears its provenance; ordinary watchlist addition never inherits a stale or unrelated screening context');
  assert.deepEqual(errors, []); assert.equal(entries(networkLog).length, 0);
  const report = { output, accountPath, errors, checks, unexpectedNetworkRequests: entries(networkLog).length };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => { console.error(error); console.error('Output:', output); if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
