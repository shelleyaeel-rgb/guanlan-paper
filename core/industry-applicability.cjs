'use strict';

const INDUSTRY_PROFILE_MAX_AGE_MS = 86400000;
const clean = value => typeof value === 'string' && value.trim() && !['-', '--'].includes(value.trim()) ? value.trim() : null;
const firstLevel = value => (clean(value) || '').split(/[-—>／/]/)[0].trim();
const REGULATORY_ORDINARY = new Set(['农、林、牧、渔业', '采矿业', '制造业', '电力、热力、燃气及水生产和供应业', '建筑业',
  '批发和零售业', '交通运输、仓储和邮政业', '住宿和餐饮业', '信息传输、软件和信息技术服务业', '房地产业',
  '租赁和商务服务业', '科学研究和技术服务业', '水利、环境和公共设施管理业', '居民服务、修理和其他服务业',
  '教育', '卫生和社会工作', '文化、体育和娱乐业', '公共管理、社会保障和社会组织', '综合']);
const PROVIDER_ORDINARY = new Set(['农林牧渔', '煤炭', '石油石化', '石油化工', '基础化工', '化工', '钢铁', '有色金属',
  '电子', '汽车', '家电', '家用电器', '食品饮料', '纺织服饰', '纺织服装', '轻工制造', '医药', '医药生物',
  '公用事业', '交通运输', '房地产', '商贸零售', '商贸', '社会服务', '美容护理', '建筑材料', '建筑装饰',
  '建筑', '建材', '电力设备', '电气设备', '机械设备', '国防军工', '计算机', '传媒', '通信', '环保', '综合']);
const TYPE_SECTORS = { 银行: 'bank', 保险: 'insurance', 证券: 'securities' };
const TYPE_CODES = { '1': 'securities', '2': 'insurance', '3': 'bank' };
const SECTOR_LABELS = { bank: '银行', insurance: '保险', securities: '证券', 'other-financial': '其他金融' };

function industrySector(value, regulatory) {
  const root = firstLevel(value);
  if (!root) return null;
  if (['金融', '金融业', '金融服务业', '银行', '银行业', '非银金融', '非银行金融', '保险', '保险业', '证券', '证券业', '货币金融服务', '资本市场服务', '其他金融业'].includes(root)) {
    const parts = (clean(value) || '').split(/[-—>／/]/).map(part => part.trim());
    if (parts.some(part => ['银行', '银行业', '货币金融服务'].includes(part))) return 'bank';
    if (parts.some(part => ['保险', '保险业'].includes(part))) return 'insurance';
    if (parts.some(part => ['证券', '证券业', '资本市场服务'].includes(part))) return 'securities';
    return 'other-financial';
  }
  return (regulatory ? REGULATORY_ORDINARY : PROVIDER_ORDINARY).has(root) ? 'ordinary' : null;
}

// Classification is a template scope check, not a financial quality score.
// Provider report type "通用" alone does not establish a non-financial industry.
function classifyFinanceApplicability(profile, symbol, now = new Date()) {
  const at = new Date(now).getTime(), data = profile?.data;
  const result = { version: 1, template: 'ordinary-non-financial', status: 'pending', sector: 'unknown',
    reasonCode: null, reason: '', industry: clean(data?.industry), regulatoryIndustry: clean(data?.regulatoryIndustry),
    orgType: clean(data?.orgType), orgTypeCode: clean(data?.orgTypeCode), source: clean(profile?.source),
    fetchedAt: Number.isFinite(profile?.fetchedAt) ? profile.fetchedAt : null, checkedAt: Number.isFinite(at) ? at : null };
  const pending = (reasonCode, reason) => ({ ...result, reasonCode, reason });
  if (!profile) return pending('industry-not-loaded', '行业分类尚未获取，等待公司资料；不能默认适用普通非金融企业模板');
  if (!Number.isFinite(at) || profile.symbol !== symbol || profile.section !== 'profile' || profile.source !== '东方财富')
    return pending('industry-invalid', '行业资料的股票、模块、来源或核验时间无法验证');
  if (profile.error || ['stale', 'unavailable'].includes(profile.status)) return pending('industry-fetch-failed', '行业资料获取失败或刷新失败，等待重新获取');
  if (profile.status === 'empty') return pending('industry-missing', '公司资料未返回行业分类，不能默认适用普通非金融企业模板');
  if (profile.status !== 'ready' || !data || typeof data !== 'object' || Array.isArray(data)) return pending('industry-invalid', '行业资料状态或格式无法验证');
  if (!Number.isFinite(profile.fetchedAt) || profile.fetchedAt <= 0 || profile.fetchedAt > at) return pending('industry-invalid', '行业资料获取时间无效或晚于核验时点');
  if (at - profile.fetchedAt > INDUSTRY_PROFILE_MAX_AGE_MS) return pending('industry-stale', '行业资料获取时间超过 24 小时，等待刷新');
  const namedType = Object.hasOwn(TYPE_SECTORS, result.orgType) ? TYPE_SECTORS[result.orgType] : null;
  const codedType = Object.hasOwn(TYPE_CODES, result.orgTypeCode) ? TYPE_CODES[result.orgTypeCode] : null;
  if (namedType && result.orgTypeCode && (result.orgTypeCode === '4' || codedType && codedType !== namedType)
    || result.orgType === '通用' && codedType) return pending('industry-conflict', '公司资料的机构类型与类型代码冲突，等待核对');
  const sectors = [industrySector(result.industry, false), industrySector(result.regulatoryIndustry, true), namedType || codedType].filter(Boolean);
  const financial = sectors.filter(sector => sector !== 'ordinary'), specific = [...new Set(financial.filter(sector => sector !== 'other-financial'))];
  if (sectors.includes('ordinary') && financial.length || specific.length > 1) return pending('industry-conflict', '公司资料中的行业分类相互冲突，不能自动选择财务模板');
  if (financial.length) {
    const sector = specific[0] || 'other-financial';
    return { ...result, status: 'inapplicable', sector, reasonCode: 'template-inapplicable',
      reason: `已识别为${SECTOR_LABELS[sector]}企业，当前普通非金融企业财务模板不适用；尚未提供该行业专用模板，此结论不表示公司财务不合格` };
  }
  if (sectors.includes('ordinary')) return { ...result, status: 'applicable', sector: 'ordinary', reasonCode: 'template-applicable', reason: '已识别为普通非金融企业，可按当前模板继续核验财务指标；行业分类本身不代表财务达标' };
  return pending(result.industry || result.regulatoryIndustry ? 'industry-unrecognized' : 'industry-missing', '行业分类缺失或尚不能可靠识别，等待核对；不以公司名称或主营描述猜测模板适用性');
}

module.exports = { classifyFinanceApplicability, INDUSTRY_PROFILE_MAX_AGE_MS };
