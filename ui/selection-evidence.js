'use strict';
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

function selectionEvidenceRecordHtml(record) {
  const kind = screenMeta?.evidenceKinds?.[record.kind];
  const ranking = ['mainRank', 'segmentRank'].includes(record.kind);
  return `<article class="selection-evidence-record"><div><b>${esc(kind?.label || record.kind)} · ${esc(kind?.values?.[record.value] || record.value)}</b><span class="reason">${esc(selectionEvidenceReview(record.reviewState))}</span></div><p>研究对象：${esc(record.subject || '未填写')}</p><p>${esc(record.sourceTitle || '来源标题未填写')} · 发布 ${esc(record.publishedAt || '未填写')} · ${esc(record.period || '报告区间未填写')}</p><p class="tiny">核验 ${esc(record.reviewedAt || '未填写')} · 有效至 ${esc(record.validUntil || '未填写')}${ranking ? ` · ${esc(record.statisticYear || '年度未填')} / ${esc(record.market || '市场未填')} / ${esc(record.geography || '地域未填')} · 排名 ${esc(record.rank ?? '未填')} · ${esc(({ sales: '销售额', volume: '销量', marketShare: '市场份额' })[record.metric] || '指标未填')} · ${record.coverage === 'allCompetitors' ? '全部竞争者' : record.coverage === 'listedOnly' ? '仅上市公司' : '竞争者覆盖未填'}${record.kind === 'segmentRank' ? ` · 业务收入占比 ${esc(record.revenueSharePct ?? '未填')}%` : ''}` : ''}</p>${record.url ? `<p class="selection-evidence-url">${esc(record.url)}</p>` : ''}${record.quote ? `<blockquote>${esc(record.quote)}</blockquote>` : ''}${record.notes ? `<p class="tiny">核验备注：${esc(record.notes)}</p>` : ''}</article>`;
}
