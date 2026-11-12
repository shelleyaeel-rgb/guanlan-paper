'use strict';

const agencyUi = { strategyId: 'swing', limitsGroup: null, limitsDirty: false, busy: new Set(), dismissedMigration: null, memberPage: 1, memberGroup: null, reconcileSession: 0, reconcileContext: null, poolPage: 1, poolResultId: null, poolRenderKey: null, screeningMode: 'strategy' };
const agencyModeNames = { running: '运行中', paused: '暂停新开仓', stopped: '全部停止' };
const agencyMemberNames = { active: '活跃监控', standby: '候补 · 低频重选', removing: '退出后移除', closing: '尽快退出' };
const agencyActionNames = { buy: '买入', hold: '持有', sell: '卖出', reduce: '减仓', wait: '等待' };
const agencyDecisionStatus = { executed: '已模拟执行', blocked: '规则拦截', waiting: '继续等待', stale: '条件已变化', request: '正在检查', error: '检查失败', complete: '检查完成', idle: '暂无可检查股票' };
function agencyGroups() { return state?.agency?.groups || []; }
function agencyActiveCandidateLimit() {
  const value = state?.agencyPool?.policy?.candidateSelection?.activeLimitPerGroup
    ?? state?.agencyPool?.policies?.strategy?.candidateSelection?.activeLimitPerGroup;
  return Number.isSafeInteger(value) && value > 0 ? value : 20;
}
function agencyGroup() { return agencyGroups().find(group => group.id === agencyUi.strategyId); }
function agencyOwner(symbol) { return agencyGroups().find(group => (group.members || []).some(member => member.symbol === symbol)); }
function agencyCycles(group) { return Number.isFinite(group.completedCycles) ? group.completedCycles : Array.isArray(group.cycles) ? group.cycles.filter(cycle => cycle.status === 'closed').length : 0; }
function agencyText(value) { return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value); }
function agencyIsRuleDecision(item) {
  return !item.model && !['model', 'llm'].includes(item.decisionMode) && !['model', 'llm'].includes(item.decisionSource)
    && (item.decisionMode === 'rules' || item.decisionSource === 'rules' || Boolean(item.rulesVersion));
}
function agencyDecisionSource(item) {
  if (item.model || ['model', 'llm'].includes(item.decisionMode) || ['model', 'llm'].includes(item.decisionSource)) return '历史模型决策' + (item.model ? ` · ${item.model}` : '');
  if (agencyIsRuleDecision(item)) return `固定规则${item.rulesVersion ? ` · v${item.rulesVersion}` : ''}`;
  return '来源未标注的历史记录';
}
function agencyHistoricalDecisionHtml(item) {
  return item ? `<small class="agency-member-decision">历史决策记录 · ${esc(timeText(item.time))} · ${esc(agencyDecisionSource(item))} · ${esc(agencyDecisionStatus[item.status] || '记录')}：${esc(agencyText(item.reason || item.message))}</small>` : '';
}
function agencyEntryConditionLabels(conditions) {
  if (!conditions) return [];
  if (Array.isArray(conditions.labels)) return [...new Set([...conditions.labels, ...researchRuleLabels(conditions.research), ...performanceLabels(conditions.performance), ...industryRuleLabels(conditions.evidence?.industry)])];
  const meta = typeof screenMeta === 'undefined' ? null : screenMeta;
  const labels = (conditions.rules || []).map(rule => {
    const field = meta?.fields?.[rule.field], target = rule.valueField ? meta?.fields?.[rule.valueField]?.label || rule.valueField : `${rule.value}${field?.unit || ''}`;
    return `${field?.label || rule.field} ${meta?.ops?.[rule.op] || rule.op} ${target}`;
  });
  if (conditions.excludeST) labels.push('排除 ST / 退市风险股票');
  for (const key of conditions.evidence?.conditions || []) labels.push(meta?.evidenceConditions?.[key] || key);
  const leadership = conditions.evidence?.leadership;
  if (leadership) labels.push(({ either: '主行业前三或重要细分行业龙头', mainTop3: '主行业前三', segmentLeader: '重要细分行业龙头' })[leadership] + (leadership !== 'mainTop3' ? `（细分业务营收占比 ≥ ${conditions.evidence.minSegmentRevenuePct ?? 30}%，细分排名第 1）` : ''));
  labels.push(...researchRuleLabels(conditions.research), ...performanceLabels(conditions.performance), ...industryRuleLabels(conditions.evidence?.industry));
  return labels;
}
function agencyEntryCheckHtml(check, held = false) {
  if (!check) return '<small>尚无持续条件检查记录，等待下一轮。</small>';
  if (check.status === 'skipped' && check.skippedBy === 'pool-qualification') {
    return `<div class="agency-entry-check"><b class="muted">历史检查：当时未检查持续条件</b><small>检查 ${esc(timeText(check.checkedAt))}</small><p>当时因严格研究资格未通过而跳过；该研究门槛现已停用。本记录不代表当前开仓状态，等待新的行情与技术检查。</p></div>`;
  }
  const status = ({ pass: '通过', passed: '通过', fail: '不满足', failed: '不满足', pending: '待核验', unavailable: '资料不足', none: '未设置', blocked: '未通过', skipped: '未检查' })[check.status] || (check.passed ? '通过' : '未通过');
  const reasons = Array.isArray(check.reasons) ? check.reasons : check.reason ? [check.reason] : [];
  const failed = check.passed === false || ['fail', 'failed', 'pending', 'unavailable', 'blocked'].includes(check.status);
  return `<div class="agency-entry-check">${researchInlineHtml(check.researchReview)}${performanceReviewHtml(check.performanceReview)}${industryReviewHtml(check.industryReview || check.selectionEvidence?.industryReview, check.conditions?.evidenceMode === 'automatic' ? 'automatic' : 'manual')}<b class="${failed ? 'agency-pending' : 'teal'}">持续开仓条件：${esc(status)}</b><small>检查 ${esc(timeText(check.checkedAt))}</small>${reasons.length ? `<p>${reasons.map(reason => esc(agencyText(reason))).join('；')}</p>` : ''}${held && failed ? '<p class="agency-pending">已有持仓提示：当前不再满足新开仓条件；不会因此直接卖出，仍按原退出规则管理。</p>' : ''}${check.checks?.length ? `<details data-detail-key="entry-check"><summary>逐项检查 · ${check.checks.length} 项</summary>${check.checks.map(item => `<p><b>${esc(item.label || '条件')} · ${esc(({ pass: '通过', fail: '不满足', failed: '不满足', pending: '待核验' })[item.status] || item.status || '')}</b>${item.actual != null ? `<span>实际：${esc(agencyText(item.actual))}</span>` : ''}${item.expected != null ? `<span>要求：${esc(agencyText(item.expected))}</span>` : ''}${item.reason ? `<span>${esc(agencyText(item.reason))}</span>` : ''}</p>`).join('')}</details>` : ''}</div>`;
}
function agencyMemberEntryHtml(member, decisions, held) {
  const poolCheck = member.poolCheck, standby = agencyMemberPhase(member, held) === 'standby';
  const archived = member.legacyResearchConditions || member.legacyPoolConditions;
  const archivedLabels = agencyEntryConditionLabels(archived);
  const archiveHtml = archived ? `<details data-detail-key="archived-research"><summary>原选股条件留档 · 研究条件已停用</summary><p class="tiny">以下是变更前的完整条件快照，仅供追溯；其中研究、财务与估值条件不再参与自动开仓。当前有效条件另列。</p>${archivedLabels.length ? `<ul>${archivedLabels.map(label => `<li>${esc(label)}</li>`).join('')}</ul>` : '<p>未记录可展示的条件。</p>'}</details>` : '';
  const poolHtml = poolCheck ? `<details class="agency-entry-check agency-pool-member"><summary class="muted">历史筛选记录：${esc(({ pass: '通过', pending: '待核验', failed: '不满足' })[poolCheck.status] || poolCheck.status)}</summary><small>${esc(timeText(poolCheck.checkedAt))} · 标准 ${esc(poolCheck.policyVersion || '未标注')}</small>${poolCheck.reasons?.length ? `<p>${poolCheck.reasons.map(reason => esc(agencyText(reason))).join('；')}</p>` : ''}${poolCheck.matchedStrategies?.length ? `<small>符合：${poolCheck.matchedStrategies.map(id => esc(strategyProfile(id).name)).join(' / ')}</small>` : ''}<small>${held ? '持仓继续沿用原退出计划，不因本次复核直接卖出。' : standby ? '当前为候补，等待候选池更新重新筛选与排序；本记录不代表当前可以开仓。' : '记录仅说明当次结果；旧研究门槛已停用，当前能否开仓见最近行情与技术检查。'}</small></details>` : '';
  if (!member.entryConditions) return `<div class="agency-entry-summary">${poolHtml}${archiveHtml}<b>未设置额外行情技术条件</b><small>此成员按内置策略检查，旧研究条件不再参与开仓判断。</small></div>`;
  const conditions = member.entryConditions, labels = agencyEntryConditionLabels(conditions);
  const latestDecision = decisions.find(item => {
    const check = item.executionCheck?.entryConditionsCheck || item.entryConditionsCheck;
    return check?.conditions && JSON.stringify(check.conditions) === JSON.stringify(conditions);
  });
  const latest = latestDecision?.executionCheck?.entryConditionsCheck || latestDecision?.entryConditionsCheck;
  return `<div class="agency-entry-summary">${poolHtml}${archiveHtml}<details data-detail-key="entry-conditions"><summary>有效行情技术条件 · ${labels.length} 项</summary><small>保存 ${esc(timeText(conditions.savedAt))}${conditions.source?.selectedAt ? ` · 筛选 ${esc(timeText(conditions.source.selectedAt))}` : ''}</small>${labels.length ? `<ul>${labels.map(label => `<li>${esc(label)}</li>`).join('')}</ul>` : '<p>未设置额外限制。</p>'}<small>新开仓持续复核；旧研究、财务和估值条件已停用。</small></details>${standby ? '<small>候补期间暂停持续开仓检查，恢复活跃后重新核验。</small>' : agencyEntryCheckHtml(latest, held)}</div>`;
}

const agencyMonitoringNames = { eligible: '本轮开仓检查通过', holding: '持仓管理', paused: '暂停开仓', data: '数据待核验', risk: '风险阻断', funds: '资金或仓位受限', conditions: '等待买点或个人条件', recheck: '待重新检查', unchecked: '尚未检查' };
const agencyPreparationNames = { prepared: '盘前资料已准备 · 等待开市', 'waiting-live': '历史资料已备 · 等待当日行情与基准', ready: '资料就绪 · 等待策略判断', preparing: '正在准备交易资料', error: '数据准备异常', inactive: '当前无需准备开仓资料' };
function agencyMemberPreparationHtml(symbol, strategyId) {
  const item = state.agency?.runtime?.preparation?.members?.find(value => value.symbol === symbol && value.strategyId === strategyId);
  if (!item) return '';
  return `<div class="agency-member-preparation" data-preparation-status="${esc(item.status)}"><b class="${['ready', 'prepared'].includes(item.status) ? 'teal' : item.status === 'inactive' ? 'muted' : 'agency-pending'}">${esc(agencyPreparationNames[item.status] || '等待资料检查')}</b>${item.reason ? `<span>${esc(item.reason)}</span>` : ''}${item.preparedAt ? `<small>资料准备 ${esc(timeText(item.preparedAt))}</small>` : ''}</div>`;
}
function agencyPreparationHtml(preparation) {
  if (!preparation) return '';
  const total = preparation.total || 0, ready = preparation.ready || 0, prepared = preparation.prepared || 0;
  const waiting = preparation.waitingLive || 0, failed = preparation.failed || 0, preparing = preparation.preparing || 0;
  const closed = state.agency?.runtime?.session?.open === false;
  const standbyOnly = !total && agencyGroups().some(group => (group.members || []).some(member => member.mode === 'standby'));
  const title = failed ? `数据准备异常 ${failed} 只${ready + prepared + waiting ? ' · 其余成员独立检查' : ''}`
    : preparing ? '正在准备交易资料' : closed && prepared ? '盘前资料已准备 · 等待开市'
      : waiting ? '历史资料已备 · 等待当日行情与基准' : ready ? '成员资料就绪 · 等待策略判断'
        : total && preparation.inactive === total ? '当前策略均已停止，未准备开仓资料' : standbyOnly ? '暂无需自动准备的成员 · 候补等待重选' : '等待交易资料准备';
  const group = agencyGroup(), modeNote = group?.mode === 'paused' ? '当前策略暂停新开仓；资料准备不会自动启用策略。'
    : group?.mode === 'stopped' ? '当前策略自动买卖已停止；资料准备不会自动启用策略。' : '';
  return `<div data-preparation-summary="${failed ? 'error' : preparing ? 'preparing' : waiting ? 'waiting-live' : closed && prepared ? 'prepared' : ready ? 'ready' : 'idle'}"><b class="${failed || preparing || waiting ? 'agency-pending' : 'teal'}">${esc(title)}</b><span>全部策略 ${total} 只 · 盘前已备 ${prepared} · 等待当日行情 ${waiting} · 资料就绪 ${ready} · 准备中 ${preparing} · 异常 ${failed}${preparation.inactive ? ` · 无需准备 ${preparation.inactive}` : ''}</span><small>${esc(modeNote)}资料就绪仅表示数据检查完成；新开仓还须通过市场环境、策略信号、资金与盘口检查。市场环境改善需至少 120 秒确认，回踩或突破信号仍需至少 60 秒站稳确认。</small></div>`;
}
function agencyMemberPhase(member, held = false) { return ['closing', 'removing'].includes(member.mode) ? 'exiting' : held ? 'held' : member.mode === 'active' ? 'active' : member.mode === 'standby' ? 'standby' : 'exiting'; }
function agencyMemberCounts(group) {
  const held = new Set((group.positions || []).map(position => position.symbol));
  const counts = { active: 0, held: 0, standby: 0, exiting: 0 };
  for (const member of group.members || []) {
    const phase = agencyMemberPhase(member, held.has(member.symbol));
    counts[phase]++;
    // Exit intent is also visible as a separate filter, including held stocks.
    if (phase === 'exiting' && held.has(member.symbol)) counts.held++;
  }
  return counts;
}
function agencyOverviewHtml(groups) {
  if (!groups.length) return '<p class="tiny">正在加载策略股票…</p>';
  return groups.map(group => {
    const counts = agencyMemberCounts(group), held = new Set((group.positions || []).map(position => position.symbol));
    const active = (group.members || []).filter(member => agencyMemberPhase(member, held.has(member.symbol)) === 'active');
    return `<article class="agency-overview-card${group.id === agencyUi.strategyId ? ' is-selected' : ''}" data-agency-overview="${esc(group.id)}"><div class="agency-overview-heading"><button type="button" data-agency-select="${esc(group.id)}" aria-label="查看${esc(group.name)}策略详情">${esc(group.name)}<span aria-hidden="true"> ↗</span></button><span class="${group.mode === 'running' ? 'teal' : 'muted'}">${esc(agencyModeNames[group.mode] || '尚未启用')}</span></div><div class="agency-overview-count"><strong>${active.length}<small> / ${agencyActiveCandidateLimit()}</small></strong><span>活跃候选</span></div><div class="agency-overview-stocks">${active.length ? active.map(member => `<button type="button" data-agency-open="${esc(member.symbol)}"><strong>${esc(state.quotes[member.symbol]?.name || member.poolCheck?.name || member.symbol)}</strong><span>${esc(member.symbol.toUpperCase())}</span></button>`).join('') : '<p class="agency-overview-empty">暂无活跃候选<br><small>等待候选池更新与筛选</small></p>'}</div><div class="agency-overview-footer"><button type="button" data-agency-select="${esc(group.id)}" data-agency-phase="held">持仓 ${counts.held}</button><button type="button" data-agency-select="${esc(group.id)}" data-agency-phase="standby">候补 ${counts.standby}</button>${counts.exiting ? `<button type="button" data-agency-select="${esc(group.id)}" data-agency-phase="exiting">退出 ${counts.exiting}</button>` : ''}</div></article>`;
  }).join('');
}
function agencyCurrentMonitoringCheck(member) { return member.monitoringCheck?.entryPolicyVersion === 1 ? member.monitoringCheck : null; }
function agencyLegacyMonitoringCheck(member) { return !agencyCurrentMonitoringCheck(member) && member.monitoringCheck || member.legacyMonitoringCheck; }
function agencyMonitoringStatus(member, held = false) {
  const phase = agencyMemberPhase(member, held), check = agencyCurrentMonitoringCheck(member);
  return ['standby', 'exiting'].includes(phase) ? phase : Object.hasOwn(agencyMonitoringNames, check?.status) ? check.status : agencyLegacyMonitoringCheck(member) ? 'recheck' : 'unchecked';
}
function agencyUnopenedReason(member, held = false, group = agencyOwner(member.symbol)) {
  if (held) return '';
  const phase = agencyMemberPhase(member, held), check = agencyCurrentMonitoringCheck(member);
  if (phase === 'standby') return member.standbyReason || '当前为候补，等待更新候选池后重新筛选与排序。';
  if (phase === 'exiting') return '已有退出或移除安排，不参与新开仓。';
  if (group?.mode === 'paused') return '本策略已暂停新开仓，恢复运行后才会继续检查买入条件。';
  if (group?.mode === 'stopped') return '本策略已全部停止，恢复运行后才会继续检查买入条件。';
  const runtime = state?.agency?.runtime;
  if (runtime?.online === false) return `自动交易当前不可用，等待恢复后重新检查。${runtime.lastError ? `最近运行错误：${runtime.lastError}` : ''}`;
  if (runtime?.session?.known === false) return runtime.session.label || '交易日历尚未核验，暂停自动开仓。';
  if (runtime?.session?.open === false) return `${runtime.session.label || '当前非连续竞价时段'}，等待连续竞价时段重新检查。`;
  const preparation = runtime?.preparation?.members?.find(item => item.symbol === member.symbol && item.strategyId === group?.id);
  if (['error', 'preparing', 'prepared', 'waiting-live'].includes(preparation?.status)) return preparation.reason || agencyPreparationNames[preparation.status];
  if (check?.status === 'eligible') return '本轮检查已通过，但尚未形成持仓；实际开仓仍需执行前复核。';
  if (check?.reason && !['holding', 'paused'].includes(check.status)) return check.reason;
  return '等待新一轮技术开仓检查，确认买点、资金和可成交条件。';
}
function agencyMonitoringHtml(member, held = false, group = agencyOwner(member.symbol)) {
  const reason = agencyUnopenedReason(member, held, group);
  const check = agencyCurrentMonitoringCheck(member);
  const reasonLabel = check?.reason && reason === check.reason ? '最近检查未开仓原因' : '未开仓原因';
  const unopened = reason ? `<span data-unopened-reason>${reasonLabel}：${esc(reason)}</span>` : '';
  if (agencyMemberPhase(member, held) === 'standby') return `<div class="agency-monitoring-check agency-standby-note" data-monitoring-status="standby"><b>候补 · 不参与高频刷新</b>${unopened}<small>点击“更新四策略候选池”后重新评估；保留原归属和个人条件。</small></div>`;
  if (agencyMemberPhase(member, held) === 'exiting') return `<div class="agency-monitoring-check" data-monitoring-status="exiting"><b>退出安排</b>${unopened || '<span>不参与新开仓，等待退出或移除处理。</span>'}</div>`;
  const status = agencyMonitoringStatus(member, held);
  const result = check?.reason && check.reason !== reason ? `<small>最近检查结果：${esc(check.reason)}</small>` : '';
  return `<div class="agency-monitoring-check" data-monitoring-status="${esc(status)}"><b class="${status === 'eligible' || status === 'holding' ? 'teal' : 'agency-pending'}">${esc(agencyMonitoringNames[status])}</b>${unopened}${result}${!reason && !check?.reason ? '<span>等待下一轮持仓检查。</span>' : ''}${check?.checkedAt ? `<small>最近检查 ${esc(timeText(check.checkedAt))}</small>` : ''}</div>`;
}
function agencyMonitoringSummary(group) {
  const counts = Object.fromEntries(Object.keys(agencyMonitoringNames).map(key => [key, 0]));
  const phases = agencyMemberCounts(group), held = new Set((group.positions || []).map(position => position.symbol));
  for (const member of group.members || []) { const status = agencyMonitoringStatus(member, held.has(member.symbol)); if (Object.hasOwn(counts, status)) counts[status]++; }
  return `<div class="agency-monitoring-heading"><b>监控与实际开仓阶段</b><span>成员 ${(group.members || []).length} 只 · 活跃 ${phases.active} · 持仓 ${phases.held} · 候补 ${phases.standby}</span></div><div class="agency-member-counts">${Object.entries({ active: '活跃空仓候选', held: '持仓管理', standby: '候补' }).map(([key, label]) => `<div data-member-count="${key}"><span>${label}</span><strong>${phases[key]}</strong></div>`).join('')}</div><p class="tiny">每策略最多 ${agencyActiveCandidateLimit()} 只活跃空仓候选，持仓及退出安排继续管理。候补保留归属和个人条件，不参与高频报价、开仓资料准备或规则检查；点击“更新四策略候选池”后重选及替补。</p><div class="agency-monitoring-counts">${Object.entries(agencyMonitoringNames).map(([key, label]) => `<div data-monitoring-count="${key}"><span>${label}</span><strong>${counts[key]}</strong></div>`).join('')}</div><p class="tiny">上方开仓阶段仅统计活跃与持仓成员的最近检查，不将候补的历史结果计作当前状态。纳入活跃监控不代表立即买入，本轮检查通过也须执行前再次复核。</p>`;
}

const agencyPoolCategories = { added: '新增', retained: '保留', standby: '候补', removed: '移出', pending: '原候选待核验', unassignedPending: '未入池待核验', held: '持仓保留', skipped: '跳过' };
function agencyPoolResearch() { return undefined; }
function agencyPoolIndustry() { return undefined; }
function agencyResearchDisabled(result) { return result?.selection?.mode === 'technical' || result?.researchChecks?.status === 'disabled' || result?.coverage?.researchChecks?.status === 'disabled' || result?.evidenceMode === 'none'; }
function agencyPoolModeName(result) {
  return !result || agencyResearchDisabled(result) ? '行情与技术筛选' : '历史筛选结果 · 原研究条件已停用';
}
function agencySelectionHtml(selection) {
  if (!selection) return '<p class="tiny">正在加载入池标准。</p>';
  return `<div class="agency-selection-heading"><b>${esc(selection.name)} · 入池标准</b><span class="small-badge">v${esc(selection.version)}</span></div><p class="tiny">仅检查流动性、波动、价格偏离与趋势，不采集公告或财务研究资料。${esc(selection.limitations)}</p><div class="agency-selection-strategies">${(selection.strategies || []).map(strategy => `<details data-render-key="selection:${esc(strategy.id)}"><summary>${esc(strategy.name)} · ${strategy.labels.length} 项条件</summary><ul>${strategy.labels.map(label => `<li>${esc(label)}</li>`).join('')}</ul></details>`).join('')}</div><p class="tiny">${esc(selection.basis)}</p><p class="tiny">这是下一轮入池规则；已持仓继续沿用原退出计划，实际开仓仍须通过实时信号、市场环境、资金与盘口约束。</p>`;
}
const agencyNoticeLabels = { 'notice-index-fetch': '公告目录获取失败', 'notice-index-data': '公告目录覆盖待核验',
  'notice-body-fetch': '公告正文获取失败', 'notice-page-parse': '公告页面解析待核验', 'notice-facts-pending': '公告事实字段待核验',
  'notice-policy-missing': '公告规则尚未支持', 'notice-event-pending': '公告事件影响待核验', 'notice-blocked': '公告已明确阻断新开仓',
  'notice-unclassified': '公告待核验原因未细分' };
function agencyNoticeStages(review) {
  if (!review || review.status === 'clear') return [];
  const found = new Set(), add = code => { if (agencyNoticeLabels[code]) found.add(code); };
  if (review.diagnostic) add(review.diagnostic.code);
  if (review.coverageComplete === false && !found.has('notice-index-fetch')) add('notice-index-data');
  for (const notice of review.notices || []) {
    if (notice.status === 'clear') continue;
    const fact = notice.factReview, code = fact?.eligibility?.code;
    if (notice.status === 'blocked' || fact?.eligibility?.status === 'blocked' || code === 'notice-event-blocked') { add('notice-blocked'); continue; }
    if (agencyNoticeLabels[notice.diagnostic?.code]) add(notice.diagnostic.code);
    else if (notice.acquisition) add(notice.acquisition.stage === 'parse' ? 'notice-page-parse' : 'notice-body-fetch');
    else if (code === 'notice-risk-policy-missing' || fact?.status === 'unsupported') add('notice-policy-missing');
    else if (code === 'notice-event-pending' || code === 'performance-exception') add('notice-event-pending');
    else if (code === 'notice-facts-pending' || code?.startsWith('performance-') || fact?.status === 'incomplete') add('notice-facts-pending');
    else if (notice.fulltextStatus === 'verified' || notice.records?.length) add('notice-event-pending');
    else add(/页面|扫描|解析/.test(notice.reason || '') ? 'notice-page-parse' : /原文|下载|获取/.test(notice.reason || '') ? 'notice-body-fetch' : 'notice-unclassified');
    if (fact?.status === 'incomplete' && (code === 'notice-risk-policy-missing' || notice.diagnostic?.code === 'notice-policy-missing')) add('notice-facts-pending');
  }
  if (review.status === 'blocked') add('notice-blocked');
  if (!found.size && review.status === 'unverified') add('notice-unclassified');
  return [...found].map(code => ({ code, label: agencyNoticeLabels[code] }));
}
function agencyPoolItemStages(item, researchRequired = true) {
  const diagnostics = item.diagnostics || {}, supplied = Array.isArray(diagnostics.stages) ? diagnostics.stages : diagnostics.label ? [diagnostics] : [];
  const legacyNotice = new Set(['notice-risk', 'notice-data', 'notice-download', 'sensitive-notice']);
  const stages = supplied.filter(value => value && typeof value.label === 'string' && !(item.noticeReview && legacyNotice.has(value.code)))
    .map(value => legacyNotice.has(value.code) ? { ...value, code: 'notice-unclassified', label: '公告待核验原因未细分（历史记录）' } : { ...value, label: agencyNoticeLabels[value.code] || value.label });
  const add = (code, label) => { if (!stages.some(value => value.code === code || value.label === label)) stages.push({ code, label }); };
  for (const stage of agencyNoticeStages(item.noticeReview)) {
    // Acquisition diagnostics in the saved row include the failed directory
    // request, which a legacy review does not itself retain.
    if (stage.code === 'notice-index-data' && stages.some(value => value.code === 'notice-index-fetch')) continue;
    add(stage.code, stage.label);
  }
  if (!supplied.length && !item.noticeReview) {
    const text = [...(item.reasons || []), ...(item.evidenceReview?.reasons || []), ...(item.evidenceReview?.checks || []).map(check => check.reason || '')].join('\n');
    if (/ERR_[A-Z_]+|下载.*(?:失败|超时)|(?:获取|请求).*失败/.test(text)) add('download', '下载失败');
    if (/解析.*(?:失败|异常)|OCR.*(?:失败|异常)|识别.*(?:失败|置信度不足)|扫描页.*(?:未完成|不足)/i.test(text)) add('parse', '解析失败');
    if (/公告源未识别出|报告目录.*(?:缺失|未找到)/.test(text)) add('directory', '报告目录缺失');
    if (/完整日线日期|日线.*(?:日期|基准).*(?:不一致|异常)/.test(text)) add('daily-date', '日线日期异常');
    if (/日线.*(?:不足|缺失)|历史.*不足/.test(text) || item.technicalError === 'insufficient') add('daily-insufficient', '日线不足');
    if (!item.noticeReview && /敏感事件|敏感公告/.test(text)) add('notice-unclassified', '公告待核验原因未细分（历史记录）');
    if (['failed', 'fail'].includes(item.status) && !stages.length) add('conditions', '条件不符');
    if (!stages.length && (item.evidenceReview?.status === 'pending' || /资料不足|资料待补齐|等待.*核验/.test(text))) add('evidence', '资料不足');
  }
  if (researchRequired && diagnostics.researchAttempted === false && ['pending', 'unassignedPending'].includes(item.category)) add('research-not-started', '未进入研究');
  return researchRequired ? stages : stages.filter(stage => !['research-not-started', 'evidence-incomplete'].includes(stage.code));
}
function agencyPoolDiagnosticsHtml(result) {
  const diagnostics = result.coverage?.diagnostics;
  const researchRequired = result.coverage?.researchRequired !== false;
  const companies = new Map();
  for (const category of Object.keys(agencyPoolCategories)) for (const row of result[category] || []) {
    const stages = companies.get(row.symbol) || new Map();
    for (const stage of agencyPoolItemStages({ ...row, category }, researchRequired)) stages.set(stage.code, stage);
    companies.set(row.symbol, stages);
  }
  const counts = new Map();
  for (const stages of companies.values()) for (const [code, stage] of stages) {
    const item = counts.get(code) || { label: stage.label, count: 0 }; item.count++; counts.set(code, item);
  }
  const entries = [...counts];
  const count = value => Number.isFinite(value) ? `${num(value, 0)} 家` : '未记录';
  return `<div class="agency-pool-diagnostics"><div class="agency-pool-diagnostics-heading"><b>本次列表按公司去重的诊断</b><span>列表 ${count(companies.size)}</span></div>${diagnostics ? `<p class="tiny">全市场扫描 ${count(diagnostics.uniqueCompanies)} · 至少一策略通过 ${count(diagnostics.eligibleCompanies)} · 全部策略条件不符 ${count(diagnostics.failedCompanies)} · 尚有策略待核验 ${count(diagnostics.pendingCompanies)}</p>` : '<p class="tiny">历史结果未记录全市场统计。</p>'}<p class="tiny">下列数量与本次结果全部分类中的逐股标签一致，不受搜索或分类筛选影响；已有成员保留归属和行情技术条件，重新分配活跃与候补；旧研究条件已停用。</p>${entries.length ? `<div class="agency-pool-stage-counts">${entries.map(([key, stage]) => `<div data-pool-stage="${esc(key)}"><span>${esc(stage.label || key)}</span><strong>${num(stage.count, 0)}<small> 家</small></strong></div>`).join('')}</div><p class="tiny">同一公司可有多个原因，同一原因跨策略只计一次，分类数量不可相加。明确阻断与待核验分别列示。</p>` : '<p class="tiny">本次列表未记录额外诊断原因。</p>'}</div>`;
}
function agencyPoolPolicyLabels(query) {
  if (!query) return [];
  const labels = {
    annualProfitableYears: '近三年扣非盈利年数', annualRoeAverage: '近三年平均年度 ROE（%）',
    annualRoeLatest: '最近一年年度 ROE（%）', annualCashPositiveYears: '近三年经营现金流为正年数',
    annualCashSum: '近三年经营现金流合计（亿元）', debtRatio: '资产负债率（%）', latestAdjustedProfit: '最新报告期扣非净利润（亿元）'
  };
  const values = (query.rules || []).map(rule => `${labels[rule.field] || rule.field} ${({ gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=' })[rule.op] || rule.op} ${rule.valueField ? labels[rule.valueField] || rule.valueField : rule.value}`);
  if (query.excludeST) values.push('排除 ST、*ST 及退市标记');
  for (const key of query.evidence?.conditions || []) values.push(({ financialReview: '财务事项复核通过：审计、偿债及财务模板适用性', productOutlook: '产品前景：同一产品的已披露经营证据核验', demand: '需求增长有依据', commercialization: '产品已商业化', advantage: '竞争优势已证实' })[key] || key);
  if (query.evidence?.leadership) values.push((({ either: '主行业前三或重要细分行业龙头', mainTop3: '主行业前三', segmentLeader: '重要细分行业龙头' })[query.evidence.leadership] || query.evidence.leadership) + (query.evidence.leadership !== 'mainTop3' ? `（细分排名第 1，细分业务营收占比 ≥ ${query.evidence.minSegmentRevenuePct ?? 30}%）` : ''));
  values.push(...industryRuleLabels(query.evidence?.industry || query.industry));
  return values;
}
function agencyPoolEvidenceSummaryHtml(result) {
  const current = agencyResearchDisabled(result);
  return `<div class="agency-pool-evidence-heading"><b>${current ? '行情与技术筛选' : '历史筛选结果 · 仅留档'}</b><span>研究筛查已停用 · 未核验</span></div><p class="tiny">公告风险、财报与行业经营研究、财务及业绩指标不参与自动入池和开仓判断。未核验不能理解为条件通过或没有风险。</p>${current ? '' : '<p class="tiny agency-pool-history-note">下方保留当时的研究结论及原因，不代表当前开仓要求。更新候选池后将按行情与技术规则重新筛选。</p>'}<p class="tiny">持仓及历史权益的公司行为核算继续保留；首次开仓仍检查行情、完整未复权日线及价格基准。</p>`;
}
function agencyEvidenceLocationHtml(record) {
  const locations = (record.locations || []).map(item => [item.page ? '第 ' + item.page + ' 页' : '', ({ 'pdf-text': 'PDF 文字', 'provider-text': '公告正文', ocr: '扫描识别 · 待核对' })[item.method] || '', item.lineStart ? `第 ${item.lineStart}${item.lineEnd && item.lineEnd !== item.lineStart ? `—${item.lineEnd}` : ''} 行` : '', item.method === 'ocr' && Number.isFinite(item.confidence) ? '识别置信度 ' + item.confidence + '%' : ''].filter(Boolean).join(' · '));
  return locations.length ? '<small>' + esc([...new Set(locations)].join('；')) + '</small>' : '';
}
function agencyResearchRecordHtml(record) {
  const relation = ({ 'issuer-disclosure': '公司公开披露', 'issuer-citation': '公司引用第三方', 'issuer-cites-third-party': '公司披露引用第三方，未独立取得第三方全文', 'independent-third-party': '已独立取得第三方原文', 'third-party-direct': '第三方原始资料', 'third-party': '第三方资料' })[record.sourceRelation] || record.sourceRelation;
  const scope = [record.subject ? `对应产品 ${record.subject}` : '', record.market ? `比较市场 ${record.market}` : '',
    record.geography ? `地域 ${record.geography}` : '', record.statisticYear ? `统计年度 ${record.statisticYear}` : '', record.metric ? `比较指标 ${({ sales: '销售额', volume: '销量', marketShare: '市场份额' })[record.metric] || record.metric}` : '',
    record.rank != null ? `排名 ${record.rank}` : '', record.revenueSharePct != null ? `细分业务收入占比 ${record.revenueSharePct}%` : '',
    record.coverage ? `比较范围 ${({ allCompetitors: '全部竞争者', listedOnly: '上市公司样本', listedCompanies: '上市公司样本' })[record.coverage] || agencyText(record.coverage)}` : '',
    record.comparisonPeriod ? `比较期间 ${record.comparisonPeriod}` : '', record.comparisonScope ? `比较口径 ${record.comparisonScope}` : '', record.comparator ? `比较对象 ${record.comparator}` : '',
    record.ownValue != null ? `产品指标 ${agencyText(record.ownValue)}${record.unit || ''}` : '', record.benchmarkValue != null ? `比较基准 ${agencyText(record.benchmarkValue)}${record.unit || ''}` : '',
    record.citedSource ? `引用机构 ${record.citedSource}` : '', record.citedReport ? `引用报告 ${record.citedReport}` : '',
    relation ? `来源关系 ${relation}` : ''];
  return `<article><b>${esc(record.sourceTitle || record.title || '公开披露资料')}</b>${record.publishedAt ? `<small>发布日期 ${esc(record.publishedAt)}</small>` : ''}${record.period ? `<small>报告期间 ${esc(record.period)}</small>` : ''}${scope.filter(Boolean).length ? `<small>${scope.filter(Boolean).map(esc).join(' · ')}</small>` : ''}${agencyEvidenceLocationHtml(record)}${record.excerptTruncated ? '<small>以下仅展示部分原文摘录，完整披露章节位置另列。</small>' : ''}${record.sectionLocations?.length ? `<small>完整披露章节位置${record.section ? `（${esc(record.section)}）` : ''}：</small>${agencyEvidenceLocationHtml({ locations: record.sectionLocations })}` : ''}${record.quote ? `<blockquote>${esc(agencyText(record.quote))}</blockquote>` : ''}${record.url ? `<p class="agency-pool-source-url">原文来源：${esc(record.url)}</p>` : ''}</article>`;
}
function agencyProductEvidenceHtml(check) {
  if (!['productOutlook', 'sameProduct'].includes(check.key)) return '';
  const intro = '<p class="tiny">“产品前景”是同一产品已披露经营证据的核验，需求、商业化、竞争优势和风险披露分别判断；不会跨产品拼接通过结论，也不代表未来增长或收益预测。风险结论仅覆盖已取得并核验的披露材料。</p>';
  if (!Array.isArray(check.productCandidates)) return `<div class="agency-product-review">${intro}<p class="tiny">历史结果未保存逐产品明细，无法还原四项结论；以下只展示当时保存的总评及依据。</p></div>`;
  if (!check.productCandidates.length) return `<div class="agency-product-review">${intro}<p class="agency-pending" data-product-identification="unverified">未可靠识别产品：尚不能将需求、商业化、竞争优势和风险证据绑定到同一产品。${esc(check.productIdentification?.reason || '具体识别原因以上方核验说明为准。')}</p></div>`;
  const labels = { demand: '需求事实', commercialization: '商业化事实', advantage: '竞争优势比较', outlookRisk: '风险披露覆盖' };
  const status = value => ({ pass: '通过', passed: '通过', fail: '不符', failed: '不符', pending: '待核验', unavailable: '待核验' })[value] || '未记录';
  return `<div class="agency-product-review">${intro}${check.productIdentification?.reason ? `<p class="tiny">产品识别：${esc(check.productIdentification.reason)}</p>` : ''}${check.productCandidates.map(candidate => {
    const parts = new Map((Array.isArray(candidate.parts) ? candidate.parts : []).map(part => [part.key, part]));
    const keys = check.key === 'productOutlook' ? Object.keys(labels) : [...parts.keys()];
    return `<details class="agency-product-candidate"><summary>产品：${esc(candidate.subject || '名称未记录')} · ${esc(status(candidate.status))}</summary>${keys.map(key => {
      const part = parts.get(key), records = Array.isArray(part?.records) ? part.records : [];
      const pending = ['pending', 'unavailable'].includes(part?.status), reason = agencyText(part?.reason);
      const missing = pending && /未定位|未找到|尚缺|缺少|不足|不完整|未覆盖/.test(reason)
        ? ({ demand: '未找到可核验的需求事实', commercialization: '商业化事实尚待补齐', advantage: '行业比较证据缺项', outlookRisk: '风险披露覆盖不足' })[key] : '';
      const basis = ({ 'explicit-disclosure': '明确对应披露', 'disclosure-scope-review': '限定披露范围复核', 'resolved-event': '明确事项后续说明' })[part?.basis];
      const scope = part?.scope, coverage = scope ? [scope.reportId ? `报告编号 ${scope.reportId}` : '', scope.reportDate ? `报告期 ${scope.reportDate}` : '',
        scope.fromDate || scope.toDate ? `公告覆盖 ${scope.fromDate || '起点未记录'} 至 ${scope.toDate || '终点未记录'}` : '', scope.noticeSelection ? `公告范围 ${scope.noticeSelection === 'risk-and-business-keywords' ? '风险及经营关键词匹配的相关公告' : agencyText(scope.noticeSelection)}` : ''].filter(Boolean) : [];
      return `<article class="agency-product-part" data-product-part="${esc(key)}" data-product-status="${esc(part?.status || 'unrecorded')}"><b>${esc(labels[key] || part?.label || key)} · ${esc(status(part?.status))}</b>${missing ? `<p class="agency-pending">${esc(missing)}</p>` : ''}<p>${esc(reason || (part ? '本项未保存具体原因。' : '历史结果未保存本项检查，不补判为通过或不符。'))}</p>${basis ? `<small>核验依据：${esc(basis)}</small>` : ''}${part?.limitedScope ? `<p class="tiny">范围限制：${esc(agencyText(part.limitedScope))}</p>` : ''}${coverage.length ? `<small>${coverage.map(esc).join(' · ')}</small>` : ''}${records.length ? `<details class="agency-product-records"><summary>本项依据摘录 · ${records.length} 条</summary>${records.map(agencyResearchRecordHtml).join('')}</details>` : `<p class="tiny">${part && !Array.isArray(part.records) ? '历史结果未保存本项原文摘录。' : '本项暂无可展示的原文摘录。'}其他产品或其他项目的证据不能补作本项依据。</p>`}</article>`;
    }).join('')}</details>`;
  }).join('')}</div>`;
}
function agencyPoolEvidenceHtml(review) {
  if (!review) return '';
  const statusLabel = status => ({ pass: '通过', passed: '通过', failed: '不符', fail: '不符', pending: '资料不足', unavailable: '资料不足' })[status] || status || '未提供';
  const cacheWarnings = (review.collection?.cacheWarnings || []).filter(value => typeof value === 'string');
  const cacheHtml = cacheWarnings.length ? `<p class="tiny">部分资料未能保存到缓存，下次可能需要重新获取：${cacheWarnings.map(esc).join('；')}</p>` : '';
  return `<details class="agency-pool-evidence-detail"><summary>公开资料程序核验 · ${esc(statusLabel(review.status))}</summary>${review.checkedAt ? `<p class="tiny">核验时间 ${esc(timeText(review.checkedAt))}</p>` : ''}${cacheHtml}${industryReviewHtml(review.industryReview)}${(review.checks || []).filter(check => !review.industryReview || check.key !== 'industry').map(check => `<section><b>${esc(check.label || ({ productOutlook: '产品前景', leadership: '行业地位', financialReview: '财务事项' })[check.key] || check.key || '研究资料')} · ${esc(statusLabel(check.status))}</b>${check.reason ? `<p>${esc(agencyText(check.reason))}</p>` : ''}${agencyProductEvidenceHtml(check)}${check.records?.length ? `<details><summary>查看依据摘录 · ${check.records.length} 条</summary>${check.records.map(agencyResearchRecordHtml).join('')}</details>` : check.productCandidates?.some(candidate => candidate.parts?.some(part => part.records?.length)) ? '<p class="tiny">总评未另附摘录，各产品依据见上方分项。</p>' : '<p class="tiny">本项未附可展示的原文摘录。</p>'}</section>`).join('')}${review.reasons?.length ? `<p>${review.reasons.map(reason => esc(agencyText(reason))).join('；')}</p>` : ''}</details>`;
}
function agencyNoticeReviewHtml(review) {
  if (!review || !Array.isArray(review.notices)) return '';
  const statusLabel = status => ({ clear: '核验通过', unverified: '待核验', blocked: '阻断新开仓' })[status] || '未提供结论';
  const factLabel = status => ({ verified: '事实字段核验完整', incomplete: '事实字段不完整', unsupported: '暂不支持自动判断' })[status] || '尚无事实核验结果';
  const summaryLabel = review.mode === 'automatic-fulltext' ? '敏感公告原文核验' : '公告目录与事件核验';
  const notices = review.notices.map(notice => {
    const facts = notice.factReview, checks = Array.isArray(facts?.checks) ? facts.checks : [];
    const labels = new Map(checks.map(check => [check.key, check.label || check.key]));
    const missing = Array.isArray(facts?.missingFields) ? facts.missingFields : checks.filter(check => check.status === 'missing').map(check => check.key);
    const basis = facts?.data?.basisLabel || (facts?.type === 'forecast' ? '业绩预测，尚非实际业绩' : facts?.type === 'flash' ? '业绩快报初步核算，尚非定期报告最终数据' : '');
    const records = Array.isArray(notice.records) ? notice.records : [];
    const diagnostics = agencyNoticeStages({ status: notice.status, notices: [notice] });
    return `<section data-notice-status="${esc(notice.status || 'unverified')}"><b>${esc(notice.title || '敏感公告')} · ${esc(statusLabel(notice.status))}</b><small>${[notice.date ? `公告日期 ${notice.date}` : '', notice.id ? `公告编号 ${notice.id}` : ''].filter(Boolean).map(esc).join(' · ')}</small>${diagnostics.map(item => `<p class="tiny" data-notice-diagnostic="${esc(item.code)}"><b>${esc(item.label)}</b></p>`).join('')}${notice.reason ? `<p>${esc(agencyText(notice.reason))}</p>` : ''}${notice.fulltextStatus === 'verified' ? '<p class="tiny">完整原文校验通过；是否放行以本公告核验结论为准。</p>' : ''}${facts ? `<p><b>${esc(facts.label || '公告事实')} · ${esc(factLabel(facts.status))}</b>${basis ? `<br><span class="agency-pending">${esc(basis)}</span>` : ''}</p><p>${missing.length ? `缺失事实字段：${missing.map(key => esc(labels.get(key) || key)).join('、')}` : checks.length && facts.status === 'verified' ? '无缺失事实字段。' : '尚无可核验的结构化事实字段。'}${facts.eligibility?.reason ? ` ${esc(facts.eligibility.reason)}` : ''}</p>${(facts.warnings || []).map(warning => `<p class="agency-pending">${esc(warning.reason || warning.label)}</p>`).join('')}${checks.length ? `<details class="agency-notice-facts"><summary>逐项事实核验 · ${checks.length} 项</summary>${checks.map(check => `<p><b>${esc(check.label || check.key || '事实字段')} · ${check.status === 'verified' ? '已核验' : '待核验'}</b>${check.reason ? `<br>${esc(agencyText(check.reason))}` : ''}${check.value != null ? `<br>提取值：${esc(noticeFactValueText(check))}` : ''}</p>`).join('')}</details>` : ''}` : ''}${records.length ? `<details class="agency-notice-excerpts"><summary>查看公告依据摘录 · ${records.length} 条</summary>${records.map(record => `<article><b>${esc(record.sourceTitle || notice.title || '公告原文')}</b>${record.publishedAt ? `<small>发布日期 ${esc(record.publishedAt)}</small>` : ''}${agencyEvidenceLocationHtml(record)}${record.quote ? `<blockquote>${esc(agencyText(record.quote))}</blockquote>` : ''}${record.url ? `<p class="agency-pool-source-url">原文来源：${esc(record.url)}</p>` : ''}</article>`).join('')}</details>` : '<p class="tiny">本公告尚无可展示的原文摘录。</p>'}</section>`;
  }).join('');
  return `<details class="agency-pool-evidence-detail agency-notice-review"><summary>${summaryLabel} · ${esc(statusLabel(review.status))}</summary>${review.checkedAt ? `<p class="tiny">核验时间 ${esc(timeText(review.checkedAt))}</p>` : ''}<p class="tiny">仅核对当前公告覆盖范围内的敏感事项，不代表完成产品前景、行业地位或专项财务研究。公告核验通过后仍须通过策略买点及交易约束。</p>${notices || `<p class="tiny">本次没有逐条公告核验记录。</p>${agencyNoticeStages(review).map(item => `<p class="tiny" data-notice-diagnostic="${esc(item.code)}">${esc(item.label)}</p>`).join('')}`}${review.reasons?.length ? `<p>${review.reasons.map(reason => esc(agencyText(reason))).join('；')}</p>` : ''}</details>`;
}
function applyAgencyPoolProgress(update) {
  const current = state?.agencyPool;
  // Start/end snapshots own the lifecycle and the result. A late callback from
  // a cancelled or completed run must never revive it or replace a new run.
  if (!current?.running || !update?.running || !update.runId || update.runId !== current.runId) return false;
  state = { ...state, agencyPool: { ...current, operation: update.operation, progress: update.progress,
    elapsedMs: update.elapsedMs, lastError: update.lastError } };
  renderAgencyPool();
  return true;
}
function agencyPoolElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds / 60) % 60} 分`
    : seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}
function initializeAgencyPoolConfiguration() {
  agencyUi.configurationAccount = state.account.createdAt;
  agencyUi.screeningMode = 'strategy';
}
function renderAgencyPool() {
  const pool = state.agencyPool || {}, result = pool.lastResult, progress = pool.progress || {};
  initializeAgencyPoolConfiguration(pool);
  const automation = pool.automation;
  const automationLabels = { running: '正在自动更新', completed: '今日已完成更新', cancelled: '本次运行内今日自动更新已取消', unavailable: '等待应用就绪', 'calendar-unverified': '交易日历待核验', 'non-trading-day': '非交易日，等待下一交易日', 'outside-window': '等待交易日更新时段', 'retry-wait': '更新失败，等待重试', 'waiting-busy': '等待当前更新结束', waiting: '等待自动更新' };
  setHtml('agency-pool-automation-status', automation ? `<b>自动选股 · ${esc(automationLabels[automation.status] || '等待调度')}</b><br><span class="tiny">${esc(automation.window || '交易日 08:45–15:00')} · 按行情与技术规则筛选。${automation.lastSuccessAt ? `最近完成 ${esc(timeText(automation.lastSuccessAt))}。` : ''}${automation.nextAttemptAt ? `下次尝试 ${esc(timeText(automation.nextAttemptAt))}。` : ''}${automation.lastError ? `最近失败：${esc(automation.lastError)}` : ''}</span>` : '正在加载自动选股计划。');
  const running = pool.running || agencyUi.busy.has('pool-run') || agencyUi.busy.has('pool-retry');
  const retrying = running && (pool.operation === 'retry' || agencyUi.busy.has('pool-retry'));
  const retryAvailable = Boolean(result && (result.coverage?.diagnostics?.pendingCompanies > 0 || ['pending', 'unassignedPending'].some(key => (result.counts?.[key] ?? result[key]?.length ?? 0) > 0) || [...result.held || [], ...result.standby || []].some(item => item.status === 'pending')));
  const selection = pool.policy?.candidateSelection || pool.policies?.strategy?.candidateSelection;
  setHtml('agency-selection-rules', agencySelectionHtml(selection));
  const screened = result?.selection?.criteria;
  $('agency-overview-note').textContent = `${selection ? screened?.version === selection.version ? `${selection.name} · ` : result ? '当前名单尚未按新版稳健条件重筛，请更新候选池。' : '稳健精选 · 等待候选池更新。' : ''}每策略最多 ${agencyActiveCandidateLimit()} 只空仓活跃候选，持仓另计；不足不补齐，入选不代表立即买入。`;
  $('agency-pool-settings-summary').textContent = '筛选规则 · 行情与技术';
  $('agency-pool-description').textContent = `按四种策略的行情与技术条件重新筛选。每组最多 ${agencyActiveCandidateLimit()} 只活跃空仓候选，不足不补齐；不符合、行情日线待核验或超出名额的成员进入候补。`;
  $('agency-pool-workflow').textContent = '① 行情初筛 → ② 完整日线与技术条件 → ③ 排序进入活跃或候补';
  $('agency-pool-run').disabled = running;
  $('agency-pool-run').textContent = running && !retrying ? '正在更新候选池…' : '更新四策略候选池';
  $('agency-pool-retry').classList.toggle('hidden', !retryAvailable && !retrying);
  $('agency-pool-retry').disabled = running;
  $('agency-pool-retry').textContent = retrying ? '正在重试行情日线…' : '重试行情日线';
  $('agency-pool-retry-note').classList.toggle('hidden', !retryAvailable && !retrying);
  $('agency-pool-cancel').classList.toggle('hidden', !running);
  $('agency-pool-cancel').disabled = agencyUi.busy.has('pool-cancel');
  $('agency-pool-cancel').textContent = agencyUi.busy.has('pool-cancel') ? '正在取消…' : '取消本次更新';
  $('agency-pool-progress').classList.toggle('hidden', !running);
  const phase = ({ quotes: '获取沪深 A 股行情', daily: '检查完整日线与技术条件', 'risk-quotes': '复核行情风险', syncing: '同步四策略候选', sync: '同步四策略候选', strategies: '匹配四种策略', screening: '匹配四种策略', preparing: '准备全市场筛选' })[progress.stage] || '正在筛选行情与技术条件';
  $('agency-pool-progress-label').textContent = (retrying ? '重试行情日线 · ' : '') + phase;
  const progressCount = progress.total > 0 ? `${num(progress.completed || 0, 0)} / ${num(progress.total, 0)}` : '等待数据';
  $('agency-pool-progress-count').textContent = `${progressCount} · 已用 ${agencyPoolElapsed(pool.elapsedMs)}`;
  const bar = $('agency-pool-progress-bar');
  if (progress.total > 0) bar.value = Math.min(100, Math.max(0, (progress.completed || 0) / progress.total * 100)); else bar.removeAttribute('value');
  let policyHtml = '<b>行情与技术条件</b><p>采用上方四策略入池规则，不再附加公告、财报、经营、行业或业绩条件；入池后仍须通过实时买点与成交检查。旧研究配置只留档，不再生效。</p>';
  policyHtml += `<b>活跃名额与归属</b><p>每组最多 ${agencyActiveCandidateLimit()} 只空仓活跃候选，持仓不占该名额。全部条件通过后，按距策略均线的百分比距离、成交额、原活跃优先、股票代码排序；排序用于分配刷新资源，不代表收益排名。数量不足不放宽条件，不改写已有持仓的退出计划。</p><p>本次不满足、待核验及超出名额的成员进入候补，不参与高频刷新。交易日更新时段内自动补更，也可手动更新或重试；每轮重新筛选及替补。</p>`;
  setHtml('agency-pool-policy-content', policyHtml);
  $('agency-pool-error').textContent = agencyUi.poolError || pool.lastError || '';
  $('agency-pool-error').classList.toggle('hidden', !agencyUi.poolError && !pool.lastError);
  $('agency-pool-status').textContent = running
    ? `${retrying ? '本次重试正在执行' : '本次更新正在执行'}${result?.finishedAt ? `；下方保留上次完成结果（${timeText(result.finishedAt)}）` : '，完成后展示处理结果'}。`
    : result ? `最近${result.operation === 'retry' ? '重试' : '执行'}：${timeText(result.startedAt)} · 完成：${timeText(result.finishedAt)} · ${agencyPoolModeName(result)}` : '尚未完成候选池更新；等待自动选股，也可手动更新。';
  $('agency-pool-retry-note').textContent = '重试按当前行情与技术规则重新筛选，复用仍有效的日线，只补取缺失或失败的行情日线；旧公告、财务和研究筛查不会恢复。完成后重新分配活跃与候补。';
  $('agency-pool-results').classList.toggle('hidden', !result);
  $('agency-pool-report').classList.toggle('hidden', !result);
  if (!result) return;
  if (agencyUi.poolResultId !== result.id) { agencyUi.poolResultId = result.id; agencyUi.poolPage = 1; agencyUi.poolRenderKey = null; }
  $('agency-pool-result-title').textContent = running ? '上一次完成结果' : '最近一次更新结果';
  const scope = [result.coverage ? agencyPoolCoverageText(result.coverage) : '行情覆盖信息未提供', agencyPoolSourceText(result.sources)];
  scope.push(screened ? `${screened.name} v${screened.version}` : '历史入池标准（未按稳健精选重筛）');
  if (result.selection) scope.push(`每组活跃上限 ${result.selection.activeLimitPerGroup} 只空仓候选`, `排序：${result.selection.ranking}`);
  $('agency-pool-result-scope').textContent = scope.join(' · ');
  const filter = $('agency-pool-filter').value, search = $('agency-pool-search').value.trim().toLowerCase();
  const renderKey = `${result.id}:${result.finishedAt}:${filter}:${search}:${agencyUi.poolPage}`;
  if (agencyUi.poolRenderKey === renderKey) return;
  agencyUi.poolRenderKey = renderKey;
  setHtml('agency-pool-evidence-summary', agencyPoolEvidenceSummaryHtml(result));
  setHtml('agency-pool-diagnostics', agencyPoolDiagnosticsHtml(result));
  setHtml('agency-pool-metrics', Object.entries(agencyPoolCategories).map(([key, label]) => `<div data-pool-count="${key}" class="${['pending', 'unassignedPending'].includes(key) ? 'is-pending' : ''}"><span>${label}</span><strong>${num(result.counts?.[key] ?? result[key]?.length ?? 0, 0)}</strong><small>${({ added: '新增活跃候选', retained: '继续或恢复活跃', standby: '不参与高频刷新', removed: '本次移出记录', pending: '历史待核验分类', unassignedPending: '资料不足，未新增', held: '沿用原退出计划', skipped: '保留现有安排' })[key]}</small></div>`).join(''));
  setHtml('agency-pool-strategies', Object.entries(result.strategies || {}).map(([id, counts]) => `<div><b>${esc(strategyProfile(id).name)}</b><span>通过 ${num(counts.pass || 0, 0)} · 不符合 ${num(counts.failed || 0, 0)} · 待核验 ${num(counts.pending || 0, 0)}</span></div>`).join('') + '<p class="tiny">策略统计为独立筛选结果，同一股票可能在多组中计数；下方按实际同步动作或未入池待核验去重展示。</p>');
  const rows = Object.keys(agencyPoolCategories).flatMap(category => (result[category] || []).map(item => ({ ...item, category })))
    .filter(item => (filter === 'all' || item.category === filter) && (!search || `${item.symbol} ${item.name || ''}`.toLowerCase().includes(search)));
  const size = 20, pages = Math.max(1, Math.ceil(rows.length / size));
  agencyUi.poolPage = Math.max(1, Math.min(agencyUi.poolPage, pages));
  $('agency-pool-page-info').textContent = `第 ${agencyUi.poolPage} / ${pages} 页 · ${rows.length} 条 · 展开可查看处理原因`;
  $('agency-pool-prev').disabled = agencyUi.poolPage <= 1; $('agency-pool-next').disabled = agencyUi.poolPage >= pages;
  setHtml('agency-pool-items', rows.length ? rows.slice((agencyUi.poolPage - 1) * size, agencyUi.poolPage * size).map(item => {
    const reasons = Array.isArray(item.reasons) ? item.reasons : item.reason ? [item.reason] : [];
    const stages = agencyPoolItemStages(item, result.coverage?.researchRequired !== false);
    return `<details class="agency-pool-item" data-render-key="${esc(`${result.id}:${item.category}:${item.symbol}:${item.strategyId || ''}`)}"><summary><span class="agency-pool-category ${['pending', 'unassignedPending'].includes(item.category) ? 'agency-pending' : ''}">${esc(agencyPoolCategories[item.category])}</span><strong>${esc(item.name || item.symbol)}</strong><span>${esc(item.symbol?.toUpperCase())}</span><span>${item.strategyId ? esc(strategyProfile(item.strategyId).name) : '未分配策略'}</span>${stages.length ? `<span class="agency-pool-stage-tags">${stages.map(stage => `<span>${esc(stage.label)}</span>`).join('')}</span>` : ''}</summary><div>${reasons.length ? `<ul>${reasons.map(reason => `<li>${esc(agencyText(reason))}</li>`).join('')}</ul>` : '<p>本项未提供额外说明。</p>'}${item.matchedStrategies?.length ? `<p>符合策略：${item.matchedStrategies.map(id => esc(strategyProfile(id).name)).join(' / ')}</p>` : ''}${item.strategyIds?.length ? `<p>待核验策略：${item.strategyIds.map(id => esc(strategyProfile(id).name)).join(' / ')}</p>` : ''}${item.category === 'held' ? `<p>本次选股复核：${esc(({ pass: '通过', pending: '待核验', failed: '不满足' })[item.status] || item.status || '见上方原因')}。已有持仓保留原归属和退出计划。</p>` : ''}${agencyResearchDisabled(result) ? '' : `<details><summary>历史研究记录 · 已停用</summary>${independentFinanceHtml(item)}${performanceReviewHtml(item.performanceReview)}${researchInlineHtml(item.researchReview)}${agencyPoolEvidenceHtml(item.evidenceReview)}${agencyNoticeReviewHtml(item.noticeReview)}</details>`}<button type="button" class="text-button" data-agency-open="${esc(item.symbol)}">查看股票 ↗</button></div></details>`;
  }).join('') : '<p class="tiny agency-pool-no-results">没有此分类的处理结果。</p>', result.id);
}
function agencyPoolCoverageText(coverage) {
  if (typeof coverage === 'string') return coverage;
  return [coverage.universeCount != null ? `沪深 A 股 ${num(coverage.universeCount, 0)} 只` : '', coverage.universeComplete ? '股票名单完整' : '股票名单覆盖待确认', coverage.partial ? '部分资料待核验' : '', coverage.requiredMissing?.length ? `${coverage.requiredMissing.length} 只原成员未被行情覆盖` : ''].filter(Boolean).join(' · ');
}
function agencyPoolSourceText(sources) {
  if (Array.isArray(sources)) return sources.length ? `来源：${sources.map(source => typeof source === 'string' ? source : source.name || source.source || agencyText(source)).join(' / ')}` : '来源未提供';
  if (!sources) return '行情来源未提供';
  const quotes = sources.quotes || {};
  return [`行情来源：${quotes.source || '未提供'}`, quotes.oldestQuote ? `实际行情：${timeText(quotes.oldestQuote)}${quotes.newestQuote && quotes.newestQuote !== quotes.oldestQuote ? ` 至 ${timeText(quotes.newestQuote)}` : ''}` : '实际行情时间未提供', quotes.unknownQuoteTime ? `${quotes.unknownQuoteTime} 只行情时间未知` : '', sources.finance?.source ? `财务：${sources.finance.source}` : '', sources.technical?.source ? `日线：${sources.technical.source}` : '', sources.evidence ? `研究资料：${agencyText(sources.evidence)}` : '', sources.notices ? `公告：${agencyText(sources.notices)}` : ''].filter(Boolean).join(' · ');
}
async function agencyUpdatePool(operation = 'update') {
  if (state.agencyPool?.running || agencyUi.busy.has('pool-run') || agencyUi.busy.has('pool-retry')) return;
  const retry = operation === 'retry', key = retry ? 'pool-retry' : 'pool-run';
  agencyUi.busy.add(key); agencyUi.poolError = ''; renderAgencyPool();
  try {
    const result = await api(retry ? 'agency:pool:retry' : 'agency:pool:run', retry ? undefined : { screeningMode: 'strategy' });
    renderState(await api('state'));
    toast(result?.cancelled ? '本次更新已取消，监控列表未同步' : retry ? '资料重试已完成，可展开查看处理原因' : '四策略监控列表已更新；纳入监控不代表立即买入');
  } catch (error) {
    agencyUi.poolError = error.message; toast(error.message, true);
    try { renderState(await api('state')); } catch {}
  } finally { agencyUi.busy.delete(key); renderAgencyPool(); }
}

function renderAgency() {
  const root = $('page-agency');
  if (!root || !state) return;
  if (page !== 'agency') return;
  renderAgencyPool();
  const groups = agencyGroups();
  $('agency-unavailable').classList.toggle('hidden', groups.length > 0);
  $('agency-workspace').classList.toggle('hidden', !groups.length);
  if (groups.length && !agencyGroup()) agencyUi.strategyId = groups[0].id;
  setHtml('agency-overview', agencyOverviewHtml(groups));
  renderAgencyRuntime();
  for (const [id, key] of [['agency-transfer-form', 'transfer'], ['agency-limits-form', 'limits']]) {
    $(id).querySelectorAll('input, select, button').forEach(control => { control.disabled = agencyUi.busy.has(key); });
  }
  if (!groups.length) return;
  if (!agencyGroup()) agencyUi.strategyId = groups[0].id;
  const group = agencyGroup(), profile = strategyProfile(group.id);
  setHtml('agency-tabs', groups.map(item => `<button type="button" role="tab" aria-selected="${item.id === group.id}" aria-controls="agency-group-panel" tabindex="${item.id === group.id ? '0' : '-1'}" data-agency-tab="${esc(item.id)}"><strong>${esc(item.name)}</strong><span>${esc(agencyModeNames[item.mode] || '尚未启用')}</span></button>`).join(''));
  $('agency-group-title').textContent = `${group.name}策略账户`;
  $('agency-group-summary').textContent = `可用资金 ¥ ${cash(group.availableCash ?? group.cash)} · 策略权益 ¥ ${cash(group.equity)}${group.comparable === false ? '（暂估）' : ''}`;
  $('agency-rule-title').textContent = `${group.name} · 固定买卖规则`;
  setHtml('agency-rule-details', [['买入条件', profile.entryDescription], ['退出条件', profile.exitDescription]].map(([title, description]) => `<section><h3>${title}</h3><p>${esc(description || '策略规则尚未加载，等待资料后再启用')}</p></section>`).join(''));
  $('agency-rule-data').textContent = profile.dataDescription || '使用完整未复权日线及有效报价；资料缺失或风险待核验时暂停新开仓。';
  $('agency-mode').textContent = agencyModeNames[group.mode] || '尚未启用';
  $('agency-mode').className = 'agency-status ' + (group.mode === 'running' ? 'is-running' : '');
  const hasUnknownValue = group.comparable === false || group.comparable == null && (group.positions || []).some(position => group.members?.some(member => member.symbol === position.symbol && member.reconciliation?.status !== 'clear' && member.reconciliation?.affectsEquity !== false));
  setHtml('agency-metrics', metric('策略权益', '¥ ' + cash(group.equity), `可用 ¥ ${cash(group.availableCash ?? group.cash)} · 净划入 ¥ ${cash(group.netFunding)}`)
    + metric('已实现盈亏', signed(group.realized / 100), hasUnknownValue ? '含待核验持仓，统计待对账' : '完整与部分退出均含已发生费用', cls(group.realized))
    + metric('浮动盈亏', signed(group.unrealized / 100), hasUnknownValue ? '暂估值 · 公司行为待核验' : '最近报价估值 · 未扣未来卖出费用', cls(group.unrealized))
    + metric('最大回撤', hasUnknownValue ? '待对账' : pct(group.drawdown), hasUnknownValue ? '核验完成前不参与策略比较' : '策略分账记录 · 关闭期间不采样')
    + metric('完整轮次胜率', hasUnknownValue ? '待对账' : pct(group.winRate), `${agencyCycles(group)} 个完整交易轮次 · 部分退出不另计胜负`));
  $('agency-mode-note').textContent = group.mode === 'running'
    ? '定期检查固定入场规则，通过资金、仓位和交易约束后才模拟买入。持仓退出由独立行情刷新检查，待对账股票暂停旧价位触发。'
    : group.mode === 'paused' ? '暂停新开仓，已有持仓继续按原计划检查与退出；恢复运行后才会再次新建仓。'
      : '自动买卖已停止，已有持仓不会自动卖出；公司行为资料仍会核验，已确认权益按登记和到账日期处理。恢复运行或暂停新开仓模式后，才继续持仓买卖管理。';
  document.querySelectorAll('[data-agency-mode]').forEach(button => { button.disabled = button.dataset.agencyMode === group.mode || agencyUi.busy.has('mode'); });
  const runtime = state.agency.runtime;
  $('agency-run').disabled = group.mode === 'stopped' || (group.mode === 'paused' && !group.positions?.length) || runtime?.decisionMode !== 'rules' || runtime.online === false || runtime.session?.open === false || runtime.session?.known === false || (runtime.runningGroups || []).includes(group.id) || agencyUi.busy.has('run');
  $('agency-manual-cash').textContent = `未分配资金可划入 ¥ ${cash(state.agency.manualCash)}；当前策略现金余额 ¥ ${cash(group.cash)}，可用 ¥ ${cash(group.availableCash ?? group.cash)}${group.receivable ? `，应收分红 ¥ ${cash(group.receivable)}` : ''}${group.taxReserve ? `，预留预计税款 ¥ ${cash(group.taxReserve)}` : ''}。正数划入，负数划回；应收分红与预留预计税款不用于新开仓或划回。`;
  if (agencyUi.limitsGroup !== group.id || !agencyUi.limitsDirty) {
    const limits = group.limits || {};
    for (const [key, fallback] of [['maxPosition', .3], ['maxTotalPosition', .8], ['maxPositions', 5], ['riskPercent', .5], ['maxPlannedRiskPercent', 2], ['minRewardRisk', 2]]) {
      const input = $('agency-limit-' + key); if (input) input.value = ['maxPosition', 'maxTotalPosition'].includes(key) ? (limits[key] ?? fallback) * 100 : limits[key] ?? fallback;
    }
    agencyUi.limitsGroup = group.id; agencyUi.limitsDirty = false;
  }
  setHtml('agency-members', agencyMembersHtml(group), group.id);
  $('agency-member-title').textContent = `${group.name} · ${{ active: '活跃候选', held: '持仓', standby: '候补', exiting: '退出安排', all: '全部成员' }[$('agency-member-filter').value] || '成员'}`;
  setHtml('agency-monitoring-summary', agencyMonitoringSummary(group));
  setHtml('agency-decisions', agencyDecisionsHtml(group), group.id);
  setHtml('agency-corporate-history', agencyCorporateHistoryHtml(group), group.id);
  const hasCorporateCandidates = group.members?.length || (state.account?.trades || []).some(item => item.owner === group.id);
  $('agency-verify').disabled = !hasCorporateCandidates || [...agencyUi.busy].some(key => key === 'verify:' + group.id || key.startsWith('verify:' + group.id + ':'));
  if ($('agency-reconcile-dialog').open) renderAgencyReconcile();
}

function agencyVerificationView(member) {
  const corporate = member?.corporateVerification;
  const withoutCorporate = corporate?.status === 'not-required';
  if (corporate?.status === 'blocked') {
    return { pending: true, checkedAt: corporate.checkedAt, label: '价格与公司行为：未通过',
      note: corporate.reason || member?.reconciliation?.reason || '公司行为资料核验未通过，暂停该股自动执行' };
  }
  const check = member?.automaticCheck;
  if (check?.phase === 'prepared' && check.status === 'waiting') {
    return { pending: true, checkedAt: check.checkedAt, label: '盘前资料已准备 · 等待当日行情与基准', note: check.reason };
  }
  if (check?.status === 'clear' && member.awaitingVerification) {
    return { pending: true, label: '价格与公司行为：等待重新核验',
      note: '对账后等待新鲜行情与日线重新核验价格基准，暂停该股自动执行' };
  }
  if (check && ['clear', 'waiting', 'blocked'].includes(check.status)) {
    return { pending: check.status !== 'clear', checkedAt: check.checkedAt,
      label: withoutCorporate ? ({ clear: '价格基准：通过', waiting: '价格基准：等待核验', blocked: '价格基准：未通过' })[check.status] : ({ clear: '价格与公司行为：通过', waiting: '价格与公司行为：等待核验', blocked: '价格与公司行为：未通过' })[check.status],
      note: check.reason || (withoutCorporate ? '无持仓权益，首次开仓无需公司行为公告前置；尚未核验公司行为资料。' : '限定公告窗口与价格基准已检查，不等于全部事件已核验') };
  }
  const pending = member?.reconciliation?.status !== 'clear' || member?.awaitingVerification;
  if (withoutCorporate) return { pending, label: pending ? '价格基准：等待核验' : member?.lastVerifiedAt ? '价格基准：通过' : '价格基准：尚未检查',
    note: member?.reconciliation?.reason || '无持仓权益，首次开仓无需公司行为公告前置；仍须核验行情与完整日线。' };
  return { pending, label: pending ? '价格与公司行为：等待核验' : member?.lastVerifiedAt ? '价格与公司行为：通过' : '价格与公司行为：尚未检查',
    note: pending ? member?.reconciliation?.reason || '等待新鲜行情与公告复核，暂停该股自动执行'
      : member?.lastVerifiedAt ? '限定公告窗口与价格基准已检查，不等于全部事件已核验' : '等待新鲜行情与公告资料，尚未完成价格基准检查' };
}
function agencyCorporateStatus(check) {
  if (!check) return '';
  if (check.status === 'not-required') return '公司行为资料：未核验 · 首次开仓无需公告前置';
  return `公司行为资料：${check.status === 'clear' ? '已核验' : check.status === 'blocked' ? '核验未通过' : '等待核验'}`;
}

function agencyMembersHtml(group) {
  if (agencyUi.memberGroup !== group.id) { agencyUi.memberPage = 1; agencyUi.memberGroup = group.id; }
  const search = $('agency-member-search').value.trim().toLowerCase(), phase = $('agency-member-filter').value;
  const positions = new Map((group.positions || []).map(position => [position.symbol, position]));
  const members = (group.members || []).filter(member => (phase === 'all' || phase === 'held' && positions.has(member.symbol) || agencyMemberPhase(member, positions.has(member.symbol)) === phase) && (!search || member.symbol.includes(search) || (state.quotes[member.symbol]?.name || positions.get(member.symbol)?.name || member.poolCheck?.name || '').toLowerCase().includes(search)));
  const size = 30, pages = Math.max(1, Math.ceil(members.length / size));
  agencyUi.memberPage = Math.max(1, Math.min(agencyUi.memberPage, pages));
  $('agency-member-page-info').textContent = `第 ${agencyUi.memberPage} / ${pages} 页 · ${search || phase !== 'all' ? '筛选后 ' : ''}${members.length} 只 · 每页 ${size} 只`;
  $('agency-member-prev').disabled = agencyUi.memberPage <= 1; $('agency-member-next').disabled = agencyUi.memberPage >= pages;
  if (!group.members?.length) return empty('还没有策略候选', '等待自动选股或点击更新候选池；划入资金并启用策略后，程序核验资料和买点。');
  if (!members.length) return empty('没有匹配的自动交易股票', `可清空搜索或切换成员范围；活跃候选不足 ${agencyActiveCandidateLimit()} 只时按实际数量展示`);
  const visibleMembers = members.slice((agencyUi.memberPage - 1) * size, agencyUi.memberPage * size);
  const decisionsBySymbol = new Map();
  for (const item of (state.agency.decisions || []).slice().reverse()) {
    if ((item.strategyId || item.groupId) !== group.id) continue;
    if (!decisionsBySymbol.has(item.symbol)) decisionsBySymbol.set(item.symbol, []);
    decisionsBySymbol.get(item.symbol).push(item);
  }
  return table(['股票', '持有 / 行情', '最近检查', '明细与操作'], visibleMembers.map(member => {
    const symbol = member.symbol, q = state.quotes[symbol], position = positions.get(symbol);
    const verification = agencyVerificationView(member), corporateStatus = agencyCorporateStatus(member.corporateVerification), standby = agencyMemberPhase(member, !!position) === 'standby';
    const decisions = decisionsBySymbol.get(symbol) || [];
    const latest = decisions.find(item => !['complete', 'request'].includes(item.status));
    return [
      `<button class="screen-stock" data-agency-open="${esc(symbol)}"><strong>${esc(q?.name || position?.name || member.poolCheck?.name || symbol.slice(2))}</strong><small>${esc(symbol.toUpperCase())}</small></button><small>${esc(position && member.mode === 'active' ? '持仓管理' : agencyMemberNames[member.mode] || member.mode)}</small>`,
      `${position ? `${num(position.quantity, 0)} 股 / 可卖 ${num(position.available, 0)}` : '未持仓'}<small>¥ ${num(q?.price ?? position?.price)} · ${esc(timeText(q?.timestamp || position?.quoteTime))}</small>${position ? `<span class="${cls(position.pnl)}">${signed(position.pnl / 100)} 元</span>` : ''}`,
      agencyMonitoringHtml(member, !!position, group),
      `<details class="agency-member-details" data-detail-key="member-review"><summary>条件、核验与操作</summary><div class="agency-member-detail-body"><small>行情与技术模式 · 研究筛查已停用</small>${agencyMemberEntryHtml(member, decisions, !!position)}${standby ? '<div class="agency-member-note agency-standby-note"><b>等待低频重选</b><span>候补不自动刷新开仓资料；自动或手动更新候选池后重选。</span><small>过去的核验与开仓检查不作为候补的当前状态。</small></div>' : `<div class="agency-member-note">${agencyMemberPreparationHtml(symbol, group.id)}<b class="${verification.pending ? 'agency-pending' : member.lastVerifiedAt ? 'teal' : 'muted'}">${verification.label}</b><span>${esc(verification.note)}</span>${dailyHistoryHtml(member.automaticCheck?.dailyHistory)}${corporateStatus ? `<small>${esc(corporateStatus)}</small>` : ''}${verification.checkedAt ? `<small>自动检查 ${esc(timeText(verification.checkedAt))}</small>` : ''}${position?.risk?.note ? `<small>${esc(position.risk.note)}</small>` : ''}${agencyHistoricalDecisionHtml(latest)}</div>`}<div class="agency-row-actions"><button class="table-action" data-agency-reconcile="${esc(symbol)}">核验详情</button><button class="table-action" data-agency-member="close" data-agency-symbol="${esc(symbol)}" ${!position || member.mode === 'closing' ? 'disabled' : ''}>尽快退出</button><button class="text-button" data-agency-member="remove" data-agency-symbol="${esc(symbol)}" ${member.mode === 'removing' ? 'disabled' : ''}>${position ? '退出后移除' : '移出'}</button></div></div></details>`
    ];
  }), visibleMembers.map(member => `${group.id}:${member.symbol}`));
}

function agencyEvidenceHtml(item) {
  const executionCheck = agencyIsRuleDecision(item) ? item.executionCheck : null;
  const basis = executionCheck || item;
  const evidenceItems = Array.isArray(basis.evidence) ? basis.evidence : [];
  const kinds = { quote: '行情', 'completed-unadjusted-daily': '完整未复权日线', finance: '财报', valuation: '估值', notices: '公告标题', corporateActions: '公司行为取证', selectionEvidence: '研究证据', automaticEvidence: '公开资料程序核验' };
  const sources = new Map((Array.isArray(basis.inputSources) ? basis.inputSources : []).map(source => [source.id, source]));
  const noticeSources = [...sources.values()].filter(source => source.kind === 'automaticEvidence' && source.data?.evaluation?.noticeReview);
  const productSources = [...sources.values()].filter(source => source.kind === 'automaticEvidence' && source.data?.evaluation?.checks?.some(check => ['productOutlook', 'sameProduct'].includes(check.key)));
  if (!evidenceItems.length && !noticeSources.length && !productSources.length) return '';
  const details = evidenceItems.map(evidence => {
    const source = sources.get(evidence.sourceId), stamp = source?.timestamp || source?.fetchedAt;
    const asOf = source?.data?.asOf || source?.data?.latest?.reportDate;
    const metadata = [source?.source, source?.kind ? kinds[source.kind] || source.kind : '', asOf ? `资料日期 ${asOf}` : '', stamp ? `记录时间 ${timeText(stamp)}` : ''].filter(Boolean);
    return `<div class="agency-evidence-item"><p>${esc(evidence.detail || '未提供具体引用说明')}</p><small>来源编号：${esc(evidence.sourceId || '未提供')}</small>${metadata.length ? `<small>${metadata.map(esc).join(' · ')}</small>` : ''}</div>`;
  }).join('');
  const noticeDetails = noticeSources.map(source => `<div class="agency-evidence-item"><small>${esc(source.source || '敏感公告原文核验')} · 来源编号：${esc(source.id || '未提供')}</small>${agencyNoticeReviewHtml(source.data.evaluation.noticeReview)}</div>`).join('');
  const productDetails = productSources.map(source => `<div class="agency-evidence-item"><small>${esc(source.source || '已披露经营证据核验')} · 来源编号：${esc(source.id || '未提供')}</small>${agencyPoolEvidenceHtml(source.data.evaluation)}</div>`).join('');
  return `<details class="tiny" data-detail-key="decision-evidence"><summary>${executionCheck ? '执行前复核依据' : '查看检查依据'}</summary>${executionCheck?.checkedAt ? `<p>复核时间：${esc(timeText(executionCheck.checkedAt))}</p>` : ''}${details}${noticeDetails}${productDetails}</details>`;
}
function agencyDecisionsHtml(group) {
  const items = (state.agency.decisions || []).filter(item => (item.strategyId || item.groupId) === group.id).slice().reverse().slice(0, 80);
  if (!items.length) return empty('还没有规则检查记录', '每次检查、等待原因、风控复核及模拟执行结果将在这里保留。');
  return items.map(item => {
    const intent = item.intent || item.decision || {}, intentAction = item.action || intent.action;
    const explanation = item.reason || intent.reason || item.rationale || item.error || item.note || '';
    const status = item.status || item.outcome || '已记录';
    const rules = agencyIsRuleDecision(item), weightLabel = rules ? intentAction === 'hold' ? '当前仓位' : '仓位上限' : '目标仓位';
    const weight = Number.isFinite(item.targetPercent) && (!rules || ['buy', 'hold'].includes(intentAction)) ? `<span>${weightLabel} ${num(item.targetPercent)}%</span>` : '';
    const execution = item.execution, hasFill = Number.isFinite(execution?.price) && Number.isFinite(execution?.quantity);
    const entryCheck = item.executionCheck?.entryConditionsCheck || item.entryConditionsCheck;
    const fill = hasFill ? `<p class="tiny">实际模拟成交：${num(execution.quantity, 0)} 股 · 成交价 ¥ ${num(execution.price)}${Number.isFinite(execution.fees?.total) ? ` · 费用 ¥ ${cash(execution.fees.total)}` : ''}${execution.time ? ` · ${esc(timeText(execution.time))}` : ''}</p>` : '';
    const result = item.message || item.result || (!hasFill ? item.execution : '');
    return `<article class="agency-decision" data-render-key="${esc(item.id || `${group.id}:${item.symbol || ''}:${item.createdAt || item.time || item.checkedAt}:${item.action || ''}:${item.status || ''}`)}"><div><span>${esc(timeText(item.createdAt || item.time || item.checkedAt))}</span><b>${esc(state.quotes[item.symbol]?.name || item.symbol || group.name)}</b><span class="small-badge agency-decision-source">${esc(agencyDecisionSource(item))}</span><span class="small-badge">${esc(agencyActionNames[intentAction] || intentAction || '检查')}</span><span>${esc(agencyDecisionStatus[status] || agencyText(status))}</span>${weight}</div><p>${esc(agencyText(explanation))}</p>${result ? `<p class="tiny">程序复核 / 执行：${esc(agencyText(result))}</p>` : ''}${independentFinanceHtml(item.executionCheck?.financeCheck ? item.executionCheck : item)}${entryCheck ? agencyEntryCheckHtml(entryCheck, group.positions?.some(position => position.symbol === item.symbol)) : ''}${fill}${agencyEvidenceHtml(item)}${intent.expiresAt || item.expiresAt ? `<small>意图有效至 ${esc(timeText(intent.expiresAt || item.expiresAt))}</small>` : ''}</article>`;
  }).join('');
}

function renderAgencyRuntime() {
  renderAgencyMarketRegime();
  const runtime = state.agency?.runtime, ready = runtime?.decisionMode === 'rules';
  const interval = Number.isFinite(runtime?.intervalSeconds) && runtime.intervalSeconds > 0 ? runtime.intervalSeconds : 300;
  const intervalText = interval % 60 === 0 ? `${interval / 60} 分钟` : `${interval} 秒`;
  $('agency-runtime-badge').textContent = ready ? `固定规则 · v${runtime.rulesVersion || '1'}` : '正在加载规则';
  $('agency-runtime-frequency').textContent = `盘前为活跃成员准备行情与完整日线；持仓及历史权益另查公司行为，候补不参加开仓资料准备；获取失败后约每分钟重试；开市复用仍有效的资料，补核当日行情与价格基准。交易时段规则每批检查 ${runtime?.batchSize || 20} 只，未完成时随行情刷新继续下一批，全部处理后再按 ${intervalText}间隔启动新一轮。完整轮次耗时取决于候选数量和数据服务；持仓退出独立刷新检查。`;
  setHtml('agency-runtime-preparation', agencyPreparationHtml(runtime?.preparation));
  $('agency-runtime-preparation')?.classList.toggle('hidden', !runtime?.preparation);
  const active = (runtime?.runningGroups || []).map(id => agencyGroups().find(group => group.id === id)?.name || id);
  $('agency-runtime-status').textContent = !ready ? '等待自动交易运行状态。' : [
    runtime.online === false ? '行情不可用，等待恢复' : '行情服务已连接',
    runtime.session?.label || '等待交易时段核验',
    active.length ? `正在检查：${active.join('、')}` : '等待下一轮规则检查'
  ].join(' · ');
  const coverage = runtime?.coverage?.[agencyUi.strategyId], group = agencyGroup(), memberCounts = group ? agencyMemberCounts(group) : null;
  $('agency-runtime-coverage').textContent = group?.mode === 'stopped' ? `${group.name}：自动买卖已停止，公司行为权益仍会核验并按日期处理。`
    : memberCounts?.standby && !memberCounts.active && !memberCounts.held ? `${group.name}：当前 ${memberCounts.standby} 只成员均为候补，不参与高频刷新。请更新四策略候选池重新筛选与排序。`
    : coverage?.total ? `${group?.name || '当前策略'} · 本轮已处理 ${coverage.processed} / ${coverage.total} 只（含规则拦截） · 剩余 ${coverage.remaining} 只${coverage.status === 'complete' ? ' · 本轮完成' : coverage.status === 'checking' ? ' · 正在检查' : ' · 等待续检'}。${group?.mode === 'paused' ? '暂停新开仓期间仅检查持仓。' : ''}`
      : group?.mode === 'paused' ? `${group.name}：暂停新开仓；后台继续准备资料，启用后分批检查活跃候选，候补不参与高频刷新。` : '后台自动准备资料，开盘后取得有效行情将自动开始规则检查。';
  $('agency-runtime-error').textContent = runtime?.lastError || '';
  $('agency-runtime-error').classList.toggle('hidden', !runtime?.lastError);
  const notice = state.agency?.migrationNotice;
  const key = `guanlan-rules-migration:${state.agency?.epoch || 'account'}:${state.agency?.version || '1'}:${runtime?.rulesVersion || '1'}`;
  let dismissed = agencyUi.dismissedMigration === key;
  try { dismissed ||= localStorage.getItem(key) === 'acknowledged'; } catch {}
  $('agency-migration').classList.toggle('hidden', !notice || dismissed);
  $('agency-migration-note').textContent = typeof notice === 'string' ? notice : notice?.message || '';
  $('agency-migration-dismiss').dataset.storageKey = key;
}

function agencyMarketPreparationHtml(preparation) {
  if (!preparation) return '';
  const labels = { ready: '市场盘前资料已准备', partial: '市场资料仍有缺项', loading: '正在准备市场资料', failed: '市场资料准备异常', idle: '等待市场资料准备' };
  const indices = preparation.indices, universe = preparation.universe;
  const details = [indices ? `指数完整日线 ${num(indices.ready || 0, 0)} / ${num(indices.total || 3, 0)}` : '',
    universe?.ready ? `证券名单 ${num(universe.count, 0)} 只已核对` : '证券名单待核对'].filter(Boolean);
  const missing = [...(preparation.missing || []), ...(!universe?.ready && universe?.error ? [universe.error] : [])];
  const live = preparation.liveRequired || [];
  const liveLabel = state.agency?.runtime?.session?.open ? '实时判断继续依赖' : '开市后仍需';
  return `<div data-market-preparation="${esc(preparation.status || 'idle')}"><b class="${preparation.ready ? 'teal' : 'agency-pending'}">${esc(labels[preparation.status] || labels.idle)}</b><span>${details.map(esc).join(' · ')}</span>${preparation.preparedAt ? `<small>资料检查 ${esc(timeText(preparation.preparedAt))}</small>` : ''}${missing.length ? `<span class="agency-pending">${[...new Set(missing)].map(esc).join('；')}</span>` : ''}<small>${live.length ? `${liveLabel}：${live.map(esc).join('、')}。` : ''}资料准备完成不代表策略信号成立；市场环境改善仍需至少 120 秒确认。</small></div>`;
}

function agencyMarketDisplay(snapshot) {
  const names = { strong: '当日广度偏强', neutral: '当日广度中性', weak: '当日广度偏弱', unknown: '市场资料待核验' };
  const candidate = snapshot?.metrics?.candidateStatus;
  const awaitingConfirmation = ['strong', 'neutral', 'weak'].includes(candidate);
  return { awaitingConfirmation, label: awaitingConfirmation ? `${names[candidate]} · 待持续确认` : names[snapshot?.status] || names.unknown };
}

function renderAgencyMarketRegime() {
  const card = $('agency-market-regime');
  if (!card) return;
  const snapshot = state.agency?.runtime?.marketRegime, enabled = state.agency?.marketPolicy?.enabled === true;
  const now = Number.isFinite(state.now) ? state.now : Date.now();
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const fresh = snapshot?.version === 1 && snapshot.policyVersion === 2 && snapshot.date === today
    && Number.isFinite(snapshot.checkedAt) && snapshot.checkedAt <= now && snapshot.expiresAt > now;
  const status = fresh && ['strong', 'neutral', 'weak'].includes(snapshot.status) ? snapshot.status : 'unknown';
  const multiplier = enabled && fresh && ['strong', 'neutral'].includes(status) && snapshot.allowEntry === true && [0.5, 1].includes(snapshot.riskMultiplier) ? snapshot.riskMultiplier : 0;
  const breakout = multiplier === 1 && status === 'strong' && snapshot.allowBreakout === true;
  const display = agencyMarketDisplay(fresh ? snapshot : null);
  card.dataset.marketStatus = enabled ? status : 'disabled';
  $('agency-market-badge').textContent = enabled ? `${display.label} · ${fresh && snapshot?.metrics?.highVolatility ? '高波动 · ' : ''}${multiplier === 1 ? '正常风险预算' : multiplier === 0.5 ? '半额风险预算' : '暂停新开仓'}` : '市场环境过滤未启用';
  $('agency-market-badge').className = 'small-badge ' + (enabled && !multiplier ? 'agency-pending' : multiplier === 1 ? 'teal' : '');
  $('agency-market-summary').textContent = !enabled ? '当前未启用市场环境过滤；按固定策略、资金及其他风控条件检查新开仓。'
    : !multiplier ? '当前暂停四类策略新开仓；已有持仓继续执行原退出计划。'
      : breakout ? '超短线、短线和波段可检查回踩或突破条件；长线仍只检查回踩条件。已有持仓不自动加仓。'
        : '四类策略仅检查回踩条件，单笔及策略总计划风险预算减半；已有持仓不自动加仓。';
  const acquisition = snapshot?.acquisition, loading = enabled && acquisition?.loading === true;
  const prepared = enabled && !loading && acquisition?.stage === 'prepared';
  setHtml('agency-market-preparation', enabled ? agencyMarketPreparationHtml(snapshot?.preparation) : '');
  $('agency-market-preparation')?.classList.toggle('hidden', !enabled || !snapshot?.preparation);
  card.setAttribute('aria-busy', String(loading));
  const reason = enabled && snapshot && snapshot.policyVersion !== 2
    ? '市场环境规则已更新，等待按当日广度与指数波动重新核验。'
    : enabled && snapshot && !fresh && snapshot.status !== 'unknown'
      ? '市场证据已过期或跨日，等待重新核验。' : snapshot?.reason || '等待指数完整日线、同日指数报价与全市场广度资料。';
  const stage = ({ indices: '指数日线', 'index-history': '指数日线', universe: '股票名单', 'screen-quotes': '全市场报价', 'breadth-quotes': '全市场报价',
    fallback: '切换备用来源', evaluating: '核对市场证据', cached: '核对已获取资料', complete: '核对市场证据' })[acquisition?.stage] || '市场资料';
  const progress = Number.isFinite(acquisition?.total) && acquisition.total > 0
    ? ` · 已完成 ${num(Math.max(0, acquisition.completed || 0), 0)} / ${num(acquisition.total, 0)}` : '';
  $('agency-market-reason').textContent = loading
    ? `正在重新获取市场环境：${stage}${acquisition.providerLabel ? `（${acquisition.providerLabel}）` : ''}${progress}。${acquisition.fallbackReason ? `本轮切换原因：${acquisition.fallbackReason}。` : ''}${acquisition.lastError
      ? `上次失败（${timeText(acquisition.lastErrorAt)}）：${acquisition.lastError}` : '当前开仓权限仍按已完成的有效证据判断。'}`
    : `${reason}${acquisition?.source && acquisition.fallbackReason ? ` 本轮已使用备用来源：${acquisition.source}。` : ''}`;
  const breadth = snapshot?.metrics?.breadth, group = agencyGroup(), risk = group?.limits?.riskPercent;
  setHtml('agency-market-metrics', `<div><span>当日市场广度 · 上涨占比</span><strong>${pct(breadth?.advanceRatio)}</strong><small>${breadth ? `${num(breadth.advancing, 0)} 涨 / ${num(breadth.valid, 0)} 有效` : '等待沪深 A 股快照'}</small></div>`
    + `<div><span>广度有效覆盖</span><strong>${pct(breadth?.coverage)}</strong><small>${breadth ? `${num(breadth.valid, 0)} / ${num(breadth.expected, 0)} 只 · 不含北交所` : '缺少有效覆盖证据'}</small></div>`
    + `<div><span>当前策略单笔风险预算上限</span><strong>${!enabled ? '按策略设置' : !multiplier ? '暂停新开仓' : Number.isFinite(risk) ? num(risk * multiplier) + '% 权益' : num(multiplier * 100, 0) + '% 原预算'}</strong><small>${enabled && multiplier && Number.isFinite(risk) ? `设置 ${num(risk)}% × ${num(multiplier * 100, 0)}%` : '计划止损估算，不是实际亏损上限'}</small></div>`);
  $('agency-market-time').textContent = prepared
    ? `历史资料准备完成 ${timeText(acquisition.finishedAt)} · 指数日线截至 ${acquisition.prepared?.[0]?.asOf || '待核验'} · 实时市场环境待开盘后自动确认`
    : `${loading ? `本次获取开始 ${timeText(acquisition.startedAt)} · ` : acquisition?.finishedAt ? `最近获取完成 ${timeText(acquisition.finishedAt)} · ` : ''}${snapshot && !fresh ? '最近证据已失效 · ' : ''}广度来源：${breadth?.source || acquisition?.source || '待获取'} · 原始行情最早时间 ${timeText(snapshot?.evidence?.quoteTime)} · 核验 ${timeText(snapshot?.checkedAt)} · 有效至 ${timeText(snapshot?.expiresAt)}`;
  const indices = snapshot?.metrics?.indices || [];
  setHtml('agency-market-indices', indices.length ? table(['指数', '完整日线', '中期趋势（仅观察）', '5 日 MA20 变化（仅观察）', 'ATR / 收盘价', '指数原始报价时间'], indices.map(index => [
    esc(({ sh000001: '上证指数', sz399001: '深证成指', sz399006: '创业板指' })[index.symbol] || index.symbol), dailyHistoryHtml(index.dailyHistory) || esc(index.asOf),
    esc(({ up: '向上', down: '向下', mixed: '未形成一致趋势' })[index.trend] || '待核验'), pct(index.ma20Slope5), pct(index.atrRatio), esc(timeText(index.quoteTime))
  ])) : '<p class="tiny">尚无可核验的指数趋势数据。</p>');
  $('agency-market-policy-note').textContent = snapshot?.policyNote || '市场环境阈值为尚未回测及样本外验证的产品模板，不代表收益优势。';
}

async function agencyRequest(key, name, payload, success) {
  if (agencyUi.busy.has(key)) return false;
  agencyUi.busy.add(key); renderAgency();
  try { const result = await api(name, payload); renderState(await api('state')); if (success) toast(success); return result ?? true; }
  finally { agencyUi.busy.delete(key); renderAgency(); }
}


function agencyReconcileCurrent(context) {
  return context && agencyUi.reconcileContext === context && $('agency-reconcile-dialog').open;
}

function agencyCorporateEvents(group, symbol) {
  return (state.agency.corporateEvents || group.corporateEvents || []).filter(event => event.symbol === symbol && (event.strategyId || event.owner) === group.id).slice().reverse();
}

function agencyCorporateActions(group, symbol) {
  return (state.agency.corporateActions || group.corporateActions || []).filter(item => (!symbol || item.symbol === symbol) && (Array.isArray(item.entitlements) && item.entitlements.length ? item.entitlements.some(entitlement => entitlement.strategyId === group.id) : group.members?.some(member => member.symbol === item.symbol) || (state.account?.trades || []).some(trade => trade.owner === group.id && trade.symbol === item.symbol)));
}

function agencyCorporateCheck(group, symbol) {
  const check = state.agency.corporateChecks?.[symbol];
  if (check?.strategyIds?.includes(group.id)) return check;
  return group.members?.find(member => member.symbol === symbol)?.corporateVerification;
}

function agencyCorporateHistoryHtml(group) {
  const actions = agencyCorporateActions(group), records = (state.agency.corporateEvents || group.corporateEvents || []).filter(item => item.strategyId === group.id);
  const checks = Object.entries(state.agency.corporateChecks || {}).filter(([, check]) => check.strategyIds?.includes(group.id));
  const symbols = [...new Set([...checks.filter(([, check]) => check.status === 'blocked').map(([symbol]) => symbol), ...actions.filter(item => item.status === 'exception').map(item => item.symbol), ...actions.map(item => item.symbol), ...records.slice().reverse().map(item => item.symbol), ...checks.filter(([, check]) => check.events?.length).map(([symbol]) => symbol)])];
  if (!symbols.length) return '<p class="tiny">暂无公司行为处理记录。识别的到期事件、入账流水与已移出股票的历史权益会保留在这里。</p>';
  return symbols.map(symbol => {
    const symbolActions = actions.filter(item => item.symbol === symbol), exceptions = symbolActions.filter(item => item.status === 'exception');
    const check = agencyCorporateCheck(group, symbol);
    const unfinished = symbolActions.filter(item => !['completed', 'no-entitlement'].includes(item.status));
    const title = check?.status === 'blocked' ? '本次资料核验异常' : exceptions.length ? `${exceptions.length} 项异常待核实` : unfinished.length ? `${unfinished.length} 项权益等待后续处理` : records.some(item => item.symbol === symbol) ? '已有公司行为处理记录' : '已识别公司行为方案';
    const reason = check?.status === 'blocked' ? check.reason : exceptions[0]?.blockedReason;
    return `<article class="agency-corporate-evidence"><div><strong>${esc(state.quotes[symbol]?.name || symbol)} · ${esc(symbol.toUpperCase())}</strong><small>${esc(title)}${group.members?.some(member => member.symbol === symbol) ? '' : ' · 已移出，保留历史权益'}</small>${reason ? `<p class="agency-pending">${esc(reason)}</p>` : ''}</div><button class="table-action" type="button" data-agency-reconcile="${esc(symbol)}">核验详情</button></article>`;
  }).join('');
}

function agencyCorporateRecordHtml(item) {
  const automatic = item.automatic || item.source === 'automatic' || item.mode === 'automatic';
  const facts = [item.recordDate ? '登记日 ' + item.recordDate : '', item.effectiveDate ? '生效日 ' + item.effectiveDate : '', Number.isFinite(item.cash) ? '净入账现金 ¥ ' + cash(item.cash) : '', Number.isFinite(item.grossCash) ? '税前分红 ¥ ' + cash(item.grossCash) : '', Number.isFinite(item.taxPaid) ? '已扣税 ¥ ' + cash(item.taxPaid) : '', Number.isFinite(item.quantity) ? '登记数量 ' + num(item.quantity, 0) + ' 股' : '', Number.isFinite(item.quantityAdded) ? '新增 ' + num(item.quantityAdded, 0) + ' 股' : ''].filter(Boolean);
  return `<article class="agency-corporate-record"><div><b>${automatic ? '自动处理' : item.confirmationOnly ? '人工核验' : '人工对账'}</b><time>${esc(timeText(item.createdAt || item.time || item.processedAt))}</time></div><p>${esc(item.reason || item.note || item.eventId || '公司行为记录')}</p><small>${facts.map(esc).join(' · ')}</small>${item.evidence ? `<p class="tiny">${esc(agencyText(item.evidence))}</p>` : ''}</article>`;
}

function agencyCorporateActionHtml(item) {
  const phases = { scheduled: '已安排到期检查', registered: '已确认登记日权益', 'ex-applied': '已调整除权基准 · 等待权益到账', completed: '已完成入账', exception: '异常待人工核实', 'no-entitlement': '登记日无对应持仓权益', planned: '方案尚未实施 · 后续自动复核', cancelled: '方案已取消', unsupported: '异常待人工核实', implemented: '已识别实施方案 · 等待权益核验' };
  const terms = item.terms || item;
  const facts = [['登记日', terms.recordDate], ['除权除息日', terms.exDate], ['派息日', terms.payDate], ['股份可卖日期', terms.listingDate]].filter(([, value]) => value).map(([label, value]) => `${label} ${value}`);
  return `<article class="agency-corporate-record"><div><b>${esc(phases[item.status] || item.status || '等待自动检查')}</b></div><p>${esc(item.title || item.eventId || '公司行为事件')}</p>${item.blockedReason || item.reason ? `<p class="agency-pending">${esc(item.blockedReason || item.reason)}</p>` : ''}<small>${facts.map(esc).join(' · ')}</small></article>`;
}

function renderAgencyReconcile() {
  const context = agencyUi.reconcileContext; if (!context) return;
  const group = agencyGroups().find(item => item.id === context.strategyId), member = group?.members?.find(item => item.symbol === context.symbol);
  const rec = member?.reconciliation, verification = group ? agencyCorporateCheck(group, context.symbol) : null;
  const withoutCorporate = verification?.status === 'not-required';
  $('agency-corporate-description').textContent = withoutCorporate
    ? '无持仓权益，首次开仓仅核验行情与完整日线价格基准，无需先获取公司行为公告。成交后继续核验持仓权益。'
    : '程序自动收集公告、核对登记日权益并处理支持的公司行为。资料缺失、冲突或不支持的事件会列出原因，只有这些异常需要补充。';
  const automatic = member?.automaticCheck ? agencyVerificationView(member) : null;
  const historical = (state.account?.trades || []).some(item => item.owner === context.strategyId && item.symbol === context.symbol);
  const stages = group ? agencyCorporateActions(group, context.symbol) : [];
  $('agency-reconcile-title').textContent = `${state.quotes[context.symbol]?.name || context.symbol} · 核验详情`;
  $('agency-reconcile-reason').textContent = automatic?.note || rec?.reason || verification?.reason || (!member ? (stages.find(item => item.blockedReason)?.blockedReason || '该股票已移出策略，历史权益仍会继续自动核验；可查看公告、处理进度及流水。') : '程序自动收集公告并核对持仓权益；只有无法自动判定的异常才需要补充。');
  const records = group ? agencyCorporateEvents(group, context.symbol) : [];
  const isBusy = agencyUi.busy.has('verify:' + context.strategyId) || agencyUi.busy.has('verify:' + context.strategyId + ':' + context.symbol);
  const pending = member && (automatic ? automatic.pending : rec?.status !== 'clear' || member.awaitingVerification);
  $('agency-reconcile-status').textContent = isBusy ? '正在自动核验…' : verification?.status === 'blocked' ? '本次资料核验异常' : pending ? automatic?.label || '等待自动检查或异常补充' : withoutCorporate ? '价格基准已核验 · 公司行为资料未核验' : records.some(item => item.automatic || item.source === 'automatic') ? '已有自动处理流水' : !member ? '已移出 · 历史权益' : verification?.status === 'clear' || member?.lastVerifiedAt ? '当前资料已核验 · 暂无自动入账流水' : '等待自动检查';
  setHtml('agency-reconcile-daily', dailyHistoryHtml(member?.automaticCheck?.dailyHistory));
  $('agency-reconcile-checked').textContent = [automatic?.checkedAt ? `自动检查 ${timeText(automatic.checkedAt)}` : '', agencyCorporateStatus(verification), verification?.checkedAt ? `公司行为检查 ${timeText(verification.checkedAt)}` : '', verification?.coverageStart ? `资料区间 ${verification.coverageStart} 至 ${verification.coverageEnd || '未提供结束日期'}` : ''].filter(Boolean).join(' · ');
  $('agency-reconcile-verify').disabled = !member && !historical || isBusy || agencyUi.busy.has('reconcile:' + context.strategyId + ':' + context.symbol);
  $('agency-reconcile-submit').disabled = !member || isBusy || agencyUi.busy.has('reconcile:' + context.strategyId + ':' + context.symbol);
  $('agency-reconcile-manual').classList.toggle('hidden', !member);
  const evidence = (Array.isArray(rec?.evidence) ? rec.evidence : []).filter(item => item && typeof item === 'object' && (!item.symbol || item.symbol === context.symbol));
  const seen = new Set(evidence.map(item => item.id).filter(Boolean));
  for (const item of verification?.evidence || []) {
    if (item && (!item.symbol || item.symbol === context.symbol) && !seen.has(item.id)) { evidence.push(item); if (item.id) seen.add(item.id); }
  }
  for (const item of [...stages, ...records]) for (const id of item.noticeIds || []) {
    if (!seen.has(id)) { seen.add(id); evidence.push({ id, title: item.title || '公司行为来源公告', date: '' }); }
  }
  context.evidence = evidence;
  setHtml('agency-reconcile-evidence-list', evidence.length ? evidence.map((item, index) => `<article class="agency-corporate-evidence"><div><strong>${esc(item.title || item.reason || '公司行为核验依据')}</strong><small>${[item.date, item.id, item.source].filter(Boolean).map(esc).join(' · ')}</small></div>${/^(?:AN|CN)\d{10,30}$/.test(item.id || '') ? `<button class="table-action" type="button" data-agency-notice="${index}">查看公告原文 ↗</button>` : '<span class="tiny">尚未获取可用公告编号</span>'}</article>`).join('') : withoutCorporate ? '<p class="tiny">首次开仓无需公司行为公告前置，本次未收集公告。</p>' : '<p class="tiny">本次尚无可展示的公告；可重新自动核验，程序会补查所需资料。</p>');
  setHtml('agency-reconcile-events', records.length ? records.map(agencyCorporateRecordHtml).join('') : '<p class="tiny">暂无该股票的公司行为处理流水。</p>');
  const displayedEvents = [...stages, ...(verification?.events || []).filter(item => !stages.some(stage => stage.eventId === item.eventId))];
  setHtml('agency-reconcile-stages', displayedEvents.length ? displayedEvents.map(agencyCorporateActionHtml).join('') : '<p class="tiny">尚无已登记的公司行为事件。</p>');
}

function agencyVerificationSummary(result) {
  const summary = result?.summary || result;
  if (!summary || !Number.isFinite(summary.checked)) return '自动核验已完成，请查看股票状态与处理流水';
  const environment = result?.marketRegime, display = agencyMarketDisplay(environment);
  const permission = environment?.allowEntry !== true ? '暂停新开仓'
    : display.awaitingConfirmation ? environment.riskMultiplier === 0.5 ? '当前半额风险预算' : '按已确认预算' : '已确认';
  const marketSummary = environment ? ` · 市场环境：${display.label}（${permission}）` : '';
  return `已检查 ${summary.checked} 只 · 通过 ${summary.clear || 0} 只 · 等待 ${summary.waiting || 0} 只 · 异常 ${summary.blocked || 0} 只${summary.skipped ? ` · 跳过 ${summary.skipped} 只` : ''}${summary.cached ? ` · 复用有效日线 ${summary.cached} 只${summary.degraded ? `（其中刷新失败 ${summary.degraded} 只）` : ''}` : summary.degraded ? ` · 日线刷新失败 ${summary.degraded} 只` : ''}${marketSummary}`;
}

async function agencyVerify(strategyId, symbol, context) {
  const key = 'verify:' + strategyId + (symbol ? ':' + symbol : '');
  if (agencyUi.busy.has(key) || agencyUi.busy.has('verify:' + strategyId)) return;
  if (!symbol && [...agencyUi.busy].some(item => item.startsWith('verify:' + strategyId + ':'))) return;
  agencyUi.busy.add(key); renderAgency(); if (agencyReconcileCurrent(context)) renderAgencyReconcile();
  try {
    const result = await api('agency:verify', { strategyId, ...(symbol ? { symbol } : {}) });
    renderState(await api('state'));
    if (!context || agencyReconcileCurrent(context)) {
      if (context) { $('agency-reconcile-auto-result').textContent = agencyVerificationSummary(result); renderAgencyReconcile(); }
      else toast(agencyVerificationSummary(result));
    }
  } catch (error) {
    if (!context) throw error;
    if (agencyReconcileCurrent(context)) $('agency-reconcile-auto-result').textContent = error.message;
  } finally {
    agencyUi.busy.delete(key); renderAgency(); if (agencyReconcileCurrent(context)) renderAgencyReconcile();
  }
}

function openAgencyReconcile(symbol) {
  const group = agencyGroup(); if (!group || !group.members?.some(member => member.symbol === symbol) && !agencyCorporateEvents(group, symbol).length && !agencyCorporateActions(group, symbol).length && !agencyCorporateCheck(group, symbol)) return;
  agencyUi.reconcileContext = { strategyId: group.id, symbol, session: ++agencyUi.reconcileSession, evidence: [] };
  $('agency-reconcile-form').reset();
  $('agency-reconcile-symbol').value = symbol;
  $('agency-reconcile-group').value = group.id;
  $('agency-reconcile-manual').open = false;
  $('agency-reconcile-auto-result').textContent = '';
  $('agency-reconcile-event-fields').classList.add('hidden');
  for (const id of ['agency-reconcile-shareNumerator', 'agency-reconcile-shareDenominator', 'agency-reconcile-recordDate', 'agency-reconcile-riskPriceFactor']) $(id).required = false;
  $('agency-reconcile-error').textContent = '';
  renderAgencyReconcile();
  $('agency-reconcile-dialog').showModal();
}

function selectAgencyGroup(strategyId, phase = 'active') {
  agencyUi.strategyId = strategyId; agencyUi.limitsDirty = false; agencyUi.memberPage = 1;
  $('agency-member-filter').value = phase; $('agency-member-search').value = '';
  renderAgency();
}
$('agency-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-agency-tab]'); if (!button) return;
  selectAgencyGroup(button.dataset.agencyTab);
});
for (const id of ['agency-member-search', 'agency-member-filter']) $(id).addEventListener(id.endsWith('search') ? 'input' : 'change', () => { agencyUi.memberPage = 1; renderAgency(); });
$('agency-member-prev').addEventListener('click', () => { agencyUi.memberPage--; renderAgency(); });
$('agency-member-next').addEventListener('click', () => { agencyUi.memberPage++; renderAgency(); });
$('agency-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const groups = agencyGroups(), current = groups.findIndex(group => group.id === agencyUi.strategyId);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + groups.length) % groups.length;
  if (!groups[index]) return; event.preventDefault(); selectAgencyGroup(groups[index].id);
  $('agency-tabs').querySelector('[aria-selected="true"]')?.focus();
});
$('agency-migration-dismiss').addEventListener('click', () => {
  const key = $('agency-migration-dismiss').dataset.storageKey; agencyUi.dismissedMigration = key;
  try { localStorage.setItem(key, 'acknowledged'); } catch {}
  $('agency-migration').classList.add('hidden');
});
$('page-agency').addEventListener('click', event => {
  const select = event.target.closest('[data-agency-select]'), disclosure = event.target.closest('[data-agency-disclosure]');
  if (select) { selectAgencyGroup(select.dataset.agencySelect, select.dataset.agencyPhase || 'active'); $('agency-group-panel').scrollIntoView({ block: 'start' }); }
  if (disclosure) { const panel = $(disclosure.dataset.agencyDisclosure); panel.open = true; panel.scrollIntoView({ block: 'start' }); panel.querySelector('summary, button')?.focus({ preventScroll: true }); }
  const mode = event.target.closest('[data-agency-mode]'), member = event.target.closest('[data-agency-member]'), reconcile = event.target.closest('[data-agency-reconcile]'), open = event.target.closest('[data-agency-open]');
  if (mode) action(async () => {
    const strategyId = agencyUi.strategyId, next = mode.dataset.agencyMode;
    if (next === 'stopped' && !await confirmDialog('停止该策略全部自动操作', `<p>${esc(agencyGroup()?.name)}的新开仓和持仓自动卖出都会停止。未平仓股票继续占用策略资金，恢复前需要自行关注持仓。</p>`)) return;
    await agencyRequest('mode', 'agency:mode', { strategyId, mode: next }, '自动交易模式已更新');
  });
  if (member) action(async () => {
    const strategyId = agencyUi.strategyId, symbol = member.dataset.agencySymbol, memberAction = member.dataset.agencyMember;
    if (memberAction === 'close' && !await confirmDialog('尽快退出该股票', `<p>${esc(state.quotes[symbol]?.name || symbol)}将停止新开仓，并在程序允许成交时卖出。T+1、停牌、缺少买盘及待对账状态可能延迟退出；不能保证当前价格成交。</p>`)) return;
    await agencyRequest('member:' + symbol, 'agency:member', { strategyId, symbol, action: memberAction }, memberAction === 'close' ? '已登记尽快退出意图' : '移除请求已保存；有持仓时保留退出管理');
  });
  if (reconcile) openAgencyReconcile(reconcile.dataset.agencyReconcile);
  if (open) { switchPage('market', { detailView: true }); action(() => selectStock(open.dataset.agencyOpen)); }
});
$('agency-run').addEventListener('click', () => action(() => agencyRequest('run', 'agency:run', { strategyId: agencyUi.strategyId }, '已请求本轮规则检查，进度与结果见执行日志')));
$('agency-pool-run').addEventListener('click', () => agencyUpdatePool());
$('agency-pool-retry').addEventListener('click', () => agencyUpdatePool('retry'));
$('agency-pool-cancel').addEventListener('click', () => action(() => agencyRequest('pool-cancel', 'agency:pool:cancel', undefined, '已请求取消本次更新')));
for (const id of ['agency-pool-filter', 'agency-pool-search']) $(id).addEventListener(id.endsWith('search') ? 'input' : 'change', () => { agencyUi.poolPage = 1; agencyUi.poolRenderKey = null; renderAgencyPool(); });
$('agency-pool-prev').addEventListener('click', () => { agencyUi.poolPage--; renderAgencyPool(); });
$('agency-pool-next').addEventListener('click', () => { agencyUi.poolPage++; renderAgencyPool(); });
window.guanlan.subscribeAgencyPoolProgress?.(applyAgencyPoolProgress);
$('agency-verify').addEventListener('click', () => action(() => agencyVerify(agencyUi.strategyId)));
$('agency-reconcile-verify').addEventListener('click', () => {
  const context = agencyUi.reconcileContext; if (context) agencyVerify(context.strategyId, context.symbol, context);
});
$('agency-reconcile-evidence-list').addEventListener('click', event => {
  const button = event.target.closest('[data-agency-notice]'), context = agencyUi.reconcileContext;
  if (!button || !agencyReconcileCurrent(context)) return;
  const item = context.evidence[Number(button.dataset.agencyNotice)];
  if (/^(?:AN|CN)\d{10,30}$/.test(item?.id || '')) action(() => api('research:open', { symbol: context.symbol, kind: 'notice', article: item.id }));
});
$('agency-transfer-form').addEventListener('submit', event => { event.preventDefault(); action(async () => {
  const strategyId = agencyUi.strategyId, amount = Number($('agency-transfer-amount').value);
  if (!amount) throw Error('请输入非零划拨金额');
  await agencyRequest('transfer', 'agency:transfer', { strategyId, amount }, '模拟资金划拨已完成'); $('agency-transfer-amount').value = '';
}); });
$('agency-limits-form').addEventListener('input', () => { agencyUi.limitsDirty = true; });
$('agency-limits-form').addEventListener('submit', event => { event.preventDefault(); action(async () => {
  const strategyId = agencyUi.strategyId, limits = {};
  for (const key of ['maxPosition', 'maxTotalPosition', 'maxPositions', 'riskPercent', 'maxPlannedRiskPercent', 'minRewardRisk']) limits[key] = Number($('agency-limit-' + key).value) / (['maxPosition', 'maxTotalPosition'].includes(key) ? 100 : 1);
  await agencyRequest('limits', 'agency:configure', { strategyId, limits }, '策略资金与风险限制已保存'); agencyUi.limitsDirty = false; renderAgency();
}); });
$('agency-reconcile-cancel').addEventListener('click', () => $('agency-reconcile-dialog').close());
$('agency-reconcile-dialog').addEventListener('close', () => { if (!$('agency-reconcile-dialog').open) agencyUi.reconcileContext = null; });
$('agency-reconcile-kind').addEventListener('change', () => {
  const hasEvent = $('agency-reconcile-kind').value === 'event'; $('agency-reconcile-event-fields').classList.toggle('hidden', !hasEvent);
  for (const id of ['agency-reconcile-shareNumerator', 'agency-reconcile-shareDenominator', 'agency-reconcile-recordDate', 'agency-reconcile-riskPriceFactor']) $(id).required = hasEvent;
});
$('agency-reconcile-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('agency-reconcile-submit'), context = agencyUi.reconcileContext;
  if (button.disabled || !agencyReconcileCurrent(context)) return;
  const key = 'reconcile:' + context.strategyId + ':' + context.symbol; if (agencyUi.busy.has(key)) return;
  agencyUi.busy.add(key); button.disabled = true;
  try {
    const kind = $('agency-reconcile-kind').value; if (!kind) throw Error('请选择核验结论，不会自动清除风险');
    const payload = { strategyId: context.strategyId, symbol: context.symbol, eventId: $('agency-reconcile-eventId').value.trim(), evidence: $('agency-reconcile-evidence').value.trim(), effectiveDate: $('agency-reconcile-effectiveDate').value, confirmationOnly: kind === 'clear' };
    if (kind === 'event') {
      payload.recordDate = $('agency-reconcile-recordDate').value;
      for (const key of ['cashAmount', 'shareNumerator', 'shareDenominator', 'riskPriceFactor']) { const value = $('agency-reconcile-' + key).value; if (value !== '') payload[key] = Number(value); }
    }
    await api('agency:reconcile', payload); renderState(await api('state'));
    if (agencyReconcileCurrent(context)) { $('agency-reconcile-dialog').close(); toast('核验 / 对账结果已保存，请查看成员状态'); }
  } catch (error) { if (agencyReconcileCurrent(context)) $('agency-reconcile-error').textContent = error.message; }
  finally { agencyUi.busy.delete(key); if (agencyReconcileCurrent(context)) renderAgencyReconcile(); }
});
