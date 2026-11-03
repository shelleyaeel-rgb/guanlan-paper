'use strict';

const marketSearchUi = { seq: 0, timer: null, composing: false, items: [], active: -1 };
const marketSearchQuery = () => $('market-symbol').value.trim();

function closeMarketSearch() {
  clearTimeout(marketSearchUi.timer); marketSearchUi.timer = null;
  marketSearchUi.seq++; marketSearchUi.items = []; marketSearchUi.active = -1;
  $('market-search-results').replaceChildren();
  $('market-search-results').classList.add('hidden');
  $('market-search-results').setAttribute('aria-busy', 'false');
  $('market-symbol').setAttribute('aria-expanded', 'false');
  $('market-symbol').removeAttribute('aria-activedescendant');
  setMarketSearchStatus('');
}
function setMarketSearchStatus(message, failed = false) {
  $('market-search-status').textContent = message;
  $('market-search-status').classList.toggle('hidden', !message);
  $('market-search-status').classList.toggle('market-search-failed', failed);
}
function marketDirectSymbol(query) {
  const value = query.toLowerCase(), code = value.replace(/^(sh|sz)/, '');
  const exchange = /^(600|601|603|605|688)\d{3}$/.test(code) ? 'sh' : /^(000|001|002|003|300|301)\d{3}$/.test(code) ? 'sz' : null;
  return exchange && (value.length === 6 || value === exchange + code) ? exchange + code : null;
}
function validateMarketSearch(query, explicit = false) {
  let error = '';
  if (!query) error = explicit ? '请输入股票名称、代码或拼音首字母。' : '';
  else if (query.length > 32) error = '查询内容最多 32 个字符。';
  else if (/^(?:(?:sh|sz|bj))?\d{6}$/i.test(query) && !marketDirectSymbol(query)) error = '请输入正确的沪深 A 股代码，SH / SZ 前缀须与市场一致；暂不支持北交所、基金和债券。';
  marketSearchError(error);
  return !!query && !error;
}
function marketSearchHighlight(value, query) {
  const text = String(value || ''), index = text.toLowerCase().indexOf(query.toLowerCase());
  return index < 0 ? esc(text) : esc(text.slice(0, index)) + '<mark>' + esc(text.slice(index, index + query.length)) + '</mark>' + esc(text.slice(index + query.length));
}
async function runMarketSearch(explicit = false) {
  const query = marketSearchQuery();
  closeMarketSearch();
  if (page !== 'market' || marketSearchUi.composing || !validateMarketSearch(query, explicit)) return;
  const seq = marketSearchUi.seq;
  setMarketSearchStatus('正在查找匹配股票…');
  $('market-search-results').setAttribute('aria-busy', 'true');
  try {
    const result = await api('market:search', { query });
    if (seq !== marketSearchUi.seq || page !== 'market' || marketSearchQuery() !== query) return;
    marketSearchUi.items = result.items;
    const items = result.items;
    if (!items.length) {
      setMarketSearchStatus(result.hasMore ? '当前候选中未找到沪深 A 股，请输入更完整的名称或代码。' : '未找到匹配的沪深 A 股，请换个关键词或输入完整代码。');
      return;
    }
    $('market-search-results').innerHTML = items.map((item, index) => `<button type="button" role="option" aria-selected="false" tabindex="-1" id="market-search-option-${index}" data-market-result="${esc(item.symbol)}"><span><strong>${marketSearchHighlight(item.name, query)}</strong><small>${marketSearchHighlight(item.pinyin, query)}</small></span><span class="market-result-code">${item.symbol.startsWith('sh') ? '沪' : '深'} · ${marketSearchHighlight(item.symbol.toUpperCase(), query)}</span></button>`).join('');
    $('market-search-results').classList.remove('hidden');
    $('market-symbol').setAttribute('aria-expanded', 'true');
    setMarketSearchStatus(`找到 ${items.length} 只匹配股票，点击或用 ↑↓ 和回车选择。${result.hasMore ? '候选较多，请补充名称或代码缩小范围。' : ''}`);
  } catch (error) {
    if (seq !== marketSearchUi.seq || page !== 'market') return;
    setMarketSearchStatus(`搜索暂不可用：${error.message}。可点击“查询”重试，或输入完整股票代码直接看盘。`, true);
  } finally {
    if (seq === marketSearchUi.seq) $('market-search-results').setAttribute('aria-busy', 'false');
  }
}
function queueMarketSearch() {
  closeMarketSearch(); marketSearchError();
  if (marketSearchUi.composing || page !== 'market' || !marketSearchQuery()) return;
  marketSearchUi.timer = setTimeout(() => runMarketSearch(), 250);
}
function moveMarketSearchSelection(direction) {
  const count = marketSearchUi.items.length;
  if (!count || $('market-search-results').classList.contains('hidden')) return false;
  marketSearchUi.active = marketSearchUi.active < 0 ? (direction > 0 ? 0 : count - 1) : (marketSearchUi.active + direction + count) % count;
  const options = $('market-search-results').querySelectorAll('[role="option"]');
  options.forEach((option, index) => option.setAttribute('aria-selected', String(index === marketSearchUi.active)));
  const active = options[marketSearchUi.active];
  $('market-symbol').setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({ block: 'nearest' });
  return true;
}
function chooseMarketSearchResult(symbol) {
  if (!marketSearchUi.items.some(item => item.symbol === symbol)) return;
  marketView = 'browse'; action(() => selectStock(symbol));
}

$('market-search-form').addEventListener('submit', event => {
  event.preventDefault();
  if (marketSearchUi.composing) return;
  const query = marketSearchQuery(), symbol = marketDirectSymbol(query);
  if (symbol) { marketView = 'browse'; action(() => selectStock(symbol)); }
  else action(() => runMarketSearch(true));
});
$('market-symbol').addEventListener('input', event => {
  if (event.isComposing) { closeMarketSearch(); marketSearchError(); return; }
  queueMarketSearch();
});
$('market-symbol').addEventListener('compositionstart', () => { marketSearchUi.composing = true; closeMarketSearch(); marketSearchError(); });
$('market-symbol').addEventListener('compositionend', () => { marketSearchUi.composing = false; if (document.activeElement === $('market-symbol')) queueMarketSearch(); });
$('market-symbol').addEventListener('keydown', event => {
  if (event.isComposing || marketSearchUi.composing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return; }
  if (event.key === 'Escape') { event.preventDefault(); closeMarketSearch(); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!moveMarketSearchSelection(event.key === 'ArrowDown' ? 1 : -1)) action(() => runMarketSearch());
  } else if (event.key === 'Enter' && marketSearchUi.active >= 0) {
    event.preventDefault(); chooseMarketSearchResult(marketSearchUi.items[marketSearchUi.active].symbol);
  }
});
$('market-search-results').addEventListener('pointerdown', event => event.preventDefault());
$('market-search-results').addEventListener('click', event => {
  const option = event.target.closest('[data-market-result]');
  if (option) chooseMarketSearchResult(option.dataset.marketResult);
});
$('market-symbol').addEventListener('blur', event => {
  if (!event.relatedTarget?.closest('.market-search-card')) closeMarketSearch();
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.market-search-card')) closeMarketSearch();
});
