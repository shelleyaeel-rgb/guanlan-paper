const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTencentScreenQuotes, TENCENT_SCREEN_SOURCE } = require('../core/screener-tencent.cjs');
const { normalize } = require('../core/screener.cjs');
const { ScreenerStore } = require('../core/screener-store.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const NOW = Date.parse('2026-10-08T15:01:00+08:00');

function quote(symbol = 'sh600519', changes = {}) {
  const a = Array(88).fill('');
  Object.assign(a, {
    0: symbol.startsWith('sh') ? '1' : '51', 1: '测试股票', 2: symbol.slice(2),
    3: '10.50', 4: '10.77', 30: '20261008150000', 32: '-2.50', 36: '20000', 37: '25000',
    38: '3.25', 39: '99.99', 43: '6.5', 44: '80', 45: '100', 46: '2.5', 49: '1.2',
    52: '15.5', 53: '88.88', 57: '25000.1234',
    61: symbol.startsWith('sh688') ? 'GP-A-KCB' : /^sz30/.test(symbol) ? 'GP-A-CYB' : 'GP-A', ...changes
  });
  return `v_${symbol}="${a.join('~')}";\n`;
}
const parse = (changes = {}) => parseTencentScreenQuotes(quote('sh600519', changes), ['sh600519'], NOW)[0];

test('腾讯选股字段使用动态 PE、明确单位及报价时间，保留来源说明', () => {
  assert.deepEqual(parse(), {
    symbol: 'sh600519', name: '测试股票', board: 'sh', isST: false,
    price: 10.5, prevClose: 10.77, changePct: -2.5, turnover: 3.25, volumeRatio: 1.2,
    amount: 2.50001234, marketCap: 100, floatCap: 80, pe: 15.5, pb: 2.5,
    amplitude: 6.5, volume: 2, timestamp: Date.parse('2026-10-08T15:00:00+08:00')
  });
  assert.match(TENCENT_SCREEN_SOURCE, /腾讯.*新浪/);
});

test('技术价格校验保留同条行情的昨收字段，不从涨幅反算或使用其他来源补齐', () => {
  assert.equal(parse({ 4: '10.77', 32: '' }).prevClose, 10.77);
  for (const value of ['', '0', '-1', 'NaN', 'Infinity']) assert.equal(parse({ 4: value }).prevClose, null);
  assert.equal(normalize({ f12: '600001', f13: 1, f14: '隔离样本', f2: 11, f3: 10, f18: 10 }).prevClose, 10);
  for (const f18 of [null, 0, -1, '']) assert.equal(normalize({ f12: '600001', f13: 1, f14: '隔离样本', f2: 11, f3: 10, f18 }).prevClose, null);
});

test('新增昨收随完整快照保存重启保留，缺该可选字段的旧历史仍可读取', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-screen-prev-close-'));
  try {
    const snapshot = { rows: [parse()], source: TENCENT_SCREEN_SOURCE, startedAt: NOW, fetchedAt: NOW, sourceCount: 1, excludedCount: 0 };
    const store = new ScreenerStore(directory);
    assert.equal(store.remember(snapshot), true);
    assert.equal(new ScreenerStore(directory).get(store.list()[0].id).rows[0].prevClose, 10.77);
    delete snapshot.rows[0].prevClose;
    assert.equal(store.remember(snapshot), true);
    assert.equal(new ScreenerStore(directory).list().length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('主板和创业板成交量为手，科创板为股，统一输出万手且保留请求顺序', () => {
  const symbols = ['sz000001', 'sh688981', 'sz300750', 'sz301269'];
  const text = [...symbols].reverse().map(s => quote(s, { 36: s.startsWith('sh688') ? '2000000' : '20000' })).join('');
  const rows = parseTencentScreenQuotes(text, symbols, NOW);
  assert.deepEqual(rows.map(r => r.symbol), symbols);
  assert.deepEqual(rows.map(r => r.board), ['sz', 'star', 'chinext', 'chinext']);
  assert.ok(rows.every(r => r.volume === 2));
});

test('动态 PE 缺失不会用 TTM 或静态 PE 补齐，负估值仍可筛选', () => {
  assert.equal(parse({ 52: '' }).pe, null);
  assert.equal(parse({ 52: '-7.82', 46: '-1.25' }).pe, -7.82);
  assert.equal(parse({ 52: '-7.82', 46: '-1.25' }).pb, -1.25);
});

test('缺失和非法数值保持 null，不能被空字符串、十六进制或非有限值补零', () => {
  for (const value of ['', ' ', '-', '--', 'NaN', 'Infinity', '0x10', '5倍', '1e999']) {
    const row = parse({ 3: value, 32: value, 36: value, 37: value, 38: value, 43: value, 44: value, 45: value, 46: value, 49: value, 52: value, 57: value });
    for (const field of ['price', 'changePct', 'volume', 'amount', 'turnover', 'amplitude', 'floatCap', 'marketCap', 'pb', 'volumeRatio', 'pe']) assert.equal(row[field], null, `${field}: ${value}`);
  }
});

test('停牌等零成交仍保留零，但源端零量比和零估值按缺失处理', () => {
  const row = parse({ 1: '*ST测试', 3: '0', 32: '0', 36: '0', 37: '0', 38: '0', 43: '0', 44: '0', 45: '0', 46: '0', 49: '0', 52: '0', 57: '0' });
  assert.equal(row.isST, true);
  for (const field of ['price', 'floatCap', 'marketCap', 'pb', 'volumeRatio', 'pe']) assert.equal(row[field], null);
  for (const field of ['changePct', 'volume', 'amount', 'turnover', 'amplitude']) assert.equal(row[field], 0);
});

test('没有精确成交额时仅使用同条报价的万元成交额，拒绝负交易指标', () => {
  assert.equal(parse({ 57: '' }).amount, 2.5);
  const row = parse({ 3: '-1', 36: '-1', 37: '-1', 38: '-1', 43: '-1', 44: '-1', 45: '-1', 49: '-1', 57: '-1' });
  for (const field of ['price', 'volume', 'amount', 'turnover', 'amplitude', 'floatCap', 'marketCap', 'volumeRatio']) assert.equal(row[field], null);
});

test('缺报价、重复报价、代码错位、市场错误和截断响应使整个批次失败', () => {
  assert.throws(() => parseTencentScreenQuotes(quote(), ['sh600519', 'sz000001'], NOW), /缺少/);
  assert.throws(() => parseTencentScreenQuotes(quote() + quote(), ['sh600519'], NOW), /重复/);
  assert.throws(() => parse({ 2: '600000' }), /代码或市场不符/);
  assert.throws(() => parse({ 0: '51' }), /代码或市场不符/);
  assert.throws(() => parse({ 1: '' }), /名称缺失/);
  assert.throws(() => parse({ 61: 'ETF' }), /证券类型不符/);
  assert.throws(() => parseTencentScreenQuotes('v_sh600519="1~测试~600519";', ['sh600519'], NOW), /截断/);
  assert.throws(() => parseTencentScreenQuotes(quote().slice(0, -8), ['sh600519'], NOW), /缺少/);
});

test('响应证券集合必须与请求严格一致，额外股票或指数不能静默丢弃', () => {
  for (const extra of ['sz000001', 'sh000001', 'sh510300', 'bj920001', 'hk00700']) {
    assert.throws(() => parseTencentScreenQuotes(quote() + quote(extra), ['sh600519'], NOW), /未请求股票/);
  }
  assert.throws(() => parseTencentScreenQuotes(quote(), [], NOW), /未请求股票/);
});

test('只接受当前产品支持的规范沪深 A 股代码，不能请求指数、基金和北交所', () => {
  for (const symbol of ['600519', 'SH600519', ' sh600519', 'sh000001', 'sh510300', 'bj920001', 'sz600519', 'sh689009', null]) {
    assert.throws(() => parseTencentScreenQuotes(quote(), [symbol], NOW), /标准沪深/);
  }
  assert.throws(() => parseTencentScreenQuotes(quote(), ['sh600519', 'sh600519'], NOW), /请求代码重复/);
  assert.deepEqual(parseTencentScreenQuotes('', [], NOW), []);
});

test('缺失、非法日期、非法时间和未来报价时间保持未知，不伪造为当前日期', () => {
  for (const time of ['', '-', '20260230150000', '20261008240000', '20261008156000', '20261008150060', '20261008150200', '20261009150000']) {
    const row = parse({ 30: time });
    assert.equal(row.timestamp, null, time);
    assert.equal(row.price, 10.5);
  }
  assert.equal(parse({ 30: '20260930150000' }).timestamp, Date.parse('2026-09-30T15:00:00+08:00'));
});

test('格式和请求参数异常不能产生看似成功的空股票池', () => {
  for (const text of ['error', '<html>denied</html>']) assert.throws(() => parseTencentScreenQuotes(text, ['sh600519'], NOW), /缺少/);
  assert.throws(() => parseTencentScreenQuotes('v_pv_none_match="1";', ['sh600519'], NOW), /未请求股票/);
  for (const text of [null, undefined, {}]) assert.throws(() => parseTencentScreenQuotes(text, ['sh600519'], NOW), /参数无效/);
  assert.throws(() => parseTencentScreenQuotes(quote(), null, NOW), /参数无效/);
  assert.throws(() => parseTencentScreenQuotes(quote(), ['sh600519'], NaN), /参数无效/);
});
