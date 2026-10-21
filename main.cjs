const { app, BrowserWindow, ipcMain, dialog, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Engine, initialState } = require('./core/engine.cjs');
const { Store } = require('./core/store.cjs');
const { Market } = require('./core/market.cjs');
const { analyze } = require('./core/analysis.cjs');
const { evaluateEntry, configureStrategy, STRATEGY_PROFILES, strategyProfile } = require('./core/strategy.cjs');
const { StrategyMonitor } = require('./core/strategy-monitor.cjs');
const { Screener, FIELDS, BOARDS, OPS, financialQualityRules, normalizeFinance } = require('./core/screener.cjs');
const { RESEARCH_METADATA, validateResearchRules } = require('./core/research-rules.cjs');
const { PERFORMANCE_METADATA } = require('./core/performance-rules.cjs');
const { evaluateOperatingResearch } = require('./core/company-research.cjs');
const { EVIDENCE_KINDS, EVIDENCE_CONDITIONS, INDUSTRY_METADATA, safeEvidenceUrl } = require('./core/selection-evidence.cjs');
const { SelectionEvidenceStore } = require('./core/selection-evidence-store.cjs');
const { CompanyEvidenceSource } = require('./core/company-evidence-source.cjs');
const { CompanyDocumentPool } = require('./core/company-document-pool.cjs');
const { CompanyIndustrySource } = require('./core/company-industry-source.cjs');
const { EntryEvidenceStore } = require('./core/entry-evidence-store.cjs');
const { FreeScreenerSource } = require('./core/screener-sources.cjs');
const { STRATEGY_PRESETS, parseStrategyDescription } = require('./core/strategy-presets.cjs');
const { ScreenerStore } = require('./core/screener-store.cjs');
const { Research, externalUrl } = require('./core/research.cjs');
const { NoticeMonitor } = require('./core/notice-monitor.cjs');
const { AgencyService } = require('./core/agency-service.cjs');
const { MarketRegimeService } = require('./core/market-regime-service.cjs');
const { enableMarketPolicy, cachedBreadthLoader } = require('./core/market-policy.cjs');
const { AgencyPoolService } = require('./core/agency-pool.cjs');
const { CorporateSource } = require('./core/corporate-source.cjs');
const { CninfoNoticeSource } = require('./core/cninfo-notice-source.cjs');
const { CorporateService } = require('./core/corporate-service.cjs');
const { addAgencyMembers } = require('./core/agency-members.cjs');
const { createEntryConditions, entryConditionNeedsFundamentals } = require('./core/entry-conditions.cjs');
const { symbolOf, session, cnTime } = require('./core/common.cjs');
const { decisionView, accountView } = require('./core/view-state.cjs');
const { ViewStream } = require('./core/view-stream.cjs');
const viewStream = new ViewStream();
let viewSubscribed = false;
const testDirArg = process.argv.find(a => a.startsWith('--test-data-dir='));
if (testDirArg && !app.isPackaged) app.setPath('userData', testDirArg.split('=').slice(1).join('='));
if (!app.requestSingleInstanceLock()) app.quit();
let win, store, engine, market, research, monitor, noticeMonitor, screener, agency, agencyPool, corporate, companyEvidence, companyIndustry, entryEvidenceStore, entryEvidenceWarning = '', agencyError = '', timer, noticeTimer, publishTimer, refreshing, previewSymbol = null, fatal = '', quotes = {}, connection = { ok: false, message: '正在连接行情服务', at: null };
let marketRegime;
const indices = ['sh000001', 'sz399001', 'sz399006'];
function agencySymbols() { return engine.s.agency.groups.flatMap(g => g.members.map(m => m.symbol)); }
// Automatic candidates are refreshed by the bounded rule-check queue. Routine
// polling remains small so holding exits are independent of the candidate count.
function strategySymbols() { return [...new Set([...engine.s.lots.map(l => l.symbol), ...engine.s.watchlist, ...(previewSymbol ? [previewSymbol] : [])])]; }
function needsFundamentals(symbol) { return engine.s.agency.groups.some(g => g.members.some(m => m.symbol === symbol && (g.id === 'long' || entryConditionNeedsFundamentals(m.entryConditions)))) || (engine.selectedStrategy(symbol) === 'long' && !engine.s.lots.some(l => l.symbol === symbol)); }
function needsNotices(symbol) { return agencySymbols().includes(symbol) || !engine.s.lots.some(l => l.symbol === symbol); }
function state({ view = false } = {}) {
  const signals = {}, owners = new Map(engine.s.agency.groups.flatMap(group => group.members.map(member => [member.symbol, group])));
  for (const symbol of strategySymbols()) {
    signals[symbol] = evaluateEntry(engine, symbol, quotes[symbol], monitor?.snapshots[symbol], undefined, engine.selectedStrategy(symbol));
    if (signals[symbol].buyable && research) {
      try { research.assertNoticeCurrent(symbol, monitor?.snapshots[symbol]?.notices); }
      catch (error) {
        signals[symbol].buyable = false; signals[symbol].quantity = 0; signals[symbol].economics = null;
        signals[symbol].status = '等待公告重新核验'; signals[symbol].reasons.unshift(error.message);
      }
    }
    const owner = owners.get(symbol);
    if (owner) {
      signals[symbol].buyable = false; signals[symbol].economics = null; signals[symbol].quantity = 0;
      signals[symbol].status = '策略自动交易管理';
      signals[symbol].reasons.unshift(`由${owner.name}自动交易组管理，请在策略自动交易自选页查看规则检查与执行记录`);
    }
    if (fatal || !connection.ok) {
      signals[symbol].buyable = false;
      if (signals[symbol].status === '规则通过 · 可模拟') signals[symbol].status = fatal ? '交易已暂停' : '等待有效行情';
      signals[symbol].reasons.unshift(fatal || '行情连接不可用，等待恢复');
    }
  }
  return { account: view ? accountView(engine.s) : engine.s, accountPaused: !!fatal, stats: engine.stats(quotes), agency: { ...engine.agencyState(quotes, view ? { decisionView } : {}), runtime: { ...(agency ? agency.publicState() : { decisionMode: 'rules', rulesVersion: '1', intervalSeconds: 300, runningGroups: [], online: false, lastError: agencyError }), notices: noticeMonitor?.publicState() } }, agencyPool: agencyPool?.publicState(), quotes: { ...engine.s.marks, ...quotes }, signals, strategyProfiles: STRATEGY_PROFILES, planSelections: { ...engine.s.planSelections }, connection, session: session(), date: cnTime().date, now: Date.now(), dataPath: app.getPath('userData'), warning: fatal || store.warning || entryEvidenceWarning || agencyError };
}
function publish(snapshot) {
  clearTimeout(publishTimer); publishTimer = null;
  if (win && !win.isDestroyed()) {
    const current = snapshot || state({ view: true });
    if (viewSubscribed) win.webContents.send('view:patch', viewStream.next(current));
    else win.webContents.send('state', current);
  }
}
function publishAgencyPoolProgress() {
  if (win && !win.isDestroyed() && agencyPool) win.webContents.send('agency:pool:progress', agencyPool.progressState());
}
function schedulePublish() { if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; publish(); }, 500); }
function transaction(fn) {
  if (fatal) throw Error(fatal);
  const before = structuredClone(engine.s);
  let result;
  try { result = fn(); } catch (e) { engine.s = before; throw e; }
  try { store.save(engine.s); return result; }
  catch (e) { engine.s = before; fatal = `账户保存失败，交易已暂停：${e.message}`; agency?.invalidate(); throw Error(fatal); }
}
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const symbols = [...new Set([...strategySymbols(), ...engine.s.orders.filter(o => o.status === 'pending').map(o => o.symbol), ...indices])];
    try {
      const batch = await market.quotes(symbols); Object.assign(quotes, batch);
      const missing = symbols.filter(s => !batch[s]);
      const sources = [...new Set(Object.values(batch).map(q => q.source).filter(Boolean))];
      const displayOnly = Object.values(batch).filter(q => !indices.includes(q.symbol) && q.canTrade === false).length;
      connection = { ok: true, message: [missing.length ? `${missing.length} 只股票暂缺报价` : '行情接口已连接', displayOnly ? `${displayOnly} 只股票行情仅供展示，暂停模拟成交` : ''].filter(Boolean).join(' · '), sources, at: Date.now() };
      // Keep quotes visible after a fatal error without retrying account changes
      // or wrapping the original failure again on every refresh.
      if (!fatal) {
        try { transaction(() => engine.tick(batch, monitor.snapshots)); }
        catch (e) {
          if (!fatal) { fatal = `交易处理失败，交易已暂停：${e.message}`; agency?.invalidate(); }
        }
      }
    } catch (e) { connection = { ok: false, message: `行情连接失败：${e.message}`, at: connection.at }; }
    const holdings = [...new Set(engine.s.lots.map(lot => lot.symbol))], holdingSet = new Set(holdings);
    const symbolsToScan = strategySymbols().filter(symbol => !holdingSet.has(symbol));
    // Separate scan lanes keep holding history/notices ahead of background entry
    // preparation. Rule scheduling never waits for the entire monitor queue.
    monitor.scan(holdings, holdings.filter(needsFundamentals), holdings.filter(needsNotices), 'holdings').catch(() => {});
    monitor.scan(symbolsToScan, symbolsToScan.filter(needsFundamentals), symbolsToScan.filter(needsNotices)).catch(() => {});
    marketRegime?.poll().catch(() => {});
    agency?.sampleEntries().catch(() => {});
    agency?.poll().catch(() => {});
    corporate?.poll().catch(() => {});
    const snapshot = state({ view: true }); publish(snapshot); return snapshot;
  })().finally(() => { refreshing = null; });
  return refreshing;
}
function startTimer() { clearInterval(timer); timer = setInterval(refresh, engine.s.settings.refreshSeconds * 1000); }
function handler(name, fn) {
  ipcMain.handle(name, async (event, payload) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false, error: '无效窗口来源' };
    try { return { ok: true, data: await fn(payload) }; } catch (e) { return { ok: false, error: e.message }; }
  });
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.whenReady().then(() => {
  try {
    entryEvidenceStore = new EntryEvidenceStore(path.join(app.getPath('userData'), 'entry-evidence'), {
      resolveDocumentArtifact: document => document.kind === 'industry-report' ? companyIndustry?.readArchivedArtifact(document) : companyEvidence?.readArchivedArtifact(document)
    });
    store = new Store(app.getPath('userData'), {
      decode: value => value?.format === 'guanlan-account-with-entry-evidence' ? entryEvidenceStore.importAccount(value) : value
    });
    const loaded = store.load();
    if (loaded && (!loaded.agency || loaded.agency.version !== 5 || loaded.agency.decisionMode !== 'rules' || !Array.isArray(loaded.agency.corporateActions))) store.backup(loaded);
    engine = new Engine(loaded || initialState());
    enableMarketPolicy(engine.s);
    if (store.warning) for (const group of engine.s.agency.groups) engine.agencyMode({ strategyId: group.id, mode: 'stopped' });
    store.save(engine.s);
  }
  catch (e) { dialog.showErrorBox('观澜 · 账户无法载入', `${e.message}\n数据目录：${app.getPath('userData')}`); app.quit(); return; }
  market = new Market((url, opts) => net.fetch(url, opts));
  const entryMarket = new Market((url, opts) => net.fetch(url, opts));
  const noticeSource = new CninfoNoticeSource((url, opts) => net.fetch(url, opts));
  research = new Research((url, opts) => net.fetch(url, opts), { noticeSource });
  const screenSource = new FreeScreenerSource((url, opts) => net.fetch(url, opts));
  const loadBreadth = cachedBreadthLoader(screenSource);
  marketRegime = new MarketRegimeService({ indexHistory: (symbol, signal, force) => market.indexHistory(symbol, signal, force),
    getQuotes: () => quotes, loadBreadth, onChange: schedulePublish });
  const selectionEvidence = new SelectionEvidenceStore(app.getPath('userData'));
  companyEvidence = new CompanyEvidenceSource((url, opts) => net.fetch(url, opts), {
    directory: path.join(app.getPath('userData'), 'company-research'), parser: new CompanyDocumentPool({ maxBytes: 128 * 1024 * 1024 }), noticeSource });
  companyIndustry = new CompanyIndustrySource((url, opts) => net.fetch(url, opts), { directory: path.join(app.getPath('userData'), 'industry-research'), parser: companyEvidence.parser });
  const automaticEvidence = async (symbol, options = {}) => {
    const bundle = await companyEvidence.get(symbol, options);
    return options.includeIndustry === false ? bundle : companyIndustry.enrich(bundle, options);
  };
  const previousPool = engine.s.agency.pool?.lastResult;
  companyEvidence.retainSymbols([...new Set([...engine.s.agency.groups.flatMap(group => group.members.map(member => member.symbol)),
    ...['pending', 'unassignedPending', 'held', 'added', 'retained'].flatMap(key => (previousPool?.[key] || []).map(item => item.symbol))])]);
  const evidenceAudit = entryEvidenceStore.auditAccount(engine.s);
  if (evidenceAudit.status !== 'ready') entryEvidenceWarning = `开仓依据档案缺失或损坏，暂停自动新开仓；已有持仓退出继续：${evidenceAudit.issues[0]?.reason || '请检查数据目录'}`;
  screener = new Screener((url, opts) => net.fetch(url, opts), new ScreenerStore(app.getPath('userData')), (symbol, signal) => market.strategyHistory(symbol, signal, true), () => new Date(), (symbol, signal, force) => research.getFinanceWithIndustry({ symbol, force }), (symbol, signal, force) => research.get({ symbol, section: 'notices', force }), symbols => market.quotes(symbols), options => screenSource.load(options), symbols => {
    const candidates = new Set(symbols);
    return selectionEvidence.list().filter(record => candidates.has(record.symbol));
  }, automaticEvidence, { screeningCacheDirectory: path.join(app.getPath('userData'), 'screening-cache'),
    screeningCacheNamespace: 'tencent-unadjusted/eastmoney-finance-industry-v2', noticeEvidenceLoader: (symbol, options) => companyEvidence.getNotices(symbol, options) });
  screener.evidenceRetention = symbols => companyEvidence.retainSymbols(symbols);
  screener.endEvidenceBatch = () => companyEvidence.endBatch();
  agencyPool = new AgencyPoolService({ getEngine: () => engine, transaction, screener,
    onChange: event => event?.progressOnly ? publishAgencyPoolProgress() : publish(),
    prepareSource: options => companyEvidence.beginBatch(options) });
  monitor = new StrategyMonitor(market, () => new Date(), schedulePublish, research);
  corporate = new CorporateService({ source: new CorporateSource((url, opts) => net.fetch(url, opts), { noticeSource }),
    getEngine: () => engine, transaction, market, getMonitor: () => monitor,
    acceptQuotes: batch => Object.assign(quotes, batch), onChange: schedulePublish, isAvailable: () => !fatal });
  monitor.corporate = corporate;
  try {
    agency = new AgencyService({ getEngine: () => engine, transaction, market, entryMarket, monitor, noticeGuard: research,
      getMarketRegime: () => marketRegime.getSnapshot(),
      getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch),
      getSelectionEvidence: symbol => selectionEvidence.list(symbol),
      getAutomaticEvidence: automaticEvidence,
      getNoticeEvidence: (symbol, options) => companyEvidence.getNotices(symbol, options),
      archiveEntryEvidence: payload => {
        if (entryEvidenceWarning) throw Error(entryEvidenceWarning);
        return entryEvidenceStore.archive(payload);
      },
      onChange: schedulePublish, isAvailable: () => !fatal && connection.ok });
  } catch (e) { agencyError = e.message; }
  noticeMonitor = new NoticeMonitor({ research, getEngine: () => engine,
    getPendingSymbols: () => agency?.pendingBuySymbols() || [],
    isAvailable: () => !fatal && session().open && session().known !== false, onChange: schedulePublish });
  // This timer does not wait for quote/history/report queues. Entry execution
  // still forces a fresh check and validates its notice version before commit.
  const pollNotices = () => noticeMonitor.poll().catch(() => {});
  noticeTimer = setInterval(pollNotices, 5000); pollNotices();
  win = new BrowserWindow({ width: 1536, height: 980, minWidth: 1120, minHeight: 760, backgroundColor: '#0b1220', title: '观澜 · A股模拟交易', icon: path.join(__dirname, 'assets/icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  handler('state', () => state());
  handler('view:state', () => state({ view: true }));
  handler('view:subscribe', () => { viewSubscribed = true; return viewStream.reset(state({ view: true })); });
  handler('view:refresh', refresh);
  handler('refresh', async () => { await refresh(); return state(); });
  handler('agency:transfer', input => { const result = transaction(() => engine.agencyTransfer(input)); publish(); return result; });
  handler('agency:configure', input => { const result = transaction(() => engine.agencyConfigure(input)); publish(); return result; });
  handler('agency:mode', input => { const result = transaction(() => engine.agencyMode(input)); publish(); if (input.mode === 'running') agency?.poll({ force: true, groupIds: [input.strategyId] }).catch(() => {}); return result; });
  handler('agency:member', async input => {
    const symbol = symbolOf(input?.symbol);
    const epoch = engine.s.agency.epoch;
    const request = { ...input, symbol, ...(input.action === 'add' ? { entryConditions: createEntryConditions(input.entryConditions, engine.clock()) } : {}) };
    let memberQuote;
    if (input.action === 'add') {
      const fresh = await market.quotes([symbol]);
      if (engine.s.agency.epoch !== epoch) throw Error('账户已重置，本次未加入，请重新选择股票');
      if (!fresh[symbol]) throw Error('没有找到该股票的有效行情'); Object.assign(quotes, fresh);
      memberQuote = fresh[symbol];
    }
    const result = transaction(() => {
      if (engine.s.agency.epoch !== epoch) throw Error('账户已重置，本次未加入，请重新选择股票');
      const member = engine.agencyMember(request);
      if (memberQuote) engine.s.marks[symbol] = structuredClone(memberQuote);
      return member;
    }); publish();
    if (input.action === 'add') monitor.load(symbol, true, needsFundamentals(symbol), true).then(() => agency?.poll({ force: true, groupIds: [input.strategyId] })).catch(() => {});
    return result;
  });
  handler('agency:members:add', async input => {
    const result = await addAgencyMembers(input, { getEngine: () => engine, transaction, market,
      acceptQuotes: batch => Object.assign(quotes, batch) });
    publish();
    if (result.added.length) agency?.poll({ force: true, groupIds: [result.strategyId] }).catch(() => {});
    return result;
  });
  handler('agency:reconcile', input => { const result = transaction(() => engine.agencyReconcile(input)); publish(); return result; });
  handler('agency:verify', async input => {
    if (fatal) throw Error(fatal);
    const group = engine.s.agency.groups.find(item => item.id === input?.strategyId);
    if (!group) throw Error('自动交易策略无效');
    const request = { strategyId: group.id };
    if (input?.symbol != null) {
      request.symbol = symbolOf(input.symbol);
      if (!group.members.some(member => member.symbol === request.symbol)
        && !engine.s.trades.some(trade => trade.owner === group.id && trade.symbol === request.symbol)) throw Error('股票不属于该策略的成员或历史权益');
    }
    // Both are data checks. A manual retry must refresh the shared environment
    // without scheduling a trading cycle or one market-wide request per stock.
    const [verification, environment] = await Promise.allSettled([corporate.verify(request), marketRegime.poll({ force: true })]);
    publish();
    if (verification.status === 'rejected') throw verification.reason;
    if (environment.status === 'rejected') throw environment.reason;
    return { ...verification.value, marketRegime: environment.value };
  });
  handler('agency:run', async input => {
    if (!agency) throw Error(agencyError || '策略自动交易不可用');
    const config = agency.publicState();
    if (!config.session.open || config.session.known === false) throw Error(config.session.label || '当前不是可核验的交易时段');
    if (fatal || !connection.ok) throw Error(fatal || '行情连接不可用，等待恢复');
    const groupIds = input?.strategyId !== undefined ? [strategyProfile(input.strategyId).id] : null;
    await marketRegime.poll({ force: true });
    if (fatal || !connection.ok) throw Error(fatal || '行情连接不可用，等待恢复');
    return agency.poll({ force: true, ...(groupIds ? { groupIds } : {}) });
  });
  handler('agency:pool:status', () => agencyPool.publicState());
  handler('agency:pool:cancel', () => { agencyPool.cancel(); return true; });
  const updateCandidatePool = async (retryEvidence, input = {}) => {
    if (fatal) throw Error(fatal);
    // Manual screening has no trading-session, daily-count or cooldown gate.
    // Keep progress visible while data requests run; execution retains its own gates.
    const progressTimer = setInterval(publishAgencyPoolProgress, 1000);
    try {
      const result = await agencyPool.run({ retryEvidence, ...(input?.screeningMode !== undefined ? { screeningMode: input.screeningMode } : {}),
        ...(input?.research !== undefined ? { research: input.research } : {}),
        ...(input?.industry !== undefined ? { industry: input.industry } : {}),
        ...(input?.performance !== undefined ? { performance: input.performance } : {}) });
      agency?.invalidate();
      agency?.poll({ force: true }).catch(() => {});
      return result;
    } finally { clearInterval(progressTimer); }
  };
  handler('agency:pool:run', input => updateCandidatePool(false, input));
  handler('agency:pool:retry', input => updateCandidatePool(true, input));
  handler('research:get', input => research.get(input));
  const researchInspections = new Map();
  handler('research:inspect', async input => {
    const symbol = symbolOf(input?.symbol);
    const query = validateResearchRules(input?.research) || { version: 1, enabled: false, path: 'product', rules: [] };
    if (input?.force !== undefined && typeof input.force !== 'boolean'
      || input?.includeProducts !== undefined && typeof input.includeProducts !== 'boolean') throw Error('资料核验参数无效');
    const includeProducts = query.path === 'product' || input?.includeProducts === true;
    const key = JSON.stringify([symbol, query, includeProducts, input?.force === true]);
    if (researchInspections.has(key)) return researchInspections.get(key);
    if (researchInspections.size >= 2) throw Error('已有资料核验正在执行，请稍后重试');
    const task = (async () => {
      const [financeResult, productResult] = await Promise.allSettled([
        research.get({ symbol, section: 'finance', force: input?.force === true }),
        includeProducts ? companyEvidence.get(symbol, { force: input?.force === true }) : Promise.resolve(null)
      ]);
      const now = new Date();
      let company = null, companyError = null;
      try {
        if (financeResult.status === 'rejected') throw financeResult.reason;
        company = { ...normalizeFinance(financeResult.value, symbol, now), symbol };
      } catch (error) { companyError = error?.message || '公司经营资料获取或解析失败'; }
      const bundle = productResult.status === 'fulfilled' ? productResult.value : { symbol, documents: [], errors: [productResult.reason?.message || '产品资料获取失败'] };
      return evaluateOperatingResearch(bundle, query, { symbol, company, now, companyError });
    })().finally(() => researchInspections.delete(key));
    researchInspections.set(key, task);
    return task;
  });
  handler('research:open', input => shell.openExternal(externalUrl(input)));
  handler('screener:meta', () => ({ fields: FIELDS, boards: BOARDS, ops: OPS, strategies: STRATEGY_PRESETS, evidenceKinds: EVIDENCE_KINDS, evidenceConditions: EVIDENCE_CONDITIONS, industry: INDUSTRY_METADATA, financialQualityRules: financialQualityRules(), research: RESEARCH_METADATA, performance: PERFORMANCE_METADATA }));
  handler('evidence:list', input => selectionEvidence.list(input?.symbol || undefined));
  handler('evidence:save', input => {
    if (screener.activeRun) throw Error('选股正在执行，请完成或取消后再修改证据');
    return selectionEvidence.save(input);
  });
  handler('evidence:remove', input => {
    if (screener.activeRun) throw Error('选股正在执行，请完成或取消后再修改证据');
    return selectionEvidence.remove(input);
  });
  handler('evidence:open', async input => {
    const record = selectionEvidence.list().find(item => item.id === input?.id);
    const url = record && safeEvidenceUrl(record.url);
    if (!url) throw Error('证据记录不存在或来源链接不可用');
    await shell.openExternal(url); return true;
  });
  handler('screener:parse', parseStrategyDescription);
  handler('screener:status', () => screener.progress);
  handler('screener:cancel', () => { screener.cancel(); return true; });
  handler('screener:history', () => ({ snapshots: screener.history.list(), warning: screener.history.warning }));
  handler('screener:run', input => screener.run(input?.query, engine.s.watchlist.slice(), input?.force === true, input?.snapshotId ?? null, input?.strategyId || null));
  handler('screener:open', async input => {
    const symbol = symbolOf(input);
    previewSymbol = symbol;
    // Company research remains accessible when quote services are unavailable.
    try { const fresh = await market.quotes([symbol]); if (fresh[symbol]) quotes[symbol] = fresh[symbol]; } catch {}
    monitor.load(symbol, false, needsFundamentals(symbol), needsNotices(symbol)).catch(() => {});
    publish(); return symbol;
  });
  handler('detail', async input => {
    const symbol = symbolOf(input.symbol); previewSymbol = symbol;
    monitor.load(symbol, !!input.force, needsFundamentals(symbol), needsNotices(symbol)).catch(() => {});
    const history = await market.history(symbol, !!input.force);
    let minute = null, minuteError = null;
    try { minute = await market.intraday(symbol); } catch (e) { minuteError = e.message; }
    return { symbol, ...history, minute, minuteError, analysis: analyze(history.bars, quotes[symbol] || engine.s.marks[symbol]) };
  });
  handler('watch:add', async input => {
    const symbol = symbolOf(input);
    if (engine.s.watchlist.length >= 50) throw Error('自选股最多 50 只');
    const found = await market.quotes([symbol]);
    if (!found[symbol]) throw Error('没有找到该股票的有效行情');
    quotes[symbol] = found[symbol]; transaction(() => { if (!engine.s.watchlist.includes(symbol)) engine.s.watchlist.push(symbol); engine.s.marks[symbol] = found[symbol]; }); publish(); return symbol;
  });
  handler('watch:remove', input => { const symbol = symbolOf(input); transaction(() => { engine.s.watchlist = engine.s.watchlist.filter(s => s !== symbol); }); publish(); });
  handler('trade', async input => {
    const symbol = symbolOf(input.symbol);
    const fresh = await market.quotes([symbol]); Object.assign(quotes, fresh);
    const trade = transaction(() => engine.execute({ ...input, symbol }, fresh[symbol], quotes)); publish(); return trade;
  });
  handler('order', input => { const order = transaction(() => engine.place(input)); publish(); return order; });
  handler('strategy:buy', async input => {
    const symbol = symbolOf(input.symbol), strategyId = strategyProfile(input.strategyId).id;
    if (strategyId !== engine.selectedStrategy(symbol)) throw Error('已选策略发生变化，请查看当前买卖计划后重新确认');
    if (!input.expected || input.expected.strategyId !== strategyId) throw Error('请先查看并确认当前策略的买卖计划');
    const snapshot = await monitor.load(symbol, true, needsFundamentals(symbol), needsNotices(symbol));
    const fresh = await market.quotes([symbol]); Object.assign(quotes, fresh);
    research.assertNoticeCurrent(symbol, snapshot?.notices);
    const trade = transaction(() => {
      research.assertNoticeCurrent(symbol, snapshot?.notices);
      return engine.strategyEntry({ ...input, symbol }, fresh[symbol], snapshot, quotes);
    });
    publish(); return trade;
  });
  handler('strategy:select', input => {
    const symbol = symbolOf(input?.symbol), strategyId = strategyProfile(input?.strategyId).id;
    transaction(() => engine.selectStrategy(symbol, strategyId)); previewSymbol = symbol;
    monitor.load(symbol, false, needsFundamentals(symbol), needsNotices(symbol)).catch(() => {}); publish(); return strategyId;
  });
  handler('strategy:settings', input => { const next = configureStrategy(input); transaction(() => { engine.s.strategySettings = next; engine.s.agency.revision++; }); publish(); });
  handler('cancel', input => { transaction(() => engine.cancel(input)); publish(); });
  handler('risk', input => { transaction(() => engine.setRisk(input.symbol, input)); publish(); });
  handler('settings', input => { transaction(() => engine.configure(input)); startTimer(); publish(); });
  handler('capital:add', input => {
    const flow = transaction(() => {
      if (input?.accountCreatedAt !== engine.s.createdAt) throw Error('模拟账户已变更，请刷新后重新确认追加本金');
      return engine.addCapital(input, quotes);
    });
    // The flow is already committed. A failed view broadcast must not turn it
    // into a business rejection that lets the renderer replace its request ID.
    try { publish(); } catch {}
    return flow;
  });
  handler('reset', input => {
    if (input.confirm !== '重置') throw Error('请输入“重置”确认');
    const next = new Engine(initialState(input.capital)).s; enableMarketPolicy(next); store.backup(engine.s); agency?.invalidate(); agencyPool?.cancel(); transaction(() => { engine.s = next; }); entryEvidenceWarning = ''; publish(); return true;
  });
  handler('backup', async () => {
    const selected = await dialog.showSaveDialog(win, { title: '备份模拟账户', defaultPath: `观澜账户备份-${cnTime().date}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (selected.canceled) return false;
    fs.writeFileSync(selected.filePath, JSON.stringify(entryEvidenceStore.exportAccount(engine.s), null, 2), 'utf8'); return true;
  });
  handler('export', async () => {
    const selected = await dialog.showSaveDialog(win, { title: '导出成交记录', defaultPath: `观澜成交记录-${cnTime().date}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (selected.canceled) return false;
    const escape = v => '"' + String(v ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
    const rows = [['北京时间', '代码', '名称', '方向', '股数', '成交价', '成交金额', '佣金', '印花税', '过户费', '已实现盈亏', '成交原因', '交易归属', '决策编号', '交易周期编号', '人工干预']];
    for (const t of engine.s.trades) { const tm = cnTime(new Date(t.time)); rows.push([tm.date + ' ' + tm.time, t.symbol, t.name, t.side === 'buy' ? '买入' : '卖出', t.quantity, t.price, t.gross / 100, t.fees.commission / 100, t.fees.stampTax / 100, t.fees.transferFee / 100, t.pnl == null ? '' : t.pnl / 100, t.reason, t.owner && t.owner !== 'manual' ? strategyProfile(t.owner).name + ' 自动交易' : '手动', t.decisionId || '', t.cycleId || '', t.manualIntervention ? '是' : '']); }
    fs.writeFileSync(selected.filePath, '\uFEFF' + rows.map(r => r.map(escape).join(',')).join('\r\n')); return true;
  });
  handler('folder', () => shell.openPath(app.getPath('userData')));
  win.loadFile(path.join(__dirname, 'ui/index.html'));
  win.webContents.once('did-finish-load', () => { refresh(); startTimer(); });
});
app.on('window-all-closed', () => { clearInterval(timer); clearInterval(noticeTimer); noticeMonitor?.stop(); agency?.stop(); agencyPool?.cancel(); void companyEvidence?.destroy?.(); app.quit(); });
