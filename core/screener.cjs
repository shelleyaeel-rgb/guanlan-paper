const { symbolOf, cnTime } = require('./common.cjs');
const { dailyIndicators } = require('./daily-indicators.cjs');
const { setTimeout: delay } = require('node:timers/promises');

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
  macd: { label: 'MACD 柱', aliases: ['MACD柱', 'MACD'], unit: '元', source: 'daily', description: 'MACD(12,26,9) 柱 = 2 × (DIF − DEA)，为正不等于 DIF、DEA 均在零轴上方。' },
  rsi: { label: 'RSI(14)', aliases: ['RSI(14)', 'RSI14', 'RSI'], unit: '', min: 0, max: 100, source: 'daily', description: 'Wilder RSI(14)，范围 0–100。' },
  dailyVolumeRatio: { label: '日量比', aliases: ['完整日线量比', '日量比'], unit: '倍', min: 0, source: 'daily', description: '完整日成交量 ÷ 此前 20 根日线平均成交量，与行情源量比分开。' }
};
const FIELDS = { ...SNAPSHOT_FIELDS, ...TECHNICAL_FIELDS };
const ruleFields = rule => [rule.field, ...(rule.valueField ? [rule.valueField] : [])];
const isTechnical = rule => ruleFields(rule).some(field => FIELDS[field].source === 'daily');
const compare = (a, op, b) => ({ gt: a > b, gte: a >= b, lt: a < b, lte: a <= b, eq: a === b })[op];
const matches = (row, rule) => compare(row[rule.field], rule.op, rule.valueField ? row[rule.valueField] : rule.value);
const BOARDS = { sh: '沪市主板', sz: '深市主板', chinext: '创业板', star: '科创板' };
const OPS = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' };
function defaults() { return { scope: 'all', boards: [], excludeST: false, rules: [] }; }
function validate(input) {
  if (!input || !['all', 'watchlist'].includes(input.scope) || !Array.isArray(input.boards) || input.boards.some(b => !Object.hasOwn(BOARDS, b)) || typeof input.excludeST !== 'boolean' || !Array.isArray(input.rules) || input.rules.length > 30) throw Error('选股条件格式无效');
  const query = { scope: input.scope, boards: [...new Set(input.boards)], excludeST: input.excludeST, rules: [] };
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
  return [query.scope === 'watchlist' ? '我的自选' : '沪深 A 股', ...(query.boards.length ? [query.boards.map(b => BOARDS[b]).join(' / ')] : []), ...(query.excludeST ? ['排除 ST / *ST / 退市标记'] : []), ...query.rules.map(r => `${FIELDS[r.field].label} ${OPS[r.op]} ${r.valueField ? FIELDS[r.valueField].label : `${r.value} ${FIELDS[r.field].unit}`}`)];
}
const NUM = '(-?\\d+(?:\\.\\d+)?)\\s*(亿元|亿|万元|万手|万|元|手|%|倍)?';
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
  if (!query.rules.length && !query.boards.length && !query.excludeST && !/全市场|A\s*股|自选/i.test(text)) throw Error('没有识别到筛选条件，请参考下方示例');
  if (query.rules.some(r => r.field === 'pe')) notes.push('市盈率按行情源的动态口径筛选；若要排除负值，请补充“市盈率大于 0”。');
  if (query.rules.some(isTechnical)) notes.push('技术指标使用完整未复权日线；向上指较前一根日线上升，上方为严格大于。MACD 指柱值，RSI 为 Wilder(14)，日量比对比此前 20 根日线均量。');
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
  const result = { symbol, name, board, isST: /ST|退/i.test(name), price: scaled('f2'), changePct: scaled('f3'), volume: scaled('f5', 10000), amount: scaled('f6', 1e8), amplitude: scaled('f7'), turnover: scaled('f8'), pe: scaled('f9'), volumeRatio: scaled('f10'), marketCap: scaled('f20', 1e8), floatCap: scaled('f21', 1e8), pb: scaled('f23'), timestamp: scaled('f124', 0.001) };
  for (const field of Object.keys(SNAPSHOT_FIELDS)) if (!fieldAvailable(result, field)) result[field] = null;
  if (!quoteTimeAvailable(result)) result.timestamp = null;
  return result;
}
function screen(snapshot, input, watchlist = []) {
  const query = validate(input), watched = new Set(watchlist);
  const pool = snapshot.rows.filter(r => (query.scope !== 'watchlist' || watched.has(r.symbol)) && (!query.boards.length || query.boards.includes(r.board)) && (!query.excludeST || !r.isST));
  const requiredFields = [...new Set(query.rules.flatMap(ruleFields))];
  const technical = query.rules.some(isTechnical), baseRules = query.rules.filter(r => !isTechnical(r));
  const baseFields = [...new Set(baseRules.flatMap(ruleFields))];
  const baseCandidates = pool.filter(row => baseFields.every(field => fieldAvailable(row, field)));
  const dailyPool = baseCandidates.filter(row => baseRules.every(rule => matches(row, rule)));
  const candidates = (technical ? dailyPool : baseCandidates).filter(row => requiredFields.every(field => fieldAvailable(row, field)));
  const missingByField = Object.fromEntries([...Object.keys(SNAPSHOT_FIELDS), ...requiredFields.filter(field => FIELDS[field].source === 'daily')].map(field => [field, (FIELDS[field].source === 'daily' ? dailyPool : pool).filter(row => !fieldAvailable(row, field)).length]));
  missingByField.timestamp = pool.filter(row => !quoteTimeAvailable(row)).length;
  const rows = candidates.filter(row => query.rules.every(rule => matches(row, rule)));
  const missing = pool.length - baseCandidates.length + (technical ? dailyPool.length - candidates.length : 0);
  const unavailable = pool.length > 0 && (baseCandidates.length === 0 || (technical && dailyPool.length > 0 && candidates.length === 0));
  const absent = requiredFields.filter(field => missingByField[field] > 0 && missingByField[field] === (FIELDS[field].source === 'daily' ? dailyPool.length : pool.length));
  let dataMessage = unavailable ? (absent.length ? `${absent.map(field => FIELDS[field].label).join('、')}数据暂不可用，本次无法筛选` : '没有股票具备本次所需的完整指标，本次无法筛选') : '';
  if (technical) {
    const failures = snapshot.technicalScan?.failures || {};
    const unavailableMetrics = Math.max(0, dailyPool.length - candidates.length - Object.values(failures).reduce((a, b) => a + b, 0));
    dataMessage += `${dataMessage ? '。' : ''}技术候选 ${dailyPool.length} 只，指标齐全 ${candidates.length} 只；日线不足 ${failures.insufficient || 0} 只，日线无效 ${failures.invalid || 0} 只，获取失败 ${failures.fetch || 0} 只。${unavailableMetrics ? `另有 ${unavailableMetrics} 只所需技术指标不可计算。` : ''}${missing ? '存在未能判断的股票，匹配数量仅覆盖可判断部分。' : ''}`;
  }
  return { ...snapshot, rows, query, labels: describe(query), status: unavailable ? 'unavailable' : rows.length ? 'ready' : 'empty', dataMessage, matched: unavailable ? null : rows.length, poolCount: pool.length, eligibleCount: snapshot.rows.length, evaluatedCount: pool.length - missing, missing, partial: missing > 0, technical, technicalCandidates: technical ? dailyPool.length : 0, technicalEvaluatedCount: technical ? candidates.length : 0, requiredFields, missingByField, watchlistMissing: query.scope === 'watchlist' ? watchlist.filter(s => !snapshot.rows.some(r => r.symbol === s)).length : 0, ...quoteRange(rows) };
}
class Screener {
  constructor(fetcher = fetch, history = null, dailyLoader = null, clock = () => new Date()) {
    this.fetcher = fetcher; this.history = history; this.dailyLoader = dailyLoader; this.clock = clock;
    this.snapshot = null; this.pending = null; this.activeRun = null; this.dailyCache = new Map();
    this.progress = { loading: false, stage: 'quotes', completed: 0, total: 0 };
  }
  cancel() { if (this.activeRun) this.activeRun.abort(); }
  async page(number) {
    const params = new URLSearchParams({ pn: number, pz: 100, po: 0, np: 1, fltt: 2, invt: 2, fid: 'f12', fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', fields: 'f2,f3,f5,f6,f7,f8,f9,f10,f12,f13,f14,f20,f21,f23,f124' });
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
  async run(input, watchlist, force = false, snapshotId = null) {
    const query = validate(input);
    if (snapshotId !== null && (typeof snapshotId !== 'string' || !snapshotId || force)) throw Error('历史快照选择无效，请切换至最新行情后刷新');
    const technical = query.rules.some(isTechnical);
    if (technical && snapshotId !== null) throw Error('历史快照未保存技术日线，无法用于技术条件；请选择最新行情，或移除技术条件');
    if (this.activeRun) throw Error('已有选股任务进行中，请等待完成或取消');
    const controller = new AbortController(); this.activeRun = controller;
    try {
      let snapshot = snapshotId === null ? await this.load(force) : this.history?.get(snapshotId);
      if (controller.signal.aborted) throw Error('已取消选股，本次结果未应用');
      if (!snapshot) throw Error('所选历史快照已不可用，请重新选择或更新最新行情');
      if (technical) snapshot = await this.scanDaily(snapshot, query, watchlist, force, controller.signal);
      if (controller.signal.aborted) throw Error('已取消选股，本次结果未应用');
      return { ...screen(snapshot, query, watchlist), dataMode: snapshotId === null ? 'latest' : 'historical', snapshotId, historyWarning: this.history?.warning || '' };
    } finally { this.activeRun = null; this.progress.loading = false; }
  }
  async scanDaily(snapshot, query, watchlist, force, signal) {
    if (!this.dailyLoader) throw Error('技术日线服务未配置，无法筛选');
    const base = screen(snapshot, { ...query, rules: query.rules.filter(r => !isTechnical(r)) }, watchlist);
    const now = this.clock(), cn = cnTime(now), cutoff = `${cn.date}:${cn.minutes >= 900 ? 'closed' : 'intraday'}`;
    const enriched = new Map(), failures = { insufficient: 0, invalid: 0, fetch: 0 };
    const startedAt = now.getTime(); let next = 0;
    this.progress = { loading: true, stage: 'daily', completed: 0, total: base.rows.length };
    await Promise.all(Array.from({ length: Math.min(3, base.rows.length) }, async () => {
      while (next < base.rows.length && !signal.aborted) {
        const row = base.rows[next++];
        try {
          let entry = this.dailyCache.get(row.symbol);
          if (force || !entry || entry.cutoff !== cutoff || this.clock().getTime() - entry.fetchedAt >= 60000) {
            const data = await this.dailyLoader(row.symbol, signal), bars = Array.isArray(data) ? data : data.bars;
            if (signal.aborted) return;
            const daily = dailyIndicators(bars, now);
            entry = { cutoff, fetchedAt: this.clock().getTime(), data: { ...Object.fromEntries(Object.keys(TECHNICAL_FIELDS).map(field => [field, daily[field]])), technicalAsOf: daily.asOf, technicalSource: data.source || '来源未标注' } };
            this.dailyCache.set(row.symbol, entry);
          }
          enriched.set(row.symbol, { ...row, ...entry.data, technicalFetchedAt: entry.fetchedAt });
        } catch (error) {
          if (signal.aborted) return;
          this.dailyCache.delete(row.symbol);
          const kind = ['insufficient', 'invalid'].includes(error.code) ? error.code : 'fetch'; failures[kind]++;
          enriched.set(row.symbol, { ...row, technicalError: kind });
        }
        this.progress.completed++;
      }
    }));
    // Keep cached snapshots and saved history quote-only; technical data belongs to this run.
    const sources = [...new Set([...enriched.values()].map(row => row.technicalSource).filter(Boolean))];
    return { ...snapshot, rows: snapshot.rows.map(row => enriched.get(row.symbol) || row), technicalScan: { startedAt, finishedAt: this.clock().getTime(), asOfCutoff: now.toISOString(), source: `${sources.join(' / ') || '日线来源不可用'} · 完整未复权日线`, failures } };
  }
}
module.exports = { FIELDS, SNAPSHOT_FIELDS, TECHNICAL_FIELDS, BOARDS, OPS, defaults, validate, describe, parseDescription, normalize, fieldAvailable, quoteTimeAvailable, quoteRange, screen, Screener };
