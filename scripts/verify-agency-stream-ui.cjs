// Offline Electron UI, production preload + stream sender/receiver. The account
// exists only in memory; an explicit GUANLAN_PERF_ACCOUNT opts into a read copy.
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const { createPerformanceAccount } = require('../tests/fixtures/agency-performance-data.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-stream-ui-'));
const parsed = process.env.GUANLAN_PERF_ACCOUNT ? JSON.parse(fs.readFileSync(path.resolve(process.env.GUANLAN_PERF_ACCOUNT), 'utf8')) : createPerformanceAccount();
fs.writeFileSync(path.join(output, 'account-snapshot.json'), JSON.stringify(parsed.account || parsed));
fs.writeFileSync(path.join(output, 'main.cjs'), `
const {app,BrowserWindow,ipcMain,session}=require('electron'),fs=require('node:fs'),path=require('node:path'),{performance,monitorEventLoopDelay}=require('node:perf_hooks');
const {Engine}=require(${JSON.stringify(path.join(root, 'core/engine.cjs'))}),{accountView,decisionView}=require(${JSON.stringify(path.join(root, 'core/view-state.cjs'))}),{ViewStream}=require(${JSON.stringify(path.join(root, 'core/view-stream.cjs'))}),{STRATEGY_PROFILES}=require(${JSON.stringify(path.join(root, 'core/strategy.cjs'))}),{poolPolicy}=require(${JSON.stringify(path.join(root, 'core/agency-screening.cjs'))});
app.setPath('userData',path.join(__dirname,'isolated-user-data'));
const account=JSON.parse(fs.readFileSync(path.join(__dirname,'account-snapshot.json'),'utf8')),engine=new Engine(account),quotes=account.marks,stream=new ViewStream();
let timer,win,sequence=0,samples=[];const delay=monitorEventLoopDelay({resolution:10});delay.enable();
function makeState(){return {account:accountView(engine.s),stats:engine.stats(quotes),agency:{...engine.agencyState(quotes,{decisionView}),runtime:{decisionMode:'rules',rulesVersion:'1',runningGroups:[],online:true,intervalSeconds:300}},agencyPool:{running:false,lastResult:account.agency.pool?.lastResult,policy:poolPolicy(),policies:{strategy:poolPolicy(),strict:poolPolicy('strict')}},quotes,signals:{},strategyProfiles:STRATEGY_PROFILES,planSelections:account.planSelections,connection:{ok:true,message:'离线持续性能测量',sources:[]},session:{open:false,label:'只读测量'},now:Date.now(),date:'2026-10-16',dataPath:__dirname,warning:''};}
function change(){const group=engine.s.agency.groups.find(g=>g.id==='long'),member=group.members[sequence%Math.min(30,group.members.length)],now=new Date().toISOString();if(!member)return;
  member.monitoringCheck={status:'conditions',reason:'隔离刷新 '+sequence,checkedAt:now};
  quotes[member.symbol]={...quotes[member.symbol],price:10+(sequence%10)/100,timestamp:Date.now()};
  const template=engine.s.agency.decisions.find(d=>(d.strategyId||d.groupId)==='long')||{};
  engine.agencyLog({...structuredClone(template),id:'stream-check-'+sequence,strategyId:'long',symbol:member.symbol,time:now,reason:'隔离增量检查 '+sequence});
}
function publish(changed=false){const start=performance.now();sequence++;if(changed)change();const snapshot=makeState(),built=performance.now(),packet=stream.next(snapshot),encoded=performance.now();win.webContents.send('view:patch',packet);samples.push({sequence,buildMs:built-start,encodeMs:encoded-built,sendMs:performance.now()-encoded,bytes:Buffer.byteLength(JSON.stringify(packet)),revision:packet.revision});return packet.revision;}
globalThis.__bench={publish,start(mode){clearInterval(timer);samples=[];delay.reset();if(mode!=='idle')timer=setInterval(()=>publish(mode==='changing'),500);},stop(){clearInterval(timer);timer=null;return {samples,eventLoop:{maxMs:delay.max/1e6,p99Ms:delay.percentile(99)/1e6}};},meta(){const snapshot=makeState();return {bytes:Buffer.byteLength(JSON.stringify(snapshot)),members:snapshot.agency.groups.map(g=>({id:g.id,count:g.members.length})),decisions:snapshot.agency.decisions.length};},gap(){sequence++;change();stream.next(makeState());return publish(true);}};
app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true}));
for(const name of ['state','view:state','view:refresh'])ipcMain.handle(name,()=>({ok:true,data:makeState()}));
ipcMain.handle('view:subscribe',()=>({ok:true,data:stream.reset(makeState())}));
ipcMain.handle('detail',()=>({ok:false,error:'隔离验证未启用外部资料'}));
win=new BrowserWindow({show:false,width:1536,height:960,webPreferences:{preload:${JSON.stringify(path.join(root, 'preload.cjs'))},contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});await win.loadFile(${JSON.stringify(path.join(root, 'ui/index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let desktop;
const summary = values => { const sorted=values.slice().sort((a,b)=>a-b);return {count:values.length,median:sorted[Math.floor(values.length/2)]||0,p95:sorted[Math.floor(values.length*.95)]||0,max:sorted.at(-1)||0,total:values.reduce((a,b)=>a+b,0)}; };
(async () => {
  desktop=await _electron.launch({executablePath:require('electron'),args:[path.join(output,'main.cjs')],cwd:root,env});
  const p=await desktop.firstWindow(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.waitForFunction(()=>typeof state!=='undefined'&&state?.agency?.groups?.length===4&&streamRevision>0);
  const meta=await desktop.evaluate(()=>globalThis.__bench.meta());
  const checks=await p.evaluate(()=>{
    const checks=[],check=(label,pass)=>{if(!pass)throw Error(label);checks.push(label);};
    switchPage('agency');agencyUi.strategyId='long';renderAgency();$('toast').classList.add('hidden');
    const member=$('agency-members').querySelector('tbody tr'),decision=$('agency-decisions').firstElementChild;
    renderState(state);check('unchanged refresh retains member and decision DOM',member===$('agency-members').querySelector('tbody tr')&&decision===$('agency-decisions').firstElementChild);
    $('agency-member-next').click();const secondPage=agencyUi.memberPage;renderState(state);check('member pagination survives refresh',secondPage===2&&agencyUi.memberPage===2);
    const search=$('agency-member-search');search.value=agencyGroup().members[32].symbol;search.dispatchEvent(new Event('input',{bubbles:true}));search.focus();search.setSelectionRange(2,6);renderState(state);
    check('search focus selection and filtering survive refresh',document.activeElement===search&&search.selectionStart===2&&search.selectionEnd===6&&$('agency-members').querySelectorAll('tbody tr').length===1);
    search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));
    const panel=$('agency-members').querySelector('details');if(panel){panel.open=true;window.__memberDetailKey=panel.closest('[data-render-key]').dataset.renderKey;window.__memberDetailClass=panel.className;}
    const evidence=decision.querySelector('details');if(evidence){evidence.open=true;window.__decisionKey=decision.dataset.renderKey;window.__evidenceClass=evidence.className;window.__existingDecision=decision;}
    agencyUi.performance={version:1,enabled:true,rules:[{field:'netProfitGrowthMinPct',op:'gte',value:null}]};renderAgencyPool();
    const performanceInput=$('agency-performance-controls').querySelector('input');performanceInput.focus();performanceInput.value='12.5';performanceInput.dispatchEvent(new Event('input',{bubbles:true}));renderState(state);
    check('performance numeric draft and node survive refresh',document.activeElement===performanceInput&&performanceInput.isConnected&&performanceInput.value==='12.5'&&agencyUi.performance.rules[0].value===12.5);
    agencyUi.screeningMode='product';renderAgencyPool();$('agency-research-controls').querySelector('[data-research-add]').click();
    const researchInput=$('agency-research-controls').querySelector('input');researchInput.focus();researchInput.value='21.5';researchInput.dispatchEvent(new Event('input',{bubbles:true}));renderState(state);
    check('research numeric draft survives refresh',document.activeElement===researchInput&&researchInput.isConnected&&researchInput.value==='21.5');
    agencyUi.industry=industryDefaults();renderAgencyPool();const industryInput=$('agency-industry-controls').querySelector('input');industryInput.focus();industryInput.value='7';industryInput.dispatchEvent(new Event('input',{bubbles:true}));renderState(state);
    check('industry numeric draft survives refresh',document.activeElement===industryInput&&industryInput.isConnected&&industryInput.value==='7');
    agencyUi.screeningMode='strategy';agencyUi.performance=undefined;agencyUi.industry=undefined;renderAgencyPool();
    const savedState=state,savedStream=streamSnapshot;
    state={...state,agencyPool:{...state.agencyPool,running:true,runId:'progress-isolation',progress:{stage:'daily',completed:1,total:10}}};streamSnapshot=state;
    const baseline=streamSnapshot;
    applyAgencyPoolProgress({running:true,runId:'progress-isolation',operation:'update',progress:{stage:'daily',completed:2,total:10},elapsedMs:2000});
    check('pool progress does not mutate stream baseline',state!==baseline&&streamSnapshot===baseline&&baseline.agencyPool.progress.completed===1&&state.agencyPool.progress.completed===2);
    streamSnapshot=savedStream;renderState(savedState);
    return checks;
  });
  let revision=await desktop.evaluate(()=>globalThis.__bench.publish(true));
  await p.waitForFunction(revision=>streamRevision>=revision,revision);
  checks.push(...await p.evaluate(()=>{
    const checks=[];
    if(window.__decisionKey){const node=[...$('agency-decisions').children].find(node=>node.dataset.renderKey===window.__decisionKey);if(node!==window.__existingDecision||!node.querySelector('details[open]'))throw Error('new decision lost prior expanded evidence '+JSON.stringify({key:window.__decisionKey,found:!!node,same:node===window.__existingDecision,open:!!node?.querySelector('details[open]'),connected:window.__existingDecision?.isConnected,diff:(()=>{const a=renderedRows.get(window.__existingDecision)||'',b=renderedRows.get(node)||'';let i=0;while(a[i]===b[i]&&i<Math.min(a.length,b.length))i++;return {a:a.slice(i-50,i+250),b:b.slice(i-50,i+250),alen:a.length,blen:b.length};})(),html:node?.outerHTML.slice(0,200),old:window.__existingDecision?.outerHTML.slice(0,200)}));checks.push('new streamed decision preserves existing record and expanded evidence');}
    const first=$('agency-decisions').firstElementChild;if(!first.textContent.includes('隔离增量检查'))throw Error('streamed decision missing');checks.push('changed decision appears');
    if(window.__memberDetailKey){const row=[...$('agency-members').querySelectorAll('tbody tr')].find(row=>row.dataset.renderKey===window.__memberDetailKey);if(!row?.querySelector('details[open]'))throw Error('member details lost');checks.push('member details survive changed refresh');}
    $('agency-member-next').click();renderState(state);if(agencyUi.memberPage!==2)throw Error('page reset after change');checks.push('member page remains usable after patch');
    document.querySelector('[data-agency-tab="short"]').click();if(agencyGroup().id!=='short'||agencyUi.memberPage!==1||![...$('agency-members').querySelectorAll('tbody tr')].every(row=>row.dataset.renderKey.startsWith('short:')))throw Error('group switch stale');checks.push('group switch clears old group rows and page');
    document.querySelector('[data-agency-tab="long"]').click();return checks;
  }));
  revision=await desktop.evaluate(()=>globalThis.__bench.gap());
  await p.waitForFunction(revision=>streamRevision>revision,revision);checks.push('missing patch triggers full resynchronization');
  const phases=[],duration=Number(process.env.GUANLAN_PERF_DURATION_MS||30000);
  const cdp=await p.context().newCDPSession(p);await cdp.send('Performance.enable');
  for(const mode of (process.env.GUANLAN_PERF_MODES||'idle,stable,changing').split(',')){
    const before=await cdp.send('Performance.getMetrics');
    await p.evaluate(()=>{
      window.__renderSamples=[];window.__frames=[];window.__tasks=[];window.__active=true;
      if(!window.__originalRender){window.__originalRender=renderState;renderState=s=>{const start=performance.now();window.__originalRender(s);window.__renderSamples?.push(performance.now()-start);};}
      window.__observer=new PerformanceObserver(list=>window.__tasks.push(...list.getEntries().map(e=>e.duration)));window.__observer.observe({type:'longtask'});
      const base=$('agency-members').getBoundingClientRect().top+scrollY,max=document.documentElement.scrollHeight-innerHeight;let previous=performance.now(),direction=1,offset=0;
      const frame=at=>{if(!window.__active)return;window.__frames.push(at-previous);previous=at;offset+=direction*12;if(offset>1200)direction=-1;if(offset<0)direction=1;scrollTo(0,Math.max(0,Math.min(max,base+offset)));window.__raf=requestAnimationFrame(frame);};window.__raf=requestAnimationFrame(frame);
    });
    await desktop.evaluate((_,mode)=>globalThis.__bench.start(mode),mode);
    await new Promise(resolve=>setTimeout(resolve,duration));
    const main=await desktop.evaluate(()=>globalThis.__bench.stop());
    const renderer=await p.evaluate(()=>{window.__active=false;cancelAnimationFrame(window.__raf);window.__observer.disconnect();return {frames:window.__frames,longTasks:window.__tasks,render:window.__renderSamples};});
    const after=await cdp.send('Performance.getMetrics'),bm=Object.fromEntries(before.metrics.map(m=>[m.name,m.value])),am=Object.fromEntries(after.metrics.map(m=>[m.name,m.value]));
    const phase={mode,pushes:main.samples.length,frames:summary(renderer.frames),framesOver50ms:renderer.frames.filter(n=>n>50).length,longTasks:summary(renderer.longTasks),render:summary(renderer.render),mainBuild:summary(main.samples.map(s=>s.buildMs)),mainEncode:summary(main.samples.map(s=>s.encodeMs)),mainSend:summary(main.samples.map(s=>s.sendMs)),bytes:summary(main.samples.map(s=>s.bytes)),eventLoop:main.eventLoop,metrics:Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount'].map(key=>[key,am[key]-bm[key]]))};
    phases.push(phase);fs.writeFileSync(path.join(output,mode+'-samples.json'),JSON.stringify({main,renderer}));fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({meta,checks,phases,errors},null,2));console.log(JSON.stringify({output,phase}));
  }
  await p.screenshot({path:path.join(output,'members.png')});assert.deepEqual(errors,[]);
  console.log(JSON.stringify({output,meta,checks,errors}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(desktop)await desktop.close();});
