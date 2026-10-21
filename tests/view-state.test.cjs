'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { decisionView, accountView } = require('../core/view-state.cjs');
const mainPath = path.join(__dirname, '../main.cjs'), mainSource = fs.readFileSync(mainPath, 'utf8');
const NOW = new Date('2026-10-16T10:00:00+08:00');

function decision() {
  const evaluation = { status: 'passed', checkedAt: +NOW,
    noticeReview: { status: 'clear', notices: [{ id: 'notice-1', title: '业绩说明', status: 'clear', records: [{ quote: '公告原文摘录' }] }] },
    checks: [{ key: 'productOutlook', status: 'passed', reason: '公开披露资料满足条件', records: [{ quote: '产品需求事实' }] },
      { key: 'sameProduct', status: 'passed', productCandidates: [{ subject: '产品甲', parts: [{ key: 'demand', records: [{ quote: '同产品依据' }] }] }] }] };
  const inputSources = [
    { id: 'daily-1', kind: 'completed-unadjusted-daily', source: '日线来源', timestamp: +NOW,
      data: { asOf: '2026-10-15', bars: [{ date: '2026-10-15', close: 10 }], dates: ['2026-10-15'], ma20: 10 } },
    { id: 'finance-1', kind: 'finance', source: '财报来源', fetchedAt: +NOW,
      data: { latest: { reportDate: '2026-06-30', roe: 12, netProfit: 123456 }, annual: [{ reportDate: '2025-12-31' }] } },
    { id: 'automatic-1', kind: 'automaticEvidence', source: '公司公告资料', fetchedAt: +NOW,
      data: { evaluation, raw: '仅审计读取的原始内容'.repeat(200) } },
    { id: 'quote-1', kind: 'quote', source: '行情来源', timestamp: +NOW, data: { price: 10, ask: 10.01, bid: 9.99 } }
  ];
  const financeCheck = { status: 'pass', period: '2026-06-30', checks: [{ field: 'roe', actual: 12, expected: 10, status: 'pass' }],
    evidence: { finance: { source: '财报来源', data: { latest: { reportDate: '2026-06-30', roe: 12 } } } } };
  const entryConditionsCheck = { status: 'pass', checkedAt: +NOW, checks: [{ label: 'ROE', actual: 12, expected: 10 }], reasons: [] };
  return { id: 'decision-1', strategyId: 'swing', symbol: 'sh600000', decisionMode: 'rules', rulesVersion: '1', action: 'buy',
    status: 'executed', reason: '规则满足', createdAt: NOW.toISOString(), financeCheck,
    valuationCheck: { status: 'pass', pe: 12 }, entryConditionsCheck,
    evidence: inputSources.map(source => ({ sourceId: source.id, detail: `引用 ${source.id}` })), inputSources,
    execution: { quantity: 100, price: 10.01, fees: { total: 500 }, time: NOW.toISOString() },
    executionCheck: { checkedAt: +NOW, financeCheck: structuredClone(financeCheck), entryConditionsCheck: structuredClone(entryConditionsCheck),
      evidence: inputSources.map(source => ({ sourceId: source.id, detail: `执行前引用 ${source.id}` })), inputSources: structuredClone(inputSources) } };
}

function host() {
  const engine = new Engine(initialState(), () => NOW); engine.s.watchlist = [];
  engine.agencyMember({ strategyId: 'swing', symbol: 'sh600000', action: 'add' });
  engine.s.agency.decisions.push(decision());
  const sent = [], timers = new Map(), handlers = {}, calls = { stateBuilds: 0, saves: 0, scans: 0 };
  const originalAgencyState = engine.agencyState.bind(engine);
  engine.agencyState = (...args) => { calls.stateBuilds++; return originalAgencyState(...args); };
  const webContents = { mainFrame: {}, send: (channel, payload) => sent.push({ channel, payload }) };
  const testing = { engine, win: { isDestroyed: () => false, webContents },
    market: { quotes: async () => ({}) }, monitor: { snapshots: {}, scan: async () => { calls.scans++; } },
    store: { warning: '', save: () => { calls.saves++; } }, agencyPool: { publicState: () => ({ running: false, lastResult: { id: 'pool-result' } }) } };
  let nextTimer = 0;
  const localRequire = createRequire(mainPath);
  const context = vm.createContext({ testing, structuredClone, process: { argv: [] },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: () => 0, clearInterval: () => {},
    require: name => name === 'electron' ? {
      app: { requestSingleInstanceLock: () => true, on: () => {}, whenReady: () => ({ then: () => {} }), getPath: () => 'isolated-memory' },
      ipcMain: { handle: (name, callback) => { handlers[name] = callback; } }
    } : localRequire(name) });
  vm.runInContext(mainSource, context, { filename: mainPath });
  vm.runInContext('engine = testing.engine; win = testing.win; market = testing.market; monitor = testing.monitor; store = testing.store; agencyPool = testing.agencyPool;', context);
  return { engine, sent, timers, handlers, calls, context, run: source => vm.runInContext(source, context),
    fireTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); } };
}

test('decision view preserves displayed dates, finance checks, interpreted evidence and execution facts without altering source records', () => {
  const original = decision(), before = structuredClone(original), view = decisionView(original);
  for (const key of ['financeCheck', 'valuationCheck', 'entryConditionsCheck', 'evidence', 'execution']) assert.deepEqual(view[key], before[key]);
  for (const key of ['financeCheck', 'entryConditionsCheck', 'evidence', 'checkedAt']) assert.deepEqual(view.executionCheck[key], before.executionCheck[key]);
  for (const sources of [view.inputSources, view.executionCheck.inputSources]) {
    assert.equal(sources[0].data.asOf, '2026-10-15'); assert.equal(sources[1].data.latest.reportDate, '2026-06-30');
    assert.deepEqual(sources[2].data.evaluation, before.inputSources[2].data.evaluation);
    assert.equal(Object.hasOwn(sources[0].data, 'bars'), false); assert.equal(Object.hasOwn(sources[1].data.latest, 'netProfit'), false);
    assert.equal(Object.hasOwn(sources[2].data, 'raw'), false);
    for (let index = 0; index < sources.length; index++) {
      const { data: actualData, ...actual } = sources[index], { data: expectedData, ...expected } = before.inputSources[index];
      assert.deepEqual(actual, expected);
    }
  }
  assert.deepEqual(original, before); assert.ok(JSON.stringify(view).length < JSON.stringify(original).length / 2);
});

test('historical sources without structured data remain readable', () => {
  for (const data of [undefined, null, '旧资料说明', 0]) {
    const original = { inputSources: [{ id: 'legacy-source', data }], executionCheck: { result: '旧检查结果' } };
    assert.deepEqual(decisionView(original), original);
  }
  assert.deepEqual(decisionView({ id: 'legacy-decision', status: 'complete' }), { id: 'legacy-decision', status: 'complete' });
});

test('the existing evidence renderer produces identical visible evidence from full and compact decisions', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ui/agency.js'), 'utf8');
  const start = source.indexOf('function agencyEvidenceHtml('), end = source.indexOf('\nfunction agencyDecisionsHtml(', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ agencyIsRuleDecision: item => item.decisionMode === 'rules', esc: String, timeText: String,
    agencyNoticeReviewHtml: value => `notice:${JSON.stringify(value)}`, agencyPoolEvidenceHtml: value => `research:${JSON.stringify(value)}` });
  vm.runInContext(source.slice(start, end), context);
  const original = decision(); context.full = original; context.compact = decisionView(original);
  const fullHtml = vm.runInContext('agencyEvidenceHtml(full)', context), viewHtml = vm.runInContext('agencyEvidenceHtml(compact)', context);
  assert.equal(viewHtml, fullHtml);
  for (const expected of ['2026-10-15', '2026-06-30', '公告原文摘录', '产品需求事实', '同产品依据', '执行前复核依据']) assert.ok(viewHtml.includes(expected), expected);
  original.decisionMode = 'model'; context.compact = decisionView(original);
  assert.equal(vm.runInContext('agencyEvidenceHtml(compact)', context), vm.runInContext('agencyEvidenceHtml(full)', context));
});

test('main compact state removes duplicate agency records while full state API retains complete audit evidence and valid account', async () => {
  const f = host(), before = structuredClone(f.engine.s);
  assert.equal(validState(before), true);
  const compact = f.run('state({ view: true })');
  assert.deepEqual(compact.account, accountView(before));
  for (const key of ['groups', 'decisions', 'pool', 'corporateChecks', 'corporateActions', 'corporateEvents', 'executionIntents', 'transfers']) {
    assert.equal(Object.hasOwn(compact.account.agency, key), false, key);
  }
  assert.equal(compact.agency.groups[0].id, before.agency.groups[0].id);
  assert.deepEqual(compact.agency.decisions, before.agency.decisions.map(decisionView));
  assert.equal(compact.agencyPool.lastResult.id, 'pool-result');
  const fullBefore = f.run('state()');
  assert.equal(fullBefore.account, f.engine.s); assert.deepEqual(fullBefore.account, before);
  assert.deepEqual(fullBefore.agency.decisions, before.agency.decisions);
  f.run('state({ view: true })');
  const route = mainSource.split('\n').find(line => line.includes("handler('state',")); assert.ok(route);
  f.run(route);
  const response = await f.handlers.state({ sender: f.context.testing.win.webContents, senderFrame: f.context.testing.win.webContents.mainFrame });
  assert.equal(response.ok, true); assert.deepEqual(response.data.account, before); assert.equal(validState(response.data.account), true);
  assert.deepEqual(response.data.agency.decisions, before.agency.decisions);
  assert.deepEqual(f.engine.s, before, 'presentation building cannot modify persisted account or evidence');
});

test('immediate publish cancels pending coalesced publication and later updates still publish once', () => {
  const f = host(); f.run('schedulePublish(); schedulePublish();'); assert.equal(f.timers.size, 1);
  f.run('publish()'); assert.equal(f.timers.size, 0); assert.equal(f.sent.length, 1); assert.equal(f.calls.stateBuilds, 1);
  f.fireTimers(); assert.equal(f.sent.length, 1);
  f.run('schedulePublish(); schedulePublish();'); assert.equal(f.timers.size, 1);
  f.fireTimers(); assert.equal(f.sent.length, 2); assert.equal(f.calls.stateBuilds, 2); assert.equal(f.timers.size, 0);
  assert.equal(Object.hasOwn(f.sent[0].payload.account.agency, 'decisions'), false);
});

test('refresh builds one compact snapshot shared by the returned value and broadcast, cancelling an already scheduled update', async () => {
  const f = host(); f.run('schedulePublish()');
  const result = await f.run('refresh()');
  assert.equal(f.calls.stateBuilds, 1); assert.equal(f.calls.saves, 1); assert.equal(f.calls.scans, 2);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].channel, 'state'); assert.equal(f.sent[0].payload, result);
  assert.equal(Object.hasOwn(result.account.agency, 'decisions'), false); assert.equal(f.timers.size, 0);
  f.fireTimers(); assert.equal(f.sent.length, 1);
  assert.equal(validState(f.engine.s), true); assert.ok(f.engine.s.agency.decisions[0].inputSources[2].data.raw);
});
