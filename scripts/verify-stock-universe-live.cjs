// Read-only, isolated Electron probe. Never imports the application store.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { app, net, session } = require('electron');
const root = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(root, 'work/stock-universe-live-'));
app.setPath('userData', path.join(output, 'runtime'));
const { FreeScreenerSource } = require(path.join(root, 'core/screener-sources.cjs'));
const { EastmoneyStockUniverseSource } = require(path.join(root, 'core/stock-universe-source.cjs'));
const report = { output, startedAt: new Date().toISOString(), requests: [], progress: [] }, save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const watchdog = setTimeout(() => { report.error = 'probe deadline'; save(); app.exit(2); }, 120000);
app.whenReady().then(async () => {
  report.proxy = await session.defaultSession.resolveProxy('https://push2.eastmoney.com');
  const source = new FreeScreenerSource(async (url, options) => {
    const entry = { url, startedAt: Date.now() }; report.requests.push(entry);
    try { const response = await net.fetch(url, { ...options, headers: { ...options.headers, Referer: 'https://quote.eastmoney.com/' } }); entry.status = response.status;
      return { ok: response.ok, status: response.status, headers: response.headers, body: response.body, text: async () => {
        const text = await response.text(); entry.elapsedMs = Date.now() - entry.startedAt;
        try { const json = JSON.parse(text); entry.total = json.data?.total; entry.length = json.data?.diff?.length;
          if (json.data?.diff) fs.writeFileSync(path.join(output, `page-${new URL(url).searchParams.get('pn')}.json`), text);
        } catch { if (url.includes('/xg/')) fs.writeFileSync(path.join(output, path.basename(new URL(url).pathname)), text); }
        save(); return text;
      } };
    } catch (error) { entry.error = error.message; save(); throw error; }
  });
  const loader = new EastmoneyStockUniverseSource(source.request.bind(source));
  const started = Date.now();
  const universe = await loader.load({ signal: AbortSignal.timeout(100000), onProgress: progress => { report.progress.push(progress); save(); } });
  report.result = universe; report.elapsedMs = Date.now() - started;
  assert.ok(universe.symbols.length > 5000);
  report.firstRequestCount = report.requests.length;
  const cached = await loader.load({ signal: AbortSignal.timeout(15000) });
  assert.deepEqual(cached.symbols, universe.symbols); assert.equal(cached.validatedAt, universe.validatedAt);
  assert.equal(report.requests.length - report.firstRequestCount, 2 + universe.pendingListings.length);
  report.passed = true; report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ output, passed: true, elapsedMs: report.elapsedMs, sourceCount: universe.sourceCount, supported: universe.symbols.length, excluded: universe.excludedCount }));
  clearTimeout(watchdog); app.quit();
}).catch(error => { report.error = error.stack; report.passed = false; save(); console.error(error); clearTimeout(watchdog); app.exit(1); });
