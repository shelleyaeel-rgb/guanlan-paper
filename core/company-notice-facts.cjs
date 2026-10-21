'use strict';
// Disclosure facts and a narrowly scoped sensitive-title gate. Passing this
// gate is neither a stock-selection signal nor authorization to place a trade.
const compact = value => String(value || '').normalize('NFKC').replace(/\s+/g, '');
const number = value => Number(String(value).replace(/,/g, ''));
const NUM = '[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const VALID_NUMBER = new RegExp(`^${NUM}$`);
const DATE = '(\\d{4})年(\\d{1,2})月(\\d{1,2})日';
const RANGE = '[—–－～~-]';
const GROWTH_TOLERANCE_PCT = 0.02; // Percentage points; reported two-decimal rounding, not a selection threshold.
const LABELS = { forecast: '业绩预告', flash: '业绩快报', reduction: '减持结果', unlock: '解除限售', unsupported: '其他敏感公告' };
function noticeType(title) {
  if (/业绩预告/.test(title)) return 'forecast';
  if (/业绩快报/.test(title)) return 'flash';
  if (/减持/.test(title) && /结果|完成|实施完毕/.test(title) && !/终止|取消/.test(title)) return 'reduction';
  if (/解禁|解除限售/.test(title)) return 'unlock';
  return 'unsupported';
}
function isoDate(parts) {
  const value = `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
}
const evidence = (page, quote) => ({ page: page.page, method: page.method, quote: quote.trim() });
function paragraphs(document) {
  return document.pageTexts.flatMap(page => page.text.split(/[。；;]/).map(text => ({ page, text, value: compact(text) })));
}
function check(key, label, value, records = [], reason = '') {
  return { key, label, status: value == null ? 'missing' : 'verified', value, records,
    reason: reason || (value == null ? `${label}尚未可靠识别` : `${label}已按公告原文核实`) };
}
function uniqueField(document, key, label, expression, convert = match => match[1]) {
  const found = [];
  for (const entry of paragraphs(document)) {
    const regex = new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : expression.flags + 'g');
    for (const match of entry.value.matchAll(regex)) {
      const value = convert(match);
      if (value != null) found.push({ value, record: evidence(entry.page, entry.text) });
    }
  }
  const values = [...new Set(found.map(item => JSON.stringify(item.value)))];
  const result = check(key, label, values.length === 1 ? found[0].value : null, found.map(item => item.record));
  if (values.length > 1) Object.assign(result, { status: 'conflict', reason: `${label}存在多个不同值，未合并或任选其一` });
  return result;
}
function periodCheck(document, type) {
  const periodLabel = '(?:业绩(?:预告|快报)(?:期间|报告期)|报告期间|本报告期|报告期)';
  const explicit = uniqueField(document, 'period', '业绩报告期间', new RegExp(`${periodLabel}[:：]?${DATE}[-—–～~至]${DATE}`), match => {
    const start = isoDate(match.slice(1, 4)), end = isoDate(match.slice(4, 7));
    return start && end && start <= end ? { start, end, basis: 'explicit-dates' } : null;
  });
  // An invalid explicit period must not be replaced by an inferred period.
  if (explicit.status !== 'missing' || type !== 'flash' || new RegExp(`${periodLabel}(?:[:：]|(?=\\d{4}年))`).test(compact(document.text))) return explicit;
  const period = /(?<year>20\d{2})年(?:前三季度|第三季度|三季度)业绩快报/.exec(compact(document.title));
  const entry = paragraphs(document).find(item => /本报告期[”"']?指年初至本季度末9个月期间/.test(item.value));
  if (!period || !entry) return explicit;
  return check('period', '业绩报告期间', { start: `${period.groups.year}-01-01`, end: `${period.groups.year}-09-30`, basis: 'title-and-nine-month-definition' }, [evidence(entry.page, entry.text)]);
}
function reconcilePerformancePeriod(period, document, type) {
  if (period.status !== 'verified') return;
  const named = /(20\d{2})年(第一季度|一季度|半年度|上半年|前三季度|第三季度|三季度|度)?业绩(?:预告|快报)/.exec(compact(document.title));
  const endings = { 第一季度: '03-31', 一季度: '03-31', 半年度: '06-30', 上半年: '06-30', 前三季度: '09-30', 第三季度: '09-30', 三季度: '09-30', 度: '12-31', '': '12-31' };
  const starts = named && ['第三季度', '三季度'].includes(named[2]) ? ['01-01', '07-01'] : ['01-01'];
  if (!named || !starts.some(start => period.value.start === `${named[1]}-${start}`) || period.value.end !== `${named[1]}-${endings[named[2] || '']}`) {
    Object.assign(period, { status: 'conflict', reason: '业绩标题与原文期间尚未形成唯一一致口径；累计和单季度数据不能互换或跨表拼接' });
    return;
  }
  Object.assign(period.value, { aggregation: period.value.start.endsWith('-07-01') ? 'single-quarter' : 'cumulative',
    aggregationLabel: period.value.start.endsWith('-07-01') ? '第三季度单季' : '年初至期末累计' });
  if (type === 'flash' && period.value.end > document.publishedAt) Object.assign(period, { status: 'conflict', reason: '快报初步实际业绩期间晚于公告披露日期，期间口径待核实' });
}
const displayWidth = text => [...text].reduce((size, character) => size + (/[^\x00-\x7f]/.test(character) ? 2 : 1), 0);
function rangedForecastRow(page, lines, index, key, label) {
  const prior = lines.slice(0, index), headers = prior.filter(line => /本报告期\s{2,}上年同期\s*$/.test(line));
  const units = [...compact(prior.join('\n')).matchAll(/单位[:：](万元|亿元|元)/g)].map(item => item[1]);
  if (headers.length !== 1 || units.length !== 1) return null;
  const header = headers[0], headerStart = header.indexOf('本报告期'), prefix = header.slice(0, headerStart);
  if (compact(prefix) !== '项目') return null;
  const left = (displayWidth(prefix.trimEnd()) + displayWidth(prefix)) / 2, right = displayWidth(header.slice(0, header.indexOf('上年同期')));
  const first = new RegExp(`^\\s*(归属于上市公司|归属于母公司|扣除非经常性损)\\s{2,}(${NUM})\\s+[～~—-]\\s+(${NUM})\\s*$`).exec(lines[index]);
  const second = new RegExp(`^\\s*(股东的净利润|益后的净利润)\\s{2,}(${NUM})\\s*$`).exec(lines[index + 1] || '');
  const growth = new RegExp(`^\\s*(?:比上年同期|同比)(增长|上升|下降|减少)\\s{2,}(${NUM})%\\s+[～~—-]\\s+(${NUM})%\\s*$`).exec(lines[index + 2] || '');
  if (!first || !second || !growth || (key === 'netProfit') === first[1].startsWith('扣除')
    || !/^(?:归属于(?:上市公司|母公司)股东的净利润|扣除非经常性损益后的净利润)$/.test(first[1] + second[1])) return null;
  const inColumn = (line, values, minimum, maximum = Infinity) => {
    let offset = 0;
    return values.every(value => {
      const index = line.indexOf(value, offset); if (index < 0) return false;
      offset = index + value.length;
      const position = displayWidth(line.slice(0, index));
      return position >= minimum && position + displayWidth(value) <= maximum;
    });
  };
  if (displayWidth(first[1]) >= left || displayWidth(second[1]) >= left || !inColumn(lines[index], first.slice(2), left, right)
    || !inColumn(lines[index + 1], [second[2]], right) || !inColumn(lines[index + 2], growth.slice(2), left, right)) return null;
  const current = first.slice(2).map(number).sort((a, b) => a - b), previous = number(second[2]), changes = growth.slice(2).map(number);
  if (![...current, previous, ...changes].every(Number.isFinite) || changes.some(value => value < 0)) return null;
  const rates = changes.map(value => value * (/下降|减少/.test(growth[1]) ? -1 : 1)).sort((a, b) => a - b);
  return arithmetic(check(key, label, { current: { min: current[0], max: current[1] }, previous, unit: units[0], growthPct: { min: rates[0], max: rates[1] } },
    [evidence(page, [prior.find(line => /单位[:：]/.test(line)), header, ...lines.slice(index, index + 3)].join('\n'))]));
}
function positionedForecastRow(page, lines, index, key, label) {
  // Some issuer tables put the current value immediately ABOVE the row label.
  // Accept only the explicitly declared exact-value layout with preserved
  // columns, never an arbitrary preceding number or a value from the next row.
  const prior = lines.slice(0, index), headerIndexes = prior.map((line, at) => /本报告期\s{2,}上年同期\s*$/.test(line) ? at : -1).filter(at => at >= 0);
  if (headerIndexes.length !== 1 || !prior.some(line => /以确数进行业绩预告/.test(compact(line)))) return null;
  const units = [...compact(prior.join('\n')).matchAll(/单位[:：](万元|亿元|元)/g)].map(item => item[1]);
  if (units.length !== 1 || index < headerIndexes[0] + 2) return null;
  const header = prior[headerIndexes[0]], left = displayWidth(header.slice(0, header.indexOf('本报告期'))), right = displayWidth(header.slice(0, header.indexOf('上年同期')));
  const current = new RegExp(`^(\\s+)(${NUM})\\s*$`).exec(lines[index - 1]);
  const previous = new RegExp(`^(归属于上市公司股东的净利润|归属于母公司股东的净利润|扣除非经常性损益后的净利润)\\s{2,}(${NUM})\\s*$`).exec(lines[index]);
  const growth = new RegExp(`^\\s*(?:比上年同期|同比)(增长|上升|下降|减少)\\s{2,}(${NUM})%\\s*$`).exec(lines[index + 1] || '');
  if (!current || !previous || !growth || (key === 'netProfit') === previous[1].startsWith('扣除')) return null;
  const within = (line, token, minimum, maximum = Infinity) => {
    const start = displayWidth(line.slice(0, line.lastIndexOf(token)));
    return start >= minimum && start + displayWidth(token) <= maximum;
  };
  if (displayWidth(previous[1]) >= left || !within(lines[index - 1], current[2], left, right)
    || !within(lines[index], previous[2], right) || !within(lines[index + 1], growth[2], left, right)) return null;
  const values = [current[2], previous[2], growth[2]].map(number);
  if (values.some(value => !Number.isFinite(value)) || values[2] < 0) return null;
  const change = values[2] * (/下降|减少/.test(growth[1]) ? -1 : 1);
  return arithmetic(check(key, label, { current: { min: values[0], max: values[0] }, previous: values[1], unit: units[0], growthPct: { min: change, max: change } },
    [evidence(page, [prior.find(line => /单位[:：]/.test(line)), header, ...lines.slice(index - 1, index + 2)].join('\n'))]));
}
function forecastColumns(lines, index) {
  const prior = lines.slice(0, index), headers = prior.filter(line => /本报告期\s{2,}上年同期\s*$/.test(line));
  if (headers.length !== 1) return null;
  const header = headers[0], prefix = header.slice(0, header.indexOf('本报告期'));
  if (compact(prefix) !== '项目') return null;
  return { header, prior, left: (displayWidth(prefix.trimEnd()) + displayWidth(prefix)) / 2,
    right: displayWidth(header.slice(0, header.indexOf('上年同期'))) };
}
function tokensInColumns(line, tokens, minimum, maximum = Infinity) {
  let offset = 0;
  return tokens.every(token => {
    const index = line.indexOf(token, offset); if (index < 0) return false;
    offset = index + token.length;
    const position = displayWidth(line.slice(0, index));
    return position >= minimum && position + displayWidth(token) <= maximum;
  });
}
function positionedRangeForecastRow(page, lines, index, key, label) {
  // Preserve the issuer's three-row layout: a labelled/unit-bearing current
  // range above the metric, prior amount alongside it, and growth below it.
  const columns = forecastColumns(lines, index); if (!columns || index < 1) return null;
  const current = new RegExp(`^\\s*(盈利|亏损)[:：]\\s*(${NUM})\\s*(万元|亿元|元)\\s*${RANGE}\\s*(${NUM})\\s*(万元|亿元|元)\\s*$`).exec(lines[index - 1]);
  const previous = new RegExp(`^\\s*(归属于上市公司股东的净利润|归属于母公司股东的净利润|扣除非经常性损益后的净利润)\\s{2,}(盈利|亏损)[:：]\\s*(${NUM})\\s*(万元|亿元|元)\\s*$`).exec(lines[index]);
  const growth = new RegExp(`^\\s*(?:比上年同期|同比)(增长|上升|下降|减少)[:：]\\s*(${NUM})%\\s*${RANGE}\\s*(${NUM})%\\s*$`).exec(lines[index + 1] || '');
  if (!current || !previous || !growth || (key === 'netProfit') === previous[1].startsWith('扣除')
    || current[3] !== current[5] || current[3] !== previous[4] || displayWidth(previous[1]) >= columns.left
    || !tokensInColumns(lines[index - 1], [current[2], current[4]], columns.left, columns.right)
    || !tokensInColumns(lines[index], [previous[3]], columns.right)
    || !tokensInColumns(lines[index + 1], growth.slice(2), columns.left, columns.right)) return null;
  const amounts = [current[2], current[4], previous[3]].map(number), rates = growth.slice(2).map(number);
  if ([...amounts, ...rates].some(value => !Number.isFinite(value) || value < 0)) return null;
  const values = amounts.slice(0, 2).map(value => value * (current[1] === '亏损' ? -1 : 1)).sort((a, b) => a - b);
  const changes = rates.map(value => value * (/下降|减少/.test(growth[1]) ? -1 : 1)).sort((a, b) => a - b);
  return arithmetic(check(key, label, { current: { min: values[0], max: values[1] }, previous: amounts[2] * (previous[2] === '亏损' ? -1 : 1),
    unit: current[3], growthPct: { min: changes[0], max: changes[1] } }, [evidence(page, [columns.header, ...lines.slice(index - 1, index + 2)].join('\n'))]));
}
function inlineForecastAmounts(page, lines, index, key, label) {
  const columns = forecastColumns(lines, index); if (!columns) return null;
  const units = [...compact(columns.prior.join('\n')).matchAll(/单位[:：](万元|亿元|元)/g)].map(item => item[1]);
  const row = new RegExp(`^\\s*(归属于上市公司股东的净利润|归属于母公司股东的净利润|扣除非经常性损益后的净利润)\\s{2,}(${NUM})\\s+${RANGE}\\s+(${NUM})\\s{2,}(${NUM})\\s*$`).exec(lines[index]);
  if (units.length !== 1 || !row || (key === 'netProfit') === row[1].startsWith('扣除') || displayWidth(row[1]) >= columns.left
    || !tokensInColumns(lines[index], row.slice(2, 4), columns.left, columns.right)
    || displayWidth(lines[index].slice(0, lines[index].lastIndexOf(row[4]))) < columns.right) return null;
  const amounts = row.slice(2).map(number); if (amounts.some(value => !Number.isFinite(value))) return null;
  const values = amounts.slice(0, 2).sort((a, b) => a - b);
  return { ...check(key, label, { current: { min: values[0], max: values[1] }, previous: amounts[2], unit: units[0], growthPct: null },
    [evidence(page, [columns.prior.find(line => /单位[:：]/.test(line)), columns.header, lines[index]].join('\n'))]),
  status: 'missing', amountStatus: 'verified', reason: `${label}当期区间、上期金额和单位已核实；公告未提供可核对的同比，不代算为已披露事实` };
}
function financialRow(document, type, key, label) {
  const candidates = [];
  for (const page of document.pageTexts) {
    // Never collect a later quarter, explanatory paragraph or next table as the
    // missing value of the first table. Preserve line and column boundaries.
    const section = page.text.split(/其中[，,：:]|\n\s*二[、.]/)[0];
    const rawLines = section.split(/\r?\n/).filter(text => text.trim()), lines = rawLines.map(text => text.trim());
    for (let index = 0; index < lines.length; index++) {
      if (!/^(?:归属于(?:上市公|母公司)|扣除非经常性)/.test(compact(lines[index]))) continue;
      const first = lines[index], block = [first];
      for (let next = index + 1; next < lines.length && block.length < 6; next++) {
        const value = compact(lines[next]);
        if (/^(?:归属于|扣除非经常性|基本每股|加权平均|二[、.])/.test(value) || /^\d/.test(value)) break;
        block.push(lines[next]);
        if (/比上年同期|同比/.test(value)) break;
      }
      const labelParts = block.map(line => line.split(/\s{2,}/)[0]).filter(part => !/\d|比上年|同比/.test(part));
      const rowLabel = compact(labelParts.join(''));
      const recurring = /^(?:扣除非经常性损益后的净利润|归属于上市公司股东的扣除非经常性损益的净利润)$/.test(rowLabel);
      const net = /^(?:归属于上市公司股东的净利润|归属于母公司股东的净利润)$/.test(rowLabel);
      if (key === 'netProfit' ? !net : !recurring) continue;
      const quote = block.join('\n'), records = [evidence(page, quote)];
      if (type === 'forecast') {
        const positioned = positionedForecastRow(page, rawLines, index, key, label) || rangedForecastRow(page, rawLines, index, key, label)
          || positionedRangeForecastRow(page, rawLines, index, key, label) || inlineForecastAmounts(page, rawLines, index, key, label);
        if (positioned) { candidates.push(positioned); continue; }
        const headers = lines.slice(0, index).filter(line => /本报告期|年初至报告期末|上年同期/.test(compact(line)) && !/比上年同期|同比/.test(compact(line))).map(compact).join('');
        const orderedHeader = /(?:本报告期|年初至报告期末)[^]*上年同期/.test(headers)
          && (headers.match(/本报告期|年初至报告期末/g) || []).length === 1 && (headers.match(/上年同期/g) || []).length === 1;
        const money = [...compact(first).matchAll(new RegExp(`(盈利|亏损)[:：]?(${NUM})(万元|亿元|元)(?:${RANGE}(${NUM})(万元|亿元|元))?`, 'g'))];
        const growth = new RegExp(`(?:比上年同期|同比)(增长|上升|下降|减少)[:：]?(${NUM})%(?:${RANGE}(${NUM})%)?`).exec(compact(quote));
        if (!orderedHeader || money.length !== 2 || !growth || money.some(item => item[5] && item[5] !== item[3]) || money[0][3] !== money[1][3]
          || money[1][4] || money.some(item => !Number.isFinite(number(item[2])) || number(item[2]) < 0 || item[4] && (!Number.isFinite(number(item[4])) || number(item[4]) < 0))
          || growth && [growth[2], growth[3] || growth[2]].some(value => !Number.isFinite(number(value)))) {
          candidates.push(check(key, label, null, records, `${label}的“本报告期／上年同期”表头顺序、当期上期金额、单位或同比未在同一明确行组内完整识别；不使用标签之前或下一行组的孤立数字`)); continue;
        }
        const sign = item => item[1] === '亏损' ? -1 : 1;
        const values = [number(money[0][2]) * sign(money[0]), number(money[0][4] || money[0][2]) * sign(money[0])].sort((a, b) => a - b);
        const growthSign = /下降|减少/.test(growth[1]) ? -1 : 1;
        const changes = [number(growth[2]) * growthSign, number(growth[3] || growth[2]) * growthSign].sort((a, b) => a - b);
        candidates.push({ ...arithmetic(check(key, label, { current: { min: values[0], max: values[1] }, previous: number(money[1][2]) * sign(money[1]), unit: money[0][3], growthPct: { min: changes[0], max: changes[1] } }, records)),
          periodBasis: /年初至报告期末/.test(headers) ? 'cumulative' : 'report-period' });
      } else {
        const prior = compact(lines.slice(0, index).join('\n'));
        const units = [...prior.matchAll(/单位[:：](万元|亿元|元)/g)].map(item => item[1]);
        const tokens = [...first.matchAll(/[+-]?\d[\d,]*(?:\.\d+)?/g)].map(item => item[0]), values = tokens.map(number);
        const columns = first.split(/\s{2,}/).slice(1).join(' ');
        if (new Set(units).size !== 1 || !/本报告期上年同期增减变动幅度\(%\)/.test(prior) || values.length !== 3
          || tokens.some(value => !VALID_NUMBER.test(value)) || values.some(value => !Number.isFinite(value)) || !new RegExp(`^${NUM}\\s+${NUM}\\s+${NUM}%?$`).test(columns)) {
          candidates.push(check(key, label, null, records, `${label}缺少明确的金额单位或“本报告期／上年同期／同比”同一行三列数值`)); continue;
        }
        candidates.push(arithmetic(check(key, label, { current: { min: values[0], max: values[0] }, previous: values[1], unit: units[0], growthPct: { min: values[2], max: values[2] } }, records)));
      }
    }
  }
  if (candidates.length === 1) return candidates[0];
  return check(key, label, null, candidates.flatMap(item => item.records), candidates.length ? `${label}存在多个行组，期间归属尚不能唯一核实` : `${label}的当期、上期、金额单位及同比行组尚未可靠识别`);
}
function arithmetic(result) {
  const { current, previous, growthPct } = result.value;
  // The table may establish disclosed amounts even when the comparison base
  // does not yet support our growth arithmetic. Do not conceal a known loss.
  result = { ...result, amountStatus: 'verified' };
  if (!(previous > 0)) return { ...result, status: 'missing', reason: `${result.label}上期值非正，当前解析规则尚未确认该同比口径` };
  const calculated = [current.min, current.max].map(value => (value / previous - 1) * 100);
  if (calculated.some((value, index) => Math.abs(value - [growthPct.min, growthPct.max][index]) > GROWTH_TOLERANCE_PCT)) {
    return { ...result, status: 'conflict', reason: `${result.label}当期、上期金额与披露同比不一致（舍入容差 ${GROWTH_TOLERANCE_PCT} 个百分点）` };
  }
  return { ...result, value: { ...result.value, calculatedGrowthPct: calculated, roundingTolerancePct: GROWTH_TOLERANCE_PCT } };
}
function performance(document, type) {
  const checks = [periodCheck(document, type), financialRow(document, type, 'netProfit', '归母净利润'), financialRow(document, type, 'recurringProfit', '扣非净利润')];
  const period = checks[0];
  reconcilePerformancePeriod(period, document, type);
  if (period.status === 'verified' && period.value.aggregation === 'single-quarter' && checks.some(item => item.periodBasis === 'cumulative')) {
    Object.assign(period, { status: 'conflict', reason: '正文明确单季度期间，但金额表头为年初至报告期末累计；不能把累计数字用作单季指标' });
  }
  const text = compact(document.text);
  const comparisonRecords = paragraphs(document).filter(entry => /(?:本期(?:利润|业绩|指标)|利润指标|上年同期|同期数据|同期业绩)[^。；]{0,80}(?:不具备可比性|不具有可比性|不可比)/.test(entry.value)
    && !/(?:不存在|并非)[^。；]{0,12}(?:不具备可比性|不具有可比性|不可比)/.test(entry.value)).map(entry => evidence(entry.page, entry.text));
  if (comparisonRecords.length) for (const item of checks.filter(item => ['netProfit', 'recurringProfit'].includes(item.key))) {
    if (item.value) delete item.value.calculatedGrowthPct;
    item.comparisonStatus = 'not-comparable';
    item.status = item.status === 'conflict' ? 'conflict' : 'missing';
    item.reason = `${item.amountStatus === 'verified' ? '原始金额已核实；' : ''}公告明确本期与上期利润指标不具备可比性，不代算同比或据此判定增长条件通过`;
  }
  return { checks, data: { basis: type === 'forecast' ? 'forecast' : 'preliminary-actual',
    basisLabel: type === 'forecast' ? '业绩预测，尚非实际业绩' : '业绩快报初步核算，尚非定期报告最终数据',
    auditStatus: /未经(?:过)?(?:注册会计师|会计师事务所)?(?:预)?审计/.test(text) ? 'unaudited' : 'not-established',
    comparativeRestatementDisclosed: /追溯调整|追溯重述/.test(text),
    comparability: { status: comparisonRecords.length ? 'not-comparable' : 'not-disclosed', records: comparisonRecords,
      reason: comparisonRecords.length ? '公告明确利润指标与上期不具备可比性，保留原始金额，不代算同比' : '未识别到明确的不可比声明' } } };
}
function actualAmendment(document) {
  const claims = (input, title = false) => compact(input).split(/[。；;，,]|但是|然而|不过|但/).some(clause =>
    [...clause.matchAll(/更正|修正|撤回|撤销/g)].some(match => {
      const before = clause.slice(0, match.index), after = clause.slice(match.index + match[0].length);
      if (/(?:无需|无须|不需要|没有|尚未|未曾|未|不|不得|不能|并非|不可)(?:对[^，。；]{0,30})?(?:进行|作出|作|予以)?$/.test(before)
        || /^(?:日期|日|权|的权利|承诺)/.test(after)) return false;
      let disclosureWithdrawal = false;
      if (/^撤回|^撤销/.test(match[0])) {
        const object = after.replace(/^了/, '');
        const disclosureAfter = /^(?:(?:本次|原|前次|上述|该|此前|已披露的)(?:的)?|20\d{2}年(?:第?[一二三四1234]季度|前三季度|半年度|年度)?)?(?:公告|业绩预告|业绩快报|财务报表|报告|披露)/.test(object)
          || /^《[^》]{0,80}(?:公告|报告)》/.test(object);
        const disclosureBefore = /(?:公告|业绩预告|业绩快报|财务报表|报告|披露)(?:(?:已经|已|被|现|予以|决定|正式|全部)){0,3}$/.test(before);
        // A company-registration cancellation announcement is not a cancelled
        // disclosure. Withdrawal must act on the disclosure itself.
        const registrationAnnouncement = /^公告/.test(object) && /(?:收到|接到)[^，。；]{0,100}(?:注册处|登记机关|市场监管|工商)[^，。；]{0,100}(?:公司|企业)$/.test(before);
        if (registrationAnnouncement || !disclosureAfter && !disclosureBefore) return false;
        disclosureWithdrawal = true;
      }
      const realized = /(?:已经|已|曾经|曾|此前|完成|现予|现对|现将|本次)[^，。；]{0,30}$/.test(before)
        && !/(?:尚未|未曾|没有|不存在|无需|无须|将|拟|应当|如(?!下)|若)[^，。；]{0,20}$/.test(before);
      if (title) return !/(?:无需|无须|不需要|不可)(?:进行)?$/.test(before);
      // The token “更正日” in an undertaking and a future promise to correct
      // possible reporting differences do not amend the present disclosure.
      if (!realized && /(?:将|拟|应当|应|须|需|必要时|如(?!下)|若)[^，。；]{0,30}$/.test(before)) return false;
      return realized || disclosureWithdrawal || /(?:作如下|作出以下|予以|现予|现对)$/.test(before)
        || /(?:进行(?:了)?|作(?:了|出)?)$/.test(before) && /公司|本次|原公告|上述|公告|报告|披露|业绩/.test(before)
        || /^(?:了|如下|内容如下)/.test(after) && /公司|本次|原公告|上述|公告|报告|披露|业绩/.test(before)
        || /^为/.test(after) && /金额|数字|数值|比例|日期|时间|数据|内容|股份|股数|数量|公告|报告/.test(before)
        || /^(?:本次|原|上述|相关)?(?:公告|业绩(?:预告|快报|数据)?|财务(?:数据|报表)?|报告|披露|错误|内容|事项)/.test(after)
        || /(?:公告|业绩预告|业绩快报|财务报表)(?:的)?$/.test(before) && /^(?:后|如下|为)/.test(after);
    }));
  return claims(document?.title, true) || claims(document?.text);
}
const PERFORMANCE_EXCEPTION = /重大诉讼|重大仲裁|被立案|涉嫌[^，。；]{0,12}违法|债务违约|流动性危机|重大损失|重大不利影响|重大减值|非标准审计意见|保留意见|无法表示意见|否定意见|持续经营能力|重大分歧|重大会计差错|重大资产重组|重大资产出售|重大会计政策变更|审计调整|重大差异|重大偏差/;
function performanceExceptionFindings(document) {
  return paragraphs(document).flatMap(entry => {
    const reportingReminder = /(?:如|若|如果)[^。；]{0,100}(?:数据|业绩|财务)[^。；]{0,80}(?:差异|变化|变动|调整|偏差)[^。；]{0,80}(?:将|应当|及时)[^。；]{0,60}(?:更正|修正|披露|公告|履行[^。；]{0,10}义务)/.test(entry.value);
    return entry.value.split(/[，,]|但是|然而|不过|但/).flatMap(clause => [...clause.matchAll(new RegExp(PERFORMANCE_EXCEPTION.source, 'g'))].flatMap(match => {
      const before = clause.slice(0, match.index), after = clause.slice(match.index + match[0].length);
      const uncertainNegation = /(?:无法|不能|尚未|未能)(?:确认|核实|排除)|(?:结论|说法)[^。；]{0,12}(?:尚未|无法|不能)|不代表|并非|并不|不是/.test(clause);
      // Remove only coordinated topics before this match, so one negation can
      // cover “未发生重大诉讼及重大仲裁” without crossing a contrast or new verb.
      const negativeScope = before.replace(new RegExp(PERFORMANCE_EXCEPTION.source, 'g'), '').replace(/(?:、|以及|及|和|或|与|等)+$/, '');
      const negated = /(?:不存在|未曾发生|未发生过?|未发现|未出现|未造成|未产生|不涉及|没有(?:发生|发现|造成|产生)?|无)(?:任何)?$/.test(negativeScope);
      if (negated && !uncertainNegation) return [];
      if (reportingReminder && /(?:如果|若|如(?!下))/.test(before) && /^(?:重大差异|重大偏差|审计调整)$/.test(match[0])
        && !/(?:已经|此前|已)[^。；]{0,12}(?:发生|出现|存在)/.test(clause)) return [];
      const uncertain = uncertainNegation || /可能|预计|如果|假如|若|尚未|不确定|无法确定|能否|是否/.test(clause)
        || /^如/.test(clause) || /尚未(?:确认|核实)/.test(after);
      const explicit = !uncertain && !negated && (/^(?:被立案|涉嫌)/.test(match[0])
        || /(?:已经|已|存在|发生|出现|被|涉嫌)[^，。；]{0,16}$/.test(before))
        && /重大诉讼|重大仲裁|被立案|涉嫌|债务违约|流动性危机|重大损失|重大不利影响|重大减值|保留意见|无法表示意见|否定意见|重大会计差错/.test(match[0]);
      return [{ clause, offset: match.index, topic: match[0], explicit, record: evidence(entry.page, entry.text) }];
    }));
  });
}
function performanceEligibility(document, type, parsed) {
  const result = (status, code, reason) => ({ status, code, scope: 'sensitive-notice-title-only', reason });
  const period = parsed.checks.find(item => item.key === 'period');
  const metrics = parsed.checks.filter(item => ['netProfit', 'recurringProfit'].includes(item.key));
  const findings = performanceExceptionFindings(document);
  parsed.data.exceptionFindings = findings;
  if (findings.length) {
    const explicit = findings.some(item => item.explicit);
    return result(explicit ? 'blocked' : 'pending', 'performance-exception', explicit ? '原文披露实质异常事项，业绩数字增长不能解除该风险' : '原文涉及异常事项，当前规则尚不能确认其范围和实际影响');
  }
  if (parsed.data.amendmentDisclosure) return result('pending', 'performance-amendment', '公告涉及实际更正、修正或撤回，生效版本和比较数据须重新核验');
  if (period?.status !== 'verified') return result('pending', 'performance-period', `业绩公告期间资料待补或存在冲突：${period?.reason || '标题与正文的唯一期间尚未核实'}；预告可覆盖尚未结束的期间，快报只使用已结束期间`);
  const adverse = metrics.filter(item => item.amountStatus === 'verified' && item.value.current.min <= 0);
  if (adverse.length) return result('blocked', 'performance-adverse', `${adverse.map(item => item.label).join('、')}已核实的披露金额区间包含不盈利，触发独立公告风险门槛；普通同比下滑由所选业绩条件判断`);
  const declaration = /业绩预告情况[:：]([^。；]{1,120})/.exec(compact(document.text))?.[1] || '';
  const declining = metrics.filter(item => item.status === 'verified' && item.value.growthPct.min < 0);
  if (/亏损|负值|扭亏/.test(declaration) || /同向下降|预减|同比下降/.test(declaration) && !declining.length) {
    return result('pending', 'performance-declaration', '业绩预告分类与已提取金额、同比尚未形成唯一一致口径，分类及表格资料待补或核实');
  }
  if (parsed.data.comparativeRestatementDisclosed) return result('pending', 'performance-comparative-basis', '公告披露追溯调整或重述，尚未确认表内上期金额与调整后比较口径逐项一致');
  if (parsed.data.comparability?.status === 'not-comparable') return result('pending', 'performance-not-comparable', '公告明确本期与上期利润指标不可比；原始金额保留展示，不代算同比，也不自动通过业绩核验');
  if (parsed.checks.some(item => item.status !== 'verified') || metrics.length !== 2
    || metrics.some(item => !(item.value.current.min > 0 && item.value.previous > 0))) {
    return result('pending', 'performance-fields-pending', '业绩期间、归母及扣非的当期／上期金额、单位和同比尚未全部核实；不得仅凭正面标题或部分字段放行');
  }
  return result('pass', 'performance-title-gate-cleared', `本篇${period.value.aggregationLabel}期间明确，归母及扣非金额均为正且同比算术一致${declining.length ? '；已披露同比下滑，作为观察提示及可编辑业绩条件输入' : ''}；仅解除该业绩类敏感标题门槛，预测或初步核算不代表最终业绩、选股信号或买入许可`);
}
function reduction(document) {
  // Restrict extraction to the actual result section; planned maximum quantities
  // and earlier holdings must not become completed sale facts.
  const pages = document.pageTexts.map(page => ({ ...page, text: page.text.split(/二、减持计划的实施结果/)[1] || '' })).filter(page => page.text);
  const section = { ...document, pageTexts: pages };
  const exactLine = (key, label, pattern, convert) => {
    const scoped = { ...section, pageTexts: pages.map(page => ({ ...page, text: page.text.split(/\r?\n/).filter(line => line.trim()).join('；') })) };
    return uniqueField(scoped, key, label, pattern, convert);
  };
  const checks = [exactLine('holder', '减持主体', /^股东名称([^\d，；:：]{1,30})$/),
    exactLine('quantity', '实际减持股数', new RegExp(`^减持数量(${NUM})股$`), match => Number.isSafeInteger(number(match[1])) && number(match[1]) >= 0 ? number(match[1]) : null),
    exactLine('dates', '实际减持期间', new RegExp(`^减持期间${DATE}[～~—至-]${DATE}$`), match => {
      const start = isoDate(match.slice(1, 4)), end = isoDate(match.slice(4, 7)); return start && end && start <= end && end <= document.publishedAt ? { start, end } : null;
    }), exactLine('completion', '计划完成状态', /^减持完成情况(已完成|未完成)$/, match => match[1])];
  const checkbox = (key, label, topic, expected) => uniqueField(section, key, label, new RegExp(`${topic}([□☐√☑☒✓✔]是[□☐√☑☒✓✔]否)`), match => {
    const choices = [...match[1].matchAll(/([□☐√☑☒✓✔])(是|否)/g)], selected = choices.filter(choice => !/[□☐]/.test(choice[1]));
    return selected.length === 1 ? { disclosed: selected[0][2] === '是', matchesExpected: (selected[0][2] === '是') === expected } : null;
  });
  checks.push(checkbox('compliance', '减持合规声明', '本次减持是否遵守相关法律法规、本所业务规则的规定', true),
    checkbox('planConsistency', '与原计划及承诺一致声明', '本次实际减持情况与此前披露的减持计划、承诺是否一致', true),
    checkbox('noViolation', '未违反计划或其他承诺声明', '是否存在违反减持计划或其他承诺的情况', false));
  return { checks, data: { basis: 'issuer-disclosed-result', independentComplianceVerification: false } };
}
function unlock(document) {
  const checks = [uniqueField(document, 'listingDate', '本次解除限售上市流通日', new RegExp(`本次解除限售(?:股票|股份的?)上市流通日为${DATE}`), match => isoDate(match.slice(1, 4))),
    uniqueField(document, 'release', '本次解禁对象、股数及占总股本比例', new RegExp(`本次符合解除限售的激励对象共(\\d+)名[，,]可解除限售的限制性股票共计(${NUM})股[，,]占公司当前股本总额的(${NUM})%`), match => {
      const holders = Number(match[1]), shares = number(match[2]), totalCapitalPct = number(match[3]);
      return Number.isSafeInteger(holders) && holders > 0 && Number.isSafeInteger(shares) && shares > 0 && totalCapitalPct > 0 && totalCapitalPct <= 100 ? { holders, shares, totalCapitalPct } : null;
    })];
  const remaining = uniqueField(document, 'remainingRestrictions', '解除限售后持有人仍适用的转让限制', /本次解除限售后[，,]?(相关股东|上述激励对象)(?:仍须|仍需|继续)([^。；]{5,150}(?:限制|锁定|减持规定))/,
    match => ({ subject: match[1], disclosedRestriction: match[2] }));
  if (remaining.status === 'missing') remaining.reason = '解除限售后持有人仍适用的转让限制尚未结构化核实；股份可解除限售不等于所有持有人可立即自由卖出';
  checks.push(remaining);
  return { checks, data: { basis: 'disclosed-release-schedule' } };
}
function reviewNoticeFacts(document, notice) {
  const type = noticeType(notice.title), label = LABELS[type];
  const parsed = ['forecast', 'flash'].includes(type) ? performance(document, type) : type === 'reduction' ? reduction(document) : type === 'unlock' ? unlock(document) : { checks: [], data: {} };
  if (actualAmendment(document)) {
    parsed.data.amendmentDisclosure = true;
    for (const item of parsed.checks) {
      item.status = 'missing'; item.reason = `${item.label}涉及更正或撤回披露，尚未确认生效版本及被替代字段，旧字段不作为已核实事实`;
      if (item.amountStatus) item.amountStatus = 'missing';
    }
  }
  const disclosedConcerns = parsed.checks.filter(item => item.status === 'verified'
    && (item.value?.matchesExpected === false || item.key === 'completion' && item.value !== '已完成')).map(item => item.label);
  parsed.data.disclosedConcerns = disclosedConcerns;
  const missing = parsed.checks.filter(item => item.status !== 'verified'), verified = parsed.checks.filter(item => item.status === 'verified');
  const eligibility = ['forecast', 'flash'].includes(type) ? performanceEligibility(document, type, parsed)
    : { status: 'pending', code: 'notice-risk-policy-missing', reason: type === 'unsupported' ? '此类敏感公告尚未建立可程序执行的事实核验及候选准入规则' : `尚未定义${label}的候选准入风险口径，事实核实不代表符合选股标准` };
  const warnings = [];
  if (['forecast', 'flash'].includes(type)) {
    const period = parsed.checks.find(item => item.key === 'period');
    parsed.data.period = period.status === 'verified' ? { ...period.value } : null;
    parsed.data.periodStatus = period.status;
    parsed.data.performanceMetrics = Object.fromEntries(parsed.checks.filter(item => ['netProfit', 'recurringProfit'].includes(item.key)).map(item => {
      const usable = period.status === 'verified' && item.status === 'verified' && !parsed.data.amendmentDisclosure && !parsed.data.comparativeRestatementDisclosed;
      const amountUsable = period.status === 'verified' && item.amountStatus === 'verified' && !parsed.data.amendmentDisclosure && !parsed.data.comparativeRestatementDisclosed;
      if (usable && item.value.growthPct.min < 0) warnings.push({ code: 'performance-growth-decline', severity: 'warning', metric: item.key,
        label: `${item.label}同比下滑`, value: { ...item.value.growthPct }, unit: '%', basis: parsed.data.basis,
        reason: `${item.label}披露同比区间为 ${item.value.growthPct.min}% 至 ${item.value.growthPct.max}%；普通同比下滑不自动等同于重大异常，是否满足业绩条件按用户所选规则判断` });
      return [item.key, { label: item.label, status: item.status, usable, amountUsable, amountStatus: item.amountStatus || 'missing',
        comparisonStatus: item.comparisonStatus || 'not-disclosed', basis: parsed.data.basis, period: parsed.data.period,
        ...(item.value || { current: null, previous: null, growthPct: null, unit: null }), reason: item.reason, sourceRecords: item.records }];
    }));
    parsed.data.warnings = warnings;
    parsed.data.riskSignals = eligibility.status === 'blocked' ? [{ code: eligibility.code, reason: eligibility.reason }] : [];
  }
  const admissionReason = eligibility.reason;
  const summary = type === 'unsupported' ? '完整原文已读取；公告类型暂不支持结构化核验'
    : missing.length ? `完整原文已读取；${label}已核实字段：${verified.map(item => item.label).join('、') || '暂无'}；待补项：${missing.map(item => item.reason).join('；')}`
      : `${label}的限定事实字段已核实`;
  return { version: 1, type, label, status: type === 'unsupported' ? 'unsupported' : missing.length ? 'incomplete' : 'verified',
    ...parsed, verifiedFields: verified.map(item => item.key), missingFields: missing.map(item => item.key),
    eligibility, warnings,
    reason: `${summary}${parsed.data.basisLabel ? `；${parsed.data.basisLabel}` : ''}${disclosedConcerns.length ? `；公告披露待关注情况：${disclosedConcerns.join('、')}` : ''}；${admissionReason}` };
}
module.exports = { noticeType, reviewNoticeFacts, actualAmendment, GROWTH_TOLERANCE_PCT };
