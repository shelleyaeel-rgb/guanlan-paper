'use strict';
let screenMeta, screenQuery = { scope: 'all', boards: [], excludeST: true, rules: [] }, screenResult, screenBusy = false, screenPage = 1, screenDirty = false, screenTextPending = false;
let screenHistory = [], screenRequestFailed = false;
let screenRiskPage = 1;
let screenFinancePendingPage = 1;
const screenFinanceTemplatePages = { pending: 1, inapplicable: 1 };
let screenAgencyBatch = null, screenAgencyBusy = false;
let screenEntryContext = null;
let screenStrategyId = '', screenStrategyRules = [], screenPersonalRules = [], screenRuleEntries = [], screenInitialized = false, screenMetaPending;
const screenSize = 30;
const screenCountText = r => r.status === 'unavailable' ? '无法筛选' : `${r.matched} 只${(r.technical || r.finance) && r.partial ? ' · 部分股票未判定' : ''}`;
async function loadScreenMeta() {
  if (screenMeta) return screenMeta;
  if (!screenMetaPending) screenMetaPending = api('screener:meta').then(result => screenMeta = result).finally(() => { screenMetaPending = null; });
  return screenMetaPending;
}
function screenPreset() { return screenMeta?.strategies.find(s => s.id === screenStrategyId); }
function syncScreenRules() {
  const entries = new Map();
  for (const [origin, rules] of [['strategy', screenStrategyRules], ['personal', screenPersonalRules]]) rules.forEach((rule, index) => {
    const key = JSON.stringify(rule);
    if (!entries.has(key)) entries.set(key, { rule, refs: [] });
    entries.get(key).refs.push({ origin, index });
  });
  screenRuleEntries = [...entries.values()]; screenQuery.rules = screenRuleEntries.map(e => e.rule);
}
function renderScreenStrategy() {
  const preset = screenPreset();
  $('screen-strategy').value = screenStrategyId;
  $('screen-strategy-info').innerHTML = preset ? `<b>${esc(preset.horizon)}</b><p>${esc(preset.summary)}</p><p>${esc(preset.entryNotes)}</p><p class="tiny">${esc(preset.limitations)}</p>` : screenQuery.performance?.enabled ? '<p>自定义选股已启用预告 / 快报条件，将批量检查近期公告及敏感公告原文。正式财报和开仓规则仍独立核验。</p>' : '<p>自定义选股只按所选条件筛选，公告未批量核验。打开股票后，四类买卖计划都会另查公告；指标匹配不代表公告风险检查通过。</p>';
  if (preset) $('screen-strategy-info').innerHTML += `<p class="screen-risk-policy">四类策略共用公告检查：最近 14 个自然日公告标题，事件待核验或数据不足时单列排除，修改指标不取消检查。${['short', 'ultra-short'].includes(screenStrategyId) ? '当前短线策略另查行情时点、跌停与买盘；当日跌幅达到 5% 暂停候选。5% 为保守观察阈值，未经收益验证。' : '波段、长线沿用各自的价格和财务条件，公告检查独立于持有周期。'}</p>`;
  if (preset?.id === 'long') $('screen-strategy-info').innerHTML += '<p class="screen-risk-policy">长线财务：最近完整年度加权 ROE ≥ 8%；最新累计扣非净利润金额 > 0、同比 ≥ 0、经营现金流净额 > 0 分别核验。最新累计 ROE 仅作趋势观察。下方修改的是本次个人筛选条件；加入自动交易后还须满足内置长线门槛，放宽筛选阈值不能覆盖内置规则。</p>';
  $('screen-description-label').textContent = preset ? '追加我的条件（与策略同时满足）' : '用一句话描述';
  $('screen-parse').textContent = preset ? '追加并选股 ↗' : '文字选股 ↗';
}
function selectScreenStrategy(id) {
  const preset = screenMeta.strategies.find(s => s.id === id);
  if (id && !preset) throw Error('选股策略不存在');
  screenStrategyId = id; screenStrategyRules = structuredClone(preset?.rules || []);
  syncScreenRules(); renderScreenStrategy(); renderScreenRules(); screenChanged(false);
  $('screen-text-status').textContent = `已${preset ? '带入' + preset.name : '移除策略条件'}，个人条件已保留。${screenTextPending ? '输入文字尚未应用，请先追加或清空输入。' : '可修改下方阈值，再点击“开始选股”。'}`;
}
async function initInvestmentStrategies() {
  await loadScreenMeta();
  $('investment-strategies').innerHTML = screenMeta.strategies.map(s => `<article class="investment-strategy"><span class="small-badge">${esc(s.horizon)}</span><h3>${esc(s.name)}</h3><p>${esc(s.summary)}</p><details><summary>开仓观察与限制</summary><p>${esc(s.entryNotes)}</p><p>${esc(s.limitations)}</p></details><button class="outline" data-use-strategy="${esc(s.id)}">用此策略选股 →</button></article>`).join('');
}
function renderScreenHistoryNote() {
  const snapshot = screenHistory.find(s => s.id === $('screen-data-source').value);
  $('screen-history-note').textContent = snapshot ? `历史快照 · 获取 ${timeText(snapshot.fetchedAt)} · 原始报价 ${timeText(snapshot.oldestQuote)} — ${timeText(snapshot.newestQuote)}。所有条件使用此快照，不代表当前行情。` : screenHistory.length ? '历史快照需主动选择；所有条件使用同一份快照，不混用新旧指标。最多保留最近 3 个获取日期的有效快照。' : '尚无历史快照。成功获取有效行情后自动保存，最多保留最近 3 个获取日期；不能补回此前未保存的数据。';
}
async function refreshScreenHistory() {
  try {
    const result = await api('screener:history'), selectedSource = $('screen-data-source').value;
    screenHistory = result.snapshots;
    $('screen-data-source').innerHTML = '<option value="latest">最新行情（选股前自动更新）</option>' + screenHistory.map(s => `<option value="${esc(s.id)}">历史快照 · 获取 ${esc(timeText(s.fetchedAt))} · ${s.count} 只</option>`).join('');
    if (screenHistory.some(s => s.id === selectedSource)) $('screen-data-source').value = selectedSource;
    $('screen-history-warning').textContent = result.warning;
    renderScreenHistoryNote();
  } catch (e) { $('screen-history-warning').textContent = '无法读取历史快照列表：' + e.message; }
}
async function initScreener() {
  if (screenInitialized) return;
  await loadScreenMeta();
  if (screenInitialized) return;
  screenInitialized = true;
  $('screen-strategy').innerHTML = '<option value="">不使用策略 · 自定义选股</option>' + screenMeta.strategies.map(s => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.horizon)}</option>`).join('');
  $('screen-boards').innerHTML = '<legend>板块（不勾选为全部）</legend>' + Object.entries(screenMeta.boards).map(([value, label]) => `<label class="check"><input type="checkbox" value="${value}">${esc(label)}</label>`).join('');
  syncScreenRules(); renderScreenStrategy(); renderScreenRules(); renderScreenCatalog();
  await refreshScreenHistory();
  if (!screenStrategyId) await runScreen();
}
function setScreenBusy(busy) {
  screenBusy = busy;
  $('screen-run').disabled = busy || screenTextPending;
  $('screen-parse').disabled = busy;
  $('screen-reset').disabled = busy;
  $('screen-strategy').disabled = busy;
  document.querySelectorAll('[data-use-strategy]').forEach(el => { el.disabled = busy; });
  document.querySelectorAll('.screen-condition-card input,.screen-condition-card select,.screen-condition-card button').forEach(el => { el.disabled = busy; });
  $('screen-run').disabled = busy || screenTextPending;
  $('screen-description').disabled = busy;
  document.querySelectorAll('[data-screen-example]').forEach(el => { el.disabled = busy; });
  $('screen-cancel').classList.toggle('hidden', !busy);
  if (!busy) { $('screen-cancel').disabled = false; $('screen-cancel').textContent = '取消本次选股'; }
  syncScreenAgency();
  syncScreenEvidenceBusy();
}
function screenChanged(manual = true) {
  screenDirty = true; screenPage = 1;
  if (manual) { $('screen-text-status').textContent = screenTextPending ? '下方条件已编辑；输入文字尚未应用，请先应用或清空输入。' : '已按下方条件编辑，点击“开始选股”应用。'; }
  $('screen-error').classList.add('hidden');
  if (screenResult) $('screen-result-count').textContent = `${screenCountText(screenResult)} · 上次结果，条件待应用`;
  setScreenBusy(false);
  $('screen-rule-count').textContent = `${screenQuery.rules.length} 项数值条件${screenQuery.evidence ? ' + 研究标签' : ''}${screenQuery.research?.enabled ? ` + ${screenQuery.research.rules.length} 项经营研究条件` : ''}`;
}
function renderScreenRules() {
  if (!screenMeta) return;
  syncScreenRules();
  $('screen-scope').value = screenQuery.scope;
  $('screen-exclude-st').checked = screenQuery.excludeST;
  $('screen-boards').querySelectorAll('input').forEach(el => { el.checked = screenQuery.boards.includes(el.value); });
  $('screen-rule-count').textContent = `${screenQuery.rules.length} 项数值条件${screenQuery.evidence ? ' + 研究标签' : ''}${screenQuery.research?.enabled ? ` + ${screenQuery.research.rules.length} 项经营研究条件` : ''}`;
  renderScreenEvidenceControls();
  performanceRuleEditor('screen-performance-controls', { get: () => screenQuery.performance, set: value => { screenQuery.performance = value; screenChanged(); renderScreenStrategy(); }, busy: screenBusy });
  researchRuleEditor('screen-research-controls', { get: () => screenQuery.research, set: value => { screenQuery.research = value; screenChanged(); }, showPath: true, busy: screenBusy });
  $('screen-rules').innerHTML = screenQuery.rules.length ? screenQuery.rules.map((r, i) => {
    const field = screenMeta.fields[r.field];
    const target = field.comparable ? `<select data-part="target" aria-label="${esc(field.label)}比较对象"><option value="number" ${!r.valueField ? 'selected' : ''}>数值</option>${Object.entries(screenMeta.fields).filter(([, f]) => f.comparable).map(([key, f]) => `<option value="${key}" ${r.valueField === key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>` : '';
    const personal = screenRuleEntries[i].refs.some(ref => ref.origin === 'personal'), shared = personal && screenRuleEntries[i].refs.some(ref => ref.origin === 'strategy');
    return `<div class="screen-rule" data-rule="${i}" data-field="${esc(r.field)}" data-origin="${personal ? 'personal' : 'strategy'}"><span>${esc(field.label)}<small class="screen-rule-origin">${shared ? '策略 + 我的条件' : personal ? '我的附加条件' : '策略模板 · 本次筛选'}</small>${r.field === 'roe' ? '<small class="screen-rule-origin">报告期累计，未年化；不是年度 ROE</small>' : r.field === 'annualRoeLatest' ? '<small class="screen-rule-origin">最近完整年度；独立于累计 ROE</small>' : ''}</span><select data-part="op" aria-label="${esc(field.label)}比较方式">${Object.entries(screenMeta.ops).map(([value, label]) => `<option value="${value}" ${value === r.op ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select><div class="screen-operand">${target}${!r.valueField ? `<input data-part="value" type="number" step="any" value="${r.value ?? ''}" aria-label="${esc(field.label)}数值">` : ''}</div><span class="tiny">${r.valueField ? '' : esc(field.unit)}</span><button type="button" data-remove="${i}" class="text-button" aria-label="删除${esc(field.label)}条件">移除 ×</button></div>`;
  }).join('') : '<p class="screen-no-rules tiny">从文字生成条件，或展开下方指标添加。没有数值条件时展示范围内全部股票。</p>';
}
function renderScreenCatalog() {
  const search = $('screen-field-search').value.trim().toLowerCase();
  $('screen-fields').innerHTML = Object.entries(screenMeta.fields).filter(([, f]) => [f.label, ...f.aliases].some(v => v.toLowerCase().includes(search))).map(([key, f]) => `<button type="button" class="subtle" data-field="${key}" title="${esc(f.description || f.label + '（' + f.unit + '）')}">＋ ${esc(f.label)} <small>${esc(f.unit)}</small></button>`).join('') || '<p class="tiny">暂无该指标，请使用已支持的条件。</p>';
}
async function runScreen() {
  if (screenBusy || screenTextPending || !screenMeta) return;
  const researchError = researchRuleError(screenQuery.research) || performanceRuleError(screenQuery.performance) || industryRuleError(screenQuery.evidence?.industry);
  if (researchError) { $('screen-error').textContent = researchError; $('screen-error').classList.remove('hidden'); return; }
  const strategyId = screenStrategyId, strategyName = screenPreset()?.name;
  const personalRules = structuredClone(screenPersonalRules);
  const snapshotId = $('screen-data-source').value === 'latest' ? null : $('screen-data-source').value;
  const force = snapshotId === null;
  setScreenBusy(true); $('screen-error').classList.add('hidden');
  $('screen-progress').classList.remove('hidden'); $('screen-progress').textContent = snapshotId ? '正在按选定历史快照筛选…' : '正在更新选股行情，完成后自动筛选…';
  const poll = setInterval(async () => { try { const p = await api('screener:status'); if (screenBusy && !snapshotId && p.total) $('screen-progress').textContent = p.stage === 'universe' ? `正在获取股票列表 ${p.completed} / ${p.total} 页 · 可取消` : p.stage === 'screen-quotes' ? `正在更新选股行情 ${p.completed} / ${p.total} 只 · 完整加载后筛选；可取消` : p.stage === 'risk-quotes' ? `正在复核候选的当日报价与盘口 ${p.completed} / ${p.total} 只` : p.stage === 'notices' ? `正在检查近期公告标题 ${p.completed} / ${p.total} 只 · 待核验事项单列；可取消` : p.stage === 'daily' ? `正在计算完整日线指标 ${p.completed} / ${p.total} 只 · 全部完成后展示；可取消` : p.stage === 'research' ? `正在核验所选研究指标 ${p.completed} / ${p.total} 只 · 原始资料逐项判断` : p.stage === 'finance' ? `正在核对财务指标 ${p.completed} / ${p.total} 只 · 全部完成后展示；可取消` : `正在获取选股行情 ${p.completed} / ${p.total} 页 · 完整加载后筛选`; } catch {} }, 700);
  try {
    screenResult = await api('screener:run', { query: screenQuery, force, snapshotId, strategyId }); screenResult.strategyId = strategyId; screenResult.strategyName = strategyName; screenResult.personalRules = personalRules; screenDirty = false; screenRequestFailed = false; screenPage = 1; screenRiskPage = 1; screenFinancePendingPage = 1;
    selectionEvidenceUi.pendingPage = 1; selectionEvidenceUi.failedPage = 1;
    renderScreenResults();
  } catch (e) {
    screenRequestFailed = true;
    $('screen-error').textContent = `${e.message}。${screenResult ? '保留下方上次结果，未使用失败请求的数据。' : '未生成选股结果，请重试。'}`;
    $('screen-error').classList.remove('hidden');
    if (screenResult) $('screen-result-count').textContent = `${screenCountText(screenResult)} · 上次结果，本次未更新`;
    else $('screen-table').innerHTML = empty('选股行情暂不可用', '点击“开始选股”重新获取行情并筛选');
  } finally { clearInterval(poll); await refreshScreenHistory(); $('screen-progress').classList.add('hidden'); setScreenBusy(false); }
}
async function screenFromText() {
  if (screenBusy) return;
  setScreenBusy(true);
  try {
    const result = await api('screener:parse', screenStrategyId ? { text: $('screen-description').value, baseQuery: screenQuery } : $('screen-description').value);
    screenPersonalRules = screenStrategyId ? [...new Map([...screenPersonalRules, ...result.addedRules].map(rule => [JSON.stringify(rule), rule])).values()] : result.query.rules;
    const retainedEvidence = screenQuery.evidence, retainedResearch = screenQuery.research, retainedPerformance = screenQuery.performance;
    screenQuery = result.query;
    if (retainedEvidence) {
      const parsedEvidence = screenQuery.evidence;
      screenQuery.evidence = parsedEvidence ? { ...structuredClone(retainedEvidence), ...parsedEvidence,
        conditions: [...new Set([...(retainedEvidence.conditions || []), ...(parsedEvidence.conditions || [])])],
        leadership: parsedEvidence.leadership || retainedEvidence.leadership || '',
        minSegmentRevenuePct: Math.max(retainedEvidence.minSegmentRevenuePct ?? 0, parsedEvidence.minSegmentRevenuePct ?? 0) } : structuredClone(retainedEvidence);
    }
    if (retainedResearch && !screenQuery.research) screenQuery.research = structuredClone(retainedResearch);
    if (retainedPerformance && !screenQuery.performance) screenQuery.performance = structuredClone(retainedPerformance);
    syncScreenRules(); screenTextPending = false; screenChanged(false); renderScreenRules();
    $('screen-description').value = '';
    $('screen-text-status').textContent = `已${screenStrategyId ? '追加个人条件，保留策略与原有条件' : '替换数值条件'}；已保留原研究标签和研究指标条件。${result.notes.join(' ')}`;
    setScreenBusy(false); await runScreen();
  } catch (e) {
    screenTextPending = true; $('screen-text-status').textContent = e.message;
    $('screen-error').textContent = `文字条件未应用：${e.message}`; $('screen-error').classList.remove('hidden');
    if (screenResult) $('screen-result-count').textContent = `${screenCountText(screenResult)} · 上次结果，文字未应用`;
  } finally { setScreenBusy(false); }
}
function renderScreenResults() {
  if (!screenResult) return;
  const r = screenResult;
  $('screen-result-count').textContent = `${screenCountText(r)}${screenRequestFailed ? ' · 上次结果，本次未更新' : screenDirty || screenTextPending ? ' · 上次结果，条件待应用' : ''}`;
  const mode = r.dataMode === 'historical' ? '历史快照 · 非当前行情' : '最新获取';
  $('screen-result-labels').innerHTML = [mode, ...(r.strategyName ? [r.strategyName + ' · 按下方实际条件'] : []), ...r.labels].map(v => `<span class="reason">${esc(v)}</span>`).join('');
  $('screen-source').textContent = `${r.source} · ${mode} · 获取 ${timeText(r.startedAt)} — ${timeText(r.fetchedAt)} · 股票池 ${r.eligibleCount} 只 / 范围内 ${r.poolCount} 只 · 可判断 ${r.evaluatedCount} 只 / 所需指标缺失 ${r.missing} 只${r.excludedCount ? ` · 不支持的代码排除 ${r.excludedCount} 只` : ''}${r.watchlistMissing ? ` · 自选中 ${r.watchlistMissing} 只未在股票池返回` : ''}${r.oldestQuote ? ` · 结果已知报价时间 ${timeText(r.oldestQuote)} — ${timeText(r.newestQuote)}` : ''}${r.unknownQuoteTime ? ` · 结果中 ${r.unknownQuoteTime} 只报价时间未知，不能确认指标对应时点` : ''}`;
  if (r.technicalScan) $('screen-source').textContent += ` · ${r.technicalScan.source} · 技术扫描 ${timeText(r.technicalScan.startedAt)} — ${timeText(r.technicalScan.finishedAt)}；以扫描开始时已收盘日线为限，逐只显示实际日线日期。`;
  if (r.finance) $('screen-source').textContent += ' · 财务指标逐只展示报告期；最新报告 ROE 未年化，年度指标使用最近三个完整年度并单列依据。';
  $('screen-data-message').textContent = r.dataMessage;
  $('screen-data-message').classList.toggle('hidden', !r.dataMessage);
  $('screen-data-message').classList.toggle('screen-data-ok', (r.technical || r.finance) && !r.partial && !r.riskScreen?.excluded);
  const missing = Object.entries(r.missingByField).filter(([, count]) => count > 0);
  $('screen-quality').innerHTML = missing.length ? `<details ${r.status === 'unavailable' ? 'open' : ''}><summary>字段缺失明细 · 范围内 ${r.poolCount} 只${r.finance ? ` / 财务候选 ${r.financeCandidates} 只` : ''}${r.technical ? ` / 技术候选 ${r.technicalCandidates} 只` : ''}</summary><div>${missing.map(([key, count]) => `<span class="reason">${esc(key === 'timestamp' ? '报价时间' : screenMeta.fields[key].label)}缺失 ${count} 只 · ${r.requiredFields.includes(key) ? '本次必需' : '不影响本次条件判断'}</span>`).join('')}</div><p class="tiny">快照字段按范围内股票统计；财务字段按通过快照条件的候选统计；日线字段按通过快照与财务条件的候选统计。同一只股票可缺少多个字段，各项不可相加。</p></details>` : '';
  const search = $('screen-result-search').value.trim().toLowerCase(), [sort, direction] = $('screen-sort').value.split(':');
  renderScreenRisk(r, search);
  renderScreenEvidenceResults(r, search);
  renderScreenResearchResults(r, search);
  renderScreenPerformanceResults(r, search);
  renderScreenFinancePending(r, search);
  const rows = r.rows.filter(a => !search || a.symbol.includes(search) || a.name.toLowerCase().includes(search)).slice().sort((a, b) => {
    const av = a[sort], bv = b[sort];
    if (av == null || bv == null) return av == null && bv == null ? a.symbol.localeCompare(b.symbol) : av == null ? 1 : -1;
    const diff = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return diff * (direction === 'asc' ? 1 : -1) || a.symbol.localeCompare(b.symbol);
  });
  const pageCount = Math.max(1, Math.ceil(rows.length / screenSize)); screenPage = Math.min(screenPage, pageCount);
  const columns = [...new Set(['price', 'changePct', ...(r.technical ? [] : ['turnover', 'volumeRatio', 'marketCap']), ...r.requiredFields])];
  $('screen-table').innerHTML = rows.length ? table(['股票 / 代码', ...columns.map(key => `${esc(screenMeta.fields[key].label)}<br><small>${esc(screenMeta.fields[key].unit)}</small>`), ...(r.finance ? ['财报依据'] : []), ...(r.technical ? ['完整日线日期'] : []), ...(r.technical || r.finance ? ['条件核对'] : []), ...(r.evidenceScreen ? ['研究标签依据'] : []), ...(r.performanceScreen ? ['预告 / 快报条件'] : []), ...(r.riskScreen ? ['风险检查'] : []), '报价时间', '操作'], rows.slice((screenPage - 1) * screenSize, screenPage * screenSize).map(row => [
    `<button class="screen-stock" data-screen-open="${row.symbol}"><strong>${esc(row.name)}</strong><small>${row.symbol.slice(2)} · ${esc(screenMeta.boards[row.board])}</small></button>`,
    ...columns.map(key => `<span title="${esc(row[key] ?? '缺失')}" class="${key === 'changePct' ? cls(row[key]) : ''}">${key === 'changePct' ? signed(row[key]) : num(row[key], screenMeta.fields[key].source === 'daily' ? 4 : 2)}</span>`),
    ...(r.finance ? [`<span class="screen-quote-time">最新报告期 ${esc(row.financeReportDate)}<small>公告 ${esc(row.financeNoticeDate)}</small><small>${esc(row.financeSource || '来源未标注')} · 获取 ${esc(timeText(row.financeFetchedAt))}</small></span>${renderSelectionAnnualReports(row)}`] : []),
    ...(r.technical ? [`<span class="screen-quote-time">${esc(row.technicalAsOf)}<small>${esc(row.technicalSource || "来源未标注")}</small><small>获取 ${esc(timeText(row.technicalFetchedAt))}</small></span>`] : []),
    ...(r.technical || r.finance ? [`<details class="screen-checks"><summary>全部 ${r.query.rules.length} 项通过</summary>${r.query.rules.map(rule => `<div>✓ ${esc(screenMeta.fields[rule.field].label)} (${esc(num(row[rule.field], 6))}) ${esc(screenMeta.ops[rule.op])} ${rule.valueField ? `${esc(screenMeta.fields[rule.valueField].label)} (${esc(num(row[rule.valueField], 6))})` : esc(rule.value)}</div>`).join('')}</details>`] : []),
    ...(r.evidenceScreen ? [`<details class="screen-checks"><summary>${esc(selectionEvidenceStatus(row.selectionEvidence?.status))} · 研究标签</summary>${renderSelectionEvidenceDetails(row.selectionEvidence)}</details>`] : []),
    ...(r.performanceScreen ? [performanceReviewHtml(row.performanceReview)] : []),
    ...(r.riskScreen ? [`<span class="screen-quote-time">规则检查通过<small>${row.entryRisk?.notices?.mode === 'automatic-fulltext' ? '敏感公告原文已核验' : '公告仅标题检查'}</small>${row.entryRisk?.market ? `<small>复核报价 ${num(row.entryRisk.market.price)} / ${signed(row.entryRisk.market.changePct)}%</small><small>${esc(timeText(row.entryRisk.market.quoteTime))}</small>` : `<small>检查 ${esc(timeText(row.entryRisk?.notices?.checkedAt))}</small>`}</span>`] : []),
    `<span class="screen-quote-time">${row.timestamp ? esc(timeText(row.timestamp)) : '时间未知'}</span>`,
    `<div class="agency-screen-actions">${researchInspectButton(row.symbol)}<button class="table-action" data-screen-watch="${row.symbol}">＋ 自选</button><button class="table-action" data-screen-agency="${esc(row.symbol)}">加入自动交易</button><button type="button" class="table-action" data-evidence-symbol="${esc(row.symbol)}">研究证据</button></div>`
  ])) : empty(r.status === 'unavailable' ? '数据不足，无法判断筛选结果' : search ? '结果中没有匹配的名称或代码' : r.poolCount === 0 ? '所选范围内没有股票' : '暂无符合条件的股票', r.status === 'unavailable' ? (r.riskScreen ? '请查看风险排除和待核验明细，更新当日报价与公告后重试' : '可更新行情，或在上方主动选择已保存的历史快照后筛选') : search ? '可清空搜索查看筛选结果' : '仅对本次指标齐全的股票进行判断；缺失指标不会当作 0');
  $('screen-page-info').textContent = r.status === 'unavailable' ? `范围内 ${r.poolCount} 只 · 指标或风险资料不足，完整匹配数量未知` : `第 ${screenPage} / ${pageCount} 页 · ${search ? '搜索后 ' : ''}${rows.length} 只 · 每页 ${screenSize} 只`;
  $('screen-prev').disabled = screenPage <= 1; $('screen-next').disabled = screenPage >= pageCount;
  syncScreenerWatch();
  syncScreenEvidenceBusy();
}
function renderScreenFinancePending(result, search) {
  const root = $('screen-finance-pending'), all = result.financePendingRows || [];
  const templateHtml = renderScreenFinanceTemplates(result, search);
  if (!all.length) { root.innerHTML = templateHtml; return; }
  const rows = all.filter(row => !search || row.symbol.toLowerCase().includes(search) || (row.name || '').toLowerCase().includes(search));
  const pages = Math.max(1, Math.ceil(rows.length / screenSize)); screenFinancePendingPage = Math.min(screenFinancePendingPage, pages);
  const rules = (result.query?.rules || []).filter(rule => screenMeta.fields[rule.field]?.source === 'finance');
  const details = row => {
    const checks = rules.map(rule => {
      const field = screenMeta.fields[rule.field], validity = row.financeFieldChecks?.[rule.field];
      // These rows matched before the final publication review. Ready fields
      // retain their matched values; invalid fields remain diagnostic only.
      const ready = validity?.status === 'ready';
      return { ...validity, field: rule.field, label: field.label, unit: field.unit, op: rule.op, expected: rule.value,
        value: ready ? validity.value ?? row[rule.field] : null, rawValue: validity?.rawValue ?? null,
        reportDate: validity?.reportDate ?? null, noticeDate: validity?.noticeDate ?? null,
        status: ready ? 'pass' : 'pending', reason: ready ? '' : validity?.reason || '本项财务资料尚未完成核验' };
    });
    return financeCheckHtml({ status: 'pending', source: row.financeSource, fetchedAt: row.financeFetchedAt,
      reportDate: row.financeReportDate, annualReportDate: row.financeAnnualReports?.[0]?.reportDate,
      checks, reasons: checks.filter(check => check.status === 'pending').map(check => check.reason) }, '本次财务筛选条件');
  };
  root.innerHTML = `<details class="screen-risk-excluded"><summary>财务待核验 · ${rows.length} 只${search ? ` / 共 ${all.length} 只` : ''}</summary><p>这些股票在发布结果前的财务复核中发现资料失效或报告期未覆盖，暂不进入匹配结果。展开逐项查看原值、适用报告期及原因；待核验不等于财务条件不合格。</p>${rows.slice((screenFinancePendingPage - 1) * screenSize, screenFinancePendingPage * screenSize).map(row => `<article data-finance-pending-symbol="${esc(row.symbol)}"><b>${esc(row.name || row.symbol)} · ${esc(row.symbol.toUpperCase())}</b>${details(row)}<button class="text-button" data-screen-open="${esc(row.symbol)}">查看股票</button></article>`).join('') || '<p>没有符合搜索条件的财务待核验记录。</p>'}<div class="screen-pagination"><span>第 ${screenFinancePendingPage} / ${pages} 页 · 每页 ${screenSize} 只</span><div><button class="subtle" data-finance-pending-page="-1" ${screenFinancePendingPage <= 1 ? 'disabled' : ''}>上一页</button><button class="subtle" data-finance-pending-page="1" ${screenFinancePendingPage >= pages ? 'disabled' : ''}>下一页</button></div></div></details>` + templateHtml;
}
function renderScreenFinanceTemplates(result, search) {
  const all = result.financeTemplateRows || [];
  if (!all.length) return '';
  return [['inapplicable', '财务模板不适用'], ['pending', '财务模板行业分类待核验']].map(([status, label]) => {
    const group = all.filter(row => (row.financeApplicability?.status === 'inapplicable' ? 'inapplicable' : 'pending') === status);
    if (!group.length) return '';
    const rows = group.filter(row => !search || `${row.symbol} ${row.name || ''}`.toLowerCase().includes(search));
    const pages = Math.max(1, Math.ceil(rows.length / screenSize)); screenFinanceTemplatePages[status] = Math.min(pages, screenFinanceTemplatePages[status]);
    const page = screenFinanceTemplatePages[status], opened = document.querySelector(`[data-finance-template-group="${status}"]`)?.open;
    return `<details class="screen-risk-excluded" data-finance-template-group="${status}" ${opened ? 'open' : ''}><summary>${label} · ${rows.length} 只${search ? ` / 共 ${group.length} 只` : ''}</summary><p>${status === 'inapplicable' ? '这些企业不适用本次普通非金融企业财务模板，未进入本次匹配结果；这不是财务条件不合格的判断。' : '这些股票尚未取得有效且一致的行业分类，暂不套用普通非金融企业财务模板，也不进入本次匹配结果。'}</p>${rows.slice((page - 1) * screenSize, page * screenSize).map(row => `<article data-finance-template-symbol="${esc(row.symbol)}"><b>${esc(row.name || row.symbol)} · ${esc(row.symbol.toUpperCase())}</b>${financeApplicabilityHtml(row.financeApplicability)}<button class="text-button" data-screen-open="${esc(row.symbol)}">查看股票</button></article>`).join('') || '<p>没有符合搜索条件的记录。</p>'}<div class="screen-pagination"><span>第 ${page} / ${pages} 页 · 每页 ${screenSize} 只</span><div><button class="subtle" data-finance-template-page="${status}" data-step="-1" ${page <= 1 ? 'disabled' : ''}>上一页</button><button class="subtle" data-finance-template-page="${status}" data-step="1" ${page >= pages ? 'disabled' : ''}>下一页</button></div></div></details>`;
  }).join('');
}
function renderScreenRisk(result, search) {
  const el = $('screen-risk-excluded'), risk = result.riskScreen;
  const noticeStatus = $('screen-notice-status');
  noticeStatus.classList.toggle('hidden', !result.noticeScreen);
  noticeStatus.textContent = result.noticeScreen ? `公告未核验 · ${result.noticeScreen.reason}` : '';
  el.classList.toggle('hidden', !risk);
  if (!risk) { el.innerHTML = ''; return; }
  const rows = (result.riskExcluded || []).filter(row => !search || row.symbol.includes(search) || row.name.toLowerCase().includes(search));
  const pages = Math.max(1, Math.ceil(rows.length / screenSize)); screenRiskPage = Math.min(screenRiskPage, pages);
  el.innerHTML = `<div class="screen-risk-heading"><b>风险排除与待核验 · ${risk.excluded} 只</b><span>风险拦截 ${risk.blocked} · 待核验 ${risk.unverified}</span></div><p>这些股票不进入正常候选。${risk.marketEnabled ? '短线行情风险检查在指标筛选前执行，排除列表不代表它们已满足技术或财务条件。' : '指标匹配后仍需通过各策略共用的公告检查。'}敏感公告按需核验原文；数据缺项和风险分别记录，不能据此断言没有事件风险。</p>${rows.length ? `<div class="table-wrap">${table(['股票 / 代码', '条件快照价格 / 涨跌幅', '排除依据', '操作'], rows.slice((screenRiskPage - 1) * screenSize, screenRiskPage * screenSize).map(row => [
    `<strong>${esc(row.name)}</strong><small>${esc(row.symbol.toUpperCase())}</small>`,
    `${num(row.price)}<small class="${cls(row.changePct)}">${signed(row.changePct)}%</small>`,
    `<div class="screen-risk-reason"><b>${row.entryRisk?.status === 'blocked' ? '风险拦截' : '待核验'}</b><p>${(row.entryRisk?.reasons || []).map(esc).join('；')}</p>${row.entryRisk?.market ? `<small>${esc(row.entryRisk.market.label || '行情')} ${esc(timeText(row.entryRisk.market.quoteTime))} · ${num(row.entryRisk.market.price ?? row.price)} 元 / ${signed(row.entryRisk.market.changePct ?? row.changePct)}% · 检查 ${esc(timeText(row.entryRisk.market.checkedAt))}</small>` : ''}${row.entryRisk?.notices ? `<small>公告获取 ${esc(timeText(row.entryRisk.notices.fetchedAt))} · 检查 ${esc(timeText(row.entryRisk.notices.checkedAt))}</small>` : ''}${(row.entryRisk?.notices?.notices || []).map(item => `<p>${esc(item.date)} · ${esc(item.title)}</p>`).join('')}</div>`,
    `<button class="table-action" data-screen-open="${esc(row.symbol)}" data-risk-open="true">查看依据</button>`
  ]))}</div><div class="screen-pagination"><span>第 ${screenRiskPage} / ${pages} 页 · ${search ? '搜索后 ' : ''}${rows.length} 只</span><div><button class="subtle" data-risk-page="-1" ${screenRiskPage <= 1 ? 'disabled' : ''}>上一页</button><button class="subtle" data-risk-page="1" ${screenRiskPage >= pages ? 'disabled' : ''}>下一页</button></div></div>` : '<p>没有符合搜索条件的排除记录。</p>'}`;
}
function syncScreenerWatch() {
  syncScreenAgency();
  if (!state) return;
  document.querySelectorAll('[data-screen-watch]').forEach(button => { const watched = state.account.watchlist.includes(button.dataset.screenWatch); button.disabled = watched; button.textContent = watched ? '已自选' : '＋ 自选'; });
}
function screenAgencyRows() { return [...new Map((screenResult?.rows || []).filter(row => !screenResult.evidenceScreen || row.selectionEvidence?.status === 'pass').map(row => [row.symbol, row])).values()]; }
function screenEntryConditions(result = screenResult) {
  if (!result?.query) return null;
  const { rules, excludeST, evidence, research, performance } = result.query;
  const personalRules = result.strategyId && Array.isArray(result.personalRules) ? result.personalRules : rules || [];
  return structuredClone({ rules: personalRules, excludeST: !!excludeST, ...(evidence ? { evidence } : {}), ...(research ? { research } : {}), ...(performance ? { performance } : {}), source: { strategyId: result.strategyId || '', selectedAt: result.fetchedAt, dataMode: result.dataMode } });
}
function clearScreenEntryConditions() { screenEntryContext = null; }
function screenSelectedEntryConditions(symbol) {
  return screenEntryContext?.symbol === symbol ? structuredClone(screenEntryContext.conditions) : null;
}
function screenAgencyReady() {
  return !!screenResult && screenResult.status !== 'unavailable' && !screenBusy && !screenDirty && !screenTextPending && !screenRequestFailed && !screenAgencyBusy && !!state?.agency?.groups?.length && screenAgencyRows().length > 0;
}
function syncScreenAgency() {
  const button = $('screen-agency-all');
  button.textContent = `全部加入自动交易（${screenAgencyRows().length}）`;
  button.disabled = !screenAgencyReady();
  $('screen-agency-hint').textContent = screenBusy ? '正在选股，请等待本次结果完成。' : screenDirty || screenTextPending || screenRequestFailed
    ? '上次结果暂不能批量加入，请先应用条件并成功完成选股。'
    : '批量加入本次筛选的全部候选，覆盖所有分页，不受下方搜索影响；风险排除、研究标签待核验和不符列表不纳入。';
  document.querySelectorAll('[data-screen-agency]').forEach(el => { el.disabled = screenBusy || screenDirty || screenTextPending || screenRequestFailed; });
  if ($('screen-agency-dialog').open && !screenAgencyBatch?.completed) renderScreenAgencyMode();
}
function renderScreenAgencyMode() {
  const group = state?.agency?.groups?.find(group => group.id === $('screen-agency-strategy').value);
  $('screen-agency-policy').textContent = '已有自动交易归属、手动持仓或待执行手动委托的股票将跳过；跳过时不会覆盖原有模式和条件。行情获取失败会逐项列出。新增股票纳入策略监控，保存本次个人筛选条件；实际开仓须通过策略买点、当前数据、风险、资金及成交约束。';
  $('screen-agency-mode').textContent = group?.mode === 'running'
    ? '所选策略正在运行：新增股票将参与规则检查。纳入监控不代表立即买入。'
    : group?.mode === 'stopped' ? '所选策略已全部停止。批量加入后仍保持停止，可到自动交易页划入模拟资金并启用。'
      : '所选策略暂停新开仓。批量加入后仍保持暂停，可到自动交易页划入模拟资金并启用。';
}
function openScreenAgency() {
  if (!screenAgencyReady()) return;
  const groups = state.agency.groups, rows = screenAgencyRows();
  screenAgencyBatch = { rows: structuredClone(rows), entryConditions: screenEntryConditions(), completed: false, strategyId: '' };
  $('screen-agency-summary').textContent = `本次全部 ${rows.length} 只候选，包含所有分页，不受结果搜索影响。${screenResult.dataMode === 'historical' ? '来源为历史快照；加入后重新核验当前行情与资料。' : ''}`;
  $('screen-agency-conditions').innerHTML = agencyEntryConditionSummary(screenAgencyBatch.entryConditions);
  $('screen-agency-strategy').innerHTML = groups.map(group => `<option value="${esc(group.id)}">${esc(group.name)}</option>`).join('');
  $('screen-agency-strategy').value = groups.some(group => group.id === screenResult.strategyId) ? screenResult.strategyId : groups.some(group => group.id === 'swing') ? 'swing' : groups[0].id;
  $('screen-agency-strategy').disabled = false;
  $('screen-agency-submit').disabled = false; $('screen-agency-submit').classList.remove('hidden');
  $('screen-agency-submit').textContent = `批量加入并授权 ${rows.length} 只`;
  $('screen-agency-close').textContent = '取消';
  $('screen-agency-result').textContent = ''; $('screen-agency-error').textContent = '';
  $('screen-agency-details').innerHTML = ''; $('screen-agency-details').classList.add('hidden');
  $('screen-agency-view').classList.add('hidden');
  renderScreenAgencyMode(); $('screen-agency-dialog').showModal();
}
$('screen-agency-all').addEventListener('click', openScreenAgency);
$('screen-agency-strategy').addEventListener('change', renderScreenAgencyMode);
$('screen-agency-close').addEventListener('click', () => { if (!screenAgencyBusy) $('screen-agency-dialog').close(); });
$('screen-agency-dialog').addEventListener('cancel', event => { if (screenAgencyBusy) event.preventDefault(); });
$('screen-agency-view').addEventListener('click', () => {
  if (!screenAgencyBatch?.completed) return;
  agencyUi.strategyId = screenAgencyBatch.strategyId;
  $('screen-agency-dialog').close(); switchPage('agency');
});
$('screen-agency-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (screenAgencyBusy || !screenAgencyBatch || screenAgencyBatch.completed) return;
  if (!screenAgencyReady()) { $('screen-agency-error').textContent = '筛选条件或研究证据已变更，请关闭窗口并重新筛选后再批量加入。'; return; }
  const batch = screenAgencyBatch, strategyId = $('screen-agency-strategy').value;
  screenAgencyBusy = true; syncScreenAgency();
  $('screen-agency-submit').disabled = true; $('screen-agency-close').disabled = true; $('screen-agency-strategy').disabled = true;
  $('screen-agency-error').textContent = ''; $('screen-agency-result').textContent = `正在分批获取 ${batch.rows.length} 只股票的行情并加入，请稍候…`;
  try {
    const result = await api('agency:members:add', { strategyId, symbols: batch.rows.map(row => row.symbol), entryConditions: batch.entryConditions, selectionMode: 'strategy' });
    batch.completed = true; batch.strategyId = strategyId;
    $('screen-agency-result').textContent = `共 ${result.total} 只：已加入 ${result.added.length} 只 · 跳过 ${result.skipped.length} 只 · 未加入 ${result.failed.length} 只。${result.added.length ? '新增股票已纳入策略监控；纳入监控不代表立即买入。' : ''}`;
    const names = new Map(batch.rows.map(row => [row.symbol, row.name]));
    const details = [...result.skipped.map(item => ({ ...item, label: '跳过' })), ...result.failed.map(item => ({ ...item, label: '未加入' }))];
    $('screen-agency-details').innerHTML = details.length ? `<details open><summary>未新增股票及原因 · ${details.length} 只</summary><ul>${details.map(item => `<li><b>${esc(names.get(item.symbol) || item.symbol)} · ${esc(item.symbol)}</b><span>${item.label}：${esc(item.reason)}</span></li>`).join('')}</ul></details>` : '';
    $('screen-agency-details').classList.toggle('hidden', !details.length);
    $('screen-agency-submit').classList.add('hidden'); $('screen-agency-view').classList.remove('hidden');
    $('screen-agency-close').textContent = '关闭';
    try { renderState(await api('state')); }
    catch (error) { $('screen-agency-error').textContent = `批量结果已保存，账户显示刷新失败：${error.message}`; }
  } catch (error) {
    $('screen-agency-result').textContent = '';
    $('screen-agency-error').textContent = error.message;
  } finally {
    screenAgencyBusy = false; $('screen-agency-close').disabled = false;
    $('screen-agency-submit').disabled = batch.completed; $('screen-agency-strategy').disabled = batch.completed;
    syncScreenAgency();
  }
});
$('screen-description-form').addEventListener('submit', e => { e.preventDefault(); action(screenFromText); });
$('screen-description').addEventListener('input', () => {
  screenDirty = true;
  screenTextPending = !!$('screen-description').value.trim();
  $('screen-text-status').textContent = screenTextPending ? `文字尚未应用，点击“${screenStrategyId ? '追加并选股' : '文字选股'}”生成条件与结果。` : '可直接编辑下方条件，或输入文字描述。';
  if (screenResult) $('screen-result-count').textContent = `${screenCountText(screenResult)} · 上次筛选结果`;
  setScreenBusy(false);
});
document.querySelectorAll('[data-screen-example]').forEach(b => b.addEventListener('click', () => { $('screen-description').value = b.dataset.screenExample; screenTextPending = true; action(screenFromText); }));
$('screen-scope').addEventListener('change', () => { screenQuery.scope = $('screen-scope').value; screenChanged(); });
$('screen-data-source').addEventListener('change', () => { screenChanged(false); renderScreenHistoryNote(); });
$('screen-exclude-st').addEventListener('change', () => { screenQuery.excludeST = $('screen-exclude-st').checked; screenChanged(); });
$('screen-boards').addEventListener('change', () => { screenQuery.boards = [...$('screen-boards').querySelectorAll('input:checked')].map(el => el.value); screenChanged(); });
$('screen-rules').addEventListener('input', e => {
  const index = e.target.closest('[data-rule]')?.dataset.rule, part = e.target.dataset.part;
  if (index == null || !part) return;
  const beforeCount = screenRuleEntries.length;
  for (const ref of screenRuleEntries[index].refs) {
    const rule = (ref.origin === 'strategy' ? screenStrategyRules : screenPersonalRules)[ref.index];
    if (part === 'target') { delete rule.value; delete rule.valueField; if (e.target.value === 'number') rule.value = 0; else rule.valueField = e.target.value; }
    else rule[part] = part === 'value' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value;
  }
  syncScreenRules(); screenChanged(); if (part === 'target' || beforeCount !== screenRuleEntries.length) renderScreenRules();
});
$('screen-rules').addEventListener('click', e => { const remove = e.target.closest('[data-remove]'); if (!remove) return; const refs = screenRuleEntries[Number(remove.dataset.remove)].refs.slice().sort((a, b) => b.index - a.index); for (const ref of refs) (ref.origin === 'strategy' ? screenStrategyRules : screenPersonalRules).splice(ref.index, 1); screenChanged(); renderScreenRules(); });
$('screen-field-search').addEventListener('input', renderScreenCatalog);
$('screen-fields').addEventListener('click', e => { const button = e.target.closest('[data-field]'); if (!button || screenBusy) return; if (screenQuery.rules.length >= 30) return toast('最多添加 30 项条件', true); const rule = { field: button.dataset.field, op: 'gte', value: 0 }; if (!screenPersonalRules.some(r => JSON.stringify(r) === JSON.stringify(rule))) screenPersonalRules.push(rule); screenChanged(); renderScreenRules(); $('screen-rules').querySelector('[data-origin="personal"] input')?.focus(); });
$('screen-run').addEventListener('click', () => action(() => runScreen()));
$('screen-cancel').addEventListener('click', () => action(async () => { $('screen-cancel').disabled = true; $('screen-cancel').textContent = '正在取消…'; await api('screener:cancel'); }));
$('screen-reset').addEventListener('click', () => { screenQuery = { scope: 'all', boards: [], excludeST: false, rules: [] }; screenStrategyId = ''; screenStrategyRules = []; screenPersonalRules = []; $('screen-description').value = ''; screenTextPending = false; screenChanged(); renderScreenStrategy(); renderScreenRules(); });
$('screen-strategy').addEventListener('change', () => selectScreenStrategy($('screen-strategy').value));
$('investment-strategies').addEventListener('click', e => action(async () => {
  const button = e.target.closest('[data-use-strategy]'); if (!button || screenBusy) return;
  screenStrategyId = button.dataset.useStrategy; await initScreener(); selectScreenStrategy(screenStrategyId); switchPage('screener');
}));
for (const id of ['screen-sort', 'screen-result-search']) $(id).addEventListener(id === 'screen-sort' ? 'change' : 'input', () => { screenPage = 1; screenRiskPage = 1; screenFinancePendingPage = 1; selectionEvidenceUi.pendingPage = 1; selectionEvidenceUi.failedPage = 1; renderScreenResults(); });
$('screen-prev').addEventListener('click', () => { screenPage--; renderScreenResults(); });
$('screen-next').addEventListener('click', () => { screenPage++; renderScreenResults(); });
$('page-screener').addEventListener('click', e => action(async () => {
  const templatePagination = e.target.closest('[data-finance-template-page]');
  if (templatePagination) { const status = templatePagination.dataset.financeTemplatePage; screenFinanceTemplatePages[status] += Number(templatePagination.dataset.step); renderScreenResults(); document.querySelector(`[data-finance-template-group="${status}"]`).open = true; return; }
  const financePagination = e.target.closest('[data-finance-pending-page]');
  if (financePagination) { screenFinancePendingPage += Number(financePagination.dataset.financePendingPage); renderScreenResults(); document.querySelector('#screen-finance-pending > details').open = true; return; }
  const pagination = e.target.closest('[data-risk-page]');
  if (pagination) { screenRiskPage += Number(pagination.dataset.riskPage); renderScreenResults(); return; }
  const agency = e.target.closest('[data-screen-agency]');
  if (agency) { if (screenBusy || screenDirty || screenTextPending || screenRequestFailed) return; if (typeof openAgencyAssign === 'function') openAgencyAssign(agency.dataset.screenAgency, screenResult?.strategyId || screenStrategyId, screenEntryConditions()); return; }
  const watch = e.target.closest('[data-screen-watch]'), open = e.target.closest('[data-screen-open]');
  if (watch) { watch.disabled = true; try { await api('watch:add', watch.dataset.screenWatch); toast('已加入自选，打开股票可查看对应买卖计划'); } finally { syncScreenerWatch(); } }
  if (open) {
    const result = screenResult;
    const conditions = !screenBusy && !screenDirty && !screenTextPending && !screenRequestFailed && !open.dataset.riskOpen && screenAgencyRows().some(row => row.symbol === open.dataset.screenOpen) ? screenEntryConditions(result) : null;
    open.disabled = true;
    try {
      const symbol = await api('screener:open', open.dataset.screenOpen);
      renderState(await api('state'));
      const position = state.stats.positions.find(item => item.symbol === symbol);
      if (result?.strategyId && !position) {
        await api('strategy:select', { symbol, strategyId: result.strategyId });
        renderState(await api('state'));
      } else if (result?.strategyId && position) {
        toast(position.risk?.strategy ? `已有持仓，继续沿用建仓时的${strategyProfile(position.risk.strategyId || 'swing').name}计划` : '已有手动持仓，保留原计划与风控设置');
      }
      rememberResearchEvidence(symbol, result); switchPage('market'); await selectStock(symbol); renderResearchEvidence();
      if (conditions && selected === symbol && page === 'market') screenEntryContext = { symbol, conditions };
      if (open.dataset.riskOpen) { setResearchTab('notices'); $('research-evidence').scrollIntoView({ block: 'center' }); }
    } finally { open.disabled = false; }
  }
}));
