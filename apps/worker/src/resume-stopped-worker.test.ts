import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resumeStoppedWorker} from '../../../scripts/resume-stopped-worker.js';
function fixture(){
 let time=0,done=false;const signals:number[]=[];const actions:string[]=[];
 const owner={pid:12811,parentPid:12809,uid:501,startedAt:'old',args:'node /repo/apps/worker/src/index.ts'};
 const parent={...owner,pid:12809,parentPid:1,args:'node /repo/node_modules/tsx/dist/cli.mjs /repo/apps/worker/src/index.ts'};
 const io={lock:async()=>({pid:12811,uid:501,ino:1,dev:1}),identity:async(pid:number)=>done?undefined:pid===12811?{...owner}:{...parent},cwd:async()=>'/repo',state:async(pid:number)=>signals.includes(pid)?'S':'T',pendingTerm:async():Promise<boolean|null>=>true,
 claimTerm:async()=>{actions.push('claimTerm');},terminate:(pid:number)=>{actions.push('TERM:'+pid);done=true;},backup:async()=>{actions.push('backup');},claim:async()=>{actions.push('claim');},signal:(pid:number)=>{signals.push(pid);actions.push('CONT:'+pid);},absent:async()=>done,pause:async()=>{time++;done=true;},now:()=>time};
 return {io,owner,parent,signals,actions};
}
test('backs up before one CONT per verified launcher/owner, never TERM/KILL',async()=>{
 const f=fixture();const result=await resumeStoppedWorker(f.io,12811,'/repo',501,10);
 assert.deepEqual(f.actions,['backup','claim','CONT:12809','CONT:12811']);assert.equal(result.lockReleased,true);
});
test('PID different from explicit target blocks',async()=>{
 const f=fixture();await assert.rejects(resumeStoppedWorker(f.io,999,'/repo',501),/OWNER_IDENTITY_NOT_VERIFIED/);assert.deepEqual(f.signals,[]);
});
test('running owner is not resumed, deadlock is not presumed OS stop',async()=>{
 const f=fixture();f.io.state=async()=> 'S';await assert.rejects(resumeStoppedWorker(f.io,12811,'/repo',501),/OWNER_NOT_OS_STOPPED/);assert.deepEqual(f.actions,[]);
});
test('absent or unavailable pending mask permits backed-up resume, then one verified TERM',async()=>{
 for(const observed of [false,null]){
  const f=fixture();f.io.pendingTerm=async()=>observed;let tick=0;f.io.now=()=>tick;f.io.pause=async()=>{tick++;};
  const result=await resumeStoppedWorker(f.io,12811,'/repo',501,10,2);
  assert.equal(result.directedTermRequested,true);assert.deepEqual(f.actions,['backup','claim','CONT:12809','CONT:12811','claimTerm','TERM:12811']);
 }
});
test('backup failure blocks signals',async()=>{
 const f=fixture();f.io.backup=async()=>{throw Error('BACKUP_FAILED');};await assert.rejects(resumeStoppedWorker(f.io,12811,'/repo',501),/BACKUP_FAILED/);assert.deepEqual(f.signals,[]);
});
test('durable claim prevents repeated CONT',async()=>{
 const f=fixture();f.io.claim=async()=>{throw Error('ALREADY_CLAIMED');};await assert.rejects(resumeStoppedWorker(f.io,12811,'/repo',501),/ALREADY_CLAIMED/);assert.deepEqual(f.signals,[]);
});
test('identity changes during backup block signals',async()=>{
 const f=fixture();f.io.backup=async()=>{f.owner.startedAt='replacement';};await assert.rejects(resumeStoppedWorker(f.io,12811,'/repo',501),/OWNER_CHANGED_BEFORE_CONT/);assert.deepEqual(f.signals,[]);
});
test('generic or watch supervisor is never resumed',async()=>{
 for(const args of ['node /repo/apps/worker/src/index.ts','node /repo/node_modules/tsx/dist/cli.mjs watch /repo/apps/worker/src/index.ts']){
  const f=fixture();f.parent.args=args;await assert.rejects(resumeStoppedWorker(f.io,12811,'/repo',501),/STOPPED_PARENT_NOT_VERIFIED/);assert.deepEqual(f.signals,[]);
 }
});
test('timeout after CONT sends no further signals and does not delete locks',async()=>{
 const f=fixture();let time=0;f.io.now=()=>time;f.io.pause=async()=>{time++;};
 await assert.rejects(resumeStoppedWorker(f.io,12811,'/repo',501,2),/RESUME_TIMEOUT_NO_MORE_SIGNALS/);assert.deepEqual(f.signals,[12809,12811]);
});

// Actual POSIX stop/pending-TERM/resume using only the isolated lifecycle harness.
for(const queuedTerm of [true,false])test('OS-stopped fixture persists and unlocks after '+(queuedTerm?'queued TERM + CONT':'CONT + verified TERM'),{timeout:15000},async()=>{
 const {spawn,execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const fs=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {setTimeout:delay}=await import('node:timers/promises');const once=(await import('node:events')).default.once;
 const {readOwner,pathAbsent}=await import('../../../scripts/stop-owned-worker.js');
 const dir=await fs.mkdtemp(join(tmpdir(),'adl-stopped-fixture-'));const path=join(dir,'feed.json');const db=join(dir,'tickets.sqlite');
 const child=spawn(process.execPath,['--import','tsx','apps/worker/src/test-fixtures/shutdown.ts',path,db],{stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');let output='';child.stderr!.resume();
 try{
  await new Promise<void>((resolve,reject)=>{child.stdout!.on('data',d=>{output+=d;if(output.includes('READY'))resolve();});child.once('exit',()=>reject(Error('FIXTURE_EXITED_EARLY')));});
  child.kill('SIGSTOP');
  const state=async()=>{try{return (await promisify(execFile)('ps',['-p',String(child.pid),'-o','state='])).stdout.trim();}catch(error){const e=error as {code?:number;stdout?:string};if(e.code===1&&!e.stdout?.trim())return '';throw error;}};
  for(let n=0;n<100&&!/^T/.test(await state());n++)await delay(10);
  assert.match(await state(),/^T/);if(queuedTerm)child.kill('SIGTERM');await delay(100);assert.equal(child.exitCode,null);
  const uid=process.getuid!();const info={pid:child.pid!,parentPid:process.pid,uid,startedAt:'isolated-spawn-identity',args:'node /isolated/apps/worker/src/index.ts'};
  const before=await fs.readFile(path);let verifiedBackup=false;
  await resumeStoppedWorker({lock:()=>readOwner(path+'.lock'),identity:async(pid)=>pid===child.pid&&child.exitCode===null?info:undefined,
   cwd:async()=>'/isolated',state,pendingTerm:async()=>queuedTerm?true:null,now:Date.now,pause:()=>delay(20),
   claimTerm:async()=>{assert.equal(queuedTerm,false);assert.equal(verifiedBackup,true);},terminate:pid=>{assert.equal(queuedTerm,false);assert.equal(pid,child.pid);child.kill('SIGTERM');},
   backup:async()=>{await fs.copyFile(path,join(dir,'before.json'));assert.deepEqual(await fs.readFile(join(dir,'before.json')),before);verifiedBackup=true;},claim:async()=>{assert.equal(verifiedBackup,true);},
   signal:pid=>{assert.equal(pid,child.pid);child.kill('SIGCONT');},absent:()=>pathAbsent(path+'.lock')},child.pid!,'/isolated',uid,5000,100);
  const [code]=await exited;assert.equal(code,0);assert.equal(await pathAbsent(path+'.lock'),true);
  assert.match(await fs.readFile(path,'utf8'),/ISOLATED TEST DRAINED/);assert.deepEqual(await fs.readFile(join(dir,'before.json')),before);
 }finally{
  if(child.exitCode===null){child.kill('SIGCONT');child.kill('SIGTERM');await exited;}
  await fs.rm(dir,{recursive:true,force:true});
 }
});

test('owner suspended again after CONT is not sent TERM',async()=>{
 const f=fixture();f.io.pendingTerm=async()=>null;let tick=0;f.io.now=()=>tick;f.io.pause=async()=>{tick++;};f.io.state=async()=> 'T';
 await assert.rejects(resumeStoppedWorker(f.io,12811,'/repo',501,10,2),/OWNER_STOPPED_AGAIN_NO_TERM_SENT/);assert.ok(!f.actions.some(a=>a.startsWith('TERM:')));
});
test('replacement lock during resumed grace blocks directed TERM',async()=>{
 const f=fixture();f.io.pendingTerm=async()=>null;let tick=0;f.io.now=()=>tick;f.io.pause=async()=>{tick++;};
 f.io.lock=async()=>({pid:12811,uid:501,ino:tick>=2?999:1,dev:1});
 await assert.rejects(resumeStoppedWorker(f.io,12811,'/repo',501,10,2),/OWNER_OR_LOCK_CHANGED_BEFORE_TERM/);assert.ok(!f.actions.some(a=>a.startsWith('TERM:')));
});

test('observed suspended concurrently parent is preserved: only lock owner gets CONT/TERM',async()=>{
 const f=fixture();f.parent.args='node /repo/node_modules/concurrently/dist/bin/concurrently.js -k node --import tsx /repo/apps/worker/src/index.ts';
 f.io.pendingTerm=async()=>null;let tick=0;f.io.now=()=>tick;f.io.pause=async()=>{tick++;};
 const result=await resumeStoppedWorker(f.io,12811,'/repo',501,10,2);
 assert.equal(result.supervisorPreserved,12809);assert.equal(result.launcherResumed,null);
 assert.deepEqual(f.actions,['backup','claim','CONT:12811','claimTerm','TERM:12811']);
});

test('real suspended supervisor stays stopped while child drains, unlocks and becomes unreaped', {timeout:15000},async()=>{
 const {spawn}=await import('node:child_process');const once=(await import('node:events')).default.once;
 const fs=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {setTimeout:delay}=await import('node:timers/promises');
 const {processIdentity,processStateCode,readOwner,pathAbsent}=await import('../../../scripts/stop-owned-worker.js');
 const dir=await fs.mkdtemp(join(tmpdir(),'adl-stopped-supervisor-'));const file=join(dir,'feed.json');
 const code=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['--import','tsx','apps/worker/src/test-fixtures/shutdown.ts',process.argv[1],process.argv[2]],{stdio:['ignore','pipe','pipe']});console.log('PID:'+c.pid);c.stdout.pipe(process.stdout);c.stderr.resume();c.once('exit',()=>process.exit(0));`;
 const parent=spawn(process.execPath,['-e',code,file,join(dir,'tickets.sqlite')],{stdio:['ignore','pipe','pipe']});parent.stderr!.resume();const exited=once(parent,'exit');let text='',childPid=0;
 try{
  await new Promise<void>((resolve,reject)=>{parent.stdout!.on('data',d=>{text+=d;const match=text.match(/PID:(\d+)/);if(match)childPid=Number(match[1]);if(text.includes('READY'))resolve();});parent.once('exit',()=>reject(Error('SUPERVISOR_EXITED')));});
  process.kill(parent.pid!,'SIGSTOP');process.kill(childPid,'SIGSTOP');
  for(let n=0;n<100&&!/^T/.test(await processStateCode(childPid));n++)await delay(10);
  assert.match(await processStateCode(parent.pid!),/^T/);process.kill(childPid,'SIGTERM');
  const identities=async(pid:number)=>{
   const info=await processIdentity(pid);if(!info)return undefined;
   return {...info,args:pid===childPid?'node /isolated/apps/worker/src/index.ts':'node /isolated/node_modules/concurrently/dist/bin/concurrently.js node /isolated/apps/worker/src/index.ts'};
  };
  const result=await resumeStoppedWorker({lock:()=>readOwner(file+'.lock'),identity:identities,cwd:async()=>'/isolated',state:processStateCode,pendingTerm:async()=>null,
   backup:()=>fs.copyFile(file,join(dir,'backup.json')),claim:async()=>{},claimTerm:async()=>{},signal:pid=>{assert.equal(pid,childPid);process.kill(pid,'SIGCONT');},
   terminate:pid=>{assert.equal(pid,childPid);process.kill(pid,'SIGTERM');},absent:()=>pathAbsent(file+'.lock'),pause:()=>delay(20),now:Date.now},childPid,'/isolated',process.getuid!(),5000,100);
  assert.equal(result.lockReleased,true);assert.equal(result.supervisorPreserved,parent.pid);assert.equal(await processIdentity(childPid),undefined);
  assert.match(await processStateCode(parent.pid!),/^T/);assert.match(await fs.readFile(file,'utf8'),/ISOLATED TEST DRAINED/);
 }finally{
  // Only resume our isolated fixture supervisor to let it reap the already-exited child.
  if(childPid&&await processIdentity(childPid)){process.kill(childPid,'SIGCONT');process.kill(childPid,'SIGTERM');}
  if(parent.exitCode===null)parent.kill('SIGCONT');await exited;await fs.rm(dir,{recursive:true,force:true});
 }
});

test('new OS stop after directed TERM is identified without another signal',async()=>{
 const f=fixture();let tick=0,terminated=false;f.io.pendingTerm=async()=>null;f.io.now=()=>tick;f.io.pause=async()=>{tick++;};
 f.io.terminate=pid=>{terminated=true;f.actions.push('TERM:'+pid);};
 const oldState=f.io.state;f.io.state=async pid=>terminated&&pid===12811?'T':oldState(pid);
 await assert.rejects(resumeStoppedWorker(f.io,12811,'/repo',501,10,2),/OWNER_RESUSPENDED_AFTER_TERM_NO_MORE_SIGNALS/);
 assert.equal(f.actions.filter(a=>a.startsWith('TERM:')).length,1);assert.equal(f.signals.filter(pid=>pid===12811).length,1);
});
