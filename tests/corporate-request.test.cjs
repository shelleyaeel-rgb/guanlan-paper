'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CorporateRequest}=require('../core/corporate-request.cjs');
const URL='https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=AN202610081830210632';
const json=value=>new Response(JSON.stringify(value));
test('公司行为临时协议及证书库变化有限重试，沿用原fetch和安全选项并记录恢复',async()=>{
 for(const code of ['ERR_HTTP2_PROTOCOL_ERROR','ERR_CERT_DATABASE_CHANGED']){
  let calls=0;const options=[],events=[],sleeps=[];
  const fetcher=async(url,request)=>{calls++;options.push(request);if(calls<3)throw Error('net::'+code);return json({ready:true});};
  const transport=new CorporateRequest(fetcher,{minIntervalMs:0,sleep:async ms=>{sleeps.push(ms);}});
  assert.deepEqual(await transport.json(URL,{stage:'corporate-body',documentId:'AN202610081830210632',onDiagnostic:event=>events.push(event)}),{ready:true});
  assert.equal(transport.fetcher,fetcher);assert.equal(calls,3);assert.deepEqual(sleeps,[300,600]);
  assert.ok(options.every(option=>Object.keys(option).sort().join(',')==='cache,headers,signal'));
  assert.equal(events.at(-1).code,'recovered');assert.equal(events.at(-1).attempts,3);
 }
});
test('连续网络失败最多3次，真实证书错误、无效JSON及404不重试',async()=>{
 let calls=0;const repeated=new CorporateRequest(async()=>{calls++;throw Error('net::ERR_HTTP2_PROTOCOL_ERROR');},{retryBaseMs:0});
 await assert.rejects(repeated.json(URL),error=>error.acquisition.code==='http2-protocol'&&error.acquisition.attempts===3);assert.equal(calls,3);
 for(const code of ['ERR_CERT_AUTHORITY_INVALID','CERT_HAS_EXPIRED','ERR_SSL_PROTOCOL_ERROR']){
  let invalid=0;const service=new CorporateRequest(async()=>{invalid++;throw Error('fetch failed',{cause:{code}});},{retryBaseMs:0});
  await assert.rejects(service.json(URL),error=>error.acquisition.code==='certificate-invalid'&&!error.acquisition.retryable);assert.equal(invalid,1);
 }
 for(const response of [new Response('',{status:404}),new Response('broken json')]){
  let invalid=0;const service=new CorporateRequest(async()=>{invalid++;return response;});await assert.rejects(service.json(URL));assert.equal(invalid,1);
 }
});
test('429尊重Retry-After，超过总期限时停止等待而不提前再次请求',async()=>{
 let calls=0;const service=new CorporateRequest(async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});},{deadlineMs:15});
 await assert.rejects(service.json(URL),error=>error.acquisition.code==='deadline'&&error.acquisition.attempts===1);assert.equal(calls,1);
 let recovered=0,now=1000;const sleeps=[];const normal=new CorporateRequest(async()=>++recovered===1?new Response('',{status:503,headers:{'retry-after':'2'}}):json({ok:true}),{clock:()=>now,sleep:async ms=>{sleeps.push(ms);now+=ms;}});
 assert.deepEqual(await normal.json(URL),{ok:true});assert.deepEqual(sleeps,[2000]);
});
test('取消请求、读取正文及退避立即停止，忽略signal的底层实现仍受总期限约束',async()=>{
 for(const phase of ['fetch','body','backoff']){
  const controller=new AbortController();let calls=0,began;const started=new Promise(resolve=>{began=resolve;});
  const service=new CorporateRequest(async()=>{calls++;if(phase==='fetch'){began();return new Promise(()=>{});}if(phase==='body')return{ok:true,json:()=>{began();return new Promise(()=>{});}};throw Error('net::ERR_HTTP2_PROTOCOL_ERROR');},{sleep:async()=>{began();return new Promise(()=>{});}});
  const pending=service.json(URL,{signal:controller.signal});await started;controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(calls,1);
 }
 const service=new CorporateRequest(async()=>({ok:true,json:()=>new Promise(()=>{})}),{deadlineMs:15,timeoutMs:100});
 await assert.rejects(service.json(URL),error=>error.acquisition.code==='deadline');
});
test('只访问现有HTTPS域名，不跟随未知或跨源返回，不引入直连路径',async()=>{
 let calls=0;const service=new CorporateRequest(async()=>{calls++;const response=json({});Object.defineProperty(response,'url',{value:'https://example.com/data'});return response;});
 for(const url of [URL.replace('https:','http:'),'https://example.com/data',URL.replace('https://','https://user:pass@')])await assert.rejects(service.json(url),/域名/);
 assert.equal(calls,0);await assert.rejects(service.json(URL),error=>error.acquisition.code==='invalid-response');assert.equal(calls,1);
});

test('567无Retry-After只暂停相同请求，同源其他股票和接口仍可获取，冷却记录明确本次未发送',async()=>{
 let now=Date.parse('2026-10-19T02:22:22Z');const retryAt=now+60000,calls=[];let rejected=true;
 const index='https://np-anotice-stock.eastmoney.com/api/security/ann?stock_list=688685&page_index=1';
 const other=index.replace('688685','600025');
 const service=new CorporateRequest(async url=>{calls.push(url);return rejected&&url===index?new Response('',{status:567}):json({ready:true});},{clock:()=>now,minIntervalMs:0});
 const first=service.json(index,{stage:'corporate-index'}),next=service.json(other,{stage:'corporate-index'});
 await assert.rejects(first,error=>error.acquisition.code==='http-567'&&!error.acquisition.retryable&&error.acquisition.attempts===1&&/公告目录接口拒绝请求.*该请求/.test(error.message));
 assert.deepEqual(await next,{ready:true});assert.deepEqual(calls,[index,other]);
 const paused=error=>error.acquisition.code==='source-cooldown'&&error.acquisition.attempts===0&&error.acquisition.scope==='request'
   &&error.acquisition.retryAt===retryAt&&error.acquisition.underlyingCode==='http-567'&&/本地暂停，本次未发送/.test(error.message)
   &&/2026-10-19 10:23:22（北京时间）/.test(error.message)&&!/秒后/.test(error.message);
 await assert.rejects(service.json(index),paused);
 // Canonicalizing only the cooldown key must not change the URL sent upstream.
 await assert.rejects(service.json('https://np-anotice-stock.eastmoney.com/api/security/ann?page_index=1&stock_list=688685#local'),paused);
 assert.equal(calls.length,2);
 assert.deepEqual(await service.json('https://datacenter-web.eastmoney.com/api/data/v1/get'),{ready:true});
 now=retryAt-1;await assert.rejects(service.json(index),paused);assert.equal(calls.length,3);
 now=retryAt;rejected=false;assert.deepEqual(await service.json(index),{ready:true});assert.equal(calls.length,4);
});

test('567明确Retry-After和429仍对同域名暂停，期满恢复时继续沿用原URL与请求头',async()=>{
 for(const [status,retryHeader,waitMs] of [[567,'120',120000],[503,'120',120000],[429,null,60000]]){
  let now=1000;const calls=[];let rejected=true;
  const service=new CorporateRequest(async(url,options)=>{calls.push({url,options});return rejected?new Response('',{status,...(retryHeader?{headers:{'retry-after':retryHeader}}:{})}):json({ready:true});},
   {clock:()=>now,minIntervalMs:0,maxAttempts:1});
  await assert.rejects(service.json(URL),error=>error.acquisition.code===`http-${status}`&&error.acquisition.attempts===1);
  await assert.rejects(service.json(URL+'&next=1'),error=>error.acquisition.code==='source-cooldown'&&error.acquisition.scope==='host'
   &&error.acquisition.retryAt===1000+waitMs&&error.acquisition.attempts===0&&/同域名请求已在本地暂停，本次未发送/.test(error.message));
  assert.equal(calls.length,1);now+=waitMs;rejected=false;
  assert.deepEqual(await service.json(URL+'&next=1'),{ready:true});assert.deepEqual(calls.map(call=>call.url),[URL,URL+'&next=1']);
  assert.ok(calls.every(call=>call.options.cache==='no-store'&&call.options.headers['User-Agent']==='Mozilla/5.0'&&call.options.headers.Referer==='https://data.eastmoney.com/'));
 }
});

test('明确Retry-After为零不额外延长暂停，不合法Retry-After不会扩大567的影响范围',async()=>{
 for(const retryHeader of ['0','invalid']){
  let calls=0;const service=new CorporateRequest(async()=>++calls===1?new Response('',{status:567,headers:{'retry-after':retryHeader}}):json({ready:true}),{minIntervalMs:0});
  await assert.rejects(service.json(URL),error=>error.acquisition.code==='http-567');
  assert.deepEqual(await service.json(retryHeader==='0'?URL:URL+'&other=1'),{ready:true});assert.equal(calls,2);
 }
});

test('同源请求串行并间隔，取消队列中等待者不会阻塞后续请求或取消正在获取的资料',async()=>{
 let now=1000,release,started;const begins=new Promise(resolve=>{started=resolve;}),calls=[],sleeps=[];
 const service=new CorporateRequest(async url=>{calls.push({url,at:now});if(calls.length===1){started();await new Promise(resolve=>{release=resolve;});}return json({url});},
   {clock:()=>now,sleep:async ms=>{sleeps.push(ms);now+=ms;}});
 const first=service.json(URL);await begins;
 const controller=new AbortController();const cancelled=service.json(URL+'&cancelled=1',{signal:controller.signal});
 const last=service.json(URL+'&last=1');controller.abort();await assert.rejects(cancelled,error=>error.name==='AbortError');
 assert.equal(calls.length,1);release();await first;await last;
 assert.equal(calls.length,2);assert.equal(calls[1].at-calls[0].at,250);assert.deepEqual(sleeps,[250]);
});

test('限流等待对同源其他股票生效，截止或取消排队不会发起网络请求',async()=>{
 let calls=0;const service=new CorporateRequest(async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});},{deadlineMs:20});
 const first=service.json(URL);await assert.rejects(first,error=>error.acquisition.code==='deadline');
 await assert.rejects(service.json(URL+'&next=1'),error=>error.acquisition.code==='source-cooldown'&&error.acquisition.attempts===0);
 assert.equal(calls,1);
 let release,started;const began=new Promise(resolve=>{started=resolve;});
 const queued=new CorporateRequest(async()=>{started();await new Promise(resolve=>{release=resolve;});return json({});},{deadlineMs:20});
 const pending=queued.json(URL);await began;const behind=queued.json(URL+'&behind=1');
 await Promise.all([assert.rejects(pending),assert.rejects(behind)]);release();
});
