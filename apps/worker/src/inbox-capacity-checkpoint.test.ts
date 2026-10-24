import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {setTimeout as sleep} from 'node:timers/promises';
import {connectDurableMq,openInbox} from './durable-ingress.mjs';import {TradeState} from './state.js';import {persistRegularCheckpoint,streamCheckpoint,restore} from './persistence.js';import {createPublisher} from '@lsports/feed-store';import {decodeMessage} from './provider.js';
const pkg={lane:'prematch',packageId:4511,username:'isolated',password:'isolated',hostname:'unused',queue:'unused',vhost:'unused',tls:false,port:5672} as any;
async function until(check:()=>boolean){const end=Date.now()+7000;while(!check()){if(Date.now()>end)throw Error('isolated test deadline');await sleep(5);}}
test('capacity stays paused before durable checkpoint and explicitly resumes only after deletion and pending receipt fit',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-capacity-proof-')),path=join(dir,'feed.json'),inbox=path+'.prematch.inbox.sqlite';let actor:any,latest:any;const states:boolean[]=[];
 const msg=(i:number,padding:number)=>({received:Date.now(),content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'cap-'+i,ServerTimestamp:Date.now()},Padding:'x'.repeat(padding),Body:{Events:[{FixtureId:i,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Price:'2.8',Status:1}]}]}]}})),properties:{headers:{MessageType:3}},fields:{}});
 const seed=openInbox(inbox);seed.append([msg(1,8192),msg(2,8192)]);const maxBytes=seed.stats().bytes+64;seed.close();
 try{
  actor=await connectDurableMq(pkg,inbox,m=>{latest=m;states.push((m as typeof m & {intakePaused:boolean}).intakePaused)},{offline:true,maxBytes});const channel:any=await actor.createChannel();const rows:any[]=[];await channel.consume('unused',(m:any)=>rows.push(m),{});
  await until(()=>rows.length===2);actor.offline([msg(3,1024)]);await until(()=>latest?.intakePaused===true);
  assert.equal(latest.checkpointed,0);assert.equal(latest.acknowledged,0);const before=openInbox(inbox);assert.equal(before.stats().backlog,2);before.close();
  const s=new TradeState(),decoded=decodeMessage(rows[0].content,rows[0].properties.headers);s.apply('prematch',decoded.events,decoded.at);await persistRegularCheckpoint(path,s);const {regular,...saved}=streamCheckpoint(s);await createPublisher(path)(s.projection(Date.now(),false),{...saved,regularExternal:true});
  const restored=new TradeState();await restore(restored,path);assert.equal(restored.rows.prematch.get(1)?.markets.get('1')?.bets?.[0].price,'2.8');
  channel.stage(rows[0]);channel.ack(rows[0]);await until(()=>latest?.checkpointed===1&&latest?.acknowledged===1&&latest?.intakePaused===false);
  assert(states.includes(true));assert.equal(states.at(-1),false);assert.equal(latest.backlog,2,'one old row remains and the queued new receipt is durable');
 }finally{await actor?.close();await rm(dir,{recursive:true,force:true});}
});
test('three durable checkpoint cycles retire old rows despite new durable receipts',{timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-three-cycles-')),path=join(dir,'feed.json'),inbox=path+'.prematch.inbox.sqlite';let actor:any,latest:any;
 const message=(id:number)=>({received:Date.now(),content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'cycle-'+id,ServerTimestamp:Date.now()},Body:{Events:[{FixtureId:id,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Price:'2.8',Status:1}]}]}]}})),properties:{headers:{MessageType:3}},fields:{}});
 const seed=openInbox(inbox);seed.append(Array.from({length:12},(_,i)=>message(i+1)));seed.close();
 try{actor=await connectDurableMq(pkg,inbox,m=>latest=m,{offline:true});const channel:any=await actor.createChannel(),rows:any[]=[];await channel.consume('unused',(m:any)=>rows.push(m),{});await until(()=>rows.length===12);const s=new TradeState();
 for(let cycle=0;cycle<3;cycle++){
  const group=rows.slice(cycle*4,cycle*4+4);for(const row of group){const d=decodeMessage(row.content,row.properties.headers);s.apply('prematch',d.events,d.at);channel.stage(row);}
  actor.offline([message(100+cycle)]);await until(()=>latest?.acknowledged===cycle+1);
  const before=openInbox(inbox);assert.equal(before.stats().backlog,13-cycle*3);before.close();
  await persistRegularCheckpoint(path,s);const {regular,...saved}=streamCheckpoint(s);await createPublisher(path)(s.projection(Date.now(),false),{...saved,regularExternal:true});const restored=new TradeState();await restore(restored,path);assert.equal(restored.rows.prematch.size,(cycle+1)*4);
  for(const row of group)channel.ack(row);await until(()=>latest?.checkpointed===(cycle+1)*4);assert.equal(latest.backlog,9-cycle*3);
 }
 }finally{await actor?.close();await rm(dir,{recursive:true,force:true});}
});
