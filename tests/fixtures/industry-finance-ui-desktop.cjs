// Same valid statements for each issuer; only template classification differs.
const fs = require('node:fs');
require('./finance-periods-desktop.cjs');
const { Research } = require('../../core/research.cjs'), get = Research.prototype.get;
Research.prototype.get = async function(input) {
  if (input.section !== 'profile') return get.call(this, input);
  const control = JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
  const data = input.symbol === 'sh600010' ? { industry: '银行', regulatoryIndustry: '金融业', orgType: '银行', orgTypeCode: '3' }
    : input.symbol === 'sh600011' && !control.classificationResolved ? { industry: null, regulatoryIndustry: null, orgType: '通用', orgTypeCode: '4' }
      : { industry: '电子', regulatoryIndustry: '制造业', orgType: '通用', orgTypeCode: '4' };
  return { symbol: input.symbol, section: 'profile', source: '东方财富', status: 'ready', fetchedAt: Date.now(), data };
};
const { FreeScreenerSource } = require('../../core/screener-sources.cjs');
FreeScreenerSource.prototype.load = async function() {
  const rows = [['sh600519', '隔离普通制造业'], ['sh600010', '隔离银行 <模板>'], ['sh600011', '隔离行业未知']].map(([symbol, name]) => ({ symbol, name, board: 'sh', isST: false,
    price: 10.17, pe: 15, pb: 2, timestamp: Date.now(), changePct: 0.1, turnover: 4, amount: 3 }));
  return { rows, source: '隔离财务适用性 UI 行情', sourceCount: rows.length, excludedCount: 0, startedAt: Date.now(), fetchedAt: Date.now() };
};
