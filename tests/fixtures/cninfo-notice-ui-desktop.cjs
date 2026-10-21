// Real corporate fallback, ledger, IPC and renderer; only public HTTP responses
// are supplied locally. External opening is captured, and all network is denied.
const fs = require('node:fs');
const { ipcMain } = require('electron');
const { CorporateSource } = require('../../core/corporate-source.cjs');
const { CninfoNoticeSource } = require('../../core/cninfo-notice-source.cjs');
if (!process.env.GUANLAN_TEST_IPC_LOG || !process.env.GUANLAN_TEST_EXTERNAL_LOG
  || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('CN notice UI requires isolated paths');
const originalGet = CorporateSource.prototype.get;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, listener) => handle(name, (event, payload) => {
  if (name === 'research:open') fs.appendFileSync(process.env.GUANLAN_TEST_IPC_LOG, JSON.stringify({ name, payload }) + '\n');
  return listener(event, payload);
});
require('./market-regime-retry-desktop.cjs');
CorporateSource.prototype.get = originalGet;
CorporateSource.prototype.request = async function(url) {
  if (url.includes('/api/security/ann?')) throw Error('隔离样本：东方财富公告目录暂不可用');
  return { success: false, code: 9201, message: '返回数据为空', result: null };
};
CninfoNoticeSource.prototype.request = async function(endpoint, params, signal) {
  signal?.throwIfAborted();
  if (endpoint === '/new/information/topSearch/query') return [{ code: params.keyWord, category: 'A股', delisted: 'false', orgId: 'gssz0000001' }];
  if (endpoint !== '/new/hisAnnouncement/query') throw Error('Unexpected CN fixture endpoint');
  return { totalAnnouncement: 1, totalRecordNum: 1, hasMore: false, announcements: [{ secCode: '000001', orgId: 'gssz0000001',
    announcementId: '1225601360', announcementTitle: '隔离样本：2026年现金分红实施公告', announcementTime: Date.parse('2026-09-28T00:00:00+08:00'),
    adjunctUrl: 'finalpage/2026-09-28/1225601360.PDF', adjunctType: 'PDF', pageColumn: 'SZZB' }] };
};
