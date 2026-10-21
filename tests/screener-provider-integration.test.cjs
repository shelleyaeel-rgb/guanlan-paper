const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Screener, defaults, normalize } = require('../core/screener.cjs');
const { ScreenerStore } = require('../core/screener-store.cjs');
const { TENCENT_SCREEN_SOURCE } = require('../core/screener-tencent.cjs');
const baseTime = Date.parse('2026-10-08T14:00:00+08:00');
function snapshot(source = TENCENT_SCREEN_SOURCE, fetchedAt = baseTime) {
  return { source, startedAt: fetchedAt - 1000, fetchedAt, sourceCount: 1, excludedCount: 0,
    rows: [normalize({ f12: '600519', f13: 1, f14: '测试股票', f2: 10, f3: 2, f5: 20000, f6: 1e8, f7: 5, f8: 3, f9: 15, f10: 1.5, f20: 100e8, f21: 80e8, f23: 2, f124: fetchedAt / 1000 })] };
}
function isolated(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-provider-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, history: new ScreenerStore(dir) };
}
function screener(history, load) { return new Screener(() => { throw Error('旧接口不应调用'); }, history, null, () => new Date(baseTime), null, null, null, load); }

test('新来源完整快照发布后保存，重启可按原时点离线筛选，旧东方财富快照兼容', async t => {
  const { dir, history } = isolated(t);
  history.remember(snapshot('东方财富公开行情', baseTime - 86400000));
  let calls = 0;
  const s = screener(history, async ({ onProgress }) => { calls++; onProgress({ loading: true, stage: 'screen-quotes', completed: 1, total: 1 }); return snapshot(); });
  const result = await s.run(defaults(), [], true);
  assert.equal(calls, 1); assert.equal(result.source, TENCENT_SCREEN_SOURCE); assert.equal(result.matched, 1);
  assert.equal(s.progress.loading, false);
  const restored = new ScreenerStore(dir); assert.equal(restored.warning, ''); assert.equal(restored.list().length, 2);
  const offline = screener(restored, async () => { throw Error('离线时不能联网'); });
  for (const entry of restored.list()) {
    const historic = await offline.run(defaults(), [], false, entry.id);
    assert.equal(historic.source, entry.source); assert.equal(historic.dataMode, 'historical'); assert.equal(historic.matched, 1);
    assert.equal(historic.rows[0].timestamp, entry.fetchedAt);
  }
  assert.equal(fs.existsSync(path.join(dir, 'account.json')), false);
});

test('刷新失败或来源加载完成瞬间取消，均不替换内存快照和历史；之后可恢复', async t => {
  const { dir, history } = isolated(t);
  const original = snapshot(), updated = snapshot(TENCENT_SCREEN_SOURCE, baseTime + 60000);
  let mode = 'ok';
  const s = screener(history, async () => {
    if (mode === 'fail') throw Error('行情不完整');
    if (mode === 'cancel') s.cancel();
    return mode === 'ok' ? original : updated;
  });
  await s.run(defaults(), [], true);
  const saved = fs.readFileSync(history.file, 'utf8');
  for (const failureMode of ['fail', 'cancel']) {
    mode = failureMode;
    await assert.rejects(s.run(defaults(), [], true), failureMode === 'fail' ? /行情不完整/ : /取消/);
    assert.equal(s.snapshot, original); assert.equal(fs.readFileSync(history.file, 'utf8'), saved);
    assert.equal(s.pending, null); assert.equal(s.activeRun, null); assert.equal(s.progress.loading, false);
  }
  mode = 'updated'; const result = await s.run(defaults(), [], true);
  assert.equal(s.snapshot, updated); assert.equal(result.fetchedAt, updated.fetchedAt);
  assert.equal(new ScreenerStore(dir).list()[0].fetchedAt, updated.fetchedAt);
});

test('新来源历史保存失败明确告警，成功取得的完整行情仍可筛选', async () => {
  const history = { remember() { throw Error('磁盘写入失败'); }, warning: '' };
  const s = screener(history, async () => snapshot());
  const result = await s.run(defaults(), [], true);
  assert.equal(result.matched, 1); assert.match(result.historyWarning, /磁盘写入失败/);
});
