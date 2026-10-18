import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TicketStore,TicketError} from './tickets.js';
import type {EventFeed,TicketRequest} from '@lsports/contracts';
const now = Date.now();
function setup() {
 const dir=mkdtempSync(join(tmpdir(),'adl-tickets-')); const path=join(dir,'tickets.sqlite');
 let db=new TicketStore(path,()=>now);
 const feed={mode:'connected',updatedAt:new Date(now).toISOString(),connections:{prematch:{phase:'connected'}},events:[{id:'prematch:9001',source:'prematch',available:true,status:1,home:'PRUEBA AISLADA',away:'',markets:[{id:'prematch:9001:160',name:'Race Winner',status:1,selections:[{id:'prematch:9001:160:9',label:'Selección de prueba',available:true,status:1,odds:3.25}]}]}]} as EventFeed;
 const request:TicketRequest={stakeMinor:10000,selections:[{eventId:'prematch:9001',marketId:'prematch:9001:160',selectionId:'prematch:9001:160:9',expectedOdds:3.25}]};
 return {feed,request,get db(){return db;},restart(){db.close();db=new TicketStore(path,()=>now);},close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
function outcome(feed:EventFeed,code:number,delta=1,lane='prematch') {
 feed.ticketOutcomes=[{eventId:`${lane}:9001`,marketId:`${lane}:9001:160`,selectionId:`${lane}:9001:160:9`,settlement:code,updatedAt:new Date(now+delta).toISOString()}];
}
test('persistent acceptance, immutable price, idempotency across restart and POSNET job acknowledgement',()=>{
 const s=setup();try {
  const input={...s.request,channel:'posnet_test' as const,terminalId:'terminal-test-01'};
  const ticket=s.db.create(input,'request-key-01',()=>s.feed);s.restart();
  assert.equal(s.db.create(input,'request-key-01',()=>{throw Error('must not revalidate replay');}).id,ticket.id);
  assert.throws(()=>s.db.create({...input,stakeMinor:1},'request-key-01',()=>s.feed),e=>e instanceof TicketError&&e.code==='IDEMPOTENCY_CONFLICT');
  const jobs=s.db.printJobs('terminal-test-01') as {id:string}[];assert.equal(jobs.length,1);
  assert.throws(()=>s.db.acknowledgePrint(jobs[0].id,'other-terminal-01'));
  s.db.acknowledgePrint(jobs[0].id,'terminal-test-01');s.db.acknowledgePrint(jobs[0].id,'terminal-test-01');assert.equal(s.db.printJobs('terminal-test-01').length,0);
  assert.equal(s.db.get(ticket.id)?.selections[0].acceptedOdds,3.25);
 } finally{s.close();}
});
test('server rejects stale/disconnected, changed prices, suspended/settled fixture and markets, duplicate event and retroactive results',()=>{
 const s=setup();try {
 const check=(code:string)=>assert.throws(()=>s.db.create(s.request,'request-blocked',()=>s.feed),e=>e instanceof TicketError&&e.code===code);
 s.feed.updatedAt=new Date(now-21000).toISOString();check('STALE_FEED');s.feed.updatedAt=new Date(now).toISOString();
 s.feed.connections!.prematch!.phase='reconnecting';check('FEED_OR_EVENT_UNAVAILABLE');s.feed.connections!.prematch!.phase='connected';
 const event=s.feed.events[0],market=event.markets![0];market.status=2;check('MARKET_NOT_OPEN');market.status=3;check('MARKET_NOT_OPEN');market.status=1;
 event.status=3;check('FEED_OR_EVENT_UNAVAILABLE');event.status=1;
 market.selections[0].odds=4;check('PRICE_CHANGED');market.selections[0].odds=3.25;
 outcome(s.feed,2);s.db.reconcile(s.feed);check('RESULT_ALREADY_RECEIVED');assert.equal(s.db.list().total,0);
 }finally{s.close();}
});
test('idempotent durable settlement, cross-feed results, correction, reopening, old and unknown code handling',()=>{
 const s=setup();try {
 const ticket=s.db.create(s.request,'request-settlement',()=>s.feed);
 outcome(s.feed,2,1,'inplay');s.db.reconcile(s.feed);s.db.reconcile(s.feed);s.restart();
 let saved=s.db.get(ticket.id)!;assert.equal(saved.status,'WON');assert.equal(saved.payoutMinor,32500);assert.equal(saved.revision,1);
 outcome(s.feed,1,2);s.db.reconcile(s.feed);assert.equal(s.db.get(ticket.id)?.payoutMinor,0);
 outcome(s.feed,2,1);s.db.reconcile(s.feed);assert.equal(s.db.get(ticket.id)?.revision,2);
 outcome(s.feed,0,3);s.db.reconcile(s.feed);assert.equal(s.db.get(ticket.id)?.status,'PENDING');assert.equal(s.db.get(ticket.id)?.payoutMinor,null);
 outcome(s.feed,999,4);s.db.reconcile(s.feed);assert.equal(s.db.get(ticket.id)?.status,'PENDING');
 outcome(s.feed,3,5);s.db.reconcile(s.feed);saved=s.db.get(ticket.id)!;assert.equal(saved.status,'REFUNDED');assert.equal(saved.payoutMinor,10000);assert.equal(saved.history.length,6);
 }finally{s.close();}
});
test('confirmed 20540195 result codes only validate mapping: no retroactive ticket is created',async()=>{
 const {settlementLabel}=await import('@lsports/contracts');
 const result={fixtureId:20540195,marketId:160,selections:[{name:'Groovinharmony',settlement:2},{name:'Vegas Vickie',settlement:1}]};
 assert.equal(settlementLabel(result.selections[0].settlement),'Ganadora');assert.equal(settlementLabel(result.selections[1].settlement),'Perdedora');
});
test('integer returns for win, loss, refund, cancellation, half win and half loss',()=>{
 for(const [code,expected] of [[2,32500],[1,0],[3,10000],[-1,10000],[4,5000],[5,21250]]) {
  const s=setup();try{const t=s.db.create(s.request,`request-result-${code}`,()=>s.feed);outcome(s.feed,code);s.db.reconcile(s.feed);assert.equal(s.db.get(t.id)?.payoutMinor,expected);}finally{s.close();}
 }
});
test('combined ticket waits for every result, then correction recomputes from accepted odds without accumulating returns',()=>{
 const s=setup();try{
  const second=structuredClone(s.feed.events[0]);second.id='prematch:9002';second.markets![0].id='prematch:9002:160';second.markets![0].selections[0].id='prematch:9002:160:10';second.markets![0].selections[0].odds=2;
  s.feed.events.push(second);s.request.selections.push({eventId:second.id,marketId:second.markets![0].id,selectionId:second.markets![0].selections[0].id,expectedOdds:2});
  const ticket=s.db.create(s.request,'request-combined',()=>s.feed);outcome(s.feed,2);s.db.reconcile(s.feed);assert.equal(s.db.get(ticket.id)?.status,'PENDING');
  s.feed.ticketOutcomes!.push({eventId:second.id,marketId:second.markets![0].id,selectionId:second.markets![0].selections[0].id,settlement:2,updatedAt:new Date(now+1).toISOString()});
  s.db.reconcile(s.feed);assert.equal(s.db.get(ticket.id)?.payoutMinor,65000);
  s.feed.ticketOutcomes![1].settlement=3;s.feed.ticketOutcomes![1].updatedAt=new Date(now+2).toISOString();s.db.reconcile(s.feed);assert.equal(s.db.get(ticket.id)?.payoutMinor,32500);
  s.db.reconcile(s.feed);assert.equal(s.db.get(ticket.id)?.revision,3);
 }finally{s.close();}
});
