'use strict';

// The bridge carries JSON strings and small change envelopes. Decode here so
// Electron does not clone the full account graph across the context bridge.
(function (root) {
  const FORMAT = 'guanlan-view-v1', forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  function fail(message) { throw new Error(`Invalid view stream: ${message}`); }
  function parse(json) { if (typeof json !== 'string') fail('missing JSON'); return JSON.parse(json); }
  function validatePath(path) {
    if (!Array.isArray(path) || !path.length || path.length > 64) fail('invalid path');
    for (const key of path) {
      if (typeof key === 'number' ? !integer(key) || key >= 4294967295
        : typeof key !== 'string' || !key || forbidden.has(key)) fail('invalid path key');
    }
  }
  function updateAt(node, path, offset, value, remove) {
    const key = path[offset], final = offset === path.length - 1;
    if (remove && (node == null || typeof node !== 'object' || !Object.hasOwn(node, key))) return node;
    const source = node !== null && typeof node === 'object' ? node : typeof key === 'number' || key === 'length' ? [] : {};
    if (Array.isArray(source)) {
      if (key === 'length') {
        if (!final || remove || !integer(value) || value > 4294967295) fail('invalid array length');
      } else if (typeof key !== 'number') fail('invalid array index');
    } else if (typeof key !== 'string') fail('invalid object key');
    const copy = Array.isArray(source) ? source.slice() : { ...source };
    if (final) { if (remove) delete copy[key]; else copy[key] = value; }
    else copy[key] = updateAt(Object.hasOwn(source, key) ? source[key] : undefined, path, offset + 1, value, remove);
    return copy;
  }
  function applyEnvelope(currentSnapshot, currentRevision, envelope) {
    if (!record(envelope) || envelope.format !== FORMAT || !integer(envelope.revision) || !envelope.revision) fail('invalid envelope');
    if (envelope.revision <= currentRevision) return { snapshot: currentSnapshot, revision: currentRevision, applied: false };
    let snapshot;
    if (envelope.kind === 'full') {
      snapshot = parse(envelope.json);
      if (!record(snapshot)) fail('invalid full snapshot');
    } else if (envelope.kind === 'patch') {
      if (!record(currentSnapshot) || envelope.baseRevision !== currentRevision || !integer(envelope.baseRevision)
        || envelope.revision !== envelope.baseRevision + 1) fail('missing patch baseline');
      if (!Array.isArray(envelope.changes) || envelope.decisions !== undefined && !Array.isArray(envelope.decisions)) fail('invalid changes');
      snapshot = currentSnapshot;
      for (const change of envelope.changes) {
        if (!record(change) || change.remove !== undefined && change.remove !== true || change.remove && change.json !== undefined) fail('invalid change');
        validatePath(change.path);
        snapshot = updateAt(snapshot, change.path, 0, change.remove ? undefined : parse(change.json), change.remove === true);
      }
      for (const operation of envelope.decisions || []) {
        const history = snapshot.agency?.decisions;
        if (!record(operation) || !Array.isArray(history) || !integer(operation.start) || operation.start > history.length
          || !integer(operation.deleteCount) || operation.deleteCount > history.length - operation.start) fail('invalid decision splice');
        const added = parse(operation.json); if (!Array.isArray(added)) fail('invalid decision records');
        // Do not mutate the active snapshot if a later operation is malformed.
        const next = history.slice(); next.splice(operation.start, operation.deleteCount, ...added);
        snapshot = { ...snapshot, agency: { ...snapshot.agency, decisions: next } };
      }
    } else fail('unknown envelope kind');
    return { snapshot, revision: envelope.revision, applied: true };
  }
  const receiver = { applyEnvelope };
  if (typeof module === 'object' && module.exports) module.exports = receiver;
  else root.GuanlanViewReceiver = receiver;
})(typeof globalThis === 'object' ? globalThis : this);
