'use strict';
const { Engine, initialState, validState } = require('../../core/engine.cjs');
const { poolPolicy } = require('../../core/agency-screening.cjs');

// Synthetic data only. No Store, network, running strategy or account writes.
function createPerformanceAccount() {
  const now = new Date('2026-10-16T10:00:00+08:00').toISOString(), engine = new Engine(initialState(), () => new Date(now));
  const groups = engine.s.agency.groups;
  for (let i = 0; i < 600; i++) {
    const symbol = `sh${600100 + i}`, group = groups[i % groups.length];
    engine.agencyMember({ strategyId: group.id, symbol, action: 'add',
      ...(i % 13 === 0 ? { entryConditions: { rules: [{ field: 'price', op: 'gte', value: 5 }], excludeST: true } } : {}) });
    const member = group.members.at(-1);
    member.monitoringCheck = { status: i % 3 ? 'conditions' : 'data', reason: '隔离样本：等待下一次规则复核', checkedAt: now };
    engine.s.marks[symbol] = { symbol, name: `性能样本 ${i}`, price: 10.12, changePct: 1.2, timestamp: Date.parse(now), date: '2026-10-16', time: '10:00:00', source: '隔离性能样本' };
  }
  for (let i = 0; i < 500; i++) {
    const group = groups[i % groups.length], member = group.members[Math.floor(i / groups.length)];
    const sourceId = `history-${i}`;
    const evaluation = { status: 'pending', checkedAt: now, checks: [{ key: 'productOutlook', label: '产品前景', status: 'pending', reason: '隔离样本资料待核验',
      records: [{ sourceTitle: '隔离产品披露', publishedAt: '2026-08-30', quote: '合成产品披露摘录 <应保持转义>', locations: [{ page: 3, method: 'pdf-text' }] }] }],
      noticeReview: { status: 'unverified', checkedAt: now, reasons: ['合成公告事实待核验'], notices: [] } };
    const inputSources = [{ id: sourceId, kind: 'completed-unadjusted-daily', source: '合成日线', fetchedAt: now, data: { asOf: '2026-10-15',
      bars: Array.from({ length: 180 }, (_, index) => ({ date: `history-${index}`, open: 10.1, close: 10.12, high: 10.3, low: 9.8, volume: 1234567, amount: 12345678 })) } },
    { id: `finance-${i}`, kind: 'finance', source: '合成财报', fetchedAt: now, data: { latest: { reportDate: '2026-06-30', revenue: 12345678 }, annual: [{ year: 2025, revenue: 45678901 }] } },
    { id: `evidence-${i}`, kind: 'automaticEvidence', source: '合成原文', fetchedAt: now, data: { evaluation, documents: [{ text: '仅供性能测量的原始披露内容。'.repeat(150) }] } }];
    const basis = { inputSources, evidence: [{ sourceId, detail: '采用完整未复权日线' }, { sourceId: `finance-${i}`, detail: '采用最近披露财报' }],
      ...(member.entryConditions ? { entryConditionsCheck: { conditions: member.entryConditions, status: 'pending', passed: false, checkedAt: now, reasons: ['合成个人条件等待复核'] } } : {}),
      financeCheck: { status: 'pending', source: '合成财报', fetchedAt: now, reportDate: '2026-06-30', reasons: ['财报项目待核验'], checks: [] } };
    engine.agencyLog({ id: `perf-${i}`, strategyId: group.id, symbol: member.symbol, decisionSource: 'rules', rulesVersion: '1', status: 'waiting', action: 'wait', reason: '隔离性能测量：等待买点', time: now,
      ...(i % 3 === 0 ? { ...basis, executionCheck: { ...structuredClone(basis), checkedAt: now } } : basis) });
  }
  const policy = poolPolicy(), rows = groups.flatMap(group => group.members.map(member => ({ symbol: member.symbol, name: engine.s.marks[member.symbol].name,
    strategyId: group.id, reasons: ['合成候选保留监控'], status: 'pass' })));
  const lastResult = { id: 'synthetic-performance-pool', policyVersion: policy.version, screeningMode: policy.screeningMode, startedAt: now, finishedAt: now,
    added: rows, retained: [], removed: [], pending: [], held: [], skipped: [], unassignedPending: [],
    counts: { added: rows.length, retained: 0, removed: 0, pending: 0, held: 0, skipped: 0, unassignedPending: 0 },
    strategies: Object.fromEntries(groups.map(group => [group.id, { pass: group.members.length, failed: 0, pending: 0 }])),
    coverage: { researchRequired: false, universeCount: 600, universeComplete: true }, sources: { quotes: { source: '隔离合成数据' } } };
  engine.s.agency.pool = { policy, lastResult };
  for (const group of groups) engine.s.agency.corporateChecks[group.members[0].symbol] = { status: 'blocked', reason: '合成核验异常', checkedAt: now, strategyIds: [group.id], affectsEquity: false };
  if (!validState(engine.s)) throw Error('Synthetic performance account is invalid');
  return engine.s;
}
module.exports = { createPerformanceAccount };
