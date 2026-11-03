// Production startup, IPC, AgencyService and persistence with isolated providers.
// The inherited fixture blocks HTTP(S), Electron fetch and renderer networking.
'use strict';
const fs = require('node:fs');
require('./auto-only-desktop.cjs');
const record = (kind, data = {}) => fs.appendFileSync(process.env.GUANLAN_TEST_SOURCE_LOG, JSON.stringify({ kind, ...data }) + '\n');
const { AgencyService } = require('../../core/agency-service.cjs');
const originalMonitoring = AgencyService.prototype.recordMonitoring;
AgencyService.prototype.recordMonitoring = function(symbol, evaluation, position) {
  const result = originalMonitoring.call(this, symbol, evaluation, position);
  const member = this.getEngine().s.agency.groups.flatMap(group => group.members).find(item => item.symbol === symbol);
  record('real-monitoring-check', { symbol, check: member?.monitoringCheck });
  return result;
};
const { Market } = require('../../core/market.cjs');
const originalHistory = Market.prototype.strategyHistory;
Market.prototype.strategyHistory = async function(symbol, ...args) {
  record('daily-history', { symbol });
  return originalHistory.call(this, symbol, ...args);
};
const { Research } = require('../../core/research.cjs');
Research.prototype.request = async function(url) { record('unexpected-research', { url: String(url) }); throw Error('隔离研究接口不可用'); };
const { CorporateSource } = require('../../core/corporate-source.cjs');
CorporateSource.prototype.get = async function(input) { record('unexpected-corporate', input); throw Error('首次开仓隔离样本不应请求公司行为资料'); };
