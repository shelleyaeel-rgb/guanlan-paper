'use strict';
const { randomUUID } = require('node:crypto');
const { AgencyRunner } = require('./agency-runner.cjs');
const { evaluateRuleDecisions, ruleEvidence, RULES_VERSION, RULES_INTERVAL_MS } = require('./agency-rules.cjs');
const { symbolOf, cnTime } = require('./common.cjs');
const { calendarSession } = require('./trading-calendar.cjs');
const { automaticEntryConditions } = require('./entry-conditions.cjs');
const { TECHNICAL_ENTRY_POLICY } = require('./strategy-profiles.cjs');
const { poolQualificationPending, monitoringCheck } = require('./agency-monitoring.cjs');
const { EntryConfirmationTracker, entryBasis } = require('./entry-confirmation.cjs');
const { validateMarketRegimeSnapshot } = require('./market-regime.cjs');
const CHECK_BATCH_SIZE = 20;
const ENTRY_SAMPLE_LIMIT = 80;

// Main-process orchestration. All market data work is outside account transactions;
// the only execution authority is a synchronous, persisted engine transaction.
class AgencyService {
  constructor({ getEngine, transaction, market, entryMarket = market, monitor, getQuotes, acceptQuotes,
    getSelectionEvidence = () => [], getAutomaticEvidence = null, getNoticeEvidence = null, getEvidenceVersion = () => null, noticeGuard = null, archiveEntryEvidence = null, getMarketRegime = () => null, onChange = () => {}, isAvailable = () => true, clock = Date.now, calendar = calendarSession } = {}) {
    Object.assign(this, { getEngine, transaction, market, monitor, getQuotes, acceptQuotes, getSelectionEvidence, getAutomaticEvidence, getNoticeEvidence, getEvidenceVersion, noticeGuard, archiveEntryEvidence, onChange, isAvailable, clock, calendar });
    this.getMarketRegime = getMarketRegime;
    this.entryMarket = entryMarket;
    this.entryTracker = new EntryConfirmationTracker(); this.entryContexts = new Map(); this.entrySampling = null;
    this.storageError = '';
    this.entryPreparations = new Map(); this.preparingEntries = new Map(); this.preparationAttempts = new Map(); this.preparationSequence = 0;
    this.generation = 0; this.commitTail = Promise.resolve(); this.cycles = new Map(); this.pendingBuys = new Set();
    this.runner = new AgencyRunner({ clock, getGroups: () => this.groups(), getCandidates: group => this.candidates(group),
      evaluateRules: input => evaluateRuleDecisions(input, this.clock()), commit: (group, result, snapshot) => this.enqueueCommit(group, result, snapshot),
      onComplete: (group, snapshot, completion) => this.completeBatch(group, snapshot, completion),
      log: (entry, group) => {
        if (!group?.persistedLifecycle?.has(entry.type)) this.log({ strategyId: entry.groupId, status: entry.type, message: entry.message, time: new Date(entry.time).toISOString() });
      } });
  }
  token() { const a = this.getEngine().s.agency; return `${a.epoch}:${a.revision}:${this.generation}`; }
  publicState() {
    const runner = this.runner.status();
    return { decisionMode: 'rules', rulesVersion: RULES_VERSION, entryPolicy: TECHNICAL_ENTRY_POLICY, intervalSeconds: RULES_INTERVAL_MS / 1000,
      marketRegime: this.currentMarketRegime(), entrySampling: { tracked: this.entryContexts.size, limit: ENTRY_SAMPLE_LIMIT },
      runningGroups: runner.runningGroups, lastError: this.storageError || runner.lastError,
      batchSize: CHECK_BATCH_SIZE, coverage: Object.fromEntries([...this.cycles].map(([id, cycle]) => [id, {
        total: cycle.symbols.length, processed: cycle.cursor, remaining: cycle.symbols.length - cycle.cursor,
        cycle: cycle.number, startedAt: cycle.startedAt, completedAt: cycle.completedAt,
        status: runner.runningGroups.includes(id) ? 'checking' : cycle.cursor < cycle.symbols.length ? 'queued' : 'complete',
        lastBatchSize: cycle.lastBatchSize || 0
      }])),
      session: this.calendar(new Date(this.clock())), online: this.available() };
  }
  available() { return !this.storageError && this.isAvailable(); }
  pendingBuySymbols() { return [...this.pendingBuys]; }
  currentMarketRegime() {
    const snapshot = this.getMarketRegime();
    const checked = validateMarketRegimeSnapshot(snapshot, this.clock());
    // Validation may rebuild an expired/unknown permission. Keep acquisition
    // progress available to the UI without changing that validated permission.
    return { ...checked, ...(snapshot?.acquisition ? { acquisition: structuredClone(snapshot.acquisition) } : {}),
      ...(snapshot?.preparation ? { preparation: structuredClone(snapshot.preparation) } : {}) };
  }
  withEntryEvidence(symbol, strategyId, quote, snapshot = {}) {
    if (!this.getEngine().s.agency.marketPolicy?.enabled) return snapshot;
    const marketRegime = this.currentMarketRegime();
    return { ...snapshot, marketRegime, entryConfirmation: this.entryTracker.observe(symbol, strategyId, quote, snapshot.technical, marketRegime, this.clock()) };
  }
  trackEntry(symbol, strategyId, quote, snapshot) {
    if (!this.getEngine().s.agency.marketPolicy?.enabled || this.getEngine().s.lots.some(lot => lot.symbol === symbol)) return;
    const basis = entryBasis(snapshot?.technical, strategyId);
    if (!basis || !(quote?.price > 0)) return;
    const distance = Math.min(Math.abs(quote.price - basis.anchor), Math.abs(quote.price - basis.resistance)) / basis.atr;
    if (distance > 2) { this.entryContexts.delete(symbol); this.entryTracker.clear(symbol); return; }
    this.entryContexts.set(symbol, { symbol, strategyId, snapshot: {
      technical: structuredClone(snapshot.technical), source: snapshot.source, fetchedAt: snapshot.fetchedAt,
      ...(snapshot.provider ? { provider: snapshot.provider } : {}),
      ...(Object.hasOwn(snapshot, 'dailyEvidence') ? { dailyEvidence: structuredClone(snapshot.dailyEvidence) } : {}),
      ...(snapshot.historyStatus ? { historyStatus: snapshot.historyStatus } : {}),
      ...(snapshot.refreshError ? { refreshError: snapshot.refreshError } : {}),
      ...(snapshot.cacheWarning ? { cacheWarning: snapshot.cacheWarning } : {})
    }, distance, updatedAt: this.clock() });
    if (this.entryContexts.size > ENTRY_SAMPLE_LIMIT) {
      const ordered = [...this.entryContexts.values()].sort((a, b) => a.distance - b.distance || b.updatedAt - a.updatedAt);
      for (const item of ordered.slice(ENTRY_SAMPLE_LIMIT)) { this.entryContexts.delete(item.symbol); this.entryTracker.clear(item.symbol); }
    }
  }
  // Separate quote lane: slow candidate sampling never delays a holding exit.
  sampleEntries() {
    if (this.entrySampling) return this.entrySampling;
    const at = this.calendar(new Date(this.clock()));
    if (!this.available() || !at.open || at.known === false || !this.getEngine().s.agency.marketPolicy?.enabled) return Promise.resolve();
    const token = this.generation, state = this.getEngine().s, epoch = state.agency.epoch;
    for (const [symbol, context] of this.entryContexts) {
      const group = state.agency.groups.find(g => g.id === context.strategyId);
      if (state.lots.some(lot => lot.symbol === symbol) || group?.mode !== 'running' || !group.members.some(m => m.symbol === symbol && m.mode === 'active') || this.clock() - context.updatedAt > 900000) {
        this.entryContexts.delete(symbol); this.entryTracker.clear(symbol);
      }
    }
    const contexts = [...this.entryContexts.values()];
    if (!contexts.length) return Promise.resolve();
    this.entrySampling = (async () => {
      try {
        const fresh = await this.entryMarket.quotes(contexts.map(context => context.symbol));
        if (this.generation !== token || this.getEngine().s.agency.epoch !== epoch) return;
        const accepted = {};
        const current = this.getEngine().s, latest = this.getQuotes();
        for (const context of contexts) {
          if (this.entryContexts.get(context.symbol) !== context) continue;
          const group = current.agency.groups.find(item => item.id === context.strategyId), quote = fresh[context.symbol];
          if (current.lots.some(lot => lot.symbol === context.symbol) || group?.mode !== 'running' || !group.members.some(member => member.symbol === context.symbol && member.mode === 'active')) continue;
          if (!quote || quote.timestamp < (latest[context.symbol]?.timestamp || 0)) continue;
          accepted[context.symbol] = quote;
          this.withEntryEvidence(context.symbol, context.strategyId, quote, context.snapshot);
        }
        this.acceptQuotes(accepted);
      } catch { /* Stale/missing observations cannot advance or extend confirmation. */ }
    })().finally(() => { this.entrySampling = null; });
    return this.entrySampling;
  }
  quoteSymbols(symbols) { return [...new Set([...symbols, ...this.getEngine().s.lots.map(lot => lot.symbol)])]; }
  entryConditions(symbol) { return automaticEntryConditions(this.getEngine().s.agency.groups.flatMap(group => group.members).find(member => member.symbol === symbol)?.entryConditions, new Date(this.clock())); }
  needsFundamentals() { return false; }
  entryDataRequirements() { return false; }
  needsPreparedEvidence() { return false; }
  syncPreparation() {
    const epoch = this.getEngine().s.agency.epoch;
    if (this.preparationEpoch !== epoch) {
      this.preparationEpoch = epoch; this.entryPreparations.clear(); this.preparingEntries.clear(); this.preparationAttempts.clear();
    }
    return epoch;
  }
  // Automatic preparation acquires only market history and, where the account
  // has held the stock, corporate-action evidence. Research is not an input.
  prepareEntry(symbol) {
    const epoch = this.syncPreparation();
    if (this.preparingEntries.has(symbol)) return this.preparingEntries.get(symbol);
    const generation = this.generation;
    this.preparationAttempts.set(symbol, this.clock());
    const task = (async () => {
      await this.monitor.prepare(symbol, false, false);
      if (this.getEngine().s.agency.epoch === epoch && this.generation === generation) this.onChange();
    })().finally(() => { if (this.preparingEntries.get(symbol) === task) this.preparingEntries.delete(symbol); });
    this.preparingEntries.set(symbol, task); return task;
  }
  prepareEntries() {
    const epoch = this.syncPreparation(), generation = this.generation;
    if (this.storageError || this.runner.stopped) return Promise.resolve();
    const state = this.getEngine().s, held = new Set(state.lots.map(lot => lot.symbol));
    const members = state.agency.groups.filter(group => group.mode !== 'stopped').flatMap(group => group.members
      .filter(member => member.mode === 'active' && !held.has(member.symbol) && !poolQualificationPending(state.agency, member))
      .map(member => ({ symbol: member.symbol, strategyId: group.id })));
    const keep = new Set(members.map(member => member.symbol));
    for (const key of this.entryPreparations.keys()) if (!keep.has(key)) this.entryPreparations.delete(key);
    for (const key of this.preparationAttempts.keys()) if (!keep.has(key)) this.preparationAttempts.delete(key);
    const due = members.filter(member => !this.preparingEntries.has(member.symbol)
      && this.clock() - (this.preparationAttempts.get(member.symbol) ?? -Infinity) >= 60000)
      .sort((a, b) => (this.preparationAttempts.get(a.symbol) ?? -Infinity) - (this.preparationAttempts.get(b.symbol) ?? -Infinity));
    // Refill a freed slot immediately. A slow data request occupies only its own slot;
    // the timer remains the retry clock for already attempted members.
    for (const member of due.slice(0, Math.max(0, 2 - this.preparingEntries.size))) {
      let wasReady = false;
      try { this.readEntrySnapshot(member.symbol, member.strategyId); wasReady = true; } catch {}
      const finished = () => {
        if (this.getEngine().s.agency.epoch !== epoch || this.generation !== generation || this.runner.stopped) return;
        if (!wasReady) {
          try {
            this.readEntrySnapshot(member.symbol, member.strategyId);
            // Wake the next ordinary rules tick; preparation never places an
            // order or declares that market/entry/risk checks have passed.
            this.runner.lastStarted.delete(member.strategyId);
            this.runner.lastCompleted.delete(member.strategyId);
          } catch {}
        }
        this.prepareEntries().catch(() => {});
      };
      this.prepareEntry(member.symbol, member.strategyId).then(finished, finished);
    }
    return Promise.allSettled([...this.preparingEntries.values()]);
  }
  readEntrySnapshot(symbol) {
    const snapshot = this.monitor.readPrepared(symbol, false, false);
    // A user may separately open research on the same stock. Its cached result
    // must not become an automatic-trading requirement or an audited pass.
    for (const key of ['finance', 'valuation', 'notices', 'financeReportSync', 'automaticEvidence',
      'automaticEvidenceEvaluation', 'automaticEvidenceScope', 'automaticEvidenceLoad', 'selectionEvidence']) delete snapshot[key];
    snapshot.entryPolicy = { ...TECHNICAL_ENTRY_POLICY };
    return snapshot;
  }
  assertEntrySnapshot(symbol, strategyId, snapshot) {
    this.monitor.assertPrepared(symbol, snapshot, false, false);
  }
  // Kept for existing callers; automatic research acquisition is disabled.
  withSelectionEvidence(symbol, snapshot) { return snapshot; }
  async withAutomaticEvidence(symbol, snapshot) { return snapshot; }
  async withNoticeEvidence(symbol, snapshot) { return snapshot; }
  persist(fn) {
    let completed = false;
    try { return this.transaction(() => { const value = fn(); completed = true; return value; }); }
    catch (error) {
      if (completed) { this.storageError = '账户保存失败，自动交易已暂停，请重启并核对账户'; this.invalidate(); }
      throw error;
    }
  }
  lifecycleEntry(group, status, count) {
    return ruleRecord({ strategyId: group.id, status, time: new Date(this.clock()).toISOString(), message: status === 'request'
      ? `正在检查 ${count} 只股票的固定策略条件` : status === 'idle' ? '本批无可提交的股票；缺失资料及规则拦截请查看记录'
        : '规则检查完成，满足全部条件的意向已交由风控复核' });
  }
  persistCompletion(group, completed, fn) {
    const result = this.persist(() => { const value = fn(); if (completed) this.getEngine().agencyLog(this.lifecycleEntry(group, 'complete')); return value; });
    if (completed) { group.persistedLifecycle ||= new Set(); group.persistedLifecycle.add('complete'); }
    return result;
  }
  invalidate() { this.generation++; this.entryContexts.clear(); this.entryTracker.clear(); this.runner.invalidate(); }
  stop() { this.generation++; this.entryContexts.clear(); this.entryTracker.clear(); this.runner.stop(); }
  async poll(options = {}) {
    const result = await this.runner.poll(options); this.onChange(); return result;
  }
  groups() {
    const at = this.calendar(new Date(this.clock()));
    const enabled = this.available() && at.open && at.known !== false;
    const engine = this.getEngine(), holdings = new Map();
    for (const lot of engine.s.lots) {
      if (!holdings.has(lot.owner)) holdings.set(lot.owner, new Set());
      holdings.get(lot.owner).add(lot.symbol);
    }
    return engine.s.agency.groups.map(g => {
      // Scheduling depends only on permissions and holding ownership. It must
      // not copy audit evidence or calculate full portfolio display statistics.
      const positions = [...(holdings.get(g.id) || [])].map(symbol => ({ symbol }));
      const cycle = this.cycleFor({ ...g, positions });
      return { id: g.id, token: this.token(), continueCycle: cycle.cursor < cycle.symbols.length,
        enabled: enabled && g.mode !== 'stopped' && (g.mode === 'running' || positions.length > 0) && cycle.symbols.length > 0 };
    });
  }
  cycleFor(view) {
    const positions = new Set(view.positions.map(p => p.symbol));
    const symbols = view.members.filter(m => (view.mode === 'running' && m.mode === 'active') || positions.has(m.symbol)).map(m => m.symbol);
    const signature = `${this.getEngine().s.agency.epoch}:${view.mode}:${symbols.join(',')}`;
    let cycle = this.cycles.get(view.id);
    if (!cycle || cycle.signature !== signature) {
      cycle = { signature, symbols, cursor: 0, number: (cycle?.number || 0) + 1, startedAt: null, completedAt: null };
      this.cycles.set(view.id, cycle);
    }
    return cycle;
  }
  completeBatch(group, snapshot, completion) {
    const cycle = this.cycles.get(group.id), batch = snapshot.batch;
    if (!batch || !completion?.completed || this.token() !== completion.token || cycle !== batch.cycle || cycle.cursor !== batch.start) return;
    cycle.cursor += batch.size; cycle.lastBatchSize = batch.size;
    if (cycle.cursor >= cycle.symbols.length) cycle.completedAt = this.clock();
    this.onChange();
  }
  log(entry, evaluation, completionGroup = null) {
    if (!this.available()) return;
    this.persistCompletion(completionGroup, !!completionGroup, () => {
      const engine = this.getEngine();
      if (evaluation) this.recordMonitoring(entry.symbol, evaluation, engine.positions().find(position => position.symbol === entry.symbol));
      engine.agencyLog(ruleRecord(entry));
    }); this.onChange();
  }
  recordMonitoring(symbol, evaluation, position) {
    const group = this.getEngine().s.agency.groups.find(item => item.members.some(member => member.symbol === symbol));
    const member = group?.members.find(item => item.symbol === symbol);
    if (member) member.monitoringCheck = monitoringCheck(evaluation,
      { holding: !!position, paused: group.mode !== 'running' || member.mode !== 'active' }, this.clock());
  }
  async candidates(group) {
    if (this.token() !== group.token) return null;
    let view = this.getEngine().agencyGroupState(group.id, this.getQuotes());
    if (!view) return null;
    const cycle = this.cycleFor(view);
    if (cycle.cursor >= cycle.symbols.length) { cycle.cursor = 0; cycle.number++; cycle.startedAt = null; cycle.completedAt = null; }
    if (cycle.startedAt === null) cycle.startedAt = this.clock();
    const start = cycle.cursor, selected = cycle.symbols.slice(start, start + CHECK_BATCH_SIZE).map(symbol => ({ symbol }));
    const snapshots = new Map(), preparationErrors = new Map();
    const positions = new Set(view.positions.map(position => position.symbol));
    const pendingQualifications = new Set(view.members.filter(member => poolQualificationPending(this.getEngine().s.agency, member)).map(member => member.symbol));
    for (const member of selected) {
      if (positions.has(member.symbol) || pendingQualifications.has(member.symbol)) {
        snapshots.set(member.symbol, this.monitor.snapshots?.[member.symbol] || {}); continue;
      }
      try { snapshots.set(member.symbol, this.readEntrySnapshot(member.symbol, group.id)); }
      catch (error) { preparationErrors.set(member.symbol, error.message || '开仓资料尚未准备，本次跳过'); }
    }
    if (this.token() !== group.token) return null;
    // Missing quotes become explicit blocked checks, so an unavailable first batch
    // cannot starve every later member in a large cycle.
    const readySymbols = selected.filter(member => !preparationErrors.has(member.symbol) && !pendingQualifications.has(member.symbol)).map(member => member.symbol);
    const fresh = readySymbols.length ? await this.market.quotes(this.quoteSymbols(readySymbols)).catch(() => ({})) : {};
    this.acceptQuotes(fresh);
    if (this.token() !== group.token) return null;
    for (const member of selected) this.trackEntry(member.symbol, group.id, fresh[member.symbol], snapshots.get(member.symbol));
    const candidates = [];
    this.persist(() => {
      const engine = this.getEngine();
      for (const member of selected) {
        const q = fresh[member.symbol], snapshot = this.withEntryEvidence(member.symbol, group.id, q, this.withSelectionEvidence(member.symbol, snapshots.get(member.symbol)));
        view = engine.agencyGroupState(group.id, fresh);
        const position = view.positions.find(p => p.symbol === member.symbol);
        const blocked = message => {
          this.recordMonitoring(member.symbol, { buyable: false, reasons: [message] }, position);
          const candidate = candidateData(member.symbol, q, snapshot, { buyable: false, status: '规则检查拦截', reasons: [message] }, position, view);
          engine.agencyLog(ruleRecord({ strategyId: group.id, symbol: member.symbol, action: position ? 'hold' : 'wait', status: 'blocked',
            message, reason: message, evidence: ruleEvidence(candidate), inputSources: candidate.sources }));
        };
        if (!position && pendingQualifications.has(member.symbol)) {
          const evaluation = engine.agencyEvaluate(group.id, member.symbol, q, snapshot, undefined, fresh);
          this.recordMonitoring(member.symbol, evaluation, position);
          candidates.push(candidateData(member.symbol, q, snapshot, evaluation, position, view)); continue;
        }
        if (!position && preparationErrors.has(member.symbol)) { blocked(preparationErrors.get(member.symbol)); continue; }
        if (!position) {
          try { this.assertEntrySnapshot(member.symbol, group.id, snapshot); }
          catch (error) { blocked(error.message); continue; }
        }
        const block = engine.agencyAutomaticBlock(member.symbol, q, snapshot);
        if (block) { blocked(block); continue; }
        try { engine.fresh(q); } catch (e) { blocked(e.message); continue; }
        const evaluation = engine.agencyEvaluate(group.id, member.symbol, q, snapshot, undefined, fresh);
        this.recordMonitoring(member.symbol, evaluation, position);
        const candidate = candidateData(member.symbol, q, snapshot, evaluation, position, view);
        candidates.push(candidate);
      }
      engine.agencyLog(this.lifecycleEntry(group, candidates.length ? 'request' : 'idle', candidates.length));
    });
    group.persistedLifecycle ||= new Set(); group.persistedLifecycle.add(candidates.length ? 'request' : 'idle');
    this.onChange();
    return { token: group.token, candidates, batch: { cycle, start, size: selected.length }, context: { asOf: new Date(this.clock()).toISOString(), currency: 'CNY', moneyUnit: '分',
      strategyId: group.id, mode: view.mode, cash: view.cash, equity: view.equity, limits: view.limits,
      execution: '真实行情的本地模拟交易；目标比例按本策略权益；固定止损、T+1和策略规则优先；不得加仓' } };
  }
  enqueueCommit(group, result, snapshot) {
    const buying = (result.decisions || []).filter(decision => decision.action === 'buy').map(decision => decision.symbol);
    for (const symbol of buying) this.pendingBuys.add(symbol);
    const task = this.commitTail.then(() => this.commit(group, result, snapshot)).finally(() => { for (const symbol of buying) this.pendingBuys.delete(symbol); });
    this.commitTail = task.catch(() => {}); return task;
  }
  async commit(group, result, snapshot) {
    if (result.decisionSource !== 'rules' || result.rulesVersion !== RULES_VERSION || !Array.isArray(result.decisions)
      || result.decisions.some(decision => !['buy', 'hold', 'wait'].includes(decision.action))) throw Error('仅接受当前固定策略产生的检查结果');
    let expectedToken = group.token;
    const decisions = [...result.decisions].sort((a, b) => rank(a.action) - rank(b.action) || a.symbol.localeCompare(b.symbol));
    let completed = true; const waiting = [];
    for (const [decisionIndex, decision] of decisions.entries()) {
      const lastDecision = decisionIndex === decisions.length - 1;
      const decisionId = randomUUID(), candidate = snapshot.candidates.find(c => c.symbol === decision.symbol);
      const entry = ruleRecord({ id: decisionId, strategyId: group.id, symbol: decision.symbol, action: decision.action,
        targetPercent: decision.targetPercent, reason: decision.reason, evidence: decision.evidence,
        entryConditionsCheck: candidate?.entryConditionsCheck,
        financeCheck: candidate?.financeCheck, valuationCheck: candidate?.valuationCheck, performanceReview: candidate?.performanceReview,
        inputSources: candidate?.sources, evaluatedAt: result.evaluatedAt, requestedAt: result.requestedAt, expiresAt: result.expiresAt });
      const current = () => {
        const at = this.calendar(new Date(this.clock()));
        return this.available() && this.token() === expectedToken && this.clock() < result.expiresAt
          && this.clock() < result.requestedAt + decision.validForSeconds * 1000 && at.open && at.known !== false;
      };
      if (!current()) { completed = false; this.log({ ...entry, status: 'stale', message: '权限、账户或有效期已变化，本次未执行' }); break; }
      if (['wait', 'hold'].includes(decision.action)) { waiting.push({ ...entry, status: 'waiting', message: decision.action === 'hold' ? '已有持仓，不加仓；固定退出规则和原风控计划持续生效' : '入场规则未全部满足，继续等待' }); continue; }
      this.pendingBuys.add(decision.symbol);
      try {
        // All slow evidence work belongs to preparation. Only the current
        // executable quotes are acquired here, then all checks run locally.
        let technical = this.readEntrySnapshot(decision.symbol, group.id);
        this.assertEntrySnapshot(decision.symbol, group.id, technical);
        const fresh = await this.market.quotes(this.quoteSymbols([decision.symbol])); this.acceptQuotes(fresh);
        if (!current()) { completed = false; this.log({ ...entry, status: 'stale', message: '刷新行情期间授权或账户已变化' }); break; }
        this.assertEntrySnapshot(decision.symbol, group.id, technical);
        const q = fresh[decision.symbol];
        this.persistCompletion(group, lastDecision, () => {
          const engine = this.getEngine();
          if (!current()) throw Error('旧决策已失效');
          this.assertEntrySnapshot(decision.symbol, group.id, technical);
          technical = this.withEntryEvidence(decision.symbol, group.id, q, this.withSelectionEvidence(decision.symbol, technical));
          // Persist a detected corporate-action block instead of rolling it back as an error.
          const block = engine.agencyAutomaticBlock(decision.symbol, q, technical);
          if (block) { this.recordMonitoring(decision.symbol, { buyable: false, reasons: [block] }, engine.positions().find(item => item.symbol === decision.symbol)); engine.agencyLog({ ...entry, status: 'blocked', message: block }); return; }
          const evaluation = engine.agencyEvaluate(group.id, decision.symbol, q, technical, undefined, fresh);
          const view = engine.agencyGroupState(group.id, fresh);
          this.recordMonitoring(decision.symbol, evaluation, view.positions.find(position => position.symbol === decision.symbol));
          const currentCandidate = candidateData(decision.symbol, q, technical, evaluation, view.positions.find(position => position.symbol === decision.symbol), view);
          entry.executionCheck = { checkedAt: this.clock(), buyable: evaluation.buyable === true, status: evaluation.status,
            marketRegime: technical.marketRegime, entryConfirmation: technical.entryConfirmation,
            entryConditionsCheck: evaluation.entryConditionsCheck,
            financeCheck: evaluation.financeCheck, valuationCheck: evaluation.valuationCheck, performanceReview: evaluation.entryConditionsCheck?.performanceReview,
            reasons: evaluation.reasons, plan: evaluation.plan || null, maxQuantity: evaluation.maxQuantity || 0,
            quote: { price: q?.price, ask: q?.ask, askSize: q?.askSize, timestamp: q?.timestamp, source: q?.source },
            valuation: { checkedAt: this.clock(), moneyUnit: '分', accountEquity: engine.stats(fresh).equity,
              strategyEquity: view.equity, holdingQuotes: holdingValuationEvidence(engine, fresh), validatedEvidence: evaluation.valuationEvidence || null },
            evidence: ruleEvidence(currentCandidate), inputSources: currentCandidate.sources };
          if (!evaluation.buyable) { engine.agencyLog({ ...entry, status: 'blocked', message: evaluation.reasons.join('；') }); return; }
          const a = engine.s.agency;
          const trade = engine.agencyExecute({ strategyId: group.id, symbol: symbolOf(decision.symbol), action: decision.action,
            targetPercent: decision.targetPercent, decisionId, expectedEpoch: a.epoch, expectedRevision: a.revision,
            archiveEntryEvidence: this.archiveEntryEvidence, entryEvidenceContext: entry }, q, technical, fresh);
          if (trade?.id) this.recordMonitoring(decision.symbol, { reasons: ['已模拟成交，继续跟踪原退出计划'] }, { quantity: trade.quantity });
          engine.agencyLog({ ...entry, status: trade?.id ? 'executed' : 'waiting', tradeId: trade?.id || null,
            ...(trade?.entryEvidenceRef ? { entryEvidenceRef: trade.entryEvidenceRef } : {}),
            execution: trade?.id ? { price: trade.price, quantity: trade.quantity, gross: trade.gross, fees: trade.fees, time: trade.time, plan: trade.strategyPlan } : null,
            message: trade?.id ? `已模拟${trade.side === 'buy' ? '买入' : '卖出'} ${trade.quantity} 股` : (trade?.reason || '退出意向已保存，等待可成交条件') });
        });
        expectedToken = this.token(); this.onChange();
      } catch (error) {
        const message = error.message || '执行校验失败，本次未成交';
        this.log({ ...entry, status: 'blocked', message }, this.token() === expectedToken ? { buyable: false, reasons: [message] } : undefined,
          lastDecision && this.token() === expectedToken ? group : null);
        // Another account mutation is not permission to continue the remaining rule decisions.
        if (this.token() !== expectedToken) { completed = false; break; }
      } finally { this.pendingBuys.delete(decision.symbol); }
    }
    // All passive decisions have been checked individually above. Persist their
    // audit records together; fills keep their own atomic account transaction.
    if (waiting.length) { this.persistCompletion(group, completed, () => { for (const entry of waiting) this.getEngine().agencyLog(entry); }); this.onChange(); }
    return { token: expectedToken, completed };
  }
}
function rank(action) { return action === 'buy' ? 0 : 1; }
function ruleRecord(entry) { return { ...entry, decisionSource: 'rules', rulesVersion: RULES_VERSION }; }
function holdingValuationEvidence(engine, fresh) {
  const holdings = new Map();
  for (const lot of engine.s.lots) {
    const entry = holdings.get(lot.symbol) || { symbol: lot.symbol, owner: lot.owner || 'manual', quantity: 0 };
    entry.quantity += lot.quantity; holdings.set(lot.symbol, entry);
  }
  return [...holdings.values()].map(holding => {
    const quote = fresh[holding.symbol] || engine.s.marks[holding.symbol];
    return { ...holding, price: quote?.price ?? null, date: quote?.date ?? null, timestamp: quote?.timestamp ?? null,
      source: quote?.source ?? null, origin: fresh[holding.symbol] ? 'refreshed' : quote ? 'saved-mark' : 'missing' };
  });
}
function candidateData(symbol, q, snapshot, evaluation, position, group) {
  const sources = [];
  for (const kind of ['marketRegime', 'entryConfirmation']) if (snapshot?.[kind]) sources.push({ id: `${kind}:${symbol}:${snapshot[kind].checkedAt}`, kind,
    source: kind === 'marketRegime' ? '指数趋势与全市场广度' : '实际观察的盘中报价序列', fetchedAt: snapshot[kind].checkedAt, data: snapshot[kind] });
  if (q) sources.push({ id: `quote:${symbol}:${q.timestamp}`, kind: 'quote', source: q.source, timestamp: q.timestamp,
    data: Object.fromEntries(['price', 'prevClose', 'open', 'high', 'low', 'volume', 'amount', 'turnover', 'bid', 'ask', 'bidSize', 'askSize', 'limitUp', 'limitDown', 'screeningMetrics'].map(k => [k, q[k]])) });
  if (snapshot?.technical) sources.push({ id: `daily:${symbol}:${snapshot.technical.asOf}`, kind: 'completed-unadjusted-daily', source: snapshot.source,
    fetchedAt: snapshot.fetchedAt, data: snapshot.technical,
    ...(Object.hasOwn(snapshot, 'dailyEvidence') ? { dailyEvidence: structuredClone(snapshot.dailyEvidence) } : {}),
    ...(snapshot.historyStatus ? { status: snapshot.historyStatus } : {}),
    ...(snapshot.refreshError ? { refreshError: snapshot.refreshError } : {}),
    ...(snapshot.cacheWarning ? { cacheWarning: snapshot.cacheWarning } : {}) });
  for (const section of ['finance', 'valuation', 'notices', 'corporateActions']) {
    const response = snapshot?.[section];
    if (response) sources.push({ id: `${section}:${symbol}:${response.fetchedAt || 'unknown'}`, kind: section,
      source: response.source, status: response.status, fetchedAt: response.fetchedAt,
      data: section === 'finance' ? { latest: response.data?.latest, annual: response.data?.annual } : section === 'corporateActions'
        ? { coverageStart: response.coverageStart, coverageEnd: response.coverageEnd, coverageComplete: response.coverageComplete,
          events: response.events?.map(({ eventId, status, recordDate, exDate, payDate, listingDate, cashPerShare, bonusPerShare, transferPerShare, noticeIds, sourceUrl, reason }) =>
            ({ eventId, status, recordDate, exDate, payDate, listingDate, cashPerShare, bonusPerShare, transferPerShare, noticeIds, sourceUrl, reason })) }
        : response.data,
      limitation: section === 'notices' ? '这是有限范围的公告标题资料，不是公告原文，不能据此认定所有事件已核验' : undefined });
  }
  if (snapshot?.selectionEvidence) sources.push({ id: `selectionEvidence:${symbol}:${snapshot.selectionEvidence.checkedAt}`,
    kind: 'selectionEvidence', source: '本地研究证据', status: snapshot.selectionEvidence.error ? 'error' : 'ready',
    fetchedAt: snapshot.selectionEvidence.checkedAt, data: { records: structuredClone(snapshot.selectionEvidence.records || []), error: snapshot.selectionEvidence.error } });
  if (snapshot?.automaticEvidence) sources.push({ id: `automaticEvidence:${symbol}:${snapshot.automaticEvidence.checkedAt || snapshot.automaticEvidence.fetchedAt}`,
    kind: 'automaticEvidence', source: snapshot.automaticEvidenceScope === 'notices' ? '敏感公告原文核验' : '公开披露资料程序核验',
    status: snapshot.automaticEvidenceEvaluation?.status || evaluation.entryRisk?.notices?.status || 'pending',
    fetchedAt: snapshot.automaticEvidence.checkedAt || snapshot.automaticEvidence.fetchedAt,
    data: { scope: snapshot.automaticEvidenceScope || 'research', evaluation: snapshot.automaticEvidenceEvaluation || evaluation.entryRisk?.notices || null,
      errors: snapshot.automaticEvidence.errors || [] } });
  if (evaluation.entryConditionsCheck?.researchReview) sources.push({ id: `operatingResearch:${symbol}:${evaluation.entryConditionsCheck.researchReview.checkedAt}`,
    kind: 'operatingResearch', source: '产品与公司经营指标', status: evaluation.entryConditionsCheck.researchReview.status,
    fetchedAt: evaluation.entryConditionsCheck.researchReview.checkedAt, data: evaluation.entryConditionsCheck.researchReview });
  for (const [kind, review] of [['financeCheck', evaluation.financeCheck], ['valuationCheck', evaluation.valuationCheck], ['performanceReview', evaluation.entryConditionsCheck?.performanceReview]]) {
    if (review) sources.push({ id: `${kind}:${symbol}:${review.checkedAt}`, kind,
      source: kind === 'performanceReview' ? '业绩预告/快报可选条件' : kind === 'financeCheck' ? '长线财务条件' : '长线估值条件',
      status: review.status, fetchedAt: review.checkedAt, data: review });
  }
  if (snapshot?.financeReportSync) sources.push({ id: `financeReportSync:${symbol}:${snapshot.financeReportSync.checkedAt}`, kind: 'financeReportSync',
    source: '正式财报公告与财务接口同步核验', status: snapshot.financeReportSync.status, fetchedAt: snapshot.financeReportSync.checkedAt, data: snapshot.financeReportSync });
  return { symbol, name: q?.name, entryAllowed: evaluation.buyable === true, entryConditionsCheck: evaluation.entryConditionsCheck,
    financeCheck: evaluation.financeCheck, valuationCheck: evaluation.valuationCheck, performanceReview: evaluation.entryConditionsCheck?.performanceReview,
    currentPercent: group.equity > 0 ? Math.min(100, (position?.value || 0) / group.equity * 100) : 0,
    position: position ? { quantity: position.quantity, available: position.available, cost: position.cost,
      value: position.value, stop: position.risk?.stop, target: position.risk?.target, pendingExit: position.risk?.pendingExit } : null,
    rules: { status: evaluation.status, reasons: evaluation.reasons, maxQuantity: evaluation.maxQuantity,
      plan: evaluation.plan, economics: evaluation.economics }, sources };
}
module.exports = { AgencyService, candidateData };
