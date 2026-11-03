const test = require('node:test');
const assert = require('node:assert/strict');
const { dailyIndicators } = require('../core/daily-indicators.cjs');
const { technicals } = require('../core/strategy.cjs');
const { TECHNICAL_FIELDS, defaults, validate, parseDescription, screen, classifyScreenRow, Screener } = require('../core/screener.cjs');

const now = new Date('2026-09-30T10:00:00+08:00');
const fields = ['atrPct14', 'biasMa5Pct', 'biasMa20Pct', 'biasMa60Pct', 'ma20Change5Pct'];
function bars(closeAt = i => 40 + i, spread = 0.25) {
  const dates = [], day = new Date('2026-09-29T00:00:00Z');
  while (dates.length < 61) {
    if (![0, 6].includes(day.getUTCDay())) dates.unshift(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return dates.map((date, i) => {
    const close = closeAt(i);
    return { date, open: close, close, high: close + spread, low: close - spread, volume: 1000 };
  });
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }
const row = values => ({ symbol: 'sh600001', name: '测试', board: 'sh', isST: false, timestamp: now.getTime(), ...values });
const snapshot = rows => ({ rows, fetchedAt: now.getTime(), startedAt: now.getTime(), source: '测试行情' });

test('新增指标按完整收盘计算有符号乖离和五根日线前的 MA20，保持 61 根最低要求', () => {
  const data = bars(), d = dailyIndicators(data, now);
  assert.equal(d.ma5, 98); assert.equal(d.ma20, 90.5); assert.equal(d.ma60, 70.5);
  near(d.atrPct14, 1.25);
  near(d.biasMa5Pct, (100 / 98 - 1) * 100);
  near(d.biasMa20Pct, (100 / 90.5 - 1) * 100);
  near(d.biasMa60Pct, (100 / 70.5 - 1) * 100);
  near(d.ma20Change5Pct, (90.5 / 85.5 - 1) * 100);
  assert.throws(() => dailyIndicators(data.slice(1), now), error => error.code === 'insufficient');
});

test('下跌序列保留负乖离与负均线变化率，ATR 使用最新完整收盘归一化', () => {
  const d = dailyIndicators(bars(i => 100 - i), now);
  near(d.atrPct14, 1.25 / 40 * 100);
  near(d.biasMa5Pct, (40 / 42 - 1) * 100);
  near(d.biasMa20Pct, (40 / 49.5 - 1) * 100);
  near(d.biasMa60Pct, (40 / 69.5 - 1) * 100);
  near(d.ma20Change5Pct, (49.5 / 54.5 - 1) * 100);
  for (const field of fields.slice(1)) assert.ok(d[field] < 0, field);
});

test('ATR 包含向上与向下跳空，只平均末 14 根 TR 并与策略执行口径一致', () => {
  const data = bars(() => 100, 1);
  data[46] = { ...data[46], high: 300, low: 1 };
  data[47] = { ...data[47], open: 110, close: 110, high: 111, low: 109 };
  const d = dailyIndicators(data, now), execution = technicals(data, now);
  // The first two included TRs are 11 (gap up) and 11 (gap down); the other twelve are 2.
  near(d.atrPct14, (11 + 11 + 12 * 2) / 14 / 100 * 100);
  near(d.atrPct14, execution.atr / execution.close * 100);
});

test('未收盘和未来日线不能改变任何新增指标，15:00 后才纳入当日完整线', () => {
  const data = bars(), before = structuredClone(data);
  const unfinished = { date: '2026-09-30', open: 100, close: 200, high: 250, low: 80, volume: 5000 };
  const future = { ...unfinished, date: '2026-10-01', close: 300, high: 350 };
  assert.deepEqual(dailyIndicators([...data, unfinished, future], now), dailyIndicators(data, now));
  const closed = dailyIndicators([...data, unfinished, future], new Date('2026-09-30T15:00:00+08:00'));
  assert.equal(closed.asOf, '2026-09-30'); assert.equal(closed.close, 200); assert.equal(closed.bars.length, 62);
  near(closed.atrPct14, (13 * 1.25 + 170) / 14 / 200 * 100);
  near(closed.biasMa5Pct, (200 / 118.8 - 1) * 100);
  assert.deepEqual(data, before, '计算指标不得修改原始日线');
});

test('零波动仍返回有效零指标，通用日线调用不继承策略执行的正 ATR 要求', () => {
  const data = bars(() => 100, 0), d = dailyIndicators(data, now);
  for (const field of fields) assert.equal(d[field], 0, field);
  assert.equal(d.rsi, 50); assert.equal(d.macd, 0); assert.equal(d.dailyVolumeRatio, 1);
  assert.throws(() => technicals(data, now), /波动/);
});

test('新增技术字段可按中文描述解析为百分比筛选，负值有效且单位不可混用', () => {
  const parsed = parseDescription('ATR(14)波动率不超过4%，MA5乖离率不低于-2%，20日乖离率不超过8%，60日均线乖离率不超过15%，MA20五日变化率不低于-1%');
  assert.deepEqual(parsed.query.rules, [
    { field: 'atrPct14', op: 'lte', value: 4 },
    { field: 'biasMa5Pct', op: 'gte', value: -2 },
    { field: 'biasMa20Pct', op: 'lte', value: 8 },
    { field: 'biasMa60Pct', op: 'lte', value: 15 },
    { field: 'ma20Change5Pct', op: 'gte', value: -1 }
  ]);
  for (const field of fields) {
    assert.equal(TECHNICAL_FIELDS[field].source, 'daily');
    assert.equal(TECHNICAL_FIELDS[field].unit, '%');
  }
  for (const field of fields.slice(1)) {
    assert.equal(TECHNICAL_FIELDS[field].min, undefined);
    assert.doesNotThrow(() => validate({ ...defaults(), rules: [{ field, op: 'gte', value: -5 }] }));
  }
  assert.throws(() => parseDescription('ATR波动率大于-1%'), /无效/);
  assert.throws(() => parseDescription('MA5乖离率小于3元'), /单位/);
});

test('新增指标逐项参与筛选，缺失属于待核验而不被当成零或条件失败', () => {
  const query = parseDescription('ATR波动率不超过4%，MA5乖离率不低于-2%，MA20乖离率不超过8%，MA60乖离率不超过15%，MA20五日变化率不低于-1%').query;
  const complete = row({ atrPct14: 4, biasMa5Pct: -2, biasMa20Pct: 8, biasMa60Pct: 15, ma20Change5Pct: -1 });
  assert.equal(screen(snapshot([complete]), query).matched, 1);
  assert.equal(classifyScreenRow(complete, query).status, 'pass');
  for (const [field, value] of Object.entries({ atrPct14: 4.01, biasMa5Pct: -2.01, biasMa20Pct: 8.01, biasMa60Pct: 15.01, ma20Change5Pct: -1.01 })) {
    const rejected = { ...complete, [field]: value };
    assert.equal(screen(snapshot([rejected]), query).matched, 0, field);
    assert.equal(classifyScreenRow(rejected, query).status, 'failed', field);
    for (const missing of [undefined, null, NaN, Infinity]) {
      const incomplete = { ...complete, [field]: missing }, result = screen(snapshot([incomplete]), query);
      assert.equal(result.status, 'unavailable', field); assert.equal(result.matched, null, field);
      assert.equal(result.missingByField[field], 1, field);
      const classification = classifyScreenRow(incomplete, query);
      assert.equal(classification.status, 'pending', field); assert.equal(classification.failedReasons.length, 0, field);
    }
  }
});

test('日线扫描实际补齐新增指标供入池使用，并保留完整日线日期', async () => {
  const data = bars(), s = new Screener(async () => { throw Error('不应请求行情'); }, null, async () => data, () => now);
  s.snapshot = snapshot([row({})]); s.load = async () => s.snapshot;
  const query = parseDescription('ATR波动率大于0%，MA5乖离率大于0%，MA20乖离率大于0%，MA60乖离率大于0%，MA20五日变化率大于0%').query;
  const result = await s.run(query, []), expected = dailyIndicators(data, now);
  assert.equal(result.matched, 1); assert.equal(result.technical, true);
  assert.equal(result.rows[0].technicalAsOf, '2026-09-29');
  for (const field of fields) near(result.rows[0][field], expected[field]);
});
