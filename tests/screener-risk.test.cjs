const test = require('node:test');
const assert = require('node:assert/strict');
const { Screener, defaults, screen } = require('../core/screener.cjs');
const { composeStrategyQuery } = require('../core/strategy-presets.cjs');
const { ordinaryProfile } = require('./fixtures/industry-profile-data.cjs');

const now = new Date('2026-10-08T10:36:00+08:00');
const row = (symbol = 'sh688578', extra = {}) => ({ symbol, name: '测试股票', board: 'star', isST: false,
  timestamp: now.getTime(), price: 112, changePct: 0.38, amount: 4, turnover: 3, ...extra });
const indicators = { close: 111.58, ma5: 108.092, previousMa5: 107.8, ma20: 104.859, previousMa20: 104.5,
  ma60: 100, previousMa60: 99.9, macd: 2.497, rsi: 55.98, dailyVolumeRatio: 1.636, technicalAsOf: '2026-09-30', technicalSource: '测试日线' };
const finance = { roe: 19.7, debtRatio: 10.37, revenueYoY: 39.85, adjustedProfitYoY: 20, latestAdjustedProfit: 2, operatingCash: 5,
  annualRoeLatest: 12, financeReportDate: '2026-06-30', financeNoticeDate: '2026-08-15', financeCurrency: 'CNY',
  financeFetchedAt: now.getTime(), financeSource: '东方财富',
  financeAnnualReports: [{ reportDate: '2025-12-31', noticeDate: '2026-03-20', currency: 'CNY', roe: 12 }] };
const personal = { ...defaults(), rules: [{ field: 'roe', op: 'gt', value: 10 }, { field: 'debtRatio', op: 'lt', value: 60 }, { field: 'revenueYoY', op: 'gt', value: 10 }] };
const noNotices = symbol => ({ symbol, section: 'notices', source: '东方财富', status: 'empty', fetchedAt: now.getTime(), data: { items: [], total: 0 } });
const notice = (symbol, title) => ({ ...noNotices(symbol), status: 'ready', data: { items: [{ id: 'AN20261008000001', date: '2026-10-08', title, categories: [] }], total: 1 } });
function scanner(rows = [row()], loader = async symbol => noNotices(symbol), clock = () => now, riskQuoteLoader = null) {
  const s = new Screener(async () => { throw Error('unexpected quote request'); }, null,
    async () => { throw Error('unexpected daily request'); }, clock,
    async () => { throw Error('unexpected finance request'); }, loader, riskQuoteLoader);
  s.snapshot = { rows, fetchedAt: now.getTime(), source: '测试行情', sourceCount: rows.length };
  s.load = async () => s.snapshot;
  for (const item of rows) {
    s.dailyCache.set(item.symbol, { cutoff: '2026-10-08:intraday', fetchedAt: now.getTime(), data: indicators });
    s.financeCache.set(item.symbol, { cutoff: '2026-10-08', loadedAt: now.getTime(), data: { ...finance, industryProfile: ordinaryProfile(item.symbol, now) } });
  }
  return s;
}

test('普通策略选股也按需核验敏感公告全文，未知的新公告不复用旧正文通过', async () => {
  const symbol = 'sh688578', s = scanner([row(symbol)], async code => notice(code, '关于诉讼结案的公告'));
  let calls = 0;
  s.noticeEvidenceLoader = async (code, { noticeResponse }) => {
    calls++;
    const item = noticeResponse.data.items[0], text = '本次诉讼已结案，相关义务已全部履行完毕。本次诉讼对公司生产经营未造成重大不利影响。';
    return { symbol: code, fetchedAt: +now, documents: [{ id: item.id, title: item.title, publishedAt: item.date, issuerSymbol: code, kind: 'notice', complete: true,
      fetchedAt: +now, url: `https://data.eastmoney.com/notices/detail/${code.slice(2)}/${item.id}.html`, text, pages: 1,
      pageTexts: [{ page: 1, text, method: 'provider-text', numericEligible: true, complete: true }] }] };
  };
  const result = await s.run(defaults(), [], false, null, 'swing');
  assert.equal(calls, 1); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].entryRisk.notices.mode, 'automatic-fulltext');
  s.noticeLoader = async code => notice(code, '关于新增重大诉讼的公告');
  s.noticeEvidenceLoader = async () => ({ symbol, fetchedAt: +now, documents: [] });
  const failed = await s.run(defaults(), [], false, null, 'swing');
  assert.equal(failed.rows.length, 0); assert.equal(failed.riskScreen.unverified, 1);
});

test('SH688578跌20%即使短线及盈利成长11项全过也不再成为观察候选', async () => {
  const crash = row('sh688578', { price: 89.26, changePct: -20 });
  const query = composeStrategyQuery('short', personal);
  assert.equal(query.rules.length, 11);
  assert.equal(screen({ rows: [{ ...crash, ...indicators, ...finance }] }, query).matched, 1);
  let noticeCalls = 0;
  const s = scanner([crash], async () => { noticeCalls++; throw Error('must not request'); });
  const before = structuredClone(s.snapshot), result = await s.run(query, [], false, null, 'short');
  assert.equal(result.rows.length, 0); assert.equal(result.matched, 0); assert.equal(result.status, 'empty');
  assert.equal(result.riskExcluded[0].symbol, 'sh688578'); assert.equal(result.riskExcluded[0].entryRisk.status, 'blocked');
  assert.match(result.riskExcluded[0].entryRisk.reasons.join(''), /20\.00%/);
  assert.equal(result.riskScreen.blocked, 1); assert.equal(result.riskScreen.marketExcluded, 1);
  assert.equal(result.missing, 0); assert.equal(noticeCalls, 0); assert.deepEqual(s.snapshot, before);
});

test('超短与短线风险检查独立于指标删除，5%边界排除而4.99%仍需公告核验', async () => {
  for (const strategy of ['short', 'ultra-short']) {
    const s = scanner([row('sh688001', { changePct: -5 }), row('sh688002', { changePct: -4.99 })]);
    const result = await s.run(defaults(), [], false, null, strategy);
    assert.deepEqual(result.rows.map(item => item.symbol), ['sh688002']);
    assert.deepEqual(result.riskExcluded.map(item => item.symbol), ['sh688001']);
    assert.equal(result.riskScreen.noticeChecked, 1); assert.equal(result.rows[0].entryRisk.status, 'clear');
  }
});

test('当日风险检查仅覆盖本次范围，拒绝报价不算指标缺失或自选缺失', async () => {
  const s = scanner([row('sh688001', { changePct: -20 }), row('sh688002', { changePct: -20 }),
    row('sh600001', { board: 'sh', changePct: -20 }), row('sh688003', { isST: true, changePct: -20 })]);
  const query = { ...defaults(), scope: 'watchlist', boards: ['star'], excludeST: true };
  const result = await s.run(query, ['sh688001', 'sh600001', 'sh688003', 'sh688999'], false, null, 'short');
  assert.equal(result.poolCount, 1); assert.equal(result.eligibleCount, 4); assert.equal(result.watchlistMissing, 1);
  assert.equal(result.riskScreen.marketChecked, 1); assert.equal(result.riskExcluded.length, 1); assert.equal(result.missing, 0);
});

test('未知、过期、未来或跨日报价单列待核验，不伪装成无匹配', async () => {
  for (const extra of [{ timestamp: null }, { timestamp: now.getTime() - 91000 }, { timestamp: now.getTime() + 1 },
    { timestamp: Date.parse('2026-09-30T15:00:00+08:00') }, { changePct: null }, { price: null }]) {
    const result = await scanner([row('sh688578', extra)]).run(defaults(), [], false, null, 'short');
    assert.equal(result.rows.length, 0); assert.equal(result.status, 'unavailable'); assert.equal(result.matched, null);
    assert.equal(result.riskScreen.unverified, 1); assert.equal(result.missing, 0); assert.equal(result.partial, true);
  }
});

test('先完成指标筛选再查公告，技术不命中与财务不命中的股票不发公告请求', async () => {
  const calls = [], s = scanner([row('sh688001'), row('sh688002'), row('sh688003')], async symbol => { calls.push(symbol); return noNotices(symbol); });
  s.dailyCache.get('sh688002').data = { ...indicators, rsi: 80 };
  s.financeCache.get('sh688003').data = { ...finance, roe: 1 };
  const result = await s.run(composeStrategyQuery('short', personal), [], false, null, 'short');
  assert.deepEqual(calls, ['sh688001']); assert.deepEqual(result.rows.map(item => item.symbol), ['sh688001']);
  assert.equal(result.riskScreen.noticeChecked, 1); assert.equal(result.riskScreen.excluded, 0);
});

test('近期敏感试验公告待核验、明确不利公告拦截，盈利成长不能覆盖事件风险', async () => {
  const s = scanner([row('sh688001'), row('sh688002'), row('sh688003')], async symbol => symbol.endsWith('1')
    ? notice(symbol, '关于伏美替尼III期临床试验研究进展的公告') : symbol.endsWith('2')
      ? notice(symbol, '临床试验未达到主要研究终点的公告') : noNotices(symbol));
  const result = await s.run(composeStrategyQuery('short', personal), [], false, null, 'short');
  assert.deepEqual(result.rows.map(item => item.symbol), ['sh688003']);
  assert.deepEqual(result.riskExcluded.map(item => item.entryRisk.status), ['unverified', 'blocked']);
  assert.equal(result.riskExcluded[0].entryRisk.notices.notices.length, 1);
  assert.equal(result.riskScreen.noticeExcluded, 2); assert.equal(result.riskScreen.unverified, 1); assert.equal(result.missing, 0);
});

test('公告缺配置、失败、来源或股票不符、缓存过期均不放行', async () => {
  const loaders = [null, async () => { throw Error('offline'); }, async () => noNotices('sh688001'),
    async symbol => ({ ...noNotices(symbol), source: '不明' }), async symbol => ({ ...noNotices(symbol), status: 'stale' }),
    async symbol => ({ ...noNotices(symbol), fetchedAt: now.getTime() - 300001 })];
  for (const loader of loaders) {
    const result = await scanner([row()], loader).run(defaults(), [], false, null, 'short');
    assert.equal(result.rows.length, 0); assert.equal(result.riskScreen.unverified, 1); assert.equal(result.missing, 0);
    assert.equal(result.status, 'unavailable'); assert.equal(result.matched, null);
  }
});

test('公告扫描最多三并发，透传刷新与取消，忽略取消的服务也不会阻塞或发布部分结果', async () => {
  const calls = []; let started;
  const began = new Promise(resolve => { started = resolve; });
  const s = scanner(Array.from({ length: 10 }, (_, i) => row(`sh6880${String(i).padStart(2, '0')}`)), (symbol, signal, force) => {
    calls.push({ symbol, signal, force }); if (calls.length === 3) started();
    return new Promise(() => {});
  });
  const run = s.run(defaults(), [], true, null, 'short'); await began;
  assert.equal(s.progress.stage, 'notices'); assert.equal(s.progress.total, 10); assert.equal(calls.length, 3);
  assert.ok(calls.every(item => item.force === true)); s.cancel(); await assert.rejects(run, /取消/);
  assert.equal(calls.length, 3); assert.ok(calls.every(item => item.signal.aborted)); assert.equal(s.progress.loading, false);
  assert.equal(s.activeRun, null); assert.ok(s.snapshot.rows.every(item => !item.entryRisk));
  s.noticeLoader = async symbol => noNotices(symbol);
  assert.equal((await s.run(defaults(), [], false, null, 'short')).rows.length, 10);
});

test('扫描期间变旧的报价在返回前重新核验，不能沿用扫描开始时的通过状态', async () => {
  let time = now;
  const s = scanner([row('sh688001'), row('sh688002')], async symbol => {
    if (symbol.endsWith('2')) { await new Promise(resolve => setImmediate(resolve)); time = new Date(now.getTime() + 91000); }
    return noNotices(symbol);
  }, () => time);
  const result = await s.run(defaults(), [], false, null, 'short');
  assert.equal(result.rows.length, 0); assert.equal(result.riskScreen.marketExcluded, 2); assert.equal(result.riskScreen.noticeExcluded, 0);
  assert.ok(result.riskExcluded.every(item => item.entryRisk.market.reasons.join('').includes('90 秒')));
});

test('所有模板拒绝历史快照与非法策略，自定义保留原指标结果并明确未核验公告', async () => {
  let requests = 0;
  const s = scanner([row('sh688578', { changePct: -20 })], async () => { requests++; throw Error('must not request'); });
  for (const strategy of ['short', 'ultra-short', 'swing', 'long']) await assert.rejects(s.run(defaults(), [], false, 'old', strategy), /历史快照.*公告/);
  for (const strategy of ['', 'unknown', '__proto__', {}, []]) await assert.rejects(s.run(defaults(), [], false, null, strategy), /不存在/);
  const result = await s.run(defaults(), [], false, null, null);
  assert.equal(result.matched, 1); assert.equal(result.riskScreen, undefined); assert.equal(result.riskExcluded, undefined);
  assert.equal(result.rows[0].entryRisk, undefined); assert.deepEqual(result.rows, s.snapshot.rows);
  assert.equal(result.noticeScreen.status, 'unverified'); assert.equal(result.noticeScreen.mode, 'not-reviewed');
  assert.match(result.noticeScreen.reason, /自定义筛选未批量核验公告/);
  s.history = { get: () => s.snapshot };
  const historical = await s.run(defaults(), [], false, 'old', null);
  assert.equal(historical.matched, 1); assert.equal(historical.noticeScreen.status, 'unverified');
  assert.match(historical.noticeScreen.reason, /历史快照未保存当时的公告/);
  assert.equal(requests, 0);
});

test('波段长线均检查指标命中者的敏感公告及资料失败，不伪造市场核验且不套用短线5%门槛', async () => {
  for (const strategy of ['swing', 'long']) {
    let quoteRequests = 0;
    const candidates = Array.from({ length: 4 }, (_, i) => row(`sh68800${i + 1}`, { price: 89.26, changePct: -20, pe: 20, pb: 2 }));
    const calls = [], s = scanner(candidates, async symbol => {
      calls.push(symbol);
      if (symbol.endsWith('1')) return noNotices(symbol);
      if (symbol.endsWith('2')) return notice(symbol, '关于临床试验研究进展的公告');
      if (symbol.endsWith('3')) throw Error('offline');
      return notice(symbol, '临床试验未达到主要研究终点的公告');
    }, () => now, async () => { quoteRequests++; throw Error('must not request short-market check'); });
    const result = await s.run(composeStrategyQuery(strategy), [], false, null, strategy);
    assert.equal(calls.length, 4); assert.equal(quoteRequests, 0); assert.equal(result.noticeScreen, undefined);
    assert.equal(result.poolCount, 4); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].changePct, -20);
    assert.equal(result.rows[0].entryRisk.market, null); assert.equal(result.rows[0].entryRisk.notices.status, 'clear');
    assert.equal(result.riskScreen.marketEnabled, false); assert.equal(result.riskScreen.marketChecked, 0); assert.equal(result.riskScreen.marketExcluded, 0);
    assert.equal(result.riskScreen.noticeChecked, 4); assert.equal(result.riskScreen.noticeExcluded, 3);
    assert.equal(result.riskScreen.unverified, 2); assert.equal(result.riskScreen.blocked, 1); assert.equal(result.missing, 0);
    assert.ok(result.riskExcluded.every(item => item.entryRisk.market === null));
    assert.ok([...result.rows, ...result.riskExcluded].every(item => !item.entryRisk.reasons.some(reason => /5%|当日行情风险规则通过/.test(reason))));
  }
});

test('波段长线公告全部失败时待核验数量独立统计，不能当成零命中或市场检查通过', async () => {
  for (const strategy of ['swing', 'long']) {
    const s = scanner([row()], async () => { throw Error('offline'); });
    const result = await s.run(defaults(), [], false, null, strategy);
    assert.equal(result.rows.length, 0); assert.equal(result.status, 'unavailable'); assert.equal(result.matched, null);
    assert.equal(result.missing, 0); assert.equal(result.riskScreen.unverified, 1); assert.equal(result.riskScreen.noticeExcluded, 1);
    assert.equal(result.riskExcluded[0].entryRisk.market, null); assert.equal(result.riskScreen.marketEnabled, false);
  }
});

test('成功候选携带核验详情，行情缓存与原始快照保持无风险派生字段', async () => {
  const s = scanner(), before = structuredClone(s.snapshot);
  const result = await s.run(composeStrategyQuery('short', personal), [], false, null, 'short');
  assert.equal(result.rows[0].entryRisk.market.status, 'clear'); assert.equal(result.rows[0].entryRisk.notices.status, 'clear');
  assert.equal(result.riskScreen.cleared, 1); assert.deepEqual(s.snapshot, before);
  assert.equal(result.rows[0].technicalAsOf, '2026-09-30'); assert.equal(result.rows[0].roe, 19.7);
});

test('长扫描完成后用新报价核验风险，保留原条件快照及技术财务证据', async () => {
  let time = now;
  const s = scanner([row()], async symbol => {
    time = new Date(now.getTime() + 120000); return { ...noNotices(symbol), fetchedAt: time.getTime() };
  }, () => time, async (symbols, signal) => {
    assert.deepEqual(symbols, ['sh688578']); assert.equal(signal.aborted, false);
    return { sh688578: { symbol: 'sh688578', price: 113, prevClose: 111.58, timestamp: time.getTime(), source: '腾讯公开行情' } };
  });
  const before = structuredClone(s.snapshot);
  const result = await s.run(composeStrategyQuery('short', personal), [], false, null, 'short');
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].price, 112); assert.equal(result.rows[0].timestamp, now.getTime());
  assert.equal(result.rows[0].technicalAsOf, '2026-09-30'); assert.equal(result.rows[0].roe, 19.7);
  const market = result.rows[0].entryRisk.market;
  assert.equal(market.status, 'clear'); assert.equal(market.basis, 'risk-refresh'); assert.equal(market.label, '风险复核报价');
  assert.equal(market.price, 113); assert.equal(market.quoteTime, time.getTime()); assert.equal(market.source, '腾讯公开行情');
  assert.ok(market.changePct > 1); assert.deepEqual(s.snapshot, before);
});

test('扫描期间由正常报价跌至跌停，用复核报价拦截且不篡改原始筛选价格', async () => {
  let time = now;
  const s = scanner([row()], async symbol => {
    time = new Date(now.getTime() + 120000); return { ...noNotices(symbol), fetchedAt: time.getTime() };
  }, () => time, async () => ({ sh688578: { symbol: 'sh688578', price: 89.26, prevClose: 111.58, changePct: -20,
    timestamp: time.getTime(), source: '腾讯公开行情', limitDown: 89.26, bid: 0, bidSize: 0 } }));
  const result = await s.run(defaults(), [], false, null, 'short');
  assert.equal(result.rows.length, 0); assert.equal(result.riskScreen.blocked, 1); assert.equal(result.riskScreen.marketExcluded, 1);
  const excluded = result.riskExcluded[0];
  assert.equal(excluded.price, 112); assert.equal(excluded.entryRisk.market.price, 89.26);
  assert.equal(excluded.entryRisk.market.changePct, -20); assert.match(excluded.entryRisk.reasons.join(''), /跌停/);
});

test('配置复核报价服务后获取失败、缺股票或返回错股票，均待核验且不回退旧报价', async () => {
  for (const quoteLoader of [async () => { throw Error('offline'); }, async () => ({}),
    async () => ({ sh688578: { ...row(), symbol: 'sh688001' } })]) {
    const s = scanner([row()], async symbol => noNotices(symbol), () => now, quoteLoader);
    const result = await s.run(defaults(), [], false, null, 'short');
    assert.equal(result.rows.length, 0); assert.equal(result.status, 'unavailable'); assert.equal(result.missing, 0);
    assert.equal(result.riskScreen.unverified, 1); assert.equal(result.riskExcluded[0].entryRisk.market.basis, 'risk-refresh');
    assert.equal(result.riskExcluded[0].entryRisk.market.quoteTime, null); assert.equal(result.riskExcluded[0].entryRisk.market.price, null);
    assert.match(result.riskExcluded[0].entryRisk.market.reasons.join(''), /复核报价获取失败/);
  }
});

test('复核报价按不超过50只分批且最多三批并发，漏返回的股票独立待核验', async () => {
  const candidates = Array.from({ length: 121 }, (_, index) => row(`sh688${String(index).padStart(3, '0')}`));
  const batches = []; let active = 0, peak = 0;
  const s = scanner(candidates, async symbol => noNotices(symbol), () => now, async symbols => {
    batches.push(symbols); peak = Math.max(peak, ++active); await new Promise(resolve => setImmediate(resolve)); active--;
    return Object.fromEntries(symbols.filter(symbol => symbol !== 'sh688120').map(symbol => [symbol, row(symbol)]));
  });
  const result = await s.run(defaults(), [], false, null, 'short');
  assert.deepEqual(batches.map(batch => batch.length), [50, 50, 21]); assert.ok(peak <= 3);
  assert.equal(result.rows.length, 120); assert.equal(result.riskScreen.unverified, 1);
  assert.equal(result.riskExcluded[0].symbol, 'sh688120'); assert.equal(s.progress.stage, 'risk-quotes');
  assert.equal(s.progress.completed, 121); assert.equal(s.progress.loading, false);
});

test('复核报价取消及时结束并停止后续批次，不发布部分结果', async () => {
  const candidates = Array.from({ length: 151 }, (_, index) => row(`sh688${String(index).padStart(3, '0')}`));
  const calls = []; let started;
  const began = new Promise(resolve => { started = resolve; });
  const s = scanner(candidates, async symbol => noNotices(symbol), () => now, (symbols, signal) => {
    calls.push({ symbols, signal }); if (calls.length === 3) started(); return new Promise(() => {});
  });
  const run = s.run(defaults(), [], false, null, 'short'); await began;
  assert.equal(s.progress.stage, 'risk-quotes'); s.cancel(); await assert.rejects(run, /取消/);
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call.signal.aborted)); assert.equal(s.activeRun, null);
  assert.ok(s.snapshot.rows.every(item => !item.entryRisk));
});
