'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { symbolOf } = require('../core/common.cjs');
const { STRATEGY_PROFILES, strategyProfile } = require('../core/strategy-profiles.cjs');
const { unknownMarketRegime } = require('../core/market-regime.cjs');
const { MarketRegimeService } = require('../core/market-regime-service.cjs');
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const start = source.indexOf("  handler('agency:verify'"), end = source.indexOf("  handler('agency:pool:status'", start);
assert.ok(start >= 0 && end > start);
const now = Date.parse('2026-10-19T10:00:00+08:00');
const symbols = ['sh600001', 'sh600002', 'sh600003', 'sh600004'];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture({ verify, marketPoll, marketService } = {}) {
  const handlers = {}, calls = { verify: [], market: [], agency: [], publishes: 0 }, order = [];
  const snapshot = unknownMarketRegime('市场环境获取失败：测试来源超时', now);
  const context = {
    fatal: '', agencyError: '', connection: { ok: true }, symbolOf, strategyProfile,
    engine: { s: { trades: [{ owner: 'long', symbol: 'sh600099' }], agency: { groups: STRATEGY_PROFILES.map((profile, index) => ({ id: profile.id, members: [{ symbol: symbols[index] }] })) } } },
    handler: (name, fn) => { handlers[name] = fn; }, publish: () => { calls.publishes++; },
    corporate: { verify: async input => { calls.verify.push(input); order.push('corporate'); return verify ? verify(input) : { checked: 1, clear: 1, waiting: 0, blocked: 0, skipped: 0, results: [] }; } },
    marketRegime: { poll: async options => { calls.market.push(options); order.push('market'); return marketService ? marketService.poll(options) : marketPoll ? marketPoll(options) : snapshot; } },
    agency: { publicState: () => ({ session: { open: true, known: true } }),
      poll: async options => { calls.agency.push(options); order.push('agency'); return { started: 1 }; } }
  };
  vm.runInNewContext(source.slice(start, end), context, { filename: 'main.cjs:market-regime-retry-routes' });
  return { handlers, calls, order, context, snapshot };
}

test('四策略整体和单只重新核验均强刷共享市场环境，不安排自动交易', async () => {
  for (const [index, profile] of STRATEGY_PROFILES.entries()) {
    for (const single of [false, true]) {
      const f = fixture(), input = { strategyId: profile.id, ...(single ? { symbol: symbols[index] } : {}) };
      const response = await f.handlers['agency:verify'](input);
      assert.deepEqual(structuredClone(f.calls.verify), [input]);
      assert.deepEqual(structuredClone(f.calls.market), [{ force: true }]);
      assert.equal(f.calls.agency.length, 0);
      assert.equal(response.checked, 1); assert.equal(response.clear, 1);
      assert.equal(response.marketRegime.status, 'unknown'); assert.equal(response.marketRegime.allowEntry, false);
      assert.equal(response.marketRegime.riskMultiplier, 0);
      assert.equal(response.marketRegime.checkedAt, now);
      assert.equal(f.calls.publishes, 1);
    }
  }
});

test('重新核验在网络请求前拒绝无效策略、越权股票和账户致命错误', async () => {
  const f = fixture();
  for (const input of [undefined, {}, { strategyId: 'bad' }, { strategyId: 'long', symbol: 'sh600001' },
    { strategyId: 'long', symbol: 'invalid' }, { strategyId: 'short', symbol: 'sh600099' }]) {
    await assert.rejects(f.handlers['agency:verify'](input));
  }
  f.context.fatal = '账户保存失败，交易已暂停：测试';
  await assert.rejects(f.handlers['agency:verify']({ strategyId: 'long' }), /账户保存失败/);
  assert.equal(f.calls.verify.length, 0); assert.equal(f.calls.market.length, 0); assert.equal(f.calls.agency.length, 0);
  f.context.fatal = '';
  const historical = await f.handlers['agency:verify']({ strategyId: 'long', symbol: '600099' });
  assert.equal(historical.checked, 1); assert.equal(f.calls.verify[0].symbol, 'sh600099');
});

test('公司行为与市场环境并行，返回前等待两者完成；一方失败也等待另一方收尾', async () => {
  for (const rejectCorporate of [false, true]) {
    const company = deferred(), environment = deferred();
    const f = fixture({ verify: () => company.promise, marketPoll: () => environment.promise });
    let settled = false;
    const work = f.handlers['agency:verify']({ strategyId: 'long' });
    work.then(() => { settled = true; }, () => { settled = true; });
    assert.equal(f.calls.verify.length, 1); assert.equal(f.calls.market.length, 1);
    if (rejectCorporate) company.reject(Error('公司行为获取失败')); else company.resolve({ checked: 2, clear: 2 });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false);
    environment.resolve(f.snapshot);
    if (rejectCorporate) await assert.rejects(work, /公司行为获取失败/);
    else assert.equal((await work).checked, 2);
    assert.equal(f.calls.publishes, 1); assert.equal(f.calls.agency.length, 0);
  }
});

test('多个策略同时重试共用市场服务中的同一轮来源请求，失败仍暂停新开仓', async () => {
  const breadth = deferred(); let loads = 0;
  const bars = Array.from({ length: 70 }, (_, index) => ({
    date: new Date(Date.parse('2026-10-16T00:00:00Z') - (69 - index) * 86400000).toISOString().slice(0, 10),
    open: 100, close: 100, high: 101, low: 99, volume: 10000
  }));
  const service = new MarketRegimeService({ clock: () => now,
    indexHistory: async symbol => ({ symbol, source: 'isolated index history', adjustment: '未复权', fetchedAt: now, bars }), getQuotes: () => ({}),
    loadBreadth: () => { loads++; return breadth.promise; } });
  const f = fixture({ marketService: service });
  const pending = STRATEGY_PROFILES.map(profile => f.handlers['agency:verify']({ strategyId: profile.id }));
  await Promise.resolve();
  assert.equal(loads, 1);
  breadth.reject(Error('选股行情获取超时，未使用不完整股票池'));
  const responses = await Promise.all(pending);
  for (const response of responses) {
    assert.equal(response.marketRegime.status, 'unknown'); assert.equal(response.marketRegime.allowEntry, false);
    assert.match(response.marketRegime.reason, /选股行情获取超时/);
  }
  assert.equal(f.calls.agency.length, 0);
});

test('四策略手动规则检查等待市场更新；unknown保留原权限并继续原规则检查', async () => {
  for (const profile of STRATEGY_PROFILES) {
    const environment = deferred(), f = fixture({ marketPoll: () => environment.promise });
    const pending = f.handlers['agency:run']({ strategyId: profile.id });
    assert.equal(f.calls.market.length, 1); assert.equal(f.calls.agency.length, 0);
    environment.resolve(f.snapshot);
    assert.equal((await pending).started, 1);
    assert.deepEqual(structuredClone(f.calls.agency), [{ force: true, groupIds: [profile.id] }]);
    assert.deepEqual(f.order, ['market', 'agency']);
    assert.equal(f.snapshot.allowEntry, false); assert.equal(f.snapshot.riskMultiplier, 0);
  }
});

test('手动规则检查先拒绝无效策略，市场等待期间发生账户错误则不启动规则检查', async () => {
  const environment = deferred(), f = fixture({ marketPoll: () => environment.promise });
  for (const strategyId of ['bad', '', null]) await assert.rejects(f.handlers['agency:run']({ strategyId }));
  assert.equal(f.calls.market.length, 0);
  const pending = f.handlers['agency:run']({ strategyId: 'long' });
  f.context.fatal = '账户保存失败，交易已暂停：等待期间发生错误'; environment.resolve(f.snapshot);
  await assert.rejects(pending, /账户保存失败/);
  assert.equal(f.calls.agency.length, 0);
});

test('新增市场重试不绕过规则检查的交易时段、行情连接或账户暂停门槛', async () => {
  const f = fixture();
  for (const session of [{ open: false, known: true, label: '非交易时段' }, { open: true, known: false }]) {
    f.context.agency.publicState = () => ({ session });
    await assert.rejects(f.handlers['agency:run']({ strategyId: 'long' }), /交易时段/);
  }
  f.context.agency.publicState = () => ({ session: { open: true, known: true } });
  f.context.connection.ok = false;
  await assert.rejects(f.handlers['agency:run']({ strategyId: 'long' }), /行情连接不可用/);
  f.context.connection.ok = true; f.context.fatal = '账户保存失败，交易已暂停';
  await assert.rejects(f.handlers['agency:run']({ strategyId: 'long' }), /账户保存失败/);
  assert.equal(f.calls.market.length, 0); assert.equal(f.calls.agency.length, 0);
});
