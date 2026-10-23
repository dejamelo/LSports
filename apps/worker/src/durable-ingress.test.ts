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

test('larger replay window is still bounded by payload plus metadata bytes; no rows are discarded',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-bounded-window-'));const db=openInbox(join(dir,'inbox.sqlite'));
 try{
  const padding='x'.repeat(60000);
  for(let base=0;base<600;base+=50)db.append(Array.from({length:50},(_,i)=>({...message(base+i),properties:{headers:{MessageType:3,padding}}})));
  const rows=db.peek();assert.ok(rows.length>100&&rows.length<600);
  const bytes=rows.reduce((n,r)=>n+r.content.byteLength+Buffer.byteLength(JSON.stringify(r.properties))+Buffer.byteLength(JSON.stringify(r.fields)),0);
  assert.ok(bytes<=16*1024**2);assert.equal(db.stats().backlog,600);
  assert.deepEqual(rows.map(r=>JSON.parse(r.content).n),Array.from({length:rows.length},(_,i)=>i));
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('processing can advance beyond a checkpoint in flight; staged rows survive crash until durable completion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-stage-prefix-'));const path=join(dir,'raw.sqlite');let latest:any;let transport=await connectDurableMq({} as any,path,m=>latest=m,{offline:true});
 try{
  const channel:any=await transport.createChannel();let applied=0;
  await channel.consume('unused',(msg:any)=>{applied++;channel.stage(msg);});
  transport.offline(Array.from({length:1000},(_,i)=>message(i)));
  const deadline=Date.now()+5000;while(Date.now()<deadline&&(latest?.processed!==1000||applied!==1000))await sleep(20);
  assert.equal(applied,1000);assert.equal(latest.acknowledged,1000);assert.equal(latest.processed,1000);assert.equal(latest.checkpointed,0);assert.equal(latest.processingBacklog,0);assert.equal(latest.backlog,1000);
  await transport.crashOfflineForTest();const db=openInbox(path);assert.equal(db.stats().backlog,1000);assert.deepEqual(db.peek().map(r=>JSON.parse(r.content).n),Array.from({length:1000},(_,i)=>i));db.close();
 }finally{await transport.close();await rm(dir,{recursive:true,force:true});}
});

test('receipt metrics use covering index without payload scan, preserve backwards receipt clocks and replay',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const directory=await mkdtemp(join(tmpdir(),'adl-receipt-metric-'));const path=join(directory,'inbox.sqlite');
 try{
  let inbox=openInbox(path);const ids=inbox.append([3000,1000,2000,500].map((received,i)=>({...message(i),received})));inbox.complete([ids[1]]);
  const stat=inbox.processingStats(ids[0]);assert.equal(stat.processingBacklog,2);assert.ok(stat.oldestProcessingAgeMs>=Date.now()-500-100);inbox.close();
  inbox=openInbox(path);assert.equal(inbox.processingStats(ids[0]).processingBacklog,2);assert.deepEqual(inbox.peek().map(r=>r.id),[ids[0],ids[2],ids[3]]);inbox.close();
  const db=new DatabaseSync(path,{readOnly:true});try{
   const plan=db.prepare('EXPLAIN QUERY PLAN SELECT count(*) AS processingBacklog,min(received) AS oldest FROM inbox WHERE id>?').all(ids[0]);
   assert.ok(plan.some(r=>String(r.detail).includes('COVERING INDEX inbox_processing_receipt')));
   assert.deepEqual({...db.prepare('SELECT count(*) AS n,min(received) AS oldest FROM inbox WHERE id>?').get(ids[0])},{n:2,oldest:500});
  }finally{db.close();}
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('adding receipt index to a legacy inbox preserves original ids, bytes and timestamps',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const directory=await mkdtemp(join(tmpdir(),'adl-legacy-inbox-'));const path=join(directory,'inbox.sqlite');
 try{
  const original=new DatabaseSync(path);original.exec('PRAGMA journal_mode=WAL; CREATE TABLE inbox(id INTEGER PRIMARY KEY AUTOINCREMENT,received INTEGER NOT NULL,content BLOB NOT NULL,properties TEXT NOT NULL,fields TEXT NOT NULL)');
  original.prepare('INSERT INTO inbox(id,received,content,properties,fields) VALUES(?,?,?,?,?)').run(19,12345,Buffer.from('preserved bytes'),'{}','{}');original.close();
  const inbox=openInbox(path);try{const rows=inbox.peek();assert.equal(rows.length,1);assert.equal(rows[0].id,19);assert.equal(rows[0].received,12345);assert.equal(rows[0].content.toString(),'preserved bytes');assert.equal(inbox.processingStats(0).processingBacklog,1);}finally{inbox.close();}
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('full restored inbox pauses intake but replays, checkpoints, frees capacity and resumes without losing pending delivery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-full-replay-')),path=join(dir,'raw.sqlite');
 const seed=Array.from({length:20},(_,i)=>({...message(i),content:Buffer.from(JSON.stringify({n:i,padding:'x'.repeat(128)}))}));
 const db=openInbox(path);db.append(seed);const maxBytes=db.stats().bytes+1;db.close();
 let latest:any;const transport=await connectDurableMq({} as any,path,m=>latest=m,{offline:true,maxBytes});const errors:any[]=[];transport.on('error',e=>errors.push(e));
 try{
  transport.offline([message(999)]);
  for(let i=0;i<100&&!transport.intakePaused();i++)await sleep(10);
  assert.equal(transport.intakePaused(),true);assert.equal(errors.length,0);
  const channel=await transport.createChannel(),rows:any[]=[];await channel.consume('offline',m=>{if(m)rows.push(m);});
  for(let i=0;i<100&&rows.length<20;i++)await sleep(10);
  assert.equal(rows.length,20);const check=openInbox(path);assert.equal(check.stats().backlog,20);check.close();
  // Completing the business checkpoint is explicit: stage alone never deletes rows.
  for(const row of rows)(channel as any).stage(row);await sleep(30);
  const before=openInbox(path);assert.equal(before.stats().backlog,20);before.close();
  for(const row of rows)channel.ack(row);
  for(let i=0;i<200&&(transport.intakePaused()||rows.length<21);i++)await sleep(10);
  assert.equal(transport.intakePaused(),false);assert.equal(rows.length,21);assert.equal(JSON.parse(rows[20].content.toString()).n,999);
  channel.ack(rows[20]);
  for(let i=0;i<200&&latest?.backlog!==0;i++)await sleep(10);
  assert.equal(latest.backlog,0);assert.equal(latest.acknowledged,1);assert.equal(latest.processed,21);assert.equal(latest.checkpointed,21);assert.equal(errors.length,0);
 }finally{await transport.close();await rm(dir,{recursive:true,force:true});}
});
