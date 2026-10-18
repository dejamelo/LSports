import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TradeState} from './state.js';
import {checkpoint,restore} from './persistence.js';
import {clients} from './provider.js';
import {createPublisher,readConnectedFeed} from '@lsports/feed-store';
import {TicketStore} from '@lsports/feed-store/tickets';
import {createApp} from '../../api/src/app.js';
import type {PackageConfig} from './config.js';

// Isolated synthetic reproduction of ten unchanged quotes; never supplier observations.
const fixtureId=900564, competitionId=900144, at=1700000000000;
function seed() {
 const state=new TradeState();
 state.apply('prematch',[{fixtureId,outright:{competitionId,fixture:{fixtureName:'ISOLATED restart test',sport:{name:'Horse Racing'},status:1,
  participants:Array.from({length:10},(_,i)=>({id:i+1,name:`Test runner ${i+1}`}))}},
  markets:[{id:160,name:'Race Winner',status:1,bets:Array.from({length:10},(_,i)=>({id:String(i+1),participantId:i+1,price:'2.63',status:1,isChanged:0,lastUpdate:new Date(at)}))}]}],at);
 state.set('prematch',{phase:'connected'});return state;
}
test('restart: official snapshot reconfirms ten unchanged timestamps, API agrees, ticket is preserved; partial/empty snapshots never open absent quotes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-quote-restart-'));const path=join(dir,'feed.json');const publish=createPublisher(path);
 let bets=Array.from({length:10},(_,i)=>({Id:String(i+1),ParticipantId:i+1,Price:'2.63',Status:1,LastUpdate:new Date(at+(i===0?1:0)).toISOString()}));
 const http=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
  assert.equal(req.url,'/Prematch/GetOutrightFixtureMarkets');assert.deepEqual(body.fixtures,[fixtureId]);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:[{Id:competitionId,Events:[{FixtureId:fixtureId,Markets:[{Id:160,Name:'Race Winner',Status:1,Bets:bets}]}]}]}));
 });
 await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const address=http.address();assert(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`;
 const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'synthetic-user',password:'synthetic-test',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false};
 // This transport only talks to the ephemeral local HTTP server; no supplier
 // cooldown/checkpoint files are read, cleared or changed by this test.
 const api=clients(pkg,{snapshotUrl:url,customersUrl:url},{run:async(_operation,action)=>action()});
 const tickets=new TicketStore(join(dir,'tickets.sqlite'));
 try{
  const original=seed(),event=original.feed().events[0];
  const ticket=tickets.create({stakeMinor:10000,selections:[{eventId:event.id,marketId:event.markets![0].id,selectionId:event.selections[0].id,expectedOdds:2.63}]},'isolated-existing-ticket',()=>original.feed());
  await publish(original.feed(),checkpoint(original));
  const state=new TradeState();await restore(state,path);state.set('prematch',{phase:'connected'});
  const count=()=>state.feed().events[0].selections.filter(s=>s.available).length;
  assert.equal(count(),0);state.replace('prematch',[],Date.now());assert.equal(count(),0);
  // Only one AMQP quote changed since the checkpoint: reproduces one enabled runner.
  state.apply('prematch',[{fixtureId,outright:{competitionId},marketMessageType:41,markets:[{id:160,bets:[{id:'1',price:'2.63',status:1,isChanged:0,lastUpdate:new Date(at+1)}]}]}],Date.now());
  assert.equal(count(),1);
  const recovered=await api.outrightMarkets!([fixtureId]);
  assert.equal(recovered[0].marketRecovery,true);assert.equal(recovered[0].markets![0].bets!.length,10);
  assert.equal(new Date(recovered[0].markets![0].bets![1].lastUpdate!).getTime(),at);
  state.apply('prematch',recovered,Date.now());assert.equal(count(),10);
  await publish(state.feed(),checkpoint(state));
  const app=createApp({getEvents:()=>readConnectedFeed(path)}).listen(0,'127.0.0.1');await new Promise<void>(r=>app.once('listening',r));
  try{
   const a=app.address();assert(a&&typeof a!=='string');const base=`http://127.0.0.1:${a.port}`;
   const feed=await(await fetch(`${base}/api/events`)).json();assert.equal(feed.events[0].selections.filter((s:{available:boolean})=>s.available).length,10);
   const d=await(await fetch(`${base}/api/diagnostics/outright/${fixtureId}`)).json();const selections=d.matches[0].markets[0].selections;
   assert(selections.every((s:{available:boolean;odds:number;quoteRecovery:{snapshot:{decision:string};awaitingFreshQuote:boolean}})=>s.available&&s.odds===2.63&&s.quoteRecovery.snapshot.decision==='confirmed'&&!s.quoteRecovery.awaitingFreshQuote));
  }finally{await new Promise<void>(r=>app.close(()=>r()));}
  assert.deepEqual(tickets.get(ticket.id),ticket); // No retroactive ticket, revision or accepted price mutation.
  const restarted=new TradeState();await restore(restarted,path);restarted.set('prematch',{phase:'connected'});
  assert.equal(restarted.feed().events[0].selections.filter(s=>s.available).length,0);
  bets=bets.slice(0,1);restarted.apply('prematch',await api.outrightMarkets!([fixtureId]),Date.now());
  let race=restarted.feed().events[0];assert.equal(race.selections.filter(s=>s.available).length,1);
  const missing=race.marketDiagnostic!.markets![0].selections.slice(1);
  assert(missing.every(s=>s.quoteRecovery?.snapshotSeen===false&&s.quoteRecovery.awaitingFreshQuote&&s.unavailableReasons?.includes('awaiting_update')));
  bets=[];restarted.apply('prematch',await api.outrightMarkets!([fixtureId]),Date.now());
  race=restarted.feed().events[0];assert.equal(race.selections.length,10);assert.equal(race.selections.filter(s=>s.available).length,1);
 }finally{tickets.close();await new Promise<void>(r=>http.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
test('restart safety: older snapshots and status-only deltas do not validate stored prices; suspension/settlement/connection still gate confirmed quotes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-quote-safety-'));const path=join(dir,'feed.json');
 try{
  const original=seed();await createPublisher(path)(original.feed(),checkpoint(original));
  const state=new TradeState();await restore(state,path);state.set('prematch',{phase:'connected'});
  const apply=(bets:NonNullable<import('trade360-nodejs-sdk').Market['bets']>,recovery=false,status?:number)=>state.apply('prematch',[{fixtureId,outright:{competitionId},marketRecovery:recovery,markets:[{id:160,status,bets}]}],Date.now());
  const quote=()=>state.feed().events[0].selections[0];
  const diagnostic=()=>state.feed().outrightDiagnostics![0].markets![0].selections[0].quoteRecovery!;
  apply([{id:'1',price:'9.99',isChanged:0,lastUpdate:new Date(at-1)}],true);
  assert.equal(quote().available,false);assert.equal(quote().odds,2.63);assert.equal(diagnostic().snapshot?.decision,'older_than_stored');
  apply([{id:'1',status:1,isChanged:0,lastUpdate:new Date(at+1)}]);assert.equal(quote().available,false);
  apply([{id:'1',status:1,isChanged:0,lastUpdate:new Date(at+1)}],true);assert.equal(quote().available,false);assert.equal(diagnostic().snapshot?.decision,'missing_or_invalid_price');
  apply([{id:'1',price:'2.63',status:1,isChanged:0,lastUpdate:new Date(at+1)}],true,2);assert.equal(quote().available,false);assert(quote().unavailableReasons?.includes('market_not_open'));
  apply([],false,1);assert.equal(quote().available,true);
  state.set('prematch',{phase:'recovering'});assert.equal(quote().available,false);state.set('prematch',{phase:'connected'});
  apply([{id:'1',settlement:2,isChanged:0,lastUpdate:new Date(at+2)}],false,3);assert.equal(quote().available,false);assert(quote().unavailableReasons?.includes('selection_settled'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
