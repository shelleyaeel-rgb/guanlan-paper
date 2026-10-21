'use strict';
const selectionEvidenceUi = { symbol: '', records: [], busy: false, loadId: 0, pendingPage: 1, failedPage: 1 };
const selectionEvidenceStatus = value => ({ pass: '符合', pending: '待核验', fail: '不符' }[value] || '待核验');
const selectionEvidenceReview = value => ({ confirmed: '已人工核验', draft: '草稿', disputed: '存在争议' }[value] || '草稿');

const industryEditors = new Map();
const industryScopes = { main: '主行业排名', segment: '重要细分行业排名', either: '主行业或重要细分行业，任一路径满足' };
function industryDefaults() { return { version: 1, scope: 'either', mainRankMax: 3, segmentRankMax: 1, minSegmentRevenuePct: 30, ...(typeof screenMeta !== 'undefined' ? screenMeta?.industry?.defaults : {}) }; }
function industryRuleLabels(query) {
  if (!query) return [];
  const main = `主营行业排名 ≤ ${query.mainRankMax ?? '未填'}`, segment = `细分业务排名 ≤ ${query.segmentRankMax ?? '未填'} 且营收占比 ≥ ${query.minSegmentRevenuePct ?? '未填'}%`;
  return [`行业指标：${query.scope === 'main' ? main : query.scope === 'segment' ? segment : `满足其一（${main}；${segment}）`}`];
}
function industryRuleError(query) {
  if (!query) return '';
  if (query.version !== 1 || !Object.hasOwn(industryScopes, query.scope)) return '请选择行业排名的判断范围。';
  if (!Number.isInteger(query.mainRankMax) || query.mainRankMax < 1 || query.mainRankMax > 100000 || !Number.isInteger(query.segmentRankMax) || query.segmentRankMax < 1 || query.segmentRankMax > 100000) return '行业排名阈值须填写 1 至 100000 之间的整数。';
  if (!Number.isFinite(query.minSegmentRevenuePct) || query.minSegmentRevenuePct < 0 || query.minSegmentRevenuePct > 100) return '细分业务收入占比须填写 0 至 100 之间的数值。';
  return '';
}
function industryRuleEditor(rootId, options) {
  const root = $(rootId); if (!root) return;
  const config = { ...industryEditors.get(rootId), ...options }; industryEditors.set(rootId, config);
  const value = config.get(), legacy = config.legacy?.(), mode = value ? 'filter' : legacy ? 'legacy' : 'observe';
  const signature = JSON.stringify({ value, legacy, busy: !!config.busy, source: config.source });
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  const thresholds = value || industryDefaults();
  root.innerHTML = `<div class="research-rule-heading"><h3>行业原始指标</h3><label>行业资料用途<select data-industry-edit="mode" aria-label="行业资料用途"><option value="observe" ${mode === 'observe' ? 'selected' : ''}>只观察 · 不限制候选</option><option value="filter" ${mode === 'filter' ? 'selected' : ''}>按排名与收入占比筛选</option>${config.legacy ? `<option value="legacy" ${mode === 'legacy' ? 'selected' : ''}>兼容旧行业龙头条件</option>` : ''}</select></label></div><p class="tiny">${config.source === 'manual' ? '使用下方证据库中已人工核验的行业排名记录。' : '由程序获取公开披露资料并核对排名来源。'} 排名须有市场、地域、统计年度和比较指标。当前没有独立的行业景气指标。</p>${mode === 'filter' ? `<div class="screen-evidence-options"><label>判断范围<select data-industry-edit="scope" aria-label="行业判断范围">${Object.entries(industryScopes).map(([key, label]) => `<option value="${key}" ${thresholds.scope === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label></div><div class="screen-evidence-options">${[['mainRankMax', '主行业排名至多', 1, '', 1], ['segmentRankMax', '细分行业排名至多', 1, '', 1], ['minSegmentRevenuePct', '细分业务收入占比至少（%）', 0, 100, 'any']].map(([key, label, min, max, step]) => `<label>${label}<input type="number" data-industry-edit="${key}" aria-label="${label}" min="${min}" ${max !== '' ? `max="${max}"` : ''} step="${step}" value="${esc(thresholds[key] ?? '')}"></label>`).join('')}</div><p class="tiny">默认 3 / 1 / 30% 是可编辑的研究偏好，未经收益验证。仅使用所选路径的阈值；缺失、过期或口径不完整的排名列为待核验。修改只影响本次筛选，已有成员保存的条件继续生效。</p>` : `<p class="tiny">${mode === 'legacy' ? '下方旧行业龙头条件正在生效；切换为原始指标会替换本次查询的旧条件，已有成员条件不变。' : '当前不增加行业排名门槛；只有主动选择筛选后才保存行业条件。'}</p>`}<p class="agency-form-error" data-industry-error role="status">${esc(industryRuleError(value))}</p>`;
  root.querySelectorAll('input,select').forEach(element => { element.disabled = !!config.busy; });
  if (root.dataset.bound) return; root.dataset.bound = 'true';
  function update(event) {
    const active = industryEditors.get(rootId), part = event.target.dataset.industryEdit;
    if (!part || active.busy) return;
    let current = structuredClone(active.get() || industryDefaults());
    if (part === 'mode') current = event.target.value === 'filter' ? current : undefined;
    else current[part] = part === 'scope' ? event.target.value : event.target.value === '' ? null : Number(event.target.value);
    active.set(current, part === 'mode' ? event.target.value : 'filter', part);
    if (!['mode', 'scope'].includes(part)) {
      root.dataset.signature = JSON.stringify({ value: active.get(), legacy: active.legacy?.(), busy: !!active.busy, source: active.source });
      root.querySelector('[data-industry-error]').textContent = industryRuleError(current); return;
    }
    industryRuleEditor(rootId, active);
  }
  root.addEventListener('change', update);
  root.addEventListener('input', event => { if (!['mode', 'scope'].includes(event.target.dataset.industryEdit)) update(event); });
}
function industryReviewHtml(review, source = 'automatic') {
  if (!review) return '';
  const relation = value => ({ 'issuer-disclosure': '公司公开披露', 'issuer-citation': '公司引用第三方', 'issuer-cites-third-party': '公司引用第三方，未独立取得第三方全文', 'independent-third-party': '已取得第三方原文', 'third-party-direct': '第三方原始资料', 'third-party': '第三方资料', manual: '人工核验记录', 'manual-record': '人工核验记录' })[value] || value || '来源关系未标注';
  const metric = value => ({ sales: '销售额', volume: '销量', marketShare: '市场份额' })[value] || value || '比较指标缺失';
  return `<details class="industry-review research-result-inline" data-industry-status="${esc(review.status || 'pending')}"><summary>行业原始指标 · ${esc(selectionEvidenceStatus(review.status))}</summary><p class="tiny">${source === 'manual' ? '人工核验记录' : '公开资料程序核验'} · ${esc(industryScopes[review.scope] || '行业排名')} · 核验 ${esc(timeText(review.checkedAt))}</p>${review.reason ? `<p>${esc(review.reason)}</p>` : ''}${review.rows?.length ? `<div class="table-wrap"><table class="research-metric-table"><thead><tr><th>比较范围</th><th>排名与收入占比</th><th>判断与来源</th></tr></thead><tbody>${review.rows.map(row => `<tr><td><b>${esc(row.market || '市场缺失')}</b><small>地域：${esc(row.geography || '缺失')}</small><small>统计年度：${esc(row.statisticYear ?? '缺失')}</small><small>比较指标：${esc(metric(row.metric))}</small><small>竞争者覆盖：${esc(({ allCompetitors: '全部竞争者', listedOnly: '仅上市公司', listedCompanies: '仅上市公司' })[row.coverage] || row.coverage || '缺失')}</small></td><td>排名：${esc(row.rank ?? '缺失')}<small>细分业务收入占比：${row.revenueSharePct == null ? '缺失' : `${esc(row.revenueSharePct)}%`}</small></td><td><b>${esc(selectionEvidenceStatus(row.status))}</b>${row.reason ? `<small>${esc(row.reason)}</small>` : ''}${row.mainStatus ? `<small>主行业路径：${esc(selectionEvidenceStatus(row.mainStatus))}</small>` : ''}${row.segmentStatus ? `<small>细分路径：${esc(selectionEvidenceStatus(row.segmentStatus))}</small>` : ''}<small>${esc(relation(row.sourceRelation))}</small>${row.records?.length ? `<details><summary>依据与原文 · ${row.records.length} 条</summary>${row.records.map(record => source === 'manual' ? selectionEvidenceRecordHtml(record) : typeof agencyResearchRecordHtml === 'function' ? agencyResearchRecordHtml(record) : selectionEvidenceRecordHtml(record)).join('')}</details>` : '<small>尚无可展示的来源记录。</small>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="tiny">尚无可用的行业排名记录；未知不等于排名为 0，也不等于公司行业地位差。</p>'}<p class="tiny">这里核验历史排名与收入占比，不能据此推断未来行业景气或投资收益。</p></details>`;
}

function selectionEvidenceMetaReady() {
  return !!screenMeta?.evidenceKinds && !!screenMeta?.evidenceConditions;
}
function renderScreenEvidenceControls() {
  const ready = selectionEvidenceMetaReady(), evidence = screenQuery.evidence || {};
  $('screen-evidence-conditions').innerHTML = ready ? Object.entries(screenMeta.evidenceConditions).map(([key, label]) => `<label class="check"><input type="checkbox" data-evidence-condition="${esc(key)}" ${evidence.conditions?.includes(key) ? 'checked' : ''}>${esc(label)}</label>`).join('') : '';
  $('screen-evidence-leadership').value = evidence.leadership || '';
  $('screen-evidence-share').value = evidence.minSegmentRevenuePct ?? 30;
  industryRuleEditor('screen-industry-controls', { get: () => screenQuery.evidence?.industry, legacy: () => screenQuery.evidence?.leadership, source: 'manual', busy: screenBusy || !ready, set: (industry, mode) => {
    const current = { ...(screenQuery.evidence || {}) }; delete current.industry; delete current.leadership; delete current.minSegmentRevenuePct;
    if (industry) current.industry = industry;
    else if (mode === 'legacy') { current.leadership = 'either'; current.minSegmentRevenuePct = 30; }
    if (current.conditions?.length || current.industry || current.leadership) screenQuery.evidence = current; else delete screenQuery.evidence;
    $('screen-evidence-leadership').value = current.leadership || ''; $('screen-evidence-share').value = current.minSegmentRevenuePct ?? 30;
    screenChanged();
  } });
  $('screen-evidence-note').textContent = ready ? '自定义选股标签使用有来源、在有效期内且已人工核验的记录；自动交易页的“四策略候选池”由程序收集并核验资料，无需在此填写。产品前景需同一研究对象四项完整；行业排名须明确市场、地域和统计口径，只有启用条件后才按填写的阈值筛选。研究证据反映当前核验状态，不能作为历史回测证据。' : '当前服务未提供研究标签元数据，数值筛选仍可使用。';
  syncScreenEvidenceBusy();
}
function syncScreenEvidenceBusy() {
  const ready = selectionEvidenceMetaReady();
  document.querySelectorAll('#screen-evidence-controls input,#screen-evidence-controls select,#screen-evidence-controls button').forEach(el => { el.disabled = screenBusy || !ready; });
  $('screen-evidence-share').disabled = screenBusy || !ready || !['either', 'segmentLeader'].includes(screenQuery.evidence?.leadership);
  $('screen-evidence-manage').disabled = screenBusy || !ready;
  document.querySelectorAll('[data-evidence-symbol]').forEach(el => { el.disabled = screenBusy || !ready; });
}
function screenEvidenceChanged(event) {
  const conditions = [...document.querySelectorAll('[data-evidence-condition]:checked')].map(el => el.dataset.evidenceCondition);
  const leadership = $('screen-evidence-leadership').value;
  const share = $('screen-evidence-share').value;
  const industry = event?.target?.id === 'screen-evidence-leadership' && leadership ? undefined : screenQuery.evidence?.industry;
  if (conditions.length || leadership || industry) screenQuery.evidence = { conditions, ...(industry ? { industry } : leadership ? { leadership, minSegmentRevenuePct: share === '' ? null : Number(share) } : {}) };
  else delete screenQuery.evidence;
  screenChanged(); renderScreenEvidenceControls();
}
function applyFinancialQualityTemplate() {
  if (screenBusy || !selectionEvidenceMetaReady()) return;
  const rules = screenMeta.financialQualityRules || [
    { field: 'annualProfitableYears', op: 'gte', value: 3 }, { field: 'annualRoeAverage', op: 'gte', value: 10 },
    { field: 'annualRoeLatest', op: 'gte', value: 8 }, { field: 'annualCashPositiveYears', op: 'gte', value: 2 },
    { field: 'annualCashSum', op: 'gt', value: 0 }, { field: 'debtRatio', op: 'lte', value: 60 }, { field: 'latestAdjustedProfit', op: 'gt', value: 0 }
  ];
  if (rules.some(rule => !screenMeta.fields[rule.field])) { $('screen-evidence-note').textContent = '当前服务缺少模板所需的年度财务指标，请更新服务后使用。'; return; }
  const merged = [...new Map([...screenPersonalRules, ...structuredClone(rules)].map(rule => [JSON.stringify(rule), rule])).values()];
  if (new Set([...screenStrategyRules, ...merged].map(rule => JSON.stringify(rule))).size > 30) { $('screen-evidence-note').textContent = '加入模板后超过 30 项数值条件，请先移除部分条件。'; return; }
  screenPersonalRules = merged;
  const previous = screenQuery.evidence;
  screenQuery.evidence = { conditions: [...new Set([...(previous?.conditions || []), 'productOutlook', 'financialReview'])], ...(previous?.industry ? { industry: previous.industry } : { leadership: previous?.leadership || 'either', minSegmentRevenuePct: Math.max(30, previous?.minSegmentRevenuePct ?? 30) }) };
  screenChanged(false); renderScreenRules();
  $('screen-text-status').textContent = '已带入“财务质量与行业龙头”个人条件：普通非金融企业的研究起点。保留策略与其他个人条件；尚未筛选，请检查阈值后开始选股。' + (screenTextPending ? '输入文字仍待应用或清空。' : '');
}

function selectionEvidenceRecordHtml(record, editable = false) {
  const kind = screenMeta?.evidenceKinds?.[record.kind];
  const ranking = ['mainRank', 'segmentRank'].includes(record.kind);
  return `<article class="selection-evidence-record"><div><b>${esc(kind?.label || record.kind)} · ${esc(kind?.values?.[record.value] || record.value)}</b><span class="reason">${esc(selectionEvidenceReview(record.reviewState))}</span></div><p>研究对象：${esc(record.subject || '未填写')}</p><p>${esc(record.sourceTitle || '来源标题未填写')} · 发布 ${esc(record.publishedAt || '未填写')} · ${esc(record.period || '报告区间未填写')}</p><p class="tiny">核验 ${esc(record.reviewedAt || '未填写')} · 有效至 ${esc(record.validUntil || '未填写')}${ranking ? ` · ${esc(record.statisticYear || '年度未填')} / ${esc(record.market || '市场未填')} / ${esc(record.geography || '地域未填')} · 排名 ${esc(record.rank ?? '未填')} · ${esc(({ sales: '销售额', volume: '销量', marketShare: '市场份额' })[record.metric] || '指标未填')} · ${record.coverage === 'allCompetitors' ? '全部竞争者' : record.coverage === 'listedOnly' ? '仅上市公司' : '竞争者覆盖未填'}${record.kind === 'segmentRank' ? ` · 业务收入占比 ${esc(record.revenueSharePct ?? '未填')}%` : ''}` : ''}</p>${record.url ? `<p class="selection-evidence-url">${esc(record.url)}</p>` : ''}${record.quote ? `<blockquote>${esc(record.quote)}</blockquote>` : ''}${record.notes ? `<p class="tiny">核验备注：${esc(record.notes)}</p>` : ''}${editable ? `<div class="selection-evidence-record-actions"><button type="button" class="text-button" data-evidence-edit="${esc(record.id)}">编辑</button><button type="button" class="text-button" data-evidence-open="${esc(record.id)}" ${record.url ? '' : 'disabled'}>打开已存原文</button><button type="button" class="text-button" data-evidence-delete="${esc(record.id)}">删除</button></div>` : ''}</article>`;
}
function renderSelectionEvidenceDetails(evaluation) {
  if (!evaluation) return '<p class="tiny">本次未设置研究标签条件。</p>';
  return `<div class="selection-evidence-detail"><p><b>${esc(selectionEvidenceStatus(evaluation.status))}</b> · 核验 ${esc(timeText(evaluation.checkedAt))}</p>${industryReviewHtml(evaluation.industryReview, 'manual')}${(evaluation.checks || []).filter(check => !evaluation.industryReview || check.key !== 'industry').map(check => `<section class="selection-evidence-check"><b>${esc(check.label || check.key)} · ${esc(selectionEvidenceStatus(check.status))}</b><p>${esc(check.reason || '')}</p>${check.records?.length ? `<details><summary>依据快照 · ${check.records.length} 条</summary>${check.records.map(record => selectionEvidenceRecordHtml(record)).join('')}</details>` : '<p class="tiny">暂无可用证据。</p>'}</section>`).join('')}</div>`;
}
function renderSelectionAnnualReports(row) {
  const reports = row.financeAnnualReports || [];
  if (!reports.length) return '';
  return `<details class="screen-checks screen-annual-reports"><summary>完整年度依据 · ${reports.length} 期</summary>${reports.map(report => `<div><b>${esc(report.reportDate)}</b> · 公告 ${esc(report.noticeDate)}<br>更新 ${esc(report.updateDate || '未提供')} · ${esc(report.currency || '币种未提供')}<br>扣非归母净利润 ${report.adjustedProfit == null ? '缺失' : num(report.adjustedProfit / 1e8)} 亿原币<br>经营现金流 ${report.operatingCash == null ? '缺失' : num(report.operatingCash / 1e8)} 亿原币<br>年度加权 ROE ${report.roe == null ? '缺失' : num(report.roe) + '%'}</div>`).join('')}</details>`;
}
function renderScreenEvidenceResults(result, search = '') {
  const summary = result.evidenceScreen;
  $('screen-evidence-summary').classList.toggle('hidden', !summary);
  $('screen-evidence-summary').textContent = summary ? `研究标签：符合 ${summary.passed ?? 0} 只 · 待核验 ${summary.pending ?? 0} 只 · 不符 ${summary.failed ?? 0} 只 · 检查 ${timeText(summary.checkedAt)}。仅符合者进入正常结果；标签通过不代表通过公告检查或自动交易策略。` : '';
  if (!summary) { $('screen-evidence-results').innerHTML = ''; return; }
  const currentOpen = new Set([...$('screen-evidence-results').querySelectorAll('details[data-evidence-group][open]')].map(el => el.dataset.evidenceGroup));
  $('screen-evidence-results').innerHTML = [['pending', '待核验', result.evidencePendingRows || []], ['failed', '不符', result.evidenceFailedRows || []]].map(([key, label, all]) => {
    if (!all.length) return '';
    const rows = all.filter(row => !search || row.symbol.toLowerCase().includes(search) || row.name.toLowerCase().includes(search));
    const pages = Math.max(1, Math.ceil(rows.length / screenSize)), pageKey = key + 'Page';
    selectionEvidenceUi[pageKey] = Math.min(selectionEvidenceUi[pageKey], pages);
    const page = selectionEvidenceUi[pageKey];
    return `<details class="screen-evidence-group" data-evidence-group="${key}" ${currentOpen.has(key) ? 'open' : ''}><summary>研究标签${label} · ${all.length} 只</summary><p class="tiny">这些股票不进入正常候选，也不加入批量自动交易。${key === 'pending' ? '补齐来源、口径和人工核验后重新筛选。' : '逐项查看不符合的条件和依据。'}</p>${rows.length ? `<div class="table-wrap">${table(['股票 / 代码', '核验结论与依据', '操作'], rows.slice((page - 1) * screenSize, page * screenSize).map(row => [ `<strong>${esc(row.name)}</strong><small>${esc(row.symbol.toUpperCase())}</small>`, renderSelectionEvidenceDetails(row.selectionEvidence), `<div class="selection-evidence-record-actions"><button type="button" class="table-action" data-screen-open="${esc(row.symbol)}">查看股票</button><button type="button" class="table-action" data-evidence-symbol="${esc(row.symbol)}">维护证据</button></div>` ]))}</div>` : '<p class="tiny">没有符合搜索条件的股票。</p>'}<div class="screen-pagination"><span class="tiny">第 ${page} / ${pages} 页 · ${rows.length} 只</span><div><button type="button" class="subtle" data-evidence-page="${key}" data-step="-1" ${page <= 1 ? 'disabled' : ''}>上一页</button><button type="button" class="subtle" data-evidence-page="${key}" data-step="1" ${page >= pages ? 'disabled' : ''}>下一页</button></div></div></details>`;
  }).join('');
}

function normalizeSelectionEvidenceSymbol(value) {
  const text = String(value || '').trim().toLowerCase();
  if (/^(sh|sz)\d{6}$/.test(text)) return text;
  if (/^\d{6}$/.test(text)) return (text[0] === '6' ? 'sh' : 'sz') + text;
  throw Error('请输入沪深股票代码，例如 sh600519 或 600519');
}
function setSelectionEvidenceBusy(busy) {
  selectionEvidenceUi.busy = busy;
  document.querySelectorAll('#selection-evidence-dialog button,#selection-evidence-dialog input,#selection-evidence-dialog select,#selection-evidence-dialog textarea').forEach(el => { el.disabled = busy; });
  if (!busy) document.querySelectorAll('[data-evidence-open]').forEach(el => { el.disabled = !selectionEvidenceUi.records.find(record => record.id === el.dataset.evidenceOpen)?.url; });
}
async function selectionEvidenceAction(fn) {
  if (selectionEvidenceUi.busy) return;
  $('selection-evidence-error').textContent = '';
  try { await fn(); } catch (error) { $('selection-evidence-error').textContent = error.message; $('selection-evidence-error').scrollIntoView({ block: 'nearest' }); } finally { setSelectionEvidenceBusy(false); }
}
function renderSelectionEvidenceList() {
  $('selection-evidence-list').innerHTML = selectionEvidenceUi.records.length ? selectionEvidenceUi.records.map(record => selectionEvidenceRecordHtml(record, true)).join('') : '<p class="tiny">该股票尚无研究证据。可先保存草稿，再补齐来源与人工核验。</p>';
  $('selection-evidence-status').textContent = `${selectionEvidenceUi.symbol.toUpperCase()} · ${selectionEvidenceUi.records.length} 条证据；更改后须重新筛选。`;
}
async function loadSelectionEvidence() {
  const symbol = normalizeSelectionEvidenceSymbol($('selection-evidence-symbol').value), request = ++selectionEvidenceUi.loadId;
  selectionEvidenceUi.symbol = ''; selectionEvidenceUi.records = [];
  $('selection-evidence-form').classList.add('hidden'); $('selection-evidence-list').innerHTML = '';
  $('selection-evidence-status').textContent = '正在加载研究证据…'; setSelectionEvidenceBusy(true);
  try {
    const records = await api('evidence:list', { symbol });
    if (request !== selectionEvidenceUi.loadId) return;
    if (!Array.isArray(records)) throw Error('研究证据返回格式无效，请重试');
    selectionEvidenceUi.symbol = symbol; selectionEvidenceUi.records = records;
    $('selection-evidence-symbol').value = symbol; renderSelectionEvidenceList();
  } catch (error) { $('selection-evidence-status').textContent = '研究证据未能加载。'; throw error; }
  finally { setSelectionEvidenceBusy(false); }
}
async function openSelectionEvidence(symbol = '') {
  if (screenBusy || !selectionEvidenceMetaReady()) return;
  $('selection-evidence-error').textContent = ''; $('selection-evidence-form').classList.add('hidden');
  if (!$('selection-evidence-dialog').open) $('selection-evidence-dialog').showModal();
  if (symbol) { $('selection-evidence-symbol').value = symbol; await selectionEvidenceAction(loadSelectionEvidence); }
  else $('selection-evidence-symbol').focus();
}
function renderSelectionEvidenceKind(value) {
  const kind = $('selection-evidence-kind').value, meta = screenMeta.evidenceKinds[kind];
  $('selection-evidence-value').innerHTML = Object.entries(meta?.values || {}).map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('');
  if (meta?.values?.[value]) $('selection-evidence-value').value = value;
  else if (meta?.values?.unknown) $('selection-evidence-value').value = 'unknown';
  $('selection-evidence-ranking').classList.toggle('hidden', !['mainRank', 'segmentRank'].includes(kind));
  $('selection-evidence-share-label').classList.toggle('hidden', kind !== 'segmentRank');
  $('selection-evidence-kind-note').textContent = kind === 'financialReview'
    ? '财务复核请说明：公司是否属于普通非金融企业、审计意见、偿债与逾期情况、重大会计更正，以及量化模板是否适用。不能仅凭财务数值通过就标记“复核通过”。'
    : ['mainRank', 'segmentRank'].includes(kind)
      ? '此处记录原始排名；筛选阈值在“行业原始指标”编辑。兼容旧规则仍按主行业前三、细分第 1 名判断。须明确全国或全球市场、地域、统计年度和销量 / 销售额 / 市占率口径；区域排名和仅上市公司排名不代表全行业。细分业务还需收入占比。'
      : '产品前景综合条件要求同一研究对象具备：需求支持、已量产或形成收入、优势已证实、前景风险已核验且未发现重大不利。历史增长、规划和试用不能单独证明未来前景。';
}
const selectionEvidenceFields = { subject: 'subject', sourceTitle: 'source-title', url: 'url', publishedAt: 'published-at', period: 'period', reviewedAt: 'reviewed-at', validUntil: 'valid-until', quote: 'quote', notes: 'notes', rank: 'rank', market: 'market', geography: 'geography', revenueSharePct: 'revenue-share-pct', statisticYear: 'statistic-year' };
function editSelectionEvidence(record = {}) {
  if (!selectionEvidenceUi.symbol) throw Error('请先加载股票代码');
  $('selection-evidence-form').reset(); $('selection-evidence-form').classList.remove('hidden');
  $('selection-evidence-editor-title').textContent = `${record.id ? '编辑' : '新建'}证据 · ${selectionEvidenceUi.symbol.toUpperCase()}`;
  $('selection-evidence-id').value = record.id || '';
  $('selection-evidence-kind').innerHTML = Object.entries(screenMeta.evidenceKinds).map(([key, item]) => `<option value="${esc(key)}">${esc(item.label)}</option>`).join('');
  if (record.kind) $('selection-evidence-kind').value = record.kind;
  renderSelectionEvidenceKind(record.value);
  $('selection-evidence-review-state').value = record.reviewState || 'draft';
  for (const [key, id] of Object.entries(selectionEvidenceFields)) $('selection-evidence-' + id).value = record[key] ?? '';
  $('selection-evidence-metric').value = record.metric || '';
  $('selection-evidence-coverage').value = record.coverage || '';
  $('selection-evidence-form').scrollIntoView({ block: 'start' });
}
async function saveSelectionEvidence() {
  if (screenBusy) throw Error('本次选股进行中，请完成后再保存证据');
  const record = { symbol: selectionEvidenceUi.symbol, kind: $('selection-evidence-kind').value, value: $('selection-evidence-value').value, reviewState: $('selection-evidence-review-state').value };
  if ($('selection-evidence-id').value) record.id = $('selection-evidence-id').value;
  for (const [key, id] of Object.entries(selectionEvidenceFields)) {
    const value = $('selection-evidence-' + id).value.trim();
    if (['rank', 'revenueSharePct', 'statisticYear'].includes(key)) { if (value !== '') record[key] = Number(value); }
    else record[key] = value;
  }
  if (['mainRank', 'segmentRank'].includes(record.kind)) { if ($('selection-evidence-metric').value) record.metric = $('selection-evidence-metric').value; if ($('selection-evidence-coverage').value) record.coverage = $('selection-evidence-coverage').value; }
  else for (const key of ['rank', 'market', 'geography', 'revenueSharePct', 'statisticYear']) delete record[key];
  if (record.kind !== 'segmentRank') delete record.revenueSharePct;
  setSelectionEvidenceBusy(true);
  const saved = await api('evidence:save', record);
  screenChanged(false);
  selectionEvidenceUi.records = [...selectionEvidenceUi.records.filter(item => item.id !== saved.id), saved];
  renderSelectionEvidenceList(); $('selection-evidence-form').classList.add('hidden');
  $('selection-evidence-status').textContent = `${saved.symbol.toUpperCase()} · 证据已保存。上次筛选结果已标记待更新，请重新点击“开始选股”。`;
}
$('screen-evidence-conditions').addEventListener('change', screenEvidenceChanged);
$('screen-evidence-leadership').addEventListener('change', screenEvidenceChanged);
$('screen-evidence-share').addEventListener('change', screenEvidenceChanged);
$('screen-quality-template').addEventListener('click', applyFinancialQualityTemplate);
$('screen-evidence-manage').addEventListener('click', () => openSelectionEvidence());
$('selection-evidence-close').addEventListener('click', () => { if (!selectionEvidenceUi.busy) $('selection-evidence-dialog').close(); });
$('selection-evidence-dialog').addEventListener('cancel', event => { if (selectionEvidenceUi.busy) event.preventDefault(); });
$('selection-evidence-search-form').addEventListener('submit', event => { event.preventDefault(); selectionEvidenceAction(loadSelectionEvidence); });
$('selection-evidence-new').addEventListener('click', () => selectionEvidenceAction(async () => {
  if (normalizeSelectionEvidenceSymbol($('selection-evidence-symbol').value) !== selectionEvidenceUi.symbol) await loadSelectionEvidence();
  editSelectionEvidence();
}));
$('selection-evidence-kind').addEventListener('change', () => renderSelectionEvidenceKind());
$('selection-evidence-cancel-edit').addEventListener('click', () => $('selection-evidence-form').classList.add('hidden'));
$('selection-evidence-form').addEventListener('submit', event => { event.preventDefault(); selectionEvidenceAction(saveSelectionEvidence); });
$('selection-evidence-list').addEventListener('click', event => selectionEvidenceAction(async () => {
  const edit = event.target.closest('[data-evidence-edit]'), open = event.target.closest('[data-evidence-open]'), remove = event.target.closest('[data-evidence-delete]');
  if (edit) editSelectionEvidence(selectionEvidenceUi.records.find(record => record.id === edit.dataset.evidenceEdit));
  if (open) { setSelectionEvidenceBusy(true); await api('evidence:open', { id: open.dataset.evidenceOpen }); }
  if (remove) {
    if (screenBusy) throw Error('本次选股进行中，请完成后再删除证据');
    if (remove.dataset.confirm !== 'true') { remove.dataset.confirm = 'true'; remove.textContent = '确认删除'; return; }
    setSelectionEvidenceBusy(true); const removed = await api('evidence:remove', { id: remove.dataset.evidenceDelete });
    if (!removed) throw Error('该证据不存在，请重新加载');
    selectionEvidenceUi.records = selectionEvidenceUi.records.filter(record => record.id !== remove.dataset.evidenceDelete);
    if ($('selection-evidence-id').value === remove.dataset.evidenceDelete) $('selection-evidence-form').classList.add('hidden');
    screenChanged(false); renderSelectionEvidenceList();
    $('selection-evidence-status').textContent += ' 证据已删除，上次结果待重新筛选。';
  }
}));
$('page-screener').addEventListener('click', event => {
  const manage = event.target.closest('[data-evidence-symbol]'), page = event.target.closest('[data-evidence-page]');
  if (manage) openSelectionEvidence(manage.dataset.evidenceSymbol);
  if (page) { selectionEvidenceUi[page.dataset.evidencePage + 'Page'] += Number(page.dataset.step); renderScreenResults(); }
});
