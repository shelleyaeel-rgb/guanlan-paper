'use strict';

const performanceEditors = new Map();
const performanceFieldsFallback = {
  netProfitGrowthMinPct: { label: '预告/快报归母净利润同比下界', unit: '%' },
  recurringProfitGrowthMinPct: { label: '预告/快报扣非净利润同比下界', unit: '%' }
};
function performanceFields() { return (typeof screenMeta !== 'undefined' && screenMeta?.performance?.fields) || performanceFieldsFallback; }
function performanceLabels(query) {
  return query?.enabled ? (query.rules || []).map(rule => `${performanceFields()[rule.field]?.label || rule.field} ${researchOps()[rule.op] || rule.op} ${rule.value ?? '未填写'} %`) : [];
}
function performanceRuleError(query) {
  if (!query?.enabled) return '';
  if (!query.rules?.length) return '已启用业绩预告/快报条件，请添加指标和阈值，或切回只观察。';
  return query.rules.some(rule => !Object.hasOwn(performanceFields(), rule.field) || !Object.hasOwn(researchOps(), rule.op) || rule.value == null || rule.value === '' || !Number.isFinite(Number(rule.value))) ? '请完整填写业绩预告/快报条件。' : '';
}
function performanceRuleEditor(id, options) {
  const root = $(id); if (!root) return;
  performanceEditors.set(id, options);
  const query = options.get() || { version: 1, enabled: false, rules: [] }, fields = performanceFields(), ops = researchOps();
  const signature = JSON.stringify({ query, busy: !!options.busy, fields });
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.innerHTML = `<div class="research-rule-heading"><h3>业绩预告 / 快报条件</h3><label>如何使用同比<select data-performance-edit="enabled" aria-label="业绩预告快报用途"><option value="observe" ${!query.enabled ? 'selected' : ''}>只观察 · 不设同比门槛</option><option value="filter" ${query.enabled ? 'selected' : ''}>按下方条件筛选</option></select></label></div><p class="tiny">正式财报独立评估。预告是预测，快报是初步核算；普通同比下滑仅提示，明确不盈利及重大异常仍按公告风险规则检查。默认不设阈值。启用后，近 14 日没有可核实的预告或快报也会待核验，半年报不能补作预测值。</p><div class="research-rule-list">${query.rules.map((rule, index) => `<div class="research-edit-rule" data-performance-rule="${index}"><label>指标<select data-performance-edit="field" aria-label="第 ${index + 1} 项业绩指标">${Object.entries(fields).map(([key, field]) => `<option value="${key}" ${key === rule.field ? 'selected' : ''}>${esc(field.label)}</option>`).join('')}</select></label><label>比较<select data-performance-edit="op" aria-label="第 ${index + 1} 项业绩比较">${Object.entries(ops).map(([key, label]) => `<option value="${key}" ${key === rule.op ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label><label>阈值<input type="number" step="any" data-performance-edit="value" aria-label="第 ${index + 1} 项业绩阈值" placeholder="填写阈值" value="${esc(rule.value ?? '')}"></label><span class="research-rule-unit">%</span><button type="button" class="text-button" data-performance-remove="${index}">移除 ×</button></div>`).join('')}</div><button type="button" class="outline" data-performance-add>＋ 添加业绩条件</button>`;
  root.querySelectorAll('input,select,button').forEach(element => { element.disabled = !!options.busy; });
  if (root.dataset.bound) return; root.dataset.bound = 'true';
  const change = event => {
    const config = performanceEditors.get(id), part = event.target.dataset.performanceEdit;
    if (!part || config.busy) return;
    const value = structuredClone(config.get() || { version: 1, enabled: false, rules: [] });
    if (part === 'enabled') { value.enabled = event.target.value === 'filter'; if (!value.enabled) value.rules = []; }
    else {
      const rule = value.rules[Number(event.target.closest('[data-performance-rule]')?.dataset.performanceRule)]; if (!rule) return;
      rule[part] = part === 'value' ? (event.target.value === '' ? null : Number(event.target.value)) : event.target.value;
    }
    config.set(value);
    // The DOM already contains the user's draft, including intermediate input
    // such as a trailing decimal point. A background tick must not replace it.
    root.dataset.signature = part === 'value' ? JSON.stringify({ query: config.get(), busy: !!config.busy, fields: performanceFields() }) : '';
    if (part !== 'value') performanceRuleEditor(id, config);
  };
  root.addEventListener('change', change);
  root.addEventListener('input', event => { if (event.target.dataset.performanceEdit === 'value') change(event); });
  root.addEventListener('click', event => {
    const config = performanceEditors.get(id), add = event.target.closest('[data-performance-add]'), remove = event.target.closest('[data-performance-remove]');
    if (config.busy || (!add && !remove)) return;
    const value = structuredClone(config.get() || { version: 1, enabled: false, rules: [] });
    if (add) { if (value.rules.length >= 20) return toast('最多添加 20 项业绩条件', true); value.enabled = true; value.rules.push({ field: 'netProfitGrowthMinPct', op: 'gte', value: null }); }
    else value.rules.splice(Number(remove.dataset.performanceRemove), 1);
    config.set(value); performanceRuleEditor(id, config);
    if (add) root.querySelector('.research-edit-rule:last-child input')?.focus();
  });
}
function financePeriodName(date) {
  return date?.endsWith('06-30') ? '半年报' : date?.endsWith('09-30') ? '三季报' : date?.endsWith('12-31') ? '年报' : date?.endsWith('03-31') ? '一季报' : '';
}
function financeItemPeriod(item, check) {
  // New snapshots state the period per predicate. Do not substitute the latest
  // half-year date when the annual row explicitly has no verified report.
  if (Object.hasOwn(item, 'reportDate')) return item.reportDate;
  if (/^annual/.test(item.field || '') || /完整年度|年度加权/.test(item.basis || '')) return check.annualReportDate || null;
  return check.reportDate || null;
}
function financeItemHtml(item, check, observing = false) {
  const reportDate = financeItemPeriod(item, check);
  const valuation = ['pe', 'pb'].includes(item.field);
  const noticeDate = Object.hasOwn(item, 'noticeDate') ? item.noticeDate : reportDate === check.reportDate ? check.noticeDate : null;
  const pending = item.status === 'pending', value = item.value ?? item.rawValue;
  const known = value != null;
  const status = observing ? pending ? '观察数据待补' : '仅观察' : ({ pass: '通过', failed: '条件不符', pending: '待核验' })[item.status] || item.status || '尚未判断';
  const currencyUnverified = pending && item.unit === '亿元'
    && (Object.hasOwn(item, 'currency') ? item.currency !== 'CNY' : /币种/.test(item.reason || ''));
  const actualUnit = currencyUnverified ? `亿原币（${item.currency || '币种未知'}）` : item.unit || '';
  const actual = known ? `${String(value)}${actualUnit}${pending ? '（当前不可用于判断）' : ''}` : '未知（缺失不补零）';
  const expected = item.op === 'range' ? `> ${item.expected?.[0] ?? '未知'} 且 ≤ ${item.expected?.[1] ?? '未知'}` : `${researchOps()[item.op] || ''} ${item.expected == null ? '未记录' : String(item.expected)}`.trim();
  const basisLabels = { annual: '完整年度财报指标', 'latest-disclosed-cumulative': '最新已披露累计财报指标' };
  const basis = Object.hasOwn(basisLabels, item.basis) ? basisLabels[item.basis]
    : item.basis || (item.field === 'roe' ? '报告期累计未年化' : valuation ? '对应行情报价口径，动态 PE 不是 TTM' : '以本项来源披露口径为准');
  return `<article class="finance-check-item" data-finance-field="${esc(item.field || '')}" data-finance-item-status="${esc(item.status || '')}" data-finance-observation="${observing}"><b>${esc(item.label || item.field)} · ${esc(status)}</b><p class="finance-item-period">${reportDate ? `${esc(financePeriodName(reportDate))} · 报告期 ${esc(reportDate)}` : valuation ? '行情估值指标' : '报告期尚未核实'}${noticeDate ? ` · 披露 ${esc(noticeDate)}` : ''}<br>${esc(basis)}</p><p>${pending && known ? '已取得原值' : '原值'} ${esc(actual)}${observing ? ' · 不作为开仓阈值' : ` · 要求 ${esc(expected)}${esc(item.unit || '')}`}</p>${item.reason ? `<p class="finance-item-reason">${esc(item.reason)}</p>` : ''}</article>`;
}
function financeApplicabilityHtml(value) {
  if (!value) return '';
  const status = ({ applicable: '适用普通非金融企业模板', inapplicable: '普通非金融企业模板不适用', pending: '行业分类待核验' })[value.status] || '行业分类待核验';
  return `<section class="finance-applicability" data-finance-applicability="${esc(value.status || 'pending')}"><b>财务模板适用性 · ${esc(status)}</b><p>${esc(value.reason || '尚无可用的模板适用性结论。')}</p><p class="tiny">行业分类：${esc(value.industry || '未取得')} · 监管行业：${esc(value.regulatoryIndustry || '未取得')}<br>机构类型：${esc(value.orgType || '未取得')}${value.orgTypeCode ? `（${esc(value.orgTypeCode)}）` : ''}<br>来源：${esc(value.source || '未取得')} · 获取 ${esc(timeText(value.fetchedAt))} · 核验 ${esc(timeText(value.checkedAt))}</p>${value.status === 'inapplicable' ? '<p class="tiny">这表示当前模板无法评价该类企业，不表示公司财务不合格；需要相应行业专用模板。</p>' : value.status !== 'applicable' ? '<p class="tiny">行业未知、过期或冲突时先补齐分类依据，不默认套用普通非金融企业模板。</p>' : ''}</section>`;
}
function financeCheckHtml(check, label = '正式财报') {
  if (!check) return '';
  const items = Array.isArray(check.checks) ? check.checks : [], observations = Array.isArray(check.observations) ? check.observations : [];
  const periods = [...new Set([...items, ...observations].map(item => financeItemPeriod(item, check)).filter(Boolean))];
  const mixed = periods.length > 1 || !!check.annualReportDate && check.annualReportDate !== check.reportDate
    || items.some(item => /^annual/.test(item.field || '')) && !!check.reportDate && !check.reportDate.endsWith('-12-31');
  const reportDate = mixed ? null : periods.length === 1 ? periods[0] : check.reportDate;
  const period = mixed ? '分项报告期' : financePeriodName(reportDate);
  const status = check.applicability?.status === 'inapplicable' ? '模板不适用' : check.applicability?.status === 'pending' ? '行业分类待核验' : ({ pass: label === '估值' ? '估值通过' : '财务通过', failed: '条件不符', pending: '资料待核验' })[check.status] || '尚未判断';
  const reasons = [...new Set(check.reasons || [])];
  return `<details class="finance-check" data-finance-status="${esc(check.status)}" data-finance-label="${esc(label)}"><summary>${esc(label)}${period ? ` · ${esc(period)}` : ''}：${esc(status)}${reportDate ? ` · ${esc(reportDate)}` : ''}</summary><p class="tiny">${esc(check.source || '来源未标注')} · 获取 ${esc(timeText(check.fetchedAt))}${mixed ? '<br>年度与累计指标分别使用各自报告期；不把半年或季度 ROE 当作年度 ROE。' : !items.length && check.noticeDate ? ` · 披露 ${esc(check.noticeDate)}` : ''}</p>${financeApplicabilityHtml(check.applicability)}${reasons.map(reason => `<p class="finance-item-reason">${esc(reason)}</p>`).join('')}${items.map(item => financeItemHtml(item, check)).join('')}${observations.length ? `<section class="finance-observations"><h4>趋势观察 · 不参与本次财务门槛</h4>${observations.map(item => financeItemHtml(item, check, true)).join('')}</section>` : ''}${check.thresholdBasis ? `<p class="tiny finance-threshold-basis">${esc(check.thresholdBasis)}</p>` : ''}</details>`;
}
function independentFinanceHtml(value) {
  if (!value) return '';
  const checks = value.financeChecks;
  return checks && Object.keys(checks).length ? Object.entries(checks).map(([id, check]) => financeCheckHtml(check, `${strategyProfile(id).name}财务`)).join('') : financeCheckHtml(value.financeCheck);
}
function performanceReviewHtml(review) {
  if (!review) return '';
  const selected = review.selectedNotice, period = Object.values(review.metrics || {}).find(metric => metric.period)?.period;
  return `<details class="performance-review"><summary>预告 / 快报条件：${esc(({ observing: '只观察', pass: '通过', failed: '条件不符', pending: '资料待补' })[review.status] || '尚未判断')}</summary>${selected ? `<p>${esc(selected.title)} · 披露 ${esc(selected.date)}<br>${esc(selected.basisLabel || '')}${period ? '<br>期间 ' + esc(period.start) + ' 至 ' + esc(period.end) + ' · ' + esc(period.aggregationLabel || '') : ''}</p>` : ''}${(review.reasons || []).map(reason => `<p>${esc(reason)}</p>`).join('')}${(review.checks || []).map(check => `<p><b>${esc(check.label)}</b>：${check.actual == null ? '未知' : esc(String(check.actual)) + '%'} · 要求 ${esc(check.expected)} · ${esc(researchStatusLabel(check.status))}</p>`).join('')}<p class="tiny">预告和快报独立判断，不替代正式财报；资料不足不等于财务不合格。</p></details>`;
}
function noticeFactValueText(check) {
  const value = check.value;
  const number = item => Number.isFinite(item) ? item.toLocaleString('zh-CN', { maximumFractionDigits: 10 }) : '未知';
  const period = item => item?.start && item?.end ? `${item.start} 至 ${item.end}` : '期间待核验';
  if (check.key === 'stage') return ({ completed: '已完成或期限届满', ongoing: '仍在进行或尚未实施',
    'conditions-met': '解除限售条件已成就', 'listing-scheduled': '已披露上市流通安排', unknown: '阶段待核验' })[value] || String(value);
  if (check.key === 'phase') return ({ 'application-accepted': '申请已受理', 'clinical-trial-approved': '获准开展临床试验' })[value] || String(value);
  if (check.key === 'endpoint' && value === 'achieved') return '达到主要终点';
  if (check.key === 'funded' && value === 0) return '尚未出资';
  if (check.key === 'term' && value?.start && value?.end) return `${value.start} 至 ${value.end}`;
  if (check.key === 'transactions' && Array.isArray(value)) return value.map(item => {
    const parts = [`股东 ${item.holder || '待核验'}`, item.sourceKind === 'issuer-treasury' ? '公司回购专户股份' : '股东持有股份',
      `${item.scope === 'disclosed-plan' ? '披露计划内' : '本次'}减持 ${number(item.quantityShares)} 股`];
    if (Number.isFinite(item.otherSourceQuantityShares)) parts.push(`其他来源 ${number(item.otherSourceQuantityShares)} 股`);
    if (Number.isFinite(item.allSourceQuantityShares)) parts.push(`全部来源合计 ${number(item.allSourceQuantityShares)} 股`);
    if (Number.isFinite(item.totalCapitalPct)) parts.push(`占总股本 ${number(item.totalCapitalPct)}%${item.ratioScope === 'disclosed-plan' ? '（披露计划口径）' : ''}`);
    parts.push(`减持期间 ${period(item.period)}${item.periodScope === 'disclosed-plan' ? '（披露计划口径）' : ''}`);
    return parts.join('，');
  }).join('；');
  if (check.key === 'releases' && Array.isArray(value)) return value.map(item => [`计划 ${item.plan || '待核验'}`,
    `本次解除限售 ${number(item.quantityShares)} 股`, `占总股本 ${number(item.totalCapitalPct)}%`,
    ...(Number.isFinite(item.holders) ? [`对象数量 ${number(item.holders)}`] : [])].join('，')).join('；');
  if (check.key === 'period' && value?.start && value?.end) return `${value.start} 至 ${value.end}${value.aggregationLabel ? ' · ' + value.aggregationLabel : ''}`;
  if (['netProfit', 'recurringProfit'].includes(check.key) && value?.current) {
    const range = item => item?.min === item?.max && Number.isFinite(item?.min) ? number(item.min) : `${number(item?.min)} 至 ${number(item?.max)}`;
    const comparable = (check.comparisonStatus || value.comparisonStatus) !== 'not-comparable';
    const growth = value.growthPct ? `公告披露同比 ${range(value.growthPct)}%` : '公告未提供同比区间';
    const amountStatus = check.amountUsable === false || value.amountUsable === false ? '；原始金额当前不可用于条件判断'
      : check.amountStatus === 'verified' || value.amountStatus === 'verified' ? '；原始金额已核验' : '';
    return `本期 ${range(value.current)} ${value.unit || ''}；上年同期 ${number(value.previous)} ${value.unit || ''}${amountStatus}；${comparable ? growth : `本期与上期不可比，不代算同比（${growth}仅保留披露值）`}`;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}
function renderScreenPerformanceResults(result, search) {
  const root = $('screen-performance-results');
  if (!result.performanceScreen) { root.innerHTML = ''; return; }
  const rows = [...(result.performancePendingRows || []), ...(result.performanceFailedRows || [])].filter(row => !search || row.symbol.includes(search) || (row.name || '').toLowerCase().includes(search));
  root.innerHTML = `<details class="screen-risk-excluded"><summary>预告 / 快报条件未通过 · ${rows.length} 只</summary><p class="tiny">此处为业绩数值条件；重大异常和公告原文不足在风险检查中另列。</p>${rows.slice(0, 100).map(row => `<article><b>${esc(row.name || row.symbol)} · ${esc(row.symbol)}</b>${performanceReviewHtml(row.performanceReview)}<button class="text-button" data-screen-open="${esc(row.symbol)}">查看股票</button></article>`).join('')}${rows.length > 100 ? '<p>仅展示前 100 条，请搜索股票缩小范围。</p>' : ''}</details>`;
}
