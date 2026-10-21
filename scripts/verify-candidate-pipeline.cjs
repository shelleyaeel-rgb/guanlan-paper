'use strict';
// Real production main, IPC, UI and public data. This runner never imports or
// copies a live account, allocates strategy funds, or enables trading.
// Example: node scripts/verify-candidate-pipeline.cjs --round=1 --operation=update
// Reuse --account-dir for rounds 2/3 to test persisted research/cache recovery.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '..'), work = path.join(root, 'work');
const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  if (!argument.startsWith('--')) throw Error(`Unknown argument: ${argument}`);
  const equal = argument.indexOf('=');
  return equal < 0 ? [argument.slice(2), true] : [argument.slice(2, equal), argument.slice(equal + 1)];
}));
if (options.help) {
  console.log('Usage: node scripts/verify-candidate-pipeline.cjs --round=1|2|3 --operation=update|retry --account-dir=<work/.../isolated-account> --output-dir=<work/.../round-N> [--timeout-ms=7200000] [--cancel-file=<work/.../cancel>] [--cdp-port=9224]');
  console.log('Environment alternatives: GUANLAN_PIPELINE_ROUND, GUANLAN_PIPELINE_OPERATION, GUANLAN_PIPELINE_ACCOUNT_DIR, GUANLAN_PIPELINE_OUTPUT_DIR, GUANLAN_PIPELINE_TIMEOUT_MS, GUANLAN_PIPELINE_CANCEL_FILE, GUANLAN_PIPELINE_CDP_PORT. GUANLAN_PLAYWRIGHT_PATH overrides Playwright discovery.');
  process.exit(0);
}
for (const key of Object.keys(options)) assert.ok(['round', 'operation', 'account-dir', 'output-dir', 'timeout-ms', 'cancel-file', 'cdp-port'].includes(key), `Unknown option --${key}`);
const option = (key, env, fallback) => options[key] ?? process.env[env] ?? fallback;
const round = Number(option('round', 'GUANLAN_PIPELINE_ROUND', 1));
const operation = option('operation', 'GUANLAN_PIPELINE_OPERATION', 'update');
const timeoutMs = Number(option('timeout-ms', 'GUANLAN_PIPELINE_TIMEOUT_MS', 2 * 60 * 60 * 1000));
const cdpPort = Number(option('cdp-port', 'GUANLAN_PIPELINE_CDP_PORT', 0));
assert.ok([1, 2, 3].includes(round), 'Only rounds 1, 2 and 3 are permitted');
assert.ok(['update', 'retry'].includes(operation), 'Operation must be update or retry');
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 2 * 60 * 60 * 1000, 'Timeout must be 1 second to 2 hours');
assert.ok(Number.isSafeInteger(cdpPort) && (cdpPort === 0 || cdpPort >= 1024 && cdpPort <= 65535), 'Invalid CDP port');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const accountDir = path.resolve(option('account-dir', 'GUANLAN_PIPELINE_ACCOUNT_DIR', path.join(work, 'candidate-pipeline-e2e/isolated-account')));
const output = path.resolve(option('output-dir', 'GUANLAN_PIPELINE_OUTPUT_DIR', path.join(work, `candidate-pipeline-e2e/round-${round}-${stamp}`)));
const cancelFile = path.resolve(option('cancel-file', 'GUANLAN_PIPELINE_CANCEL_FILE', path.join(output, 'cancel')));

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function guardWorkspacePath(target) {
  assert.ok(isInside(work, target), `Test path must be a child of ${work}: ${target}`);
  let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const workReal = fs.realpathSync(work), existingReal = fs.realpathSync(existing);
  assert.ok(existingReal === workReal || isInside(workReal, existingReal), `Test path escapes work through a link: ${target}`);
}
function safeAccountSummary(account) {
  return { cash: account.cash, initialCash: account.initialCash,
    trades: account.trades?.length, orders: account.orders?.length, positions: account.lots?.length,
    transfers: account.agency?.transfers?.length,
    groups: account.agency?.groups?.map(group => ({ id: group.id, mode: group.mode, cash: group.cash, netFunding: group.netFunding })) };
}
function assertIsolatedAccount(account) {
  const summary = safeAccountSummary(account);
  assert.equal(summary.trades, 0, 'Test account must have no trades');
  assert.equal(summary.orders, 0, 'Test account must have no orders');
  assert.equal(summary.positions, 0, 'Test account must have no holdings');
  assert.equal(summary.transfers, 0, 'Test account must have no strategy funding transfers');
  assert.equal(summary.groups?.length, 4, 'Expected four strategy groups');
  assert.ok(summary.groups.every(group => group.mode === 'paused' && group.cash === 0 && group.netFunding === 0), 'All strategies must remain paused and unfunded');
  return summary;
}
function prepareDirectories() {
  fs.mkdirSync(work, { recursive: true });
  for (const target of [accountDir, output, cancelFile]) guardWorkspacePath(target);
  assert.ok(output !== accountDir && !isInside(accountDir, output) && !isInside(output, accountDir), 'Account and output directories must be separate');
  fs.mkdirSync(accountDir, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const marker = path.join(accountDir, '.candidate-pipeline-isolated.json');
  if (fs.existsSync(marker)) {
    const identity = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(identity.format, 'guanlan-candidate-pipeline-isolated-v1');
    assert.equal(path.resolve(identity.accountDir), accountDir); assert.equal(path.resolve(identity.root), root);
  } else {
    assert.ok(!fs.readdirSync(accountDir).some(name => /^account(?:[.-]|$)/i.test(name)), 'Refusing an existing account without this runner\'s isolation marker');
    assert.equal(round, 1, 'First creation must be round 1');
    fs.writeFileSync(marker, JSON.stringify({ format: 'guanlan-candidate-pipeline-isolated-v1', root, accountDir, createdAt: new Date().toISOString(), purpose: 'Paused, unfunded public-data verification only' }, null, 2), { flag: 'wx' });
  }
  const accountFile = path.join(accountDir, 'account.json');
  if (fs.existsSync(accountFile)) {
    const account = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
    assert.ok(require('../core/engine.cjs').validState(account), 'Isolated account failed validation');
    assertIsolatedAccount(account);
  } else assert.equal(round, 1, 'Later rounds must reuse the existing isolated account');
  assert.ok(!fs.existsSync(path.join(output, 'report.json')), 'Output already has a report; choose a fresh output directory');
  assert.ok(!fs.existsSync(cancelFile), 'Cancel file already exists; choose a new cancel path before starting');
}
function loadPlaywright() {
  const choices = [process.env.GUANLAN_PLAYWRIGHT_PATH, 'playwright',
    path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean);
  const failures = [];
  for (const candidate of choices) {
    try { const loaded = require(candidate); if (loaded._electron?.launch) return { library: loaded, resolved: require.resolve(candidate) }; }
    catch (error) { failures.push(`${candidate}: ${error.code || error.message}`); }
  }
  throw Error(`Playwright Electron support was not found. Set GUANLAN_PLAYWRIGHT_PATH. ${failures.join('; ')}`);
}
function pendingRows(result) {
  const rows = new Map();
  for (const category of ['pending', 'unassignedPending', 'held']) for (const item of result?.[category] || []) {
    if (category === 'held' && item.status !== 'pending') continue;
    const row = rows.get(item.symbol) || { symbol: item.symbol, name: item.name, categories: [], strategyIds: [], reasons: [], checks: [], diagnostics: [] };
    row.categories.push(category);
    row.strategyIds = [...new Set([...row.strategyIds, ...(item.strategyIds || []), ...(item.strategyId ? [item.strategyId] : [])])];
    row.reasons = [...new Set([...row.reasons, ...(item.reasons || []), ...(item.evidenceReview?.reasons || [])])];
    row.checks.push(...(item.evidenceReview?.checks || []).filter(check => check.status !== 'pass').map(check => ({ key: check.key, label: check.label, status: check.status, reason: check.reason, records: check.records })));
    if (item.diagnostics) row.diagnostics.push(item.diagnostics);
    if (item.technicalError) row.technicalError = item.technicalError;
    if (item.evidenceReview?.collection) row.collection = item.evidenceReview.collection;
    rows.set(item.symbol, row);
  }
  return [...rows.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

const report = { round, operation, root, output, accountDir, cancelFile, timeoutMs, cdpPort: cdpPort || null,
  startedAt: new Date().toISOString(), scope: '真实 main / IPC / 按钮 / 公开数据；隔离虚拟账户，四策略暂停且未划入资金', errors: [] };
let desktop, page, cancelled = false, cancelReason = '', runId = null, initialResultId = null;
let cancellationAt = null, closedUnexpectedly = false, pathsReady = false;
const requestCancellation = reason => { cancelled = true; cancelReason ||= reason; };
process.on('SIGINT', () => requestCancellation('SIGINT'));
process.on('SIGTERM', () => requestCancellation('SIGTERM'));
async function call(name) {
  return page.evaluate(async name => { const response = await window.guanlan.call(name); if (!response.ok) throw Error(response.error); return response.data; }, name);
}
async function collectProbe() {
  return page.evaluate(() => {
    const probe = window.__candidatePipelineProbe;
    if (!probe) return null;
    const now = performance.now(), phases = [...probe.phases];
    if (probe.phase) phases.push({ stage: probe.phase, startedMs: probe.phaseAt, elapsedMs: Math.round(now - probe.phaseAt) });
    return { lightMessages: probe.lightMessages, lightBytes: probe.lightBytes, maxLightBytes: probe.maxLightBytes,
      fullMessages: probe.fullMessages, accountObservations: probe.accountObservations,
      firstLightAfterClickMs: probe.firstLightAt == null ? null : Math.round(probe.firstLightAt - probe.clickAt),
      violations: probe.violations, phases, latest: probe.latest };
  });
}
async function saveScreenshot(name) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 30000 }).catch(error => { report.errors.push(`Screenshot: ${error.message}`); });
}

(async () => {
  prepareDirectories(); pathsReady = true;
  const playwright = loadPlaywright(); report.playwright = playwright.resolved;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('GUANLAN_TEST_')) delete env[key];
  desktop = await playwright.library._electron.launch({ executablePath: require('electron'),
    args: [root, `--test-data-dir=${accountDir}`, ...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [])], cwd: root, env, timeout: 120000 });
  desktop.on('close', () => { closedUnexpectedly = true; });
  page = await desktop.firstWindow();
  page.on('pageerror', error => { if (report.errors.length < 100) report.errors.push(error.message); });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state?.agencyPool && state.agency?.groups?.length === 4, null, { timeout: 60000 });
  const initial = await call('state');
  assert.equal(path.resolve(initial.dataPath), accountDir, 'Production main must use the isolated account path');
  report.accountBefore = assertIsolatedAccount(initial.account);
  initialResultId = initial.agencyPool.lastResult?.id || null;
  report.previousResultId = initialResultId;
  await page.evaluate(baseline => {
    const probe = window.__candidatePipelineProbe = { lightMessages: 0, lightBytes: 0, maxLightBytes: 0, fullMessages: 0,
      accountObservations: 0, violations: [], phases: [], phase: null, phaseAt: null, latest: null, firstLightAt: null, clickAt: performance.now() };
    const setProgress = pool => {
      probe.latest = { runId: pool?.runId, running: !!pool?.running, operation: pool?.operation, elapsedMs: pool?.elapsedMs,
        progress: pool?.progress || null, lastError: pool?.lastError || '', resultId: pool?.lastResult?.id || null };
      const stage = pool?.running ? pool.progress?.stage || 'preparing' : 'idle', now = performance.now();
      if (probe.phase !== stage) {
        if (probe.phase) probe.phases.push({ stage: probe.phase, startedMs: probe.phaseAt, elapsedMs: Math.round(now - probe.phaseAt) });
        probe.phase = stage; probe.phaseAt = now;
      }
    };
    assertBridge();
    function assertBridge() { if (typeof window.guanlan.subscribeAgencyPoolProgress !== 'function') throw Error('Missing production lightweight progress subscription'); }
    window.guanlan.subscribeAgencyPoolProgress(message => {
      const size = new TextEncoder().encode(JSON.stringify(message)).length;
      probe.lightMessages++; probe.lightBytes += size; probe.maxLightBytes = Math.max(probe.maxLightBytes, size); probe.firstLightAt ??= performance.now();
      if (Object.hasOwn(message, 'account') || Object.hasOwn(message, 'lastResult') || Object.hasOwn(message, 'policy')) probe.violations.push('Lightweight progress contained account, result or policy');
      setProgress(message);
    });
    window.guanlan.subscribe(snapshot => {
      probe.fullMessages++; probe.accountObservations++;
      const account = snapshot.account;
      const unsafe = account.trades.length || account.orders.length || account.lots.length || account.agency.transfers.length
        || account.cash !== baseline.cash || account.initialCash !== baseline.initialCash
        || account.agency.groups.some(group => group.mode !== 'paused' || group.cash !== 0 || group.netFunding !== 0);
      if (unsafe && probe.violations.length < 100) probe.violations.push('Account funds, orders, holdings, trades, transfers or strategy modes changed');
      setProgress(snapshot.agencyPool);
    });
  }, report.accountBefore);
  await page.locator('[data-page="agency"]').click();
  const button = page.locator(operation === 'retry' ? '#agency-pool-retry' : '#agency-pool-run');
  assert.equal(await button.isVisible(), true, `${operation} button must be visible`);
  assert.equal(await button.isEnabled(), true, `${operation} button must be enabled`);
  await page.evaluate(() => { window.__candidatePipelineProbe.clickAt = performance.now(); });
  report.clickedAt = new Date().toISOString(); const clickedAt = Date.now();
  await button.click();
  await page.waitForFunction(previousId => state.agencyPool?.running || state.agencyPool?.lastError
    || state.agencyPool?.lastResult?.id && state.agencyPool.lastResult.id !== previousId, initialResultId, { timeout: 30000 });
  let nextPrintAt = 0, done = false;
  while (!done) {
    if (closedUnexpectedly || page.isClosed()) throw Error('Electron closed before verification completed');
    const status = await page.evaluate(() => ({ runId: state.agencyPool?.runId, running: !!state.agencyPool?.running,
      progress: state.agencyPool?.progress, elapsedMs: state.agencyPool?.elapsedMs, lastError: state.agencyPool?.lastError,
      resultId: state.agencyPool?.lastResult?.id || null, busy: agencyUi.busy.has('pool-run') || agencyUi.busy.has('pool-retry'),
      lightMessages: window.__candidatePipelineProbe.lightMessages, maxLightBytes: window.__candidatePipelineProbe.maxLightBytes,
      violations: window.__candidatePipelineProbe.violations.length }));
    runId ||= status.runId;
    const now = Date.now();
    if (now >= nextPrintAt) {
      const detail = status.progress?.detail;
      console.log(JSON.stringify({ type: 'progress', round, operation, elapsedMs: now - clickedAt, runId: status.runId,
        running: status.running, stage: status.progress?.stage, completed: status.progress?.completed, total: status.progress?.total,
        document: detail?.documentId, symbol: detail?.symbol, page: detail?.page, pages: detail?.pages,
        detailStage: detail?.stage, lightMessages: status.lightMessages, maxLightBytes: status.maxLightBytes, cancelling: cancelled }));
      nextPrintAt = now + 15000;
    }
    if (status.violations) throw Error('Account/progress invariant failed; see report');
    done = !status.running && !status.busy && (!!status.lastError || status.resultId !== initialResultId || cancelled);
    if (done) break;
    if (now - clickedAt >= timeoutMs) requestCancellation('timeout');
    if (fs.existsSync(cancelFile)) requestCancellation('cancel-file');
    if (cancelled && cancellationAt === null) {
      cancellationAt = now;
      const cancelButton = page.locator('#agency-pool-cancel');
      if (await cancelButton.isVisible() && await cancelButton.isEnabled()) await cancelButton.click();
      else await call('agency:pool:cancel');
    }
    if (cancellationAt !== null && now - cancellationAt > 120000) throw Error('Cancellation did not settle within two minutes');
    await delay(1000);
  }
  const final = await call('state'); report.accountAfter = assertIsolatedAccount(final.account);
  assert.deepEqual(report.accountAfter, report.accountBefore, 'No cash, trades, orders, holdings, transfers or mode changes');
  report.accountUnchanged = true;
  report.probe = await collectProbe();
  assert.deepEqual(report.probe.violations, []);
  report.runId = runId; report.elapsedMs = Date.now() - clickedAt;
  report.cancelled = cancelled; if (cancelled) report.cancelReason = cancelReason;
  const pool = final.agencyPool;
  report.lastError = pool.lastError || '';
  report.completed = !pool.running && !!pool.lastResult && pool.lastResult.id !== initialResultId && !pool.lastError;
  if (report.completed) {
    const result = pool.lastResult, pending = pendingRows(result);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(output, 'pending.json'), JSON.stringify(pending, null, 2));
    report.result = { id: result.id, startedAt: result.startedAt, finishedAt: result.finishedAt, counts: result.counts,
      coverage: result.coverage, sources: result.sources, strategies: result.strategies, pendingCompanies: pending.length };
    report.hasPending = pending.length > 0 || (result.coverage?.diagnostics?.pendingCompanies || 0) > 0 || result.coverage?.partial === true;
    report.fullyVerified = !report.hasPending && result.coverage?.universeComplete === true;
    assert.equal(await page.locator('#agency-pool-run').isEnabled(), true);
    if (report.elapsedMs >= 2000) assert.ok(report.probe.lightMessages > 0, 'Expected at least one lightweight progress event during a long run');
    await saveScreenshot('completed.png');
  } else {
    await saveScreenshot(cancelled ? 'cancelled.png' : 'failed.png');
    if (cancelled) { report.ok = false; process.exitCode = 2; }
    else throw Error(pool.lastError || 'Run ended without a new completed result');
  }
  assert.deepEqual(report.errors, []);
  report.ok ??= true;
})().catch(async error => {
  report.ok = false; report.error = error.stack || error.message; process.exitCode = 1;
  if (page && !page.isClosed()) {
    report.probe = await collectProbe().catch(() => null);
    // Best effort cancellation is confined to the verified isolated window.
    if (report.accountBefore) await call('agency:pool:cancel').catch(() => {});
    await saveScreenshot('failed.png');
  }
}).finally(async () => {
  if (desktop) await desktop.close().catch(error => { report.closeError = error.message; });
  report.finishedAt = new Date().toISOString();
  // Do not write any artifact if path/identity validation failed.
  if (pathsReady && fs.existsSync(output) && isInside(work, output)) {
    try { guardWorkspacePath(output); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
    catch (error) { report.writeError = error.message; }
  }
  console.log(JSON.stringify({ type: 'finished', round, operation, ok: report.ok, completed: report.completed || false,
    cancelled: report.cancelled || false, hasPending: report.hasPending, pendingCompanies: report.result?.pendingCompanies,
    elapsedMs: report.elapsedMs, report: path.join(output, 'report.json'), error: report.error || report.lastError || report.writeError || undefined }));
});
