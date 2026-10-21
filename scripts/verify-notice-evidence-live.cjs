// Targeted public announcement collection in a separate cache; no account or
// trading engine is loaded. Run with Node to use Electron's production transport.
'use strict';
const fs = require('node:fs'), path = require('node:path');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, net } = require('electron');
  const root = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(root, 'work/notice-evidence-live-'));
  app.setPath('userData', path.join(output, 'electron'));
  const { Research } = require('../core/research.cjs');
  const { CompanyEvidenceSource } = require('../core/company-evidence-source.cjs');
  const { checkNoticeWithEvidence } = require('../core/company-notice-review.cjs');
  let source;
  const report = { startedAt: new Date().toISOString(), output, scope: 'Only requested public announcements; isolated cache; no account or trading engine', companies: [] };
  app.whenReady().then(async () => {
    const cache = path.join(output, 'cache'); fs.mkdirSync(cache);
    if (process.env.GUANLAN_NOTICE_SEED_DIR) {
      const seed = path.resolve(process.env.GUANLAN_NOTICE_SEED_DIR);
      for (const file of fs.readdirSync(seed).filter(name => /^doc-AN\d+\.json$/.test(name))) fs.copyFileSync(path.join(seed, file), path.join(cache, file));
    }
    const research = new Research((...args) => net.fetch(...args));
    source = new CompanyEvidenceSource((...args) => net.fetch(...args), { directory: cache });
    const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ['sz000792', 'sz000933', 'sz002648'];
    console.log(JSON.stringify({ output, symbols }));
    for (const symbol of symbols) {
      const noticeResponse = await research.get({ symbol, section: 'notices', force: true });
      const bundle = await source.getNotices(symbol, { noticeResponse, signal: AbortSignal.timeout(180000) });
      const evaluation = checkNoticeWithEvidence(noticeResponse, symbol, bundle);
      fs.writeFileSync(path.join(output, `${symbol}.json`), JSON.stringify({ noticeResponse, bundle, evaluation }, null, 2));
      const item = { symbol, status: evaluation.status, reasons: evaluation.reasons, documents: bundle.documents.map(({ id, title, complete, pages, characters }) => ({ id, title, complete, pages, characters })),
        acquisition: bundle.acquisition, coverage: bundle.coverage };
      report.companies.push(item); console.log(JSON.stringify({ symbol, status: item.status, documents: item.documents, reasons: item.reasons }));
    }
  }).catch(error => { report.error = error.stack; process.exitCode = 1; console.error(error); }).finally(async () => {
    await source?.destroy(); report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, error: report.error || null })); app.exit(process.exitCode || 0);
  });
}
