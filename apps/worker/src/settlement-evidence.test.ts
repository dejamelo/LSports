import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {TradeState} from './state.js';
import {decodeMessage} from './messages.js';
import {clients} from './provider.js';
import {checkpoint,restore} from './persistence.js';
import {inspectSettlements} from './settlement-evidence.js';
import {createPublisher,readConnectedFeed} from '@lsports/feed-store';
import {TicketStore} from '@lsports/feed-store/tickets';
import {createApp} from '../../api/src/app.js';
import type {PackageConfig} from './config.js';
const id=900564,competition=900144;
const bet=(i:number,extra:object={})=>({Id:String(i),Name:`ISOLATED runner ${i}`,ParticipantId:i,Price:'2.6233',Status:1,...extra});
function seed(){const state=new TradeState();state.apply('prematch',[{fixtureId:id,outright:{competitionId:competition,fixture:{fixtureName:'ISOLATED settlement test',sport:{name:'Horse Racing'},status:1,participants:Array.from({length:10},(_,i)=>({id:i+1,name:`ISOLATED runner ${i+1}`}))}}}],Date.now()-1000);receive(state,41,Array.from({length:10},(_,i)=>bet(i+1)));state.set('prematch',{phase:'connected'});return state;}
function receive(state:TradeState,type:number,bets:object[],at=Date.now(),status=1){const decoded=decodeMessage(Buffer.from(JSON.stringify({Header:{Type:type,MsgGuid:`isolated-${type}-${at}`,ServerTimestamp:at},Body:{Competition:{Id:competition,Events:[{FixtureId:id,Markets:[{Id:160,Name:'Race Winner',Status:status,Bets:bets}]}]}}})));state.apply('prematch',decoded.events,decoded.at);return decoded;}
test('numeric settlements survive official 42 conversion, later null/omitted snapshots, persistence and API; seven absent results never become inferred losers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-settlement-evidence-'));const path=join(dir,'feed.json');const tickets=new TicketStore(join(dir,'tickets.sqlite'));let apiServer:ReturnType<ReturnType<typeof createApp>['listen']>|undefined;
 let snapshotBets=Array.from({length:10},(_,i)=>bet(i+1,{Settlement:i===0?2:i<3?1:null}));
 const http=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;assert.deepEqual(JSON.parse(text).fixtures,[id]);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:[{Id:competition,Events:[{FixtureId:id,Markets:[{Id:160,Name:'Race Winner',Status:3,Bets:snapshotBets}]}]}]}));});
 await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const address=http.address();assert(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
 const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false};
 const api=clients(pkg,{snapshotUrl:url,customersUrl:url},{run:async(_operation,action)=>action()});
 try{
  const state=seed(),event=state.feed().events[0],selection=event.selections[3];
  const ticket=tickets.create({stakeMinor:10000,selections:[{eventId:event.id,marketId:event.markets![0].id,selectionId:selection.id,expectedOdds:2.6233}]},'isolated-pending-ticket',()=>state.feed());
  const now=Date.now()+100;
  receive(state,42,[bet(1,{Settlement:2}),bet(2,{Settlement:1}),bet(3,{Settlement:1})],now,3);
  tickets.reconcile(state.feed());assert.deepEqual(tickets.get(ticket.id),ticket); // No actual Madrid ticket is opened or edited.
  let recovered=await api.outrightMarkets!([id]);state.apply('prematch',recovered,now+1);
  let market=state.feed().outrightDiagnostics![0].markets![0];
  assert.equal(market.settlementEvidence?.['snapshot.outright.markets']?.rootNumeric,3);assert.equal(market.settlementEvidence?.['snapshot.outright.markets']?.rootNull,7);
  assert.equal(market.selections.filter(s=>s.settlement===null).length,7);assert.equal(market.selections[3].settlementTrace?.lastSnapshot?.field,'null');assert.equal(market.selections[3].settlementTrace?.last42,undefined);
  // Reproduce the local erasure bug: a later explicit null must not erase the known winner.
  snapshotBets=Array.from({length:10},(_,i)=>bet(i+1,{Settlement:null}));recovered=await api.outrightMarkets!([id]);state.apply('prematch',recovered,now+2);
  market=state.feed().outrightDiagnostics![0].markets![0];assert.equal(market.selections[0].settlement,2);assert.equal(market.selections[0].settlementTrace?.lastSnapshot?.decision,'ignored_null');assert.equal(market.selections[0].settlementTrace?.lastNumeric?.source,'snapshot.outright.markets');
  receive(state,41,[bet(1)],now+3,3);assert.equal(state.feed().events[0].selections[0].settlement,2);
  tickets.reconcile(state.feed());assert.deepEqual(tickets.get(ticket.id),ticket);
  await createPublisher(path)(state.feed(),checkpoint(state));const restarted=new TradeState();await restore(restarted,path);
  assert.deepEqual(restarted.feed().outrightDiagnostics![0].markets![0].settlementEvidence,market.settlementEvidence);
  apiServer=createApp({getEvents:()=>readConnectedFeed(path)},{ticketStore:tickets}).listen(0,'127.0.0.1');await new Promise<void>(r=>apiServer!.once('listening',r));const a=apiServer.address();assert(a&&typeof a!=='string');
  const d=await(await fetch(`http://127.0.0.1:${a.port}/api/diagnostics/outright/${id}`)).json();assert.equal(d.matches[0].markets[0].selections[0].settlement,2);assert.equal(d.matches[0].markets[0].selections[3].settlementTrace.lastSnapshot.field,'null');
  // Only a later explicit result for the accepted selection can settle this ticket.
  receive(restarted,42,[bet(4,{Settlement:1})],now+4,3);tickets.reconcile(restarted.feed());let saved=tickets.get(ticket.id)!;assert.equal(saved.status,'LOST');assert.equal(saved.revision,1);assert.equal(saved.selections[0].acceptedOdds,2.6233);
  tickets.reconcile(restarted.feed());assert.equal(tickets.get(ticket.id)?.revision,1);
  receive(restarted,42,[bet(4,{Settlement:0})],now+5,3);tickets.reconcile(restarted.feed());saved=tickets.get(ticket.id)!;assert.equal(saved.status,'PENDING');assert.equal(saved.selections[0].acceptedOdds,2.6233);
 }finally{if(apiServer)await new Promise<void>(r=>apiServer!.close(()=>r()));await new Promise<void>(r=>http.close(()=>r()));tickets.close();await rm(dir,{recursive:true,force:true});}
});
test('settlement audit distinguishes root absence, explicit zero, stale rejection, invalid conversion and provider-only results',()=>{
 const state=seed(),now=Date.now()+1000;
 receive(state,41,[bet(1,{LastUpdate:new Date(now).toISOString()})],now);
 receive(state,42,[bet(1,{Settlement:1,LastUpdate:new Date(now-1).toISOString()})],now+1,3);
 const selection=state.feed().outrightDiagnostics![0].markets![0].selections[0];assert.equal(selection.settlement,null);assert.equal(selection.settlementTrace?.last42?.decision,'ignored_older');assert.equal(selection.settlementTrace?.last42?.code,1);
 const raw=[{Id:160,Bets:[bet(1,{Settlement:2})]}];
 assert.throws(()=>inspectSettlements(raw,[{id:160,bets:[{id:'1',isChanged:0}]}])); // Explicit code cannot disappear unnoticed in SDK conversion.
 assert.throws(()=>inspectSettlements(raw,[{id:160,bets:[]}])) ;
 assert.throws(()=>receive(state,42,[bet(1,{Settlement:'lost'})],now+2));
 const d=decodeMessage(Buffer.from(JSON.stringify({Header:{Type:42,MsgGuid:'isolated-provider',ServerTimestamp:now+2},Body:{Competition:{Id:competition,Events:[{FixtureId:id,Markets:[{Id:160,Bets:[bet(1)],ProviderMarkets:[{Id:8,Bets:[bet(1,{Settlement:1})]}]}]}]}}})));
 state.apply('prematch',d.events,d.at);const market=state.feed().outrightDiagnostics![0].markets![0];assert.equal(market.settlementEvidence?.['amqp.42']?.providerNumeric,1);assert.equal(market.settlementEvidence?.['amqp.42']?.rootMissing,1);assert.equal(market.selections[0].settlement,null);assert.equal(market.selections[0].settlementTrace?.last42?.decision,'ignored_missing');
});
