'use strict';
// Replay the recorded documents only. No Store, account, network or order engine.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { reviewNoticeEvidence } = require('../core/company-notice-review.cjs');
const root = path.resolve(__dirname, '..');
const snapshot = JSON.parse(fs.readFileSync(process.argv[2] || path.join(root, 'tmp/notice-pending-20261016.json'), 'utf8'));
const documents = JSON.parse(fs.readFileSync(process.argv[3] || path.join(root, 'tmp/notice-fix-documents-20261016.json'), 'utf8'));
const at = Date.parse(snapshot.run.finishedAt), report = { runId: snapshot.run.id, sourceSha256: snapshot.sourceSha256,
  scope: '按原扫描时点重放相同哈希的公告正文；只计算公告门槛，不重新筛选或修改正式账户', rows: [] };
for (const row of snapshot.rows) {
  const saved = row.noticeReview;
  const docs = saved.notices.map(notice => {
    const item = documents.find(item => item.symbol === row.symbol && item.document?.id === notice.id);
    assert.ok(item && notice.records.some(record => record.sourceHash === item.document.sourceHash), `${row.symbol}/${notice.id}正文哈希必须一致`);
    return { ...item.document, fetchedAt: at };
  });
  // Reproduce transport validity at the saved evaluation time, not today's cache age.
  const result = reviewNoticeEvidence({ ...saved, status: 'unverified', fetchedAt: at, checkedAt: at },
    { symbol: row.symbol, fetchedAt: at, documents: docs }, row.symbol, new Date(at));
  report.rows.push({ symbol: row.symbol, name: row.name, before: saved.status, after: result.status,
    notices: result.notices.map(item => ({ id: item.id, title: item.title, status: item.status, diagnostic: item.diagnostic,
      type: item.factReview?.type, missingFields: item.factReview?.missingFields || [], reason: item.reason })) });
}
report.counts = report.rows.reduce((all, row) => ({ ...all, [row.after]: (all[row.after] || 0) + 1 }), {});
report.unsupported = report.rows.flatMap(row => row.notices.filter(notice => notice.type === 'unsupported').map(notice => `${row.name}:${notice.title}`));
const output = path.join(root, 'tmp/notice-pending-replay-result.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, companies: report.rows.length, counts: report.counts, unsupported: report.unsupported,
  pending: report.rows.filter(row => row.after === 'unverified').map(row => ({ name: row.name, notices: row.notices.filter(item => item.status !== 'clear').map(item => ({ title: item.title, reason: item.reason })) })) }, null, 2));
