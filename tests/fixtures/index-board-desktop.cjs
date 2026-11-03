// Real desktop, preload, IPC and isolated account; only data providers are replaced.
'use strict';
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
require('./market-search-desktop.cjs');
const { IndexMarket } = require('../../core/index-market.cjs');
const scenario = () => JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
const record = (kind, data = {}) => fs.appendFileSync(process.env.GUANLAN_TEST_SOURCE_LOG, JSON.stringify({ kind, ...data }) + '\n');
const definitions = [
  ['cn-shanghai', '上证指数', 'cn', '中国内地', 'Asia/Shanghai', '000001', 3210.25, 10.25, '2026-09-28T15:00:00+08:00', '2026-09-28 15:00:00'],
  ['cn-shenzhen', '深证成指', 'cn', '中国内地', 'Asia/Shanghai', '399001', 11250.5, -20.5, '2026-09-28T15:00:00+08:00', '2026-09-28 15:00:00'],
  ['hk-hsi', '恒生指数', 'hk', '中国香港', 'Asia/Hong_Kong', 'HSI', 22120.75, 120.75, '2026-09-28T16:00:00+08:00', '2026-09-28 16:00:00'],
  ['us-sp500', '标普 500', 'us', '美国', 'America/New_York', 'SPX', 6500.25, -5.25, '2026-09-28T16:00:00-04:00', '2026-09-28 16:00:00'],
  ['us-nasdaq', '纳斯达克综合', 'us', '美国', 'America/New_York', 'IXIC', 22110.5, 0, '2026-09-28T16:00:00-04:00', '2026-09-28 16:00:00'],
  ['asia-nikkei', '日经 225', 'asia', '日本', 'Asia/Tokyo', 'N225', 41200.5, 200.5, '2026-09-28T15:30:00+09:00', '2026-09-28 15:30:00'],
  ['europe-dax', '德国 DAX', 'europe', '德国', 'Europe/Berlin', 'GDAXI', 24001.25, -10.25, '2026-09-28T17:30:00+02:00', '2026-09-28 17:30:00'],
  ['europe-ftse', '英国富时 100', 'europe', '英国', 'Europe/London', 'FTSE', 9250.75, 50.75, '2026-09-28T16:30:00+01:00', '2026-09-28 16:30:00']
];
IndexMarket.prototype.overview = async function({ force = false } = {}) {
  const control = scenario(); record('index-start', { force });
  if (control.indexDelay) await delay(control.indexDelay);
  if (control.indexFailure) { record('index-failed'); throw Error('隔离指数接口暂时不可用'); }
  const fetchedAt = Date.parse(control.now), attemptedAt = fetchedAt;
  const items = definitions.map(([id, name, group, region, timeZone, code, price, change, iso, quoteTime]) => {
    const prevClose = price - change;
    const item = { id, name, group, region, timeZone, code, instrumentType: 'index', canTrade: false,
      price, change, changePct: change / prevClose * 100, prevClose, open: prevClose, high: Math.max(price, prevClose),
      low: Math.min(price, prevClose), quoteAt: Date.parse(iso), quoteTime, source: '隔离指数行情', provider: 'fixture',
      fetchedAt, status: 'ok', error: null };
    if (control.indexUnavailable?.includes(id)) Object.assign(item, { price: null, change: null, changePct: null,
      prevClose: null, open: null, high: null, low: null, quoteAt: null, quoteTime: null, fetchedAt: null,
      status: 'unavailable', error: '隔离指数未返回有效报价' });
    if (control.indexStale?.includes(id)) Object.assign(item, { status: 'stale', fetchedAt: fetchedAt - 60000,
      error: '隔离指数刷新失败，保留上次报价' });
    return item;
  });
  record('index-complete', { force, count: items.length });
  return { items, fetchedAt, attemptedAt };
};
