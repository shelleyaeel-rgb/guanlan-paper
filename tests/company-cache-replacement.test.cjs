'use strict';
const test=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto'),{CompanyEvidenceSource}=require('../core/company-evidence-source.cjs');
const hash=v=>createHash('sha256').update(v).digest('hex');
const SYMBOL='sh600519',ID='AN20260417000001',HASH='a'.repeat(64),NOW=Date.parse('2026-10-14T10:00:00Z');
const item={id:ID,title:'贵州茅台:资料公告',date:'2026-04-17',kind:'notice'};
const fingerprint=hash(JSON.stringify([SYMBOL,ID,item.title,item.date,item.kind,null]));
const reference={symbol:SYMBOL,id:ID,fingerprint};
function page(n,{ocr=false,complete=true}={}) {
 const text=`Complete original page ${n}: verified financial disclosure for the same issuer.`;
 return {page:n,text,textHash:hash(text),characters:text.length,method:ocr?'ocr':'pdf-text',complete,numericEligible:!ocr,
  confidence:ocr?95:null,issues:ocr?['ocr-numbers-unverified']:[]};
}
function result(version,{ocr=false,pages=[page(1,{ocr})],complete=true,sourceHash=HASH}={}) {
 return {format:'pdf',parserVersion:version,sourceHash,pages:pages.length,pageTexts:pages,text:pages.map(p=>p.text).join('\n\n'),
  complete,hasOcrPages:pages.some(p=>p.method==='ocr'),numericEligible:complete&&pages.every(p=>p.numericEligible),issues:[]};
}
function setup(t,{old=result('3'),oldProfile=null,body=false}={}) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'guanlan-cache-replacement-'));
 t.after(()=>{const full=path.resolve(directory);assert.equal(path.dirname(full),path.resolve(os.tmpdir()));assert(path.basename(full).startsWith('guanlan-cache-replacement-'));fs.rmSync(full,{recursive:true,force:true});});
 const source=new CompanyEvidenceSource(async()=>{throw Error('No network in cache replacement test');},{directory,clock:()=>NOW,parser:{minOcrConfidence:85},parserVersion:'3'});
 source.retainSymbols([SYMBOL]);assert.equal(source.saveParsing(old.sourceHash,old,reference,oldProfile),undefined);
 const oldFile=source.parsedCachePath(old.sourceHash,oldProfile,'3'),original=fs.readFileSync(oldFile);
 let bodyFile;
 if(body){
  const saved={...old,id:ID,symbol:SYMBOL,issuerSymbol:SYMBOL,title:item.title,url:`https://data.eastmoney.com/notices/detail/600519/${ID}.html`,
   publishedAt:item.date,kind:item.kind,sourceKind:item.kind,source:'东方财富公告全文',fetchedAt:NOW,textHash:hash(old.text),fingerprint,
   format:old.hasOcrPages?'pdf-ocr':'pdf-text',originalFile:{sha256:old.sourceHash,cacheKey:'b'.repeat(64),bytes:123,format:'pdf'}};
  bodyFile=path.join(directory,`doc-${ID}.json`);fs.writeFileSync(bodyFile,JSON.stringify(saved));
 }
 source.parserVersion='4';source.diskMetadata.clear();
 return {source,directory,oldFile,bodyFile,original};
}
function budgetFor(source,newResult,extra=32){
 const value={cacheKind:'company-parsed-result-v1',sourceHash:newResult.sourceHash,parserVersion:'4',maxPages:source.maxPdfPages,maxChars:source.maxDocumentChars,parsedAt:NOW,references:[reference],result:newResult};
 source.maxCachedBytes=Buffer.byteLength(JSON.stringify(value))+extra;source.maxParsedCacheBytes=source.maxCachedBytes-1;source.maxBodyCacheBytes=1;
}
const countedBytes=dir=>fs.readdirSync(dir).filter(n=>/^(parsed|doc|bundle|link)-.*\.json$/.test(n)).reduce((n,file)=>n+fs.statSync(path.join(dir,file)).size,0);

test('满预算保护旧解析可由同原件本版结果原子置换，可信OCR页被完整承接',t=>{
 const f=setup(t,{old:result('3',{ocr:true})}),next=result('4');budgetFor(f.source,next);
 const warning=f.source.saveParsing(HASH,next,reference);assert.equal(warning,undefined);
 assert.equal(fs.existsSync(f.oldFile),false);assert.equal(f.source.cachedParsing(HASH).parserVersion,'4');
 assert(countedBytes(f.directory)<=f.source.maxCachedBytes);assert.equal(f.source.maxCachedBytes,Buffer.byteLength(fs.readFileSync(f.source.parsedCachePath(HASH)))+32);
});
test('同ID旧body与旧解析同时占据预算时被同身份新解析置换',t=>{
 const f=setup(t,{body:true}),next=result('4');budgetFor(f.source,next);
 assert.equal(f.source.saveParsing(HASH,next,reference),undefined);assert.equal(fs.existsSync(f.oldFile),false);assert.equal(fs.existsSync(f.bodyFile),false);
 assert.equal(f.source.cachedParsing(HASH).complete,true);assert(countedBytes(f.directory)<=f.source.maxCachedBytes);
});
test('写临时文件或rename失败都保留旧解析与旧body，不丢失可信OCR',t=>{
 for(const operation of ['writeFileSync','renameSync']) {
  const f=setup(t,{old:result('3',{ocr:true}),body:true}),next=result('4');budgetFor(f.source,next);
  const oldBody=fs.readFileSync(f.bodyFile),original=fs[operation];
  fs[operation]=(...args)=>{if(path.dirname(args[0])===f.directory&&String(args[0]).endsWith('.tmp'))throw Error(`isolated ${operation} failure`);return original(...args);};
  let warning;try{warning=f.source.saveParsing(HASH,next,reference);}finally{fs[operation]=original;}
  assert.match(warning,/isolated/);assert.deepEqual(fs.readFileSync(f.oldFile),f.original);assert.deepEqual(fs.readFileSync(f.bodyFile),oldBody);
  assert.equal(fs.existsSync(f.source.parsedCachePath(HASH)),false);assert.equal(fs.readdirSync(f.directory).some(n=>n.endsWith('.tmp')),false);
 }
});
test('同hash但解析limits不同的旧缓存不能挪作当前置换额度',t=>{
 const f=setup(t,{oldProfile:{maxPages:900,maxChars:900000}}),next=result('4');budgetFor(f.source,next);
 assert.match(f.source.saveParsing(HASH,next,reference),/容量已满/);assert.deepEqual(fs.readFileSync(f.oldFile),f.original);
});
test('其他hash与未知同名文件不得为新版置换被删除',t=>{
 const f=setup(t),next=result('4',{sourceHash:'c'.repeat(64)});budgetFor(f.source,next);
 const unknown=path.join(f.directory,'doc-AN20260000000000.json');fs.writeFileSync(unknown,'not an owned cache');
 assert.match(f.source.saveParsing(next.sourceHash,next,reference),/容量已满/);assert.deepEqual(fs.readFileSync(f.oldFile),f.original);assert.equal(fs.readFileSync(unknown,'utf8'),'not an owned cache');
});
test('未承接旧可信OCR页的新结果不能替换旧解析',t=>{
 const old=result('3',{pages:[page(1,{ocr:true}),page(2)]}),f=setup(t,{old}),next=result('4',{pages:[page(1,{complete:false}),page(2)],complete:false});
 budgetFor(f.source,next);assert.match(f.source.saveParsing(HASH,next,reference),/容量已满/);assert.deepEqual(fs.readFileSync(f.oldFile),f.original);
});
test('同ID但fingerprint不同的旧body不计入可替换空间',t=>{
 const f=setup(t,{body:true}),next=result('4');budgetFor(f.source,next);
 const body=fs.readFileSync(f.bodyFile);assert.match(f.source.saveParsing(HASH,next,{...reference,fingerprint:'c'.repeat(64)}),/容量已满/);
 assert.deepEqual(fs.readFileSync(f.oldFile),f.original);assert.deepEqual(fs.readFileSync(f.bodyFile),body);
});
