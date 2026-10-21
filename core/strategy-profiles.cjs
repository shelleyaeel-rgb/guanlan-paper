// Execution profiles are fixed defaults. Editing screener conditions does not rewrite an open trade.
const LONG_FINANCE_POLICY_NOTE = '当前模板仅适用于已核验行业的普通非金融企业；银行、保险、证券及其他金融企业列为模板不适用，行业资料不足时等待核验。数值阈值是内置产品模板，不是会计标准，尚未完成细分行业校准和样本外验证。编辑预筛条件不会改写内置开仓门槛，已保存的个人条件另行叠加。';
const LONG_FINANCE_RULES = [
  { field: 'annualRoeLatest', label: '最近完整年度加权 ROE', op: 'gte', value: 8, unit: '%', basis: '完整年度加权 ROE；不使用季度累计值或简单年化' },
  { field: 'debtRatio', label: '资产负债率', op: 'gte', value: 0, unit: '%', basis: '最新报告期末负债率' },
  { field: 'debtRatio', label: '资产负债率', op: 'lte', value: 60, unit: '%', basis: '最新报告期末负债率' },
  { field: 'revenueYoY', label: '营收同比', op: 'gte', value: 0, unit: '%', basis: '最新报告期累计营收与上年同期比较' },
  { field: 'adjustedProfitYoY', label: '扣非净利润同比', op: 'gte', value: 0, unit: '%', basis: '最新报告期累计扣非净利润与上年同期比较；增长不等于盈利' },
  { field: 'latestAdjustedProfit', label: '最新累计扣非净利润', op: 'gt', value: 0, unit: '亿元', basis: '最新报告期累计人民币金额；不使用预告或快报替代' },
  { field: 'operatingCash', label: '最新累计经营现金流净额', op: 'gt', value: 0, unit: '亿元', basis: '最新报告期累计人民币金额；非 TTM' }
];
for (const rule of LONG_FINANCE_RULES) Object.freeze(rule);
Object.freeze(LONG_FINANCE_RULES);
// Fixed, versioned product assumptions; these are not fitted profitability or
// probability estimates. Existing positions retain their original plans.
const ADAPTIVE_ENTRY_TEMPLATE = Object.freeze({ id: 'observed-entry-v1', confirmMs: 60000, maxQuoteGapMs: 90000,
  observationWindowMs: 900000, maxObservations: 256, reboundAtr: 0.1, breakoutBufferAtr: 0.05, maxChaseAtr: 0.5,
  breakoutStopAtr: 0.5, breakoutTargetAtr: 3,
  limitation: '未完成样本外验证的产品模板；连续报价仅表示已观察的价格路径，不保证止跌、突破有效或可实现收益' });
const STRATEGY_PROFILES = [
  {
    id: 'ultra-short', name: '超短线', horizon: '隔夜观察；买入日后满 3 根完整日线触发期限退出',
    entryDescription: '收盘高于 MA5，MA5 上行且高于 MA20；MACD 柱为正、RSI 50–75、日量比 1.2–3；当日成交额至少 2 亿元、换手率 2%–15%。在 MA5 −0.25 至 +0.75 ATR 区域回踩确认。',
    exitDescription: '初始止损取 MA5 与近 3 日低点较低值再减 0.25 ATR，目标为近 5 日高点；收盘跌破 MA5 −0.5 ATR、MA5 不再高于 MA20，或买入日后满 3 根完整日线触发退出。T+1、跳空和盘口不足可能延迟或偏离退出价。',
    dataDescription: '使用完整未复权日线和当日 90 秒内报价；成交额、换手率为盘中累计值。超短线仍遵守 A 股 T+1，不支持买入当日卖出。新建仓另行检查当日跌幅、退出买盘和近 14 日公告标题，风险拦截或待核验时暂停。',
    anchor: 'ma5', supportDays: 3, resistanceDays: 5, maxHeldBars: 3
  },
  {
    id: 'short', name: '短线', horizon: '短期跟踪；买入日后满 10 根完整日线触发期限退出',
    entryDescription: '收盘不低于 MA5，MA5 高于 MA20 且 MA20 上行；MACD 柱为正、RSI 45–75、日量比至少 1，当日成交额至少 1 亿元。在 MA5 −0.25 至 +0.75 ATR 区域回踩确认。',
    exitDescription: '初始止损取 MA5 与近 5 日低点较低值再减 0.25 ATR，目标为近 20 日高点；MA5 低于 MA20、收盘跌破 MA20 −0.5 ATR，或买入日后满 10 根完整日线触发退出。止损只上移；新日线按动量小幅调整目标。',
    dataDescription: '使用完整未复权日线和当日 90 秒内报价，成交额为盘中累计值；成交仍需一档数量、含费盈亏比与风险预算通过。新建仓另查当日跌幅与近 14 日公告标题，敏感事项或数据不足时暂停；标题检查不替代原文核验。',
    anchor: 'ma5', supportDays: 5, resistanceDays: 20, maxHeldBars: 10
  },
  {
    id: 'swing', name: '波段', horizon: '数日至数周；买入日后满 15 根新日线仍未上涨触发退出',
    entryDescription: 'MA20 上行且高于 MA60、收盘不低于 MA20；MACD 柱为正、RSI 40–75、日量比至少 0.6。在 MA20 −0.25 至 +0.75 ATR 区域回踩确认。',
    exitDescription: '初始止损取 MA20 与近 5 日低点较低值再减 0.25 ATR，目标为近 20 日高点；MA20 低于 MA60、收盘跌破 MA20 −0.5 ATR，或满 15 根新日线仍未上涨触发退出。止损只上移；新日线按动量小幅调整目标。',
    dataDescription: '使用完整未复权日线；新建仓须通过四类策略共用的近 14 日公告标题检查，风险事项或数据不足时暂停。旧波段持仓保持原交易计划。回踩后还须通过盘中确认、含费盈亏比和风险预算。',
    anchor: 'ma20', supportDays: 5, resistanceDays: 20, maxHeldBars: 15
  },
  {
    id: 'long', name: '长线', horizon: '数月跟踪；买入日后满 120 根完整日线触发期限退出',
    entryDescription: '先确认属于普通非金融企业；最近完整年度加权 ROE≥8%；最新报告期负债率为0%–60%，累计营收及扣非净利润同比≥0，累计扣非净利润与经营现金流净额均>0；动态 PE 为 0–30（不含 0）、PB 为 0–4（不含 0）。MA20≥MA60、MA60 不下降、收盘不低于 MA60，在 MA60 −0.25 至 +0.75 ATR 区域回踩确认。',
    exitDescription: '初始止损取 MA60 与近 20 日低点较低值再减 0.25 ATR，目标为近 60 日高点；MA20 低于 MA60、收盘跌破 MA60 −0.5 ATR，或买入日后满 120 根完整日线触发退出。持仓按趋势与价位跟踪，不把跨季累计财务数值直接比较为恶化。',
    dataDescription: `东方财富财报获取不超过 6 小时，报告期也须满足有效性要求；估值获取及报价均不超过 90 秒。年度 ROE 独立取最近完整年报，不要求三个年度齐全；最新累计 ROE 仅作观察，未年化，PE 为动态口径。增长和实际盈利分别核验，金额使用人民币。${LONG_FINANCE_POLICY_NOTE}新建仓同样须通过公告检查，明确风险及资料缺失时暂停。自动交易会取证并处理资料完整的标准现金分红和免税整数转增，复杂事件附原文进入异常核验；未核实权益不可用于收益比较。手动账户仍须在除权除息前结束该轮模拟。`,
    anchor: 'ma60', supportDays: 20, resistanceDays: 60, maxHeldBars: 120
  }
];
for (const profile of STRATEGY_PROFILES) Object.freeze(profile);
Object.freeze(STRATEGY_PROFILES);

function strategyProfile(id = 'swing') {
  const profile = STRATEGY_PROFILES.find(item => item.id === id);
  if (!profile) throw Error('所选买卖计划不存在，请重新选择投资策略');
  return profile;
}

module.exports = { STRATEGY_PROFILES, strategyProfile, LONG_FINANCE_RULES, LONG_FINANCE_POLICY_NOTE, ADAPTIVE_ENTRY_TEMPLATE };
