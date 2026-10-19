import {test} from 'node:test';import assert from 'node:assert/strict';
import {partitionedSnapshot,completeInventory,subscriptionInventory,type PartitionSink} from './partitioned-snapshot.js';
import {OperationError} from './diagnostics.js';import {TradeState} from './state.js';
const row=(fixtureId:number)=>({fixtureId,fixture:{status:1,sport:{name:'Football'}}});
function sink(){const applied:number[]=[];const progress:unknown[]=[];const io:PartitionSink={assertOpen(){},async begin(){},async batch(rows){applied.push(...rows.map(r=>r.fixtureId));},async progress(p){progress.push(p);}};return {io,applied,progress};}
test('complete inventory, bounded serial batches, second inventory and no aggregate response array',async()=>{
 const f=sink();let active=0,max=0;const requests:number[][]=[];let inventoryCalls=0;
 const result=await partitionedSnapshot({async inventory(){inventoryCalls++;return [3,1,2];},async events(ids){active++;max=Math.max(max,active);requests.push(ids);await Promise.resolve();active--;return ids.map(row);}},f.io,{batchSize:2});
 assert.deepEqual(requests,[[1,2],[3]]);assert.deepEqual(f.applied,[1,2,3]);assert.equal(inventoryCalls,2);assert.equal(max,1);assert.equal(result.stage,'complete');assert.equal(result.maxResponseBytes,16*1024*1024);
});
test('missing rows, ignored filters, changed inventory and invalid inventory never complete baseline',async()=>{
 for(const mode of ['missing','unexpected','changed']){const f=sink();let n=0;await assert.rejects(partitionedSnapshot({async inventory(){return ++n===2&&mode==='changed'?[1,2]:[1];},async events(){return mode==='missing'?[]:mode==='unexpected'?[row(9)]:[row(1)];}},f.io));assert.ok(!(f.progress as {stage:string}[]).some(p=>p.stage==='complete'));}
 assert.deepEqual(completeInventory([2,1,1]),[1,2]);
 for(const ids of [['1'],[0],null])assert.throws(()=>completeInventory(ids));
});
test('Retry-After is waited without duplicate application; size failure splits with bounded cap',async()=>{
 let now=1000,calls=0;const f=sink();
 const result=await partitionedSnapshot({async inventory(){return [1,2];},async events(ids){calls++;if(calls===1)throw new OperationError({operation:'snapshot.events',protocol:'http',category:'rate_limited',httpStatus:429,retryAt:new Date(5000).toISOString(),message:'isolated'});if(ids.length>1)throw new OperationError({operation:'snapshot.events',protocol:'http',category:'response_limit',reason:'response_size_limit',message:'isolated'});return ids.map(row);}},f.io,{batchSize:2,now:()=>now,wait:async ms=>{now+=ms;}});
 assert.ok(now>=5000);assert.deepEqual(f.applied,[1,2]);assert.equal(result.batches,2);
});
test('empty complete inventory never issues GetEvents with an empty filter',async()=>{
 const f=sink();await partitionedSnapshot({async inventory(){return [];},async events(){assert.fail('Empty filter can mean all events');}},f.io);assert.deepEqual(f.applied,[]);
});
test('partial baseline cannot release old prices; missing old selections stay blocked; outcomes retained',async()=>{
 const state=new TradeState(),at=Date.now();state.apply('prematch',[{...row(1),markets:[{id:1,status:1,bets:[{id:'one',isChanged:1,price:'2.1',status:1},{id:'absent',isChanged:1,price:'5',status:1}]}]}],at);
 state.set('prematch',{phase:'recovering'});state.beginPartitionedSnapshot('prematch');
 state.apply('prematch',[{...row(1),marketRecovery:true,markets:[{id:1,status:1,bets:[{id:'one',isChanged:1,price:'2.1',status:1}]}]}],at+1,{source:'snapshot',receivedAt:at+1});
 assert.ok(state.feed().events.flatMap(e=>(e.markets||[]).flatMap(m=>m.selections)).every(s=>!s.available));
 state.finishPartitionedSnapshot('prematch',new Set([1]));state.set('prematch',{phase:'connected',lastMessageAt:new Date().toISOString()});
 const bets=state.feed().events[0].markets![0].selections;assert.ok(bets.find(b=>b.id.endsWith(':absent'))?.unavailableReasons?.includes('awaiting_update'));
});

test('official SDK sends complete unfiltered subscription inventory and filtered GetEvents; >16 MiB batch splits without increasing cap',{timeout:20000},async()=>{
 const {createServer}=await import('node:http');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {SnapshotScheduler}=await import('./snapshot-scheduler.js');const {clients}=await import('./provider.js');
 const dir=await mkdtemp(join(tmpdir(),'adl-sdk-partitions-')),old=process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT;process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT='true';
 let inventories=0;const filters:number[][]=[];const server=createServer(async(req,res)=>{
  let text='';for await(const data of req)text+=data;const body=JSON.parse(text||'{}'),ids=body.fixtures??body.Fixtures;
  res.on('error',()=>{});res.setHeader('Content-Type','application/json');
  if(!ids){inventories++;res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{Fixtures:[11,12,13]}}));return;}
  assert.ok(Array.isArray(ids)&&ids.length);filters.push(ids);
  const envelope={Header:{HttpStatusCode:200},Body:ids.map((fixtureId:number)=>({FixtureId:fixtureId,Fixture:{Status:1,Sport:{Id:1,Name:'Football'},LastUpdate:'2026-10-19T06:00:00Z'},Markets:[]}))};
  if(ids.length>1)res.end(JSON.stringify({...envelope,Padding:'x'.repeat(17*1024*1024)}));else res.end(JSON.stringify(envelope));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  const pkg={lane:'prematch' as const,packageId:4511,username:'isolated',password:'isolated',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false};const options={root:join(dir,'feed'),spacingMs:0,refreshMs:0};
  const api=clients(pkg,{snapshotUrl:url,customersUrl:url},new SnapshotScheduler(url,4511,options),new SnapshotScheduler(url,4511,options));const f=sink();await api.snapshotPartitioned!(f.io);
  assert.equal(inventories,2);assert.deepEqual(f.applied,[11,12,13]);assert.ok(filters.some(ids=>ids.length>1));assert.ok(filters.filter(ids=>ids.length===1).length===3);assert.equal(api.snapshotAudit?.()?.partition?.complete,true);assert.equal(api.snapshotAudit?.()?.filters,'fixtures');
  assert.equal(clients({...pkg,lane:'inplay'},{snapshotUrl:url,customersUrl:url}).snapshotPartitioned,undefined);
 }finally{if(old===undefined)delete process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT;else process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT=old;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test('cumulative snapshot volume exceeds 256 MiB using bounded SDK batches',{timeout:30000},async()=>{
 const {createServer}=await import('node:http');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {SnapshotScheduler}=await import('./snapshot-scheduler.js');const {clients}=await import('./provider.js');
 const dir=await mkdtemp(join(tmpdir(),'adl-cumulative-')),old=process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT;process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT='true';
 const inventory=Array.from({length:280},(_,i)=>i+1000),chunk='x'.repeat(1024*1024);let sent=0;
 const server=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;const body=JSON.parse(text||'{}'),ids=body.fixtures??body.Fixtures;res.on('error',()=>{});res.setHeader('Content-Type','application/json');
  if(!ids){res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{Fixtures:inventory}}));return;}
  assert.ok(ids.length<=10);const response={Header:{HttpStatusCode:200},Body:ids.map((fixtureId:number)=>({FixtureId:fixtureId,Fixture:{Status:1,Sport:{Id:1,Name:'Football'}}}))};
  res.write(JSON.stringify(response).slice(0,-1)+',"Padding":"');
  for(let i=0;i<ids.length&&!res.destroyed;i++){sent+=chunk.length;if(!res.write(chunk))await new Promise<void>(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});}
  if(!res.destroyed)res.end('"}');
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  const pkg={lane:'prematch' as const,packageId:4511,username:'isolated',password:'isolated',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false},options={root:join(dir,'feed'),spacingMs:0,refreshMs:0};
  const api=clients(pkg,{snapshotUrl:url,customersUrl:url},new SnapshotScheduler(url,4511,options),new SnapshotScheduler(url,4511,options));const f=sink();await api.snapshotPartitioned!(f.io);
  assert.ok(sent>268435456);assert.equal(f.applied.length,inventory.length);assert.equal(new Set(f.applied).size,inventory.length);assert.equal(api.snapshotAudit?.()?.partition?.batches,28);assert.equal(api.snapshotAudit?.()?.partition?.maxResponseBytes,16777216);
 }finally{if(old===undefined)delete process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT;else process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT=old;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test('dense single fixture has finite adaptive 16/32/64 MiB caps and never retries past 64',async()=>{
 const caps:number[]=[];const f=sink();await partitionedSnapshot({async inventory(){return [1];},async events(ids,_id,_part,cap){caps.push(cap);if(cap<64)throw new OperationError({operation:'snapshot.events',protocol:'http',category:'response_limit',reason:'response_size_limit',message:'isolated'});return ids.map(row);}},f.io);
 assert.deepEqual(caps,[16,32,64]);assert.equal((f.progress.at(-1) as {maxResponseBytes:number}).maxResponseBytes,64*1024*1024);
 const rejected:number[]=[];await assert.rejects(partitionedSnapshot({async inventory(){return [1];},async events(_ids,_id,_part,cap){rejected.push(cap);throw new OperationError({operation:'snapshot.events',protocol:'http',category:'response_limit',reason:'response_size_limit',message:'isolated'});}},sink().io));assert.deepEqual(rejected,[16,32,64]);
});

test('snapshot fallback version uses actual HTTP start after cooldown, not the original scheduled attempt',async()=>{
 let now=1000,calls=0,appliedAt=0;const f=sink();f.io.batch=async(_rows,at)=>{appliedAt=at;};
 await partitionedSnapshot({async inventory(){return [1];},async events(ids,_id,_part,_cap,markStarted){if(++calls===1)throw new OperationError({operation:'snapshot.events',protocol:'http',category:'rate_limited',retryAt:new Date(5000).toISOString(),message:'isolated cooldown'});markStarted();return ids.map(row);}},f.io,{now:()=>now,wait:async ms=>{now+=ms;}});
 assert.ok(appliedAt>=5000);
});


test('subscription inventory reports exact contract rejection without leaking IDs, payloads or SDK defaults',()=>{
 assert.deepEqual(subscriptionInventory({fixtures:[3,1,3]},{Body:{Fixtures:[3,1,3]}}),[1,3]);
 for(const [raw,sdk,code] of [[{Body:null},{fixtures:[]},'inventory_envelope'],[{Body:{Fixtures:[1]}},{fixtures:[]},'inventory_sdk_mismatch'],[{Body:{Fixtures:[1,'PRIVATE_STRING',{Id:'PRIVATE_ID'},null]}},{fixtures:[1,'PRIVATE_STRING',{Id:'PRIVATE_ID'},null]},'inventory_invalid_ids']] as const){
  assert.throws(()=>subscriptionInventory(sdk,raw),(e:unknown)=>{assert.ok(e instanceof OperationError);assert.equal(e.diagnostic.snapshotValidation?.code,code);assert.ok(!JSON.stringify(e.diagnostic).includes('PRIVATE'));return true;});
 }
 const items=[1,'PRIVATE_STRING',null];assert.throws(()=>subscriptionInventory({fixtures:items},{Body:{Fixtures:items}}),(e:unknown)=>{assert.ok(e instanceof OperationError);assert.deepEqual(e.diagnostic.snapshotValidation?.itemTypes,{number:1,string:1,null:1});assert.equal(e.diagnostic.snapshotValidation?.invalidCount,2);assert.equal(e.diagnostic.snapshotValidation?.code,'inventory_invalid_ids');assert.ok(!JSON.stringify(e.diagnostic).includes('PRIVATE'));return true;});
 assert.throws(()=>completeInventory(Array(50001).fill(1)),(e:unknown)=>e instanceof OperationError&&e.diagnostic.snapshotValidation?.attribution==='local_bound');
});

test('official SDK invalid inventory is failed inside HTTP reservation, not successful; next attempt preserves cooldown',{timeout:10000},async()=>{
 const {createServer}=await import('node:http');const {mkdtemp,rm,readFile,readdir}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {SnapshotScheduler}=await import('./snapshot-scheduler.js');const {clients}=await import('./provider.js');
 const dir=await mkdtemp(join(tmpdir(),'adl-inventory-invalid-')),old=process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT;process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT='true';let calls=0,inventoryRequests=0,now=1000;
 const server=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{Fixtures:++inventoryRequests===1?['PRIVATE_NOT_NUMERIC_ID']:[12]}}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  const pkg={lane:'prematch' as const,packageId:4511,username:'isolated',password:'isolated',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false},options={root:join(dir,'feed'),spacingMs:0,refreshMs:300000,now:()=>now};
  const coordinator=new SnapshotScheduler(url,4511,options),api=clients(pkg,{snapshotUrl:url,customersUrl:url},coordinator,coordinator),f=sink();
  await assert.rejects(api.snapshotPartitioned!(f.io),(e:unknown)=>{assert.ok(e instanceof OperationError);assert.equal(e.diagnostic.httpStatus,200);assert.equal(e.diagnostic.operation,'subscriptions.list');assert.equal(e.diagnostic.snapshotValidation?.phase,'inventory');assert.equal(e.diagnostic.snapshotValidation?.code,'inventory_invalid_ids');return true;});
  assert.equal(calls,1);assert.equal((f.progress.at(-1) as {stage:string}).stage,'failed');assert.deepEqual(f.applied,[]);
  const journal=JSON.parse(await readFile(join(dir,(await readdir(dir)).find(p=>p.endsWith('.json'))!),'utf8'));assert.equal(journal.requests['4511:subscriptions.list'].outcome,'failed');assert.equal(journal.requests['4511:subscriptions.list'].failure.reason,'invalid_snapshot');assert.equal(journal.requests['4511:subscriptions.list'].failure.snapshotValidation.code,'inventory_invalid_ids');
  await assert.rejects(coordinator.run('subscriptions.list',async()=>{assert.fail('Must retain failed request cooldown');}),(e:unknown)=>e instanceof OperationError&&e.diagnostic.rateLimitSource==='local_operation_cooldown');assert.equal(calls,1);
 }finally{if(old===undefined)delete process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT;else process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT=old;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
