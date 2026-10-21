'use strict';

// A forced caller cannot inherit a request that started before it arrived.
// Callers waiting behind that same request share one successor; once that
// successor starts, a later forced caller must wait for another fresh request.
function afterPending(pending, next, key, start) {
  if (next.has(key)) return next.get(key);
  const active = pending.get(key);
  if (!active) return start();
  const queued = Promise.resolve(active).catch(() => {}).then(() => {
    next.delete(key);
    return start();
  });
  next.set(key, queued);
  return queued;
}

module.exports = { afterPending };
