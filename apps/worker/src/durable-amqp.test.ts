/** Opt-in local RabbitMQ only. The test container shares a network-none namespace with the broker. */
import {test} from 'node:test';import assert from 'node:assert/strict';import amqp from 'amqplib';import {connectDurableMq} from './durable-ingress.mjs';import {mkdtemp,open,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {setTimeout as sleep} from 'node:timers/promises';
test('real local RabbitMQ: manual durable ACK keeps receiving beyond prefetch while business thread is blocked',{skip:process.env.ADL_LOCAL_AMQP_TEST!=='1',timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-real-amqp-')),queue='isolated-durable-review';let producer:any,transport:any,latest:any;
 try{
  producer=await amqp.connect({hostname:'127.0.0.1',username:'guest',password:'guest',vhost:'/',heartbeat:30});producer.on('error',()=>{});const publish=await producer.createConfirmChannel();await publish.assertQueue(queue,{durable:true});
  const pkg={lane:'prematch' as const,packageId:4511,username:'guest',password:'guest',hostname:'127.0.0.1',port:5672,tls:false,vhost:'/',queue};
  transport=await connectDurableMq(pkg,join(dir,'raw.sqlite'),m=>latest=m);transport.on('error',()=>{});
  for(let i=0;i<1000;i++)publish.sendToQueue(queue,Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'isolated-'+i},Body:{Events:[]}})),{persistent:true,headers:{MessageType:3,FixtureId:1}});
  await publish.waitForConfirms();
  // Transport/SQLite/heartbeats run on another thread while business JS cannot take a turn.
  const blockedUntil=performance.now()+1500;while(performance.now()<blockedUntil){}
  for(let i=0;i<100&&latest?.acknowledged!==1000;i++)await sleep(20);
  assert.equal(latest.received,1000);assert.equal(latest.acknowledged,1000);assert.equal(latest.processed,0);assert.equal(latest.backlog,1000);
  const broker=await publish.checkQueue(queue);assert.equal(broker.messageCount,0);assert.equal(broker.consumerCount,1);
  const business=await transport.createChannel();let rows:any[]=[],processed=0;await business.consume(queue,(m:any)=>{if(m)rows.push(m);});
  while(processed<1000){while(!rows.length)await sleep(10);const batch=rows;rows=[];const fd=await open(join(dir,'checkpoint'),'w',0o600);await fd.writeFile(String(processed+batch.length));await fd.sync();await fd.close();for(const row of batch)business.ack(row);processed+=batch.length;}
  for(let i=0;i<100&&latest?.processed!==1000;i++)await sleep(20);assert.equal(latest.processed,1000);assert.equal(latest.backlog,0);
  console.log(JSON.stringify({test:'real_local_amqp',received:1000,durableAcknowledged:1000,processed,brokerQueueDepth:broker.messageCount,prefetch:100,noAck:false,blockedBusinessMs:1500,awsValidated:false}));
 }finally{await transport?.close();await producer?.close();await rm(dir,{recursive:true,force:true});}
});

test('real local RabbitMQ: full inbox retains replay and resumes manual durable intake under 72/s and burst',{skip:process.env.ADL_LOCAL_AMQP_TEST!=='1',timeout:30000},async()=>{
 const {openInbox}=await import('./durable-ingress.mjs');const dir=await mkdtemp(join(tmpdir(),'adl-full-amqp-')),path=join(dir,'raw.sqlite'),queue='isolated-capacity-'+process.pid+'-'+Date.now();let producer:any,transport:any,latest:any;const windows:any[]=[],errors:any[]=[];
 const payload=(id:string,padding=768)=>Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:id},Body:{Events:[]},padding:'x'.repeat(padding)}));
 const seed=Array.from({length:120},(_,i)=>({content:payload('seed-'+i,2048),properties:{},fields:{},received:Date.now()}));const db=openInbox(path);db.append(seed);const maximum=db.stats().bytes+1;db.close();
 try{
  producer=await amqp.connect({hostname:'127.0.0.1',username:'guest',password:'guest',vhost:'/',heartbeat:30});producer.on('error',(e:any)=>errors.push(e));const pub=await producer.createConfirmChannel();await pub.assertQueue(queue,{durable:true});
  transport=await connectDurableMq({lane:'prematch',packageId:4511,username:'guest',password:'guest',hostname:'127.0.0.1',port:5672,tls:false,vhost:'/',queue},path,m=>{latest=m;windows.push(m);},{maxBytes:maximum});transport.on('error',(e:any)=>errors.push(e));
  const load=(async()=>{let sent=0;const start=performance.now();while(sent<660){const elapsed=performance.now()-start,target=Math.floor(Math.min(elapsed,5000)*72/1000)+(elapsed>=2500?300:0);while(sent<target){pub.sendToQueue(queue,payload('live-'+sent++),{headers:{MessageType:3}});}await sleep(10);}await pub.waitForConfirms();})();
  for(let i=0;i<200&&(!transport.intakePaused()||!latest);i++)await sleep(10);assert.equal(transport.intakePaused(),true);assert.equal(latest.backlog,120);assert.equal(errors.length,0);
  const business=await transport.createChannel();let pending:any[]=[],done=0;const seen=new Set();await business.consume(queue,(m:any)=>{if(m)pending.push(m);});
  const deadline=Date.now()+20000;while(done<780&&Date.now()<deadline){if(!pending.length){await sleep(10);continue;}const batch=pending;pending=[];for(const row of batch){const id=JSON.parse(row.content).Header.MsgGuid;assert.equal(seen.has(id),false);seen.add(id);business.stage(row);}
   const file=await open(join(dir,'checkpoint'),'w',0o600);await file.writeFile(String(done+batch.length));await file.sync();await file.close();for(const row of batch)business.ack(row);done+=batch.length;}
  await load;for(let i=0;i<200&&latest?.backlog!==0;i++)await sleep(10);
  assert.equal(done,780);assert.equal(latest.backlog,0);assert.equal(latest.acknowledged,660);assert.equal(latest.processed,780);assert.equal(latest.checkpointed,780);assert.equal(transport.intakePaused(),false);assert.equal(errors.length,0);
  const status=await pub.checkQueue(queue);assert.equal(status.messageCount,0);assert.equal(status.consumerCount,1);assert.ok(windows.some((w,i)=>i>0&&w.processingBacklog<windows[i-1].processingBacklog));
  console.log(JSON.stringify({test:'full_inbox_live_amqp',initialBacklog:120,received:660,processed:780,checkpointed:780,finalBacklog:latest.backlog,windows:windows.map(w=>({start:w.metricWindowStartUTC,end:w.metricWindowEndUTC,received:w.received,processed:w.processed,checkpointed:w.checkpointed,backlog:w.processingBacklog,ageMs:w.oldestProcessingAgeMs})),awsValidated:false}));
 }finally{await transport?.close();await producer?.close();await rm(dir,{recursive:true,force:true});}
});
