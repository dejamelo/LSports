import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';import vm from 'node:vm';
import {openInbox,persistIngressBatch,isClosedIngressChannel,ingressFailureDetails} from './durable-ingress.mjs';
const require=createRequire(import.meta.url);const {Channel}=require('amqplib/lib/channel_model');
const message=n=>({content:Buffer.from('raw-'+n),properties:{headers:{MessageType:3}},fields:{deliveryTag:n},original:{fields:{deliveryTag:n}}});
function closedChannel(){const c=new Channel({releaseChannel(){}});c.toClosed('isolated state change');return c;}
test('installed flush reproduces IllegalOperationError at the reported line after full-inbox checkpoint frees space',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-installed-ack-')),path=join(dir,'inbox.sqlite');let db;
 try{
  db=openInbox(path);const ids=db.append([message(1)]);const max=db.stats().bytes+1;db.close();db=openInbox(path,max);
  const baseline=readFileSync(new URL('./fixtures/f18c123-flush.txt',import.meta.url),'utf8').trimEnd();assert.ok(baseline.includes('channel?.ack(m.original)'));
  const failures=[],c=closedChannel();let paused=false;
  const ctx={clearTimeout,performance,flushTimer:undefined,pending:[message(2)],inbox:db,metrics:{acknowledged:0},channel:c,pauseIntake:()=>paused=true,pump(){},fail:e=>failures.push(e),connection:{close:()=>Promise.resolve()}};
  vm.createContext(ctx);vm.runInContext(baseline+'\nglobalThis.invoke=flush;',ctx,{filename:'durable-ingress.mjs',lineOffset:65});ctx.invoke();assert.equal(paused,true);assert.equal(failures.length,0);
  db.complete(ids);ctx.invoke();assert.equal(failures.length,1);assert.equal(failures[0].name,'IllegalOperationError');assert.match(failures[0].stack,/durable-ingress\.mjs:66:255/);assert.equal(db.stats().backlog,1,'raw retry was committed even though its broker ACK failed');
 }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});
test('fixed retry commits exactly once after capacity release; closed-channel ACK does not invalidate receipt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-fixed-ack-'));let db;
 try{
  const path=join(dir,'inbox.sqlite');db=openInbox(path);const ids=db.append([message(1)]),max=db.stats().bytes+1;db.close();db=openInbox(path,max);
  let attempts=0,commits=0,acked=0;const deferred=[];const c=closedChannel();
  const options={onCommitted:()=>commits++,onAcknowledged:()=>acked++,onAckFailure:e=>deferred.push(e)};
  assert.throws(()=>persistIngressBatch(db,[message(2)],m=>{attempts++;c.ack(m.original);},options),/INBOX_CAPACITY_EXCEEDED/);assert.equal(attempts,0);assert.equal(commits,0);
  db.complete(ids);const result=persistIngressBatch(db,[message(2)],m=>{attempts++;c.ack(m.original);},options);
  assert.deepEqual(result,{committedRows:1,acknowledged:0});assert.equal(commits,1);assert.equal(acked,0);assert.equal(deferred.length,1);assert.ok(isClosedIngressChannel(deferred[0]));assert.equal(ingressFailureDetails(deferred[0],'amqp.ack').errorType,'IllegalOperationError');assert.equal(db.stats().backlog,1);
  db.close();db=openInbox(path);const replay=db.peek();assert.equal(replay.length,1);assert.equal(replay[0].content.toString(),'raw-2');db.complete([replay[0].id]);assert.equal(db.stats().backlog,0);
 }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});
test('known-closed transport skips broker ACK but preserves the committed raw batch for replay',()=>{
 const committed=[];let acked=0;const batch=[message(1),message(2)];const result=persistIngressBatch({append:rows=>committed.push(...rows)},batch,()=>acked++,{canAcknowledge:()=>false});assert.equal(acked,0);assert.equal(result.committedRows,2);assert.equal(committed.length,2);
});
test('failed raw commit never acknowledges; unexpected ACK failures are not classified as channel closure',()=>{
 let acked=0;assert.throws(()=>persistIngressBatch({append(){throw Error('isolated EIO');}},[message(1)],()=>acked++),/isolated EIO/);assert.equal(acked,0);assert.equal(isClosedIngressChannel(Error('Channel closed')),false);assert.equal(isClosedIngressChannel(Object.assign(Error('unrelated'),{name:'IllegalOperationError'})),false);
});
