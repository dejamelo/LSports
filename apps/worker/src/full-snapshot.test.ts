import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createServer} from 'node:http';import {once} from 'node:events';
import {walkSnapshot,convertSnapshotRow,fullSnapshot,fullSnapshotMemory,FULL_SNAPSHOT_LIMITS} from './full-snapshot.js';
const row=(FixtureId:number)=>({FixtureId,Fixture:{Status:1,LastUpdate:'2026-10-19T14:00:00.0173136'},Markets:[]});
test('full snapshot download window covers the observed rate at the unchanged byte cap',()=>{
 const secondsAtObservedRate=FULL_SNAPSHOT_LIMITS.responseBytes/(3.5*1024*1024);
 assert.equal(FULL_SNAPSHOT_LIMITS.responseBytes,2*1024*1024*1024);assert.equal(FULL_SNAPSHOT_LIMITS.idleMs,60000);
 assert.equal(FULL_SNAPSHOT_LIMITS.totalMs,12*60*1000);assert.ok(FULL_SNAPSHOT_LIMITS.totalMs/1000>secondsAtObservedRate);
});
test('sanitized progress distinguishes an HTTP 200 empty snapshot without retaining response content',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'-adl-empty-snapshot-')),server=createServer((_req,res)=>res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:[]}))),progress:any[]=[];
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const result=await fullSnapshot({lane:'inplay',url:'http://127.0.0.1:'+(server.address() as {port:number}).port,credentials:{packageId:4510,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},progress:p=>progress.push(p),async apply(){assert.fail('empty response cannot apply a row');}});assert.equal(result.rows,0);const complete=progress.at(-1);assert.equal(complete.stage,'complete');assert.equal(complete.httpStatus,200);assert.equal(complete.responseHeaderStatusCode,200);assert.equal(complete.emptyResponse,true);assert.equal(JSON.stringify(complete).includes('isolated'),false);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test('active snapshot response can outlast a short total window without being classified as idle',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-full-total-window-'));let applied=0;const available=process.availableMemory;process.availableMemory=()=>1024**3;
 const server=createServer((_req,res)=>{res.write('{"Header":{"HttpStatusCode":200},"Body":[');setTimeout(()=>res.end(JSON.stringify(row(1))+']}'),120);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const result=await fullSnapshot({url:'http://127.0.0.1:'+(server.address() as {port:number}).port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},limits:{totalMs:500,idleMs:300},async apply(){applied++;}});
  assert.equal(result.rows,1);assert.equal(applied,1);assert.deepEqual(await readdir(dir),[]);
 }finally{process.availableMemory=available;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test('bounded envelope parser validates ordering, trailing Header, UTF8 and rejects truncation, duplicate root and application errors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-full-envelope-'));try{const file=join(dir,'body');
 await writeFile(file,JSON.stringify({Body:[{...row(1),Fixture:{...row(1).Fixture,Name:'Hipódromo {"} }}'}},row(2)],Header:{HttpStatusCode:200}}));let n=0;await walkSnapshot(file,async raw=>{assert.ok(convertSnapshotRow(raw).fixture);n++;});assert.equal(n,2);
 for(const text of ['{"Body":[', '{"Header":{},"Body":[],"Body":[]}','{"Header":{},"Body":null}','{"Header":{"Errors":["PRIVATE"]},"Body":[]}','{"Header":{},"Body":[]} trailing','{"Header":{},"Body":[{},]}','{"Header":{},"Body":[],"Extra":'+'['.repeat(129)+'0'+']'.repeat(129)+'}']){await writeFile(file,text);await assert.rejects(walkSnapshot(file,async()=>{}));}
 await writeFile(file,JSON.stringify({Header:{},Body:[{FixtureId:1,Fixture:{},Extra:'x'.repeat(1024)}]}));await assert.rejects(walkSnapshot(file,async()=>{},256));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('full HTTP >256 MiB is spooled, not aggregated; exact unfiltered SDK request and bounded item conversion',{timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-full-volume-'));let applied=0,largestRSS=process.memoryUsage().rss;const before=largestRSS;
 const available=process.availableMemory;process.availableMemory=()=>768*1024*1024;
 const count=260,padding='x'.repeat(1024*1024);let mode='valid';
 const server=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;const request=JSON.parse(text);assert.equal(req.url,'/Prematch/GetEvents');assert.deepEqual(Object.keys(request).sort(),['packageId','password','username']);assert.equal(request.packageId,4511);res.setHeader('Content-Type','application/json');
 res.write('{"Body":[');for(let i=1;i<=count;i++){const data=(i>1?',':'')+JSON.stringify({...row(i),Padding:padding});if(!res.write(data))await once(res,'drain');}res.end('],"Header":'+JSON.stringify(mode==='valid'?{HttpStatusCode:200}:{Errors:['PRIVATE']})+'}');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const opts={url,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},async apply(r:ReturnType<typeof convertSnapshotRow>){assert.equal(r.fixtureId,++applied);largestRSS=Math.max(largestRSS,process.memoryUsage().rss);},limits:{responseBytes:280*1024*1024}};
 try{const result=await fullSnapshot(opts);assert.ok(result.bytes>256*1024*1024);assert.equal(result.rows,count);assert.equal(applied,count);assert.ok(largestRSS-before<256*1024*1024,`RSS increase ${largestRSS-before}`);assert.deepEqual(await readdir(dir),[]);
 }finally{process.availableMemory=available;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test('HTTP 429 keeps Retry-After and malformed trailing envelope never applies partially',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-full-http-'));let mode='429',applied=0;
 const server=createServer((_req,res)=>{if(mode==='429'){res.writeHead(429,{'Retry-After':'30'});res.end('PRIVATE');}else res.end(JSON.stringify({Body:[row(1)],Header:{Errors:['PRIVATE']}}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const opts={url:'http://127.0.0.1:'+(server.address() as {port:number}).port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},async apply(){applied++;},limits:{responseBytes:1024*1024}};
 try{await assert.rejects(fullSnapshot(opts),(e:{diagnostic:{httpStatus:number;retryAfterMs:number}})=>e.diagnostic.httpStatus===429&&e.diagnostic.retryAfterMs===30000);mode='bad';await assert.rejects(fullSnapshot(opts));assert.equal(applied,0);assert.deepEqual(await readdir(dir),[]);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test('planned Stop uses official SDK Distribution/Stop and verifies off without reading a queue',{timeout:6000},async()=>{
 const{clients}=await import('./provider.js');const paths:string[]=[];let on=true;
 const server=createServer(async(req,res)=>{for await(const _b of req){}paths.push(req.url!);res.setHeader('Content-Type','application/json');if(req.url==='/Distribution/Stop'){on=false;res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{Message:'Distribution is: Stopped'}}));}else res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{IsDistributionOn:on}}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{const api=clients({lane:'prematch',packageId:4511,username:'isolated',password:'isolated',hostname:'unused',vhost:'unused',queue:'unused',port:5672,tls:false},{snapshotUrl:url,customersUrl:url});await api.stopDistribution!();assert.deepEqual(paths,['/Package/GetDistributionStatus','/Distribution/Stop','/Package/GetDistributionStatus']);await api.stopDistribution!();assert.equal(paths.filter(p=>p==='/Distribution/Stop').length,1);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('compressed transport is bounded by decoded bytes, never ACKs/applies a decompression overflow',async()=>{
 const{gzipSync}=await import('node:zlib');const dir=await mkdtemp(join(tmpdir(),'adl-full-gzip-'));let large=false,applied=0;
 const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json','Content-Encoding':'gzip'});res.end(gzipSync(JSON.stringify({Header:{HttpStatusCode:200},Body:[{...row(1),Padding:large?'x'.repeat(2000):''}]})));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const opts={url:'http://127.0.0.1:'+(server.address() as {port:number}).port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},async apply(){applied++;},limits:{responseBytes:1024}};
 try{const result=await fullSnapshot(opts);assert.equal(result.rows,1);assert.equal(applied,1);large=true;await assert.rejects(fullSnapshot(opts),(e:{diagnostic:{reason:string}})=>e.diagnostic.reason==='response_size_limit');assert.equal(applied,1);assert.deepEqual(await readdir(dir),[]);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test('captured fixture 20563979 Markets:null and equivalent Bets:null preserve absence, never invent quotes; other shapes reject',()=>{
 const event=convertSnapshotRow({...row(20563979),Markets:null});assert.equal(event.fixtureId,20563979);assert.equal(event.markets,null);assert.ok(event.fixture);
 const empty=convertSnapshotRow({...row(2),Markets:[{Id:1,Status:1,Bets:null}]});assert.equal(empty.markets![0].bets,null);
 for(const [Markets,path,type] of [[{},'Markets','object'],['x','Markets','string'],[[null],'Markets[0]','null'],[[[]],'Markets[0]','array'],[[{Id:1,Bets:{}}],'Markets[0].Bets','object'],[[{Id:1,Bets:[null]}],'Markets[0].Bets[0]','null']] as const){
  assert.throws(()=>convertSnapshotRow({...row(20563979),Markets}),(e:any)=>e.diagnostic.snapshotValidation.fieldPath===path&&e.diagnostic.snapshotValidation.actualType===type&&e.diagnostic.snapshotValidation.fixtureId===20563979);
 }
});

test('whole document validates multiple null occurrences; invalid later market prevents ALL application',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-null-document-'));let invalid=false,applied=0;
 const rows=()=>[{...row(20563979),Markets:null},{...row(2),Markets:[{Id:1,Bets:null}]},row(3),{...row(4),Markets:invalid?{}:null}];
 const server=createServer((_req,res)=>res.end(JSON.stringify({Body:rows(),Header:{HttpStatusCode:200}})));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const opts={url:'http://127.0.0.1:'+(server.address() as {port:number}).port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},async apply(){applied++;},limits:{responseBytes:1024*1024}};
 try{invalid=true;await assert.rejects(fullSnapshot(opts));assert.equal(applied,0);invalid=false;const result=await fullSnapshot(opts);assert.equal(result.rows,4);assert.deepEqual([...result.ids],[20563979,2,3,4]);assert.equal(applied,4);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('null collections preserve stored settlement evidence but never refresh old odds; concurrent fresh AMQP survives reconciliation',async()=>{
 const {TradeState}=await import('./state.js');const {checkpoint,restore}=await import('./persistence.js');const {createPublisher}=await import('@lsports/feed-store');
 const dir=await mkdtemp(join(tmpdir(),'adl-null-prices-')),file=join(dir,'feed.json');
 const now=Date.now(),state=new TradeState();state.set('prematch',{phase:'connected'});
 const seed={FixtureId:20563979,Fixture:{Status:1,Sport:{Id:6046,Name:'Football'},Participants:[{Id:1,Name:'A',Position:'1'},{Id:2,Name:'B',Position:'2'}]},Markets:[{Id:1,Status:1,Bets:[{Id:'11',Name:'1',Price:'2.1',Status:1,LastUpdate:new Date(now-1000).toISOString()},{Id:'12',Name:'2',Price:'3.1',Status:1,Settlement:2,LastUpdate:new Date(now-1000).toISOString()}]}]};
 state.apply('prematch',[convertSnapshotRow(seed)],now);assert.equal(state.feed(now).events[0].selections.filter(s=>s.available).length,1);
 try{for(const Markets of [null,[{Id:1,Status:1,Bets:null}]]){
  state.beginPartitionedSnapshot('prematch');state.apply('prematch',[{...convertSnapshotRow({...seed,Markets}),marketRecovery:true}],now+1,{source:'snapshot',receivedAt:now+1});state.finishPartitionedSnapshot('prematch',new Set([20563979]));
  assert.equal(state.feed(now+1).events[0].selections.filter(s=>s.available).length,0);assert.equal(state.rows.prematch.get(20563979)!.markets.get('1')!.bets!.find(b=>b.id==='12')!.settlement,2);
 }
 await createPublisher(file)(state.feed(now+1),checkpoint(state));const restarted=new TradeState();await restore(restarted,file);restarted.set('prematch',{phase:'connected'});assert.equal(restarted.feed(now+1).events[0].selections.filter(s=>s.available).length,0);
 state.beginPartitionedSnapshot('prematch');state.apply('prematch',[convertSnapshotRow({...seed,Markets:[{Id:1,Status:1,Bets:[{Id:'11',Price:'2.2',Status:1,LastUpdate:new Date(now+5).toISOString()}]}]})],now+10,{source:'amqp',receivedAt:now+10});
 state.apply('prematch',[{...convertSnapshotRow({...seed,Markets:null}),marketRecovery:true}],now+1,{source:'snapshot',receivedAt:now+12});state.finishPartitionedSnapshot('prematch',new Set([20563979]));assert.equal(state.feed(now+12).events[0].selections.filter(s=>s.available).length,1);assert.equal(state.feed(now+12).events[0].selections.find(s=>s.available)!.odds,2.2);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('HTTP coordinator is released before local snapshot validation/application; InPlay respects spacing without waiting for PreMatch apply',async()=>{
 const {SnapshotScheduler}=await import('./snapshot-scheduler.js');const dir=await mkdtemp(join(tmpdir(),'adl-http-scope-'));let now=Date.now(),otherRequests=0;
 const pm=new SnapshotScheduler('http://isolated',4511,{root:join(dir,'feed'),now:()=>now}),ip=new SnapshotScheduler('http://isolated',4510,{root:join(dir,'feed'),now:()=>now});
 const server=createServer((_req,res)=>res.end(JSON.stringify({Body:[{...row(20563979),Markets:null},row(2)],Header:{HttpStatusCode:200}})));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const stages:string[]=[];
 try{await fullSnapshot({url:'http://127.0.0.1:'+(server.address() as {port:number}).port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},downloadGate:download=>pm.run('snapshot.events',download),progress:p=>stages.push(p.stage),limits:{responseBytes:1024*1024},async apply(){
  if(!otherRequests){await assert.rejects(ip.run('snapshot.events',async()=>assert.fail('spacing cannot be bypassed')),(e:any)=>e.diagnostic.rateLimitSource==='local_host_cooldown'&&e.diagnostic.httpStatus===undefined);now+=15000;await ip.run('snapshot.events',async()=>{otherRequests++;});}
 }});assert.equal(otherRequests,1);assert.ok(stages.indexOf('validate')<stages.indexOf('apply'));assert.equal(stages.at(-1),'complete');}
 finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('disk-spool guard preserves 320 MiB working reserve and refuses exhausted available memory',()=>{const original=process.availableMemory;try{process.availableMemory=()=>768*1024*1024;fullSnapshotMemory();process.availableMemory=()=>64*1024*1024;assert.throws(()=>fullSnapshotMemory(),(e:any)=>e.diagnostic.reason==='memory_budget_exceeded'&&e.diagnostic.memoryBudgetBytes===320*1024*1024);}finally{process.availableMemory=original;}});

test('dense tokens cross chunks while durable consumer progress and timer turns continue',async()=>{
 const {coalescedPersistence}=await import('./connected.js');const dir=await mkdtemp(join(tmpdir(),'adl-dense-concurrent-'));const file=join(dir,'body');let timerTurns=0,acks=0,durable=0,received=0,chain=Promise.resolve();
 const bets=Array.from({length:300},(_,i)=>({Id:String(i+1),Price:'2.00',Status:1}));
 await writeFile(file,JSON.stringify({Body:Array.from({length:200},(_,i)=>({...row(i+1),Markets:[{Id:1,Bets:bets}]})),Header:{}}));
 const {open,readFile}=await import('node:fs/promises');const save=coalescedPersistence(async()=>{const captured=received;const fd=await open(join(dir,'journal'),'w');try{await fd.writeFile(JSON.stringify({captured}));await fd.sync();}finally{await fd.close();}durable=captured;});
 const clock=setInterval(()=>timerTurns++,1);const consumer=setInterval(()=>{chain=chain.then(async()=>{const delivery=++received;await save();assert.ok(durable>=delivery);assert.ok(JSON.parse(await readFile(join(dir,'journal'),'utf8')).captured>=delivery);acks++;});},5);
 try{let rows=0;await walkSnapshot(file,async raw=>{convertSnapshotRow(raw);rows++;});assert.equal(rows,200);assert.ok(timerTurns>1);clearInterval(consumer);await chain;assert.ok(acks>0);}finally{clearInterval(clock);clearInterval(consumer);await chain;await rm(dir,{recursive:true,force:true});}
});

test('checkpoint envelope is streamed by nested fixture; per-fixture and malformed-envelope guards remain',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-private-envelope-')),file=join(dir,'body');
 try{
  const fixture={fixtureId:1,padding:'x'.repeat(80)};
  const document={mode:'connected',events:[],workerCheckpoint:{version:1,regular:[fixture,fixture,fixture],outright:[fixture]}};
  await writeFile(file,JSON.stringify(document));let regular=0,outright=0;
  const metadata=await walkSnapshot(file,async()=>{},128,'events',async(_,r)=>{r?regular++:outright++;}) as any;
  assert.equal(regular,3);assert.equal(outright,1);assert.deepEqual(metadata.header,{version:1,regular:[],outright:[]});
  await writeFile(file,JSON.stringify({...document,workerCheckpoint:{...document.workerCheckpoint,regular:[{padding:'x'.repeat(300)}]}}));
  await assert.rejects(walkSnapshot(file,async()=>{},128,'events'));
  for(const workerCheckpoint of ['{"version":1,"outright":[],"regular":[],"regular":[]}','{"version":1,"outright":[],"regular":{}}','{"version":1,"outright":[],"regular":[],}']){
   await writeFile(file,'{"mode":"connected","events":[],"workerCheckpoint":'+workerCheckpoint+'}');
   await assert.rejects(walkSnapshot(file,async()=>{},128,'events'));
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('checkpoint metadata streams aggregates but rejects malformed grammar, giant scalar and excessive nesting',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-metadata-')),file=join(dir,'body');
 try{
  const base='"mode":"connected","events":[],"workerCheckpoint":{"version":1,"outright":[]}';
  await writeFile(file,'{'+base+',"ticketOutcomes":'+JSON.stringify(Array.from({length:100},()=>({description:'x'.repeat(80)})))+'}');await walkSnapshot(file,async()=>{},128,'events');
  for(const bad of ['[1,]','{"a":}','{"a":true,}','{"a" 1}','[true false]','"'+'x'.repeat(200)+'"','['.repeat(130)+'0'+']'.repeat(130)]){
   await writeFile(file,'{'+base+',"ticketOutcomes":'+bad+'}');await assert.rejects(walkSnapshot(file,async()=>{},128,'events'));
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('dense record tokenization stays within 256 MiB heap without retaining all token fragments',{timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-dense-tokens-')),file=join(dir,'body');
 try{
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  await writeFile(file,'{"Header":{},"Body":[{"FixtureId":1,"Fixture":{},"denseValues":['+'0,'.repeat(5999999)+'0]}]}');
  const code=`import{walkSnapshot}from${JSON.stringify(new URL('./full-snapshot.ts',import.meta.url).href)};let count=0;await walkSnapshot(${JSON.stringify(file)},async row=>{count=row.denseValues.length});console.log(JSON.stringify({count,maxRSS:process.resourceUsage().maxRSS*1024}));`;
  const {stdout}=await promisify(execFile)(process.execPath,['--max-old-space-size=256','--import','tsx','--input-type=module','-e',code],{timeout:90000,maxBuffer:4096});
  const result=JSON.parse(stdout);assert.equal(result.count,6000000);assert.ok(result.maxRSS>0);assert.ok(result.maxRSS<384*1024**2);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('memory deferral reports heap vs physical budget and the actual validated prefix without partial application',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-full-memory-prefix-'));const previous=process.availableMemory;let samples=0,applied=0;const progress:any[]=[];
 const server=createServer((_req,res)=>res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:Array.from({length:12},(_,i)=>row(i+1))})));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  process.availableMemory=()=>++samples<=2?512*1024**2:0;
  await assert.rejects(fullSnapshot({url:'http://127.0.0.1:'+(server.address() as any).port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},progress:p=>progress.push(p),limits:{memoryWaitMs:0},async apply(){applied++;}}),(error:any)=>{
   assert.equal(error.diagnostic.reason,'memory_budget_exceeded');assert.equal(error.diagnostic.memoryBudgetBytes,320*1024**2);assert.equal(error.diagnostic.snapshotMemory.availableMemoryBytes,0);assert.equal(error.diagnostic.snapshotMemory.limitingFactor,'available_memory');return true;
  });assert.equal(progress.at(-1).stage,'validate');assert.equal(progress.at(-1).validatedRows,10);assert.equal(progress.at(-1).appliedRows,0);assert.equal(applied,0);
 }finally{process.availableMemory=previous;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('transient physical pressure keeps one complete spool, allows independent work, then fully validates/applies without another HTTP request',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-spool-pressure-'));const available=process.availableMemory;let requests=0,gateEnded=false,workTicks=0,applied=0,release=false;const stages:any[]=[];
 const server=createServer((_req,res)=>{requests++;res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:Array.from({length:23},(_,i)=>row(i+1))}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const ticker=setInterval(()=>workTicks++,2);
 try{
  process.availableMemory=()=>!gateEnded||release?512*1024**2:264994816;
  const task=fullSnapshot({url:'http://127.0.0.1:'+(server.address() as any).port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},downloadGate:async download=>{await download();gateEnded=true;},progress:p=>stages.push(p),limits:{memoryWaitMs:1000,memoryRetryMs:20},async apply(){applied++;}});
  await new Promise(r=>setTimeout(r,80));assert.equal(applied,0);assert.equal(requests,1);assert.equal((await readdir(dir)).length,1);assert.ok(workTicks>=2);release=true;
  const result=await task;assert.equal(result.rows,23);assert.equal(applied,23);assert.equal(requests,1);assert.equal(stages.at(-1).stage,'complete');assert.deepEqual(await readdir(dir),[]);
 }finally{clearInterval(ticker);process.availableMemory=available;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('persistent pressure and disconnection cannot turn retained spool into a partial baseline',async()=>{
 for(const cancel of [false,true]){
  const dir=await mkdtemp(join(tmpdir(),'adl-spool-abort-'));const available=process.availableMemory;let downloaded=false,applied=0;const abort=new AbortController();
  const server=createServer((_req,res)=>res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:[row(1)]})));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
   process.availableMemory=()=>downloaded?0:512*1024**2;
   const task=fullSnapshot({url:'http://127.0.0.1:'+(server.address() as any).port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},signal:abort.signal,downloadGate:async download=>{await download();downloaded=true;},limits:{memoryWaitMs:80,memoryRetryMs:10},async apply(){applied++;}});
   if(cancel)setTimeout(()=>abort.abort(),30);
   await assert.rejects(task,(e:any)=>cancel?e.name==='AbortError':e.diagnostic.reason==='memory_budget_exceeded');assert.equal(applied,0);assert.deepEqual(await readdir(dir),[]);
  }finally{process.availableMemory=available;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
 }
});

test('large snapshot tolerates bounded stream pauses while the independent total deadline remains finite',async()=>{
 assert.equal(FULL_SNAPSHOT_LIMITS.idleMs,60000);assert.equal(FULL_SNAPSHOT_LIMITS.totalMs,12*60*1000);
 const previous=process.availableMemory;process.availableMemory=()=>1024**3;
 const payload=JSON.stringify({Header:{HttpStatusCode:200},Body:[row(901)]});
 try{for(const pauseMs of [30,100]){
  const dir=await mkdtemp(join(tmpdir(),'adl-snapshot-idle-'));let applied=0;
  const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write(payload.slice(0,Math.floor(payload.length/2)));setTimeout(()=>res.end(payload.slice(Math.floor(payload.length/2))),pauseMs);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
   const task=fullSnapshot({url:'http://127.0.0.1:'+(server.address() as any).port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},limits:{idleMs:60,totalMs:1000},async apply(){applied++;}});
   if(pauseMs<60){const result=await task;assert.equal(result.rows,1);assert.equal(applied,1);}
   else{await assert.rejects(task,(error:any)=>error?.message==='Snapshot idle timeout');assert.equal(applied,0);}
   assert.deepEqual(await readdir(dir),[]);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
 }}finally{process.availableMemory=previous;}
});

test('apply progress exposes the first completed row before the next 100-row checkpoint',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'adl-apply-progress-'));const original=process.availableMemory;process.availableMemory=()=>1024**3;
 const server=createServer((_req,res)=>res.end(JSON.stringify({Body:Array.from({length:100},(_,i)=>row(i+1)),Header:{HttpStatusCode:200}})));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const progress:import('./full-snapshot.js').FullSnapshotProgress[]=[];let applied=0;
 try{
  const result=await fullSnapshot({url:'http://127.0.0.1:'+(server.address() as {port:number}).port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory,assertOpen(){},progress:p=>progress.push(p),async apply(){
   if(applied===99){assert.equal(progress.at(-1)?.stage,'apply');assert.equal(progress.at(-1)?.appliedRows,1);}
   applied++;
  }});
  assert.equal(applied,100);assert.equal(result.rows,100);assert.equal(progress.at(-1)?.appliedRows,100);assert.equal(progress.at(-1)?.stage,'complete');
 }finally{process.availableMemory=original;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});}
});

test('bounded snapshot jobs preserve fixture order, publish first completion and avoid one processing barrier per fixture',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-snapshot-batch-'));const original=process.availableMemory;process.availableMemory=()=>1024**3;
 const server=createServer((_req,res)=>res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:Array.from({length:101},(_,i)=>row(i+1))})));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const received:number[]=[];const sizes:number[]=[];const progress:any[]=[];
 try{const result=await fullSnapshot({url:'http://127.0.0.1:'+(server.address() as any).port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},async apply(){assert.fail('batch sink must be used');},async applyBatch(rows){assert.ok(rows.length<=16);sizes.push(rows.length);received.push(...rows.map(r=>r.fixtureId));},progress:p=>progress.push(p)});
  assert.deepEqual(received,Array.from({length:101},(_,i)=>i+1));assert.equal(result.rows,101);assert.equal(sizes.length,7);assert.equal(progress.find(p=>p.stage==='apply'&&p.appliedRows>0).appliedRows,16);assert.equal(progress.at(-1).appliedRows,101);
 }finally{process.availableMemory=original;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('InPlay full snapshot uses the SDK request shape once and keeps the existing response cap',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-inplay-full-spool-'));let calls=0,applied=0;
 const available=process.availableMemory;process.availableMemory=()=>768*1024*1024;const previousFlag=process.env.LSPORTS_INPLAY_STREAMED_SNAPSHOT;
 const server=createServer(async(req,res)=>{calls++;let text='';for await(const b of req)text+=b;const body=JSON.parse(text);assert.equal(req.url,'/Inplay/GetEvents');assert.deepEqual(Object.keys(body).sort(),['packageId','password','username']);res.end(JSON.stringify({Body:[row(91)],Header:{HttpStatusCode:200}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const result=await fullSnapshot({lane:'inplay',url:'http://127.0.0.1:'+(server.address() as {port:number}).port,credentials:{packageId:4510,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},async apply(){applied++;},limits:{responseBytes:128*1024*1024}});
  assert.equal(calls,1);assert.equal(result.rows,1);assert.equal(applied,1);assert.equal(FULL_SNAPSHOT_LIMITS.responseBytes,2*1024*1024*1024);
  const {clients}=await import('./provider.js');process.env.LSPORTS_INPLAY_STREAMED_SNAPSHOT='true';
  const api=clients({lane:'inplay',packageId:4510,username:'isolated',password:'isolated',hostname:'unused',vhost:'unused',queue:'unused',port:5672,tls:false},{snapshotUrl:'http://127.0.0.1:1',customersUrl:'http://127.0.0.1:1'});assert.equal(typeof api.snapshotFull,'function');
 }finally{if(previousFlag===undefined)delete process.env.LSPORTS_INPLAY_STREAMED_SNAPSHOT;else process.env.LSPORTS_INPLAY_STREAMED_SNAPSHOT=previousFlag;process.availableMemory=available;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test('InPlay spool memory reserve checks both heap and container headroom',()=>{const original=process.availableMemory;try{process.availableMemory=()=>768*1024*1024;fullSnapshotMemory('inplay');process.availableMemory=()=>64*1024*1024;assert.throws(()=>fullSnapshotMemory('inplay'),(e:any)=>e.diagnostic.reason==='memory_budget_exceeded'&&e.diagnostic.memoryBudgetBytes===320*1024*1024&&e.diagnostic.snapshotMemory.limitingFactor==='available_memory');}finally{process.availableMemory=original;}});
