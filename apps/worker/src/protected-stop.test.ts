import {test} from 'node:test';
import assert from 'node:assert/strict';
import {protect,terminateProtected,type ProtectedRecord} from '../../../scripts/protected-stop.js';
function fixture(){
 const owner={pid:11,parentPid:9,uid:501,startedAt:'old',args:'node /repo/apps/worker/src/index.ts'},parent={...owner,pid:9,parentPid:7,args:'node concurrently'};
 const lock={pid:11,uid:501,ino:1,dev:1};const record:ProtectedRecord={owner,parent,lock:{...lock},frozenOwner:false,frozenParent:false,backupVerified:false,terminationRequested:false};
 let ownerAlive=true,parentAlive=true,time=0;const frozen=new Set<number>();const calls:string[]=[];
 const io={identity:async(pid:number)=>pid===11?(ownerAlive?{...owner}:undefined):(parentAlive?{...parent}:undefined),cwd:async()=>'/repo',state:async(pid:number)=>frozen.has(pid)?'T':'S',lock:async()=>({...lock}),noTcp:async()=>true,children:async()=>ownerAlive?[11]:[],
  signal:(pid:number,s:'SIGSTOP'|'SIGCONT'|'SIGHUP')=>{calls.push(s+':'+pid);if(s==='SIGSTOP')frozen.add(pid);if(s==='SIGCONT'){frozen.delete(pid);if(pid===11&&record.terminationRequested)ownerAlive=false;if(pid===9&&!ownerAlive)parentAlive=false;}},
  save:async()=>{},backup:async()=>{calls.push('backup');},verifyBackup:async()=>{calls.push('verify-backup');},gone:()=>!ownerAlive&&!parentAlive,archive:async()=>{assert.equal(ownerAlive,false);calls.push('archive');},pause:async()=>{time++;},now:()=>time};
 return {record,io,calls,lock};
}
test('fresh protected backup precedes one authorized non-cooperative stop; archive only after real exit',async()=>{
 const f=fixture();await protect(f.io,f.record,'/repo',501);assert.equal(f.record.backupVerified,true);
 assert.deepEqual(f.calls.slice(0,4),['SIGSTOP:9','SIGSTOP:11','backup','verify-backup']);
 await terminateProtected(f.io,f.record,'/repo',501,true,20);
 assert.equal(f.calls.filter(c=>c==='SIGHUP:11').length,1);assert.equal(f.calls.at(-1),'archive');assert.ok(!f.calls.some(c=>c.includes('SIGKILL')||c.includes('SIGTERM')));
});
test('missing approval, missing backup and replaced lease all block termination',async()=>{
 let f=fixture();await assert.rejects(terminateProtected(f.io,f.record,'/repo',501,false),/APPROVAL_REQUIRED/);assert.deepEqual(f.calls,[]);
 await assert.rejects(terminateProtected(f.io,f.record,'/repo',501,true),/BACKUP_REQUIRED/);
 f=fixture();await protect(f.io,f.record,'/repo',501);f.lock.ino=9;await assert.rejects(terminateProtected(f.io,f.record,'/repo',501,true),/IDENTITY_OR_LEASE_CHANGED/);assert.ok(!f.calls.some(c=>c.startsWith('SIGHUP')));
});
test('network connection or unverifiable backup blocks before any fatal signal',async()=>{
 let f=fixture();f.io.noTcp=async()=>false;await assert.rejects(protect(f.io,f.record,'/repo',501),/TCP_PRESENT/);assert.deepEqual(f.calls,[]);
 f=fixture();f.io.backup=async()=>{throw Error('BACKUP_FAILED');};await assert.rejects(protect(f.io,f.record,'/repo',501),/BACKUP_FAILED/);assert.ok(!f.calls.some(c=>c.startsWith('SIGHUP')));assert.equal(f.record.backupVerified,false);
});
test('protected preparation resumes without repeating freeze or completed backup',async()=>{
 const f=fixture();await protect(f.io,f.record,'/repo',501);const before=[...f.calls];await protect(f.io,f.record,'/repo',501);assert.deepEqual(f.calls,[...before,'verify-backup']);
});
test('already attempted termination never sends HUP again to a living owner',async()=>{
 const f=fixture();await protect(f.io,f.record,'/repo',501);f.record.terminationRequested=true;
 await assert.rejects(terminateProtected(f.io,f.record,'/repo',501,true),/ALREADY_REQUESTED/);assert.ok(!f.calls.some(c=>c.startsWith('SIGHUP')));
});
test('crash after owner exit can finish parent reap/archive without repeating HUP',async()=>{
 const f=fixture();await protect(f.io,f.record,'/repo',501);f.record.terminationRequested=true;
 f.io.identity=async pid=>pid===11?undefined:{...f.record.parent};f.io.gone=()=>true;f.io.archive=async()=>{f.calls.push('archive');};
 await terminateProtected(f.io,f.record,'/repo',501,true);assert.equal(f.calls.at(-1),'archive');assert.ok(!f.calls.some(c=>c.startsWith('SIGHUP')));
});

test('isolated old process: protect committed ticket data, terminate with HUP, reap, then archive lock',{timeout:20000},async()=>{
 const fs=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawn,execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {once}=await import('node:events');const {setTimeout:delay}=await import('node:timers/promises');
 const {processIdentity,processStateCode,readOwner}=await import('../../../scripts/stop-owned-worker.js');const {DatabaseSync}=await import('node:sqlite');
 const dir=await fs.mkdtemp(join(tmpdir(),'adl-authorized-stop-fixture-'));const state=join(dir,'feed.json'),dbfile=join(dir,'tickets.sqlite'),childFile=join(dir,'old.cjs');
 await fs.writeFile(childFile,`const fs=require('node:fs');const{DatabaseSync}=require('node:sqlite');const p=process.argv[2],db=new DatabaseSync(process.argv[3]);db.exec('PRAGMA journal_mode=WAL;CREATE TABLE tickets(id TEXT PRIMARY KEY,body TEXT NOT NULL)');for(const[id,odd]of[['fixture-one','2.6233'],['fixture-two','1.9']])db.prepare('INSERT INTO tickets VALUES (?,?)').run(id,JSON.stringify({status:'LOST',revision:1,acceptedOdds:odd,returnMinor:'0'}));fs.writeFileSync(p+'.lock',String(process.pid));fs.writeFileSync(p,JSON.stringify({isolated:true,mode:'connected',heartbeat:0}));let n=0;setInterval(()=>fs.writeFileSync(p,JSON.stringify({isolated:true,mode:'connected',heartbeat:++n})),50);process.on('SIGTERM',()=>{});console.log('READY:'+process.pid);`);
 const launcher=`const{spawn}=require('node:child_process');const c=spawn(process.execPath,[process.argv[1],process.argv[2],process.argv[3]],{stdio:['ignore','pipe','pipe']});c.stdout.pipe(process.stdout);c.stderr.resume();c.once('exit',(code,signal)=>{console.error('CHILD_SIGNAL:'+signal);process.exit(0);});`;
 const parent=spawn(process.execPath,['-e',launcher,childFile,state,dbfile],{stdio:['ignore','pipe','pipe']});const parentExit=once(parent,'exit');let stdout='',stderr='',pid=0;parent.stdout!.on('data',d=>{stdout+=d;pid=Number(stdout.match(/READY:(\d+)/)?.[1]||0);});parent.stderr!.on('data',d=>{stderr+=d;});
 try{
  for(let n=0;n<200&&!pid;n++)await delay(10);assert.ok(pid);process.kill(pid,'SIGTERM'); // Known isolated fixture ignores graceful stop.
  const actualOwner=await processIdentity(pid),actualParent=await processIdentity(parent.pid!);assert.ok(actualOwner&&actualParent);
  const record:ProtectedRecord={owner:{...actualOwner,args:'node /repo/apps/worker/src/index.ts'},parent:{...actualParent,args:'node concurrently'},lock:await readOwner(state+'.lock'),frozenOwner:false,frozenParent:false,backupVerified:false,terminationRequested:false};
  const identity=async(target:number)=>{const info=await processIdentity(target);return info?{...info,args:target===pid?'node /repo/apps/worker/src/index.ts':'node concurrently'}:undefined;};
  const expected=[] as unknown[];const signals:string[]=[];const saved=join(dir,'protected.sqlite');
  const io={identity,cwd:async()=>'/repo',state:processStateCode,lock:()=>readOwner(state+'.lock'),noTcp:async()=>true,children:async()=>await processIdentity(pid)?[pid]:[],signal:(target:number,signal:'SIGSTOP'|'SIGCONT'|'SIGHUP')=>{signals.push(signal+':'+target);process.kill(target,signal);},save:async()=>{},
   backup:async()=>{await fs.copyFile(state,join(dir,'feed.before.json'));await promisify(execFile)(process.execPath,['--import','tsx','scripts/protected-sqlite.ts','--source',dbfile,'--destination',saved],{timeout:8000});const db=new DatabaseSync(saved,{readOnly:true});try{expected.push(...db.prepare('SELECT * FROM tickets ORDER BY id').all());}finally{db.close();}},
   verifyBackup:async()=>{assert.deepEqual(await fs.readFile(state),await fs.readFile(join(dir,'feed.before.json')));const db=new DatabaseSync(dbfile,{readOnly:true});try{assert.deepEqual(db.prepare('SELECT * FROM tickets ORDER BY id').all(),expected);}finally{db.close();}},
   gone:(target:number)=>{try{process.kill(target,0);return false;}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}},archive:async()=>{assert.equal(await processIdentity(pid),undefined);await fs.rename(state+'.lock',join(dir,'worker.lock.archived'));},pause:()=>delay(20),now:Date.now};
  await protect(io,record,'/repo',process.getuid!());assert.equal(record.backupVerified,true);assert.match(await processStateCode(pid),/^T/);
  await terminateProtected(io,record,'/repo',process.getuid!(),true,8000);await parentExit;
  assert.match(stderr,/CHILD_SIGNAL:SIGHUP/);assert.equal(signals.filter(s=>s==='SIGHUP:'+pid).length,1);assert.ok(!signals.some(s=>s.startsWith('SIGKILL')));assert.equal((await fs.readFile(join(dir,'worker.lock.archived'),'utf8')),String(pid));assert.equal(expected.length,2);
 }finally{
  // Only fixture cleanup; never touch user/runtime processes.
  if(parent.exitCode===null){parent.kill('SIGCONT');if(pid&&await processIdentity(pid)){process.kill(pid,'SIGHUP');process.kill(pid,'SIGCONT');}await parentExit;}
  await fs.rm(dir,{recursive:true,force:true});
 }
});
