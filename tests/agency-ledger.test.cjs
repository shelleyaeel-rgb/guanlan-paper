const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, initialState, validState } = require('../core/engine.cjs');
const { cnTime } = require('../core/common.cjs');

function fixture() {
  let now = new Date('2026-09-29T10:00:00+08:00');
  const engine = new Engine(initialState(100000), () => now);
  const quote = (extra = {}) => ({ symbol: 'sz000001', name: '代理测试', price: 10.1, prevClose: 10.05, open: 10, low: 10, high: 10.2, volume: 100000,
    bid: 10.09, ask: 10.1, bidSize: 20000, askSize: 20000, limitUp: 11.05, limitDown: 9.05, timestamp: now.getTime(), date: cnTime(now).date, ...extra });
  const snapshot = (extra = {}, symbol = 'sz000001') => {
    const previous = cnTime(new Date(now.getTime() - 86400000)).date;
    return { fetchedAt: now.getTime(), notices: { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), checkedAt: now.getTime(), data: { items: [], total: 0 } },
      technical: { asOf: previous, close: 10.05, ma5: 10, ma20: 10, ma60: 9.5, atr: 0.4, macd: 0.1, rsi: 55, volumeRatio: 1, trend: true,
        breakout: false, support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5, dates: [previous], ...extra } };
  };
  const authorize = (symbol = 'sz000001') => { engine.agencyTransfer({ strategyId: 'swing', amount: 50000 }); engine.agencyMember({ strategyId: 'swing', symbol, action: 'add' }); engine.agencyMode({ strategyId: 'swing', mode: 'running' }); };
  const execute = (action = 'buy', extra = {}, q = quote(), snap = snapshot()) => engine.agencyExecute({ strategyId: 'swing', symbol: 'sz000001', action,
    targetPercent: action === 'buy' ? 20 : undefined, decisionId: `decision-${engine.s.trades.length}-${action}`, expectedEpoch: engine.s.agency.epoch, expectedRevision: engine.s.agency.revision, ...extra }, q, snap, { [q.symbol]: q });
  return { engine, quote, snapshot, authorize, execute, day: date => { now = new Date(`${date}T10:00:00+08:00`); }, advance: milliseconds => { now = new Date(now.getTime() + milliseconds); } };
}

test('旧账户迁移全部现金和持仓归手动，四个策略没有复制本金', () => {
  const state = initialState(100000); state.lots.push({ id: 'old', symbol: 'sz000001', name: '旧持仓', date: '2026-09-28', quantity: 100, cost: 100000 }); state.cash -= 100000;
  const engine = new Engine(state); const agency = engine.agencyState();
  assert.equal(agency.manualCash, state.cash); assert.equal(agency.groups.length, 4);
  assert.ok(agency.groups.every(g => g.cash === 0 && g.mode === 'paused')); assert.equal(engine.s.lots[0].owner, 'manual'); assert.equal(validState(engine.s), true);
  assert.equal(agency.decisionMode, 'rules'); assert.equal(agency.rulesVersion, '1'); assert.equal(agency.migrationNotice, null);
});

test('单策略视图保持完整视图的实时估值和成员快照，不携带其他策略及历史日志', () => {
  const f = fixture(); f.authorize(); f.execute();
  f.engine.agencyLog({ strategyId: 'swing', message: '保留完整历史依据', inputSources: [{ data: 'audit'.repeat(1000) }] });
  f.engine.agencyMember({ strategyId: 'long', symbol: 'sh600000', action: 'add' });
  const quotes = { sz000001: f.quote({ price: 10.8 }) };
  const expected = f.engine.agencyState(quotes).groups.find(group => group.id === 'swing');
  const view = f.engine.agencyGroupState('swing', quotes);
  assert.deepEqual(view, expected);
  assert.equal(view.positions[0].price, 10.8);
  assert.equal(view.equity, view.cash + view.positions[0].value);
  assert.equal(view.decisions, undefined); assert.equal(view.groups, undefined);
  assert.equal(f.engine.agencyGroupState('missing', quotes), null);
  view.members[0].mode = 'exit'; view.cycles[0].pnl = 12345; view.limits.maxPosition = 1;
  assert.deepEqual(f.engine.agencyGroupState('swing', quotes), expected, '修改返回成员、周期和限额不能修改账户');
  assert.equal(f.engine.agencyState().decisions[0].message, '保留完整历史依据');
});

test('旧模型运行组一次性暂停新开仓；历史记录、账务、已承诺退出与停止状态不改写', () => {
  const f = fixture(); f.authorize(); f.execute(); f.execute('sell');
  f.engine.agencyMode({ strategyId: 'short', mode: 'stopped' });
  f.engine.agencyLog({ model: 'legacy-model', message: '历史 AI 建议退出' });
  const old = structuredClone(f.engine.s); delete old.agency.decisionMode; delete old.agency.rulesVersion;
  const priorRevision = old.agency.revision, priorEpoch = old.agency.epoch, priorTrades = structuredClone(old.trades), priorDecisions = structuredClone(old.agency.decisions);
  assert.equal(validState(old), true, '持久化加载先接受旧格式，再由Engine安全迁移');
  const restored = new Engine(old, f.engine.clock), view = restored.agencyState();
  assert.equal(view.decisionMode, 'rules'); assert.equal(view.rulesVersion, '1');
  assert.equal(view.groups.find(group => group.id === 'swing').mode, 'paused'); assert.equal(view.groups.find(group => group.id === 'short').mode, 'stopped');
  assert.equal(view.revision, priorRevision + 1); assert.equal(view.epoch, priorEpoch);
  assert.equal(restored.s.cash, f.engine.s.cash); assert.deepEqual(restored.s.lots, f.engine.s.lots);
  assert.deepEqual(restored.s.trades, priorTrades); assert.deepEqual(view.decisions, priorDecisions);
  assert.deepEqual(view.executionIntents, f.engine.agencyState().executionIntents);
  assert.deepEqual(view.migrationNotice.pausedGroups, ['swing']); assert.match(view.migrationNotice.message, /固定策略规则/);
  assert.equal(restored.agencyEvaluate('swing', '000001', f.quote(), f.snapshot()).buyable, false);
  f.day('2026-09-30');
  const [exit] = restored.tick({ sz000001: f.quote() }, { sz000001: f.snapshot() });
  assert.equal(exit.side, 'sell'); assert.match(exit.reason, /自动退出/); assert.doesNotMatch(exit.reason, /AI/);
  assert.equal(restored.positions().length, 0); assert.equal(validState(restored.s), true);
  restored.agencyMode({ strategyId: 'swing', mode: 'running' });
  const revision = restored.s.agency.revision, migratedAgain = new Engine(structuredClone(restored.s), f.engine.clock);
  assert.equal(migratedAgain.agencyState().groups.find(group => group.id === 'swing').mode, 'running');
  assert.equal(migratedAgain.s.agency.revision, revision); assert.deepEqual(migratedAgain.s.agency.migrationNotice, view.migrationNotice);
});

test('新规则账户重启保留运行授权，未知决策方式或规则版本拒绝加载', () => {
  const f = fixture(); f.authorize();
  const restored = new Engine(structuredClone(f.engine.s), f.engine.clock);
  assert.equal(restored.agencyState().groups.find(group => group.id === 'swing').mode, 'running');
  assert.equal(restored.s.agency.revision, f.engine.s.agency.revision);
  for (const fields of [{ decisionMode: 'unknown' }, { rulesVersion: '999' }]) {
    const broken = structuredClone(f.engine.s); Object.assign(broken.agency, fields);
    assert.equal(validState(broken), false); assert.throws(() => new Engine(broken), /格式/);
  }
});

test('固定规则通过后可直接自动建仓，目标上限仍受组单笔风险和资金约束', () => {
  const f = fixture(); f.authorize(); const group = f.engine.agencyState().groups.find(group => group.id === 'swing');
  const evaluation = f.engine.agencyEvaluate('swing', '000001', f.quote(), f.snapshot());
  assert.equal(evaluation.buyable, true);
  const trade = f.execute('buy', { targetPercent: group.limits.maxPosition * 100 });
  assert.equal(trade.quantity, evaluation.quantity); assert.ok(trade.gross <= group.equity * group.limits.maxPosition);
  assert.ok(f.engine.s.risks.sz000001.initialPlannedLoss <= group.equity * group.limits.riskPercent / 100);
  assert.equal(f.engine.s.agency.groups.find(g => g.id === 'swing').cash, group.cash - trade.gross - trade.fees.total);
  assert.equal(f.engine.s.agency.manualCash, 5000000);
  assert.equal(f.engine.agencyEvaluate('swing', '000001', f.quote(), f.snapshot()).buyable, false, '不会在相同持仓上反复加仓');
});

test('固定规则持仓通过行情轮询独立完成止损、止盈、趋势及期限退出', () => {
  for (const trigger of ['止损触发', '止盈触发', '波段趋势失效', '波段持有超时']) {
    const f = fixture(); f.authorize(); f.execute('buy', { targetPercent: 30 }); f.day('2026-09-30');
    let q = f.quote(), snap = f.snapshot();
    if (trigger === '止损触发') q = f.quote({ price: 9.5, bid: 9.5 });
    if (trigger === '止盈触发') { q = f.quote({ price: 11.6, bid: 11.59, prevClose: 11, limitUp: 12.1, limitDown: 9.9 }); snap = f.snapshot({ close: 11 }); }
    if (trigger === '波段趋势失效') { q = f.quote({ prevClose: 9.7 }); snap = f.snapshot({ close: 9.7 }); }
    if (trigger === '波段持有超时') f.engine.s.risks.sz000001.heldBars = 15;
    f.engine.agencyMode({ strategyId: 'swing', mode: 'paused' });
    const restored = new Engine(structuredClone(f.engine.s), f.engine.clock);
    const [exit] = restored.tick({ sz000001: q }, { sz000001: snap });
    assert.ok(exit, trigger); assert.equal(exit.reason, trigger); assert.equal(exit.owner, 'swing'); assert.equal(exit.manualIntervention, false);
    assert.equal(restored.positions().length, 0); assert.equal(restored.s.agency.groups.find(g => g.id === 'swing').cycles[0].status, 'closed');
    assert.equal(validState(restored.s), true);
  }
});

test('划拨以分守恒且资金流不产生策略收益、手动不能借用代理现金', () => {
  const f = fixture(); f.engine.agencyTransfer({ strategyId: 'swing', amount: 99990.12 });
  let a = f.engine.agencyState(), g = a.groups.find(g => g.id === 'swing');
  assert.equal(a.manualCash, 988); assert.equal(g.cash, 9999012); assert.equal(g.pnl, 0); assert.equal(f.engine.s.cash, 10000000);
  assert.throws(() => f.engine.execute({ symbol: 'sz000001', side: 'buy', quantity: 100 }, f.quote()), /手动可用资金不足/);
  assert.throws(() => f.engine.agencyTransfer({ strategyId: 'short', amount: 10 }), /现金不足/);
  assert.throws(() => f.engine.agencyTransfer({ strategyId: 'short', amount: 0.001 }), /两位/);
  f.engine.agencyTransfer({ strategyId: 'swing', amount: -99990.12 });
  g = f.engine.agencyState().groups.find(g => g.id === 'swing'); assert.equal(g.pnl, 0); assert.equal(g.units, 0); assert.equal(validState(f.engine.s), true);
});

test('单股代理归属互斥；普通自选可以重叠；手动持仓和待单不能接管', () => {
  const f = fixture(); f.authorize(); assert.ok(f.engine.s.watchlist.includes('sz000001'));
  assert.throws(() => f.engine.agencyMember({ strategyId: 'short', symbol: '000001', action: 'add' }), /一个自动交易/);
  assert.throws(() => f.engine.place({ symbol: '000001', side: 'buy', quantity: 100, limit: 10 }), /手动委托/);
  assert.throws(() => f.engine.execute({ symbol: '000001', side: 'buy', quantity: 100 }, f.quote()), /已授权/);
  const manual = fixture(); manual.engine.execute({ symbol: '000001', side: 'buy', quantity: 100 }, manual.quote());
  assert.throws(() => manual.engine.agencyMember({ strategyId: 'swing', symbol: '000001', action: 'add' }), /手动持仓/);
  const pending = fixture(); pending.engine.place({ symbol: '000001', side: 'buy', quantity: 100, limit: 10 });
  assert.throws(() => pending.engine.agencyMember({ strategyId: 'swing', symbol: '000001', action: 'add' }), /手动委托/);
});

test('代理买入从所属组扣费且保留策略风险；重启严格恢复并拒绝坏账', () => {
  const f = fixture(); f.authorize(); const before = f.engine.s.agency.manualCash, trade = f.execute();
  const group = f.engine.agencyState().groups.find(g => g.id === 'swing');
  assert.equal(trade.owner, 'swing'); assert.equal(trade.strategyId, 'swing'); assert.equal(f.engine.s.lots[0].owner, 'swing');
  assert.equal(group.cash, 5000000 - trade.gross - trade.fees.total); assert.equal(f.engine.s.agency.manualCash, before);
  assert.ok(f.engine.s.risks.sz000001.initialPlannedLoss <= 5000000 * 0.005);
  assert.equal(group.completedCycles, 0); assert.equal(validState(f.engine.s), true);
  assert.doesNotThrow(() => new Engine(structuredClone(f.engine.s)));
  const broken = structuredClone(f.engine.s); broken.agency.manualCash++; assert.equal(validState(broken), false); assert.throws(() => new Engine(broken), /格式/);
  const hiddenTransfer = structuredClone(f.engine.s); hiddenTransfer.agency.manualCash--; hiddenTransfer.agency.groups.find(g => g.id === 'swing').cash++;
  assert.equal(validState(hiddenTransfer), false, '即使总现金仍守恒，也不能绕过真实划拨和成交台账修改策略余额');
});

test('授权及账户版本变化使迟到决策失效，已成交编号重启后仍拒绝重放', () => {
  const f = fixture(); f.authorize(); const input = { expectedEpoch: f.engine.s.agency.epoch, expectedRevision: f.engine.s.agency.revision };
  f.engine.agencyMode({ strategyId: 'swing', mode: 'paused' });
  assert.throws(() => f.execute('buy', input), /旧决策失效/);
  f.engine.agencyMode({ strategyId: 'swing', mode: 'running' }); const trade = f.execute();
  const restored = new Engine(structuredClone(f.engine.s));
  assert.throws(() => restored.agencyExecute({ strategyId: 'swing', symbol: 'sz000001', action: 'buy', decisionId: trade.decisionId }, f.quote(), f.snapshot()), /重复执行/);
  const reset = new Engine(initialState(100000)); assert.notEqual(reset.s.agency.epoch, f.engine.s.agency.epoch);
});

test('组风险配置用于实际计划；持仓数量、组总仓位与总计划风险可阻止买入', () => {
  const f = fixture(); f.authorize(); f.engine.agencyConfigure({ strategyId: 'swing', limits: { riskPercent: 0.1 } });
  assert.equal(f.engine.agencyEvaluate('swing', '000001', f.quote(), f.snapshot()).buyable, false);
  f.engine.agencyConfigure({ strategyId: 'swing', limits: { riskPercent: 2, maxTotalPosition: 0.01 } });
  assert.match(f.engine.agencyEvaluate('swing', '000001', f.quote(), f.snapshot()).reasons.join(), /总仓位/);
  f.engine.agencyConfigure({ strategyId: 'swing', limits: { maxTotalPosition: 0.8, maxPlannedRiskPercent: 0.1 } });
  assert.match(f.engine.agencyEvaluate('swing', '000001', f.quote(), f.snapshot()).reasons.join(), /总计划风险/);
  f.engine.agencyConfigure({ strategyId: 'swing', limits: { maxPlannedRiskPercent: 2, maxPositions: 1 } }); f.execute();
  f.engine.agencyMember({ strategyId: 'swing', symbol: '600000', action: 'add' });
  assert.match(f.engine.agencyEvaluate('swing', '600000', f.quote({ symbol: 'sh600000' }), f.snapshot({}, 'sh600000')).reasons.join(), /持仓数量上限/);
});

test('人工部分卖出仍归原策略；完整平仓才计一个周期胜负', () => {
  const f = fixture(); f.authorize(); const buy = f.execute(); f.day('2026-09-30');
  const beforeManual = f.engine.s.agency.manualCash;
  const first = f.engine.execute({ symbol: '000001', side: 'sell', quantity: 100 }, f.quote({ bid: 10.7 }), {}, '人工减仓');
  assert.equal(first.owner, 'swing'); assert.equal(first.manualIntervention, true); assert.equal(f.engine.agencyState().groups.find(g => g.id === 'swing').completedCycles, 0);
  const last = f.engine.execute({ symbol: '000001', side: 'sell', quantity: buy.quantity - 100 }, f.quote({ bid: 10.8, timestamp: f.quote().timestamp + 1 }));
  const g = f.engine.agencyState().groups.find(g => g.id === 'swing');
  assert.equal(g.completedCycles, 1); assert.equal(g.wins, 1); assert.equal(g.pnl, first.pnl + last.pnl);
  assert.equal(f.engine.s.agency.manualCash, beforeManual); assert.equal(validState(f.engine.s), true);
  const returnBefore = g.returnPct;
  f.engine.agencyTransfer({ strategyId: 'swing', amount: -g.cash / 100 });
  f.engine.agencyTransfer({ strategyId: 'swing', amount: 30000 });
  const fundedAgain = f.engine.agencyState().groups.find(g => g.id === 'swing');
  assert.ok(Math.abs(fundedAgain.returnPct - returnBefore) < 1e-12);
  assert.equal(fundedAgain.drawdown, g.drawdown);
});

test('暂停新开仓仍允许硬退出，停止全部阻止自动卖出，移出有仓须平仓后移除', () => {
  const f = fixture(); f.authorize(); f.execute(); f.day('2026-09-30');
  f.engine.agencyMember({ strategyId: 'swing', symbol: '000001', action: 'remove' });
  f.engine.agencyMode({ strategyId: 'swing', mode: 'stopped' });
  const q = f.quote({ price: 9.5, bid: 9.5 }); const snaps = { sz000001: f.snapshot() };
  assert.equal(f.engine.tick({ sz000001: q }, snaps).length, 0); assert.ok(f.engine.positions().length);
  f.engine.agencyMode({ strategyId: 'swing', mode: 'paused' });
  assert.equal(f.engine.tick({ sz000001: q }, snaps).length, 1); assert.equal(f.engine.positions().length, 0);
  assert.equal(f.engine.agencyState().groups.find(g => g.id === 'swing').members.length, 0);
});

test('自动退出遵循 T+1 和可见盘口；部分减仓不会伪造全部成交', () => {
  const f = fixture(); f.authorize(); const buy = f.execute();
  const pending = f.execute('sell'); assert.equal(pending.pending, true); assert.match(pending.reason, /T\+1/); assert.equal(f.engine.s.trades.length, 1);
  f.day('2026-09-30'); const [sell] = f.engine.tick({ sz000001: f.quote({ bidSize: 100 }) }, { sz000001: f.snapshot() });
  assert.equal(sell.quantity, 100); assert.equal(f.engine.positions()[0].quantity, buy.quantity - 100);
  assert.equal(f.engine.agencyState().groups.find(g => g.id === 'swing').completedCycles, 0);
  const restored = new Engine(structuredClone(f.engine.s), f.engine.clock);
  const remainder = restored.tick({ sz000001: f.quote({ bidSize: 20000, timestamp: f.quote().timestamp + 1 }) }, { sz000001: f.snapshot() });
  assert.equal(remainder[0].quantity, buy.quantity - 100); assert.equal(restored.s.agency.executionIntents[0].status, 'completed'); assert.equal(validState(restored.s), true);
});

test('价格基准异常在旧止损触发之前锁定待对账，不能靠新快照自动消除', () => {
  const f = fixture(); f.authorize(); f.execute(); f.day('2026-09-30');
  const q = f.quote({ price: 8, prevClose: 8, bid: 8 });
  assert.equal(f.engine.tick({ sz000001: q }, { sz000001: f.snapshot() }).length, 0);
  const g = f.engine.agencyState().groups.find(g => g.id === 'swing'); assert.equal(g.members[0].reconciliation.status, 'pending'); assert.equal(g.comparable, false);
  assert.equal(f.engine.tick({ sz000001: f.quote({ price: 9.5, bid: 9.5 }) }, { sz000001: f.snapshot() }).length, 0);
  assert.throws(() => f.engine.execute({ symbol: '000001', side: 'sell', quantity: 100 }, f.quote()), /待对账/);
});

test('公司行为净现金和送转可审计入账，修正计划价格且事件不可重复', () => {
  const f = fixture(); f.authorize(); const buy = f.execute(); f.day('2026-09-30');
  const before = f.engine.s.cash, oldStop = f.engine.s.risks.sz000001.stop, cost = f.engine.s.lots[0].cost;
  const input = { strategyId: 'swing', symbol: '000001', eventId: 'verified-dividend-1', evidence: '交易所权益分派公告和登记明细已核验', recordDate: '2026-09-29', effectiveDate: '2026-09-30', cashAmount: 20, shareNumerator: 2, shareDenominator: 1, riskPriceFactor: 0.49 };
  f.engine.agencyReconcile(input);
  assert.equal(f.engine.s.cash, before + 2000); assert.equal(f.engine.s.lots[0].quantity, buy.quantity * 2); assert.equal(f.engine.s.lots[0].cost, cost);
  assert.equal(f.engine.s.risks.sz000001.stop, Math.round(oldStop * 0.49 * 100) / 100);
  assert.equal(f.engine.s.risks.sz000001.originalTerms.entryPrice, buy.price);
  assert.equal(f.engine.s.risks.sz000001.originalTerms.initialStop, oldStop);
  assert.equal(f.engine.s.risks.sz000001.currentPriceBasis.cumulativeFactor, 0.49);
  assert.equal(f.engine.s.agency.groups.find(g => g.id === 'swing').cycles[0].dividends, 2000);
  const stat = f.engine.stats(); assert.equal(stat.pnl, stat.realized + stat.unrealized);
  assert.throws(() => f.engine.agencyReconcile(input), /重复入账/); assert.equal(validState(f.engine.s), true);
  const unchanged = structuredClone(f.engine.s);
  assert.throws(() => f.engine.agencyReconcile({ ...input, eventId: 'different-id', effectiveDate: '2026-09-30' }), /相同权益登记日/);
  assert.deepEqual(f.engine.s, unchanged);
});

test('送转同步放大未成交减仓目标，原授权股份比例不因股本变更而多卖', () => {
  const f = fixture(); f.authorize(); const buy = f.execute();
  const pending = f.execute('reduce'); assert.equal(pending.pending, true);
  const target = f.engine.s.agency.executionIntents[0].targetQuantity;
  f.day('2026-09-30');
  f.engine.agencyReconcile({ strategyId: 'swing', symbol: '000001', eventId: 'share-event', evidence: '交易所送股公告及登记股份核对一致',
    recordDate: '2026-09-29', effectiveDate: '2026-09-30', shareNumerator: 2, shareDenominator: 1, riskPriceFactor: 0.5 });
  assert.equal(f.engine.s.agency.executionIntents[0].targetQuantity, target * 2);
  const q = f.quote({ price: 5.05, ask: 5.05, bid: 5.04, prevClose: 5.025, open: 5, low: 5, high: 5.1, limitUp: 5.53, limitDown: 4.52 });
  const snap = f.snapshot({ close: 5.025, ma5: 5, ma20: 5, ma60: 4.75, atr: 0.2, support: 4.85, resistance: 5.75, entryLow: 4.95, entryHigh: 5.15, stop: 4.8, target: 5.75 });
  const events = f.engine.tick({ sz000001: q }, { sz000001: snap });
  assert.equal(events[0].quantity, (buy.quantity - target) * 2);
  assert.equal(f.engine.positions()[0].quantity, target * 2);
  assert.equal(f.engine.s.agency.executionIntents[0].status, 'completed'); assert.equal(validState(f.engine.s), true);
});

test('已入账公告不能通过更换事件编号及登记日再次记账', () => {
  const f = fixture(); f.authorize(); f.execute(); f.day('2026-09-30');
  const input = { strategyId: 'swing', symbol: '000001', eventId: 'event-first', noticeIds: ['AN123456789012'], evidence: '交易所权益分派公告及到账流水核对一致',
    recordDate: '2026-09-29', effectiveDate: '2026-09-30', cashAmount: 10, riskPriceFactor: 0.999 };
  f.engine.agencyReconcile(input); const before = structuredClone(f.engine.s);
  assert.throws(() => f.engine.agencyReconcile({ ...input, eventId: 'event-renamed', recordDate: '2026-09-30' }), /公告批次已经入账/);
  assert.deepEqual(f.engine.s, before);
});

test('巨潮公告对账保留独立编号，同公告改事件编号和登记日仍拒绝重复入账', () => {
  const f = fixture(); f.authorize(); f.execute(); f.day('2026-09-30');
  const input = { strategyId: 'swing', symbol: '000001', eventId: 'CN122345678901', noticeIds: ['CN122345678901'], evidence: '巨潮权益分派原文、权益登记及到账流水已核对',
    recordDate: '2026-09-29', effectiveDate: '2026-09-30', cashAmount: 10, riskPriceFactor: 0.999 };
  const cash = f.engine.s.cash;
  f.engine.agencyReconcile(input);
  assert.equal(f.engine.s.cash, cash + 1000);
  assert.deepEqual(f.engine.s.agency.corporateEvents.at(-1).noticeIds, ['CN122345678901']);
  const before = structuredClone(f.engine.s);
  assert.throws(() => f.engine.agencyReconcile({ ...input, eventId: 'renamed', recordDate: '2026-09-30' }), /公告批次已经入账/);
  assert.throws(() => f.engine.agencyReconcile({ ...input, eventId: 'invalid', noticeIds: ['CNbad'] }), /公告编号格式无效/);
  assert.deepEqual(f.engine.s, before); assert.equal(validState(f.engine.s), true);
});

test('待对账期间冻结净值峰值回撤，恢复后先等有效新快照', () => {
  const f = fixture(); f.authorize(); f.execute(); f.day('2026-09-30');
  const group = f.engine.s.agency.groups.find(g => g.id === 'swing'), peak = group.unitPeak, drawdown = group.drawdown;
  f.engine.tick({ sz000001: f.quote({ price: 1, prevClose: 1, bid: 1 }) }, { sz000001: f.snapshot() });
  assert.equal(group.unitPeak, peak); assert.equal(group.drawdown, drawdown);
  assert.equal(f.engine.agencyState().groups.find(g => g.id === 'swing').drawdown, null);
  f.engine.agencyReconcile({ strategyId: 'swing', symbol: '000001', eventId: 'checked-price-error', evidence: '行情供应商错误已核验并等待新数据', effectiveDate: '2026-09-30', confirmationOnly: true });
  assert.equal(group.unitPeak, peak); assert.equal(f.engine.agencyState().groups.find(g => g.id === 'swing').comparable, false);
  f.engine.tick({ sz000001: f.quote() }, { sz000001: f.snapshot() });
  assert.equal(f.engine.agencyState().groups.find(g => g.id === 'swing').comparable, true);
});

test('减仓目标按申报单位保存，只减至目标；后续硬退出优先', () => {
  const f = fixture(); f.authorize(); const buy = f.execute(); f.day('2026-09-30');
  const reduction = f.execute('reduce', { targetPercent: 4 }, f.quote({ bidSize: 100 }));
  assert.equal(reduction.quantity, 100);
  const intent = f.engine.s.agency.executionIntents[0]; assert.equal((buy.quantity - intent.targetQuantity) % 100, 0);
  f.engine.tick({ sz000001: f.quote({ timestamp: f.quote().timestamp + 1 }) }, { sz000001: f.snapshot() });
  assert.equal(f.engine.positions()[0].quantity, intent.targetQuantity); assert.equal(intent.status, 'completed');
  assert.equal(f.engine.s.risks.sz000001.pendingExit, undefined);
  f.engine.tick({ sz000001: f.quote({ price: 9.5, bid: 9.5, timestamp: f.quote().timestamp + 2 }) }, { sz000001: f.snapshot() });
  assert.equal(f.engine.positions().length, 0);
});

test('未知权益日期、无证据及零碎送转不能更改账户', () => {
  const f = fixture(); f.authorize(); f.execute(); f.day('2026-09-30');
  const before = structuredClone(f.engine.s), input = { strategyId: 'swing', symbol: '000001', eventId: 'event-1', effectiveDate: '2026-09-30', cashAmount: 10 };
  assert.throws(() => f.engine.agencyReconcile(input), /依据/);
  assert.throws(() => f.engine.agencyReconcile({ ...input, evidence: '已核对公告和登记资料' }), /权益登记日/);
  assert.throws(() => f.engine.agencyReconcile({ ...input, evidence: '已核对公告和登记资料', recordDate: '2026-09-29', shareNumerator: 7, shareDenominator: 3, riskPriceFactor: 0.4 }), /零碎股份/);
  assert.deepEqual(f.engine.s, before);
});

test('离线跨未核验交易日即使最新报价日线一致也要求补充对账', () => {
  const f = fixture(); f.authorize(); f.execute(); f.day('2026-10-09');
  const q = f.quote({ price: 9.5, bid: 9.5 });
  assert.equal(f.engine.tick({ sz000001: q }, { sz000001: f.snapshot({ dates: ['2026-09-29', '2026-09-30', '2026-10-08'] }) }).length, 0);
  assert.match(f.engine.s.agency.groups.find(g => g.id === 'swing').members[0].reconciliation.reason, /未核验交易日/);
});

test('公司行为公告进入待对账；日志限长不清除成交去重证据', () => {
  const f = fixture(); f.authorize(); const buy = f.execute();
  const snap = f.snapshot(); snap.notices.status = 'ready'; snap.notices.data = { total: 1, items: [{ id: 'AN123456789012', date: '2026-09-29', title: '权益分派实施公告' }] };
  assert.throws(() => f.execute('sell', {}, f.quote(), snap), /公司行为公告/);
  for (let i = 0; i < 510; i++) f.engine.agencyLog({ action: 'wait', decisionId: `${i}` });
  assert.equal(f.engine.agencyState().decisions.length, 500);
  assert.throws(() => f.execute('buy', { decisionId: buy.decisionId }), /重复执行/);
});

test('同策略待对账权益不能用于另一股票的新开仓预算，其他策略仍独立检查', () => {
  const f = fixture(); f.authorize(); f.execute();
  f.engine.agencyMember({ strategyId: 'swing', symbol: '600000', action: 'add' });
  f.engine.agencyAutomaticBlock('sz000001', f.quote({ prevClose: 8 }), f.snapshot());
  const result = f.engine.agencyEvaluate('swing', '600000', f.quote({ symbol: 'sh600000' }), f.snapshot({}, 'sh600000'));
  assert.equal(result.buyable, false); assert.match(result.reasons.join(), /本策略有待对账/);
  f.engine.agencyTransfer({ strategyId: 'long', amount: 20000 });
  f.engine.agencyMember({ strategyId: 'long', symbol: '600001', action: 'add' }); f.engine.agencyMode({ strategyId: 'long', mode: 'running' });
  const independent = f.engine.agencyEvaluate('long', '600001', f.quote({ symbol: 'sh600001' }), f.snapshot({}, 'sh600001'));
  assert.doesNotMatch(independent.reasons.join(), /本策略有待对账/);
  assert.match(independent.reasons.join(), /日线价位不足/);
});

test('仅核验公司行为公告当天有效，次日仍需核验实际权益，不能永久豁免未来生效', () => {
  const f = fixture(); f.authorize(); f.execute();
  const noticeSnapshot = () => {
    const snap = f.snapshot(); snap.notices.status = 'ready'; snap.notices.data = { total: 1, items: [{ id: 'AN123456789013', date: '2026-09-29', title: '关于即将实施权益分派的公告' }] };
    return snap;
  };
  assert.match(f.engine.agencyAutomaticBlock('sz000001', f.quote(), noticeSnapshot()), /公司行为公告/);
  f.engine.agencyReconcile({ strategyId: 'swing', symbol: '000001', eventId: 'review-20260929', effectiveDate: '2026-09-29', confirmationOnly: true,
    evidence: '公告原文已核对，当前尚未到权益登记及到账日期' });
  assert.equal(f.engine.agencyAutomaticBlock('sz000001', f.quote(), noticeSnapshot()), null);
  f.day('2026-09-30');
  assert.match(f.engine.agencyAutomaticBlock('sz000001', f.quote(), noticeSnapshot()), /公司行为公告/);
  assert.equal(f.engine.s.agency.groups.find(g => g.id === 'swing').members[0].reconciliation.status, 'pending');
});

test('同组、手动和其他组持仓旧价均阻断自动新买，新鲜估值批次恢复且不预写持仓标价', () => {
  for (const owner of ['same-group', 'manual', 'other-group']) {
    const f = fixture();
    let heldSymbol = 'sz000001', targetSymbol = 'sh600000', targetStrategy = 'swing';
    if (owner === 'manual') {
      heldSymbol = 'sh600000'; targetSymbol = 'sz000001';
      f.engine.execute({ symbol: heldSymbol, side: 'buy', quantity: 100 }, f.quote({ symbol: heldSymbol })); f.authorize();
    } else {
      f.authorize(); f.execute();
      if (owner === 'other-group') { targetStrategy = 'short'; f.engine.agencyTransfer({ strategyId: 'short', amount: 30000 }); f.engine.agencyMode({ strategyId: 'short', mode: 'running' }); }
      f.engine.agencyMember({ strategyId: targetStrategy, symbol: targetSymbol, action: 'add' });
    }
    f.advance(600000);
    const q = f.quote({ symbol: targetSymbol, amount: 2e8 }), snap = f.snapshot({}, targetSymbol);
    if (targetStrategy === 'short') Object.assign(snap.technical, { ma5: 10.02, ma20: 10, previousMa20: 9.9,
      levels: { short: { support: 9.7, resistance: 11.5, entryLow: 9.9, entryHigh: 10.3, stop: 9.6, target: 11.5 } } });
    const blocked = f.engine.agencyEvaluate(targetStrategy, targetSymbol, q, snap);
    assert.equal(blocked.buyable, false, owner); assert.match(blocked.reasons.join(), /持仓.*估值报价/);
    const marks = structuredClone(f.engine.s.marks);
    const batch = { [targetSymbol]: q, [heldSymbol]: { symbol: heldSymbol, price: 10.1, timestamp: q.timestamp, date: q.date, source: 'fresh valuation only' } };
    const allowed = f.engine.agencyEvaluate(targetStrategy, targetSymbol, q, snap, undefined, batch);
    assert.equal(allowed.buyable, true, `${owner}: ${allowed.reasons.join()}`);
    assert.deepEqual(f.engine.s.marks, marks, '估值检查不能在成交前覆盖账户保存的标价');
    assert.equal(allowed.valuationEvidence.quotes[0].timestamp, q.timestamp);
    const a = f.engine.s.agency;
    const trade = f.engine.agencyExecute({ strategyId: targetStrategy, symbol: targetSymbol, action: 'buy', targetPercent: 30,
      decisionId: `fresh-${owner}`, expectedEpoch: a.epoch, expectedRevision: a.revision }, q, snap, batch);
    assert.ok(trade.quantity > 0); assert.equal(trade.owner, targetStrategy); assert.equal(validState(f.engine.s), true);
    assert.deepEqual(f.engine.s.marks[heldSymbol], marks[heldSymbol], '完成另一股买入也不预写非成交持仓的估值缓存');
  }
});

test('持仓估值拒绝错股、非正价、跨日与超时；不要求盘口且准确接受90秒和15秒边界', () => {
  const f = fixture(), heldSymbol = 'sh600000';
  f.engine.execute({ symbol: heldSymbol, side: 'buy', quantity: 100 }, f.quote({ symbol: heldSymbol })); f.authorize();
  const q = f.quote(), snap = f.snapshot(), mark = { symbol: heldSymbol, price: 10.1, timestamp: q.timestamp, date: q.date };
  for (const invalid of [{ symbol: 'sh600001' }, { price: 0 }, { price: NaN }, { timestamp: NaN },
    { timestamp: q.timestamp - 90001 }, { timestamp: q.timestamp + 15001 }, { date: '2026-09-28' }]) {
    const result = f.engine.agencyEvaluate('swing', 'sz000001', q, snap, undefined, { [heldSymbol]: { ...mark, ...invalid } });
    assert.equal(result.buyable, false); assert.match(result.reasons.join(), /估值报价/);
  }
  for (const offset of [-90000, 15000]) {
    const result = f.engine.agencyEvaluate('swing', 'sz000001', q, snap, undefined, { [heldSymbol]: { ...mark, timestamp: q.timestamp + offset } });
    assert.equal(result.buyable, true);
  }
});

test('最新持仓估值参与真实下单数量，旧300股预算收紧为200股且每次重验使用相同快照', () => {
  const f = fixture(); f.authorize(); f.execute(); f.engine.agencyMember({ strategyId: 'swing', symbol: '600000', action: 'add' });
  f.engine.agencyConfigure({ strategyId: 'swing', limits: { maxPosition: 0.06072 } });
  const q = f.quote({ symbol: 'sh600000' }), snap = f.snapshot({}, 'sh600000');
  const oldPrice = f.engine.agencyEvaluate('swing', 'sh600000', q, snap);
  assert.equal(oldPrice.quantity, 300);
  f.advance(600000); const current = f.quote({ symbol: 'sh600000' }), currentSnap = f.snapshot({}, 'sh600000');
  const batch = { sh600000: current, sz000001: { symbol: 'sz000001', price: 9.1, timestamp: current.timestamp, date: current.date } };
  const revised = f.engine.agencyEvaluate('swing', 'sh600000', current, currentSnap, undefined, batch);
  assert.equal(revised.quantity, 200); assert.equal(revised.valuationEvidence.quotes[0].price, 9.1);
  const a = f.engine.s.agency;
  const trade = f.engine.agencyExecute({ strategyId: 'swing', symbol: 'sh600000', action: 'buy', targetPercent: 6.072,
    decisionId: 'same-valuation-batch', expectedEpoch: a.epoch, expectedRevision: a.revision }, current, currentSnap, batch);
  assert.equal(trade.quantity, 200); assert.equal(validState(f.engine.s), true);
});

test('其他持仓缺少新估值不会阻止当前持仓的硬退出或已授权退出', () => {
  for (const throughTick of [true, false]) {
    const f = fixture();
    f.engine.execute({ symbol: 'sh600000', side: 'buy', quantity: 100 }, f.quote({ symbol: 'sh600000' }));
    f.authorize(); const buy = f.execute(); f.day('2026-09-30');
    const quote = f.quote({ price: 9.5, bid: 9.5 }), snap = f.snapshot();
    const result = throughTick ? f.engine.tick({ sz000001: quote }, { sz000001: snap })[0] : f.execute('sell', {}, quote, snap);
    assert.equal(result.side, 'sell'); assert.equal(result.quantity, buy.quantity);
    assert.equal(f.engine.positions()[0].symbol, 'sh600000'); assert.equal(f.engine.positions().length, 1); assert.equal(validState(f.engine.s), true);
  }
});
