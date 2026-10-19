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
