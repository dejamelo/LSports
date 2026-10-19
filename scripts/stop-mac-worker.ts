import {root,statePath} from '@lsports/feed-store';
import {realpath} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {diagnoseCutover,safeError} from './cutover-diagnostics.js';
import {stopOwnedWorker,readOwner,processIdentity,processCwd,processStateCode,pathAbsent,journalHashes,normalPause} from './stop-owned-worker.js';
let stage='identify';let signalRequested=false;
const emit=(value:object)=>console.log(JSON.stringify({operation:'cutover.stop',workerStarted:false,awsChanged:false,...value}));
try{
 const state=statePath();const lock=state+'.lock';
 const before=await diagnoseCutover({state,refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});
 emit({stage,status:'ok',processes:before.processes,locks:before.locks});
 if(!await pathAbsent(lock)){
  stage='verified_shutdown';
  const result=await stopOwnedWorker({lock:()=>readOwner(lock),identity:processIdentity,cwd:processCwd,osState:processStateCode,
   absent:async()=>await pathAbsent(lock)&&await pathAbsent(lock+'.reclaim'),pause:normalPause,now:Date.now,
   signal:pid=>{signalRequested=true;process.kill(pid,'SIGTERM');},
   verified:(pid,parentPid)=>emit({stage:'signal_target',status:'verified',ownerPid:pid,parentPid,signal:'SIGTERM',parentSignaled:false})},await realpath(root),process.getuid!());
  emit({stage,status:'ok',...result});
 }
 stage='post_shutdown_audit';
 const after=await diagnoseCutover({state,refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});
 if(after.status!=='ok'){
  emit({stage,status:'blocked',signalRequested,evidence:after,note:'No repeated signals, escalation, parent/group stop or lock deletion. Supervisor may remain or have restarted worker; preserve evidence.'});
  process.exitCode=2;
 }else{
  stage='journal_stability';const first=await journalHashes(state);await delay(1000);
  if(first!==await journalHashes(state))throw Error('JOURNALS_CHANGED_AFTER_SHUTDOWN');
  // Recheck no writer after the stability interval. Export performs its own fresh audit too.
  const final=await diagnoseCutover({state,refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});
  if(final.status!=='ok'){emit({stage,status:'blocked',signalRequested,evidence:final});process.exitCode=2;}
  else emit({stage:'complete',status:'ok',signalRequested,workerLockAbsent:true,matchingWorkerProcesses:0,journalsStable:true,
    note:'Mac worker stopped normally; no worker started. Launcher may now export journals. notBeforeUTC comes from fresh export, not this stop step.'});
 }
}catch(e){
 const message=(e as Error).message;
 const allowed=['WORKER_OS_STOPPED_REQUIRES_RESUME_RECOVERY','PROCESS_STATE_UNVERIFIED','LOCK_UNVERIFIED','LOCK_OWNER_UNVERIFIED','LOCK_OWNER_NOT_VERIFIED_LSPORTS_WORKER','IDENTITY_CHANGED_BEFORE_SIGNAL','IDENTITY_CHANGED_WHILE_WAITING','GRACEFUL_SHUTDOWN_TIMEOUT_LOCK_PRESERVED','PROCESS_IDENTITY_UNVERIFIED','CWD_UNVERIFIED','PLATFORM_UNSUPPORTED','JOURNALS_MISSING','JOURNAL_UNVERIFIED','JOURNALS_CHANGED_AFTER_SHUTDOWN'];
 emit({stage,status:'blocked',signalRequested,reason:allowed.includes(message)?message:safeError(e),
  note:'No raw commands/errors printed. No force kill, parent/group signals or lock removal. Preserve checkpoint/journals; AWS worker remains untouched.'});process.exitCode=2;
}
