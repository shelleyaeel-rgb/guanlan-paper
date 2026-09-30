'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 2) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
const cash = v => num(v / 100);
const signed = (v, d = 2) => v == null ? '—' : (v > 0 ? '+' : '') + num(v, d);
const pct = v => v == null ? '—' : num(v * 100) + '%';
const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : 'neutral';
const timeText = v => v ? new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
let state, selected = 'sh600519', detail, page = 'market', chartMode = 'day', side = 'buy', detailSeq = 0, toastTimer, settingsReady = false, detailBusy = false, riskDirty = false;
async function api(name, payload) { const r = await window.guanlan.call(name, payload); if (!r.ok) throw Error(r.error); return r.data; }
function toast(message, error = false) { $('toast').textContent = message; $('toast').className = 'toast' + (error ? ' error' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), error ? 8000 : 4200); }
async function action(fn) { try { return await fn(); } catch (e) { toast(e.message, true); } }
function empty(title, hint = '') { return `<div class="empty"><div class="empty-symbol">◇</div>${esc(title)}${hint ? `<p>${esc(hint)}</p>` : ''}</div>`; }
function metric(label, value, sub, color = '') { return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value ${color}">${value}</div><div class="metric-sub">${sub}</div></div>`; }
function table(headers, rows) { return `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(v => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table>`; }
function renderState(s) {
  state = s; const stat = s.stats, q = s.quotes[selected];
  $('session').textContent = s.session.label;
  const latest = s.connection.at ? new Date(s.connection.at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
  $('connection').className = 'connection' + (s.connection.ok ? '' : ' error') + (page === 'screener' ? ' hidden' : '');
  $('connection').innerHTML = `<span class="dot"></span><span>${esc(s.connection.message)} · 最近获取 ${latest} · ${esc(s.connection.sources?.join(' / ') || '等待行情来源')} · 免费接口可能延迟</span>`;
  $('warning').textContent = s.warning || ''; $('warning').classList.toggle('hidden', !s.warning);
  $('account-cards').innerHTML = metric('账户总资产', '¥ ' + cash(stat.equity), '初始模拟本金 ¥ ' + cash(s.account.initialCash)) + metric('累计盈亏', signed(stat.pnl / 100), '累计收益率 ' + signed(stat.returnPct * 100) + '%', cls(stat.pnl)) + metric('可用资金', '¥ ' + cash(stat.cash), '持仓市值 ¥ ' + cash(stat.marketValue)) + metric('已实现卖出胜率', pct(stat.winRate), stat.sells ? `${stat.wins} 笔盈利 / ${stat.sells} 笔卖出 · 含费用` : '暂无已完成卖出，开始积累交易样本');
  $('position-count').textContent = stat.positions.length;
  $('refresh-interval').textContent = s.account.settings.refreshSeconds;
  $('watch-count').textContent = s.account.watchlist.length + ' 只';
  $('watchlist').innerHTML = s.account.watchlist.length ? s.account.watchlist.map(symbol => { const a = s.quotes[symbol]; return `<button class="watch-row ${symbol === selected ? 'selected' : ''}" data-symbol="${symbol}"><div><strong>${esc(a?.name || symbol.slice(2))}</strong><small>${symbol.toUpperCase()}</small></div><div class="watch-right ${cls(a?.changePct)}"><strong>${num(a?.price)}</strong><small class="${cls(a?.changePct)}">${a ? signed(a.changePct) + '%' : '等待行情'}</small></div></button>`; }).join('') : empty('添加一只自选股');
  $('indices').innerHTML = ['sh000001', 'sz399001', 'sz399006'].map(symbol => { const a = s.quotes[symbol]; return `<div class="index-item"><span>${esc(a?.name || ({ sh000001: '上证指数', sz399001: '深证成指', sz399006: '创业板指' }[symbol]))}</span><b class="${cls(a?.changePct)}">${num(a?.price)}</b><em class="${cls(a?.changePct)}">${a ? signed(a.changePct) + '%' : '—'}</em></div>`; }).join('');
  $('remove-watch').textContent = s.account.watchlist.includes(selected) ? '★' : '☆'; $('remove-watch').title = s.account.watchlist.includes(selected) ? '移出自选' : '加入自选';
  if (typeof syncScreenerWatch === 'function') syncScreenerWatch();
  if (typeof syncResearchStock === 'function') syncResearchStock();
  $('stock-name').textContent = q?.name || selected.slice(2); $('stock-symbol').textContent = selected.toUpperCase();
  $('stock-time').textContent = q ? `${q.date} ${q.time} · ${q.source || '来源未标注'} ${s.session.open && (s.now - q.timestamp > 90000) ? '· 报价过期' : s.session.open ? '· 行情时间' : '· 最近行情'}` : '无有效报价';
  $('stock-price').textContent = num(q?.price); $('stock-price').className = cls(q?.changePct);
  $('stock-change').textContent = q ? `${signed(q.change)} / ${signed(q.changePct)}%` : '—'; $('stock-change').className = cls(q?.changePct);
  $('stock-ohlc').textContent = q ? `开 ${num(q.open)}　高 ${num(q.high)}　低 ${num(q.low)}` : '';
  $('quote-capability').textContent = q?.canTrade === false ? q.tradeBlockedReason : '';
  $('risk-position').textContent = (() => { const p = stat.positions.find(p => p.symbol === selected); return p ? `持有 ${p.quantity} 股 · 可卖 ${p.available} 股${p.risk ? ' · ' + p.risk.note : ''}` : '尚无持仓 · 买入后可设置'; })();
  if (!settingsReady) { fillSettings(); settingsReady = true; }
  renderStrategy(); syncRisk(); renderEstimate(); if (page === 'portfolio') renderPortfolio(); if (page === 'stats') renderStats();
}
function fillSettings() { const s = state.account.settings; Object.keys(s).forEach(k => { const el = $('s-' + k); if (el) el.value = ['commission', 'stampTax', 'transferFee'].includes(k) ? +(s[k] * 10000).toFixed(6) : k === 'maxPosition' ? +(s[k] * 100).toFixed(4) : s[k]; }); $('data-path').textContent = state.dataPath; Object.entries(state.account.strategySettings).forEach(([key, value]) => { $('strategy-' + key).value = value; }); }
function syncRisk() {
  const r = state.account.risks[selected], managed = !!r?.strategy;
  ['risk-stop', 'risk-target', 'risk-trailing', 'apply-plan'].forEach(id => { $(id).disabled = managed; });
  $('risk-dynamic-label').classList.toggle('hidden', !managed);
  if (riskDirty) return;
  $('risk-stop').value = r?.stop || ''; $('risk-target').value = r?.target || ''; $('risk-trailing').value = r?.trailing || 0; $('risk-enabled').checked = r ? r.enabled : true;
  $('risk-dynamic').checked = !!r?.dynamic;
}
function renderStrategy() {
  const signal = state.signals?.[selected], risk = state.account.risks[selected];
  const needsWatch = !state.account.watchlist.includes(selected) && !state.stats.positions.some(p => p.symbol === selected);
  const p = risk?.strategy ? { entry: risk.entryPrice, stop: risk.stop, target: risk.target, asOf: risk.lastReviewAsOf } : signal?.plan;
  $('strategy-content').className = '';
  $('strategy-content').innerHTML = `<div class="strategy-status ${signal?.buyable ? 'ready' : ''}">${esc(signal?.status || (needsWatch ? '加入自选后生成波段计划' : '等待数据'))}${risk?.strategy ? ` · ${risk.enabled ? '自动卖出已启用' : '自动卖出已暂停'}` : ''}</div><p class="strategy-reason">${(signal?.reasons || [needsWatch ? '点击股票名称右侧的星标加入自选，即可持续监控波段条件。下方日线和技术分析可直接查看。' : '等待策略日线']).map(esc).join('；')}</p>${p ? `<div class="plan"><div><span>${risk?.strategy ? '实际入场价' : '含滑点买价'}</span><strong>${num(p.entry)}</strong></div><div><span>${risk?.strategy ? '当前止损' : '计划止损'}</span><strong class="down">${num(p.stop)}</strong></div><div><span>${risk?.strategy ? '当前止盈' : '计划止盈'}</span><strong class="up">${num(p.target)}</strong></div></div><p class="tiny">${esc(signal?.dailySource || "来源未标注")} · 完整未复权日线 ${esc(p.asOf)}${p.entryLow ? ` · 回踩区域 ${num(p.entryLow)}–${num(p.entryHigh)}` : ''}</p>` : ''}${signal?.economics ? `<div class="strategy-budget"><span>含费盈亏比 <b>${num(signal.economics.rewardRisk)} : 1</b></span><span>计划亏损 <b>¥ ${cash(signal.economics.loss)}</b></span><span>计划数量 <b>${num(signal.quantity, 0)} 股</b></span></div>` : ''}<p class="tiny">报价 ${timeText(signal?.quoteTime)} · 计划亏损按止损价估算，跳空或 T+1 可能使实际亏损扩大。</p>`;
  $('strategy-buy').disabled = !signal?.buyable;
  $('strategy-buy').textContent = signal?.buyable ? `按计划模拟买入 ${num(signal.quantity, 0)} 股` : risk?.strategy ? '持仓计划已保存，持续监控中' : '等待策略条件满足';
  const historical = [...state.account.trades].reverse().find(t => t.symbol === selected && t.riskSnapshot)?.riskSnapshot;
  const record = risk?.strategy ? risk : historical;
  $('strategy-history').innerHTML = record ? `<p>${risk?.strategy ? '当前交易' : '最近已退出交易'} · 入场 ${num(record.entryPrice)}<br>初始止损 ${num(record.initialStop)} / 止盈 ${num(record.initialTarget)}<br>动态更新${record.dynamic ? '启用' : '暂停'} · 每根新日线一次<br>单次最多 ${num(record.config.adjustmentAtr)} ATR</p><div class="risk-log">${record.history.slice().reverse().map(h => `<div><span>${timeText(h.time)}</span><b>止损 ${num(h.oldStop)} → ${num(h.stop)}<br>止盈 ${num(h.oldTarget)} → ${num(h.target)}</b><p>${esc(h.reason)}</p></div>`).join('')}</div>` : '策略建仓后显示初始价位与调整原因。';
  document.querySelectorAll('.watch-row').forEach(row => {
    const s = state.signals?.[row.dataset.symbol], badge = document.createElement('span');
    badge.className = 'watch-signal' + (s?.buyable ? ' ready' : ''); badge.textContent = s?.status || '等待数据'; row.append(badge);
  });
}
function switchPage(next) { page = next; ['account-cards', 'connection', 'refresh'].forEach(id => $(id).classList.toggle('hidden', next === 'screener')); document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.page === next)); document.querySelectorAll('.page').forEach(p => p.classList.toggle('hidden', p.id !== 'page-' + next)); $('page-title').textContent = ({ market: '市场与分析', portfolio: '持仓与委托', stats: '交易统计', settings: '策略与设置', screener: '选股' })[next]; if (next === 'screener') action(initScreener); if (next === 'portfolio') renderPortfolio(); if (next === 'stats') renderStats(); if (next === 'settings') fillSettings(); window.scrollTo(0, 0); }
async function selectStock(symbol) { if (selected !== symbol) { selected = symbol; detail = null; riskDirty = false; $('quantity').value = symbol.startsWith('sh688') ? 200 : 100; } renderState(state); syncRisk(); await loadDetail(); }
async function loadDetail(force = false) {
  const seq = ++detailSeq, symbol = selected; detailBusy = true;
  if (!detail || detail.symbol !== symbol) { $('chart').innerHTML = empty('正在载入真实历史行情…'); $('chart-source').textContent = ''; $('analysis-date').textContent = ''; $('signal-content').innerHTML = empty('正在计算技术指标…'); $('forecast-content').innerHTML = empty('正在分析历史相似走势…'); $('indicator-row').innerHTML = ''; }
  try { const d = await api('detail', { symbol, force }); if (seq !== detailSeq) return; detail = d; renderDetail(); }
  catch (e) { if (seq !== detailSeq) return; if (!detail) { $('chart').innerHTML = empty('行情暂不可用', e.message); $('signal-content').innerHTML = empty('缺少日线数据'); $('forecast-content').innerHTML = empty('数据恢复后生成预测'); } else toast('历史数据更新失败，继续显示上次数据：' + e.message, true); }
  finally { if (seq === detailSeq) detailBusy = false; }
}
function renderDetail() {
  drawChart(); const a = detail.analysis;
  if (a.error) { $('signal-content').innerHTML = empty(a.error); $('forecast-content').innerHTML = empty('样本不足'); return; }
  $('analysis-date').textContent = `${detail.source || '来源未标注'} · 完整日线截至 ${a.asOf}`;
  $('indicator-row').innerHTML = [['MA5', a.ma5], ['MA20', a.ma20], ['MA60', a.ma60], ['RSI(14)', a.rsi], ['ATR(14)', a.atr]].map(([label, v]) => `<div class="indicator">${label}<b>${num(v)}</b></div>`).join('');
  $('signal-content').className = '';
  $('signal-content').innerHTML = `<div class="signal-top"><div class="score-box"><b>${a.score}</b><small>技术评分 / 100</small></div><div><div class="signal-title">${a.signal}</div><div class="signal-desc">${a.score >= 70 ? '关注均线附近回踩，量价确认后再考虑买入。' : a.score <= 30 ? '趋势偏弱；已有持仓关注止损，等待重新站稳均线。' : '趋势尚未形成一致信号，耐心等待价格与动能确认。'}</div></div></div><div class="reasons">${a.reasons.map(r => `<span class="reason">${esc(r)}</span>`).join('')}</div><p class="forecast-note">前复权日线评分用于趋势参考，不是成功概率。交易价位以“波段策略 · 买卖计划”的未复权价格为准。</p>`;
  const f = a.forecast, v = a.validation; $('forecast-content').className = '';
  if (!f) { $('forecast-content').innerHTML = empty('历史样本不足，暂不预测'); return; }
  $('forecast-content').innerHTML = `<div class="forecast-numbers"><div><span>中位数预期涨跌</span><strong class="${cls(f.median)}">${signed(f.median * 100)}%</strong></div><div><span>历史相似样本上涨占比</span><strong>${pct(f.upRate)}</strong></div><div><span>80% 经验价格区间</span><strong class="range">${num(f.lowPrice)} – ${num(f.highPrice)}</strong></div></div><div class="prediction-band"></div><div class="tiny">预测锚点 ${num(f.base)} 元 · 中位价格 ${num(f.price)} 元 · 相似样本 ${f.n} 个</div><div class="validation">历史逐次检验　方向命中率 <b>${pct(v.accuracy)}</b>　/　${v.count} 次　·　区间覆盖率 ${pct(v.coverage)}　·　平均误差 ${pct(v.mae)}</div><div class="forecast-note">预测来自历史相似走势，样本可能重叠且未校准；历史检验未含费用，不代表未来交易胜率。</div>`;
}
function svgBase(w, h, body) { return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="行情图表">${body}</svg>`; }
function linePath(data, x, y) { return data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' '); }
function drawChart() {
  if (!detail) return;
  const series = chartMode === 'minute' ? detail.minute : detail;
  $('chart-source').textContent = series ? `${series.source || '来源未标注'} · ${chartMode === 'minute' ? '分时' : detail.adjustment} · 获取 ${timeText(series.fetchedAt)}` : '';
  const w = 720, h = 265, left = 4, right = 62, top = 10, bottom = 24, areaW = w - left - right;
  $('tab-day').classList.toggle('active', chartMode === 'day'); $('tab-minute').classList.toggle('active', chartMode === 'minute');
  if (chartMode === 'minute') {
    const points = detail.minute?.points || [];
    $('chart-caption').textContent = `分时价格 · ${detail.minute?.date || '暂无数据'} · 30 秒更新`;
    if (!points.length) { $('chart').innerHTML = empty('分时数据暂不可用', detail.minuteError || ''); return; }
    const prices = points.map(p => p.price), prev = detail.minute.prevClose || prices[0], min = Math.min(...prices, prev), max = Math.max(...prices, prev), pad = Math.max((max - min) * 0.14, prev * .001), lo = min - pad, hi = max + pad;
    const x = i => left + i / Math.max(1, prices.length - 1) * areaW, y = p => top + (hi - p) / (hi - lo) * (h - bottom - top);
    let body = grids(lo, hi, y, areaW, h, left);
    body += `<path d="${linePath(prices, x, y)} L${x(prices.length - 1)},${h-bottom} L${left},${h-bottom} Z" fill="#5ad2b3" opacity="0.07"/><line x1="${left}" y1="${y(prev)}" x2="${areaW}" y2="${y(prev)}" stroke="#62758c" stroke-dasharray="4 5"/><path d="${linePath(prices, x, y)}" fill="none" stroke="#61ceb3" stroke-width="1.8"/>`;
    for (const i of [0, Math.floor(prices.length / 2), prices.length - 1]) body += `<text x="${x(i)}" y="${h-3}" text-anchor="${i === 0 ? 'start' : i === prices.length - 1 ? 'end' : 'middle'}">${points[i].time.slice(0,2)}:${points[i].time.slice(2)}</text>`;
    points.forEach((p,i)=>{body += `<circle class="candle" data-point="${i}" cx="${x(i)}" cy="${y(p.price)}" r="4" fill="transparent"/>`;});
    $('chart').innerHTML = svgBase(w, h, body); $('chart-readout').textContent = `最新分时 ${points.at(-1).time} · ${num(prices.at(-1))} 元 · 虚线为${detail.minute.prevClose ? '昨收' : '首个分时价格（昨收缺失）'}`;
    return;
  }
  const bars = detail.bars.slice(-90), all = detail.bars, min = Math.min(...bars.map(b => b.low)), max = Math.max(...bars.map(b => b.high)), pad = Math.max((max - min) * 0.12, min * .003), lo = min-pad, hi = max+pad;
  const plotBottom = h - bottom - 40, y = p => top + (hi - p) / (hi - lo) * (plotBottom - top), dx = areaW / bars.length, x = i => left + (i + .5) * dx;
  let body = grids(lo, hi, y, areaW, h, left);
  const volMax = Math.max(1,...bars.map(b => b.volume));
  bars.forEach((b,i)=>{ const color = b.close >= b.open ? '#eb7882' : '#43bea1', cy = Math.min(y(b.close),y(b.open)), ch = Math.max(1,Math.abs(y(b.close)-y(b.open))); body += `<g class="candle" data-bar="${i}"><rect x="${x(i)-dx/2}" y="0" width="${dx}" height="${h-bottom}" fill="transparent"/><line x1="${x(i)}" y1="${y(b.high)}" x2="${x(i)}" y2="${y(b.low)}" stroke="${color}"/><rect x="${x(i)-dx*.29}" y="${cy}" width="${Math.max(1,dx*.58)}" height="${ch}" fill="${color}"/><rect x="${x(i)-dx*.29}" y="${h-bottom-b.volume/volMax*28}" width="${Math.max(1,dx*.58)}" height="${b.volume/volMax*28}" fill="${color}" opacity=".4"/></g>`; });
  for (const [period, color] of [[5,'#dfc072'],[20,'#85a6ea']]) { const a = bars.map((b,i)=>{ const idx = all.length-bars.length+i; return all.slice(Math.max(0,idx-period+1),idx+1).reduce((s,b)=>s+b.close,0)/Math.min(period,idx+1); }); body += `<path d="${linePath(a,x,y)}" fill="none" stroke="${color}" stroke-width="1.15"/>`; }
  for (const i of [0, Math.floor(bars.length/2),bars.length-1]) body += `<text x="${x(i)}" y="${h-3}" text-anchor="${i===0?'start':i===bars.length-1?'end':'middle'}">${bars[i].date.slice(5)}</text>`;
  $('chart').innerHTML = svgBase(w,h,body); $('chart-caption').textContent = '前复权日 K · 90 日 · MA5 金 / MA20 蓝'; $('chart-readout').textContent = '悬停查看开高低收 · 下方柱为成交量 · 当日日 K 盘中未完成';
}
function grids(lo,hi,y,width,h,left) { let body='';for(let i=0;i<5;i++){const price=hi-(hi-lo)*i/4,py=y(price);body+=`<line x1="${left}" y1="${py}" x2="${width+left}" y2="${py}" stroke="#243349" stroke-dasharray="3 5"/><text x="${width+left+9}" y="${py+4}">${num(price)}</text>`;}return body; }
function renderEstimate() {
  if (!state) return;
  const q = state.quotes[selected], s = state.account.settings, quantity = Number($('quantity').value), type = $('order-type').value;
  const price = type === 'limit' ? Number($('limit-price').value) : q ? (side === 'buy' ? q.ask + s.slippageTicks * .01 : q.bid - s.slippageTicks * .01) : 0;
  const gross = Math.max(0,quantity*price), fee = Math.max(s.minCommission,gross*s.commission) + gross*s.transferFee + (side==='sell'?gross*s.stampTax:0), p = state.stats.positions.find(p=>p.symbol===selected);
  $('trade-estimate').innerHTML = `<div><span>参考成交金额</span><b>¥ ${num(gross)}</b></div><div><span>预计交易费用</span><b>¥ ${num(fee)}</b></div><div><span>${side==='buy'?'可用资金':'T+1 可卖数量'}</span><b>${side==='buy'?'¥ '+cash(state.stats.cash):(p?.available||0)+' 股'}</b></div><div><span>对手一档数量</span><b>${q?num(side==='buy'?q.askSize:q.bidSize,0):'—'} 股</b></div>`;
  const valid = state.session.open && state.connection.ok && q && q.canTrade !== false && Date.now()-q.timestamp<=90000 && Date.now()-q.timestamp>=-15000;
  $('trade-submit').disabled = type==='market' && !valid;
  $('trade-submit').textContent = type==='limit' ? '创建模拟限价单' : q?.canTrade === false ? '行情仅供展示 · 暂停成交' : !state.session.open ? state.session.label + ' · 可创建限价单' : !valid ? '等待有效实时报价' : side==='buy'?'模拟买入':'模拟卖出';
  $('trade-submit').className = 'primary wide ' + side;
}
function renderPortfolio() {
  const positions=state.stats.positions;
  $('positions-table').innerHTML = positions.length ? table(['股票','持有 / 可卖','含费成本','最新价 / 行情时间','市值','浮动盈亏','止损 / 止盈','操作'],positions.map(p=>[
    `<strong>${esc(p.name)}</strong><small>${p.symbol}</small>`,`${p.quantity} / ${p.available}`,num(p.average),`${num(p.price)}<small>${timeText(p.quoteTime)}</small>`,cash(p.value),`<span class="${cls(p.pnl)}">${signed(p.pnl/100)}<small class="${cls(p.pnl)}">${signed(p.pnlPct*100)}%</small></span>`,p.risk?`${num(p.risk.stop)} / ${num(p.risk.target)}<small>${p.risk.enabled?'已启用':'已暂停'} · ${esc(p.risk.note)}</small>`:'未设置',`<button class="table-action" data-open="${p.symbol}">分析 / 交易</button>`])):empty('还没有持仓','添加自选股，在交易时段模拟买入，或创建限价条件单');
  const orders = state.account.orders.slice().reverse().slice(0,200);
  $('orders-table').innerHTML = orders.length ? table(['创建时间','股票','方向 / 数量','限价','状态','执行说明','操作'],orders.map(o=>[timeText(o.createdAt),`${esc(state.quotes[o.symbol]?.name||o.symbol)}<small>${o.symbol}</small>`,`<span class="${o.side==='buy'?'up':'down'}">${o.side==='buy'?'买入':'卖出'} ${o.quantity} 股</span>`,num(o.limit),`<span class="status-tag ${o.status==='filled'?'done':''}">${({pending:'等待触发',filled:'已成交',cancelled:'已撤销'})[o.status]}</span>`,`<span title="${esc(o.note)}">${esc(o.note).slice(0,100)}</span>`,o.status==='pending'?`<button class="table-action" data-cancel="${o.id}">撤单</button>`:'—'])):empty('暂无条件委托','设置限价后，程序将在运行期间持续监控');
  const trades = state.account.trades.slice().reverse().slice(0,200);
  $('trades-table').innerHTML = trades.length ? table(['成交时间','股票','方向','数量','价格','费用','已实现盈亏','原因'],trades.map(t=>[timeText(t.time),`${esc(t.name)}<small>${t.symbol}</small>`,`<span class="${t.side==='buy'?'up':'down'}">${t.side==='buy'?'买入':'卖出'}</span>`,num(t.quantity,0),num(t.price),cash(t.fees.total),t.pnl==null?'—':`<span class="${cls(t.pnl)}">${signed(t.pnl/100)}</span>`,esc(t.reason)])):empty('还没有成交记录','这里将记录每一次模拟成交与实际费用');
}
function renderStats() {
  const s = state.stats;
  $('stats-extra').innerHTML = metric('已实现盈亏', signed(s.realized/100),'按卖出成交逐笔核算',cls(s.realized))+metric('持仓浮动盈亏',signed(s.unrealized/100),'最近行情估值 · 未扣卖出费用',cls(s.unrealized))+metric('最大回撤',pct(s.drawdown),'根据本地记录的账户权益')+metric('盈利 / 亏损总额比',num(s.profitFactor),s.losses?'已实现盈利总额 ÷ 亏损总额':'暂无亏损卖出，暂不计算比值');
  $('pnl-breakdown').innerHTML = [['盈利卖出',`${s.wins} 笔`,'up'],['亏损卖出',`${s.losses} 笔`,'down'],['持平卖出',`${s.breakeven} 笔`,''],['累计交易费用',`¥ ${cash(s.fees)}`,''],['累计净收益',`¥ ${signed(s.pnl/100)}`,cls(s.pnl)]].map(([l,v,c])=>`<div class="breakdown-item"><span>${l}</span><strong class="${c}">${v}</strong></div>`).join('');
  const raw = [...state.account.equity, {time:state.now,value:s.equity}], data=raw.length>700?raw.filter((_,i)=>i%Math.ceil(raw.length/700)===0||i===raw.length-1):raw;
  const values=data.map(a=>a.value/100),w=1060,h=240,left=8,right=100,bottom=28,top=15,min=Math.min(...values),max=Math.max(...values),pad=Math.max((max-min)*.12,max*.002),lo=min-pad,hi=max+pad,x=i=>left+i/Math.max(1,values.length-1)*(w-left-right),y=v=>top+(hi-v)/(hi-lo)*(h-top-bottom);
  let body=grids(lo,hi,y,w-left-right,h,left)+`<path d="${linePath(values,x,y)} L${x(values.length-1)},${h-bottom} L${left},${h-bottom} Z" fill="#5ad2b3" opacity=".06"/><path d="${linePath(values,x,y)}" fill="none" stroke="#5ad2b3" stroke-width="2"/><text x="${left}" y="${h-3}">${timeText(data[0].time)}</text><text x="${w-right}" y="${h-3}" text-anchor="end">${timeText(data.at(-1).time)}</text>`;
  $('equity-chart').innerHTML=svgBase(w,h,body);
}
function confirmDialog(title,html){$('confirm-title').textContent=title;$('confirm-body').innerHTML=html;$('confirm-dialog').showModal();return new Promise(resolve=>{const done=value=>{$('confirm-dialog').close();$('confirm-ok').onclick=null;$('confirm-cancel').onclick=null;$('confirm-dialog').oncancel=null;resolve(value);};$('confirm-ok').onclick=()=>done(true);$('confirm-cancel').onclick=()=>done(false);$('confirm-dialog').oncancel=e=>{e.preventDefault();done(false);};});}
document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>switchPage(b.dataset.page)));
$('watchlist').addEventListener('click',e=>{const button=e.target.closest('[data-symbol]');if(button) action(()=>selectStock(button.dataset.symbol));});
$('watch-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const symbol=await api('watch:add',$('stock-code').value);$('stock-code').value='';toast('已加入自选');await selectStock(symbol);});});
$('remove-watch').addEventListener('click',()=>action(async()=>{const watched=state.account.watchlist.includes(selected);await api(watched?'watch:remove':'watch:add',selected);toast(watched?'已移出自选，已有持仓和委托继续监控':'已加入自选');}));
$('refresh').addEventListener('click',()=>action(async()=>{const b=$('refresh');b.disabled=true;try{renderState(await api('refresh'));await loadDetail(true);}finally{b.disabled=false;}}));
$('tab-day').addEventListener('click',()=>{chartMode='day';drawChart();});$('tab-minute').addEventListener('click',()=>{chartMode='minute';drawChart();});
$('chart').addEventListener('pointermove',e=>{const b=e.target.closest('[data-bar]'),p=e.target.closest('[data-point]');if(b&&detail){const a=detail.bars.slice(-90)[+b.dataset.bar];$('chart-readout').textContent=`${a.date}　开 ${num(a.open)}　高 ${num(a.high)}　低 ${num(a.low)}　收 ${num(a.close)}　成交 ${num(a.volume/10000)} 万股`;}if(p&&detail){const a=detail.minute.points[+p.dataset.point];$('chart-readout').textContent=`${a.time.slice(0,2)}:${a.time.slice(2)}　价格 ${num(a.price)}　累计成交 ${num(a.volume/10000)} 万股`;}});
function setSide(value){side=value;$('buy-side').classList.toggle('active',side==='buy');$('sell-side').classList.toggle('active',side==='sell');renderEstimate();}
$('buy-side').addEventListener('click',()=>setSide('buy'));$('sell-side').addEventListener('click',()=>setSide('sell'));
$('order-type').addEventListener('change',()=>{$('limit-label').classList.toggle('hidden',$('order-type').value!=='limit');if(!$('limit-price').value&&state.quotes[selected])$('limit-price').value=state.quotes[selected].price;renderEstimate();});
['quantity','limit-price'].forEach(k=>$(k).addEventListener('input',renderEstimate));
document.querySelectorAll('[data-qty]').forEach(b=>b.addEventListener('click',()=>{$('quantity').value=b.dataset.qty;renderEstimate();}));
$('trade-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const input={symbol:selected,side,quantity:Number($('quantity').value)},isLimit=$('order-type').value==='limit';if(isLimit)input.limit=Number($('limit-price').value);const ok=await confirmDialog(isLimit?'创建模拟条件单':'确认模拟交易',`<b>${esc(state.quotes[selected]?.name||selected)}</b> · ${selected}<br>${side==='buy'?'买入':'卖出'} ${num(input.quantity,0)} 股${isLimit?` · 限价 ¥ ${num(input.limit)}`:''}<p>${isLimit?'条件单持续有效，不冻结资金或股份；仅在程序运行、行情新鲜且满足交易规则时执行。':'提交后重新获取报价，以最新对手价加减滑点撮合，最终金额可能与当前预估略有差异。'}</p>`);if(!ok)return;$('trade-submit').disabled=true;try{const result=await api(isLimit?'order':'trade',input);toast(isLimit?'限价条件单已保存，可在持仓与委托中查看':`模拟${side==='buy'?'买入':'卖出'} ${result.quantity} 股，成交价 ${num(result.price)} 元`);riskDirty=false;syncRisk();}finally{renderEstimate();}});});
$('risk-form').addEventListener('input',()=>{riskDirty=true;});
let strategySubmitting = false;
$('strategy-buy').addEventListener('click', () => action(async () => {
  if (strategySubmitting) return;
  const signal = state.signals?.[selected], symbol = selected;
  if (!signal?.buyable) return;
  strategySubmitting = true;
  try {
    const p = signal.plan;
    const confirmed = await confirmDialog('确认波段策略模拟买入', `<b>${esc(state.quotes[symbol]?.name || symbol)}</b> · ${symbol}<br>买入 ${signal.quantity} 股 · 买价上限 ${num(p.entry)} 元<br>止损 ${num(p.stop)} / 止盈 ${num(p.target)}<p>含费盈亏比 ${num(signal.economics.rewardRisk)}；计划亏损 ¥ ${cash(signal.economics.loss)}。成交后启用动态计划和自动模拟卖出，参数保留建仓时设置。T+1 当天不可卖，实际亏损可能超过计划估计。</p><p>提交时重新获取日线和盘口；条件失效、买价上涨或计划变化时拒绝成交。</p>`);
    if (!confirmed) return;
    $('strategy-buy').disabled = true;
    const trade = await api('strategy:buy', { symbol, quantity: signal.quantity, expected: p });
    riskDirty = false; syncRisk(); toast(`策略买入 ${trade.quantity} 股，止盈止损计划已自动保存`);
  } finally { strategySubmitting = false; renderState(await api('state')); }
}));
$('strategy-settings-form').addEventListener('submit', e => {
  e.preventDefault(); action(async () => {
    const input = Object.fromEntries(['minRewardRisk', 'riskPercent', 'adjustmentAtr'].map(key => [key, Number($('strategy-' + key).value)]));
    await api('strategy:settings', input); toast('策略参数已保存，仅用于之后新建的交易计划');
  });
});
$('risk-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{await api('risk',{symbol:selected,stop:$('risk-stop').value,target:$('risk-target').value,trailing:$('risk-trailing').value,enabled:$('risk-enabled').checked,dynamic:$('risk-dynamic').checked});riskDirty=false;syncRisk();toast('止盈止损设置已保存');});});
$('apply-plan').addEventListener('click',()=>{const plan=state.signals?.[selected]?.plan;if(!plan){toast('请等待有效的未复权策略价位',true);return;}$('risk-stop').value=plan.stop.toFixed(2);$('risk-target').value=plan.target.toFixed(2);riskDirty=true;toast('已填入参考价，点击保存后生效');});
$('page-portfolio').addEventListener('click',e=>{const open=e.target.closest('[data-open]'),cancel=e.target.closest('[data-cancel]');if(open){switchPage('market');action(()=>selectStock(open.dataset.open));}if(cancel)action(async()=>{await api('cancel',cancel.dataset.cancel);toast('条件单已撤销');});});
$('settings-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const input={};Object.keys(state.account.settings).forEach(k=>{let v=Number($('s-'+k).value);if(['commission','stampTax','transferFee'].includes(k))v/=10000;if(k==='maxPosition')v/=100;input[k]=v;});await api('settings',input);toast('设置已保存，将用于之后的模拟交易');});});
$('reset-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{await api('reset',{capital:Number($('reset-capital').value),confirm:$('reset-confirm').value});$('reset-confirm').value='';fillSettings();riskDirty=false;syncRisk();toast('已自动备份原账户，新的模拟账户已建立');});});
$('backup').addEventListener('click',()=>action(async()=>{if(await api('backup'))toast('账户备份已保存');}));
$('export-trades').addEventListener('click',()=>action(async()=>{if(await api('export'))toast('成交记录已导出');}));
$('open-folder').addEventListener('click',()=>action(()=>api('folder')));
$('method-button').addEventListener('click',()=>$('method-dialog').showModal());$('close-method').addEventListener('click',()=>$('method-dialog').close());
window.guanlan.subscribe(renderState);
action(async()=>{renderState(await api('state'));syncRisk();await loadDetail();});
setInterval(()=>{if(page==='market'&&!detailBusy)loadDetail();},30000);
setInterval(()=>{if(state)renderEstimate();},3000);
