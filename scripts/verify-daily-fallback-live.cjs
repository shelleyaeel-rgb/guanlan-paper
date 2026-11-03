// Read-only live data probe. Uses an isolated Electron profile and an in-memory
// Market; it never opens the application or loads/saves an account.
const fs = require('node:fs'), path = require('node:path');
const electron = require('electron');
const root = path.resolve(__dirname, '..');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
if (typeof electron === 'string') {
  const { spawn } = require('node:child_process');
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const output = fs.mkdtempSync(path.join(root, 'work/daily-fallback-live-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__filename, ...process.argv.slice(2), `--output=${output}`], { env, windowsHide: true, stdio: 'ignore' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    const file = path.join(output, 'report.json');
    if (fs.existsSync(file)) {
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      console.log(JSON.stringify({ output, ...report.summary, failed: report.results.filter(row => !row.ready) }, null, 2));
    } else console.error('Probe did not produce a report:', output);
    process.exitCode = code || 0;
  });
} else {
  const { app, net } = electron;
  const { Market } = require('../core/market.cjs');
  const { INDEX_SYMBOLS } = require('../core/market-parsers.cjs');
  const { preparedHistoryValid } = require('../core/daily-history.cjs');
  const output = argument('output');
  app.setPath('userData', path.join(output, 'isolated-profile'));
  app.whenReady().then(async () => {
    const symbols = argument('symbols-file') ? JSON.parse(fs.readFileSync(argument('symbols-file'), 'utf8'))
      : ['sh600000', 'sh688213', 'sz300229', 'sh000001', 'sz399001', 'sz399006'];
    if (!Array.isArray(symbols) || symbols.some(value => !/^(sh|sz)\d{6}$/.test(value))) throw Error('Invalid probe symbols');
    const requests = [], results = [], startedAt = new Date().toISOString();
    const market = new Market(async (url, options) => {
      const row = { url, startedAt: Date.now() }; requests.push(row);
      try { const response = await net.fetch(url, options); row.status = response.status; return response; }
      catch (error) { row.error = error.message; throw error; }
      finally { row.elapsedMs = Date.now() - row.startedAt; }
    });
    let offset = 0;
    await Promise.all(Array.from({ length: Math.min(3, symbols.length) }, async () => {
      while (offset < symbols.length) {
        const symbol = symbols[offset++], kind = INDEX_SYMBOLS.has(symbol) ? 'index' : 'stock', start = Date.now();
        try {
          const entry = kind === 'index' ? await market.indexHistory(symbol) : await market.strategyHistory(symbol, null, true);
          results.push({ symbol, kind, ready: preparedHistoryValid(entry, symbol, kind, Date.now()), provider: entry.provider,
            adjustment: entry.adjustment, asOf: entry.dailyEvidence?.asOf, count: entry.bars.length, fetchedAt: entry.fetchedAt,
            last: entry.bars.at(-1), elapsedMs: Date.now() - start });
        } catch (error) { results.push({ symbol, kind, ready: false, error: error.message, elapsedMs: Date.now() - start }); }
      }
    }));
    const summary = { startedAt, finishedAt: new Date().toISOString(), total: results.length, ready: results.filter(row => row.ready).length,
      providers: results.reduce((counts, row) => { const key = row.provider || 'failed'; counts[key] = (counts[key] || 0) + 1; return counts; }, {}), requests: requests.length };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ summary, results, requests }, null, 2));
    app.exit(summary.ready === summary.total ? 0 : 1);
  }).catch(error => { fs.writeFileSync(path.join(output, 'error.txt'), error.stack); app.exit(1); });
}
