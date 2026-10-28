import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {setTimeout as sleep} from 'node:timers/promises';
import {connectDurableMq,openInbox} from './durable-ingress.mjs';import {connectionCloser} from './connection-closer.js';
import {session,publicationCaptureTurn,coalescedPersistence} from './connected.js';import {TradeState} from './state.js';import {persistRegularCheckpoint,streamCheckpoint,restore} from './persistence.js';import {createPublisher} from '@lsports/feed-store';
async function until(check:()=>boolean,ms=10000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw Error('isolated condition deadline');await sleep(10);}}
const pkg={lane:'prematch',packageId:4511,username:'isolated',password:'isolated',hostname:'unused',queue:'unused',vhost:'unused',tls:false,port:5672} as any;
test('transport close joins actor and releases inbox ownership before another session; stale metrics stop',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-actor-cleanup-')),path=join(dir,'inbox.sqlite');let actor:any,next:any,count=0;
 try{
  actor=await connectDurableMq(pkg,path,()=>count++,{offline:true});
  await assert.rejects(connectDurableMq(pkg,path,()=>{},{offline:true}),/INBOX_ACTOR_ALREADY_OWNED/);
  const close=connectionCloser(actor,{joinLocalResources:true});actor.emit('close');await close();const closedCount=count;await sleep(1100);assert.equal(count,closedCount,'an ended session must not leave a metrics-emitting SQLite actor');
  next=await connectDurableMq(pkg,path,()=>{},{offline:true});await next.close();
 }finally{await actor?.close();await next?.close();await rm(dir,{recursive:true,force:true});}
});
for(const persistFails of [false,true])test(`transport closes during captured checkpoint: ${persistFails?'failed write retains all raw rows':'committed prefix retires before actor exit'}`,{timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-final-prefix-')),path=join(dir,'feed.json'),inbox=path+'.prematch.inbox.sqlite';const state=new TradeState(),abort=new AbortController();
 let actor:any,latest:any,began=false,hold=true,release!:()=>void;const gate=new Promise<void>(r=>release=r);let saves=0;
 const publish=createPublisher(path);
 const save=coalescedPersistence(()=>publicationCaptureTurn(state,async stable=>{
  if(hold&&stable.metrics.prematch.messages>0){hold=false;began=true;await gate;if(persistFails)throw Error('isolated EIO before checkpoint commit');}
  const {regular,...saved}=streamCheckpoint(stable);await persistRegularCheckpoint(path,stable);await publish(stable.projection(Date.now(),false),{...saved,regularExternal:true});saves++;
 }));
 const api={async startDistribution(){},async stopDistribution(){},async distributionStatus(){return {isDistributionOn:true}},async snapshot(){return []},async catalog(){return []}};
 let task:Promise<void>|undefined;
 try{
  task=session(pkg,{packages:[pkg],staleMs:3600000,recoveryMs:300000} as any,state,save,abort.signal,{connect:null as any,clientFactory:()=>api as any,durableConnect:async(p,db,onMetrics)=>actor=await connectDurableMq(p,db,m=>{latest=m;onMetrics?.(m);},{offline:true})},inbox);void task.catch(()=>{});
  await until(()=>state.connections.prematch.phase==='connected');
  actor.offline(Array.from({length:100},(_,i)=>({content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'isolated-'+i,ServerTimestamp:Date.now()},Body:{Events:[{FixtureId:1,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Price:'2.80',Status:1,IsChanged:1}]}]}]}})),properties:{headers:{MessageType:3}},fields:{redelivered:false}})));
  await until(()=>began);actor.emit('close');
  const before=openInbox(inbox);assert.equal(before.stats().backlog,100,'broker ACKed raw rows cannot retire before business persistence');before.close();
  release();await assert.rejects(task);const db=openInbox(inbox);assert.equal(db.stats().backlog,persistFails?100:99,'only the captured prefix may retire; the uncaptured raw suffix stays replayable');if(!persistFails)assert.equal(db.peek(99).length,99);db.close();
  assert.ok(saves>0);if(!persistFails){assert.equal(latest.checkpointed,1);const recovered=new TradeState();await restore(recovered,path);assert.equal(recovered.rows.prematch.get(1)?.markets.get('1')?.bets?.[0].price,'2.80');}
  if(persistFails){
   const replayState=new TradeState();await restore(replayState,path);const replayAbort=new AbortController();let replayActor:any,replayMetrics:any;
   const replaySave=coalescedPersistence(()=>publicationCaptureTurn(replayState,async stable=>{const {regular,...saved}=streamCheckpoint(stable);await persistRegularCheckpoint(path,stable);await publish(stable.projection(Date.now(),false),{...saved,regularExternal:true});}));
   const replayTask=session(pkg,{packages:[pkg],staleMs:3600000,recoveryMs:300000} as any,replayState,replaySave,replayAbort.signal,{connect:null as any,clientFactory:()=>api as any,durableConnect:async(p,db,onMetrics)=>replayActor=await connectDurableMq(p,db,m=>{replayMetrics=m;onMetrics?.(m);},{offline:true})},inbox);void replayTask.catch(()=>{});
   try{
    await until(()=>replayMetrics?.checkpointed===100);const beforeFresh=openInbox(inbox);assert.equal(beforeFresh.stats().backlog,0);beforeFresh.close();
    replayActor.offline([{content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'new-session-update',ServerTimestamp:Date.now()},Body:{Events:[{FixtureId:1,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Price:'3.10',Status:1,IsChanged:1}]}]}]}})),properties:{headers:{MessageType:3}},fields:{}}]);
    await until(()=>replayMetrics?.checkpointed===101);assert.notEqual(replayMetrics.ingressActorId,latest.ingressActorId);assert.ok(Date.now()-Date.parse(replayMetrics.metricWindowEndUTC)<2000);
    const checked=new TradeState();await restore(checked,path);assert.equal(checked.rows.prematch.get(1)?.markets.get('1')?.bets?.[0].price,'3.10');
   }finally{replayAbort.abort();await replayTask.catch(()=>{});await replayActor?.close();}
  }
  // Reopen is possible immediately after session cleanup, never alongside an orphan.
  const reopened=await connectDurableMq(pkg,inbox,()=>{},{offline:true});await reopened.close();
 }finally{release();abort.abort();await task?.catch(()=>{});await actor?.close();await rm(dir,{recursive:true,force:true});}
});
test('distribution propagation is followed by AMQP connection before any slow publication of observations',{timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-connect-order-')),path=join(dir,'inbox.sqlite');const state=new TradeState(),abort=new AbortController();let actor:any,started=false,calls=0,blocked=false,release!:()=>void;
 const gate=new Promise<void>(r=>release=r);
 const save=async()=>{if(++calls===2){blocked=true;await gate;}};
 const api={async startDistribution(){started=true;},async stopDistribution(){},distributionObservations(){return [{stage:'after_propagation',bodyIsDistributionOn:true}];},async snapshot(){return []},async catalog(){return []}};
 const task=session(pkg,{packages:[pkg],staleMs:3600000,recoveryMs:300000} as any,state,save,abort.signal,{connect:null as any,clientFactory:()=>api as any,durableConnect:async(p,db,onMetrics)=>{actor=await connectDurableMq(p,db,onMetrics,{offline:true,deferTransport:true});const activate=actor.activateTransport.bind(actor);actor.activateTransport=async()=>{assert.equal(started,true);return activate();};return actor;}},path);void task.catch(()=>{});
 try{await until(()=>blocked);assert.ok(actor,'a slow observation publication cannot delay opening the consumer');assert.ok(state.connections.prematch.consumerProgress?.registeredAt);}
 finally{release();abort.abort();await task.catch(()=>{});await actor?.close();await rm(dir,{recursive:true,force:true});}
});
