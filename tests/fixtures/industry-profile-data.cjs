// Synthetic scope evidence only; never a statement about the real ticker.
function ordinaryProfile(symbol, now) {
  return { symbol, section: 'profile', source: '东方财富', status: 'ready', fetchedAt: +new Date(now),
    data: { industry: '食品饮料-食品加工', regulatoryIndustry: '制造业-食品制造业', orgType: '通用', orgTypeCode: '4' } };
}
module.exports = { ordinaryProfile };
