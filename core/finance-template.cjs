'use strict';
const { classifyFinanceApplicability } = require('./industry-applicability.cjs');

// Applicability is a property of this template, never a rating of the issuer.
function financeTemplateCheck(row, now) {
  const applicability = classifyFinanceApplicability(row?.financeSourceSnapshot?.industryProfile, row?.symbol, now);
  return { status: applicability.status === 'applicable' ? 'pass' : applicability.status === 'inapplicable' ? 'failed' : 'pending',
    stage: 'finance-applicability', applicability, reasonCode: applicability.reasonCode,
    reasons: applicability.status === 'applicable' ? [] : [applicability.reason] };
}

module.exports = { financeTemplateCheck };
