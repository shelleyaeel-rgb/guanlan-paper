// Offline replay of byte-copied public research caches at their recorded time.
// Reads a saved account only to select historical research rows. Never writes
// the account/cache, starts the engine, or fetches network data.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const query = { conditions: ['productOutlook'] };
function summarize(review) {
  return { status: review.status, ruleVersion: review.ruleVersion, checks: review.checks.map(check => ({
    key: check.key, status: check.status, reason: check.reason, productCandidates: check.productCandidates,
  })) };
}
function aggregate(rows, field) {
  const result = { companies: rows.length, productChecks: 0, productPass: 0, productFail: 0, productPending: 0, noProduct: 0, sourcePending: 0, parts: {} };
  for (const key of ['demand', 'commercialization', 'advantage', 'outlookRisk']) result.parts[key] = { anyProductPass: 0, anyProductFail: 0, allCandidatesPending: 0 };
  for (const row of rows) {
    const review = row[field]; if (!review) continue;
    if (review.checks.some(check => check.key === 'sourceIntegrity')) result.sourcePending++;
    const product = review.checks.find(check => check.key === 'productOutlook'); if (!product) continue;
    result.productChecks++; result[{ pass: 'productPass', fail: 'productFail', pending: 'productPending' }[product.status]]++;
    const candidates = product.productCandidates || []; if (!candidates.length) result.noProduct++;
    for (const key of Object.keys(result.parts)) {
      const parts = candidates.flatMap(item => item.parts || []).filter(item => item.key === key);
      if (parts.some(item => item.status === 'pass')) result.parts[key].anyProductPass++;
      if (parts.some(item => item.status === 'fail')) result.parts[key].anyProductFail++;
      if (parts.length && parts.every(item => item.status === 'pending')) result.parts[key].allCandidatesPending++;
    }
  }
  return result;
}
let output = process.env.GUANLAN_PRODUCT_REPLAY_OUTPUT;
if (!output) {
  for (const key of ['GUANLAN_REPLAY_ACCOUNT', 'GUANLAN_REPLAY_CACHE', 'GUANLAN_REPLAY_BASELINE_ASAR']) if (!process.env[key]) throw Error(`${key} is required for an initial read-only export`);
  output = fs.mkdtempSync(path.join(root, 'work/product-evidence-replay-'));
  fs.mkdirSync(path.join(output, 'documents')); fs.mkdirSync(path.join(output, 'bundles')); fs.mkdirSync(path.join(output, 'baseline/core'), { recursive: true });
  const asar = require('@electron/asar'), archive = process.env.GUANLAN_REPLAY_BASELINE_ASAR;
  for (const entry of asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')).filter(file => /^core\/[^/]+\.(?:cjs|json)$/.test(file))) {
    fs.writeFileSync(path.join(output, 'baseline', entry), asar.extractFile(archive, path.normalize(entry)));
  }
  const account = read(process.env.GUANLAN_REPLAY_ACCOUNT), result = account.agency.pool.lastResult, unique = new Map();
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.evidenceReview?.symbol) unique.set(value.evidenceReview.symbol, { symbol: value.evidenceReview.symbol, name: value.name, saved: summarize(value.evidenceReview) });
    for (const item of Object.values(value)) if (item && typeof item === 'object') walk(item);
  }
  walk(result);
  const manifest = { exportedAt: new Date().toISOString(), savedResultAt: result.finishedAt, savedPolicyVersion: result.policyVersion,
    scope: 'Historical public-document replay only; no account mutation, engine, network or live eligibility claim', files: [], rows: [...unique.values()] };
  const copied = new Set();
  for (const row of manifest.rows) {
    const source = path.join(process.env.GUANLAN_REPLAY_CACHE, `bundle-${row.symbol}.json`);
    if (!fs.existsSync(source)) { row.exportIssue = 'Saved public research bundle no longer cached'; continue; }
    const bytes = fs.readFileSync(source), bundle = JSON.parse(bytes);
    fs.writeFileSync(path.join(output, 'bundles', `${row.symbol}.json`), bytes);
    manifest.files.push({ file: `bundles/${row.symbol}.json`, sha256: hash(bytes) });
    row.missingDocuments = [];
    for (const ref of bundle.documentRefs || []) {
      if (!/^AN\d+$/.test(ref.id)) { row.missingDocuments.push(ref.id); continue; }
      const file = `doc-${ref.id}.json`, original = path.join(process.env.GUANLAN_REPLAY_CACHE, file);
      if (!fs.existsSync(original)) { row.missingDocuments.push(ref.id); continue; }
      if (copied.has(file)) continue;
      const document = fs.readFileSync(original); copied.add(file); fs.writeFileSync(path.join(output, 'documents', file), document);
      manifest.files.push({ file: `documents/${file}`, sha256: hash(document) });
    }
    if (process.env.GUANLAN_REPLAY_INDUSTRY_CACHE) {
      const file = path.join(process.env.GUANLAN_REPLAY_INDUSTRY_CACHE, `${row.symbol}.json`);
      if (fs.existsSync(file)) { const bytes = fs.readFileSync(file); fs.writeFileSync(path.join(output, 'bundles', `${row.symbol}-industry.json`), bytes); manifest.files.push({ file: `bundles/${row.symbol}-industry.json`, sha256: hash(bytes) }); }
    }
  }
  write(path.join(output, 'manifest.json'), manifest);
}
const manifest = read(path.join(output, 'manifest.json'));
for (const file of manifest.files) if (hash(fs.readFileSync(path.join(output, file.file))) !== file.sha256) throw Error(`Exported public document changed: ${file.file}`);
const before = require(path.join(output, 'baseline/core/company-evidence.cjs')).evaluateCompanyEvidence;
const after = require('../core/company-evidence.cjs').evaluateCompanyEvidence;
const rows = [];
for (const item of manifest.rows) {
  const row = { ...item }; rows.push(row);
  if (row.exportIssue || row.missingDocuments?.length) continue;
  const bundle = read(path.join(output, 'bundles', `${row.symbol}.json`));
  bundle.documents = bundle.documentRefs.map(ref => read(path.join(output, 'documents', `doc-${ref.id}.json`)));
  const industryFile = path.join(output, 'bundles', `${row.symbol}-industry.json`);
  if (fs.existsSync(industryFile)) { const industry = read(industryFile); Object.assign(bundle, { industryDocuments: industry.industryDocuments, industryCoverage: industry.industryCoverage }); }
  // Never rewrite acquisition times to make old documents look fresh.
  const observed = new Date(bundle.checkedAt || bundle.fetchedAt); row.observedAt = observed.toISOString();
  let started = Date.now(); row.before = summarize(before(bundle, query, observed)); row.beforeMs = Date.now() - started;
  started = Date.now(); row.after = summarize(after(bundle, query, observed)); row.afterMs = Date.now() - started;
  if (rows.length % 20 === 0) console.error(`Historical product replay: ${rows.length}/${manifest.rows.length}`);
}
const report = { replayedAt: new Date().toISOString(), output, scope: manifest.scope, savedResultAt: manifest.savedResultAt,
  saved: aggregate(rows, 'saved'), before: aggregate(rows.filter(row => row.before), 'before'), after: aggregate(rows.filter(row => row.after), 'after'),
  unavailable: rows.filter(row => !row.after).map(({ symbol, exportIssue, missingDocuments }) => ({ symbol, exportIssue, missingDocuments })), rows };
write(path.join(output, 'report.json'), report);
console.log(JSON.stringify({ output, saved: report.saved, before: report.before, after: report.after, unavailable: report.unavailable.length }, null, 2));
