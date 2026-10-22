/** Opt-in cold-process recovery using a synthetic checkpoint from the constrained load test. */
import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';import {setTimeout as sleep} from 'node:timers/promises';
import {restore,checkpoint,streamCheckpoint,persistRegularCheckpoint} from './persistence.js';import {TradeState} from './state.js';
import {session,publicationTurn,coalescedPersistence} from './connected.js';import {createPublisher} from '@lsports/feed-store';
import {openInbox,connectDurableMq} from './durable-ingress.mjs';
test('cold restart: restore dense checkpoint, replay durable raw prefix, reconcile full baseline without the old heap', {skip:!process.env.ADL_COLD_FIXTURE_DIR,timeout:600000},async()=>{
 const dir=process.env.ADL_COLD_FIXTURE_DIR!,path=dir+'/feed.json',inbox=dir+'/inbox.sqlite';
 assert.equal(Number(await readFile('/sys/fs/cgroup/memory.max','utf8')),4294967296);
 const state=new TradeState(),restored=await restore(state,path);assert.equal(restored.rows,16329);
 const at=Date.now();const message={content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'cold-duplicate',ServerTimestamp:at},Body:{Events:[{FixtureId:1,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Price:'3.33',Status:1,IsChanged:1}]}]}]}})),properties:{headers:{MessageType:3}},fields:{redelivered:false}};
 const source=openInbox(inbox);source.append([message,message]);assert.equal(source.stats().backlog,2);source.close();
 const publish=createPublisher(path);let writes=0,latest:any,transport:any,appliedRows=0,fullDone=false;
 const save=coalescedPersistence(()=>publicationTurn(state,async()=>{await persistRegularCheckpoint(path,state);await publish(state.projection(Date.now(),false),{...streamCheckpoint(state),regularExternal:true},state.availabilityBlocks());writes++;}));
 const pkg={lane:'prematch' as const,packageId:4511,username:'isolated',password:'isolated',hostname:'unused',vhost:'unused',queue:'unused',tls:false,port:5672};
 const api={async startDistribution(){},async stopDistribution(){},async distributionStatus(){return{isDistributionOn:true}},async catalog(){return[]},async snapshot(){throw Error('unexpected')},async snapshotFull(sink:any){const ids=new Set<number>();for(const [id,row] of [...state.rows.prematch]){if(row.outright||typeof id!=='number')continue;sink.assertOpen();await sink.apply({fixtureId:id,fixture:row.fixture?.value,livescore:row.livescore?.value,markets:[...row.markets.values()]},at);ids.add(id);appliedRows++;}fullDone=true;return{ids,rows:ids.size,bytes:0}}};
 const abort=new AbortController();const task=session(pkg,{packages:[pkg],snapshotUrl:'http://127.0.0.1/unused',customersUrl:'http://127.0.0.1/unused',staleMs:300000,recoveryMs:300000},state,save,abort.signal,{connect:null as any,clientFactory:()=>api as any,durableConnect:async(p,db,metrics)=>{transport=await connectDurableMq(p,db,m=>{latest=m;metrics?.(m)},{offline:true});return transport;}},inbox);void task.catch(()=>{});
 try{
  const deadline=Date.now()+300000;while(Date.now()<deadline&&(!fullDone||latest?.backlog!==0||state.connections.prematch.phase!=='connected'))await sleep(100);
  assert.equal(fullDone,true);assert.equal(appliedRows,16329);assert.equal(state.connections.prematch.phase,'connected');assert.equal(latest.processed,2);assert.equal(latest.checkpointed,2);assert.equal(latest.backlog,0);
  assert.equal(Number(state.rows.prematch.get(1)!.markets.get('1')!.bets!.find(b=>b.id==='1')!.price),3.33);
  abort.abort();await task;
  const db=openInbox(inbox);assert.equal(db.stats().backlog,0);db.close();
  const result={test:'cold_dense_replay',status:'ok',rows:restored.rows,appliedRows,replayedRawRows:2,duplicateRows:1,checkpointed:latest.checkpointed,writes,cgroupPeakBytes:Number(await readFile('/sys/fs/cgroup/memory.peak','utf8')),awsValidated:false,providerRequests:0,snapshotSource:'synthetic_validated_rows_not_supplier_HTTP'};
  console.log(JSON.stringify(result));if(process.env.ADL_COLD_RESULT)await writeFile(process.env.ADL_COLD_RESULT,JSON.stringify(result,null,2));
 }finally{abort.abort();await task.catch(()=>{});await transport?.close();}
});
