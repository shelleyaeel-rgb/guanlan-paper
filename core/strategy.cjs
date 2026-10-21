const { cnTime, money, yuan, numberIn } = require('./common.cjs');
const { dailyIndicators } = require('./daily-indicators.cjs');
const { fees } = require('./fees.cjs');
const { STRATEGY_PROFILES, strategyProfile, LONG_FINANCE_RULES, LONG_FINANCE_POLICY_NOTE } = require('./strategy-profiles.cjs');
const { checkMarketRisk } = require('./entry-risk.cjs');
const { checkNoticeWithEvidence } = require('./company-notice-review.cjs');
const { buildFinanceSnapshot } = require('./finance-validity.cjs');
const { validateEntryConfirmation } = require('./entry-confirmation.cjs');
const strategyDefaults = { minRewardRisk: 2, riskPercent: 0.5, adjustmentAtr: 0.25 };
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const round = n => yuan(money(n));

function configureStrategy(input) {
  return {
    minRewardRisk: numberIn(input.minRewardRisk, 1, 5, '最低含费盈亏比'),
    riskPercent: numberIn(input.riskPercent, 0.1, 2, '单笔计划风险比例（%）'),
    adjustmentAtr: numberIn(input.adjustmentAtr, 0.05, 0.5, '单日调整幅度（ATR）')
  };
}

// Trading levels always use unadjusted bars, matching the executable quote basis.
function technicals(rawBars, now = new Date()) {
  const daily = dailyIndicators(rawBars, now), { bars, ma5, ma20, ma60 } = daily;
  const c = bars.map(b => b.close), last = bars.at(-1);
  const atr = mean(bars.slice(-14).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - c[c.length - 15 + i]), Math.abs(b.low - c[c.length - 15 + i]))));
  if (!(atr > 0)) throw Error('波动幅度不足，暂停生成计划');
  const support = Math.min(ma20, ...bars.slice(-5).map(b => b.low)), resistance = Math.max(...bars.slice(-20).map(b => b.high));
  const levels = Object.fromEntries(STRATEGY_PROFILES.map(profile => {
    const anchor = daily[profile.anchor], support = Math.min(anchor, ...bars.slice(-profile.supportDays).map(b => b.low));
    const resistance = Math.max(...bars.slice(-profile.resistanceDays).map(b => b.high));
    return [profile.id, { support, resistance, entryLow: round(anchor - atr * 0.25), entryHigh: round(anchor + atr * 0.75),
      stop: round(Math.max(0.01, support - atr * 0.25)), target: round(resistance),
      breakout: last.close > Math.max(...bars.slice(-profile.resistanceDays - 1, -1).map(b => b.high)) }];
  }));
  return {
    asOf: last.date, close: last.close, previousClose: c.at(-2), dates: bars.map(b => b.date), ma5, ma20, ma60, atr,
    previousMa5: daily.previousMa5, previousMa20: daily.previousMa20, previousMa60: daily.previousMa60, levels,
    rsi: daily.rsi, macd: daily.macd, volumeRatio: daily.dailyVolumeRatio,
    trend: last.close >= ma20 && ma20 > ma60 && ma20 > daily.previousMa20,
    breakout: last.close > Math.max(...bars.slice(-6, -1).map(b => b.high)), support, resistance,
    entryLow: round(ma20 - atr * 0.25), entryHigh: round(ma20 + atr * 0.75),
    stop: round(Math.max(0.01, support - atr * 0.25)), target: round(resistance)
  };
}

// Preserve the original top-level swing fields for existing snapshots and accounts.
function profileTechnicals(t, profile) {
  if (profile.id === 'swing') return t;
  const levels = t.levels?.[profile.id];
  if (!levels || !['entryLow', 'entryHigh', 'stop', 'target', 'support', 'resistance'].every(key => Number.isFinite(levels[key]) && levels[key] > 0)) throw Error(`${profile.name}日线价位不足，等待重新获取完整未复权日线`);
  return { ...t, ...levels };
}

function entryTrend(t, profile) {
  const finite = keys => keys.every(key => Number.isFinite(t[key]));
  if (profile.id === 'swing') return t.trend && t.macd > 0 && t.rsi >= 40 && t.rsi <= 75 && Number.isFinite(t.volumeRatio) && t.volumeRatio >= 0.6;
  if (profile.id === 'long') return finite(['close', 'ma20', 'ma60', 'previousMa60']) && t.ma20 >= t.ma60 && t.ma60 >= t.previousMa60 && t.close >= t.ma60;
  if (!finite(['close', 'ma5', 'ma20', 'macd', 'rsi', 'volumeRatio']) || !(t.macd > 0) || !(t.ma5 > t.ma20) || t.rsi > 75) return false;
  if (profile.id === 'ultra-short') return Number.isFinite(t.previousMa5) && t.close > t.ma5 && t.ma5 > t.previousMa5 && t.rsi >= 50 && t.volumeRatio >= 1.2 && t.volumeRatio <= 3;
  return Number.isFinite(t.previousMa20) && t.close >= t.ma5 && t.ma20 > t.previousMa20 && t.rsi >= 45 && t.volumeRatio >= 1;
}

// Explain a rejected signal without changing entryTrend or the stored swing
// trend flag used by older snapshots and existing position management.
function entryTrendReasons(t, profile) {
  const reasons = [], display = value => String(Number(value.toFixed(6)));
  const compare = (label, value, op, reference, referenceLabel = String(reference)) => {
    const requirement = `${label} ${op} ${referenceLabel}`;
    const missing = [...(!Number.isFinite(value) ? [label] : []), ...(!Number.isFinite(reference) ? [referenceLabel] : [])];
    if (missing.length) { reasons.push(`${missing.join('、')}缺失或无效，无法核验${requirement}`); return; }
    const passed = op === '>' ? value > reference : op === '≥' ? value >= reference : value <= reference;
    if (passed) return;
    let actual = display(value), expected = display(reference);
    // Preserve visible differences at a boundary, even below six decimals.
    if (value !== reference && actual === expected) { actual = String(value); expected = String(reference); }
    const relation = value < reference ? '<' : value > reference ? '>' : '=';
    reasons.push(`${label} ${actual} ${relation} ${referenceLabel === String(reference) ? expected : `${referenceLabel} ${expected}`}，要求${requirement}`);
  };
  if (profile.id === 'long') {
    compare('MA20', t.ma20, '≥', t.ma60, 'MA60');
    compare('MA60', t.ma60, '≥', t.previousMa60, '前一日 MA60');
    compare('完整日线收盘价', t.close, '≥', t.ma60, 'MA60');
    return reasons;
  }
  if (profile.id === 'swing') {
    if (!t.trend) {
      compare('完整日线收盘价', t.close, '≥', t.ma20, 'MA20');
      compare('MA20', t.ma20, '>', t.ma60, 'MA60');
      compare('MA20', t.ma20, '>', t.previousMa20, '前一日 MA20');
      if (!reasons.length) reasons.push('完整日线趋势标记未通过，等待重新获取日线核验');
    }
  } else {
    compare('MA5', t.ma5, '>', t.ma20, 'MA20');
    compare('完整日线收盘价', t.close, profile.id === 'ultra-short' ? '>' : '≥', t.ma5, 'MA5');
    if (profile.id === 'ultra-short') compare('MA5', t.ma5, '>', t.previousMa5, '前一日 MA5');
    else compare('MA20', t.ma20, '>', t.previousMa20, '前一日 MA20');
  }
  compare('MACD 柱', t.macd, '>', 0);
  compare('RSI', t.rsi, '≥', profile.id === 'ultra-short' ? 50 : profile.id === 'short' ? 45 : 40);
  // Avoid repeating the same missing-indicator message for both range bounds.
  if (Number.isFinite(t.rsi)) compare('RSI', t.rsi, '≤', 75);
  compare('日量比', t.volumeRatio, '≥', profile.id === 'ultra-short' ? 1.2 : profile.id === 'short' ? 1 : 0.6);
  if (profile.id === 'ultra-short' && Number.isFinite(t.volumeRatio)) compare('日量比', t.volumeRatio, '≤', 3);
  return reasons;
}

function longFinanceCheck(snapshot, symbol, now) {
  const finance = snapshot?.finance, at = now.getTime();
  const normalized = buildFinanceSnapshot(finance, symbol, now, { checkedAt: now, notices: snapshot?.notices });
  const result = { status: 'pending', reportDate: normalized.financeReportDate, noticeDate: normalized.financeNoticeDate,
    annualReportDate: normalized.financeFieldChecks.annualRoeLatest.reportDate,
    source: normalized.financeSource, fetchedAt: normalized.financeFetchedAt, checkedAt: at, reasons: [], checks: [],
    thresholdBasis: LONG_FINANCE_POLICY_NOTE, applicability: normalized.financeApplicability };
  if (result.applicability.status !== 'applicable') {
    result.status = result.applicability.status === 'inapplicable' ? 'failed' : 'pending';
    result.reasonCode = result.applicability.reasonCode;
    result.reasons = [result.applicability.reason];
    if (result.applicability.status === 'pending' && normalized.financeError) {
      result.reasonCode = 'finance-source-unavailable';
      result.reasons.unshift(normalized.financeFieldChecks.annualRoeLatest.reason);
    }
    const fields = [...new Map([...LONG_FINANCE_RULES, { field: 'roe', label: '最新累计加权 ROE', unit: '%', basis: '报告期累计未年化' }].map(rule => [rule.field, rule])).values()];
    result.observations = fields.map(({ field, label, unit, basis }) => {
      const source = normalized.financeFieldChecks[field];
      return { field, label, value: source.value, rawValue: source.rawValue, unit, basis,
        status: source.status === 'ready' ? 'available' : 'pending', reason: source.reason,
        reportDate: source.reportDate, noticeDate: source.noticeDate, source: source.source, currency: source.currency };
    });
    return result;
  }
  const ops = { gte: '≥', lte: '≤', gt: '>' };
  result.checks = LONG_FINANCE_RULES.map(({ field, label, op, value: expected, unit, basis }) => {
    const source = normalized.financeFieldChecks[field], value = normalized[field];
    const valid = source?.status === 'ready' && Number.isFinite(value);
    const pass = valid && (op === 'gte' ? value >= expected : op === 'lte' ? value <= expected : value > expected);
    return { field, label, value: valid ? value : null, rawValue: source?.rawValue ?? null, op, expected, unit,
      reportDate: source?.reportDate || null, noticeDate: source?.noticeDate || null, source: source?.source || null, currency: source?.currency || null, basis,
      status: !valid ? 'pending' : pass ? 'pass' : 'failed',
      reason: !valid ? source?.reason || `${label}缺失，等待数据` : pass ? '' : `${label} ${value}${unit}，要求${ops[op]}${expected}${unit}`,
      ...(source?.pendingReport ? { pendingReport: structuredClone(source.pendingReport) } : {}) };
  });
  const cumulativeRoe = normalized.financeFieldChecks.roe;
  result.observations = [{ field: 'roe', label: '最新累计加权 ROE（观察）', value: normalized.roe, rawValue: cumulativeRoe.rawValue, unit: '%',
    status: cumulativeRoe.status === 'ready' ? 'available' : 'pending', reason: cumulativeRoe.reason,
    reportDate: cumulativeRoe.reportDate, noticeDate: cumulativeRoe.noticeDate, source: cumulativeRoe.source, currency: cumulativeRoe.currency,
    basis: '报告期累计未年化；仅观察，不作为年度 ROE 门槛' }];
  const pendingReport = result.checks.find(check => check.pendingReport)?.pendingReport;
  if (pendingReport) result.pendingReport = pendingReport;
  result.status = result.checks.some(check => check.status === 'failed') ? 'failed' : result.checks.some(check => check.status === 'pending') ? 'pending' : 'pass';
  result.reasons = result.checks.filter(check => check.status !== 'pass').map(check => check.reason);
  if (result.status === 'pass') result.evidence = { finance: structuredClone(finance),
    financeCheck: structuredClone({ checks: result.checks, observations: result.observations, reportDate: result.reportDate,
      annualReportDate: result.annualReportDate, thresholdBasis: result.thresholdBasis, applicability: result.applicability }),
    roeBasis: '最近完整年度加权 ROE；累计 ROE 仅观察，未年化', operatingCashUnit: 'CNY', normalizedAmountUnit: '亿元', verifiedAt: at };
  return result;
}

function longValuationCheck(snapshot, symbol, now) {
  const valuation = snapshot?.valuation, at = now.getTime(), value = valuation?.data;
  const result = { status: 'pending', source: valuation?.source || null, fetchedAt: valuation?.fetchedAt || null, checkedAt: at, reasons: [], checks: [] };
  const pending = reason => ({ ...result, reasons: [reason] });
  if (!valuation || valuation.status !== 'ready' || valuation.error) return pending('估值资料缺失或获取失败，暂停长线建仓');
  if (valuation.symbol !== symbol || valuation.section !== 'valuation' || valuation.source !== '东方财富') return pending('估值资料的股票、模块或来源无法验证');
  if (!Number.isFinite(valuation.fetchedAt) || valuation.fetchedAt <= 0 || valuation.fetchedAt > at || at - valuation.fetchedAt > 90000) return pending('估值资料获取时间过期或无效');
  if (!value || !Number.isFinite(value.quoteTime) || value.quoteTime <= 0 || value.quoteTime > at || at - value.quoteTime > 90000 || cnTime(value.quoteTime).date !== cnTime(now).date) return pending('估值报价时间未知、过期或无效，暂停长线建仓');
  result.checks = [['pe', '动态 PE', 30], ['pb', 'PB', 4]].map(([field, label, maximum]) => ({ field, label, value: Number.isFinite(value[field]) ? value[field] : null,
    op: 'range', expected: [0, maximum], unit: '倍', status: !Number.isFinite(value[field]) ? 'pending' : value[field] > 0 && value[field] <= maximum ? 'pass' : 'failed',
    reason: !Number.isFinite(value[field]) ? `${label}缺失，等待数据` : value[field] > 0 && value[field] <= maximum ? '' : `${label} ${value[field]}，要求大于0且不超过${maximum}` }));
  result.status = result.checks.some(check => check.status === 'failed') ? 'failed' : result.checks.some(check => check.status === 'pending') ? 'pending' : 'pass';
  result.reasons = result.checks.filter(check => check.status !== 'pass').map(check => check.reason);
  if (result.status === 'pass') result.evidence = { valuation: structuredClone(valuation), peBasis: '东方财富动态市盈率', verifiedAt: at };
  return result;
}

function usableTechnical(snapshot, q, now = new Date()) {
  if (!snapshot || snapshot.error) throw Error(snapshot?.error || '正在获取策略日线');
  if (!Number.isFinite(snapshot.fetchedAt) || now.getTime() - snapshot.fetchedAt > 180000 || snapshot.fetchedAt > now.getTime() + 15000) throw Error('策略日线缓存已过期，等待重新获取');
  const t = snapshot.technical, date = cnTime(now).date;
  if (!t || !q || t.asOf > q.date || t.asOf > date) throw Error('日线与报价日期不一致');
  // Catch missed sessions and ex-rights reference changes instead of mixing price bases.
  const reference = t.close;
  const marketReference = t.asOf === q.date ? q.price : q.prevClose;
  if (!Number.isFinite(marketReference) || Math.abs(reference - marketReference) > 0.011) throw Error('日线与行情价格基准不一致（可能缺日线或除权），暂停策略更新');
  return t;
}

function economics(price, stop, target, quantity, settings) {
  const cost = money(price) * quantity, buyFee = fees(cost, 'buy', settings).total;
  const stopGross = Math.max(1, money(stop) - settings.slippageTicks) * quantity;
  const targetGross = Math.max(1, money(target) - settings.slippageTicks) * quantity;
  const loss = cost + buyFee - stopGross + fees(stopGross, 'sell', settings).total;
  const reward = targetGross - fees(targetGross, 'sell', settings).total - cost - buyFee;
  return { cost: cost + buyFee, loss, reward, rewardRisk: loss > 0 ? reward / loss : 0 };
}

function evaluateEntry(engine, symbol, q, snapshot, requestedQuantity, strategyId = 'swing') {
  let profile = strategyProfile(strategyId);
  const now = engine.clock(), settings = engine.s.settings, config = engine.s.strategySettings;
  const result = { symbol, strategyId: profile.id, strategyName: profile.name, status: '等待数据', buyable: false, reasons: [], quoteTime: q?.timestamp, quoteSource: q?.source, dailySource: snapshot?.source, checkedAt: now.getTime(), quantity: 0 };
  const position = engine.positions().find(p => p.symbol === symbol);
  // The selected page does not change which rules manage an existing strategy holding.
  if (position?.risk?.strategy) {
    profile = strategyProfile(position.risk.strategyId);
    result.strategyId = profile.id; result.strategyName = profile.name;
  }
  if (profile.id === 'long') {
    result.financeCheck = longFinanceCheck(snapshot, symbol, now);
    result.valuationCheck = longValuationCheck(snapshot, symbol, now);
    if (result.financeCheck.status === 'pass') result.financeEvidence = structuredClone(result.financeCheck.evidence);
  }
  if (position) {
    try { const t = profileTechnicals(usableTechnical(snapshot, q, now), profile); result.plan = { strategyId: profile.id, strategyName: profile.name, entry: q.price, entryLow: t.entryLow, entryHigh: t.entryHigh, stop: position.risk?.strategy ? position.risk.stop : t.stop, target: position.risk?.strategy ? position.risk.target : t.target, asOf: t.asOf }; } catch {}
    return { ...result, status: position.risk?.pendingExit ? '卖出触发' : '持仓跟踪', reasons: [position.risk?.note || '已有持仓，本策略暂不加仓'], risk: position.risk };
  }
  const shortEntry = ['ultra-short', 'short'].includes(profile.id);
  const market = shortEntry ? checkMarketRisk(q, now) : null, notices = checkNoticeWithEvidence(snapshot?.notices, symbol, snapshot?.automaticEvidence, now);
  const checks = [market, notices].filter(Boolean);
  const status = checks.some(item => item.status === 'blocked') ? 'blocked'
    : checks.some(item => item.status !== 'clear') ? 'unverified' : 'clear';
  result.entryRisk = { market, notices, status, reasons: checks.filter(item => item.status !== 'clear').flatMap(item => item.reasons), checkedAt: now.getTime() };
  const reject = (status, reason) => { result.status = status; result.reasons.push(reason); return result; };
  const rejectEntryRisk = () => {
    const risk = result.entryRisk;
    result.status = risk.market && risk.market.status !== 'clear' ? (risk.market.status === 'blocked' ? '当日风险拦截' : '等待有效行情') : '等待公告核验';
    result.reasons.push(...risk.reasons);
    return result;
  };
  let t;
  try { t = profileTechnicals(usableTechnical(snapshot, q, now), profile); }
  catch (e) {
    if (result.entryRisk && result.entryRisk.status !== 'clear') rejectEntryRisk();
    result.reasons.push(e.message); return result;
  }
  const price = q?.ask > 0 ? round(q.ask + settings.slippageTicks * 0.01) : null;
  result.plan = { strategyId: profile.id, strategyName: profile.name, entryLow: t.entryLow, entryHigh: t.entryHigh, entry: price, stop: t.stop, target: t.target, asOf: t.asOf, config: { ...config } };
  if (result.financeCheck?.status === 'pass' && result.valuationCheck?.status === 'pass') result.plan.financeEvidence = {
    ...structuredClone(result.financeCheck.evidence), ...structuredClone(result.valuationCheck.evidence) };
  if (result.entryRisk) result.plan.entryRiskEvidence = structuredClone(result.entryRisk);
  if (result.entryRisk && result.entryRisk.status !== 'clear') return rejectEntryRisk();
  try { engine.fresh(q); } catch (e) { return reject('等待有效行情', e.message); }
  if (profile.id === 'long') {
    const failed = [result.financeCheck, result.valuationCheck].filter(check => check.status !== 'pass');
    if (result.financeCheck.reasonCode === 'template-inapplicable') return reject('财务模板不适用', result.financeCheck.reasons.join('；'));
    if (result.financeCheck.applicability?.status === 'pending' && result.financeCheck.reasonCode !== 'finance-source-unavailable') return reject('等待行业核验', result.financeCheck.reasons.join('；'));
    if (failed.length) return reject('等待财务估值', failed.flatMap(check => check.reasons).join('；'));
  }
  if (!entryTrend(t, profile)) {
    result.status = '等待趋势'; result.reasons.push(...entryTrendReasons(t, profile)); return result;
  }
  if (profile.id === 'ultra-short' && (!Number.isFinite(q.amount) || q.amount < 2e8 || !Number.isFinite(q.turnover) || q.turnover < 2 || q.turnover > 15)) return reject('等待成交活跃', '超短线要求当日累计成交额至少 2 亿元、换手率 2%–15%');
  if (profile.id === 'short' && (!Number.isFinite(q.amount) || q.amount < 1e8)) return reject('等待成交活跃', '短线要求当日累计成交额至少 1 亿元');
  const adaptive = engine.s.agency?.marketPolicy?.enabled === true && engine.s.marketAdaptiveEntry === true;
  if (adaptive) {
    const confirmation = validateEntryConfirmation(snapshot.entryConfirmation, { symbol, strategyId: profile.id, quote: q,
      technical: snapshot.technical, regime: snapshot.marketRegime, now });
    if (!confirmation.valid) return reject('等待时序确认', confirmation.reason);
    t = { ...t, ...confirmation.plan };
    Object.assign(result.plan, confirmation.plan, { entryMode: confirmation.path, entryConfirmation: confirmation.evidence });
  }
  const anchorLabel = profile.anchor.toUpperCase();
  if (!(price >= t.entryLow && price <= t.entryHigh)) return reject('等待回踩', result.plan.entryMode === 'breakout' ? '含滑点买价超出已确认突破区域或追价上限' : `含滑点买价尚未进入 ${anchorLabel} 附近的回踩区域`);
  if (!(q.price >= q.prevClose && q.price >= q.open && q.price >= t[profile.anchor] && (adaptive || q.low <= t.entryHigh))) return reject('等待确认', `等待盘中价格站回 ${anchorLabel}，且不低于昨收和今开`);
  if (!(t.stop < price && t.target > price)) return reject('空间不足', '支撑止损、入场价与压力止盈的顺序不满足交易条件');
  if (money(price) > money(q.limitUp) || money(price) < money(q.limitDown)) return reject('等待有效行情', '含滑点价格超出涨跌停范围');
  if (engine.s.orders.some(o => o.symbol === symbol && o.side === 'buy' && o.status === 'pending')) return reject('已有买入委托', '请先处理该股票的待执行买单，避免重复建仓');
  // A stopped-out strategy cannot immediately re-enter on the same closed-bar signal.
  const previous = [...engine.s.trades].reverse().find(tr => tr.symbol === symbol && tr.side === 'buy' && tr.strategyPlan);
  if (previous?.strategyPlan.asOf >= t.asOf) return reject('等待新日线', '本根日线已用于策略建仓，平仓后等待下一根完整日线');
  const stat = engine.stats({ [symbol]: q }), budget = Math.floor(stat.equity * config.riskPercent / 100), star = symbol.startsWith('sh688'), minimum = star ? 200 : 100, step = star ? 1 : 100;
  // Strategy facades supply their own cash; ordinary manual plans cannot spend allocated strategy funds.
  const availableCash = Math.min(stat.cash, stat.manualCash ?? stat.cash);
  let maxQuantity = Math.min(1000000, Math.floor(engine.liquidity(q, 'buy')), Math.floor(stat.equity * settings.maxPosition / money(price)), Math.floor(availableCash / money(price)));
  const units = n => star ? n : Math.floor(n / 100) * 100;
  maxQuantity = units(maxQuantity);
  // Binary search includes minimum commissions and exact cent rounding in the budget.
  let low = 0, high = Math.max(0, Math.floor((maxQuantity - minimum) / step) + 1);
  while (low < high) { const mid = Math.ceil((low + high) / 2), quantity = minimum + (mid - 1) * step, e = economics(price, t.stop, t.target, quantity, settings); if (e.cost <= availableCash && e.loss <= budget) low = mid; else high = mid - 1; }
  const recommended = low ? minimum + (low - 1) * step : 0;
  result.maxQuantity = recommended; result.budget = budget;
  const quantity = requestedQuantity == null ? recommended : Number(requestedQuantity);
  if (!recommended) return reject('风险预算不足', '资金、仓位、单笔风险预算或一档数量不足以买入最小数量');
  try { engine.validateQuantity(symbol, quantity, 'buy'); } catch (e) { return reject('数量无效', e.message); }
  if (quantity > recommended) return reject('超过计划上限', `当前最多允许 ${recommended} 股，请重新确认计划`);
  result.quantity = quantity; result.economics = economics(price, t.stop, t.target, quantity, settings);
  if (result.economics.rewardRisk < config.minRewardRisk) return reject('空间不足', `含双边费用及滑点的盈亏比低于 ${config.minRewardRisk}`);
  return { ...result, buyable: true, status: '规则通过 · 可模拟', reasons: [`当前${shortEntry ? '当日行情、' : ''}${notices.mode === 'automatic-fulltext' ? '公告原文核验' : '公告标题检查'}及策略规则通过，含费盈亏比、资金、仓位与计划风险预算符合设置；提交时重新校验。规则通过不代表上涨概率或实际亏损上限`] };
}

function updateDynamicRisk(risk, snapshot, q, now) {
  if (!risk.strategy || !risk.dynamic || risk.pendingExit) return;
  let t, profile;
  try { profile = strategyProfile(risk.strategyId); t = profileTechnicals(usableTechnical(snapshot, q, now), profile); } catch (e) { risk.reviewNote = e.message; return; }
  if (t.asOf <= risk.lastReviewAsOf) return;
  const oldStop = risk.stop, oldTarget = risk.target, step = Math.floor(t.atr * risk.config.adjustmentAtr * 100) / 100, noise = Math.max(0.01, t.atr * 0.05);
  // Accumulate newly closed bars across rolling history windows and restarts. The purchase
  // date is excluded, matching the established swing plan's holding-period convention.
  const priorHeld = Number.isInteger(risk.heldBars) && risk.heldBars >= 0 ? risk.heldBars : null;
  const visibleHeld = t.dates.filter(date => date > risk.entryDate && date <= t.asOf).length;
  const heldDays = priorHeld === null ? visibleHeld
    : Math.max(visibleHeld, priorHeld + t.dates.filter(date => date > risk.entryDate && date > risk.lastReviewAsOf && date <= t.asOf).length);
  risk.heldBars = heldDays;
  let trendFailed;
  if (profile.id === 'ultra-short') trendFailed = t.ma5 <= t.ma20 || t.close < t.ma5 - t.atr * 0.5;
  else if (profile.id === 'short') trendFailed = t.ma5 < t.ma20 || t.close < t.ma20 - t.atr * 0.5;
  else trendFailed = t.ma20 < t.ma60 || t.close < t[profile.anchor] - t.atr * 0.5;
  let reason = '新日线确认，保留原计划';
  if (trendFailed) {
    risk.pendingExit = `${profile.name}趋势失效`; reason = '完整日线跌破趋势条件，等待可卖报价退出';
  } else if (heldDays >= profile.maxHeldBars && (profile.id !== 'swing' || t.close <= risk.entryPrice)) {
    risk.pendingExit = `${profile.name}持有超时`; reason = `买入日后已满 ${profile.maxHeldBars} 根完整日线${profile.id === 'swing' ? '仍未上涨' : ''}，等待退出`;
  } else {
    const desiredStop = round(Math.min(t.support - t.atr * 0.25, t.close - t.atr, q.price - 0.01, risk.target - 0.01));
    if (desiredStop - risk.stop >= noise && step >= 0.01) { risk.stop = round(Math.min(desiredStop, risk.stop + step)); reason = '有效支撑抬高，上移止损保护仓位'; }
    const trend = profile.id === 'swing' ? t.trend : entryTrend(t, profile);
    if (trend && t.breakout && risk.stop > oldStop) {
      risk.target = round(risk.target + step); reason += `；完整日线突破近 ${profile.id === 'swing' ? 5 : profile.resistanceDays} 日压力，小幅上调止盈`;
    } else if (profile.id === 'long' ? t.close < t.ma20 : t.close < t.ma5 || t.macd <= 0) {
      const desiredTarget = Math.max(risk.stop + 0.01, q.price + 0.01, t.close + t.atr);
      if (risk.target - desiredTarget >= noise && step >= 0.01) { risk.target = round(Math.max(desiredTarget, risk.target - step)); reason += '；动能减弱，小幅下调止盈'; }
    }
  }
  risk.lastReviewAsOf = t.asOf; risk.reviewNote = reason;
  risk.history.push({ time: now.toISOString(), asOf: t.asOf, strategyId: profile.id, heldBars: heldDays, oldStop, stop: risk.stop, oldTarget, target: risk.target, reason });
}

module.exports = { STRATEGY_PROFILES, strategyProfile, strategyDefaults, configureStrategy, technicals, usableTechnical, economics, longFinanceCheck, longValuationCheck, evaluateEntry, updateDynamicRisk };
