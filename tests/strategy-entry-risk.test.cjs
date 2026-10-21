const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState } = require('../core/engine.cjs');
const { cnTime } = require('../core/common.cjs');
const { evaluateEntry } = require('../core/strategy.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');

const symbol = 'sh688578';
function fixture(strategyId = 'short') {
  let now = new Date('2026-09-29T10:00:00+08:00');
  const engine = new Engine(initialState(100000), () => now);
  engine.selectStrategy(symbol, strategyId);
  const quote = (extra = {}) => ({ symbol, name: '隔离事件风险样本', price: 10.1, prevClose: 10.08, open: 10, low: 10, high: 10.2,
    volume: 100000, amount: 3e8, turnover: 4, bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000,
    limitUp: 12.1, limitDown: 8.06, timestamp: now.getTime(), date: cnTime(now).date, ...extra });
  const snapshot = () => {
    const level = { entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, support: 9.7, resistance: 11.5, breakout: false };
    return { source: '隔离未复权日线', fetchedAt: now.getTime(),
      technical: { asOf: '2026-09-28', close: 10.08, ma5: 10.05, previousMa5: 10.02, ma20: 10, previousMa20: 9.99,
        ma60: 9.5, previousMa60: 9.49, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1.5, trend: true, dates: ['2026-09-28'],
        ...level, levels: { short: { ...level }, 'ultra-short': { ...level }, long: { ...level } } },
      notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), checkedAt: now.getTime(), data: { items: [], total: 0 } },
      finance: { symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: now.getTime(), checkedAt: now.getTime(), industryProfile: ordinaryProfile(symbol, now),
        data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', updateDate: '2026-08-20', currency: 'CNY', roe: 12, debtRatio: 45,
          revenueYoY: 8, adjustedProfitYoY: 10, adjustedProfit: 1e8, operatingCash: 1e8 },
          annual: [{ reportDate: '2025-12-31', noticeDate: '2026-03-20', currency: 'CNY', roe: 12 }] } },
      valuation: { symbol, section: 'valuation', source: '东方财富', status: 'ready', fetchedAt: now.getTime(), checkedAt: now.getTime(), data: { quoteTime: now.getTime(), pe: 15, pb: 2 } }
    };
  };
  const evaluate = (q = quote(), snap = snapshot()) => evaluateEntry(engine, symbol, q, snap, undefined, strategyId);
  return { engine, quote, snapshot, evaluate, now: () => now, day: time => { now = new Date(time); } };
}
function withNotice(snapshot, title) {
  snapshot.notices.status = 'ready';
  snapshot.notices.data = { items: [{ id: 'AN202609291234567890', date: '2026-09-29', title, categories: ['临时公告'] }], total: 1 };
  return snapshot;
}

test('执行前用新鲜目录重新匹配原文，不能沿用旧公告通过状态，持仓退出不受影响', () => {
  const f = fixture(), snap = withNotice(f.snapshot(), '关于诉讼结案的公告'), item = snap.notices.data.items[0];
  const text = '本次诉讼已结案，相关义务已全部履行完毕。本次诉讼对公司生产经营未造成重大不利影响。';
  snap.automaticEvidence = { symbol, fetchedAt: +f.now(), documents: [{ id: item.id, issuerSymbol: symbol,
    kind: 'notice', title: item.title, publishedAt: item.date, complete: true, fetchedAt: +f.now(),
    url: 'https://example.com/notice', text, pages: 1,
    pageTexts: [{ page: 1, text, method: 'provider-text', numericEligible: true, complete: true }] }] };
  assert.equal(f.evaluate(f.quote(), snap).buyable, true);
  const stale = structuredClone(snap); stale.notices.fetchedAt -= 300001;
  assert.equal(f.evaluate(f.quote(), stale).buyable, false);
  const revised = structuredClone(snap); revised.notices.data.items[0].title = '关于诉讼结案的更正公告';
  assert.equal(f.evaluate(f.quote(), revised).buyable, false);
  const fresh = structuredClone(snap); fresh.notices.data.items.push({ id: 'AN202609291234567891', date: item.date, title: '关于重大诉讼的公告' }); fresh.notices.data.total++;
  assert.equal(f.evaluate(f.quote(), fresh).buyable, false);
  const before = structuredClone(f.engine.s);
  assert.throws(() => f.engine.strategyEntry({ symbol, strategyId: 'short', quantity: 200 }, f.quote(), fresh), /公告/);
  assert.deepEqual(f.engine.s, before);
  const trade = f.engine.strategyEntry({ symbol, strategyId: 'short', quantity: 200 }, f.quote(), snap);
  assert.equal(trade.strategyPlan.entryRiskEvidence.notices.mode, 'automatic-fulltext');
  assert.ok(trade.strategyPlan.entryRiskEvidence.notices.notices[0].records.length);
  f.day('2026-09-30T10:00:00+08:00');
  f.engine.tick({ [symbol]: f.quote({ price: 9.5, bid: 9.49 }) }, { [symbol]: { error: '公告与日线不可用' } });
  assert.equal(f.engine.positions().length, 0);
});

test('四策略仅在所需风险检查通过时放行，成交冻结公告证据，状态不表述为买入推荐', () => {
  for (const id of ['short', 'ultra-short', 'swing', 'long']) {
    const f = fixture(id), result = f.evaluate();
    assert.equal(result.buyable, true, result.reasons.join('；'));
    assert.equal(result.status, '规则通过 · 可模拟');
    if (['short', 'ultra-short'].includes(id)) assert.equal(result.entryRisk.market.status, 'clear');
    else assert.equal(result.entryRisk.market, null, '波段长线不伪造短线行情阈值通过状态');
    assert.equal(result.entryRisk.notices.status, 'clear');
    assert.equal(result.entryRisk.status, 'clear');
    assert.match(result.reasons.join(''), /公告标题检查/);
    assert.match(result.reasons.join(''), /不代表上涨概率或实际亏损上限/);
    const trade = f.engine.strategyEntry({ symbol, strategyId: id, quantity: result.quantity }, f.quote(), f.snapshot());
    assert.equal(trade.quantity, result.quantity);
    assert.equal(trade.strategyPlan.entryRiskEvidence.status, 'clear');
    assert.equal(trade.strategyPlan.entryRiskEvidence.checkedAt, f.now().getTime());
    assert.equal(trade.strategyPlan.entryRiskEvidence.notices.fetchedAt, f.now().getTime());
    const evidence = structuredClone(trade.strategyPlan.entryRiskEvidence);
    result.entryRisk.notices.status = 'unverified';
    assert.deepEqual(trade.strategyPlan.entryRiskEvidence, evidence, '展示结果变化不改变成交时的核验记录');
    const restored = new Engine(JSON.parse(JSON.stringify(f.engine.s)), f.engine.clock);
    assert.deepEqual(restored.s.trades[0].strategyPlan.entryRiskEvidence, evidence);
  }
});

test('跌停及跌幅门槛优先于旧日线错误，阻止新建仓并保留可用计划价位', () => {
  const f = fixture(), drop = f.quote({ price: 8.06, ask: 8.06, bid: 0, bidSize: 0 });
  const result = f.evaluate(drop);
  assert.equal(result.buyable, false); assert.equal(result.status, '当日风险拦截');
  assert.match(result.reasons.join(''), /跌停/); assert.ok(result.plan);
  const missing = f.evaluate(drop, { error: '日线断线' });
  assert.equal(missing.status, '当日风险拦截');
  assert.match(missing.reasons[0], /跌停/); assert.match(missing.reasons.join(''), /日线断线/);
  const threshold = f.evaluate(f.quote({ price: 9.57 }));
  assert.equal(threshold.entryRisk.market.status, 'blocked');
  const before = structuredClone(f.engine.s);
  assert.throws(() => f.engine.strategyEntry({ symbol, strategyId: 'short', quantity: 200 }, drop, f.snapshot()), /跌停/);
  assert.deepEqual(f.engine.s, before);
});

test('四策略公告缺失、失败、过期与身份错配均暂停建仓，临床和立案标题均不可绕过', () => {
  const mutations = [
    s => { delete s.notices; },
    s => { s.notices.status = 'unavailable'; s.notices.error = '测试断线'; },
    s => { s.notices.status = 'stale'; },
    s => { s.notices.fetchedAt -= 300001; },
    s => { s.notices.symbol = 'sh600519'; },
    s => withNotice(s, '关于临床试验取得积极进展的公告'),
    s => withNotice(s, 'III期临床试验未达到主要研究终点的公告'),
    s => withNotice(s, '关于收到立案告知书的公告')
  ];
  for (const id of ['short', 'ultra-short', 'swing', 'long']) {
    const f = fixture(id);
    for (const mutate of mutations) {
      const snap = f.snapshot(); mutate(snap);
      const result = f.evaluate(f.quote(), snap), before = structuredClone(f.engine.s);
      assert.equal(result.buyable, false, `${id}: ${mutate}`); assert.equal(result.status, '等待公告核验'); assert.ok(result.plan);
      assert.throws(() => f.engine.strategyEntry({ symbol, strategyId: id, quantity: 200 }, f.quote(), snap), /公告/);
      assert.deepEqual(f.engine.s, before);
    }
    const event = f.evaluate(f.quote(), withNotice(f.snapshot(), 'III期临床试验未达到主要研究终点的公告'));
    assert.equal(event.entryRisk.notices.status, 'blocked'); assert.equal(event.entryRisk.notices.notices.length, 1);
  }
});

test('公告适用所有策略，但短线5%阈值不外推波段和长线', () => {
  for (const id of ['short', 'ultra-short', 'swing', 'long']) {
    const f = fixture(id), result = f.evaluate(f.quote({ price: 9.57 }));
    assert.equal(result.buyable, false);
    if (['short', 'ultra-short'].includes(id)) {
      assert.equal(result.entryRisk.market.status, 'blocked'); assert.equal(result.status, '当日风险拦截');
    } else {
      assert.equal(result.entryRisk.market, null); assert.equal(result.entryRisk.status, 'clear');
      assert.equal(result.status, '等待确认', '波段长线仍独立遵守原有盘中确认规则');
      assert.ok(!result.reasons.some(reason => /5%/.test(reason)));
    }
  }
});

test('四策略持仓已有止损在公告与日线均不可用时仍触发和执行退出', () => {
  for (const id of ['short', 'ultra-short', 'swing', 'long']) {
    const f = fixture(id), signal = f.evaluate();
    f.engine.strategyEntry({ symbol, strategyId: id, quantity: signal.quantity }, f.quote(), f.snapshot());
    f.day('2026-09-30T10:00:00+08:00');
    const broken = { error: '日线断线', notices: { status: 'unavailable', error: '公告断线' } };
    const quote = f.quote({ price: 9.5, bid: 9.49 });
    assert.equal(f.evaluate(quote, broken).status, '持仓跟踪');
    f.engine.tick({ [symbol]: quote }, { [symbol]: broken });
    assert.equal(f.engine.positions().length, 0); assert.equal(f.engine.s.trades.at(-1).reason, '止损触发');
    assert.equal(f.engine.s.trades.at(-1).price, 9.48);
  }
});

test('先买后跳空跌停无买盘时无法按止损价退出，恢复流动性按实际盘口成交且亏损可超计划预算', () => {
  // A deterministic execution stress case, not historical backtesting or a return claim.
  const f = fixture(), signal = f.evaluate();
  const buy = f.engine.strategyEntry({ symbol, strategyId: 'short', quantity: signal.quantity }, f.quote(), f.snapshot());
  const plannedLoss = buy.strategyPlan.economics.loss, stop = buy.strategyPlan.stop;
  f.day('2026-09-30T10:00:00+08:00');
  const locked = f.quote({ prevClose: 10.1, open: 8.08, low: 8.08, high: 8.08, price: 8.08, limitDown: 8.08, limitUp: 12.12,
    bid: 0, bidSize: 0, ask: 8.08 });
  const failed = { error: '测试日线不可用', notices: { status: 'unavailable' } };
  f.engine.tick({ [symbol]: locked }, { [symbol]: failed });
  assert.equal(f.engine.s.trades.length, 1); assert.equal(f.engine.positions()[0].quantity, buy.quantity);
  assert.equal(f.engine.s.risks[symbol].pendingExit, '止损触发'); assert.match(f.engine.s.risks[symbol].note, /一档数量不足/);
  const restored = new Engine(JSON.parse(JSON.stringify(f.engine.s)), f.engine.clock);
  restored.tick({ [symbol]: locked }, { [symbol]: failed });
  assert.equal(restored.s.trades.length, 1, '重启不能凭空产生跌停买盘');
  f.day('2026-09-30T10:01:00+08:00');
  const liquid = f.quote({ prevClose: 10.1, price: 8.12, open: 8.08, low: 8.08, high: 8.12, bid: 8.12,
    bidSize: buy.quantity, ask: 8.13, limitDown: 8.08, limitUp: 12.12 });
  restored.tick({ [symbol]: liquid }, { [symbol]: failed });
  const sell = restored.s.trades.at(-1);
  assert.equal(restored.positions().length, 0); assert.equal(sell.reason, '止损触发');
  assert.equal(sell.price, 8.11); assert.ok(sell.price < stop);
  assert.ok(-sell.pnl > plannedLoss); assert.ok(-sell.pnl > signal.budget);
  assert.equal(restored.stats().realized, sell.pnl); assert.equal(restored.stats().pnl, sell.pnl);
});
