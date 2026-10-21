// Isolated issuer-shaped disclosure text, never real investment evidence.
function companyBundle(symbol = 'sh600001', inputNow = new Date('2026-10-13T10:00:00+08:00')) {
  const now = new Date(inputNow), at = now.getTime();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const annualText = `2025年年度报告
公司名称：隔离声学股份有限公司
所属行业：电子设备制造业
主营业务：汽车扬声器
主要产品为汽车扬声器
汽车扬声器产品销量同比增长12.5%，已完成交付。
汽车扬声器产品实现营业收入3亿元。
根据中国电子行业协会发布的《2025年度汽车扬声器市场研究报告》，2025年公司在全国汽车扬声器市场份额排名第1，统计覆盖全部竞争者。
汽车扬声器业务营业收入占公司总收入35%。
汽车扬声器产品未发生重大不利变化。
本报告期不存在债务逾期。
本报告期未发生重大会计差错更正。
审计意见类型：标准的无保留意见。
我们认为，后附财务报表在所有重大方面按照企业会计准则的规定编制，公允反映了公司的财务状况及经营成果。`;
  const semiText = annualText.replace('2025年年度报告', '2026年半年度报告').replace(/审计意见类型：[\s\S]+$/, '本半年度报告未经审计，年度审计意见应参阅最近完整年度报告。');
  const make = (id, kind, publishedAt, reportDate, text) => ({ id, kind, sourceKind: kind,
    title: kind === 'annual-report' ? '2025年年度报告' : '2026年半年度报告', url: `https://example.com/disclosures/${id}`,
    publishedAt, period: kind === 'annual-report' ? '2025年度' : '2026半年度', reportDate,
    issuerSymbol: symbol, fetchedAt: at, complete: true, pages: 1, text, fullText: text, source: '东方财富公告全文' });
  return { symbol, checkedAt: at, fetchedAt: at, status: 'ready', documents: [
    make('AN20260401000001', 'annual-report', '2026-04-01', '2025-12-31', annualText),
    make('AN20260815000001', 'semiannual-report', '2026-08-15', '2026-06-30', semiText)
  ], coverage: { fromDate: '2025-01-01', toDate: today, noticeIndexComplete: true, noticeCount: 2,
    annualReport: { status: 'ready', id: 'AN20260401000001', reportDate: '2025-12-31' },
    semiannualReport: { status: 'ready', id: 'AN20260815000001', reportDate: '2026-06-30' },
    relatedNotices: { selection: 'risk-and-business-keywords', windowFromDate: '2026-07-15', matched: 0, selected: 0, loaded: 0, omitted: 0, complete: true },
    businessAnalysis: { status: 'available', derivedFromReportIds: ['AN20260401000001', 'AN20260815000001'] }, allNoticeBodiesComplete: true, complete: true }, errors: [] };
}

module.exports = { companyBundle };
