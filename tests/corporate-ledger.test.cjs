const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { taxRate, replayHoldings, processCorporateActions } = require('../core/corporate-ledger.cjs');
const { CorporateService } = require('../core/corporate-service.cjs');
const { cnTime } = require('../core/common.cjs');

function fixture() {
  let now = new Date('2026-09-28T10:00:00+08:00');
  const engine = new Engine(initialState(100000), () => now);
  const quote = (extra = {}) => ({ symbol: 'sz000001', name: '权益测试', price: 10.1, prevClose: 10.05, open: 10, low: 10, high: 10.2,
    volume: 100000, bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05,
    timestamp: now.getTime(), date: cnTime(now).date, ...extra });
  const snapshot = () => ({ fetchedAt: now.getTime(), technical: { asOf: '2026-09-27', close: 10.05, ma5: 10, ma20: 10, ma60: 9.5,
    atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true, breakout: false, support: 9.7, resistance: 11.5,
    entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: ['2026-09-27'] },
    notices: { symbol: 'sz000001', section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } } });
  engine.agencyTransfer({ strategyId: 'swing', amount: 50000 });
  engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'add' }); engine.agencyMode({ strategyId: 'swing', mode: 'running' });
  const buy = () => engine.agencyExecute({ strategyId: 'swing', symbol: 'sz000001', action: 'buy', targetPercent: 20,
    decisionId: `buy-${engine.s.trades.length}`, expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision }, quote(), snapshot());
  const event = extra => ({ eventId: 'cash-20260929', noticeIds: ['AN123456789012'], sourceUrl: 'https://example.test/implementation',
    status: 'implemented', recordDate: '2026-09-29', exDate: '2026-09-30', payDate: '2026-10-08', listingDate: null,
    cashPerShare: 0.1, bonusPerShare: 0, transferPerShare: 0, taxPolicy: 'cn-individual-deferred-v1', ...extra });
  const source = events => ({ corporateActions: { symbol: 'sz000001', status: 'ready', fetchedAt: now.getTime(), coverageComplete: true,
    coverageStart: '2026-01-01', coverageEnd: cnTime(now).date, events: events || [event()], notices: [] } });
  const process = events => engine.agencyProcessCorporateActions('sz000001', quote(), source(events));
  const group = () => engine.agencyState().groups.find(group => group.id === 'swing');
  const sell = quantity => engine.execute({ symbol: 'sz000001', side: 'sell', quantity }, quote());
  const day = (date, time = '10:00:00') => { now = new Date(`${date}T${time}+08:00`); };
  return { engine, quote, snapshot, buy, event, source, process, group, sell, day };
}

test('巨潮目录证据保留原来源和链接，缺失实施资料不改变账户权益', () => {
  const f = fixture(), source = f.source([]);
  const notice = { id: 'CN1225601360', title: '权益分派实施公告', date: '2026-09-28', corporateStage: 'implemented',
    source: '巨潮资讯', url: 'https://www.cninfo.com.cn/new/disclosure/detail?stockCode=000001&announcementId=1225601360' };
  Object.assign(source.corporateActions, { status: 'unavailable', coverageComplete: false, notices: [notice] });
  const cash = f.engine.s.cash, lots = structuredClone(f.engine.s.lots);
  const result = f.engine.agencyProcessCorporateActions('sz000001', f.quote(), source);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.evidence, [{ id: notice.id, title: notice.title, date: notice.date, url: notice.url, source: '巨潮资讯' }]);
  assert.equal(f.engine.s.cash, cash); assert.deepEqual(f.engine.s.lots, lots);
  assert.equal(f.engine.s.agency.corporateEvents.length, 0); assert.equal(validState(f.engine.s), true);
});

test('现金分红分登记、除息应收、到账与卖出扣税，收益恒等式及可用资金一致', () => {
  const f = fixture(), trade = f.buy(), quantity = trade.quantity, initialCash = f.engine.s.cash;
  assert.equal(f.process().status, 'clear'); assert.equal(f.engine.s.agency.corporateActions[0].status, 'scheduled');
  f.day('2026-09-29'); f.process(); assert.equal(f.engine.s.agency.corporateActions[0].registeredAt, undefined);
  f.day('2026-09-29', '15:01:00'); f.process(); assert.equal(f.engine.s.agency.corporateActions[0].status, 'registered');
  const oldStop = f.engine.s.risks.sz000001.stop;
  f.day('2026-09-30'); f.process();
  assert.equal(f.engine.s.cash, initialCash); assert.equal(f.group().receivable, quantity * 10);
  assert.equal(f.group().taxReserve, quantity * 2); assert.equal(f.engine.s.risks.sz000001.stop, Math.round((oldStop - 0.1) * 100) / 100);
  assert.equal(f.group().availableCash, f.group().cash - quantity * 2);
  let stats = f.engine.stats(); assert.equal(stats.pnl, stats.realized + stats.unrealized + stats.receivable - stats.taxReserve);
  f.day('2026-10-08'); f.process(); assert.equal(f.engine.s.cash, initialCash + quantity * 10); assert.equal(f.group().receivable, 0);
  const sale = f.sell(quantity);
  assert.equal(f.engine.s.cash, initialCash + quantity * 8 + sale.gross - sale.fees.total);
  assert.equal(f.group().taxReserve, 0); assert.equal(f.engine.s.agency.corporateEvents[0].taxPaid, quantity * 2);
  stats = f.engine.stats(); assert.equal(stats.pnl, stats.realized + stats.unrealized + stats.receivable - stats.taxReserve); assert.equal(validState(f.engine.s), true);
});

test('登记后减仓按完整成交历史补权益，已清仓和移出成员仍归原周期', () => {
  const f = fixture(), trade = f.buy();
  f.day('2026-09-30'); f.sell(trade.quantity); f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'remove' });
  const before = f.engine.s.cash; assert.equal(f.engine.s.lots.length, 0);
  f.day('2026-10-08'); assert.equal(f.process().status, 'clear');
  assert.equal(f.engine.s.cash, before + trade.quantity * 8); assert.equal(f.group().cycles[0].dividends, trade.quantity * 8);
  assert.equal(f.engine.s.agency.corporateActions[0].entitlements[0].quantity, trade.quantity);
  assert.ok(f.engine.agencyCorporateSymbols().includes('sz000001')); assert.equal(validState(f.engine.s), true);
});

test('到账前卖出只锁定应交税，到账时一次净结算且不重复扣税', () => {
  const f = fixture(), trade = f.buy(); f.day('2026-09-30'); f.process();
  const sale = f.sell(100); assert.equal(f.engine.s.agency.corporateEvents.length, 0);
  const before = f.engine.s.cash; f.day('2026-10-08'); f.process();
  assert.equal(f.engine.s.cash, before + trade.quantity * 10 - 200);
  assert.equal(f.engine.s.agency.corporateEvents[0].taxPaid, 200);
  f.process(); assert.equal(f.engine.s.cash, before + trade.quantity * 10 - 200); assert.equal(validState(f.engine.s), true);
});

test('重启及重复轮询不重记现金股份或修改决策版本', () => {
  const f = fixture(); f.buy(); f.day('2026-10-08'); f.process();
  const restored = new Engine(structuredClone(f.engine.s), f.engine.clock), cash = restored.s.cash, revision = restored.s.agency.revision;
  const result = restored.agencyProcessCorporateActions('sz000001', f.quote(), f.source());
  assert.equal(result.changed, false); assert.equal(restored.s.cash, cash); assert.equal(restored.s.agency.revision, revision); assert.equal(validState(restored.s), true);
});

test('空仓候选资料异常只拦自身，不冻结整个策略权益和划拨', () => {
  const f = fixture(); f.day('2026-10-08');
  const result = f.process([f.event({ payDate: null })]);
  assert.equal(result.status, 'blocked'); assert.equal(result.affectsEquity, false); assert.equal(f.group().comparable, true);
  assert.equal(f.group().members[0].reconciliation.status, 'pending'); assert.equal(f.engine.stats().comparable, true);
  assert.doesNotThrow(() => f.engine.agencyTransfer({ strategyId: 'swing', amount: -100 }));
});

test('历史已卖出且登记日前无权益的异常也不污染整组净值', () => {
  const f = fixture(), buy = f.buy(); f.day('2026-09-29'); f.sell(buy.quantity);
  f.day('2026-10-09'); const result = f.process([f.event({ recordDate: '2026-09-30', exDate: '2026-10-08', payDate: null })]);
  assert.equal(result.affectsEquity, false); assert.equal(f.group().comparable, true);
});

test('缺字段、缺历史覆盖和实施更正不会部分变更资金或计划', () => {
  const f = fixture(); f.buy(); f.day('2026-10-08');
  const cash = f.engine.s.cash, risk = structuredClone(f.engine.s.risks), lots = structuredClone(f.engine.s.lots);
  assert.equal(f.process([f.event({ payDate: null })]).status, 'blocked'); assert.equal(f.engine.s.cash, cash); assert.deepEqual(f.engine.s.risks, risk); assert.deepEqual(f.engine.s.lots, lots);
  assert.equal(f.process().status, 'clear');
  const posted = f.engine.s.cash, stopped = structuredClone(f.engine.s.risks);
  assert.equal(f.process([f.event({ cashPerShare: 0.2 })]).status, 'blocked'); assert.equal(f.engine.s.cash, posted); assert.deepEqual(f.engine.s.risks, stopped);
  const short = f.source(); short.corporateActions.coverageStart = '2026-10-01';
  assert.equal(f.engine.agencyProcessCorporateActions('sz000001', f.quote(), short).status, 'blocked'); assert.equal(f.engine.s.cash, posted);
});

test('自动账务核验后仍要求新鲜日线及当日除息价格基准一致', () => {
  const f = fixture(); f.buy(); f.day('2026-09-30');
  const snap = { ...f.snapshot(), ...f.source() }; snap.technical.asOf = '2026-09-29'; snap.technical.dates = ['2026-09-29'];
  assert.match(f.engine.agencyAutomaticBlock('sz000001', f.quote({ prevClose: 8 }), snap), /价格基准/);
  assert.equal(f.engine.agencyAutomaticBlock('sz000001', f.quote({ prevClose: 9.95 }), snap), null);
  snap.fetchedAt -= 180001; assert.match(f.engine.agencyAutomaticBlock('sz000001', f.quote({ prevClose: 9.95 }), snap), /新鲜日线/);
});

test('明确免税转增新增独立上市日，原有股份仍可卖且总成本守恒', () => {
  const f = fixture(), trade = f.buy(), cost = f.engine.s.lots[0].cost;
  const event = f.event({ cashPerShare: 0, transferPerShare: 1, transferTaxExempt: true, payDate: null, listingDate: '2026-10-09' });
  f.day('2026-09-30'); assert.equal(f.process([event]).status, 'clear');
  assert.equal(f.engine.positions()[0].quantity, trade.quantity * 2); assert.equal(f.engine.positions()[0].available, trade.quantity);
  assert.equal(f.engine.s.lots.reduce((sum, lot) => sum + lot.cost, 0), cost);
  assert.throws(() => f.sell(trade.quantity * 2), /可卖数量/);
  f.day('2026-10-09'); assert.equal(f.engine.positions()[0].available, trade.quantity * 2);
  const restored = new Engine(structuredClone(f.engine.s), f.engine.clock); assert.equal(restored.positions()[0].available, trade.quantity * 2); assert.equal(validState(restored.s), true);
});

test('送股、税源未知转增、混合派息和碎股均留异常不改持仓', () => {
  for (const extra of [{ bonusPerShare: 0.1 }, { cashPerShare: 0, transferPerShare: 1, listingDate: '2026-10-09' },
    { transferPerShare: 1, transferTaxExempt: true, listingDate: '2026-10-09' }, { cashPerShare: 0, transferPerShare: 0.00001, transferTaxExempt: true, listingDate: '2026-10-09' }]) {
    const f = fixture(); f.buy(); f.day('2026-10-08'); const lots = structuredClone(f.engine.s.lots), cash = f.engine.s.cash;
    assert.equal(f.process([f.event(extra)]).status, 'blocked'); assert.deepEqual(f.engine.s.lots, lots); assert.equal(f.engine.s.cash, cash);
  }
});

test('改事件编号不能重复记同一登记日或公告批次', () => {
  const f = fixture(); f.buy(); f.day('2026-10-08'); f.process(); const cash = f.engine.s.cash;
  assert.equal(f.process([f.event(), f.event({ eventId: 'other-id' })]).status, 'blocked'); assert.equal(f.engine.s.cash, cash);
});

test('登记日重放包含历史手工送转，但取得日未明确的送转股份不猜股息税', () => {
  const f = fixture(), trade = f.buy(); f.day('2026-09-29');
  f.engine.agencyReconcile({ strategyId: 'swing', symbol: 'sz000001', eventId: 'old-transfer', evidence: '历史实施公告与权益记录已核对',
    recordDate: '2026-09-28', effectiveDate: '2026-09-29', shareNumerator: 2, shareDenominator: 1, riskPriceFactor: 0.5 });
  assert.equal(replayHoldings(f.engine.s, 'sz000001', '2026-09-29').lots[0].quantity, trade.quantity * 2);
  f.day('2026-10-08'); const cash = f.engine.s.cash, result = f.process();
  assert.equal(result.status, 'blocked'); assert.match(result.reason, /取得日期/); assert.equal(f.engine.s.cash, cash);
});

test('按自然月与年对应日期计算递延税率，超过期限才切换档位', () => {
  assert.throws(() => taxRate('2026-01-31', '2026-02-28'), /月末/); assert.throws(() => taxRate('2026-01-31', '2026-03-01'), /月末/);
  assert.equal(taxRate('2026-01-31', '2026-03-04'), 0.1);
  assert.equal(taxRate('2025-09-29', '2026-09-29'), 0.1); assert.equal(taxRate('2025-09-29', '2026-09-30'), 0);
});

test('同日卖出后回买有税务权益的股票会被拒绝，退出与已有扣税保留', () => {
  const f = fixture(), buy = f.buy(); f.day('2026-10-08'); f.process(); f.sell(buy.quantity);
  f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'remove' });
  const before = structuredClone(f.engine.s);
  assert.throws(() => f.engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 100 }, f.quote()), /同日回买/);
  assert.deepEqual(f.engine.s, before); assert.equal(f.engine.s.trades.at(-1).side, 'sell'); assert.equal(validState(f.engine.s), true);
});

test('迟到的公司行为发现历史同日买卖时不能按逐笔FIFO错误自动扣税', () => {
  const f = fixture(), buy = f.buy(); f.day('2026-09-30'); f.sell(buy.quantity);
  f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'remove' });
  f.engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 100 }, f.quote());
  const cash = f.engine.s.cash; f.day('2026-10-08'); const result = f.process();
  assert.equal(result.status, 'blocked'); assert.match(result.reason, /日终净额/); assert.equal(f.engine.s.cash, cash);
  assert.equal(f.engine.s.agency.corporateEvents.length, 0); assert.equal(f.group().comparable, false);
});

test('已登记方案撤销或退回预案均保留旧账并暂停，不能静默当成无事件', () => {
  for (const status of ['planned', 'cancelled']) {
    const f = fixture(); f.buy(); f.day('2026-10-08'); f.process(); const cash = f.engine.s.cash;
    const result = f.process([f.event({ status })]); assert.equal(result.status, 'blocked'); assert.equal(f.engine.s.cash, cash);
    assert.equal(f.engine.s.agency.corporateActions[0].status, 'exception'); assert.equal(f.group().comparable, false);
  }
});

test('自动登记和自动除息阶段都拒绝同批手工加款，不产生应收与现金双记', () => {
  for (const date of ['2026-09-29', '2026-09-30']) {
    const f = fixture(); f.buy(); f.day(date, '15:01:00'); f.process(); const before = structuredClone(f.engine.s);
    assert.throws(() => f.engine.agencyReconcile({ strategyId: 'swing', symbol: 'sz000001', eventId: 'manual-copy', recordDate: '2026-09-29',
      effectiveDate: date, cashAmount: 10, evidence: '尝试同一批次权益重复手工补账', riskPriceFactor: 0.99 }), /已有自动账务/);
    assert.deepEqual(f.engine.s, before);
  }
});

test('全量历史核验通过不再被最近30条公告覆盖范围阻挡持仓退出', () => {
  const f = fixture(); f.buy(); f.day('2026-09-30');
  const snap = { ...f.snapshot(), ...f.source() }; snap.technical.asOf = '2026-09-29'; snap.technical.dates = ['2026-09-29'];
  snap.notices.data.total = 100;
  assert.equal(f.engine.agencyAutomaticBlock('sz000001', f.quote({ prevClose: 9.95 }), snap), null);
});

test('无当前成员的资料失败仍展示证据并保护历史未确定权益', () => {
  const f = fixture(), buy = f.buy(); f.day('2026-09-30'); f.sell(buy.quantity); f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'remove' });
  const source = f.source(); Object.assign(source.corporateActions, { status: 'unavailable', coverageComplete: false,
    notices: [{ id: 'AN123456789012', title: '权益分派实施公告', date: '2026-09-29', corporateStage: 'implemented', url: 'https://example.test/notice' }] });
  f.engine.agencyProcessCorporateActions('sz000001', f.quote(), source);
  const view = f.engine.agencyState(), check = view.corporateChecks.sz000001;
  assert.equal(check.evidence[0].id, 'AN123456789012'); assert.equal(check.affectsEquity, true); assert.equal(f.group().comparable, false);
  assert.throws(() => f.engine.agencyTransfer({ strategyId: 'swing', amount: -100 }), /待对账/);
});

test('已核实并结清的空仓历史不因之后资料断线重新污染收益', () => {
  const f = fixture(), buy = f.buy(); f.day('2026-10-08'); f.process(); f.sell(buy.quantity); f.process();
  f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'remove' });
  const source = f.source(); Object.assign(source.corporateActions, { status: 'unavailable', coverageComplete: false });
  const result = f.engine.agencyProcessCorporateActions('sz000001', f.quote(), source);
  assert.equal(result.affectsEquity, false); assert.equal(f.group().comparable, true); assert.equal(f.engine.stats().comparable, true);
});

test('历史未匹配实施公告阻止自动放行，并保留直达链接', () => {
  const f = fixture(); f.buy(); f.day('2026-09-30'); const source = f.source([]);
  source.corporateActions.notices = [{ id: 'AN123456789099', title: '配股实施及更正公告', date: '2026-09-29', corporateStage: 'unsupported', url: 'https://example.test/unmatched' }];
  const result = f.engine.agencyProcessCorporateActions('sz000001', f.quote(), source);
  assert.equal(result.status, 'blocked'); assert.match(result.reason, /未.*匹配/); assert.equal(result.evidence[0].url, 'https://example.test/unmatched');
});

test('持有期跨月只释放预留不伪造现金，分红重复轮询不重复计税', () => {
  const f = fixture(), buy = f.buy(); f.day('2026-10-08'); f.process(); const cash = f.engine.s.cash;
  assert.equal(f.group().taxReserve, buy.quantity * 2);
  f.day('2026-10-29'); assert.equal(f.group().taxReserve, buy.quantity); assert.equal(f.engine.s.cash, cash);
  const prior = f.group().equity; f.process(); assert.equal(f.group().equity, prior); assert.equal(f.engine.s.cash, cash);
  f.sell(buy.quantity); assert.equal(f.engine.s.agency.corporateEvents[0].taxPaid, buy.quantity); assert.equal(validState(f.engine.s), true);
});

test('新状态拒绝被篡改的税务批次数量、关联成交、税款及上市日期', () => {
  const f = fixture(), buy = f.buy(); f.day('2026-10-08'); f.process(); f.sell(100);
  for (const mutate of [state => { state.agency.corporateActions[0].entitlements[0].grossCash++; },
    state => { state.agency.corporateActions[0].entitlements[0].taxPaid++; },
    state => { state.agency.corporateActions[0].entitlements[0].disposals[0].quantity = buy.quantity + 1; },
    state => { state.agency.corporateActions[0].entitlements[0].disposals[0].tradeId = 'missing'; },
    state => { state.lots[0].availableDate = '2026-02-30'; }]) {
    const bad = structuredClone(f.engine.s); mutate(bad); assert.equal(validState(bad), false); assert.throws(() => new Engine(bad), /格式/);
  }
});

test('明确未来预案保留资料但不入账或冻结现有持仓，后续实施另行核验', () => {
  const f = fixture(); f.buy(); f.day('2026-09-30'); const source = f.source([]);
  source.corporateActions.notices = [{ id: 'AN123456789066', title: '未来三年股东分红规划预案', date: '2026-09-29', corporateStage: 'planned', url: 'https://example.test/plan' }];
  const result = f.engine.agencyProcessCorporateActions('sz000001', f.quote(), source);
  assert.equal(result.status, 'clear'); assert.equal(f.group().comparable, true); assert.equal(f.engine.s.agency.corporateActions.length, 0);
  assert.equal(f.engine.agencyState().corporateChecks.sz000001.evidence[0].title, '未来三年股东分红规划预案');
});

test('已经结清的旧权益不会禁止后续无关周期的同日回买', () => {
  const f = fixture(), buy = f.buy(); f.day('2026-10-08'); f.process(); f.sell(buy.quantity);
  f.engine.agencyMember({ strategyId: 'swing', symbol: 'sz000001', action: 'remove' });
  f.day('2026-10-09'); f.engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 100 }, f.quote());
  f.day('2026-10-12'); f.sell(100);
  assert.doesNotThrow(() => f.engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 100 }, f.quote()));
  assert.equal(validState(f.engine.s), true);
});

test('免税转增本身可自动处理，后续现金分红的新增股份税期未确认则留异常', () => {
  const f = fixture(), buy = f.buy();
  const transfer = f.event({ cashPerShare: 0, transferPerShare: 1, transferTaxExempt: true, payDate: null, listingDate: '2026-09-30' });
  f.day('2026-09-30'); assert.equal(f.process([transfer]).status, 'clear');
  const cashEvent = f.event({ eventId: 'next-cash', noticeIds: ['AN123456789077'], recordDate: '2026-10-08', exDate: '2026-10-09', payDate: '2026-10-12' });
  f.day('2026-10-09'); const cash = f.engine.s.cash, result = f.process([transfer, cashEvent]);
  assert.equal(result.status, 'blocked'); assert.match(result.reason, /取得日期/); assert.equal(f.engine.s.cash, cash);
  assert.equal(f.engine.positions()[0].quantity, buy.quantity * 2);
});

test('干净旧v1账户迁移到当前版本，成交与资金保留，版本降级和未知版本拒绝', () => {
  const f = fixture(); f.buy(); const legacy = structuredClone(f.engine.s);
  legacy.agency.version = 1; delete legacy.agency.corporateActions; delete legacy.agency.corporateChecks; delete legacy.agency.entryConditionsVersion; delete legacy.agency.monitoringVersion;
  delete legacy.agency.poolVersion; delete legacy.agency.pool; delete legacy.agency.poolAuthorizationRevision;
  const before = { cash: legacy.cash, trades: structuredClone(legacy.trades), lots: structuredClone(legacy.lots), revision: legacy.agency.revision };
  assert.equal(validState(legacy), true);
  const migrated = new Engine(legacy, f.engine.clock); assert.equal(migrated.s.agency.version, 5); assert.equal(migrated.agencyState().version, 5);
  assert.equal(migrated.s.cash, before.cash); assert.deepEqual(migrated.s.trades, before.trades); assert.deepEqual(migrated.s.lots, before.lots);
  assert.equal(migrated.s.agency.revision, before.revision + 4);
  const again = new Engine(structuredClone(migrated.s), f.engine.clock); assert.equal(again.s.agency.revision, migrated.s.agency.revision);
  for (const version of [1, 2, 3, 4, 6]) { const bad = structuredClone(migrated.s); bad.agency.version = version; assert.equal(validState(bad), false); assert.throws(() => new Engine(bad), /格式/); }
  const incomplete = structuredClone(migrated.s); delete incomplete.agency.corporateActions; assert.equal(validState(incomplete), false);
});

test('公司行为changed局部比较与完整账务变更一致，覆盖登记、除息、现金和转增退出数量', () => {
  const check = (f, events) => {
    const before = structuredClone(f.engine.s), result = processCorporateActions(f.engine, 'sz000001', f.quote(), f.source(events));
    const after = structuredClone(f.engine.s); after.agency.revision = before.agency.revision;
    assert.equal(result.changed, JSON.stringify(before) !== JSON.stringify(after));
    assert.equal(f.engine.s.agency.revision, before.agency.revision + Number(result.changed));
    assert.equal(validState(f.engine.s), true); return result;
  };
  const cash = fixture(); cash.buy();
  assert.equal(check(cash).changed, true); assert.equal(check(cash).changed, false);
  for (const [date, time] of [['2026-09-29', '15:01:00'], ['2026-09-30', '10:00:00'], ['2026-10-08', '10:00:00']]) {
    cash.day(date, time); assert.equal(check(cash).changed, true); assert.equal(check(cash).changed, false);
  }
  const transfer = fixture(), trade = transfer.buy();
  transfer.engine.s.agency.executionIntents.push({ decisionId: 'pending-reduce', strategyId: 'swing', symbol: 'sz000001', action: 'reduce',
    targetQuantity: 100, status: 'pending', tradeIds: [] });
  transfer.day('2026-09-30');
  const event = transfer.event({ cashPerShare: 0, transferPerShare: 1, transferTaxExempt: true, payDate: null, listingDate: '2026-10-09' });
  assert.equal(check(transfer, [event]).changed, true); assert.equal(check(transfer, [event]).changed, false);
  assert.equal(transfer.engine.s.agency.executionIntents[0].targetQuantity, 200);
  assert.equal(transfer.engine.positions()[0].quantity, trade.quantity * 2);
  assert.equal(transfer.engine.s.marks.sz000001.companyActionAdjusted, event.eventId);
});

test('空事件和过期资料不序列化账户，仍拦截历史事件遗漏及撤销公告', () => {
  const f = fixture(); f.buy(); f.day('2026-09-30'); f.process();
  const missing = f.source([]), revoked = f.source([]), stale = f.source();
  revoked.corporateActions.notices = [{ id: f.event().noticeIds[0], title: '撤销实施公告', corporateStage: 'cancelled', date: '2026-09-30' }];
  stale.corporateActions.fetchedAt -= 300001;
  const before = structuredClone(f.engine.s), original = JSON.stringify; let calls = 0;
  JSON.stringify = (...args) => { calls++; return original(...args); };
  try {
    for (const snapshot of [missing, revoked, stale]) {
      const result = processCorporateActions(f.engine, 'sz000001', f.quote(), snapshot);
      assert.equal(result.status, 'blocked'); assert.equal(result.changed, false); assert.equal(result.affectsEquity, true);
    }
  } finally { JSON.stringify = original; }
  assert.equal(calls, 0); assert.deepEqual(f.engine.s, before);
});

test('已存在事件核验的changed比较不包含决策历史或候选池，但失败仍回滚已调整资金和风险', () => {
  const f = fixture(); f.buy(); f.day('2026-10-08');
  f.engine.s.agency.decisions.push({ id: 'retained-audit', payload: 'audit'.repeat(5000) });
  const auditBefore = structuredClone(f.engine.s.agency.decisions), cash = f.engine.s.cash, lots = structuredClone(f.engine.s.lots), risks = structuredClone(f.engine.s.risks);
  // A failure after registration and risk adjustment must still restore the
  // event checkpoint; an invalid cycle is discovered when paying the dividend.
  const cycle = f.engine.s.agency.groups.find(group => group.id === 'swing').cycles[0];
  const cycleId = cycle.id; cycle.id = 'temporarily-missing-cycle';
  const original = JSON.stringify; let fullAccountComparisons = 0;
  JSON.stringify = (value, ...args) => {
    if (value && value.agency && Object.hasOwn(value.agency, 'decisions')) fullAccountComparisons++;
    return original(value, ...args);
  };
  let result;
  try { result = processCorporateActions(f.engine, 'sz000001', f.quote(), f.source()); }
  finally { JSON.stringify = original; }
  assert.equal(result.status, 'blocked'); assert.equal(result.changed, true); assert.equal(fullAccountComparisons, 0);
  assert.equal(f.engine.s.cash, cash); assert.deepEqual(f.engine.s.lots, lots); assert.deepEqual(f.engine.s.risks, risks);
  assert.deepEqual(f.engine.s.agency.decisions, auditBefore);
  f.engine.s.agency.groups.find(group => group.id === 'swing').cycles[0].id = cycleId;
  assert.equal(validState(f.engine.s), true);
});

function queuedCorporateService(f, { failSave = false } = {}) {
  const callbacks = [], calls = { saves: 0, publishes: 0 };
  const service = new CorporateService({ getEngine: () => f.engine, clock: () => +f.engine.clock(), scheduleCommit: callback => callbacks.push(callback),
    source: {}, getMonitor: () => ({ load: async symbol => ({ ...f.snapshot(), ...f.source(symbol === 'sz000001' ? undefined : []),
      corporateActions: { ...f.source(symbol === 'sz000001' ? undefined : []).corporateActions, symbol } }) }),
    market: { quotes: async symbols => Object.fromEntries(symbols.map(symbol => [symbol, { ...f.quote(), symbol }])) },
    transaction: fn => {
      const before = structuredClone(f.engine.s);
      try { const value = fn(); calls.saves++; calls.cashBeforeSave = f.engine.s.cash; calls.dividendsBeforeSave = f.engine.s.agency.corporateEvents.length;
        if (failSave) throw Error('分红批次保存失败'); assert.equal(validState(f.engine.s), true); return value; }
      catch (error) { f.engine.s = before; throw error; }
    }, onChange: () => calls.publishes++ });
  return { service, callbacks, calls };
}
const prepareQueued = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

test('真实公司行为同批提交保存失败不留下分红、税款、价位调整或成功结果', async () => {
  const f = fixture(); f.buy(); f.day('2026-10-08'); f.engine.agencyMember({ strategyId: 'swing', symbol: 'sh600000', action: 'add' });
  const before = structuredClone(f.engine.s), batch = queuedCorporateService(f, { failSave: true });
  const pending = Promise.allSettled(['sz000001', 'sh600000'].map(symbol => batch.service.verifyOne(symbol)));
  await prepareQueued(); assert.equal(batch.service.ready.length, 2); batch.callbacks.shift()();
  const results = await pending; assert.ok(results.every(result => result.status === 'rejected' && /分红批次保存失败/.test(result.reason.message)));
  assert.ok(batch.calls.cashBeforeSave > before.cash); assert.equal(batch.calls.dividendsBeforeSave, 1);
  assert.equal(batch.calls.saves, 1); assert.equal(batch.calls.publishes, 0); assert.deepEqual(f.engine.s, before); assert.equal(validState(f.engine.s), true);
});

test('排队后来源过期在真实引擎提交时重新拦截，不入账且不返回核验通过', async () => {
  const f = fixture(); f.buy(); f.day('2026-10-08'); const cash = f.engine.s.cash, batch = queuedCorporateService(f);
  const pending = batch.service.verifyOne('sz000001'); await prepareQueued();
  f.day('2026-10-08', '10:06:00'); batch.callbacks.shift()();
  const result = await pending;
  assert.equal(result.status, 'blocked'); assert.match(result.reason, /不新鲜|过期/);
  assert.equal(f.engine.s.cash, cash); assert.equal(f.engine.s.agency.corporateEvents.length, 0); assert.equal(f.engine.s.agency.corporateActions.length, 0);
});
