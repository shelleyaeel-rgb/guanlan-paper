'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reviewCorporateAction } = require('../core/company-notice-corporate-actions.cjs');
const { checkNoticeWithEvidence } = require('../core/company-notice-review.cjs');
const cases = require('./fixtures/notice-corporate-actions.json').documents;
const now = new Date('2026-10-16T06:00:00Z');
const byId = suffix => cases.find(item => item.notice.id.endsWith(suffix));
const byName = name => cases.find(item => item.name === name);
function prepare(item, transform) {
  const copy = structuredClone(item);
  copy.document.fetchedAt = +now;
  if (transform) {
    const text = transform(copy.document.text);
    assert.notEqual(text, copy.document.text, 'mutation must change source text');
    copy.document.text = text;
    copy.document.pages = 1;
    copy.document.pageTexts = [{ page: 1, text, method: 'provider-text', complete: true, numericEligible: true }];
  }
  return copy;
}
function review(item, transform) {
  const { document, notice } = prepare(item, transform);
  return reviewCorporateAction(document, notice);
}
function integrated(item) {
  const { document, notice } = prepare(item), symbol = document.issuerSymbol;
  const response = { symbol, source: '东方财富', section: 'notices', status: 'ready', fetchedAt: +now, data: { items: [notice], total: 1 } };
  return checkNoticeWithEvidence(response, symbol, { symbol, fetchedAt: +now, documents: [document] }, now).notices[0];
}
const append = text => source => source + '\n' + text;

test('十一篇真实公告逐篇回放：完成与解禁阶段可核验，未来减持期间和进行中保留待核验', () => {
  assert.equal(cases.length, 11);
  for (const item of cases) {
    const original = structuredClone(item), fact = review(item), result = integrated(item);
    const pending = ['泰鸿万立', '星球石墨'].includes(item.name);
    assert.equal(fact.eligibility.status, pending ? 'pending' : 'pass', item.name + fact.eligibility.reason);
    assert.equal(result.status, pending ? 'unverified' : 'clear', item.name + result.reason);
    assert.equal(result.fulltextStatus, 'verified');
    assert.deepEqual(item, original, 'review must not mutate evidence');
    assert.ok(fact.checks.flatMap(check => check.records).every(record => record.page >= 1 && record.quote && ['pdf-text', 'provider-text'].includes(record.method)));
    assert.ok(result.records.some(record => record.locations?.[0]?.page >= 1));
  }
});

test('海顺逐股东及来源核算，不把计划内数量、其他来源和前后持股相加', () => {
  const result = review(byName('海顺新材'));
  assert.deepEqual(result.data.transactions.map(item => [item.holder, item.quantityShares]), [['倪海龙', 90060], ['陈平', 39100], ['李俊', 271560]]);
  const li = result.data.transactions[2];
  assert.equal(li.otherSourceQuantityShares, 60500);
  assert.equal(li.allSourceQuantityShares, 332060);
  assert.equal(li.ratioScope, 'disclosed-plan');
  assert.equal(li.periodScope, 'disclosed-plan');
  assert.equal(li.totalCapitalPct, 0.0976);
  assert.equal(result.data.quantityShares, 461220);
  const bad = review(byName('海顺新材'), text => text.replaceAll('332,060', '332,061'));
  assert.equal(bad.eligibility.status, 'pending');
  assert.match(bad.eligibility.reason, /股份来源明细不一致/);
  assert.equal(bad.data.transactions[2].quantityShares, 271560);
});

test('东岳万股正确换算，吉大只取实际减持合计并包含最后一笔大宗交易日期', () => {
  const dong = review(byName('东岳硅材')), ji = review(byName('吉大正元'));
  assert.equal(dong.data.quantityShares, 11999903);
  assert.equal(dong.data.transactions[0].holder, '淄博晓希');
  assert.deepEqual(dong.data.transactions[0].period, { start: '2026-08-21', end: '2026-10-13' });
  assert.equal(ji.data.quantityShares, 2254200);
  assert.deepEqual(ji.data.transactions[0].period, { start: '2026-09-21', end: '2026-09-29' });
  assert.equal(ji.data.independentComplianceVerification, false);
});

test('星球回购专户与股东减持区分，尚未减持的零值不被拟售上限代替', () => {
  const result = review(byName('星球石墨'));
  assert.equal(result.data.sourceKind, 'issuer-treasury');
  assert.equal(result.data.stage, 'ongoing');
  assert.equal(result.data.quantityShares, 0);
  assert.equal(result.eligibility.status, 'pending');
  assert.match(result.eligibility.reason, /仍在进行|尚未实施/);
});

test('泰鸿已知十五万股保留，但表内未来期间不能虚构实际结束日', () => {
  const result = review(byName('泰鸿万立'));
  assert.equal(result.data.quantityShares, 150000);
  assert.equal(result.data.stage, 'completed');
  assert.equal(result.data.transactions[0].period.end, '2026-12-27');
  assert.equal(result.eligibility.status, 'pending');
  assert.match(result.eligibility.reason, /晚于披露日/);
});

test('海通条件成就和上市流通安排分开，多激励计划不混为冲突或盲目合计', () => {
  const a = review(byId('9761')), b = review(byId('9764')), legal = review(byId('9762'));
  assert.equal(a.data.stage, 'conditions-met');
  assert.equal(a.data.listingDate, null);
  assert.equal(a.data.releases[0].quantityShares, 411795);
  assert.equal(a.data.releases[0].holders, 3);
  assert.equal(b.data.releases[0].quantityShares, 475080);
  assert.equal(b.data.releases[0].holders, 11);
  assert.deepEqual(legal.data.releases.map(item => item.quantityShares), [411795, 475080]);
  assert.notEqual(legal.data.releases[0].plan, legal.data.releases[1].plan);
  assert.equal(legal.data.quantityShares, undefined);
  assert.equal(legal.data.immediatelyFreelySaleable, false);
  assert.ok(a.warnings.some(warning => warning.code === 'unlock-supply-observation'));
});

test('陕西及润贝保留实际本次规模与流通安排，不受历史解禁、授予、回购数量干扰', () => {
  for (const item of cases.filter(item => item.name === '陕西能源')) {
    const result = review(item);
    assert.equal(result.data.stage, 'listing-scheduled');
    assert.equal(result.data.listingDate, '2026-10-12');
    assert.equal(result.data.releases[0].quantityShares, 2400000000);
    assert.equal(result.data.releases[0].totalCapitalPct, 64);
    assert.equal(result.data.immediatelyFreelySaleable, false);
  }
  const run = review(byName('润贝航科'));
  assert.equal(run.data.releases[0].quantityShares, 704816);
  assert.equal(run.data.releases[0].totalCapitalPct, .437);
  assert.equal(run.data.listingDate, '2026-10-14');
});

test('肯定标题不能代替正文完成、合规及计划一致证据', () => {
  const source = byName('东岳硅材');
  const without = [
    text => text.replaceAll('本次减持计划已实施完毕', '本次减持计划尚未实施完毕'),
    text => text.replaceAll('本次减持计划已实施完毕', '如果本次减持计划已实施完毕'),
    text => text.replaceAll('减持事项未违反', '减持事项待核实是否符合'),
    text => text.replaceAll('与预披露的减持计划一致', '与预披露的减持计划是否一致尚待核实')
      .replaceAll('与已披露减持计划一致', '与已披露减持计划是否一致尚待核实')
      .replaceAll('与已披露的承诺一致', '与已披露的承诺是否一致尚待核实'),
    text => text.replaceAll('未出现违反承诺的情况', '是否违反承诺尚待核实')
      .replaceAll('不存在违反已披露的减持计划及相关承', '尚待核实是否违反已披露的减持计划及相关承')
  ];
  for (const [index, transform] of without.entries()) {
    assert.notEqual(review(source, transform).eligibility.status, 'pass', `missing-evidence mutation ${index}`);
  }
  const noBody = review(source, () => '本公告仅有标题，正文尚待补充。');
  assert.equal(noBody.eligibility.status, 'pending');
});

test('实际违规独立阻断，修正说明与另一个无风险句都不能覆盖', () => {
  for (const item of [byName('海顺新材'), byName('润贝航科')]) {
    for (const text of ['本次减持已构成违规减持。', '本次减持违反承诺。', '公司不存在重大损失，但本次减持已构成违规减持。',
      '公司已发生债务违约。本公告现予以更正。', '本次解除限售违反相关规定。']) {
      const result = review(item, append(text));
      assert.equal(result.eligibility.status, 'blocked', item.name + text);
      assert.ok(result.data.riskSignals.length);
    }
  }
});

test('否定、条件和承诺措辞不制造违规或修订，真实更正与计划变更仍需核对', () => {
  const item = byName('润贝航科');
  for (const text of ['公司不存在重大损失。本次解除限售未违反相关规定。',
    '如果本次解除限售违反相关规定，公司应当承担责任。', '本承诺不可撤销，如发生差错应在更正日作出说明。']) {
    assert.equal(review(item, append(text)).eligibility.status, 'pass', text);
  }
  for (const text of ['本公告现予以更正。', '本次解除限售计划已变更。']) {
    const result = review(item, append(text));
    assert.equal(result.eligibility.status, 'pending', text);
    assert.match(result.eligibility.reason, /更正|变更/);
  }
});

test('同一计划数量或比例冲突待核验，明确未成就不能由正面表述覆盖', () => {
  const item = byId('9761');
  for (const extra of ['本次可解除限售的限制性股票数量为411,796股，约占目前公司股份总数的0.03%。',
    '本次可解除限售的限制性股票数量为411,795股，约占目前公司股份总数的0.04%。',
    '公司本次解除限售条件尚未成就。', '公司本次解除限售条件未能成就。', '公司本次解除限售条件尚未满足。']) {
    const result = review(item, append(extra));
    assert.equal(result.eligibility.status, 'pending', extra);
    assert.equal(result.data.releases[0].quantityShares, 411795);
  }
});

test('多计划中一项缺数量或阶段不得借另一计划通过，非法分组不能部分解析', () => {
  const item = byId('9762');
  const malformed = review(item, text => text.replaceAll('47.5080 万股', '47.50.80 万股'));
  assert.equal(malformed.eligibility.status, 'pending');
  assert.equal(malformed.data.releases.length, 1);
  assert.match(malformed.eligibility.reason, /数字格式无效|尚缺对应的解除数量/);
  const noSecondStage = review(item, text => text.replace(/2024 年股票期权与限制性股票激励计划预留授予的限制性股票第二个解除限售期解除限售条件已成就/g,
    '2024 年股票期权与限制性股票激励计划预留授予的限制性股票第二个解除限售期的条件尚待核实'));
  assert.equal(noSecondStage.eligibility.status, 'pending');
  assert.equal(noSecondStage.data.releases.length, 2);
});

test('上市安排日期不能被标作实际交易，日期冲突保留待核验', () => {
  const item = byName('润贝航科');
  const future = review(item, text => text.replaceAll('2026 年 10 月 14 日', '2026 年 12 月 14 日'));
  assert.equal(future.eligibility.status, 'pass');
  assert.equal(future.data.stage, 'listing-scheduled');
  assert.equal(future.data.immediatelyFreelySaleable, false);
  const conflict = review(item, append('本次解除限售股份上市流通日为2026年12月15日。'));
  assert.equal(conflict.eligibility.status, 'pending');
  assert.match(conflict.eligibility.reason, /日期存在冲突/);
});

test('数值分组、单位和可靠页面缺失不从局部数字或其他股东拼补', () => {
  const item = byName('泰鸿万立');
  for (const [from, to] of [['150,000股', '15,00,00股'], ['150,000股', '150,000元'],
    ['股东名称              吴建夏', '股东名称              ']]) {
    const result = review(item, text => text.replaceAll(from, to));
    assert.equal(result.eligibility.status, 'pending', to);
  }
  for (const change of [document => { document.complete = false; },
    document => { document.pageTexts[0].method = 'ocr'; },
    document => { document.pageTexts[0].numericEligible = false; },
    document => { document.publishedAt = '2026-01-01'; }]) {
    const copy = prepare(byName('润贝航科')); change(copy.document);
    assert.equal(reviewCorporateAction(copy.document, copy.notice).eligibility.status, 'pending');
  }
});

test('单股东水平表不能把新增其他股东的合计数量归给原股东', () => {
  const result = review(byName('吉大正元'), append('\n一、股东减持股份情况\n股东名称 减持股数（股）\n李四 集中竞价交易 200\n合计 200 0.01\n本次减持前后持股'));
  assert.equal(result.eligibility.status, 'pending');
  assert.match(result.eligibility.reason, /其他股东|数量冲突/);
});

test('不相关公告及减持取消路径继续交给专门核验器', () => {
  for (const title of ['关于董事会会议决议的公告', '关于终止减持计划的公告', '关于不减持承诺的公告']) {
    assert.equal(reviewCorporateAction({}, { title }), null);
  }
});
