'use strict';

// Activation is explicit at the application boundary; old accounts and research
// fixtures can still be read without manufacturing historical market evidence.
function enableMarketPolicy(state) {
  if (!state.agency) throw Error('自动交易账户尚未初始化');
  state.version = 2;
  if (state.agency.marketPolicy?.enabled === true && state.agency.marketPolicy.version === 1) return false;
  state.agency.marketPolicy = { version: 1, enabled: true };
  state.agency.revision++;
  return true;
}

// Share only unmodified provider snapshots. Cache age never becomes quote age.
function cachedBreadthLoader(source, clock = Date.now) {
  let cached = null, pending = null;
  const loadSource = options => typeof source.loadBreadth === 'function' ? source.loadBreadth(options) : source.load(options);
  return async (options = {}) => {
    options.signal?.throwIfAborted();
    // Periodic polls should obtain current quotes; force bypasses a completed
    // cache, while concurrent callers still join the same acquisition.
    if (!options.force && cached && clock() >= cached.fetchedAt && clock() - cached.fetchedAt < 30000) return cached;
    if (!pending) pending = loadSource(options).then(value => { cached = value; return value; }).finally(() => { pending = null; });
    return pending;
  };
}
module.exports = { enableMarketPolicy, cachedBreadthLoader };
