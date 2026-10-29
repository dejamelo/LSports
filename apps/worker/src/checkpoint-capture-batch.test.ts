import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {setTimeout as sleep} from 'node:timers/promises';
import {session,publicationCaptureTurn,coalescedPersistence,checkpointBeforeProjection,deferPublicProjection,heartbeatPublicationDue,durableInboxBacklog,shouldDeferRoutineSnapshot,routineSnapshotDeferral,checkpointBatchThresholdForLane,INPLAY_CHECKPOINT_BATCH_THRESHOLD,PREMATCH_CHECKPOINT_BATCH_THRESHOLD,PREMATCH_CHECKPOINT_BATCH_FLUSH_MS} from './connected.js';import {TradeState} from './state.js';import {connectDurableMq,openInbox} from './durable-ingress.mjs';import {persistRegularCheckpoint,streamCheckpoint,restore} from './persistence.js';import {createPublisher} from '@lsports/feed-store';
const pkg={lane:'prematch',packageId:4511,username:'test',password:'test',hostname:'unused',queue:'unused',vhost:'unused',tls:false,port:5672} as any;
test('PreMatch commits a bounded durable delta batch inside the public freshness window',()=>{assert.equal(PREMATCH_CHECKPOINT_BATCH_THRESHOLD,512);assert.equal(PREMATCH_CHECKPOINT_BATCH_FLUSH_MS,5000);});
test('InPlay full checkpoint cadence does not rewrite the multi-GB state every 32 control rows',()=>{assert.equal(INPLAY_CHECKPOINT_BATCH_THRESHOLD,4096);assert.equal(checkpointBatchThresholdForLane('prematch'),512);assert.equal(checkpointBatchThresholdForLane('inplay'),4096);});
test('initial dual-feed recovery defers the full public projection until a baseline exists',async()=>{
 const state=new TradeState(),startedAt=new Date().toISOString();
 for(const lane of ['prematch','inplay'] as const)state.set(lane,{phase:'recovering',session:{id:`initial-${lane}`,startedAt},recoveryProgress:{stage:'snapshot',startedAt,regularSnapshotReady:false}});
 assert.equal(deferPublicProjection(state),true);
 let projectionBuilt=false;
 await checkpointBeforeProjection(async()=>({saved:true}),()=>{projectionBuilt=true;return {};},deferPublicProjection(state));
 assert.equal(projectionBuilt,false,'the first session save must not rebuild the multi-GB public graph before either snapshot');
 for(const lane of ['prematch','inplay'] as const)state.set(lane,{recoveryProgress:{stage:'waiting_retry',startedAt,regularSnapshotReady:false}});
 assert.equal(deferPublicProjection(state),true,'rate-limited retries must keep the stale public projection gated while both lanes lack a validated baseline');
 state.set('inplay',{phase:'connected',recoveryProgress:{stage:'idle',startedAt,regularSnapshotReady:true}});
 assert.equal(deferPublicProjection(state),false,'a healthy feed keeps publishing while only the other lane is recovering');
});
test('durable backlog reserves full-state serialization for retireable checkpoint batches',()=>{
 const state=new TradeState();state.set('prematch',{ingressProgress:{received:20,acknowledged:0,processed:20,backlog:20,bytes:0,oldestAgeMs:0,receivedBytes:0,lastReceiveAt:null,lastAckAt:null,durableCommitMs:0,rssBytes:0,ingressMaxEventLoopDelayMs:0,metricWindowStartUTC:'',metricWindowEndUTC:'',headersByType:{}} as any});
 assert.equal(durableInboxBacklog(state),20);assert.equal(heartbeatPublicationDue(state,0,120000),false);
 state.set('prematch',{ingressProgress:{...state.connections.prematch.ingressProgress!,backlog:0}});assert.equal(heartbeatPublicationDue(state,0,120000),true);
 assert.equal(shouldDeferRoutineSnapshot(false,900000),false,'initial/reconnect baseline remains mandatory');
 assert.equal(shouldDeferRoutineSnapshot(true,PREMATCH_CHECKPOINT_BATCH_THRESHOLD+1),true);
 assert.equal(shouldDeferRoutineSnapshot(true,PREMATCH_CHECKPOINT_BATCH_THRESHOLD),false);
 const due=300000, longHandoffAt=620000, backlog=PREMATCH_CHECKPOINT_BATCH_THRESHOLD+1;
 const deferredUntil=routineSnapshotDeferral(true,backlog,due,longHandoffAt);
 assert.equal(deferredUntil,longHandoffAt+60000,'a snapshot whose due time elapsed during a long handoff must be deferred again');
 assert.equal(routineSnapshotDeferral(true,backlog,deferredUntil,deferredUntil-1),undefined,'do not retry before the new deferral expires');
 assert.equal(routineSnapshotDeferral(true,backlog,deferredUntil,deferredUntil),deferredUntil+60000,'recheck and defer again while the backlog remains');
 assert.equal(routineSnapshotDeferral(true,PREMATCH_CHECKPOINT_BATCH_THRESHOLD,due,longHandoffAt),undefined,'allow the refresh once durable backlog is below the threshold');
 assert.equal(heartbeatPublicationDue(state,0,120000,false,false),false,'unchanged state needs no multi-gigabyte heartbeat rewrite');
 assert.equal(heartbeatPublicationDue(state,0,120000,false,true),true,'a mutation still enables the recovery heartbeat');
});
test('mutation generation excludes persistence telemetry and freezes at publication capture',async()=>{
 const state=new TradeState();assert.equal(state.mutationGeneration,0);
 state.set('prematch',{persistenceProgress:{} as any});assert.equal(state.mutationGeneration,0);
 state.set('prematch',{phase:'recovering'});assert.equal(state.mutationGeneration,1);
 const captured=state.capturePublication();
 try{await state.publicationMutation(()=>state.set('prematch',{phase:'connected'}));assert.equal(captured.state.mutationGeneration,1);assert.equal(state.mutationGeneration,2);}
 finally{captured.release();}
});
async function until(check:()=>boolean){const end=Date.now()+15000;while(!check()){if(Date.now()>end)throw Error('isolated test deadline');await sleep(5);}}
test('private checkpoint completes before the full public projection is materialized',async()=>{
 const order:string[]=[],stages:string[]=[];const result=await checkpointBeforeProjection(async()=>{order.push('checkpoint:start');await sleep(10);order.push('checkpoint:durable');return 22;},()=>{assert.equal(order.at(-1),'checkpoint:durable');order.push('projection:materialized');return {events:1};},false,stage=>stages.push(stage));
 assert.deepEqual(order,['checkpoint:start','checkpoint:durable','projection:materialized']);assert.deepEqual(stages,['projection.build']);assert.equal(result.checkpointResult,22);assert.deepEqual(result.projection,{events:1});
});
test('deferred public projection skips materialization after the private checkpoint',async()=>{
 const order:string[]=[],stages:string[]=[];const result=await checkpointBeforeProjection(async()=>{order.push('checkpoint:durable');return 23;},()=>{order.push('projection:materialized');return {events:1};},true,stage=>stages.push(stage));
 assert.deepEqual(order,['checkpoint:durable']);assert.deepEqual(stages,['checkpoint.projection_deferred']);assert.equal(result.checkpointResult,23);assert.equal('projection'in result,false);
});
test('durable inbox remains received but unprocessed while a full snapshot is validated',{timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-snapshot-validation-gate-')),path=join(dir,'feed.json'),dbPath=path+'.prematch.inbox.sqlite',state=new TradeState(),abort=new AbortController();
 let actor:any,metrics:any,entered!:()=>void,release!:()=>void;const snapshotEntered=new Promise<void>(r=>entered=r),validationGate=new Promise<void>(r=>release=r);
 const save=coalescedPersistence(()=>publicationCaptureTurn(state,async stable=>{const{regular,...saved}=streamCheckpoint(stable);await persistRegularCheckpoint(path,stable);await createPublisher(path)(stable.projection(Date.now(),false),{...saved,regularExternal:true});}));
 const api:any={async startDistribution(){},async stopDistribution(){},async distributionStatus(){return{isDistributionOn:true}},async snapshot(){assert.fail('full recovery only');},async catalog(){return[];},snapshotFull:async(options:any)=>{
  options.progress?.({stage:'validate',bytes:865000000,validatedRows:1400,appliedRows:0,lastProgressAt:new Date().toISOString(),httpStatus:200});entered();await validationGate;
  options.progress?.({stage:'apply',bytes:865000000,validatedRows:41303,appliedRows:0,lastProgressAt:new Date().toISOString(),httpStatus:200});
  await options.apply({fixtureId:900001,fixture:{status:1,sport:{name:'Football'}},markets:[{id:1,status:1,bets:[{id:'1',price:'2.0',status:1}]}]},Date.now());
  options.progress?.({stage:'complete',bytes:865000000,validatedRows:41303,appliedRows:1,lastProgressAt:new Date().toISOString(),httpStatus:200});return{ids:new Set([900001]),rows:41303,bytes:865000000};
 }};
 const task=session(pkg,{packages:[pkg],snapshotUrl:'https://snapshot.invalid',customersUrl:'https://customers.invalid',recoveryMs:300000,staleMs:90000} as any,state,save,abort.signal,{connect:null as any,clientFactory:()=>api,durableConnect:async(p:any,db:string,onMetrics:any)=>actor=await connectDurableMq(p,db,m=>{metrics=m;onMetrics?.(m)},{offline:true,deferTransport:true}),checkpointBatchThreshold:8,checkpointBatchFlushMs:1000},dbPath);void task.catch(()=>{});
 try{
  await snapshotEntered;const rows=Array.from({length:8},(_,i)=>({content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:`during-snapshot-${i}`,ServerTimestamp:Date.now()+i},Body:{Events:[{FixtureId:900001,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Price:String(2+i/10),Status:1,IsChanged:1}]}]}]}})),properties:{headers:{MessageType:3}},fields:{}}));
  actor.offline(rows);await until(()=>metrics?.received===8);assert.equal(metrics.processed,0,'snapshot validation must not race a second full-state checkpoint');assert.equal(metrics.checkpointed,0);
  const inbox=openInbox(dbPath);assert.equal(inbox.stats().backlog,8,'all received rows remain durable and unacknowledged');inbox.close();
  release();await until(()=>metrics?.checkpointed===8);const drained=openInbox(dbPath);assert.equal(drained.stats().backlog,0);drained.close();
 }finally{release();abort.abort();await task.catch(()=>{});await actor?.close();await rm(dir,{recursive:true,force:true});}
});
test('only active snapshot mutation defers public projection; a recovering lane remains individually blocked',()=>{
 const state=new TradeState();assert.equal(deferPublicProjection(state),false);
 const recoveryAt=new Date().toISOString();state.set('prematch',{phase:'recovering',session:{id:'isolated-recovery',startedAt:recoveryAt},recoveryProgress:{stage:'snapshot',startedAt:recoveryAt,regularSnapshotReady:false}});
 assert.equal(deferPublicProjection(state),false,'the recovering lane is unavailable by phase and must not stall the other feed');
 state.set('prematch',{session:undefined,recoveryProgress:undefined,phase:'starting'});
 state.set('prematch',{fullSnapshot:{method:'disk_spool_two_pass',startedAt:new Date().toISOString()}});assert.equal(deferPublicProjection(state),true);
 state.set('prematch',{fullSnapshot:{method:'disk_spool_two_pass',startedAt:new Date().toISOString(),stage:'waiting_http'}});assert.equal(deferPublicProjection(state),true);
 state.set('prematch',{phase:'connected',recoveryProgress:{stage:'idle',startedAt:recoveryAt,regularSnapshotReady:true},fullSnapshot:{method:'disk_spool_two_pass',startedAt:new Date().toISOString(),stage:'apply',appliedRows:1}});assert.equal(deferPublicProjection(state),false,'periodic refreshes leave indexed publication open against the live baseline');
 state.set('prematch',{phase:'starting',recoveryProgress:undefined,fullSnapshot:{method:'disk_spool_two_pass',startedAt:new Date().toISOString(),stage:'waiting_http',appliedRows:0}});
 state.set('prematch',{lastSnapshotErrorAt:new Date().toISOString()});assert.equal(deferPublicProjection(state),false,'a rejected request before apply releases the projection gate');
 state.set('prematch',{fullSnapshot:{method:'disk_spool_two_pass',startedAt:new Date().toISOString(),stage:'apply',bytes:10,validatedRows:1,appliedRows:1,lastProgressAt:new Date().toISOString()}});
 assert.equal(deferPublicProjection(state),true);
 state.set('prematch',{fullSnapshot:{...state.connections.prematch.fullSnapshot!,stage:'complete'}});assert.equal(deferPublicProjection(state),true);
 state.set('prematch',{fullSnapshot:{...state.connections.prematch.fullSnapshot!,completedAt:new Date().toISOString()}});
 assert.equal(deferPublicProjection(state),false);
});
test('stale durable backlog defers the masked public projection but a fresh nonempty tail does not',()=>{
 const state=new TradeState(),startedAt=new Date().toISOString();
 for(const lane of ['prematch','inplay'] as const)state.set(lane,{phase:'connected',recoveryProgress:{stage:'idle',startedAt,regularSnapshotReady:true}});
 const ingress={received:1000,acknowledged:1000,processed:900,checkpointed:800,backlog:200,processingBacklog:100,oldestAgeMs:7000,oldestProcessingAgeMs:7000,bytes:0,receivedBytes:0,lastReceiveAt:null,lastAckAt:null,durableCommitMs:0,rssBytes:0,ingressMaxEventLoopDelayMs:0,metricWindowStartUTC:'',metricWindowEndUTC:'',headersByType:{}};
 state.set('prematch',{ingressProgress:ingress as any});
 assert.equal(deferPublicProjection(state),true,'all selections are already masked after the five-second freshness limit');
 state.set('prematch',{ingressProgress:{...ingress,oldestProcessingAgeMs:5000} as any});
 assert.equal(deferPublicProjection(state),false,'publication resumes at the freshness boundary without waiting for backlog zero');
});
for(const fail of [false,true])test(`queued checkpoint reserves the complete applied prefix before next capture; ${fail?'failed persistence retains all rows':'commit retires only durable captured rows'}`,{timeout:25000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-capture-batch-')),path=join(dir,'feed.json'),dbPath=path+'.prematch.inbox.sqlite',state=new TradeState(),abort=new AbortController();
 let actor:any,metrics:any,block=false,busy=false,release!:()=>void,capturedDataWrites=0,failDataWrite=fail;
 const gate=new Promise<void>(r=>release=r);const publish=createPublisher(path);
 const save=coalescedPersistence(id=>publicationCaptureTurn(state,async stable=>{
  if(block){block=false;busy=true;await gate;}
  if(stable.metrics.prematch.messages>0){capturedDataWrites++;if(failDataWrite)throw Error('ISOLATED_ATOMIC_WRITE_FAILURE');}
  const {regular,...saved}=streamCheckpoint(stable);await persistRegularCheckpoint(path,stable);await publish(stable.projection(Date.now(),false),{...saved,regularExternal:true});
 },id));
 const api={async startDistribution(){},async stopDistribution(){},async distributionStatus(){return{isDistributionOn:true}},async snapshot(){return []},async catalog(){return []}};
 const task=session(pkg,{staleMs:3600000,recoveryMs:300000} as any,state,save,abort.signal,{connect:null as any,clientFactory:()=>api as any,durableConnect:async(p,db,onMetrics)=>actor=await connectDurableMq(p,db,m=>{metrics=m;onMetrics?.(m)},{offline:true,deferTransport:true}),checkpointBatchThreshold:8192,checkpointBatchFlushMs:1000},dbPath);void task.catch(()=>{});
 try{
  await until(()=>state.connections.prematch.phase==='connected');await sleep(50);
  block=true;const preceding=save();await until(()=>busy);
  const rows=Array.from({length:8192},(_,i)=>({content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'capture-'+i,ServerTimestamp:Date.now()},Body:{Events:[{FixtureId:1,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Price:String(2+i/100000),Status:1,IsChanged:1}]}]}]}})),properties:{headers:{MessageType:3}},fields:{}}));
  actor.offline(rows);await until(()=>metrics?.processed===8192);
  assert.equal(metrics.checkpointed,0,'preceding capture cannot confirm later mutations');
  const before=openInbox(dbPath);assert.equal(before.stats().backlog,8192);before.close();
  release();await preceding;
  if(fail){await until(()=>state.connections.prematch.phase==='error');abort.abort();await task.catch(()=>{});const db=openInbox(dbPath);assert.equal(db.stats().backlog,8192);db.close();}
  else{
   await until(()=>metrics?.checkpointed===8192);
   assert.equal(capturedDataWrites,1,'all applied rows fit the same post-request capture, not several full publications');
   const db=openInbox(dbPath);assert.equal(db.stats().backlog,0);db.close();
   const recovered=new TradeState();await restore(recovered,path);assert.equal(recovered.rows.prematch.get(1)?.markets.get('1')?.bets?.[0].price,String(2+8191/100000));
  }
 }finally{release();abort.abort();await task.catch(()=>{});await actor?.close();await rm(dir,{recursive:true,force:true});}
});
test('a caller arriving after capture start must await a later publication',async()=>{
 let release!:()=>void,started=false;const gate=new Promise<void>(r=>release=r);let captures=0,reservedAt=0;
 const save=coalescedPersistence(async()=>{captures++;if(captures===1){started=true;await gate;}});
 const earlier=save();await until(()=>started);const next=save.beforeCapture(id=>{reservedAt=id;});assert.equal(reservedAt,0);release();await earlier;await next;assert.equal(reservedAt,2);assert.equal(captures,2);
});
