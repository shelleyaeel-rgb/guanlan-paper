'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { classifyFinanceApplicability, INDUSTRY_PROFILE_MAX_AGE_MS } = require('../core/industry-applicability.cjs');
const { buildFinanceSnapshot, refreshFinanceSnapshot } = require('../core/finance-validity.cjs');
const { longFinanceCheck } = require('../core/strategy.cjs');
const { Research, parseProfile } = require('../core/research.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');
const samples = require('./fixtures/research-data.cjs');
const symbol = 'sh600001', NOW = new Date('2026-10-15T10:00:00+08:00');
const profile = data => ({ ...ordinaryProfile(symbol, NOW), data });
const financialProfiles = [
  ['bank', { industry: '金融-银行-股份制与城商行', regulatoryIndustry: '金融业-货币金融服务', orgType: '银行', orgTypeCode: '3' }],
  ['insurance', { industry: '金融-非银行金融-保险', regulatoryIndustry: '金融业-保险业', orgType: '保险', orgTypeCode: '2' }],
  ['securities', { industry: '金融-非银行金融-证券', regulatoryIndustry: '金融业-资本市场服务', orgType: '证券', orgTypeCode: '1' }],
  ['other-financial', { industry: '金融-多元金融', regulatoryIndustry: '金融业-其他金融业', orgType: '通用', orgTypeCode: '4' }]
];
function finance(industryProfile = ordinaryProfile(symbol, NOW)) {
  return { symbol, section: 'finance', source: '东方财富', status: 'ready', fetchedAt: +NOW, industryProfile,
    data: { latest: { reportDate: '2026-06-30', noticeDate: '2026-08-15', currency: 'CNY', roe: 4, debtRatio: 40,
      revenueYoY: 10, adjustedProfitYoY: 10, adjustedProfit: 1e8, operatingCash: 2e8 },
    annual: [{ reportDate: '2025-12-31', noticeDate: '2026-03-20', currency: 'CNY', roe: 12 }] } };
}

test('普通行业明确适用，银行保险证券及其他金融分别识别为模板不适用', () => {
  assert.equal(classifyFinanceApplicability(ordinaryProfile(symbol, NOW), symbol, NOW).status, 'applicable');
  for (const [sector, data] of financialProfiles) {
    const result = classifyFinanceApplicability(profile(data), symbol, NOW);
    assert.equal(result.status, 'inapplicable'); assert.equal(result.sector, sector);
    assert.equal(result.reasonCode, 'template-inapplicable'); assert.match(result.reason, /不表示公司财务不合格/);
  }
});

test('未知分类、通用报表类型和公司名不能伪造非金融；显式冲突保持待核验', () => {
  for (const data of [{}, { orgType: '通用', orgTypeCode: '4' }, { industry: '新行业', company: '食品制造有限公司', business: '食品制造' },
    { orgType: 'constructor' }, { orgTypeCode: 'toString' }, { orgType: '__proto__', orgTypeCode: 'valueOf' }]) {
    assert.equal(classifyFinanceApplicability(profile(data), symbol, NOW).status, 'pending');
  }
  for (const data of [
    { industry: '金融-银行', regulatoryIndustry: '制造业-食品制造业' },
    { industry: '金融-保险', orgType: '证券', orgTypeCode: '1' },
    { industry: '金融-银行', orgType: '银行', orgTypeCode: '2' }
  ]) assert.equal(classifyFinanceApplicability(profile(data), symbol, NOW).reasonCode, 'industry-conflict');
  assert.equal(classifyFinanceApplicability(profile({ industry: '计算机-金融软件', regulatoryIndustry: '信息传输、软件和信息技术服务业-软件和信息技术服务业' }), symbol, NOW).status, 'applicable');
});

test('行业来源身份失败、未获取与过期分开，24小时边界不被checkedAt续期', () => {
  assert.equal(classifyFinanceApplicability(null, symbol, NOW).reasonCode, 'industry-not-loaded');
  for (const change of [{ symbol: 'sh600002' }, { section: 'finance' }, { source: '未知' }, { fetchedAt: +NOW + 1 }])
    assert.equal(classifyFinanceApplicability({ ...ordinaryProfile(symbol, NOW), ...change }, symbol, NOW).reasonCode, 'industry-invalid');
  assert.equal(classifyFinanceApplicability({ ...ordinaryProfile(symbol, NOW), status: 'stale' }, symbol, NOW).reasonCode, 'industry-fetch-failed');
  const old = ordinaryProfile(symbol, +NOW - INDUSTRY_PROFILE_MAX_AGE_MS);
  assert.equal(classifyFinanceApplicability(old, symbol, NOW).status, 'applicable');
  assert.equal(classifyFinanceApplicability({ ...old, checkedAt: +NOW }, symbol, +NOW + 1).reasonCode, 'industry-stale');
});

test('财务原值不因行业不可用而清空；长线先判断适用性，不给金融公司套60%负债率', () => {
  for (const [, data] of financialProfiles) {
    const raw = finance(profile(data)); raw.data.latest.debtRatio = 90; raw.data.latest.operatingCash = -1e8;
    const normalized = buildFinanceSnapshot(raw, symbol, NOW), result = longFinanceCheck({ finance: raw }, symbol, NOW);
    assert.equal(normalized.debtRatio, 90); assert.equal(normalized.operatingCash, -1);
    assert.equal(normalized.financeApplicability.status, 'inapplicable');
    assert.equal(result.status, 'failed'); assert.equal(result.reasonCode, 'template-inapplicable'); assert.deepEqual(result.checks, []);
    assert.equal(result.observations.find(item => item.field === 'debtRatio').value, 90);
    assert.equal(result.evidence, undefined); assert.doesNotMatch(result.reasons.join(''), /要求.*60|现金流.*要求/);
  }
  const missing = finance(null), pending = longFinanceCheck({ finance: missing }, symbol, NOW);
  assert.equal(pending.status, 'pending'); assert.equal(pending.reasonCode, 'industry-not-loaded');
  assert.equal(longFinanceCheck({ finance: finance() }, symbol, NOW).status, 'pass');
});

test('归一化与发布复核保留原始行业来源，行业过期不得延长且不误删财务指标', () => {
  const raw = finance(ordinaryProfile(symbol, +NOW - INDUSTRY_PROFILE_MAX_AGE_MS + 1000));
  const normalized = buildFinanceSnapshot(raw, symbol, NOW), later = refreshFinanceSnapshot(normalized, symbol, +NOW + 1001);
  assert.equal(normalized.financeApplicability.status, 'applicable'); assert.equal(later.financeApplicability.reasonCode, 'industry-stale');
  assert.equal(later.debtRatio, 40); assert.equal(later.financeSourceSnapshot.industryProfile.fetchedAt, raw.industryProfile.fetchedAt);
});

test('公司profile保留机构类别元数据，财务与行业并发获取独立缓存且失败不抹掉财务', async () => {
  const parsed = parseProfile(samples.profile(symbol), symbol);
  assert.equal(parsed.orgType, '通用'); assert.equal(parsed.orgTypeCode, '4');
  let now = +NOW, failProfile = false; const calls = [];
  const service = new Research(async url => {
    const kind = url.includes('BASICINFO') ? 'profile' : 'finance'; calls.push(kind);
    if (kind === 'profile' && failProfile) throw Error('profile offline');
    return { ok: true, json: async () => samples[kind](symbol) };
  }, { clock: () => now });
  const first = await service.getFinanceWithIndustry({ symbol });
  assert.equal(first.status, 'ready'); assert.equal(first.industryProfile.status, 'ready'); assert.deepEqual(calls.sort(), ['finance', 'profile']);
  const cached = await service.getFinanceWithIndustry({ symbol }); assert.equal(calls.length, 2); assert.equal(cached.industryProfile.cached, true);
  failProfile = true; now += 1000;
  const failed = await service.getFinanceWithIndustry({ symbol, force: true });
  assert.equal(failed.status, 'ready'); assert.equal(failed.industryProfile.status, 'stale');
  assert.equal(failed.industryProfile.fetchedAt, +NOW); assert.equal(failed.fetchedAt, now);
  assert.equal(classifyFinanceApplicability(failed.industryProfile, symbol, now).reasonCode, 'industry-fetch-failed');
});
