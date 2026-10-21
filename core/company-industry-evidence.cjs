'use strict';
const { createHash } = require('node:crypto');
const { cnTime } = require('./common.cjs');
const { PARSER_VERSION } = require('./company-document-parser.cjs');
const hash = text => createHash('sha256').update(text).digest('hex');
const compact = text => String(text || '').normalize('NFKC').replace(/\s+/g, '');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SOURCES = Object.freeze({ 'www.frostchina.com': '弗若斯特沙利文', 'img.frostchina.com': '弗若斯特沙利文' });
function trustedIndustryUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.port && !url.username && !url.password && Object.hasOwn(SOURCES, url.hostname) ? url.href : null; } catch { return null; }
}
function hasCurrentIndustryPdfParsing(document) {
  const pdf = /^pdf(?:-|$)/.test(document?.format || '') || typeof document?.originalBase64 === 'string';
  return !pdf || document.parserVersion === PARSER_VERSION;
}
const LEGAL_NAME = /^[\u4e00-\u9fffA-Za-z()·]{2,50}(?:股份有限公司|股份有限责任公司|有限责任公司|有限公司)$/;
// These are references to a subject, never an independently named issuer.
const REFERENCE_NAME = /^(?:公司|本公司|上市公司|发行人|本集团)$/;
function namedIssuer(value) { return /^[\u4e00-\u9fffA-Za-z0-9()·*]{2,60}$/.test(value) && !REFERENCE_NAME.test(value); }
function issuerIdentity(bundle) {
  const names = new Set(), titleNames = [];
  const reports = (bundle?.documents || []).filter(doc => doc.issuerSymbol === bundle.symbol && doc.complete === true
    && ['annual-report', 'semiannual-report'].includes(doc.kind)).sort((a, b) => String(b.reportDate || b.publishedAt || '').localeCompare(String(a.reportDate || a.publishedAt || '')));
  for (const doc of reports) {
    // The provider's issuer-bound disclosure title is separate from OCR body
    // text. A report must actually be named after its issuer in this syntax.
    const title = /^([^:]{2,60}):(.+)$/.exec(compact(doc.title));
    if (title && namedIssuer(title[1]) && /20\d{2}年?(?:半年度报告|中期报告|年度报告)/.test(title[2])) {
      names.add(title[1]); if (!titleNames.includes(title[1])) titleNames.push(title[1]);
    }
    let majorInfo = false, basicInfo = false, foundInfoSection = false, pendingFullName = false;
    for (const page of doc.pageTexts || []) {
      // Never create an issuer alias from a scan, garbled text, unverified page,
      // or a raw whole-document string that lost its page provenance.
      if (!Number.isSafeInteger(page.page) || page.complete !== true || page.numericEligible !== true
        || !['provider-text', 'pdf-text'].includes(page.method) || typeof page.text !== 'string' || page.textHash !== hash(page.text)) {
        majorInfo = false; basicInfo = false; pendingFullName = false; continue;
      }
      for (const raw of page.text.split(/[\r\n]+/)) {
        const line = compact(raw); if (!line) continue;
        // Cover metadata explicitly binds the short name to this security code.
        const cover = /^(?:公司|证券|股票)代码:(\d{6})(?:公司|证券|股票)简称:([\u4e00-\u9fffA-Za-z0-9()·*]{2,30})$/.exec(line);
        if (page.page <= 3 && cover?.[1] === bundle.symbol.slice(2) && namedIssuer(cover[2])) names.add(cover[2]);
        if (!foundInfoSection && /^第[一二三四五六七八九十\d]+节(?:公司基本信息|公司基本情况|公司简介(?:和主要财务指标)?)$/.test(line)) {
          foundInfoSection = true; majorInfo = true; basicInfo = true; pendingFullName = false; continue;
        }
        if (/^第[一二三四五六七八九十\d]+节/.test(line)) { majorInfo = false; basicInfo = false; pendingFullName = false; continue; }
        if (majorInfo && /^(?:[一二三四五六七八九十\d]+[、.])?(?:公司信息|公司基本信息|公司基本情况)$/.test(line)) {
          basicInfo = true; pendingFullName = false; continue;
        }
        if (!basicInfo) continue;
        if (/^(?:第[一二三四五六七八九十\d]+节|[一二三四五六七八九十\d]+[、.])/.test(line)) { basicInfo = false; pendingFullName = false; continue; }
        if (pendingFullName) { if (LEGAL_NAME.test(line)) names.add(line); pendingFullName = false; }
        // Only a complete field line in the issuer's basic-information section
        // can introduce a legal name. Anchoring excludes 子公司名称/表格列头.
        const full = /^(?:公司的中文名称|公司中文名称|中文名称|公司全称|公司名称(?:\(中文\))?)(?::)?(.*)$/.exec(line);
        if (full) {
          if (!full[1]) pendingFullName = true;
          else if (LEGAL_NAME.test(full[1])) names.add(full[1]);
        }
        // Body short-name fields alone do not establish a new identity. The
        // title or code-bound cover above already preserves verified aliases.
      }
    }
  }
  return { names: [...names].sort((a, b) => b.length - a.length), titleNames };
}
function issuerNames(bundle) { return issuerIdentity(bundle).names; }
function issuerSearchName(bundle) {
  const identity = issuerIdentity(bundle);
  return identity.titleNames[0] || identity.names.find(name => LEGAL_NAME.test(name)) || identity.names[0] || null;
}
function rankNumber(value) {
  if (/^\d+$/.test(value)) return +value;
  const digits = '零一二三四五六七八九';
  if (value.length === 1) return digits.indexOf(value);
  const parts = value.split('十'); return parts.length === 2 ? (parts[0] ? digits.indexOf(parts[0]) : 1) * 10 + (parts[1] ? digits.indexOf(parts[1]) : 0) : null;
}
// Discovery results never enter this function: only a complete, hashed original
// fetched from a supported publisher and tied to the issuer can support a fact.
function collectIndependentRankings(bundle, { now = new Date(), symbol = bundle?.symbol, minimumYear = 0, existingRankings = [] } = {}) {
  const records = existingRankings.map(record => structuredClone(record));
  const at = +new Date(now); if (!Number.isFinite(at)) return records;
  const today = cnTime(new Date(at)).date, names = issuerNames(bundle), accepted = [];
  if (symbol !== bundle?.symbol || !names.length) return records;
  for (const document of bundle.industryDocuments || []) {
    if (document.issuerSymbol !== symbol || document.kind !== 'industry-report' || document.complete !== true
      || !hasCurrentIndustryPdfParsing(document)
      || !trustedIndustryUrl(document.url) || typeof document.text !== 'string' || !document.text.trim()
      || document.textHash !== hash(document.text) || !/^[a-f0-9]{64}$/.test(document.sourceHash || '')
      || document.rawSource !== undefined && hash(document.rawSource) !== document.sourceHash
      || !/^\d{4}-\d{2}-\d{2}$/.test(document.publishedAt || '') || !Number.isFinite(Date.parse(document.publishedAt))
      || new Date(document.publishedAt).toISOString().slice(0, 10) !== document.publishedAt || document.publishedAt > today
      || !Number.isFinite(document.fetchedAt) || document.fetchedAt <= 0 || document.fetchedAt > at || at - document.fetchedAt > 21600000) continue;
    const pages = document.pageTexts;
    if (!Array.isArray(pages) || pages.length !== document.pages || !pages.length
      || pages.some((page, index) => page.page !== index + 1 || page.complete !== true || page.numericEligible !== true
        || !['pdf-text', 'provider-text'].includes(page.method) || typeof page.text !== 'string')
      || compact(pages.map(page => page.text).join('\n\n')) !== compact(document.text)) continue;
    accepted.push(document);
    for (const page of pages) for (const quote of page.text.split(/[。；;\n]/)) {
      const text = compact(quote);
      if (/预计|有望|目标|计划|未核实|无法核实|不准确|不正确|表述有误|不是|未能|可能|假设|并非|不实|撤回|更正|母公司|控股股东|参股公司|合营|联营|集团排名|上市公司|上市企业|会员|参评|样本|规模以上|受访|重点企业/.test(text)) continue;
      const company = names.map(name => ({ name, at: text.indexOf(name) })).find(item => item.at >= 0);
      if (!company || /[\u4e00-\u9fffA-Za-z]/.test(text[company.at - 1] || '') && !/(?:年|,|，)$/.test(text.slice(0, company.at))) continue;
      const pattern = new RegExp(`^(?:(20\\d{2})年[,，]?)?${escape(company.name)}(?:在|的)?(?:(20\\d{2})年)?(?:在)?(全球|世界|全国|中国|国内)([^,，:：]{1,35}?)(?:市场|行业)?(?:的)?(市场份额|市场占有率|销量|销售量|销售额|营业收入)(?:排名|位居|位列|居)第([一二三四五六七八九十]+|\\d{1,3})(?=[,，。；;]|$)`);
      const match = pattern.exec(text); if (!match) continue;
      const statisticYear = +(match[1] || match[2]), rank = rankNumber(match[6]), market = match[4];
      if (!statisticYear || statisticYear < minimumYear || statisticYear > +document.publishedAt.slice(0, 4) || !rank || /公司|集团|排名|第|报告/.test(market)) continue;
      const limited = /(?:统计|调查|研究|样本|排名)(?:范围)?(?:仅|只|局限)|上市公司|上市企业|会员|参评|样本企业|规模以上|受访|重点企业/.test(compact(document.text));
      const coverage = !limited && /(?:统计|调查|研究)(?:范围)?覆盖(?:全部|所有)(?:竞争者|竞争企业|市场参与者)|(?:全行业|全部市场参与者)(?:统计|排名)/.test(text) ? 'allCompetitors' : 'unverified';
      records.push({ id: `${document.id}#ranking:${page.page}:${hash(quote).slice(0, 16)}`, symbol, kind: 'ranking', subject: market, value: 'ranked',
        market, geography: /全球|世界/.test(match[3]) ? '全球' : '中国', metric: /份额|占有率/.test(match[5]) ? 'marketShare' : /销量|销售量/.test(match[5]) ? 'volume' : 'sales',
        rank, statisticYear, coverage, coverageBasis: coverage === 'allCompetitors' ? '第三方原文明示全行业统计范围' : '第三方原文未明确全行业统计分母',
        sourceRelation: 'independent-third-party', sourceDocumentId: document.id, sourceTitle: document.title, url: document.url,
        source: SOURCES[new URL(document.url).hostname], quote: quote.trim(), sourceHash: document.sourceHash, publishedAt: document.publishedAt,
        period: String(statisticYear), checkedAt: new Date(at).toISOString(), mode: 'automatic', reviewState: 'automatic', ruleVersion: '5',
        locations: [{ page: page.page, method: page.method, numericEligible: true, textHash: hash(page.text) }] });
    }
  }
  for (const record of records) {
    const conflicts = accepted.filter(document => document.publishedAt >= record.publishedAt).flatMap(document => document.pageTexts.flatMap(page => page.text.split(/[。；;\n]/)
      .filter(quote => names.some(name => compact(quote).includes(name)) && compact(quote).includes(record.market)
        && /排名|位居|位列/.test(quote) && /撤回|不实|无法核实|不准确|不正确|表述有误|不能确认|范围有误/.test(quote))
      .map(quote => ({ id: `${document.id}#rankingConflict:${page.page}:${hash(quote).slice(0, 12)}`, symbol, kind: 'rankingConflict', subject: record.market, value: 'disputed',
        sourceDocumentId: document.id, sourceTitle: document.title, sourceRelation: 'independent-third-party', url: document.url, sourceHash: document.sourceHash,
        publishedAt: document.publishedAt, quote, locations: [{ page: page.page, method: page.method, numericEligible: true }] }))));
    if (conflicts.length) { record.automaticConflict = true; record.conflictRecords = conflicts; }
  }
  return records;
}
module.exports = { collectIndependentRankings, trustedIndustryUrl, issuerNames, issuerSearchName, hasCurrentIndustryPdfParsing };
