'use strict';
const { cnTime, symbolOf } = require('./common.cjs');
const { FIELDS, OPS, validate, describe, fieldAvailable, normalizeFinance } = require('./screener.cjs');
const { evaluateEvidence } = require('./selection-evidence.cjs');
const { evaluateCompanyEvidence } = require('./company-evidence.cjs');
const { evaluateOperatingResearch } = require('./company-research.cjs');
const { pendingFinanceReport, reportSyncReason } = require('./financial-report-status.cjs');
const { evaluatePerformanceRules } = require('./performance-rules.cjs');
const { checkNoticeWithEvidence } = require('./company-notice-review.cjs');

const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => structuredClone(value);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validAge = (time, now, ttl) => Number.isFinite(time) && time > 0 && time <= now && now - time <= ttl;
const fieldsOf = rule => [rule.field, ...(rule.valueField ? [rule.valueField] : [])];
const usesAutomaticEvidence = saved => !!saved?.evidence && saved.source?.kind === 'agency-pool' && [2, 3].includes(saved.source.policyVersion);
const compare = (left, op, right) => ({ gt: left > right, gte: left >= right, lt: left < right, lte: left <= right, eq: left === right })[op];
const amount = (value, field) => `${Number(value.toFixed(6))}${FIELDS[field].unit ? ` ${FIELDS[field].unit}` : ''}`;
function sourceCopy(value) {
  if (value == null) return undefined;
  const jsonValue = item => item === null || ['string', 'boolean'].includes(typeof item) || (typeof item === 'number' && Number.isFinite(item))
    || (Array.isArray(item) && item.every(jsonValue)) || (plain(item) && Object.values(item).every(jsonValue));
  if (!(typeof value === 'string' || plain(value)) || !jsonValue(value) || JSON.stringify(value).length > 8192) throw Error('开仓条件来源信息格式无效');
  return clone(value);
}
function queryOf(input) {
  if (!plain(input) || Object.keys(input).some(key => !['rules', 'excludeST', 'evidence', 'research', 'performance', 'source', 'scope', 'boards'].includes(key))) throw Error('附加开仓条件格式无效');
  if (input.rules !== undefined && (!Array.isArray(input.rules) || input.rules.some(rule => !plain(rule) || Object.keys(rule).some(key => !['field', 'op', 'value', 'valueField'].includes(key))))) throw Error('附加开仓指标格式无效');
  return validate({ scope: 'all', boards: [], excludeST: input.excludeST === undefined ? false : input.excludeST, rules: input.rules === undefined ? [] : input.rules, evidence: input.evidence, research: input.research, performance: input.performance });
}

// Scope and boards select a candidate universe; only explicit predicates persist.
function createEntryConditions(input, now = new Date()) {
  if (input == null) return null;
  if (plain(input) && own(input, 'version')) {
    if (!validEntryConditions(input)) throw Error('已保存开仓条件版本或格式无效');
    return freeze(clone(input));
  }
  const query = queryOf(input), date = new Date(now), source = sourceCopy(input.source);
  if (!Number.isFinite(date.getTime())) throw Error('开仓条件保存时间无效');
  if (!query.research?.enabled) delete query.research;
  if (!query.performance?.enabled) delete query.performance;
  if (!query.rules.length && !query.excludeST && !query.evidence && !query.research && !query.performance) return null;
  return freeze({ version: 1, savedAt: date.toISOString(), rules: clone(query.rules), excludeST: query.excludeST,
    ...(query.evidence ? { evidence: clone(query.evidence) } : {}), ...(query.research ? { research: clone(query.research) } : {}), ...(query.performance ? { performance: clone(query.performance) } : {}),
    labels: describe(query).slice(1), ...(source === undefined ? {} : { source }) });
}
function validEntryConditions(saved) {
  if (saved == null) return true;
  try {
    if (!plain(saved) || saved.version !== 1 || Object.keys(saved).some(key => !['version', 'savedAt', 'rules', 'excludeST', 'evidence', 'research', 'performance', 'labels', 'source'].includes(key))
      || typeof saved.savedAt !== 'string' || !Number.isFinite(Date.parse(saved.savedAt)) || new Date(saved.savedAt).toISOString() !== saved.savedAt
      || !Array.isArray(saved.rules) || typeof saved.excludeST !== 'boolean' || !Array.isArray(saved.labels)) return false;
    const normalized = createEntryConditions({ rules: saved.rules, excludeST: saved.excludeST, evidence: saved.evidence, research: saved.research, performance: saved.performance, source: saved.source }, new Date(saved.savedAt));
    return normalized !== null && JSON.stringify(normalized.rules) === JSON.stringify(saved.rules)
      && JSON.stringify(normalized.evidence) === JSON.stringify(saved.evidence) && JSON.stringify(normalized.research) === JSON.stringify(saved.research) && JSON.stringify(normalized.performance) === JSON.stringify(saved.performance)
      && JSON.stringify(normalized.labels) === JSON.stringify(saved.labels);
  } catch { return false; }
}
function entryConditionNeedsFundamentals(saved) {
  return saved != null && validEntryConditions(saved) && (saved.research?.enabled && saved.research.path === 'company'
    || saved.rules.some(rule => fieldsOf(rule).some(field => FIELDS[field].source === 'finance' || ['pe', 'pb', 'marketCap', 'floatCap'].includes(field))));
}

function quoteIssue(q, symbol, now) {
  if (!q || q.symbol !== symbol) return '行情股票代码不符或行情缺失';
  if (!validAge(q.timestamp, now.getTime(), 90000) || q.date !== cnTime(now).date || cnTime(q.timestamp).date !== q.date) return '行情时间未知、超过 90 秒或不是当日报价';
  return '';
}
function technicalRow(snapshot, q, symbol, now) {
  if (!snapshot || snapshot.error) throw Error(snapshot?.error || '完整日线尚未获取');
  if (!validAge(snapshot.fetchedAt, now.getTime(), 180000)) throw Error('完整日线缓存超过 3 分钟或时间无效');
  const issue = quoteIssue(q, symbol, now); if (issue) throw Error(issue);
  const t = snapshot.technical, today = cnTime(now);
  if (!t || !validDate(t.asOf) || t.asOf > today.date || t.asOf > q.date || (t.asOf === today.date && today.minutes < 900)) throw Error('技术指标包含未完成日线或日线日期无效');
  if (Array.isArray(t.dates) && t.dates.some(date => !validDate(date) || date > t.asOf)) throw Error('技术指标包含无效或未完成的日线日期');
  const reference = t.asOf === q.date ? q.price : q.prevClose;
  if (!Number.isFinite(t.close) || !(t.close > 0) || !Number.isFinite(reference) || Math.abs(t.close - reference) > 0.011) throw Error('日线与行情价格基准不一致，等待完整未复权日线');
  return { ...t, dailyVolumeRatio: t.volumeRatio };
}
function financeRow(snapshot, symbol, now) {
  const result = snapshot?.finance;
  if (!result || result.error || result.status !== 'ready') throw Error('财务资料缺失或获取失败');
  if (result.source !== '东方财富') throw Error('财务资料来源无法验证');
  if (!validAge(result.fetchedAt, now.getTime(), 21600000)) throw Error('财务资料超过 6 小时或获取时间无效');
  return normalizeFinance(result, symbol, now, now, { notices: snapshot?.notices });
}
function valuationRow(snapshot, symbol, now) {
  const result = snapshot?.valuation;
  if (!result || result.error || result.status !== 'ready' || result.symbol !== symbol || result.section !== 'valuation' || result.source !== '东方财富') throw Error('动态估值资料缺失或股票、模块、来源无法验证');
  if (!validAge(result.fetchedAt, now.getTime(), 90000) || !validAge(result.data?.quoteTime, now.getTime(), 90000) || cnTime(result.data.quoteTime).date !== cnTime(now).date) throw Error('动态估值行情超过 90 秒或时间无效');
  const row = { ...result.data };
  for (const field of ['marketCap', 'floatCap']) row[field] = Number.isFinite(row[field]) ? row[field] / 1e8 : null;
  return row;
}

function evaluateEntryConditions(saved, inputSymbol, q, snapshot, inputNow = new Date()) {
  const now = new Date(inputNow), checks = [];
  let researchReview, performanceReview, industryReview;
  const finish = () => {
    const status = checks.some(item => item.status === 'failed') ? 'failed' : checks.some(item => item.status === 'pending') ? 'pending' : 'pass';
    let conditions = null;
    try { if (saved != null) conditions = clone(saved); } catch {}
    return { status, passed: status === 'pass', reasons: checks.filter(item => item.status !== 'pass').map(item => `${item.label}：${item.reason}`), checks,
      checkedAt: Number.isFinite(now.getTime()) ? now.toISOString() : null, conditions, ...(researchReview ? { researchReview } : {}), ...(performanceReview ? { performanceReview } : {}), ...(industryReview ? { industryReview } : {}) };
  };
  const pending = (label, reason, expected = '资料有效后重新判断') => checks.push({ label, actual: null, expected, status: 'pending', reason });
  if (!validEntryConditions(saved)) { pending('附加开仓条件', '已保存条件版本或格式无效，需重新从选股结果加入'); return finish(); }
  if (saved == null) return finish();
  if (!Number.isFinite(now.getTime())) { pending('附加开仓条件', '检查时间无效'); return finish(); }
  let symbol;
  try { symbol = symbolOf(inputSymbol); } catch { pending('附加开仓条件', '股票代码无效'); return finish(); }
  const memo = new Map();
  const cached = (key, load) => { if (!memo.has(key)) { try { memo.set(key, { row: load() }); } catch (error) { memo.set(key, { error: error.message }); } } const value = memo.get(key); if (value.error) throw Error(value.error); return value.row; };
  const valueFor = field => {
    if (FIELDS[field].source === 'finance') {
      const row = cached('finance', () => financeRow(snapshot, symbol, now));
      if (row.financeFieldChecks?.[field]?.status === 'pending') throw Error(row.financeFieldChecks[field].reason);
      const pendingReport = pendingFinanceReport(snapshot?.notices, symbol, now, row, field);
      if (pendingReport) throw Error(reportSyncReason(pendingReport));
      return row;
    }
    if (FIELDS[field].source === 'daily') return cached('daily', () => technicalRow(snapshot, q, symbol, now));
    const issue = quoteIssue(q, symbol, now); if (issue) throw Error(issue);
    const metrics = q.screeningMetrics;
    if (metrics != null) {
      if (!plain(metrics) || metrics.symbol !== symbol || metrics.timestamp !== q.timestamp || !['腾讯财经', '东方财富', '东方财富公开行情', '腾讯财经公开行情（新浪证券列表）'].includes(metrics.source)) throw Error('选股行情指标的股票、来源或报价时间无法验证');
      if (own(metrics, field)) return metrics;
    }
    if (['price', 'changePct', 'turnover', 'amount', 'volume'].includes(field)) {
      if (field === 'volume' && symbol.startsWith('sh688')) throw Error('科创板成交量单位未核验，等待完整选股行情指标');
      const value = q[field];
      return { [field]: Number.isFinite(value) ? value / ({ amount: 1e8, volume: 1e6 }[field] || 1) : null };
    }
    // Tencent q.pe is not the dynamic PE used by the screener.
    if (['pe', 'pb', 'marketCap', 'floatCap'].includes(field)) return cached('valuation', () => valuationRow(snapshot, symbol, now));
    return {};
  };
  if (saved.excludeST) {
    const issue = quoteIssue(q, symbol, now), name = q?.name;
    if (issue || typeof name !== 'string' || !name.trim()) pending('排除 ST / *ST / 退市标记', issue || '股票名称缺失，无法核验 ST / 退市标记');
    else { const passed = !/ST|退/i.test(name); checks.push({ label: '排除 ST / *ST / 退市标记', actual: name, expected: '无 ST / *ST / 退市标记', status: passed ? 'pass' : 'failed', reason: passed ? '当前名称无 ST / 退市标记' : '当前股票名称存在 ST / 退市标记' }); }
  }
  for (const rule of saved.rules) {
    const label = FIELDS[rule.field].label, expected = `${OPS[rule.op]} ${rule.valueField ? FIELDS[rule.valueField].label : amount(rule.value, rule.field)}`;
    try {
      const values = fieldsOf(rule).map(field => { const row = valueFor(field); if (!fieldAvailable(row, field)) throw Error(`${FIELDS[field].label}缺失、单位不明或数值无效${field.startsWith('annual') && row.financeAnnualReason ? `；${row.financeAnnualReason}` : ''}`); return row[field]; });
      const actual = amount(values[0], rule.field), right = rule.valueField ? values[1] : rule.value, passed = compare(values[0], rule.op, right);
      const requirement = rule.valueField ? `${expected}（${amount(right, rule.valueField)}）` : expected;
      checks.push({ label, actual, expected: requirement, status: passed ? 'pass' : 'failed', reason: `当前 ${actual}，要求 ${requirement}${passed ? '，已通过' : '，未通过'}` });
    } catch (error) { pending(label, error.message, expected); }
  }
  if (saved.research?.enabled) {
    try {
      let company = null, companyError = null;
      try { company = { ...financeRow(snapshot, symbol, now), symbol }; } catch (error) { companyError = error.message; }
      researchReview = evaluateOperatingResearch(snapshot?.automaticEvidence, saved.research, { company, companyError, symbol, now, notices: snapshot?.notices });
      const assessment = researchReview.assessment;
      checks.push({ key: 'research', label: assessment.label, actual: assessment.status === 'pass' ? '符合所选指标' : '指标条件未满足',
        expected: '明确选择的经营指标条件', status: assessment.status, reason: assessment.reasons.join('；') || '所选经营指标条件已满足' });
    } catch (error) { pending('经营指标条件', error.message); }
  }
  if (saved.performance?.enabled) {
    try {
      const noticeReview = checkNoticeWithEvidence(snapshot?.notices, symbol, snapshot?.automaticEvidence, now);
      performanceReview = evaluatePerformanceRules(saved.performance, noticeReview, { symbol, now });
      checks.push({ key: 'performance', label: performanceReview.label, actual: performanceReview.status === 'pass' ? '符合所选业绩条件' : '业绩条件未满足',
        expected: '明确选择的预告/快报条件', status: performanceReview.status, reason: performanceReview.reasons.join('；') || '所选业绩预告/快报条件已满足' });
    } catch (error) { pending('业绩预告/快报条件', error.message); }
  }
  if (saved.evidence) {
    try {
      if (usesAutomaticEvidence(saved)) {
        const bundle = snapshot?.automaticEvidence;
        if (!bundle || bundle.symbol !== symbol) throw Error('当前公开研究资料缺失或股票代码不符');
        const checkedAt = typeof bundle.checkedAt === 'string' ? Date.parse(bundle.checkedAt) : bundle.checkedAt;
        if (!validAge(checkedAt, now.getTime(), 21600000)) throw Error('公开研究资料检查已超过 6 小时或时间无效，等待程序重新获取');
        // Recompute from the source bundle, never trust a saved positive verdict.
        const evaluation = evaluateCompanyEvidence(bundle, saved.evidence, now);
        industryReview = evaluation.industryReview;
        for (const check of evaluation.checks) checks.push({ label: check.label, actual: check.status === 'pass' ? '程序核验通过' : check.status === 'fail' ? '程序核验不符' : '资料不足', expected: '公开披露原文支持', status: check.status === 'fail' ? 'failed' : check.status, reason: check.reason });
        return finish();
      }
      const current = snapshot?.selectionEvidence;
      const checkedAt = typeof current?.checkedAt === 'string' ? Date.parse(current.checkedAt) : current?.checkedAt;
      if (!current || current.error || !validAge(checkedAt, now.getTime(), 90000) || !Array.isArray(current.records)) throw Error(current?.error || '当前研究证据未重新读取、已过期或格式无效');
      if (current.records.some(record => !record || symbolOf(record.symbol) !== symbol)) throw Error('研究证据股票代码不符');
      const evaluation = evaluateEvidence(current.records, saved.evidence, now);
      industryReview = evaluation.industryReview;
      for (const check of evaluation.checks) checks.push({ label: check.label, actual: check.status === 'pass' ? '证据支持' : check.status === 'fail' ? '证据不支持' : '待核验', expected: '当前有效证据支持', status: check.status === 'fail' ? 'failed' : check.status, reason: check.reason });
    } catch (error) {
      if (saved.evidence.industry) industryReview = { version: 1, scope: saved.evidence.industry.scope, checkedAt: now.toISOString(), status: 'pending', reason: error.message, rows: [] };
      pending('研究证据条件', error.message);
    }
  }
  return finish();
}

module.exports = { createEntryConditions, validEntryConditions, entryConditionNeedsFundamentals, evaluateEntryConditions, usesAutomaticEvidence };
