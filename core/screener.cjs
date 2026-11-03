const { symbolOf, cnTime } = require('./common.cjs');
const { dailyIndicators } = require('./daily-indicators.cjs');
const { preparedHistoryValid } = require('./daily-history.cjs');
const { checkMarketRisk, checkNoticeRisk, NOTICE_RISK_POLICY } = require('./entry-risk.cjs');
const { checkNoticeWithEvidence } = require('./company-notice-review.cjs');
const { validateEvidenceQuery, describeEvidenceQuery, evaluateEvidence } = require('./selection-evidence.cjs');
const { validateResearchRules, describeResearchRules, RESEARCH_METADATA } = require('./research-rules.cjs');
const { validatePerformanceRules, describePerformanceRules, evaluatePerformanceRules, PERFORMANCE_METADATA } = require('./performance-rules.cjs');
const { setTimeout: delay } = require('node:timers/promises');
const { ScreeningDataCache, FINANCE_MAX_AGE_MS, DAILY_MAX_AGE_MS, recent } = require('./screening-data-cache.cjs');
const { refreshFinanceSnapshot } = require('./finance-validity.cjs');
const { financeTemplateCheck } = require('./finance-template.cjs');

// Percent fields use percentage points; money fields use the units shown in the UI.
const SNAPSHOT_FIELDS = {
  price: { label: '最新价', unit: '元', aliases: ['最新价', '股价', '价格'], min: 0 },
  changePct: { label: '涨跌幅', unit: '%', aliases: ['涨跌幅', '涨幅', '跌幅'] },
  turnover: { label: '换手率', unit: '%', aliases: ['换手率', '换手'], min: 0 },
  volumeRatio: { label: '量比', unit: '倍', aliases: ['量比'], min: 0 },
  amount: { label: '成交额', unit: '亿元', aliases: ['成交金额', '成交额'], min: 0 },
  marketCap: { label: '总市值', unit: '亿元', aliases: ['总市值', '市值'], min: 0 },
  floatCap: { label: '流通市值', unit: '亿元', aliases: ['流通市值'], min: 0 },
  pe: { label: '动态市盈率', unit: '倍', aliases: ['动态市盈率', '市盈率', 'PE'], description: '行情源提供的动态市盈率，非 TTM；负值保留。' },
  pb: { label: '市净率', unit: '倍', aliases: ['市净率', 'PB'] },
  amplitude: { label: '振幅', unit: '%', aliases: ['振幅'], min: 0 },
  volume: { label: '成交量', unit: '万手', aliases: ['成交量'], min: 0 }
};
const dailyPrice = (label, aliases) => ({ label, aliases, unit: '元', min: 0, source: 'daily', comparable: true });
const TECHNICAL_FIELDS = {
  close: dailyPrice('完整日线收盘', ['完整日线收盘价', '完整日线收盘', '收盘价', '收盘']),
  ma5: dailyPrice('MA5', ['MA5', '5日均线']),
  ma20: dailyPrice('MA20', ['MA20', '20日均线']),
  ma60: dailyPrice('MA60', ['MA60', '60日均线']),
  previousMa5: dailyPrice('前一日 MA5', ['前一日MA5', '昨日MA5']),
  previousMa20: dailyPrice('前一日 MA20', ['前一日MA20', '昨日MA20']),
  previousMa60: dailyPrice('前一日 MA60', ['前一日MA60', '昨日MA60']),
  atrPct14: { label: 'ATR(14)波动率', aliases: ['ATR(14)波动率', 'ATR14波动率', '14日ATR波动率', 'ATR波动率'], unit: '%', min: 0, source: 'daily', description: '最近 14 根完整日线真实波幅 TR 的简单均值 ÷ 最新完整日线收盘 × 100%；TR 包含与前收盘的跳空。' },
  biasMa5Pct: { label: 'MA5乖离率', aliases: ['MA5乖离率', '5日均线乖离率', '5日乖离率'], unit: '%', source: 'daily', description: '（最新完整日线收盘 ÷ MA5 − 1）× 100%，保留正负号；负值表示收盘低于均线。' },
  biasMa20Pct: { label: 'MA20乖离率', aliases: ['MA20乖离率', '20日均线乖离率', '20日乖离率'], unit: '%', source: 'daily', description: '（最新完整日线收盘 ÷ MA20 − 1）× 100%，保留正负号；负值表示收盘低于均线。' },
  biasMa60Pct: { label: 'MA60乖离率', aliases: ['MA60乖离率', '60日均线乖离率', '60日乖离率'], unit: '%', source: 'daily', description: '（最新完整日线收盘 ÷ MA60 − 1）× 100%，保留正负号；负值表示收盘低于均线。' },
  ma20Change5Pct: { label: 'MA20五日变化率', aliases: ['MA20五日变化率', 'MA20近5日变化率', '20日均线五日变化率'], unit: '%', source: 'daily', description: '（最新完整日线 MA20 ÷ 五根完整日线前的 MA20 − 1）× 100%，保留正负号；五日指五根完整日线。' },
  macd: { label: 'MACD 柱', aliases: ['MACD柱', 'MACD'], unit: '元', source: 'daily', description: 'MACD(12,26,9) 柱 = 2 × (DIF − DEA)，为正不等于 DIF、DEA 均在零轴上方。' },
  rsi: { label: 'RSI(14)', aliases: ['RSI(14)', 'RSI14', 'RSI'], unit: '', min: 0, max: 100, source: 'daily', description: 'Wilder RSI(14)，范围 0–100。' },
  dailyVolumeRatio: { label: '日量比', aliases: ['完整日线量比', '日量比'], unit: '倍', min: 0, source: 'daily', description: '完整日成交量 ÷ 此前 20 根日线平均成交量，与行情源量比分开。' }
};
const FINANCIAL_FIELDS = {
  roe: { label: '加权净资产收益率', aliases: ['加权净资产收益率', '净资产收益率', '加权ROE', 'ROE'], unit: '%', source: 'finance', description: '最新已公告报告期的加权 ROE，非年化，负值保留。' },
  debtRatio: { label: '资产负债率', aliases: ['资产负债率', '负债率'], unit: '%', min: 0, source: 'finance' },
  revenueYoY: { label: '营收同比', aliases: ['营业收入同比增长率', '营业收入同比增长', '营业收入同比', '营收同比增长率', '营收同比增长', '营收同比'], unit: '%', source: 'finance' },
  profitYoY: { label: '归母净利润同比', aliases: ['归母净利润同比增长率', '归母净利润同比增长', '归母净利润同比', '净利润同比增长率', '净利润同比增长', '净利润同比'], unit: '%', source: 'finance' },
  adjustedProfitYoY: { label: '扣非净利润同比', aliases: ['扣非净利润同比增长率', '扣非净利润同比增长', '扣非净利润同比'], unit: '%', source: 'finance' },
  operatingCash: { label: '经营现金流净额', aliases: ['经营活动现金流量净额', '经营性现金流净额', '经营现金流净额', '经营现金流'], unit: '亿元', source: 'finance', description: '最新已公告报告期累计经营活动现金流量净额，仅使用 CNY（人民币）报告；负值保留。' },
  annualProfitableYears: { label: '近三年扣非盈利年数', aliases: ['近三年扣非盈利年数'], unit: '年', min: 0, max: 3, source: 'finance', description: '最近三个连续完整年度中，扣非归母净利润大于零的年数。必须有三个有效人民币年报；不以季度或半年报告替代。' },
  annualRoeAverage: { label: '近三年平均年度ROE', aliases: ['近三年平均年度ROE', '近三年平均年度净资产收益率'], unit: '%', source: 'finance', description: '最近三个连续完整年度的年度加权 ROE 简单平均值，非季度年化值；三个年度均需有效。' },
  annualRoeLatest: { label: '最近一年年度ROE', aliases: ['最近一年年度ROE', '最新年度ROE'], unit: '%', source: 'finance', description: '最新已披露完整年度的加权 ROE；不使用最新季度或半年报告。5 月起要求上一年度年报。' },
  annualCashPositiveYears: { label: '近三年经营现金流为正年数', aliases: ['近三年经营现金流为正年数'], unit: '年', min: 0, max: 3, source: 'finance', description: '最近三个连续完整年度经营活动现金流净额大于零的年数；三个年度均需有效人民币金额。' },
  annualCashSum: { label: '近三年经营现金流合计', aliases: ['近三年经营现金流合计'], unit: '亿元', source: 'finance', description: '最近三个连续完整年度经营活动现金流净额之和（人民币亿元）；缺失值不能当零。' },
  latestAdjustedProfit: { label: '最新报告期扣非净利润', aliases: ['最新报告期扣非净利润'], unit: '亿元', source: 'finance', description: '最新已公告报告期累计扣非归母净利润，仅使用人民币金额；并非同比增速。' }
};
const FIELDS = { ...SNAPSHOT_FIELDS, ...TECHNICAL_FIELDS, ...FINANCIAL_FIELDS };
const ruleFields = rule => [rule.field, ...(rule.valueField ? [rule.valueField] : [])];
const isTechnical = rule => ruleFields(rule).some(field => FIELDS[field].source === 'daily');
const isFinancial = rule => ruleFields(rule).some(field => FIELDS[field].source === 'finance');
const compare = (a, op, b) => ({ gt: a > b, gte: a >= b, lt: a < b, lte: a <= b, eq: a === b })[op];
const matches = (row, rule) => compare(row[rule.field], rule.op, rule.valueField ? row[rule.valueField] : rule.value);
const BOARDS = { sh: '沪市主板', sz: '深市主板', chinext: '创业板', star: '科创板' };
const OPS = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' };
function defaults() { return { scope: 'all', boards: [], excludeST: false, rules: [] }; }
function financialQualityRules() {
  return [
    { field: 'annualProfitableYears', op: 'gte', value: 3 },
    { field: 'annualRoeAverage', op: 'gte', value: 10 },
    { field: 'annualRoeLatest', op: 'gte', value: 8 },
    { field: 'annualCashPositiveYears', op: 'gte', value: 2 },
    { field: 'annualCashSum', op: 'gt', value: 0 },
    { field: 'debtRatio', op: 'lte', value: 60 },
    { field: 'latestAdjustedProfit', op: 'gt', value: 0 }
  ];
}
function validate(input) {
  if (!input || !['all', 'watchlist'].includes(input.scope) || !Array.isArray(input.boards) || input.boards.some(b => !Object.hasOwn(BOARDS, b)) || typeof input.excludeST !== 'boolean' || !Array.isArray(input.rules) || input.rules.length > 30) throw Error('选股条件格式无效');
  const query = { scope: input.scope, boards: [...new Set(input.boards)], excludeST: input.excludeST, rules: [] };
  const evidence = validateEvidenceQuery(input.evidence);
  if (evidence) query.evidence = evidence;
  const research = validateResearchRules(input.research);
  if (research) query.research = research;
  const performance = validatePerformanceRules(input.performance);
  if (performance) query.performance = performance;
  for (const r of input.rules) {
    const field = Object.hasOwn(FIELDS, r?.field) ? FIELDS[r.field] : null;
    if (!field || typeof r.field !== 'string' || typeof r.op !== 'string' || !Object.hasOwn(OPS, r.op)) throw Error('选股指标、比较方式或数值无效');
    let rule;
    if (Object.hasOwn(r, 'valueField')) {
      if (Object.hasOwn(r, 'value') || typeof r.valueField !== 'string' || !field.comparable || !Object.hasOwn(FIELDS, r.valueField) || !FIELDS[r.valueField].comparable) throw Error('指标比较仅支持完整日线收盘与均线，不能混用快照价格或其他指标');
      if (r.field === r.valueField && ['gt', 'lt'].includes(r.op)) throw Error('同一指标的严格比较条件相互矛盾');
      rule = { field: r.field, op: r.op, valueField: r.valueField };
    } else {
      if (typeof r.value !== 'number' || !Number.isFinite(r.value) || Math.abs(r.value) > 1e12 || (field.min != null && r.value < field.min) || (field.max != null && r.value > field.max)) throw Error('选股指标、比较方式或数值无效');
      rule = { field: r.field, op: r.op, value: r.value };
    }
    if (!query.rules.some(v => JSON.stringify(v) === JSON.stringify(rule))) query.rules.push(rule);
  }
  for (const field of Object.keys(FIELDS)) {
    const rules = query.rules.filter(r => r.field === field && !r.valueField);
    const lows = rules.filter(r => ['gt', 'gte', 'eq'].includes(r.op)), highs = rules.filter(r => ['lt', 'lte', 'eq'].includes(r.op));
    for (const l of lows) for (const h of highs) if (l.value > h.value || (l.value === h.value && (l.op === 'gt' || h.op === 'lt'))) throw Error(`${FIELDS[field].label}条件相互矛盾，请调整上下限`);
  }
  // Canonicalize reversed field comparisons before detecting empty intersections.
  const relations = new Map(), inverse = { gt: 'lt', gte: 'lte', lt: 'gt', lte: 'gte', eq: 'eq' };
  for (const r of query.rules.filter(r => r.valueField)) {
    const reversed = r.field > r.valueField, key = [r.field, r.valueField].sort().join(':'), op = reversed ? inverse[r.op] : r.op;
    const allowed = [-1, 0, 1].filter(sign => compare(sign, op, 0) && (!relations.has(key) || relations.get(key).includes(sign)));
    if (!allowed.length) throw Error('均线与收盘比较条件相互矛盾');
    relations.set(key, allowed);
  }
  return query;
}
function describe(query) {
  return [query.scope === 'watchlist' ? '我的自选' : '沪深 A 股', ...(query.boards.length ? [query.boards.map(b => BOARDS[b]).join(' / ')] : []), ...(query.excludeST ? ['排除 ST / *ST / 退市标记'] : []), ...query.rules.map(r => `${FIELDS[r.field].label} ${OPS[r.op]} ${r.valueField ? FIELDS[r.valueField].label : `${r.value} ${FIELDS[r.field].unit}`}`), ...describeEvidenceQuery(query.evidence), ...describeResearchRules(query.research), ...describePerformanceRules(query.performance)];
}
const NUM = '(-?\\d+(?:\\.\\d+)?)\\s*(亿元|亿|万元|万手|万|元|手|%|倍|年)?';
const comparison = { '>': 'gt', '大于': 'gt', '超过': 'gt', '高于': 'gt', '多于': 'gt', '>=': 'gte', '≥': 'gte', '大于等于': 'gte', '不低于': 'gte', '不少于': 'gte', '至少': 'gte', '<': 'lt', '小于': 'lt', '低于': 'lt', '少于': 'lt', '<=': 'lte', '≤': 'lte', '小于等于': 'lte', '不超过': 'lte', '不高于': 'lte', '不大于': 'lte', '至多': 'lte', '=': 'eq', '等于': 'eq' };
function convert(value, unit, field, phrase) {
  let n = Number(value);
  const expected = FIELDS[field].unit;
  if (expected === '亿元') {
    if (unit && !['亿元', '亿', '万元', '万', '元'].includes(unit)) throw Error(`${phrase}：金额请使用元、万元或亿元`);
    n *= { 元: 1e-8, 万: 1e-4, 万元: 1e-4, 亿: 1, 亿元: 1 }[unit] || 1;
  } else if (expected === '万手') {
    if (unit && !['万手', '手'].includes(unit)) throw Error('成交量请使用手或万手');
    if (unit === '手') n /= 10000;
  } else if (unit && unit !== expected) throw Error(`${FIELDS[field].label}的单位应为${expected}`);
  if (phrase === '跌幅') n = -n;
  return n;
}
function parseDescription(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 500) throw Error('请输入 1–500 字的选股描述');
  let rest = text.normalize('NFKC').replaceAll('％', '%').replaceAll('不小于', '不低于').replaceAll('不多于', '不超过').replaceAll('到达', '等于');
  rest = rest.replace(/^\s*(?:需要|要求)\s*/, '').replace(/\bMA\s*(5|20|60)\b/gi, 'MA$1').replace(/(前一日|昨日)\s+(MA(?:5|20|60))/gi, '$1$2').replace(/MACD\s+柱/gi, 'MACD柱');
  const query = defaults(), notes = [];
  const evidence = { conditions: [], leadership: '', minSegmentRevenuePct: 30 };
  // Only this named alternative is supported. Arbitrary OR still fails below.
  rest = rest.replace(/主行业前三\s*(?:或者|或)\s*(?:重要)?细分(?:行业)?龙头|主行业前三|(?:重要)?细分(?:行业)?龙头/g, phrase => {
    const leadership = /或/.test(phrase) ? 'either' : phrase === '主行业前三' ? 'mainTop3' : 'segmentLeader';
    if (evidence.leadership && evidence.leadership !== leadership) throw Error('行业地位条件重复且口径不同，请明确选择主行业前三、细分龙头或两者满足其一');
    evidence.leadership = leadership; return ' ';
  });
  const evidencePhrases = { '产品前景有证据支持': 'productOutlook', '产品前景好': 'productOutlook', '需求增长有依据': 'demand', '产品已商业化': 'commercialization', '竞争优势已证实': 'advantage' };
  rest = rest.replace(/产品前景有证据支持|产品前景好|需求增长有依据|产品已商业化|竞争优势已证实/g, phrase => { evidence.conditions.push(evidencePhrases[phrase]); return ' '; });
  rest = rest.replace(/财务状况良好|财务质量达标/g, () => {
    query.rules.push(...financialQualityRules()); evidence.conditions.push('financialReview');
    notes.push('“财务状况良好”使用可编辑的初始模板：三年扣非盈利、平均年度 ROE≥10%、最新年度 ROE≥8%、至少两年经营现金流为正且三年合计为正、负债率≤60%、最新扣非利润为正，并核验财务异常及行业适用性；阈值尚未经策略效果验证，适用于普通非金融企业。');
    return ' ';
  });
  if (evidence.conditions.length || evidence.leadership) {
    query.evidence = evidence;
    notes.push('证据条件按已复核且有效的资料判断，资料不足、过期或冲突列为待核验。产品前景要求同一产品的需求、商业化和竞争优势均获证据支持，并完成重大反向证据复核；不能视为未来收益保证。');
    if (evidence.leadership) notes.push('主行业前三或细分龙头为明确的行业地位口径；细分龙头要求排名第一且业务收入占比不低于30%，需保留市场范围、统计期间和来源。');
  }
  if (/(?:或者|或|任一|其一|非ST以外)/i.test(rest)) throw Error('暂不支持“或”和复杂否定逻辑，请使用同时满足的条件；多个板块可在下方勾选');
  if (/(?:排除|剔除|不要|去掉|非|不含|不选)\s*\*?ST(?:\s*(?:和|以及|及|、|\/)\s*\*?ST)*\s*(?:和|以及|及|、|\/)(?!\s*\*?ST)/i.test(rest)) throw Error('无法确定连续排除的范围，请将“排除ST”和其他筛选条件用逗号分开；暂不支持排除其他板块或指标');
  if (/自选/.test(rest) && /全市场|全部\s*A\s*股|沪深\s*A\s*股/i.test(rest)) throw Error('请明确选择自选股或全部沪深 A 股中的一个范围');
  if (/自选/.test(rest)) { query.scope = 'watchlist'; rest = rest.replace(/(?:我的)?自选(?:股票|股)?(?:中|里)?/g, ' '); }
  rest = rest.replace(/(?:排除|剔除|不要|去掉|非|不含|不选)\s*(?:ST|\*ST)(?:\s*[/、和及]\s*\*?ST)?(?:股票|股)?/gi, () => { query.excludeST = true; return ' '; });
  rest = rest.replace(/沪市主板|沪主板|深市主板|深主板|创业板|科创板|主板|沪市|深市/g, name => {
    query.boards.push(...({ 沪市主板: ['sh'], 沪主板: ['sh'], 深市主板: ['sz'], 深主板: ['sz'], 创业板: ['chinext'], 科创板: ['star'], 主板: ['sh', 'sz'], 沪市: ['sh', 'star'], 深市: ['sz', 'chinext'] }[name])); return ' ';
  });
  const aliases = Object.entries(FIELDS).flatMap(([field, spec]) => spec.aliases.map(alias => ({ field, alias }))).sort((a, b) => b.alias.length - a.alias.length);
  const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const aliasPattern = aliases.map(a => escapePattern(a.alias)).join('|');
  const opPattern = Object.keys(comparison).sort((a, b) => b.length - a.length).join('|');
  const fieldOf = alias => aliases.find(a => a.alias.toLowerCase() === alias.toLowerCase()).field;
  const dailyAliases = aliases.filter(a => FIELDS[a.field].comparable).map(a => escapePattern(a.alias)).join('|');
  const movingAverage = '(?:MA(?:20|60|5)|(?:20|60|5)日均线)';
  // Recover the shared subject only for this explicit, unambiguous conjunction.
  rest = rest.replace(new RegExp(`(${movingAverage})\\s*(向上|上行|上升|向下|下行|下降)\\s*(?:并且|且|并)\\s*(?=${opPattern})`, 'gi'), '$1$2，$1');
  rest = rest.replace(new RegExp(`(${movingAverage})\\s*(向上|上行|上升|向下|下行|下降)`, 'gi'), (whole, alias, direction) => {
    const field = fieldOf(alias);
    query.rules.push({ field, op: /上/.test(direction) ? 'gt' : 'lt', valueField: 'previous' + field[0].toUpperCase() + field.slice(1) });
    return ' ';
  });
  rest = rest.replace(new RegExp(`(${dailyAliases})\\s*在\\s*(${dailyAliases})\\s*(上方|下方|以上|以下)`, 'gi'), (whole, left, right, position) => {
    query.rules.push({ field: fieldOf(left), op: { 上方: 'gt', 下方: 'lt', 以上: 'gte', 以下: 'lte' }[position], valueField: fieldOf(right) }); return ' ';
  });
  rest = rest.replace(new RegExp(`(${dailyAliases})\\s*(${opPattern})\\s*(${dailyAliases})`, 'gi'), (whole, left, op, right) => {
    query.rules.push({ field: fieldOf(left), op: comparison[op], valueField: fieldOf(right) }); return ' ';
  });
  rest = rest.replace(/MACD(?:柱)?\s*为(正|负)/gi, (whole, sign) => {
    query.rules.push({ field: 'macd', op: sign === '正' ? 'gt' : 'lt', value: 0 }); return ' ';
  });
  const add = (field, alias, op, value, unit) => {
    if (alias === '跌幅') op = ({ gt: 'lt', gte: 'lte', lt: 'gt', lte: 'gte', eq: 'eq' })[op];
    query.rules.push({ field, op, value: convert(value, unit, field, alias) });
  };
  rest = rest.replace(new RegExp(`(${aliasPattern})\\s*(?:在|为|介于)?\\s*${NUM}\\s*(?:到|至|~|～|-|—|–)\\s*${NUM}(?:之间)?`, 'gi'), (whole, alias, low, lu, high, hu) => {
    const field = aliases.find(a => a.alias.toLowerCase() === alias.toLowerCase()).field;
    add(field, alias, 'gte', low, lu || hu); add(field, alias, 'lte', high, hu || lu); return ' ';
  });
  rest = rest.replace(new RegExp(`(${aliasPattern})\\s*(${opPattern})\\s*${NUM}`, 'gi'), (whole, alias, op, value, unit) => {
    const field = aliases.find(a => a.alias.toLowerCase() === alias.toLowerCase()).field;
    add(field, alias, comparison[op], value, unit); return ' ';
  });
  rest = rest.replace(new RegExp(`(${aliasPattern})\\s*(?:在|为)?\\s*${NUM}\\s*(以下|以内|以上|以外)`, 'gi'), (whole, alias, value, unit, suffix) => {
    if (suffix === '以外') return whole;
    const field = aliases.find(a => a.alias.toLowerCase() === alias.toLowerCase()).field;
    add(field, alias, suffix === '以上' ? 'gte' : 'lte', value, unit); return ' ';
  });
  rest = rest.replace(/沪深\s*A\s*股|全部\s*A\s*股|全市场|A\s*股|请帮我|帮我|帮忙|我想找|我想要|我要|筛选出|筛选一下|筛选|选出|找出|找一下|找一些|寻找|只要|一些|的股票|的个股|股票|个股|同时满足|并且|而且|以及|且|和|及|的/gi, ' ').replace(/[\s,，。;；、:：]/g, '');
  if (rest) throw Error(`尚未支持或无法确定的描述：“${rest}”。请改为明确的指标与数值；未执行筛选。`);
  if (!query.rules.length && !query.boards.length && !query.excludeST && !query.evidence && !/全市场|A\s*股|自选/i.test(text)) throw Error('没有识别到筛选条件，请参考下方示例');
  if (query.rules.some(r => r.field === 'pe')) notes.push('市盈率按行情源的动态口径筛选；若要排除负值，请补充“市盈率大于 0”。');
  if (query.rules.some(isTechnical)) notes.push('技术指标使用完整未复权日线；向上指较前一根日线上升，上方为严格大于。MACD 指柱值，RSI 为 Wilder(14)，日量比对比此前 20 根日线均量。');
  if (query.rules.some(isFinancial)) notes.push('非年度财务指标使用最新已公告报告期：ROE 为加权非年化值，净利润同比为归母口径，经营现金流为报告期累计净额（人民币亿元）。不同股票报告期可能不同；不支持历史快照财务筛选。');
  if (query.rules.some(rule => rule.field.startsWith('annual'))) notes.push('带“年度/近三年”的指标只使用完整年报；三年指标要求连续三个年度。产品新鲜度规则为5月起须有上一年度年报，1–4月可使用前年年报；该规则不是交易所交易约束，缺失和时点不明不补零。');
  return { query: validate(query), notes };
}
const numeric = value => !['number', 'string'].includes(typeof value) || String(value).trim() === '' || value === '-' || !Number.isFinite(Number(value)) ? null : Number(value);
const fieldAvailable = (row, field) => Number.isFinite(row[field]) && (field === 'price' || FIELDS[field].comparable ? row[field] > 0 : FIELDS[field].min == null || row[field] >= FIELDS[field].min) && (FIELDS[field].max == null || row[field] <= FIELDS[field].max);
const quoteTimeAvailable = row => Number.isFinite(row.timestamp) && row.timestamp > 0 && row.timestamp <= 8640000000000000;
function quoteRange(rows) {
  const times = rows.filter(quoteTimeAvailable).map(r => r.timestamp);
  return { oldestQuote: times.length ? Math.min(...times) : null, newestQuote: times.length ? Math.max(...times) : null, unknownQuoteTime: rows.length - times.length };
}
function normalize(row) {
  let symbol;
  try { symbol = symbolOf((row.f13 === 1 ? 'sh' : row.f13 === 0 ? 'sz' : '?') + row.f12); } catch { return null; }
  const scaled = (key, factor = 1) => { const n = numeric(row[key]); return n === null ? null : n / factor; };
  const name = String(row.f14 || row.f12), board = symbol.startsWith('sh688') ? 'star' : /^sz30/.test(symbol) ? 'chinext' : symbol.startsWith('sh') ? 'sh' : 'sz';
  const result = { symbol, name, board, isST: /ST|退/i.test(name), price: scaled('f2'), prevClose: scaled('f18') > 0 ? scaled('f18') : null, changePct: scaled('f3'), volume: scaled('f5', 10000), amount: scaled('f6', 1e8), amplitude: scaled('f7'), turnover: scaled('f8'), pe: scaled('f9'), volumeRatio: scaled('f10'), marketCap: scaled('f20', 1e8), floatCap: scaled('f21', 1e8), pb: scaled('f23'), timestamp: scaled('f124', 0.001) };
  for (const field of Object.keys(SNAPSHOT_FIELDS)) if (!fieldAvailable(result, field)) result[field] = null;
  if (!quoteTimeAvailable(result)) result.timestamp = null;
  return result;
}
function screen(snapshot, input, watchlist = []) {
  const query = validate(input), watched = new Set(watchlist);
  const pool = snapshot.rows.filter(r => (query.scope !== 'watchlist' || watched.has(r.symbol)) && (!query.boards.length || query.boards.includes(r.board)) && (!query.excludeST || !r.isST));
  const requiredFields = [...new Set(query.rules.flatMap(ruleFields))];
  const technical = query.rules.some(isTechnical), finance = query.rules.some(isFinancial);
  const baseRules = query.rules.filter(r => !isTechnical(r) && !isFinancial(r)), financeRules = query.rules.filter(isFinancial), technicalRules = query.rules.filter(isTechnical);
  const baseFields = [...new Set(baseRules.flatMap(ruleFields))];
  const baseCandidates = pool.filter(row => baseFields.every(field => fieldAvailable(row, field)));
  const financePool = baseCandidates.filter(row => baseRules.every(rule => matches(row, rule)));
  const financeFields = [...new Set(financeRules.flatMap(ruleFields))], technicalFields = [...new Set(technicalRules.flatMap(ruleFields))];
  const financeCandidates = financePool.filter(row => financeFields.every(field => fieldAvailable(row, field)));
  const dailyPool = financeCandidates.filter(row => financeRules.every(rule => matches(row, rule)));
  const candidates = dailyPool.filter(row => technicalFields.every(field => fieldAvailable(row, field)));
  const fieldPool = field => FIELDS[field].source === 'daily' ? dailyPool : FIELDS[field].source === 'finance' ? financePool : pool;
  const missingByField = Object.fromEntries([...Object.keys(SNAPSHOT_FIELDS), ...requiredFields.filter(field => FIELDS[field].source)].map(field => [field, fieldPool(field).filter(row => !fieldAvailable(row, field)).length]));
  missingByField.timestamp = pool.filter(row => !quoteTimeAvailable(row)).length;
  const rows = candidates.filter(row => technicalRules.every(rule => matches(row, rule)));
  const missing = pool.length - baseCandidates.length + financePool.length - financeCandidates.length + dailyPool.length - candidates.length;
  const unavailable = pool.length > 0 && (baseCandidates.length === 0 || (finance && financePool.length > 0 && financeCandidates.length === 0) || (technical && dailyPool.length > 0 && candidates.length === 0));
  const absent = requiredFields.filter(field => missingByField[field] > 0 && missingByField[field] === fieldPool(field).length);
  let dataMessage = unavailable ? (absent.length ? `${absent.map(field => FIELDS[field].label).join('、')}数据暂不可用，本次无法筛选` : '没有股票具备本次所需的完整指标，本次无法筛选') : '';
  if (finance) {
    const failures = snapshot.financeScan?.failures || {};
    dataMessage += `${dataMessage ? '。' : ''}财务候选 ${financePool.length} 只，指标齐全 ${financeCandidates.length} 只；所需财务指标缺失 ${financePool.length - financeCandidates.length} 只（无报告 ${failures.missing || 0} 只，报告无效或时点不明 ${failures.invalid || 0} 只，获取失败 ${failures.fetch || 0} 只）。${missing ? '存在未能判断的股票，匹配数量仅覆盖可判断部分。' : ''}`;
  }
  if (technical) {
    const failures = snapshot.technicalScan?.failures || {};
    const unavailableMetrics = Math.max(0, dailyPool.length - candidates.length - Object.values(failures).reduce((a, b) => a + b, 0));
    dataMessage += `${dataMessage ? '。' : ''}技术候选 ${dailyPool.length} 只，指标齐全 ${candidates.length} 只；日线不足 ${failures.insufficient || 0} 只，日线无效 ${failures.invalid || 0} 只，获取失败 ${failures.fetch || 0} 只。${unavailableMetrics ? `另有 ${unavailableMetrics} 只所需技术指标不可计算。` : ''}${missing ? '存在未能判断的股票，匹配数量仅覆盖可判断部分。' : ''}`;
  }
  return { ...snapshot, rows, query, labels: describe(query), status: unavailable ? 'unavailable' : rows.length ? 'ready' : 'empty', dataMessage, matched: unavailable ? null : rows.length, poolCount: pool.length, eligibleCount: snapshot.rows.length, evaluatedCount: pool.length - missing, missing, partial: missing > 0, technical, technicalCandidates: technical ? dailyPool.length : 0, technicalEvaluatedCount: technical ? candidates.length : 0, finance, financeCandidates: finance ? financePool.length : 0, financeEvaluatedCount: finance ? financeCandidates.length : 0, requiredFields, missingByField, watchlistMissing: query.scope === 'watchlist' ? watchlist.filter(s => !snapshot.rows.some(r => r.symbol === s)).length : 0, ...quoteRange(rows) };
}
// Complete per-symbol classification for membership reconciliation. A missing
// value is never the same as a failed condition. Intraday cumulative minima may
// be deferred by the caller without changing ordinary screener semantics.
function classifyScreenRow(row, input, { deferMinimumFields = [] } = {}) {
  const query = validate(input), failed = [], pending = [], deferred = new Set(deferMinimumFields);
  if (query.boards.length && !query.boards.includes(row.board)) failed.push('证券板块不在筛选范围');
  if (query.excludeST) {
    if (row.isST === true) failed.push('证券带有 ST / 退市标记');
    else if (row.isST !== false) pending.push('证券 ST / 退市状态无法核验');
  }
  for (const rule of query.rules) {
    const absent = ruleFields(rule).filter(field => !fieldAvailable(row, field));
    if (absent.length) { pending.push(`${absent.map(field => FIELDS[field].label).join('、')}数据缺失或无效`); continue; }
    if (matches(row, rule)) continue;
    const reason = `${FIELDS[rule.field].label} ${OPS[rule.op]} ${rule.valueField ? FIELDS[rule.valueField].label : `${rule.value} ${FIELDS[rule.field].unit}`} 未满足`;
    if (!rule.valueField && ['gt', 'gte'].includes(rule.op) && deferred.has(rule.field)) pending.push(`${reason}；盘中累计值尚未完成，保留待核验`);
    else failed.push(reason);
  }
  return { status: failed.length ? 'failed' : pending.length ? 'pending' : 'pass', reasons: [...new Set(failed.length ? failed : pending)], failedReasons: failed, pendingReasons: pending };
}
function financeError(code, message) { const error = Error(message); error.code = code; return error; }
function normalizeFinance(result, symbol, now, checkedAt = now, options = {}) {
  const { financeResponseIssue, buildFinanceSnapshot } = require('./finance-validity.cjs');
  const issue = financeResponseIssue(result, symbol, checkedAt);
  if (issue) throw financeError(issue.code, issue.reason);
  return buildFinanceSnapshot(result, symbol, now, { ...options, checkedAt });
}
function cancellable(promise, signal) {
  if (signal.aborted) return Promise.reject(Error('已取消选股，本次结果未应用'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error('已取消选股，本次结果未应用'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
class Screener {
  constructor(fetcher = fetch, history = null, dailyLoader = null, clock = () => new Date(), financeLoader = null, noticeLoader = null, riskQuoteLoader = null, snapshotLoader = null, evidenceLoader = null, automaticEvidenceLoader = null, options = {}) {
    this.fetcher = fetcher; this.history = history; this.dailyLoader = dailyLoader; this.clock = clock; this.financeLoader = financeLoader; this.noticeLoader = noticeLoader; this.riskQuoteLoader = riskQuoteLoader;
    this.snapshotLoader = snapshotLoader; this.evidenceLoader = evidenceLoader; this.automaticEvidenceLoader = automaticEvidenceLoader;
    this.noticeEvidenceLoader = options.noticeEvidenceLoader || null;
    this.snapshot = null; this.pending = null; this.activeRun = null; this.dailyCache = new Map(); this.financeCache = new Map();
    this.screeningDataCache = new ScreeningDataCache(options.screeningCacheDirectory, options.screeningCacheNamespace);
    this.progress = { loading: false, stage: 'quotes', completed: 0, total: 0 };
  }
  cancel() { if (this.activeRun) this.activeRun.abort(); }
  async page(number) {
    const params = new URLSearchParams({ pn: number, pz: 100, po: 0, np: 1, fltt: 2, invt: 2, fid: 'f12', fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', fields: 'f2,f3,f5,f6,f7,f8,f9,f10,f12,f13,f14,f18,f20,f21,f23,f124' });
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (this.activeRun?.signal.aborted) throw Error('已取消选股，本次结果未应用');
        const host = attempt === 1 ? '82.push2.eastmoney.com' : 'push2.eastmoney.com';
        const timeout = AbortSignal.timeout(15000), signal = this.activeRun ? AbortSignal.any([this.activeRun.signal, timeout]) : timeout;
        response = await this.fetcher(`https://${host}/api/qt/clist/get?${params}`, { signal, cache: 'no-store', headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' } });
        if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
      } catch (e) { if (this.activeRun?.signal.aborted) throw Error('已取消选股，本次结果未应用'); if (attempt === 2) throw Error(`第 ${number} 页选股行情获取失败：${e.message}`); }
      await delay(250 * (attempt + 1));
    }
    if (!response.ok) throw Error(`选股行情 HTTP ${response.status}`);
    const json = await response.json(), data = json.data;
    if (json.rc !== 0 || !Number.isInteger(data?.total) || data.total < 1 || data.total > 15000 || !Array.isArray(data.diff) || !data.diff.length) throw Error('选股行情格式异常，未使用不完整股票池');
    return data;
  }
  async load(force = false) {
    if (this.pending) return this.pending;
    if (!force && this.snapshot && Date.now() - this.snapshot.fetchedAt < 60000) return this.snapshot;
    this.pending = this.fetchAll().finally(() => { this.pending = null; this.progress.loading = false; });
    return this.pending;
  }
  async fetchAll() {
    if (this.snapshotLoader) {
      const signal = this.activeRun?.signal;
      const snapshot = await this.snapshotLoader({ signal, onProgress: progress => { this.progress = progress; } });
      if (signal?.aborted) throw Error('已取消选股，本次结果未应用');
      // A complete provider response is published atomically; failures and
      // cancellation leave the previous in-memory and persisted snapshots intact.
      this.snapshot = snapshot;
      if (this.history) {
        try { this.history.remember(snapshot); }
        catch (e) { this.history.warning = `历史快照保存失败：${e.message}；本次获取的数据仍可筛选`; }
      }
      return snapshot;
    }
    this.progress = { loading: true, stage: 'quotes', completed: 0, total: 0 };
    const startedAt = Date.now(), first = await this.page(1), pages = Math.ceil(first.total / 100), batches = [first.diff];
    if (first.diff.length !== Math.min(100, first.total)) throw Error('选股行情分页大小变化，请稍后重试');
    this.progress = { loading: true, stage: 'quotes', completed: 1, total: pages };
    let next = 2, failure;
    await Promise.all(Array.from({ length: Math.min(3, pages - 1) }, async () => {
      while (next <= pages && !failure) {
        const page = next++;
        try {
          const data = await this.page(page);
          if (data.total !== first.total) throw Error('股票池在获取期间发生变化，请重新刷新');
          batches[page - 1] = data.diff; this.progress.completed++;
        } catch (error) { failure = error; }
      }
    }));
    if (failure) throw failure;
    const raw = batches.flat(), unique = new Set(raw.map(r => `${r.f13}.${r.f12}`));
    if (raw.length !== first.total || unique.size !== first.total) throw Error('选股行情分页不完整或重复，请重新刷新');
    const rows = raw.map(normalize).filter(Boolean);
    if (!rows.length) throw Error('未收到可识别的沪深 A 股');
    this.snapshot = { rows, startedAt, fetchedAt: Date.now(), source: '东方财富公开行情', sourceCount: first.total, excludedCount: first.total - rows.length };
    if (this.history) {
      try { this.history.remember(this.snapshot); }
      catch (e) { this.history.warning = `历史快照保存失败：${e.message}；本次获取的数据仍可筛选`; }
    }
    return this.snapshot;
  }
  async run(input, watchlist, force = false, snapshotId = null, strategyId = null) {
    const query = validate(input);
    if (strategyId !== null && !['ultra-short', 'short', 'swing', 'long'].includes(strategyId)) throw Error('所选投资策略不存在，请重新选择');
    const riskEnabled = strategyId !== null, marketEnabled = ['ultra-short', 'short'].includes(strategyId);
    if (snapshotId !== null && (typeof snapshotId !== 'string' || !snapshotId || force)) throw Error('历史快照选择无效，请切换至最新行情后刷新');
    if (query.evidence && snapshotId !== null) throw Error('历史快照未保存当时可知的选股证据，不能用当前证据判断历史；请选择最新行情或移除证据条件');
    if (query.research?.enabled && snapshotId !== null) throw Error('历史快照未保存当时可知的产品与公司经营资料，不能使用当前经营研究判断历史');
    if (query.performance?.enabled && snapshotId !== null) throw Error('历史快照未保存当时可知的业绩预告或快报，不能用当前预测判断历史');
    if (riskEnabled && snapshotId !== null) throw Error('历史快照未保存当时的公告核验，无法执行策略公告检查；请选择最新行情');
    const technical = query.rules.some(isTechnical), finance = query.rules.some(isFinancial), companyResearch = query.research?.enabled && query.research.path === 'company';
    const requireTemplate = strategyId === 'long' && finance || query.evidence?.conditions.includes('financialReview');
    if (finance && snapshotId !== null) throw Error('历史快照未保存当时可知的财务报告，无法用于财务条件；请选择最新行情，或移除财务条件');
    if (technical && snapshotId !== null) throw Error('历史快照未保存技术日线，无法用于技术条件；请选择最新行情，或移除技术条件');
    if (this.activeRun) throw Error('已有选股任务进行中，请等待完成或取消');
    const controller = new AbortController(); this.activeRun = controller;
    try {
      let snapshot = snapshotId === null ? await this.load(force) : this.history?.get(snapshotId);
      if (controller.signal.aborted) throw Error('已取消选股，本次结果未应用');
      if (!snapshot) throw Error('所选历史快照已不可用，请重新选择或更新最新行情');
      const originalSnapshot = snapshot, scanTime = new Date(this.clock().getTime());
      // Risk checks are separate from editable indicator rules. Keep their results out of cached/history quotes.
      const marketCheck = marketEnabled ? this.screenMarketRisk(snapshot, query, watchlist) : null;
      if (marketCheck) snapshot = marketCheck.snapshot;
      if ((finance || requireTemplate || companyResearch && this.financeLoader) && (!riskEnabled || snapshot.rows.length)) snapshot = await this.scanFinance(snapshot, query, watchlist, force, controller.signal, scanTime);
      const financeTemplateRows = [];
      if (requireTemplate) {
        const scopeRows = new Set(screen(snapshot, { ...query, rules: query.rules.filter(rule => !isTechnical(rule) && !isFinancial(rule)) }, watchlist).rows);
        snapshot = { ...snapshot, rows: snapshot.rows.filter(row => {
          if (!scopeRows.has(row)) return true;
          const check = financeTemplateCheck(row, this.clock());
          if (check.status === 'pass') return true;
          financeTemplateRows.push({ ...row, financeApplicability: check.applicability });
          return false;
        }) };
      }
      if (technical && (!riskEnabled || snapshot.rows.length)) snapshot = await this.scanDaily(snapshot, query, watchlist, force, controller.signal, scanTime);
      if (finance || companyResearch) snapshot = { ...snapshot, rows: snapshot.rows.map(row => row.financeSourceSnapshot ? refreshFinanceSnapshot(row, row.symbol, this.clock()) : row) };
      if (controller.signal.aborted) throw Error('已取消选股，本次结果未应用');
      let result = screen(snapshot, query, watchlist);
      if (query.evidence) result = await this.screenEvidence(result, controller.signal);
      if (query.research?.enabled) result = await this.screenResearch(result, controller.signal, force);
      if (riskEnabled || query.performance?.enabled) result = await this.screenNoticeRisk(result, marketCheck, originalSnapshot, watchlist, strategyId, force, controller.signal);
      else result = { ...result, noticeScreen: { status: 'unverified', mode: 'not-reviewed', reason: snapshotId === null
        ? '自定义筛选未批量核验公告；打开股票后由买卖计划另行检查'
        : '历史快照未保存当时的公告，自定义筛选未核验历史事件；当前买卖计划的公告检查不能替代历史核验' } };
      if (controller.signal.aborted) throw Error('已取消选股，本次结果未应用');
      if ((riskEnabled || query.performance?.enabled) && query.research?.enabled) result = this.refreshResearchResult(result);
      if (query.performance?.enabled) result = this.screenPerformanceResult(result);
      if (finance && result.rows.length) {
        const required = query.rules.filter(isFinancial).flatMap(ruleFields).filter(field => FIELDS[field].source === 'finance');
        const refreshed = result.rows.map(row => refreshFinanceSnapshot(row, row.symbol, this.clock(), { notices: row.financeNoticeResponse }));
        const pending = refreshed.filter(row => required.some(field => row.financeFieldChecks[field].status !== 'ready'));
        if (pending.length) {
          const rows = refreshed.filter(row => !pending.includes(row));
          result = { ...result, rows, financePendingRows: pending, matched: rows.length ? rows.length : null, status: rows.length ? 'ready' : 'unavailable', partial: true,
            missing: (result.missing || 0) + pending.length, evaluatedCount: Math.max(0, (result.evaluatedCount || 0) - pending.length),
            dataMessage: `${result.dataMessage || ''}。发布前复核发现 ${pending.length} 只财务资料需重新核验；逐项原因见财务明细，原值保留查看。` };
        } else result = { ...result, rows: refreshed };
      }
      if (requireTemplate) {
        const rows = result.rows.filter(row => {
          const check = financeTemplateCheck(row, this.clock());
          if (check.status === 'pass') return true;
          financeTemplateRows.push({ ...row, financeApplicability: check.applicability }); return false;
        });
        const pending = financeTemplateRows.filter(row => row.financeApplicability.status === 'pending').length;
        result = { ...result, rows, financeTemplateRows, matched: rows.length || pending ? (rows.length || null) : 0,
          partial: result.partial || pending > 0, status: rows.length ? 'ready' : pending ? 'unavailable' : result.status,
          dataMessage: `${result.dataMessage || ''}${financeTemplateRows.length ? `。财务模板不适用 ${financeTemplateRows.length - pending} 只，行业分类待核验 ${pending} 只；原因单独列示，不作为财务数值不达标。` : ''}` };
      }
      return { ...result, dataMode: snapshotId === null ? 'latest' : 'historical', snapshotId, historyWarning: this.history?.warning || '' };
    } finally { this.activeRun = null; this.progress.loading = false; }
  }
  async screenEvidence(result, signal) {
    this.progress = { loading: true, stage: 'evidence', completed: 0, total: result.rows.length };
    let records = [], failure = '';
    if (result.rows.length) {
      try {
        if (!this.evidenceLoader) throw Error('选股证据库未配置');
        records = await cancellable(this.evidenceLoader(result.rows.map(row => row.symbol), signal), signal);
        if (!Array.isArray(records)) throw Error('选股证据库返回格式无效');
      } catch (error) {
        if (signal.aborted) throw Error('已取消选股，本次结果未应用');
        records = []; failure = `证据读取失败：${error.message}`;
      }
    }
    if (signal.aborted) throw Error('已取消选股，本次结果未应用');
    const now = this.clock(), bySymbol = new Map();
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      if (!bySymbol.has(record.symbol)) bySymbol.set(record.symbol, []);
      bySymbol.get(record.symbol).push(record);
    }
    const reviewed = result.rows.map(row => {
      const selectionEvidence = evaluateEvidence(bySymbol.get(row.symbol) || [], result.query.evidence, now);
      if (failure) selectionEvidence.loadError = failure;
      this.progress.completed++;
      return { ...row, selectionEvidence };
    });
    const rows = reviewed.filter(row => row.selectionEvidence.status === 'pass');
    const evidencePendingRows = reviewed.filter(row => row.selectionEvidence.status === 'pending');
    const evidenceFailedRows = reviewed.filter(row => row.selectionEvidence.status === 'fail');
    const evidenceScreen = { evaluated: reviewed.length, passed: rows.length, pending: evidencePendingRows.length, failed: evidenceFailedRows.length, checkedAt: now.toISOString() };
    const unavailable = result.status === 'unavailable' || (!rows.length && evidencePendingRows.length > 0);
    const message = `量化条件命中后核验选股证据 ${reviewed.length} 只：符合 ${rows.length} 只，待核验 ${evidencePendingRows.length} 只，不符合 ${evidenceFailedRows.length} 只。${failure ? failure + '。' : ''}`;
    return { ...result, rows, evidenceScreen, evidencePendingRows, evidenceFailedRows,
      status: unavailable ? 'unavailable' : rows.length ? 'ready' : 'empty', matched: unavailable ? null : rows.length,
      partial: result.partial || evidencePendingRows.length > 0,
      dataMessage: `${result.dataMessage}${result.dataMessage ? '。' : ''}${message}`, ...quoteRange(rows) };
  }
  screenPerformanceResult(result) {
    const reviewed = result.rows;
    const rows = reviewed.filter(row => row.performanceReview?.status === 'pass');
    const performancePendingRows = reviewed.filter(row => row.performanceReview?.status !== 'pass' && row.performanceReview?.status !== 'failed');
    const performanceFailedRows = reviewed.filter(row => row.performanceReview?.status === 'failed');
    const performanceScreen = { enabled: true, evaluated: reviewed.length, passed: rows.length, pending: performancePendingRows.length,
      failed: performanceFailedRows.length, checkedAt: this.clock().toISOString() };
    const unavailable = result.status === 'unavailable' || !rows.length && performancePendingRows.length > 0;
    const message = `业绩预告/快报条件核验 ${reviewed.length} 只：符合 ${rows.length} 只，待核验 ${performancePendingRows.length} 只，不符合 ${performanceFailedRows.length} 只；预测和初步核算不替代正式财报。`;
    return { ...result, rows, performanceScreen, performancePendingRows, performanceFailedRows,
      status: unavailable ? 'unavailable' : rows.length ? 'ready' : 'empty', matched: unavailable ? null : rows.length,
      partial: result.partial || performancePendingRows.length > 0, dataMessage: `${result.dataMessage}${result.dataMessage ? '。' : ''}${message}`, ...quoteRange(rows) };
  }
  async screenResearch(result, signal, force = false) {
    // Runtime import keeps the ordinary quote/finance path independent of
    // document parsing, and avoids creating a normalization dependency cycle.
    const { evaluateOperatingResearch, refreshOperatingResearch } = require('./company-research.cjs');
    const reviews = new Map(), errors = new Map(); let next = 0;
    this.progress = { loading: true, stage: 'research', completed: 0, total: result.rows.length };
    await Promise.all(Array.from({ length: Math.min(3, result.rows.length) }, async () => {
      while (next < result.rows.length && !signal.aborted) {
        const row = result.rows[next++]; let bundle = null;
        if (result.query.research.path === 'product') {
          try {
            if (!this.automaticEvidenceLoader) throw Error('公开产品资料采集服务未配置');
            bundle = await cancellable(this.automaticEvidenceLoader(row.symbol, { signal, force, includeIndustry: false,
              onProgress: detail => { if (!signal.aborted) this.progress.detail = { ...detail, name: row.name || row.symbol }; } }), signal);
            if (bundle?.symbol !== row.symbol) throw Error('产品资料股票代码不符');
          } catch (error) {
            if (signal.aborted) return;
            errors.set(row.symbol, error.message || '产品资料获取失败');
            bundle = null;
          }
        }
        // Reduce each report to traceable metrics before requesting another
        // company; never retain the whole market's PDF text until batch end.
        try { reviews.set(row.symbol, evaluateOperatingResearch(bundle, result.query.research, { symbol: row.symbol, now: this.clock(), company: row, companyError: row.financeError || null })); }
        catch (error) {
          errors.set(row.symbol, error.message || '经营研究资料无法核验');
          reviews.set(row.symbol, evaluateOperatingResearch(null, result.query.research, { symbol: row.symbol, now: this.clock(), company: null, companyError: errors.get(row.symbol) }));
        }
        this.progress.completed++;
      }
    }));
    if (signal.aborted) throw Error('已取消选股，本次结果未应用');
    const now = this.clock();
    const reviewed = result.rows.map(row => {
      const researchReview = refreshOperatingResearch(reviews.get(row.symbol), { company: row, now });
      if (errors.has(row.symbol)) {
        researchReview.loadError = errors.get(row.symbol);
        researchReview.acquisition = [...(researchReview.acquisition || []), { code: 'fetch-failed', label: '产品资料未完成', reason: errors.get(row.symbol), action: '重试产品资料', retryable: true }];
      }
      return { ...row, researchReview };
    });
    const rows = reviewed.filter(row => row.researchReview.status === 'pass'), researchPendingRows = reviewed.filter(row => row.researchReview.status === 'pending');
    const researchFailedRows = reviewed.filter(row => row.researchReview.status === 'failed');
    const researchScreen = { enabled: true, path: result.query.research.path, evaluated: reviewed.length, passed: rows.length, pending: researchPendingRows.length,
      failed: researchFailedRows.length, checkedAt: now.toISOString() };
    const unavailable = result.status === 'unavailable' || !rows.length && researchPendingRows.length > 0;
    const message = `${result.query.research.path === 'product' ? '同一产品指标' : '公司经营指标'}条件核验 ${reviewed.length} 只：符合 ${rows.length} 只，待核验 ${researchPendingRows.length} 只，不符合 ${researchFailedRows.length} 只；未替换其他已选条件。`;
    return { ...result, rows, researchScreen, researchPendingRows, researchFailedRows,
      status: unavailable ? 'unavailable' : rows.length ? 'ready' : 'empty', matched: unavailable ? null : rows.length,
      partial: result.partial || researchPendingRows.length > 0, dataMessage: `${result.dataMessage}${result.dataMessage ? '。' : ''}${message}`, ...quoteRange(rows) };
  }
  refreshResearchResult(result) {
    if (!result.rows.length) return result;
    const { refreshOperatingResearch } = require('./company-research.cjs'), now = this.clock();
    // Announcement collection can outlive research freshness. Recheck only
    // surviving rows; a risk-excluded company must never be brought back here.
    const reviewed = result.rows.map(row => ({ ...row, researchReview: refreshOperatingResearch(row.researchReview, { company: row, now, notices: row.financeNoticeResponse }) }));
    const rows = reviewed.filter(row => row.researchReview.status === 'pass');
    const pending = reviewed.filter(row => row.researchReview.status === 'pending'), failed = reviewed.filter(row => row.researchReview.status === 'failed');
    const researchPendingRows = [...(result.researchPendingRows || []), ...pending], researchFailedRows = [...(result.researchFailedRows || []), ...failed];
    const researchScreen = { ...result.researchScreen, passed: result.researchScreen.passed - pending.length - failed.length,
      pending: researchPendingRows.length, failed: researchFailedRows.length, checkedAt: now.toISOString() };
    const unavailable = result.status === 'unavailable' || !rows.length && researchPendingRows.length > 0;
    const message = pending.length || failed.length ? `发布前重新核验经营资料：新增待核验 ${pending.length} 只，不符合 ${failed.length} 只，最终保留 ${rows.length} 只。` : '';
    return { ...result, rows, researchScreen, researchPendingRows, researchFailedRows,
      status: unavailable ? 'unavailable' : rows.length ? 'ready' : 'empty', matched: unavailable ? null : rows.length,
      partial: result.partial || pending.length > 0, dataMessage: `${result.dataMessage}${message && result.dataMessage ? '。' : ''}${message}`, ...quoteRange(rows) };
  }
  screenMarketRisk(snapshot, query, watchlist) {
    const pool = screen(snapshot, { ...query, rules: [] }, watchlist).rows, now = this.clock();
    const accepted = [], excluded = [];
    for (const row of pool) {
      const market = { ...checkMarketRisk(row, now), price: Number.isFinite(row.price) ? row.price : null,
        source: snapshot.source || '来源未标注', basis: 'screen-snapshot', label: '条件快照' };
      const entryRisk = { status: market.status, market, notices: null, reasons: [...market.reasons] };
      if (market.status === 'clear') accepted.push({ ...row, entryRisk });
      else excluded.push({ ...row, entryRisk });
    }
    return { snapshot: { ...snapshot, rows: accepted }, excluded, checked: pool.length };
  }
  async refreshRiskQuotes(rows, signal) {
    const refreshed = new Map(), batches = [];
    for (let index = 0; index < rows.length; index += 50) batches.push(rows.slice(index, index + 50).map(row => row.symbol));
    let next = 0;
    this.progress = { loading: true, stage: 'risk-quotes', completed: 0, total: rows.length };
    await Promise.all(Array.from({ length: Math.min(3, batches.length) }, async () => {
      while (next < batches.length && !signal.aborted) {
        const symbols = batches[next++];
        try {
          const quotes = await cancellable(this.riskQuoteLoader(symbols, signal), signal);
          if (signal.aborted) return;
          for (const symbol of symbols) {
            const quote = quotes && Object.hasOwn(quotes, symbol) ? quotes[symbol] : null;
            if (quote?.symbol === symbol) refreshed.set(symbol, quote);
          }
        } catch {
          if (signal.aborted) return;
          // Missing/failed refreshes remain absent; never substitute the older screening quote.
        }
        this.progress.completed += symbols.length;
      }
    }));
    if (signal.aborted) throw Error('已取消选股，本次结果未应用');
    return refreshed;
  }
  async screenNoticeRisk(result, marketCheck, originalSnapshot, watchlist, strategyId, force, signal) {
    const checked = new Map(); let next = 0;
    this.progress = { loading: true, stage: 'notices', completed: 0, total: result.rows.length };
    await Promise.all(Array.from({ length: Math.min(3, result.rows.length) }, async () => {
      while (next < result.rows.length && !signal.aborted) {
        const row = result.rows[next++];
        try {
          if (!this.noticeLoader) throw Error('公告服务未配置');
          const response = await cancellable(this.noticeLoader(row.symbol, signal, force), signal);
          if (signal.aborted) return;
          let bundle;
          const review = checkNoticeRisk(response, row.symbol, this.clock());
          if (this.noticeEvidenceLoader && review.status === 'unverified' && review.coverageComplete && review.notices.length) {
            try { bundle = await cancellable(this.noticeEvidenceLoader(row.symbol, { noticeResponse: response, signal }), signal); }
            catch (error) {
              if (signal.aborted) return;
              bundle = { symbol: row.symbol, fetchedAt: this.clock().getTime(), documents: [], errors: [error.message || '公告原文获取失败'] };
            }
          }
          checked.set(row.symbol, { response, bundle });
        } catch (error) {
          if (signal.aborted) return;
          checked.set(row.symbol, { failed: true });
        }
        this.progress.completed++;
      }
    }));
    if (signal.aborted) throw Error('已取消选股，本次结果未应用');
    // Body parsing may outlive an earlier index. Refresh it once before the
    // final boundary; new titles still require matching full text of their own.
    if ([...checked.values()].some(item => item.bundle)) {
      const expired = [...checked].filter(([, item]) => item.response && this.clock().getTime() - item.response.fetchedAt > NOTICE_RISK_POLICY.noticeMaxAgeMs);
      let refreshNext = 0;
      await Promise.all(Array.from({ length: Math.min(3, expired.length) }, async () => {
        while (refreshNext < expired.length && !signal.aborted) {
          const [symbol, item] = expired[refreshNext++];
          try { item.response = await cancellable(this.noticeLoader(symbol, signal, true), signal); }
          catch { if (!signal.aborted) item.failed = true; }
        }
      }));
      if (signal.aborted) throw Error('已取消选股，本次结果未应用');
    }
    const marketEnabled = marketCheck !== null;
    const refreshed = marketEnabled && this.riskQuoteLoader ? await this.refreshRiskQuotes(result.rows, signal) : null;
    // Recheck all candidates at publication time, including those whose notices returned early.
    const finishedAt = this.clock();
    const reviewed = result.rows.map(row => {
      const loaded = checked.get(row.symbol), quote = refreshed ? refreshed.get(row.symbol) : row;
      const market = marketEnabled ? { ...checkMarketRisk(quote, finishedAt), price: Number.isFinite(quote?.price) ? quote.price : null,
        source: quote?.source || (refreshed ? '风险复核行情服务' : originalSnapshot.source || '来源未标注'),
        basis: refreshed ? 'risk-refresh' : 'screen-snapshot', label: refreshed ? '风险复核报价' : '条件快照' } : null;
      if (refreshed && !quote) market.reasons = ['风险复核报价获取失败或未返回对应股票，等待有效报价'];
      const notices = loaded.failed
        ? checkNoticeRisk({ symbol: row.symbol, section: 'notices', source: '东方财富', status: 'unavailable', error: '公告资料获取失败' }, row.symbol, finishedAt)
        : checkNoticeWithEvidence(loaded.response, row.symbol, loaded.bundle, finishedAt);
      const status = market?.status === 'blocked' || notices.status === 'blocked' ? 'blocked' : market?.status === 'unverified' || notices.status === 'unverified' ? 'unverified' : 'clear';
      const performanceReview = evaluatePerformanceRules(result.query.performance, notices, { symbol: row.symbol, now: finishedAt });
      return { ...row, financeNoticeResponse: loaded.failed ? null : loaded.response, performanceReview,
        entryRisk: { status, market, notices, reasons: [...(market?.reasons || []), ...notices.reasons] } };
    });
    const rows = reviewed.filter(row => row.entryRisk.status === 'clear');
    const finalExcluded = reviewed.filter(row => row.entryRisk.status !== 'clear');
    const lateMarketExcluded = finalExcluded.filter(row => row.entryRisk.market && row.entryRisk.market.status !== 'clear');
    const noticeExcluded = finalExcluded.filter(row => !row.entryRisk.market || row.entryRisk.market.status === 'clear');
    const riskExcluded = [...(marketCheck?.excluded || []), ...finalExcluded];
    const unverified = riskExcluded.filter(row => row.entryRisk.status === 'unverified').length;
    const riskScreen = { enabled: true, marketEnabled, strategyId, label: marketEnabled ? '短线当日行情与近期公告检查' : '近期公告检查', marketChecked: marketCheck?.checked || 0,
      marketExcluded: (marketCheck?.excluded.length || 0) + lateMarketExcluded.length, noticeChecked: reviewed.length, noticeExcluded: noticeExcluded.length,
      blocked: riskExcluded.length - unverified, unverified, excluded: riskExcluded.length, cleared: rows.length };
    const unavailable = result.status === 'unavailable' || (!rows.length && unverified > 0);
    const riskMessage = `${marketEnabled ? `当日行情检查 ${riskScreen.marketChecked} 只，排除 ${riskScreen.marketExcluded} 只；` : ''}指标命中后公告检查 ${riskScreen.noticeChecked} 只，排除 ${riskScreen.noticeExcluded} 只。风险排除共 ${riskScreen.excluded} 只，其中待核验 ${unverified} 只；保留 ${rows.length} 只观察候选。`;
    return { ...result, rows, riskExcluded, riskScreen, labels: [...result.labels, riskScreen.label],
      status: unavailable ? 'unavailable' : rows.length ? 'ready' : 'empty', matched: unavailable ? null : rows.length,
      partial: result.partial || unverified > 0, poolCount: marketCheck?.checked ?? result.poolCount, eligibleCount: originalSnapshot.rows.length,
      watchlistMissing: result.query.scope === 'watchlist' ? (watchlist || []).filter(symbol => !originalSnapshot.rows.some(row => row.symbol === symbol)).length : 0,
      dataMessage: `${result.dataMessage}${result.dataMessage ? '。' : ''}${riskMessage}`, ...quoteRange(rows) };
  }
  async scanFinance(snapshot, query, watchlist, force, signal, observationTime = undefined, cachePolicy = null) {
    if (!this.financeLoader) throw Error('财务资料服务未配置，无法筛选');
    const base = screen(snapshot, { ...query, rules: query.rules.filter(r => !isTechnical(r) && !isFinancial(r)) }, watchlist);
    const startedAt = this.clock().getTime(), now = new Date(observationTime === undefined ? startedAt : observationTime.getTime());
    if (!Number.isFinite(now.getTime())) throw Error('财务扫描观察时点无效');
    const cutoff = cnTime(now).date, enriched = new Map(), failures = { missing: 0, invalid: 0, fetch: 0 };
    const candidateCache = cachePolicy?.mode === 'candidate';
    const requiredFields = cachePolicy?.requiredFinanceFields || [...query.rules.filter(isFinancial).flatMap(ruleFields), ...(query.research?.enabled && query.research.path === 'company' ? query.research.rules.map(rule => rule.field) : [])];
    const cache = { policy: candidateCache ? 'candidate-finance-6h' : 'interactive-60s', hits: 0, requested: 0, fetched: 0 };
    let next = 0;
    this.progress = { loading: true, stage: 'finance', completed: 0, total: base.rows.length };
    await Promise.all(Array.from({ length: Math.min(3, base.rows.length) }, async () => {
      while (next < base.rows.length && !signal.aborted) {
        const row = base.rows[next++];
        try {
          let entry = this.financeCache.get(row.symbol), cachedData;
          const saved = candidateCache && this.screeningDataCache.get('finance', row.symbol), checkedAt = this.clock();
          if (saved && !cachePolicy.refreshQuantitative && saved.cutoff === cutoff && saved.observedAt <= now.getTime()
              && recent(saved.loadedAt, checkedAt.getTime(), FINANCE_MAX_AGE_MS) && recent(saved.result?.fetchedAt, checkedAt.getTime(), FINANCE_MAX_AGE_MS)) {
            try {
              cachedData = normalizeFinance(saved.result, row.symbol, now, checkedAt);
              if (cachedData.financeReportVersion !== saved.reportVersion || cachedData.financeSource === '来源未标注'
                  || !requiredFields.every(field => fieldAvailable(cachedData, field))
                  || cachePolicy.requireIndustry && cachedData.financeApplicability?.status === 'pending') cachedData = null;
            } catch { cachedData = null; }
          }
          if (candidateCache ? !cachedData : force || !entry || entry.cutoff !== cutoff || this.clock().getTime() - entry.loadedAt >= 60000) {
            // Candidate updates refresh quotes separately. A cache miss must
            // bypass the provider's own cache, including retrying missing fields.
            cache.requested++;
            const result = await cancellable(this.financeLoader(row.symbol, signal, candidateCache ? true : force), signal);
            if (signal.aborted) return;
            const receivedAt = this.clock();
            entry = { cutoff, loadedAt: receivedAt.getTime(), data: normalizeFinance(result, row.symbol, now, receivedAt) };
            this.financeCache.set(row.symbol, entry);
            cache.fetched++;
            if (candidateCache) {
              if (entry.data.financeSource !== '来源未标注' && requiredFields.every(field => fieldAvailable(entry.data, field))) this.screeningDataCache.set('finance', row.symbol,
                { cutoff, loadedAt: entry.loadedAt, observedAt: now.getTime(), reportVersion: entry.data.financeReportVersion, result });
              else this.screeningDataCache.delete('finance', row.symbol);
            }
          } else {
            cache.hits++;
            if (candidateCache) entry = { data: cachedData };
            else entry = { ...entry, data: refreshFinanceSnapshot(entry.data, row.symbol, now, { checkedAt: this.clock() }) };
          }
          if (Object.values(entry.data.financeFieldChecks || {}).some(check => check.reasonCode === 'invalid')) {
            failures.invalid++;
            this.financeCache.delete(row.symbol);
            if (candidateCache) this.screeningDataCache.delete('finance', row.symbol);
          }
          enriched.set(row.symbol, { ...row, ...entry.data });
        } catch (error) {
          if (signal.aborted) return;
          this.financeCache.delete(row.symbol);
          if (candidateCache) this.screeningDataCache.delete('finance', row.symbol);
          const kind = ['missing', 'invalid'].includes(error.code) ? error.code : 'fetch'; failures[kind]++;
          enriched.set(row.symbol, { ...row, ...Object.fromEntries(Object.keys(FINANCIAL_FIELDS).map(field => [field, null])), financeError: kind });
        }
        this.progress.completed++;
      }
    }));
    if (candidateCache) await this.screeningDataCache.flush(this.clock().getTime());
    const sources = [...new Set([...enriched.values()].map(row => row.financeSource).filter(Boolean))];
    // Financial enrichment belongs only to this run, never to quote history.
    return { ...snapshot, rows: snapshot.rows.map(row => enriched.get(row.symbol) || row), financeScan: { startedAt, finishedAt: this.clock().getTime(), asOfCutoff: now.toISOString(), source: `${sources.join(' / ') || '财务来源不可用'} · 最新已公告报告期`, failures, cache,
      ...(candidateCache && this.screeningDataCache.warning ? { cacheWarning: this.screeningDataCache.warning } : {}) } };
  }
  async scanDaily(snapshot, query, watchlist, force, signal, observationTime = undefined, cachePolicy = null) {
    if (!this.dailyLoader) throw Error('技术日线服务未配置，无法筛选');
    const base = screen(snapshot, { ...query, rules: query.rules.filter(r => !isTechnical(r)) }, watchlist);
    const startedAt = this.clock().getTime(), now = new Date(observationTime === undefined ? startedAt : observationTime.getTime());
    if (!Number.isFinite(now.getTime())) throw Error('日线扫描观察时点无效');
    const cn = cnTime(now), cutoff = `${cn.date}:${cn.minutes >= 900 ? 'closed' : 'intraday'}`;
    const enriched = new Map(), failures = { insufficient: 0, invalid: 0, fetch: 0 };
    const candidateCache = cachePolicy?.mode === 'candidate';
    const cache = { policy: candidateCache ? 'candidate-complete-session' : 'interactive-60s', hits: 0, requested: 0, fetched: 0 };
    const compatible = (entry, row) => {
      const expected = cachePolicy.expectedDailyDate;
      const reference = Number.isFinite(row.timestamp) && cnTime(row.timestamp).date === expected ? row.price : row.prevClose;
      return expected && entry?.data?.technicalAsOf === expected && entry.quoteSource === snapshot.source
        && entry.priceBasis === 'unadjusted' && entry.observedAt <= now.getTime()
        && typeof entry.data.technicalSource === 'string' && entry.data.technicalSource !== '来源未标注'
        && entry.fetchedAt === entry.loadedAt && recent(entry.loadedAt, this.clock().getTime(), DAILY_MAX_AGE_MS)
        && Number.isFinite(reference) && reference > 0 && Number.isFinite(entry.data.close) && Math.abs(entry.data.close - reference) <= 0.011
        && Object.keys(TECHNICAL_FIELDS).every(field => fieldAvailable(entry.data, field));
    };
    let next = 0;
    this.progress = { loading: true, stage: 'daily', completed: 0, total: base.rows.length };
    await Promise.all(Array.from({ length: Math.min(3, base.rows.length) }, async () => {
      while (next < base.rows.length && !signal.aborted) {
        const row = base.rows[next++];
        try {
          let entry = candidateCache ? this.screeningDataCache.get('daily', row.symbol) : this.dailyCache.get(row.symbol);
          if (candidateCache ? cachePolicy.refreshQuantitative || !compatible(entry, row) : force || !entry || entry.cutoff !== cutoff || this.clock().getTime() - entry.fetchedAt >= 60000) {
            cache.requested++;
            const data = await cancellable(this.dailyLoader(row.symbol, signal), signal), bars = Array.isArray(data) ? data : data?.bars;
            if (signal.aborted) return;
            const daily = dailyIndicators(bars, now);
            if (!Array.isArray(data) && Object.hasOwn(data, 'dailyEvidence')
              && (!preparedHistoryValid(data, row.symbol, 'stock', this.clock().getTime()) || daily.asOf !== data.dailyEvidence?.asOf))
              throw Object.assign(Error('日线证据无效或未覆盖最近完整交易日'), { code: 'invalid' });
            const fetchedAt = !Array.isArray(data) && Number.isFinite(data.fetchedAt) ? data.fetchedAt : this.clock().getTime();
            entry = { cutoff, fetchedAt, data: { ...Object.fromEntries(Object.keys(TECHNICAL_FIELDS).map(field => [field, daily[field]])), technicalAsOf: daily.asOf, technicalSource: data.source || '来源未标注' } };
            this.dailyCache.set(row.symbol, entry);
            cache.fetched++;
            if (candidateCache) {
              const saved = { ...entry, loadedAt: entry.fetchedAt, observedAt: now.getTime(), quoteSource: snapshot.source, priceBasis: 'unadjusted' };
              if (compatible(saved, row)) this.screeningDataCache.set('daily', row.symbol, saved);
              else this.screeningDataCache.delete('daily', row.symbol);
            }
          } else {
            cache.hits++;
          }
          enriched.set(row.symbol, { ...row, ...entry.data, technicalFetchedAt: entry.fetchedAt, technicalError: null, technicalErrorDetail: null });
        } catch (error) {
          if (signal.aborted) return;
          this.dailyCache.delete(row.symbol);
          if (candidateCache) this.screeningDataCache.delete('daily', row.symbol);
          const kind = ['insufficient', 'invalid'].includes(error.code) ? error.code : 'fetch'; failures[kind]++;
          enriched.set(row.symbol, { ...row, ...Object.fromEntries(Object.keys(TECHNICAL_FIELDS).map(field => [field, null])),
            technicalAsOf: null, technicalSource: null, technicalFetchedAt: null, technicalError: kind, technicalErrorDetail: error.message || String(error) });
        }
        this.progress.completed++;
      }
    }));
    if (candidateCache) await this.screeningDataCache.flush(this.clock().getTime());
    // Keep cached snapshots and saved history quote-only; technical data belongs to this run.
    const sources = [...new Set([...enriched.values()].map(row => row.technicalSource).filter(Boolean))];
    return { ...snapshot, rows: snapshot.rows.map(row => enriched.get(row.symbol) || row), technicalScan: { startedAt, finishedAt: this.clock().getTime(), asOfCutoff: now.toISOString(), source: `${sources.join(' / ') || '日线来源不可用'} · 完整未复权日线`, failures, cache,
      ...(candidateCache && this.screeningDataCache.warning ? { cacheWarning: this.screeningDataCache.warning } : {}) } };
  }
}
module.exports = { FIELDS, SNAPSHOT_FIELDS, TECHNICAL_FIELDS, FINANCIAL_FIELDS, BOARDS, OPS, RESEARCH_METADATA, PERFORMANCE_METADATA, defaults, financialQualityRules, validate, describe, parseDescription, normalize, normalizeFinance, fieldAvailable, quoteTimeAvailable, quoteRange, screen, classifyScreenRow, cancellable, Screener };
