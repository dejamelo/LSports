import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {openInbox,connectDurableMq} from './durable-ingress.mjs';
const message=(n:number)=>({content:Buffer.from(JSON.stringify({n})),properties:{headers:{MessageType:3,FixtureId:1}},fields:{redelivered:false}});
test('durable raw inbox retains order, bounded capacity, safe cursor cannot pass pending rows; crash replay',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-inbox-'));const path=join(dir,'raw.sqlite');
 try{let db=openInbox(path,1024);const first=message(1);(first.properties.headers as any).FixtureId=Buffer.from('1');const ids=db.append([first,message(2)]);assert.ok(Buffer.isBuffer(db.peek()[0].properties.headers.FixtureId));assert.throws(()=>db.safePoint(100));db.close();db=openInbox(path,1024);assert.deepEqual(db.peek().map(r=>JSON.parse(r.content).n),[1,2]);db.complete([ids[0]]);db.close();db=openInbox(path,1024);assert.equal(JSON.parse(db.peek()[0].content).n,2);assert.throws(()=>db.append([{...message(3),content:Buffer.alloc(2048)}]));assert.equal(db.stats().backlog,1);db.complete([ids[1]]);db.safePoint(100);db.close();db=openInbox(path);assert.equal(db.safeSeconds(),100);db.close();}finally{await rm(dir,{recursive:true,force:true});}
});
test('transport ACK is durable before processing; restart replays rows without supplier redelivery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-inbox-thread-'));const path=join(dir,'raw.sqlite');let latest:any;const pkg={} as any;let transport=await connectDurableMq(pkg,path,m=>latest=m,{offline:true});
 try{transport.offline([message(1),message(2)]);for(let i=0;i<100&&latest?.acknowledged!==2;i++)await sleep(10);assert.equal(latest.acknowledged,2);assert.equal(latest.processed,0);assert.equal(latest.backlog,2);await transport.crashOfflineForTest();transport=await connectDurableMq(pkg,path,()=>{},{offline:true});const channel=await transport.createChannel();const rows:any[]=[];await channel.consume('unused',m=>{if(m)rows.push(m);});for(let i=0;i<100&&rows.length!==2;i++)await sleep(10);assert.deepEqual(rows.map(r=>JSON.parse(r.content.toString()).n),[1,2]);for(const row of rows)channel.ack(row);await sleep(50);await transport.close();const db=openInbox(path);assert.equal(db.stats().backlog,0);db.close();}finally{await transport.close();await rm(dir,{recursive:true,force:true});}
});

test('SDK recovery timestamp is seconds; null markets preserved; settlement and stale backlog never become eligible',async()=>{
 const {Mapper,GetEventRequest,GetEventRequestDto}=await import('trade360-nodejs-sdk');
 const timestamp=1792500000;const body=new Mapper({packageId:4511,username:'offline',password:'offline'}).map(new GetEventRequestDto({timestamp}),GetEventRequest);
 assert.equal((body as any).timestamp,timestamp);assert.equal((body as any).fixtures,undefined);
 const {convertSnapshotRow}=await import('./full-snapshot.js');const {TradeState}=await import('./state.js');const state=new TradeState();
 const at=new Date().toISOString();const row=convertSnapshotRow({FixtureId:1,Fixture:{Status:1,Sport:{Name:'Football'},LastUpdate:at},Markets:[{Id:1,Status:1,LastUpdate:at,Bets:[{Id:'1',Price:'2.1',Status:1,LastUpdate:at,Settlement:1}]}]});
 state.apply('prematch',[row],Date.now());state.set('prematch',{phase:'connected'});const selection=state.feed().events[0].markets![0].selections[0];assert.equal(selection.available,false);assert.ok(selection.unavailableReasons?.includes('selection_settled'));
 const nullRow=convertSnapshotRow({FixtureId:2,Fixture:{Status:1},Markets:null});state.apply('prematch',[nullRow],Date.now());assert.equal(state.feed().events.find(e=>e.id==='prematch:2')?.markets?.length,0);
});
