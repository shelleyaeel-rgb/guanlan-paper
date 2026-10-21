'use strict';

const MAX_ADDITION_CENTS = 10000000000;
const MAX_CUMULATIVE_CENTS = 100000000000;
const identifier = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128;
const cents = value => Number.isSafeInteger(value);

function validCapitalFlows(state) {
  const flows = state.capitalFlows === undefined ? [] : state.capitalFlows;
  if (!Array.isArray(flows) || (state.version === 1 && flows.length > 0)) return false;
  const ids = new Set(), requests = new Set(), fundingStages = new Set([0]);
  let total = 0, lastTime = -Infinity;
  for (const flow of flows) {
    if (!flow || !identifier(flow.id) || !identifier(flow.requestId) || ids.has(flow.id) || requests.has(flow.requestId)
      || !cents(flow.amount) || flow.amount <= 0 || flow.amount > MAX_ADDITION_CENTS
      || typeof flow.time !== 'string' || !Number.isFinite(Date.parse(flow.time)) || Date.parse(flow.time) < lastTime
      || !cents(flow.equityBefore) || flow.equityBefore <= 0 || !cents(flow.equityAfter)
      || flow.equityAfter !== flow.equityBefore + flow.amount) return false;
    total += flow.amount;
    if (!cents(state.initialCash + total) || state.initialCash + total > MAX_CUMULATIVE_CENTS) return false;
    ids.add(flow.id); requests.add(flow.requestId); fundingStages.add(total); lastTime = Date.parse(flow.time);
  }
  let priorFunding = 0;
  for (const point of state.equity) {
    if (!point || typeof point !== 'object') return false;
    const funding = point.netContributions ?? 0;
    if (!fundingStages.has(funding) || funding < priorFunding) return false;
    priorFunding = funding;
  }
  return true;
}

// Each funding event issues units at the immediately preceding portfolio NAV.
// Observation funding markers preserve execution order even when a fill and a
// cash addition share a millisecond. Legacy observations all precede first funding.
function capitalPerformance(initialCash, observations, flows = [], currentEquity = initialCash) {
  const stages = [{ contributions: 0, units: initialCash, points: [] }];
  let units = initialCash, contributions = 0;
  for (const flow of flows) {
    const nav = flow.equityBefore / units;
    units += flow.amount / nav;
    contributions += flow.amount;
    stages.push({ contributions, units, points: [], flow });
  }
  const byFunding = new Map(stages.map(stage => [stage.contributions, stage]));
  for (const point of observations) {
    const stage = byFunding.get(point.netContributions ?? 0);
    if (stage && Number.isFinite(point.value)) stage.points.push(point);
  }
  let peak = 1, drawdown = 0;
  const observe = nav => {
    peak = Math.max(peak, nav);
    drawdown = Math.max(drawdown, (peak - nav) / peak);
  };
  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index];
    for (const point of stage.points) observe(point.value / stage.units);
    const next = stages[index + 1];
    if (next) {
      observe(next.flow.equityBefore / stage.units);
      observe(next.flow.equityAfter / next.units);
    }
  }
  const unitValue = currentEquity / units;
  observe(unitValue);
  return { netContributions: contributions, cumulativeCapital: initialCash + contributions,
    pnl: currentEquity - initialCash - contributions, unitValue, returnPct: unitValue - 1, drawdown };
}

module.exports = { validCapitalFlows, capitalPerformance, MAX_ADDITION_CENTS, MAX_CUMULATIVE_CENTS, identifier };
