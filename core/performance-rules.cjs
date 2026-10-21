'use strict';
const { cnTime, symbolOf } = require('./common.cjs');
const { safeEvidenceUrl } = require('./selection-evidence.cjs');
const { NOTICE_RISK_POLICY } = require('./entry-risk.cjs');

const PERFORMANCE_RULE_VERSION = 1;
const PERFORMANCE_OPS = Object.freeze({ gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' });
const PERFORMANCE_FIELDS = Object.freeze({
  netProfitGrowthMinPct: { label: '预告/快报归母净利润同比下界', unit: '%', fact: 'netProfit', description: '近期最新期间、最新公告内已核实的归母净利润同比区间下界；预告为预测，快报为初步核算，不是正式财报实际值。' },
  recurringProfitGrowthMinPct: { label: '预告/快报扣非净利润同比下界', unit: '%', fact: 'recurringProfit', description: '同一公告内已核实的扣非净利润同比区间下界；缺失不补零，不使用旧公告或另一篇公告的数字替代。' }
});
const PERFORMANCE_METADATA = Object.freeze({ version: PERFORMANCE_RULE_VERSION, fields: PERFORMANCE_FIELDS, ops: PERFORMANCE_OPS,
  scope: '新鲜公告目录覆盖的最近14个自然日；无可核实预告或快报时，已启用的条件待核验，未启用时仅观察。' });
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validAge = (value, at, ttl) => Number.isFinite(value) && value > 0 && value <= at && at - value <= ttl;
const compare = (left, op, right) => ({ gt: left > right, gte: left >= right, lt: left < right, lte: left <= right, eq: left === right })[op];

function validatePerformanceRules(input) {
  if (input == null) return undefined;
  if (!plain(input) || Object.keys(input).some(key => !['version', 'enabled', 'rules'].includes(key)) || input.version !== PERFORMANCE_RULE_VERSION
    || typeof input.enabled !== 'boolean' || !Array.isArray(input.rules) || input.rules.length > 20) throw Error('业绩预告/快报条件格式或版本无效');
  if (input.enabled && !input.rules.length) throw Error('启用业绩预告/快报条件前请至少添加一条明确条件');
  const rules = [];
  for (const rule of input.rules) {
    if (!plain(rule) || Object.keys(rule).some(key => !['field', 'op', 'value'].includes(key)) || typeof rule.field !== 'string' || !Object.hasOwn(PERFORMANCE_FIELDS, rule.field)
      || typeof rule.op !== 'string' || !Object.hasOwn(PERFORMANCE_OPS, rule.op) || typeof rule.value !== 'number' || !Number.isFinite(rule.value) || Math.abs(rule.value) > 1e12) throw Error('业绩预告/快报指标、比较符或数值无效');
    const normalized = { field: rule.field, op: rule.op, value: rule.value };
    if (!rules.some(existing => JSON.stringify(existing) === JSON.stringify(normalized))) rules.push(normalized);
  }
  for (const [field, metadata] of Object.entries(PERFORMANCE_FIELDS)) {
    const selected = rules.filter(rule => rule.field === field);
    for (const low of selected.filter(rule => ['gt', 'gte', 'eq'].includes(rule.op))) for (const high of selected.filter(rule => ['lt', 'lte', 'eq'].includes(rule.op))) {
      if (low.value > high.value || low.value === high.value && (low.op === 'gt' || high.op === 'lt')) throw Error(`${metadata.label}条件相互矛盾`);
    }
  }
  return { version: PERFORMANCE_RULE_VERSION, enabled: input.enabled, rules };
}

function describePerformanceRules(input) {
  const query = validatePerformanceRules(input);
  if (!query) return [];
  return [query.enabled ? `业绩预告/快报条件：${query.rules.map(rule => `${PERFORMANCE_FIELDS[rule.field].label} ${PERFORMANCE_OPS[rule.op]} ${rule.value} %`).join('；')}` : '业绩预告/快报仅观察，未作为筛选条件'];
}

function performanceSource(review, symbol, now) {
  const at = now.getTime(), today = cnTime(now).date;
  const pending = reason => ({ issue: reason, notice: null, period: null, metrics: {} });
  if (!plain(review) || review.symbol !== symbol || !['东方财富', '巨潮资讯'].includes(review.source) || review.coverageComplete !== true || !Array.isArray(review.notices)) return pending('近期公告目录缺失、股票或来源不符，或14日覆盖尚未完整');
  if (!validAge(review.fetchedAt, at, NOTICE_RISK_POLICY.noticeMaxAgeMs) || !validAge(review.checkedAt, at, NOTICE_RISK_POLICY.noticeMaxAgeMs)
    || review.windowEnd !== today) return pending('公告目录或核验时间无效、超过5分钟或不属于当日');
  const notices = review.notices.filter(notice => /业绩预告|业绩快报/.test(notice?.title || ''));
  if (!notices.length) return pending('近期公告范围内没有可供该条件判断的业绩预告或快报；不以正式财报代替');
  if (new Set(notices.map(notice => notice.id)).size !== notices.length) return pending('业绩公告编号重复，不能择优使用版本');
  const candidates = [];
  for (const notice of notices) {
    const facts = notice.factReview, periods = facts?.checks?.filter(check => check.key === 'period') || [], period = periods[0]?.value;
    if (!(review.source === '巨潮资讯' ? /^CN\d{10,30}$/ : /^AN\d{10,30}$/).test(notice.id) || !validDate(notice.date) || notice.date > today || notice.date < review.windowStart
      || notice.fulltextStatus !== 'verified' || !['forecast', 'flash'].includes(facts?.type) || facts.version !== 1
      || periods.length !== 1 || periods[0].status !== 'verified' || !validDate(period?.start) || !validDate(period?.end) || period.start > period.end
      || facts.type === 'flash' && period.end > notice.date) return pending('存在业绩公告的原文、期间或版本尚未核实，不能跳过它改用其他公告通过条件');
    candidates.push({ notice, period });
  }
  const latestEnd = candidates.map(item => item.period.end).sort().at(-1);
  const latestPeriod = candidates.filter(item => item.period.end === latestEnd);
  // A later disclosure can supersede an earlier value only for the same
  // period. Quarterly and year-to-date figures sharing an end date are not
  // alternate versions, and this query does not select between those bases.
  const periodBases = new Set(latestPeriod.map(item => JSON.stringify([item.period.start, item.period.aggregation || null])));
  if (periodBases.size !== 1) {
    const ranges = [...new Set(latestPeriod.map(item => `${item.period.start} 至 ${item.period.end}（${item.period.aggregation === 'single-quarter' ? '单季度' : item.period.aggregation === 'cumulative' ? '年初累计' : '口径未标明'}）`))];
    return pending(`最新期末 ${latestEnd} 存在不同起始日或单季度／累计口径：${ranges.join('、')}；当前条件尚未选择期间口径，不能把较晚披露的单季数字当作累计数据的新版本，等待明确口径`);
  }
  const latestDate = latestPeriod.map(item => item.notice.date).sort().at(-1);
  const selected = latestPeriod.filter(item => item.notice.date === latestDate);
  if (selected.length !== 1) return pending('同一最新报告期、同一披露日存在多篇业绩公告，生效顺序无法确认；不择优放行或跨公告拼接');
  const { notice, period } = selected[0], facts = notice.factReview, metrics = {};
  const expectedBasis = facts.type === 'forecast' ? 'forecast' : 'preliminary-actual';
  const commonIssue = facts.data?.amendmentDisclosure ? '最新业绩公告涉及更正、修正或撤回，生效字段尚未核实'
    : facts.data?.comparativeRestatementDisclosed ? '最新业绩公告涉及追溯调整或重述，比较基数尚未核实'
      : facts.data?.basis !== expectedBasis ? '预告预测与快报初步核算口径不一致' : '';
  for (const [field, metadata] of Object.entries(PERFORMANCE_FIELDS)) {
    const matches = facts.checks.filter(check => check.key === metadata.fact), check = matches[0], value = check?.value;
    const records = (notice.records || []).filter(record => record?.id?.startsWith(`${notice.id}#notice-fact:${metadata.fact}:`));
    let issue = commonIssue;
    if (!issue && (matches.length !== 1 || check?.status !== 'verified' || !Number.isFinite(value?.growthPct?.min) || !Number.isFinite(value?.growthPct?.max)
      || value.growthPct.min > value.growthPct.max || !Number.isFinite(value.current?.min) || !Number.isFinite(value.current?.max)
      || value.current.min > value.current.max || !Number.isFinite(value.previous) || !(value.previous > 0) || !['元', '万元', '亿元'].includes(value.unit))) issue = check?.reason || '该同比区间、金额单位或比较基数尚未完整核实；缺失不等于零';
    // A fact verdict is meaningful only together with its own traceable source.
    if (!issue && (!records.length || records.some(record => record.symbol !== symbol || record.sourceDocumentId !== notice.id || record.sourceTitle !== notice.title
      || record.publishedAt !== notice.date || record.value !== 'fact-verified' || record.sourceRelation !== 'issuer-disclosure' || !safeEvidenceUrl(record.url)
      || typeof record.quote !== 'string' || !record.quote.trim() || !validAge(Date.parse(record.checkedAt), at, NOTICE_RISK_POLICY.noticeMaxAgeMs)))) issue = '该指标缺少身份、时间和原文一致的公告来源记录';
    if (!issue && [value.current.min, value.current.max].some((amount, index) => Math.abs((amount / value.previous - 1) * 100 - [value.growthPct.min, value.growthPct.max][index]) > 0.02)) issue = '当期、同期金额与同比区间不一致，不能仅信任已保存的核验标记';
    metrics[field] = { value: issue ? null : value.growthPct.min, unit: '%', status: issue ? 'pending' : 'available', reason: issue,
      sourceRefs: structuredClone(records), period: { ...period }, basis: expectedBasis };
  }
  return { issue: '', notice: { id: notice.id, title: notice.title, date: notice.date, type: facts.type, basis: expectedBasis, basisLabel: facts.data.basisLabel }, period, metrics };
}

function evaluatePerformanceRules(input, noticeReview, { symbol: inputSymbol, now: inputNow = new Date() } = {}) {
  const query = validatePerformanceRules(input), now = new Date(inputNow);
  if (!Number.isFinite(now.getTime())) throw Error('业绩条件评估时间无效');
  const enabled = query?.enabled === true;
  const base = { version: PERFORMANCE_RULE_VERSION, enabled, query: query || null, checkedAt: now.toISOString(), label: '业绩预告/快报条件',
    checks: [], selectedNotice: null, metrics: {}, limitation: '仅判断近期预告预测或快报初步核算的明确条件，不替代正式财报和独立公告风险检查；同比阈值由用户选择，未经策略效果验证。' };
  let symbol, source;
  try { symbol = symbolOf(inputSymbol); source = performanceSource(noticeReview, symbol, now); }
  catch { source = { issue: '股票身份或业绩来源格式无效', notice: null, metrics: {} }; }
  const result = { ...base, symbol: symbol || null, selectedNotice: source.notice, metrics: source.metrics };
  if (!enabled) return { ...result, status: 'observing', passed: null, blocksEntry: false, reasons: [source.issue || '未启用业绩预告/快报条件，仅供观察'] };
  const checks = query.rules.map(rule => {
    const metadata = PERFORMANCE_FIELDS[rule.field], metric = source.metrics[rule.field], reason = source.issue || metric?.reason || '';
    const status = reason || !metric ? 'pending' : compare(metric.value, rule.op, rule.value) ? 'pass' : 'failed';
    return { field: rule.field, label: metadata.label, rule: { ...rule }, actual: status === 'pending' ? null : metric.value,
      unit: '%', expected: `${PERFORMANCE_OPS[rule.op]} ${rule.value} %`, status,
      reason: reason || (status === 'pass' ? '满足明确选择的业绩条件' : '不满足该业绩条件；普通同比下降不自动等同于重大公告风险'),
      sourceRefs: metric?.sourceRefs || [], period: metric?.period || null, basis: metric?.basis || null };
  });
  const status = checks.some(check => check.status === 'failed') ? 'failed' : checks.some(check => check.status === 'pending') ? 'pending' : 'pass';
  return { ...result, checks, status, passed: status === 'pass', blocksEntry: status !== 'pass', reasons: checks.filter(check => check.status !== 'pass').map(check => `${check.label}：${check.reason}`) };
}

module.exports = { PERFORMANCE_RULE_VERSION, PERFORMANCE_FIELDS, PERFORMANCE_OPS, PERFORMANCE_METADATA, validatePerformanceRules, describePerformanceRules, evaluatePerformanceRules };
