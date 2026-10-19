// Resume only a revalidated OS-stopped owner (and, if necessary, its non-watch tsx launcher).
import type {Identity,Lock} from './stop-owned-worker.js';
import {sameIdentity,workerIdentity} from './stop-owned-worker.js';
export type ResumeIO={lock:()=>Promise<Lock>;identity:(pid:number)=>Promise<Identity|undefined>;cwd:(pid:number)=>Promise<string>;state:(pid:number)=>Promise<string>;pendingTerm:(pid:number)=>Promise<boolean|null>;backup:()=>Promise<void>;claim:()=>Promise<void>;signal:(pid:number)=>void;absent:()=>Promise<boolean>;pause:()=>Promise<void>;now:()=>number};
export async function resumeStoppedWorker(io:ResumeIO,expectedPid:number,root:string,uid:number,timeoutMs=120000){
 const lock=await io.lock();const owner=await io.identity(expectedPid);
 if(lock.pid!==expectedPid||lock.uid!==uid||!owner||!workerIdentity(owner,root,await io.cwd(expectedPid),uid))throw Error('OWNER_IDENTITY_NOT_VERIFIED');
 if(!/^T/.test(await io.state(expectedPid)))throw Error('OWNER_NOT_OS_STOPPED');
 const pending=await io.pendingTerm(expectedPid);if(pending===false)throw Error('SIGTERM_NOT_PENDING');
 let parent:Identity|undefined;
 const candidate=await io.identity(owner.parentPid);
 if(candidate&&/^T/.test(await io.state(candidate.pid))){
  if(!workerIdentity(candidate,root,await io.cwd(candidate.pid),uid)||!/(?:^|\/)(?:tsx\/dist\/cli\.[cm]?js|node_modules\/\.bin\/tsx)(?:\s|$)/.test(candidate.args)||/(?:^|\s)watch(?:\s|$)/.test(candidate.args))throw Error('STOPPED_PARENT_NOT_VERIFIED_TSX_LAUNCHER');
  parent=candidate;
 }
 await io.backup();
 const fresh=await io.identity(expectedPid);const latest=await io.lock();
 if(!fresh||!sameIdentity(owner,fresh)||lock.ino!==latest.ino||lock.dev!==latest.dev||lock.uid!==latest.uid||latest.pid!==expectedPid||!/^T/.test(await io.state(expectedPid)))throw Error('OWNER_CHANGED_BEFORE_CONT');
 if(await io.pendingTerm(expectedPid)===false)throw Error('SIGTERM_NOT_PENDING');
 if(parent&&fresh.parentPid!==parent.pid)throw Error('PARENT_RELATION_CHANGED_BEFORE_CONT');
 if(parent){const current=await io.identity(parent.pid);if(!current||!sameIdentity(parent,current)||!/^T/.test(await io.state(parent.pid)))throw Error('PARENT_CHANGED_BEFORE_CONT');}
 await io.claim(); // Durable one-shot intent: retries cannot blindly issue CONT again.
 if(parent)io.signal(parent.pid);
 io.signal(expectedPid);
 const deadline=io.now()+timeoutMs;
 while(io.now()<deadline){
  const current=await io.identity(expectedPid);
  if(!current&&await io.absent())return {ownerPid:expectedPid,launcherResumed:parent?.pid??null,signal:'SIGCONT',pendingTermObserved:pending,lockReleased:true};
  if(current&&!sameIdentity(owner,current))throw Error('OWNER_CHANGED_AFTER_CONT');
  await io.pause();
 }
 throw Error('RESUME_TIMEOUT_NO_MORE_SIGNALS');
}
