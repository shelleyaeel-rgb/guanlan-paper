'use strict';
// Shared read-only metadata for automatic pool configuration and strategy rules.
let screenMeta, screenMetaPending;
async function loadScreenMeta() {
  if (screenMeta) return screenMeta;
  if (!screenMetaPending) screenMetaPending = api('screener:meta').then(result => screenMeta = result).finally(() => { screenMetaPending = null; });
  return screenMetaPending;
}
async function initInvestmentStrategies() {
  await loadScreenMeta();
  $('investment-strategies').innerHTML = screenMeta.strategies.map(strategy => `<article class="investment-strategy"><span class="small-badge">${esc(strategy.horizon)}</span><h3>${esc(strategy.name)}</h3><p>${esc(strategy.summary)}</p><details><summary>开仓观察与限制</summary><p>${esc(strategy.entryNotes)}</p><p>${esc(strategy.limitations)}</p></details></article>`).join('');
}
