import {test} from 'node:test';import assert from 'node:assert/strict';
import {TradeState} from './state.js';
const now=Date.now();
const event=(id:number,price='2.1')=>({fixtureId:id,fixture:{status:1},markets:[{id:1,status:1,bets:[{id:'one',price,status:1,isChanged:1}]}]});
test('worker projection cache preserves full semantics and only rebuilds changed regular fixtures',()=>{
 const s=new TradeState();s.apply('prematch',[event(1),event(2)],now);s.set('prematch',{phase:'connected'});
 const one=s.feed(now,true);assert.deepEqual(one,s.feed(now));const two=s.feed(now,true);assert.equal(one.events[1],two.events[1]);
 s.apply('prematch',[event(1,'2.8')],now+1);const three=s.feed(now,true);assert.notEqual(one.events[0],three.events[0]);assert.equal(one.events[1],three.events[1]);assert.deepEqual(three,s.feed(now));
 assert.equal(one.events[0].selections[0].odds,2.1);assert.equal(three.events[0].selections[0].odds,2.8);
 s.set('prematch',{phase:'stopped'});assert.deepEqual(s.feed(now,true),s.feed(now));assert.equal(s.feed(now,true).events[0].selections[0].available,false);
 s.set('prematch',{phase:'connected'});s.beginPartitionedSnapshot('prematch');assert.deepEqual(s.feed(now,true),s.feed(now));assert.equal(s.feed(now,true).events[0].selections[0].available,false);
});
test('cached quotes become unavailable on an unapplied gap; WAL retention alone does not invent a processing gap',()=>{
 const s=new TradeState();s.apply('prematch',[event(1)],now);s.set('prematch',{phase:'connected'});assert.ok(s.feed(now,true).events[0].selections[0].available);
 const m={backlog:1000,oldestAgeMs:20000,processingBacklog:5,oldestProcessingAgeMs:6000} as any;
 s.set('prematch',{ingressProgress:m});assert.equal(s.feed(now,true).events[0].selections[0].available,false);assert.deepEqual(s.feed(now,true),s.feed(now));
 s.set('prematch',{ingressProgress:{...m,processingBacklog:0,oldestProcessingAgeMs:0}});assert.ok(s.feed(now,true).events[0].selections[0].available);assert.deepEqual(s.feed(now,true),s.feed(now));
});

test('deferred worker publication applies the same block policy without rebuilding or mutating the cached quote graph',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {createPublisher}=await import('@lsports/feed-store');const dir=await mkdtemp(join(tmpdir(),'adl-mask-')),path=join(dir,'feed.json');
 try{
  const s=new TradeState();s.apply('prematch',[event(1)],now);s.set('prematch',{phase:'recovering'});
  const base=s.feed(now,true,true);assert.ok(base.events[0].selections[0].available);assert.equal(base.coverage!.prematch.eventsWithSelectableOdds,0);
  const publish=createPublisher(path);await publish(base,undefined,s.availabilityBlocks());
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),JSON.parse(JSON.stringify(s.feed(now))));
  s.set('prematch',{phase:'connected'});const active=s.feed(now,true,true);assert.equal(active.events[0],base.events[0]);
  await publish(active,undefined,s.availabilityBlocks());assert.deepEqual(JSON.parse(await readFile(path,'utf8')),JSON.parse(JSON.stringify(s.feed(now))));
  s.set('prematch',{ingressProgress:{backlog:100,oldestAgeMs:7000,processingBacklog:100,oldestProcessingAgeMs:7000} as any});
  const blocked=s.feed(now,true,true);assert.equal(blocked.events[0],base.events[0]);await publish(blocked,undefined,s.availabilityBlocks());
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),JSON.parse(JSON.stringify(s.feed(now))));assert.ok(base.events[0].selections[0].available);
 }finally{await rm(dir,{recursive:true,force:true});}
});
