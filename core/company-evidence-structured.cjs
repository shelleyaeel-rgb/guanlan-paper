const { checkboxSelection } = require('./company-evidence-text.cjs');
const { productTableFacts, productTableScopes, columnTypesMatch, percentCell } = require('./company-product-tables.cjs');
const compact = text => String(text || '').normalize('NFKC').replace(/\s+/g, '');
const sectionless = text => compact(text).replace(/^(?:[一二三四五六七八九十百0-9]+[、.)]|\([一二三四五六七八九十0-9]+\))\s*/, '');
const OTHER = /竞争对手|其他公司|参股公司|联营公司|合营公司|供应商|客户公司|母公司财务报表/;
const NOT_FACT = /预计|可能|如果|假设|若发生|计划|不属实|无法核实|不能认定|并非|不是/;
const NUMBER = /^(?:-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?|\(\d+(?:\.\d+)?\))%?$/;
const valueOf = value => /^\(/.test(value) ? -Number(value.slice(1, -1).replaceAll(',', '')) : Number(value.replace(/[,%]/g, ''));

function productName(value) {
  const original = compact(value).replace(/^(?:本公司|公司)/, '');
  const name = original.replace(/(?:等(?:(?:有色|黑色)?金属(?:产品)?|产品|智能终端|终端|服务)?|产品)$/, '');
  if (!/^[\p{Script=Han}A-Za-z0-9()/·+-]{1,24}$/u.test(name) || /^(?:主营|主营业|内销|外销|境内|境外|国内|国外|海外|合计|总计|销售|营业|其他|其它|本期|上期|同期|公司|集团|分部|地区|行业|产品|业务|收入|成本|利润|全部|相关|上述|平均|整体|原料|贸易|投资)(?:收入|成本|业务|产品)?$/.test(name)) return null;
  if (/报告|主要|其他|全部|相关|上述|本期|上期|从20|享受|税|利润|成本|竞争对手|参股公司|为期|地区|地理|主营|实现|本集团|本年度|报告期|其中|各类|价格|决定|经营|情况|周期|因素|政策|供求|的|^其|^年|^[()0-9]|产品销售/.test(name)) return null;
  // Single-character commodities are real product names; arbitrary single
  // characters and accounting/region fragments are not product identities.
  if (/分部$|行业$|制造业$|集团$|公司$/.test(name)) return null;
  if (name.length === 1 && !/[铜铝铌锌铅锡镍钴锂金银煤硅钾]/.test(name)) return null;
  // A report's broad commodity product family is not automatically the same
  // identity as one chemical compound disclosed elsewhere in the report.
  if (name.length === 1 && original === `${name}产品`) return original;
  return name;
}
const CONNECTED_PRODUCT_NAMES = ['变形铝及铝合金圆铸锭', '变形铝及铝合金扁铸锭', '铝及铝合金焊材', '铝箔及铝箔坯料'];
function splitProductNames(value) {
  let text = compact(value);
  const saved = [];
  for (const name of CONNECTED_PRODUCT_NAMES) text = text.replaceAll(name, () => { saved.push(name); return `\u0001${saved.length - 1}\u0002`; });
  return [...new Set(text.split(/[、,，及和]/).map(part => part.replace(/\u0001(\d+)\u0002/g, (_, index) => saved[Number(index)]))
    .map(productName).filter(Boolean))];
}

function nativePages(document) {
  if (Array.isArray(document.pageTexts)) return document.pageTexts.filter(page => page.complete === true && page.numericEligible === true && ['pdf-text', 'provider-text'].includes(page.method));
  return [{ page: null, text: document.text, method: 'provider-text', numericEligible: true }];
}
function span(document, page, lines, start, end, extra = {}) {
  return { document, text: lines.slice(start, end + 1).join('\n'), locations: [{ page: page.page ?? null, method: page.method,
    numericEligible: true, confidence: page.confidence ?? null, textHash: page.textHash || null, lineStart: start + 1, lineEnd: end + 1 }], ...extra };
}

// Each recognised correction answer is within the same native page and an
// exact section. Both child methods must be answered; a single negative method
// cannot answer the parent and a selected positive cannot be ignored.
function correctionSections(document) {
  const result = [];
  for (const page of nativePages(document)) {
    const lines = page.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^(?:前期|重大)?会计差错更正(?:情况|的说明)?$/.test(sectionless(lines[i]))) continue;
      const direct = checkboxSelection(lines[i + 1]);
      if (direct !== null) { result.push(span(document, page, lines, i, i + 1, { clear: direct === 'notApplicable' })); continue; }
      if (sectionless(lines[i + 1]) !== '追溯重述法' || sectionless(lines[i + 3]) !== '未来适用法') continue;
      const answers = [checkboxSelection(lines[i + 2]), checkboxSelection(lines[i + 4])];
      if (answers.some(answer => answer === null)) continue;
      if (/^\(?3\)/.test(compact(lines[i + 5]))) continue;
      result.push(span(document, page, lines, i, i + 4, { clear: answers.every(answer => answer === 'notApplicable') }));
    }
  }
  return result;
}

// These categories describe the disclosed issuer's liabilities, not receivables
// from third parties or guarantee beneficiaries. Completeness is explicit and
// missing categories remain unknown. Ordinary accounts-payable aging does not
// establish an overdue obligation, and an empty template does not mean zero.
const DEBT_CATEGORIES = [
  ['shortBorrowing', '短期借款'], ['longBorrowing', '长期借款'], ['bonds', '应付债券'],
  ['bills', '应付票据'], ['leases', '租赁负债'], ['tradePayables', '应付账款'],
  ['otherPayables', '其他应付款'], ['otherFinancing', '其他有息债务'],
];
function debtCoverage(document) {
  const found = new Map(DEBT_CATEGORIES.map(([key, label]) => [key, { key, label, absent: [], overdue: [], default: [], unresolved: [], present: [] }]));
  const scopes = [];
  const namedCategories = value => {
    const names = value.replace(/(?:以及|和|及)/g, '、').split('、').filter(Boolean);
    const expanded = names.flatMap(name => name === '借款' ? ['短期借款', '长期借款'] : name === '债券' ? ['应付债券'] : [name]);
    return expanded.length && expanded.every(name => DEBT_CATEGORIES.some(([, label]) => label === name)) ? new Set(expanded) : null;
  };
  for (const page of nativePages(document)) {
    const lines = page.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const text = sectionless(lines[i]);
      const inventory = /^(?:本公司|公司|本集团)(?:的)?(?:全部)?债务(?:仅包括|仅包含|只包括)([^。]+)[。.]?$/.exec(text);
      if (inventory) {
        const labels = namedCategories(inventory[1]);
        if (labels) scopes.push({ labels, fact: span(document, page, lines, i, i, { scopeBasis: '原文明确封闭列举全部债务类别；未凭科目缺失推断不适用' }) });
      }
      const combined = /^(?:本公司|公司|本集团)([^。]+?)(?:均)?(?:不存在|未发生)(逾期(?:及|和)违约|违约(?:及|和)逾期)(?:情况)?[。.]?$/.exec(text);
      if (combined) {
        const labels = namedCategories(combined[1]);
        if (labels) for (const state of found.values()) if (labels.has(state.label)) {
          const fact = span(document, page, lines, i, i); state.overdue.push(fact); state.default.push(fact);
        }
      }
      if (!/短期借款|长期借款|应付债券|应付票据|租赁负债|应付账款|其他应付款|其他有息债务/.test(text)
        || OTHER.test(text) || NOT_FACT.test(text) || /^(?:本公司|公司)?(?:应收|债权|金融资产|信用风险)|认定标准/.test(text)) continue;
      for (const [, state] of found) {
        const category = state.label;
        if (!text.includes(category)) continue;
        const starts = `(?:(?:本公司|公司|本集团|报告期内|本报告期|本期末|截至报告期末|于本报告期间)[,:，：]?)*`;
        const balance = new RegExp(`^${starts}${category}(?:期末余额|余额)(?:为|:)?(\\d+(?:\\.\\d+)?)(?:元|万元|亿元)[。.]?$`).exec(text);
        if (balance && Number(balance[1]) > 0) state.present.push(span(document, page, lines, i, i));
        const zero = new RegExp(`^${starts}(?:不存在|没有|无)${category}[。.]?$`).test(text)
          || new RegExp(`^${starts}${category}(?:期末余额|余额)(?:为|:)?0(?:\\.0+)?(?:元|万元|亿元)[。.]?$`).test(text);
        const notApplicable = text === category && checkboxSelection(lines[i + 1]) === 'notApplicable';
        if (zero || notApplicable) state.absent.push(span(document, page, lines, i, notApplicable ? i + 1 : i));
        const overdue = new RegExp(`^${starts}(?:不存在|未发生|没有|无)(?:已)?逾期(?:未偿还的)?${category}[。.]?$`).test(text)
          || new RegExp(`^${starts}${category}(?:未发生|不存在)(?:逾期|逾期未偿还)(?:情况)?[。.]?$`).test(text)
          || new RegExp(`^${starts}(?:已)?逾期未偿还的${category}(?:总额|金额)(?:为|:)0(?:\\.0+)?(?:元|万元|亿元)[。.]?$`).test(text);
        const overdueHeading = new RegExp(`^(?:已)?逾期未偿还的${category}(?:情况)?$`).test(text) && checkboxSelection(lines[i + 1]) === 'notApplicable';
        if (overdue || overdueHeading) state.overdue.push(span(document, page, lines, i, overdueHeading ? i + 1 : i));
        if (new RegExp(`^${starts}${category}(?:本金[、及和]利息[、及和])?(?:未发生|不存在)(?:偿还条款)?违约(?:情况)?[。.]?$`).test(text)
          || new RegExp(`^${starts}(?:未发生|不存在)${category}(?:本金[、及和]利息)?违约(?:情况)?[。.]?$`).test(text)) state.default.push(span(document, page, lines, i, i));
        if (new RegExp(`^${starts}${category}(?:存在|发生)(?:逾期|违约)`).test(text)) state.unresolved.push(span(document, page, lines, i, i));
      }
    }
  }
  // A closed inventory is usable only when all such declarations agree. A
  // narrower "interest-bearing debt" inventory cannot cover trade payables.
  const inventoryAgrees = scopes.length && scopes.every(scope => [...scope.labels].sort().join('|') === [...scopes[0].labels].sort().join('|'));
  if (inventoryAgrees) for (const state of found.values()) if (!scopes[0].labels.has(state.label)) state.absent.push(scopes[0].fact);
  const categories = [...found.values()].map(item => ({ ...item, conflict: !!item.present.length && !!item.absent.length,
    complete: !item.unresolved.length && !(item.present.length && item.absent.length) && (!!item.absent.length || !!item.overdue.length && !!item.default.length) }));
  return { categories, complete: categories.every(item => item.complete), records: categories.flatMap(item => [...item.absent, ...item.overdue, ...item.default].map(record => ({ ...record, debtCategory: item.key, debtLabel: item.label }))),
    missing: categories.filter(item => !item.complete).map(item => `${item.label}${item.conflict ? '范围与余额披露矛盾' : item.unresolved.length ? '存在未解决事项' : !item.overdue.length && !item.default.length ? '适用性/余额及逾期、违约披露' : !item.overdue.length ? '逾期披露' : '违约披露'}`) };
}

function numbers(text) {
  const tokens = text.trim().replace(/-\s+(?=\d)/g, '-').split(/\s+/);
  return tokens.length && tokens.every(token => NUMBER.test(token)) ? tokens.map(valueOf) : null;
}
function tableRows(lines, start, limit) {
  const rows = [];
  for (let i = start; i < Math.min(lines.length, limit); i++) {
    const match = /^([\p{Script=Han}A-Za-z·-]{1,24})(?:\s*\(([^)]{1,20})\))?\s+([\d(-].*)$/u.exec(lines[i].trim().normalize('NFKC'));
    if (!match) { if (compact(lines[i])) break; continue; }
    const first = i; let numeric = match[3];
    // PDF text order sometimes wraps just the final cents onto the next line.
    // Rejoin only an unfinished two-decimal value, never a complete number.
    while (i + 1 < Math.min(lines.length, limit) && /^[-\d(]/.test(lines[i + 1].trim()) && !/[\p{Script=Han}A-Za-z]/u.test(lines[i + 1])) {
      const next = lines[++i].trim();
      const decimal = /\.([0-9]?)$/.exec(numeric);
      if (decimal && new RegExp(`^\\d{${2 - decimal[1].length}}(?:\\s|$)`).test(next)) numeric += next;
      else numeric += ` ${next}`;
    }
    const values = numbers(numeric);
    rows.push({ subject: productName(match[1]), label: match[1], unit: match[2], values, numeric, start: first, end: i });
  }
  return rows;
}

function reportProductTables(document, options = {}) {
  const facts = [], pages = nativePages(document), scopes = productTableScopes(document, pages);
  const observe = typeof options.observe === 'function' ? (page, lines, start, end, extra) => options.observe(span(document, page, lines, start, end, {
    ...extra, tableScope: scopes.get(page)?.[end]?.metadata,
    period: { currentEnd: document.reportDate, previousEnd: `${Number(document.reportDate?.slice(0, 4)) - 1}${document.reportDate?.slice(4)}` }
  })) : null;
  for (const page of pages) {
    const lines = page.text.split(/\r?\n/), pageText = compact(page.text);
    if (OTHER.test(pageText) || /母公司利润表|子公司主要财务/.test(pageText)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (!scopes.get(page)?.[i]?.eligible) continue;
      if (/^分产品(?:或服务)?$/.test(compact(lines[i]))) {
        const headerStart = Math.max(0, i - 12), rawHeader = compact(lines.slice(headerStart, i).join(''));
        const header = rawHeader.replace(/\((?:%|个?百分点)\)/g, '');
        if (!/营业收入营业成本毛利率营业收入比上年同期增减营业成本比上年同期增减毛利率比上年同期增减$/.test(header)) continue;
        const before = compact(lines.slice(0, i).join(''));
        if (!/本报告期|报告期内|主营业务分析/.test(before) || /(?:上年度|上年同期|历史)(?:产品|分产品)(?:收入|情况)/.test(before)
          || [...before.matchAll(/(20\d{2})年(?:度|半年度)?(?:产品|分产品)(?:收入|情况)/g)].some(match => match[1] !== document.reportDate?.slice(0, 4))) continue;
        const unit = [...header.matchAll(/单位[:：](元|万元|百万元|亿元)/g)].at(-1)?.[1];
        if (!unit) continue;
        const localHeader = header.slice(header.lastIndexOf('单位'));
        if (!/^单位[:：](?:元|万元|百万元|亿元)(?:项目)?营业收入营业成本毛利率营业收入比上年同期增减营业成本比上年同期增减毛利率比上年同期增减$/.test(localHeader)
          || (lines.slice(headerStart, i).findLast(line => /单位[:：]/.test(compact(line)))?.match(/单位[:：]/g) || []).length !== 1) continue;
        const totalIndex = lines.findIndex((line, index) => index < i && /^营业收入\s+/.test(line.trim()) && /本报告期上年同期同比增减/.test(compact(lines.slice(Math.max(0, index - 2), index).join(''))));
        const totalUnit = totalIndex >= 0 ? /单位[:：](元|万元|百万元|亿元)/.exec(compact(lines.slice(Math.max(0, totalIndex - 4), totalIndex).join('')))?.[1] : null;
        const totalNumeric = totalIndex >= 0 ? lines[totalIndex].trim().replace(/^营业收入\s+/, '') : '';
        const total = totalIndex >= 0 && totalUnit === unit && columnTypesMatch(totalNumeric, 3, [2]) ? numbers(totalNumeric)?.[0] : null;
        for (const row of tableRows(lines, i + 1, i + 28)) {
          if (row.subject && observe) observe(page, lines, headerStart, row.end, { subject: row.subject, unit, rowStart: row.start + 1,
            table: 'product-revenue-margin', cells: row.numeric,
            columns: ['currentRevenue', 'currentCost', 'reportedGrossMarginPct', 'reportedRevenueGrowthPct', 'reportedCostGrowthPct', 'reportedGrossMarginChange'],
            percentageHeaders: [...(/毛利率\(%\)/.test(rawHeader) ? [2] : []), ...(/营业收入比上年同期增减\(%\)/.test(rawHeader) ? [3] : []),
              ...(/营业成本比上年同期增减\(%\)/.test(rawHeader) ? [4] : []), ...(/毛利率比上年同期增减\(%\)/.test(rawHeader) ? [5] : [])],
            percentagePointHeaders: /毛利率比上年同期增减\(个?百分点\)/.test(rawHeader) ? [5] : [],
            total: totalIndex >= 0 && totalUnit === unit ? { cells: totalNumeric, unit, columns: ['currentTotalRevenue', 'previousTotalRevenue', 'reportedTotalRevenueGrowthPct'],
              percentageHeaders: [], locations: span(document, page, lines, totalIndex - 1, totalIndex).locations } : null });
          if (!row.subject || row.values?.length !== 6 || !columnTypesMatch(row.numeric, 6, [2, 3, 4, 5])
             || !percentCell(row.numeric, 2) && !/毛利率\(%\)/.test(rawHeader)) continue;
          const [revenue, cost, margin] = row.values;
          if (!(revenue > 0) || cost < 0 || Math.abs((1 - cost / revenue) * 100 - margin) > 0.03) continue;
          facts.push(span(document, page, lines, headerStart, row.end, { subject: row.subject, revenue, unit, table: 'product-revenue-margin', rowStart: row.start + 1,
            revenueShare: total > 0 && revenue <= total ? revenue / total * 100 : null, totalRevenue: total, totalLocation: totalIndex >= 0 ? span(document, page, lines, totalIndex - 1, totalIndex).locations[0] : null }));
        }
      }
      // Explicit two-period volume/revenue table. Period order and units must
      // be present; price changes, production and revenue growth are never
      // silently promoted to product demand.
      if (!/^油气销售收入\s*\(人民币百万元\)/.test(lines[i].trim())) continue;
      const headerStart = Math.max(0, i - 8), header = compact(lines.slice(headerStart, i).join(''));
      const year = Number(document.reportDate?.slice(0, 4));
      if (!header.endsWith(`${year}年上半年${year - 1}年上半年变动金额变动比例(%)`)) continue;
      let metric = 'revenue';
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const line = compact(lines[j]);
        if (/^销量\(/.test(line)) { metric = 'volume'; continue; }
        if (/^实现价格/.test(line)) break;
        const row = tableRows(lines, j, j + 1)[0];
        if (row?.subject && observe) observe(page, lines, headerStart, j, { subject: row.subject, rowStart: j + 1,
          table: 'product-period-comparison', unit: metric === 'volume' ? row.unit : '百万元', cells: row.numeric,
          columns: metric === 'volume' ? ['currentSalesVolume', 'previousSalesVolume', 'reportedSalesChange', 'reportedSalesGrowthPct']
            : ['currentRevenue', 'previousRevenue', 'reportedRevenueChange', 'reportedRevenueGrowthPct'], percentageHeaders: [3] });
        if (!row?.subject || row.values?.length !== 4 || !columnTypesMatch(row.numeric, 4, [3])) break;
        const [current, previous, change, percent] = row.values;
        if (current < 0 || previous <= 0 || Math.abs(current - previous - change) > 0.11 || Math.abs((current / previous - 1) * 100 - percent) > 0.15) continue;
        facts.push(span(document, page, lines, headerStart, j, { subject: row.subject, table: 'product-period-comparison', unit: metric === 'volume' ? row.unit : '百万元',
          ...(metric === 'volume' && row.unit ? { growth: percent, volume: current, priorVolume: previous } : metric === 'revenue' ? { revenue: current } : {}), rowStart: j + 1 }));
      }
    }
  }
  const additional = productTableFacts(document, { nativePages: () => pages, span, productName, numbers, scopes, observe });
  const result = [...facts, ...additional.filter(fact => !facts.some(existing => existing.subject === fact.subject
    && existing.locations[0].page === fact.locations[0].page && existing.rowStart === fact.rowStart && existing.table === fact.table))];
  return result.filter(fact => fact.table !== 'product-identification' || !result.some(other => other.subject === fact.subject && other.table !== 'product-identification'))
    .map(fact => ({ ...fact, tableScope: scopes.get(pages.find(page => (page.page ?? null) === fact.locations[0].page))?.[fact.rowStart - 1]?.metadata }));
}

function reportProductObservations(document) {
  const observations = [];
  reportProductTables(document, { observe: observation => observations.push(observation) });
  return observations.filter((value, index) => !observations.slice(0, index).some(other => other.subject === value.subject
    && other.table === value.table && other.rowStart === value.rowStart && other.locations[0].page === value.locations[0].page));
}

// Explicit issuer classifications from GB/T 4754/CSRC use letter categories;
// J is finance and is intentionally not eligible for the ordinary template.
const INDUSTRY_CLASSIFICATION_VERSION = 'gbt4754-2017/csrc-2012-v1';
function industryClassification(text) {
  const value = compact(text);
  if (OTHER.test(value) || /子公司(?:所属|所处|行业)|例如|假设|拟从事/.test(value)) return null;
  const match = /(?:本公司|公司)?(?:所属行业|所处行业|行业分类|行业类别)(?:属于|为|是|[:：])?([^。；]{1,180})/.exec(value);
  if (!match) {
    // An explicit principal operating activity can establish ordinary-company
    // applicability without inventing an official industry code. Production
    // descriptions of customers/investees or a broad legal business licence
    // are deliberately excluded.
    if (!/^(?:本公司|公司)/.test(value) || /预计|计划|拟|经营范围|(?:银行|保险|证券|金融)(?:业|服务|业务)/.test(value)) return null;
    if (/(?:主营|主要)业务(?:为|是)(?:勘探[、,]开发[、,])?生产及销售原油和天然气/.test(value)
      || /^(?:本公司|公司)主营业务(?:为|是)(?:煤制烯烃|化工产品制造|有色金属冶炼)/.test(value)
      || /^(?:本公司|公司)主营的贸易品种包括(?:铌|铜|铝|铁矿石|钢材)/.test(value)) return {
      applicable: true, classificationVersion: INDUSTRY_CLASSIFICATION_VERSION, classificationBasis: '发行人明确的主要生产或商品贸易业务；未推定官方行业代码' };
    return null;
  }
  const target = match[1], code = /\(([A-R])(\d{2,4})\)/.exec(target);
  if (code) return { applicable: code[1] !== 'J', code: code[1] + code[2], classificationVersion: INDUSTRY_CLASSIFICATION_VERSION };
  if (/银行业|保险业|证券业|金融业|金融服务业/.test(target)) return { applicable: false, classificationVersion: INDUSTRY_CLASSIFICATION_VERSION };
  if (/制造(?:业|\(|”|"|$)|软件|信息技术服务|批发|零售|农(?:业|林牧渔)|采矿|石油和天然气开采|建筑业|交通运输|货物运输|航运业|电力|食品|医药|住宿和餐饮|租赁和商务服务|水利.*环境.*公共设施|文化.*体育.*娱乐/.test(target)) return { applicable: true, classificationVersion: INDUSTRY_CLASSIFICATION_VERSION };
  return null;
}

module.exports = { productName, splitProductNames, correctionSections, debtCoverage, reportProductTables, reportProductObservations, industryClassification };
