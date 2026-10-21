const { checkboxSelection } = require('./company-evidence-text.cjs');
const { isVerifiedNonContentPage } = require('./company-document-parser.cjs');

const compact = value => String(value || '').normalize('NFKC').replace(/\s+/g, '');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUMBER = '(\\d+(?:,\\d{3})*(?:\\.\\d+)?)';
const NOT_FACT = /预计|有望|计划|拟于|拟在|目标|假设|如果|可能|不确定|未经核实|无法核实|不属实|不准确|表述有误|撤回|并非|不是/;

function sourceLines(document) {
  const pages = (Array.isArray(document.pageTexts) ? document.pageTexts : [{ text: document.text, page: null, method: 'provider-text', numericEligible: true, complete: true }])
    .filter(page => !isVerifiedNonContentPage(page, document));
  // A section crossing an OCR/untrusted page has no safe automatic conclusion.
  if (pages.some(page => page.complete !== true || page.numericEligible !== true || !['pdf-text', 'provider-text'].includes(page.method))) return [];
  return pages.flatMap(page => page.text.split(/\r?\n/).map((text, index) => ({ text, page: page.page, method: page.method, textHash: page.textHash || null, line: index + 1 })));
}

function span(lines, extra = {}) {
  const locations = [];
  for (const line of lines) {
    const previous = locations.at(-1);
    if (previous && previous.page === line.page && previous.lineEnd === line.line - 1) previous.lineEnd = line.line;
    else locations.push({ page: line.page, method: line.method, numericEligible: true, textHash: line.textHash, lineStart: line.line, lineEnd: line.line });
  }
  const text = lines.map(line => line.text).join('\n').trim(), excerpt = text.slice(0, 600);
  let used = 0;
  const excerptLines = lines.filter(line => { const include = used < 600; used += line.text.length + 1; return include; });
  const excerptLocations = locations.flatMap(location => {
    const last = excerptLines.filter(line => line.page === location.page).at(-1);
    return last && last.line >= location.lineStart ? [{ ...location, lineEnd: Math.min(last.line, location.lineEnd) }] : [];
  });
  return { text, locations, excerpt, excerptLocations, ...extra };
}

const headingLevel = text => /^第[一二三四五六七八九十百0-9]+[章节]/.test(text) ? 1
  : /^[一二三四五六七八九十]+[、.]/.test(text) ? 2 : /^\([一二三四五六七八九十0-9]+\)/.test(text) ? 3 : /^\d+[、.](?!\d)/.test(text) ? 4 : 0;
const stripHeading = text => text.replace(/^(?:第[一二三四五六七八九十百0-9]+[章节]|[一二三四五六七八九十]+[、.]|\([一二三四五六七八九十0-9]+\)|\d+[、.])/, '');

const riskSectionCache = new WeakMap();
function productRiskSections(document) {
  const cached = riskSectionCache.get(document); if (cached) return cached;
  const lines = sourceLines(document), majorChanges = [], riskSections = [];
  for (let i = 0; i < lines.length; i++) {
    const value = compact(lines[i].text);
    // The exact issuer-wide disclosure question and its own adjacent answer
    // establish a disclosure scope; a generic risk keyword miss does not.
    for (let end = i; end < Math.min(i + 4, lines.length) && lines[end].page === lines[i].page; end++) {
      const title = stripHeading(compact(lines.slice(i, end + 1).map(line => line.text).join('')));
      if (!/^报告期内公司经营情况的重大变化[,，]以及报告期内发生的对公司经营情况有重大影响和预计未来会有重大影响的事项$/.test(title)) continue;
      const answer = lines[end + 1];
      if (answer?.page === lines[i].page && checkboxSelection(answer.text) === 'notApplicable') majorChanges.push(span(lines.slice(i, end + 2), { section: '经营情况重大变化披露' }));
    }
    if (/^(?:报告期内|本报告期)(?:公司|本公司)经营情况(?:未发生|没有发生|不存在)重大变化[。.]?$/.test(value)) majorChanges.push(span([lines[i]], { section: '经营情况重大变化披露' }));
    const name = stripHeading(value);
    if (!/^(?:可能面对的风险|公司(?:可能)?面临的风险(?:和应对措施|及应对措施)?|风险因素|风险及应对措施)$/.test(name)) continue;
    const level = headingLevel(value) || 3;
    let end = i + 1;
    for (; end < lines.length && end - i <= 500; end++) {
      const current = compact(lines[end].text), nextLevel = headingLevel(current);
      if (nextLevel && nextLevel <= level) break;
    }
    if (end - i > 500) continue;
    const text = compact(lines.slice(i + 1, end).map(line => line.text).join(''));
    const reference = /(?:报告期内)?(?:公司|本公司)?(?:可能面对|面临)的风险(?:无变化|未发生变化|未发生重大变化)[,，]?详见(?:公司|本公司)?(20\d{2})年年度报告/.exec(text);
    // A heading, boilerplate cross-reference, empty checkbox or bare "risk"
    // alone cannot supply a substantive reviewable section.
    const substantive = text.length >= 60 && /风险/.test(text) && /应对|措施|管理|控制|防范|应收|原材料|市场|客户|技术/.test(text)
      && !/^(?:[□☐√☑☒✓✔适用不]*)?(?:详见|参见|请参阅)/.test(text);
    if (reference || substantive) riskSections.push(span(lines.slice(i, end), { section: name, referencedAnnualYear: reference ? Number(reference[1]) : null, substantive: !reference && substantive }));
  }
  const result = { majorChanges, riskSections };
  riskSectionCache.set(document, result);
  return result;
}

const METRICS = [
  { name: '单位成本', direction: -1, units: ['元/件', '元/台', '元/吨', '美元/件', '美元/台', '美元/吨'], group: 'cost' },
  { name: '单位能耗', direction: -1, units: ['千瓦时/台', '千瓦时/吨', '千瓦时/件', 'kWh/台', 'kWh/吨'], group: 'efficiency' },
  { name: '转换效率', direction: 1, units: ['%'], group: 'performance' },
  { name: '能量密度', direction: 1, units: ['Wh/kg', '瓦时/千克'], group: 'performance' },
  { name: '良品率', direction: 1, units: ['%'], group: 'performance' },
  { name: '市场份额', direction: 1, units: ['%'], group: 'market' }
];

function quantifiedProductComparisons(document, subject, issuerNames) {
  const results = [], aliases = issuerNames.map(escape).join('|'), period = document.reportDate;
  const expectedPeriod = period?.endsWith('-06-30') ? `${period.slice(0, 4)}年(?:上半年|半年度)` : `${period?.slice(0, 4)}年(?:度)?`;
  for (const paragraph of document.paragraphs) {
    const text = compact(paragraph);
    if (NOT_FACT.test(text) || /竞争对手的报告|公司自行|内部测算|公司测算|自认为|宣传/.test(text)) continue;
    const citation = /^(?:根据|据|援引)([^，,:：《》]{2,80}?)(?:发布|公布|出具)的?[《〈]([^》〉]{2,100})[》〉][,，]/.exec(text);
    if (!citation || !/(?:协会|研究院|研究所|实验室|检测中心|咨询|委员会|机构|统计局|[A-Z])/.test(citation[1])
      || /^(?:有关|相关|权威|第三方|某|独立|本公司|公司)(?:行业)?(?:机构|协会|研究|实验室)/.test(citation[1])
      || /本公司|子公司|关联方|控股股东|母公司|参股|联营|合营/.test(citation[1])) continue;
    const citedYears = [...citation[2].matchAll(/20\d{2}/g)].map(match => Number(match[0]));
    const sourcePeriodConflict = citedYears.some(year => year !== Number(period?.slice(0, 4)));
    const statement = text.slice(citation[0].length);
    for (const metric of METRICS) {
      const unit = `(${metric.units.map(escape).join('|')})`;
      const basis = metric.group === 'market' ? '(全国|全球)同口径' : '(同规格同口径|同规格同测试条件|相同规格及测试条件)';
      // Both operands explicitly name the same product and metric. No metric
      // inheritance across an intervening clause, different unit or prior year.
      const pattern = new RegExp(`^(${expectedPeriod})${basis}[,，](?:${aliases})(?:的)?${escape(subject)}(?:产品)?${metric.name}(?:为|达到)${NUMBER}${unit}[,，]同期${metric.group === 'market' ? '(?:全国|全球)全市场' : '行业同规格'}${escape(subject)}(?:产品)?平均${metric.name}(?:为|达到)${NUMBER}${unit}[。.]?$`);
      const match = pattern.exec(statement);
      if (!match || match[4] !== match[6] || metric.group === 'market' && !statement.includes(`同期${match[2]}全市场`)) continue;
      const own = Number(match[3].replaceAll(',', '')), benchmark = Number(match[5].replaceAll(',', ''));
      if (!(own > 0 && benchmark > 0) || metric.units[0] === '%' && (own > 100 || benchmark > 100)) continue;
      results.push({ text: paragraph, metric: metric.name, comparisonType: metric.group, ownValue: own, benchmarkValue: benchmark, unit: match[4],
        comparisonPeriod: period, comparisonScope: match[2], comparator: metric.group === 'market' ? '全市场平均' : '行业同规格平均',
        supportsAdvantage: !sourcePeriodConflict && (own - benchmark) * metric.direction > 0, automaticConflict: sourcePeriodConflict,
        ...(sourcePeriodConflict ? { conflictReason: '引用报告名称中的明确年度与比较统计期间不一致' } : {}), citedSource: citation[1], citedReport: citation[2],
        sourceRelation: 'issuer-cites-third-party', coverageBasis: '发行人引用具名第三方报告的同期间、同产品、同规格或同市场口径量化比较；第三方原文未独立取回' });
    }
  }
  return results;
}

module.exports = { productRiskSections, quantifiedProductComparisons };
