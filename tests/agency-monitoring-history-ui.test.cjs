'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../ui/agency.js'), 'utf8').split("$('agency-tabs').addEventListener")[0];
const oldReason = '开仓资料未就绪：公告资料已过期或不可用，等待后台准备或手动核验';
const oldCheck = status => ({ status, reason: oldReason, checkedAt: '2026-10-23T02:00:00.000Z' });
const currentCheck = (status, reason) => ({ status, reason, checkedAt: '2026-10-26T02:00:00.000Z', entryPolicyVersion: 1 });
function fixture({ member = { symbol: 'sh600938', mode: 'active' }, mode = 'running', runtime } = {}) {
  const group = { id: 'swing', mode, members: [member], positions: [] };
  const context = vm.createContext({ structuredClone, member, group, state: { agency: { groups: [group], runtime } }, timeText: value => value,
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') });
  vm.runInContext(source, context);
  return { context, run: expression => vm.runInContext(expression, context) };
}

test('obsolete data and passed checks stay stored but their descriptions are absent from recent checks', () => {
  for (const field of ['legacyMonitoringCheck', 'monitoringCheck']) for (const status of ['data', 'eligible']) {
    const f = fixture({ member: { symbol: 'sh600938', mode: 'active', [field]: oldCheck(status) } });
    const saved = JSON.stringify(f.context.state);
    assert.equal(f.run('agencyMonitoringStatus(member)'), 'recheck');
    const html = f.run('agencyMonitoringHtml(member)');
    assert.match(html, /待重新检查.*未开仓原因：等待新一轮技术开仓检查/);
    assert.equal(html.includes(oldReason), false);
    assert.doesNotMatch(html, /legacy-monitoring|旧版检查|2026-10-23|本轮开仓检查通过|数据待核验/);
    assert.equal(JSON.stringify(f.context.state), saved, 'displaying the reason must preserve archived account records');
  }
});

test('an unversioned current field is also treated as historical and never counted as currently passed or blocked', () => {
  const f = fixture();
  f.context.group = { positions: [], members: ['data', 'eligible'].map(status => ({ symbol: status, mode: 'active', monitoringCheck: oldCheck(status) })) };
  const html = f.run('agencyMonitoringSummary(group)');
  for (const status of ['data', 'eligible']) assert.match(html, new RegExp(`data-monitoring-count="${status}"[\\s\\S]*?<strong>0<\\/strong>`));
  assert.match(html, /data-monitoring-count="recheck"[\s\S]*?<strong>2<\/strong>/);
  assert.match(html, /每策略最多 20 只/);
});

test('current data, risk, funds and entry-condition failures explain unopened positions without duplicate text', () => {
  const f = fixture();
  for (const [status, reason] of [['data', '完整日线不足 61 根'], ['risk', '价格基准不一致'], ['funds', '达到本策略持仓数量上限'], ['conditions', '回踩信号尚未站稳 60 秒']]) {
    f.context.member = { mode: 'active', legacyMonitoringCheck: oldCheck('data'),
      monitoringCheck: currentCheck(status, reason) };
    assert.equal(f.run('agencyMonitoringStatus(member)'), status);
    const html = f.run('agencyMonitoringHtml(member)');
    assert.ok(html.includes(`未开仓原因：${reason}`));
    assert.equal(html.split(reason).length - 1, 1);
    assert.match(html, /最近检查 2026-10-26T02:00:00.000Z/);
    assert.doesNotMatch(html, /待重新检查|公告资料已过期|旧版检查/);
  }
});

test('current strategy permission explains why a previously passed candidate has not opened', () => {
  const f = fixture({ member: { symbol: 'sh600938', mode: 'active', monitoringCheck: currentCheck('eligible', '技术入场规则通过') } });
  for (const [mode, expected] of [['paused', /本策略已暂停新开仓/], ['stopped', /本策略已全部停止/]]) {
    f.context.group.mode = mode;
    const saved = JSON.stringify(f.context.state);
    const reason = f.run('agencyUnopenedReason(member)'), html = f.run('agencyMonitoringHtml(member)');
    assert.match(reason, expected);
    assert.ok(html.includes(`未开仓原因：${reason}`));
    assert.match(html, /最近检查结果：技术入场规则通过/);
    assert.equal(JSON.stringify(f.context.state), saved, 'rendering must not rewrite the saved pass or permission');
  }
});

test('unavailable service and nontrading sessions explain why entry checking is waiting', () => {
  for (const [runtime, expected] of [
    [{ online: false, lastError: '账户保存失败，自动交易已暂停' }, /自动交易当前不可用.*最近运行错误：账户保存失败，自动交易已暂停/],
    [{ online: false }, /自动交易当前不可用，等待恢复/],
    [{ session: { known: false, label: '交易日历尚未核验' } }, /交易日历尚未核验/],
    [{ session: { known: false } }, /交易日历尚未核验，暂停自动开仓/],
    [{ session: { known: true, open: false, label: '午间休市' } }, /午间休市，等待连续竞价时段重新检查/]
  ]) {
    const f = fixture({ runtime, member: { symbol: 'sh600938', mode: 'active', monitoringCheck: currentCheck('eligible', '技术入场规则通过') } });
    assert.match(f.run('agencyUnopenedReason(member)'), expected);
    assert.match(f.run('agencyMonitoringHtml(member)'), /data-unopened-reason/);
  }
});

test('current preparation failures and waits take precedence over an earlier entry check', () => {
  for (const [status, reason] of [['error', '完整日线下载失败'], ['preparing', '正在下载完整日线'], ['prepared', '盘前资料已准备，等待开市'], ['waiting-live', '等待当前价格基准核验']]) {
    const f = fixture({ member: { symbol: 'sh600938', mode: 'active', monitoringCheck: currentCheck('data', '旧检查：完整日线尚未准备') },
      runtime: { preparation: { members: [
        { symbol: 'sh600938', strategyId: 'short', status: 'error', reason: '别的策略原因' },
        { symbol: 'sh600000', strategyId: 'swing', status: 'error', reason: '别的股票原因' },
        { symbol: 'sh600938', strategyId: 'swing', status, reason }
      ] } } });
    assert.equal(f.run('agencyUnopenedReason(member)'), reason);
    const html = f.run('agencyMonitoringHtml(member)');
    assert.ok(html.includes(`未开仓原因：${reason}`));
    assert.match(html, /最近检查结果：旧检查：完整日线尚未准备/);
    assert.doesNotMatch(html, /别的策略原因|别的股票原因/);
  }
});

test('ready data does not replace a concrete entry-condition failure or promise execution after a pass', () => {
  const f = fixture({ runtime: { preparation: { members: [{ symbol: 'sh600938', strategyId: 'swing', status: 'ready', reason: '资料已就绪' }] } } });
  f.context.member.monitoringCheck = currentCheck('conditions', '等待突破站稳确认');
  assert.equal(f.run('agencyUnopenedReason(member)'), '等待突破站稳确认');
  f.context.member.monitoringCheck = currentCheck('eligible', '技术入场规则通过');
  const reason = f.run('agencyUnopenedReason(member)'), html = f.run('agencyMonitoringHtml(member)');
  assert.match(reason, /检查已通过，但尚未形成持仓.*仍需执行前复核/);
  assert.doesNotMatch(reason, /正在.*(?:下单|买入|执行)|即将成交|保证/);
  assert.match(html, /最近检查结果：技术入场规则通过/);
});

test('a flat candidate with no check or a previous holding or paused result waits for a new check', () => {
  const f = fixture();
  for (const check of [undefined, currentCheck('holding', '已模拟成交，继续跟踪原退出计划'), currentCheck('paused', '策略已暂停新开仓')]) {
    f.context.member.monitoringCheck = check;
    const reason = f.run('agencyUnopenedReason(member)');
    assert.match(reason, /等待新一轮技术开仓检查/);
    assert.doesNotMatch(reason, /已模拟成交|已暂停新开仓/);
    assert.ok(f.run('agencyMonitoringHtml(member)').includes(`未开仓原因：${reason}`));
  }
});

test('standby and exit reasons take precedence over current strategy permission and archived checks', () => {
  const f = fixture();
  f.context.group.mode = 'paused';
  for (const [mode, expected] of [['standby', 'standby'], ['closing', 'exiting'], ['removing', 'exiting']]) {
    f.context.member = { symbol: 'sh600938', mode, standbyReason: '活跃候选名额已满，等待下一轮排序', legacyMonitoringCheck: oldCheck('eligible') };
    assert.equal(f.run('agencyMonitoringStatus(member)'), expected);
    const reason = f.run('agencyUnopenedReason(member)'), html = f.run('agencyMonitoringHtml(member)');
    assert.match(reason, mode === 'standby' ? /活跃候选名额已满/ : /退出或移除安排，不参与新开仓/);
    assert.ok(html.includes(`未开仓原因：${reason}`));
    assert.doesNotMatch(html, /本策略已暂停|旧版检查|公告资料已过期/);
  }
  f.context.member = { mode: 'active' };
  assert.equal(f.run('agencyMonitoringStatus(member)'), 'unchecked');
});

test('held members never receive an unopened-position explanation, including pending exits', () => {
  const f = fixture({ mode: 'paused', runtime: { online: false, lastError: '服务暂不可用' } });
  for (const mode of ['active', 'closing', 'removing']) {
    f.context.member.mode = mode;
    f.context.member.monitoringCheck = currentCheck('holding', '已模拟成交，继续跟踪原退出计划');
    assert.equal(f.run('agencyUnopenedReason(member, true)'), '');
    assert.doesNotMatch(f.run('agencyMonitoringHtml(member, true)'), /未开仓原因|data-unopened-reason/);
  }
  delete f.context.member.monitoringCheck;
  f.context.member.mode = 'active';
  assert.match(f.run('agencyMonitoringHtml(member, true)'), /等待下一轮持仓检查/);
});

test('unopened reasons and previous check text escape stored markup without modifying account data', () => {
  const reason = '价格 < 10 & <script>bad</script>', f = fixture({ member: { symbol: 'sh600938', mode: 'active',
    legacyMonitoringCheck: oldCheck('eligible'), monitoringCheck: currentCheck('conditions', reason) } });
  for (const runtime of [undefined, { online: false, lastError: '<img src=x onerror="bad()">服务失败' }]) {
    f.context.state.agency.runtime = runtime;
    const saved = JSON.stringify(f.context.state), html = f.run('agencyMonitoringHtml(member)');
    assert.match(html, /价格 &lt; 10 &amp; &lt;script&gt;bad&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>|<img/);
    if (runtime) assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
    assert.equal(JSON.stringify(f.context.state), saved);
  }
});

test('member decision text explicitly identifies history and escapes the stored reason', () => {
  const f = fixture();
  f.context.item = { time: '2026-10-23T02:00:00.000Z', decisionSource: 'rules', status: 'blocked', reason: oldReason + '<script>bad</script>' };
  const html = f.run('agencyHistoricalDecisionHtml(item)');
  assert.match(html, /历史决策记录 · 2026-10-23T02:00:00.000Z/);
  assert.ok(html.includes(oldReason));
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.ok(source.includes('${agencyHistoricalDecisionHtml(latest)}'), 'member detail uses the historical label');
});
