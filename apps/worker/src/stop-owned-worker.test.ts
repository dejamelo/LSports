import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stopOwnedWorker,workerIdentity} from '../../../scripts/stop-owned-worker.js';
import type {Identity,Lock} from '../../../scripts/stop-owned-worker.js';
function fixture(){
 const lock:Lock={pid:12811,ino:1,dev:2,uid:501};
 const info:Identity={pid:12811,parentPid:12809,uid:501,startedAt:'Mon Oct 19 01:00:00 2026',args:'node /repo/apps/worker/src/index.ts'};
 let now=0,alive=true,absent=false;const signals:number[]=[];
 const io={lock:async()=>({...lock}),identity:async()=>alive?{...info}:undefined,cwd:async()=>'/repo',signal:(pid:number)=>{signals.push(pid);},absent:async()=>absent,pause:async()=>{now++;alive=false;absent=true;},now:()=>now};
 return {io,info,lock,signals,setAlive:(value:boolean)=>{alive=value;},setAbsent:(value:boolean)=>{absent=value;}};
}
test('signals only revalidated lock owner once, never parent/group; waits for exit and unlock',async()=>{
 const f=fixture();const result=await stopOwnedWorker(f.io,'/repo',501,10);
 assert.deepEqual(f.signals,[12811]);assert.equal(result.parentPid,12809);assert.equal(result.lockReleased,true);
});
test('wrong repository cwd blocks without any signal',async()=>{
 const f=fixture();f.io.cwd=async()=>'/another-project';
 await assert.rejects(stopOwnedWorker(f.io,'/repo',501,10),/NOT_VERIFIED/);assert.deepEqual(f.signals,[]);
});
test('wrong user or non-worker entrypoint cannot be stopped',async()=>{
 for(const change of [()=>({args:'node /repo/apps/api/src/index.ts'}),()=>({uid:502})]){
  const f=fixture();Object.assign(f.info,change());
  await assert.rejects(stopOwnedWorker(f.io,'/repo',501,10),/NOT_VERIFIED/);assert.deepEqual(f.signals,[]);
 }
});
test('PID reuse before signal blocks and preserves all locks',async()=>{
 const f=fixture();let calls=0;f.io.identity=async()=>({...f.info,startedAt:++calls>1?'new owner':f.info.startedAt});
 await assert.rejects(stopOwnedWorker(f.io,'/repo',501,10),/IDENTITY_CHANGED_BEFORE_SIGNAL/);assert.deepEqual(f.signals,[]);
});
test('replacement lock before signal blocks without signaling',async()=>{
 const f=fixture();let calls=0;f.io.lock=async()=>({...f.lock,ino:++calls});
 await assert.rejects(stopOwnedWorker(f.io,'/repo',501,10),/IDENTITY_CHANGED_BEFORE_SIGNAL/);assert.deepEqual(f.signals,[]);
});
test('dead owner is not reclaimed and is never signaled',async()=>{
 const f=fixture();f.setAlive(false);
 await assert.rejects(stopOwnedWorker(f.io,'/repo',501,10),/NOT_VERIFIED/);assert.deepEqual(f.signals,[]);
});
test('timeout does not escalate or repeat SIGTERM',async()=>{
 const f=fixture();let tick=0;f.io.now=()=>tick;f.io.pause=async()=>{tick++;};
 await assert.rejects(stopOwnedWorker(f.io,'/repo',501,3),/GRACEFUL_SHUTDOWN_TIMEOUT_LOCK_PRESERVED/);assert.deepEqual(f.signals,[12811]);
});
test('lock disappearance alone does not count as process shutdown',async()=>{
 const f=fixture();let tick=0;f.setAbsent(true);f.io.now=()=>tick;f.io.pause=async()=>{tick++;};
 await assert.rejects(stopOwnedWorker(f.io,'/repo',501,3),/TIMEOUT/);assert.deepEqual(f.signals,[12811]);
});
test('worker matcher accepts npm workspace cwd, rejects API and generic supervisor',()=>{
 const f=fixture();assert.equal(workerIdentity(f.info,'/repo','/repo/apps/worker',501),true);
 assert.equal(workerIdentity({...f.info,args:'node /repo/apps/api/src/index.ts'},'/repo','/repo',501),false);
 assert.equal(workerIdentity({...f.info,args:'npm run dev:worker'},'/repo','/repo',501),false);
});
test('normal stop refuses an already OS-stopped owner without sending TERM',async()=>{
 const f=fixture();await assert.rejects(stopOwnedWorker({...f.io,osState:async()=> 'T'},'/repo',501,10),/WORKER_OS_STOPPED_REQUIRES_RESUME_RECOVERY/);assert.deepEqual(f.signals,[]);
});
