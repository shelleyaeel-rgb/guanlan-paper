'use strict';
let screenMeta, screenQuery = { scope: 'all', boards: [], excludeST: true, rules: [] }, screenResult, screenBusy = false, screenPage = 1, screenDirty = false, screenTextPending = false;
let screenHistory = [], screenRequestFailed = false;
const screenSize = 30;
const screenCountText = r => r.status === 'unavailable' ? '无法筛选' : `${r.matched} 只${r.technical && r.partial ? ' · 部分股票未判定' : ''}`;
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
  if (screenMeta) return;
  screenMeta = await api('screener:meta');
  $('screen-boards').innerHTML = '<legend>板块（不勾选为全部）</legend>' + Object.entries(screenMeta.boards).map(([value, label]) => `<label class="check"><input type="checkbox" value="${value}">${esc(label)}</label>`).join('');
  renderScreenRules(); renderScreenCatalog();
  await refreshScreenHistory();
  await runScreen();
}
function setScreenBusy(busy) {
  screenBusy = busy;
  $('screen-run').disabled = busy || screenTextPending;
  $('screen-parse').disabled = busy;
  $('screen-reset').disabled = busy;
  document.querySelectorAll('.screen-condition-card input,.screen-condition-card select,.screen-condition-card button').forEach(el => { el.disabled = busy; });
  $('screen-run').disabled = busy || screenTextPending;
  $('screen-description').disabled = busy;
  document.querySelectorAll('[data-screen-example]').forEach(el => { el.disabled = busy; });
  $('screen-cancel').classList.toggle('hidden', !busy);
  if (!busy) { $('screen-cancel').disabled = false; $('screen-cancel').textContent = '取消本次选股'; }
}
function screenChanged(manual = true) {
  screenDirty = true; screenPage = 1;
  if (manual) { $('screen-description').value = ''; screenTextPending = false; $('screen-text-status').textContent = '已按下方条件编辑，点击“开始选股”应用。'; }
  $('screen-error').classList.add('hidden');
  if (screenResult) $('screen-result-count').textContent = `${screenCountText(screenResult)} · 上次结果，条件待应用`;
  setScreenBusy(false);
}
function renderScreenRules() {
  if (!screenMeta) return;
  $('screen-scope').value = screenQuery.scope;
  $('screen-exclude-st').checked = screenQuery.excludeST;
  $('screen-boards').querySelectorAll('input').forEach(el => { el.checked = screenQuery.boards.includes(el.value); });
  $('screen-rule-count').textContent = `${screenQuery.rules.length} 项条件`;
  $('screen-rules').innerHTML = screenQuery.rules.length ? screenQuery.rules.map((r, i) => {
    const field = screenMeta.fields[r.field];
    const target = field.comparable ? `<select data-part="target" aria-label="${esc(field.label)}比较对象"><option value="number" ${!r.valueField ? 'selected' : ''}>数值</option>${Object.entries(screenMeta.fields).filter(([, f]) => f.comparable).map(([key, f]) => `<option value="${key}" ${r.valueField === key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>` : '';
    return `<div class="screen-rule" data-rule="${i}"><span>${esc(field.label)}</span><select data-part="op" aria-label="${esc(field.label)}比较方式">${Object.entries(screenMeta.ops).map(([value, label]) => `<option value="${value}" ${value === r.op ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select><div class="screen-operand">${target}${!r.valueField ? `<input data-part="value" type="number" step="any" value="${r.value ?? ''}" aria-label="${esc(field.label)}数值">` : ''}</div><span class="tiny">${r.valueField ? '' : esc(field.unit)}</span><button type="button" data-remove="${i}" class="text-button" aria-label="删除${esc(field.label)}条件">移除 ×</button></div>`;
  }).join('') : '<p class="screen-no-rules tiny">从文字生成条件，或展开下方指标添加。没有数值条件时展示范围内全部股票。</p>';
}
function renderScreenCatalog() {
  const search = $('screen-field-search').value.trim().toLowerCase();
  $('screen-fields').innerHTML = Object.entries(screenMeta.fields).filter(([, f]) => [f.label, ...f.aliases].some(v => v.toLowerCase().includes(search))).map(([key, f]) => `<button type="button" class="subtle" data-field="${key}" title="${esc(f.description || f.label + '（' + f.unit + '）')}">＋ ${esc(f.label)} <small>${esc(f.unit)}</small></button>`).join('') || '<p class="tiny">暂无该指标，请使用已支持的条件。</p>';
}
async function runScreen() {
  if (screenBusy || screenTextPending || !screenMeta) return;
  const snapshotId = $('screen-data-source').value === 'latest' ? null : $('screen-data-source').value;
  const force = snapshotId === null;
  setScreenBusy(true); $('screen-error').classList.add('hidden');
  $('screen-progress').classList.remove('hidden'); $('screen-progress').textContent = snapshotId ? '正在按选定历史快照筛选…' : '正在更新选股行情，完成后自动筛选…';
  const poll = setInterval(async () => { try { const p = await api('screener:status'); if (screenBusy && !snapshotId && p.total) $('screen-progress').textContent = p.stage === 'daily' ? `正在计算完整日线指标 ${p.completed} / ${p.total} 只 · 全部完成后展示；可取消` : `正在获取选股行情 ${p.completed} / ${p.total} 页 · 完整加载后筛选`; } catch {} }, 700);
  try {
    screenResult = await api('screener:run', { query: screenQuery, force, snapshotId }); screenDirty = false; screenRequestFailed = false; screenPage = 1;
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
    const result = await api('screener:parse', $('screen-description').value);
    screenQuery = result.query; screenTextPending = false; screenChanged(false); renderScreenRules();
    $('screen-text-status').textContent = `已转换为下方条件。${result.notes.join(' ')}`;
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
  $('screen-result-labels').innerHTML = [mode, ...r.labels].map(v => `<span class="reason">${esc(v)}</span>`).join('');
  $('screen-source').textContent = `${r.source} · ${mode} · 获取 ${timeText(r.startedAt)} — ${timeText(r.fetchedAt)} · 股票池 ${r.eligibleCount} 只 / 范围内 ${r.poolCount} 只 · 可判断 ${r.evaluatedCount} 只 / 所需指标缺失 ${r.missing} 只${r.excludedCount ? ` · 不支持的代码排除 ${r.excludedCount} 只` : ''}${r.watchlistMissing ? ` · 自选中 ${r.watchlistMissing} 只未在股票池返回` : ''}${r.oldestQuote ? ` · 结果已知报价时间 ${timeText(r.oldestQuote)} — ${timeText(r.newestQuote)}` : ''}${r.unknownQuoteTime ? ` · 结果中 ${r.unknownQuoteTime} 只报价时间未知，不能确认指标对应时点` : ''}`;
  if (r.technicalScan) $('screen-source').textContent += ` · ${r.technicalScan.source} · 技术扫描 ${timeText(r.technicalScan.startedAt)} — ${timeText(r.technicalScan.finishedAt)}；以扫描开始时已收盘日线为限，逐只显示实际日线日期。`;
  $('screen-data-message').textContent = r.dataMessage;
  $('screen-data-message').classList.toggle('hidden', !r.dataMessage);
  $('screen-data-message').classList.toggle('screen-data-ok', r.technical && !r.partial);
  const missing = Object.entries(r.missingByField).filter(([, count]) => count > 0);
  $('screen-quality').innerHTML = missing.length ? `<details ${r.status === 'unavailable' ? 'open' : ''}><summary>字段缺失明细 · 范围内 ${r.poolCount} 只${r.technical ? ` / 技术候选 ${r.technicalCandidates} 只` : ''}</summary><div>${missing.map(([key, count]) => `<span class="reason">${esc(key === 'timestamp' ? '报价时间' : screenMeta.fields[key].label)}缺失 ${count} 只 · ${r.requiredFields.includes(key) ? '本次必需' : '不影响本次条件判断'}</span>`).join('')}</div><p class="tiny">快照字段按范围内股票统计；日线字段按通过快照条件的技术候选统计。同一只股票可缺少多个字段，各项不可相加。缺价格显示“—”，缺时间标为“时间未知”。</p></details>` : '';
  const search = $('screen-result-search').value.trim().toLowerCase(), [sort, direction] = $('screen-sort').value.split(':');
  const rows = r.rows.filter(a => !search || a.symbol.includes(search) || a.name.toLowerCase().includes(search)).slice().sort((a, b) => {
    const av = a[sort], bv = b[sort];
    if (av == null || bv == null) return av == null && bv == null ? a.symbol.localeCompare(b.symbol) : av == null ? 1 : -1;
    const diff = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return diff * (direction === 'asc' ? 1 : -1) || a.symbol.localeCompare(b.symbol);
  });
  const pageCount = Math.max(1, Math.ceil(rows.length / screenSize)); screenPage = Math.min(screenPage, pageCount);
  const columns = [...new Set(['price', 'changePct', ...(r.technical ? [] : ['turnover', 'volumeRatio', 'marketCap']), ...r.requiredFields])];
  $('screen-table').innerHTML = rows.length ? table(['股票 / 代码', ...columns.map(key => `${esc(screenMeta.fields[key].label)}<br><small>${esc(screenMeta.fields[key].unit)}</small>`), ...(r.technical ? ['完整日线日期', '条件核对'] : []), '报价时间', '操作'], rows.slice((screenPage - 1) * screenSize, screenPage * screenSize).map(row => [
    `<button class="screen-stock" data-screen-open="${row.symbol}"><strong>${esc(row.name)}</strong><small>${row.symbol.slice(2)} · ${esc(screenMeta.boards[row.board])}</small></button>`,
    ...columns.map(key => `<span title="${esc(row[key] ?? '缺失')}" class="${key === 'changePct' ? cls(row[key]) : ''}">${key === 'changePct' ? signed(row[key]) : num(row[key], screenMeta.fields[key].source === 'daily' ? 4 : 2)}</span>`),
    ...(r.technical ? [`<span class="screen-quote-time">${esc(row.technicalAsOf)}<small>${esc(row.technicalSource || "来源未标注")}</small><small>获取 ${esc(timeText(row.technicalFetchedAt))}</small></span>`, `<details class="screen-checks"><summary>全部 ${r.query.rules.length} 项通过</summary>${r.query.rules.map(rule => `<div>✓ ${esc(screenMeta.fields[rule.field].label)} (${esc(num(row[rule.field], 6))}) ${esc(screenMeta.ops[rule.op])} ${rule.valueField ? `${esc(screenMeta.fields[rule.valueField].label)} (${esc(num(row[rule.valueField], 6))})` : esc(rule.value)}</div>`).join('')}</details>`] : []),
    `<span class="screen-quote-time">${row.timestamp ? esc(timeText(row.timestamp)) : '时间未知'}</span>`,
    `<button class="table-action" data-screen-watch="${row.symbol}">＋ 自选</button>`
  ])) : empty(r.status === 'unavailable' ? '数据不足，无法判断筛选结果' : search ? '结果中没有匹配的名称或代码' : r.poolCount === 0 ? '所选范围内没有股票' : '暂无符合条件的股票', r.status === 'unavailable' ? '可更新行情，或在上方主动选择已保存的历史快照后筛选' : search ? '可清空搜索查看筛选结果' : '仅对本次指标齐全的股票进行判断；缺失指标不会当作 0');
  $('screen-page-info').textContent = r.status === 'unavailable' ? `范围内 ${r.poolCount} 只 · 所需指标不足，完整匹配数量未知` : `第 ${screenPage} / ${pageCount} 页 · ${search ? '搜索后 ' : ''}${rows.length} 只 · 每页 ${screenSize} 只`;
  $('screen-prev').disabled = screenPage <= 1; $('screen-next').disabled = screenPage >= pageCount;
  syncScreenerWatch();
}
function syncScreenerWatch() {
  if (!state) return;
  document.querySelectorAll('[data-screen-watch]').forEach(button => { const watched = state.account.watchlist.includes(button.dataset.screenWatch); button.disabled = watched; button.textContent = watched ? '已自选' : '＋ 自选'; });
}
$('screen-description-form').addEventListener('submit', e => { e.preventDefault(); action(screenFromText); });
$('screen-description').addEventListener('input', () => {
  screenDirty = true;
  screenTextPending = !!$('screen-description').value.trim();
  $('screen-text-status').textContent = screenTextPending ? '文字尚未应用，点击“文字选股”生成条件与结果。' : '可直接编辑下方条件，或输入文字描述。';
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
  const rule = screenQuery.rules[index];
  if (part === 'target') {
    delete rule.value; delete rule.valueField;
    if (e.target.value === 'number') rule.value = 0; else rule.valueField = e.target.value;
    screenChanged(); renderScreenRules();
  } else { rule[part] = part === 'value' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value; screenChanged(); }
});
$('screen-rules').addEventListener('click', e => { const remove = e.target.closest('[data-remove]'); if (!remove) return; screenQuery.rules.splice(Number(remove.dataset.remove), 1); screenChanged(); renderScreenRules(); });
$('screen-field-search').addEventListener('input', renderScreenCatalog);
$('screen-fields').addEventListener('click', e => { const button = e.target.closest('[data-field]'); if (!button || screenBusy) return; if (screenQuery.rules.length >= 30) return toast('最多添加 30 项条件', true); screenQuery.rules.push({ field: button.dataset.field, op: 'gte', value: 0 }); screenChanged(); renderScreenRules(); $('screen-rules').lastElementChild.querySelector('input').focus(); });
$('screen-run').addEventListener('click', () => action(() => runScreen()));
$('screen-cancel').addEventListener('click', () => action(async () => { $('screen-cancel').disabled = true; $('screen-cancel').textContent = '正在取消…'; await api('screener:cancel'); }));
$('screen-reset').addEventListener('click', () => { screenQuery = { scope: 'all', boards: [], excludeST: false, rules: [] }; screenChanged(); renderScreenRules(); });
for (const id of ['screen-sort', 'screen-result-search']) $(id).addEventListener(id === 'screen-sort' ? 'change' : 'input', () => { screenPage = 1; renderScreenResults(); });
$('screen-prev').addEventListener('click', () => { screenPage--; renderScreenResults(); });
$('screen-next').addEventListener('click', () => { screenPage++; renderScreenResults(); });
$('screen-table').addEventListener('click', e => action(async () => {
  const watch = e.target.closest('[data-screen-watch]'), open = e.target.closest('[data-screen-open]');
  if (watch) { watch.disabled = true; try { await api('watch:add', watch.dataset.screenWatch); toast('已加入自选，可在市场与分析中查看波段计划'); } finally { syncScreenerWatch(); } }
  if (open) { const symbol = await api('screener:open', open.dataset.screenOpen); rememberResearchEvidence(symbol); switchPage('market'); await selectStock(symbol); renderResearchEvidence(); }
}));
