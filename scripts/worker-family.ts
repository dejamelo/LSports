import {statePath,root} from '@lsports/feed-store';
import {readOwner,processIdentity,processCwd,processStateCode,sameIdentity} from './stop-owned-worker.js';
import {launcherEvidence,childKind} from './launcher-evidence.js';
import {safeError} from './cutover-diagnostics.js';
import {realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export async function inspectWorkerFamily(pid:number){
 if(!Number.isSafeInteger(pid)||pid<=0)throw Error('EXPLICIT_OWNER_PID_REQUIRED');const lock=await readOwner(statePath()+'.lock');
 if(lock.pid!==pid)throw Error('OWNER_PID_DIFFERS_FROM_EXPLICIT_TARGET');
 const directory=await realpath(root);const uid=process.getuid!();const initial=await processIdentity(pid);
 if(!initial)throw Error('OWNER_ALREADY_EXITED');
 const {stdout}=await promisify(execFile)('ps',['-axo','pid=,ppid=,command='],{timeout:5000,maxBuffer:8*1024*1024});
 const table=stdout.split('\n').flatMap(line=>{const row=line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);return row?[{pid:Number(row[1]),parentPid:Number(row[2]),kind:childKind(row[3])}]:[];});
 const chain=[];const visited=new Set<number>();let current:number=pid;
 for(let depth=0;depth<4&&current>1&&!visited.has(current);depth++){
  visited.add(current);const info=await processIdentity(current);if(!info)break;
  let cwd:string|undefined;let cwdReason:string|undefined;let osState:string|undefined;
  try{cwd=await processCwd(current);}catch(e){cwdReason=safeError(e);}
  try{osState=await processStateCode(current);}catch{}
  let jobControl:object={status:'unverified'};
  try{
   const {stdout}=await promisify(execFile)('ps',['-p',String(current),'-o','pgid=,tpgid='],{timeout:5000,maxBuffer:4096});
   const fields=stdout.trim().split(/\s+/).map(Number);if(fields.length===2&&fields.every(Number.isSafeInteger))jobControl={status:'ok',processGroup:fields[0],terminalForegroundGroup:fields[1]};
  }catch{}
  chain.push({jobControl,role:depth===0?'lock_owner':depth===1?'direct_parent':'ancestor',...launcherEvidence(info,directory,cwd,uid),osState:osState??'unverified',cwdReason,
   children:table.filter(row=>row.parentPid===current).map(({pid,kind})=>({pid,kind}))});
  current=info.parentPid;
 }
 const fresh=await processIdentity(pid);const latest=await readOwner(statePath()+'.lock');
 const stable=!!fresh&&sameIdentity(initial,fresh)&&lock.pid===latest.pid&&lock.ino===latest.ino&&lock.dev===latest.dev&&lock.uid===latest.uid;
 const parent=chain.find(row=>row.role==='direct_parent');
 return {operation:'launcher.diagnose',status:stable?'ok':'blocked',readOnly:true,ownerPid:pid,identityStable:stable,parentPid:initial.parentPid,
  parentAcceptedByCurrentGate:parent?.acceptedByCurrentGate??false,parentFailedChecks:parent?.failedChecks??['parent_unavailable'],chain,
  workerStarted:false,awsChanged:false,signalsSent:0,note:'No raw argv/cwd/env/secrets printed. Current gate is unchanged. A shell/supervisor signature alone does not authorize resume; share sanitized report before changing recovery.'};
}
