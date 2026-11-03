'use strict';

// Shared editor. Report values are read-only; only the user's comparison rules
// are edited here. An empty editor never supplies an implicit threshold.
const researchRulesUi = { editors: new Map(), inspection: null, session: 0 };
const researchPathNames = { product: '产品指标', company: '公司经营' };
const researchFallbackFields = {
  product: {
    currentRevenue: { label: '产品当期收入', unit: '元' }, revenueSharePct: { label: '产品收入占比', unit: '%' }, revenueGrowthPct: { label: '产品收入同比', unit: '%' },
    currentSalesVolume: { label: '产品当期销量', unit: '' }, salesGrowthPct: { label: '产品销量同比', unit: '%' }, grossMarginPct: { label: '产品毛利率', unit: '%' }, grossMarginChangePp: { label: '产品毛利率变化', unit: '百分点' }
  },
  company: { revenueYoY: { label: '公司营收同比', unit: '%' }, adjustedProfitYoY: { label: '公司扣非净利润同比', unit: '%' }, latestAdjustedProfit: { label: '公司扣非净利润', unit: '亿元' }, operatingCash: { label: '公司经营现金流净额', unit: '亿元' } }
};
function researchMetadata() {
  return typeof screenMeta !== 'undefined' && screenMeta?.research || {};
}
function researchFields(path) { return researchMetadata().fields?.[path] || researchMetadata()[path + 'Fields'] || researchFallbackFields[path] || {}; }
function researchOps() { return researchMetadata().ops || { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' }; }
function researchVolumeUnits() { return researchMetadata().volumeUnits || ['台', '辆', '吨', '万吨', '件', '万件', '个', '万个', '套', '万套', '片', '万片', '平方米', '万平方米', '立方米', '万立方米', '亿立方米', '桶', '万桶', '百万桶', '十亿立方英尺', '千瓦时', '万千瓦时']; }
function researchRuleLabels(research) {
  if (!research?.enabled) return [];
  const fields = researchFields(research.path), prefix = researchPathNames[research.path] || '研究';
  return (research.rules || []).map(rule => `${prefix} · ${fields[rule.field]?.label || rule.field} ${researchOps()[rule.op] || rule.op} ${rule.value ?? '未填写'} ${rule.unit || fields[rule.field]?.unit || ''}`.trim());
}
function researchRuleError(research) {
  if (!research?.enabled) return '';
  if (!research.rules?.length) return '已开启研究筛选，请至少添加一项条件并填写阈值；也可切回“只观察”。';
  const fields = researchFields(research.path);
  for (const rule of research.rules) {
    if (!fields[rule.field] || !Object.hasOwn(researchOps(), rule.op) || rule.value === null || rule.value === '' || !Number.isFinite(Number(rule.value))) return '请完整填写研究条件的指标、比较方式和数值。';
    if (rule.field === 'currentSalesVolume' && !rule.unit) return '销量条件须选择披露使用的精确单位，系统不自动换算。';
    const field = fields[rule.field];
    if (field.min != null && rule.value < field.min || field.max != null && rule.value > field.max) return `${field.label}条件超出指标的数学范围。`;
  }
  return '';
}
function researchRuleEditor(rootId, options) {
  const root = $(rootId);
  if (!root) return;
  const previous = researchRulesUi.editors.get(rootId);
  const config = { ...previous, ...options };
  researchRulesUi.editors.set(rootId, config);
  const value = config.get() || { version: 1, enabled: false, path: config.path || 'product', rules: [] };
  const selectedPath = config.path || value.path || 'product', fields = researchFields(selectedPath), ops = researchOps();
  const signature = JSON.stringify({ value, selectedPath, busy: !!config.busy, showPath: !!config.showPath, fields, ops });
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.innerHTML = `<div class="research-rule-heading"><h3>研究条件 · ${esc(researchPathNames[selectedPath])}</h3>${config.showPath ? `<label>判断路径<select data-research-edit="path" aria-label="研究判断路径">${Object.entries(researchPathNames).map(([key, label]) => `<option value="${key}" ${key === selectedPath ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>` : ''}<label>如何使用资料<select data-research-edit="enabled" aria-label="研究资料用途"><option value="observe" ${!value.enabled ? 'selected' : ''}>只观察 · 不参与筛选</option><option value="filter" ${value.enabled ? 'selected' : ''}>按下方条件筛选</option></select></label></div><p class="tiny">${selectedPath === 'company' ? '公司经营指标是独立的替代判断，不证明某个产品有前景。产品信息不足会继续标为未知。' : '同一产品须满足全部已启用条件；原始披露值与计算值可在逐股资料中查看。'} 默认不设阈值。原始资料不能在此修改，旧的个人研究标签继续独立生效。</p><div class="research-rule-list">${(value.rules || []).map((rule, index) => {
    const field = fields[rule.field];
    return `<div class="research-edit-rule" data-research-rule="${index}"><label>指标<select data-research-edit="field" aria-label="第 ${index + 1} 项研究指标">${Object.entries(fields).map(([key, metadata]) => `<option value="${key}" ${key === rule.field ? 'selected' : ''}>${esc(metadata.label || key)}</option>`).join('')}</select></label><label>比较<select data-research-edit="op" aria-label="第 ${index + 1} 项研究比较">${Object.entries(ops).map(([key, label]) => `<option value="${key}" ${key === rule.op ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label><label>阈值<input data-research-edit="value" aria-label="第 ${index + 1} 项研究阈值" type="number" step="any" placeholder="填写阈值" value="${esc(rule.value ?? '')}"></label>${rule.field === 'currentSalesVolume' ? `<label>原披露单位<select data-research-edit="unit" aria-label="第 ${index + 1} 项销量单位"><option value="">选择单位</option>${researchVolumeUnits().map(unit => `<option value="${esc(unit)}" ${unit === rule.unit ? 'selected' : ''}>${esc(unit)}</option>`).join('')}</select></label>` : `<span class="research-rule-unit">${esc(field?.unit || '')}</span>`}<button type="button" class="text-button" data-research-remove="${index}" aria-label="移除第 ${index + 1} 项研究条件">移除 ×</button></div>`;
  }).join('') || '<p class="tiny">尚未添加研究条件。</p>'}</div><div class="research-rule-actions"><button type="button" class="outline" data-research-add>＋ 添加研究条件</button><span class="tiny" data-research-editor-status>${value.enabled ? '全部条件同时满足才通过；资料缺失不会当作 0。' : '只观察：当前研究资料不影响候选，不保存额外研究开仓门槛。'}</span></div>`;
  root.querySelectorAll('input,select,button').forEach(element => { element.disabled = !!config.busy; });
  if (root.dataset.bound) return;
  root.dataset.bound = 'true';
  function update(event) {
    const active = researchRulesUi.editors.get(rootId), part = event.target.dataset.researchEdit;
    if (!part || active.busy) return;
    const current = structuredClone(active.get() || { version: 1, enabled: false, path: active.path || 'product', rules: [] });
    current.path = active.path || current.path || 'product';
    if (part === 'enabled') { current.enabled = event.target.value === 'filter'; if (!current.enabled) current.rules = []; }
    else if (part === 'path') { current.path = event.target.value; current.rules = []; current.enabled = false; }
    else {
      const index = Number(event.target.closest('[data-research-rule]')?.dataset.researchRule), rule = current.rules[index];
      if (!rule) return;
      if (part === 'field') { rule.field = event.target.value; rule.value = null; delete rule.unit; }
      else rule[part] = part === 'value' ? (event.target.value === '' ? null : Number(event.target.value)) : event.target.value;
    }
    active.set(current);
    // Keep the focused numeric input stable while typing.
    if (part === 'value') {
      const value = active.get(), selectedPath = active.path || value.path || 'product';
      root.dataset.signature = JSON.stringify({ value, selectedPath, busy: !!active.busy, showPath: !!active.showPath, fields: researchFields(selectedPath), ops: researchOps() });
      return;
    }
    researchRuleEditor(rootId, active);
  }
  root.addEventListener('change', update);
  root.addEventListener('input', event => { if (event.target.dataset.researchEdit === 'value') update(event); });
  root.addEventListener('click', event => {
    const active = researchRulesUi.editors.get(rootId), add = event.target.closest('[data-research-add]'), remove = event.target.closest('[data-research-remove]');
    if ((!add && !remove) || active.busy) return;
    const current = structuredClone(active.get() || { version: 1, enabled: false, path: active.path || 'product', rules: [] });
    current.path = active.path || current.path || 'product';
    if (add) { if (current.rules.length >= 30) return toast('最多添加 30 项研究条件', true); current.enabled = true; current.rules.push({ field: Object.keys(researchFields(current.path))[0], op: 'gte', value: null }); }
    else current.rules.splice(Number(remove.dataset.researchRemove), 1);
    active.set(current); researchRuleEditor(rootId, active);
    if (add) root.querySelector('.research-edit-rule:last-child input')?.focus();
  });
}

function researchStatusLabel(status) { return ({ pass: '条件通过', passed: '条件通过', failed: '条件不符', fail: '条件不符', pending: '待核验', observing: '只观察', ready: '资料已取得', available: '可用', 'not-extracted': '尚未取得有效值' })[status] || '尚未判断'; }
function researchNumber(value) { return value == null ? '—' : String(value); }
function researchMetricLabel(key, path = 'product') {
  const labels = { previousRevenue: '上年同期产品收入', currentCost: '本期产品成本', previousCost: '上年同期产品成本', currentTotalRevenue: '同口径当期总收入', previousTotalRevenue: '同口径上年同期总收入', previousSalesVolume: '上年同期销量', previousGrossMarginPct: '上年同期毛利率', reportedRevenueGrowthPct: '披露收入同比', reportedRevenueSharePct: '披露收入占比', reportedSalesGrowthPct: '披露销量同比', reportedGrossMarginPct: '披露毛利率', reportedPreviousGrossMarginPct: '披露上年同期毛利率', reportedGrossMarginChangePp: '披露毛利率变化', reportedGrossMarginChange: '披露毛利率增减' };
  return researchFields(path)[key]?.label || labels[key] || '其他披露指标';
}
function researchSourceHtml(ref) {
  const heading = [ref.sourceTitle || ref.title || ref.source || '来源未标注', ref.reportDate ? `报告期 ${ref.reportDate}` : ref.period ? `统计期间 ${ref.period}` : '', ref.publishedAt ? `公告 ${ref.publishedAt}` : '', ref.updateDate ? `更新 ${ref.updateDate}` : '', ref.fetchedAt ? `获取 ${timeText(ref.fetchedAt)}` : ''].filter(Boolean).map(esc).join(' · ');
  const scopes = [typeof ref.tableScope === 'string' ? ref.tableScope : (ref.tableScope?.headings || []).map(heading => heading.text).filter(Boolean).join(' → '), typeof ref.accountingScope === 'string' ? ref.accountingScope : ref.accountingScope?.text].filter(Boolean);
  return `<article class="research-metric-source"><b>${heading}</b>${ref.reportVersion ? `<p class="tiny">报告版本 ${esc(ref.reportVersion)}</p>` : ''}${scopes.length ? `<p class="tiny">披露口径 ${scopes.map(esc).join(' · ')}</p>` : ''}${typeof agencyEvidenceLocationHtml === 'function' ? agencyEvidenceLocationHtml(ref) : ''}${ref.excerptTruncated ? '<p class="tiny">以下仅为部分原文摘录。</p>' : ''}${ref.quote ? `<blockquote>${esc(ref.quote)}</blockquote>` : ''}${ref.url ? `<p class="tiny">原文地址：${esc(ref.url)}</p>` : ''}</article>`;
}
function researchMetricTable(metrics, path) {
  const fields = researchFields(path);
  const keys = [...new Set([...Object.keys(fields), ...Object.keys(metrics || {})])];
  return `<table class="research-metric-table"><thead><tr><th>指标</th><th>数值与口径</th><th>核验与来源</th></tr></thead><tbody>${keys.map(key => {
    const cell = metrics?.[key], label = researchMetricLabel(key, path);
    const available = cell?.usable === true && cell?.status === 'available', refs = cell?.sourceRefs || cell?.records || [];
    const verification = ({ calculated: '按原始值计算', 'source-verified': '原始披露已核对', 'provider-reported': '数据源披露值', 'disclosed-only': '仅披露值 · 尚不能复算', mismatch: '计算值与披露值不一致' })[cell?.verification] || '';
    const value = cell?.value, reported = cell?.reportedValue;
    return `<tr data-research-metric="${esc(key)}"><td>${esc(label)}</td><td><strong>${value == null ? '—' : esc(researchNumber(value))} ${esc(cell?.unit ?? fields[key]?.unit ?? '')}</strong>${reported != null ? `<small>披露值：${esc(researchNumber(reported))} ${esc(cell?.reportedUnit || cell?.unit || '')}</small>` : ''}${cell?.rawValue != null ? `<small>原始值：${esc(researchNumber(cell.rawValue))} ${esc(cell.rawUnit || cell.unit || '')}</small>` : ''}${verification && value != null ? `<small>${esc(verification)}</small>` : ''}${cell?.formula ? `<small>计算：${esc(cell.formula)}</small>` : ''}${cell?.definition ? `<details><summary>指标口径</summary><p>${esc(cell.definition)}</p></details>` : ''}</td><td><span class="${available ? 'teal' : 'agency-pending'}">${available ? '可用于所选条件' : value != null ? '仅供查看 · 不能放行' : '尚无有效值'}</span>${cell?.reason ? `<small>${esc(cell.reason)}</small>` : !cell ? '<small>本次未返回该指标，不能当作 0。</small>' : ''}${refs.length ? `<details><summary>原文与来源 · ${refs.length} 项</summary>${refs.map(researchSourceHtml).join('')}</details>` : '<small>未记录可追溯来源</small>'}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function researchObservationsHtml(observations, issues) {
  if (!observations?.length && !issues?.length) return '';
  return `<details class="research-raw-observations"><summary>报告原始行与提取情况 · ${observations?.length || 0} 行</summary>${(observations || []).map(row => `<article class="research-metric-source"><b>${esc(row.subject || '产品行')} · ${esc(row.reportDate || row.period || '期间未标注')} · 原表单位 ${esc(row.unit || '未核实')}</b><p class="tiny">原始单元格顺序：${(row.cells || []).map(esc).join(' ｜ ')}</p>${Object.entries(row.fields || {}).length ? `<ul class="research-metric-checks">${Object.entries(row.fields).map(([key, cell]) => `<li>${esc(researchMetricLabel(key))}：${esc(cell.rawValue ?? '未提取')} ${esc(cell.rawUnit || '')}${cell.reason ? `<br>${esc(cell.reason)}` : ''}</li>`).join('')}</ul>` : '<p>表头尚未可靠映射到字段。</p>'}${(row.issues || []).map(issue => `<p class="agency-pending">${esc(issue.reason || '该行仍待核验')}</p>`).join('')}${row.sourceRef ? researchSourceHtml(row.sourceRef) : ''}</article>`).join('')}${(issues || []).map(issue => `<p class="agency-pending">${esc(issue.reason || '字段口径尚待核验')}</p>`).join('')}</details>`;
}
function researchChecksHtml(checks) {
  return !checks?.length ? '' : `<ul class="research-metric-checks">${checks.map(check => `<li><b>${esc(check.label || check.field || '指标')} · ${esc(researchStatusLabel(check.status))}</b><br>要求 ${esc(check.expected || '')} · 实际 ${check.actual == null ? '尚不可判断' : `${esc(researchNumber(check.actual))} ${esc(check.unit || '')}`}${check.reason ? `<br>${esc(check.reason)}` : ''}</li>`).join('')}</ul>`;
}
function researchReviewHtml(review) {
  if (!review) return '<p class="tiny">本次记录未包含产品原始指标和公司经营判断，可独立查看当前资料。</p>';
  const assessment = review.assessment || {}, product = review.productMetrics || {}, company = review.companyMetrics || {};
  const products = product.products || [], productSelected = assessment.path === 'product', companySelected = assessment.path === 'company';
  const productConclusion = productSelected ? researchStatusLabel(assessment.status) : '未按产品条件判断';
  const companyConclusion = companySelected ? researchStatusLabel(assessment.status) : '未按公司条件判断';
  const gaps = [...(review.acquisition || []), ...(product.sourceIssues || []).map(reason => ({ label: '产品来源核验不足', reason }))];
  return `<div class="research-review" data-research-status="${esc(assessment.status || review.status || 'pending')}"><p class="tiny">核验 ${esc(timeText(review.checkedAt))}${review.query ? ` · ${esc(researchPathNames[review.query.path] || '研究')} · ${review.query.enabled ? '按明确条件筛选' : '只观察，不影响候选'}` : ''}</p><div class="research-metrics-columns"><section class="research-metrics-panel" data-research-path="product"><h3>产品原始指标</h3><div class="research-metrics-state ${!productSelected || assessment.status !== 'pass' ? 'is-pending' : ''}">${esc(productConclusion)}</div><p class="tiny">产品前景仍需独立研究。这些数字只反映已披露期间，不代表未来增长或收益。</p>${product.reportDate ? `<p class="tiny">当前报告期 ${esc(product.reportDate)}</p>` : ''}${products.length ? products.map(item => {
    const result = (assessment.productCandidates || []).find(candidate => candidate.subject === item.subject && candidate.reportDate === item.reportDate);
    return `<details class="research-product-metrics" open><summary><b>${esc(item.subject || '产品未标注')}</b> · ${esc(item.reportDate || '期间未知')}${result ? ` · ${esc(researchStatusLabel(result.status))}` : ''}</summary>${researchChecksHtml(result?.checks)}${researchMetricTable(item.metrics, 'product')}${researchObservationsHtml(item.observations, item.issues)}</details>`;
  }).join('') : `<p class="agency-pending">产品未知：${esc(product.reason || '尚未可靠取得产品级指标；公司总收入、利润和现金流不能补填产品缺项。')}</p>`}</section><section class="research-metrics-panel" data-research-path="company"><h3>公司经营 · 独立替代路径</h3><div class="research-metrics-state ${!companySelected || assessment.status !== 'pass' ? 'is-pending' : ''}">经营判断：${esc(companyConclusion)}</div><p class="tiny">即使公司经营条件通过，也不表示某一产品前景已通过。</p>${company.reportDate ? `<p class="tiny">报告期 ${esc(company.reportDate)}</p>` : ''}${company.error || company.reason ? `<p class="agency-pending">${esc(company.error || company.reason)}</p>` : ''}${companySelected ? researchChecksHtml(assessment.checks) : ''}${researchMetricTable(company.metrics, 'company')}${company.limitation ? `<p class="tiny">${esc(company.limitation)}</p>` : ''}</section></div>${gaps.length ? `<section class="research-metric-gaps"><b>资料补全与核验</b><ul>${gaps.map(gap => `<li><b>${esc(gap.label || '资料待核验')}</b>：${esc(gap.reason || '')}${gap.action ? `<br>可继续：${esc(gap.action)}` : ''}</li>`).join('')}</ul><p class="tiny">未抓到、未解析或口径不能比较，不等同于公司未披露，也不等同于条件不符。</p></section>` : ''}${review.riskSignals?.length ? `<section class="research-metric-gaps"><b>另外发现的产品风险事实</b><ul>${review.riskSignals.map(risk => `<li>${esc(risk.subject || '')}：${esc(risk.reason || '')}</li>`).join('')}</ul></section>` : ''}${assessment.reasons?.length ? `<p class="tiny">本次判断：${assessment.reasons.map(esc).join('；')}</p>` : ''}${(review.limitations || []).map(text => `<p class="tiny">${esc(text)}</p>`).join('')}</div>`;
}
function researchInlineHtml(review) { return review ? `<details class="research-result-inline"><summary>产品指标与公司经营 · ${esc(researchStatusLabel(review.assessment?.status || review.status))}</summary>${researchReviewHtml(review)}</details>` : ''; }
function researchInspectButton(symbol, origin = 'agency') { return `<button type="button" class="table-action" data-research-symbol="${esc(symbol)}" data-research-origin="${esc(origin)}">经营与产品资料</button>`; }
function researchInspectionRows(origin) {
  if (origin.startsWith('agency')) {
    const result = state?.agencyPool?.lastResult || {};
    return Object.keys(agencyPoolCategories).flatMap(key => result[key] || []);
  }
  return [];
}
function renderResearchInspection() {
  const current = researchRulesUi.inspection;
  if (!current) return;
  $('research-metrics-title').textContent = `${current.name || current.symbol} · 经营与产品资料`;
  $('research-metrics-subtitle').textContent = `${current.symbol.toUpperCase()} · 只读原始资料；下方只编辑筛选规则`;
  $('research-metrics-content').innerHTML = current.review ? researchReviewHtml(current.review) : '<p class="tiny">正在取得资料；未知值不会按 0 参与判断。</p>';
  researchRuleEditor('research-inspect-rules', { get: () => current.query, set: value => { current.query = value; current.dirty = true; $('research-metrics-status').textContent = '查看规则已更改，请点击“按规则重新判断”。采用规则只更新筛选编辑区，不修改既有成员的已保存条件。'; }, showPath: true, busy: current.busy });
  for (const id of ['research-metrics-evaluate', 'research-metrics-products', 'research-metrics-retry', 'research-metrics-apply']) $(id).disabled = !!current.busy;
  $('research-metrics-apply').classList.toggle('hidden', current.origin?.startsWith('agency') !== false);
}
async function inspectResearchMetrics({ includeProducts, force = false } = {}) {
  const current = researchRulesUi.inspection;
  if (!current || current.busy) return;
  const error = researchRuleError(current.query);
  if (error) { $('research-metrics-error').textContent = error; return; }
  current.busy = true; $('research-metrics-error').textContent = '';
  current.includeProducts = includeProducts ?? (current.query.path === 'product' || current.includeProducts);
  $('research-metrics-status').textContent = current.includeProducts ? '正在读取公司经营数据与产品报告，原文解析可能需要稍候…' : '正在读取公司经营数据…';
  renderResearchInspection();
  try {
    const review = await api('research:inspect', { symbol: current.symbol, research: current.query, includeProducts: !!current.includeProducts, force });
    if (researchRulesUi.inspection !== current) return;
    current.review = review; current.dirty = false;
    $('research-metrics-status').textContent = '资料已更新。本次查看不改变账户或候选资格；自动交易已停用研究条件。';
  } catch (error) {
    if (researchRulesUi.inspection !== current) return;
    $('research-metrics-error').textContent = error.message;
    $('research-metrics-status').textContent = current.review ? '读取失败，下方保留上次资料，不能视为本次核验通过。' : '读取失败，未取得可用资料。';
  } finally {
    if (researchRulesUi.inspection === current) { current.busy = false; renderResearchInspection(); }
  }
}
async function openResearchMetrics(symbol, origin = 'agency') {
  await loadScreenMeta();
  const row = researchInspectionRows(origin).find(row => row.symbol === symbol);
  const member = origin.startsWith('agency') ? agencyOwner(symbol)?.members.find(item => item.symbol === symbol) : null;
  const chosen = origin === 'agency-member' ? member?.entryConditions?.research : agencyPoolResearch();
  const review = origin === 'agency-member' ? null : row?.researchReview;
  const query = structuredClone(chosen || review?.query || member?.entryConditions?.research || { version: 1, enabled: false, path: 'company', rules: [] });
  const current = { session: ++researchRulesUi.session, symbol, name: row?.name || state?.quotes?.[symbol]?.name, origin, query, review, busy: false, dirty: false, includeProducts: !!review?.productMetrics?.products?.length };
  researchRulesUi.inspection = current; $('research-metrics-error').textContent = '';
  $('research-metrics-status').textContent = review ? '正在显示筛选时保存的资料；可点击“按规则重新判断”核对当前资料。' : '';
  renderResearchInspection(); $('research-metrics-dialog').showModal();
  if (!review) await inspectResearchMetrics({ includeProducts: query.path === 'product' });
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-research-symbol]');
  if (button) action(() => openResearchMetrics(button.dataset.researchSymbol, button.dataset.researchOrigin));
});
$('research-metrics-close').addEventListener('click', () => $('research-metrics-dialog').close());
$('research-metrics-dialog').addEventListener('close', () => { researchRulesUi.inspection = null; });
$('research-metrics-evaluate').addEventListener('click', () => action(() => inspectResearchMetrics()));
$('research-metrics-products').addEventListener('click', () => action(() => inspectResearchMetrics({ includeProducts: true })));
$('research-metrics-retry').addEventListener('click', () => action(() => inspectResearchMetrics({ force: true })));
$('research-metrics-apply').addEventListener('click', () => {
  const current = researchRulesUi.inspection;
  if (!current || current.busy) return;
  $('research-metrics-status').textContent = '自动交易已停用研究条件，此处仅供查看，不能应用为自动入池或开仓门槛。';
});
