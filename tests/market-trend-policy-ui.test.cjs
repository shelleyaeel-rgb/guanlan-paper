'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../ui/agency.js'), 'utf8').split("$('agency-tabs').addEventListener")[0];
const now = Date.parse('2026-11-03T10:00:00+08:00');

function fixture(overrides = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', dataset: {}, classList: { toggle() {} }, setAttribute() {} });
    return elements.get(id);
  };
  const snapshot = { version: 1, policyVersion: 2, date: '2026-11-03', checkedAt: now - 1000, expiresAt: now + 80000,
    status: 'strong', riskMultiplier: 1, allowEntry: true, allowBreakout: true, reason: '当日广度偏强，指数中期趋势仅供观察。',
    metrics: { highVolatility: false, breadth: { advanceRatio: 0.6, advancing: 3000, valid: 5000, expected: 5000, coverage: 1 },
      indices: ['sh000001', 'sz399001', 'sz399006'].map(symbol => ({ symbol, trend: 'down', ma20Slope5: -0.03, atrRatio: 0.02, asOf: '2026-11-02', quoteTime: now - 1000 })) },
    ...overrides };
  const context = vm.createContext({ state: { now, agency: { marketPolicy: { enabled: true }, runtime: { marketRegime: snapshot },
    groups: [{ id: 'swing', limits: { riskPercent: 0.5 } }] } }, $: element, setHtml: (id, html) => { element(id).innerHTML = html; },
    timeText: value => String(value ?? ''), esc: value => String(value ?? ''), num: value => String(value),
    pct: value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—', dailyHistoryHtml: () => '',
    table: (headers, rows) => [headers, ...rows].map(row => row.join(' | ')).join('\n') });
  vm.runInContext(source, context);
  return { element, snapshot, run: expression => vm.runInContext(expression, context) };
}

test('current breadth permission remains visible when all three observed index trends point down', () => {
  const f = fixture();
  f.run('renderAgencyMarketRegime()');
  assert.equal(f.element('agency-market-regime').dataset.marketStatus, 'strong');
  assert.match(f.element('agency-market-badge').textContent, /当日广度偏强.*正常风险预算/);
  assert.match(f.element('agency-market-summary').textContent, /可检查回踩或突破/);
  assert.match(f.element('agency-market-indices').innerHTML, /中期趋势（仅观察）.*5 日 MA20 变化（仅观察）/);
  assert.equal(f.element('agency-market-indices').innerHTML.match(/向下/g).length, 3);
  assert.match(f.element('agency-market-metrics').innerHTML, /当日市场广度 · 上涨占比/);
  assert.match(f.run('agencyVerificationSummary({summary:{checked:3}, marketRegime:state.agency.runtime.marketRegime})'), /市场环境：当日广度偏强（已确认）/);
});

test('breadth weakness and high volatility still display their actual entry restrictions', () => {
  const weak = fixture({ status: 'weak', riskMultiplier: 0, allowEntry: false, allowBreakout: false });
  weak.run('renderAgencyMarketRegime()');
  assert.match(weak.element('agency-market-badge').textContent, /当日广度偏弱.*暂停新开仓/);
  assert.match(weak.element('agency-market-summary').textContent, /暂停四类策略新开仓/);

  for (const status of ['strong', 'neutral']) {
    const f = fixture({ status, riskMultiplier: 0.5, allowBreakout: false });
    if (status === 'strong') f.snapshot.metrics.highVolatility = true;
    f.run('renderAgencyMarketRegime()');
    assert.match(f.element('agency-market-badge').textContent, /半额风险预算/);
    if (status === 'strong') assert.match(f.element('agency-market-badge').textContent, /当日广度偏强.*高波动/);
    assert.match(f.element('agency-market-summary').textContent, /仅检查回踩条件，单笔及策略总计划风险预算减半/);
  }
});

test('old trend-based permissions cannot appear as current authorization after the policy update', () => {
  const f = fixture({ policyVersion: 1, reason: '三个指数向下，暂停新开仓' });
  f.run('renderAgencyMarketRegime()');
  assert.equal(f.element('agency-market-regime').dataset.marketStatus, 'unknown');
  assert.match(f.element('agency-market-badge').textContent, /市场资料待核验.*暂停新开仓/);
  assert.match(f.element('agency-market-reason').textContent, /规则已更新.*当日广度与指数波动重新核验/);
  assert.doesNotMatch(f.element('agency-market-reason').textContent, /三个指数向下/);
});

test('improving breadth is identified as awaiting confirmation while previous permissions remain in force', () => {
  for (const [status, multiplier] of [['weak', 0], ['neutral', 0.5]]) {
    const f = fixture({ status, riskMultiplier: multiplier, allowEntry: multiplier > 0, allowBreakout: false,
      reason: '市场环境改善等待持续确认：至少 2 份不同报价且间隔 120 秒' });
    f.snapshot.metrics.candidateStatus = 'strong';
    Object.assign(f.snapshot.metrics.breadth, { advanceRatio: 0.83, advancing: 4150 });
    f.run('renderAgencyMarketRegime()');
    const badge = f.element('agency-market-badge').textContent;
    assert.match(badge, /当日广度偏强 · 待持续确认/);
    assert.match(badge, multiplier ? /半额风险预算/ : /暂停新开仓/);
    assert.doesNotMatch(badge, /当日广度偏弱|当日广度中性|正常风险预算/);
    assert.equal(f.element('agency-market-regime').dataset.marketStatus, status);
    assert.match(f.element('agency-market-metrics').innerHTML, /83\.0%/);
    assert.match(f.element('agency-market-summary').textContent, multiplier ? /仅检查回踩条件/ : /暂停四类策略新开仓/);
    const summary = f.run('agencyVerificationSummary({summary:{checked:3}, marketRegime:state.agency.runtime.marketRegime})');
    assert.match(summary, /当日广度偏强 · 待持续确认/);
    assert.match(summary, multiplier ? /（当前半额风险预算）/ : /（暂停新开仓）/);
    assert.doesNotMatch(summary, /（已确认）/);
  }
});

test('a stored check reason is presented as the last check without rewriting its historical explanation', () => {
  const f = fixture();
  const html = f.run(`agencyMonitoringHtml({symbol:'sh600001', mode:'active', monitoringCheck:{entryPolicyVersion:1, status:'conditions',
    reason:'三个指数向下，暂停新开仓', checkedAt:'2026-11-02T06:50:00Z'}}, false, {mode:'running'})`);
  assert.match(html, /最近检查未开仓原因：三个指数向下，暂停新开仓/);
  assert.match(html, /最近检查 2026-11-02T06:50:00Z/);
});
