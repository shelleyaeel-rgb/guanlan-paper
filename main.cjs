const { app, BrowserWindow, ipcMain, dialog, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Engine, initialState } = require('./core/engine.cjs');
const { Store } = require('./core/store.cjs');
const { Market } = require('./core/market.cjs');
const { StockSearch } = require('./core/stock-search.cjs');
const { IndexMarket } = require('./core/index-market.cjs');
const { DailyHistoryCache } = require('./core/daily-history-cache.cjs');
const { DailyHistoryStore } = require('./core/daily-history-store.cjs');
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
const { STRATEGY_PRESETS } = require('./core/strategy-presets.cjs');
const { ScreenerStore } = require('./core/screener-store.cjs');
const { Research, externalUrl } = require('./core/research.cjs');
const { TECHNICAL_STRATEGY_PROFILES } = require('./core/strategy-profiles.cjs');
const { AgencyService } = require('./core/agency-service.cjs');
const { MarketRegimeService } = require('./core/market-regime-service.cjs');
const { enableMarketPolicy, cachedBreadthLoader } = require('./core/market-policy.cjs');
const { AgencyPoolService } = require('./core/agency-pool.cjs');
const { AgencyPoolScheduler } = require('./core/agency-pool-scheduler.cjs');
const { CorporateSource } = require('./core/corporate-source.cjs');
const { CninfoNoticeSource } = require('./core/cninfo-notice-source.cjs');
const { CorporateService } = require('./core/corporate-service.cjs');
const { preparationState } = require('./core/preparation-state.cjs');
const { symbolOf, session, cnTime } = require('./core/common.cjs');
const { decisionView, accountView } = require('./core/view-state.cjs');
const { ViewStream } = require('./core/view-stream.cjs');
const { AccountOperations } = require('./core/account-operations.cjs');
const accountOperations = new AccountOperations(() => engine.s, fn => transaction(fn));
const viewStream = new ViewStream();
let viewSubscribed = false;
const testDirArg = process.argv.find(a => a.startsWith('--test-data-dir='));
if (testDirArg && !app.isPackaged) app.setPath('userData', testDirArg.split('=').slice(1).join('='));
if (!app.requestSingleInstanceLock()) app.quit();
let win, store, engine, market, research, monitor, screener, agency, agencyPool, corporate, companyEvidence, companyIndustry, entryEvidenceStore, entryEvidenceWarning = '', agencyError = '', timer, preparationTimer, publishTimer, refreshing, previewSymbol = null, fatal = '', quotes = {}, connection = { ok: false, message: '正在连接行情服务', at: null };
let marketRegime, poolScheduler;
const indices = ['sh000001', 'sz399001', 'sz399006'];
function agencySymbols() { return engine.s.agency.groups.flatMap(g => g.members.map(m => m.symbol)); }
// Automatic candidates are refreshed by the bounded rule-check queue. Routine
// polling remains small so holding exits are independent of the candidate count.
function strategySymbols() {
  return [...new Set([...engine.s.lots.map(l => l.symbol), ...(previewSymbol ? [previewSymbol] : [])])];
}
function poolState() { return agencyPool ? { ...agencyPool.publicState(), automation: poolScheduler?.publicState() || null } : undefined; }
async function refreshPreviewQuote(symbol) {
  const identity = accountOperations.capture(), fresh = await market.quotes([symbol]);
  accountOperations.assertCurrent(identity);
  if (previewSymbol !== symbol) return;
  if (!fresh[symbol]) throw Error('未取得该股票的有效报价，请核对代码或稍后刷新');
  if (fresh[symbol] && (!quotes[symbol] || fresh[symbol].timestamp >= quotes[symbol].timestamp)) quotes[symbol] = fresh[symbol];
  publish();
}
function needsFundamentals() { return false; }
function needsNotices() { return false; }
function state({ view = false } = {}) {
  const signals = {}, owners = new Map(engine.s.agency.groups.flatMap(group => group.members.map(member => [member.symbol, group])));
  for (const symbol of strategySymbols()) {
    const owner = owners.get(symbol);
    signals[symbol] = evaluateEntry(engine, symbol, quotes[symbol], monitor?.snapshots[symbol], undefined, owner?.id || engine.selectedStrategy(symbol), { technicalOnly: true });
    signals[symbol].buyable = false; signals[symbol].economics = null; signals[symbol].quantity = 0;
    if (owner) {
      signals[symbol].buyable = false; signals[symbol].economics = null; signals[symbol].quantity = 0;
      signals[symbol].status = '策略自动交易管理';
      signals[symbol].reasons.unshift(`由${owner.name}自动交易组管理，请在自动交易页查看规则检查与执行记录`);
    } else signals[symbol].status = '只读分析 · 不提供手动开仓';
    if (fatal || !connection.ok) {
      signals[symbol].buyable = false;
      signals[symbol].status = fatal ? '交易已暂停' : '等待有效行情';
      signals[symbol].reasons.unshift(fatal || '行情连接不可用，等待恢复');
    }
  }
  return { account: view ? accountView(engine.s) : engine.s, accountPaused: !!fatal, stats: engine.stats(quotes), agency: { ...engine.agencyState(quotes, view ? { decisionView } : {}), runtime: { ...(agency ? agency.publicState() : { decisionMode: 'rules', rulesVersion: '1', intervalSeconds: 300, runningGroups: [], online: false, lastError: agencyError }), preparation: preparationState(engine, monitor, quotes) } }, agencyPool: poolState(), quotes: { ...engine.s.marks, ...quotes }, signals, strategyProfiles: TECHNICAL_STRATEGY_PROFILES, planSelections: { ...engine.s.planSelections }, connection, session: session(), date: cnTime().date, now: Date.now(), dataPath: app.getPath('userData'), warning: fatal || store.warning || entryEvidenceWarning || agencyError };
}
function publish(snapshot) {
  clearTimeout(publishTimer); publishTimer = null;
  // Saving is the commit boundary. A renderer failure must never turn a
  // committed operation into a business rejection; view resync recovers gaps.
  try {
  if (win && !win.isDestroyed()) {
    const current = snapshot || state({ view: true });
    if (viewSubscribed) win.webContents.send('view:patch', viewStream.next(current));
    else win.webContents.send('state', current);
  }
  return true;
  } catch { return false; }
}
function publishAgencyPoolProgress() {
  try { if (win && !win.isDestroyed() && agencyPool) win.webContents.send('agency:pool:progress', agencyPool.progressState()); } catch {}
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
function pollPreparation() {
  if (fatal) return;
  poolScheduler?.poll().catch(() => {});
  // Data preparation has its own clock and never invokes the trading runner.
  // A slow or unavailable routine quote request must not delay pre-open work.
  marketRegime?.poll().catch(() => {});
  corporate?.poll().catch(() => {});
  agency?.prepareEntries().catch(() => {});
}
async function refresh() {
  pollPreparation();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const identity = accountOperations.capture();
    const symbols = [...new Set([...strategySymbols(), ...engine.s.orders.filter(o => o.status === 'pending').map(o => o.symbol), ...indices])];
    try {
      const batch = await market.quotes(symbols);
      accountOperations.assertCurrent(identity); Object.assign(quotes, batch);
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
    } catch (e) {
      try { accountOperations.assertCurrent(identity); } catch { return state({ view: true }); }
      connection = { ok: false, message: `行情连接失败：${e.message}`, at: connection.at };
    }
    const holdings = [...new Set(engine.s.lots.map(lot => lot.symbol))], holdingSet = new Set(holdings);
    const symbolsToScan = strategySymbols().filter(symbol => !holdingSet.has(symbol));
    // Separate scan lanes keep holding history/notices ahead of background entry
    // preparation. Rule scheduling never waits for the entire monitor queue.
    monitor.scan(holdings, holdings.filter(needsFundamentals), holdings.filter(needsNotices), 'holdings').catch(() => {});
    monitor.scan(symbolsToScan, symbolsToScan.filter(needsFundamentals), symbolsToScan.filter(needsNotices)).catch(() => {});
    agency?.sampleEntries().catch(() => {});
    agency?.poll().catch(() => {});
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
function operationHandler(name, perform) {
  handler(name, input => accountOperations.run(name, input, context => perform(input, context)));
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
    if (loaded && (!loaded.agency || loaded.agency.version !== 8 || loaded.agency.decisionMode !== 'rules' || !Array.isArray(loaded.agency.corporateActions))) store.backup(loaded);
    engine = new Engine(loaded || initialState());
    enableMarketPolicy(engine.s);
    if (store.warning) for (const group of engine.s.agency.groups) engine.agencyMode({ strategyId: group.id, mode: 'stopped' });
    store.save(engine.s);
  }
  catch (e) { dialog.showErrorBox('观澜 · 账户无法载入', `${e.message}\n数据目录：${app.getPath('userData')}`); app.quit(); return; }
  const dailyHistory = new DailyHistoryCache({ store: new DailyHistoryStore(path.join(app.getPath('userData'), 'daily-history')),
    onChange: ({ symbol, kind }) => {
      if (kind === 'stock') {
        if (monitor) delete monitor.snapshots[symbol];
        agency?.entryContexts.delete(symbol); agency?.entryTracker.clear(symbol);
      }
      schedulePublish();
    } });
  market = new Market((url, opts) => net.fetch(url, opts), { dailyHistory });
  const stockSearch = new StockSearch((url, opts) => net.fetch(url, opts));
  const indexMarket = new IndexMarket((url, opts) => net.fetch(url, opts));
  const entryMarket = new Market((url, opts) => net.fetch(url, opts), { dailyHistory });
  const noticeSource = new CninfoNoticeSource((url, opts) => net.fetch(url, opts));
  research = new Research((url, opts) => net.fetch(url, opts), { noticeSource });
  const screenSource = new FreeScreenerSource((url, opts) => net.fetch(url, opts));
  const loadBreadth = cachedBreadthLoader(screenSource);
  marketRegime = new MarketRegimeService({ indexHistory: (symbol, signal, force) => market.indexHistory(symbol, signal, force),
    getQuotes: async () => { const batch = await market.quotes(indices); Object.assign(quotes, batch); return batch; },
    loadBreadth, prepareUniverse: options => screenSource.prepareUniverse(options), onChange: schedulePublish });
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
    agency = new AgencyService({ getEngine: () => engine, transaction, market, entryMarket, monitor,
      getMarketRegime: () => marketRegime.getSnapshot(),
      getQuotes: () => quotes, acceptQuotes: batch => Object.assign(quotes, batch),
      archiveEntryEvidence: payload => {
        if (entryEvidenceWarning) throw Error(entryEvidenceWarning);
        return entryEvidenceStore.archive(payload);
      },
      onChange: schedulePublish, isAvailable: () => !fatal && connection.ok });
  } catch (e) { agencyError = e.message; }
  // Event-risk announcement polling is disabled for technical automatic trading.
  preparationTimer = setInterval(pollPreparation, 5000);
  win = new BrowserWindow({ width: 1536, height: 980, minWidth: 1120, minHeight: 760, backgroundColor: '#0b1220', title: '观澜 · A股模拟交易', icon: path.join(__dirname, 'assets/icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  handler('state', () => state());
  handler('view:state', () => state({ view: true }));
  handler('view:subscribe', () => { viewSubscribed = true; return viewStream.reset(state({ view: true })); });
  handler('view:refresh', refresh);
  handler('refresh', async () => { await refresh(); return state(); });
  handler('operation:status', input => accountOperations.status(input?.channel, input?.request));
  operationHandler('agency:transfer', async (input, operation) => {
    const symbols = [...new Set(engine.s.lots.filter(lot => lot.owner === input.strategyId).map(lot => lot.symbol))];
    const fresh = symbols.length ? await market.quotes(symbols) : {};
    operation.assertCurrent(); Object.assign(quotes, fresh);
    const result = operation.commit(() => { engine.agencyTransfer(input, quotes); return engine.s.agency.transfers.at(-1); });
    publish(); return result;
  });
  handler('agency:configure', input => { const result = transaction(() => engine.agencyConfigure(input)); publish(); return result; });
  handler('agency:mode', input => { const result = transaction(() => engine.agencyMode(input)); publish(); if (input.mode === 'running') agency?.poll({ force: true, groupIds: [input.strategyId] }).catch(() => {}); return result; });
  handler('agency:member', input => {
    if (input?.action === 'add') throw Error('本版本只由策略筛选生成候选，不支持人工指定股票');
    const symbol = symbolOf(input?.symbol);
    const result = transaction(() => engine.agencyMember({ ...input, symbol })); publish();
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
  handler('agency:pool:status', poolState);
  handler('agency:pool:cancel', () => { poolScheduler?.cancelToday(); agencyPool.cancel(); return true; });
  const updateCandidatePool = async (retryEvidence, input = {}, automatic = false) => {
    if (fatal) throw Error(fatal);
    // Manual screening has no trading-session, daily-count or cooldown gate.
    // Keep progress visible while data requests run; execution retains its own gates.
    const progressTimer = setInterval(publishAgencyPoolProgress, 1000);
    try {
      // Old renderer drafts cannot restore retired automatic research gates.
      const result = await agencyPool.run({ retryEvidence, automatic, screeningMode: 'strategy' });
      agency?.invalidate();
      agency?.prepareEntries().catch(() => {});
      return result;
    } finally { clearInterval(progressTimer); }
  };
  poolScheduler = new AgencyPoolScheduler({ getEngine: () => engine, run: input => updateCandidatePool(false, input, true),
    isBusy: () => !!agencyPool.active || !!screener.activeRun, isAvailable: () => !fatal,
    onChange: schedulePublish });
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
  handler('market:search', input => stockSearch.search(input));
  handler('market:indices', input => indexMarket.overview({ force: input?.force === true }));
  handler('detail', async input => {
    const symbol = symbolOf(input.symbol);
    previewSymbol = symbol;
    monitor.load(symbol, !!input.force, needsFundamentals(symbol), needsNotices(symbol)).catch(() => {});
    // Each read can succeed independently: a daily-data outage must not hide
    // a valid quote or intraday chart, and missing quotes must be visible.
    const [dailyResult, minuteResult, quoteResult] = await Promise.allSettled([
      market.history(symbol, !!input.force), market.intraday(symbol), refreshPreviewQuote(symbol)
    ]);
    const history = dailyResult.status === 'fulfilled' ? dailyResult.value : { bars: [], adjustment: '前复权' };
    const minute = minuteResult.status === 'fulfilled' ? minuteResult.value : null;
    const dailyError = dailyResult.status === 'rejected' ? dailyResult.reason.message : null;
    const minuteError = minuteResult.status === 'rejected' ? minuteResult.reason.message : null;
    const quoteError = quoteResult.status === 'rejected' ? quoteResult.reason.message : null;
    return { symbol, ...history, minute, dailyError, minuteError, quoteError, analysis: analyze(history.bars, quotes[symbol] || engine.s.marks[symbol]) };
  });
  handler('detail:close', () => { previewSymbol = null; publish(); return true; });
  // Retire write endpoints as well as their UI. An older renderer cannot
  // silently create personal watchlists, orders or discretionary positions.
  for (const channel of ['watch:add', 'watch:remove', 'trade', 'order', 'strategy:buy', 'strategy:select',
    'agency:members:add', 'screener:parse', 'screener:run', 'screener:history', 'screener:status', 'screener:cancel', 'screener:open', 'risk'])
    handler(channel, () => { throw Error('本版本仅提供自动模拟交易，此人工操作已移除'); });
  operationHandler('legacy:exit', async (input, operation) => {
    const symbol = symbolOf(input.symbol);
    if (engine.s.agency.groups.some(group => group.members.some(member => member.symbol === symbol))
      || !engine.s.lots.some(lot => lot.symbol === symbol && (!lot.owner || lot.owner === 'manual')))
      throw Error('仅可退出历史手动持仓；策略持仓请使用策略退出安排');
    const fresh = await market.quotes([symbol]);
    operation.assertCurrent(); Object.assign(quotes, fresh);
    const trade = operation.commit(() => engine.legacyExit({ ...input, symbol }, fresh[symbol], quotes));
    publish(); return trade;
  });
  handler('strategy:settings', input => { const next = configureStrategy(input); transaction(() => { engine.s.strategySettings = next; engine.s.agency.revision++; }); publish(); });
  handler('cancel', input => { transaction(() => engine.cancel(input)); publish(); });
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
    const next = new Engine(initialState(input.capital)).s;
    next.createdAt = new Date(Math.max(Date.now(), Date.parse(engine.s.createdAt) + 1)).toISOString();
    enableMarketPolicy(next); store.backup(engine.s); agency?.invalidate(); agencyPool?.cancel(); transaction(() => { engine.s = next; });
    poolScheduler?.invalidate(); previewSymbol = null;
    quotes = {}; entryEvidenceWarning = ''; publish(); return true;
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
app.on('window-all-closed', () => { clearInterval(timer); clearInterval(preparationTimer); poolScheduler?.invalidate(); agency?.stop(); agencyPool?.cancel(); void companyEvidence?.destroy?.(); app.quit(); });
