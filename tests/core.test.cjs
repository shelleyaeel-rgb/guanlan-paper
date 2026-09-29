const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine, initialState, fees } = require('../core/engine.cjs');
const { Store } = require('../core/store.cjs');
const { symbolOf, session, cnTime } = require('../core/common.cjs');
const { analyze, forecastAt, rsi } = require('../core/analysis.cjs');
const { parseQuotes } = require('../core/market.cjs');
function cleanTestDirectory(dir) {
  const resolved = path.resolve(dir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('guanlan-test-'));
  fs.rmSync(resolved, {recursive:true,force:true});
}
function fixture() {
  let now = new Date('2026-09-29T10:00:00+08:00');
  const e = new Engine(initialState(100000), () => now);
  const q = (overrides = {}) => ({ symbol: 'sz000001', name: '平安银行', price: 10, open: 10, volume: 100000, bid: 9.99, ask: 10.01, bidSize: 10000, askSize: 10000, limitUp: 11, limitDown: 9, timestamp: now.getTime(), date: cnTime(now).date, ...overrides });
  return { e, q, day: value => { now = new Date(value); } };
}
test('沪深股票识别、交易时间与集合竞价隔离', () => {
  assert.equal(symbolOf('600519'),'sh600519'); assert.equal(symbolOf('301001'),'sz301001'); assert.equal(symbolOf('688001'),'sh688001');
  for (const s of ['sh000001','510300','920001','00700','600519,sz000001','../x']) assert.throws(()=>symbolOf(s));
  assert.equal(session(new Date('2026-09-29T11:30:00+08:00')).open,false);
  assert.equal(session(new Date('2026-09-29T13:00:00+08:00')).open,true);
  assert.equal(session(new Date('2026-09-29T14:57:00+08:00')).open,false);
  assert.equal(session(new Date('2026-10-03T10:00:00+08:00')).open,false);
});
test('买入含费成本、T+1、卖出费用与盈亏恒等式',()=>{
  const {e,q,day}=fixture();const initial=e.s.cash;
  const buy=e.execute({symbol:'000001',side:'buy',quantity:100},q());
  assert.equal(buy.price,10.02); assert.equal(e.s.cash,initial-buy.gross-buy.fees.total);
  assert.equal(e.positions()[0].available,0);
  assert.throws(()=>e.execute({symbol:'000001',side:'sell',quantity:100},q()),/T\+1/);
  day('2026-09-30T10:00:00+08:00');const quote=q({price:10.8,bid:10.8});
  const sell=e.execute({symbol:'000001',side:'sell',quantity:100},quote);
  assert.equal(sell.pnl,sell.gross-sell.fees.total-buy.gross-buy.fees.total);
  assert.equal(e.positions().length,0);assert.equal(e.s.cash-initial,sell.pnl);assert.equal(e.stats().winRate,1);
  assert.equal(e.stats().pnl,e.stats().realized+e.stats().unrealized);
});
test('FIFO 部分卖出按比例分摊成本，剩余成本不丢分',()=>{
  const {e,q,day}=fixture();e.execute({symbol:'000001',side:'buy',quantity:300},q());
  const original=e.s.lots[0].cost;day('2026-09-30T10:00:00+08:00');
  const a=e.execute({symbol:'000001',side:'sell',quantity:100},q());
  const b=e.execute({symbol:'000001',side:'sell',quantity:200},q());
  assert.equal(a.cost+b.cost,original);assert.equal(e.stats().pnl,e.stats().realized);
});
test('同日新买入不会混入旧仓可卖数',()=>{
  const {e,q,day}=fixture();e.execute({symbol:'000001',side:'buy',quantity:100},q());
  day('2026-09-30T10:00:00+08:00');e.execute({symbol:'000001',side:'buy',quantity:200},q());
  assert.equal(e.positions()[0].available,100);assert.throws(()=>e.execute({symbol:'000001',side:'sell',quantity:200},q()),/T\+1/);
});
test('陈旧、未来、跨日和停牌报价都不能成交',()=>{
  const {e,q}=fixture();
  for(const quote of [q({timestamp:q().timestamp-91000}),q({timestamp:q().timestamp+20000}),q({date:'2026-09-28'}),q({volume:0}),q({limitUp:null})])assert.throws(()=>e.execute({symbol:'000001',side:'buy',quantity:100},quote));
  assert.equal(e.s.trades.length,0);
});
test('数量、余额、仓位、盘口和涨跌停检查',()=>{
  const {e,q}=fixture();assert.throws(()=>e.execute({symbol:'000001',side:'buy',quantity:101},q()),/100/);
  assert.throws(()=>e.execute({symbol:'000001',side:'buy',quantity:100},q({ask:11})),/涨跌停/);
  assert.throws(()=>e.execute({symbol:'000001',side:'buy',quantity:100},q({askSize:0})),/数量不足/);
  assert.throws(()=>e.execute({symbol:'000001',side:'buy',quantity:4000},q()),/仓位/);
  e.s.cash=1;assert.throws(()=>e.execute({symbol:'000001',side:'buy',quantity:100},q()),/资金不足/);
});
test('科创板最低 200 股，200 以上允许 1 股递增',()=>{
  const {e,q}=fixture();const quote=q({symbol:'sh688001'});
  assert.throws(()=>e.execute({symbol:'688001',side:'buy',quantity:100},quote),/200/);
  e.execute({symbol:'688001',side:'buy',quantity:201},quote);assert.equal(e.positions()[0].quantity,201);
});
test('同一报价的可见数量不能被多次重复消费',()=>{
  const {e,q}=fixture();const quote=q({askSize:100});e.execute({symbol:'000001',side:'buy',quantity:100},quote);
  assert.throws(()=>e.execute({symbol:'000001',side:'buy',quantity:100},quote),/数量不足/);
});
test('限价单等待、含滑点判断、自动成交及幂等',()=>{
  const {e,q}=fixture();const o=e.place({symbol:'000001',side:'buy',quantity:100,limit:10.01});
  e.tick({sz000001:q()});assert.equal(o.status,'pending');assert.match(o.note,/滑点/);
  e.tick({sz000001:q({ask:10})});assert.equal(o.status,'filled');e.tick({sz000001:q({ask:10})});assert.equal(e.s.trades.length,1);
});
test('缺少报价时限价单继续等待，可撤销',()=>{
  const {e}=fixture();const o=e.place({symbol:'000001',side:'buy',quantity:100,limit:11});e.tick({});assert.equal(o.status,'pending');e.cancel(o.id);assert.equal(o.status,'cancelled');
});
test('止损在 T+1 时等待，下个交易日触发并清除风控',()=>{
  const {e,q,day}=fixture();e.execute({symbol:'000001',side:'buy',quantity:100},q());e.setRisk('000001',{stop:9.8,target:11,enabled:true});
  e.tick({sz000001:q({price:9.7,bid:9.69})});assert.equal(e.s.trades.length,1);assert.match(e.s.risks.sz000001.note,/T\+1/);
  day('2026-09-30T10:00:00+08:00');e.tick({sz000001:q({price:9.7,bid:9.69})});assert.equal(e.s.trades.length,2);assert.equal(e.s.trades[1].reason,'止损触发');assert.equal(e.s.risks.sz000001,undefined);
});
test('移动止损追踪新高并按回撤触发',()=>{
  const {e,q,day}=fixture();e.execute({symbol:'000001',side:'buy',quantity:100},q());e.setRisk('000001',{trailing:3,enabled:true});day('2026-09-30T10:00:00+08:00');
  e.tick({sz000001:q({price:10.8})});assert.equal(e.s.risks.sz000001.peak,10.8);e.tick({sz000001:q({price:10.4,bid:10.4})});assert.equal(e.positions().length,0);
});
test('无效设置不会部分写入',()=>{
  const {e}=fixture();const old={...e.s.settings};assert.throws(()=>e.configure({...old,commission:0.003,refreshSeconds:0}));assert.deepEqual(e.s.settings,old);
  assert.throws(()=>e.place({symbol:'000001',side:'buy',quantity:100,limit:10.001}));
});
test('佣金最低额、单边印花税与双边过户费',()=>{
  const s=initialState().settings,b=fees(100000,'buy',s),v=fees(100000,'sell',s);assert.equal(b.commission,500);assert.equal(b.stampTax,0);assert.equal(v.stampTax,50);assert.equal(b.transferFee,1);
});
test('账户原子持久化及损坏时恢复备份',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guanlan-test-'));try{const st=new Store(dir),s=initialState();st.save(s);s.cash-=100;st.save(s);assert.equal(st.load().cash,s.cash);fs.writeFileSync(st.file,'broken');const recovered=st.load();assert.equal(recovered.cash,s.cash+100);assert.match(st.warning,/恢复/);st.save(recovered);assert.equal(JSON.parse(fs.readFileSync(st.file+'.bak','utf8')).cash,recovered.cash);}finally{cleanTestDirectory(dir);}
});
test('不能读取的账户不静默重置',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guanlan-test-'));try{const st=new Store(dir);fs.writeFileSync(st.file,'broken');assert.throws(()=>st.load(),/没有重置/);}finally{cleanTestDirectory(dir);}
});
test('预测在时点 t 不依赖 t 之后数据',()=>{
  const c=Array.from({length:300},(_,i)=>10+i*.02+Math.sin(i*.31));const first=forecastAt(c,180),changed=c.map((v,i)=>i>180?v*7:v);assert.deepEqual(forecastAt(changed,180),first);assert.equal(first.n,40);
});
test('盘中分析排除尚未收盘的当日日线',()=>{
  const bars=Array.from({length:120},(_,i)=>({date:new Date(Date.UTC(2026,5,2+i)).toISOString().slice(0,10),open:10+i*.01,close:10+i*.01,high:10.2+i*.01,low:9.8+i*.01,volume:10000}));
  bars.push({date:'2026-09-30',open:12,close:999,high:999,low:12,volume:1000});const a=analyze(bars,null,new Date('2026-09-30T10:00:00+08:00'));assert.notEqual(a.close,999);assert.equal(rsi(Array(60).fill(10)),50);
});
test('腾讯字段解析包括北京时间、盘口手转股、涨跌停',()=>{
  const a=Array(50).fill('');Object.assign(a,{1:'平安银行',2:'000001',3:'11.35',4:'11.30',5:'11.30',6:'690979',9:'11.35',10:'3815',19:'11.36',20:'986',30:'20260929161500',31:'0.05',32:'0.44',33:'11.41',34:'11.28',47:'12.43',48:'10.17'});
  const q=parseQuotes(`v_sz000001="${a.join('~')}";`).sz000001;assert.equal(q.askSize,98600);assert.equal(q.limitUp,12.43);assert.equal(q.timestamp,Date.parse('2026-09-29T16:15:00+08:00'));assert.deepEqual(parseQuotes('v_bad="";'),{});
});
