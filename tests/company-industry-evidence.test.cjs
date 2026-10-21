'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { companyBundle: rawCompanyBundle } = require('./fixtures/company-evidence-data.cjs');
const { collectIndependentRankings, trustedIndustryUrl, issuerNames } = require('../core/company-industry-evidence.cjs');
const { CompanyIndustrySource, publisherBodyMatches, discoveryTerms } = require('../core/company-industry-source.cjs');
const { PARSER_VERSION } = require('../core/company-document-parser.cjs');
const now = new Date('2026-10-14T00:30:00+08:00'), hash = text => createHash('sha256').update(text).digest('hex');
function companyBundle(symbol, at) {
  const bundle = rawCompanyBundle(symbol, at);
  for (const document of bundle.documents) {
    document.title = `隔离声学:${document.title}`;
    document.text = document.text.replace('公司名称：', '第二节 公司简介和主要财务指标\n一、公司信息\n公司名称：'); document.fullText = document.text;
    document.pageTexts = [{ page: 1, method: 'provider-text', complete: true, numericEligible: true, text: document.text, textHash: hash(document.text) }];
  }
  return bundle;
}
const claim = '2025年隔离声学股份有限公司在全国汽车扬声器市场份额排名第2，统计覆盖全部竞争者。';
function original(text = claim, changes = {}) {
  return { id: 'frost-test', issuerSymbol: 'sh600001', kind: 'industry-report', title: '2025汽车扬声器统计', url: 'https://www.frostchina.com/content/insight/detail/abcdef',
    complete: true, publishedAt: '2026-10-14', fetchedAt: +now, text, textHash: hash(text), rawSource: text, sourceHash: hash(text), pages: 1,
    pageTexts: [{ page: 1, method: 'provider-text', complete: true, numericEligible: true, text }], ...changes };
}
function collect(document = original(), extras = []) { const bundle = companyBundle('sh600001', now); bundle.industryDocuments = [document, ...extras]; return collectIndependentRankings(bundle, { now, symbol: bundle.symbol, minimumYear: 2024 }); }
test('第三方同主体完整原文包含时间、市场、指标、分母，保留来源和位置（北京时间）', () => {
  const [r] = collect(); assert.equal(r.rank, 2); assert.equal(r.market, '汽车扬声器'); assert.equal(r.coverage, 'allCompetitors'); assert.equal(r.sourceRelation, 'independent-third-party'); assert.equal(r.locations[0].page, 1); assert.equal(r.ruleVersion, '5');
});
test('摘要、错主体、未来、陈旧、无逐页、OCR、哈希不符或非官方原文不能进入行业证据', () => {
  for (const change of [{ complete: false }, { issuerSymbol: 'sh600002' }, { publishedAt: '2026-10-15' }, { fetchedAt: +now - 21600001 }, { pageTexts: [] },
    { textHash: 'a'.repeat(64) }, { sourceHash: 'a'.repeat(64) }, { url: 'https://www.frostchina.com.evil.test/x' },
    { pageTexts: [{ page: 1, method: 'ocr', complete: true, numericEligible: true, text: claim }] }]) assert.deepEqual(collect(original(claim, change)), []);
  assert.deepEqual(collect(original(claim.replace('隔离声学', '其他声学'))), []);
  assert.equal(trustedIndustryUrl('https://user@www.frostchina.com/x'), null);
});
test('不确定排名与限制分母不能被同句全部竞争者或分行掩盖', () => {
  for (const tail of ['但该排名不准确', '该排名无法核实', '该表述有误', '该排名不是事实']) assert.deepEqual(collect(original(claim.replace('。', `，${tail}。`))), []);
  const [r] = collect(original(claim + '\n统计范围仅包括上市公司。')); assert.equal(r.coverage, 'unverified');
  assert.equal(collect(original(claim.replace('，统计覆盖全部竞争者', '')))[0].coverage, 'unverified');
});
test('后发官方撤回同公司同市场排名阻断旧正面证据，不借其他公司撤回', () => {
  const later = original('隔离声学股份有限公司汽车扬声器排名不准确，现撤回。', { id: 'later' });
  assert.equal(collect(original(), [later])[0].automaticConflict, true);
  assert.equal(collect(original(), [original(later.text.replace('隔离声学', '其他声学'))])[0].automaticConflict, undefined);
});
const row = (content = `<p>${claim}</p>`, more = {}) => ({ _id: '69eb362eeb778a7e2b5004d7', title: '汽车扬声器行业统计', category: 'insight', type: 'article', status: 1, isDeleted: false,
  publishDate: '2026-10-13T00:00:00.000Z', content, ...more });
const response = rows => new Response(JSON.stringify({ errCode: 0, data: { data: rows, count: rows.length } }), { headers: { 'content-type': 'application/json' } });
test('自动行业源取官方发布正文并按公司缓存，目录摘要不作为原文', async () => {
  let calls = 0; const source = new CompanyIndustrySource(async url => { calls++; assert.match(url, /^https:\/\/www.frostchina.com\//); return url.includes('/api/') ? response([row()]) : new Response(`<div class="content">${row().content}</div>`); }, { clock: () => +now });
  const bundle = companyBundle('sh600001', now), enriched = await source.enrich(bundle); assert.equal(enriched.industryDocuments.length, 1);
  assert.equal(collectIndependentRankings(enriched, { now, minimumYear: 2024 }).length, 1);
  assert.equal(bundle.industryDocuments, undefined); await source.enrich(bundle); assert.equal(calls, 2); await source.destroy();
});
test('付费/介绍/图表页面明确未取全文，搜索摘要和下载页不会误通过', async () => {
  for (const item of [row(`<p>${claim}</p>`, { pageCount: 29, price: 9800 }), row(`<p>${claim}</p><img src="chart.png">`), row(`<p>报告摘要：${claim}</p>`)]) {
    const source = new CompanyIndustrySource(async () => response([item]), { clock: () => +now });
    const result = await source.enrich(companyBundle('sh600001', now)); assert.equal(result.industryDocuments.length, 0); assert.match(result.industryCoverage.issues.join(), /尚未取得/); await source.destroy();
  }
});
test('官方列出的PDF附件完整解析后才可用，原件哈希可追溯并限制下载来源', async () => {
  let parses = 0; const bytes = Buffer.from('%PDF-test'); const parser = { parse: async () => { parses++; return { parserVersion: PARSER_VERSION, format: 'pdf', complete: true, text: claim, pages: 1, pageTexts: original().pageTexts }; } };
  const source = new CompanyIndustrySource(async url => url.includes('/api/') ? response([row('', { attachment: 'attachment/test.pdf' })]) : new Response(bytes), { clock: () => +now, parser });
  const result = await source.enrich(companyBundle('sh600001', now)); assert.equal(parses, 1); const document = result.industryDocuments[0];
  assert.equal(document.sourceHash, hash(bytes)); assert.deepEqual(source.readArchivedArtifact(document).bytes, bytes); await source.destroy();
  const bad = new CompanyIndustrySource(async () => response([row('', { attachment: 'https://untrusted.test/report.pdf' })]), { clock: () => +now, parser });
  assert.equal((await bad.enrich(companyBundle('sh600001', now))).industryDocuments.length, 0); assert.equal(parses, 1); await bad.destroy();
});
test('网络失败两次封顶、错误缓存短暂且限流冷却不连发，取消不保存部分数据', async () => {
  let calls = 0; const source = new CompanyIndustrySource(async () => { calls++; throw Error('fetch failed'); }, { clock: () => +now });
  const bundle = companyBundle('sh600001', now), result = await source.enrich(bundle); assert.equal(result.industryCoverage.status, 'error'); assert.equal(calls, 2);
  await source.enrich(bundle); assert.equal(calls, 2); await source.destroy();
  let rateCalls = 0; const limited = new CompanyIndustrySource(async () => { rateCalls++; return new Response('', { status: 429 }); }, { clock: () => +now });
  await limited.enrich(bundle); await limited.enrich(companyBundle('sz000001', now)); assert.equal(rateCalls, 1); await limited.destroy();
  const controller = new AbortController(); const cancelled = new CompanyIndustrySource(async () => { controller.abort(); return response([row()]); }, { clock: () => +now });
  await assert.rejects(cancelled.enrich(bundle, { signal: controller.signal }), /取消/); assert.equal(cancelled.cache.size, 0); await cancelled.destroy();
});
test('官方详情与目录不一致不使用正文，缓存失败不丢本次完整原文', async () => {
  assert.equal(publisherBodyMatches('<div class="content"><p>前缀</p><p>未获取的实际风险</p></div>', '<p>前缀</p>'), false);
  assert.equal(publisherBodyMatches('<div class="content"><div>原文</div><p>全部内容</p></div>', '<div>原文</div><p>全部内容</p>'), true);
  const source = new CompanyIndustrySource(async url => url.includes('/api/') ? response([row()]) : new Response('<div class="content">其他正文</div>'), { clock: () => +now });
  const bundle = companyBundle('sh600001', now), result = await source.enrich(bundle);
  assert.equal(result.industryDocuments.length, 0); assert.match(result.industryCoverage.issues.join(), /未能对应/); await source.destroy();
  const healthy = new CompanyIndustrySource(async url => url.includes('/api/') ? response([row()]) : new Response(`<div class="content">${row().content}</div>`), { clock: () => +now });
  healthy.cache.set(bundle.symbol, { version: 1, symbol: bundle.symbol, fetchedAt: +now });
  healthy.save = () => { throw Error('ENOSPC'); };
  const recovered = await healthy.enrich(bundle); assert.equal(recovered.industryDocuments.length, 1); assert.match(recovered.industryCoverage.issues.join(), /缓存保存失败/); await healthy.destroy();
});
test('手动失败资料重试会重新发现行业原文，不固守部分覆盖缓存', async () => {
  let calls = 0; const source = new CompanyIndustrySource(async () => { calls++; return response([]); }, { clock: () => +now });
  const bundle = companyBundle('sh600001', now);
  await source.enrich(bundle); await source.enrich(bundle); assert.equal(calls, 1);
  await source.enrich(bundle, { retryFailed: true }); assert.equal(calls, 2); await source.destroy();
});

function identityBundle({ title = '隔离声学:2026年半年度报告', text = '第二节 公司简介和主要财务指标\n一、公司信息\n公司的中文名称 隔离声学股份有限公司\n公司的中文简称 隔离声学\n二、联系人和联系方式', method = 'pdf-text', complete = true, numericEligible = true, page = 1 } = {}) {
  return { symbol: 'sh600001', documents: [{ issuerSymbol: 'sh600001', kind: 'semiannual-report', complete: true, title,
    reportDate: '2026-06-30', text, pageTexts: [{ page, text, textHash: hash(text), method, complete, numericEligible }] }] };
}
test('行业主体名称只从可信公告标题和原生公司基本信息取得，搜索优先标题简称', () => {
  const bundle = identityBundle();
  assert.deepEqual(issuerNames(bundle), ['隔离声学股份有限公司', '隔离声学']);
  assert.deepEqual(discoveryTerms(bundle), ['隔离声学']);
  const multiline = identityBundle({ text: '第二节 公司简介\n一、公司信息\n公司全称：\n隔离声学股份有限公司\n二、联系人' });
  assert.deepEqual(issuerNames(multiline), ['隔离声学股份有限公司', '隔离声学']);
  const noTitle = identityBundle({ title: '2026年半年度报告' });
  assert.deepEqual(issuerNames(noTitle), ['隔离声学股份有限公司']);
  assert.deepEqual(discoveryTerms(noTitle), ['隔离声学股份有限公司']);
});
test('主体提取使用有限字段语法，不把子公司表头、任意列名、普通简称字段变为发行人别名', () => {
  const tableWords = ['经营地', '公司', '主要经营', '主要经', '少数股东', '注册', '尚未列入任何黑名单的新表头'];
  for (const word of tableWords) {
    const bundle = identityBundle({ text: `第二节 公司简介和主要财务指标\n一、公司信息\n公司的中文名称 隔离声学股份有限公司\n公司简称 ${word}\n子公司名称 ${word}\n公司名称 ${word}\n二、联系人\n公司名称 其他企业股份有限公司` });
    assert.deepEqual(issuerNames(bundle), ['隔离声学股份有限公司', '隔离声学']);
    assert.deepEqual(discoveryTerms(bundle), ['隔离声学']);
  }
  const outside = identityBundle({ text: '第八节 财务报告\n一、公司信息\n公司名称 其他企业股份有限公司\n子公司名称 经营地' });
  assert.deepEqual(issuerNames(outside), ['隔离声学']);
});
test('扫描OCR、损坏哈希和缺失页级来源均不提供新的主体名称', () => {
  for (const change of [{ method: 'ocr' }, { complete: false }, { numericEligible: false }]) {
    const bundle = identityBundle(change); assert.deepEqual(issuerNames(bundle), ['隔离声学']);
  }
  const corrupted = identityBundle(); corrupted.documents[0].pageTexts[0].textHash = '0'.repeat(64);
  assert.deepEqual(issuerNames(corrupted), ['隔离声学']);
  const legacy = identityBundle(); delete legacy.documents[0].pageTexts;
  assert.deepEqual(issuerNames(legacy), ['隔离声学']);
});
test('封面简称必须由本股票代码同一行绑定，不采用别家代码或泛称', () => {
  const title = '2026年半年度报告';
  assert.deepEqual(issuerNames(identityBundle({ title, text: '公司代码：600001 公司简称：隔离声学' })), ['隔离声学']);
  for (const text of ['公司代码：600002 公司简称：隔离声学', '公司简称：隔离声学', '子公司代码：600001 公司简称：隔离声学', '公司代码：600001 公司简称：公司']) {
    assert.deepEqual(issuerNames(identityBundle({ title, text })), []);
  }
});
test('绑定证券代码也不能把公司等必然泛称或广告句标题作为独立主体', () => {
  for (const prefix of ['公司', '本公司', '上市公司', '发行人', '本集团', '上市捷报 | 沙利文祝贺某企业']) {
    const bundle = identityBundle({ title: `${prefix}:2026年半年度报告`, text: '全文正文不提供基本信息字段' });
    assert.deepEqual(issuerNames(bundle), []); assert.deepEqual(discoveryTerms(bundle), []);
  }
});
test('本轮真实表头形状的合成回归：泛称排名不再错误归属，明确发行人全称和简称仍匹配', () => {
  const bundle = identityBundle({ text: '第二节 公司简介和主要财务指标\n一、公司信息\n公司的中文名称 隔离声学股份有限公司\n二、联系人\n第八节 财务报告\n公司名称 公司\n类型 主要业务 注册\n子公司名称 经营地\n公司名称 本期发生额上期发生额' });
  for (const name of ['公司', '本公司', '经营地', '本期发生额上期发生额', '其他声学股份有限公司']) {
    bundle.industryDocuments = [original(claim.replace('隔离声学股份有限公司', name))];
    assert.deepEqual(collectIndependentRankings(bundle, { now, minimumYear: 2024 }), []);
  }
  for (const name of ['隔离声学股份有限公司', '隔离声学']) {
    bundle.industryDocuments = [original(claim.replace('隔离声学股份有限公司', name))];
    assert.equal(collectIndependentRankings(bundle, { now, minimumYear: 2024 })[0]?.rank, 2);
  }
});
test('最新可信报告标题作为行业搜索词，不因表头变短或较老报告排列在先而改变', () => {
  const bundle = identityBundle(); bundle.documents.unshift({ ...bundle.documents[0], title: '隔离旧名:2025年年度报告', kind: 'annual-report', reportDate: '2025-12-31' });
  assert.deepEqual(discoveryTerms(bundle), ['隔离声学']);
});
