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
