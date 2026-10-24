import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {setTimeout as sleep} from 'node:timers/promises';
import {session,publicationCaptureTurn,coalescedPersistence} from './connected.js';import {TradeState} from './state.js';import {connectDurableMq,openInbox} from './durable-ingress.mjs';import {persistRegularCheckpoint,streamCheckpoint,restore} from './persistence.js';import {createPublisher} from '@lsports/feed-store';
const pkg={lane:'prematch',packageId:4511,username:'test',password:'test',hostname:'unused',queue:'unused',vhost:'unused',tls:false,port:5672} as any;
async function until(check:()=>boolean){const end=Date.now()+8000;while(!check()){if(Date.now()>end)throw Error('isolated test deadline');await sleep(5);}}
test('14 applied messages retire durably while decode 15 remains blocked; no need to finish the 4096-row batch',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-partial-pressure-')),path=join(dir,'feed.json'),dbPath=path+'.prematch.inbox.sqlite',state=new TradeState(),abort=new AbortController();
 let actor:any,metrics:any,release!:()=>void,blocked=false,calls=0;const gate=new Promise<void>(r=>release=r);const publish=createPublisher(path);
 const save=coalescedPersistence(id=>publicationCaptureTurn(state,async stable=>{const {regular,...saved}=streamCheckpoint(stable);await persistRegularCheckpoint(path,stable);await publish(stable.projection(Date.now(),false),{...saved,regularExternal:true});},id));
 const api={async startDistribution(){},async stopDistribution(){},async distributionStatus(){return{isDistributionOn:true}},async snapshot(){return []},async catalog(){return []}};
 const task=session(pkg,{staleMs:3600000,recoveryMs:300000} as any,state,save,abort.signal,{connect:null as any,clientFactory:()=>api as any,durableConnect:async(p,db,onMetrics)=>actor=await connectDurableMq(p,db,m=>{metrics=m;onMetrics?.(m)},{offline:true,deferTransport:true})},dbPath);void task.catch(()=>{});
 try{
  await until(()=>state.connections.prematch.phase==='connected');await sleep(30);
  const mutate=state.publicationMutation.bind(state);
  // Deterministic reproduction of an outstanding reserve wait on the next
  // decode, with real SQLite, atomic publications and private checkpoint readback.
  state.publicationMutation=async(operation:any,waiting:any)=>{if(++calls===15){blocked=true;await gate;}return mutate(operation,waiting);};
  actor.offline(Array.from({length:100},(_,i)=>({content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'partial-'+i,ServerTimestamp:Date.now()},Body:{Events:[{FixtureId:1,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Price:String(2+i/1000),Status:1,IsChanged:1}]}]}]}})),properties:{headers:{MessageType:3}},fields:{}})));
  await until(()=>blocked);await until(()=>metrics?.checkpointed===14);
  assert.equal(calls,15);assert.equal(metrics.processed,14);
  const db=openInbox(dbPath);assert.equal(db.stats().backlog,86,'only the durable processed prefix may retire');db.close();
  const recovered=new TradeState();await restore(recovered,path);assert.equal(recovered.rows.prematch.get(1)?.markets.get('1')?.bets?.[0].price,'2.013');
 }finally{abort.abort();release();await task.catch(()=>{});await actor?.close();await rm(dir,{recursive:true,force:true});}
});
