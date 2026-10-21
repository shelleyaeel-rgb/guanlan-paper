const test = require('node:test');
const assert = require('node:assert/strict');
const { FIELDS, FINANCIAL_FIELDS, Screener, defaults, validate, normalize, parseDescription, screen } = require('../core/screener.cjs');
const { Research } = require('../core/research.cjs');
const { financialRow, data } = require('./fixtures/research-data.cjs');
const now = new Date('2026-10-08T10:00:00+08:00');
const parse = text => parseDescription(text).query;
function row(code = '600001', extra = {}) {
  return normalize({ f12: code, f13: 1, f14: '测试', f2: 10, f3: 1, f5: 1000, f6: 1e8, f7: 2, f8: 3, f9: 15, f10: 2, f20: 1e10, f21: 1e10, f23: 2, f124: now.getTime() / 1000, ...extra });
}
function report(symbol = 'sh600001', extra = {}, wrapper = {}) {
  return { symbol, section: 'finance', status: 'ready', fetchedAt: now.getTime(), source: '东方财富', data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', updateDate: '2026-08-20', currency: 'CNY', roe: 15, debtRatio: 50, revenueYoY: 10, profitYoY: 20, adjustedProfitYoY: 15, operatingCash: 2e8, ...extra } }, ...wrapper };
}
function scanner(loader, rows = [row()], { daily = null, clock = () => now, history = null } = {}) {
  const s = new Screener(async () => { throw Error('unexpected quotes'); }, history, daily, clock, loader);
  s.snapshot = { rows, fetchedAt: now.getTime(), source: '隔离行情', sourceCount: rows.length };
  s.load = async () => s.snapshot;
  return s;
}
function bars() {
  return Array.from({ length: 120 }, (_, i) => {
    const close = 10 + i * 0.02, date = new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10);
    return { date, close, open: close, high: close + 0.1, low: close - 0.1, volume: 100 };
  });
}

test('基本面别名对应真实字段，百分数不缩放，经营现金流按亿元换算', () => {
  const parsed = parseDescription('加权ROE不低于10%，资产负债率不超过60%，营业收入同比增长率大于5%，净利润同比大于10%，扣非净利润同比大于8%，经营现金流不低于5000万元');
  assert.deepEqual(parsed.query.rules, [
    { field: 'roe', op: 'gte', value: 10 }, { field: 'debtRatio', op: 'lte', value: 60 },
    { field: 'revenueYoY', op: 'gt', value: 5 }, { field: 'profitYoY', op: 'gt', value: 10 },
    { field: 'adjustedProfitYoY', op: 'gt', value: 8 }, { field: 'operatingCash', op: 'gte', value: 0.5 }
  ]);
  assert.match(parsed.notes.join(''), /非年化/); assert.match(parsed.notes.join(''), /归母/);
  for (const alias of ['ROE', 'roe', '加权ROE', '净资产收益率', '加权净资产收益率']) assert.deepEqual(parse(`${alias}大于10%`).rules, [{ field: 'roe', op: 'gt', value: 10 }]);
  assert.equal(FINANCIAL_FIELDS.operatingCash.source, 'finance'); assert.equal(FIELDS.roe.source, 'finance');
  assert.deepEqual(parse('经营活动现金流量净额不低于100000000元').rules, [{ field: 'operatingCash', op: 'gte', value: 1 }]);
  for (const text of ['ROE大于10元', '经营现金流大于5%', '净利润同比大于10亿元', '资产负债率不超过-1%', 'ROE大于10%，ROE不超过10%', '净利润同比大于10%或者营收同比大于10%', '近三年ROE大于10%']) assert.throws(() => parse(text));
  assert.throws(() => validate({ ...defaults(), rules: [{ field: 'roe', op: 'gt', valueField: 'debtRatio' }] }));
});

test('基本面负值和零保留，严格/包含边界按实际值执行', async () => {
  const s = scanner(symbol => report(symbol, { roe: -1, debtRatio: 105, revenueYoY: -20, profitYoY: 0, adjustedProfitYoY: -5, operatingCash: -0.5e8 }));
  const result = await s.run(parse('ROE等于-1%，资产负债率不低于100%，营收同比等于-20%，净利润同比等于0%，扣非净利润同比等于-5%，经营现金流等于-0.5亿元'), []);
  assert.equal(result.matched, 1); assert.equal(result.missing, 0);
  assert.equal((await s.run(parse('净利润同比大于0%'), [])).matched, 0);
  assert.equal((await s.run(parse('经营现金流大于-0.5亿元'), [])).matched, 0);
  assert.equal(result.rows[0].financeReportDate, '2026-06-30'); assert.equal(result.rows[0].financeNoticeDate, '2026-08-15');
  assert.equal(result.rows[0].financeFetchedAt, now.getTime()); assert.equal(result.rows[0].financeSource, '东方财富');
});

test('组合按行情预筛、财务、日线逐步执行，前阶段未通过者不请求后续数据', async () => {
  const financeCalls = [], dailyCalls = [];
  const s = scanner(symbol => {
    financeCalls.push(symbol);
    return report(symbol, symbol === 'sh600002' ? { debtRatio: null } : symbol === 'sh600003' ? { roe: 9 } : {});
  }, [row('600001', { f9: 100 }), row('600002'), row('600003'), row('600004'), row('600005'), row('600006', { f9: null })], { daily: async symbol => {
    dailyCalls.push(symbol); if (symbol === 'sh600004') throw Error('offline'); return { bars: bars(), source: '隔离日线' };
  } });
  const before = structuredClone(s.snapshot);
  const result = await s.run(parse('市盈率小于20，ROE不低于10%，资产负债率不超过60%，收盘高于MA20'), []);
  assert.deepEqual(financeCalls, ['sh600002', 'sh600003', 'sh600004', 'sh600005']); assert.deepEqual(dailyCalls, ['sh600004', 'sh600005']);
  assert.deepEqual(result.rows.map(r => r.symbol), ['sh600005']); assert.equal(result.financeCandidates, 4); assert.equal(result.financeEvaluatedCount, 3);
  assert.equal(result.technicalCandidates, 2); assert.equal(result.technicalEvaluatedCount, 1); assert.equal(result.missing, 3); assert.equal(result.evaluatedCount, 3);
  assert.equal(result.missingByField.pe, 1); assert.equal(result.missingByField.debtRatio, 1); assert.equal(result.missingByField.close, 1);
  assert.equal(result.partial, true); assert.match(result.dataMessage, /财务候选 4 只/); assert.match(result.dataMessage, /所需财务指标缺失 1 只/);
  assert.deepEqual(s.snapshot, before);
});

test('财务只扫描所选板块和自选范围，快照无候选时不请求财务', async () => {
  const calls = [], s = scanner(symbol => { calls.push(symbol); return report(symbol); }, [row(), row('600002', { f14: '*ST测试' }), row('688001')]);
  const q = parse('我的自选，主板，排除ST，ROE大于10%');
  assert.equal((await s.run(q, ['sh600001', 'sh600002', 'sh688001'])).matched, 1); assert.deepEqual(calls, ['sh600001']);
  assert.equal((await s.run(parse('市盈率大于100，ROE大于10%'), [])).matched, 0); assert.equal(calls.length, 1);
  const absent = scanner(() => { throw Error('must not fetch'); }, [row('600001', { f9: null })]);
  assert.equal((await absent.run(parse('市盈率小于20，ROE大于10%'), [])).status, 'unavailable');
});

test('缺失值不能变成零，无关指标缺失不影响本次财务条件', async () => {
  for (const value of [null, undefined, '', ' ', '-', '--', [], {}, false, NaN, Infinity]) {
    const s = scanner(symbol => report(symbol, { roe: value, operatingCash: value }));
    const result = await s.run(parse('ROE不超过0%'), []);
    assert.equal(result.status, 'unavailable'); assert.equal(result.matched, null); assert.equal(result.missingByField.roe, 1);
  }
  const s = scanner(symbol => report(symbol, { roe: null, revenueYoY: null, debtRatio: 0, operatingCash: 0 }));
  assert.equal((await s.run(parse('资产负债率等于0%，经营现金流等于0亿元'), [])).matched, 1);
  const empty = await scanner(symbol => report(symbol, { roe: 5 })).run(parse('ROE大于10%'), []);
  assert.equal(empty.status, 'empty'); assert.equal(empty.matched, 0); assert.equal(empty.missing, 0);
});

test('经营现金流只接受人民币报告，币种未知与其他币种均不能当亿元比较', async () => {
  for (const currency of ['USD', 'HKD', '人民币', '', null, undefined]) {
    const s = scanner(symbol => report(symbol, { currency, operatingCash: -2e8 }));
    const result = await s.run(parse('经营现金流小于0亿元'), []);
    assert.equal(result.status, 'unavailable'); assert.equal(result.missingByField.operatingCash, 1);
    assert.equal((await s.run(parse('ROE大于10%'), [])).matched, 1);
  }
});

test('无报告、获取失败、失效缓存与无效财报分开统计，失败不能报告为零匹配', async () => {
  const s = scanner(symbol => {
    if (symbol === 'sh600001') return report(symbol, {}, { status: 'empty', data: { latest: null } });
    if (symbol === 'sh600002') throw Error('offline');
    if (symbol === 'sh600003') return report(symbol, {}, { status: 'stale' });
    if (symbol === 'sh600004') return report(symbol, { noticeDate: null });
    return report(symbol, {}, { status: 'unavailable' });
  }, Array.from({ length: 5 }, (_, i) => row(String(600001 + i))));
  const result = await s.run(parse('ROE小于100%'), []);
  assert.equal(result.status, 'unavailable'); assert.equal(result.matched, null); assert.equal(result.missing, 5);
  assert.deepEqual(result.financeScan.failures, { missing: 1, invalid: 1, fetch: 3 });
  assert.match(result.dataMessage, /无报告 1 只/); assert.match(result.dataMessage, /获取失败 3 只/);
});

test('未来或无效报告期、公告日、更新时间及来源身份不混入当前筛选', async () => {
  const cases = [
    [{ reportDate: '2026-12-31', noticeDate: '2027-03-10' }, {}], [{ noticeDate: '2026-10-09' }, {}],
    [{ updateDate: '2026-10-09' }, {}], [{ noticeDate: '2026-02-30' }, {}], [{ reportDate: '2026-06-29' }, {}],
    [{ noticeDate: '2026-06-29' }, {}], [{ reportDate: null }, {}], [{}, { symbol: 'sh600999' }],
    [{}, { section: 'profile' }], [{}, { fetchedAt: now.getTime() + 1 }], [{}, { fetchedAt: null }]
  ];
  for (const [changes, wrapper] of cases) {
    const result = await scanner(symbol => report(symbol, changes, wrapper)).run(parse('ROE大于10%'), []);
    assert.equal(result.status, 'unavailable'); assert.equal(result.financeScan.failures.invalid, 1);
  }
});

test('Research 当前日期过滤未来财报后使用最近已公告报告，未知公告日仍不筛入', async () => {
  const research = new Research(async () => ({ ok: true, json: async () => data([
    { ...financialRow('sh600001', '2026-09-30'), NOTICE_DATE: '2026-10-20 00:00:00', ROEJQ: 99 },
    financialRow('sh600001', '2026-06-30')
  ]) }), { clock: () => now.getTime() });
  const s = scanner((symbol, signal, force) => research.get({ symbol, section: 'finance', force }));
  const result = await s.run(parse('ROE大于10%，ROE小于20%'), []);
  assert.equal(result.matched, 1); assert.equal(result.rows[0].roe, 16.75); assert.equal(result.rows[0].financeReportDate, '2026-06-30');
});

test('财务缓存复用与到期、跨日、强制刷新遵循查询，强制失败不使用上次值', async () => {
  let time = now.getTime(), calls = 0, fail = false; const forceFlags = [];
  const s = scanner((symbol, signal, force) => {
    calls++; forceFlags.push(force); if (fail) return report(symbol, {}, { status: 'stale' });
    return report(symbol, {}, { fetchedAt: time });
  }, [row()], { clock: () => new Date(time) });
  const q = parse('ROE大于10%'); await s.run(q, []); await s.run(q, []); assert.equal(calls, 1);
  time += 60000; await s.run(q, []); assert.equal(calls, 2);
  await s.run(q, [], true); assert.equal(calls, 3); assert.equal(forceFlags.at(-1), true);
  time = Date.parse('2026-10-09T00:00:00+08:00'); await s.run(q, []); assert.equal(calls, 4);
  fail = true; const result = await s.run(q, [], true);
  assert.equal(result.status, 'unavailable'); assert.equal(s.financeCache.has('sh600001'), false); assert.equal(s.snapshot.rows[0].roe, undefined);
});

test('请求完成时间晚于扫描开始时点的真实财务资料仍可用', async () => {
  let time = now.getTime();
  const s = scanner(symbol => { time += 1000; return report(symbol, {}, { fetchedAt: time }); }, [row()], { clock: () => new Date(time) });
  const result = await s.run(parse('ROE大于10%'), []);
  assert.equal(result.matched, 1); assert.equal(result.rows[0].financeFetchedAt, time);
});

test('财务请求跨午夜仍按本轮观察日期过滤未来披露，次日新扫描才使用新报告', async () => {
  const time = new Date('2026-10-13T23:59:55+08:00'), observedAt = time.toISOString(); let calls = 0;
  const s = scanner(symbol => {
    calls++; time.setTime(Date.parse('2026-10-14T00:00:05+08:00'));
    return report(symbol, { noticeDate: '2026-10-14', updateDate: '2026-10-14' }, { fetchedAt: time.getTime() });
  }, [row()], { clock: () => time });
  const first = await s.run(parse('ROE大于10%'), []);
  assert.equal(first.status, 'unavailable'); assert.equal(first.financeScan.failures.invalid, 1);
  assert.equal(first.financeScan.asOfCutoff, observedAt); assert.equal(first.financeScan.finishedAt, time.getTime());
  assert.equal(s.financeCache.has('sh600001'), false);
  const second = await s.run(parse('ROE大于10%'), []);
  assert.equal(calls, 2); assert.equal(second.matched, 1); assert.equal(second.rows[0].financeNoticeDate, '2026-10-14');
  assert.equal(second.rows[0].financeFetchedAt, time.getTime()); assert.equal(s.financeCache.get('sh600001').cutoff, '2026-10-14');
});

test('显式财务观察日期控制缓存基准，获取时间和缓存失效仍依真实clock', async () => {
  const time = new Date('2026-10-14T00:00:05+08:00'), observed = new Date('2026-10-13T23:59:55+08:00'); let calls = 0;
  const s = scanner(symbol => { calls++; return report(symbol, {}, { fetchedAt: time.getTime() }); }, [row()], { clock: () => time });
  const signal = new AbortController().signal, q = parse('ROE大于10%');
  let result = await s.scanFinance(s.snapshot, q, [], false, signal, observed);
  assert.equal(result.financeScan.asOfCutoff, observed.toISOString()); assert.equal(result.financeScan.startedAt, time.getTime());
  assert.equal(result.rows[0].financeFetchedAt, time.getTime()); assert.equal(s.financeCache.get('sh600001').cutoff, '2026-10-13');
  await s.scanFinance(s.snapshot, q, [], false, signal, observed); assert.equal(calls, 1);
  result = await s.scanFinance(s.snapshot, q, [], false, signal, time); assert.equal(calls, 2);
  assert.equal(s.financeCache.get('sh600001').cutoff, '2026-10-14');
  time.setTime(time.getTime() + 60000);
  await s.scanFinance(s.snapshot, q, [], false, signal, time); assert.equal(calls, 3);
});

test('财务并发不超过三，取消即刻停止排队与发布，即使资料服务不响应取消', async () => {
  let inFlight = 0, peak = 0, calls = 0;
  const rows = Array.from({ length: 10 }, (_, i) => row(String(600001 + i)));
  const s = scanner(async symbol => { calls++; inFlight++; peak = Math.max(peak, inFlight); await new Promise(resolve => setImmediate(resolve)); inFlight--; return report(symbol); }, rows);
  assert.equal((await s.run(parse('ROE大于10%'), [])).matched, 10); assert.equal(calls, 10); assert.equal(peak, 3);
  const signals = [], releases = [];
  s.financeLoader = (symbol, signal) => new Promise(resolve => { signals.push(signal); releases.push(() => resolve(report(symbol))); });
  const task = s.run(parse('ROE大于10%'), [], true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.progress.stage, 'finance'); assert.equal(s.progress.total, 10);
  await assert.rejects(s.run(parse('ROE大于10%'), []), /已有选股/);
  s.cancel(); await assert.rejects(task, /取消/); assert.equal(signals.length, 3); assert.ok(signals.every(signal => signal.aborted));
  assert.equal(s.activeRun, null); assert.equal(s.progress.loading, false); assert.ok(s.snapshot.rows.every(r => !r.financeReportDate));
  releases.forEach(release => release());
  s.financeLoader = symbol => report(symbol); assert.equal((await s.run(parse('ROE大于10%'), [], true)).matched, 10);
});

test('历史快照财务条件在访问历史和网络之前拒绝，不混用当前财报', async () => {
  const s = scanner(() => { throw Error('must not fetch finance'); }, [row()], { history: { get() { throw Error('must not read history'); } } });
  await assert.rejects(s.run(parse('ROE大于10%'), [], false, 'old'), /历史快照未保存当时可知的财务报告/);
  await assert.rejects(s.run(parse('ROE大于10%，收盘高于MA20'), [], false, 'old'), /历史快照未保存当时可知的财务报告/);
  const unavailable = scanner(null); await assert.rejects(unavailable.run(parse('ROE大于10%'), []), /财务资料服务未配置/);
  assert.equal((await unavailable.run(parse('市盈率小于20'), [])).matched, 1);
});

test('纯计算多财务字段缺失仅统计一次，不修改输入条件和行情', () => {
  const snapshot = { rows: [{ ...row(), roe: null, debtRatio: null }, { ...row('600002'), roe: 15, debtRatio: 50 }] };
  const q = parse('ROE不低于10%，资产负债率不超过60%'), before = structuredClone({ snapshot, q });
  const result = screen(snapshot, q);
  assert.equal(result.missing, 1); assert.equal(result.matched, 1); assert.equal(result.financeEvaluatedCount, 1);
  assert.equal(result.missingByField.roe, 1); assert.equal(result.missingByField.debtRatio, 1); assert.deepEqual({ snapshot, q }, before);
});
