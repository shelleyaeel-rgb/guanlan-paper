// Scheduling deliberately has no execution authority. The caller must revalidate
// account revision, strategy/member state, fresh data and all trade constraints in commit.
const { AgencyRulesError, RULES_INTERVAL_MS } = require('./agency-rules.cjs');
class AgencyRunner {
  constructor({ clock = Date.now, getGroups, getCandidates, evaluateRules, commit, onComplete = () => {}, log = () => {}, maxConcurrency = 2 } = {}) {
    for (const [name, value] of Object.entries({ getGroups, getCandidates, evaluateRules, commit })) if (typeof value !== 'function') throw Error(`代理调度缺少 ${name}`);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 2) throw Error('规则检查并发数应为 1 至 2');
    Object.assign(this, { clock, getGroups, getCandidates, evaluateRules, commit, onComplete, log, maxConcurrency });
    Object.defineProperty(this, 'intervalMs', { value: RULES_INTERVAL_MS, enumerable: true });
    this.active = new Map(); this.lastStarted = new Map(); this.lastCompleted = new Map(); this.lastScheduled = new Map(); this.scheduleSequence = 0; this.generation = 0; this.stopped = false; this.logs = []; this.lastError = '';
  }
  // Explicit kicks only: the main process owns the timer and runs hard exits separately.
  async poll({ force = false, groupIds } = {}) {
    if (this.stopped) return { started: 0, active: this.active.size };
    const groups = await this.getGroups(), now = Number(this.clock()); let started = 0;
    if (!Array.isArray(groups)) throw Error('代理策略快照无效');
    if (this.stopped) return { started: 0, active: this.active.size };
    // A continuing large group must yield scheduling slots to other groups.
    for (const group of [...groups].sort((a, b) => (this.lastScheduled.get(a.id) || 0) - (this.lastScheduled.get(b.id) || 0))) {
      if (this.active.size >= this.maxConcurrency) break;
      if (!group?.enabled || !validToken(group.token) || typeof group.id !== 'string' || (groupIds && !groupIds.includes(group.id)) || this.active.has(group.id)) continue;
      const previous = Math.max(this.lastStarted.get(group.id) ?? -Infinity, this.lastCompleted.get(group.id) ?? -Infinity);
      if (!force && !group.continueCycle && now - previous < this.intervalMs) continue;
      this.lastStarted.set(group.id, now);
      this.lastScheduled.set(group.id, ++this.scheduleSequence);
      // Set the active entry before executing any callback (including synchronous callbacks).
      const generation = this.generation;
      const task = Promise.resolve().then(() => this._run({ ...group, forceRefresh: force }, generation)).finally(() => this.active.delete(group.id));
      this.active.set(group.id, task); started++;
    }
    return { started, active: this.active.size };
  }
  async _current(group, generation) {
    if (this.stopped || generation !== this.generation) return false;
    const groups = await this.getGroups();
    return !this.stopped && generation === this.generation && groups.some(item => item.id === group.id && item.enabled && item.token === group.token);
  }
  async _run(group, generation) {
    try {
      if (!(await this._current(group, generation))) return this._log(group, 'stale', '策略或账户已变化，忽略旧检查结果');
      const snapshot = await this.getCandidates(group);
      if (!(await this._current(group, generation)) || !snapshot || snapshot.token !== group.token) return this._log(group, 'stale', '策略或账户已变化，忽略旧检查结果');
      if (!Array.isArray(snapshot.candidates) || !snapshot.candidates.length) {
        await this.onComplete(group, snapshot, { token: group.token, completed: true });
        this.lastCompleted.set(group.id, Number(this.clock()));
        return this._log(group, 'idle', '本批无可提交的股票；缺失资料及规则拦截请查看记录');
      }
      this._log(group, 'request', `正在检查 ${snapshot.candidates.length} 只股票的固定策略条件`);
      const result = await this.evaluateRules({ strategyId: group.id, candidates: snapshot.candidates, context: snapshot.context || {} });
      if (!(await this._current(group, generation)) || !Number.isFinite(result?.expiresAt) || Number(this.clock()) >= result.expiresAt) return this._log(group, 'stale', '账户状态变化或决策过期，本轮未交易');
      // A serial commit owner must also check the token immediately before each fill.
      const completion = await this.commit(group, result, snapshot);
      await this.onComplete(group, snapshot, completion);
      if (completion?.completed !== false) this.lastCompleted.set(group.id, Number(this.clock()));
      this.lastError = '';
      if (completion?.completed !== false) this._log(group, 'complete', '规则检查完成，满足全部条件的意向已交由风控复核');
    } catch (error) {
      this.lastError = error instanceof AgencyRulesError ? error.message : '规则检查或执行校验失败，请查看检查与成交记录';
      this._log(group, 'error', this.lastError);
    }
  }
  _log(group, type, message) {
    const item = { time: Number(this.clock()), groupId: group.id, type, message };
    this.logs.push(item); if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
    // Logging must never turn a rule-check failure into an unhandled rejection.
    try { const pending = this.log(item, group); if (pending?.catch) pending.catch(() => {}); } catch {}
    return item;
  }
  status() { return { runningGroups: [...this.active.keys()], stopped: this.stopped, lastError: this.lastError, logs: this.logs.map(item => ({ ...item })) }; }
  invalidate() { this.generation++; }
  stop() { this.stopped = true; this.invalidate(); }
  resume() { this.stopped = false; this.invalidate(); }
  async drain() { await Promise.allSettled([...this.active.values()]); }
}
function validToken(token) { return typeof token === 'string' && token.length > 0 || typeof token === 'number' && Number.isFinite(token); }
module.exports = { AgencyRunner };
