'use strict';

const FORMAT = 'guanlan-view-v1';
// Keep serialized baselines: account objects can change in place between sends.
// Only the display transport is diffed; these patches never write account data.
function sections(snapshot) {
  const result = new Map();
  const put = (path, value, arrayLength = false) => {
    const json = JSON.stringify(value);
    if (json !== undefined) result.set(JSON.stringify(path), { path, json, arrayLength });
  };
  const fields = (path, value, nested = {}) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { put(path, value); return; }
    // Preserve empty objects and type changes even when there are no children.
    // Stable markers are not resent, so ordinary changes retain prior siblings.
    put(path, {});
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(nested, key)) nested[key]([...path, key], item);
      else put([...path, key], item);
    }
  };
  const rows = (path, value, each = put) => {
    if (!Array.isArray(value)) { put(path, value); return; }
    put(path, []);
    for (const [index, item] of value.entries()) each([...path, index], item === undefined ? null : item);
    put([...path, 'length'], value.length, true);
  };
  for (const [key, value] of Object.entries(snapshot)) {
    const path = [key];
    if (key === 'account' || key === 'agencyPool') fields(path, value);
    else if (key === 'agency') fields(path, value, {
      groups: (path, groups) => rows(path, groups, (path, group) => fields(path, group, { members: rows })),
      decisions: (path, entries) => put(path, Array.isArray(entries) ? [] : entries),
      corporateChecks: fields
    });
    else put(path, value);
  }
  return result;
}
function decisions(snapshot) {
  return Array.isArray(snapshot.agency?.decisions)
    ? Array.from(snapshot.agency.decisions, entry => ({ id: entry?.id, json: JSON.stringify(entry) ?? 'null' })) : [];
}
function historyChanges(previous, current) {
  if (!previous.length && !current.length) return [];
  const first = current.length ? previous.findIndex(entry => entry.id != null && entry.id === current[0].id) : previous.length;
  const offset = first < 0 ? previous.length : first;
  const overlap = Math.min(previous.length - offset, current.length);
  const reusable = (first >= 0 || !previous.length) && overlap === previous.length - offset
    && current.slice(0, overlap).every((entry, index) => entry.json === previous[offset + index].json);
  if (!reusable) return [{ start: 0, deleteCount: previous.length, json: `[${current.map(entry => entry.json).join(',')}]` }];
  const changes = [];
  if (offset) changes.push({ start: 0, deleteCount: offset, json: '[]' });
  if (current.length > overlap) changes.push({ start: overlap, deleteCount: 0, json: `[${current.slice(overlap).map(entry => entry.json).join(',')}]` });
  return changes;
}
class ViewStream {
  constructor() { this.revision = 0; this.previous = null; this.history = []; }
  reset(snapshot) {
    this.previous = sections(snapshot); this.history = decisions(snapshot);
    return { format: FORMAT, kind: 'full', revision: ++this.revision, json: JSON.stringify(snapshot) };
  }
  next(snapshot) {
    if (!this.previous) return this.reset(snapshot);
    const next = sections(snapshot), changes = [];
    // Remove old parents before setting children of a newly expanded object.
    for (const [key, item] of this.previous) if (!next.has(key) && !item.arrayLength) changes.push({ path: item.path, remove: true });
    for (const [key, item] of next) if (this.previous.get(key)?.json !== item.json) changes.push({ path: item.path, json: item.json });
    const history = decisions(snapshot), splice = Array.isArray(snapshot.agency?.decisions) ? historyChanges(this.history, history) : [];
    const baseRevision = this.revision;
    this.previous = next; this.history = history;
    return { format: FORMAT, kind: 'patch', baseRevision, revision: ++this.revision, changes,
      ...(splice.length ? { decisions: splice } : {}) };
  }
}
module.exports = { ViewStream };
