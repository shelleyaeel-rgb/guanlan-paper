'use strict';
const { cnTime, symbolOf } = require('./common.cjs');
const { safeEvidenceUrl } = require('./selection-evidence.cjs');
const { refreshFinanceSnapshot } = require('./finance-validity.cjs');

const RESEARCH_RULE_VERSION = 1;
const RESEARCH_OPS = Object.freeze({ gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' });
const VOLUME_UNITS = Object.freeze(['吨', '万吨', '千克', '克', '台', '万台', '件', '万件', '套', '万套', '只', '万只', '个', '万个', '条', '万条', '平方米', '万平方米', '立方米', '万立方米', '亿立方米', '十亿立方英尺', '桶', '万桶', '百万桶', '升', '万升', '千升', '千瓦时', '万千瓦时', '亿千瓦时']);
const PRODUCT_RESEARCH_FIELDS = Object.freeze({
  currentRevenue: { label: '产品收入', unit: '元', min: 0, description: '最新完整报告期同一产品披露收入；人民币元，不代替公司收入。' },
  revenueSharePct: { label: '产品收入占比', unit: '%', min: 0, max: 100, description: '同期间同合并范围的产品收入÷公司收入×100。' },
  revenueGrowthPct: { label: '产品收入同比', unit: '%', min: -100, description: '同产品同口径本期与上年同期收入比较；收入增长不直接等于需求增长。' },
  currentSalesVolume: { label: '产品销量', unit: null, min: 0, units: VOLUME_UNITS, description: '最新完整报告期实际销量；条件必须指定与原披露相同的单位，不自动换算。' },
  salesGrowthPct: { label: '产品销量同比', unit: '%', min: -100, description: '同产品、同单位、本期与上年同期销量比较；生产量和订单不能替代销量。' },
  grossMarginPct: { label: '产品毛利率', unit: '%', max: 100, description: '同产品收入减成本后除以收入；普通毛利不等于竞争优势。' },
  grossMarginChangePp: { label: '产品毛利率同比变化', unit: '百分点', description: '本期产品毛利率减上年同期毛利率，按百分点比较。' }
});
const COMPANY_RESEARCH_FIELDS = Object.freeze({
  revenueYoY: { label: '公司营收同比', unit: '%', description: '最新已公告累计报告期的数据源营业收入同比；不代表某一产品需求。' },
  adjustedProfitYoY: { label: '公司扣非净利润同比', unit: '%', description: '最新已公告累计报告期的数据源扣非归母净利润同比；依数据源同比口径，不宣称已重新核算基期。' },
  latestAdjustedProfit: { label: '公司扣非净利润', unit: '亿元', description: '最新已公告累计报告期扣非归母净利润，人民币亿元，负值保留。' },
  operatingCash: { label: '公司经营现金流净额', unit: '亿元', description: '最新已公告累计报告期经营活动现金流量净额，人民币亿元，非TTM。' }
});
const RESEARCH_METADATA = Object.freeze({ version: RESEARCH_RULE_VERSION, fields: { product: PRODUCT_RESEARCH_FIELDS, company: COMPANY_RESEARCH_FIELDS }, ops: RESEARCH_OPS, volumeUnits: VOLUME_UNITS });
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const compare = (left, op, right) => ({ gt: left > right, gte: left >= right, lt: left < right, lte: left <= right, eq: left === right })[op];
const aggregate = checks => checks.some(check => check.status === 'failed') ? 'failed' : checks.some(check => check.status === 'pending') ? 'pending' : 'pass';
const fieldsFor = path => path === 'product' ? PRODUCT_RESEARCH_FIELDS : COMPANY_RESEARCH_FIELDS;
// This is a minimum report-coverage check, not evidence that the provider has
// already supplied every newer quarterly filing.
function minimumCoveredReportDate(today) {
  const year = Number(today.slice(0, 4));
  return today.slice(5) >= '09-01' ? `${year}-06-30` : `${year - (today.slice(5) < '05-01' ? 2 : 1)}-12-31`;
}

function validateResearchRules(input) {
  if (input == null) return undefined;
  if (!plain(input) || Object.keys(input).some(key => !['version', 'enabled', 'path', 'rules'].includes(key)) || input.version !== RESEARCH_RULE_VERSION
    || typeof input.enabled !== 'boolean' || !['product', 'company'].includes(input.path) || !Array.isArray(input.rules) || input.rules.length > 30) throw Error('经营研究条件格式或版本无效');
  if (input.enabled && !input.rules.length) throw Error('启用经营研究条件前请至少添加一条明确条件');
  const fields = fieldsFor(input.path), rules = [];
  for (const rule of input.rules) {
    if (!plain(rule) || Object.keys(rule).some(key => !['field', 'op', 'value', 'unit'].includes(key)) || typeof rule.field !== 'string' || !own(fields, rule.field)
      || typeof rule.op !== 'string' || !own(RESEARCH_OPS, rule.op) || typeof rule.value !== 'number' || !Number.isFinite(rule.value) || Math.abs(rule.value) > 1e15) throw Error('经营研究指标、比较符或数值无效');
    const field = fields[rule.field];
    if (field.min != null && rule.value < field.min || field.max != null && rule.value > field.max) throw Error(`${field.label}条件超出指标的数学范围`);
    if (rule.field === 'currentSalesVolume') {
      if (!VOLUME_UNITS.includes(rule.unit)) throw Error('产品销量条件必须指定支持的原披露单位');
    } else if (own(rule, 'unit') && rule.unit !== field.unit) throw Error(`${field.label}条件单位应为${field.unit}`);
    const normalized = { field: rule.field, op: rule.op, value: rule.value, ...(rule.field === 'currentSalesVolume' ? { unit: rule.unit } : {}) };
    if (!rules.some(existing => JSON.stringify(existing) === JSON.stringify(normalized))) rules.push(normalized);
  }
  for (const [name, field] of Object.entries(fields)) {
    const selected = rules.filter(rule => rule.field === name);
    if (new Set(selected.map(rule => rule.unit)).size > 1) throw Error('同一产品销量的条件不能混用单位');
    const lows = selected.filter(rule => ['gt', 'gte', 'eq'].includes(rule.op)), highs = selected.filter(rule => ['lt', 'lte', 'eq'].includes(rule.op));
    for (const low of lows) for (const high of highs) if (low.value > high.value || low.value === high.value && (low.op === 'gt' || high.op === 'lt')) throw Error(`${field.label}条件相互矛盾`);
  }
  return { version: RESEARCH_RULE_VERSION, enabled: input.enabled, path: input.path, rules };
}

function describeResearchRules(input) {
  const query = validateResearchRules(input);
  if (!query) return [];
  if (!query.enabled) return ['经营研究仅观察，未作为筛选条件'];
  const fields = fieldsFor(query.path), prefix = query.path === 'product' ? '同一产品' : '公司经营';
  return [`${prefix}条件：${query.rules.map(rule => `${fields[rule.field].label} ${RESEARCH_OPS[rule.op]} ${rule.value} ${rule.unit || fields[rule.field].unit}`).join('；')}`];
}

function buildCompanyMetrics(normalized, { symbol: inputSymbol, now: inputNow = new Date() } = {}) {
  const now = new Date(inputNow), symbol = symbolOf(inputSymbol || normalized?.symbol), today = Number.isFinite(now.getTime()) ? cnTime(now).date : '';
  const source = normalized?.financeSource, reportDate = normalized?.financeReportDate, noticeDate = normalized?.financeNoticeDate, updateDate = normalized?.financeUpdateDate;
  let issue = '';
  if (!today) issue = '公司经营指标评估时间无效';
  else if (!plain(normalized) || normalized.symbol !== symbol) issue = '公司经营数据股票身份不符或未明确';
  const refreshed = refreshFinanceSnapshot(normalized, symbol, now);
  if (!issue) issue = refreshed.financeFieldChecks.revenueYoY.reason && refreshed.financeFieldChecks.revenueYoY.rawValue !== null
    ? refreshed.financeFieldChecks.revenueYoY.reason : '';
  const sourceRefs = issue ? [] : [{ source, reportDate, publishedAt: noticeDate, updateDate: updateDate || null, fetchedAt: normalized.financeFetchedAt,
    reportVersion: normalized.financeReportVersion || [reportDate, noticeDate, updateDate || noticeDate].join('/'), basis: 'latest-disclosed-cumulative' }];
  const metrics = Object.fromEntries(Object.entries(COMPANY_RESEARCH_FIELDS).map(([field, metadata]) => {
    const checked = refreshed.financeFieldChecks[field], value = checked.rawValue, currencyIssue = metadata.unit === '亿元' && normalized?.financeCurrency !== 'CNY' ? '金额币种未确认人民币，不能按亿元比较' : '';
    const reason = issue || currencyIssue || checked.reason;
    return [field, { value, unit: metadata.unit, status: reason ? 'not-extracted' : 'available', usable: !reason,
      verification: reason ? null : 'provider-reported', reason, reasonCode: issue ? 'invalid-source' : currencyIssue ? 'incomparable-currency' : reason ? 'missing-value' : '', sourceRefs,
      definition: metadata.description }];
  }));
  return { version: '1', symbol, status: issue || Object.values(metrics).some(metric => !metric.usable) ? 'pending' : 'ready', checkedAt: today ? now.toISOString() : null, reportDate: reportDate || null, metrics,
    limitation: '公司经营指标只能判断公司整体，不能替代产品收入、销量或竞争优势；金额为已公告累计期间，非TTM', ...(issue ? { reason: issue } : {}) };
}

function snapshotIssue(snapshot, symbol, now) {
  if (!plain(snapshot) || snapshot.symbol !== symbol) return '指标资料缺失或股票身份不符';
  const checkedAt = typeof snapshot.checkedAt === 'number' ? snapshot.checkedAt : Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > now.getTime() || now.getTime() - checkedAt > 21600000) return '指标评估时间无效、晚于当前时点或超过6小时';
  if (snapshot.integrityIssue) return String(snapshot.integrityIssue);
  return '';
}

function evaluateMetricRules(rules, metrics, { path, reportDate, symbol, now, issue = '' }) {
  const today = cnTime(now).date, fields = fieldsFor(path);
  return rules.map(rule => {
    const field = fields[rule.field], cell = metrics?.[rule.field], expectedUnit = rule.unit || field.unit;
    const expected = `${RESEARCH_OPS[rule.op]} ${rule.value} ${expectedUnit}`;
    let reason = issue, reasonCode = issue ? 'invalid-source' : '';
    const refs = Array.isArray(cell?.sourceRefs) ? cell.sourceRefs : Array.isArray(cell?.records) ? cell.records : [];
    if (!reason && (!validDate(reportDate) || reportDate > today)) { reason = '指标所属报告期无效或晚于评估时点'; reasonCode = 'invalid-period'; }
    if (!reason && (cell?.status !== 'available' || cell.usable !== true || !Number.isFinite(cell.value))) { reason = cell?.reason || '该指标尚无可用于判断的数值；不以缺失值代替零'; reasonCode = cell?.reasonCode || 'missing-value'; }
    if (!reason && cell.unit !== expectedUnit) { reason = `指标原单位为${cell.unit || '未知'}，条件单位为${expectedUnit}，不能自动混用或换算`; reasonCode = 'incomparable-unit'; }
    if (!reason && !(path === 'company' ? ['provider-reported'] : ['source-verified', 'calculated']).includes(cell.verification)) { reason = '指标尚未完成适用口径核验，不能只凭披露百分比或冲突数据执行条件'; reasonCode = 'unverified-value'; }
    if (!reason && (!refs.length || refs.some(ref => !plain(ref) || !validDate(ref.reportDate) || !validDate(ref.publishedAt)
      || ref.reportDate > ref.publishedAt || ref.publishedAt > today || ref.updateDate && (!validDate(ref.updateDate) || ref.updateDate > today)
      || path === 'product' && (!safeEvidenceUrl(ref.url) || typeof ref.quote !== 'string' || !ref.quote.trim())
      || path === 'company' && (typeof ref.source !== 'string' || !ref.source.trim() || !Number.isFinite(ref.fetchedAt) || ref.fetchedAt <= 0
        || ref.fetchedAt > now.getTime() || now.getTime() - ref.fetchedAt > 21600000)) || !refs.some(ref => ref.reportDate === reportDate))) {
      reason = '指标来源、统计期间或公告时点无法完整核验'; reasonCode = 'invalid-provenance';
    }
    if (!reason && (field.min != null && cell.value < field.min || field.max != null && cell.value > field.max)) { reason = '指标数值超出数学定义范围，需核对原始口径'; reasonCode = 'invalid-value'; }
    const status = reason ? 'pending' : compare(cell.value, rule.op, rule.value) ? 'pass' : 'failed';
    return { field: rule.field, label: field.label, rule: { ...rule }, actual: reason ? null : cell.value, unit: expectedUnit, expected, status,
      reason: reason || (status === 'pass' ? '满足明确选择的指标条件' : '不满足该指标条件；不代表产品或公司没有前景'), reasonCode,
      reportDate, symbol, sourceRefs: structuredClone(refs) };
  });
}

function evaluateResearchRules(input, data = {}, inputNow = new Date()) {
  const query = validateResearchRules(input), now = new Date(inputNow);
  if (!Number.isFinite(now.getTime())) throw Error('经营研究评估时间无效');
  const enabled = query?.enabled === true, path = query?.path || null;
  const base = { version: RESEARCH_RULE_VERSION, enabled, path, checkedAt: now.toISOString(), query: query || null, checks: [], productCandidates: [], selectedProduct: null,
    label: path === 'company' ? '公司经营条件' : path === 'product' ? '同一产品指标条件' : '经营研究观察',
    limitation: path === 'company' ? '结果仅表示公司经营条件是否满足，不能表述为产品前景已通过' : '结果仅表示已披露的同一产品指标是否满足所选条件，不是未来表现预测' };
  if (!enabled) return { ...base, status: 'observing', passed: null, blocksEntry: false, reasons: ['未启用经营研究条件，仅供观察'] };
  let symbol;
  try { symbol = symbolOf(data.symbol); } catch { return { ...base, status: 'pending', passed: false, blocksEntry: true, reasons: ['股票身份无效或缺失'] }; }
  const snapshot = path === 'product' ? data.productMetrics : data.companyMetrics;
  let issue = snapshotIssue(snapshot, symbol, now);
  if (path === 'company') {
    const checks = evaluateMetricRules(query.rules, snapshot?.metrics, { path, reportDate: snapshot?.reportDate, symbol, now, issue });
    const status = aggregate(checks);
    return { ...base, symbol, status, passed: status === 'pass', blocksEntry: status !== 'pass', checks, reasons: checks.filter(check => check.status !== 'pass').map(check => `${check.label}：${check.reason}`) };
  }
  const products = Array.isArray(snapshot?.products) ? snapshot.products : [];
  if (!issue && !validDate(snapshot?.reportDate)) issue = '产品指标集合缺少可核验的最新报告期';
  const identities = products.map(product => `${product?.subject}|${product?.reportDate}`);
  if (!issue && new Set(identities).size !== identities.length) issue = '同一产品同期间存在重复指标集合，需先核对冲突，不能择优放行';
  const productCandidates = products.map(product => {
    const identityIssue = typeof product?.subject !== 'string' || !product.subject.trim() || product.subject.length > 150 ? '产品主体未可靠识别' : '';
    const periodIssue = validDate(snapshot?.reportDate) && product?.reportDate !== snapshot.reportDate ? '产品指标不属于当前最新报告期，不能选用较旧结果放行' : '';
    const checks = evaluateMetricRules(query.rules, product?.metrics, { path, reportDate: product?.reportDate, symbol, now, issue: issue || identityIssue || periodIssue });
    return { subject: product?.subject || '', reportDate: product?.reportDate || null, status: aggregate(checks), checks };
  });
  const status = productCandidates.some(product => product.status === 'pass') ? 'pass' : !productCandidates.length || productCandidates.some(product => product.status === 'pending') ? 'pending' : 'failed';
  const selected = productCandidates.find(product => product.status === status);
  const reasons = status === 'pass' ? [] : !productCandidates.length ? [issue || '未可靠识别可供判断的产品指标，不能使用公司指标自动替代']
    : [...new Set(productCandidates.filter(product => product.status === status).flatMap(product => product.checks.filter(check => check.status !== 'pass').map(check => `产品「${product.subject}」${check.label}：${check.reason}`)))];
  return { ...base, symbol, status, passed: status === 'pass', blocksEntry: status !== 'pass', productCandidates, selectedProduct: selected?.subject || null, checks: selected?.checks || [], reasons };
}

module.exports = { RESEARCH_RULE_VERSION, RESEARCH_OPS, VOLUME_UNITS, PRODUCT_RESEARCH_FIELDS, COMPANY_RESEARCH_FIELDS, RESEARCH_METADATA,
  validateResearchRules, describeResearchRules, evaluateResearchRules, buildCompanyMetrics, minimumCoveredReportDate };
