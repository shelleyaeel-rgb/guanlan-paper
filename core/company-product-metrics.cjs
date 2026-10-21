'use strict';
const { createHash } = require('node:crypto');
const { cnTime } = require('./common.cjs');
const { PARSER_VERSION, isVerifiedNonContentPage } = require('./company-document-parser.cjs');
const { reportProductObservations } = require('./company-evidence-structured.cjs');

const VERSION = '1';
const AMOUNTS = new Set(['currentRevenue', 'previousRevenue', 'currentCost', 'previousCost', 'currentTotalRevenue', 'previousTotalRevenue']);
const RAW_FIELDS = [...AMOUNTS, 'currentSalesVolume', 'previousSalesVolume'];
const DERIVED_FIELDS = ['revenueGrowthPct', 'revenueSharePct', 'salesGrowthPct', 'grossMarginPct', 'previousGrossMarginPct', 'grossMarginChangePp'];
const MONEY = { 元: 1, 万元: 10000, 百万元: 1000000, 亿元: 100000000 };
const NUMBER = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const compact = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '');
const currencyField = field => AMOUNTS.has(field) || /(?:RevenueChange|OrderAmount)$/.test(field);
const percentageField = field => /Pct$/.test(field) || field === 'reportedGrossMarginChange';
const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
const hash = value => createHash('sha256').update(value).digest('hex');
const missing = (unit = null, reasonCode = 'not-extracted', reason = '尚未从支持的可靠原文中提取到此字段；不代表公司未披露') => ({
  value: null, unit, status: 'not-extracted', verification: null, usable: false, reasonCode, reason,
  rawValue: null, rawUnit: null, reportedValue: null, formula: null, sourceRefs: []
});

function sourceRef(observation) {
  const document = observation.document || {}, text = String(observation.text || '');
  return { sourceDocumentId: document.id || null, title: document.title || null, url: document.url || null,
    publishedAt: document.publishedAt || null, reportDate: document.reportDate || null,
    locations: observation.locations || [], table: observation.table || null, rowStart: observation.rowStart || null,
    tableScope: observation.tableScope || null, accountingScope: observation.accountingScope || null,
    quote: text.length <= 1600 ? text : `${text.slice(0, 500)}\n[…]\n${text.slice(-1000)}`, excerptTruncated: text.length > 1600 };
}

function parseCell(rawValue, field, unit, percentageHeader, source, percentagePointHeader = false) {
  const raw = compact(rawValue), percent = raw.includes('%'), negative = /^\(.*\)$/.test(raw);
  const numeric = (negative ? `-${raw.slice(1, -1)}` : raw).replace(/%$/, '');
  const marginChange = field === 'reportedGrossMarginChange';
  const disclosedUnit = marginChange ? percent || percentageHeader ? '%' : percentagePointHeader ? '百分点' : null : null;
  const result = { field, rawValue: rawValue ?? null, rawUnit: marginChange ? disclosedUnit : percentageField(field) && (percent || percentageHeader) ? '%' : unit,
    value: null, unit: marginChange ? disclosedUnit : currencyField(field) ? '元' : percentageField(field) ? '%' : unit, sourceRefs: [source], usable: false };
  if (!raw || /^(?:[-—–]+|N\/?A|不适用)$/i.test(raw)) return { ...result, reasonCode: 'reported-placeholder', reason: '原表该位置为空或占位符，未按零处理' };
  if (!NUMBER.test(numeric)) return { ...result, reasonCode: 'cell-not-parsed', reason: '原文单元格无法可靠解析为数值' };
  if (!percentageField(field) && percent) return { ...result, reasonCode: 'cell-unit-mismatch', reason: '金额或数量位置出现百分比，未当作金额或数量使用' };
  if (marginChange && percentagePointHeader && (percent || percentageHeader)) return { ...result, reasonCode: 'cell-unit-mismatch', reason: '毛利率增减单元格百分比与表头百分点单位冲突，未换算或任选其一' };
  if (percentageField(field) && !percent && !percentageHeader && !(marginChange && percentagePointHeader)) return { ...result, reasonCode: 'percentage-unit-unverified', reason: '原文增减值未明确比例单位，未据此推断同比或百分点变化' };
  if (currencyField(field) && !MONEY[unit]) return { ...result, reasonCode: 'currency-unit-unverified', reason: '金额单位尚未核实' };
  if (!currencyField(field) && !percentageField(field) && (!unit || MONEY[unit])) return { ...result, reasonCode: 'volume-unit-unverified', reason: '数量单位尚未核实或误用了金额单位' };
  const value = Number(numeric.replaceAll(',', '')) * (currencyField(field) ? MONEY[unit] : 1);
  if (!Number.isFinite(value)) return { ...result, reasonCode: 'nonfinite-value', reason: '数值超出可计算范围' };
  return { ...result, value, usable: true, reasonCode: null, reason: null };
}

function splitCells(text, expected) {
  const value = String(text || '').trim().normalize('NFKC'), cells = value.split(/\s+/);
  // A standalone dash occupying one of the expected columns is missing data.
  // Rejoin a spaced minus only when the raw token count otherwise has extras.
  return cells.length === expected ? cells : value.replace(/-\s+(?=\d)/g, '-').split(/\s+/);
}

function readObservation(observation) {
  const source = sourceRef(observation), cells = splitCells(observation.cells, observation.columns?.length);
  const fields = {}, columns = observation.columns || [], issues = [];
  if (!columns.length) issues.push({ reasonCode: observation.issue || 'table-layout-not-verified', reason: '已定位产品行，但表头或单位未完整核实，未映射数值字段' });
  else if (cells.length !== columns.length) issues.push({ reasonCode: 'column-count-mismatch', reason: '原始单元格数量与表头不一致，未移动或拼补数值列' });
  else columns.forEach((field, index) => {
    fields[field] = parseCell(cells[index], field, observation.unit, observation.percentageHeaders?.includes(index), source, observation.percentagePointHeaders?.includes(index));
    if (!fields[field].usable) issues.push({ field, reasonCode: fields[field].reasonCode, reason: fields[field].reason });
  });
  const total = observation.total;
  if (total) {
    const totalCells = splitCells(total.cells, total.columns?.length);
    if (totalCells.length === total.columns?.length) total.columns.forEach((field, index) => {
      fields[field] = parseCell(totalCells[index], field, total.unit, total.percentageHeaders?.includes(index), { ...source, locations: total.locations || source.locations });
    });
    else issues.push({ reasonCode: 'total-columns-not-parsed', reason: '同表总收入列未能可靠解析' });
  }
  const currency = /币种\s*[:：]\s*([\p{Script=Han}A-Za-z]+)/u.exec(observation.text || '')?.[1];
  if (currency && !/^(?:人民币|CNY|RMB)$/.test(currency)) for (const field of Object.keys(fields).filter(currencyField)) {
    fields[field] = { ...fields[field], value: null, usable: false, reasonCode: 'currency-not-cny', reason: '原文币种不是人民币，未把外币金额当作人民币元' };
    issues.push({ field, reasonCode: 'currency-not-cny', reason: fields[field].reason });
  }
  return { subject: observation.subject, reportDate: observation.document?.reportDate, period: observation.period,
    documentId: observation.document?.id, table: observation.table, unit: observation.unit, rowStart: observation.rowStart,
    cells, columns, fields, issues, sourceRef: source };
}

function equalValue(left, right) {
  return left.unit === right.unit && Math.abs(left.value - right.value) <= 1e-7;
}
function selectField(candidates, unit = null) {
  const all = candidates.filter(Boolean), valid = all.filter(value => value.usable), sources = unique(all.flatMap(value => value.sourceRefs));
  if (!valid.length) return { ...missing(unit, all[0]?.reasonCode, all[0]?.reason), sourceRefs: sources,
    rawValue: all.length === 1 ? all[0].rawValue : null, rawUnit: all.length === 1 ? all[0].rawUnit : null };
  if (valid.some(value => !equalValue(valid[0], value))) return { ...missing(unit || valid[0].unit, 'conflicting-source-values', '同产品同期间存在不同原始值或单位，尚未消除口径冲突'),
    status: 'conflict', verification: 'mismatch', sourceRefs: sources };
  const first = valid[0];
  return { ...missing(first.unit), value: first.value, status: 'available', verification: 'source-verified', usable: true,
    rawValue: first.rawValue ?? null, rawUnit: first.rawUnit ?? null, reasonCode: null, reason: null, sourceRefs: sources };
}

const FORMULAS = {
  revenueGrowthPct: { inputs: ['currentRevenue', 'previousRevenue'], report: 'reportedRevenueGrowthPct', formula: '(当期收入 / 上年同期收入 - 1) × 100', calc: (a, b) => (a / b - 1) * 100, positive: [1] },
  revenueSharePct: { inputs: ['currentRevenue', 'currentTotalRevenue'], report: 'reportedRevenueSharePct', formula: '当期产品收入 / 同期同口径总收入 × 100', calc: (a, b) => a / b * 100, positive: [1] },
  salesGrowthPct: { inputs: ['currentSalesVolume', 'previousSalesVolume'], report: 'reportedSalesGrowthPct', formula: '(当期销量 / 上年同期销量 - 1) × 100', calc: (a, b) => (a / b - 1) * 100, positive: [1] },
  grossMarginPct: { inputs: ['currentRevenue', 'currentCost'], report: 'reportedGrossMarginPct', formula: '(当期收入 - 当期成本) / 当期收入 × 100', calc: (a, b) => (a - b) / a * 100, positive: [0] },
  previousGrossMarginPct: { inputs: ['previousRevenue', 'previousCost'], report: 'reportedPreviousGrossMarginPct', formula: '(上年同期收入 - 上年同期成本) / 上年同期收入 × 100', calc: (a, b) => (a - b) / a * 100, positive: [0] },
  grossMarginChangePp: { inputs: ['currentRevenue', 'currentCost', 'previousRevenue', 'previousCost'], report: 'reportedGrossMarginChange', formula: '当期毛利率 - 上年同期毛利率', calc: (a, b, c, d) => ((a - b) / a - (c - d) / c) * 100, positive: [0, 2] }
};

function connectedGroups(observations) {
  const groups = [...observations];
  // Cross-table costs may join revenue only when the same report and exact
  // product-period identity have an independently matching current revenue.
  for (let i = 0; i < observations.length; i++) for (let j = i + 1; j < observations.length; j++) {
    const a = observations[i], b = observations[j], ar = a.fields.currentRevenue, br = b.fields.currentRevenue;
    if (a.documentId !== b.documentId || a.reportDate !== b.reportDate || !ar?.usable || !br?.usable || !equalValue(ar, br)) continue;
    if (Object.keys(a.fields).some(key => a.fields[key]?.usable && b.fields[key]?.usable && !equalValue(a.fields[key], b.fields[key]))) continue;
    groups.push({ ...a, fields: { ...b.fields, ...a.fields }, table: `${a.table}+${b.table}` });
  }
  return groups;
}

function deriveField(key, observations, groups, rawMetrics) {
  const spec = FORMULAS[key], unit = key.endsWith('Pp') ? '百分点' : '%';
  const disclosures = observations.map(row => row.fields[spec.report]).filter(Boolean);
  const reported = selectField(disclosures, unit), calculations = [];
  let obstruction = null;
  for (const row of groups) {
    const inputs = spec.inputs.map(field => row.fields[field]);
    if (inputs.some(value => !value?.usable)) continue;
    if (inputs.some(input => input.unit !== inputs[0].unit)) { obstruction = 'incomparable-units'; continue; }
    if (spec.positive.some(index => inputs[index].value <= 0)) { obstruction = 'nonpositive-base'; continue; }
    if (key === 'revenueSharePct' && (inputs[0].value < 0 || inputs[0].value > inputs[1].value)) { obstruction = 'share-scope-conflict'; continue; }
    const value = spec.calc(...inputs.map(input => input.value));
    if (!Number.isFinite(value)) continue;
    calculations.push({ value, unit, usable: true, sourceRefs: unique(inputs.flatMap(input => input.sourceRefs)), tolerance: row.table === 'product-period-comparison' ? .15 : .03 });
  }
  const result = selectField(calculations, unit), operandConflict = spec.inputs.some(field => rawMetrics[field]?.status === 'conflict');
  // A percent change in a ratio is not its percentage-point difference. An
  // ambiguous or malformed disclosed change cannot be silently ignored just
  // because four independent amounts are available for a calculation.
  const unverifiedChange = key === 'grossMarginChangePp' && disclosures.some(value =>
    value.reasonCode !== 'reported-placeholder' && (!value.usable || value.unit !== unit));
  if (unverifiedChange) return { ...result, formula: spec.formula, usable: false, status: 'pending', verification: null,
    reportedValue: reported.usable ? reported.value : null, reportedUnit: reported.usable ? reported.unit : null,
    rawValue: reported.rawValue, rawUnit: reported.rawUnit, reasonCode: 'reported-change-unit-unverified',
    reason: '原文毛利率增减的单位或数值尚未核实；百分比不能直接视为百分点，计算值仅供查看',
    sourceRefs: unique([...result.sourceRefs, ...reported.sourceRefs]) };
  if (result.usable && !operandConflict) {
    const disagreement = reported.status === 'conflict' || reported.usable && Math.abs(result.value - reported.value) > Math.max(.03, ...calculations.map(value => value.tolerance));
    return { ...result, formula: spec.formula, verification: disagreement ? 'mismatch' : 'calculated', usable: !disagreement,
      status: disagreement ? 'conflict' : 'available', reportedValue: reported.usable ? reported.value : null,
      reportedUnit: reported.usable ? reported.unit : null,
      rawValue: reported.rawValue, rawUnit: reported.rawUnit, reasonCode: disagreement ? 'reported-calculated-mismatch' : null,
      reason: disagreement ? '原文披露比例与原始金额或数量复算结果不一致，均保留供核验' : null,
      sourceRefs: unique([...result.sourceRefs, ...reported.sourceRefs]) };
  }
  if (result.status === 'conflict' || operandConflict) return { ...result, status: 'conflict', verification: 'mismatch', usable: false,
    formula: spec.formula, reasonCode: 'conflicting-source-values', reason: '用于计算的同产品同期间数据存在冲突', reportedValue: reported.usable ? reported.value : null };
  const reason = obstruction === 'nonpositive-base' ? '分母或比较基数不为正，未计算同比、占比或毛利率'
    : obstruction === 'incomparable-units' ? '当期与比较期单位不同，未擅自换算数量或跨口径计算'
      : obstruction === 'share-scope-conflict' ? '产品收入超过同口径总收入或为负，需核实收入范围'
        : '尚未提取到同产品、同期间、同口径的完整计算原值；不代表公司未披露';
  return { ...reported, value: reported.usable ? reported.value : null, status: reported.status === 'conflict' ? 'conflict' : reported.usable ? 'available' : 'not-extracted',
    usable: false, verification: reported.usable ? 'disclosed-only' : reported.verification,
    reportedValue: reported.usable ? reported.value : null, formula: spec.formula,
    reasonCode: obstruction || 'calculation-inputs-not-extracted', reason };
}

function metricsFromObservations(input, options = {}) {
  const selectedPeriod = options.reportDate || input.map(row => row.document?.reportDate).filter(Boolean).sort().at(-1);
  const observations = input.filter(row => !selectedPeriod || row.document?.reportDate === selectedPeriod).map(readObservation);
  const subjects = unique([...(options.subjects || []), ...observations.map(row => row.subject)]).filter(Boolean);
  return subjects.map(subject => {
    const rows = observations.filter(row => row.subject === subject), metrics = {};
    for (const key of RAW_FIELDS) metrics[key] = selectField(rows.map(row => row.fields[key]), AMOUNTS.has(key) ? '元' : null);
    const groups = connectedGroups(rows);
    for (const key of DERIVED_FIELDS) metrics[key] = deriveField(key, rows, groups, metrics);
    return { subject, reportDate: options.reportDate || rows[0]?.reportDate || null, period: rows[0]?.period || null, metrics,
      observations: rows.map(({ fields, documentId, ...row }) => ({ ...row, fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, {
        rawValue: value.rawValue, rawUnit: value.rawUnit, value: value.value, unit: value.unit, usable: value.usable,
        reasonCode: value.reasonCode, reason: value.reason }])) })),
      issues: unique(rows.flatMap(row => row.issues)) };
  });
}

function sourceIntegrityIssue(document) {
  const pages = document.pageTexts, text = document.text ?? document.fullText;
  const pdf = /^pdf(?:-|$)/.test(document.format || '') || document.originalFile?.format === 'pdf'
    || Array.isArray(pages) && pages.some(page => page?.method === 'pdf-text');
  if (pdf && document.parserVersion !== PARSER_VERSION) return 'pdf-parser-version-not-current';
  if (typeof text !== 'string' || !text.trim() || document.fullText != null && document.fullText !== text
    || document.textHash != null && document.textHash !== hash(text)) return 'document-text-integrity-invalid';
  if (!Array.isArray(pages)) return pdf || document.hasOcrPages || /ocr|^(?:png|jpeg|webp|bmp)$/.test(document.format || '')
    ? 'page-records-missing' : null;
  if (!Number.isSafeInteger(document.pages) || document.pages <= 0 || document.pages > 1600 || pages.length !== document.pages
    || pages.some((page, index) => !page || page.page !== index + 1 || typeof page.text !== 'string' || page.complete !== true
      || page.nativeReauditFromVersion != null || typeof page.numericEligible !== 'boolean'
      || !['pdf-text', 'provider-text', 'ocr', 'page-audit'].includes(page.method)
      || (page.method === 'ocr' && (page.numericEligible !== false || !Number.isFinite(page.confidence) || page.confidence < 85 || page.confidence > 100))
      || ((page.method === 'page-audit' || page.contentRole === 'non-content' || page.classification) && !isVerifiedNonContentPage(page, document))
      || (page.characters != null || pdf) && page.characters !== page.text.length
      || (page.textHash != null || pdf) && page.textHash !== hash(page.text))
    || pages.map(page => page.text).join('\n\n') !== text
    || document.hasOcrPages != null && document.hasOcrPages !== pages.some(page => page.method === 'ocr')
    || document.numericEligible != null && document.numericEligible !== pages.every(page => page.numericEligible)) return 'page-records-integrity-invalid';
  return null;
}

function buildProductMetrics(documents, options = {}) {
  documents = Array.isArray(documents) ? documents : [];
  const date = new Date(options.now ?? Date.now()), checkedAt = date.getTime(), today = Number.isFinite(checkedAt) ? cnTime(date).date : null;
  const symbols = unique(documents.map(document => document?.issuerSymbol).filter(Boolean));
  const symbol = options.symbol || (symbols.length === 1 ? symbols[0] : null);
  const diagnostics = [], candidates = [];
  for (const document of Array.isArray(documents) ? documents : []) {
    if (!document || !['annual-report', 'semiannual-report'].includes(document.kind || document.sourceKind)) continue;
    const kind = document.kind || document.sourceKind, reportDate = document.reportDate;
    let reasonCode = null;
    if (!symbol || document.issuerSymbol !== symbol) reasonCode = 'issuer-not-verified';
    else if (!/^20\d{2}-(?:06-30|12-31)$/.test(reportDate || '') || (kind === 'annual-report') !== reportDate.endsWith('12-31')) reasonCode = 'report-period-not-verified';
    else if (!today || reportDate > today || typeof document.publishedAt !== 'string'
      || !/^20\d{2}-\d{2}-\d{2}/.test(document.publishedAt) || !Number.isFinite(new Date(document.publishedAt).getTime())
      || new Date(document.publishedAt.slice(0, 10)).toISOString().slice(0, 10) !== document.publishedAt.slice(0, 10)
      || document.publishedAt.includes('T') && new Date(document.publishedAt).getTime() > checkedAt
      || document.publishedAt.slice(0, 10) > today || document.publishedAt.slice(0, 10) < reportDate) reasonCode = 'publication-date-not-verified';
    if (reasonCode) diagnostics.push({ sourceDocumentId: document.id || null, reasonCode });
    else candidates.push(document);
  }
  const reportDate = candidates.map(document => document.reportDate).sort().at(-1) || null, observations = [];
  for (const document of candidates.filter(value => value.reportDate === reportDate)) {
    if (document.complete !== true || !document.id || !/^https?:\/\//.test(document.url || '')) {
      diagnostics.push({ sourceDocumentId: document.id || null, reasonCode: 'source-incomplete' }); continue;
    }
    const integrityIssue = sourceIntegrityIssue(document);
    if (integrityIssue) { diagnostics.push({ sourceDocumentId: document.id || null, reasonCode: integrityIssue }); continue; }
    const native = Array.isArray(document.pageTexts) ? document.pageTexts.filter(page => page.complete === true && page.numericEligible === true && ['pdf-text', 'provider-text'].includes(page.method)) : null;
    if (native && !native.length || !native && !String(document.text || document.fullText || '').trim()) {
      diagnostics.push({ sourceDocumentId: document.id, reasonCode: 'native-text-not-available' }); continue;
    }
    const prepared = { ...document, kind: document.kind || document.sourceKind, text: document.text || document.fullText || '' };
    const extracted = reportProductObservations(prepared);
    observations.push(...extracted);
    if (!extracted.length) diagnostics.push({ sourceDocumentId: document.id, reasonCode: 'supported-product-rows-not-extracted' });
  }
  const products = metricsFromObservations(observations, { ...options, reportDate });
  return { version: VERSION, symbol, checkedAt: Number.isFinite(checkedAt) ? checkedAt : null, reportDate,
    status: products.some(product => Object.values(product.metrics).some(metric => metric.usable)) ? 'available' : 'pending', products, diagnostics };
}

module.exports = { buildProductMetrics, metricsFromObservations, PRODUCT_METRICS_VERSION: VERSION };
