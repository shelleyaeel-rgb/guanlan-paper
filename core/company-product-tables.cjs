'use strict';
// Common issuer report layouts. A disclosed product category stays a category;
// neither an industry segment nor production/revenue is a demand observation.
const compact = text => String(text || '').normalize('NFKC').replace(/\s+/g, '');
const MONEY = /单位[:：](百万元|万元|亿元|元)/;
const UNIT = '(?:十亿立方英尺|百万立方米|万立方米|立方米|百万桶|万桶|万吨|千吨|吨|千克|公斤|万台|台|万件|件|万套|套|万只|只|万盒|盒|万平方米|平方米|亿元|万元|元)';
const NON_ISSUER = /母公司财务报表|母公司利润表|子公司主要财务|竞争对手|其他公司|客户|供应商|参股公司|联营公司|合营公司/;
const STOP = /^(?:分行业|分地区|分销售模式|分产品|主营业务分(?:行业|产品)|营业收入构成|单位[:：]|公司主营业务数据|相关数据同比|产销量情况说明|[一二三四五六七八九十]+[、.]|\(?\d+\)?[、.])/;
const GROWTH_ROUNDING_PCT = 0.03;
const marginHeader = '营业收入营业成本毛利率营业收入比上年同期增减营业成本比上年同期增减毛利率比上年同期增减';
const shareHeader = '本报告期上年同期同比增减金额占营业收入比重金额占营业收入比重';
const supportedNameWraps = new Set(['功能化学品', '高分子新材料', '铝箔及铝箔坯料', '销售铝箔及铝箔坯料']);
const cleanHeader = text => compact(text).replace(/\(%\)/g, '');
function columnTypesMatch(text, size, percentageColumns) {
  const cells = String(text).trim().replace(/-\s+(?=\d)/g, '-').split(/\s+/);
  return cells.length === size && cells.every((cell, index) => !cell.includes('%') || percentageColumns.includes(index));
}
function percentCell(text, index) {
  return String(text).trim().replace(/-\s+(?=\d)/g, '-').split(/\s+/)[index]?.endsWith('%') === true;
}
function explicitPeriod(title, document) {
  const text = title.replace(/^(?:本公司|公司|本集团)/, ''), half = document.reportDate?.endsWith('06-30');
  if (/^(?:上年|上年度|上期|去年|前期|历史|以前年度)/.test(text)) return false;
  const dated = /^(20\d{2})(?:年)?(.*)$/.exec(text), duration = dated?.[2] ?? text;
  if (dated && dated[1] !== document.reportDate?.slice(0, 4)) return false;
  if (/^(?:上半年|半年度|1(?:月)?[-—至~～]6月)/.test(duration)) return half;
  if (/^(?:度|年度|全年|本年度|本年|1(?:月)?[-—至~～]12月)/.test(duration)) return !half;
  if (/^(?:下半年|本季度|当季|单季|第?[一二三四1234]季度|前?[一二三四1234567890]+(?:个)?月|\d)/.test(duration)) return false;
  return dated ? !half : null;
}
function titlePeriod(title, document) {
  // Read all explicit periods in a heading, including parenthesized suffixes.
  // Multiple conflicting periods are not silently reduced to the report date.
  const starts = [...title.matchAll(/20\d{2}年|上年度|上年同期|上年|上期|去年|前期|历史|以前年度|本年度|本季度|当季|单季|第?[一二三四1234]季度|上半年|下半年/g)];
  const periods = starts.map(match => explicitPeriod(title.slice(match.index), document)).filter(value => value !== null);
  return periods.length ? periods.every(Boolean) : null;
}

// Table scopes survive blank lines, table notes and PDF page boundaries. A
// repeated report page header does not reset an older-period or third-party
// chapter. Only a new top-level chapter resets the enclosing report scope.
function productTableScopes(document, pages) {
  const byPage = new Map(), stack = [], initial = () => ({ period: true, issuer: true, actual: true, headings: [] });
  let scope = initial();
  for (const page of pages) {
    const states = [], lines = page.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const raw = compact(line), title = raw.replace(/^(?:第[一二三四五六七八九十0-9]+[章节]|[一二三四五六七八九十]+[、.]|\([一二三四五六七八九十]+\)|\(?\d+\)?[、.])/, '');
      const reportHeader = /20\d{2}年(?:年度|半年度|第[一二三四]季度)报告(?:全文)?$/.test(raw);
      const headingLike = title.length <= 100 && !/[，,、。；;！？!?]/.test(title)
        && !/\d[\d.]*(?:百|千|万|亿)*(?:元|吨|件|台|套|只|%)/.test(title);
      const level = reportHeader || !headingLike ? null : /^第[一二三四五六七八九十0-9]+[章节]/.test(raw) ? 0
        : /^[一二三四五六七八九十]+[、.]/.test(raw) ? 1 : /^\([一二三四五六七八九十]+\)/.test(raw) ? 2
          : /^\d+[、.](?!\d)/.test(raw) ? 3 : /^\(\d+\)/.test(raw) ? 4 : null;
      if (level !== null) {
        if (level === 0) stack.length = 0;
        while (stack.length && stack.at(-1).level >= level) stack.pop();
        scope = stack.length ? { ...stack.at(-1).scope } : initial();
      }
      // Native line wrapping does not turn a comma-ended narrative, monetary
      // comparison or column label into an enclosing section. Those lines can
      // mention forecasts/previous years without changing a later table's scope.
      const subjectTitle = /^(?:主要)?(?:竞争对手|其他公司|客户(?:公司)?|供应商|参股公司|联营公司|合营公司)(?:情况|信息|概况|数据)?$/.test(title);
      const tableTitle = !reportHeader && headingLike
        && (subjectTitle || /产品|营业收入|销量|销售|产销|订单|经营|统计|财务/.test(title)
          && /(?:情况|数据|统计|分析|构成|收入|销量|销售|产销|订单|经营|财务|报告|产品|汇总|业绩|回顾)$/.test(title.replace(/\([^()]*\)$/, '')))
        && !/^(?:行业分类|产品分类|产品名称|主要产品|产品)(?:项目)?单位/.test(title)
        && !/^(?:营业收入|营业成本|毛利率)比上年同期增减(?:\(%\))?$/.test(title)
        && !/本报告期上年同期.*同比增减/.test(title);
      let scopeHeading = level !== null;
      if (tableTitle) {
        if (NON_ISSUER.test(title)) { scope = { ...scope, issuer: false }; scopeHeading = true; }
        if (/预计|预测|预算|计划/.test(title)) { scope = { ...scope, actual: false }; scopeHeading = true; }
        const period = titlePeriod(title, document);
        if (period !== null) {
          scopeHeading = true;
          scope = { ...scope, period: scope.period && period };
        }
      }
      if (scopeHeading) scope = { ...scope, headings: [...scope.headings, { text: line.trim(), location: { page: page.page ?? null,
        method: page.method, numericEligible: true, textHash: page.textHash || null, lineStart: index + 1, lineEnd: index + 1 } }] };
      if (level !== null) stack.push({ level, scope });
      else if (stack.length) stack.at(-1).scope = scope;
      else if (scopeHeading) stack.push({ level: -1, scope });
      states.push({ eligible: scope.period && scope.issuer && scope.actual,
        metadata: { basis: 'report-period-with-enclosing-native-section', reportDate: document.reportDate, headings: scope.headings } });
    }
    byPage.set(page, states);
  }
  return byPage;
}
// A complete table header cannot lend its unit or columns to a later table.
// Only numeric industry rows (and their explicit divider) may intervene before
// the product divider of that same revenue table.
function headerTailIsLocal(lines, unitAt, start, expected, numericRow) {
  let built = '', end = -1;
  for (let line = unitAt; line < start; line++) {
    built += cleanHeader(lines[line]);
    if (built.includes(expected)) { end = line; break; }
  }
  if (end < 0) return false;
  for (let line = end + 1; line < start; line++) {
    if (!cleanHeader(lines[line]) || compact(lines[line]) === '分行业' || numericRow(lines[line])) continue;
    // Native PDF extraction can split an industry row label across several
    // lines. This admits only complete industry/other-business labels, never
    // an arbitrary new heading followed by a product's numbers.
    let joined = lines[line].trim(), consumed = false;
    for (let next = line + 1; next < Math.min(start, line + 5); next++) {
      if (!/^[\p{Script=Han}A-Za-z\s]+$/u.test(joined)) break;
      joined += (/^\s*[(-]?\d/.test(lines[next]) ? ' ' : '') + lines[next].trim();
      const row = numericRow(joined);
      if (row) {
        if (/(?:行业|加工|加工业|采掘业|制造业|其他业务)$/.test(row.label)) { line = next; consumed = true; }
        break;
      }
    }
    if (!consumed) return false;
  }
  return true;
}
function reportPeriod(document) {
  if (!/^20\d{2}-(?:06-30|12-31)$/.test(document.reportDate || '')) return null;
  return { currentEnd: document.reportDate, previousEnd: `${Number(document.reportDate.slice(0, 4)) - 1}${document.reportDate.slice(4)}`,
    basis: 'current-report-and-explicit-comparison-columns' };
}
function sameGrowth(current, previous, percent) {
  return [current, previous, percent].every(Number.isFinite) && current >= 0 && previous > 0
    && Math.abs((current / previous - 1) * 100 - percent) <= GROWTH_ROUNDING_PCT;
}
function productTableFacts(document, api) {
  const { nativePages, span, productName, numbers } = api, facts = [], period = reportPeriod(document);
  if (!period) return facts;
  const pages = nativePages(document), names = new Set(), scopes = api.scopes || productTableScopes(document, pages);
  const normalizeName = label => productName(compact(label).replace(/^销售(?=.{1,24}$)/, ''));
  const numericRow = text => {
    const normalized = String(text).trim().normalize('NFKC');
    const match = /^(.+?)\s+([(-]?\d[\d,.%()\s+\-]*)$/.exec(normalized)
      || (api.observe ? /^(.+?)\s+((?:[-—–](?:\s|$)|\(?-?\d)[\d,.%()\s+\-—–]*)$/.exec(normalized) : null);
    return match ? { label: compact(match[1]), values: numbers(match[2]), numeric: match[2] } : null;
  };
  const sections = [];
  for (const page of pages) {
    const lines = page.text.split(/\r?\n/);
    if (/母公司财务报表|母公司利润表|子公司主要财务/.test(compact(page.text))) continue;
    for (let i = 0; i < lines.length; i++) {
      if (!/^(?:分产品(?:或服务)?|主营业务分产品情况)$/.test(compact(lines[i]))) continue;
      if (!scopes.get(page)?.[i]?.eligible) continue;
      let end = i + 1;
      while (end < lines.length && end < i + 65 && !STOP.test(compact(lines[end]))) end++;
      sections.push({ page, lines, start: i, end });
    }
  }
  for (const section of sections) {
    const { page, lines, start, end } = section;
    // The unit and complete header must be on this page. Continuation pages can
    // identify their explicitly labelled products without inventing lost units.
    let unitAt = -1;
    for (let i = 0; i < start; i++) if (MONEY.test(compact(lines[i]))) unitAt = i;
    const header = unitAt >= 0 ? cleanHeader(lines.slice(unitAt, start).join('')) : '';
    const rawHeader = unitAt >= 0 ? compact(lines.slice(unitAt, start).join('')) : '';
    const unitMatches = unitAt >= 0 ? [...compact(lines[unitAt]).matchAll(/单位[:：](百万元|万元|亿元|元)/g)] : [];
    const unit = unitMatches.length === 1 ? unitMatches[0][1] : null;
    const headingContext = compact(lines.slice(Math.max(0, unitAt >= 0 ? unitAt - 3 : start - 10), start).join(''));
    const historical = [...headingContext.matchAll(/(20\d{2})年(?:度|半年度)?(?:产品|分产品)(?:收入|情况)/g)]
      .some(match => match[1] !== document.reportDate.slice(0, 4));
    const shareCount = header.split(shareHeader).length - 1, marginCount = header.split(marginHeader).length - 1;
    const layout = !historical && unit && shareCount + marginCount === 1
      && headerTailIsLocal(lines, unitAt, start, shareCount ? shareHeader : marginHeader, numericRow)
      ? shareCount === 1 ? 'shares' : 'margin' : null;
    let total = null, rawTotal = null, invalidTotal = false;
    if (layout === 'shares') {
      const totals = lines.slice(unitAt, start).map((line, index) => ({ ...numericRow(line), line: unitAt + index })).filter(row => row?.label === '营业收入合计');
      rawTotal = totals.length === 1 ? totals[0] : null;
      if (totals.length === 1 && totals[0].values?.length === 5 && columnTypesMatch(totals[0].numeric, 5, [1, 3, 4])
        && (percentCell(totals[0].numeric, 4) || /同比增减\(%\)/.test(rawHeader))
        && sameGrowth(totals[0].values[0], totals[0].values[2], totals[0].values[4])
        && totals[0].values[1] === 100 && totals[0].values[3] === 100) total = totals[0].values;
      invalidTotal = lines.slice(unitAt, start).some(line => compact(line).startsWith('营业收入合计')) && !total;
      if (invalidTotal && !api.observe) continue;
    }
    for (let row = start + 1; row < end; row++) {
      if (!compact(lines[row])) continue;
      const first = row; let parsed = numericRow(lines[row]);
      if (!parsed && /^[\p{Script=Han}A-Za-z/·() -]{1,25}$/u.test(lines[row].trim()) && row + 1 < end) {
        const next = numericRow(lines[row + 1]), joined = next && compact(lines[row]) + next.label;
        if (next && (names.has(normalizeName(joined)) || supportedNameWraps.has(joined))) { parsed = { ...next, label: joined }; row++; }
      }
      if (!parsed) continue;
      const subject = normalizeName(parsed.label); if (!subject) continue;
      const identity = { subject, disclosedSubject: parsed.label, subjectBasis: 'explicit-product-category', period,
        table: 'product-identification', rowStart: first + 1 };
      // Only unfinished decimal cents may use the immediately following numeric
      // line. Never concatenate two complete amounts into a new number.
      while (row + 1 < end && /\.[0-9]?$/.test(parsed.numeric) && /^\s*\d{1,2}(?:\s|$)/.test(lines[row + 1])) {
        const digits = /\.([0-9]?)$/.exec(parsed.numeric)[1].length, next = lines[row + 1].trim();
        if (!new RegExp(`^\\d{${2 - digits}}(?:\\s|$)`).test(next)) break;
        parsed.numeric += next; parsed.values = numbers(parsed.numeric); row++;
      }
      let values = parsed.values, numeric = null;
      if (api.observe) api.observe(page, lines, layout ? unitAt : start, row, { ...identity, table: layout === 'shares' ? 'product-revenue-comparison'
        : layout === 'margin' ? 'product-revenue-margin' : 'product-identification', unit, cells: parsed.numeric,
        columns: layout === 'shares' ? ['currentRevenue', 'reportedRevenueSharePct', 'previousRevenue', 'reportedPreviousRevenueSharePct', 'reportedRevenueGrowthPct']
          : layout === 'margin' ? ['currentRevenue', 'currentCost', 'reportedGrossMarginPct', 'reportedRevenueGrowthPct', 'reportedCostGrowthPct', 'reportedGrossMarginChange'] : [],
        percentageHeaders: layout === 'shares' ? [...(/占营业收入比重\(%\)/.test(rawHeader) ? [1, 3] : []), ...(/同比增减\(%\)/.test(rawHeader) ? [4] : [])]
          : [...(/毛利率\(%\)/.test(rawHeader) ? [2] : []), ...(/营业收入比上年同期增减\(%\)/.test(rawHeader) ? [3] : []),
            ...(/营业成本比上年同期增减\(%\)/.test(rawHeader) ? [4] : []), ...(/毛利率比上年同期增减\(%\)/.test(rawHeader) ? [5] : [])],
        total: rawTotal ? { unit, cells: rawTotal.numeric, columns: ['currentTotalRevenue', 'reportedTotalSharePct', 'previousTotalRevenue', 'reportedPreviousTotalSharePct', 'reportedTotalRevenueGrowthPct'],
          percentageHeaders: /同比增减\(%\)/.test(rawHeader) ? [4] : [], locations: span(document, page, lines, rawTotal.line, rawTotal.line).locations } : null,
        issue: layout ? null : 'table-layout-not-verified' });
      if (api.observe && layout) names.add(subject);
      if (layout === 'shares' && !invalidTotal && values?.length === 5 && columnTypesMatch(parsed.numeric, 5, [1, 3, 4])) {
        const [revenue, share, previousRevenue, previousShare, change] = values;
        const sharesValid = [share, previousShare].every(value => value >= 0 && value <= 100)
          && (!total || Math.abs(revenue / total[0] * 100 - share) <= GROWTH_ROUNDING_PCT && Math.abs(previousRevenue / total[2] * 100 - previousShare) <= GROWTH_ROUNDING_PCT);
        if (revenue > 0 && sharesValid && (percentCell(parsed.numeric, 4) || /同比增减\(%\)/.test(rawHeader))
          && sameGrowth(revenue, previousRevenue, change)) numeric = { table: 'product-revenue-comparison', revenue, previousRevenue,
          unit, revenueGrowthPct: change, revenueShare: total ? share : null, totalRevenue: total?.[0] ?? null, arithmetic: 'current/prior-revenue-and-reported-growth' };
      }
      if (layout === 'margin' && values?.length === 6 && columnTypesMatch(parsed.numeric, 6, [2, 3, 4, 5])) {
        const [revenue, cost, margin] = values;
        if (revenue > 0 && cost >= 0 && values.every(Number.isFinite) && (percentCell(parsed.numeric, 2) || /毛利率\(%\)/.test(rawHeader))
          && Math.abs((1 - cost / revenue) * 100 - margin) <= GROWTH_ROUNDING_PCT) {
          numeric = { table: 'product-revenue-margin', revenue, cost, margin, unit,
            ...(percentCell(parsed.numeric, 3) || /营业收入比上年同期增减\(%\)/.test(rawHeader) ? { revenueGrowthPct: values[3] } : {}),
            arithmetic: 'revenue/cost-and-reported-margin' };
        }
      }
      if (!numeric && (unitAt >= 0 || historical)) continue;
      names.add(subject);
      facts.push(span(document, page, lines, numeric ? unitAt : start, row, { ...identity, ...numeric,
        ...(!numeric ? { validationReason: '产品身份可识别；同页完整表头、单位或金额算术尚不足，未转为收入或需求事实' } : {}) }));
    }
  }
  for (const page of pages) {
    const lines = page.text.split(/\r?\n/);
    if (/母公司财务报表|母公司利润表|子公司主要财务/.test(compact(page.text))) continue;
    for (let i = 0; i < lines.length; i++) {
      const headerLines = []; let headerEnd = i;
      for (; headerEnd < Math.min(lines.length, i + 14); headerEnd++) {
        headerLines.push(lines[headerEnd]); const value = cleanHeader(headerLines.join(''));
        if (/同比增减$|库存量比上年增减$/.test(value)) break;
      }
      const header = cleanHeader(headerLines.join(''));
      const growthPercentHeader = /同比增减\(%\)/.test(compact(headerLines.join('')));
      const year = Number(document.reportDate.slice(0, 4)), annual = document.reportDate.endsWith('12-31');
      const periods = annual ? `${year}年${year - 1}年` : `${year}年上半年${year - 1}年上半年`;
      const grouped = new RegExp(`^(行业分类|产品分类|产品名称|主要产品)项目单位${periods}同比增减$`).exec(header);
      const direct = /^(?:产品名称|主要产品|产品)单位(?:本报告期|本期)(销量|销售量|订单量|订单金额)上年同期\1同比增减$/.exec(header);
      const inventory = /^(?:主要产品|产品名称)单位生产量销售量库存量生产量比上年增减销售量比上年增减库存量比上年增减$/.test(header);
      if (!grouped && !direct && !inventory) continue;
      if (!scopes.get(page)?.[i]?.eligible) continue;
      let rows = [], pendingSubject = null;
      for (let j = headerEnd + 1; j < Math.min(lines.length, headerEnd + 65); j++) {
        const raw = lines[j].trim().normalize('NFKC'), text = compact(raw); if (!text) continue;
        if (STOP.test(text) || /是否|情况说明|单位[:：]/.test(text)) break;
        const expression = grouped ? new RegExp(`^(.*?)(销售量|生产量|库存量)\\s+(${UNIT})\\s+(.+)$`)
          : new RegExp(`^(.+?)\\s+(${UNIT})\\s+(.+)$`);
        const match = expression.exec(raw);
        if (!match) {
          if (grouped && !rows.length && /^[\p{Script=Han}A-Za-z/·() -]{1,25}$/u.test(raw)) { pendingSubject = text; continue; }
          break;
        }
        if (grouped) {
          rows.push({ label: compact(match[1]) || pendingSubject, metric: match[2], unit: match[3], values: numbers(match[4]), numeric: match[4], line: j }); pendingSubject = null;
          if (rows.length < 3) continue;
          if (rows.map(row => row.metric).join() !== '销售量,生产量,库存量' || new Set(rows.map(row => row.unit)).size !== 1) { rows = []; continue; }
          const disclosed = [...new Set(rows.map(row => row.label).filter(Boolean))];
          let subject = disclosed.length === 1 ? normalizeName(disclosed[0]) : null;
          if (grouped[1] === '行业分类') {
            const candidate = disclosed[0]?.replace(/(?:制造业|行业)$/, '');
            subject = disclosed.length === 1 && names.has(normalizeName(candidate)) ? normalizeName(candidate) : null;
          }
          const sales = rows[0], values = sales.values;
          if (subject && !/元$/.test(sales.unit) && api.observe) api.observe(page, lines, i, j, { subject, disclosedSubject: disclosed[0], rowStart: sales.line + 1,
            unit: sales.unit, table: 'product-sales-comparison', cells: sales.numeric,
            columns: ['currentSalesVolume', 'previousSalesVolume', 'reportedSalesGrowthPct'], percentageHeaders: growthPercentHeader ? [2] : [] });
          if (subject && !/元$/.test(sales.unit) && values?.length === 3 && columnTypesMatch(sales.numeric, 3, [2])
            && (percentCell(sales.numeric, 2) || growthPercentHeader) && sameGrowth(...values)) facts.push(span(document, page, lines, i, j, { subject,
            disclosedSubject: disclosed[0], table: 'product-sales-comparison', metric: 'sales-volume', unit: sales.unit, period,
            volume: values[0], priorVolume: values[1], growth: values[2], rowStart: sales.line + 1, arithmetic: 'current/prior-sales-and-reported-growth' }));
          rows = []; continue;
        }
        const subject = normalizeName(match[1]), unit = match[2], values = numbers(match[3]);
        if (!subject) continue;
        if (api.observe && (inventory && !/元$/.test(unit) || direct && (direct[1] === '订单金额' ? /元$/.test(unit) : !/元$/.test(unit)))) {
          const metric = direct && /订单/.test(direct[1]) ? direct[1] === '订单金额' ? 'OrderAmount' : 'OrderVolume' : 'SalesVolume';
          api.observe(page, lines, i, j, { subject, rowStart: j + 1, unit, cells: match[3], table: inventory ? 'product-production-sales-inventory' : 'product-sales-comparison',
            columns: inventory ? ['currentProductionVolume', 'currentSalesVolume', 'currentInventoryVolume', 'reportedProductionGrowthPct', 'reportedSalesGrowthPct', 'reportedInventoryGrowthPct']
              : [`current${metric}`, `previous${metric}`, metric === 'SalesVolume' ? 'reportedSalesGrowthPct' : 'reportedOrderGrowthPct'],
            percentageHeaders: inventory ? [...(/生产量比上年增减\(%\)/.test(compact(headerLines.join(''))) ? [3] : []),
              ...(/销售量比上年增减\(%\)/.test(compact(headerLines.join(''))) ? [4] : []), ...(/库存量比上年增减\(%\)/.test(compact(headerLines.join(''))) ? [5] : [])]
              : growthPercentHeader ? [2] : [] });
        }
        if (!values) continue;
        if (direct && values.length === 3 && columnTypesMatch(match[3], 3, [2]) && (percentCell(match[3], 2) || growthPercentHeader)
          && sameGrowth(...values) && (direct[1] === '订单金额' ? /元$/.test(unit) : !/元$/.test(unit))) {
          facts.push(span(document, page, lines, i, j, { subject, disclosedSubject: compact(match[1]), table: 'product-sales-comparison',
            metric: /订单/.test(direct[1]) ? direct[1] : 'sales-volume', unit, period, volume: values[0], priorVolume: values[1], growth: values[2],
            rowStart: j + 1, arithmetic: 'current/prior-disclosed-metric-and-reported-growth' }));
        }
        if (inventory && values.length === 6 && columnTypesMatch(match[3], 6, [3, 4, 5]) && values.every(Number.isFinite) && values.slice(0, 3).every(value => value >= 0) && !/元$/.test(unit)) {
          facts.push(span(document, page, lines, i, j, { subject, disclosedSubject: compact(match[1]), table: 'product-production-sales-inventory', metric: 'sales-volume',
            unit, period, volume: values[1], ...(percentCell(match[3], 4) || /销售量比上年增减\(%\)/.test(compact(headerLines.join(''))) ? { reportedGrowthPct: values[4] } : {}), rowStart: j + 1,
            validationReason: '原文披露当期销量及同比，但缺少可独立核对的上期销量；未用产量或收入替代需求，未将该同比设为已验证增长' }));
        }
      }
      i = headerEnd;
    }
  }
  // Raw-metric-only layout: both periods' revenue and cost are explicitly
  // disclosed. This does not change the legacy four-condition evidence path.
  if (api.observe) {
    let financialScope = 'unknown', accountingScope = null;
    for (const page of pages) {
      const lines = page.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const heading = compact(lines[i]).replace(/^(?:[一二三四五六七八九十]+[、.]|\d+[、.]|\([一二三四五六七八九十\d]+\))/, '');
        if (/^母公司财务报表(?:主要)?项目注释$/.test(heading)) financialScope = 'parent';
        if (/^合并财务报表(?:主要)?项目注释$/.test(heading)) {
          financialScope = 'issuer';
          accountingScope = { kind: 'consolidated-report-notes', text: lines[i].trim(), locations: span(document, page, lines, i, i).locations };
        }
        if (financialScope !== 'issuer' || !scopes.get(page)?.[i]?.eligible) continue;
        const header = compact(lines.slice(i, i + 2).join(''));
        if (!/^产品名称本期(?:发生额|金额)上期(?:发生额|金额)收入成本收入成本$/.test(header)) continue;
        const preceding = lines.slice(Math.max(0, i - 3), i).map(compact).filter(Boolean).at(-1) || '';
        if (!/^(?:\d+\))?主营业务\(分产品\)$/.test(preceding)) continue;
        let unitAt = -1;
        for (let j = Math.max(0, i - 40); j < i; j++) if (MONEY.test(compact(lines[j]))) unitAt = j;
        const units = unitAt >= 0 ? [...compact(lines[unitAt]).matchAll(/单位[:：](百万元|万元|亿元|元)/g)] : [];
        if (units.length !== 1 || /币种[:：](?!人民币)[\p{Script=Han}]+/u.test(compact(lines[unitAt]))) continue;
        const local = lines.slice(unitAt + 1, i).every(line => !compact(line) || numericRow(line)
          || /^(?:项目本期(?:发生额|金额)上期(?:发生额|金额)|收入成本收入成本|(?:\d+\))?营业收入明细|(?:\d+\))?主营业务\(分产品\))$/.test(compact(line)));
        if (!local) continue;
        const unit = units[0][1];
        let total = null;
        for (let j = unitAt + 1; j < i - 1; j++) {
          if (!/^项目本期(?:发生额|金额)上期(?:发生额|金额)收入成本收入成本$/.test(compact(lines.slice(j, j + 2).join('')))) continue;
          for (let row = j + 2; row < i; row++) {
            if (!compact(lines[row])) continue;
            const parsed = numericRow(lines[row]); if (!parsed) break;
            if (parsed.label !== '合计') continue;
            const cells = parsed.numeric.trim().split(/\s+/);
            if (cells.length === 4) total = { unit, cells: `${cells[0]} ${cells[2]}`, columns: ['currentTotalRevenue', 'previousTotalRevenue'],
              percentageHeaders: [], locations: span(document, page, lines, row, row).locations };
            break;
          }
          break;
        }
        for (let row = i + 2; row < Math.min(lines.length, i + 65); row++) {
          if (!compact(lines[row])) continue;
          const parsed = numericRow(lines[row]); if (!parsed || parsed.label === '合计') break;
          const subject = normalizeName(parsed.label); if (!subject) continue;
          api.observe(page, lines, unitAt, row, { subject, disclosedSubject: parsed.label, unit, rowStart: row + 1,
            table: 'product-revenue-cost-two-periods', cells: parsed.numeric,
            columns: ['currentRevenue', 'currentCost', 'previousRevenue', 'previousCost'], percentageHeaders: [], total, accountingScope });
        }
      }
    }
  }
  return facts;
}
module.exports = { productTableFacts, productTableScopes, columnTypesMatch, percentCell };
