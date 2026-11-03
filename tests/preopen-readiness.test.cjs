'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const { preparationState, preopenPriceReference, noticePreparationOpen } = require('../core/preparation-state.cjs');
const { MARKET_REGIME_POLICY } = require('../core/market-regime.cjs');
const { ADAPTIVE_ENTRY_TEMPLATE } = require('../core/strategy-profiles.cjs');
const symbol = 'sz000001', time = text => Date.parse(`2026-10-22T${text}+08:00`);
function fixture() {
  const engine = new Engine(initialState(), () => new Date(time('09:30:05')));
  engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' });
  engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const member = engine.s.agency.groups.find(group => group.id === 'swing').members[0];
  const evidence = { status: 'prepared', reason: '历史资料已准备', preparedAt: time('09:29:00'), checkedAt: time('09:30:05'), components: [] };
  const monitor = { preparationState: () => ({ ...evidence }), snapshots: { [symbol]: { technical: { asOf: '2026-10-21', close: 10 } } } };
  const quote = { symbol, price: 10.1, prevClose: 10, source: 'test', timestamp: time('09:30:05'), date: '2026-10-22', canTrade: true };
  member.automaticCheck = { status: 'clear' };
  member.exitPriceBasis = { date: '2026-10-22', checkedAt: time('09:30:05'), dailyAsOf: '2026-10-21', dailyClose: 10, prevClose: 10 };
  return { engine, member, monitor, evidence, quote };
}

test('盘前资料状态与实时就绪分离，不授予交易权限或改变策略确认时长', () => {
  const f = fixture(), before = structuredClone(f.engine.s);
  assert.equal(preparationState(f.engine, f.monitor, {}, time('09:20:00')).members[0].status, 'prepared');
  assert.equal(preparationState(f.engine, f.monitor, {}, time('09:30:05')).members[0].status, 'waiting-live');
  const ready = preparationState(f.engine, f.monitor, { [symbol]: f.quote }, time('09:30:05'));
  assert.equal(ready.ready, 1); assert.match(ready.members[0].reason, /仍需市场环境、策略信号/);
  assert.deepEqual(f.engine.s, before); assert.equal(MARKET_REGIME_POLICY.confirmationMs, 120000);
  assert.equal(ADAPTIVE_ENTRY_TEMPLATE.confirmMs, 60000);
});

test('过期或竞价报价、仅展示来源、旧价格基准均不能显示开盘资料齐备', () => {
  for (const change of [f => { f.quote.timestamp = time('09:29:59'); }, f => { f.quote.timestamp = time('09:28:00'); },
    f => { f.quote.canTrade = false; }, f => { f.quote.prevClose = 9; },
    f => { f.member.exitPriceBasis.dailyClose = 9; }, f => { f.member.awaitingVerification = true; },
    f => { f.member.reconciliation.status = 'pending'; }]) {
    const f = fixture(); change(f);
    assert.equal(preparationState(f.engine, f.monitor, { [symbol]: f.quote }, time('09:30:05')).ready, 0);
  }
});

test('日线资料过期导致失效时即刻退出就绪，暂停和停止状态保持', () => {
  const f = fixture();
  f.evidence.status = 'error'; f.evidence.reason = '完整日线已过期';
  assert.equal(preparationState(f.engine, f.monitor, { [symbol]: f.quote }, time('09:30:05')).failed, 1);
  f.evidence.status = 'prepared'; f.engine.agencyMode({ strategyId: 'swing', mode: 'paused' });
  assert.match(preparationState(f.engine, f.monitor, { [symbol]: f.quote }, time('09:30:05')).members[0].reason, /暂停新开仓/);
  f.engine.agencyMode({ strategyId: 'swing', mode: 'stopped' });
  assert.equal(preparationState(f.engine, f.monitor, { [symbol]: f.quote }, time('09:30:05')).inactive, 1);
});

test('盘前资料齐备也不能掩盖原待对账及核验阻断', () => {
  const f = fixture();
  f.member.reconciliation = { status: 'pending', reason: '公司行为需人工对账' };
  let status = preparationState(f.engine, f.monitor, {}, time('09:20:00'));
  assert.equal(status.failed, 1); assert.match(status.members[0].reason, /公司行为需人工对账/);
  f.member.reconciliation = { status: 'clear', reason: '' };
  f.member.automaticCheck = { status: 'blocked', reason: '价格基准不一致' };
  status = preparationState(f.engine, f.monitor, {}, time('09:20:00'));
  assert.equal(status.failed, 1); assert.match(status.members[0].reason, /价格基准不一致/);
});

test('开盘撮合拒绝竞价或午间旧盘口，收到本场连续交易报价后正常成交', () => {
  for (const [current, prior] of [['09:30:00', '09:29:59'], ['13:00:00', '12:59:59']]) {
    const engine = new Engine(initialState(), () => new Date(time(current)));
    const quote = { symbol, price: 10, prevClose: 10, source: 'test', timestamp: time(prior), date: '2026-10-22',
      volume: 10000, open: 10, bid: 9.99, ask: 10, bidSize: 1000, askSize: 1000, limitUp: 11, limitDown: 9 };
    const before = structuredClone(engine.s);
    assert.throws(() => engine.execute({ symbol, side: 'buy', quantity: 100 }, quote), /连续竞价时段的新报价/);
    assert.deepEqual(engine.s, before);
    const trade = engine.execute({ symbol, side: 'buy', quantity: 100 }, { ...quote, timestamp: time(current) });
    assert.equal(trade.quantity, 100); assert.equal(engine.s.trades.length, 1);
  }
});

test('竞价预检只使用当日参考价，虚拟成交价和盘口不授予成交权限', () => {
  const quote = { symbol, provider: 'tencent', source: '腾讯财经', date: '2026-10-22', timestamp: time('09:20:00'),
    prevClose: 9.9, limitUp: 10.89, limitDown: 8.91, price: 300, volume: 0, canTrade: false };
  const actions = [{ symbol, status: 'ready', terms: { exDate: '2026-10-22', cashPerShare: 0.1, bonusPerShare: 0, transferPerShare: 0 } }];
  const daily = { asOf: '2026-10-21', close: 10 };
  assert.equal(preopenPriceReference(symbol, quote, daily, actions, time('09:20:01')).status, 'checked');
  assert.equal(preopenPriceReference(symbol, quote, daily, [], time('09:20:01')).status, 'mismatch');
  for (const extra of [{ date: '2026-10-21' }, { timestamp: time('09:10:00') }, { timestamp: time('09:20:02') }, { provider: 'sina' }, { limitUp: null }])
    assert.equal(preopenPriceReference(symbol, { ...quote, ...extra }, daily, actions, time('09:20:01')).status, 'waiting');
  assert.equal(preopenPriceReference(symbol, quote, daily, actions, time('09:30:00')).status, 'waiting');
});

test('公告独立查新从交易日8:45开始，午间保持，未知日历和休市日不启用', () => {
  for (const text of ['08:45:00', '09:20:00', '09:30:00', '12:00:00', '14:59:59']) assert.equal(noticePreparationOpen(time(text)), true);
  for (const text of ['08:44:59', '15:00:00']) assert.equal(noticePreparationOpen(time(text)), false);
  for (const date of ['2026-10-24', '2026-10-01', '2027-01-04']) assert.equal(noticePreparationOpen(Date.parse(`${date}T09:20:00+08:00`)), false);
});
