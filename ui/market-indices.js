'use strict';
// A separate read-only view: index quotes never enter stock detail or account state.
const indexGroups = { cn: 'A 股主要指数', hk: '香港市场', us: '美国市场', asia: '亚太市场', europe: '欧洲市场' };
const indexUi = { group: 'all', data: null, busy: false, error: '', attemptedAt: 0, timer: null, pending: null };
function indexOverviewVisible() { return page === 'market' && marketView === 'browse' && marketTab === 'indices'; }
function clearMarketStock() {
  closeMarketSearch(); selected = ''; detail = null; detailWarning = ''; detailSeq++; detailBusy = false;
  clearResearchSelection(); $('market-symbol').value = ''; marketSearchError();
  $('market-content').setAttribute('aria-busy', 'false');
  action(() => api('detail:close'));
}
function setMarketTab(tab) {
  if (!['indices', 'stocks'].includes(tab)) return;
  if (tab === 'indices') { if (selected) clearMarketStock(); else closeMarketSearch(); }
  marketTab = tab; marketView = 'browse'; renderMarketLayout(); syncIndexOverview();
}
function syncIndexOverview() {
  clearInterval(indexUi.timer); indexUi.timer = null;
  if (!indexOverviewVisible() || document.hidden) return;
  if (!indexUi.attemptedAt || Date.now() - indexUi.attemptedAt >= 60000) loadIndexOverview();
  indexUi.timer = setInterval(() => { if (indexOverviewVisible() && !document.hidden) loadIndexOverview(); }, 60000);
}
async function loadIndexOverview(force = false) {
  if (indexUi.busy) return indexUi.pending;
  indexUi.busy = true; indexUi.error = ''; indexUi.attemptedAt = Date.now(); renderIndexOverview();
  indexUi.pending = (async () => {
    try {
      const data = await api('market:indices', { force });
      if (!data || !Array.isArray(data.items) || !data.items.length) throw Error('未收到有效的指数列表');
      indexUi.data = data;
    } catch (error) { indexUi.error = error.message || '指数接口暂不可用'; }
    finally { indexUi.busy = false; indexUi.pending = null; renderIndexOverview(); }
  })();
  return indexUi.pending;
}
function indexCard(item) {
  const hasPrice = Number.isFinite(item.price) && item.price > 0;
  const unavailable = item.status === 'unavailable' || !hasPrice;
  const failed = item.status === 'stale' || !!indexUi.error;
  const oldQuote = Number.isFinite(item.quoteAt) && Date.now() - item.quoteAt > 36 * 60 * 60 * 1000;
  const status = unavailable ? '暂不可用' : failed ? '上次数据 · 刷新失败' : oldQuote ? '较早报价' : '最近报价';
  const quoteTime = Number.isFinite(item.quoteAt) && item.quoteAt > 0 ? timeText(item.quoteAt) : '时间未提供';
  const move = Number.isFinite(item.changePct) ? cls(item.changePct) : 'neutral';
  // Overseas vendor codes are not universal tickers (Eastmoney NDX is the
  // Composite, whereas NDX commonly means Nasdaq 100). Show the market instead.
  const identity = item.group === 'cn' ? `${item.code} · ${item.region}` : item.region;
  const error = item.error || (indexUi.error ? '本次刷新失败，保留上次数据，请核对报价时间。' : '');
  return `<article class="index-quote-card${unavailable || failed ? ' index-quote-warning' : ''}" data-index-id="${esc(item.id)}" data-index-status="${esc(unavailable ? 'unavailable' : failed ? 'stale' : item.status)}">
    <div class="index-quote-heading"><div><h3>${esc(item.name)}</h3><span>${esc(identity)}</span></div><span class="index-quote-tag">${status}</span></div>
    <div class="index-quote-value ${unavailable ? 'neutral' : move}">${unavailable ? '—' : num(item.price)}<small>点</small></div>
    <div class="index-quote-move ${unavailable ? 'neutral' : move}"><b>${unavailable || !Number.isFinite(item.changePct) ? '—' : signed(item.changePct) + '%'}</b><span>${unavailable || !Number.isFinite(item.change) ? '—' : signed(item.change)} 点</span></div>
    <p class="index-quote-time">报价 ${esc(quoteTime)}<span>北京时间</span></p>
    <div class="index-quote-source">${esc(item.source || '尚无有效来源')}${oldQuote && !unavailable ? ' · 报价距今超过 36 小时' : ''}</div>
    ${error ? `<p class="index-quote-error">${esc(error)}</p>` : ''}
    <details class="index-quote-details"><summary>行情明细与时间</summary><dl>
      ${[['前收盘', item.prevClose], ['开盘', item.open], ['最高', item.high], ['最低', item.low]].map(([name, value]) => `<div><dt>${name}</dt><dd>${unavailable ? '—' : num(value)}</dd></div>`).join('')}
      </dl><p>当地报价时间：${esc(item.quoteTime || '未提供')}<br>${esc(item.timeZone || '时区未提供')}</p><p>此条数据获取：${esc(timeText(item.fetchedAt))}（北京时间）</p></details>
  </article>`;
}
function renderIndexOverview() {
  const data = indexUi.data, items = data?.items || [], unavailable = items.filter(item => item.status === 'unavailable' || !Number.isFinite(item.price)).length;
  const stale = items.filter(item => item.status === 'stale').length;
  $('index-refresh').disabled = indexUi.busy; $('index-refresh').textContent = indexUi.busy ? '正在获取…' : '↻ 刷新指数';
  $('index-board').setAttribute('aria-busy', String(indexUi.busy));
  for (const button of document.querySelectorAll('[data-index-group]')) button.setAttribute('aria-pressed', String(button.dataset.indexGroup === indexUi.group));
  $('index-status').textContent = indexUi.busy ? '正在获取各市场最近报价…' : indexUi.error
    ? `${data ? '更新失败，继续显示上次数据' : '指数行情暂不可用'}：${indexUi.error}。可点击“刷新指数”重试。`
    : data ? `${items.length} 项指数 · ${items.length - unavailable} 项有报价${unavailable ? ` · ${unavailable} 项暂不可用` : ''}${stale ? ` · ${stale} 项为刷新失败前数据` : ''} · 本轮获取 ${timeText(data.attemptedAt || data.fetchedAt)}（北京时间） · 本页每 60 秒刷新`
    : '进入后获取指数行情。';
  $('index-status').classList.toggle('index-quote-error', !!indexUi.error || unavailable > 0 || stale > 0);
  if (!data) { setHtml('index-board', `<div class="card empty">${indexUi.busy ? '正在连接指数行情…' : '暂无指数行情，请刷新重试。'}</div>`); return; }
  const groups = indexUi.group === 'all' ? Object.keys(indexGroups) : [indexUi.group];
  setHtml('index-board', groups.map(group => {
    const rows = items.filter(item => item.group === group);
    return `<section class="index-region" aria-label="${indexGroups[group]}"><div class="index-region-heading"><h2>${indexGroups[group]}</h2><span>${rows.length} 项指数</span></div><div class="index-quote-grid">${rows.map(indexCard).join('') || '<p class="tiny">此地区暂无指数。</p>'}</div></section>`;
  }).join(''));
}
for (const tab of ['indices', 'stocks']) $('market-tab-' + tab).addEventListener('click', () => setMarketTab(tab));
$('market-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tab = event.key === 'Home' ? 'indices' : event.key === 'End' ? 'stocks' : marketTab === 'indices' ? 'stocks' : 'indices';
  setMarketTab(tab); $('market-tab-' + tab).focus();
});
for (const button of document.querySelectorAll('[data-index-group]')) button.addEventListener('click', () => { indexUi.group = button.dataset.indexGroup; renderIndexOverview(); });
$('index-refresh').addEventListener('click', () => loadIndexOverview(true));
document.addEventListener('visibilitychange', syncIndexOverview);
window.addEventListener('beforeunload', () => clearInterval(indexUi.timer));
