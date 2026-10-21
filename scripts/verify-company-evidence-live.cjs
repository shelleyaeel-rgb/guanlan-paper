// Public-company sample verification only. No trading engine or user account is loaded.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { CompanyEvidenceSource } = require('../core/company-evidence-source.cjs');
const { evaluateCompanyEvidence } = require('../core/company-evidence.cjs');
const { poolPolicy } = require('../core/agency-screening.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/company-evidence-live-'));
const source = new CompanyEvidenceSource(fetch, { directory: process.env.GUANLAN_EVIDENCE_CACHE || path.join(output, 'cache') });
const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ['sh600519', 'sz300750'];
const report = { startedAt: new Date().toISOString(), output, scope: '公开公司资料抽样，未执行全市场筛选或交易', companies: [] };
(async () => {
  for (const symbol of symbols) {
    const bundle = await source.get(symbol, { force: true });
    const evaluation = evaluateCompanyEvidence(bundle, poolPolicy().commonQuery.evidence);
    fs.writeFileSync(path.join(output, `${symbol}.json`), JSON.stringify(bundle, null, 2));
    fs.writeFileSync(path.join(output, `${symbol}-evaluation.json`), JSON.stringify(evaluation, null, 2));
    const item = { symbol, sourceStatus: bundle.status, coverage: bundle.coverage, errors: bundle.errors,
      documents: bundle.documents.map(({ id, title, url, reportDate, format, pages, characters }) => ({ id, title, url, reportDate, format, pages, characters })),
      evaluation: { status: evaluation.status, mode: evaluation.mode, ruleVersion: evaluation.ruleVersion,
        checks: evaluation.checks.map(({ key, status, reason }) => ({ key, status, reason })) } };
    report.companies.push(item); console.log(JSON.stringify(item));
    assert.equal(bundle.symbol, symbol); assert.equal(evaluation.symbol, symbol);
    assert.equal(evaluation.mode, 'automatic');
    assert.ok(evaluation.records.every(record => record.reviewState !== 'confirmed'));
    assert.ok(bundle.documents.some(document => document.kind === 'annual-report' && document.complete), '真实年报全文未取得');
    assert.ok(bundle.documents.some(document => document.kind === 'semiannual-report' && document.complete), '真实半年报全文未取得');
  }
  report.ok = true;
})().catch(error => { report.ok = false; report.error = error.message; process.exitCode = 1; }).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, output, error: report.error }));
});
