import {test} from 'node:test';
import assert from 'node:assert/strict';
import {supervisorPolicy,drainSupervisor} from '../../../scripts/drain-supervisor.js';
const defaults='exports.restartTries = 0; exports.maxProcesses = 0; exports.handleInput = false; exports.killSignal = undefined;';
test('allows known no-restart/no-queue defaults and describes normal kill-others behavior',()=>{
 assert.equal(supervisorPolicy('node concurrently -k -n api,worker,demo',[],'9.2.1',defaults).normalKillOthers,true);
});
test('rejects restart, queued work, forced kill, input, aliases and inherited policy changes',()=>{
 for(const arg of ['--restart-tries=1','--restartTries=1','--max-processes 1','--maxProcesses=1','-m1','--kill-timeout 500','--killTimeout=500','--kill-signal=SIGKILL','--handle-input','-i','--raw','-r','--passthrough-arguments'])assert.throws(()=>supervisorPolicy('node concurrently '+arg,[],'9.2.1',defaults),/CUSTOM_LIFECYCLE/);
 for(const name of ['CONCURRENTLY_RESTART_TRIES','CONCURRENTLY_KILL_TIMEOUT','CONCURRENTLY_MAX_PROCESSES'])assert.throws(()=>supervisorPolicy('node concurrently',[name],'9.2.1',defaults),/CUSTOM_ENVIRONMENT/);
 assert.throws(()=>supervisorPolicy('node concurrently',[],'8.0.0',defaults),/DEFAULTS_UNVERIFIED/);
});
function fixture(){
 const owner={pid:11,parentPid:9,uid:501,startedAt:'old',args:'node /repo/apps/worker/src/index.ts'};const parent={...owner,pid:9,parentPid:7,args:'node concurrently'};
 let tick=0,resumed=false,done=false;const signals:number[]=[];
 const io={identity:async(pid:number)=>done?undefined:pid===11?{...owner}:{...parent},cwd:async()=>'/repo',state:async(pid:number)=>pid===9&&!resumed?'T':'S',lock:async()=>({pid:11,uid:501,ino:1,dev:1}),children:async()=>[11],claim:async()=>{},resumeParent:(pid:number)=>{resumed=true;signals.push(pid);},absent:async()=>done,pause:async()=>{tick++;done=true;},now:()=>tick};
 return {io,owner,parent,signals};
}
test('one CONT targets only parent; completes after owner, parent and lease are gone',async()=>{
 const f=fixture();assert.equal((await drainSupervisor(f.io,11,9,'/repo',501)).lockReleased,true);assert.deepEqual(f.signals,[9]);
});
test('sibling or replaced identity blocks before signal; durable intent is not bypassed',async()=>{
 let f=fixture();f.io.children=async()=>[11,12];await assert.rejects(drainSupervisor(f.io,11,9,'/repo',501),/OTHER_LIVE_CHILDREN/);assert.deepEqual(f.signals,[]);
 f=fixture();f.io.claim=async()=>{f.parent.startedAt='replacement';};await assert.rejects(drainSupervisor(f.io,11,9,'/repo',501),/CHANGED_BEFORE_CONT/);assert.deepEqual(f.signals,[]);
 f=fixture();f.io.claim=async()=>{throw Error('EEXIST');};await assert.rejects(drainSupervisor(f.io,11,9,'/repo',501),/EEXIST/);assert.deepEqual(f.signals,[]);
});
test('timeout preserves owner/lock and never escalates or repeats CONT',async()=>{
 const f=fixture();let tick=0;f.io.now=()=>tick;f.io.pause=async()=>{tick++;};
 await assert.rejects(drainSupervisor(f.io,11,9,'/repo',501,3),/DRAIN_TIMEOUT_NO_MORE_SIGNALS/);assert.deepEqual(f.signals,[9]);
});
test('real stdout backpressure under stopped concurrently drains with parent-only CONT',{timeout:20000},async()=>{
 const fs=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawn}=await import('node:child_process');const {once}=await import('node:events');const {setTimeout:delay}=await import('node:timers/promises');
 const {processIdentity,processStateCode,readOwner,pathAbsent}=await import('../../../scripts/stop-owned-worker.js');
 const dir=await fs.mkdtemp(join(tmpdir(),'adl-supervisor-backpressure-'));const file=join(dir,'checkpoint');const fixtureFile=join(dir,'child.cjs');
 await fs.writeFile(fixtureFile,`const fs=require('node:fs');const p=process.argv[2];fs.writeFileSync(p+'.lock',String(process.pid));let i=0,stopping=false;const t=setInterval(()=>fs.writeFileSync(p,'PENDING '+(++i)),40);process.on('SIGTERM',()=>{if(stopping)return;stopping=true;process.stdout.write(Buffer.alloc(8*1024*1024,120),()=>{clearInterval(t);fs.writeFileSync(p,'DRAINED');fs.unlinkSync(p+'.lock');});});console.log('READY:'+process.pid);`);
 const parent=spawn(process.execPath,['node_modules/concurrently/dist/bin/concurrently.js','--prefix','none',`exec '${process.execPath}' '${fixtureFile}' '${file}'`],{stdio:['ignore','pipe','pipe']});parent.stderr!.resume();const exit=once(parent,'exit');let ownerPid=0;let text='';
 parent.stdout!.on('data',d=>{if(ownerPid)return;text+=d;const m=text.match(/READY:(\d+)/);if(m)ownerPid=Number(m[1]);});
 try{
  for(let n=0;n<200&&!ownerPid;n++)await delay(20);assert.ok(ownerPid);
  parent.kill('SIGSTOP');for(let n=0;n<100&&!/^T/.test(await processStateCode(parent.pid!));n++)await delay(10);
  process.kill(ownerPid,'SIGTERM');await delay(200);
  assert.match(await fs.readFile(file,'utf8'),/PENDING/);assert.equal(await pathAbsent(file+'.lock'),false);assert.match(await processStateCode(parent.pid!),/^T/);
  const identities=async(pid:number)=>{const info=await processIdentity(pid);return info?{...info,args:pid===ownerPid?'node /repo/apps/worker/src/index.ts':'node concurrently'}:undefined;};
  const result=await drainSupervisor({identity:identities,cwd:async()=>'/repo',state:processStateCode,lock:()=>readOwner(file+'.lock'),children:async()=>await processIdentity(ownerPid)?[ownerPid]:[],
   claim:async()=>{},resumeParent:pid=>{assert.equal(pid,parent.pid);parent.kill('SIGCONT');},absent:()=>pathAbsent(file+'.lock'),pause:()=>delay(20),now:Date.now},ownerPid,parent.pid!,'/repo',process.getuid!(),8000);
  assert.equal(result.signalsToWorker,0);assert.equal(await fs.readFile(file,'utf8'),'DRAINED');assert.equal(await pathAbsent(file+'.lock'),true);await exit;
 }finally{
  if(parent.exitCode===null){parent.kill('SIGCONT');if(ownerPid&&await processIdentity(ownerPid))process.kill(ownerPid,'SIGTERM');await exit;}
  await fs.rm(dir,{recursive:true,force:true});
 }
});
