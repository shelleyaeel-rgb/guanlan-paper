'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reviewNoticeFacts, actualAmendment } = require('../core/company-notice-facts.cjs');
const { checkNoticeWithEvidence } = require('../core/company-notice-review.cjs');
const NOW = new Date('2026-10-16T10:00:00+08:00'), symbol = 'sh600001';
function document(text, title = '2026年前三季度业绩预告') {
  return { id: 'AN20261015000001', issuerSymbol: symbol, title, kind: 'notice', publishedAt: '2026-10-15',
    fetchedAt: +NOW, complete: true, pages: 1, text, url: 'https://example.com/disclosure',
    pageTexts: [{ page: 1, text, method: 'provider-text', numericEligible: true, complete: true }] };
}
function review(text, title) { const d = document(text, title); return reviewNoticeFacts(d, { title: d.title }); }
const baseline = `业绩预告期间：2026年1月1日至2026年9月30日。
项目  本报告期  上年同期
归属于上市公司股东的净利润  盈利：200万元  盈利：100万元
比上年同期增长：100.00%
扣除非经常性损益后的净利润  盈利：200万元  盈利：100万元
比上年同期增长：100.00%。`;

// Stable layout excerpts transcribed from the 2026-10-16 disclosure review;
// runtime tests never depend on application accounts, caches or tmp files.
const positionedRange = `一、本期业绩预计情况
    （一）业绩预告期间
    2026 年 1 月 1 日至 2026 年 9 月 30 日
    （二）业绩预告情况
    预计净利润为正值且属于下列情形之一：
      扭亏为盈 √同向上升  同向下降
          项目                          本报告期                    上年同期
        营业收入                123,000 万元–125,000 万元          68,312.29 万元
                              比上年同期增长：80.06%-82.98%
                              盈利：43,000 万元–45,000 万元
归属于上市公司股东的净利润                                      盈利：7,135.15 万元
                            比上年同期增长：502.65%-530.68%
                              盈利：42,000 万元–44,000 万元
扣除非经常性损益后的净利润                                      盈利：5,082.94 万元
                            比上年同期增长：726.29%-765.64%
    二、与会计师事务所沟通情况
    本次业绩预告的相关财务数据未经会计师事务所审计。`;
const incomparable = `一、本期业绩预计情况
  1、业绩预告期间：2026 年 1 月 1 日至 2026 年 9 月 30 日。
  2、业绩预告情况：预计净利润为正值且属于同向上升情形
  （1）以区间数进行业绩预告的
                                                                    单位：万元
            项 目                        本报告期                上年同期
 归属于上市公司股东的净利润            54,700  ～    56,700          285.67
 扣除非经常性损益后的净利润            58,900  ～    60,900        1,182.13
  二、与会计师事务所沟通情况
  本次业绩预告相关数据是公司财务部门初步测算的结果，未经会计师事务所审计。
  2025 年第三季度受“720”火灾事故影响，公司当期亏损 3,933.74 万元，使得前三季度归属于上市公司股东的净利润为285.67 万元，本期利润指标与上年同期不具备可比性。`;

test('缺少冒号但标签紧邻唯一完整起止日的业绩期间可核实，不从孤立日期推断', () => {
  for (const separator of ['', '\n\n', '：']) {
    const result = review(baseline.replace('业绩预告期间：', `业绩预告期间${separator}`));
    assert.equal(result.eligibility.status, 'pass'); assert.equal(result.data.period.start, '2026-01-01');
  }
  for (const text of [baseline.replace('业绩预告期间：', ''), baseline.replace('9月30日', '13月30日')]) {
    assert.equal(review(text).eligibility.status, 'pending'); assert.equal(review(text).data.period, null);
  }
  assert.equal(review(baseline.replace('9月30日', '6月30日')).checks[0].status, 'conflict');
});

test('前置有单位盈利区间保留同页列位置并支持短横线，金额和同比逐项对应', () => {
  const result = review(positionedRange);
  assert.equal(result.eligibility.status, 'pass'); assert.equal(result.data.basis, 'forecast');
  assert.deepEqual(result.data.performanceMetrics.netProfit.current, { min: 43000, max: 45000 });
  assert.equal(result.data.performanceMetrics.netProfit.previous, 7135.15);
  assert.deepEqual(result.data.performanceMetrics.recurringProfit.current, { min: 42000, max: 44000 });
  assert.equal(result.data.performanceMetrics.recurringProfit.previous, 5082.94);
  assert.equal(result.data.performanceMetrics.netProfit.amountUsable, true);
  assert.match(result.data.performanceMetrics.netProfit.sourceRecords[0].quote, /本报告期.*上年同期/);
  for (const dash of ['—', '-', '～']) assert.equal(review(positionedRange.replaceAll('–', dash)).eligibility.status, 'pass');
});

test('前置区间的缺端点、错单位、错列、反转表头、算术冲突及不可信页面不放行', () => {
  for (const text of [positionedRange.replace('43,000 万元–45,000 万元', '43,000 万元–'),
    positionedRange.replace('43,000 万元–45,000 万元', '43,000 万元–45,000 亿元'),
    positionedRange.replace('                              盈利：43,000', '盈利：43,000'),
    positionedRange.replace('本报告期                    上年同期', '上年同期                    本报告期'),
    positionedRange.replace('502.65%', '80.00%'), positionedRange.replace('43,000 万元–45,000 万元', '44,000 万元–45,000 万元')]) {
    assert.equal(review(text).eligibility.status, 'pending', text);
  }
  const d = document(positionedRange); d.pageTexts[0].method = 'ocr';
  const result = checkNoticeWithEvidence({ symbol, section: 'notices', source: '东方财富', status: 'ready', fetchedAt: +NOW,
    data: { items: [{ id: d.id, date: d.publishedAt, title: d.title }], total: 1 } }, symbol, { symbol, fetchedAt: +NOW, documents: [d] }, NOW);
  assert.equal(result.status, 'unverified'); assert.equal(result.notices[0].factReview, undefined);
});

test('明确不可比公告保留当期区间、上期金额与单位，不捏造同比且不会自动通过', () => {
  const result = review(incomparable), net = result.data.performanceMetrics.netProfit, recurring = result.data.performanceMetrics.recurringProfit;
  assert.equal(result.eligibility.status, 'pending'); assert.equal(result.eligibility.code, 'performance-not-comparable');
  assert.equal(result.data.comparability.status, 'not-comparable'); assert.ok(result.data.comparability.records.length);
  assert.deepEqual(net.current, { min: 54700, max: 56700 }); assert.equal(net.previous, 285.67);
  assert.deepEqual(recurring.current, { min: 58900, max: 60900 }); assert.equal(recurring.previous, 1182.13);
  for (const metric of [net, recurring]) {
    assert.equal(metric.unit, '万元'); assert.equal(metric.amountStatus, 'verified'); assert.equal(metric.amountUsable, true);
    assert.equal(metric.usable, false); assert.equal(metric.growthPct, null); assert.equal(metric.calculatedGrowthPct, undefined);
    assert.equal(metric.comparisonStatus, 'not-comparable'); assert.ok(metric.sourceRecords.length);
  }
  const absentGrowth = review(incomparable.replace('本期利润指标与上年同期不具备可比性', '本期业绩预计如上'));
  assert.equal(absentGrowth.eligibility.code, 'performance-fields-pending'); assert.equal(absentGrowth.data.performanceMetrics.netProfit.growthPct, null);
  assert.equal(review(incomparable.replace('单位：万元', '')).data.performanceMetrics.netProfit.amountUsable, false);
  const sameNumbers = incomparable.replace('54,700  ～    56,700          285.67', '54,700  ～    54,700          54,700');
  assert.equal(review(sameNumbers).data.performanceMetrics.netProfit.amountUsable, true);
});

test('标准条件性更正提醒和否定的异常事项不制造待核验，肯定与不确定事实仍保留', () => {
  for (const tail of ['如最终数据与本次业绩预告存在重大差异，公司将及时修正业绩预告。',
    '公司未发生过重大损失。', '公司未发生重大诉讼及重大仲裁。', '公司不存在重大损失或重大不利影响。',
    '公司不存在无法表示意见和否定意见。', '公司本年获得标准无保留意见。']) {
    assert.equal(review(baseline + tail).eligibility.status, 'pass', tail);
  }
  for (const tail of ['公司无法确认不存在重大损失。', '公司不存在重大损失的结论尚未确认。',
    '公司可能发生债务违约。', '公司存在重大差异，如最终数据与本次预告存在重大差异，公司将及时修正业绩预告。']) {
    assert.equal(review(baseline + tail).eligibility.status, 'pending', tail);
  }
  for (const tail of ['公司未发生重大诉讼但已发生债务违约。', '公司不存在重大分歧但已发生重大损失。',
    '公司已发生重大损失，如最终数据存在重大差异，公司将及时修正业绩预告。']) {
    assert.equal(review(baseline + tail).eligibility.status, 'blocked', tail);
  }
});

test('实际修订识别排除不可撤销承诺、更正日期及否定或将来动作，覆盖不同公告类型', () => {
  for (const text of ['本承诺函为不可撤销承诺。', '本公司将向自本次发行至欺诈发行揭露日或者更正日期买入股票的投资者发出要约。',
    '有关揭露日、更正日、基准价格等，参照有权部门认可的规定确定。', '公司无需修正本次业绩预告。',
    '公司无须对本次业绩预告进行更正。', '公司尚未修正本次业绩预告。', '公司未对原公告进行更正。',
    '如最终数据发生差异，公司将及时修正业绩预告。']) {
    assert.equal(actualAmendment(document(text, '限售股上市流通提示性公告')), false, text);
  }
  for (const text of ['公司撤回本次业绩预告。', '公司已对本次业绩数据作修正。', '对原公告的业绩数据作如下更正。',
    '公司对原公告进行了更正。', '公司更正了前次公告。', '原公告中的金额更正为100万元。',
    '此前修正业绩数据，如最终数据发生差异，公司将及时修正业绩预告。', '如业绩数据发生差异，公司已及时修正业绩预告。']) {
    assert.equal(actualAmendment(document(text)), true, text); assert.equal(review(baseline + text).eligibility.status, 'pending', text);
  }
  assert.equal(actualAmendment(document('正确公告内容。', '关于前次限售股上市流通公告的更正公告')), true);
  assert.equal(review(baseline + '公司无需修正本次业绩预告。').eligibility.status, 'pass');
});

test('已发生实质异常优先于修订待核验，同时修订中的数字不恢复为可用字段', () => {
  const result = review(baseline + '公司已对本次业绩数据作修正。公司已发生债务违约。');
  assert.equal(result.eligibility.status, 'blocked'); assert.equal(result.eligibility.code, 'performance-exception');
  assert.equal(result.data.amendmentDisclosure, true); assert.ok(result.data.exceptionFindings.some(item => item.explicit));
  assert.equal(result.data.performanceMetrics.netProfit.usable, false); assert.equal(result.data.performanceMetrics.netProfit.amountUsable, false);
  assert.ok(result.data.riskSignals.length);
});

test('公司注册撤销公告和撤销投资项目不等于撤回披露，真正撤回业绩公告仍须核验版本', () => {
  const text = '公司于2026年10月12日收到香港注册处签发的关于DRA公司撤销公告，DRA公司的注册已依据当地《公司条例》第751条经2026年10月9日刊登的第6382号宪报公告宣布撤销，DRA公司于刊登当日予以解散。';
  assert.equal(actualAmendment(document(text, '关于终止对外投资的公告')), false);
  for (const sentence of ['公司已撤销注册。', '公司决定撤销本次投资项目。', '公司已撤销DRA公司。']) {
    assert.equal(actualAmendment(document(sentence, '关于终止对外投资的公告')), false, sentence);
  }
  for (const sentence of ['公司已撤销本次业绩预告。', '公司撤回公告。', '本次业绩预告已被撤销。', '公司已对原公告予以撤回。', '公司决定撤回《2026年第三季度业绩预告公告》。']) {
    assert.equal(actualAmendment(document(sentence)), true, sentence);
  }
  assert.equal(actualAmendment(document('事项终止。', '关于撤销对外投资的公告')), false);
});
