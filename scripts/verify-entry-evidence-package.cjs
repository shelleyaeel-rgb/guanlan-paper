// Real packaged main startup, portable backup-envelope restoration and missing
// archive diagnostics. Every account/object used here is created in a new work
// directory; all groups are stopped and market traffic is disabled.
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const asar = require('@electron/asar');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { EntryEvidenceStore } = require('../core/entry-evidence-store.cjs');
const { companyBundle } = require('../tests/fixtures/company-evidence-data.cjs');
const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.env.GUANLAN_PACKAGE_EXE || path.join(root, 'releases/local-document-research/win-unpacked/Guanlan.exe'));
const archiveFile = path.join(path.dirname(executable), 'resources/app.asar');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/entry-evidence-package-'));
const seedDirectory = path.join(output, 'seed'), accountDirectory = path.join(output, 'account');
fs.mkdirSync(accountDirectory); const accountFile = path.join(accountDirectory, 'account.json');
const now = new Date('2026-10-13T02:00:00.000Z'), symbol = 'sz000001';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('GUANLAN_TEST_')) delete env[key];
let desktop, page; const errors = [], checks = [];

function seed() {
  const evidence = new EntryEvidenceStore(seedDirectory), engine = new Engine(initialState(100000), () => now);
  engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
  engine.agencyMember({ strategyId: 'swing', symbol, action: 'add', entryConditions: { rules: [],
    evidence: { conditions: ['productOutlook', 'financialReview'], leadership: 'either', minSegmentRevenuePct: 30 }, source: { kind: 'agency-pool', policyVersion: 2 } } });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const quote = { symbol, name: '隔离开仓归档样本', source: 'fixture', price: 10.1, prevClose: 10.05, open: 10, low: 10, high: 10.2,
    volume: 100000, bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05, timestamp: now.getTime(), date: '2026-10-13' };
  const bundle = companyBundle(symbol, now), { evaluateCompanyEvidence } = require('../core/company-evidence.cjs');
  const industryText = '2025年隔离声学股份有限公司在全国汽车扬声器市场份额排名第1，统计覆盖全部竞争者。';
  const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const rawSource = JSON.stringify({ title: '隔离官方原文夹具', content: industryText });
  bundle.industryDocuments = [{ id: 'frost-archive-fixture', issuerSymbol: symbol, kind: 'industry-report', title: '隔离行业原文',
    url: 'https://www.frostchina.com/content/insight/detail/fixture', publishedAt: '2026-10-12', fetchedAt: +now, complete: true,
    text: industryText, textHash: digest(industryText), sourceHash: digest(rawSource), rawSource, pages: 1,
    pageTexts: [{ page: 1, text: industryText, method: 'provider-text', complete: true, numericEligible: true }] }];
  const snapshot = { source: 'fixture daily', fetchedAt: now.getTime(), automaticEvidence: bundle,
    automaticEvidenceEvaluation: evaluateCompanyEvidence(bundle, engine.s.agency.groups.find(group => group.id === 'swing').members[0].entryConditions.evidence, now),
    notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } },
    technical: { asOf: '2026-10-12', close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true,
      breakout: false, support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-10-12'] } };
  const a = engine.s.agency;
  const trade = engine.agencyExecute({ strategyId: 'swing', symbol, action: 'buy', targetPercent: 30, decisionId: 'packaged-archive-restoration',
    expectedEpoch: a.epoch, expectedRevision: a.revision, archiveEntryEvidence: input => evidence.archive(input) }, quote, snapshot, { [symbol]: quote });
  for (const group of a.groups) engine.agencyMode({ strategyId: group.id, mode: 'stopped' });
  assert.equal(validState(engine.s), true); assert.equal(trade.entryEvidenceRequired, true);
  const backup = evidence.exportAccount(engine.s); fs.writeFileSync(accountFile, JSON.stringify(backup, null, 2));
  return { account: structuredClone(engine.s), ref: trade.entryEvidenceRef, backup };
}
function verifyPackage() {
  assert.ok(fs.existsSync(executable));
  const files = ['main.cjs', 'core/store.cjs', 'core/entry-evidence-store.cjs', 'core/agency-ledger.cjs', 'core/agency-service.cjs', 'core/company-evidence.cjs'];
  for (const file of files) assert.ok(asar.extractFile(archiveFile, path.normalize(file)).equals(fs.readFileSync(path.join(root, file))), `package/source mismatch: ${file}`);
  return files;
}
async function launch() {
  desktop = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${accountDirectory}`], cwd: root, env, timeout: 60000 });
  const appPath = await desktop.evaluate(({ app, net }) => { net.fetch = async () => new Response('Isolated archive check: no live data', { status: 503 }); return app.getAppPath(); });
  assert.equal(path.resolve(appPath), path.resolve(archiveFile));
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  return page.evaluate(async () => { const result = await window.guanlan.call('state'); if (!result.ok) throw Error(result.error); return result.data; });
}
async function close() { if (desktop) { await desktop.close(); desktop = null; page = null; } }
function unchanged(current, original) {
  assert.equal(path.resolve(current.dataPath), path.resolve(accountDirectory));
  assert.equal(current.account.cash, original.cash); assert.deepEqual(current.account.trades, original.trades);
  assert.deepEqual(current.account.lots, original.lots); assert.deepEqual(current.account.orders, original.orders);
  assert.deepEqual(current.account.agency.transfers, original.agency.transfers);
  assert.ok(current.agency.groups.every(group => group.mode === 'stopped')); assert.equal(current.agencyPool.running, false);
}
async function inspectPackagedArchive(ref) {
  return desktop.evaluate(({ app }, input) => {
    const mainRequire = process.mainModule.require.bind(process.mainModule), path = mainRequire('node:path');
    const bundledRequire = mainRequire('node:module').createRequire(path.join(app.getAppPath(), 'package.json'));
    const { EntryEvidenceStore } = bundledRequire('./core/entry-evidence-store.cjs');
    const evidence = new EntryEvidenceStore(path.join(app.getPath('userData'), 'entry-evidence'));
    return evidence.read(input);
  }, ref);
}
(async () => {
  const comparedFiles = verifyPackage(), original = seed();
  let current = await launch(); unchanged(current, original.account);
  assert.doesNotMatch(current.warning || '', /开仓依据档案缺失或损坏/);
  const restored = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
  assert.equal(restored.format, undefined); assert.equal(validState(restored), true);
  const snapshot = await inspectPackagedArchive(original.ref);
  assert.equal(snapshot.decisionId, original.ref.decisionId); assert.equal(snapshot.snapshot.automaticEvidence.documents.length, 2);
  assert.match(snapshot.snapshot.automaticEvidence.documents[1].text, /2026年半年度报告/);
  assert.equal(snapshot.snapshot.automaticEvidence.industryDocuments.length, 1);
  assert.match(snapshot.snapshot.automaticEvidence.industryDocuments[0].text, /统计覆盖全部竞争者/);
  assert.match(snapshot.snapshot.automaticEvidence.industryDocuments[0].rawSource, /隔离官方原文夹具/);
  assert.equal(snapshot.snapshot.automaticEvidenceEvaluation.status, 'pass');
  checks.push('real packaged main restores a copied backup envelope and all referenced text objects, saves a plain valid account, and reads immutable evidence through the ASAR implementation');
  await close();
  const evidence = new EntryEvidenceStore(path.join(accountDirectory, 'entry-evidence'));
  const manifest = evidence.manifest(original.ref), textRef = manifest.snapshot.snapshot.automaticEvidence.documents[0].archivedText;
  const objectFile = evidence.file('text', textRef.hash), preservedFile = path.join(output, 'intentionally-withheld-text.txt');
  assert.ok(path.resolve(objectFile).startsWith(path.resolve(output) + path.sep));
  assert.equal(path.dirname(preservedFile), output); fs.renameSync(objectFile, preservedFile);
  current = await launch(); unchanged(current, original.account);
  assert.match(current.warning, /开仓依据档案缺失或损坏，暂停自动新开仓；已有持仓退出继续/);
  await page.locator('[data-page="agency"]').click();
  await page.screenshot({ path: path.join(output, 'packaged-missing-archive.png'), fullPage: true });
  checks.push('a second isolated packaged startup detects one withheld archive object and exposes the explicit new-entry warning, while preserving every trade, lot, order and cash balance');
  const missingObjectWarning = current.warning;
  await close();
  fs.writeFileSync(objectFile, 'Deliberately damaged isolated archive object');
  fs.writeFileSync(accountFile, JSON.stringify(original.backup, null, 2));
  current = await launch(); unchanged(current, original.account);
  assert.doesNotMatch(current.warning || '', /开仓依据档案缺失或损坏/);
  const repaired = await inspectPackagedArchive(original.ref);
  assert.match(repaired.snapshot.automaticEvidence.documents[0].text, /2025年年度报告/);
  const quarantined = fs.readdirSync(path.dirname(objectFile)).filter(name => name.startsWith(path.basename(objectFile) + '.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(objectFile), quarantined[0]), 'utf8'), 'Deliberately damaged isolated archive object');
  checks.push('copying the valid backup envelope into the same account directory repairs a corrupted text object, preserves its damaged bytes in a .corrupt file and clears the missing-evidence warning without changing accounting');
  assert.deepEqual(errors, []);
  const report = { status: 'passed', output, executable, archiveFile, comparedFiles, ref: original.ref,
    objectsInBackup: original.backup.objects.length, restoredDocuments: snapshot.snapshot.automaticEvidence.documents.length,
    missingObjectWarning, repairedCorruptObjects: quarantined.length, account: { trades: current.account.trades.length, cash: current.account.cash, groups: current.agency.groups.map(group => ({ id: group.id, mode: group.mode })) },
    limitations: ['No live market or trade execution is exercised by this startup check; entry blocking and continued T+1 exit execution are covered by isolated business tests.'], checks, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => { console.error(error.stack); console.error('Output:', output); if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; }).finally(close);
