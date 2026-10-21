// Packaged-app smoke check. A fresh user-data directory is mandatory.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const { extractFile } = require('@electron/asar');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const packaged = ['main.cjs', 'preload.cjs', 'core/screener.cjs', 'core/strategy-presets.cjs', 'core/selection-evidence.cjs', 'core/selection-evidence-store.cjs', 'ui/index.html', 'ui/style.css', 'ui/screener.js', 'ui/research.js', 'ui/selection-evidence.js'];
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
for (const file of packaged) assert.deepEqual(extractFile(archive, file), fs.readFileSync(path.join(root, file)), `packaged file must match source: ${file}`);
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/selection-evidence-package-')), dataPath = path.join(output, 'account');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.GUANLAN_TEST_CONTROL;
let desktop; const errors = [];
(async () => {
  desktop = await _electron.launch({ executablePath: path.join(root, 'dist/win-unpacked/Guanlan.exe'), args: [`--user-data-dir=${dataPath}`], cwd: root, env });
  const page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.account);
  assert.equal(path.resolve(await page.evaluate(() => state.dataPath)), path.resolve(dataPath));
  const result = await page.evaluate(async () => {
    const meta = await api('screener:meta');
    const parsed = await api('screener:parse', '财务状况良好，产品前景有证据支持，主行业前三或细分龙头');
    const before = await api('evidence:list');
    const saved = await api('evidence:save', { symbol: '600519', kind: 'demand', subject: '打包隔离测试', value: 'unknown', reviewState: 'draft' });
    const loaded = await api('evidence:list', { symbol: 'sh600519' });
    const removed = await api('evidence:remove', { id: saved.id });
    const unsafe = await window.guanlan.call('evidence:save', { symbol: '600519', kind: 'demand', subject: '打包隔离测试', value: 'unknown', reviewState: 'draft', url: 'javascript:alert(1)' });
    return { ruleCount: meta.financialQualityRules.length, annualField: meta.fields.annualRoeAverage.source, conditions: parsed.query.evidence.conditions, leadership: parsed.query.evidence.leadership, before: before.length, loaded: loaded.length, removed, unsafeRejected: !unsafe.ok, after: (await api('evidence:list')).length, renderer: typeof renderSelectionEvidenceDetails, trades: state.account.trades.length, orders: state.account.orders.length };
  });
  assert.deepEqual(result, { ruleCount: 7, annualField: 'finance', conditions: ['productOutlook', 'financialReview'], leadership: 'either', before: 0, loaded: 1, removed: true, unsafeRejected: true, after: 0, renderer: 'function', trades: 0, orders: 0 });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ packaged, result, errors, dataPath }, null, 2));
  console.log(JSON.stringify({ output, packagedFilesMatch: packaged.length, result, errors }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (desktop) await desktop.close(); });
