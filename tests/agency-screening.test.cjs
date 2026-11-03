const test = require('node:test');
const assert = require('node:assert/strict');
const { Screener, classifyScreenRow, defaults } = require('../core/screener.cjs');
const { runAgencyScreening: screenAgency, poolPolicy, AGENCY_POOL_POLICY } = require('../core/agency-screening.cjs');
const runAgencyScreening = screenAgency;
const { composeAgencySelectionQuery } = require('../core/agency-selection.cjs');
const { calendarSession } = require('../core/trading-calendar.cjs');
const { companyBundle } = require('./fixtures/company-evidence-data.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');

const NOW = new Date('2026-10-13T10:00:00+08:00');
const IDS = ['ultra-short', 'short', 'swing', 'long'];
function bars(end = '2026-10-12') {
  const dates = []; let day = Date.parse(`${end}T10:00:00+08:00`);
  while (dates.length < 120) {
    const session = calendarSession(new Date(day));
    if (session.open) dates.unshift(session.date);
    day -= 86400000;
  }
  // A rising but two-sided series keeps RSI inside the stricter candidate band;
  // anchor its last completed close to the quote fixtures' 10.94 reference.
  const level = i => i * 0.008 + Math.sin(i / 4 + 1.6) * 0.12 + (i % 2 === 0 ? 0.02 : -0.02);
  return dates.map((date, i) => {
    const close = 10.94 + level(i) - level(119);
    return { date, open: close, close, high: close + 0.1, low: close - 0.1, volume: i === 119 ? 150 : 100 };
  });
}
const row = (symbol = 'sh600001', extra = {}) => ({ symbol, name: '隔离测试', board: 'sh', isST: false,
  timestamp: NOW.getTime(), price: 11.05, prevClose: 10.94, changePct: 1, amount: 3, turnover: 3, pe: 20, pb: 2, ...extra });
const annual = year => ({ reportDate: `${year}-12-31`, noticeDate: `${year + 1}-03-30`, currency: 'CNY', roe: 12, adjustedProfit: 2e8, operatingCash: 3e8 });
const report = (extra = {}) => ({ latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', currency: 'CNY', roe: 9,
  debtRatio: 40, adjustedProfit: 1e8, revenueYoY: 10, adjustedProfitYoY: 10, operatingCash: 2e8, ...extra }, annual: [annual(2025), annual(2024), annual(2023)] });
function scanner({ rows = [row()], now = NOW, finance, daily, automatic, notices, load } = {}) {
  const calls = { snapshot: 0, finance: [], daily: [], evidence: [], notices: [], risk: 0 };
  const s = new Screener(null, null, async (symbol, signal) => {
    calls.daily.push(symbol); return daily ? daily(symbol, signal) : { bars: bars(), source: '隔离未复权日线' };
  }, () => now, async (symbol, signal, force) => {
    calls.finance.push({ symbol, force });
    const response = finance ? await finance(symbol, signal) : { symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: now.getTime(), data: report() };
    return { industryProfile: ordinaryProfile(symbol, now), ...response };
  }, async (symbol, signal, force) => {
    calls.notices.push({ symbol, force }); return notices ? notices(symbol, signal) : { symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } };
  }, async () => { calls.risk++; throw Error('候选扫描不可调用盘中90秒风险报价'); }, null, () => { throw Error('自动候选不能依赖人工证据库'); }, async (symbol, { signal }) => {
    calls.evidence.push(symbol); return automatic ? automatic(symbol, signal) : companyBundle(symbol, now);
  });
  s.load = async force => { calls.snapshot++; return load ? load(force) : { rows: structuredClone(rows), source: '隔离行情', fetchedAt: now.getTime(), sourceCount: rows.length, excludedCount: 0 }; };
  return { s, calls };
}
const state = (result, id, symbol) => ['pass', 'failed', 'pending'].find(key => result.strategies[id][key].some(item => item.symbol === symbol));


test('早盘累计成交额与换手不足只待核验，完整收盘数据才可明确不合格', async () => {
  const low = row('sh600001', { amount: 0.1, turnover: 0.1 });
  const intraday = await runAgencyScreening(scanner({ rows: [low] }).s);
  assert.equal(state(intraday, 'ultra-short', low.symbol), 'pending'); assert.equal(state(intraday, 'short', low.symbol), 'pending');
  assert.equal(state(intraday, 'swing', low.symbol), 'pending'); assert.equal(state(intraday, 'long', low.symbol), 'pending');
  const now = new Date('2026-10-13T19:00:00+08:00'), closed = row(low.symbol, { amount: 0.1, turnover: 0.1, price: 10.94, timestamp: Date.parse('2026-10-13T15:00:00+08:00') });
  const result = await runAgencyScreening(scanner({ rows: [closed], now, daily: () => ({ bars: bars('2026-10-13') }) }).s);
  assert.equal(state(result, 'ultra-short', low.symbol), 'failed'); assert.equal(state(result, 'short', low.symbol), 'failed');
});

test('周末与盘前使用最近完整交易日，可重复手动更新且无次数限制', async () => {
  for (const now of [new Date('2026-10-10T08:00:00+08:00'), new Date('2026-10-12T08:00:00+08:00')]) {
    const { s, calls } = scanner({ now, rows: [row('sh600001', { price: 10.94, timestamp: Date.parse('2026-10-09T15:00:00+08:00') })], daily: () => ({ bars: bars('2026-10-09') }) });
    for (let i = 0; i < 2; i++) {
      const result = await runAgencyScreening(s);
      for (const id of IDS) assert.equal(result.strategies[id].pass.length, 1, `${now.toISOString()} ${id}`);
      assert.equal(result.sources.expectedQuoteDate, now.getUTCDate() === 10 ? '2026-10-09' : '2026-10-12');
      assert.deepEqual(result.sources.allowedQuoteDates, now.getUTCDate() === 10 ? ['2026-10-09'] : ['2026-10-12', '2026-10-09']);
      assert.equal(result.sources.expectedDailyDate, '2026-10-09');
    }
    assert.equal(calls.snapshot, 2); assert.equal(calls.finance.length, 0); assert.equal(calls.notices.length, 0);
  }
});

test('真实形状盘前和集合竞价当日报价可核验；昨日收盘也有效，当天累计额仍未完成', async () => {
  for (const time of ['09:11:40', '09:25:00']) {
    const now = new Date(`2026-10-13T${time}+08:00`);
    const current = row('sh600001', { timestamp: now.getTime(), amount: 0, turnover: 0 });
    const previous = row('sh600002', { timestamp: Date.parse('2026-10-12T15:00:00+08:00'), price: 10.94, prevClose: null });
    const previousLow = { ...previous, symbol: 'sh600003', amount: 0.1, turnover: 0.1 };
    const { s, calls } = scanner({ now, rows: [current, previous, previousLow] });
    const result = await runAgencyScreening(s);
    assert.equal(calls.evidence.length, 0); assert.equal(result.sources.expectedQuoteDate, '2026-10-13');
    assert.deepEqual(result.sources.allowedQuoteDates, ['2026-10-13', '2026-10-12']);
    assert.equal(result.sources.expectedDailyDate, '2026-10-12');
    for (const id of IDS) assert.equal(state(result, id, previous.symbol), 'pass');
    for (const id of IDS) {
      assert.equal(state(result, id, current.symbol), 'pending');
      assert.match(result.strategies[id].pending.find(item => item.symbol === current.symbol).reasons.join(''), /累计值尚未完成/);
      assert.equal(state(result, id, previousLow.symbol), 'failed');
    }
  }
});

test('交易日09:30起及盘后不沿用前日行情，节假日继续允许最近完整交易日', async () => {
  for (const time of ['09:30:00', '10:00:00', '16:00:00']) {
    const now = new Date(`2026-10-13T${time}+08:00`), { s, calls } = scanner({ now,
      rows: [row('sh600001', { timestamp: Date.parse('2026-10-12T15:00:00+08:00'), price: 10.94 })] });
    const result = await runAgencyScreening(s);
    assert.deepEqual(result.sources.allowedQuoteDates, ['2026-10-13']);
    for (const id of IDS) { assert.equal(state(result, id, 'sh600001'), 'pending'); assert.equal(result.strategies[id].pending[0].stage, 'quotes'); }
    assert.equal(calls.finance.length, 0);
  }
  const now = new Date('2026-10-06T09:11:40+08:00');
  const result = await runAgencyScreening(scanner({ now, rows: [row('sh600001', { timestamp: Date.parse('2026-09-30T15:00:00+08:00'), price: 10.94 })], daily: () => ({ bars: bars('2026-09-30') }) }).s);
  assert.deepEqual(result.sources.allowedQuoteDates, ['2026-09-30']);
  for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pass');
});

test('旧行情、未来报价与旧日线均不能误作明确失败或有效候选', async () => {
  for (const timestamp of [null, NOW.getTime() + 1000, Date.parse('2026-10-09T15:00:00+08:00')]) {
    const { s, calls } = scanner({ rows: [row('sh600001', { timestamp, amount: 0 })] });
    const result = await runAgencyScreening(s);
    for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pending');
    assert.equal(calls.finance.length, 0);
  }
  const result = await runAgencyScreening(scanner({ daily: () => ({ bars: bars('2026-10-09') }) }).s);
  for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pending');
});

test('旧行情上的ST名称不能作为本次明确剔除依据，日期检查先于ST条件', async () => {
  const { s, calls } = scanner({ rows: [row('sh600001', { isST: true, name: '*ST旧名称', timestamp: Date.parse('2026-10-09T15:00:00+08:00') })] });
  const result = await runAgencyScreening(s);
  for (const id of IDS) { assert.equal(state(result, id, 'sh600001'), 'pending'); assert.equal(result.strategies[id].pending[0].stage, 'quotes'); }
  assert.equal(calls.evidence.length, 0); assert.equal(calls.finance.length, 0);
});

test('跨日日线比对同源昨收，同日完整日线比对收盘报价，缺失或错配只待核验', async () => {
  for (const prevClose of [null, 20]) {
    const result = await runAgencyScreening(scanner({ rows: [row('sh600001', { prevClose })] }).s);
    for (const id of IDS) { assert.equal(state(result, id, 'sh600001'), 'pending'); assert.match(result.strategies[id].pending[0].reasons.join(''), /价格基准/); }
  }
  const now = new Date('2026-10-10T08:00:00+08:00');
  for (const price of [10.94, 20]) {
    const result = await runAgencyScreening(scanner({ now, rows: [row('sh600001', { timestamp: Date.parse('2026-10-09T15:00:00+08:00'), price, prevClose: null })], daily: () => ({ bars: bars('2026-10-09') }) }).s);
    for (const id of IDS) assert.equal(state(result, id, 'sh600001'), price === 10.94 ? 'pass' : 'pending');
  }
});

test('跨15点的同轮日线使用行情完成时固定的观察时点，不混入刚完成或未来日线', async () => {
  const now = new Date('2026-10-13T14:59:50+08:00'), observedAt = now.toISOString(), observedMs = now.getTime();
  const previous = bars(), future = date => ({ date, open: 999, high: 1000, low: 998, close: 999, volume: 100 });
  const { s } = scanner({ now, rows: [row('sh600001', { timestamp: observedMs })], daily: () => {
    now.setTime(Date.parse('2026-10-13T15:00:05+08:00'));
    return { bars: [...previous, future('2026-10-13'), future('2026-10-14')] }; } });
  const result = await runAgencyScreening(s);
  for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pass');
  assert.equal(result.sources.scanTime, observedAt); assert.equal(result.sources.expectedDailyDate, '2026-10-12');
  assert.equal(result.sources.finance, null); assert.equal(result.sources.technical.asOfCutoff, observedAt);
  assert.equal(result.sources.technical.startedAt, observedMs);
  assert.equal(result.strategies.swing.pass[0].technicalAsOf, '2026-10-12');
  assert.equal(result.strategies.swing.pass[0].close, previous.at(-1).close);
  assert.equal(result.strategies.swing.pass[0].technicalFetchedAt, now.getTime());
  assert.equal(s.dailyCache.get('sh600001').cutoff, '2026-10-13:intraday');
});

test('快照加载跨收盘时以加载完成时为基准，允许已完整的当日日线', async () => {
  const now = new Date('2026-10-13T14:59:50+08:00');
  const { s } = scanner({ now, load: () => {
    now.setTime(Date.parse('2026-10-13T15:00:05+08:00'));
    return { rows: [row('sh600001', { timestamp: Date.parse('2026-10-13T15:00:00+08:00'), price: 10.94 })], sourceCount: 1, excludedCount: 0 };
  }, daily: () => ({ bars: bars('2026-10-13') }) });
  const result = await runAgencyScreening(s);
  for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pass');
  assert.equal(result.sources.scanTime, now.toISOString()); assert.equal(result.sources.expectedDailyDate, '2026-10-13');
});

test('跨午夜或盘前跨开盘不改变本轮日期基准，实际获取时间仍持续前进', async () => {
  for (const [start, finish, end, cutoff] of [
    ['2026-10-13T23:59:55+08:00', '2026-10-14T00:00:05+08:00', '2026-10-13', '2026-10-13:closed'],
    ['2026-10-13T09:29:55+08:00', '2026-10-13T09:30:05+08:00', '2026-10-12', '2026-10-13:intraday']
  ]) {
    const now = new Date(start), observedAt = now.toISOString();
    const { s } = scanner({ now, rows: [row('sh600001', { timestamp: Date.parse(`${end}T15:00:00+08:00`), price: 10.94, prevClose: null })],
      daily: () => { now.setTime(Date.parse(finish)); return { bars: bars(end) }; } });
    const result = await runAgencyScreening(s);
    for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'pass', `${start} ${id}`);
    assert.equal(result.sources.scanTime, observedAt); assert.equal(result.sources.finance, null);
    assert.equal(result.sources.technical.asOfCutoff, observedAt); assert.equal(result.sources.expectedDailyDate, end);
    assert.equal(s.dailyCache.get('sh600001').cutoff, cutoff); assert.equal(s.financeCache.size, 0);
    assert.equal(result.sources.technical.startedAt, Date.parse(start)); assert.equal(result.finishedAt, now.getTime());
  }
});

test('技术根数不足、数据无效、获取失败、旧日线及价格错配分别保留可统计原因', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(`sh60000${i + 1}`, i === 4 ? { prevClose: 20 } : {}));
  const { s } = scanner({ rows, daily: symbol => {
    if (symbol.endsWith('1')) return { bars: bars().slice(-60) };
    if (symbol.endsWith('2')) return { bars: [...bars(), bars().at(-1)] };
    if (symbol.endsWith('3')) throw Error('isolated net::ERR_HTTP2_PROTOCOL_ERROR');
    return { bars: bars(symbol.endsWith('4') ? '2026-10-09' : '2026-10-12') };
  } });
  const result = await runAgencyScreening(s), kinds = ['insufficient', 'invalid', 'fetch', 'stale', 'mismatch'];
  for (const id of IDS.slice(0, 3)) for (let i = 0; i < rows.length; i++) {
    const item = result.strategies[id].pending.find(item => item.symbol === rows[i].symbol);
    assert.ok(item); assert.equal(item.stage, 'daily'); assert.equal(item.technicalError, kinds[i]);
  }
  assert.deepEqual(result.coverage.technicalFailures, { insufficient: 1, invalid: 1, fetch: 1 });
  assert.match(result.strategies.swing.pending[2].technicalErrorDetail, /ERR_HTTP2_PROTOCOL_ERROR/);
  assert.doesNotMatch(result.strategies.swing.pending[0].reasons.join(''), /日期 未知/);
});

test('技术日期比本轮允许日期更晚也只能待核验，不能用日期大于等于条件放行', async () => {
  const { s } = scanner(), original = s.scanDaily.bind(s);
  s.scanDaily = async (...args) => {
    const result = await original(...args);
    return { ...result, rows: result.rows.map(item => ({ ...item, technicalAsOf: '2026-10-13' })) };
  };
  const result = await runAgencyScreening(s);
  for (const id of IDS) { assert.equal(state(result, id, 'sh600001'), 'pending'); assert.equal(result.strategies[id].pending[0].technicalError, 'mismatch'); }
});

test('快照失败、不完整和重复均抛错，不能发布空成功；忙碌不可覆盖锁', async () => {
  for (const load of [() => { throw Error('离线'); }, () => ({ rows: [], sourceCount: 0 }), () => ({ rows: [row()], sourceCount: 2 }), () => ({ rows: [row(), row()] })]) {
    const { s } = scanner({ load }); await assert.rejects(runAgencyScreening(s)); assert.equal(s.activeRun, null); assert.equal(s.progress.loading, false);
  }
  const { s } = scanner(); const active = new AbortController(); s.activeRun = active;
  await assert.rejects(runAgencyScreening(s), /已有选股任务/); assert.equal(s.activeRun, active);
});

test('日线服务忽略signal时仍能立即取消，不发布部分扫描', async () => {
  for (const stage of ['daily']) {
    let began; const started = new Promise(resolve => { began = resolve; });
    const { s } = scanner({ [stage]: () => { began(); return new Promise(() => {}); } });
    const running = runAgencyScreening(s); await started; s.cancel();
    await assert.rejects(running, /取消/); assert.equal(s.activeRun, null); assert.equal(s.progress.loading, false);
  }
});

test('普通数值筛选与执行时行情校验未被候选扫描语义放宽，策略快照隔离', async () => {
  const query = { ...defaults(), rules: [{ field: 'amount', op: 'gte', value: 2 }] };
  assert.equal(classifyScreenRow(row('sh600001', { amount: 0.1 }), query).status, 'failed');
  assert.equal(classifyScreenRow(row('sh600001', { amount: null }), query).status, 'pending');
  assert.equal(classifyScreenRow(row('sh600001', { amount: 0.1 }), query, { deferMinimumFields: ['amount'] }).status, 'pending');
  const policy = poolPolicy('strict'); policy.commonQuery.excludeST = false; policy.priority.reverse();
  assert.equal(poolPolicy('strict').commonQuery.excludeST, true); assert.deepEqual(poolPolicy().priority, IDS);
  assert.equal(AGENCY_POOL_POLICY.version, 3); assert.deepEqual(AGENCY_POOL_POLICY.commonQuery.rules, []);
  const { s } = scanner({ now: new Date('2026-10-10T08:00:00+08:00'), rows: [row('sh600001', { timestamp: Date.parse('2026-10-09T15:00:00+08:00') })] });
  const ordinary = await s.run(defaults(), [], false, null, 'short');
  assert.equal(ordinary.rows.length, 0); assert.equal(ordinary.riskExcluded[0].entryRisk.status, 'unverified');
});

test('稳健扫描用真实完整日线的波幅按周期分流，不从行情振幅冒充历史波动', async () => {
  const levels = new Map([['sh600001', 2.5], ['sh600002', 3.5], ['sh600003', 4.5], ['sh600004', 5.5], ['sh600005', 6.5]]);
  const { s } = scanner({ rows: [...levels.keys()].map(symbol => row(symbol, { amplitude: 0.1 })), daily: symbol => {
    const halfWidth = 10.94 * levels.get(symbol) / 200;
    return { bars: bars().map(bar => ({ ...bar, high: bar.close + halfWidth, low: bar.close - halfWidth })), source: '隔离未复权日线' };
  } });
  const result = await screenAgency(s);
  for (const [symbol, atrPct] of levels) {
    for (const [id, maximum] of [['ultra-short', 6], ['short', 5], ['swing', 4], ['long', 3]]) {
      assert.equal(state(result, id, symbol), atrPct < maximum ? 'pass' : 'failed', `${id} ${symbol} ${atrPct}`);
    }
  }
  assert.ok(Math.abs(result.strategies.long.pass[0].atrPct14 - 2.5) < 1e-8);
});

test('长线偏离根据日线收盘和MA60计算，移除财务后仍不能过度追高', async () => {
  for (const [step, expected] of [[0.03, 'pass'], [0.05, 'failed']]) {
    const { s } = scanner({ daily: () => ({ source: '隔离未复权日线', bars: bars().map((bar, index) => {
      const close = 10.94 - (119 - index) * step;
      return { ...bar, open: close, close, high: close + 0.1, low: close - 0.1 };
    }) }) });
    const result = await screenAgency(s);
    assert.equal(state(result, 'long', 'sh600001'), expected, `step=${step}`);
    if (expected === 'failed') assert.match(result.strategies.long.failed[0].reasons.join('；'), /偏离|乖离/);
  }
});

test('稳健四策略盘中成交额不足仅待核验，最近完整收盘不足才明确失败', async () => {
  const symbol = 'sh600001';
  for (const time of ['09:25:00', '10:00:00']) {
    const now = new Date(`2026-10-13T${time}+08:00`);
    const result = await screenAgency(scanner({ now, rows: [row(symbol, { timestamp: +now, amount: 0.1 })] }).s);
    for (const id of IDS) {
      assert.equal(state(result, id, symbol), 'pending', `${id} ${time}`);
      assert.match(result.strategies[id].pending[0].reasons.join('；'), /累计值尚未完成/, `${id} ${time}`);
    }
  }
  const now = new Date('2026-10-13T16:00:00+08:00');
  const result = await screenAgency(scanner({ now, rows: [row(symbol, { timestamp: Date.parse('2026-10-13T15:00:00+08:00'), price: 10.94, amount: 0.1 })],
    daily: () => ({ bars: bars('2026-10-13'), source: '隔离未复权日线' }) }).s);
  for (const id of IDS) assert.equal(state(result, id, symbol), 'failed', id);
});

test('稳健新增日线指标不采纳未完成当天极端行情，保持本轮完整日线边界', async () => {
  const { s } = scanner({ daily: () => ({ source: '隔离未复权日线', bars: [...bars(),
    { date: '2026-10-13', open: 100, close: 150, high: 200, low: 1, volume: 100000 },
    { date: '2026-10-14', open: 200, close: 200, high: 300, low: 1, volume: 100000 }] }) });
  const result = await screenAgency(s);
  for (const id of IDS) {
    assert.equal(state(result, id, 'sh600001'), 'pass', id);
    const selected = result.strategies[id].pass[0];
    assert.equal(selected.technicalAsOf, '2026-10-12'); assert.equal(selected.close, 10.94);
    assert.ok(selected.atrPct14 > 0 && selected.atrPct14 < 3);
  }
});

test('旧技术缓存缺少稳健字段时重新获取真实日线，不能按旧通过结果放行', async () => {
  const { s, calls } = scanner();
  const first = await screenAgency(s);
  for (const id of IDS) assert.equal(state(first, id, 'sh600001'), 'pass', id);
  const cached = s.screeningDataCache.get('daily', 'sh600001');
  assert.ok(cached, '应有可复用完整日线缓存');
  for (const field of ['atrPct14', 'biasMa5Pct', 'biasMa20Pct', 'biasMa60Pct', 'ma20Change5Pct']) delete cached.data[field];
  s.dailyLoader = async symbol => {
    calls.daily.push(symbol);
    return { source: '隔离未复权日线', bars: bars().map(bar => ({ ...bar, high: bar.close + 0.4, low: bar.close - 0.4 })) };
  };
  const result = await screenAgency(s);
  assert.equal(calls.daily.length, 2);
  for (const id of IDS) assert.equal(state(result, id, 'sh600001'), 'failed', id);
  assert.ok(s.screeningDataCache.get('daily', 'sh600001').data.atrPct14 > 6);
});

test('稳健指标获取失败保持待核验，不利用上次通过结果和缺失默认值放行', async () => {
  const { s } = scanner();
  await screenAgency(s);
  s.dailyLoader = async () => { throw Error('隔离新日线暂不可用'); };
  const result = await screenAgency(s, { refreshQuantitative: true });
  for (const id of IDS) {
    assert.equal(state(result, id, 'sh600001'), 'pending', id);
    assert.equal(result.strategies[id].pending[0].technicalError, 'fetch');
  }
});

test('旧严格研究、公告与财务接口不可用时纯技术候选仍能入围，停用不冒充通过', async () => {
  for (const screeningMode of ['strategy', 'strict']) {
    const unavailable = () => { throw Error('net::ERR_HTTP2_PROTOCOL_ERROR'); };
    const { s, calls } = scanner({ finance: unavailable, automatic: unavailable, notices: unavailable,
      rows: [row('sh600001', { pe: null, pb: null })] });
    s.beginEvidenceBatch = s.endEvidenceBatch = s.evidenceRetention = unavailable;
    const result = await screenAgency(s, { screeningMode, research: { invalidLegacy: true }, performance: { invalidLegacy: true }, industry: { invalidLegacy: true } });
    assert.equal(result.screeningMode, 'strategy'); assert.equal(result.status, 'ready');
    assert.equal(calls.finance.length + calls.notices.length + calls.evidence.length, 0); assert.equal(calls.daily.length, 1);
    for (const id of IDS) {
      assert.equal(state(result, id, 'sh600001'), 'pass');
      const candidate = result.strategies[id].pass[0];
      assert.equal(candidate.researchChecks.status, 'disabled'); assert.equal(candidate.financeCheck, undefined);
      assert.equal(candidate.noticeReview, undefined); assert.equal(candidate.entryRisk, undefined);
    }
    assert.equal(result.coverage.researchRequired, false); assert.equal(result.coverage.researchStatus, 'disabled');
    assert.equal(result.coverage.noticesChecked + result.coverage.financeChecked + result.coverage.evidenceChecked, 0);
  }
});

test('纯技术扫描仍排除有效ST，池外成员和日线失败待核验但不再提示等待研究', async () => {
  const { s, calls } = scanner({ rows: [row('sh600001', { isST: true }), row('sh600002')], daily: () => { throw Error('日线离线'); } });
  const result = await screenAgency(s, { requiredSymbols: ['sh600003'] });
  for (const id of IDS) {
    assert.equal(state(result, id, 'sh600001'), 'failed'); assert.equal(state(result, id, 'sh600002'), 'pending');
    assert.equal(state(result, id, 'sh600003'), 'pending');
  }
  assert.deepEqual(calls.daily, ['sh600002']); assert.equal(result.coverage.diagnostics.researchNotStarted, 0);
  assert.equal(result.coverage.diagnostics.stages['research-not-started'], undefined);
  assert.equal(result.coverage.diagnostics.stages['daily-download'].count, 1);
});

test('取消研究后短线行情跌幅和缺失拦截继续生效', async () => {
  for (const [changePct, expected] of [[-5, 'failed'], [null, 'pending']]) {
    const result = await screenAgency(scanner({ rows: [row('sh600001', { changePct })] }).s);
    for (const id of ['ultra-short', 'short']) { assert.equal(state(result, id, 'sh600001'), expected); assert.equal(result.strategies[id][expected][0].stage, 'market-risk'); }
    for (const id of ['swing', 'long']) assert.equal(state(result, id, 'sh600001'), 'pass');
  }
});
