// Backed-up OS resume, then at most one TERM to the same revalidated live owner if still needed.
import type {Identity,Lock} from './stop-owned-worker.js';
import {sameIdentity,workerIdentity} from './stop-owned-worker.js';
export type ResumeIO={lock:()=>Promise<Lock>;identity:(pid:number)=>Promise<Identity|undefined>;cwd:(pid:number)=>Promise<string>;state:(pid:number)=>Promise<string>;pendingTerm:(pid:number)=>Promise<boolean|null>;backup:()=>Promise<void>;claim:()=>Promise<void>;signal:(pid:number)=>void;terminate:(pid:number)=>void;claimTerm:()=>Promise<void>;absent:()=>Promise<boolean>;pause:()=>Promise<void>;now:()=>number};
export async function resumeStoppedWorker(io:ResumeIO,expectedPid:number,root:string,uid:number,timeoutMs=120000,resumeGraceMs=3000){
 const lock=await io.lock();const owner=await io.identity(expectedPid);
 if(lock.pid!==expectedPid||lock.uid!==uid||!owner||!workerIdentity(owner,root,await io.cwd(expectedPid),uid))throw Error('OWNER_IDENTITY_NOT_VERIFIED');
 if(!/^T/.test(await io.state(expectedPid)))throw Error('OWNER_NOT_OS_STOPPED');
 const pending=await io.pendingTerm(expectedPid); // Observation only; a legacy/empty mask is not a shutdown prerequisite.
 let parent:Identity|undefined;let supervisorPreserved:number|null=null;
 const candidate=await io.identity(owner.parentPid);
 if(candidate&&/^T/.test(await io.state(candidate.pid))){
  const valid=workerIdentity(candidate,root,await io.cwd(candidate.pid),uid);
  if(valid&&/(?:^|\/)(?:concurrently\/dist\/bin\/concurrently\.[cm]?js|concurrently\/dist\/bin\/concurrently|node_modules\/\.bin\/concurrently)(?:\s|$)/.test(candidate.args)){
   // Shared supervisor: never resume, terminate or signal its process group.
   supervisorPreserved=candidate.pid;
  }else{
   if(!valid||!/(?:^|\/)(?:tsx\/dist\/cli\.[cm]?js|node_modules\/\.bin\/tsx)(?:\s|$)/.test(candidate.args)||/(?:^|\s)watch(?:\s|$)/.test(candidate.args))throw Error('STOPPED_PARENT_NOT_VERIFIED_TSX_LAUNCHER');
   parent=candidate;
  }
 }
 await io.backup();
 const fresh=await io.identity(expectedPid);const latest=await io.lock();
 if(!fresh||!sameIdentity(owner,fresh)||lock.ino!==latest.ino||lock.dev!==latest.dev||lock.uid!==latest.uid||latest.pid!==expectedPid||!/^T/.test(await io.state(expectedPid)))throw Error('OWNER_CHANGED_BEFORE_CONT');
 if(parent&&fresh.parentPid!==parent.pid)throw Error('PARENT_RELATION_CHANGED_BEFORE_CONT');
 if(supervisorPreserved){const current=await io.identity(supervisorPreserved);if(!current||!candidate||!sameIdentity(candidate,current)||!/^T/.test(await io.state(supervisorPreserved))||fresh.parentPid!==supervisorPreserved)throw Error('SUPERVISOR_CHANGED_BEFORE_OWNER_CONT');}
 if(parent){const current=await io.identity(parent.pid);if(!current||!sameIdentity(parent,current)||!/^T/.test(await io.state(parent.pid)))throw Error('PARENT_CHANGED_BEFORE_CONT');}
 await io.claim(); // Durable one-shot intent: retries cannot blindly issue CONT again.
 if(parent)io.signal(parent.pid);
 io.signal(expectedPid);
 const resumedAt=io.now();const deadline=resumedAt+timeoutMs;let termRequested=false;
 while(io.now()<deadline){
  const current=await io.identity(expectedPid);
  if(!current&&await io.absent())return {ownerPid:expectedPid,launcherResumed:parent?.pid??null,supervisorPreserved,signal:'SIGCONT',pendingTermObserved:pending,directedTermRequested:termRequested,lockReleased:true};
  if(current&&!sameIdentity(owner,current))throw Error('OWNER_CHANGED_AFTER_CONT');
  if(current&&termRequested&&/^T/.test(await io.state(expectedPid)))throw Error('OWNER_RESUSPENDED_AFTER_TERM_NO_MORE_SIGNALS');
  if(current&&pending!==true&&!termRequested&&io.now()-resumedAt>=resumeGraceMs){
   if(/^T/.test(await io.state(expectedPid)))throw Error('OWNER_STOPPED_AGAIN_NO_TERM_SENT');
   if(await io.absent()){await io.pause();continue;}
   let currentLock:Lock;try{currentLock=await io.lock();}catch(e){if(await io.absent()){await io.pause();continue;}throw e;}
   if(currentLock.pid!==expectedPid||currentLock.uid!==lock.uid||currentLock.ino!==lock.ino||currentLock.dev!==lock.dev||!workerIdentity(current,root,await io.cwd(expectedPid),uid))throw Error('OWNER_OR_LOCK_CHANGED_BEFORE_TERM');
   await io.claimTerm();
   const final=await io.identity(expectedPid);
   if(!final){if(await io.absent())continue;throw Error('OWNER_EXITED_WITH_LOCK_PRESERVED');}
   if(await io.absent()){await io.pause();continue;}
   let finalLock:Lock;try{finalLock=await io.lock();}catch(e){if(await io.absent()){await io.pause();continue;}throw e;}
   if(!sameIdentity(owner,final)||finalLock.pid!==expectedPid||finalLock.uid!==lock.uid||finalLock.ino!==lock.ino||finalLock.dev!==lock.dev||/^T/.test(await io.state(expectedPid)))throw Error('OWNER_CHANGED_BEFORE_DIRECTED_TERM');
   termRequested=true;io.terminate(expectedPid);
  }
  await io.pause();
 }
 throw Error('RESUME_TIMEOUT_NO_MORE_SIGNALS');
}
