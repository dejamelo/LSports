// Resume only the independently verified stopped supervisor. Never signal owner/group.
import type {Identity,Lock} from './stop-owned-worker.js';
import {sameIdentity,workerIdentity} from './stop-owned-worker.js';
export function supervisorPolicy(args:string,environmentNames:string[],version:string,defaults:string){
 const forbidden=/(?:^|\s)(?:--(?:restart(?:-tries|Tries)|max(?:-processes|Processes)|kill(?:-timeout|Timeout|-signal|Signal)|handle(?:-input|Input)|raw|passthrough(?:-arguments|Arguments))(?:=|\s|$)|-[mir][^\s]*(?:\s|$)|--(?:\s|$))/;
 if(forbidden.test(args)||/(?:^|\s)-(?!-)[A-Za-z]*[mir][^\s]*(?:\s|$)/.test(args))throw Error('SUPERVISOR_CUSTOM_LIFECYCLE_OPTIONS');
 if(environmentNames.some(n=>!['CONCURRENTLY_NAMES','CONCURRENTLY_PREFIX','CONCURRENTLY_PREFIX_COLORS'].includes(n)))throw Error('SUPERVISOR_CUSTOM_ENVIRONMENT');
 if(!/^9\./.test(version)||!/exports\.restartTries\s*=\s*0\s*;/.test(defaults)||!/exports\.maxProcesses\s*=\s*0\s*;/.test(defaults)||!/exports\.handleInput\s*=\s*false\s*;/.test(defaults)||!/exports\.killSignal\s*=\s*undefined\s*;/.test(defaults))throw Error('SUPERVISOR_DEFAULTS_UNVERIFIED');
 return {restartTries:0,inputForwarding:false,queuedCommands:false,forceKillConfigured:false,normalKillOthers:/\s(?:-k|--kill-others)(?:\s|$)/.test(args)};
}
export type DrainIO={identity:(pid:number)=>Promise<Identity|undefined>;cwd:(pid:number)=>Promise<string>;state:(pid:number)=>Promise<string>;lock:()=>Promise<Lock>;children:(pid:number)=>Promise<number[]>;claim:()=>Promise<void>;resumeParent:(pid:number)=>void;absent:()=>Promise<boolean>;pause:()=>Promise<void>;now:()=>number};
export async function drainSupervisor(io:DrainIO,pid:number,parentPid:number,root:string,uid:number,timeout=120000){
 const owner=await io.identity(pid),parent=await io.identity(parentPid),lock=await io.lock();
 if(!owner||!parent||owner.parentPid!==parentPid||!workerIdentity(owner,root,await io.cwd(pid),uid)||parent.uid!==uid||await io.cwd(parentPid)!==root||lock.pid!==pid||lock.uid!==uid)throw Error('DRAIN_IDENTITY_UNVERIFIED');
 if(/^T/.test(await io.state(pid))||!/^T/.test(await io.state(parentPid)))throw Error('DRAIN_PROCESS_STATE_CHANGED');
 const children=await io.children(parentPid);if(children.length!==1||children[0]!==pid)throw Error('SUPERVISOR_OTHER_LIVE_CHILDREN');
 await io.claim();
 const freshOwner=await io.identity(pid),freshParent=await io.identity(parentPid),freshLock=await io.lock();
 if(!freshOwner||!freshParent||!sameIdentity(owner,freshOwner)||!sameIdentity(parent,freshParent)||freshOwner.parentPid!==parentPid||freshLock.ino!==lock.ino||freshLock.dev!==lock.dev||freshLock.uid!==uid||freshLock.pid!==pid||/^T/.test(await io.state(pid))||!/^T/.test(await io.state(parentPid)))throw Error('DRAIN_IDENTITY_CHANGED_BEFORE_CONT');
 io.resumeParent(parentPid);
 const until=io.now()+timeout;
 while(io.now()<until){
  const current=await io.identity(pid),supervisor=await io.identity(parentPid);
  if(current&&!sameIdentity(owner,current)||supervisor&&!sameIdentity(parent,supervisor))throw Error('DRAIN_PID_IDENTITY_CHANGED');
  if(!current&&!supervisor&&await io.absent())return {ownerExited:true,supervisorExited:true,lockReleased:true,signalsToWorker:0,signalToParent:'SIGCONT'};
  const stateIfAlive=async(target:number)=>{try{return await io.state(target);}catch(error){if(!await io.identity(target))return undefined;throw error;}};
  if(current&&/^T/.test((await stateIfAlive(pid))||''))throw Error('WORKER_STOPPED_DURING_DRAIN');
  if(supervisor&&/^T/.test((await stateIfAlive(parentPid))||''))throw Error('SUPERVISOR_STOPPED_AGAIN_NO_REPEAT');
  if(supervisor&&(await io.children(parentPid)).some(child=>child!==pid))throw Error('SUPERVISOR_NEW_CHILD_NO_AWS_START');
  await io.pause();
 }
 throw Error('SUPERVISOR_DRAIN_TIMEOUT_NO_MORE_SIGNALS');
}
