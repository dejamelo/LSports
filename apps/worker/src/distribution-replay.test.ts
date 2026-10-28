import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {connectDurableMq,openInbox} from './durable-ingress.mjs';
import {session,publicationCaptureTurn,coalescedPersistence,PREMATCH_CHECKPOINT_BATCH_THRESHOLD,PREMATCH_CHECKPOINT_BATCH_FLUSH_MS} from './connected.js';
import {TradeState} from './state.js';
import {persistRegularCheckpoint,streamCheckpoint,restore} from './persistence.js';
import {createPublisher} from '@lsports/feed-store';
const pkg={lane:'prematch',packageId:4511,username:'test',password:'test',hostname:'unused',queue:'unused',vhost:'unused',tls:false,port:5672} as any;
async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw Error('test deadline');await sleep(10);}}
for(const failure of [false,true])test(`durable replay and atomic retirement continue while distribution ${failure?'times out':'has not answered'}`,{timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-distribution-replay-')),path=join(dir,'feed.json'),dbPath=path+'.prematch.inbox.sqlite';
 const rows=Array.from({length:100},(_,i)=>({received:Date.now()-86400000,content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'preserved-'+i,ServerTimestamp:Date.now()-86400000},Body:{Events:[{FixtureId:1,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Price:'2.80',Status:1,IsChanged:1}]}]}]}})),properties:{headers:{MessageType:3}},fields:{}}));
 const seed=openInbox(dbPath);seed.append(rows);seed.close();
 const state=new TradeState(),abort=new AbortController();let actor:any,metrics:any,activateCalls=0,attempts=0,gateResolve!:()=>void,gateReject!:(e:Error)=>void;
 const gate=new Promise<void>((r,j)=>{gateResolve=r;gateReject=j});
 const publish=createPublisher(path);
 const save=coalescedPersistence(()=>publicationCaptureTurn(state,async stable=>{const {regular,...saved}=streamCheckpoint(stable);await persistRegularCheckpoint(path,stable);await publish(stable.projection(Date.now(),false),{...saved,regularExternal:true});}));
 const api={async startDistribution(){attempts++;await gate;},async stopDistribution(){},async snapshot(){return []},async catalog(){return []}};
 const task=session(pkg,{staleMs:3600000,recoveryMs:300000} as any,state,save,abort.signal,{connect:null as any,clientFactory:()=>api as any,durableConnect:async(p,db,onMetrics,options)=>{
  assert.equal(options?.deferTransport,true);
  actor=await connectDurableMq(p,db,m=>{metrics=m;onMetrics?.(m)},{offline:true,deferTransport:true});
  const activate=actor.activateTransport.bind(actor);actor.activateTransport=async()=>{activateCalls++;return activate()};return actor;
 },checkpointBatchThreshold:PREMATCH_CHECKPOINT_BATCH_THRESHOLD,checkpointBatchFlushMs:PREMATCH_CHECKPOINT_BATCH_FLUSH_MS},dbPath);void task.catch(()=>{});
 try{
  await until(()=>metrics?.checkpointed===100);
  assert.equal(attempts,1);assert.equal(activateCalls,0,'no network connection before verified distribution');
  assert.equal(state.connections.prematch.consumerProgress?.active,false);
  const db=openInbox(dbPath);assert.equal(db.stats().backlog,0);db.close();
  const recovered=new TradeState();await restore(recovered,path);assert.equal(recovered.rows.prematch.get(1)?.markets.get('1')?.bets?.[0].price,'2.80');
  assert.equal(state.projection(Date.now(),false).coverage?.prematch?.eventsWithSelectableOdds??0,0,'old replay must not release prices without recovery');
  if(failure){gateReject(Object.assign(Error('timeout'),{code:'ECONNABORTED'}));await sleep(30);assert.equal(activateCalls,0);abort.abort();}
  else{gateResolve();await until(()=>state.connections.prematch.consumerProgress?.active===true);assert.equal(activateCalls,1);abort.abort();}
  await task.catch(()=>{});
  // Released only after actor exit; an immediate replacement can own the inbox.
  const reopened=await connectDurableMq(pkg,dbPath,()=>{},{offline:true});await reopened.close();
 }finally{gateResolve();abort.abort();await task.catch(()=>{});await actor?.close();await rm(dir,{recursive:true,force:true});}
});
test('failed deferred AMQP attachment preserves inbox ownership and raw rows until actor is joined',{timeout:10000},async()=>{
 const {createServer}=await import('node:net');const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));
 const dir=await mkdtemp(join(tmpdir(),'adl-deferred-failure-')),path=join(dir,'inbox.sqlite');let actor:any;
 const seed=openInbox(path);seed.append([{received:Date.now(),content:Buffer.from('{}'),properties:{headers:{}},fields:{}}]);seed.close();
 try{
  const local={...pkg,hostname:'127.0.0.1',port};actor=await connectDurableMq(local,path,()=>{},{deferTransport:true});
  await assert.rejects(actor.activateTransport(),(e:any)=>e.ingressStage==='amqp.connect'&&e.code==='ECONNREFUSED');
  await assert.rejects(connectDurableMq(local,path,()=>{},{deferTransport:true}),/INBOX_ACTOR_ALREADY_OWNED/);
  await actor.close();const preserved=openInbox(path);assert.equal(preserved.stats().backlog,1);assert.equal(preserved.peek(1)[0].content.toString(),'{}');preserved.close();
  const next=await connectDurableMq(local,path,()=>{},{deferTransport:true});await next.close();
 }finally{await actor?.close();await rm(dir,{recursive:true,force:true});}
});
