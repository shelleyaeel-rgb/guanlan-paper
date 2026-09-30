const { technicals } = require('./strategy.cjs');

// Independent of the displayed stock/page. Slow history requests never block quote/risk polling.
class StrategyMonitor {
  constructor(market, clock = () => new Date(), onChange = () => {}) { this.market = market; this.clock = clock; this.onChange = onChange; this.snapshots = {}; this.inflight = new Map(); }
  async load(symbol, force = false) {
    if (this.inflight.has(symbol)) return this.inflight.get(symbol);
    const previous = this.snapshots[symbol];
    if (!force && previous && this.clock().getTime() - previous.attemptedAt < 60000) return previous;
    const work = (async () => {
      let snapshot;
      try {
        const data = await this.market.strategyHistory(symbol, null, true), bars = Array.isArray(data) ? data : data.bars;
        snapshot = { technical: technicals(bars, this.clock()), source: data.source || '来源未标注', provider: data.provider || null, fetchedAt: this.clock().getTime(), attemptedAt: this.clock().getTime() };
      }
      catch (e) { snapshot = { error: `策略日线不可用：${e.message}`, attemptedAt: this.clock().getTime() }; }
      this.snapshots[symbol] = snapshot; this.onChange(); return snapshot;
    })().finally(() => this.inflight.delete(symbol));
    this.inflight.set(symbol, work); return work;
  }
  async scan(symbols) {
    if (this.scanning) return this.scanning;
    const queue = [...new Set(symbols)];
    this.scanning = Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { while (queue.length) await this.load(queue.shift()); })).finally(() => { this.scanning = null; });
    return this.scanning;
  }
}
module.exports = { StrategyMonitor };
