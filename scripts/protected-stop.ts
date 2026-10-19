import type {Identity,Lock} from './stop-owned-worker.js';
import {sameIdentity,workerIdentity} from './stop-owned-worker.js';
export type ProtectedRecord={owner:Identity;parent:Identity;lock:Lock;frozenOwner:boolean;frozenParent:boolean;backupVerified:boolean;terminationRequested:boolean;hupSent?:boolean;ownerContinueRequested?:boolean;parentContinueRequested?:boolean};
export type ProtectedIO={identity:(pid:number)=>Promise<Identity|undefined>;cwd:(pid:number)=>Promise<string>;state:(pid:number)=>Promise<string>;lock:()=>Promise<Lock>;noTcp:()=>Promise<boolean>;children:()=>Promise<number[]>;signal:(pid:number,s:'SIGSTOP'|'SIGCONT'|'SIGHUP')=>void;save:(record:ProtectedRecord)=>Promise<void>;backup:()=>Promise<void>;verifyBackup:()=>Promise<void>;gone:(pid:number)=>boolean;archive:()=>Promise<void>;pause:()=>Promise<void>;now:()=>number};
const lease=(a:Lock,b:Lock)=>a.pid===b.pid&&a.uid===b.uid&&a.ino===b.ino&&a.dev===b.dev;
async function verify(io:ProtectedIO,r:ProtectedRecord,root:string,uid:number){
 const owner=await io.identity(r.owner.pid),parent=await io.identity(r.parent.pid);
 if(!owner||!parent||!sameIdentity(r.owner,owner)||!sameIdentity(r.parent,parent)||owner.parentPid!==parent.pid||!workerIdentity(owner,root,await io.cwd(owner.pid),uid)||parent.uid!==uid||await io.cwd(parent.pid)!==root||!lease(r.lock,await io.lock()))throw Error('PROTECTED_IDENTITY_OR_LEASE_CHANGED');
 if((await io.children()).some(pid=>pid!==owner.pid))throw Error('PROTECTED_OTHER_SUPERVISOR_CHILD');
 if(!await io.noTcp())throw Error('PROTECTED_WORKER_TCP_PRESENT');
}
export async function protect(io:ProtectedIO,r:ProtectedRecord,root:string,uid:number){
 await verify(io,r,root,uid);
 if(r.terminationRequested)throw Error('TERMINATION_ALREADY_REQUESTED_NO_REPEAT');
 if(r.backupVerified){
  if(!/^T/.test(await io.state(r.owner.pid))||!/^T/.test(await io.state(r.parent.pid)))throw Error('PROTECTED_FREEZE_LOST');
  await io.verifyBackup();return r;
 }
 // Mark intent BEFORE each one-shot signal. A crash with uncertain delivery blocks replay.
 if(!r.frozenParent){if(/^T/.test(await io.state(r.parent.pid)))throw Error('UNOWNED_PARENT_FREEZE');r.frozenParent=true;await io.save(r);io.signal(r.parent.pid,'SIGSTOP');}
 if(!r.frozenOwner){if(/^T/.test(await io.state(r.owner.pid)))throw Error('UNOWNED_WORKER_FREEZE');r.frozenOwner=true;await io.save(r);io.signal(r.owner.pid,'SIGSTOP');}
 for(let n=0;n<20;n++){if(/^T/.test(await io.state(r.owner.pid))&&/^T/.test(await io.state(r.parent.pid)))break;await io.pause();}
 if(!/^T/.test(await io.state(r.owner.pid))||!/^T/.test(await io.state(r.parent.pid)))throw Error('PROTECT_FREEZE_NOT_CONFIRMED');
 await verify(io,r,root,uid);await io.backup();await io.verifyBackup();r.backupVerified=true;await io.save(r);return r;
}
export async function terminateProtected(io:ProtectedIO,r:ProtectedRecord,root:string,uid:number,approved:boolean,timeout=30000){
 if(!approved)throw Error('ABRUPT_TERMINATION_APPROVAL_REQUIRED');
 if(!r.backupVerified||!r.frozenOwner||!r.frozenParent)throw Error('PROTECTED_BACKUP_REQUIRED');
 if(r.terminationRequested){
  if(await io.identity(r.owner.pid))throw Error('TERMINATION_ALREADY_REQUESTED_INSPECT_NO_REPEAT');
 }else{
  await verify(io,r,root,uid);await io.verifyBackup();
  if(!/^T/.test(await io.state(r.owner.pid))||!/^T/.test(await io.state(r.parent.pid)))throw Error('PROTECTED_FREEZE_LOST');
  r.terminationRequested=true;await io.save(r);
  io.signal(r.owner.pid,'SIGHUP');r.hupSent=true;await io.save(r);
  r.ownerContinueRequested=true;await io.save(r);io.signal(r.owner.pid,'SIGCONT');
 }
 const until=io.now()+timeout;let parentContinued=!!r.parentContinueRequested;
 while(io.now()<until){
  const current=await io.identity(r.owner.pid);
  if(current&&!sameIdentity(r.owner,current))throw Error('PID_REUSED_AFTER_TERMINATION');
  if(!current&&!parentContinued){
   const parent=await io.identity(r.parent.pid);
   if(parent&&!sameIdentity(parent,r.parent))throw Error('PARENT_CHANGED_AFTER_TERMINATION');
   if(parent){r.parentContinueRequested=true;await io.save(r);io.signal(parent.pid,'SIGCONT');parentContinued=true;}
  }
  if(!current&&io.gone(r.owner.pid)){
   await io.verifyBackup();await io.archive();return {ownerExited:true,staleLockArchived:true,nonCooperative:true};
  }
  await io.pause();
 }
 throw Error('ABRUPT_TERMINATION_NOT_CONFIRMED_NO_ESCALATION');
}
