const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dailyIndicators } = require('../core/daily-indicators.cjs');
const { prepareHistory } = require('../core/daily-history.cjs');
const { technicals, evaluateEntry } = require('../core/strategy.cjs');
const { analyze } = require('../core/analysis.cjs');
const { parseDescription, validate, defaults, normalize, screen, Screener } = require('../core/screener.cjs');
const { ScreenerStore } = require('../core/screener-store.cjs');
const { Market } = require('../core/market.cjs');
const now = new Date('2026-09-30T10:00:00+08:00');
const original = '需要 MA20 向上且高于 MA60、收盘在 MA20 上方、MACD 为正、RSI 40–75、日量比不低于 0.6';
const parse = text => parseDescription(text).query;
function bars() {
  const dates = [], day = new Date('2026-09-29T00:00:00Z');
  while (dates.length < 120) { if (![0, 6].includes(day.getUTCDay())) dates.unshift(day.toISOString().slice(0, 10)); day.setUTCDate(day.getUTCDate() - 1); }
  return dates.map((date, i) => {
    const close = 10 + i * 0.008 + Math.sin(i / 4 + 1.6) * 0.12;
    return { date, open: close, close, high: close + 0.1, low: close - 0.1, volume: i === 119 ? 60 : 100 };
  });
}
function row(code = '600001', extra = {}) {
  return normalize({ f12: code, f13: code.startsWith('6') ? 1 : 0, f14: '测试', f2: 10, f3: 1, f5: 1000, f6: 1e8, f7: 2, f8: 3, f9: 15, f10: 9, f20: 1e10, f21: 1e10, f23: 2, f124: now.getTime() / 1000, ...extra });
}
function snapshot(rows = [row()]) { return { rows, source: '东方财富公开行情', sourceCount: rows.length, excludedCount: 0, startedAt: now.getTime(), fetchedAt: now.getTime() }; }
function scanner(loader, rows = [row()], clock = () => now) {
  const s = new Screener(async () => { throw Error('unexpected quote request'); }, null, loader, clock);
  s.snapshot = snapshot(rows); s.load = async () => s.snapshot;
  return s;
}

test('原句解析为七个完整技术条件，并保留严格上方和包含区间边界', () => {
  const q = parse(original);
  assert.equal(q.rules.length, 7);
  for (const rule of [
    { field: 'ma20', op: 'gt', valueField: 'previousMa20' }, { field: 'ma20', op: 'gt', valueField: 'ma60' },
    { field: 'close', op: 'gt', valueField: 'ma20' }, { field: 'macd', op: 'gt', value: 0 },
    { field: 'rsi', op: 'gte', value: 40 }, { field: 'rsi', op: 'lte', value: 75 }, { field: 'dailyVolumeRatio', op: 'gte', value: 0.6 }
  ]) assert.ok(q.rules.some(r => JSON.stringify(r) === JSON.stringify(rule)));
  assert.ok(parseDescription(original).notes.some(n => n.includes('完整未复权')));
});

test('均线别名、大小写、前一日引用、MACD柱和Unicode区间使用相同口径', () => {
  for (const description of ['ma20向上且高于ma60', '20日均线上升并且大于60日均线', 'MA20大于前一日 MA20，MA20大于MA60']) {
    assert.deepEqual(parse(description).rules, [{ field: 'ma20', op: 'gt', valueField: 'previousMa20' }, { field: 'ma20', op: 'gt', valueField: 'ma60' }]);
  }
  for (const separator of ['–', '—', '-', '到', '至', '~']) assert.deepEqual(parse(`RSI(14) 40${separator}75`).rules, [{ field: 'rsi', op: 'gte', value: 40 }, { field: 'rsi', op: 'lte', value: 75 }]);
  assert.deepEqual(parse('MACD 柱为正').rules, parse('macd大于0').rules);
  assert.deepEqual(parse('需要 收盘不低于MA20').rules, [{ field: 'close', op: 'gte', valueField: 'ma20' }]);
  assert.deepEqual(parse('MA5下降').rules, [{ field: 'ma5', op: 'lt', valueField: 'previousMa5' }]);
});

test('日量比不冒用快照量比，不支持的语义、错误单位和矛盾关系整体拒绝', () => {
  assert.deepEqual(parse('日量比不低于0.6，量比大于2').rules, [{ field: 'dailyVolumeRatio', op: 'gte', value: 0.6 }, { field: 'volumeRatio', op: 'gt', value: 2 }]);
  for (const text of ['不要MA20向上', 'MA20连续三天向上', 'MACD金叉', 'MACD DIF为正', 'RSI大于101', 'RSI大于40元', '日量比大于0.6元', 'RSI40–75或者MACD为正', 'MA20高于MA60且MA60不低于MA20', '收盘高于MA20，MA20大于收盘', 'MA20向上且向下', 'RSI75–40']) assert.throws(() => parse(text), /不支持|无法确定|无效|单位|矛盾/);
});

test('IPC比较对象只接受明确的日线价格字段，不能绕过类型和单位校验', () => {
  for (const rule of [
    { field: 'ma20', op: 'gt', valueField: 'price' }, { field: 'ma20', op: 'gt', valueField: 'rsi' },
    { field: 'rsi', op: 'gt', valueField: 'ma20' }, { field: 'ma20', op: 'gt', valueField: '__proto__' },
    { field: 'ma20', op: 'gt', valueField: 'ma60', value: 10 }, { field: 'ma20', op: 'gt', valueField: 'ma20' }
  ]) assert.throws(() => validate({ ...defaults(), rules: [rule] }));
});

test('全部七项AND与RSI、MACD、日量比和价格相等边界逐项生效', () => {
  const base = { ...row(), ma20: 10, previousMa20: 9.99, ma60: 9, close: 10.1, macd: 0.01, rsi: 40, dailyVolumeRatio: 0.6 };
  assert.equal(screen(snapshot([base]), parse(original)).matched, 1);
  assert.equal(screen(snapshot([{ ...base, rsi: 75 }]), parse(original)).matched, 1);
  for (const change of [{ previousMa20: 10 }, { ma60: 10 }, { close: 10 }, { macd: 0 }, { rsi: 39.99 }, { rsi: 75.01 }, { dailyVolumeRatio: 0.5999 }]) assert.equal(screen(snapshot([{ ...base, ...change }]), parse(original)).matched, 0);
  assert.equal(screen(snapshot([{ ...base, close: 10 }]), parse(original.replace('收盘在 MA20 上方', '收盘不低于MA20'))).matched, 1);
  const missing = screen(snapshot([{ ...base, previousMa20: undefined }]), parse(original));
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.matched, null); assert.equal(missing.missingByField.previousMa20, 1);
});

test('日线指标与策略及同口径分析一致，MA20向上只比较相邻完整日线', () => {
  const data = bars(), d = dailyIndicators(data, now), t = technicals(data, now), a = analyze(data, null, now);
  for (const field of ['ma5', 'ma20', 'ma60', 'rsi', 'macd', 'close']) { assert.equal(d[field], t[field]); assert.equal(d[field], a[field]); }
  assert.equal(d.dailyVolumeRatio, 0.6); assert.equal(d.dailyVolumeRatio, t.volumeRatio);
  assert.ok(Math.abs(d.ma20 - d.previousMa20 - (data.at(-1).close - data.at(-21).close) / 20) < 1e-12);
  const { bars: ignored, ...values } = d;
  assert.equal(screen(snapshot([{ ...row(), ...values }]), parse(original)).matched, 1);
  for (const phase of [0, 1, 2, 3]) {
    const varied = data.map((b, i) => { const close = 10 + i * 0.008 + Math.sin(i / 4 + phase) * 0.12; return { ...b, open: close, close, high: close + 0.1, low: close - 0.1 }; });
    const v = dailyIndicators(varied, now), strategy = technicals(varied, now);
    const pass = strategy.trend && strategy.macd > 0 && strategy.rsi >= 40 && strategy.rsi <= 75 && strategy.volumeRatio >= 0.6;
    assert.equal(screen(snapshot([{ ...row(), ...v }]), parse(original.replace('收盘在 MA20 上方', '收盘不低于MA20'))).matched, +pass);
  }
});

test('未收盘与未来日线不影响结果，收盘后纳入；不足和异常日期有明确分类', () => {
  const data = bars(), unfinished = { ...data.at(-1), date: '2026-09-30', close: 999, high: 1000, low: 1 };
  assert.deepEqual(dailyIndicators([...data, unfinished, { ...unfinished, date: '2026-10-01' }], now), dailyIndicators(data, now));
  assert.equal(dailyIndicators([...data, unfinished], new Date('2026-09-30T15:00:00+08:00')).asOf, '2026-09-30');
  assert.throws(() => dailyIndicators(data.slice(-60), now), e => e.code === 'insufficient');
  for (const invalid of [[...data, data.at(-1)], [...data].reverse(), [{ ...data[0], date: '2026-02-30' }, ...data.slice(1)], [{ ...data[0], volume: NaN }, ...data.slice(1)]]) assert.throws(() => dailyIndicators(invalid, now), e => e.code === 'invalid');
});

test('零均量标记不可判断；无波动日线仍可用于技术选股，策略保留ATR限制', () => {
  const data = bars().map(b => ({ ...b, open: 10, close: 10, high: 10, low: 10, volume: 0 }));
  const d = dailyIndicators(data, now);
  assert.equal(d.dailyVolumeRatio, null); assert.equal(d.rsi, 50); assert.equal(d.macd, 0);
  assert.equal(screen(snapshot([{ ...row(), ...d }]), parse('日量比不低于0.6')).status, 'unavailable');
  assert.equal(screen(snapshot([{ ...row(), ...d }]), parse('RSI40–75')).matched, 1);
  assert.throws(() => technicals(data, now), /波动/);
  const engine = { clock: () => now, s: { settings: {}, strategySettings: {} }, positions: () => [], fresh() {} };
  const signal = evaluateEntry(engine, 'sh600001', { date: '2026-09-30', prevClose: 10, ask: 10 }, { fetchedAt: now.getTime(),
    notices: { symbol: 'sh600001', section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } },
    technical: { asOf: '2026-09-29', close: 10, trend: true, macd: 1, rsi: 50, volumeRatio: null } });
  assert.equal(signal.status, '等待趋势'); assert.equal(signal.buyable, false);
});

test('技术扫描先过滤范围和快照条件，缓存复用与强制刷新均不修改快照', async () => {
  const calls = [], s = scanner(async symbol => { calls.push(symbol); return bars(); }, [row(), row('600002', { f2: 30 }), row('300001'), row('600003', { f14: '*ST测试' })]);
  const before = structuredClone(s.snapshot), q = parse('主板，排除ST，股价小于20，' + original.replace('需要 ', ''));
  const result = await s.run(q, []);
  assert.deepEqual(calls, ['sh600001']); assert.equal(result.matched, 1); assert.equal(result.technicalCandidates, 1); assert.equal(result.evaluatedCount, 2); assert.equal(result.missing, 0);
  assert.equal(result.rows[0].volumeRatio, 9); assert.equal(result.rows[0].dailyVolumeRatio, 0.6); assert.equal(result.rows[0].technicalAsOf, '2026-09-29');
  assert.deepEqual(s.snapshot, before); await s.run(q, []); assert.equal(calls.length, 1);
  await s.run(q, [], true); assert.equal(calls.length, 2); assert.equal(s.progress.loading, false);
});

test('技术筛选复用有效日线缓存时保留原始获取时间，重新扫描不能把旧数据标成刚获取', async () => {
  const fetchedAt = Date.parse('2026-09-30T09:00:00+08:00'), time = new Date(now);
  const data = prepareHistory('sh600001', 'stock', { bars: bars(), source: '腾讯财经', provider: 'tencent', adjustment: '未复权', fetchedAt }, fetchedAt);
  assert.ok(data);
  const s = scanner(async () => ({ ...data, historyStatus: 'cached' }), [row()], () => time);
  const query = parse(original), first = await s.run(query, []);
  assert.equal(first.matched, 1); assert.equal(first.rows[0].technicalFetchedAt, fetchedAt);
  assert.equal(first.rows[0].technicalAsOf, '2026-09-29'); assert.equal(first.rows[0].technicalSource, '腾讯财经');
  assert.equal(s.dailyCache.get('sh600001').fetchedAt, fetchedAt);
  time.setTime(time.getTime() + 300000);
  const rechecked = await s.run(query, [], true);
  assert.equal(rechecked.matched, 1); assert.equal(rechecked.rows[0].technicalFetchedAt, fetchedAt);
  assert.equal(s.dailyCache.get('sh600001').fetchedAt, fetchedAt);
});

test('刚获取但滞后、串股或损坏的新日线证据不能进入有效技术筛选或缓存', async () => {
  const entry = (symbol = 'sh600001', inputBars = bars(), at = now.getTime()) => prepareHistory(symbol, 'stock', {
    bars: inputBars, source: '腾讯财经', provider: 'tencent', adjustment: '未复权', fetchedAt: at }, at);
  const lagged = entry('sh600001', bars().slice(0, -1), Date.parse('2026-09-29T10:00:00+08:00'));
  assert.ok(lagged); lagged.fetchedAt = now.getTime(); lagged.dailyEvidence.fetchedAt = now.getTime();
  const foreign = entry('sh600002'), damaged = entry(), unverified = entry();
  damaged.dailyEvidence.barsHash = '0'.repeat(64); unverified.dailyEvidence = null;
  for (const [kind, data] of [['lagged', lagged], ['foreign', foreign], ['damaged', damaged], ['unverified', unverified]]) {
    assert.equal(data.fetchedAt, now.getTime(), kind);
    const s = scanner(async () => data), result = await s.run(parse('RSI大于0'), []);
    assert.equal(result.status, 'unavailable', kind); assert.equal(result.matched, null, kind);
    assert.equal(result.rows.length, 0, kind); assert.equal(result.technicalScan.failures.invalid, 1, kind);
    assert.equal(result.technicalScan.failures.fetch, 0, kind); assert.equal(s.dailyCache.size, 0, kind);
  }
});

test('所需快照指标缺失或无候选时不获取日线；无关快照字段不阻止技术筛选', async () => {
  let calls = 0;
  const s = scanner(async () => { calls++; return bars(); }, [row('600001', { f2: null, f124: null })]);
  assert.equal((await s.run(parse('股价大于10，RSI40–75'), [])).status, 'unavailable'); assert.equal(calls, 0);
  assert.equal((await s.run(parse('RSI40–75'), [])).matched, 1); assert.equal(calls, 1);
  assert.equal((await s.run(parse('创业板，RSI40–75'), [])).status, 'empty'); assert.equal(calls, 1);
});

test('缺日线、无效日线与断线分别计数，全部失败不报告零匹配', async () => {
  const s = scanner(async symbol => {
    if (symbol.endsWith('2')) return bars().slice(-60);
    if (symbol.endsWith('3')) return [...bars(), bars().at(-1)];
    if (symbol.endsWith('4')) throw Error('offline');
    return bars();
  }, [row(), row('600002'), row('600003'), row('600004')]);
  let result = await s.run(parse(original), []);
  assert.equal(result.matched, 1); assert.equal(result.partial, true); assert.equal(result.missing, 3);
  assert.deepEqual(result.technicalScan.failures, { insufficient: 1, invalid: 1, fetch: 1 });
  result = await s.run(parse('我的自选，RSI40–75'), ['sh600002', 'sh600003', 'sh600004']);
  assert.equal(result.status, 'unavailable'); assert.equal(result.matched, null);
  s.dailyLoader = async () => { throw Error('offline'); };
  result = await s.run(parse(original), [], true); assert.equal(result.matched, null); assert.equal(s.dailyCache.size, 0);
});

test('跨收盘时间与缓存到期重新加载，扫描以开始时间固定完整日线截止点', async () => {
  let time = new Date('2026-09-30T14:59:50+08:00'), calls = 0;
  const data = [...bars(), { ...bars().at(-1), date: '2026-09-30' }];
  const s = scanner(async () => { calls++; time = new Date('2026-09-30T15:00:01+08:00'); return data; }, [row()], () => time);
  let result = await s.run(parse('RSI大于0'), []); assert.equal(result.rows[0].technicalAsOf, '2026-09-29');
  result = await s.run(parse('RSI大于0'), []); assert.equal(result.rows[0].technicalAsOf, '2026-09-30'); assert.equal(calls, 2);
  s.dailyLoader = async () => { calls++; return data; };
  time = new Date('2026-09-30T15:01:02+08:00'); await s.run(parse('RSI大于0'), []); assert.equal(calls, 3);
});

test('普通财务加技术筛选共用快照后的观察时点，财务请求跨收盘不引入新日线', async () => {
  const time = new Date('2026-09-30T14:59:50+08:00'), observation = time.toISOString();
  const data = [...bars(), { ...bars().at(-1), date: '2026-09-30', open: 999, close: 999, high: 1000, low: 998 }];
  const s = scanner(async () => data, [row()], () => time);
  s.financeLoader = async symbol => {
    time.setTime(Date.parse('2026-09-30T15:00:05+08:00'));
    return { symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: time.getTime(), data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', roe: 15 } } };
  };
  const result = await s.run(parse('ROE大于10%，RSI大于0'), []);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].technicalAsOf, '2026-09-29');
  assert.equal(result.financeScan.asOfCutoff, observation); assert.equal(result.technicalScan.asOfCutoff, observation);
  assert.equal(result.technicalScan.startedAt, time.getTime()); assert.equal(result.rows[0].financeFetchedAt, time.getTime());
  assert.equal(s.dailyCache.get('sh600001').cutoff, '2026-09-30:intraday');
});

test('显式观察时点按同一基准计算和复用缓存，收盘基准变化及真实TTL到期必须重载', async () => {
  const time = new Date('2026-09-30T15:00:05+08:00'), observed = new Date('2026-09-30T14:59:50+08:00');
  let calls = 0; const data = [...bars(), { ...bars().at(-1), date: '2026-09-30' }];
  const s = scanner(async () => { calls++; return data; }, [row()], () => time);
  const q = parse('RSI大于0'), signal = new AbortController().signal;
  let result = await s.scanDaily(s.snapshot, q, [], false, signal, observed);
  assert.equal(result.rows[0].technicalAsOf, '2026-09-29'); assert.equal(result.technicalScan.startedAt, time.getTime());
  assert.equal(result.technicalScan.asOfCutoff, observed.toISOString());
  await s.scanDaily(s.snapshot, q, [], false, signal, observed); assert.equal(calls, 1);
  result = await s.scanDaily(s.snapshot, q, [], false, signal, time); assert.equal(calls, 2);
  assert.equal(result.rows[0].technicalAsOf, '2026-09-30'); assert.equal(s.dailyCache.get('sh600001').cutoff, '2026-09-30:closed');
  result = await s.scanDaily(s.snapshot, q, [], false, signal, observed); assert.equal(calls, 3);
  assert.equal(result.rows[0].technicalAsOf, '2026-09-29');
  time.setTime(time.getTime() + 60000);
  await s.scanDaily(s.snapshot, q, [], false, signal, observed); assert.equal(calls, 4, '冻结观察时点不能冻结缓存的真实有效期');
});

test('日线缓存跨午夜重新匹配观察日期；异步修改clock返回的Date不能改变当次截止点', async () => {
  const time = new Date('2026-09-29T23:59:55+08:00'), observed = time.toISOString(); let calls = 0;
  const data = [...bars(), { ...bars().at(-1), date: '2026-09-30', open: 999, close: 999, high: 1000, low: 998 }];
  const s = scanner(async () => { calls++; time.setTime(Date.parse('2026-09-30T00:00:05+08:00')); return data; }, [row()], () => time);
  const signal = new AbortController().signal, q = parse('RSI大于0');
  const first = await s.scanDaily(s.snapshot, q, [], false, signal);
  assert.equal(first.rows[0].technicalAsOf, '2026-09-29'); assert.equal(first.technicalScan.asOfCutoff, observed);
  assert.equal(s.dailyCache.get('sh600001').cutoff, '2026-09-29:closed');
  const second = await s.scanDaily(s.snapshot, q, [], false, signal);
  assert.equal(calls, 2); assert.equal(second.rows[0].technicalAsOf, '2026-09-29');
  assert.equal(s.dailyCache.get('sh600001').cutoff, '2026-09-30:intraday');
});

test('无效日线响应不是网络错误，失败不能沿用输入上已有的技术数值', async () => {
  const s = scanner(async () => null), signal = new AbortController().signal;
  const snapshot = { ...s.snapshot, rows: [{ ...s.snapshot.rows[0], close: 99, rsi: 60, technicalAsOf: '2026-09-29' }] };
  const result = await s.scanDaily(snapshot, parse('RSI大于0'), [], false, signal);
  assert.equal(result.technicalScan.failures.invalid, 1); assert.equal(result.technicalScan.failures.fetch, 0);
  assert.equal(result.rows[0].technicalError, 'invalid'); assert.equal(result.rows[0].close, null);
  assert.equal(result.rows[0].rsi, null); assert.equal(result.rows[0].technicalAsOf, null);
});

test('日线并发不超过三，取消停止排队并拒绝发布部分结果；可以重试', async () => {
  const pending = [], rows = Array.from({ length: 10 }, (_, i) => row(String(600001 + i)));
  let resolveStarted; const started = new Promise(resolve => { resolveStarted = resolve; });
  const s = scanner((symbol, signal) => new Promise((resolve, reject) => {
    pending.push(symbol); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
    if (pending.length === 3) resolveStarted();
  }), rows);
  const run = s.run(parse(original), []); await started;
  assert.equal(s.progress.stage, 'daily'); assert.equal(s.progress.total, 10); assert.equal(pending.length, 3);
  await assert.rejects(s.run(parse(original), []), /已有选股/);
  s.cancel(); await assert.rejects(run, /取消/);
  assert.equal(pending.length, 3); assert.equal(s.activeRun, null); assert.equal(s.progress.loading, false); assert.ok(s.snapshot.rows.every(r => !r.technicalAsOf));
  s.dailyLoader = async () => bars(); assert.equal((await s.run(parse(original), [])).matched, 10);
});

test('取消股票池请求会中止网络且不重试、不覆盖上次快照', async () => {
  let start; const started = new Promise(resolve => { start = resolve; }); let calls = 0;
  const s = new Screener(async (url, { signal }) => new Promise((resolve, reject) => { calls++; signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); start(); }));
  const old = snapshot(); s.snapshot = old;
  const run = s.run(defaults(), [], true); await started; s.cancel(); await assert.rejects(run, /取消/);
  assert.equal(calls, 1); assert.equal(s.snapshot, old); assert.equal(s.activeRun, null);
});

test('历史快照保持旧字段兼容，技术请求在读历史或发网络请求之前被拒绝', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-technical-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('guanlan-technical-')); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = new ScreenerStore(dir); assert.equal(store.remember(snapshot()), true);
  const reloaded = new ScreenerStore(dir); assert.equal(reloaded.warning, ''); assert.equal(reloaded.list().length, 1);
  const s = new Screener(async () => { throw Error('must not fetch'); }, reloaded, async () => { throw Error('must not fetch daily'); });
  const id = reloaded.list()[0].id;
  assert.equal((await s.run(parse('市盈率小于20'), [], false, id)).matched, 1);
  await assert.rejects(s.run(parse(original), [], false, id), /历史快照未保存技术日线/);
  assert.equal(fs.readFileSync(reloaded.file, 'utf8').includes('dailyVolumeRatio'), false);
});

test('未复权日线接口传递取消信号，前复权字段不会被当成日线使用', async () => {
  const received = [];
  const market = new Market(async (url, options) => { received.push({ url, signal: options.signal }); return { ok: true, json: async () => ({ data: { sh600001: { qfqday: [] } } }) }; });
  const controller = new AbortController();
  await assert.rejects(market.strategyHistory('sh600001', controller.signal), /未收到未复权日线/);
  assert.ok(received[0].url.endsWith('120,')); assert.equal(new URL(received.at(-1).url).searchParams.get('fqt'), '0');
  controller.abort();
  const completed = received.length;
  await assert.rejects(market.strategyHistory('sh600001', controller.signal), { name: 'AbortError' });
  assert.equal(received.length, completed, '已取消的调用不能启动新请求');
  assert.equal(market.dailyHistory.pending.size, 0, '已结束的共享下载没有在途请求');
});
