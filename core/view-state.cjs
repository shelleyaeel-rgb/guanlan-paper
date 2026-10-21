'use strict';

// The renderer shows source labels, dates and interpreted evidence. Raw source
// payloads stay in the account and the full state API for audit/export; sending
// them on every quote update duplicates megabytes of unused historical data.
function sourceView(source) {
  if (!source || typeof source !== 'object') return source;
  const { data, ...metadata } = source;
  if (!data || typeof data !== 'object') return { ...metadata, data };
  return { ...metadata, data: {
    ...(data.asOf !== undefined ? { asOf: data.asOf } : {}),
    ...(data.latest?.reportDate !== undefined ? { latest: { reportDate: data.latest.reportDate } } : {}),
    ...(data.evaluation !== undefined ? { evaluation: data.evaluation } : {})
  } };
}
function decisionView(decision) {
  return { ...decision,
    ...(Array.isArray(decision.inputSources) ? { inputSources: decision.inputSources.map(sourceView) } : {}),
    ...(decision.executionCheck ? { executionCheck: { ...decision.executionCheck,
      ...(Array.isArray(decision.executionCheck.inputSources) ? { inputSources: decision.executionCheck.inputSources.map(sourceView) } : {})
    } } : {})
  };
}
function accountView(account) {
  const { decisions, groups, pool, corporateChecks, corporateActions, corporateEvents, executionIntents, transfers, ...metadata } = account.agency;
  // These records are already supplied in the top-level agency/agencyPool views.
  // This is a presentation payload, never an account persistence format.
  return { ...account, agency: metadata };
}
module.exports = { decisionView, accountView };
