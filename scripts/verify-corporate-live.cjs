// Read-only provider smoke test. No Engine, account file, or execution service.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { CorporateSource } = require('../core/corporate-source.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const source = new CorporateSource();
const cases = [
  { symbol: 'sh600519', kind: 'cash' }, { symbol: 'sz000001', kind: 'cash' },
  { symbol: 'sh688300', kind: 'transfer' }, { symbol: 'sz300750', kind: 'nonstandard' }
];
(async () => {
  const results = [];
  for (const item of cases) {
    const evidence = await source.get({ symbol: item.symbol, fromDate: '2026-01-01', force: true });
    assert.equal(evidence.status, 'ready', evidence.error); assert.equal(evidence.coverageComplete, true);
    const match = evidence.events.find(event => item.kind === 'cash'
      ? event.status === 'implemented' && event.bodyVerified && event.cashPerShare > 0 && !event.bonusPerShare && !event.transferPerShare
      : item.kind === 'transfer' ? event.status === 'implemented' && event.bodyVerified && event.transferTaxExempt && event.listingDate && event.transferPerShare > 0
        : event.status === 'unsupported' && /差异|折算|虚拟|除息/.test(event.reason));
    assert.ok(match, `${item.symbol}: expected ${item.kind} evidence must not silently disappear`);
    results.push({ ...item, coveredNotices: evidence.notices.length, coverageStart: evidence.coverageStart,
      coverageEnd: evidence.coverageEnd, source: evidence.source, event: match });
  }
  const report = { checkedAt: new Date().toISOString(), accountTouched: false, results };
  const file = path.join(root, 'work/corporate-live-report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, file, cases: results.map(r => ({ symbol: r.symbol, kind: r.kind, status: r.event.status, coveredNotices: r.coveredNotices })) }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
