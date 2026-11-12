// Run: electron tests/fixtures/market-regime-ui.cjs --output=work/market-regime-ui
// Renders the real UI with synthetic state, isolated storage, no production IPC or network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../../core/engine.cjs');
const { AgencyService } = require('../../core/agency-service.cjs');
const { enableMarketPolicy } = require('../../core/market-policy.cjs');
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
  const advanceRatio = status === 'weak' ? 0.3 : status === 'neutral' ? 0.45 : 0.62;
  return { version: 1, policyVersion: MARKET_REGIME_POLICY.version, date: '2026-10-16', status, label: status, riskMultiplier: multiplier, allowEntry: multiplier > 0, allowBreakout: multiplier === 1,
    checkedAt: at, expiresAt: at + 90000, reason: '隔离样本：指数中期趋势全部向下，仅供观察；交易权限按当日广度与波动核验。', policyNote: MARKET_REGIME_POLICY.note,
    evidence: { quoteTime: at - 30000 }, metrics: { highVolatility: multiplier === 0.5 && status === 'strong',
      breadth: { advanceRatio, advancing: 5000 * advanceRatio, valid: 5000, expected: 5100, coverage: 5000 / 5100, source: '隔离合成行情' },
      indices: ['sh000001', 'sz399001', 'sz399006'].map(symbol => ({ symbol, asOf: '2026-10-15', trend: 'down', ma20Slope5: -0.003,
        atrRatio: multiplier === 0.5 && status === 'strong' ? 0.03 : 0.012, quoteTime: at })) }, ...extra };
}
function entryDiagnosticsState() {
  let now = at;
  const account = new Engine(initialState(1000000), () => new Date(now));
  account.agencyTransfer({ strategyId: 'swing', amount: 500000 });
  account.agencyMode({ strategyId: 'swing', mode: 'running' });
  enableMarketPolicy(account.s);
  let snapshot;
  const service = new AgencyService({ getEngine: () => account, clock: () => now, getMarketRegime: () => snapshot });
  const quotes = {}, checks = [];
  const scenarios = [
    { name: '回踩条件无交集样本', prices: [9.98, 10.1, 10.1], open: 10.5, expected: /无交集/ },
    { name: '尚未触碰锚点样本', prices: [10.2, 10.2, 10.2], expected: /尚未.*触碰/ },
    { name: '低于回踩区间样本', prices: [9.8, 9.8, 9.8], expected: /低于.*区间/ },
    { name: '回升条件待满足样本', prices: [9.98, 10.02, 10.02], expected: /尚未满足回升/ },
    { name: '站稳计时样本', prices: [9.98, 10.1, 10.1], expected: /30.*秒/ },
    { name: '回踩无交集但突破计时样本', prices: [10.6, 10.64, 10.65], open: 10.5, breakout: true, expected: /无交集.*突破.*30.*秒/ }
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const symbol = `sh${600000 + index}`;
    account.agencyMember({ strategyId: 'swing', symbol, action: 'add' });
    const technical = { asOf: '2026-10-15', close: 10.05, ma5: 10.02, ma20: 10, ma60: 9.5, atr: 0.4,
      macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false, support: 9.7, resistance: 10.6,
      entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-10-15'] };
    let entry;
    for (const [sample, price] of scenario.prices.entries()) {
      now = at - (2 - sample) * 30000;
      snapshot = market('strong', scenario.breakout ? 1 : 0.5, { checkedAt: now, expiresAt: now + 90000,
        evidence: { quoteTime: now, indexQuoteTimes: { sh000001: now, sz399001: now, sz399006: now }, breadthQuoteTime: now, breadthFetchedAt: now } });
      const quote = { symbol, name: scenario.name, source: 'isolated quote', price, ask: price, bid: price - 0.01,
        prevClose: 10.05, open: scenario.open || 10, low: 9.8, high: 10.7, volume: 100000, amount: 3e8, turnover: 4,
        askSize: 50000, bidSize: 50000, timestamp: now, date: '2026-10-16', limitUp: 11.05, limitDown: 9.05 };
      entry = service.withEntryEvidence(symbol, 'swing', quote, { technical, source: 'isolated daily', fetchedAt: now });
      quotes[symbol] = quote;
    }
    const evaluation = account.agencyEvaluate('swing', symbol, quotes[symbol], entry, undefined, quotes);
    assert.equal(evaluation.buyable, false);
    assert.equal(evaluation.status, '等待时序确认');
    service.recordMonitoring(symbol, evaluation);
    const check = account.s.agency.groups.find(group => group.id === 'swing').members.find(member => member.symbol === symbol).monitoringCheck;
    assert.equal(check.status, 'conditions');
    assert.match(check.reason, scenario.expected);
    checks.push({ symbol, name: scenario.name, ...check });
  }
  assert.equal(validState(account.s), true);
  assert.equal(account.s.trades.length, 0);
  assert.equal(account.s.lots.length, 0);
  return { checks, state: { ...state, account: account.s, stats: account.stats(quotes), quotes,
    agency: { ...account.agencyState(quotes), runtime: { ...state.agency.runtime, marketRegime: snapshot } } } };
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
    ['strong', market('strong', 1), /当日广度偏强.*正常风险预算/, /波段可检查回踩或突破/],
    ['neutral', market('neutral', 0.5), /半额风险预算/, /仅检查回踩/],
    ['high-volatility', market('strong', 0.5), /半额风险预算/, /仅检查回踩/],
    ['confirming-paused', market('weak', 0, { reason: '市场环境改善等待持续确认：至少 2 份不同报价且间隔 120 秒',
      metrics: { ...market('strong', 1).metrics, candidateStatus: 'strong' } }), /当日广度偏强.*待持续确认.*暂停新开仓/, /已有持仓继续执行原退出计划/],
    ['confirming-half', market('neutral', 0.5, { reason: '市场环境改善等待持续确认：至少 2 份不同报价且间隔 120 秒',
      metrics: { ...market('strong', 1).metrics, candidateStatus: 'strong' } }), /当日广度偏强.*待持续确认.*半额风险预算/, /仅检查回踩/],
    ['weak', market('weak', 0), /暂停新开仓/, /已有持仓继续执行原退出计划/],
    ['stale', market('strong', 1, { expiresAt: at - 1 }), /待核验.*暂停新开仓/, /已有持仓继续执行原退出计划/],
    ['unknown', market('unknown', 0, { reason: '市场环境获取失败：隔离网络错误' }), /待核验.*暂停新开仓/, /已有持仓继续执行原退出计划/],
    ['old-policy', market('strong', 1, { policyVersion: 1 }), /待核验.*暂停新开仓/, /已有持仓继续执行原退出计划/]
  ];
  const checked = [];
  for (const [name, snapshot, badge, summary] of cases) {
    await win.webContents.executeJavaScript(`state.agency.runtime.marketRegime=${JSON.stringify(snapshot)}; switchPage('agency'); $('agency-diagnostics').open=true; $('agency-market-regime').scrollIntoView({block:'center'});`);
    await paint();
    const view = await win.webContents.executeJavaScript(`({badge:$('agency-market-badge').innerText, summary:$('agency-market-summary').innerText, time:$('agency-market-time').innerText, metrics:$('agency-market-metrics').innerText, overflow:document.documentElement.scrollWidth>innerWidth})`);
    assert.match(view.badge, badge); assert.match(view.summary, summary); assert.match(view.time, /2026\/10\/16/); assert.equal(view.overflow, false);
    if (name === 'strong') { assert.match(view.metrics, /62.00%/); assert.match(view.metrics, /0.50% 权益/); }
    if (name === 'neutral') assert.match(view.metrics, /0.25% 权益/);
    fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG()); checked.push({ name, ...view });
  }
  await win.webContents.executeJavaScript(`state.agency.runtime.marketRegime=${JSON.stringify(market('strong', 1))}; renderAgency(); $('agency-market-regime').querySelector('details').open=true; $('agency-market-regime').scrollIntoView({block:'center'});`);
  await paint();
  const evidence = await win.webContents.executeJavaScript(`$('agency-market-indices').innerText`);
  assert.match(evidence, /中期趋势（仅观察）/); assert.equal((evidence.match(/向下/g) || []).length, 3);
  for (const profile of STRATEGY_PROFILES) {
    const permission = await win.webContents.executeJavaScript(`agencyUi.strategyId=${JSON.stringify(profile.id)}; renderAgency(); ({badge:$('agency-market-badge').innerText,metrics:$('agency-market-metrics').innerText})`);
    assert.match(permission.badge, /当日广度偏强.*正常风险预算/);
    assert.match(permission.metrics, /0.50% 权益/);
  }
  fs.writeFileSync(path.join(output, 'expanded-evidence.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1120, 850);
  await win.webContents.executeJavaScript(`$('agency-market-regime').scrollIntoView({block:'center'});`);
  await paint();
  const narrow = await win.webContents.executeJavaScript('({width:innerWidth, overflow:document.documentElement.scrollWidth>innerWidth})');
  assert.equal(narrow.overflow, false);
  fs.writeFileSync(path.join(output, 'narrow-evidence.png'), (await win.webContents.capturePage()).toPNG());
  const diagnostic = entryDiagnosticsState();
  await win.webContents.executeJavaScript(`renderState(${JSON.stringify(diagnostic.state)}); agencyUi.strategyId='swing'; switchPage('agency'); $('agency-member-filter').value='active'; renderAgency(); $('agency-members').scrollIntoView({block:'start'});`);
  await paint();
  const diagnosticView = await win.webContents.executeJavaScript(`({reasons:[...document.querySelectorAll('#agency-members [data-unopened-reason]')].map(node=>node.innerText), overflow:document.documentElement.scrollWidth>innerWidth})`);
  assert.equal(diagnosticView.reasons.length, diagnostic.checks.length);
  for (const check of diagnostic.checks) assert.ok(diagnosticView.reasons.some(reason => reason === '最近检查未开仓原因：' + check.reason));
  assert.equal(diagnosticView.overflow, false);
  fs.writeFileSync(path.join(output, 'entry-diagnostics.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelector('#agency-members tbody tr:last-child').scrollIntoView({block:'center'});`);
  await paint();
  fs.writeFileSync(path.join(output, 'entry-breakout-diagnostics.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []); assert.deepEqual(blockedNetwork, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checked, account, narrow, diagnostics: diagnostic.checks, diagnosticView, errors, blockedNetwork }, null, 2));
  console.log(JSON.stringify({ passed: checked.length, diagnostics: diagnostic.checks.length, accountVerified: true, errors, blockedNetwork, output }));
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
