const test = require('node:test');
const assert = require('node:assert/strict');
const { StrategyMonitor } = require('../core/strategy-monitor.cjs');
const { prepareHistory } = require('../core/daily-history.cjs');
const { CorporateService } = require('../core/corporate-service.cjs');

const SYMBOL = 'sh600519', START = Date.parse('2026-10-22T09:29:50+08:00');
function fixture(at = START) {
  let now = at, version = 1;
  const calls = [], controls = { yesterdayQuote: false, failNotices: false, gates: {} };
  const bars = Array.from({ length: 80 }, (_, index) => ({ date: new Date(Date.parse('2026-10-21') - (79 - index) * 86400000).toISOString().slice(0, 10),
    open: 10, close: 10, high: 10.2, low: 9.8, volume: 10000 }));
  const history = prepareHistory(SYMBOL, 'stock', { symbol: SYMBOL, bars, source: '隔离测试行情', provider: 'test', adjustment: '未复权', fetchedAt: START - 3600000 }, at);
  const request = async (section, force) => { calls.push({ section, force, at: now }); if (controls.gates[section]) await controls.gates[section](); };
  const research = {
    noticeVersion: () => ({ version }),
    getFinanceWithIndustry: async ({ force }) => {
      await request('finance', force);
      return { symbol: SYMBOL, status: 'ready', fetchedAt: now, data: { latest: { reportDate: '2026-06-30' } },
        industryProfile: { status: 'ready', fetchedAt: now, data: { industry: '食品饮料' } } };
    },
    get: async ({ section, force }) => {
      await request(section, force);
      if (section === 'notices' && controls.failNotices) throw Error('公告接口 501');
      return { symbol: SYMBOL, section, status: section === 'notices' ? 'empty' : 'ready', fetchedAt: now,
        ...(section === 'notices' ? { noticeVersion: version, data: { items: [], total: 0 } } : { data: { quoteTime: controls.yesterdayQuote ? START - 86400000 : now } }) };
    }
  };
  const corporate = { symbols: () => [SYMBOL], fromDate: () => '2026-10-08', getSnapshot: async (_symbol, force) => {
    await request('corporate', force);
    return { symbol: SYMBOL, status: 'ready', fetchedAt: now, coverageStart: '2026-10-08', coverageEnd: '2026-10-22', coverageComplete: true, events: [] };
  } };
  const monitor = new StrategyMonitor({ strategyHistory: async (_symbol, _signal, _metadata, force) => { await request('daily', force); return history; } }, () => new Date(now), () => {}, research, corporate);
  return { monitor, calls, controls, corporate, now: () => now, advance: ms => { now += ms; }, setVersion: value => { version = value; } };
}

test('9:29资料完整准备后，9:30核验只取当日报价，不重新请求任何资料模块', async () => {
  const f = fixture(), snapshot = await f.monitor.prepare(SYMBOL, true, true), initial = structuredClone(f.calls), quoted = [], checks = [];
  const engine = { s: { lots: [], trades: [], agency: { epoch: 'preopen-isolated', groups: [{ id: 'long', members: [{ symbol: SYMBOL, reconciliation: { status: 'clear' } }] }] } },
    agencyPrepare: (symbol, quote, value) => { checks.push({ symbol, quote, snapshot: value }); return null; } };
  const service = new CorporateService({ getEngine: () => engine, getMonitor: () => f.monitor, transaction: fn => fn(), clock: f.now,
    market: { quotes: async symbols => { quoted.push(symbols); return { [SYMBOL]: { symbol: SYMBOL, date: '2026-10-22' } }; } } });
  f.advance(10000);
  assert.equal((await service.poll()).clear, 1);
  assert.deepEqual(f.calls, initial); assert.deepEqual(quoted, [[SYMBOL]]);
  assert.equal(checks[0].snapshot, snapshot); assert.equal(checks[0].snapshot.fetchedAt, START - 3600000);
  assert.equal(checks[0].snapshot.notices.fetchedAt, START); assert.equal(engine.s.trades.length, 0);
});

test('预备提前30秒仅续验将到期模块，财报与日线原始时间保持不变', async () => {
  const f = fixture(), first = await f.monitor.prepare(SYMBOL, true, true);
  f.advance(60001);
  const renewed = await f.monitor.prepare(SYMBOL, true, true);
  assert.equal(f.calls.filter(item => item.section === 'valuation').length, 2);
  assert.equal(f.calls.filter(item => item.section === 'finance').length, 1);
  assert.equal(f.calls.filter(item => item.section === 'notices').length, 1);
  assert.equal(f.calls.filter(item => item.section === 'corporate').length, 1);
  assert.equal(renewed.finance, first.finance); assert.equal(renewed.notices, first.notices);
  assert.equal(renewed.fetchedAt, first.fetchedAt); assert.equal(renewed.valuation.fetchedAt, f.now());
  assert.equal(f.calls.filter(item => item.section === 'valuation').at(-1).force, true);
  f.advance(210000);
  const late = await f.monitor.prepare(SYMBOL, true, true);
  assert.equal(f.calls.filter(item => item.section === 'notices').length, 2);
  assert.equal(f.calls.filter(item => item.section === 'corporate').length, 2);
  assert.equal(late.finance, first.finance); assert.equal(late.fetchedAt, first.fetchedAt);
});

test('慢日线不会串行拖延财务估值公告及公司行为的提前获取', async () => {
  const f = fixture(); let release;
  f.controls.gates.daily = () => new Promise(resolve => { release = resolve; });
  const pending = f.monitor.prepare(SYMBOL, true, true);
  assert.deepEqual(new Set(f.calls.map(item => item.section)), new Set(['daily', 'finance', 'valuation', 'notices', 'corporate']));
  release(); await pending; assert.ok(f.monitor.peekPrepared(SYMBOL, true, true));
});

test('盘前昨日估值区分等待行情并限制重试，开盘立即独立刷新，不续期旧报价', async () => {
  const f = fixture(); f.controls.yesterdayQuote = true;
  const first = await f.monitor.prepare(SYMBOL, true, true);
  assert.equal(f.monitor.preparationState(SYMBOL, true, true).status, 'waiting-live');
  assert.equal(f.monitor.peekPrepared(SYMBOL, true, true), null);
  f.advance(5000); await f.monitor.prepare(SYMBOL, true, true);
  assert.equal(f.calls.filter(item => item.section === 'valuation').length, 1);
  assert.equal(first.valuation.data.quoteTime, START - 86400000);
  f.advance(5000); f.controls.yesterdayQuote = false;
  const open = await f.monitor.load(SYMBOL, false, true, true);
  assert.equal(f.calls.filter(item => item.section === 'valuation').length, 2);
  assert.equal(f.calls.filter(item => item.section === 'finance').length, 1);
  assert.equal(open.valuation.data.quoteTime, f.now()); assert.equal(f.monitor.preparationState(SYMBOL, true, true).status, 'prepared');
});

test('快速复用逐项检查真实TTL、行业有效性、公告版本和公司行为覆盖日期', async () => {
  const changes = [value => { value.finance.fetchedAt = START - 21600001; }, value => { value.finance.industryProfile.status = 'unavailable'; },
    value => { value.valuation.data.quoteTime = START - 90001; }, value => { value.notices.fetchedAt = START - 300001; },
    value => { value.corporateActions.coverageEnd = '2026-10-21'; }, value => { value.corporateActions.coverageStart = '2026-10-09'; },
    value => { value.dailyEvidence = null; }, value => { value.fetchedAt = START + 1; }];
  for (const change of changes) {
    const f = fixture(); await f.monitor.prepare(SYMBOL, true, true);
    const old = structuredClone(f.monitor.snapshots[SYMBOL]); change(old); f.monitor.snapshots[SYMBOL] = old;
    assert.equal(f.monitor.peekPrepared(SYMBOL, true, true), null, change.toString());
    assert.notEqual(f.monitor.preparationState(SYMBOL, true, true).status, 'prepared');
  }
  const f = fixture(); await f.monitor.prepare(SYMBOL, true, true); f.setVersion(2);
  assert.equal(f.monitor.peekPrepared(SYMBOL, true, true), null);
  const updated = await f.monitor.load(SYMBOL, false, true, true);
  assert.equal(updated.notices.noticeVersion, 2); assert.equal(f.calls.filter(item => item.section === 'daily').length, 1);
});

test('提前续验失败明确取消就绪，失败冷却不改证据时间，其他模块保持原值', async () => {
  const f = fixture(), first = await f.monitor.prepare(SYMBOL, true, true);
  f.advance(270001); f.controls.failNotices = true;
  const failed = await f.monitor.prepare(SYMBOL, true, true);
  assert.equal(f.monitor.peekPrepared(SYMBOL, true, true), null); assert.equal(f.monitor.preparationState(SYMBOL, true, true).status, 'error');
  assert.equal(failed.finance, first.finance); assert.equal(failed.fetchedAt, first.fetchedAt);
  f.advance(15000); await f.monitor.prepare(SYMBOL, true, true);
  assert.equal(f.calls.filter(item => item.section === 'notices').length, 2);
});

test('普通仅日线观察不会丢弃已经准备的财报公告及公司行为模块', async () => {
  const f = fixture(), first = await f.monitor.prepare(SYMBOL, true, true); f.advance(60000);
  const observed = await f.monitor.load(SYMBOL);
  assert.equal(observed.notices, first.notices); assert.equal(observed.finance, first.finance);
  assert.equal(observed.corporateActions, first.corporateActions); assert.ok(f.monitor.peekPrepared(SYMBOL, true, true));
});

test('自动开盘准备忽略已停用的公告变化，当前日线失败仍在提交前撤销准备', async () => {
  for (const dailyFailure of [false, true]) {
  const f = fixture(); await f.monitor.prepare(SYMBOL, true, true); let release;
  const member = { symbol: SYMBOL, reconciliation: { status: 'clear' } };
  const engine = { s: { lots: [], trades: [], agency: { epoch: 'notice-isolated', groups: [{ id: 'long', members: [member] }] } },
    agencyPrepare: (_symbol, _quote, snapshot) => {
      const reason = snapshot.error || '';
      member.automaticCheck = { status: reason ? 'waiting' : 'clear', reason };
      return reason;
    } };
  const service = new CorporateService({ getEngine: () => engine, getMonitor: () => f.monitor, transaction: fn => fn(), clock: f.now,
    market: { quotes: () => new Promise(resolve => { release = resolve; }) } });
  const pending = service.verifyOne(SYMBOL);
  f.setVersion(2);
  if (dailyFailure) f.monitor.snapshots[SYMBOL] = { ...f.monitor.snapshots[SYMBOL], error: '当前日线版本已失效' };
  release({});
  const result = await pending;
  assert.equal(result.status, dailyFailure ? 'waiting' : 'clear');
  if (dailyFailure) assert.match(result.reason, /日线版本已失效/);
  else assert.equal(result.reason, '');
  assert.equal(member.automaticCheck.status, dailyFailure ? 'waiting' : 'clear');
  }
});

test('已披露财报仍待同步以及慢模块结束时过期的估值均不能标记准备完成', async () => {
  const f = fixture(); await f.monitor.prepare(SYMBOL, true, true);
  f.monitor.snapshots[SYMBOL].financeReportSync = { status: 'pending', attemptedAt: f.now() };
  assert.equal(f.monitor.peekPrepared(SYMBOL, true, true), null);
  assert.match(f.monitor.preparationState(SYMBOL, true, true).reason, /新财报/);
  delete f.monitor.snapshots[SYMBOL].financeReportSync;
  f.advance(90001);
  assert.equal(f.monitor.peekPrepared(SYMBOL, true, true), null);
  assert.notEqual(f.monitor.preparationState(SYMBOL, true, true).status, 'prepared');
});

test('公司行为独立查新结果即时撤销旧就绪，纯获取时间更新不误阻塞', async () => {
  const f = fixture(), first = await f.monitor.prepare(SYMBOL, true, true);
  f.corporate.latestEvidence = new Map(); f.advance(1000);
  f.corporate.latestEvidence.set(SYMBOL, { ...first.corporateActions, fetchedAt: f.now(), acquisition: { duration: 50 } });
  assert.equal(f.monitor.peekPrepared(SYMBOL, true, true), first, '相同事实只是重新获取无需撤销');
  for (const replacement of [{ ...first.corporateActions, fetchedAt: f.now(), status: 'unavailable', error: '公司行为查新失败' },
    { ...first.corporateActions, fetchedAt: f.now(), events: [{ eventId: 'corrected-event', cashPerShare: 1 }] }]) {
    f.corporate.latestEvidence.set(SYMBOL, replacement);
    assert.equal(f.monitor.peekPrepared(SYMBOL, true, true), null);
    assert.notEqual(f.monitor.preparationState(SYMBOL, true, true).status, 'prepared');
  }
});
