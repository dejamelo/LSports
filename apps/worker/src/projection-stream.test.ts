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
  s.apply(lane,[{fixtureId:1,fixture:{status:2,sport:{id:1,name:'Soccer'}},markets:[{id:1,status:1,bets:[{id:'1',price:'2.1',isChanged:1,status:1,settlement:2},{id:'2',price:'2.2',isChanged:1,status:2}]}]},
   {fixtureId:2,fixture:{status:1,sport:{id:2,name:'Horse Racing'}},markets:[{id:2,status:1,bets:[{id:'3',price:'0',isChanged:1,status:1}]}]}],now);
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
 s.apply('prematch',[{fixtureId:1,fixture:{status:1},markets:[{id:1,status:1,bets:[{id:'1',price:'2.1',isChanged:1,status:1}]}]}],now);
 s.set('prematch',{phase:'connected'});
 const old=s.projection(now),expected=JSON.parse(JSON.stringify(s.feed(now)));
 s.apply('prematch',[{fixtureId:1,markets:[{id:1,status:1,bets:[{id:'1',price:'3.1',isChanged:1,status:1}]}]}],now+1000);
 s.beginPartitionedSnapshot('prematch');
 const dir=await mkdtemp(join(tmpdir(),'projection-capture-')),path=join(dir,'feed.json');
 try{await createPublisher(path)(old);assert.deepEqual(JSON.parse(await readFile(path,'utf8')),expected);}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('outright diagnostics and version recovery remain identical in streamed projection',async()=>{
 const s=new TradeState(),now=1700000000000;
 s.apply('prematch',[{fixtureId:30,outright:{competitionId:90,competitionName:'Meeting'},fixture:{status:1,sport:{id:1,name:'Horse Racing'},participants:[{id:1,name:'Runner',position:'1'}]},markets:[{id:160,status:1,bets:[{id:'1',participantId:1,price:'2.5',isChanged:1,status:1,settlement:2}]}]}],now);
 const row=s.rows.prematch.get('outright:90:30')!;
 row.timestampRecovery=new Map([['160:1',{auditId:'proof',status:'awaiting_fresh_amqp',previousVersion:new Date(now).toISOString(),baselineVersion:new Date(now-1).toISOString()} as any]]);
 const dir=await mkdtemp(join(tmpdir(),'projection-outright-')),path=join(dir,'feed.json');
 try{await createPublisher(path)(s.projection(now));assert.deepEqual(JSON.parse(await readFile(path,'utf8')),JSON.parse(JSON.stringify(s.feed(now))));}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('streamed receipt verifies all bytes and rejects corruption/count mismatch',async()=>{
 const {open,writeFile}=await import('node:fs/promises');
 const {writeJsonObject}=await import('@lsports/feed-store');
 const {verifyProjectionFile}=await import('./full-snapshot.js');
 const dir=await mkdtemp(join(tmpdir(),'projection-receipt-')),path=join(dir,'feed.json');
 try{
  const state=new TradeState();state.apply('prematch',[{fixtureId:1,fixture:{status:1},markets:[]}],1700000000000);
  const f=await open(path,'w');const receipt=await writeJsonObject(f,{...state.projection()});await f.close();
  assert.equal((await verifyProjectionFile(path,{...receipt,rows:1})).rows,1);
  await assert.rejects(verifyProjectionFile(path,{...receipt,rows:2}),/count_mismatch/);
  await assert.rejects(verifyProjectionFile(path,{...receipt,rows:1,eventSha256:'0'.repeat(64)}),/content_mismatch/);
  const body=await readFile(path,'utf8');await writeFile(path,body.replace('Evento 1','Evento 2'));
  await assert.rejects(verifyProjectionFile(path,{...receipt,rows:1}),/digest_mismatch/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('exclusive publication holds a stable state without copy-on-write and releases queued processing',async()=>{
 const s=new TradeState(),now=1700000000000;
 s.apply('prematch',[{fixtureId:1,fixture:{status:1},markets:[{id:1,status:1,bets:[{id:'1',price:'2.1',isChanged:1,status:1}]}]}],now);s.set('prematch',{phase:'connected'});
 const original=s.rows.prematch.get(1);let release!:()=>void,entered!:()=>void;
 const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const dir=await mkdtemp(join(tmpdir(),'exclusive-publish-')),path=join(dir,'feed.json');
 try{
  const saving=s.exclusive(async()=>{const feed=s.projection(now,false);entered();await gate;await persistRegularCheckpoint(path,s);await createPublisher(path)(feed,{...checkpoint(s,false),regularExternal:true});});
  await ready;let applied=false;
  const update=s.exclusive(()=>{s.apply('prematch',[{fixtureId:1,markets:[{id:1,status:1,bets:[{id:'1',price:'3.1',isChanged:1,status:1}]}]}],now+1000);applied=true;});
  await new Promise(r=>setImmediate(r));assert.equal(applied,false);release();await saving;await update;
  assert.equal(s.rows.prematch.get(1),original,'stable publication must not create a shadow SDK row');
  const persisted=JSON.parse(await readFile(path,'utf8'));assert.equal(persisted.events[0].selections[0].odds,2.1);assert.equal(s.feed(now).events[0].selections[0].odds,3.1);
  const restored=new TradeState();await restore(restored,path);assert.equal(restored.feed(now).events[0].selections[0].odds,2.1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('fixture dates reuse one native formatter and preserve Argentine output',()=>{
 const s=new TradeState(),date='2026-10-23T12:00:00Z';s.apply('prematch',[{fixtureId:1,fixture:{status:1,startDate:new Date(date)},markets:[]}],1700000000000);
 const expected=new Intl.DateTimeFormat('es-AR',{timeZone:'America/Argentina/Buenos_Aires',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(date))+' ART';
 const constructor=Intl.DateTimeFormat;
 try{Intl.DateTimeFormat=(()=>{throw Error('per-event ICU allocation');}) as any;for(let i=0;i<20;i++)assert.equal(s.feed().events[0].time,expected);}
 finally{Intl.DateTimeFormat=constructor;}
});

test('failed publication releases the local mutation gate without marking recovery complete',async()=>{
 const s=new TradeState();s.beginPartitionedSnapshot('prematch');
 await assert.rejects(s.exclusive(async()=>{throw Error('offline disk failure');}),/disk failure/);
 await s.exclusive(()=>s.apply('prematch',[{fixtureId:1,fixture:{status:1},markets:[]}],Date.now()));
 assert.equal(s.rows.prematch.size,1);assert.ok(!s.feed().events.some(e=>e.selections.some(selection=>selection.available)));
});
