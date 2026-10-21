// Run: electron tests/fixtures/market-regime-ui.cjs --output=work/market-regime-ui
// Renders the real UI with synthetic state, isolated storage, no production IPC or network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Engine, initialState } = require('../../core/engine.cjs');
const { STRATEGY_PROFILES } = require('../../core/strategy-profiles.cjs');
const { MARKET_REGIME_POLICY } = require('../../core/market-regime.cjs');
const root = path.resolve(__dirname, '../..'), workRoot = path.join(root, 'work');
const output = path.resolve(root, process.argv.find(value => value.startsWith('--output='))?.slice(9) || 'work/market-regime-ui');
assert.ok(output.startsWith(workRoot + path.sep), 'Fixture output must stay within repository work/');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'isolated-profile'));
app.disableHardwareAcceleration();
const at = Date.parse('2026-10-16T10:05:00+08:00'), engine = new Engine(initialState(), () => new Date(at));
engine.s.equity = [{ time: at - 3600000, value: 100000000 }, { time: at - 3000000, value: 250000000 }, { time: at - 1800000, value: 248000000 }];
const stats = { ...engine.stats(), cumulativeCapital: 250000000, equity: 245000000, cash: 245000000, pnl: -5000000, returnPct: -0.04, drawdown: 0.065 };
const state = { account: engine.s, stats, quotes: {}, signals: {}, planSelections: {}, strategyProfiles: STRATEGY_PROFILES,
  agency: { ...engine.agencyState(), marketPolicy: { version: 1, enabled: true }, runtime: { decisionMode: 'rules', rulesVersion: '1', intervalSeconds: 300, runningGroups: [], online: true, session: { open: true, known: true, label: '隔离测试时段' } } },
  connection: { ok: true, at, message: '隔离测试行情', sources: ['本地合成数据'] }, session: { open: true, label: '隔离测试时段' }, now: at, date: '2026-10-16', dataPath: output };
function market(status, multiplier, extra = {}) {
  return { version: 1, policyVersion: 1, date: '2026-10-16', status, label: status, riskMultiplier: multiplier, allowEntry: multiplier > 0, allowBreakout: multiplier === 1,
    checkedAt: at, expiresAt: at + 90000, reason: '隔离样本：指数趋势与全市场广度已核验。', policyNote: MARKET_REGIME_POLICY.note,
    evidence: { quoteTime: at - 30000 }, metrics: { highVolatility: multiplier === 0.5 && status === 'strong',
      breadth: { advanceRatio: 0.62, advancing: 3100, valid: 5000, expected: 5100, coverage: 5000 / 5100 },
      indices: ['sh000001', 'sz399001', 'sz399006'].map(symbol => ({ symbol, asOf: '2026-10-15', trend: 'up', ma20Slope5: 0.003, atrRatio: 0.012, quoteTime: at })) }, ...extra };
}
app.whenReady().then(async () => {
  const errors = [], blockedNetwork = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const blocked = /^https?:/.test(details.url); if (blocked) blockedNetwork.push(details.url); callback({ cancel: blocked });
  });
  const win = new BrowserWindow({ show: false, width: 1440, height: 1050, webPreferences: {
    preload: path.join(__dirname, 'market-regime-ui-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true
  } });
  const paint = async () => { await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await new Promise(resolve => setTimeout(resolve, 100)); };
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  await win.loadFile(path.join(root, 'ui/index.html'));
  await win.webContents.executeJavaScript(`renderState(${JSON.stringify(state)}); switchPage('stats');`);
  await paint();
  const account = await win.webContents.executeJavaScript(`({cards:$('account-cards').innerText, stats:$('stats-extra').innerText, explanation:$('page-stats').innerText})`);
  assert.match(account.cards, /累计投入 ¥ 2,500,000.00/); assert.match(account.cards, /时间加权收益率 -4.00%/);
  assert.match(account.stats, /剔除追加本金影响的单位净值回撤/); assert.match(account.explanation, /含资金流入/);
  fs.writeFileSync(path.join(output, 'account-stats.png'), (await win.webContents.capturePage()).toPNG());
  const cases = [
    ['strong', market('strong', 1), /正常风险预算/, /波段可检查回踩或突破/],
    ['neutral', market('neutral', 0.5), /半额风险预算/, /仅检查回踩/],
    ['high-volatility', market('strong', 0.5), /半额风险预算/, /仅检查回踩/],
    ['weak', market('weak', 0), /暂停新开仓/, /已有持仓继续执行原退出计划/],
    ['stale', market('strong', 1, { expiresAt: at - 1 }), /待核验.*暂停新开仓/, /已有持仓继续执行原退出计划/],
    ['unknown', market('unknown', 0, { reason: '市场环境获取失败：隔离网络错误' }), /待核验.*暂停新开仓/, /已有持仓继续执行原退出计划/]
  ];
  const checked = [];
  for (const [name, snapshot, badge, summary] of cases) {
    await win.webContents.executeJavaScript(`state.agency.runtime.marketRegime=${JSON.stringify(snapshot)}; switchPage('agency'); $('agency-market-regime').scrollIntoView({block:'center'});`);
    await paint();
    const view = await win.webContents.executeJavaScript(`({badge:$('agency-market-badge').innerText, summary:$('agency-market-summary').innerText, time:$('agency-market-time').innerText, metrics:$('agency-market-metrics').innerText, overflow:document.documentElement.scrollWidth>innerWidth})`);
    assert.match(view.badge, badge); assert.match(view.summary, summary); assert.match(view.time, /2026\/10\/16/); assert.equal(view.overflow, false);
    if (name === 'strong') { assert.match(view.metrics, /62.00%/); assert.match(view.metrics, /0.50% 权益/); }
    if (name === 'neutral') assert.match(view.metrics, /0.25% 权益/);
    fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG()); checked.push({ name, ...view });
  }
  await win.webContents.executeJavaScript(`$('agency-market-regime').querySelector('details').open=true; $('agency-market-regime').scrollIntoView({block:'center'});`);
  await paint();
  fs.writeFileSync(path.join(output, 'expanded-evidence.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1120, 850);
  await win.webContents.executeJavaScript(`$('agency-market-regime').scrollIntoView({block:'center'});`);
  await paint();
  const narrow = await win.webContents.executeJavaScript('({width:innerWidth, overflow:document.documentElement.scrollWidth>innerWidth})');
  assert.equal(narrow.overflow, false);
  fs.writeFileSync(path.join(output, 'narrow-evidence.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []); assert.deepEqual(blockedNetwork, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checked, account, narrow, errors, blockedNetwork }, null, 2));
  console.log(JSON.stringify({ passed: checked.length, accountVerified: true, errors, blockedNetwork, output }));
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
