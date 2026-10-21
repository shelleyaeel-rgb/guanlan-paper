const { isIP } = require('node:net');
const { cnTime, symbolOf } = require('./common.cjs');

const EVIDENCE_KINDS = Object.freeze({
  demand: { label: '需求增长', values: { supported: '有证据支持', unsupported: '缺乏需求支持', unknown: '资料不足' } },
  commercialization: { label: '产品商业化', values: { revenue: '已形成收入', production: '已量产', trial: '试验阶段', plan: '仅有规划', unknown: '资料不足' } },
  advantage: { label: '竞争优势', values: { verified: '已证实', unverified: '尚未证实', unknown: '资料不足' } },
  outlookRisk: { label: '产品重大反向证据复核', values: { clear: '已核验，无未解决重大反向证据', adverse: '存在重大不利证据', unknown: '尚待核验' } },
  financialReview: { label: '财务事项复核', values: { clear: '审计、偿债及财务模板适用性复核通过', adverse: '存在重大财务问题或模板不适用', unknown: '尚待核验' } },
  mainRank: { label: '主行业排名', values: { ranked: '有明确排名', unknown: '无法判断' } },
  segmentRank: { label: '细分行业排名', values: { ranked: '有明确排名', unknown: '无法判断' } }
});
const EVIDENCE_CONDITIONS = Object.freeze({ productOutlook: '产品前景有证据支持', demand: '需求增长有依据', commercialization: '产品已商业化', advantage: '竞争优势已证实', financialReview: '财务事项复核通过' });
const OUTLOOK_KINDS = ['demand', 'commercialization', 'advantage', 'outlookRisk'];
const POSITIVE = { demand: ['supported'], commercialization: ['revenue', 'production'], advantage: ['verified'], outlookRisk: ['clear'], financialReview: ['clear'] };
const LEADERSHIP = { either: '主行业前三或重要细分行业龙头', mainTop3: '主行业前三', segmentLeader: '重要细分行业龙头' };
const LEADERSHIP_GEOGRAPHIES = new Set(['中国', '全国', '中国大陆', '中国市场', '中国大陆市场', '国内', '全球', '全球市场', 'china', 'global']);
const geographyScope = value => ['全球', '全球市场', 'global'].includes(value.toLowerCase()) ? 'global' : LEADERSHIP_GEOGRAPHIES.has(value.toLowerCase()) ? 'china' : value;
const clone = value => JSON.parse(JSON.stringify(value));
const own = (object, key) => Object.hasOwn(object, key);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const INDUSTRY_METADATA = Object.freeze({
  version: 1, label: '行业原始指标', scopes: { main: '主营行业', segment: '细分业务', either: '任一路径满足' },
  fields: {
    mainRankMax: { label: '主营行业排名上限', unit: '名', min: 1, max: 100000, integer: true },
    segmentRankMax: { label: '细分业务排名上限', unit: '名', min: 1, max: 100000, integer: true },
    minSegmentRevenuePct: { label: '细分业务营收占比下限', unit: '%', min: 0, max: 100 }
  },
  defaults: { version: 1, scope: 'either', mainRankMax: 3, segmentRankMax: 1, minSegmentRevenuePct: 30 },
  limitation: '排名与营收占比是可编辑的筛选条件；须核验同一市场、地域、统计年度、指标和全行业范围。默认数值是产品规则，不是行业前景评分或收益预测。'
});

function validateIndustryRules(input) {
  if (input == null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input) || input.version !== 1
    || typeof input.scope !== 'string' || !Object.hasOwn(INDUSTRY_METADATA.scopes, input.scope)
    || Object.keys(input).some(key => !['version', 'scope', ...Object.keys(INDUSTRY_METADATA.fields)].includes(key))) throw Error('行业指标条件格式或版本无效');
  const rules = { version: 1, scope: input.scope };
  for (const [field, spec] of Object.entries(INDUSTRY_METADATA.fields)) {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max || spec.integer && !Number.isInteger(value)) throw Error(`${spec.label}应为 ${spec.min} 至 ${spec.max} 之间的${spec.integer ? '整数' : '数值'}`);
    rules[field] = value;
  }
  return rules;
}

function describeIndustryRules(input) {
  const rules = validateIndustryRules(input); if (!rules) return '';
  const main = `主营行业排名 ≤ ${rules.mainRankMax}`;
  const segment = `细分业务排名 ≤ ${rules.segmentRankMax} 且营收占比 ≥ ${rules.minSegmentRevenuePct}%`;
  return `行业指标：${rules.scope === 'main' ? main : rules.scope === 'segment' ? segment : `满足其一（${main}；${segment}）`}`;
}

function industryRulesForQuery(query) {
  if (query?.industry) return query.industry;
  if (!query?.leadership) return null;
  return { version: 1, scope: query.leadership === 'mainTop3' ? 'main' : query.leadership === 'segmentLeader' ? 'segment' : 'either',
    mainRankMax: 3, segmentRankMax: 1, minSegmentRevenuePct: query.minSegmentRevenuePct };
}

// This validation is also used immediately before opening a source in the browser.
function safeEvidenceUrl(input) {
  if (typeof input !== 'string' || input.length > 2048 || /[\u0000-\u0020\\]/.test(input)) return '';
  try {
    const url = new URL(input);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
    if (!host || /(^|\.)(localhost|local|internal|intranet|lan|home|test|invalid)$/.test(host)) return '';
    const ip = isIP(host);
    if (ip === 4) {
      const [a, b, c] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return '';
    } else if (ip === 6) {
      // Global unicast only; mapped/translated local IPv4 and reserved scopes are rejected.
      if (!/^[23][0-9a-f]{3}:/.test(host) || /^2001:db8:/i.test(host) || /^2002:/i.test(host)) return '';
    } else if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return '';
    return url.href;
  } catch { return ''; }
}

function validateEvidenceQuery(input) {
  if (input == null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) throw Error('证据筛选条件格式不正确');
  if (Object.keys(input).some(key => !['conditions', 'leadership', 'minSegmentRevenuePct', 'industry'].includes(key))) throw Error('存在不支持的证据筛选字段');
  const conditions = input.conditions ?? [];
  const leadership = input.leadership ?? '';
  if (!Array.isArray(conditions) || conditions.length > 5 || conditions.some(key => typeof key !== 'string' || !own(EVIDENCE_CONDITIONS, key))) throw Error('存在不支持的证据筛选条件');
  if (typeof leadership !== 'string' || (leadership && !own(LEADERSHIP, leadership))) throw Error('行业地位条件不正确');
  const industry = validateIndustryRules(input.industry);
  if (industry && leadership) throw Error('行业原始指标与旧行业地位条件不能同时启用');
  const minSegmentRevenuePct = input.minSegmentRevenuePct ?? 30;
  if (typeof minSegmentRevenuePct !== 'number' || !Number.isFinite(minSegmentRevenuePct) || minSegmentRevenuePct < 0 || minSegmentRevenuePct > 100) throw Error('细分业务营收占比应在 0 至 100 之间');
  if (!conditions.length && !leadership && !industry) return undefined;
  return { conditions: [...new Set(conditions)], leadership, minSegmentRevenuePct, ...(industry ? { industry } : {}) };
}

function describeEvidenceQuery(input) {
  const query = validateEvidenceQuery(input);
  if (!query) return [];
  const description = query.conditions.map(key => EVIDENCE_CONDITIONS[key]);
  if (query.leadership) description.push(LEADERSHIP[query.leadership] + (query.leadership !== 'mainTop3' ? `（细分业务营收占比 ≥ ${query.minSegmentRevenuePct}%，细分排名第 1）` : ''));
  if (query.industry) description.push(describeIndustryRules(query.industry));
  return description;
}

function textField(input, key, limit, required = false) {
  const value = input[key] == null ? '' : input[key];
  if (typeof value !== 'string' || value.length > limit || /\u0000/.test(value)) throw Error(`证据字段 ${key} 格式不正确`);
  if (required && !value.trim()) throw Error(`证据字段 ${key} 不能为空`);
  return value.trim();
}

// Drafts may lack provenance, but malformed dates/values/URLs are never persisted.
// Completeness and temporal validity are assessed separately at screening time.
function validateRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('证据记录格式不正确');
  const record = { symbol: symbolOf(input.symbol), kind: textField(input, 'kind', 40, true), subject: textField(input, 'subject', 150, true), value: textField(input, 'value', 40, true), reviewState: textField(input, 'reviewState', 30, true) };
  if (!own(EVIDENCE_KINDS, record.kind) || !own(EVIDENCE_KINDS[record.kind].values, record.value)) throw Error('证据类型或结论不正确');
  if (!['confirmed', 'draft', 'disputed'].includes(record.reviewState)) throw Error('证据复核状态不正确');
  if (input.id != null && input.id !== '') {
    if (typeof input.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.id)) throw Error('证据编号不正确');
    record.id = input.id;
  }
  for (const [key, limit] of [['sourceTitle', 300], ['url', 2048], ['period', 200], ['quote', 12000], ['notes', 12000]]) record[key] = textField(input, key, limit);
  if (record.url && !safeEvidenceUrl(record.url)) throw Error('证据来源只支持不含登录信息的公开 HTTP/HTTPS 地址');
  if (record.url) record.url = safeEvidenceUrl(record.url);
  for (const key of ['publishedAt', 'reviewedAt', 'validUntil']) {
    record[key] = textField(input, key, 10);
    if (record[key] && !validDate(record[key])) throw Error(`${key} 应为有效的 YYYY-MM-DD 日期`);
  }
  if (['mainRank', 'segmentRank'].includes(record.kind)) {
    for (const key of ['market', 'geography']) record[key] = textField(input, key, 200);
    record.metric = textField(input, 'metric', 30);
    record.coverage = textField(input, 'coverage', 30);
    if (record.metric && !['sales', 'volume', 'marketShare'].includes(record.metric)) throw Error('排名指标不正确');
    if (record.coverage && !['allCompetitors', 'listedOnly'].includes(record.coverage)) throw Error('排名覆盖范围不正确');
    for (const [key, min, max, integer] of [['rank', 1, 100000, true], ['statisticYear', 1900, 9999, true], ['revenueSharePct', 0, 100, false]]) {
      const value = input[key];
      if (value == null || value === '') { record[key] = null; continue; }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw Error(`${key} 数值不正确`);
      record[key] = value;
    }
  }
  return record;
}

function provenanceAvailability(record, today) {
  if (record.reviewState !== 'confirmed') return record.reviewState === 'disputed' ? '证据存在争议' : '证据尚未复核';
  if (['sourceTitle', 'url', 'period', 'quote', 'publishedAt', 'reviewedAt', 'validUntil'].some(key => !record[key])) return '来源、原文引用、期间或日期不完整';
  if (record.publishedAt > today || record.reviewedAt > today) return '发布或复核日期晚于评估日期';
  if (record.reviewedAt < record.publishedAt || record.validUntil < record.reviewedAt) return '证据日期顺序不合理';
  if (record.validUntil < today) return '证据已过期';
  return '';
}
function availability(record, today) {
  const provenanceIssue = provenanceAvailability(record, today);
  if (provenanceIssue) return provenanceIssue;
  if (record.value === 'unknown') return '结论为资料不足';
  if (record.kind === 'advantage' && record.value === 'unverified') return '竞争优势尚未证实';
  if (['mainRank', 'segmentRank'].includes(record.kind)) {
    if (!record.rank || !record.market || !record.geography || !record.metric || !record.statisticYear || !record.coverage) return '排名的市场、地域、指标、年度或名次不完整';
    if (!LEADERSHIP_GEOGRAPHIES.has(record.geography.toLowerCase())) return '该条件只认可全国或全球市场排名；区域或范围不明确的排名需补充核验';
    if (record.coverage !== 'allCompetitors') return '仅上市公司排名不能证明全行业地位';
    if (record.statisticYear > Number(record.publishedAt.slice(0, 4)) || record.statisticYear > Number(today.slice(0, 4))) return '排名年度晚于发布或评估年度';
    if (record.kind === 'segmentRank' && record.revenueSharePct == null) return '缺少细分业务营收占比';
  }
  return '';
}
function andStatus(statuses) { return statuses.includes('fail') ? 'fail' : statuses.includes('pending') ? 'pending' : 'pass'; }
function orStatus(statuses) { return statuses.includes('pass') ? 'pass' : !statuses.length || statuses.includes('pending') ? 'pending' : 'fail'; }
function check(key, label, status, reason, records) { return { key, label, status, reason, records: clone(records) }; }

function assess(records, key, label, today, positive) {
  if (records.some(record => record.reviewState === 'disputed')) return check(key, label, 'pending', '相关证据存在未解决争议，需要复核', records);
  const eligible = records.filter(record => !availability(record, today));
  const pendingReasons = [...new Set(records.map(record => availability(record, today)).filter(Boolean))];
  if (!eligible.length) return check(key, label, 'pending', pendingReasons.join('；') || '尚无对应证据', records);
  const assessedDate = record => record.reviewedAt > record.publishedAt ? record.reviewedAt : record.publishedAt;
  const unresolved = records.filter(record => (record.value === 'unknown' || (record.kind === 'advantage' && record.value === 'unverified')) && !provenanceAvailability(record, today));
  if (unresolved.some(record => {
    const known = eligible.filter(item => item.subject === record.subject);
    return !known.length || assessedDate(record) >= known.map(assessedDate).sort().at(-1);
  })) return check(key, label, 'pending', '同一判断对象的最新已复核资料仍为资料不足或尚未证实，不能沿用较早肯定结论', records);
  const positiveRecords = eligible.filter(positive);
  if (positiveRecords.length && positiveRecords.length !== eligible.length) return check(key, label, 'pending', '有效证据结论相互冲突，需要复核', records);
  const status = positiveRecords.length ? 'pass' : 'fail';
  return check(key, label, status, status === 'pass' ? '现有有效证据支持此条件' : '现有有效证据不满足此条件', records);
}

function productCheck(records, condition, today) {
  const kinds = condition === 'productOutlook' ? OUTLOOK_KINDS : [condition];
  const relevant = records.filter(record => kinds.includes(record.kind));
  const subjects = [...new Set(relevant.map(record => record.subject))];
  const alternatives = subjects.map(subject => {
    const parts = kinds.map(kind => assess(relevant.filter(record => record.subject === subject && record.kind === kind), kind, EVIDENCE_KINDS[kind].label, today, record => POSITIVE[kind].includes(record.value)));
    return { subject, status: andStatus(parts.map(part => part.status)), parts };
  });
  const status = orStatus(alternatives.map(item => item.status));
  const candidate = alternatives.find(item => item.status === status);
  const reason = candidate ? `产品「${candidate.subject}」：${candidate.parts.map(part => `${part.label}：${part.reason}`).join('；')}` : '尚无对应产品证据';
  return check(condition, EVIDENCE_CONDITIONS[condition], status, reason, relevant);
}

function rankCheck(records, kind, query, today, rows = []) {
  const relevant = records.filter(record => record.kind === kind);
  const rules = industryRulesForQuery(query);
  // Free-form subject labels do not create different statistical universes.
  const scopeOf = record => JSON.stringify([record.market, geographyScope(record.geography), record.metric]);
  const scopes = [...new Set(relevant.map(scopeOf))];
  const parts = scopes.map(scope => {
    const scoped = relevant.filter(record => scopeOf(record) === scope);
    const scopeRecords = records.filter(record => ['mainRank', 'segmentRank'].includes(record.kind) && scopeOf(record) === scope);
    const years = scopeRecords.map(record => record.statisticYear).filter(Number.isInteger);
    const latestYear = years.length ? Math.max(...years) : null;
    const latest = latestYear == null ? scoped : scoped.filter(record => record.statisticYear === latestYear);
    const assessed = assess(latest, kind, EVIDENCE_KINDS[kind].label, today, record => kind === 'mainRank'
      ? record.rank <= rules.mainRankMax : record.rank <= rules.segmentRankMax && record.revenueSharePct >= rules.minSegmentRevenuePct);
    const eligible = latest.filter(record => !availability(record, today));
    const rankEvidence = scopeRecords.filter(record => record.statisticYear === latestYear && !availability({ ...record, kind: 'mainRank' }, today));
    const rankConflict = new Set(rankEvidence.map(record => record.rank)).size > 1;
    const shareConflict = kind === 'segmentRank' && new Set(eligible.map(record => record.revenueSharePct)).size > 1;
    if (rankConflict || shareConflict) {
      assessed.status = 'pending';
      assessed.reason = `${[rankConflict ? '同年度同口径排名冲突' : '', shareConflict ? '同口径细分营收占比冲突' : ''].filter(Boolean).join('；')}，需要复核全部原始值`;
    }
    if (latestYear != null) assessed.reason = `采用 ${latestYear} 年排名${latest.length < scoped.length ? '，旧年度记录仅保留追溯' : ''}；${assessed.reason}`;
    assessed.records = clone(scoped);
    for (const record of scoped) {
      const reason = !latest.includes(record) ? `历史 ${record.statisticYear} 年记录仅保留追溯，本次采用 ${latestYear} 年` : availability(record, today) || assessed.reason;
      const status = !latest.includes(record) || availability(record, today) ? 'pending' : assessed.status;
      rows.push({ statisticYear: record.statisticYear, market: record.market, geography: record.geography, metric: record.metric, rank: record.rank,
        revenueSharePct: record.revenueSharePct, sourceRelation: 'manual-record', coverage: record.coverage, status, reason,
        mainStatus: kind === 'mainRank' ? status : 'pending', segmentStatus: kind === 'segmentRank' ? status : 'pending', records: clone([record]) });
    }
    return assessed;
  });
  const status = orStatus(parts.map(part => part.status));
  const label = query.industry ? kind === 'mainRank' ? `主营行业排名 ≤ ${rules.mainRankMax}` : `细分排名 ≤ ${rules.segmentRankMax} 且营收占比 ≥ ${rules.minSegmentRevenuePct}%`
    : kind === 'mainRank' ? '主行业前三' : `细分排名第 1 且营收占比 ≥ ${query.minSegmentRevenuePct}%`;
  return check(kind, label, status, parts.filter(part => part.status === status).map(part => part.reason).join('；') || '尚无对应排名证据', relevant);
}

function evaluateEvidence(inputRecords, inputQuery, now = new Date()) {
  const query = validateEvidenceQuery(inputQuery);
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw Error('证据评估日期不正确');
  const checkedAt = date.toISOString(), today = cnTime(date).date;
  if (!query) return { status: 'pass', checks: [], checkedAt, query: null, records: [] };
  if (!Array.isArray(inputRecords)) throw Error('证据记录应为数组');
  const records = [], invalid = [];
  for (const input of inputRecords) {
    try { records.push(validateRecord(input)); }
    catch (error) { invalid.push({ reason: error.message }); }
  }
  const symbols = new Set(records.map(record => record.symbol));
  if (symbols.size > 1) throw Error('一次只能评估一家公司的证据');
  const checks = []; let industryReview;
  const productConditions = query.conditions.filter(key => key !== 'financialReview');
  for (const condition of productConditions) checks.push(productCheck(records, condition, today));
  // Separate passes from different products cannot be stitched into one product thesis.
  if (productConditions.length > 1) {
    const kinds = [...new Set(productConditions.flatMap(key => key === 'productOutlook' ? OUTLOOK_KINDS : [key]))];
    const relevant = records.filter(record => kinds.includes(record.kind));
    const subjects = [...new Set(relevant.map(record => record.subject))];
    const alternatives = subjects.map(subject => ({ subject, status: andStatus(kinds.map(kind => assess(relevant.filter(record => record.subject === subject && record.kind === kind), kind, EVIDENCE_KINDS[kind].label, today, record => POSITIVE[kind].includes(record.value)).status)) }));
    const status = orStatus(alternatives.map(item => item.status));
    checks.push(check('sameProduct', '所有产品条件须对应同一产品', status, status === 'pass' ? `产品「${alternatives.find(item => item.status === 'pass').subject}」满足所选产品条件` : '尚无同一产品满足全部所选条件，不能拼接不同产品的证据', relevant));
  }
  if (query.conditions.includes('financialReview')) checks.push(assess(records.filter(record => record.kind === 'financialReview'), 'financialReview', EVIDENCE_CONDITIONS.financialReview, today, record => record.value === 'clear'));
  if (query.leadership) {
    const main = rankCheck(records, 'mainRank', query, today), segment = rankCheck(records, 'segmentRank', query, today);
    if (query.leadership === 'either') checks.push(check('leadership', LEADERSHIP.either, orStatus([main.status, segment.status]), `${main.label}：${main.reason}；${segment.label}：${segment.reason}`, [...main.records, ...segment.records]));
    else checks.push(query.leadership === 'mainTop3' ? main : segment);
  }
  if (query.industry) {
    const rows = [], main = rankCheck(records, 'mainRank', query, today, rows), segment = rankCheck(records, 'segmentRank', query, today, rows);
    const chosen = query.industry.scope === 'main' ? [main] : query.industry.scope === 'segment' ? [segment] : [main, segment];
    const status = orStatus(chosen.map(part => part.status)), reason = chosen.map(part => `${part.label}：${part.reason}`).join('；');
    industryReview = { version: 1, scope: query.industry.scope, checkedAt, status, reason, rows };
    checks.push(check('industry', describeIndustryRules(query.industry), status, reason, chosen.flatMap(part => part.records)));
  }
  if (invalid.length) checks.push(check('invalidRecords', '证据格式核验', 'pending', `${invalid.length} 条记录格式不正确，需要修复后再评估`, []));
  if (invalid.length && industryReview) {
    industryReview.status = 'pending'; industryReview.reason = '存在格式无效的证据，行业原始值需完成核验后再比较';
    industryReview.rows = industryReview.rows.map(row => ({ ...row, status: 'pending', reason: industryReview.reason, mainStatus: 'pending', segmentStatus: 'pending' }));
    const industry = checks.find(item => item.key === 'industry'); industry.status = 'pending'; industry.reason = industryReview.reason;
  }
  return { status: andStatus(checks.map(item => item.status)), checks, checkedAt, query: clone(query), records: clone(records), ...(industryReview ? { industryReview } : {}) };
}

module.exports = { EVIDENCE_KINDS, EVIDENCE_CONDITIONS, validateEvidenceQuery, describeEvidenceQuery, evaluateEvidence, validateRecord, safeEvidenceUrl,
  INDUSTRY_METADATA, validateIndustryRules, describeIndustryRules, industryRulesForQuery };
