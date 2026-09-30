// Deterministic research samples, never loaded by the packaged application.
const data = rows => ({ success: true, result: { data: rows, count: rows.length } });
function profile(symbol = 'sh600519') {
  return data([{ SECUCODE: `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`, ORG_NAME: `测试公司 ${symbol}`, SECURITY_NAME_ABBR: '测试股票', MAIN_BUSINESS: '测试主营业务', EM2016: '测试行业', LISTING_DATE: '2001-08-27 00:00:00', ORG_PROFILE: '仅用于界面与数据解析验证' }]);
}
function financialRow(symbol = 'sh600519', date = '2026-06-30') {
  return { SECUCODE: `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`, REPORT_DATE: date + ' 00:00:00', NOTICE_DATE: date.endsWith('12-31') ? `${+date.slice(0, 4) + 1}-03-20 00:00:00` : `${date.slice(0, 4)}-08-15 00:00:00`, UPDATE_DATE: '2026-08-20 00:00:00', CURRENCY: 'CNY', TOTALOPERATEREVE: 920e8, PARENTNETPROFIT: 440e8, KCFJCXSYJLR: 435e8, TOTALOPERATEREVETZ: 1.3, PARENTNETPROFITTZ: -1.9, KCFJCXSYJLRTZ: -2.1, NETCASH_OPERATE_PK: 700e8, ROEJQ: 16.75, ZCFZL: 15.19 };
}
function finance(symbol = 'sh600519') { return data(['2026-06-30', '2025-12-31', '2024-12-31', '2023-12-31'].map(date => financialRow(symbol, date))); }
function valuation(symbol = 'sh600519') { return { rc: 0, data: { diff: [{ f12: symbol.slice(2), f13: symbol.startsWith('sh') ? 1 : 0, f9: -2.3, f23: 1.8, f20: 15000e8, f21: 12000e8, f124: Date.parse('2026-09-30T10:00:00+08:00') / 1000 }] } }; }
function notices(symbol = 'sh600519') { return { success: 1, data: { total_hits: 1, list: [{ art_code: 'AN202608141827994403', notice_date: '2026-08-15 00:00:00', title: `测试公告 ${symbol}：2026年半年度报告`, codes: [{ stock_code: symbol.slice(2), market_code: symbol.startsWith('sh') ? '1' : '0' }], columns: [{ column_name: '半年度报告' }] }] } }; }
module.exports = { data, profile, financialRow, finance, valuation, notices };
