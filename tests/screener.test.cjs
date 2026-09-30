const test = require('node:test');
const assert = require('node:assert/strict');
const { defaults, validate, parseDescription, normalize, screen, Screener } = require('../core/screener.cjs');
const raw = (code = '600001', overrides = {}) => ({ f12: code, f13: 1, f14: '测试股票', f2: 10, f3: 2, f5: 20000, f6: 1e8, f7: 5, f8: 3, f9: 15, f10: 1.5, f20: 100e8, f21: 80e8, f23: 2, f124: 1790647200, ...overrides });
const parse = s => parseDescription(s).query;
function snapshot(overrides = []) { return { rows: [normalize(raw()), ...overrides.map((r, i) => normalize(raw(String(600002 + i), r)))], fetchedAt: 100 }; }

test('文字和手动条件相同：主板、ST、区间、万元到亿元', () => {
  const q = parse('帮我筛选主板，排除ST，股价10到30元，总市值50到300亿，成交额不低于5000万元');
  assert.deepEqual(q, { scope: 'all', boards: ['sh', 'sz'], excludeST: true, rules: [
    { field: 'price', op: 'gte', value: 10 }, { field: 'price', op: 'lte', value: 30 },
    { field: 'marketCap', op: 'gte', value: 50 }, { field: 'marketCap', op: 'lte', value: 300 }, { field: 'amount', op: 'gte', value: 0.5 }
  ] });
  assert.deepEqual(screen(snapshot(), q).rows, screen(snapshot(), validate(q)).rows);
});
test('流通市值不混入总市值，百分数不再次除以100，量比不是成交量', () => {
  const q = parse('创业板，流通市值100亿以上，换手率3%到10%，量比超过1.5，成交量不超过20000手');
  assert.deepEqual(q.boards, ['chinext']);
  assert.deepEqual(q.rules, [
    { field: 'turnover', op: 'gte', value: 3 }, { field: 'turnover', op: 'lte', value: 10 },
    { field: 'volumeRatio', op: 'gt', value: 1.5 }, { field: 'volume', op: 'lte', value: 2 }, { field: 'floatCap', op: 'gte', value: 100 }
  ]);
});
test('跌幅转换为负涨跌幅，区间和严格不等号保持原意', () => {
  assert.deepEqual(parse('跌幅2%到5%').rules, [{ field: 'changePct', op: 'lte', value: -2 }, { field: 'changePct', op: 'gte', value: -5 }]);
  assert.deepEqual(parse('跌幅小于3%').rules, [{ field: 'changePct', op: 'gt', value: -3 }]);
  assert.equal(screen(snapshot([{ f3: -3 }, { f3: -4 }, { f3: -5 }, { f3: -6 }]), parse('跌幅2%到5%')).matched, 3);
});
test('支持自选范围、全角符号、PE别名；估值口径明确', () => {
  const result = parseDescription('我的自选股，科创板，ＰＥ大于０，市净率≤２');
  assert.equal(result.query.scope, 'watchlist'); assert.deepEqual(result.query.boards, ['star']);
  assert.match(result.notes.join(''), /动态/);
  assert.equal(screen(snapshot(), parse('我的自选股'), ['sh600001']).matched, 1);
  assert.equal(screen(snapshot(), parse('我的自选股'), []).matched, 0);
});
test('不忽略不支持的行业、技术形态、否定、未来承诺、OR或TTM', () => {
  for (const text of ['银行股，市盈率小于20', '股价大于10，MACD金叉', '不要创业板，价格小于20', '不低估的股票', '明天一定上涨', '市值小于100亿或者量比大于2', '市盈率TTM小于20', '股价大于10，换手率大于3的且盈利质量好']) assert.throws(() => parse(text), /不支持|无法确定|没有识别/);
});
test('矛盾条件、未完成语句、错误单位不会静默执行', () => {
  for (const text of ['股价30到10元', '股价大于10，股价不超过10', '股价大于', '股价小于10亿元', '换手率大于3元', '成交额大于3%', '', 'a'.repeat(501)]) assert.throws(() => parse(text));
  assert.doesNotThrow(() => parse('股价不低于10，股价不超过10'));
});
test('IPC查询拒绝无效范围、操作符、空数值、越界和任意字段', () => {
  for (const query of [null, {}, { ...defaults(), scope: 'ALL' }, { ...defaults(), boards: ['beijing'] }, { ...defaults(), excludeST: 'false' }, ...[null, '1', NaN, Infinity, -1, 1e13].map(value => ({ ...defaults(), rules: [{ field: 'price', op: 'lt', value }] })), { ...defaults(), rules: [{ field: 'price', op: 'eval', value: 10 }] }, { ...defaults(), rules: [{ field: 'cash', op: 'lt', value: 10 }] }]) assert.throws(() => validate(query));
  assert.throws(() => validate({ ...defaults(), rules: Array(31).fill({ field: 'price', op: 'gt', value: 0 }) }));
  assert.throws(() => validate({ ...defaults(), boards: ['toString'] }));
  assert.throws(() => validate({ ...defaults(), rules: [{ field: '__proto__', op: 'gte', value: 0 }] }));
  assert.throws(() => validate({ ...defaults(), rules: [{ field: 'price', op: '__proto__', value: 0 }] }));
});
test('行情字段保留单位和负估值，缺失值不是0，不允许混入指数基金', () => {
  const row = normalize(raw('000001', { f13: 0, f9: -3, f23: '-', f8: '', f20: 200e8 }));
  assert.equal(row.symbol, 'sz000001'); assert.equal(row.board, 'sz'); assert.equal(row.volume, 2); assert.equal(row.amount, 1); assert.equal(row.marketCap, 200); assert.equal(row.pe, -3); assert.equal(row.pb, null); assert.equal(row.turnover, null); assert.equal(row.timestamp, 1790647200000);
  for (const value of [null, undefined, '-', '', ' ', [], {}, 'NaN', Infinity, false]) assert.equal(normalize(raw('600001', { f9: value })).pe, null);
  assert.equal(normalize(raw('000001')), null); assert.equal(normalize(raw('510300')), null); assert.equal(normalize(raw('920001', { f13: 2 })), null);
  assert.equal(normalize(raw('688001')).board, 'star'); assert.equal(normalize(raw('300750', { f13: 0 })).board, 'chinext');
});
test('仅按所需指标排除缺失；无价格或时间不阻止PE筛选，负PE按数值判断', () => {
  const s = snapshot([{ f9: '-' }, { f9: -5 }, { f2: 0 }, { f124: '-' }, { f9: 0 }]);
  const r = screen(s, parse('市盈率小于20'));
  assert.equal(r.matched, 5); assert.equal(r.missing, 1);
  assert.equal(r.missingByField.pe, 1); assert.equal(r.missingByField.price, 1); assert.equal(r.missingByField.timestamp, 1);
  assert.equal(screen(s, parse('市盈率大于0，市盈率小于20')).matched, 3);
  assert.equal(screen(s, parse('市盈率不超过0')).matched, 2);
});
test('严格/包含边界行为、多条件AND、板块并集及ST排除', () => {
  const s = snapshot([{ f2: 20, f3: 5 }, { f2: 30, f3: 5 }, { f2: 10, f14: '*ST测试' }, { f2: 20, f12: '300001', f13: 0 }]);
  assert.equal(screen(s, parse('主板，排除ST，股价10到20元')).matched, 2);
  assert.equal(screen(s, parse('主板，排除ST，股价大于10，股价小于30，涨幅大于4%')).matched, 1);
  assert.equal(screen(s, parse('主板，创业板，排除ST')).matched, 4);
  const q = parse('我的自选股'); const result = screen(s, q, ['sh600001', 'sz000999']); assert.equal(result.matched, 1); assert.equal(result.watchlistMissing, 1);
});
function fixture({ total = 205, fail = false, duplicate = false, changedTotal = false } = {}) {
  let calls = 0, concurrent = 0, peak = 0;
  const fetcher = async url => {
    calls++; concurrent++; peak = Math.max(peak, concurrent);
    await new Promise(resolve => setImmediate(resolve)); concurrent--;
    const params = new URL(url).searchParams, page = Number(params.get('pn'));
    assert.equal(params.get('fltt'), '2'); assert.equal(params.get('fid'), 'f12'); assert.equal(params.get('po'), '0');
    if (fail && page === 2) throw Error('network failure');
    const diff = Array.from({ length: Math.min(100, total - (page - 1) * 100) }, (_, i) => raw(String(600001 + (duplicate ? 0 : (page - 1) * 100) + i)));
    return { ok: true, json: async () => ({ rc: 0, data: { total: changedTotal && page === 2 ? total + 1 : total, diff } }) };
  };
  return { screener: new Screener(fetcher), calls: () => calls, peak: () => peak };
}
test('完整分页、去重验证、缓存和同一时间合并请求', async () => {
  const f = fixture({ total: 505 }), [a, b] = await Promise.all([f.screener.load(), f.screener.load()]);
  assert.equal(a, b); assert.equal(a.rows.length, 505); assert.equal(f.calls(), 6); assert.ok(f.peak() <= 3);
  assert.equal(await f.screener.load(), a); assert.equal(f.calls(), 6); assert.equal(f.screener.progress.loading, false);
  await f.screener.load(true); assert.equal(f.calls(), 12);
  const q = parse('股价大于10'); assert.equal((await f.screener.run(q, [])).matched, 0); assert.equal(f.calls(), 12);
});
test('少于一页与整页边界不会请求多余页', async () => {
  for (const total of [1, 100, 101, 200]) { const f = fixture({ total }); assert.equal((await f.screener.load()).rows.length, total); assert.equal(f.calls(), Math.ceil(total / 100)); }
});
test('部分页失败、重复页、总数变化均拒绝发布部分股票池', async () => {
  for (const options of [{ fail: true }, { duplicate: true }, { changedTotal: true }]) {
    const f = fixture(options); await assert.rejects(f.screener.load()); assert.equal(f.screener.snapshot, null); assert.equal(f.screener.progress.loading, false);
  }
});
test('刷新失败保留旧快照，但本次请求明确失败；恢复后可重试', async () => {
  const f = fixture(), old = await f.screener.load(), previous = f.screener.fetcher;
  f.screener.fetcher = async () => { throw Error('offline'); };
  await assert.rejects(f.screener.load(true), /offline/); assert.equal(f.screener.snapshot, old); assert.equal(f.screener.pending, null);
  f.screener.fetcher = previous; assert.equal((await f.screener.load(true)).rows.length, 205);
});
test('HTTP错误、异常格式和截断分页不被当成无匹配', async () => {
  const bad = [{ ok: false, status: 503 }, ...[{ rc: 1 }, { rc: 0, data: { total: 10, diff: [] } }, { rc: 0, data: { total: 15001, diff: [raw()] } }, { rc: 0, data: { total: 101, diff: [raw()] } }].map(json => ({ ok: true, json: async () => json }))];
  for (const response of bad) await assert.rejects(new Screener(async () => response).load());
});
test('筛选为只读计算：不修改查询、行情或自选列表', () => {
  const s = snapshot(), q = parse('主板，股价大于1'), watchlist = ['sh600001'], before = structuredClone({ s, q, watchlist });
  screen(s, q, watchlist); assert.deepEqual({ s, q, watchlist }, before);
});
test('常见描述助词可识别，但矛盾范围仍拒绝执行', () => {
  assert.equal(parse('帮我找一下非ST的主板股票，股价在10-30元之间，市值不超过300亿').rules.length, 3);
  assert.equal(parse('我的自选股票，排除ST股票').scope, 'watchlist');
  assert.throws(() => parse('我的自选股，全市场，市值小于100亿'), /范围/);
  assert.equal(parse('股价大于等于10，股价小于等于20').rules[0].op, 'gte');
  for (const text of ['排除ST和创业板', '排除ST、科创板', '排除ST和市盈率小于0', '排除ST和*ST和创业板']) assert.throws(() => parse(text), /排除/);
  assert.equal(parse('排除 ST / *ST，主板').excludeST, true);
});
test('短暂网络错误有限重试后可成功获取，不额外重复成功页', async () => {
  let calls = 0; const hosts = [];
  const screener = new Screener(async url => { hosts.push(new URL(url).hostname); if (++calls === 1) throw Error('connection reset'); return { ok: true, json: async () => ({ rc: 0, data: { total: 1, diff: [raw()] } }) }; });
  assert.equal((await screener.load()).rows.length, 1); assert.equal(calls, 2);
  assert.deepEqual(hosts, ['push2.eastmoney.com', '82.push2.eastmoney.com']);
});
