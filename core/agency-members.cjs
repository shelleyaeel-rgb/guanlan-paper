'use strict';
const { symbolOf } = require('./common.cjs');
const { createEntryConditions } = require('./entry-conditions.cjs');

// The screener accepts a complete market catalogue of at most 15,000 rows.
const MAX_BATCH_AGENCY_MEMBERS = 15000;

function memberContext(engine, strategyId) {
  const group = engine.s.agency.groups.find(item => item.id === strategyId);
  if (!group) throw Error('自动交易策略不存在');
  const owners = new Map();
  for (const owner of engine.s.agency.groups) for (const member of owner.members) owners.set(member.symbol, { group: owner, member });
  return { group, owners, positions: new Set(engine.s.lots.map(lot => lot.symbol)),
    orders: new Set(engine.s.orders.filter(order => order.status === 'pending').map(order => order.symbol)) };
}

function unavailable(context, symbol) {
  const owner = context.owners.get(symbol);
  if (owner) return { symbol, code: owner.group.id === context.group.id ? 'already-member' : 'other-strategy',
    reason: owner.group.id === context.group.id
      ? `已在${owner.group.name}自动交易组${owner.member.mode === 'active' ? '' : '，保留原退出安排'}`
      : `已由${owner.group.name}自动交易组管理，不能重复归属` };
  if (context.positions.has(symbol)) return { symbol, code: 'manual-position', reason: '已有手动持仓，策略不能自动接管' };
  if (context.orders.has(symbol)) return { symbol, code: 'manual-order', reason: '该股票有待执行手动委托，请先处理' };
  return null;
}

function normalizeSymbols(symbols) {
  if (!Array.isArray(symbols) || !symbols.length || symbols.length > MAX_BATCH_AGENCY_MEMBERS) throw Error(`请选择 1 至 ${MAX_BATCH_AGENCY_MEMBERS} 只股票批量加入`);
  const entries = [], seen = new Set();
  for (const value of symbols) {
    let symbol, error;
    const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim().toLowerCase() : JSON.stringify(value) ?? '';
    try {
      if (!['string', 'number'].includes(typeof value)) throw Error('股票代码格式无效，请使用沪深 A 股六位代码');
      symbol = symbolOf(value);
    } catch (caught) { symbol = raw; error = caught.message; }
    const key = `${error ? 'invalid' : 'valid'}:${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key); entries.push({ symbol, ...(error ? { error } : {}) });
  }
  return entries;
}

// Refresh data outside the account transaction; apply the entire accepted batch
// through one persisted transaction after rechecking current ownership.
async function addAgencyMembers(input, { getEngine, transaction, market, acceptQuotes = () => {} }) {
  const strategyId = input?.strategyId, entries = normalizeSymbols(input?.symbols);
  const initial = getEngine(), epoch = initial.s.agency.epoch, context = memberContext(initial, strategyId);
  // Freeze the input before awaiting quotes. Caller edits cannot alter this batch.
  const entryConditions = createEntryConditions(input?.entryConditions, initial.clock());
  const result = { strategyId, total: entries.length, added: [], skipped: [], failed: [] }, candidates = [];
  for (const entry of entries) {
    if (entry.error) { result.failed.push({ symbol: entry.symbol, code: 'invalid-symbol', reason: entry.error }); continue; }
    const blocked = unavailable(context, entry.symbol);
    if (blocked) { result.skipped.push(blocked); continue; }
    candidates.push(entry.symbol);
  }
  if (!candidates.length) return result;

  let fresh;
  try { fresh = await market.quotes(candidates); }
  catch (error) {
    result.failed.push(...candidates.map(symbol => ({ symbol, code: 'quote-unavailable', reason: `行情获取失败，未加入：${error.message || '请稍后重试'}` })));
    return result;
  }
  if (getEngine().s.agency.epoch !== epoch) throw Error('账户已重置，本次未加入，请重新选择股票');
  acceptQuotes(fresh);
  const quoted = candidates.filter(symbol => {
    if (fresh[symbol]) return true;
    result.failed.push({ symbol, code: 'quote-unavailable', reason: '没有找到该股票的有效行情，未加入' }); return false;
  });
  if (!quoted.length) return result;

  transaction(() => {
    const engine = getEngine();
    if (engine.s.agency.epoch !== epoch) throw Error('账户已重置，本次未加入，请重新选择股票');
    const current = memberContext(engine, strategyId);
    for (const symbol of quoted) {
      const blocked = unavailable(current, symbol);
      if (blocked) { result.skipped.push(blocked); continue; }
      const member = engine.agencyMember({ strategyId, symbol, action: 'add', entryConditions });
      // Keep the original quote time so restart can display names/prices without
      // presenting this saved mark as fresh execution data.
      engine.s.marks[symbol] = structuredClone(fresh[symbol]);
      current.owners.set(symbol, { group: current.group, member }); result.added.push(symbol);
    }
  });
  return result;
}

module.exports = { addAgencyMembers, MAX_BATCH_AGENCY_MEMBERS };
