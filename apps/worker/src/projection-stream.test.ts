import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TradeState} from './state.js';
import {createPublisher} from '@lsports/feed-store';
import {walkSnapshot} from './full-snapshot.js';
import {checkpoint,persistRegularCheckpoint,restore} from './persistence.js';
test('lazy projection preserves complete public schema, duplicate precedence, settlements and blocked quotes',async()=>{
 const s=new TradeState(),now=1700000000000;
 for(const lane of ['prematch','inplay'] as const){
  s.apply(lane,[{fixtureId:1,fixture:{status:2,sport:{id:1,name:'Soccer'}},markets:[{id:1,status:1,bets:[{id:'1',price:'2.1',status:1,settlement:2},{id:'2',price:'2.2',status:2}]}]},
   {fixtureId:2,fixture:{status:1,sport:{id:2,name:'Horse Racing'}},markets:[{id:2,status:1,bets:[{id:'3',price:'0',status:1}]}]}],now);
  s.set(lane,{phase:'connected',lastSnapshotAt:new Date(now).toISOString()});
 }
 const dir=await mkdtemp(join(tmpdir(),'projection-stream-')),path=join(dir,'feed.json');
 try{
  const expected=JSON.parse(JSON.stringify(s.feed(now)));
  await createPublisher(path)(s.projection(now));
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),expected);
  await persistRegularCheckpoint(path,s);
  await createPublisher(path)(s.projection(now),{...checkpoint(s,false),regularExternal:true});
  let rows=0;await walkSnapshot(path,async raw=>{assert.ok((raw as any).id);rows++;},undefined,'events');
  assert.equal(rows,expected.events.length);
  const restored=new TradeState();await restore(restored,path);
  await createPublisher(path)(restored.projection(now));
  const reread=JSON.parse(await readFile(path,'utf8'));
  assert.equal(reread.ticketOutcomes.length,expected.ticketOutcomes.length);
  assert.ok(reread.events.every((e:any)=>e.markets.every((m:any)=>m.selections.every((s:any)=>!s.available))));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('captured projection stays consistent while updates and recovery mutate live rows',async()=>{
 const s=new TradeState(),now=1700000000000;
 s.apply('prematch',[{fixtureId:1,fixture:{status:1},markets:[{id:1,status:1,bets:[{id:'1',price:'2.1',status:1}]}]}],now);
 s.set('prematch',{phase:'connected'});
 const old=s.projection(now),expected=JSON.parse(JSON.stringify(s.feed(now)));
 s.apply('prematch',[{fixtureId:1,markets:[{id:1,status:1,bets:[{id:'1',price:'3.1',status:1}]}]}],now+1000);
 s.beginPartitionedSnapshot('prematch');
 const dir=await mkdtemp(join(tmpdir(),'projection-capture-')),path=join(dir,'feed.json');
 try{await createPublisher(path)(old);assert.deepEqual(JSON.parse(await readFile(path,'utf8')),expected);}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('outright diagnostics and version recovery remain identical in streamed projection',async()=>{
 const s=new TradeState(),now=1700000000000;
 s.apply('prematch',[{fixtureId:30,outright:{competitionId:90,competitionName:'Meeting'},fixture:{status:1,sport:{id:1,name:'Horse Racing'},participants:[{id:1,name:'Runner',position:'1'}]},markets:[{id:160,status:1,bets:[{id:'1',participantId:1,price:'2.5',status:1,settlement:2}]}]}],now);
 const row=s.rows.prematch.get('outright:90:30')!;
 row.timestampRecovery=new Map([['160:1',{auditId:'proof',status:'awaiting_fresh_amqp',previousVersion:new Date(now).toISOString(),baselineVersion:new Date(now-1).toISOString()} as any]]);
 const dir=await mkdtemp(join(tmpdir(),'projection-outright-')),path=join(dir,'feed.json');
 try{await createPublisher(path)(s.projection(now));assert.deepEqual(JSON.parse(await readFile(path,'utf8')),JSON.parse(JSON.stringify(s.feed(now))));}
 finally{await rm(dir,{recursive:true,force:true});}
});
