'use strict';
// Read-only live probe using the same Electron net.fetch transport as main.cjs.
// No main module, account, BrowserWindow or persistent application state is loaded.
const fs = require('node:fs'), path = require('node:path');
const electron = require('electron');
const root = path.resolve(__dirname, '..');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
function createOutput() {
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  return fs.mkdtempSync(path.join(root, 'work/index-market-live-'));
}

if (typeof electron === 'string') {
  const { spawn } = require('node:child_process');
  const output = createOutput(), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__filename, `--output=${output}`], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  const watchdog = setTimeout(() => child.kill(), 45000);
  child.on('error', error => { clearTimeout(watchdog); console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    clearTimeout(watchdog);
    const file = path.join(output, 'report.json');
    if (fs.existsSync(file)) {
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      console.log(JSON.stringify({ output, ...report.summary,
        failed: report.items.filter(item => item.status !== 'ok').map(({ id, name, status, error }) => ({ id, name, status, error })),
        mappingErrors: report.mappingChecks.filter(check => !check.matched), fatalError: report.fatalError || null }, null, 2));
    } else console.error(`指数联网验证未生成报告：${output}；exit=${code} signal=${signal || ''}`);
    process.exitCode = code === 0 && fs.existsSync(file) ? 0 : 1;
  });
} else {
  const { app, net } = electron;
  const { IndexMarket, INDEX_CATALOG } = require('../core/index-market.cjs');
  const output = argument('output') || createOutput();
  app.setPath('userData', path.join(output, 'isolated-profile'));
  const requests = [], startedAt = Date.now(), mappingChecks = [];
  // The provider still labels its GDAXI field "DAX30". The product deliberately
  // uses "德国DAX" without retaining that outdated constituent-count label.
  const sourceNames = {
    'cn-shanghai': ['上证指数'], 'cn-shenzhen': ['深证成指'], 'cn-chinext': ['创业板指'],
    'cn-csi300': ['沪深300'], 'cn-sse50': ['上证50'], 'cn-star50': ['科创50'],
    'cn-csi500': ['中证500'], 'cn-csi1000': ['中证1000'], 'hk-hsi': ['恒生指数'],
    'hk-hstech': ['恒生科技指数'], 'us-sp500': ['标普500'], 'us-nasdaq': ['纳斯达克'],
    'us-dow': ['道琼斯'], 'us-nasdaq100': ['纳斯达克100'], 'asia-nikkei225': ['日经225'],
    'asia-kospi': ['韩国KOSPI'], 'asia-asx200': ['澳大利亚标普200'], 'asia-taiwan': ['台湾加权'],
    'eu-dax': ['德国DAX30', '德国DAX'], 'eu-cac40': ['法国CAC40'], 'eu-ftse100': ['英国富时100'],
    'eu-stoxx50': ['欧洲斯托克50'],
  };
  const request = async (url, options) => {
    const row = { url, startedAt: Date.now(), status: null, error: null }; requests.push(row);
    try {
      const response = await net.fetch(url, options); row.status = response.status;
      if (response.ok && new URL(url).hostname.endsWith('eastmoney.com')) {
        try {
          const payload = await response.clone().json();
          row.providerNames = Object.values(payload?.data?.diff || {}).map(item => ({ secid: `${item.f13}.${item.f12}`, name: item.f14 }));
        } catch (error) { row.bodyInspectionError = error.message; }
      }
      return response;
    } catch (error) { row.error = error.message; throw error; }
    finally { row.elapsedMs = Date.now() - row.startedAt; }
  };
  const writeReport = (snapshot, fatalError = null) => {
    const items = snapshot?.items || [], names = new Map(requests.flatMap(row => row.providerNames || []).map(row => [row.secid, row.name]));
    for (const item of INDEX_CATALOG) mappingChecks.push({ id: item.id, code: item.eastmoney, displayName: item.name,
      providerName: names.get(item.eastmoney) || null, acceptedNames: sourceNames[item.id], matched: sourceNames[item.id].includes(names.get(item.eastmoney)) });
    const summary = { transport: 'Electron net.fetch', electron: process.versions.electron, startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(), total: INDEX_CATALOG.length, ready: items.filter(item => item.status === 'ok').length,
      unavailable: items.filter(item => item.status === 'unavailable').length, stale: items.filter(item => item.status === 'stale').length,
      providers: items.reduce((counts, item) => { const key = item.provider || 'unavailable'; counts[key] = (counts[key] || 0) + 1; return counts; }, {}),
      requests: requests.length, mappingMatched: mappingChecks.filter(check => check.matched).length,
      accountLoaded: false, isolatedProfile: path.join(output, 'isolated-profile') };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ summary, snapshotAttemptedAt: snapshot?.attemptedAt || null,
      snapshotFetchedAt: snapshot?.fetchedAt || null, items, mappingChecks, requests, fatalError,
      mappingNotes: ['100.NDX 对应纳斯达克综合；100.NDX100 对应纳斯达克100，按完整市场代码匹配。',
        '100.GDAXI 的数据源名称可能仍为德国DAX30，界面统一使用德国DAX。',
        'quoteAt 是源报价时间，quoteTime 为该市场当地时间；fetchedAt 为获取时间，不据此声明实时或开市。'] }, null, 2));
    return !fatalError && summary.ready === summary.total && summary.mappingMatched === summary.total;
  };
  app.whenReady().then(async () => {
    const snapshot = await new IndexMarket(request).overview();
    app.exit(writeReport(snapshot) ? 0 : 1);
  }).catch(error => { writeReport(null, error.stack || error.message); app.exit(1); });
}
