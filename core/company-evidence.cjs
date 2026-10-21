const { cnTime, symbolOf } = require('./common.cjs');
const { validateEvidenceQuery, EVIDENCE_CONDITIONS, safeEvidenceUrl, describeIndustryRules, industryRulesForQuery } = require('./selection-evidence.cjs');
const { paragraphEntries: parseParagraphs, checkboxSelection } = require('./company-evidence-text.cjs');
const { isVerifiedNonContentPage, PARSER_VERSION } = require('./company-document-parser.cjs');
const { productName, splitProductNames, correctionSections, debtCoverage, reportProductTables, industryClassification } = require('./company-evidence-structured.cjs');
const { collectIndependentRankings } = require('./company-industry-evidence.cjs');
const { productRiskSections, quantifiedProductComparisons } = require('./company-product-assessment.cjs');

const RULE_VERSION = '7';
const LABELS = { demand: '需求增长', commercialization: '产品商业化', advantage: '竞争优势', outlookRisk: '产品重大反向证据复核', financialReview: '财务事项复核', leadership: '行业地位' };
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const and = statuses => statuses.includes('fail') ? 'fail' : statuses.includes('pending') ? 'pending' : 'pass';
const or = statuses => statuses.includes('pass') ? 'pass' : !statuses.length || statuses.includes('pending') ? 'pending' : 'fail';
const clean = text => String(text || '').normalize('NFKC').replace(/[\t \u3000]+/g, ' ').trim();
const compact = text => clean(text).replace(/\s+/g, '');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUM = '[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?';
const FORWARD = /预计|有望|力争|目标(?:为|是|达到)|计划(?:于|在|实现|达到)|拟(?:于|在|实现|达到)|假设|尚未|尚无|未能|未实现|不能证明|不属实|不准确|不正确|表述有误|撤回.{0,8}表述/;
const UNCERTAIN = /无法核实|未经核实|尚待|存在争议|口径不一致|可能|不确定/;
const OTHER_ENTITY = /竞争对手|其他公司|其他企业|参股公司|联营公司|合营公司|控股股东|母公司|供应商|客户公司/;
const HYPOTHETICAL = /如果|假如|假设|(?:^|[，,])若|一旦|如发生|可能发生|可能存在|将会|未来可能/;
const LIMITED_SCOPE = /上市公司|上市企业|区域|省内|市内|华东|华南|集团|控股股东|母公司|会员|成员企业|成员单位|参评|参赛|参展|受访|受调查|抽样|样本|重点企业|重点公司|主要企业|重点监测|规模以上|百强企业|(?:调查|统计|覆盖)(?:了)?\d+家/;
const issuerPrefix = text => /^(?:(?:本公司|公司|我们|报告期内|本报告期|本年度|本期|本年|其中|同期|于|截至|20\d{2}年(?:上半年|下半年|半年度|年度)?|的|，|,))*$/.test(text);
const clauses = text => text.replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '\u0001')
  .split(/[，,]|但是|但|然而|不过/).map(value => value.replace(/\u0001/g, ','));
const currentFact = (text, document) => {
  if (/^(?:去年|上年度|上一年度)/.test(text)) return false;
  const year = /^(?:于|截至)?(20\d{2}|二[〇零一二三四五六七八九]{3})年/.exec(text)?.[1];
  const digits = { 〇: '0', 零: '0', 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
  return !year || year.replace(/[〇零一二三四五六七八九]/g, value => digits[value]) === document.reportDate?.slice(0, 4);
};
function rankNumberOf(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0, 〇: 0 };
  let total = 0, digit = 0;
  for (const character of value) {
    if (Object.hasOwn(digits, character)) digit = digits[character];
    else if (character === '十' || character === '百' || character === '千') { total += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[character]); digit = 0; }
    else return null;
  }
  return total + digit;
}
const PRODUCT_ADVERSE = /(?:产品|业务|订单|需求|销量|销售量|市场份额|市场占有率).{0,35}(?:持续萎缩|严重下滑|大幅下降|终止生产|停止生产|被禁止|存在重大不利|发生重大不利|重大质量事故)|(?:临床|试验).{0,30}(?:失败|未达到.{0,12}终点)/;
const FINANCIAL_BOILERPLATE = /详见|参见|认定标准|定性标准|重大缺陷的认定|例如|或者很可能|已经或很可能|形成(?:保留|否定|无法表示)意见的|(?:会计差错更正|审计意见).{0,15}(?:情形|条件)之一/;
const check = (key, label, status, reason, records = []) => ({ key, label, status, reason, records });
const affirmedAdverse = (pattern, text) => clauses(text).some(clause => pattern.test(clause)
  && !HYPOTHETICAL.test(clause) && !OTHER_ENTITY.test(clause)
  && !/(?:未发生|不存在|未发现|未出现|不涉及|无重大|无需|不属于|并非|不是|不适用)/.test(clause));
function financialAdverseFacts(input) {
  const text = compact(input), facts = [];
  // Reports contain mandatory blank/zero rows, section names and hypothetical
  // governance criteria. A topic mention is not an issuer adverse event.
  if (/认定标准|定性标准|重大缺陷的认定|例如|或者很可能|已经或很可能/.test(text)) return facts;
  for (const clause of clauses(text)) {
    if (FINANCIAL_BOILERPLATE.test(clause) || HYPOTHETICAL.test(clause) || /^(?:若|如|一旦)/.test(clause) || OTHER_ENTITY.test(clause)
      || /(?:未发生|不存在|未发现|未出现|未实施|未进行|未出具|未发表|没有发生|没有进行|没有出具|没有发表|不涉及|无重大|并非|不是|不适用)/.test(clause)) continue;
    if (/(?:存在|发生|已发生).{0,12}(?:债务逾期|逾期债务|债务违约)/.test(clause)) facts.push('debt');
    if (/(?:存在|发生|实施|进行了|已完成).{0,8}重大(?:会计差错|财务报表更正)/.test(clause)) facts.push('correction');
    const statement = clause.replace(/^[一二三四五六七八九十0-9()、.]+/, '');
    const opinion = '(?:(?<!无)保留意见|否定意见|无法表示意见|拒绝表示意见)';
    const actualOpinion = new RegExp(`^(?:本公司|公司|本年度|本报告期)?审计(?:报告)?意见(?:类型)?[：:]?(?:为|是)?${opinion}`);
    const issuedOpinion = new RegExp(`^(?:我们|本公司|公司|本年度|本报告期|审计机构|会计师事务所).{0,45}(?:出具|发表)(?:了|为|的是)?${opinion}`);
    if (!/非无保留|或者|(?:或|与).*重大不确定|(?:的|时)(?:应|需|须)|(?:可能|将|应当|应|需|须|可以|必要时).{0,12}(?:出具|发表)/.test(statement)
      && (actualOpinion.test(statement) || issuedOpinion.test(statement))) facts.push('audit');
    // A named subsidiary/investee or an unowned "其持续经营" cannot be
    // silently treated as the listed issuer's own going-concern conclusion.
    if (/^(?:(?:本公司|公司|发行人|本集团)(?:的)?|本报告期(?:公司)?|报告期内(?:公司)?|本年度(?:公司)?)持续经营能力存在重大不确定性/.test(statement)) facts.push('goingConcern');
    if (/^与持续经营相关的重大不确定性[：:]?[√☑☒]适用/.test(statement) && !/[√☑☒]不适用/.test(statement)) facts.push('goingConcern');
  }
  if (/重大(?:会计差错|财务报表)更正/.test(text) && !OTHER_ENTITY.test(text) && !HYPOTHETICAL.test(text) && !/^(?:详见|参见)/.test(text)) {
    const impacts = [...text.matchAll(new RegExp(`重大(?:会计差错|财务报表)更正[,，]?(?:导致)?(?:影响|调整|调增|调减|增加|减少)[^，,。；]{0,30}?([-+−]?${NUM})(?:万|亿)?元`, 'g'))];
    if (impacts.some(match => Number(match[1].replaceAll(',', '').replace('−', '-')) !== 0
      && !/(?:未发生|不存在|未实施|不涉及|无)[^，,]{0,12}$/.test(text.slice(0, match.index)))) facts.push('correction');
  }
  return [...new Set(facts)];
}
const subjectClauses = (text, subject) => clauses(text).filter(clause => {
  const at = clause.indexOf(subject);
  const prefix = clause.slice(0, at).replace(/(?:主要产品|核心产品|全部产品)$/, '');
  // A named major product does not represent every other product. Only an
  // unqualified "all products" predicate has genuinely issuer-wide scope.
  return at >= 0 && issuerPrefix(prefix) && /^(?:产品|业务|项目)?(?:未|没有|不存在|不涉及|无重大|已|发生|存在|重大|持续|严重|大幅|停止|终止|被禁止|需求|订单|销量|销售量|市场|临床|试验|在|的)/.test(clause.slice(at + subject.length))
    || /^(?:公司|本公司)?全部产品(?:均|皆)?(?:未发生|不存在|未发现|未出现|发生|存在)/.test(clause);
});
const issuerNameCache = new WeakMap();

function periodOf(document) {
  if (validDate(document.reportDate)) return document.reportDate;
  const value = `${document.period || ''} ${document.title || ''}`;
  const year = value.match(/(20\d{2})\s*年?/);
  if (!year) return null;
  if (/半年度|半年报|中期报告/.test(value)) return `${year[1]}-06-30`;
  if (/年度|年报/.test(value)) return `${year[1]}-12-31`;
  return null;
}

function reportAcquisitionIssue(bundle, key, requiredDate, label) {
  const coverage = bundle?.coverage, report = coverage?.[key];
  if (coverage?.noticeIndexComplete === false) return `公告目录获取未完成，暂不能核实${label}的披露情况；不能据此认定公司未披露`;
  if (report?.id && report.reportDate >= requiredDate) {
    const detail = report.reason || coverage?.documentFailures?.find(item => item.id === report.id)?.reason;
    const published = validDate(report.publishedAt) ? `，披露日期 ${report.publishedAt}` : '';
    return `已找到${label.replace('完整', '')}公告${published}，但全文尚未完整取得或未通过校验${detail ? `：${detail}` : ''}；暂不能用作核验依据`;
  }
  if (report?.id && validDate(report.reportDate)) return `当前公告源仅识别到报告期 ${report.reportDate}，尚未取得${label}的可核验正文；不能以旧报告替代，也不代表公司未披露`;
  return `当前公告源未识别出${label}全文条目；不等于公司尚未披露，保留待核验`;
}

function prepare(bundle, now) {
  const symbol = symbolOf(bundle?.symbol), today = cnTime(now).date, issues = [], documents = [];
  const at = now.getTime(), fetchedAt = bundle?.fetchedAt ?? bundle?.checkedAt;
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || fetchedAt > at || at - fetchedAt > 21600000) issues.push('全文资料获取时间缺失、超过6小时或晚于评估时间');
  for (const input of Array.isArray(bundle?.documents) ? bundle.documents : []) {
    if (!input || input.issuerSymbol !== symbol || !validDate(input.publishedAt) || input.publishedAt > today || !safeEvidenceUrl(input.url)
      || input.complete !== true || typeof (input.text ?? input.fullText) !== 'string' || !(input.text ?? input.fullText).trim()
      || !Number.isFinite(input.fetchedAt) || input.fetchedAt > at || input.fetchedAt <= 0) {
      issues.push('存在身份、来源、全文完整性或时点无法验证的文档'); continue;
    }
    const kind = input.kind || input.sourceKind;
    if (!['annual-report', 'semiannual-report', 'notice'].includes(kind)) { issues.push('文档类型无法核验'); continue; }
    const reportDate = kind === 'notice' ? null : periodOf(input);
    if (kind !== 'notice' && (!reportDate || reportDate > input.publishedAt || reportDate > today)) { issues.push('定期报告的期间或披露日期无法核验'); continue; }
    const text = clean(input.text ?? input.fullText);
    // Stored bundles may be evaluated without returning through the source
    // cache. Old PDF completion claims predate mixed scanned-body detection.
    const parsedPdf = /^pdf(?:-|$)/.test(input.format || '') || input.originalFile?.format === 'pdf';
    if (parsedPdf && input.parserVersion !== PARSER_VERSION) {
      issues.push('PDF 解析版本已过期或缺失，须重新核验原件正文完整性'); continue;
    }
    if (parsedPdf && !Array.isArray(input.pageTexts)) { issues.push('PDF 文档缺少可核对的逐页完整性记录'); continue; }
    // Keep paragraph provenance; no parsed claim can be sourced to a title alone.
    let paragraphEntries;
    if (Array.isArray(input.pageTexts)) {
      const pages = input.pageTexts;
      if (pages.length !== input.pages || !pages.length || pages.some((page, index) => page.page !== index + 1
        || typeof page.text !== 'string' || page.complete !== true || !['pdf-text', 'provider-text', 'ocr', 'page-audit'].includes(page.method)
        || (page.method === 'page-audit' && !isVerifiedNonContentPage(page, input))
        || (page.method === 'ocr' && (!Number.isFinite(page.confidence) || page.confidence < 85 || page.confidence > 100 || page.numericEligible !== false)))
        || clean(pages.map(page => page.text).join('\n\n')) !== text) {
        issues.push('文档逐页解析记录与全文不一致或识别可靠性不足'); continue;
      }
      paragraphEntries = pages.flatMap(page => parseParagraphs(page, { nonContent: isVerifiedNonContentPage(page, input), issuerName: compact(input.title?.match(/^([^:：]{2,24})[:：]/)?.[1]) }));
    } else if (input.hasOcrPages || /ocr|^(?:png|jpeg|webp|bmp)$/.test(input.format || '')) {
      issues.push('OCR 文档缺少可核对的逐页解析记录'); continue;
    } else paragraphEntries = parseParagraphs({ text, method: 'provider-text', page: null }, { trusted: true, issuerName: compact(input.title?.match(/^([^:：]{2,24})[:：]/)?.[1]) });
    // OCR is retained for retrieval and completeness, but its confidence score
    // cannot verify a digit, unit, table relationship or missing negation.
    const paragraphs = paragraphEntries.filter(entry => entry.trusted).map(entry => entry.text);
    const document = { ...input, kind, reportDate, text, paragraphs, paragraphEntries };
    document.productTables = reportProductTables(document);
    documents.push(document);
  }
  const reports = documents.filter(document => document.reportDate).sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.publishedAt.localeCompare(a.publishedAt));
  const annual = reports.find(document => document.kind === 'annual-report');
  const year = Number(today.slice(0, 4)), minimumAnnualYear = year - (today.slice(5, 10) < '05-01' ? 2 : 1);
  const annualFresh = !!annual && Number(annual.reportDate.slice(0, 4)) >= minimumAnnualYear && Number(annual.reportDate.slice(0, 4)) < year;
  const annualCoverageIncomplete = bundle?.coverage?.annualReport && !['ready', 'available'].includes(bundle.coverage.annualReport.status);
  if (!annualFresh || annualCoverageIncomplete) issues.push(reportAcquisitionIssue(bundle, 'annualReport', `${minimumAnnualYear}-12-31`, `${minimumAnnualYear}年完整年度报告`));
  const expectedSemiYear = today.slice(5, 10) >= '09-01' ? year : null;
  const semiCoverageIncomplete = bundle?.coverage?.semiannualReport && !['ready', 'available'].includes(bundle.coverage.semiannualReport.status);
  if (expectedSemiYear && (semiCoverageIncomplete || !reports.some(document => document.kind === 'semiannual-report' && document.reportDate === `${expectedSemiYear}-06-30`))) {
    issues.push(reportAcquisitionIssue(bundle, 'semiannualReport', `${expectedSemiYear}-06-30`, `${expectedSemiYear}年完整半年度报告`));
  }
  return { symbol, today, now, documents, reports, annual, annualFresh, minimumAnnualYear, issues, bundle };
}

function evidence(context, document, kind, subject, value, quote, extra = {}) {
  const locations = (document.paragraphEntries || []).filter(entry => entry.trusted && compact(entry.text).includes(compact(quote)))
    .map(({ page, method, confidence, numericEligible, textHash, lineStart, lineEnd }) => ({ page, method, confidence, numericEligible, textHash, lineStart, lineEnd }));
  return { id: `${document.id || document.url}#${kind}:${subject}:${compact(quote).slice(0, 60)}`, symbol: context.symbol,
    kind, subject, value, reviewState: 'automatic', sourceTitle: document.title, url: document.url,
    source: document.source || '公司公告全文', publishedAt: document.publishedAt, period: document.period || document.reportDate || document.publishedAt,
    quote: quote.trim(), checkedAt: context.now.toISOString(), mode: 'automatic', ruleVersion: RULE_VERSION,
    sourceRelation: 'issuer-disclosure', sourceDocumentId: document.id || null, parserVersion: document.parserVersion || null,
    sourceHash: document.sourceHash || document.textHash || null, locations, ...extra };
}

function unresolvedOcr(context) {
  // An OCR-only adverse statement must not disappear merely because a topic
  // keyword list missed it. Ignore only fixed cover labels and issuer names
  // exactly corroborated by the same report's native company-name disclosure.
  const coverLabel = text => /^(?:20\d{2}年?)?(?:年度|半年度|中期)报告(?:封面)?$/.test(compact(text));
  return context.documents.flatMap(document => document.paragraphEntries.filter(entry => {
    if (entry.trusted || entry.nonContent || coverLabel(entry.text)) return false;
    const value = compact(entry.text);
    const issuerName = document.paragraphs.some(text => /^(?:公司名称|中文名称|公司中文名称|公司全称)[：:]/.test(compact(text))
      && compact(text).replace(/^(?:公司名称|中文名称|公司中文名称|公司全称)[：:]/, '') === value);
    return !issuerName;
  })
    .map(entry => ({ id: `${document.id}#ocr:${entry.page}:${compact(entry.text).slice(0, 60)}`, kind: 'ocrPending',
      symbol: context.symbol, sourceTitle: document.title, sourceDocumentId: document.id, url: document.url, publishedAt: document.publishedAt,
      quote: entry.text, mode: 'automatic', reviewState: 'pending', ruleVersion: RULE_VERSION, parserVersion: document.parserVersion,
      sourceHash: document.sourceHash || document.textHash || null,
      locations: [{ page: entry.page, method: entry.method, confidence: entry.confidence, numericEligible: false, textHash: entry.textHash }] })));
}

function latestParagraphs(context) {
  const latest = context.reports[0];
  if (!latest || !context.annualFresh) return [];
  return context.reports.filter(document => document.reportDate === latest.reportDate).flatMap(document => document.paragraphEntries.filter(entry => entry.trusted).map(entry => ({ document, entry, text: entry.text, compact: compact(entry.text) })));
}

function discoverProducts(context) {
  const names = new Set();
  const add = value => {
    const name = productName(value); if (name) names.add(name);
  };
  for (const { document, compact: text } of latestParagraphs(context)) {
    for (const match of text.matchAll(/(?:主要|核心|主营)产品(?:及服务)?(?:包括|为|是|有)[：:]?([^。；,，]{2,150})/g)) {
      if (OTHER_ENTITY.test(text.slice(0, match.index))) continue;
      for (const name of splitProductNames(match[1])) add(name);
    }
    // Product names in a direct issuer description of production/sales are
    // useful even when the report does not use the literal "主要产品为".
    const business = /(?:本公司|公司|其)?主要业务(?:是|为|包括)(?:勘探[、,]?)?(?:开发[、,]?)?(?:生产(?:及|和)?销售|生产及销售|生产和销售|销售)([^。；]{2,100})/.exec(text);
    if (business && !OTHER_ENTITY.test(text.slice(0, business.index))
      && (/^(?:本公司|公司)主要业务/.test(business[0]) || issuerNames(document).some(name => text.startsWith(name)) || /^(?:本公司|公司)/.test(text))) {
      for (const name of splitProductNames(business[1])) add(name);
    }
    const trading = /^(?:本公司|公司)主营的贸易品种包括([^。；]{1,150})/.exec(text);
    if (trading && !OTHER_ENTITY.test(text)) for (const group of trading[1].split(/等(?:有色|黑色)金属产品/)) {
      for (const name of splitProductNames(group.replace(/^[,，](?:以及)?/, ''))) add(name);
    }
    const core = /^(?:其中[,，])?([^,，]{1,30})是(?:本公司|公司)的核心产品$/.exec(text);
    if (core) add(core[1]);
    const mainBusiness = /^(?:本公司|公司)主营业务(?:为|是)([^,，。；]{1,80})/.exec(text);
    if (mainBusiness) for (const name of splitProductNames(mainBusiness[1].replace(/\([^)]*\)/g, ''))) add(name);
    for (const match of text.matchAll(/^(?:本公司|公司|报告期内|本报告期)?([\p{Script=Han}A-Za-z0-9()·-]{2,24}?)(?:产品|业务)(?:实现|的)?(?:营业收入|销售收入|收入|销量|销售量|订单量)/gu)) {
      const name = match[1].replace(/^(?:报告期内|本报告期|本年度|报告期|公司|本公司|其中)+/g, '');
      add(name);
    }
  }
  for (const document of context.reports.filter(document => document.reportDate === context.reports[0]?.reportDate)) {
    for (const fact of document.productTables) add(fact.subject);
  }
  return [...names];
}

function issuerNames(document) {
  const cached = issuerNameCache.get(document); if (cached) return cached;
  const names = new Set(['本公司', '公司']);
  const titleName = document.title?.match(/^([^:：]{2,24})[:：]/)?.[1];
  if (titleName && !/报告|公告|摘要|董事会/.test(titleName)) names.add(compact(titleName));
  for (const text of document.paragraphs) {
    const match = /^(?:公司名称|中文名称|公司中文名称|公司全称|公司简称)[：:]([^，,；。]{2,60})$/.exec(compact(text));
    if (match) names.add(match[1]);
  }
  const result = [...names].sort((a, b) => b.length - a.length);
  issuerNameCache.set(document, result);
  return result;
}

function factualChecks(context, subject) {
  const selected = latestParagraphs(context).filter(item => item.compact.includes(subject));
  const demanded = [], commercial = [], adverseDemand = [], adverseCommercial = [];
  const demandGaps = [];
  for (const document of context.reports.filter(document => document.reportDate === context.reports[0]?.reportDate)) for (const fact of document.productTables.filter(fact => fact.subject === subject)) {
    const extra = { locations: fact.locations, table: fact.table, unit: fact.unit, rowStart: fact.rowStart,
      tableScope: fact.tableScope, periodComparison: fact.period };
    if (fact.revenue > 0) commercial.push(evidence(context, document, 'commercialization', subject, 'revenue', fact.text, { ...extra, amount: fact.revenue }));
    if (fact.growth > 0) demanded.push(evidence(context, document, 'demand', subject, 'supported', fact.text, { ...extra, growthPct: fact.growth }));
    if (fact.growth < 0) adverseDemand.push(evidence(context, document, 'demand', subject, 'unsupported', fact.text, { ...extra, growthPct: fact.growth }));
    if (!Number.isFinite(fact.growth) && typeof fact.validationReason === 'string' && fact.validationReason) demandGaps.push(fact.validationReason);
  }
  for (const item of selected) {
    const parts = clauses(item.compact);
    for (let index = 0; index < parts.length; index++) {
    const clause = parts[index];
    const at = clause.indexOf(subject);
    let prefix = clause.slice(0, at);
    for (const name of issuerNames(item.document)) if (prefix.startsWith(name)) { prefix = `公司${prefix.slice(name.length)}`; break; }
    prefix = prefix.replace(/(?:已实现|实现)$/, '');
    if (at < 0 || !issuerPrefix(prefix) || !currentFact(item.compact, item.document) || !currentFact(clause, item.document)) continue;
    let text = clause.slice(at + subject.length).replace(/^(?:的|产品|业务|项目|报告期内|本报告期|本年度|本期)*/, '');
    const volumeLevel = new RegExp(`^(?:销量|销售量|订单量|订单金额|需求量)(?:为|实现|达到)?${NUM}(?:百万|千万|亿|万|千)?(?:件|台|吨|元|套|只|桶|立方米|立方英尺)$`);
    const nextGrowth = new RegExp(`^(?:同比|较上年同期|比上年同期|比去年同期|比去年)(?:增长|增加|上升|上涨|下降|减少|下滑)${NUM}[%％]$`);
    // The immediate next clause may describe this exact, explicitly owned
    // volume. A changed subject/metric, intervening clause or forecast cannot.
    if (volumeLevel.test(text) && nextGrowth.test(parts[index + 1] || '')) text += parts[index + 1];
    // Only the explicitly named issuer product may own the following fact.
    // Do not borrow another product's or a competitor's metric in the paragraph.
    const growthPrefix = `^(?:销量|销售量|订单量|订单金额|需求量)(?:本期|本年度|报告期内|实现|为|达到|[0-9.,百千万亿件台吨元套只桶立方米英尺])*(?:同比|较上年同期|比上年同期|比去年同期|比去年)`;
    const positiveGrowth = new RegExp(`${growthPrefix}(?:增长|增加|上升|上涨)(${NUM})[%％]`).exec(text);
    const negativeGrowth = new RegExp(`${growthPrefix}(?:下降|减少|下滑)(${NUM})[%％]`).exec(text);
    if (positiveGrowth && Number(positiveGrowth[1].replaceAll(',', '')) > 0 && !FORWARD.test(text) && !UNCERTAIN.test(text)
      && !/(?:未|没有|并非|不是|不曾).{0,10}(?:同比|增长|增加|上升)/.test(text)) demanded.push(evidence(context, item.document, 'demand', subject, 'supported', item.text));
    if (negativeGrowth && Number(negativeGrowth[1].replaceAll(',', '')) > 0 && !FORWARD.test(text)) adverseDemand.push(evidence(context, item.document, 'demand', subject, 'unsupported', item.text));
    const revenue = new RegExp(`^(?:已|已经)?(?:实现|形成)?(?:营业收入|销售收入|收入|业务收入)(?:为|达到|实现|合计|总计)?[：:]?(?:人民币)?(${NUM})(?:百万|千万|万|亿)?元`).exec(text);
    const production = /^(?:已实现|已经实现|已进入|已实现规模|实现规模|已|已经)(?:批量生产|规模量产|量产)/.test(text);
    if (((revenue && Number(revenue[1].replaceAll(',', '')) > 0) || production) && !FORWARD.test(text) && !UNCERTAIN.test(text)
      && !/(?:未|没有|并非|不是|不曾).{0,10}(?:收入|量产|批量生产)/.test(text)) commercial.push(evidence(context, item.document, 'commercialization', subject, revenue ? 'revenue' : 'production', item.text));
    if (/^(?:尚未|未曾|未实现|没有实现|未形成).{0,8}(?:收入|量产)|^(?:仅处于|仍处于)(?:研发|试验|规划)/.test(text)) adverseCommercial.push(evidence(context, item.document, 'commercialization', subject, 'plan', item.text));
    }
  }
  const assess = (kind, positive, negative) => {
    if (positive.length && negative.length) return check(kind, LABELS[kind], 'pending', '同期间存在相反事实陈述，程序不能自行消除冲突', [...positive, ...negative]);
    if (negative.length) return check(kind, LABELS[kind], 'fail', '完整报告有明确不满足该条件的事实陈述', negative);
    return check(kind, LABELS[kind], positive.length ? 'pass' : 'pending', positive.length ? '最新完整报告有对应产品、期间和明确已发生事实' :
      `未定位到对应产品的明确已发生事实；收入增长不直接替代需求增长，计划不替代商业化${kind === 'demand' && demandGaps.length ? `；${[...new Set(demandGaps)].join('；')}` : ''}`, positive);
  };
  return [assess('demand', demanded, adverseDemand), assess('commercialization', commercial, adverseCommercial)];
}

function attributedRankings(context) {
  const records = [];
  if (!context.annualFresh) return records;
  const minimumYear = Number(context.annual.reportDate.slice(0, 4)) - 1;
  for (const document of context.reports) {
    if (document.reportDate < context.annual.reportDate) continue;
    for (const paragraph of document.paragraphs) {
      const text = compact(paragraph);
      // A named institution and identifiable report/statistics are necessary;
      // the issuer's unqualified "industry leader" assertion is not a ranking.
      const source = /(?:根据|据|援引|引用|按照)([^，,:：《》]{2,100}?)(?:发布|公布|出具|统计(?!局)|报告|数据|研究(?=显示|指出|认为))/.exec(text);
      const citedSource = source?.[1].replace(/\((?:以下简称|下称)[^)]*\)/g, '')
        .replace(/^(?:国际|全球)?(?:知名|权威)?(?:市场调研|行业研究)机构/, '');
      if (!source || !/(?:协会|研究院|研究所|咨询|委员会|机构|统计局|[A-Z])/.test(source[1])
        || !citedSource || citedSource.length < 2 || /^(?:协会|研究院|研究所|咨询|委员会|机构|统计局)$/.test(citedSource)
        || /^(?:有关|相关|权威|第三方|某|独立)(?:行业)?(?:机构|协会|研究)/.test(citedSource)) continue;
      const scopedText = text.slice(source.index), parts = clauses(scopedText);
      const aliases = issuerNames(document).map(escape).join('|');
      const canonical = value => value.replace(new RegExp(`^((?:20\\d{2}年|报告期内|其中)*)(?:${aliases})(?=的|在|全球|世界|全国|中国|国内|以|市场份额|市场占有率|市占率|销量|销售量|销售额|营业收入|营收)`), '$1公司');
      let issuerIndex = parts.findIndex(clause => /^(?:20\d{2}年|报告期内|其中)*公司(?:的)?(?:在)?(?:全球|世界|全国|中国(?:市场)?|国内)/.test(canonical(clause)));
      let issuerClause = issuerIndex >= 0 ? canonical(parts[issuerIndex]) : '';
      let issuerScope = /公司(?:的)?(?:在)?(全球|世界|全国|中国(?:市场)?|国内)([^，,:：《》]{2,40}?)(?:市场|行业)/.exec(issuerClause);
      let scopeYear;
      if (!issuerScope) {
        // The citation may name geography/year, then its metric, then the
        // identified issuer. Accept only these adjacent clauses, never a
        // competitor's rank or an unrelated earlier market description.
        issuerIndex = parts.findIndex(clause => new RegExp(`^公司(?:以${NUM}[%％]的)?(?:市场份额|市场占有率|市占率|销量|销售量|销售额|营业收入|营收)(?:排名|位居|位列|居)`).test(canonical(clause)));
        if (issuerIndex >= 0) {
          issuerClause = canonical(parts[issuerIndex]);
          const previous = parts[issuerIndex - 1] || '';
          const scopeClause = /^按(?:零售量|销量|销售量|销售额|营业收入|营收|市场份额)计$/.test(previous) ? parts[issuerIndex - 2] : previous;
          const scoped = /^(?:在)?(20\d{2})年(全球|世界|全国|中国(?:市场)?|国内)([^，,:：《》]{2,40}?)(?:市场|行业)(?:零售格局)?(?:中)?$/.exec(scopeClause || '');
          if (scoped) { scopeYear = [scoped[1], scoped[1]]; issuerScope = [scoped[0], scoped[2], scoped[3]]; }
        }
      }
      const year = /(20\d{2})年/.exec(issuerClause) || scopeYear || /[《〈][^》〉]*?(20\d{2})年/.exec(scopedText);
      const rank = /(?:市场份额|市场占有率|市占率|销量|销售量|销售额|营业收入|营收)(?:排名|位居|位列|居)(?:为)?第([一二三四五六七八九十百千零〇]+|\d{1,4})(?![一二三四五六七八九十百千万零〇0-9])/.exec(issuerClause);
      const geography = issuerScope ? /全球|世界/.test(issuerScope[1]) ? '全球' : '中国' : '';
      const issuerText = issuerClause;
      const metric = /市场份额|市场占有率|市占率/.test(issuerText) ? 'marketShare' : /销量|销售量/.test(issuerText) ? 'volume' : /销售额|营业收入|营收/.test(issuerText) ? 'sales' : '';
      const rankNumber = rank ? rankNumberOf(rank[1]) : null;
      const reportName = /[《〈]([^》〉]{2,100})[》〉]/.exec(scopedText)?.[1] || (year && /统计|数据/.test(scopedText.slice(0, parts[0]?.length || 0)) ? `${citedSource}${year[1]}年统计数据` : '');
      if (!year || !rankNumber || !geography || !metric || !issuerClause || !reportName || FORWARD.test(text) || UNCERTAIN.test(text) || HYPOTHETICAL.test(text)) continue;
      if (/(?:至|到|[-~～—])第?\d+|之间|左右|约第|大约/.test(issuerClause)) continue;
      if (Number(year[1]) > Number(document.publishedAt.slice(0, 4)) || Number(year[1]) < minimumYear) continue;
      if (LIMITED_SCOPE.test(text)) continue;
      if (/(?:并非|不是|未(?:能)?|没有).{0,8}(?:排名|位居|位列|居)|排名.{0,8}(?:并非|不是|未达)/.test(text)) continue;
      const market = issuerScope?.[2];
      if (!market || /(?:公司|协会|报告|排名|第)/.test(market)) continue;
      // Exact product/market association is preserved for later same-product
      // checks. A group ranking is deliberately not inherited by a subsidiary.
      const completeScope = /(?:统计|调查|研究)(?:范围)?覆盖(?:全部|所有)(?:竞争者|竞争企业|市场参与者)|(?:全行业|全部市场参与者)(?:统计|排名)/.test(text);
      records.push(evidence(context, document, 'ranking', market, 'ranked', paragraph, { market, geography, metric, rank: rankNumber,
        statisticYear: Number(year[1]), coverage: completeScope ? 'allCompetitors' : 'unverified', sourceRelation: 'issuer-cites-third-party', citedSource, citedReport: reportName,
        coverageBasis: `${completeScope ? '原文明确覆盖全部竞争者' : '发行人引用未明确全行业统计分母，不能以未出现限制词推定完整覆盖'}；第三方原文未独立取回` }));
    }
  }
  const combinedRankings = collectIndependentRankings(context.bundle, { now: context.now, symbol: context.symbol, minimumYear, existingRankings: records });
  records.splice(0, records.length, ...combinedRankings);
  const latest = new Map();
  for (const record of records) {
    const key = `${record.market}|${record.geography}|${record.metric}`;
    latest.set(key, Math.max(latest.get(key) || 0, record.statisticYear));
  }
  return records.filter(record => record.statisticYear === latest.get(`${record.market}|${record.geography}|${record.metric}`)).map(record => {
    const corrections = context.documents.filter(document => document.publishedAt >= record.publishedAt).flatMap(document => document.paragraphs
      .filter(paragraph => compact(paragraph).includes(record.market) && /排名|位居|位列|行业第一|市场第一/.test(paragraph)
        && /不属实|不准确|不正确|表述有误|撤回|无法核实|并非.{0,8}第|不是.{0,8}第/.test(paragraph))
      .map(paragraph => evidence(context, document, 'rankingConflict', record.market, 'disputed', paragraph)));
    return corrections.length ? { ...record, automaticConflict: true, conflictRecords: [...new Map([...(record.conflictRecords || []), ...corrections].map(item => [item.id, item])).values()] } : record;
  });
}

function postReportCoverage(context) {
  const latest = context.reports[0], coverage = context.bundle.coverage, related = coverage?.relatedNotices;
  const from = related?.windowFromDate || coverage?.fromDate;
  const valid = latest && coverage?.noticeIndexComplete === true && related?.complete === true && related.omitted === 0
    && Number.isInteger(related.selected) && related.selected === related.loaded && validDate(from) && from <= latest.publishedAt
    && coverage.toDate === context.today;
  return valid ? '' : '最新报告披露后的相关公告全文或目录覆盖不完整，不能把未找到事项视为风险已消除';
}

function riskCheck(context, subject) {
  const coverageIssue = postReportCoverage(context), quotes = [], adverse = [], resolved = [], unassigned = [];
  const latest = context.reports[0], notices = context.documents.filter(item => item.kind === 'notice' && latest && item.publishedAt >= latest.publishedAt);
  const explicitClear = value => /(?:未发生|不存在|未发现|未出现).{0,12}(?:重大不利变化|重大不利影响|重大产品风险|重大质量问题)/.test(value)
    && !/无法|不能|尚未完成|未能|并非|不准确|不属实|撤回|如果|假设|预计/.test(value);
  for (const { document, text, compact: value } of latestParagraphs(context)) {
    for (const clause of subjectClauses(value, subject)) {
      if (!currentFact(clause, document)) continue;
      if (explicitClear(clause)) quotes.push(evidence(context, document, 'outlookRisk', subject, 'clear', text));
      if (affirmedAdverse(PRODUCT_ADVERSE, clause)) adverse.push(evidence(context, document, 'outlookRisk', subject, 'adverse', text));
    }
  }
  const referencesAnnual = context.annual && context.reports.filter(document => document.reportDate === latest?.reportDate)
    .some(document => productRiskSections(document).riskSections.some(section => section.referencedAnnualYear === Number(context.annual.reportDate.slice(0, 4))));
  if (referencesAnnual) for (const paragraph of context.annual.paragraphs) {
    if (subjectClauses(compact(paragraph), subject).some(clause => affirmedAdverse(PRODUCT_ADVERSE, clause))) adverse.push(evidence(context, context.annual, 'outlookRisk', subject, 'adverse', paragraph));
  }
  const reviewedDocuments = [...context.reports.filter(document => document.reportDate === latest?.reportDate), ...notices, ...(referencesAnnual ? [context.annual] : [])];
  for (const document of reviewedDocuments) for (const paragraph of document.paragraphs) {
    const value = compact(paragraph);
    for (const clause of clauses(value)) {
      let owned = clause.replace(/^(?:报告期内|本报告期|本年度)[,，]?/, '');
      for (const name of issuerNames(document)) if (owned.startsWith(name)) { owned = `公司${owned.slice(name.length)}`; break; }
      const unspecified = /^公司(?:主要|核心)?(?:产品|业务)(?:发生|存在|需求|订单|销量|销售量|市场份额|市场占有率|持续|严重|大幅|停止|终止|被禁止)/.test(owned)
        || /^公司(?:发生|存在)重大产品质量事故/.test(owned);
      if (unspecified && !/(?:预计|可能|如果|假设|计划)[^，,]{0,30}(?:严重下滑|大幅下降|持续萎缩|发生|重大质量事故|重大产品质量事故)/.test(owned)
        && affirmedAdverse(new RegExp(`${PRODUCT_ADVERSE.source}|(?:发生|存在)重大产品质量事故`), owned)) {
        unassigned.push(evidence(context, document, 'outlookRisk', subject, 'unassignedAdverse', paragraph, { affectedProduct: '未明确', reasonCode: 'adverse-product-unidentified' }));
      }
    }
  }
  for (const document of notices) for (const paragraph of document.paragraphs) {
    const owned = subjectClauses(compact(paragraph), subject);
    if (owned.some(explicitClear)) quotes.push(evidence(context, document, 'outlookRisk', subject, 'clear', paragraph));
    if (owned.some(clause => affirmedAdverse(PRODUCT_ADVERSE, clause))) adverse.push(evidence(context, document, 'outlookRisk', subject, 'adverse', paragraph));
  }
  const eventTypes = text => ['重大质量事故', '严重下滑', '大幅下降', '持续萎缩', '终止生产', '停止生产', '被禁止', '临床试验失败', '试验失败'].filter(event => compact(text).includes(event));
  // A generic subsequent denial cannot erase a known event. A resolution must
  // identify its date/source and product/event, describe completed remediation,
  // and explicitly address the impact; all original evidence remains visible.
  const unresolved = adverse.filter(record => {
    const types = eventTypes(record.quote), date = record.publishedAt;
    const chineseDate = `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
    const explanations = notices.filter(document => document.publishedAt > date).flatMap(document => document.paragraphs.flatMap(paragraph => {
      const value = compact(paragraph), firstClause = clauses(value)[0];
      const named = new RegExp(`^(?:公司|本公司)?针对[^。；]{0,80}${escape(subject)}(?:产品|业务)?(?:发生的)?(?:需求|订单|销量|销售量|市场份额|市场占有率)?(?:${types.map(escape).join('|')})(?:事项)?已(?:完成整改|完成修复|恢复生产|恢复销售)$`).test(firstClause);
      const reference = value.includes(chineseDate) || value.includes(date) || record.sourceDocumentId && value.includes(record.sourceDocumentId);
      const ambiguousEvent = adverse.some(other => other.id !== record.id && other.sourceDocumentId === record.sourceDocumentId && other.publishedAt === date
        && eventTypes(other.quote).join('|') === types.join('|'));
      const revoked = notices.filter(later => later.publishedAt > document.publishedAt).some(later => later.paragraphs.some(text => compact(text).includes(subject)
        && /整改|影响已消除/.test(text) && /不准确|不属实|撤回|尚未完成/.test(text)));
      if (!named || !reference || !types.length || ambiguousEvent || revoked || !types.every(event => value.includes(event)) || FORWARD.test(value) || UNCERTAIN.test(value) || HYPOTHETICAL.test(value)
        || /未完成|尚未|不能|无法|并非|预计|计划|仍存在|未消除|没有消除|不准确|不属实|撤回/.test(value)
        || !/已(?:完成整改|完成修复|恢复生产|恢复销售)/.test(value) || !/(?:相关|该事项|上述事项)(?:的)?重大不利影响已消除/.test(value)) return [];
      return [evidence(context, document, 'outlookRisk', subject, 'resolved', paragraph, { resolvesRecordId: record.id })];
    }));
    resolved.push(...explanations);
    return !explanations.length;
  });
  const scope = { reportId: latest?.id || null, reportDate: latest?.reportDate || null, fromDate: latest?.publishedAt || null,
    toDate: context.today, noticeSelection: context.bundle.coverage?.relatedNotices?.selection || '已收集的相关公告' };
  const limitedScope = '结论仅为所列完整定期报告及覆盖期间内已取得相关公告的披露核验；不代表不存在未披露风险，也不证明产品未来表现';
  const result = (status, reason, records, basis) => ({ ...check('outlookRisk', LABELS.outlookRisk, status, reason, [...new Map(records.map(record => [record.id, record])).values()]), basis, limitedScope, scope });
  if (unresolved.length) return result('fail', '对应产品存在尚无明确匹配后续说明的重大反向事实；普通风险否定不能解除已披露事项', [...adverse, ...resolved], 'explicit-disclosure');
  if (unassigned.length) return { ...result('pending', '公司已披露实际产品重大不利事项，但尚未明确涉及哪些产品；不能据此完成当前产品的风险范围复核', [...unassigned, ...quotes, ...adverse, ...resolved], 'explicit-disclosure'), reasonCode: 'adverse-product-unidentified' };
  if (coverageIssue) return result('pending', coverageIssue, [...quotes, ...adverse, ...resolved], 'explicit-disclosure');
  if (unresolvedOcr(context).length) return result('pending', '所列披露存在尚未可靠核对的扫描正文，不能完成产品风险范围核验', [...quotes, ...adverse, ...resolved], 'explicit-disclosure');
  if (quotes.length) return result('pass', '对应产品有明确风险披露，报告后相关公告覆盖完整；结论仅限列明的披露范围', [...quotes, ...adverse, ...resolved], resolved.length ? 'resolved-event' : 'explicit-disclosure');
  if (resolved.length) return result('pass', '已核对明确引用原事项的同产品后续说明及完整相关公告覆盖；仅认定所列已披露事项有匹配的完成整改及影响消除说明', [...adverse, ...resolved], 'resolved-event');
  const scoped = [];
  for (const document of context.reports.filter(item => item.reportDate === latest?.reportDate)) {
    const sections = productRiskSections(document);
    if (!sections.majorChanges.length) continue;
    for (const section of sections.riskSections) {
      const annualSections = section.referencedAnnualYear && context.annual && Number(context.annual.reportDate.slice(0, 4)) === section.referencedAnnualYear
        ? productRiskSections(context.annual).riskSections.filter(item => item.substantive) : [];
      if (!section.substantive && !annualSections.length) continue;
      const selected = [...sections.majorChanges.map(item => ({ document, item })), { document, item: section }, ...annualSections.map(item => ({ document: context.annual, item }))];
      // Risk chapters are a review basis, not a claim that every risk was
      // classified. Preserve compact source excerpts and full section locations.
      for (const { document: source, item } of selected) {
        const quote = item.excerpt;
        scoped.push(evidence(context, source, 'outlookRisk', subject, 'disclosureScope', quote, { section: item.section,
          locations: item.excerptLocations, sectionLocations: item.locations, excerptTruncated: item.text.length > quote.length, limitedScope }));
      }
    }
  }
  if (scoped.length) return result('pass', '已核对经营重大变化明确披露、实质风险章节及报告后相关公告；仅完成披露范围复核，不作无风险判断', [...scoped, ...adverse, ...resolved], resolved.length ? 'resolved-event' : 'disclosure-scope-review');
  return result('pending', '缺少对应产品明确风险披露，或缺少可定位的经营重大变化说明及完整实质风险章节；关键词未命中不能代替核验', [...adverse, ...resolved], 'explicit-disclosure');
}

function advantageCheck(context, subject, rankings) {
  const qualified = rankings.filter(record => (record.market === subject || record.market === `${subject}产品`) && record.coverage === 'allCompetitors');
  const rankConflict = qualified.some(record => record.automaticConflict || rankings.some(other => other.market === record.market && other.statisticYear === record.statisticYear && other.metric === record.metric && other.geography === record.geography && other.rank !== record.rank));
  const comparisons = context.reports.filter(document => document.reportDate === context.reports[0]?.reportDate).flatMap(document =>
    quantifiedProductComparisons(document, subject, issuerNames(document)).map(({ text, ...fact }) => evidence(context, document, 'advantage', subject, fact.automaticConflict ? 'comparisonDisputed' : fact.supportsAdvantage ? 'quantifiedAdvantage' : 'comparisonUnsupported', text, fact)));
  const comparisonConflict = comparisons.some(record => record.automaticConflict || comparisons.some(other => record.metric === other.metric && record.comparisonPeriod === other.comparisonPeriod
    && record.comparisonScope === other.comparisonScope && (record.ownValue !== other.ownValue || record.benchmarkValue !== other.benchmarkValue)));
  const corrections = comparisons.flatMap(record => context.documents.filter(document => document.publishedAt >= record.publishedAt).flatMap(document => document.paragraphs
    .filter(paragraph => compact(paragraph).includes(subject) && compact(paragraph).includes(record.metric) && /不属实|不准确|表述有误|撤回|无法核实/.test(paragraph))
    .map(paragraph => evidence(context, document, 'advantage', subject, 'comparisonDisputed', paragraph))));
  const records = [...qualified, ...comparisons, ...corrections], conflict = rankConflict || comparisonConflict || corrections.length;
  const rankPass = qualified.some(record => record.rank <= 3), comparisonPass = comparisons.some(record => record.supportsAdvantage);
  return check('advantage', LABELS.advantage, conflict ? 'pending' : rankPass || comparisonPass ? 'pass' : 'pending', conflict
    ? '同产品同行业比较事实存在冲突或已被更正，不能自动认定竞争优势'
    : rankPass ? '对应产品具可追溯第三方行业比较事实支持其市场地位优势；来源关系详见各条证据'
      : comparisonPass ? '对应产品有具名第三方来源的同期间、同产品和同口径量化比较支持单项优势；不等同于综合领先'
        : '尚缺同产品可追溯的行业排名或同期间同口径量化比较；普通毛利、专利数量及宣传不能单独证明竞争优势', records);
}

function financialCheck(context) {
  if (!context.annualFresh) return check('financialReview', LABELS.financialReview, 'pending', `缺少最新适用完整年报（至少${context.minimumAnnualYear}年度），不能以量化指标通过替代专项复核`);
  const items = latestParagraphs(context), annual = context.annual;
  const required = [], records = [], adverse = [];
  const industries = [...items, ...annual.paragraphs.map(text => ({ document: annual, text, compact: compact(text) }))]
    .map(item => ({ ...item, classification: industryClassification(item.text) }));
  const industry = industries.find(item => item.classification?.applicable === true);
  const financeIndustry = industries.find(item => item.classification?.applicable === false);
  if (financeIndustry) return check('financialReview', LABELS.financialReview, 'fail', '公开报告显示属于金融企业，当前普通非金融企业量化模板不适用；此结论不等于公司财务恶化', [evidence(context, financeIndustry.document, 'financialReview', '公司财务', 'industryInapplicable', financeIndustry.text)]);
  if (!industry) required.push('普通非金融企业行业适用性');
  else records.push(evidence(context, industry.document, 'financialReview', '公司财务', 'industryApplicable', industry.text, industry.classification));
  const auditType = annual.paragraphs.map(text => /审计意见(?:类型)?[：:]?([^。；\n]{0,60}(?:无保留意见|保留意见|否定意见|无法表示意见))/.exec(compact(text))).find(Boolean);
  const conventional = annual.paragraphs.map((text, index) => {
    // Responsibility/illustrative boilerplate may repeat this exact wording.
    // Accept the opinion sentence only under an actual opinion section.
    const preceding = annual.paragraphs.slice(Math.max(0, index - 4), index + 1).map(compact);
    const heading = preceding.findLastIndex(value => /^(?:[一二三四五六七八九十0-9]+[、.])?审计意见(?:[：:]|$)/.test(value));
    if (heading < 0 || preceding.slice(heading).some(value => /管理层.*责任|注册会计师.*责任|审计责任|例如|假设|如果/.test(value))) return null;
    return /^我们认为.{0,120}在所有重大方面.{0,50}企业会计准则.{0,80}公允反映/.exec(compact(text));
  }).find(Boolean);
  const auditAdverse = annual.paragraphs.find(text => financialAdverseFacts(text).some(kind => ['audit', 'goingConcern'].includes(kind)));
  if (auditAdverse) adverse.push(evidence(context, annual, 'financialReview', '公司财务', 'adverse', auditAdverse));
  else if ((auditType && /无保留意见/.test(auditType[1])) || conventional) records.push(evidence(context, annual, 'financialReview', '公司财务', 'auditClear', auditType?.[0] || conventional[0]));
  else required.push('明确审计意见与持续经营披露');
  const debt = items.find(item => !OTHER_ENTITY.test(item.compact) && !HYPOTHETICAL.test(item.compact)
    && (checkboxSelection(item.compact) !== null ? checkboxSelection(item.compact) === 'notApplicable' && /^(?:[一二三四五六七八九十0-9、.()]+)?(?:公司|本公司)?(?:债务逾期|逾期债务|债务违约)(?:情况|的说明)?/.test(item.compact)
      : /^(?:本公司|公司|本集团|本报告期|报告期内)*(?:不存在|未发生|没有)(?:任何)?(?:债务逾期|逾期债务|债务违约|逾期未偿还的?债务)(?:情况)?$|^(?:公司|本公司)?(?:债务逾期|逾期债务|债务违约)(?:情况)?[：:]?(?:无|不适用)$/.test(item.compact)));
  const debtReviews = [...new Set(items.map(item => item.document))].map(document => ({ document, review: debtCoverage(document) }));
  const coveredDebt = debtReviews.find(item => item.review.complete);
  const conflictingDebt = debtReviews.flatMap(item => item.review.categories.flatMap(category => category.unresolved));
  for (const fact of conflictingDebt) adverse.push(evidence(context, fact.document, 'financialReview', '公司财务', 'adverse', fact.text, { locations: fact.locations }));
  if (debt) records.push(evidence(context, debt.document, 'financialReview', '公司财务', 'debtClear', debt.text));
  else {
    for (const { review } of debtReviews) for (const record of review.records) records.push(evidence(context, record.document, 'debtScope', record.debtLabel, 'reviewed', record.text, { debtCategory: record.debtCategory, locations: record.locations }));
    if (coveredDebt) records.push(evidence(context, coveredDebt.document, 'financialReview', '公司财务', 'debtClear', coveredDebt.review.records.map(record => record.text).join('\n'),
      { reviewScope: '最新合并报告明确披露的借款、债券、票据、租赁及应付款项目；每项须无余额或明确逾期与违约披露', locations: coveredDebt.review.records.flatMap(record => record.locations), debtCoverage: coveredDebt.review.categories.map(({ key, complete }) => ({ key, complete })) }));
    else required.push(`偿债及逾期事项明确披露${debtReviews.length ? `（${debtReviews[0].review.missing.join('、')}）` : ''}`);
  }
  const correctionSectionsFound = [...new Set(items.map(item => item.document))].flatMap(document => correctionSections(document));
  const correction = items.find(item => !OTHER_ENTITY.test(item.compact) && !HYPOTHETICAL.test(item.compact)
    && (checkboxSelection(item.compact) !== null ? checkboxSelection(item.compact) === 'notApplicable'
      && /^(?:[一二三四五六七八九十0-9、.()]+)?(?:董事会关于报告期会计政策、会计估计变更或)?(?:前期会计差错更正|重大会计差错更正|重大会计更正|重大财务更正)(?:情况|的说明)?/.test(item.compact)
      : /^(?:本公司|公司|本报告期|报告期内)*(?:不存在|未发生|没有)(?:重大|前期)?(?:会计差错(?:更正)?|会计更正|财务更正)(?:事项|情况)?$|^(?:前期会计差错更正|重大会计差错更正|重大会计更正|重大财务更正)(?:情况)?[：:]?(?:无|不适用)$/.test(item.compact)));
  const structuredCorrection = correctionSectionsFound.find(section => section.clear);
  if ((correction || structuredCorrection) && !correctionSectionsFound.some(section => !section.clear)) {
    const fact = correction || structuredCorrection;
    records.push(evidence(context, fact.document, 'financialReview', '公司财务', 'correctionClear', fact.text, fact.locations ? { locations: fact.locations } : {}));
  } else required.push(correctionSectionsFound.some(section => !section.clear) ? '会计更正存在适用或不明选项，须核实影响及处理情况' : '重大会计更正事项明确披露');
  const latest = context.reports[0];
  const recent = context.documents.filter(document => document.kind === 'notice' && document.publishedAt >= latest.publishedAt);
  for (const document of [...new Set([...items.map(item => item.document), ...recent])]) for (const paragraph of document.paragraphs) {
    const text = compact(paragraph);
    if (financialAdverseFacts(text).length) adverse.push(evidence(context, document, 'financialReview', '公司财务', 'adverse', paragraph));
  }
  if (adverse.length) return check('financialReview', LABELS.financialReview, 'fail', '审计、持续经营或后续公告出现明确财务异常，需要适用的专项处理', [...records, ...adverse]);
  const coverageIssue = postReportCoverage(context); if (coverageIssue) required.push(coverageIssue);
  return check('financialReview', LABELS.financialReview, required.length ? 'pending' : 'pass', required.length ? `尚缺：${required.join('；')}。量化财务达标不替代这些核验` : '行业适用性、年报审计意见、最新报告的逾期/更正披露及后续相关公告均已按原文程序核验', records);
}

function leadershipCheck(context, rankings, query) {
  const checks = [], rows = [], rules = industryRulesForQuery(query);
  for (const record of rankings) {
    const latest = latestParagraphs(context);
    const related = latest.filter(item => item.compact.includes(record.market));
    const main = related.find(item => !OTHER_ENTITY.test(item.compact) && !FORWARD.test(item.compact)
      && new RegExp(`^(?:本公司|公司)?(?:主营业务|主要业务|主行业|所属行业|主要产品).{0,15}${escape(record.market)}|^(?:本公司|公司)?${escape(record.market)}(?:为|是)(?:主营业务|主行业)`).test(item.compact));
    const shares = related.filter(item => currentFact(item.compact, item.document) && !OTHER_ENTITY.test(item.compact) && !FORWARD.test(item.compact))
      .map(item => ({ item, match: new RegExp(`^(?:本公司|公司|报告期内|本报告期|20\\d{2}年)*${escape(record.market)}(?:业务|产品|的)*(?:营收|收入|营业收入)占(?:公司|本公司)?(?:营业)?(?:总)?收入(?:的比例)?(?:为|达|比例为|比例达)?(-?${NUM})[%％]`).exec(item.compact) })).filter(item => item.match);
    const tableShares = context.reports.filter(document => document.reportDate === context.reports[0]?.reportDate)
      .flatMap(document => document.productTables).filter(fact => fact.subject === record.market && Number.isFinite(fact.revenueShare));
    const shareRecords = [
      ...shares.map(share => evidence(context, share.item.document, 'segmentRevenue', record.market, Number(share.match[1].replaceAll(',', '')), share.item.text)),
      ...tableShares.map(fact => evidence(context, fact.document, 'segmentRevenue', record.market, fact.revenueShare, fact.text,
        { locations: [...fact.locations, fact.totalLocation].filter(Boolean), amount: fact.revenue, totalRevenue: fact.totalRevenue, unit: fact.unit, derivation: '同页本期产品营业收入 / 同单位公司本期营业收入' }))
    ];
    const shareValues = [...new Set(shareRecords.map(item => item.value))].sort((a, b) => a - b);
    const shareConflict = shareValues.length > 1 && shareValues.at(-1) - shareValues[0] > 1e-6;
    const shareValue = shareConflict ? null : shareValues[0] ?? null;
    const conflicting = record.automaticConflict || rankings.some(other => other.market === record.market && other.geography === record.geography && other.metric === record.metric && other.statisticYear === record.statisticYear && other.rank !== record.rank);
    const scopeUnverified = record.coverage !== 'allCompetitors';
    const mainStatus = conflicting || scopeUnverified ? 'pending' : main ? record.rank <= rules.mainRankMax ? 'pass' : 'fail' : 'pending';
    const segmentStatus = conflicting || scopeUnverified || shareConflict ? 'pending' : shareValue === null || shareValue < 0 || shareValue > 100 ? 'pending' : record.rank <= rules.segmentRankMax && shareValue >= rules.minSegmentRevenuePct ? 'pass' : 'fail';
    const status = rules.scope === 'main' ? mainStatus : rules.scope === 'segment' ? segmentStatus : or([mainStatus, segmentStatus]);
    const supporting = [record, ...(record.conflictRecords || []), ...(main ? [evidence(context, main.document, 'mainBusiness', record.market, 'identified', main.text)] : []),
      ...shareRecords];
    const relation = record.sourceRelation === 'independent-third-party' ? '已独立取得第三方原文' : '公司披露引用第三方，未独立取回第三方全文';
    const metricLabel = { marketShare: '市场份额', volume: '销量', sales: '销售额' }[record.metric] || '指标';
    const reason = `${record.statisticYear}年${record.geography}${record.market}，${metricLabel}第${record.rank}；${conflicting ? '同口径排名冲突' : main ? '最新报告可对应主营业务' : '主营行业对应关系不足'}；${shareConflict ? `同期细分收入占比冲突（${shareValues.join('%、')}%），需核对原文` : shareValue !== null ? `细分收入占比${Number(shareValue.toFixed(2))}%` : '细分收入占比未定位'}${scopeUnverified ? '；全行业统计分母未核实' : ''}；${relation}`;
    checks.push(check('leadershipScope', LABELS.leadership, status, reason, supporting));
    rows.push({ statisticYear: record.statisticYear, market: record.market, geography: record.geography, metric: record.metric, rank: record.rank,
      revenueSharePct: shareValue, revenueShareValues: shareValues, sourceRelation: record.sourceRelation, coverage: record.coverage,
      status, reason, mainStatus, segmentStatus, records: supporting });
  }
  const status = or(checks.map(item => item.status));
  const selected = checks.filter(item => item.status === status);
  const industryIssues = (context.bundle.industryCoverage?.issues || []).filter(issue => typeof issue === 'string' && issue.trim()).slice(0, 6);
  const reason = selected.map(item => item.reason).join('；') || `缺少可追溯的全国/全球、全行业、明确年份和指标排名；自称龙头、集团排名或仅上市公司排名不能替代${industryIssues.length ? `；行业原文：${industryIssues.join('；')}` : ''}`;
  return { ...check(query.industry ? 'industry' : 'leadership', query.industry ? describeIndustryRules(query.industry) : LABELS.leadership, status, reason, selected.flatMap(item => item.records)),
    ...(query.industry ? { industryReview: { version: 1, scope: rules.scope, checkedAt: context.now.toISOString(), status, reason, rows } } : {}) };
}

function sourceValiditySnapshot(context, checks, query) {
  // Publication keeps facts and provenance, not complete report bodies. Keep
  // the original clocks so a later checkedAt cannot renew the collection.
  const records = checks.flatMap(item => item.records || []);
  const referenced = document => document && records.some(record => (document.kind !== 'industry-report' || record.sourceRelation === 'independent-third-party')
    && (record.sourceDocumentId && record.sourceDocumentId === document.id || record.url && record.url === document.url));
  const requiredReports = context.reports.filter(document => document === context.annual || document.reportDate === context.reports[0]?.reportDate);
  const documents = [...new Set([...requiredReports, ...context.documents.filter(referenced),
    ...(context.bundle?.industryDocuments || []).filter(referenced)])];
  const year = Number(context.today.slice(0, 4));
  return { version: 1, symbol: context.symbol, fetchedAt: context.bundle?.fetchedAt ?? context.bundle?.checkedAt,
    evaluatedAt: context.now.getTime(), minimumAnnualReportDate: `${context.minimumAnnualYear}-12-31`,
    requiredSemiannualReportDate: context.today.slice(5) >= '09-01' ? `${year}-06-30` : null,
    requiresNoticeCoverage: !!query?.conditions.some(condition => ['financialReview', 'productOutlook', 'outlookRisk'].includes(condition)),
    coverage: { annualReportStatus: context.bundle?.coverage?.annualReport?.status ?? null,
      semiannualReportStatus: context.bundle?.coverage?.semiannualReport?.status ?? null,
      noticeIndexComplete: context.bundle?.coverage?.noticeIndexComplete ?? null, toDate: context.bundle?.coverage?.toDate ?? null },
    documents: documents.map(document => ({ id: document.id || null, issuerSymbol: document.issuerSymbol,
      kind: document.kind, publishedAt: document.publishedAt, reportDate: document.reportDate || null,
      fetchedAt: document.fetchedAt, url: document.url, sourceHash: document.sourceHash || document.textHash || null,
      parsedPdf: /^pdf(?:-|$)/.test(document.format || '') || document.originalFile?.format === 'pdf' || typeof document.originalBase64 === 'string',
      parserVersion: document.parserVersion || null })) };
}

function refreshCompanyEvidence(evaluation, inputNow = new Date()) {
  const now = new Date(inputNow), at = now.getTime();
  if (!Number.isFinite(at)) throw Error('证据复核日期不正确');
  // This is a publication gate, not a re-evaluator or an archive migration.
  // Existing unresolved/negative findings cannot be revived by time alone.
  if (evaluation?.status !== 'pass' || evaluation.mode !== 'automatic' || !evaluation.query) return evaluation;
  const snapshot = evaluation.sourceValidity, today = cnTime(now).date, issues = [];
  if (!snapshot || snapshot.version !== 1 || snapshot.symbol !== evaluation.symbol
    || !Array.isArray(snapshot.documents) || !snapshot.coverage) issues.push('缺少可复核的原始资料时效快照，需要重新获取并核验');
  else {
    if (!Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt <= 0 || snapshot.fetchedAt > at || at - snapshot.fetchedAt > 21600000
      || !Number.isFinite(snapshot.evaluatedAt) || snapshot.evaluatedAt < snapshot.fetchedAt || snapshot.evaluatedAt > at) {
      issues.push('全文资料原始获取时间缺失、超过6小时或晚于复核时间，需要重新获取并核验');
    }
    for (const document of snapshot.documents) {
      if (!document || document.issuerSymbol !== evaluation.symbol || !safeEvidenceUrl(document.url)
        || !validDate(document.publishedAt) || document.publishedAt > today
        || !Number.isFinite(document.fetchedAt) || document.fetchedAt <= 0 || document.fetchedAt > at || document.fetchedAt > snapshot.evaluatedAt
        || document.parsedPdf && document.parserVersion !== PARSER_VERSION) {
        issues.push('参与结论的原始文档身份、解析版本或时点无法复核'); continue;
      }
      // An unchanged issuer report is reusable after its index is refreshed;
      // independent sources retain their own acquisition TTL.
      if (document.kind === 'industry-report' && at - document.fetchedAt > 21600000) issues.push('参与行业结论的第三方原文原始获取时间超过6小时，需要重新获取并核验');
      if (['annual-report', 'semiannual-report'].includes(document.kind)
        && (!validDate(document.reportDate) || document.reportDate > document.publishedAt || document.reportDate > today)) issues.push('参与结论的定期报告期间无法复核');
    }
    const year = Number(today.slice(0, 4)), minimumAnnualYear = year - (today.slice(5) < '05-01' ? 2 : 1);
    const annual = snapshot.documents.filter(document => document?.kind === 'annual-report')
      .some(document => validDate(document.reportDate) && document.reportDate >= `${minimumAnnualYear}-12-31` && Number(document.reportDate.slice(0, 4)) < year);
    if (!annual || snapshot.coverage.annualReportStatus !== null && !['ready', 'available'].includes(snapshot.coverage.annualReportStatus)) {
      issues.push(`发布时至少需要${minimumAnnualYear}年完整年度报告，原结论的报告期间不足`);
    }
    if (today.slice(5) >= '09-01' && (!snapshot.documents.some(document => document?.kind === 'semiannual-report' && document.reportDate === `${year}-06-30`)
      || snapshot.coverage.semiannualReportStatus !== null && !['ready', 'available'].includes(snapshot.coverage.semiannualReportStatus))) {
      issues.push(`发布时需要${year}年完整半年度报告，原结论的报告期间不足`);
    }
    if (snapshot.requiresNoticeCoverage && (snapshot.coverage.noticeIndexComplete !== true || snapshot.coverage.toDate !== today)) {
      issues.push('发布时相关公告目录尚未覆盖当日，需要重新核验后续披露');
    }
  }
  if (!issues.length) return evaluation;
  const result = structuredClone(evaluation), reason = [...new Set(issues)].join('；');
  result.status = 'pending'; result.refreshedAt = now.toISOString();
  const pendingReview = review => ({ ...review, status: 'pending', reason, previousStatus: review.status, previousReason: review.reason,
    rows: (review.rows || []).map(row => ({ ...row, status: 'pending', mainStatus: 'pending', segmentStatus: 'pending', reason,
      previousStatus: row.status, previousReason: row.reason })) });
  result.checks = (result.checks || []).map(item => ({ ...item, status: 'pending', previousStatus: item.status, previousReason: item.reason,
    reason: `${reason}；原核验：${item.reason}`, ...(item.industryReview ? { industryReview: pendingReview(item.industryReview) } : {}) }));
  result.checks.unshift(check('sourceValidity', '发布时来源与时点核验', 'pending', reason));
  result.reasons = [...new Set([...(result.reasons || []), reason])];
  if (result.industryReview) result.industryReview = pendingReview(result.industryReview);
  return result;
}

function evaluateCompanyEvidence(bundle, inputQuery, inputNow = new Date()) {
  const query = validateEvidenceQuery(inputQuery?.evidence || inputQuery), now = new Date(inputNow);
  if (!Number.isFinite(now.getTime())) throw Error('证据评估日期不正确');
  const context = prepare(bundle, now), { symbol } = context, checks = []; let industryReview;
  const finish = () => ({ symbol, status: and(checks.map(item => item.status)), checks, checkedAt: now.toISOString(), query: query ? structuredClone(query) : null,
    records: [...new Map(checks.flatMap(item => item.records).map(record => [record.id, record])).values()],
    reasons: [...new Set([
      ...(Array.isArray(bundle?.errors) ? bundle.errors : []).filter(reason => typeof reason === 'string' && reason.trim()).slice(0, 20).map(reason => `资料获取：${reason.slice(0, 2000)}`),
      ...(Array.isArray(bundle?.industryCoverage?.issues) ? bundle.industryCoverage.issues : []).filter(reason => typeof reason === 'string' && reason.trim()).slice(0, 8).map(reason => `行业原文：${reason.slice(0, 2000)}`),
    ])],
    mode: 'automatic', ruleVersion: RULE_VERSION, sourceValidity: sourceValiditySnapshot(context, checks, query), ...(industryReview ? { industryReview } : {}) });
  if (!query) return finish();
  if (context.issues.length) {
    checks.push(check('sourceIntegrity', '全文来源与时点核验', 'pending', [...new Set(context.issues)].join('；')));
    if (query.industry) industryReview = { version: 1, scope: query.industry.scope, checkedAt: now.toISOString(), status: 'pending', reason: [...new Set(context.issues)].join('；'), rows: [] };
    // An invalid latest report must not silently fall back to older facts and
    // produce a destructive definite failure or a positive eligibility claim.
    return finish();
  }
  const ocrPending = unresolvedOcr(context);
  if (ocrPending.length) checks.push(check('ocrReview', '扫描页关键内容核验', 'pending', '扫描页存在尚未可靠核对的正文；OCR 置信度不等于事实核验，数字、单位、表格和关键否定词尚未交叉核对，保留待核验', ocrPending));
  const rankings = attributedRankings(context), products = discoverProducts(context);
  const productConditions = query.conditions.filter(condition => condition !== 'financialReview');
  if (productConditions.length) {
    const productChecks = products.map(subject => {
      const parts = factualChecks(context, subject);
      parts.push(advantageCheck(context, subject, rankings));
      parts.push(riskCheck(context, subject));
      const wanted = new Set(productConditions.flatMap(condition => condition === 'productOutlook' ? ['demand', 'commercialization', 'advantage', 'outlookRisk'] : [condition]));
      const selected = parts.filter(part => wanted.has(part.key));
      return { subject, status: and(selected.map(part => part.status)), parts: selected };
    });
    const status = or(productChecks.map(item => item.status));
    // Display the best-supported single product, while keeping every candidate
    // available for diagnostics. This selection never combines facts belonging
    // to different products and does not change the AND/OR eligibility rule.
    const chosen = productChecks.filter(item => item.status === status).sort((left, right) => right.parts.filter(part => part.status === 'pass').length - left.parts.filter(part => part.status === 'pass').length)[0];
    checks.push({ ...check(productConditions.includes('productOutlook') ? 'productOutlook' : 'sameProduct', productConditions.includes('productOutlook') ? EVIDENCE_CONDITIONS.productOutlook : '所有产品条件对应同一产品', status,
      chosen ? `产品「${chosen.subject}」：${chosen.parts.map(part => `${part.label}：${part.reason}`).join('；')}` : '最新完整报告中未可靠识别同一产品及其事实证据；不跨产品拼接结论', chosen ? chosen.parts.flatMap(part => part.records) : []),
      productIdentification: { status: products.length ? 'identified' : 'unidentified', count: products.length,
        reason: products.length ? `已从最新完整报告定位${products.length}个产品主体；各项证据按同一产品分别核验` : '最新完整报告尚未可靠识别产品主体；不能据此认定公司没有产品或产品前景差' },
      productCandidates: productChecks.map(({ subject, status: candidateStatus, parts }) => ({ subject, status: candidateStatus, parts })) });
  }
  if (query.conditions.includes('financialReview')) checks.push(financialCheck(context));
  if (query.leadership || query.industry) {
    const industry = leadershipCheck(context, rankings, query);
    industryReview = industry.industryReview;
    if (industryReview && ocrPending.length) {
      industryReview.status = 'pending'; industryReview.reason = '扫描页关键内容尚未可靠核验，已提取的原始行业指标仅供观察';
      industryReview.rows = industryReview.rows.map(row => ({ ...row, status: 'pending', reason: industryReview.reason, mainStatus: 'pending', segmentStatus: 'pending' }));
      industry.status = 'pending'; industry.reason = industryReview.reason;
    }
    checks.push(industry);
  }
  return finish();
}

// The raw-metric route retains identified adverse facts, without requiring all
// of the legacy product-outlook evidence categories to be present.
function knownProductRiskSignals(bundle, subjects = [], inputNow = new Date()) {
  const context = prepare(bundle, new Date(inputNow));
  const candidates = [...new Set([...subjects, ...discoverProducts(context)])];
  // A product need not have a numeric table row for its disclosed adverse
  // event to matter. Also retain company-level events with unidentified scope.
  if (!candidates.length) candidates.push('未明确产品');
  return candidates.flatMap(subject => {
    const result = riskCheck(context, subject);
    return result.status === 'fail' || result.reasonCode === 'adverse-product-unidentified'
      ? [{ ...result, subject }] : [];
  });
}

module.exports = { evaluateCompanyEvidence, refreshCompanyEvidence, knownProductRiskSignals, COMPANY_EVIDENCE_RULE_VERSION: RULE_VERSION };
