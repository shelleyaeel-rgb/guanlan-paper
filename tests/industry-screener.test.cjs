'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Screener, defaults } = require('../core/screener.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');
const { INDUSTRY_PROFILE_MAX_AGE_MS } = require('../core/industry-applicability.cjs');

const NOW = new Date('2026-10-15T10:00:00+08:00');
const SYMBOLS = { ordinary: 'sh600001', bank: 'sh600002', unknown: 'sh600003' };
function profile(kind, at) {
  const value = ordinaryProfile(SYMBOLS[kind], at);
  if (kind === 'bank') value.data = { industry: '金融-银行-股份制与城商行', regulatoryIndustry: '金融业-货币金融服务', orgType: '银行', orgTypeCode: '3' };
  if (kind === 'unknown') value.data = { industry: '待核对新分类', regulatoryIndustry: '', orgType: '通用', orgTypeCode: '4' };
  return value;
}
function fixture(kinds = ['ordinary', 'bank', 'unknown'], options = {}) {
  let now = new Date(NOW);
  const calls = { finance: [], notices: [], evidence: [] };
  const service = new Screener(null, null, null, () => now, async symbol => {
    calls.finance.push(symbol);
    const kind = kinds.find(kind => SYMBOLS[kind] === symbol);
    return { symbol, section: 'finance', status: 'ready', source: '东方财富', fetchedAt: +now,
      industryProfile: profile(kind, options.profileAt ?? now),
      data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', currency: 'CNY', roe: 12, debtRatio: kind === 'bank' ? 90 : 40 } } };
  }, async symbol => {
    calls.notices.push(symbol);
    if (options.noticeDelay) now = new Date(+now + options.noticeDelay);
    return { symbol, section: 'notices', status: 'empty', source: '东方财富', fetchedAt: +now, data: { items: [], total: 0 } };
  }, null, null, async symbols => {
    calls.evidence.push(...symbols);
    return symbols.map(symbol => ({ symbol, kind: 'financialReview', value: 'clear', subject: '财务事项', reviewState: 'confirmed',
      sourceTitle: '隔离审查资料', url: 'https://example.com/report', publishedAt: '2026-08-15', period: '2026半年度',
      reviewedAt: '2026-10-15', validUntil: '2026-12-31', quote: '隔离样本审查记录。', notes: '' }));
  });
  const snapshot = { source: '隔离行情', fetchedAt: +NOW, rows: kinds.map(kind => ({ symbol: SYMBOLS[kind], name: '隔离行业样本',
    board: 'sh', isST: false, price: 10, timestamp: +NOW })) };
  service.load = async () => snapshot;
  return { service, calls, snapshot };
}
const numericQuery = () => ({ ...defaults(), rules: [{ field: 'roe', op: 'gte', value: 10 }] });

test('实际普通长线筛选先区分普通企业、银行不适用与未知行业，保留原值且不发明数值失败', async () => {
  const f = fixture(), original = structuredClone(f.snapshot);
  const result = await f.service.run(numericQuery(), [], false, null, 'long');
  assert.deepEqual(result.rows.map(row => row.symbol), [SYMBOLS.ordinary]);
  assert.equal(result.rows[0].roe, 12);
  assert.deepEqual(f.calls.notices, [SYMBOLS.ordinary]);
  const bank = result.financeTemplateRows.find(row => row.symbol === SYMBOLS.bank);
  const unknown = result.financeTemplateRows.find(row => row.symbol === SYMBOLS.unknown);
  assert.equal(bank.financeApplicability.status, 'inapplicable');
  assert.equal(bank.financeApplicability.reasonCode, 'template-inapplicable');
  assert.equal(bank.debtRatio, 90); assert.equal(bank.financeFieldChecks.debtRatio.status, 'ready');
  assert.equal(unknown.financeApplicability.status, 'pending');
  assert.equal(unknown.financeApplicability.reasonCode, 'industry-unrecognized');
  assert.equal(unknown.roe, 12); assert.equal(result.partial, true);
  assert.deepEqual(f.snapshot, original);
});

test('行业未知只有待核验，不适用单独列示，均不能返回普通长线通过', async () => {
  for (const kind of ['bank', 'unknown']) {
    const f = fixture([kind]), result = await f.service.run(numericQuery(), [], false, null, 'long');
    assert.equal(result.rows.length, 0); assert.equal(result.financeTemplateRows.length, 1);
    assert.equal(result.matched, kind === 'unknown' ? null : 0);
    assert.equal(result.status, kind === 'unknown' ? 'unavailable' : 'empty');
    assert.equal(f.calls.notices.length, 0);
  }
});

test('未选普通财务模板的自定义数字条件仍可比较银行或未知行业原值', async () => {
  const f = fixture(['bank', 'unknown']);
  const query = { ...defaults(), rules: [{ field: 'debtRatio', op: 'gte', value: 80 }] };
  const result = await f.service.run(query, []);
  assert.deepEqual(result.rows.map(row => row.symbol), [SYMBOLS.bank]);
  assert.equal(result.rows[0].debtRatio, 90); assert.equal(result.financeTemplateRows, undefined);
  const unknown = await f.service.run(numericQuery(), []);
  assert.deepEqual(unknown.rows.map(row => row.symbol), [SYMBOLS.bank, SYMBOLS.unknown]);
  assert.equal(unknown.rows[1].financeApplicability.status, 'pending');
  const noFinance = fixture(['bank']);
  const quoteOnly = await noFinance.service.run(defaults(), [], false, null, 'long');
  assert.equal(quoteOnly.rows.length, 1); assert.equal(quoteOnly.financeTemplateRows, undefined);
  assert.equal(noFinance.calls.finance.length, 0);
});

test('财务事项复核明确使用普通模板，即使没有数字规则仍须核验行业', async () => {
  const f = fixture();
  const query = { ...defaults(), evidence: { conditions: ['financialReview'] } };
  const result = await f.service.run(query, []);
  assert.deepEqual(result.rows.map(row => row.symbol), [SYMBOLS.ordinary]);
  assert.deepEqual(f.calls.evidence, [SYMBOLS.ordinary]);
  assert.equal(result.financeTemplateRows.length, 2);
});

test('发布前跨越行业资料24小时边界不沿用开始时的模板通过，财务原值仍有效', async () => {
  const f = fixture(['ordinary'], { profileAt: +NOW - INDUSTRY_PROFILE_MAX_AGE_MS + 1000, noticeDelay: 2000 });
  const result = await f.service.run(numericQuery(), [], false, null, 'long');
  assert.equal(f.calls.notices.length, 1); assert.equal(result.rows.length, 0);
  assert.equal(result.status, 'unavailable'); assert.equal(result.matched, null);
  const excluded = result.financeTemplateRows[0];
  assert.equal(excluded.financeApplicability.reasonCode, 'industry-stale');
  assert.equal(excluded.financeApplicability.fetchedAt, +NOW - INDUSTRY_PROFILE_MAX_AGE_MS + 1000);
  assert.equal(excluded.roe, 12); assert.equal(excluded.financeFieldChecks.roe.status, 'ready');
  assert.equal(result.financePendingRows, undefined);
});
