import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createServer} from 'node:http';import {once} from 'node:events';
import {walkSnapshot,convertSnapshotRow,fullSnapshot} from './full-snapshot.js';
const row=(FixtureId:number)=>({FixtureId,Fixture:{Status:1,LastUpdate:'2026-10-19T14:00:00.0173136'},Markets:[]});
test('bounded envelope parser validates ordering, trailing Header, UTF8 and rejects truncation, duplicate root and application errors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-full-envelope-'));try{const file=join(dir,'body');
 await writeFile(file,JSON.stringify({Body:[{...row(1),Fixture:{...row(1).Fixture,Name:'Hipódromo {"} }}'}},row(2)],Header:{HttpStatusCode:200}}));let n=0;await walkSnapshot(file,async raw=>{assert.ok(convertSnapshotRow(raw).fixture);n++;});assert.equal(n,2);
 for(const text of ['{"Body":[', '{"Header":{},"Body":[],"Body":[]}','{"Header":{},"Body":null}','{"Header":{"Errors":["PRIVATE"]},"Body":[]}','{"Header":{},"Body":[]} trailing','{"Header":{},"Body":[{},]}','{"Header":{},"Body":[],"Extra":'+'['.repeat(129)+'0'+']'.repeat(129)+'}']){await writeFile(file,text);await assert.rejects(walkSnapshot(file,async()=>{}));}
 await writeFile(file,JSON.stringify({Header:{},Body:[{FixtureId:1,Fixture:{},Extra:'x'.repeat(1024)}]}));await assert.rejects(walkSnapshot(file,async()=>{},256));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('full HTTP >256 MiB is spooled, not aggregated; exact unfiltered SDK request and bounded item conversion',{timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-full-volume-'));let applied=0,largestRSS=process.memoryUsage().rss;const before=largestRSS;
 const count=260,padding='x'.repeat(1024*1024);let mode='valid';
 const server=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;const request=JSON.parse(text);assert.equal(req.url,'/Prematch/GetEvents');assert.deepEqual(Object.keys(request).sort(),['packageId','password','username']);assert.equal(request.packageId,4511);res.setHeader('Content-Type','application/json');
 res.write('{"Body":[');for(let i=1;i<=count;i++){const data=(i>1?',':'')+JSON.stringify({...row(i),Padding:padding});if(!res.write(data))await once(res,'drain');}res.end('],"Header":'+JSON.stringify(mode==='valid'?{HttpStatusCode:200}:{Errors:['PRIVATE']})+'}');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const opts={url,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},async apply(r:ReturnType<typeof convertSnapshotRow>){assert.equal(r.fixtureId,++applied);largestRSS=Math.max(largestRSS,process.memoryUsage().rss);},limits:{responseBytes:280*1024*1024}};
 try{const result=await fullSnapshot(opts);assert.ok(result.bytes>256*1024*1024);assert.equal(result.rows,count);assert.equal(applied,count);assert.ok(largestRSS-before<256*1024*1024,`RSS increase ${largestRSS-before}`);assert.deepEqual(await readdir(dir),[]);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
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
