const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEvidenceQuery, describeEvidenceQuery, evaluateEvidence, validateRecord, safeEvidenceUrl } = require('../core/selection-evidence.cjs');

const NOW = new Date('2026-10-08T08:00:00.000Z');
const record = (kind = 'demand', value = 'supported', changes = {}) => ({ symbol: 'sh600001', kind, subject: '汽车音响', value, reviewState: 'confirmed', sourceTitle: '2025年年度报告', url: 'https://example.com/report', publishedAt: '2026-04-01', period: '2025年度', reviewedAt: '2026-05-01', validUntil: '2027-05-01', quote: '相关产品已经量产，报告披露销售收入及客户情况。', notes: '', ...changes });
const rank = (kind, changes = {}) => record(kind, 'ranked', { rank: 1, market: '汽车音响', geography: '中国', metric: 'marketShare', coverage: 'allCompetitors', revenueSharePct: 40, statisticYear: 2025, ...changes });
const outlook = (changes = {}) => [record('demand', 'supported', changes), record('commercialization', 'revenue', changes), record('advantage', 'verified', changes), record('outlookRisk', 'clear', changes)];
const query = (conditions = ['productOutlook'], changes = {}) => ({ conditions, leadership: '', minSegmentRevenuePct: 30, ...changes });
const result = (records, conditions, changes) => evaluateEvidence(records, query(conditions, changes), NOW);

test('证据查询保持可选，拒绝无效字段、原型键和非数值门槛', () => {
  assert.equal(validateEvidenceQuery(undefined), undefined);
  assert.equal(validateEvidenceQuery({ conditions: [], leadership: '' }), undefined);
  assert.deepEqual(validateEvidenceQuery({ conditions: ['demand', 'demand'] }), query(['demand']));
  for (const input of [false, [], { conditions: 'demand' }, { conditions: ['__proto__'] }, { conditions: ['toString'] }, { leadership: 'leader' }, { minSegmentRevenuePct: '30' }, { minSegmentRevenuePct: -1 }, { minSegmentRevenuePct: 101 }, { unrelated: true }]) assert.throws(() => validateEvidenceQuery(input));
  assert.match(describeEvidenceQuery(query(['productOutlook'], { leadership: 'either' })).join('；'), /前三或.*营收占比.*30/);
});

test('产品前景必须有同一产品的需求、商业化、优势和反向证据核验', () => {
  const good = result(outlook());
  assert.equal(good.status, 'pass');
  assert.equal(good.checks.length, 1);
  assert.equal(good.records.length, 4);
  assert.equal(result(outlook().slice(0, 3)).status, 'pending');
  assert.equal(result(outlook().map(item => item.kind === 'commercialization' ? { ...item, value: 'plan' } : item)).status, 'fail');
  assert.equal(result(outlook().map(item => item.kind === 'outlookRisk' ? { ...item, value: 'adverse' } : item)).status, 'fail');
  const differentProducts = outlook().map((item, index) => ({ ...item, subject: `产品${index}` }));
  assert.equal(result(differentProducts).status, 'pending');
});

test('勾选多个独立产品条件不能拼接不同产品，完整任一产品可以通过', () => {
  const records = [record('demand', 'supported', { subject: '产品A' }), record('commercialization', 'production', { subject: '产品B' })];
  const checked = result(records, ['demand', 'commercialization']);
  assert.equal(checked.status, 'pending');
  assert.equal(checked.checks.find(item => item.key === 'sameProduct').status, 'pending');
  records.push(record('commercialization', 'production', { subject: '产品A' }));
  assert.equal(result(records, ['demand', 'commercialization']).status, 'pass');
});

test('草稿、争议、资料不足、日期及来源缺项不被当作通过或确定否定', () => {
  for (const changes of [{ reviewState: 'draft' }, { reviewState: 'disputed' }, { value: 'unknown' }, { quote: '' }, { sourceTitle: '' }, { url: '' }, { period: '' }, { publishedAt: '' }, { reviewedAt: '' }, { validUntil: '' }, { validUntil: '2026-10-07' }, { publishedAt: '2026-10-09', reviewedAt: '2026-10-09' }, { reviewedAt: '2026-10-09' }, { reviewedAt: '2026-03-01' }, { validUntil: '2026-04-01' }]) {
    const checked = result([record('demand', 'supported', changes)], ['demand']);
    assert.equal(checked.status, 'pending', JSON.stringify(changes));
  }
  assert.equal(result([record('demand', 'supported', { validUntil: '2026-10-08' })], ['demand']).status, 'pass');
});

test('有效相反结论进入待核验；过期历史记录保留但不覆盖当前有效结论', () => {
  const positive = record();
  const negative = record('demand', 'unsupported');
  assert.equal(result([positive, negative], ['demand']).status, 'pending');
  const checked = result([positive, { ...negative, validUntil: '2026-06-01' }], ['demand']);
  assert.equal(checked.status, 'pass');
  assert.equal(checked.records.length, 2);
  assert.equal(checked.checks[0].records.length, 2);
  assert.equal(result([positive, { ...negative, reviewState: 'disputed' }], ['demand']).status, 'pending');
  assert.equal(result([record('advantage', 'unverified')], ['advantage']).status, 'pending');
});

test('财务复核独立于产品，存在有效不利证据不能通过', () => {
  assert.equal(result([...outlook(), record('financialReview', 'clear', { subject: '公司财务' })], ['productOutlook', 'financialReview']).status, 'pass');
  assert.equal(result([...outlook(), record('financialReview', 'adverse', { subject: '公司财务' })], ['productOutlook', 'financialReview']).status, 'fail');
  assert.equal(result([...outlook(), record('financialReview', 'clear', { subject: '公司财务' }), record('financialReview', 'adverse', { subject: '审计事项' })], ['financialReview']).status, 'pending');
});

test('最新已复核未知结论覆盖旧支持；旧未知结论不会覆盖更新的已核验支持', () => {
  for (const [kind, supported, unknown] of [['financialReview', 'clear', 'unknown'], ['advantage', 'verified', 'unknown'], ['advantage', 'verified', 'unverified']]) {
    const old = { publishedAt: '2026-04-01', reviewedAt: '2026-05-01' };
    const recent = { publishedAt: '2026-10-01', reviewedAt: '2026-10-08' };
    const pending = result([record(kind, supported, old), record(kind, unknown, recent)], [kind]);
    assert.equal(pending.status, 'pending', `${kind}/${unknown}`);
    assert.match(pending.checks[0].reason, /最新已复核资料/);
    assert.equal(pending.records.length, 2);
    assert.equal(pending.checks[0].records.length, 2);
    assert.equal(result([record(kind, unknown, old), record(kind, supported, recent)], [kind]).status, 'pass');
    assert.equal(result([record(kind, supported, recent), record(kind, unknown, recent)], [kind]).status, 'pending');
    // A renewed review of an old publication is a current unresolved assessment.
    assert.equal(result([record(kind, supported, old), record(kind, unknown, { ...old, reviewedAt: '2026-10-08' })], [kind]).status, 'pending');
    for (const changes of [{ reviewState: 'draft' }, { validUntil: '2026-10-07', reviewedAt: '2026-10-06' }, { publishedAt: '2026-10-09', reviewedAt: '2026-10-09' }, { reviewedAt: '2026-10-09' }]) {
      assert.equal(result([record(kind, supported, old), record(kind, unknown, { ...recent, ...changes })], [kind]).status, 'pass', JSON.stringify(changes));
    }
  }
});

test('行业地位三值 OR：任一路径通过；两路径明确不符合才否定', () => {
  const q = { leadership: 'either' };
  assert.equal(result([rank('mainRank', { rank: 3 })], [], q).status, 'pass');
  assert.equal(result([rank('segmentRank')], [], q).status, 'pass');
  assert.equal(result([rank('mainRank', { rank: 4 }), rank('segmentRank', { rank: 2, market: '车载高音音响' })], [], q).status, 'fail');
  assert.equal(result([rank('mainRank', { rank: 4 })], [], q).status, 'pending');
  assert.equal(result([], [], q).status, 'pending');
  assert.equal(result([rank('segmentRank', { revenueSharePct: 29.99 })], [], { leadership: 'segmentLeader' }).status, 'fail');
  assert.equal(result([rank('segmentRank', { revenueSharePct: 30 })], [], { leadership: 'segmentLeader' }).status, 'pass');
});

test('排名必须包含全市场竞争者、市场地域年度口径，不能用上市排名代替', () => {
  for (const changes of [{ coverage: 'listedOnly' }, { market: '' }, { geography: '' }, { metric: '' }, { statisticYear: null }, { rank: null }, { statisticYear: 2027 }]) assert.equal(result([rank('mainRank', changes)], [], { leadership: 'mainTop3' }).status, 'pending', JSON.stringify(changes));
  assert.equal(result([rank('segmentRank', { revenueSharePct: null })], [], { leadership: 'segmentLeader' }).status, 'pending');
  assert.equal(result([rank('mainRank', { rank: 2 }), rank('mainRank', { rank: 4 })], [], { leadership: 'mainTop3' }).status, 'pending');
});

test('同市场采用最新统计年，不以更早的领先排名掩盖新年度落后', () => {
  const checked = result([rank('mainRank', { rank: 1, statisticYear: 2023 }), rank('mainRank', { rank: 8, statisticYear: 2025 })], [], { leadership: 'mainTop3' });
  assert.equal(checked.status, 'fail');
  assert.match(checked.checks[0].reason, /2025.*旧年度/);
  assert.equal(checked.records.length, 2);
  assert.equal(checked.checks[0].records.length, 2);
  assert.equal(result([rank('mainRank', { statisticYear: 2023 }), rank('mainRank', { statisticYear: 2025, reviewState: 'disputed' })], [], { leadership: 'mainTop3' }).status, 'pending');
  assert.equal(result([rank('mainRank', { statisticYear: 2023, geography: '全国' }), rank('mainRank', { statisticYear: 2025, rank: 8, geography: 'China' })], [], { leadership: 'mainTop3' }).status, 'fail');
});

test('行业地位仅认可明确全国或全球范围，区域领先和模糊国际排名待核验', () => {
  for (const geography of ['中国', '全国', '中国大陆', '中国市场', '中国大陆市场', '国内', '全球', '全球市场', 'China', 'GLOBAL']) assert.equal(result([rank('mainRank', { geography })], [], { leadership: 'mainTop3' }).status, 'pass', geography);
  for (const geography of ['华东', '江苏省', '国际', '国际市场', '海外', '美国', '某地区']) {
    const checked = result([rank('segmentRank', { geography })], [], { leadership: 'segmentLeader' });
    assert.equal(checked.status, 'pending', geography);
    assert.match(checked.checks[0].reason, /全国或全球/);
  }
});

test('评估使用上海日期，结果保留独立证据与条件快照', () => {
  const records = [record('demand', 'supported', { publishedAt: '2026-10-09', reviewedAt: '2026-10-09' })];
  const inputQuery = query(['demand']);
  assert.equal(evaluateEvidence(records, inputQuery, '2026-10-08T15:59:59Z').status, 'pending');
  const checked = evaluateEvidence(records, inputQuery, '2026-10-08T16:00:00Z');
  assert.equal(checked.status, 'pass');
  records[0].quote = '改写'; inputQuery.conditions.push('financialReview');
  assert.notEqual(checked.records[0].quote, '改写');
  assert.deepEqual(checked.query.conditions, ['demand']);
  checked.records[0].quote = '再次改写';
  assert.notEqual(checked.checks[0].records[0].quote, '再次改写');
});

test('拒绝跨股票拼接，畸形记录只能待核验，记录日期与数值严格验证', () => {
  assert.throws(() => result([record(), record('commercialization', 'revenue', { symbol: 'sh600002' })]));
  assert.equal(result([{ ...record(), publishedAt: '2026-02-30' }], ['demand']).status, 'pending');
  for (const changes of [{ symbol: '510300' }, { value: 'toString' }, { kind: '__proto__' }, { publishedAt: '2026-02-30' }, { reviewedAt: 'invalid' }]) assert.throws(() => validateRecord(record('demand', 'supported', changes)));
  for (const changes of [{ rank: 1.5 }, { revenueSharePct: 101 }, { revenueSharePct: '30' }, { statisticYear: 2025.5 }]) assert.throws(() => validateRecord(rank('segmentRank', changes)));
});

test('来源地址只支持公开 HTTP/HTTPS，阻断脚本、文件、凭据和本机私网', () => {
  assert.equal(safeEvidenceUrl('https://example.com/report?q=2025#p10'), 'https://example.com/report?q=2025#p10');
  assert.equal(safeEvidenceUrl('http://8.8.8.8/report'), 'http://8.8.8.8/report');
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'https://user:pass@example.com/', 'http://localhost/', 'http://test.localhost/', 'http://server/', 'http://machine.local/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/', 'http://100.64.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fc00::1]/', 'https://example.com/\nsecret', 'https://example.com\\@127.0.0.1']) {
    assert.equal(safeEvidenceUrl(url), '', url);
    assert.throws(() => validateRecord(record('demand', 'supported', { url })), url);
  }
});
