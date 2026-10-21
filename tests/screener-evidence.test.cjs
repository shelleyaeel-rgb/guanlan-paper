const test = require('node:test');
const assert = require('node:assert/strict');
const { Screener, defaults, validate, describe, parseDescription, financialQualityRules } = require('../core/screener.cjs');
const { composeStrategyQuery, parseStrategyDescription } = require('../core/strategy-presets.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');

const now = new Date('2026-10-08T10:00:00+08:00');
const row = (symbol, extra = {}) => ({ symbol, name: '隔离样本', board: 'sh', isST: false, price: 10, pe: 15, timestamp: now.getTime(), ...extra });
const evidence = (symbol, kind = 'demand', value = 'supported', extra = {}) => ({ symbol, kind, value, subject: '核心产品', reviewState: 'confirmed', sourceTitle: '隔离证据资料', url: 'https://example.com/report', publishedAt: '2026-04-01', period: '2025年度', reviewedAt: '2026-05-01', validUntil: '2027-05-01', quote: '可核实的测试事实', notes: '', ...extra });
const ranking = (symbol, kind, rank, extra = {}) => evidence(symbol, kind, 'ranked', { rank, market: kind === 'mainRank' ? '测试主行业市场' : '测试细分产品市场', geography: '中国', metric: 'sales', coverage: 'allCompetitors', statisticYear: 2025, revenueSharePct: 30, ...extra });
function scanner(rows, loader, extra = {}) {
  const service = new Screener(null, extra.history, extra.daily, () => now, extra.finance, extra.notices, null, null, loader);
  service.snapshot = { rows, fetchedAt: now.getTime(), source: '隔离行情' };
  service.load = async () => service.snapshot;
  return service;
}
const parse = text => parseDescription(text).query;

test('量化条件与证据 AND，主行业与细分路径 OR，仅命中者查证且保留三态依据', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(`sh60000${i + 1}`, i === 5 ? { pe: 50 } : {}));
  let requested;
  const records = [
    evidence('sh600001'), ranking('sh600001', 'mainRank', 3),
    evidence('sh600002'), ranking('sh600002', 'mainRank', 5), ranking('sh600002', 'segmentRank', 1),
    evidence('sh600003'), ranking('sh600003', 'mainRank', 4), ranking('sh600003', 'segmentRank', 2),
    evidence('sh600004'),
    evidence('sh600005', 'demand', 'unsupported'), ranking('sh600005', 'mainRank', 1),
    evidence('sh600006'), ranking('sh600006', 'mainRank', 1)
  ];
  const service = scanner(rows, symbols => { requested = symbols; return records; });
  const query = parse('市盈率小于20，需求增长有依据，主行业前三或细分龙头');
  const before = structuredClone({ snapshot: service.snapshot, query, records });
  const result = await service.run(query, []);
  assert.deepEqual(requested, rows.slice(0, 5).map(item => item.symbol));
  assert.deepEqual(result.rows.map(item => item.symbol), ['sh600001', 'sh600002']);
  assert.deepEqual(result.evidencePendingRows.map(item => item.symbol), ['sh600004']);
  assert.deepEqual(result.evidenceFailedRows.map(item => item.symbol), ['sh600003', 'sh600005']);
  assert.deepEqual(result.evidenceScreen, { evaluated: 5, passed: 2, pending: 1, failed: 2, checkedAt: now.toISOString() });
  assert.equal(result.matched, 2); assert.equal(result.partial, true); assert.equal(result.missing, 0);
  assert.match(result.labels.join(''), /主行业前三或/); assert.match(result.dataMessage, /待核验 1 只/);
  assert.equal(result.rows[0].selectionEvidence.records[0].quote, '可核实的测试事实');
  assert.deepEqual({ snapshot: service.snapshot, query, records }, before);
});

test('空证据库与读取失败都待核验，不能报告零命中；纯量化不访问证据库', async () => {
  for (const loader of [null, () => [], () => { throw Error('离线'); }, () => ({ records: [] })]) {
    const service = scanner([row('sh600001')], loader);
    const result = await service.run(parse('产品前景有证据支持'), []);
    assert.equal(result.status, 'unavailable'); assert.equal(result.matched, null); assert.equal(result.partial, true);
    assert.equal(result.evidencePendingRows.length, 1); assert.equal(result.evidenceFailedRows.length, 0);
  }
  const service = scanner([row('sh600001')], () => { throw Error('不应访问'); });
  assert.equal((await service.run(parse('市盈率小于20'), [])).matched, 1);
  const noCandidate = await service.run(parse('市盈率大于20，产品前景好'), []);
  assert.equal(noCandidate.status, 'empty'); assert.equal(noCandidate.evidenceScreen.evaluated, 0);
});

test('产品评价缺反向证据复核不能通过，补齐同产品证据后通过', async () => {
  const records = [evidence('sh600001'), evidence('sh600001', 'commercialization', 'production'), evidence('sh600001', 'advantage', 'verified')];
  const service = scanner([row('sh600001')], () => records);
  assert.equal((await service.run(parse('产品前景好'), [])).evidenceScreen.pending, 1);
  records.push(evidence('sh600001', 'outlookRisk', 'clear'));
  assert.equal((await service.run(parse('产品前景好'), [])).matched, 1);
});

test('财务和日线先完成，证据筛选不会提前阻断候选；通过证据后仍执行公告检查', async () => {
  const calls = [];
  const service = scanner([row('sh600001'), row('sh600002')], symbols => { calls.push(['evidence', ...symbols]); return [evidence('sh600001')]; }, {
    finance: symbol => { calls.push(['finance', symbol]); return { symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: now.getTime(), industryProfile: ordinaryProfile(symbol, now), data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-01', roe: 15 } } }; },
    daily: symbol => { calls.push(['daily', symbol]); return { source: '日线样本', bars: Array.from({ length: 100 }, (_, i) => ({ date: new Date(Date.UTC(2026, 3, i + 1)).toISOString().slice(0, 10), open: 10, close: 10 + i / 100, high: 12, low: 9, volume: 100 })) }; },
    notices: symbol => { calls.push(['notices', symbol]); return { symbol, section: 'notices', status: 'empty', source: '东方财富', fetchedAt: now.getTime(), data: { items: [], total: 0 } }; }
  });
  const result = await service.run(parse('ROE大于10，收盘高于MA20，需求增长有依据'), [], false, null, 'long');
  assert.deepEqual(calls.map(call => call[0]), ['finance', 'finance', 'daily', 'daily', 'evidence', 'notices']);
  assert.deepEqual(result.rows.map(item => item.symbol), ['sh600001']);
  assert.equal(result.riskScreen.noticeChecked, 1); assert.equal(result.evidenceScreen.pending, 1);
});

test('证据任务可立即取消，即使读取器不响应 signal 也不会发布或污染缓存', async () => {
  let release, signal;
  const service = scanner([row('sh600001')], (symbols, inputSignal) => { signal = inputSignal; return new Promise(resolve => { release = resolve; }); });
  const before = structuredClone(service.snapshot), task = service.run(parse('需求增长有依据'), []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.progress.stage, 'evidence'); service.cancel();
  await assert.rejects(task, /取消/); assert.equal(signal.aborted, true); assert.equal(service.activeRun, null);
  release([evidence('sh600001')]); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(service.snapshot, before); assert.equal(service.progress.loading, false);
});

test('历史快照证据条件在读取行情、历史和证据前拒绝', async () => {
  const service = scanner([], () => { throw Error('不应读取'); }, { history: { get() { throw Error('不应读取'); } } });
  service.load = () => { throw Error('不应读取'); };
  await assert.rejects(service.run(parse('需求增长有依据'), [], false, 'history-id'), /历史快照未保存当时可知的选股证据/);
});

test('固定短语转成明确条件与说明，未知 OR 不泛化且财务模板可编辑', () => {
  const parsed = parseDescription('财务状况良好，产品前景好，主行业前三或细分龙头');
  assert.deepEqual(parsed.query.rules, financialQualityRules());
  assert.deepEqual(parsed.query.evidence.conditions, ['productOutlook', 'financialReview']);
  assert.equal(parsed.query.evidence.leadership, 'either');
  assert.match(parsed.notes.join(''), /普通非金融企业/); assert.match(parsed.notes.join(''), /未经策略效果验证/);
  for (const [text, condition] of [['需求增长有依据', 'demand'], ['产品已商业化', 'commercialization'], ['竞争优势已证实', 'advantage']]) assert.deepEqual(parse(text).evidence.conditions, [condition]);
  assert.equal(parse('主行业前三').evidence.leadership, 'mainTop3'); assert.equal(parse('细分龙头').evidence.leadership, 'segmentLeader');
  for (const text of ['产品前景好或ROE大于10', '需求增长有依据或者竞争优势已证实', '不是产品前景好', '主行业前三，细分龙头']) assert.throws(() => parse(text));
  const second = financialQualityRules(); second[0].value = 0; assert.equal(financialQualityRules()[0].value, 3);
});

test('校验保留证据条件，未知证据字段和条件不静默丢弃', () => {
  const query = parse('需求增长有依据，主行业前三');
  assert.deepEqual(validate(query), query); assert.ok(describe(query).some(label => /需求增长/.test(label)));
  for (const evidenceQuery of [{ conditions: ['unknown'] }, { leadership: 'top100' }, { any: true }, { conditions: ['demand'], minSegmentRevenuePct: -1 }]) assert.throws(() => validate({ ...defaults(), evidence: evidenceQuery }));
});

test('追加文字与切换投资策略保留证据，收紧行业路径且不能静默放宽已有阈值', () => {
  const baseQuery = parse('需求增长有依据，主行业前三或细分龙头'); baseQuery.evidence.minSegmentRevenuePct = 50;
  const before = structuredClone(baseQuery);
  const merged = parseStrategyDescription({ text: '产品已商业化，细分龙头，市盈率小于20', baseQuery });
  assert.deepEqual(merged.query.evidence, { conditions: ['demand', 'commercialization'], leadership: 'segmentLeader', minSegmentRevenuePct: 50 });
  assert.deepEqual(composeStrategyQuery('long', merged.query).evidence, merged.query.evidence);
  assert.deepEqual(parseStrategyDescription({ text: 'ROE大于10', baseQuery }).query.evidence, baseQuery.evidence);
  assert.equal(parseStrategyDescription({ text: '主行业前三或细分龙头', baseQuery: parse('主行业前三') }).query.evidence.leadership, 'mainTop3');
  assert.throws(() => parseStrategyDescription({ text: '细分龙头', baseQuery: parse('主行业前三') }), /两条路径同时满足/);
  assert.deepEqual(baseQuery, before);
});
