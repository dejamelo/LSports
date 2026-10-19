// One complete local preflight. Read only, no signals, worker imports or AWS actions.
import {statePath} from '@lsports/feed-store';
import {diagnoseCutover,safeError} from './cutover-diagnostics.js';
import {inspectWorkerFamily} from './worker-family.js';
import {journalHashes} from './stop-owned-worker.js';
import {lstat,statfs} from 'node:fs/promises';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
const fixed=['EXPLICIT_OWNER_PID_REQUIRED','OWNER_PID_DIFFERS_FROM_EXPLICIT_TARGET','OWNER_ALREADY_EXITED'];
async function guarded<T>(action:()=>Promise<T>){try{return {status:'ok',value:await action()};}catch(e){return {status:'unverified',reason:fixed.includes((e as Error).message)?(e as Error).message:safeError(e)};}}
try{
 if(process.argv.length!==4||process.argv[2]!=='--pid'||!/^\d+$/.test(process.argv[3]))throw Error('EXPLICIT_OWNER_PID_REQUIRED');
 const pid=Number(process.argv[3]);const state=statePath();const refreshMs=Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000);
 const evidence=await diagnoseCutover({state,refreshMs});const family=await guarded(()=>inspectWorkerFamily(pid));
 const checkpoint=await guarded(async()=>{const stat=await lstat(state);return {bytes:stat.size,modifiedAt:stat.mtimeMs};});
 const first=await guarded(()=>journalHashes(state));await delay(5000);const second=await guarded(()=>journalHashes(state));
 const finalCheckpoint=await guarded(async()=>{const stat=await lstat(state);return {bytes:stat.size,modifiedAt:stat.mtimeMs};});
 const free=await guarded(async()=>{const disk=await statfs(homedir());return {availableBytes:disk.bsize*disk.bavail};});
 const bytes=checkpoint.status==='ok'&&checkpoint.value?checkpoint.value.bytes:null;
 const bytesNeeded=bytes===null?null:bytes*2+64*1024*1024;
 console.log(JSON.stringify({operation:'cutover.complete_preflight.local',status:'collected',readOnly:true,ownerPid:pid,
  localEvidence:evidence,family,checkpointStable:checkpoint.status==='ok'&&finalCheckpoint.status==='ok'&&JSON.stringify(checkpoint)===JSON.stringify(finalCheckpoint),
  journalsStable:first.status==='ok'&&second.status==='ok'&&first.value===second.value,backupDisk:free,backupEstimatedBytes:bytesNeeded,
  nodeVersion:process.version,workerStarted:false,signalsSent:0,loadedCodeVersion:'unknown',
  note:'No process resumed/stopped, no locks reclaimed, no export or writes. Parent classification is evidence only. notBeforeUTC before shutdown is preliminary; export must recalculate.'}));
}catch(e){console.log(JSON.stringify({operation:'cutover.complete_preflight.local',status:'unverified',readOnly:true,reason:fixed.includes((e as Error).message)?(e as Error).message:safeError(e),signalsSent:0,workerStarted:false}));process.exitCode=2;}
