import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, rename, lstat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { TicketStore } from '@lsports/feed-store/tickets';
import type { EventFeed } from '@lsports/contracts';
import { acquireWorkerLock } from './worker-lock.js';
import { TradeState } from './state.js';
import { restore } from './persistence.js';

for (const supervisor of [false,true]) for (const signal of ['SIGINT','SIGTERM'] as const) test(`${supervisor ? 'npm/concurrently' : 'direct'} ${signal}: drain, persist, release own lock, restart and preserve two settled tickets`, {timeout:15000}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'adl-shutdown-'));const path=join(dir,'feed.json');const dbPath=join(dir,'tickets.sqlite');
  const db=new TicketStore(dbPath);const now=new Date().toISOString();
  const feed={mode:'connected',updatedAt:now,connections:{prematch:{phase:'connected'}},events:[{id:'prematch:9001',source:'prematch',available:true,status:1,markets:[{id:'160',name:'Race Winner',status:1,selections:[{id:'runner',label:'ISOLATED TEST',available:true,status:1,odds:2.6233}]}]}]} as EventFeed;
  for (let i=0;i<2;i++) db.create({stakeMinor:1000,selections:[{eventId:'prematch:9001',marketId:'160',selectionId:'runner',expectedOdds:2.6233}]},`isolated-ticket-${i}`,()=>feed);
  feed.ticketOutcomes=[{eventId:'prematch:9001',marketId:'160',selectionId:'runner',settlement:1,updatedAt:now}];db.reconcile(feed);
  const before=db.list();db.close();
  assert.equal(before.total,2);
  const children: ReturnType<typeof spawn>[]=[];
  try {
    for(let restart=0;restart<2;restart++) {
      const args=['--import','tsx','apps/worker/src/test-fixtures/shutdown.ts',path,dbPath];
      const child=supervisor
        ? spawn('npm',['exec','--','concurrently','--raw',`node ${args.map(arg => "'" + arg.replace(/'/g, "'\\''") + "'").join(' ')}`],{detached:true,stdio:['ignore','pipe','pipe']})
        : spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});
      children.push(child);
      let output='',errors='';child.stderr!.on('data',d=>errors+=d);
      const exited=once(child,'close');
      await new Promise<void>((resolve,reject)=>{
        child.stdout!.on('data',d=>{output+=d;if(output.includes('READY'))resolve();});
        child.once('exit',()=>reject(Error(`Exited before readiness: ${errors}`)));
      });
      await assert.rejects(acquireWorkerLock(`${path}.lock`),{code:'EEXIST'});
      if(supervisor) process.kill(-child.pid!,signal); else { child.kill(signal);child.kill(signal==='SIGINT'?'SIGTERM':'SIGINT'); }
      const [code,exitSignal]=await exited;
      if(!supervisor){assert.equal(code,0,errors);assert.equal(exitSignal,null);}
      assert.match(output,/"lock":"released"/);
      await assert.rejects(lstat(`${path}.lock`),{code:'ENOENT'});
      await assert.rejects(lstat(`${path}.lock.reclaim`),{code:'ENOENT'});
      const projection=JSON.parse(await readFile(path,'utf8'));
      assert.equal(projection.connections.prematch.phase,'stopped');
      const restored=new TradeState();const result=await restore(restored,path);assert.equal(result.source,'checkpoint');assert.equal(result.rows,1);
      assert.match(JSON.stringify(projection),/ISOLATED TEST DRAINED/);
      const reopened=new TicketStore(dbPath);assert.deepEqual(reopened.list(),before);reopened.close();
    }
  } finally {for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
test('release preserves a replacement lock and startup preserves a stale lock for explicit backed-up recovery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'adl-lock-owner-'));const path=join(dir,'feed.lock');
  try {
    const release=await acquireWorkerLock(path);
    await rename(path,`${path}.original`);await writeFile(path,'99999999');
    assert.equal(await release(),false);assert.equal(await readFile(path,'utf8'),'99999999');
    await assert.rejects(acquireWorkerLock(path),{code:'EEXIST'});
    assert.equal(await readFile(path,'utf8'),'99999999');
    await assert.rejects(lstat(`${path}.reclaim`),{code:'ENOENT'});
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('lock release preserves same inode when owner PID was changed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'adl-lock-pid-'));const path=join(dir,'feed.lock');
  try {
    const release=await acquireWorkerLock(path);await writeFile(path,'99999999');
    assert.equal(await release(),false);assert.equal(await readFile(path,'utf8'),'99999999');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('SIGTERM during pending AMQP connect closes the returned connection once, without starting consumption',async()=>{
  const {session}=await import('./connected.js');const {EventEmitter}=await import('node:events');
  const controller=new AbortController();let closes=0;let saves=0;
  const connection=Object.assign(new EventEmitter(),{
    async close(){closes++;connection.emit('close');},
    async createChannel(){assert.fail('Aborted connect must not create a channel');},
  });
  const pkg={lane:'prematch' as const,packageId:4511,username:'test',password:'',hostname:'localhost',port:5672,tls:false,vhost:'test',queue:'test'};
  await session(pkg,{packages:[pkg],snapshotUrl:'http://localhost',customersUrl:'http://localhost',recoveryMs:300000,staleMs:90000},new TradeState(),async()=>{saves++;},controller.signal,{
    connect:(async()=>{controller.abort();return connection;}) as unknown as typeof import('amqplib').connect,
    clientFactory:()=>({async startDistribution(){},async distributionStatus(){return {isDistributionOn:true,consumers:[],numberMessagesInQueue:0,messagesPerSecond:0};},async snapshot(){assert.fail('No supplier recovery after abort');},async catalog(){return [];}}),
  });
  assert.equal(closes,1);assert.equal(saves,2);
});
test('shutdown waits for a concurrent startup/recovery guard without deleting that guard',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'adl-lock-gate-'));const path=join(dir,'feed.lock');
  try {
    const release=await acquireWorkerLock(path);
    await writeFile(`${path}.reclaim`,'other-operation');
    const pending=release();
    await delay(80);
    assert.equal(await readFile(`${path}.reclaim`,'utf8'),'other-operation');
    assert.equal(await readFile(path,'utf8'),String(process.pid));
    await unlink(`${path}.reclaim`);
    assert.equal(await pending,true);
    await assert.rejects(lstat(path),{code:'ENOENT'});
  } finally {await rm(dir,{recursive:true,force:true});}
});
