// Read-only historical parsing replay. The input is an immutable exported
// public-document corpus, never a live account/cache. Every run gets a new
// output directory; collection times are preserved and never refreshed.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildProductMetrics } = require('../core/company-product-metrics.cjs');
const { acquisitionDiagnostics, productSourceIssues } = require('../core/company-research.cjs');
const { PRODUCT_RESEARCH_FIELDS } = require('../core/research-rules.cjs');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== '--input')) throw Error('Usage: node scripts/verify-operating-metrics-replay.cjs [--input EXPORTED_CORPUS_DIRECTORY]');
const input = path.resolve(argv[1] || path.join(root, 'work/product-evidence-replay-SwxXYz'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
const count = (object, key) => { object[key] = (object[key] || 0) + 1; };
const iso = value => Number.isFinite(typeof value === 'string' ? Date.parse(value) : value) ? new Date(value).toISOString() : null;
function inputFile(relative) {
  const file = path.resolve(input, relative), rel = path.relative(input, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error(`Invalid corpus file path: ${relative}`);
  return file;
}
const manifestFile = inputFile('manifest.json'), manifestBytes = fs.readFileSync(manifestFile), manifest = JSON.parse(manifestBytes);
const originalReportFile = inputFile('report.json');
const originalReportHash = fs.existsSync(originalReportFile) ? hash(fs.readFileSync(originalReportFile)) : null;
const listed = new Map(manifest.files.map(item => [item.file, item.sha256]));
function verifyInput() {
  if (hash(fs.readFileSync(manifestFile)) !== hash(manifestBytes)) throw Error('The original manifest changed during replay');
  if (originalReportHash && hash(fs.readFileSync(originalReportFile)) !== originalReportHash) throw Error('The original report changed during replay');
  for (const [file, expected] of listed) if (hash(fs.readFileSync(inputFile(file))) !== expected) throw Error(`Exported public document changed: ${file}`);
}
function listedRead(relative) {
  if (!listed.has(relative)) throw Error(`Required file was not included in the immutable manifest: ${relative}`);
  return read(inputFile(relative));
}
verifyInput();
const started = new Date(), output = fs.mkdtempSync(path.join(root, 'work/operating-metrics-replay-'));
fs.mkdirSync(path.join(output, 'snapshots'));
const codeFiles = ['scripts/verify-operating-metrics-replay.cjs', 'core/company-product-metrics.cjs', 'core/company-product-tables.cjs',
  'core/company-evidence-structured.cjs', 'core/company-evidence-text.cjs', 'core/company-research.cjs', 'core/research-rules.cjs'];
const codeHashes = codeFiles.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) }));
const summary = { manifestCompanies: manifest.rows.length, replayedCompanies: 0, unavailableCompanies: 0,
  companiesWithProductRows: 0, companiesWithAnyUsableRawMetric: 0, companiesWithAnyUsableEditableMetric: 0,
  companiesWithOneProductHavingAllSevenEditableMetrics: 0, products: 0, productsWithAnyUsableRawMetric: 0,
  productsWithAnyUsableEditableMetric: 0, productsWithAllSevenEditableMetrics: 0,
  companiesWithSourceIssuesAtRecordedTime: 0, companiesWithSourceIssuesAtReplayWallClock: 0,
  companiesWhoseCollectionIsOlderThanSixHoursAtReplayWallClock: 0,
  fieldCoverage: {}, cellMissingOrConflictReasons: {}, observationIssues: {}, documentDiagnostics: {},
  acquisitionDiagnostics: {}, noProductRowReasons: {}, sourceIssuesAtRecordedTime: {}, sourceIssuesAtReplayWallClock: {} };
const rawFields = ['currentRevenue', 'previousRevenue', 'currentCost', 'previousCost', 'currentTotalRevenue', 'previousTotalRevenue', 'currentSalesVolume', 'previousSalesVolume'];
const editableFields = Object.keys(PRODUCT_RESEARCH_FIELDS);
const rows = [], collectionTimes = [];
for (const item of manifest.rows) {
  const row = { symbol: item.symbol, name: item.name || null }; rows.push(row);
  if (!/^(?:sh|sz|bj)\d{6}$/.test(item.symbol)) throw Error(`Invalid issuer symbol in corpus: ${item.symbol}`);
  if (item.exportIssue || item.missingDocuments?.length) {
    row.unavailable = { exportIssue: item.exportIssue || null, missingDocuments: item.missingDocuments || [] };
    summary.unavailableCompanies++; continue;
  }
  const bundle = listedRead(`bundles/${item.symbol}.json`);
  if (bundle.symbol !== item.symbol || !Array.isArray(bundle.documentRefs)) throw Error(`Invalid restored bundle: ${item.symbol}`);
  bundle.documents = bundle.documentRefs.map(ref => {
    if (!/^AN\d+$/.test(ref.id)) throw Error(`Invalid document ID: ${ref.id}`);
    return listedRead(`documents/doc-${ref.id}.json`);
  });
  const originalCheckedAt = bundle.checkedAt ?? null, originalFetchedAt = bundle.fetchedAt ?? null;
  const recordedAt = iso(bundle.checkedAt ?? bundle.fetchedAt);
  if (!recordedAt) { row.unavailable = { reason: 'Original collection timestamp is invalid; no replacement historical clock was invented' }; summary.unavailableCompanies++; continue; }
  collectionTimes.push(recordedAt);
  const at = new Date(recordedAt), snapshot = buildProductMetrics(bundle.documents, { symbol: item.symbol, now: at });
  const sourceIssuesRecorded = productSourceIssues(bundle, snapshot, at), sourceIssuesWallClock = productSourceIssues(bundle, snapshot, started);
  const acquisition = acquisitionDiagnostics(bundle), elapsedHours = (started.getTime() - at.getTime()) / 3600000;
  summary.replayedCompanies++;
  if (sourceIssuesRecorded.length) summary.companiesWithSourceIssuesAtRecordedTime++;
  if (sourceIssuesWallClock.length) summary.companiesWithSourceIssuesAtReplayWallClock++;
  if (elapsedHours > 6) summary.companiesWhoseCollectionIsOlderThanSixHoursAtReplayWallClock++;
  for (const issue of sourceIssuesRecorded) count(summary.sourceIssuesAtRecordedTime, issue);
  for (const issue of sourceIssuesWallClock) count(summary.sourceIssuesAtReplayWallClock, issue);
  for (const diagnostic of snapshot.diagnostics) count(summary.documentDiagnostics, diagnostic.reasonCode);
  for (const diagnostic of acquisition) count(summary.acquisitionDiagnostics, diagnostic.code);
  const products = snapshot.products;
  if (products.length) summary.companiesWithProductRows++;
  else for (const code of new Set(snapshot.diagnostics.map(item => item.reasonCode).concat(snapshot.diagnostics.length ? [] : ['no-supported-current-product-rows']))) count(summary.noProductRowReasons, code);
  const hasRaw = product => rawFields.some(field => product.metrics[field]?.usable === true);
  const hasEditable = product => editableFields.some(field => product.metrics[field]?.usable === true);
  const allEditable = product => editableFields.every(field => product.metrics[field]?.usable === true);
  if (products.some(hasRaw)) summary.companiesWithAnyUsableRawMetric++;
  if (products.some(hasEditable)) summary.companiesWithAnyUsableEditableMetric++;
  if (products.some(allEditable)) summary.companiesWithOneProductHavingAllSevenEditableMetrics++;
  const companyFieldCounts = {};
  for (const product of products) {
    summary.products++;
    if (hasRaw(product)) summary.productsWithAnyUsableRawMetric++;
    if (hasEditable(product)) summary.productsWithAnyUsableEditableMetric++;
    if (allEditable(product)) summary.productsWithAllSevenEditableMetrics++;
    for (const [field, cell] of Object.entries(product.metrics)) {
      const tally = summary.fieldCoverage[field] ||= { productCells: 0, usableProducts: 0, companiesWithUsableValue: 0,
        availableProducts: 0, disclosedOnlyProducts: 0, conflictProducts: 0, notExtractedProducts: 0, reasons: {} };
      tally.productCells++;
      if (cell.usable) { tally.usableProducts++; companyFieldCounts[field] = true; }
      if (cell.status === 'available') tally.availableProducts++;
      if (cell.verification === 'disclosed-only') tally.disclosedOnlyProducts++;
      if (cell.status === 'conflict') tally.conflictProducts++;
      if (cell.status === 'not-extracted') tally.notExtractedProducts++;
      if (!cell.usable) { count(tally.reasons, cell.reasonCode || 'unspecified'); count(summary.cellMissingOrConflictReasons, cell.reasonCode || 'unspecified'); }
    }
    for (const issue of product.issues || []) count(summary.observationIssues, issue.reasonCode);
  }
  for (const field of Object.keys(companyFieldCounts)) summary.fieldCoverage[field].companiesWithUsableValue++;
  const snapshotFile = `snapshots/${item.symbol}.json`;
  Object.assign(row, { recordedCollectionAt: recordedAt, originalCheckedAt, originalFetchedAt,
    ageHoursAtReplayWallClock: elapsedHours, reportDate: snapshot.reportDate, productRows: products.length,
    productsWithAnyUsableRawMetric: products.filter(hasRaw).length, productsWithAnyUsableEditableMetric: products.filter(hasEditable).length,
    sourceIssuesAtRecordedTime: sourceIssuesRecorded, sourceIssuesAtReplayWallClock: sourceIssuesWallClock,
    acquisitionDiagnostics: acquisition, documentDiagnostics: snapshot.diagnostics, snapshotFile });
  write(path.join(output, snapshotFile), { symbol: item.symbol, name: item.name || null,
    timeMeaning: 'Metrics evaluated at ORIGINAL recorded collection time for historical parser coverage only. This is not a current refresh or current eligibility decision.',
    originalCollection: { checkedAt: originalCheckedAt, fetchedAt: originalFetchedAt, recordedAt,
      documents: bundle.documents.map(document => ({ id: document.id, fetchedAt: document.fetchedAt ?? null, reportDate: document.reportDate || null, publishedAt: document.publishedAt || null })) },
    replayWallClock: started.toISOString(), sourceIssuesAtRecordedTime: sourceIssuesRecorded, sourceIssuesAtReplayWallClock: sourceIssuesWallClock,
    productMetrics: snapshot, acquisitionDiagnostics: acquisition });
  if (summary.replayedCompanies % 20 === 0) console.error(`Historical operating-metrics replay: ${summary.replayedCompanies} restored bundles`);
}
verifyInput();
const finished = new Date();
const report = { generatedAt: finished.toISOString(), startedAt: started.toISOString(), input, output,
  scope: 'Offline read-only historical public-document parsing coverage; no account/cache mutation, network, engine, trading or current eligibility claim.',
  clockSemantics: { historicalEvaluationClock: 'Each bundle original checkedAt, falling back to original fetchedAt only if checkedAt is absent',
    replayWallClock: started.toISOString(), latestOriginalCollectionAt: collectionTimes.sort().at(-1) || null, earliestOriginalCollectionAt: collectionTimes[0] || null,
    expiry: 'The application requires a collection check no older than 6 hours. Replay does not renew collection freshness; wall-clock issues are diagnostics, not a refreshed verification.' },
  sourceExportedAt: manifest.exportedAt, sourceSavedResultAt: manifest.savedResultAt,
  inputIntegrity: { manifestSha256: hash(manifestBytes), originalReportSha256: originalReportHash, validatedManifestFiles: listed.size, checkedBeforeAndAfter: true },
  parserSourceHashes: codeHashes, editableFields,
  limitations: ['Usable raw metric counts refer to native original value/calculation checks, before collection freshness eligibility gating.',
    'No supported row or missing field means this parser has not recovered it; it does not establish that the issuer did not disclose it.',
    'Available includes reported-only percentages. Only usable source-verified or calculated values can satisfy an explicit metric condition.',
    'Raw coverage is not legacy product outlook approval, strategy validation, a buy signal, or a promise of a trade.',
    'This exported sample was selected by a historical result, not randomly from all listed securities; coverage is not a market-wide estimate.',
    'Company financial metric feeds are not contained in this document-only corpus and are not evaluated by this replay.'],
  summary, rows };
write(path.join(output, 'report.json'), report);
console.log(JSON.stringify({ output, report: path.join(output, 'report.json'), summary,
  clockSemantics: report.clockSemantics, inputIntegrity: report.inputIntegrity }, null, 2));
