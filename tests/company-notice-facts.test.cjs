'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { checkNoticeWithEvidence } = require('../core/company-notice-review.cjs');
const symbol = 'sh600001', now = new Date('2026-10-14T10:00:00+08:00');
function fixture(text, title = '2026年前三季度业绩预告', at = now, publishedAt = '2026-10-13') {
  const notice = { id: 'AN20261013000001', date: publishedAt, title };
  const document = { id: notice.id, kind: 'notice', issuerSymbol: symbol, title, publishedAt: notice.date, fetchedAt: +at,
    complete: true, text, pages: 1, url: 'https://data.eastmoney.com/notices/detail/600001/AN20261013000001.html',
    pageTexts: [{ page: 1, text, method: 'provider-text', numericEligible: true, complete: true }] };
  const response = { symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +at, data: { items: [notice], total: 1 } };
  return { document, notice, response, now: at, bundle: { symbol, fetchedAt: +at, documents: [document] } };
}
const review = f => checkNoticeWithEvidence(f.response, symbol, f.bundle, f.now).notices[0];
const forecast = `业绩预告期间：2026年1月1日至2026年9月30日。
项目  年初至报告期末  上年同期
归属于上市公  盈利：884,000.00万元—905,000.00万元  盈利：470,315.04万元
司股东的净利
润            比上年同期增长：87.96%—92.42%
扣除非经常性  盈利：867,000.00万元—888,000.00万元  盈利：465,822.49万元
损益后的净利
润            比上年同期增长：86.12%—90.63%
基本每股收益  1.6706元/股
二、与会计师事务所沟通情况
本次业绩预告未经会计师事务所审计。`;

test('严格预告行组核实期间、金额单位、归母扣非上下界同比，只解除该篇敏感标题门槛', () => {
  const result = review(fixture(forecast));
  assert.equal(result.status, 'clear'); assert.equal(result.fulltextStatus, 'verified');
  assert.equal(result.factReview.status, 'verified'); assert.equal(result.factReview.data.basis, 'forecast');
  assert.equal(result.factReview.data.auditStatus, 'unaudited');
  assert.equal(result.factReview.eligibility.status, 'pass'); assert.equal(result.factReview.eligibility.scope, 'sensitive-notice-title-only');
  assert.deepEqual(result.factReview.checks.find(item => item.key === 'netProfit').value.current, { min: 884000, max: 905000 });
  assert.equal(result.factReview.checks.find(item => item.key === 'recurringProfit').value.previous, 465822.49);
  assert.match(result.reason, /限定事实字段已核实.*业绩预测.*仅解除.*不代表.*买入许可/);
  assert.doesNotMatch(result.reason, /结案|义务履行|敏感公告尚未取得/);
  assert.ok(result.records.some(record => record.value === 'fact-verified' && record.locations[0].page === 1));
});

test('预告缺单位、同比不符、期间缺失或无效、不可靠页均不能标作事实核实', () => {
  for (const [text, key] of [[forecast.replaceAll('万元', ''), 'netProfit'], [forecast.replace('87.96%', '80.00%'), 'netProfit'],
    [forecast.replace('业绩预告期间：2026年1月1日至2026年9月30日。', ''), 'period'],
    [forecast.replace('2026年9月30日', '2026年13月31日'), 'period'],
    [forecast.replace('470,315.04万元', '470,315.04亿元'), 'netProfit']]) {
    const result = review(fixture(text)); assert.equal(result.status, 'unverified'); assert.equal(result.factReview.status, 'incomplete');
    assert.ok(result.factReview.missingFields.includes(key), result.reason);
  }
  const f = fixture(forecast); f.document.pageTexts[0].numericEligible = false;
  assert.equal(review(f).factReview, undefined); assert.match(review(f).reason, /未可靠核验/);
});

test('预告表头不能反转，非法逗号分组和更正撤回不能标为已核实，未来预测不冒充实际业绩', () => {
  for (const text of [forecast.replace('年初至报告期末  上年同期', '上年同期  年初至报告期末'),
    forecast.replace('884,000.00', '88,4000.00'), forecast.replace('884,000.00', '9'.repeat(400)), forecast + '公司撤回本次业绩预告。', forecast + '对原公告的业绩数据作如下更正。']) {
    const result = review(fixture(text)); assert.equal(result.factReview.status, 'incomplete'); assert.equal(result.status, 'unverified');
  }
  const future = review(fixture(forecast.replace('2026年9月30日', '2026年12月31日')));
  assert.equal(future.factReview.status, 'incomplete'); assert.equal(future.factReview.data.basis, 'forecast'); assert.equal(future.status, 'unverified');
  assert.equal(future.factReview.checks.find(item => item.key === 'period').status, 'conflict', '前三季度标题不能套用全年正文期间');
});

test('三季预告允许披露时期间尚未结束，保持预测属性和原始区间，不等待正式三季报', () => {
  const at = new Date('2026-09-16T10:00:00+08:00');
  const result = review(fixture(forecast, '2026年前三季度业绩预告', at, '2026-09-15'));
  assert.equal(result.status, 'clear'); assert.equal(result.factReview.data.basis, 'forecast');
  assert.deepEqual(result.factReview.data.period, { start: '2026-01-01', end: '2026-09-30', basis: 'explicit-dates', aggregation: 'cumulative', aggregationLabel: '年初至期末累计' });
  const metric = result.factReview.data.performanceMetrics.netProfit;
  assert.equal(metric.usable, true); assert.equal(metric.basis, 'forecast'); assert.equal(metric.unit, '万元');
  assert.deepEqual(metric.current, { min: 884000, max: 905000 }); assert.ok(metric.sourceRecords.length);
  assert.match(result.reason, /业绩预测，尚非实际业绩/); assert.doesNotMatch(result.reason, /等待.*三季报|等待.*正式|已经结束/);
  const annual = review(fixture(forecast.replace('2026年9月30日', '2026年12月31日'), '2026年度业绩预告'));
  assert.equal(annual.status, 'clear'); assert.equal(annual.factReview.data.period.end, '2026-12-31');
});

test('第三季度标题依据正文唯一起止日区分累计与单季，不用标题猜测或拼接多个期间', () => {
  const cumulative = review(fixture(forecast, '2026年第三季度业绩预告'));
  assert.equal(cumulative.status, 'clear'); assert.equal(cumulative.factReview.data.period.aggregation, 'cumulative');
  const singleBody = forecast.replace('2026年1月1日', '2026年7月1日').replace('年初至报告期末', '本报告期');
  for (const title of ['2026年第三季度业绩预告', '2026年三季度业绩预告']) {
    const single = review(fixture(singleBody, title));
    assert.equal(single.status, 'clear'); assert.equal(single.factReview.data.period.aggregation, 'single-quarter');
    assert.equal(single.factReview.data.performanceMetrics.netProfit.period.start, '2026-07-01');
  }
  for (const [body, title] of [[singleBody, '2026年前三季度业绩预告'],
    [forecast + '业绩预告期间：2026年7月1日至2026年9月30日。', '2026年第三季度业绩预告'],
    [forecast.replace('2026年1月1日', '2026年7月1日'), '2026年第三季度业绩预告'],
    [forecast.replace('2026年1月1日', '2026年4月1日'), '2026年第三季度业绩预告']]) {
    const result = review(fixture(body, title));
    assert.equal(result.status, 'unverified'); assert.equal(result.factReview.eligibility.code, 'performance-period');
    assert.equal(result.factReview.data.period, null); assert.equal(result.factReview.data.performanceMetrics.netProfit.usable, false);
  }
});

test('数字在标签之前不借用下一行组数字，神火式布局保留明确缺项', () => {
  const text = `业绩预告期间：2026年1月1日至2026年9月30日。
单位：万元
项目  本报告期  上年同期
740,000.00
归属于上市公司股东的净利润  348,970.74
比上年同期增长  112.05%
741,000.00
扣除非经常性损益后的净利润  357,924.10
比上年同期增长  107.03%
基本每股收益  3.344  1.575
本次业绩预告未经会计师事务所预审计。`;
  const result = review(fixture(text)); assert.equal(result.factReview.status, 'incomplete');
  assert.deepEqual(result.factReview.missingFields, ['netProfit', 'recurringProfit']);
  assert.match(result.reason, /不使用标签之前或下一行组的孤立数字/);
  assert.equal(result.factReview.checks.find(item => item.key === 'netProfit').value, null);
});

test('快报初步实际与预告区别，只有明确单位和同表三列才算同比', () => {
  const text = `单位：万元  币种：人民币
本报告期  上年同期  增减变动幅度（%）
归属于上市公司股东的净  299,384.32  228,638.42  30.94
利润
归属于上市公司股东的扣  301,905.33  227,437.37  32.74
除非经常性损益的净利润
基本每股收益  0.928  0.709  30.89
注：“本报告期”指年初至本季度末9个月期间，下同。
二、风险提示
本公告数据未经会计师事务所审计。`;
  const result = review(fixture(text, '2026年前三季度业绩快报公告'));
  assert.equal(result.factReview.status, 'verified'); assert.equal(result.factReview.data.basis, 'preliminary-actual');
  assert.equal(result.factReview.checks.find(item => item.key === 'period').value.end, '2026-09-30');
  assert.equal(result.status, 'clear'); assert.match(result.reason, /初步核算.*仅解除/);
  const changed = review(fixture(text.replace('30.94', '39.94'), '2026年前三季度业绩快报公告'));
  assert.equal(changed.factReview.status, 'incomplete'); assert.match(changed.reason, /同比不一致/);
  const invalidNumber = review(fixture(text.replace('299,384.32', '29,9384.32'), '2026年前三季度业绩快报公告'));
  assert.ok(invalidNumber.factReview.missingFields.includes('netProfit'));
  assert.ok(review(fixture(text.replace('299,384.32', '299,384.32%'), '2026年前三季度业绩快报公告')).factReview.missingFields.includes('netProfit'));
  const future = review(fixture(text, '2027年前三季度业绩快报公告'));
  assert.equal(future.factReview.checks.find(item => item.key === 'period').status, 'conflict');
  const early = review(fixture(text, '2026年前三季度业绩快报公告', new Date('2026-09-16T10:00:00+08:00'), '2026-09-15'));
  assert.equal(early.status, 'unverified'); assert.equal(early.factReview.data.periodStatus, 'conflict');
  assert.match(early.reason, /初步实际业绩期间晚于公告披露日期/);
  const thirdTitle = review(fixture(text, '2026年第三季度业绩快报公告'));
  assert.equal(thirdTitle.status, 'clear'); assert.equal(thirdTitle.factReview.data.period.aggregation, 'cumulative', '第三季度标题须结合正文九个月定义');
});

test('普通同比下滑转为可量化观察提示，不盈利独立阻断，算术冲突仍待补核实', () => {
  const metric = (current, previous, growth) => `盈利：${current}万元  盈利：${previous}万元\n比上年同期${growth}`;
  const text = (net, recurring) => `业绩预告期间：2026年1月1日至2026年9月30日。\n项目  本报告期  上年同期\n归属于上市公司股东的净利润  ${net}\n扣除非经常性损益后的净利润  ${recurring}`;
  const growth = metric(200, 100, '增长：100.00%'), decline = metric(90, 100, '下降：10.00%');
  for (const body of [text(decline, growth), text(growth, decline), '业绩预告情况：同向下降。' + text(decline, growth)]) {
    const f = fixture(body), result = checkNoticeWithEvidence(f.response, symbol, f.bundle, now);
    assert.equal(result.status, 'clear'); assert.equal(result.notices[0].factReview.eligibility.code, 'performance-title-gate-cleared');
    assert.equal(result.warnings.length, 1); assert.equal(result.warnings[0].code, 'performance-growth-decline');
    assert.deepEqual(result.warnings[0].value, { min: -10, max: -10 }); assert.equal(result.warnings[0].noticeId, f.notice.id);
    assert.match(result.reasons.join('；'), /同比下滑|同比区间/);
    const facts = result.notices[0].factReview;
    assert.equal(facts.data.performanceMetrics[facts.warnings[0].metric].usable, true);
  }
  for (const body of [text('亏损：10万元  盈利：100万元\n比上年同期下降：110.00%', growth),
    text('盈利：0万元  盈利：100万元\n比上年同期下降：100.00%', growth)]) {
    const result = review(fixture(body));
    assert.equal(result.status, 'blocked'); assert.equal(result.factReview.eligibility.code, 'performance-adverse');
  }
  assert.equal(review(fixture(text(metric(100, 100, '增长：0.00%'), growth))).status, 'clear', '零增长不人为增加选股阈值');
  assert.equal(review(fixture(text(metric(200, 100, '增长：10.00%'), growth))).status, 'unverified');
  assert.equal(review(fixture(text(growth, '亏损：10万元  亏损：100万元\n比上年同期增长：90.00%'))).status, 'blocked', '同比口径未支持也不能掩盖明确披露的当期亏损');
  assert.equal(review(fixture(text(growth, '盈利：10万元  亏损：100万元\n比上年同期增长：110.00%'))).status, 'unverified', '扭亏的同比口径仍须明确核实，不能补零');
});

test('期间与标题不一致、追溯调整、实质异常和实际修正仍不可清除门槛', () => {
  const changes = [forecast.replace('2026年9月30日', '2026年6月30日'), forecast.replace('2026年1月1日', '2026年7月1日'),
    forecast.replace('2026年9月30日', '2026年12月31日'), forecast + '公司对上年同期净利润进行了追溯调整。',
    forecast + '公司存在持续经营能力重大不确定性。', forecast + '公司已对本次业绩预告数据进行修正。'];
  for (const text of changes) assert.notEqual(review(fixture(text)).status, 'clear', text);
  assert.equal(review(fixture('业绩预告情况：同向下降。' + forecast)).status, 'unverified', '正文预告分类与数值冲突不可择一通过');
  for (const text of [forecast + '公司已发生债务违约。', forecast + '公司已发生重大损失。', forecast + '公司被立案调查。']) assert.equal(review(fixture(text)).status, 'blocked');
  assert.equal(review(fixture(forecast + '公司不存在重大分歧。')).status, 'clear');
  for (const statement of ['公司无法确认不存在重大损失。', '公司不存在重大损失的结论尚未确认。', '公司不存在重大分歧但已发生重大损失。']) {
    assert.notEqual(review(fixture(forecast + statement)).status, 'clear', statement);
  }
  assert.equal(review(fixture(forecast + '如最终数据发生差异，公司将及时修正业绩预告。')).status, 'clear', '条件性的未来更正提示不等于实际已经更正');
  assert.equal(review(fixture(forecast + '公司已对本次业绩数据作修正，如最终数据发生差异，公司将及时修正业绩预告。')).status, 'unverified');
  assert.equal(review(fixture(forecast + '此前修正业绩数据，如最终数据发生差异，公司将及时修正业绩预告。')).status, 'unverified');
  assert.equal(review(fixture(forecast + '如业绩数据发生差异，公司已及时修正业绩预告。')).status, 'unverified');
});

test('预测资料缺项与实质异常分别呈现，重大异常不会被期间缺失或正面数字掩盖', () => {
  const withoutRecurring = forecast.split('扣除非经常性')[0];
  const incomplete = review(fixture(withoutRecurring));
  assert.equal(incomplete.status, 'unverified'); assert.equal(incomplete.factReview.eligibility.code, 'performance-fields-pending');
  assert.equal(incomplete.factReview.data.performanceMetrics.netProfit.usable, true);
  assert.equal(incomplete.factReview.data.performanceMetrics.recurringProfit.usable, false);
  assert.equal(incomplete.factReview.data.performanceMetrics.recurringProfit.current, null);
  assert.match(incomplete.reason, /待补项/); assert.doesNotMatch(incomplete.reason, /等待.*正式|三季报尚未披露/);
  const noPeriod = forecast.replace('业绩预告期间：2026年1月1日至2026年9月30日。', '');
  const adverse = review(fixture(noPeriod + '公司已发生债务违约。'));
  assert.equal(adverse.status, 'blocked'); assert.equal(adverse.factReview.eligibility.code, 'performance-exception');
  assert.equal(adverse.factReview.data.riskSignals[0].code, 'performance-exception');
  for (const body of [forecast + '公司已对本次业绩数据作修正。', forecast + '公司对上年同期净利润进行了追溯调整。']) {
    const result = review(fixture(body));
    assert.equal(result.factReview.data.performanceMetrics.netProfit.usable, false);
    assert.equal(result.factReview.warnings.length, 0);
  }
});

const positionedForecast = `业绩预告期间：2026年1月1日至2026年9月30日。
（1）以确数进行业绩预告的
                                                                    单位：万元
          项  目                        本报告期                  上年同期
                                                  740,000.00
归属于上市公司股东的净利润                                            348,970.74
                              比上年同期增长        112.05%
                                                  741,000.00
扣除非经常性损益后的净利润                                            357,924.10
                              比上年同期增长        107.03%
基本每股收益（元/股）                                  3.344              1.575
二、与会计师事务所沟通情况
本次业绩预告未经会计师事务所预审计。`;

test('明确确数表中前置当期数字须满足同页邻接三行、列位置、单位和算术才能核实', () => {
  const result = review(fixture(positionedForecast));
  assert.equal(result.status, 'clear'); assert.equal(result.factReview.status, 'verified');
  assert.equal(result.factReview.checks.find(item => item.key === 'netProfit').value.current.min, 740000);
  assert.equal(result.factReview.checks.find(item => item.key === 'recurringProfit').value.previous, 357924.1);
  assert.match(result.factReview.checks.find(item => item.key === 'netProfit').records[0].quote, /单位：万元.*\n.*本报告期/);
  for (const text of [positionedForecast.replace('以确数进行业绩预告的', '以区间进行业绩预告的'),
    positionedForecast.replace('                                                  740,000.00', '740,000.00'),
    positionedForecast.replace('上年同期\n', '上期其他指标\n'), positionedForecast.replace('112.05%', '107.03%'),
    positionedForecast.replace('740,000.00', '741,000.00'), positionedForecast.replace('单位：万元', '单位：元 单位：万元'),
    positionedForecast.replace('                                                  740,000.00', '                                                  74,0000.00')]) {
    assert.equal(review(fixture(text)).status, 'unverified', text);
  }
  const pages = fixture(positionedForecast); pages.document.pages = 2;
  const [before, after] = positionedForecast.split('归属于上市公司股东的净利润');
  pages.document.pageTexts = [{ page: 1, text: before, method: 'provider-text', numericEligible: true, complete: true },
    { page: 2, text: '归属于上市公司股东的净利润' + after, method: 'provider-text', numericEligible: true, complete: true }];
  pages.document.text = pages.document.pageTexts.map(page => page.text).join('\n\n');
  assert.equal(review(pages).status, 'unverified', '金额、表头、行标签跨页时不拼接孤立数字');
});

const rangedForecast = `业绩预告期间：2026年1月1日至2026年9月30日。
                                                                    单位：万元
    项  目                          本报告期                        上年同期
归属于上市公司                    870,000.00  ～    970,000.00
股东的净利润                                                          375,503.40
                比上年同期增长    131.69%  ～      158.32%
扣除非经常性损                    866,400.00  ～    966,400.00
益后的净利润                                                          423,780.45
                比上年同期增长    104.45%  ～      128.04%
基本每股收益                            2.58  ～          2.88          1.11
二、与会计师事务所沟通情况
本次业绩预告未经过注册会计师预审计。`;

test('换行区间表保留标签、当期上下限、上期与同比的独立列，缺列或移位不补猜', () => {
  const result = review(fixture(rangedForecast));
  assert.equal(result.status, 'clear'); assert.equal(result.factReview.data.auditStatus, 'unaudited');
  assert.deepEqual(result.factReview.checks.find(item => item.key === 'netProfit').value.current, { min: 870000, max: 970000 });
  assert.deepEqual(result.factReview.checks.find(item => item.key === 'recurringProfit').value.growthPct, { min: 104.45, max: 128.04 });
  for (const text of [rangedForecast.replace('～    970,000.00', '～'), rangedForecast.replace('375,503.40', '423,780.45'),
    rangedForecast.replace('股东的净利润                                                          375,503.40', '股东的净利润  375,503.40'),
    rangedForecast.replace('131.69%', '104.45%'), rangedForecast.replace('单位：万元', ''),
    rangedForecast.replace('本报告期                        上年同期', '上年同期                        本报告期')]) {
    assert.notEqual(text, rangedForecast); assert.equal(review(fixture(text)).status, 'unverified');
  }
  const quarter = rangedForecast + '\n其中，2026年7月1日至9月30日业绩预计情况如下：\n' + rangedForecast.replaceAll('870,000.00', '1.00');
  assert.equal(review(fixture(quarter)).status, 'clear', '附单季度行不得混入累计报告期间的已核验行组');
  const unreliable = fixture(rangedForecast); unreliable.document.pageTexts[0].method = 'ocr';
  assert.equal(review(unreliable).status, 'unverified'); assert.equal(review(unreliable).factReview, undefined);
});

const reduction = `拟减持不超过999,999股。
二、减持计划的实施结果
股东名称  张三
减持数量  127,400股
减持期间  2026年8月28日～2026年9月30日
减持完成情况  已完成
(二)本次减持是否遵守相关法律法规、本所业务规则的规定 √是 □否
(三)本次实际减持情况与此前披露的减持计划、承诺是否一致 √是 □否
(七)是否存在违反减持计划或其他承诺的情况 □是 √否`;
test('减持结果核实主体股数期间和逐项合规，仅解除对应标题门槛', () => {
  const result = review(fixture(reduction, '高级管理人员减持股份结果公告'));
  assert.equal(result.factReview.status, 'verified'); assert.equal(result.status, 'clear');
  assert.equal(result.factReview.data.quantityShares, 127400);
  assert.equal(result.factReview.data.transactions[0].holder, '张三');
  assert.equal(result.factReview.data.independentComplianceVerification, false);
  assert.match(result.reason, /仅解除该类标题门槛/);
  const ambiguous = review(fixture(reduction.replace('√是 □否', '□是 □否'), '减持股份结果公告'));
  assert.ok(ambiguous.factReview.missingFields.includes('compliance'));
  assert.equal(ambiguous.status, 'unverified');
  const violation = review(fixture(reduction.replace('□是 √否', '√是 □否'), '减持股份结果公告'));
  assert.equal(violation.status, 'blocked');
  assert.equal(violation.factReview.checks.find(item => item.key === 'eventRisk').status, 'conflict');
  assert.match(violation.reason, /实质违规/);
  const future = review(fixture(reduction.replace('2026年9月30日', '2026年10月30日'), '减持股份结果公告'));
  assert.equal(future.status, 'unverified');
  assert.match(future.reason, /晚于披露日/);
  assert.equal(future.factReview.data.quantityShares, 127400);
});

test('解禁规模与流通安排作为供给观察，程序缺项和数量冲突仍待核验', () => {
  const text = '本次解除限售股票上市流通日为2026年10月14日。' +
    '本次符合解除限售的激励对象共50名，可解除限售的限制性股票共计704,816股，占公司当前股本总额的0.437%。';
  const result = review(fixture(text, '解除限售股份上市流通的提示性公告'));
  assert.equal(result.status, 'unverified'); assert.equal(result.factReview.status, 'incomplete');
  assert.deepEqual(result.factReview.missingFields, ['compliance']);
  assert.equal(result.factReview.data.basis, 'disclosed-release-schedule');
  assert.deepEqual(result.factReview.data.releases[0], { plan: '本次解除限售', holders: 50, quantityShares: 704816, totalCapitalPct: 0.437, records: undefined });
  assert.equal(result.factReview.data.immediatelyFreelySaleable, false);
  const complete = review(fixture(text + '本次解除限售已履行现阶段必要的法律程序。', '解除限售股份上市流通的提示性公告'));
  assert.equal(complete.factReview.status, 'verified'); assert.equal(complete.status, 'clear');
  assert.equal(complete.factReview.data.stage, 'listing-scheduled');
  assert.equal(complete.factReview.data.listingDate, '2026-10-14');
  assert.match(complete.reason, /不表示股份已卖出或可以买入/);
  const conflict = review(fixture(text + text.replace('704,816', '700,000'), '解除限售股份上市流通的提示性公告'));
  assert.equal(conflict.status, 'unverified');
  assert.match(conflict.reason, /本次解除数量或占总股本比例冲突/);
});

test('不支持的类型明确规则缺口，不套用诉讼履约，也不使原文缺失变成事实已核验', () => {
  const f = fixture('项目已完成，对公司没有重大影响。', '关于收到监管工作函的风险提示公告');
  const result = review(f); assert.equal(result.factReview.status, 'unsupported'); assert.equal(result.status, 'unverified');
  assert.match(result.reason, /完整原文已读取.*暂不支持结构化核验/); assert.doesNotMatch(result.reason, /义务履行/);
  f.bundle.documents = []; const missing = review(f); assert.equal(missing.factReview, undefined); assert.match(missing.reason, /尚未取得/);
  const changed = fixture(forecast); changed.document.issuerSymbol = 'sh600002'; assert.equal(review(changed).factReview, undefined);
});
