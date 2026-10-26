import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {setTimeout as sleep} from 'node:timers/promises';
import {session,publicationCaptureTurn,coalescedPersistence,checkpointBeforeProjection,deferPublicProjectionDuringSnapshot,PREMATCH_CHECKPOINT_BATCH_THRESHOLD,PREMATCH_CHECKPOINT_BATCH_FLUSH_MS} from './connected.js';import {TradeState} from './state.js';import {connectDurableMq,openInbox} from './durable-ingress.mjs';import {persistRegularCheckpoint,streamCheckpoint,restore} from './persistence.js';import {createPublisher} from '@lsports/feed-store';
const pkg={lane:'prematch',packageId:4511,username:'test',password:'test',hostname:'unused',queue:'unused',vhost:'unused',tls:false,port:5672} as any;
test('offline batch policy matches the deployed PreMatch bounds',()=>{assert.equal(PREMATCH_CHECKPOINT_BATCH_THRESHOLD,32768);assert.equal(PREMATCH_CHECKPOINT_BATCH_FLUSH_MS,120000);});
async function until(check:()=>boolean){const end=Date.now()+15000;while(!check()){if(Date.now()>end)throw Error('isolated test deadline');await sleep(5);}}
test('private checkpoint completes before the full public projection is materialized',async()=>{
 const order:string[]=[];const result=await checkpointBeforeProjection(async()=>{order.push('checkpoint:start');await sleep(10);order.push('checkpoint:durable');return 22;},()=>{assert.equal(order.at(-1),'checkpoint:durable');order.push('projection:materialized');return {events:1};});
 assert.deepEqual(order,['checkpoint:start','checkpoint:durable','projection:materialized']);assert.equal(result.checkpointResult,22);assert.deepEqual(result.projection,{events:1});
});
test('snapshot application defers full public projection until the verified baseline is complete',()=>{
 const state=new TradeState();assert.equal(deferPublicProjectionDuringSnapshot(state),false);
 state.set('prematch',{fullSnapshot:{method:'disk_spool_two_pass',startedAt:new Date().toISOString()}});assert.equal(deferPublicProjectionDuringSnapshot(state),false);
 state.set('prematch',{fullSnapshot:{method:'disk_spool_two_pass',startedAt:new Date().toISOString(),stage:'waiting_http'}});assert.equal(deferPublicProjectionDuringSnapshot(state),true);
 state.set('prematch',{fullSnapshot:{method:'disk_spool_two_pass',startedAt:new Date().toISOString(),stage:'apply',bytes:10,validatedRows:1,appliedRows:1,lastProgressAt:new Date().toISOString()}});
 assert.equal(deferPublicProjectionDuringSnapshot(state),true);
 state.set('prematch',{fullSnapshot:{...state.connections.prematch.fullSnapshot!,stage:'complete'}});assert.equal(deferPublicProjectionDuringSnapshot(state),true);
 state.set('prematch',{fullSnapshot:{...state.connections.prematch.fullSnapshot!,completedAt:new Date().toISOString()}});
 assert.equal(deferPublicProjectionDuringSnapshot(state),false);
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
