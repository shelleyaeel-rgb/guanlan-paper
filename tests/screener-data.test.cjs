const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Screener, normalize, parseDescription, screen, defaults } = require('../core/screener.cjs');
const { ScreenerStore, usableSnapshot } = require('../core/screener-store.cjs');
const query = text => parseDescription(text).query;
const raw = (code = '600001', changes = {}) => ({ f12: code, f13: 1, f14: '隔离样本', f2: 10, f3: 2, f5: 10000, f6: 1e8, f7: 2, f8: 3, f9: 12, f10: 1, f20: 100e8, f21: 80e8, f23: 1, f124: Date.parse('2026-09-29T15:00:00+08:00') / 1000, ...changes });
function snapshot(changes = [{}], date = '2026-09-29T15:10:00+08:00') {
  const time = Date.parse(date);
  return { source: '东方财富公开行情', sourceCount: changes.length, excludedCount: 0, startedAt: time - 1000, fetchedAt: time, rows: changes.map((r, i) => normalize(raw(String(600001 + i), r))) };
}
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-screener-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('guanlan-screener-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}
test('盘前：PE有效、价格和时间缺失仍可筛选；40边界、负值和0不被改变', () => {
  const data = snapshot([12, 39.99, 40, 50, null, -5, 0].map(f9 => ({ f9, f2: '-', f124: 0 })));
  const result = screen(data, query('动态市盈率小于40倍'));
  assert.equal(result.status, 'ready'); assert.equal(result.matched, 4); assert.equal(result.evaluatedCount, 6); assert.equal(result.missing, 1);
  assert.deepEqual(result.rows.map(r => r.pe), [12, 39.99, -5, 0]);
  assert.deepEqual(result.requiredFields, ['pe']);
  assert.equal(result.missingByField.price, 7); assert.equal(result.missingByField.timestamp, 7); assert.equal(result.missingByField.pe, 1);
  assert.equal(result.oldestQuote, null); assert.equal(result.newestQuote, null); assert.equal(result.unknownQuoteTime, 4);
  assert.ok(result.rows.every(r => r.price === null && r.timestamp === null));
  assert.equal(screen(data, query('市盈率不超过40倍')).matched, 5);
  assert.equal(screen(data, query('市盈率大于0，市盈率小于40倍')).matched, 2);
});
test('PE全部缺失是无法筛选，完整指标不符合是零匹配；空范围单独处理', () => {
  const unavailable = screen(snapshot([{ f9: '-' }, { f9: null }]), query('市盈率小于40'));
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.matched, null);
  assert.equal(unavailable.evaluatedCount, 0); assert.equal(unavailable.missing, 2); assert.match(unavailable.dataMessage, /动态市盈率数据暂不可用/);
  const empty = screen(snapshot([{ f9: 40 }, { f9: 50 }]), query('市盈率小于40'));
  assert.equal(empty.status, 'empty'); assert.equal(empty.matched, 0); assert.equal(empty.missing, 0);
  const outside = screen(snapshot([{ f9: null }]), query('创业板，市盈率小于40'));
  assert.equal(outside.status, 'empty'); assert.equal(outside.poolCount, 0); assert.equal(outside.matched, 0);
});
test('组合条件仍要求全部所需指标，同一只缺多个字段只排除一次', () => {
  const result = screen(snapshot([{ f9: null, f2: null }, { f9: 12, f2: 0 }, { f9: null }, {}]), query('市盈率小于40，股价小于20'));
  assert.equal(result.missing, 3); assert.equal(result.missingByField.pe, 2); assert.equal(result.missingByField.price, 2); assert.equal(result.matched, 1);
  const disjoint = screen(snapshot([{ f9: 12, f2: null }, { f9: null }]), query('市盈率小于40，股价小于20'));
  assert.equal(disjoint.status, 'unavailable'); assert.match(disjoint.dataMessage, /完整指标/);
});
test('零成交是有效数值，零价格无效；时间缺失不混入已知时间区间', () => {
  const data = snapshot([{ f2: 0, f5: 0, f124: 0 }, { f2: '-', f5: '-', f124: '-' }, {}]);
  const result = screen(data, query('成交量等于0万手'));
  assert.equal(result.matched, 1); assert.equal(result.missing, 1);
  assert.equal(screen(data, query('股价小于40')).matched, 1);
  const list = screen(data, defaults()); assert.equal(list.matched, 3); assert.equal(list.missing, 0); assert.equal(list.unknownQuoteTime, 2);
  assert.equal(list.oldestQuote, data.rows[2].timestamp); assert.equal(list.newestQuote, data.rows[2].timestamp);
});
test('有效完整快照独立原子保存，重启后按原始时间离线筛选，不修改账户', async t => {
  const dir = directory(t), account = path.join(dir, 'account.json');
  fs.writeFileSync(account, '{"account":"untouched"}');
  const history = new ScreenerStore(dir), saved = snapshot([{ f9: 12 }, { f9: 45 }]);
  assert.equal(history.remember(saved), true); assert.equal(fs.existsSync(history.file + '.tmp'), false);
  const id = history.list()[0].id, reloaded = new ScreenerStore(dir);
  const service = new Screener(async () => { throw Error('must not fetch'); }, reloaded);
  const result = await service.run(query('市盈率小于40'), [], false, id);
  assert.equal(result.dataMode, 'historical'); assert.equal(result.snapshotId, id); assert.equal(result.matched, 1);
  assert.equal(result.fetchedAt, saved.fetchedAt); assert.equal(result.rows[0].pe, 12);
  assert.equal(fs.readFileSync(account, 'utf8'), '{"account":"untouched"}');
});
test('全列缺失的盘前快照不替换历史；部分缺失按原样保存，不填补旧值', t => {
  const history = new ScreenerStore(directory(t)); history.remember(snapshot()); const id = history.list()[0].id;
  for (const missing of [{ f9: null }, { f2: null }, { f124: null }, { f8: null }]) assert.equal(history.remember(snapshot([missing], '2026-09-30T08:57:00+08:00')), false);
  assert.equal(history.list()[0].id, id);
  const partial = snapshot([{ f9: 18 }, { f9: null }], '2026-09-30T10:00:00+08:00');
  assert.equal(history.remember(partial), true);
  assert.equal(history.get(history.list()[0].id).rows[1].pe, null);
  assert.equal(history.list().length, 2);
});
test('保留最近三个获取日期，每日只保留最新一份完整快照', t => {
  const history = new ScreenerStore(directory(t));
  for (const day of [26, 27, 28, 29]) history.remember(snapshot([{}], `2026-09-${day}T15:10:00+08:00`));
  assert.equal(history.list().length, 3);
  history.remember(snapshot([{ f9: 30 }], '2026-09-29T16:00:00+08:00'));
  assert.equal(history.list().length, 3); assert.equal(history.get(history.list()[0].id).rows[0].pe, 30);
  assert.equal(new ScreenerStore(path.dirname(history.file)).list().length, 3);
});
test('最新请求失败不自动切换历史；缺少指标时也返回最新的不可用状态', async t => {
  const history = new ScreenerStore(directory(t)); history.remember(snapshot());
  const service = new Screener(async () => { throw Error('offline'); }, history);
  await assert.rejects(service.run(query('市盈率小于40'), []), /offline/);
  const current = snapshot([{ f9: null }]); current.fetchedAt = Date.now(); current.startedAt = current.fetchedAt - 1000;
  service.snapshot = current;
  const result = await service.run(query('市盈率小于40'), []);
  assert.equal(result.status, 'unavailable'); assert.equal(result.dataMode, 'latest'); assert.equal(result.matched, null);
  assert.equal(history.get(history.list()[0].id).rows[0].pe, 12);
});
test('历史ID失效和强制刷新历史不会悄悄更换数据', async t => {
  const history = new ScreenerStore(directory(t)); history.remember(snapshot());
  const service = new Screener(async () => { throw Error('must not fetch'); }, history);
  await assert.rejects(service.run(defaults(), [], false, 'no-such-snapshot'), /不可用/);
  await assert.rejects(service.run(defaults(), [], true, history.list()[0].id), /切换至最新/);
  await assert.rejects(service.run(defaults(), [], false, {}), /选择无效/);
});
test('损坏、重复或不完整缓存不会被当作有效历史，也不阻止最新筛选', t => {
  const dir = directory(t), history = new ScreenerStore(dir); history.remember(snapshot());
  const valid = JSON.parse(fs.readFileSync(history.file, 'utf8'));
  const invalid = structuredClone(valid); invalid.snapshots[0].sourceCount++;
  for (const data of ['{broken', JSON.stringify(invalid), JSON.stringify({ version: 2, snapshots: valid.snapshots }), JSON.stringify({ version: 1, snapshots: [...valid.snapshots, ...valid.snapshots] })]) {
    fs.writeFileSync(history.file, data); const loaded = new ScreenerStore(dir);
    assert.equal(loaded.list().length, 0); assert.match(loaded.warning, /无法读取/);
  }
  assert.equal(usableSnapshot({ ...snapshot(), source: '其他口径' }), false);
  const broken = snapshot([{}, {}]); broken.rows[1].symbol = broken.rows[0].symbol; assert.equal(usableSnapshot(broken), false);
});
test('快照写入失败保留旧文件和列表，本次最新筛选仍正常且显示保存失败', async t => {
  const history = new ScreenerStore(directory(t)); history.remember(snapshot());
  const before = fs.readFileSync(history.file, 'utf8'), id = history.list()[0].id;
  fs.mkdirSync(history.file + '.tmp');
  const service = new Screener(async () => ({ ok: true, json: async () => ({ rc: 0, data: { total: 1, diff: [raw('600001', { f9: 25 })] } }) }), history);
  const result = await service.run(query('市盈率小于40'), []);
  assert.equal(result.matched, 1); assert.equal(result.rows[0].pe, 25); assert.match(result.historyWarning, /保存失败/);
  assert.equal(history.list()[0].id, id); assert.equal(fs.readFileSync(history.file, 'utf8'), before);
});
