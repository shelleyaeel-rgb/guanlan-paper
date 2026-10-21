'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { parseStrategyDescription } = require('../core/strategy-presets.cjs');
const { validate } = require('../core/screener.cjs');

// Execute the shipped renderer flow with real query parsing. Only DOM painting
// and the subsequent market fetch are stubbed; failed parses must preserve the
// complete editor state and input, not just produce an error string.
function fixture(query, { strategyId = '', strategyRules = [], personalRules = query.rules } = {}) {
  const elements = new Map(), submissions = [], requests = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [] });
    return elements.get(id);
  };
  const context = vm.createContext({ $: element, document: { querySelectorAll: () => [] }, structuredClone,
    api: async (channel, input) => {
      assert.equal(channel, 'screener:parse');
      const request = JSON.parse(JSON.stringify(input)); requests.push(request);
      return parseStrategyDescription(request);
    }, submitted: value => submissions.push(JSON.parse(JSON.stringify(value))) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/screener.js'), 'utf8'), context);
  vm.runInContext(`screenQuery=${JSON.stringify(query)}; screenStrategyId=${JSON.stringify(strategyId)};
    screenStrategyRules=${JSON.stringify(strategyRules)}; screenPersonalRules=${JSON.stringify(personalRules)};
    screenResult={status:'ready',matched:2,rows:[{symbol:'sz000001'},{symbol:'sh600000'}]};
    setScreenBusy=value=>{screenBusy=value}; renderScreenRules=()=>{};
    screenChanged=()=>{screenDirty=true}; runScreen=async()=>submitted(screenQuery);`, context);
  const read = expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
  return { element, requests, submissions, read, context,
    async run(text) { element('screen-description').value = text; await vm.runInContext('screenFromText()', context); } };
}
const industry = { version: 1, scope: 'main', mainRankMax: 3, segmentRankMax: 1, minSegmentRevenuePct: 30 };
const originalQuery = evidence => ({ scope: 'watchlist', boards: ['sh'], excludeST: true,
  rules: [{ field: 'price', op: 'gte', value: 10 }], evidence });

test('custom text rejects conflicting industry modes without replacing query, rules, results or input', async () => {
  const query = originalQuery({ conditions: ['demand'], industry });
  const f = fixture(query), before = f.read('({query:screenQuery,personal:screenPersonalRules,result:screenResult})');
  await f.run('主行业前三，市盈率小于20');
  assert.deepEqual(f.read('({query:screenQuery,personal:screenPersonalRules,result:screenResult})'), before);
  assert.equal(f.element('screen-description').value, '主行业前三，市盈率小于20');
  assert.match(f.element('screen-error').textContent, /行业.*不能隐式合并/);
  assert.equal(f.submissions.length, 0); assert.equal(f.read('screenTextPending'), true); assert.equal(f.read('screenBusy'), false);
  assert.doesNotThrow(() => validate(f.read('screenQuery')));
  // Choosing a compatible mode and retrying the same text succeeds normally.
  vm.runInContext('delete screenQuery.evidence.industry', f.context);
  await f.run(f.element('screen-description').value);
  assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].evidence.leadership, 'mainTop3');
  assert.deepEqual(f.submissions[0].evidence.conditions, ['demand']);
  assert.equal(f.element('screen-description').value, '');
});

test('compatible custom text retains research predicates while replacing numeric and universe filters', async () => {
  const query = originalQuery({ conditions: ['demand'], industry });
  query.research = { version: 1, enabled: true, path: 'company', rules: [{ field: 'revenueYoY', op: 'gt', value: 10 }] };
  query.performance = { version: 1, enabled: true, rules: [{ field: 'netProfitGrowthMinPct', op: 'gte', value: 20 }] };
  const f = fixture(query);
  await f.run('产品已商业化，市盈率小于20');
  assert.equal(f.element('screen-error').textContent, ''); assert.equal(f.submissions.length, 1);
  const result = f.submissions[0];
  assert.deepEqual(result.rules, [{ field: 'pe', op: 'lt', value: 20 }]);
  assert.equal(result.scope, 'all'); assert.deepEqual(result.boards, []); assert.equal(result.excludeST, false);
  assert.deepEqual(result.evidence.conditions, ['demand', 'commercialization']); assert.deepEqual(result.evidence.industry, industry);
  assert.deepEqual(result.research, query.research); assert.deepEqual(result.performance, query.performance);
  assert.deepEqual(f.read('screenPersonalRules'), result.rules); assert.doesNotThrow(() => validate(result));
  assert.equal(f.element('screen-description').value, ''); assert.equal(f.read('screenTextPending'), false);
});

test('custom text uses the same explicit industry-path conflict and tightening rules as strategy text', async () => {
  const query = originalQuery({ conditions: ['demand'], leadership: 'mainTop3', minSegmentRevenuePct: 50 });
  const conflict = fixture(query);
  await conflict.run('细分龙头');
  assert.deepEqual(conflict.read('screenQuery'), query); assert.equal(conflict.submissions.length, 0);
  assert.match(conflict.element('screen-error').textContent, /两条路径同时满足/);
  const compatible = fixture(query);
  await compatible.run('主行业前三或细分龙头');
  assert.equal(compatible.submissions[0].evidence.leadership, 'mainTop3');
  assert.equal(compatible.submissions[0].evidence.minSegmentRevenuePct, 50);
});

test('strategy text still adds personal conditions, and failed additions leave all rule origins intact', async () => {
  const preset = { field: 'price', op: 'gte', value: 10 }, personal = { field: 'pe', op: 'lt', value: 20 };
  const query = { scope: 'watchlist', boards: ['sh'], excludeST: true, rules: [preset, personal] };
  const f = fixture(query, { strategyId: 'long', strategyRules: [preset], personalRules: [personal] });
  await f.run('市净率小于3');
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.submissions[0].rules, [preset, personal, { field: 'pb', op: 'lt', value: 3 }]);
  assert.deepEqual(f.read('screenPersonalRules'), [personal, { field: 'pb', op: 'lt', value: 3 }]);
  assert.deepEqual(f.read('screenStrategyRules'), [preset]);
  assert.equal(f.submissions[0].scope, 'watchlist'); assert.deepEqual(f.submissions[0].boards, ['sh']);
  const before = f.read('({query:screenQuery,personal:screenPersonalRules,strategy:screenStrategyRules})');
  await f.run('股价小于5');
  assert.deepEqual(f.read('({query:screenQuery,personal:screenPersonalRules,strategy:screenStrategyRules})'), before);
  assert.equal(f.submissions.length, 1); assert.equal(f.element('screen-description').value, '股价小于5');
  assert.match(f.element('screen-error').textContent, /矛盾/);
});
