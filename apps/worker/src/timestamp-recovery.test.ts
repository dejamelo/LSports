import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,access,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {TradeState} from './state.js';
import {decodeMessage} from './messages.js';
import {checkpoint,restore} from './persistence.js';
import {planTimestampRecovery,applyTimestampRecovery} from './timestamp-recovery.js';
import {createPublisher} from '@lsports/feed-store';
import {TicketStore} from '@lsports/feed-store/tickets';
import {clients} from './provider.js';
import type {PackageConfig} from './config.js';
const fixtureId=900283,competitionId=900111;
function receive(state:TradeState,type:number,version:number,at:number,ids=['1','2'],price:string|null='2.6233',settlement?:number){
 const body={Competition:{Id:competitionId,Events:[{FixtureId:fixtureId,Markets:[{Id:160,Name:'Race Winner',Status:type===42?3:1,Bets:ids.map(Id=>({Id,Status:1,Price:price===null?undefined:price,Settlement:settlement,LastUpdate:new Date(version).toISOString()}))}]}]}};
 const decoded=decodeMessage(Buffer.from(JSON.stringify({Header:{Type:type,MsgGuid:`isolated-${type}-${at}`,ServerTimestamp:at},Body:body})));state.apply('prematch',decoded.events,decoded.at);
}
test('selective recovery backs up both tickets, quarantines future versions, accepts fresh explicit AMQP and settles without changing accepted odds',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-safe-recovery-')),path=join(dir,'feed.json'),database=join(dir,'tickets.sqlite'),now=Date.now();const tickets=new TicketStore(database);const publish=createPublisher(path);
 try{
  const state=new TradeState();state.apply('prematch',[{fixtureId,outright:{competitionId,fixture:{fixtureName:'ISOLATED recovery',sport:{name:'Horse Racing'},status:1,participants:[{id:1,name:'Test one'},{id:2,name:'Test two'}]}}}],now-200000);
  receive(state,41,now-180000,now-180000);state.set('prematch',{phase:'connected'});const e=state.feed().events[0];
  const accepted=e.selections.map((s,i)=>tickets.create({stakeMinor:10000,selections:[{eventId:e.id,marketId:e.markets![0].id,selectionId:s.id,expectedOdds:2.6233}]},`isolated-ticket-${i}`,()=>state.feed()));
  const future=now+3*3600000,receivedAt=now-120000;
  receive(state,41,future,receivedAt,undefined,undefined,0);
  const row=state.rows.prematch.get(`outright:${competitionId}:${fixtureId}`)!;
  // Recreate historical checkpoint evidence from before raw timestamp capture existed.
  for(const id of ['1','2']){const trace=row.settlementAudit!.get(`160:${id}`)!;trace.lastSnapshot={...trace.last41!,source:'snapshot.outright.markets'};delete trace.lastSnapshot.timestamp;}
  tickets.reconcile(state.feed()); // Old unsettled outcome index also acquired the future version.
  for(let i=0;i<accepted.length;i++)accepted[i]=tickets.get(accepted[i].id)!;
  receive(state,41,now-10000,now-1000,['1'],'3.10');
  assert.equal(row.marketReceipt?.staleBetUpdates,1);await publish(state.feed(),checkpoint(state));
  const bytes=await readFile(path);const plan=await planTimestampRecovery(path,fixtureId,160,now);assert.equal(plan.candidates.length,1);assert.equal(plan.candidates[0].selectionId,'1');assert.equal(plan.excluded[0].selectionId,'2');assert.deepEqual(await readFile(path),bytes);
  await writeFile(`${path}.lock`,'isolated-existing-owner');
  await assert.rejects(()=>applyTimestampRecovery(path,database,fixtureId,160,now),/Stop the worker/);
  assert.equal(await readFile(`${path}.lock`,'utf8'),'isolated-existing-owner');await rm(`${path}.lock`);
  const result=await applyTimestampRecovery(path,database,fixtureId,160,now);assert.equal(result.ticketsModified,false);assert.deepEqual(await readFile(join(result.backup,'feed.before.json')),bytes);
  const backed=new DatabaseSync(join(result.backup,'tickets.before.sqlite'),{readOnly:true});try{assert.equal((backed.prepare('SELECT count(*) AS n FROM tickets').get() as {n:number}).n,2);}finally{backed.close();}
  assert.deepEqual(tickets.list().tickets.sort((a,b)=>a.id.localeCompare(b.id)),[...accepted].sort((a,b)=>a.id.localeCompare(b.id)));await assert.rejects(()=>access(`${path}.lock`));
  const restarted=new TradeState();await restore(restarted,path);restarted.set('prematch',{phase:'connected'});const quote=()=>restarted.feed().events[0].selections.find(s=>s.id.endsWith(':1'))!;
  assert.equal(quote().available,false);assert(quote().unavailableReasons?.includes('awaiting_timestamp_recovery'));assert.equal(quote().odds,2.6233);
  assert.equal((await planTimestampRecovery(path,fixtureId,160,now)).candidates.length,0);
  const prepared=await readFile(path);await assert.rejects(()=>applyTimestampRecovery(path,database,fixtureId,160,now),/No eligible/);assert.deepEqual(await readFile(path),prepared);
  tickets.reconcile(restarted.feed());assert.deepEqual(tickets.get(accepted[0].id),accepted[0]);
  // Even an explicitly zoned future quote cannot poison the recovered baseline again.
  receive(restarted,41,future,now+1,['1'],'9.99',0);assert.equal(quote().available,false);assert.equal(quote().odds,2.6233);
  // Snapshot confirmations cannot reopen a quarantined legacy quote.
  const snapshotMessage=decodeMessage(Buffer.from(JSON.stringify({Header:{Type:41,MsgGuid:'isolated-snapshot',ServerTimestamp:now+1},Body:{Competition:{Id:competitionId,Events:[{FixtureId:fixtureId,Markets:[{Id:160,Status:1,Bets:[{Id:'1',Status:1,Price:'8.88',LastUpdate:new Date(future).toISOString()}]}]}]}}})));
  restarted.apply('prematch',snapshotMessage.events.map(e=>({...e,marketMessageType:undefined,marketRecovery:true})),now+1);assert.equal(quote().available,false);assert.equal(quote().odds,2.6233);
  // A status-only message cannot clear the quarantine.
  receive(restarted,41,now-5000,now+1,['1'],null,0);assert.equal(quote().available,false);
  // A new, explicitly zoned quote newer than the recovered baseline is required.
  receive(restarted,41,now-5000,now+2,['1'],'3.20',0);assert.equal(quote().available,true);assert.equal(quote().odds,3.2);
  assert.equal(restarted.rows.prematch.get(`outright:${competitionId}:${fixtureId}`)?.timestampRecovery?.get('160:1')?.status,'validated_amqp');
  tickets.reconcile(restarted.feed());assert.deepEqual(tickets.get(accepted[0].id),accepted[0]);
  await publish(restarted.feed(),checkpoint(restarted));const twice=new TradeState();await restore(twice,path);assert.equal(twice.feed().events[0].selections[0].available,false); // restart still requires fresh confirmation
  receive(restarted,42,now+3,now+3,['1'],null,2);tickets.reconcile(restarted.feed());const settled=tickets.get(accepted[0].id)!;assert.equal(settled.status,'WON');assert.equal(settled.payoutMinor,26233);assert.equal(settled.selections[0].acceptedOdds,2.6233);assert.equal(settled.revision,accepted[0].revision+1);tickets.reconcile(restarted.feed());assert.equal(tickets.get(accepted[0].id)?.revision,accepted[0].revision+1);assert.deepEqual(tickets.get(accepted[1].id),accepted[1]);
 }finally{tickets.close();await rm(dir,{recursive:true,force:true});}
});
test('six-fixture snapshot isolates one invalid-calendar selection, identifies IDs and preserves it across restart while applying five safe fixtures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-isolate-snapshot-'));const path=join(dir,'feed.json');const now=Date.now();
 const body=Array.from({length:6},(_,i)=>({FixtureId:900280+i,Markets:[{Id:160,Status:1,Bets:[{Id:String(i+1),Price:'2.63',Status:1,LastUpdate:i===3?'2026-02-30T00:19:34.10384':new Date(now-1000).toISOString()}]}]}));
 const http=createServer(async(req,res)=>{for await(const _chunk of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:[{Id:competitionId,Events:body}]}));});await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const a=http.address();assert(a&&typeof a!=='string');const url=`http://127.0.0.1:${a.port}`;
 try{
  const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false};
  const api=clients(pkg,{snapshotUrl:url,customersUrl:url},{run:async(_op,action)=>action()});const events=await api.outrightMarkets!([900280,900281,900282,900283,900284,900285]);assert.equal(events.length,6);assert.equal(events.reduce((n,e)=>n+e.markets![0].bets!.length,0),5);
  const rejected=api.outrightTimestampRejections!();assert.equal(rejected.length,1);assert.deepEqual(rejected[0].context,{competitionId,fixtureId:900283,marketId:160,selectionId:'4'});
  const state=new TradeState();for(const event of events)state.apply('prematch',[{fixtureId:event.fixtureId,outright:{competitionId,fixture:{sport:{name:'Horse Racing'},status:1}}}],now-2000);state.apply('prematch',events,now);state.set('prematch',{phase:'connected'});
  assert.equal(state.feed().events.flatMap(e=>e.selections).filter(s=>s.available).length,5);await createPublisher(path)(state.feed(),checkpoint(state));const restored=new TradeState();await restore(restored,path);const row=restored.rows.prematch.get(`outright:${competitionId}:900283`)!;assert.equal(row.deferredTimestampBets?.get('160:4')?.inspection.rawLastUpdate,'2026-02-30T00:19:34.10384');assert.equal(row.deferredTimestampBets?.get('160:4')?.bet.price,'2.63');
  const d=restored.feed().outrightDiagnostics!.find(d=>d.fixtureId===900283)!;assert.equal(d.markets![0].timestampRejections![0].context?.selectionId,'4');
 }finally{await new Promise<void>(r=>http.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
test('replays seven previously rejected explicit settlements through parser/state and normal ticket settlement, idempotently, preserving a second ticket',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-settlement-replay-')),path=join(dir,'feed.json'),database=join(dir,'tickets.sqlite'),now=Date.now();const tickets=new TicketStore(database);const publish=createPublisher(path);
 try{
  const state=new TradeState();state.apply('prematch',[{fixtureId,outright:{competitionId,fixture:{fixtureName:'ISOLATED seven-settlement replay',sport:{name:'Horse Racing'},status:1,participants:Array.from({length:8},(_,i)=>({id:i+1,name:`Test runner ${i+1}`}))}}}],now-10000000);
  const ids=Array.from({length:8},(_,i)=>String(i+1));ids[0]='3160611920540564';receive(state,41,now-10000000,now-10000000,ids);state.set('prematch',{phase:'connected'});const event=state.feed().events[0];
  const green=tickets.create({stakeMinor:10000,selections:[{eventId:event.id,marketId:event.markets![0].id,selectionId:event.selections[0].id,expectedOdds:2.6233}]},'isolated-existing-green',()=>state.feed());
  const other=tickets.create({stakeMinor:5000,selections:[{eventId:event.id,marketId:event.markets![0].id,selectionId:event.selections[7].id,expectedOdds:2.6233}]},'isolated-other-ticket',()=>state.feed());
  const snapshotReceived=now-7200000,future=snapshotReceived+3*3600000;
  receive(state,41,future,snapshotReceived,ids);
  const row=state.rows.prematch.get(`outright:${competitionId}:${fixtureId}`)!;
  for(const id of ids){const trace=row.settlementAudit!.get(`160:${id}`)!;trace.lastSnapshot={...trace.last41!,source:'snapshot.outright.markets'};delete trace.lastSnapshot.timestamp;}
  // The seven official results arrived an hour ago: they must not expire like quotes.
  const received=now-3600000,version=received-137;receive(state,42,version,received,ids.slice(0,7),null,1);
  assert.equal(row.marketReceipt?.staleBetUpdates,7);assert(ids.slice(0,7).every(id=>row.settlementAudit!.get(`160:${id}`)?.last42?.decision==='ignored_older'));tickets.reconcile(state.feed());assert.deepEqual(tickets.get(green.id),green);
  await publish(state.feed(),checkpoint(state));const original=await readFile(path);
  const plan=await planTimestampRecovery(path,fixtureId,160,now,'settlements');assert.equal(plan.candidates.length,7);assert(plan.candidates.every(c=>c.settlement?.code===1));
  const applied=await applyTimestampRecovery(path,database,fixtureId,160,now,'settlements');assert.equal(applied.status,'settlement_replayed_awaiting_normal_reconciliation');assert.deepEqual(await readFile(join(applied.backup,'feed.before.json')),original);assert.deepEqual(tickets.get(green.id),green);assert.deepEqual(tickets.get(other.id),other);
  const restarted=new TradeState();await restore(restarted,path);const results=restarted.feed().events[0].selections;
  assert.equal(results.filter(s=>s.settlement===1).length,7);assert.equal(results[7].settlement,undefined);assert(results.every(s=>!s.available));
  assert.equal(restarted.rows.prematch.get(`outright:${competitionId}:${fixtureId}`)?.marketReceipt?.messagesByType['42'],1); // no fabricated AMQP delivery counts
  tickets.reconcile(restarted.feed());const settled=tickets.get(green.id)!;assert.equal(settled.status,'LOST');assert.equal(settled.revision,1);assert.equal(settled.payoutMinor,0);assert.equal(settled.selections[0].acceptedOdds,2.6233);assert.deepEqual(tickets.get(other.id),other);
  tickets.reconcile(restarted.feed());assert.equal(tickets.get(green.id)?.revision,1);const repeated=await planTimestampRecovery(path,fixtureId,160,now,'settlements');assert.equal(repeated.candidates.length,0);await assert.rejects(()=>applyTimestampRecovery(path,database,fixtureId,160,now,'settlements'),/No eligible/);
  assert.equal(tickets.get(green.id)?.revision,1);assert.deepEqual(tickets.get(other.id),other);
 }finally{tickets.close();await rm(dir,{recursive:true,force:true});}
});
