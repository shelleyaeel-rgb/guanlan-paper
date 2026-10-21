// Frozen synthetic account by default; GUANLAN_PERF_ACCOUNT explicitly opts into
// reading a supplied account/snapshot. Never starts main.cjs, Store or services.
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), v8 = require('node:v8');
const { _electron } = require(process.env.GUANLAN_PLAYWRIGHT_PATH || 'playwright');
const { Engine } = require('../core/engine.cjs');
const { STRATEGY_PROFILES } = require('../core/strategy.cjs');
const { poolPolicy } = require('../core/agency-screening.cjs');
const { accountView, decisionView } = require('../core/view-state.cjs');
const { createPerformanceAccount } = require('../tests/fixtures/agency-performance-data.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'work/agency-performance-ui-'));
const parsed = process.env.GUANLAN_PERF_ACCOUNT ? JSON.parse(fs.readFileSync(path.resolve(process.env.GUANLAN_PERF_ACCOUNT), 'utf8')) : createPerformanceAccount();
const account = parsed.account || parsed, now = Date.parse('2026-10-16T10:00:00+08:00'), engine = new Engine(account, () => new Date(now)), quotes = account.marks;
const common = { stats: engine.stats(quotes), agencyPool: { running: false, lastResult: account.agency.pool?.lastResult, policy: poolPolicy(), policies: { strategy: poolPolicy(), strict: poolPolicy('strict') } },
  quotes, signals: {}, strategyProfiles: STRATEGY_PROFILES, planSelections: account.planSelections,
  connection: { ok: true, message: '隔离性能测量', sources: [] }, session: { open: false, label: '只读测量' }, now, date: '2026-10-16', dataPath: output, warning: '' };
const runtime = { decisionMode: 'rules', rulesVersion: '1', runningGroups: [], online: true, intervalSeconds: 300 };
const snapshots = { state: { ...common, account, agency: { ...engine.agencyState(quotes), runtime } },
  'view:state': { ...common, account: accountView(account), agency: { ...engine.agencyState(quotes, { decisionView }), runtime } } };
const sizes = Object.fromEntries(Object.entries(snapshots).map(([key, value]) => [key, { jsonBytes: Buffer.byteLength(JSON.stringify(value)), serializedBytes: v8.serialize(value).byteLength }]));
fs.writeFileSync(path.join(output, 'snapshots.json'), JSON.stringify(snapshots));
fs.writeFileSync(path.join(output, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('guanlan',{call:(name,payload)=>ipcRenderer.invoke('call',name,payload),subscribe:()=>()=>{},subscribeAgencyPoolProgress:()=>()=>{}});`);
fs.writeFileSync(path.join(output, 'main.cjs'), `
const {app,BrowserWindow,ipcMain,session}=require('electron'),path=require('node:path'),fs=require('node:fs');
app.setPath('userData',path.join(__dirname,'isolated-user-data'));
const snapshots=JSON.parse(fs.readFileSync(path.join(__dirname,'snapshots.json'),'utf8'));
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:true}));
  ipcMain.handle('call',(_,name)=>{const value=snapshots[name==='refresh'?'state':name==='view:refresh'?'view:state':name];return value?{ok:true,data:value}:{ok:false,error:'隔离性能测量：外部操作已禁用'};});
  const win=new BrowserWindow({show:false,width:1536,height:960,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  await win.loadFile(${JSON.stringify(path.join(root, 'ui/index.html'))});
});app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let desktop;
(async () => {
  desktop = await _electron.launch({ executablePath: require('electron'), args: [path.join(output, 'main.cjs')], cwd: root, env });
  const p = await desktop.firstWindow(), errors = []; p.on('pageerror', error => errors.push(error.message));
  await p.waitForFunction(() => typeof state !== 'undefined' && state?.agency?.groups?.length === 4);
  const report = await p.evaluate(async () => {
    const raw = async name => { const result = await window.guanlan.call(name); if (!result.ok) throw Error(result.error); return result.data; };
    const full = await raw('state'), view = await raw('view:state');
    const summary = values => ({ medianMs: [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)], maxMs: Math.max(...values), samplesMs: values });
    const measure = fn => { const values=[];for(let i=0;i<9;i++){const start=performance.now();fn();values.push(performance.now()-start);}return summary(values); };
    const timings = { state: [], 'view:state': [] };
    for(let i=0;i<7;i++) for(const name of i%2?['view:state','state']:['state','view:state']) { const start=performance.now();await raw(name);timings[name].push(performance.now()-start); }
    const report={ members: full.agency.groups.map(group=>({id:group.id,count:group.members.length})), decisions:full.agency.decisions.length,
      ipc:Object.fromEntries(Object.entries(timings).map(([key,values])=>[key,summary(values)])), htmlEquality:[], rendering:[] };
    const sections=['agency-members','agency-monitoring-summary','agency-decisions','agency-corporate-history','agency-pool-items','agency-pool-metrics','agency-pool-diagnostics','agency-pool-evidence-summary','agency-pool-strategies'];
    const capture=(snapshot,id)=>{
      page='agency';agencyUi.strategyId=id;agencyUi.memberGroup=null;agencyUi.memberPage=1;agencyUi.poolPage=1;agencyUi.poolResultId=null;agencyUi.poolRenderKey=null;
      renderState(snapshot);
      return Object.fromEntries(sections.map(section=>[section,document.getElementById(section).innerHTML]));
    };
    for(const group of full.agency.groups){const before=capture(full,group.id),after=capture(view,group.id);
      report.htmlEquality.push({id:group.id,sections:Object.fromEntries(sections.map(key=>[key,before[key]===after[key]]))});
      const current=view.agency.groups.find(item=>item.id===group.id);
      report.rendering.push({id:group.id,renderState:measure(()=>renderState(view)),members:measure(()=>agencyMembersHtml(current)),decisions:measure(()=>agencyDecisionsHtml(current)),decisionNodes:document.querySelectorAll('#agency-decisions *').length});
    }
    report.market=(()=>{page='market';return measure(()=>renderState(view));})();
    const refresh=await raw('view:refresh');report.refreshRetainsDecisions=refresh.agency.decisions.length===full.agency.decisions.length;
    return report;
  });
  report.fixture = process.env.GUANLAN_PERF_ACCOUNT ? 'explicit-read-only-account' : 'synthetic-600-members';
  report.sizes=sizes;report.errors=errors;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report,null,2));
  await p.evaluate(() => { switchPage('agency'); agencyUi.strategyId='long'; renderAgency(); document.getElementById('toast').classList.add('hidden'); window.scrollTo(0,0); });
  await p.screenshot({ path: path.join(output, 'agency-overview.png') });
  await p.evaluate(() => document.getElementById('agency-members').scrollIntoView({block:'start'}));
  await p.screenshot({ path: path.join(output, 'agency-members.png') });
  report.screenshots=['agency-overview.png','agency-members.png'];
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report,null,2));
  assert.deepEqual(errors, []);
  for(const group of report.htmlEquality)for(const [section,equal] of Object.entries(group.sections))assert.equal(equal,true,`${group.id}: ${section} retains identical HTML`);
  assert.equal(report.refreshRetainsDecisions,true);
  if(!process.env.GUANLAN_PERF_ACCOUNT)assert.ok(sizes['view:state'].serializedBytes<sizes.state.serializedBytes*0.5,'synthetic bulk sources are removed from the renderer payload');
  console.log(JSON.stringify({output,fixture:report.fixture,sizes,ipc:report.ipc,htmlEquality:report.htmlEquality,rendering:report.rendering.map(item=>({id:item.id,renderMs:item.renderState.medianMs,decisionMs:item.decisions.medianMs}))},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(desktop)await desktop.close();});
