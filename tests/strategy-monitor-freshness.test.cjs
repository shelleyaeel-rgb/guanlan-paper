const test = require('node:test');
const assert = require('node:assert/strict');
const { Research } = require('../core/research.cjs');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const sample = require('./fixtures/research-data.cjs');

const symbol = 'sh600519', START = Date.parse('2026-09-30T10:00:00+08:00');
const bars = Array.from({ length: 80 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 11 + i)).toISOString().slice(0, 10), open: 10, close: 10, high: 10.2, low: 9.8, volume: 10000 }));

test('正式新财报触发一次强制同步，同一公告五分钟内自动重试限速，预告不触发', async () => {
  let now = Date.parse('2026-10-15T10:00:00+08:00'), synchronize = false;
  const requests = [], notice = { id: 'AN20261013000001', date: '2026-10-13', title: '2026年第三季度报告' };
  const research = { get: async input => {
    requests.push({ ...input });
    const base = { symbol, section: input.section, source: '东方财富', fetchedAt: now, status: 'ready' };
    return input.section === 'notices' ? { ...base, data: { items: [notice], total: 1 } }
      : input.section === 'finance' ? { ...base, data: { latest: { reportDate: synchronize && input.force ? '2026-09-30' : '2026-06-30' } } }
        : { ...base, data: { quoteTime: now } };
  } };
  const monitor = new StrategyMonitor({ strategyHistory: async () => bars }, () => new Date(now), () => {}, research);
  const first = await monitor.load(symbol, false, true, true);
  assert.equal(requests.filter(r => r.section === 'finance' && r.force).length, 1); assert.equal(first.financeReportSync.status, 'pending');
  for (let i = 0; i < 4; i++) { now += 60000; await monitor.load(symbol, false, true, true); }
  assert.equal(requests.filter(r => r.section === 'finance' && r.force).length, 1);
  now += 60000; synchronize = true;
  const synced = await monitor.load(symbol, false, true, true);
  assert.equal(requests.filter(r => r.section === 'finance' && r.force).length, 2); assert.equal(synced.financeReportSync.status, 'synced');
  synchronize = false; now += 1000;
  await monitor.load(symbol, true, true, true);
  assert.equal(requests.filter(r => r.section === 'finance' && r.force).length, 3, '显式force本身只请求一次财务');
  notice.title = '2026年前三季度业绩预告'; now += 60000;
  const forecast = await monitor.load(symbol, false, true, true);
  assert.equal(forecast.financeReportSync, undefined); assert.equal(requests.filter(r => r.section === 'finance' && r.force).length, 3);
});

test('自动成员附带公司行为证据，普通自选不额外取证；新授权不会沿用缺少公司行为的缓存', async () => {
  const members = [], calls = [];
  const corporate = { symbols: () => members, getSnapshot: async (stock, force) => { calls.push({ stock, force }); return { symbol: stock, fetchedAt: START, coverageComplete: true, coverageEnd: '2026-09-30', status: 'ready', events: [] }; } };
  const research = { get: async () => ({ symbol, status: 'empty', fetchedAt: START, data: { items: [], total: 0 } }) };
  const monitor = new StrategyMonitor({ strategyHistory: async () => bars }, () => new Date(START), () => {}, research, corporate);
  const ordinary = await monitor.load(symbol, false, false, true);
  assert.equal(ordinary.corporateActions, undefined); assert.equal(calls.length, 0);
  members.push(symbol);
  const automatic = await monitor.load(symbol, false, false, true);
  assert.equal(automatic.corporateActions.symbol, symbol); assert.equal(calls.length, 1);
  assert.equal(await monitor.load(symbol, false, false, true), automatic);
  await monitor.load(symbol, true, false, true);
  assert.deepEqual(calls, [{ stock: symbol, force: false }, { stock: symbol, force: true }]);
});

test('持仓资料扫描独立于慢速候选队列，每条扫描队列最多并发三只', async () => {
  const calls = [], releases = [];
  const monitor = new StrategyMonitor({ strategyHistory: async stock => {
    calls.push(stock);
    if (stock !== symbol) await new Promise(resolve => releases.push(resolve));
    return bars;
  } }, () => new Date(START));
  const background = monitor.scan(['sh600001', 'sh600002', 'sh600003', 'sh600004']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3);
  await monitor.scan([symbol], [], [], 'holdings');
  assert.ok(monitor.snapshots[symbol]); assert.equal(calls.length, 4);
  for (const release of releases) release();
  await new Promise(resolve => setImmediate(resolve));
  for (const release of releases) release();
  await background;
  assert.equal(calls.length, 5); assert.equal(monitor.scans.size, 0);
});
function fixture() {
  let now = START;
  const calls = { finance: 0, valuation: 0, profile: 0, history: 0 }, controls = { failFinance: false, failValuation: false, failProfile: false, quoteTime: undefined };
  const research = new Research(async url => {
    const section = url.includes('FINANCE') ? 'finance' : url.includes('BASICINFO') ? 'profile' : 'valuation'; calls[section]++;
    if (controls[{ finance: 'failFinance', valuation: 'failValuation', profile: 'failProfile' }[section]]) throw Error('隔离测试断线');
    const data = sample[section](symbol);
    if (section === 'valuation') data.data.diff[0].f124 = controls.quoteTime === undefined ? Math.floor(now / 1000) : controls.quoteTime;
    return { ok: true, json: async () => data };
  }, { clock: () => now });
  const requests = [], get = research.get.bind(research);
  research.get = input => { requests.push(input); return get(input); };
  const monitor = new StrategyMonitor({ strategyHistory: async () => { calls.history++; return bars; } }, () => new Date(now), () => {}, research);
  return { research, monitor, calls, requests, controls, time: () => now, advance: ms => { now += ms; }, load: (force = false) => monitor.load(symbol, force, true) };
}

test('Research与监控两层缓存叠加时，估值自身满90秒后立即重新获取', async () => {
  const f = fixture();
  await f.research.get({ symbol, section: 'valuation' });
  f.advance(50000);
  const first = await f.load();
  assert.equal(first.valuation.cached, true); assert.equal(first.valuation.fetchedAt, START);
  assert.deepEqual(f.calls, { finance: 1, valuation: 1, profile: 1, history: 1 });
  f.advance(40000);
  assert.equal(await f.load(), first, '90秒边界仍与建仓检查一致');
  f.advance(1);
  const second = await f.load();
  assert.notEqual(second, first); assert.equal(second.valuation.fetchedAt, f.time());
  assert.deepEqual(f.calls, { finance: 1, valuation: 2, profile: 1, history: 1 });
});

test('行业原获取时间超过24小时即刷新，不能借刚完成的财务扫描续期', async () => {
  const f = fixture();
  await f.research.get({ symbol, section: 'profile' });
  f.advance(86400000 - 50000);
  const first = await f.load();
  assert.equal(first.finance.industryProfile.fetchedAt, START);
  assert.equal(f.calls.profile, 1);
  f.advance(50001);
  const second = await f.load();
  assert.notEqual(second, first); assert.equal(second.finance.industryProfile.fetchedAt, f.time());
  assert.equal(f.calls.profile, 2); assert.equal(f.calls.finance, 1);
});

test('财报自身跨越6小时时刷新，监控尝试时间不会延长Research财报有效期', async () => {
  const f = fixture();
  await f.research.get({ symbol, section: 'finance' });
  f.advance(21600000 - 50000);
  const first = await f.load();
  assert.equal(first.finance.cached, true); assert.equal(first.finance.fetchedAt, START);
  f.advance(50001);
  const second = await f.load();
  assert.notEqual(second, first); assert.equal(second.finance.fetchedAt, f.time());
  assert.deepEqual(f.calls, { finance: 2, valuation: 1, profile: 1, history: 1 });
});

test('ready响应中获取时间或估值报价未知、未来及过期，均不命中监控缓存', async () => {
  const mutations = [
    snapshot => { snapshot.finance.fetchedAt = null; },
    snapshot => { snapshot.finance.fetchedAt = START + 1; },
    snapshot => { snapshot.finance.fetchedAt = START - 21600001; },
    snapshot => { snapshot.valuation.fetchedAt = null; },
    snapshot => { snapshot.valuation.fetchedAt = START + 1; },
    snapshot => { snapshot.valuation.fetchedAt = START - 90001; },
    snapshot => { snapshot.valuation.data.quoteTime = null; },
    snapshot => { snapshot.valuation.data.quoteTime = START + 1; },
    snapshot => { snapshot.valuation.data.quoteTime = START - 90001; }
  ];
  for (const change of mutations) {
    const f = fixture(), first = await f.load();
    const cached = structuredClone(first); change(cached); f.monitor.snapshots[symbol] = cached;
    const next = await f.load();
    assert.notEqual(next, cached, change.toString());
    assert.equal(f.calls.history, 1); assert.ok(f.requests.length < 6, '仅刷新无效模块，不重载全部资料');
    assert.equal(next.finance.fetchedAt, START); assert.equal(next.valuation.data.quoteTime, START);
  }
});

test('财务与估值失败仍按一分钟限速，用户强制刷新不受失败缓存限制', async () => {
  const f = fixture(); f.controls.failFinance = true; f.controls.failValuation = true;
  const first = await f.load(), initialCalls = { ...f.calls };
  f.advance(10000);
  assert.equal(await f.load(), first); assert.deepEqual(f.calls, initialCalls);
  const forced = await f.load(true);
  assert.notEqual(forced, first); assert.equal(forced.forced, true); assert.equal(f.calls.finance, 2);
  const forcedCalls = { ...f.calls };
  f.advance(59999); assert.equal(await f.load(), forced); assert.deepEqual(f.calls, forcedCalls);
  f.advance(1); assert.notEqual(await f.load(), forced); assert.equal(f.calls.finance, 3);
});

test('一节ready但报价过期不导致另一节失败接口每次重试，也不会无限延后其正常重试', async () => {
  const f = fixture(); f.controls.failFinance = true; f.controls.quoteTime = (START - 100000) / 1000;
  const first = await f.load();
  assert.equal(first.finance.status, 'unavailable'); assert.equal(first.valuation.status, 'ready');
  f.advance(10000); const second = await f.load();
  assert.equal(second, first, '旧行情仅保留失败重试冷却，不能因此成为可执行证据');
  assert.equal(f.monitor.peekPrepared(symbol, true, false), null);
  assert.equal(f.calls.finance, 1, '失败财报仍保留其一分钟限速');
  assert.equal(second.fundamentalsAttempts.finance, START);
  f.advance(50000); await f.load();
  assert.equal(f.calls.finance, 2, '到原失败请求的一分钟后再次尝试');
});

function noticeFixture() {
  let now = START;
  const calls = { notices: 0, history: 0 }, controls = { fail: false, empty: false };
  const research = new Research(async () => {
    calls.notices++;
    if (controls.fail) throw Error('公告隔离测试断线');
    return { ok: true, json: async () => controls.empty ? { success: 1, data: { total_hits: 0, list: [] } } : sample.notices(symbol) };
  }, { clock: () => now });
  const requests = [], get = research.get.bind(research);
  research.get = input => { requests.push(input); return get(input); };
  const monitor = new StrategyMonitor({ strategyHistory: async () => { calls.history++; return bars; } }, () => new Date(now), () => {}, research);
  return { research, monitor, calls, requests, controls, time: () => now, advance: ms => { now += ms; }, load: (force = false) => monitor.load(symbol, force, false, true) };
}

test('公告按需加载，普通日线扫描不请求公告，空列表也保留核验响应', async () => {
  const f = noticeFixture(); f.controls.empty = true;
  await f.monitor.scan([symbol, 'sz000001'], [], [symbol]);
  assert.deepEqual(f.calls, { notices: 1, history: 2 });
  assert.equal(f.monitor.snapshots[symbol].notices.status, 'empty');
  assert.equal(f.monitor.snapshots.sz000001.notices, undefined);
  const first = await f.load(); f.advance(59999);
  assert.equal(await f.load(), first); assert.equal(f.calls.notices, 1);
});

test('公告自身超过5分钟时刷新，两层缓存不能因监控刚加载而延长公告有效期', async () => {
  for (const empty of [false, true]) {
    const f = noticeFixture(); f.controls.empty = empty;
    await f.research.get({ symbol, section: 'notices' });
    f.advance(250000);
    const first = await f.load();
    assert.equal(first.notices.fetchedAt, START); assert.equal(first.notices.cached, true);
    f.advance(50000); assert.equal(await f.load(), first);
    f.advance(1); const next = await f.load();
    assert.notEqual(next, first); assert.equal(next.notices.fetchedAt, f.time());
    assert.equal(f.calls.notices, 2); assert.equal(f.calls.history, 1);
  }
});

test('公告失败一分钟内限速，到期重试；强制买入刷新即刻重验公告', async () => {
  const f = noticeFixture(); f.controls.fail = true;
  const first = await f.load(); assert.equal(first.notices.status, 'unavailable');
  f.advance(59999); assert.equal(await f.load(), first); assert.equal(f.calls.notices, 1);
  f.advance(1); const retried = await f.load(); assert.notEqual(retried, first); assert.equal(f.calls.notices, 2);
  f.controls.fail = false;
  const forced = await f.load(true); assert.equal(forced.forced, true); assert.equal(forced.notices.status, 'ready');
  assert.equal(f.calls.notices, 3); assert.equal(f.requests.at(-1).force, true);
  f.advance(1000); await f.load(true); assert.equal(f.calls.notices, 4, '再次提交仍独立强制刷新');
});

test('公告获取时间缺失、未来或过期不复用监控缓存，未配置公告服务明确失败', async () => {
  for (const fetchedAt of [null, START + 1, START - 300001]) {
    const f = noticeFixture(), first = await f.load();
    const cached = structuredClone(first); cached.notices.fetchedAt = fetchedAt;
    f.monitor.snapshots[symbol] = cached;
    assert.notEqual(await f.load(), cached); assert.equal(f.calls.history, 1);
  }
  const monitor = new StrategyMonitor({ strategyHistory: async () => bars }, () => new Date(START));
  const snapshot = await monitor.load(symbol, false, false, true);
  assert.equal(snapshot.notices.status, 'unavailable'); assert.match(snapshot.notices.error, /未配置/);
  assert.ok(snapshot.technical);
});

test('在途日线请求升级为公告核验及强制刷新，普通并发合并且不会漏掉核验', async () => {
  let release, historyCalls = 0;
  const requests = [], gate = new Promise(resolve => { release = resolve; });
  const research = { get: async input => {
    requests.push(input);
    return { symbol: input.symbol, section: input.section, source: '东方财富', status: 'empty', fetchedAt: START, checkedAt: START, data: { items: [], total: 0 } };
  } };
  const monitor = new StrategyMonitor({ strategyHistory: async () => { historyCalls++; if (historyCalls === 1) await gate; return bars; } }, () => new Date(START), () => {}, research);
  const first = monitor.load(symbol), ordinary = monitor.load(symbol), submitted = monitor.load(symbol, true, false, true);
  release();
  const [background, combined, refreshed] = await Promise.all([first, ordinary, submitted]);
  assert.equal(background, combined); assert.notEqual(refreshed, background); assert.equal(historyCalls, 2);
  assert.equal(refreshed.notices.status, 'empty'); assert.equal(refreshed.forced, true);
  assert.deepEqual(requests, [{ symbol, section: 'notices', force: true }]);
});

test('只有日线的在途请求也能升级普通公告请求，已有公告的并发请求不重复调用', async () => {
  let release, historyCalls = 0, noticeCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const monitor = new StrategyMonitor({ strategyHistory: async () => { historyCalls++; if (historyCalls === 1) await gate; return bars; } }, () => new Date(START), () => {}, {
    get: async () => { noticeCalls++; return { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: START, data: { items: [], total: 0 } }; }
  });
  const first = monitor.load(symbol), notice = monitor.load(symbol, false, false, true), duplicate = monitor.load(symbol, false, false, true);
  release();
  const [plain, updated, shared] = await Promise.all([first, notice, duplicate]);
  assert.notEqual(plain, updated); assert.equal(updated, shared); assert.equal(historyCalls, 1); assert.equal(noticeCalls, 1);
});

test('force不能复用已在途的force监控，同一旧轮次之后的并发force共享一次刷新', async () => {
  const releases = [];
  const monitor = new StrategyMonitor({ strategyHistory: () => new Promise(resolve => releases.push(() => resolve(bars))) }, () => new Date(START), () => {}, {
    get: async () => ({ symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: START, data: { items: [], total: 0 } }) });
  const first = monitor.load(symbol, true, false, true), second = monitor.load(symbol, true, false, true), shared = monitor.load(symbol, true, false, true);
  assert.equal(releases.length, 1); releases[0](); await first; await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2); releases[1]();
  const [a, b] = await Promise.all([second, shared]); assert.equal(a, b); assert.equal(monitor.nextForced.size, 0);
});

test('独立公告查新成功后立刻替换旧失败监控依据，不被旧失败退避期挡住', async () => {
  const f = noticeFixture(); f.controls.fail = true;
  const failed = await f.load(); assert.equal(failed.notices.status, 'unavailable');
  f.controls.fail = false; f.advance(1000);
  const refreshed = await f.research.get({ symbol, section: 'notices', force: true });
  const recovered = await f.load();
  assert.notEqual(recovered, failed); assert.equal(recovered.notices.status, 'ready');
  assert.equal(recovered.notices.noticeVersion, refreshed.noticeVersion);
  assert.equal(f.research.assertNoticeCurrent(symbol, recovered.notices), true);
  assert.equal(f.calls.notices, 2, '直接采用独立查新成功缓存，无须重复访问公告接口');
});
