'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '../ui', name), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function metadataFixture(api) {
  const elements = new Map();
  const context = vm.createContext({ api, $: id => { if (!elements.has(id)) elements.set(id, { innerHTML: '' }); return elements.get(id); }, esc: value => String(value ?? '') });
  vm.runInContext(source('screener.js'), context);
  return { context, elements, run: expression => vm.runInContext(expression, context) };
}
test('automatic configuration shares one read-only metadata request and caches only success', async () => {
  let resolve, calls = 0;
  const pending = new Promise(done => resolve = done), metadata = { strategies: [] };
  const f = metadataFixture(async name => { assert.equal(name, 'screener:meta'); calls++; return pending; });
  const first = f.run('loadScreenMeta()'), second = f.run('loadScreenMeta()');
  assert.equal(calls, 1); resolve(metadata);
  assert.equal(await first, metadata); assert.equal(await second, metadata);
  assert.equal(await f.run('loadScreenMeta()'), metadata); assert.equal(calls, 1);
});
test('failed shared metadata request can be retried without retaining failure', async () => {
  let calls = 0;
  const f = metadataFixture(async name => { assert.equal(name, 'screener:meta'); if (++calls === 1) throw Error('offline'); return { strategies: [] }; });
  await assert.rejects(f.run('loadScreenMeta()'), /offline/);
  assert.deepEqual(clone(await f.run('loadScreenMeta()')), { strategies: [] }); assert.equal(calls, 2);
});
test('strategy library presents four read-only explanations without manual selection controls', async () => {
  const strategies = ['ultra-short', 'short', 'swing', 'long'].map(id => ({ id, name: id, horizon: '观察周期', summary: '规则', entryNotes: '入场', limitations: '限制' }));
  const f = metadataFixture(async () => ({ strategies })); await f.run('initInvestmentStrategies()');
  const html = f.elements.get('investment-strategies').innerHTML;
  assert.equal((html.match(/class="investment-strategy"/g) || []).length, 4);
  assert.doesNotMatch(html, /<button|data-use-strategy|用此策略选股/);
});
function poolFixture(savedPolicy) {
  const requests = [], state = { account: { createdAt: 'account-a' }, agencyPool: { running: false, savedPolicy, policy: { screeningMode: 'strategy', commonQuery: {} } } };
  const context = vm.createContext({ state, structuredClone, console,
    researchRuleError: query => query?.enabled && !query.rules.length ? '研究条件不能为空' : '', performanceRuleError: () => '', industryRuleError: () => '',
    api: async (name, input) => { requests.push({ name, input: input ? clone(input) : input }); return name === 'state' ? state : { id: 'applied' }; },
    toast() {}, renderState() {} });
  vm.runInContext(source('agency.js').split("$('agency-tabs').addEventListener")[0], context);
  vm.runInContext('renderAgencyPool = () => {}; initializeAgencyPoolConfiguration(state.agencyPool)', context);
  return { state, requests, context, run: expression => vm.runInContext(expression, context), read: expression => clone(vm.runInContext(expression, context)) };
}
const policy = { screeningMode: 'strategy', commonQuery: {
  research: { version: 1, enabled: true, path: 'company', rules: [{ field: 'revenueYoY', op: 'gte', value: 10 }] },
  performance: { version: 1, enabled: true, rules: [{ field: 'netProfitGrowthMinPct', op: 'gte', value: 20 }] },
  evidence: { industry: { version: 1, scope: 'main', mainRankMax: 3, segmentRankMax: 1, minSegmentRevenuePct: 30 } }
} };
test('automatic configuration does not reactivate saved research or strict policy', () => {
  for (const saved of [policy, { ...policy, screeningMode: 'strict' }, { version: 1, commonQuery: policy.commonQuery }]) {
    const f = poolFixture(clone(saved));
    assert.equal(f.read('agencyUi.screeningMode'), 'strategy');
    assert.equal(f.run('agencyPoolResearch()'), undefined);
    assert.equal(f.run('agencyPoolIndustry()'), undefined);
    assert.equal(f.run('agencyUi.performance'), undefined);
    assert.deepEqual(f.state.agencyPool.savedPolicy, saved, 'renderer leaves the historical policy intact');
  }
});

test('pool update submits only technical strategy policy even if old renderer drafts remain', async () => {
  const f = poolFixture(clone(policy));
  f.run('agencyUi.screeningMode = "strict"; agencyUi.performance = {enabled:true,rules:[]}; agencyUi.researchDrafts = {company:{enabled:true,rules:[]}}');
  await f.run('agencyUpdatePool()');
  assert.deepEqual(f.requests, [{ name: 'agency:pool:run', input: { screeningMode: 'strategy' } }, { name: 'state', input: undefined }]);
  assert.deepEqual(f.state.agencyPool.savedPolicy, policy);
  assert.equal(f.read('agencyUi.busy.size'), 0);
});

test('running update or retry cannot submit another pool operation', async () => {
  for (const busy of ['running', 'pool-run', 'pool-retry']) {
    const f = poolFixture(clone(policy));
    if (busy === 'running') f.state.agencyPool.running = true;
    else f.run('agencyUi.busy.add(' + JSON.stringify(busy) + ')');
    await f.run('agencyUpdatePool()');
    await f.run('agencyUpdatePool("retry")');
    assert.equal(f.requests.length, 0, busy);
  }
});

test('retry uses the technical backend retry without resubmitting old research fields', async () => {
  const f = poolFixture(clone(policy));
  await f.run('agencyUpdatePool("retry")');
  assert.deepEqual(f.requests, [{ name: 'agency:pool:retry', input: undefined }, { name: 'state', input: undefined }]);
  assert.deepEqual(f.state.agencyPool.savedPolicy, policy);
});

test('automatic results distinguish new technical scans from historical research conclusions', () => {
  const f = poolFixture(clone(policy));
  assert.equal(f.run('agencyResearchDisabled({selection:{mode:"technical"}})'), true);
  assert.equal(f.run('agencyResearchDisabled({coverage:{researchChecks:{status:"disabled"}}})'), true);
  assert.equal(f.run('agencyResearchDisabled({screeningMode:"strategy",coverage:{researchRequired:false}})'), false);
  assert.match(f.run('agencyPoolEvidenceSummaryHtml({selection:{mode:"technical"}})'), /已停用.*未核验/);
  assert.doesNotMatch(f.run('agencyPoolEvidenceSummaryHtml({selection:{mode:"technical"}})'), /核验通过/);
  assert.match(f.run('agencyPoolEvidenceSummaryHtml({screeningMode:"strict"})'), /历史筛选结果.*仅留档/);
});

test('first-entry price validation does not claim corporate announcements were verified', () => {
  const f = poolFixture(clone(policy));
  const member = { corporateVerification: { status: 'not-required' }, automaticCheck: { status: 'clear', checkedAt: 123 }, reconciliation: { status: 'clear' }, awaitingVerification: false };
  f.context.member = member;
  const result = f.read('agencyVerificationView(member)');
  assert.equal(result.pending, false);
  assert.equal(result.label, '价格基准：通过');
  assert.match(result.note, /无需公司行为公告前置.*尚未核验/);
  assert.equal(f.run('agencyCorporateStatus(member.corporateVerification)'), '公司行为资料：未核验 · 首次开仓无需公告前置');
  member.automaticCheck.status = 'waiting'; member.automaticCheck.reason = '日线不足';
  assert.equal(f.read('agencyVerificationView(member)').pending, true);
  assert.equal(f.read('agencyVerificationView(member)').note, '日线不足');
});

test('automatic page has no research selectors or apply route and retains corporate reconciliation', () => {
  const html = source('index.html'), agency = source('agency.js'), research = source('research-rules.js');
  for (const id of ['agency-pool-mode', 'agency-pool-legacy', 'agency-research-controls', 'agency-industry-controls', 'agency-performance-controls']) {
    assert.ok(!html.includes('id="' + id + '"'), id);
    assert.ok(!agency.includes("$('" + id + "')"), id + ' handler');
  }
  assert.match(html, /id="agency-research-disabled"/);
  assert.match(html, /id="agency-reconcile-dialog"/);
  assert.doesNotMatch(agency, /researchInspectButton/);
  assert.doesNotMatch(research, /agencyUi.researchDrafts.*=/);
});
