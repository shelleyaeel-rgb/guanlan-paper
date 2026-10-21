// Read-only live integration probe. An existing same-day complete EM universe
// may be reused through GUANLAN_UNIVERSE_REPORT; original validation time stays.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { app, net, session } = require('electron');
const root = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(root, 'work/independent-breadth-live-'));
app.setPath('userData', path.join(output, 'runtime'));
const { FreeScreenerSource } = require(path.join(root, 'core/screener-sources.cjs'));
const { EastmoneyStockUniverseSource } = require(path.join(root, 'core/stock-universe-source.cjs'));
const { MarketBreadthSource, parseSinaBreadth } = require(path.join(root, 'core/market-breadth-source.cjs'));
const report = { output, startedAt: new Date().toISOString(), requests: [], progress: [] }, parsed = new Map();
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const watchdog = setTimeout(() => { report.error = 'probe deadline'; save(); app.exit(2); }, 150000);
app.whenReady().then(async () => {
  report.proxy = await session.defaultSession.resolveProxy('https://hq.sinajs.cn');
  const transport = new FreeScreenerSource(async (url, options) => {
    const entry = { url, startedAt: Date.now() }; report.requests.push(entry);
    try {
      const response = await net.fetch(url, options); entry.status = response.status;
      return { ok: response.ok, status: response.status, headers: response.headers, body: response.body,
        text: async () => { const value = await response.text(); entry.elapsedMs = Date.now() - entry.startedAt; save(); return value; },
        arrayBuffer: async () => {
          const buffer = await response.arrayBuffer(), text = new TextDecoder('gb18030').decode(buffer);
          entry.elapsedMs = Date.now() - entry.startedAt;
          const expected = new URL(url).pathname.slice('/list='.length).split(','), rows = parseSinaBreadth(text, expected);
          entry.parsedRows = rows.length; for (const row of rows) parsed.set(row.symbol, row);
          save(); return buffer;
        } };
    } catch (error) { entry.error = error.message; save(); throw error; }
  });
  const universeLoader = new EastmoneyStockUniverseSource(transport.request.bind(transport));
  let acquiredUniverse;
  const loadUniverse = universeLoader.load.bind(universeLoader);
  universeLoader.load = async options => { acquiredUniverse = await loadUniverse(options); return acquiredUniverse; };
  if (process.env.GUANLAN_UNIVERSE_REPORT) {
    const original = JSON.parse(fs.readFileSync(process.env.GUANLAN_UNIVERSE_REPORT, 'utf8'));
    assert.equal(original.passed, true); universeLoader.cache = original.result;
    report.cacheReused = { report: process.env.GUANLAN_UNIVERSE_REPORT, validatedAt: original.result.validatedAt };
  }
  const primary = {
    request: transport.request.bind(transport),
    load: async () => { throw Error('诊断注入：腾讯不可用；未发送腾讯请求'); },
    loadUniverse: async () => { throw Error('诊断注入：新浪名单不可用；未发送新浪名单请求'); },
    validateUniverse: async () => { throw Error('unexpected primary-universe validation'); }
  };
  const source = new MarketBreadthSource(primary, { universeLoader });
  const started = Date.now();
  try {
    const result = await source.load({ onProgress: progress => { report.progress.push(progress); save(); } });
    report.result = { accepted: true, rows: result.rows.length, source: result.source, universeSource: result.universeSource,
      universeValidatedAt: result.universeValidatedAt, fetchedAt: result.fetchedAt };
  } catch (error) { report.result = { accepted: false, message: error.message }; }
  const universe = universeLoader.cache || acquiredUniverse;
  assert.ok(universe, 'independent complete universe was acquired');
  report.universe = universe; report.elapsedMs = Date.now() - started;
  report.validationCacheCleared = !universeLoader.cache;
  const at = Date.now(), rows = [...parsed.values()];
  report.parsedRows = rows.length; report.symbols = rows.map(row => row.symbol).sort();
  report.missing = universe.symbols.filter(symbol => !parsed.has(symbol));
  report.fresh180s = rows.filter(row => row.timestamp <= at && at - row.timestamp <= 180000 && row.price > 0 && Number.isFinite(row.changePct)).length;
  report.quoteTimestampRange = { min: Math.min(...rows.map(row => row.timestamp)), max: Math.max(...rows.map(row => row.timestamp)), evaluatedAt: at };
  assert.equal(report.parsedRows, universe.symbols.length); assert.deepEqual(report.missing, []);
  if (report.cacheReused) assert.equal(universe.validatedAt, report.cacheReused.validatedAt);
  if (report.validationCacheCleared) {
    assert.equal(report.result.accepted, false);
    report.verificationOutcome = 'source-revalidation-failed';
    report.passed = false;
  } else if (report.fresh180s / rows.length < 0.8) {
    assert.equal(report.result.accepted, false); assert.match(report.result.message, /有效同日报价不足/);
    report.verificationOutcome = 'complete-source-rejected-by-freshness'; report.passed = true;
  } else {
    assert.equal(report.result.accepted, true); report.verificationOutcome = 'accepted'; report.passed = true;
  }
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ output, passed: report.passed, elapsedMs: report.elapsedMs, result: report.result, parsedRows: report.parsedRows, fresh180s: report.fresh180s, cacheReused: report.cacheReused }));
  clearTimeout(watchdog); app.quit();
}).catch(error => { report.error = error.stack; report.passed = false; save(); console.error(error); clearTimeout(watchdog); app.exit(1); });
