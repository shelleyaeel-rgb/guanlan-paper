'use strict';
let researchSymbol = null, researchTab = 'company', researchGeneration = 0, researchData = {}, researchLoading = new Set(), researchEvidence = null;
const researchTitles = { profile: '公司概况', valuation: '估值快照', finance: '财务摘要', notices: '近期公告' };
const researchSections = () => researchTab === 'company' ? ['profile', 'valuation', 'finance'] : ['notices'];
const researchAmount = value => value == null ? '—' : num(value / 1e8);
const researchPercent = value => value == null ? '—' : num(value) + '%';
const researchPeriod = date => date ? date.slice(0, 4) + ({ '03-31': '一季报', '06-30': '中报', '09-30': '三季报', '12-31': '年报' }[date.slice(5)] || '') : '报告期未知';
const researchCurrency = value => ({ CNY: '人民币', USD: '美元', HKD: '港元' }[value] || value || '币种未提供');
function clearResearchSelection() { researchSymbol = null; researchGeneration++; researchData = {}; researchLoading = new Set(); researchEvidence = null; }
function syncResearchStock() {
  if (!selected || page !== 'market') return;
  $('research-stock').textContent = `${state?.quotes[selected]?.name || selected.slice(2)} · ${selected.toUpperCase()}`;
  if (researchSymbol === selected) return;
  researchSymbol = selected; researchGeneration++; researchData = {}; researchLoading = new Set();
  renderResearchEvidence(); loadResearch();
}
async function loadResearch(force = false, sections = researchSections()) {
  if (!researchSymbol || page !== 'market') return;
  const symbol = researchSymbol, generation = researchGeneration;
  await Promise.all(sections.map(async section => {
    if (researchLoading.has(section)) return;
    researchLoading.add(section); renderResearchSection(section); researchRefreshState();
    try {
      const result = await api('research:get', { symbol, section, force });
      if (generation !== researchGeneration || result.symbol !== researchSymbol) return;
      researchData[section] = result;
    } catch (e) {
      if (generation !== researchGeneration) return;
      const previous = researchData[section];
      researchData[section] = { ...previous, status: previous?.data ? 'stale' : 'unavailable', error: e.message, checkedAt: Date.now() };
    } finally {
      if (generation === researchGeneration) { researchLoading.delete(section); renderResearchSection(section); researchRefreshState(); }
    }
  }));
}
function researchRefreshState() {
  const busy = researchSections().some(section => researchLoading.has(section));
  $('research-refresh').disabled = busy; $('research-refresh').textContent = busy ? '正在更新…' : '更新资料';
}
function researchMeta(result) {
  return `<p class="research-meta">${esc(result.source || '来源未标注')} · 获取 ${esc(timeText(result.fetchedAt))}${result.cached ? ' · 本次运行缓存' : ''}</p>`;
}
function researchExternal(kind, text, article = '') {
  return `<button class="text-button" data-research-link="${kind}"${article ? ` data-article="${esc(article)}"` : ''}>${esc(text)} ↗</button>`;
}
function renderResearchSection(section) {
  const el = $('research-' + section), result = researchData[section], loading = researchLoading.has(section);
  el.setAttribute('aria-busy', String(loading));
  const head = `<div class="research-section-head"><h3>${researchTitles[section]}</h3>${section === 'profile' ? researchExternal('profile', '东方财富 F10') : section === 'notices' ? researchExternal('notices', '更多公告') : ''}</div>`;
  if (!result) { el.innerHTML = head + '<p class="research-meta" role="status">正在获取资料…</p>'; return; }
  const failed = ['stale', 'unavailable'].includes(result.status);
  const warning = failed ? `<p class="research-error" role="status">${result.status === 'stale' ? '更新失败，以下为上次获取的资料' : '数据暂不可用'}：${esc(result.error)}<br>尝试时间 ${esc(timeText(result.checkedAt))}。${section === 'notices' ? '无法据此判断是否存在新的风险事项。' : ''}<button class="text-button" data-research-retry="${section}" ${loading ? 'disabled' : ''}>重试</button></p>` : '';
  const data = result.data;
  let body = '';
  if (section === 'profile' && data) {
    body = `<p class="research-company-name">${esc(data.company || data.name || '公司名称暂无数据')}</p><dl class="research-profile-grid"><div><dt>所属行业 · 东方财富分类</dt><dd>${esc(data.industry || '暂无数据')}</dd></div><div><dt>上市日期</dt><dd>${esc(data.listedAt || '暂无数据')}</dd></div></dl><p class="research-business"><span>主营业务</span>${esc(data.business || '暂无数据')}</p>${data.summary ? `<p class="research-summary">${esc(data.summary)}</p>` : ''}<p class="research-meta">公司资料为当前来源版本，来源未提供统一更新日期。</p>`;
  } else if (section === 'valuation' && data) {
    body = `<div class="research-metrics">${[['总市值', researchAmount(data.marketCap), '亿元'], ['流通市值', researchAmount(data.floatCap), '亿元'], ['动态市盈率', num(data.pe), '倍 · 非 TTM'], ['市净率', num(data.pb), '倍']].map(([label, value, sub]) => `<div><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`).join('')}</div><p class="research-meta">报价时间 ${data.quoteTime ? esc(timeText(data.quoteTime)) : '未知，无法确认指标对应时点'}。动态 PE 与 PB 使用行情源口径，负值保留；与上方行情更新时间可能不同。</p>`;
  } else if (section === 'finance' && data?.latest) {
    const r = data.latest;
    body = `<div class="research-report"><b>${esc(researchPeriod(r.reportDate))}</b><span>报告期截至 ${esc(r.reportDate)}</span><span>公告 ${esc(r.noticeDate || '日期未知')} · 数据更新 ${esc(r.updateDate || '日期未知')}</span><span>金额单位：亿${esc(researchCurrency(r.currency))}${r.currency ? '' : '（原币种）'}</span></div>`;
    const values = [
      ['营业总收入', researchAmount(r.revenue), `同比 ${researchPercent(r.revenueYoY)}`],
      ['归母净利润', researchAmount(r.profit), `同比 ${researchPercent(r.profitYoY)}`],
      ['扣非归母净利润', researchAmount(r.adjustedProfit), `同比 ${researchPercent(r.adjustedProfitYoY)}`],
      ['经营现金流净额', researchAmount(r.operatingCash), '年初至报告期末'],
      ['累计加权 ROE', researchPercent(r.roe), '年初至报告期末 · 未年化'],
      ['资产负债率', researchPercent(r.debtRatio), '报告期末']
    ];
    body += `<div class="research-metrics">${values.map(([label, value, sub]) => `<div><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`).join('')}</div>`;
    body += '<p class="research-meta">营收、利润、现金流为年初至报告期末累计值；同比使用来源披露值。累计 ROE 不自行年化；长线内置门槛采用最近完整年度 ROE，累计 ROE 单独观察。扣非利润金额与同比独立判断，正同比不代表金额为正。缺失显示“—”，行业间指标含义可能不同。</p>';
    if (data.annual.length) {
      body += `<h4>近三年年度对照${data.annual.length < 3 ? ` · 已返回 ${data.annual.length} 年` : ''}</h4><div class="research-table" tabindex="0" role="region" aria-label="年度财务对照，可横向滚动">${table(['指标', ...data.annual.map(a => `${esc(a.reportDate.slice(0, 4))} 年<small>亿${esc(researchCurrency(a.currency))}</small>`)], [
        ['营业总收入', ...data.annual.map(a => researchAmount(a.revenue))],
        ['归母净利润', ...data.annual.map(a => researchAmount(a.profit))],
        ['扣非归母净利润', ...data.annual.map(a => researchAmount(a.adjustedProfit))],
        ['经营现金流净额', ...data.annual.map(a => researchAmount(a.operatingCash))],
        ['年度加权 ROE', ...data.annual.map(a => researchPercent(a.roe))],
        ['资产负债率', ...data.annual.map(a => researchPercent(a.debtRatio))],
        ['公告日期', ...data.annual.map(a => esc(a.noticeDate || '未知'))],
        ['数据更新日期', ...data.annual.map(a => esc(a.updateDate || '未知'))]
      ])}</div>`;
    }
    body += '<p class="research-meta">历史年度值可能包含后续修订，仅供当前研究，不能直接作为历史时点的选股或回测数据。</p>';
  } else if (section === 'notices' && data?.items.length) {
    body = `<p class="research-meta">本页 ${data.items.length} 条近期公告 · 来源共 ${data.total} 条。仅展示最近返回的公告，完整记录见“更多公告”。</p><div class="research-notice-list">${data.items.map(item => `<article><div><time>${esc(item.date)}</time><span>${esc(item.categories.join(' / ') || '未分类')}</span></div>${researchExternal('notice', item.title, item.id)}</article>`).join('')}</div>`;
  } else if (!failed) {
    body = `<p class="research-meta">${section === 'notices' ? '本次未返回可展示的近期公告，不代表没有风险事项。' : '暂无可展示的数据。'}</p>`;
  }
  el.setAttribute('aria-busy', String(loading));
  el.innerHTML = head + warning + (loading ? '<p class="research-meta">正在更新…</p>' : '') + body + researchMeta(result);
}
function setResearchTab(tab) {
  researchTab = tab;
  document.querySelectorAll('[data-research-tab]').forEach(button => {
    const active = button.dataset.researchTab === tab;
    button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
  });
  $('research-company').classList.toggle('hidden', tab !== 'company'); $('research-notices').classList.toggle('hidden', tab !== 'notices');
  loadResearch();
}
function renderResearchEvidence() { $('research-evidence').classList.add('hidden'); $('research-evidence').innerHTML = ''; }
document.querySelectorAll('[data-research-tab]').forEach(button => button.addEventListener('click', () => setResearchTab(button.dataset.researchTab)));
document.querySelector('.research-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const tab = event.key === 'Home' ? 'company' : event.key === 'End' ? 'notices' : researchTab === 'company' ? 'notices' : 'company';
  setResearchTab(tab); $('research-tab-' + tab).focus();
});
$('research-refresh').addEventListener('click', () => loadResearch(true));
document.querySelector('.research-card').addEventListener('click', event => {
  const link = event.target.closest('[data-research-link]'), retry = event.target.closest('[data-research-retry]');
  if (link) action(() => api('research:open', { symbol: researchSymbol, kind: link.dataset.researchLink, article: link.dataset.article }));
  if (retry) loadResearch(true, [retry.dataset.researchRetry]);
});
