import {root,statePath} from '@lsports/feed-store';
import {diagnoseCutover,safeError} from './cutover-diagnostics.js';
import {processIdentity,processCwd,workerIdentity,sameIdentity,journalHashes} from './stop-owned-worker.js';
import {socketSummary,descriptorSummary,shutdownLogSignals} from './shutdown-observation.js';
import {lstat,open,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const exec=promisify(execFile);const state=statePath();
async function localRead(args:string[]){
 try{return {ok:true,text:(await exec('lsof',args,{timeout:5000,maxBuffer:1024*1024})).stdout};}
 catch(e){
  const error=e as {code?:unknown;stdout?:unknown;stderr?:unknown};
  if(error.code===1&&!String(error.stdout||'').trim()&&!String(error.stderr||'').trim())return {ok:true,text:'',empty:true};
  return {ok:false,text:'',reason:safeError(e)};
 }
}
async function fileStat(){try{const stat=await lstat(state);return {exists:true,regular:stat.isFile()&&!stat.isSymbolicLink(),bytes:stat.size,modifiedAt:new Date(stat.mtimeMs).toISOString()};}catch(e){return {exists:false,reason:safeError(e)};}}
async function logs(path:string){
 try{
  const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())return {status:'not_read',reason:'NOT_OWNED_REGULAR_FILE'};
  const file=await open(path,'r');try{const size=Math.min(stat.size,128*1024);const buffer=Buffer.alloc(size);const {bytesRead}=await file.read(buffer,0,size,Math.max(0,stat.size-size));return {status:'ok',...shutdownLogSignals(buffer.subarray(0,bytesRead).toString('utf8'))};}finally{await file.close();}
 }catch(e){return {status:'unverified',reason:safeError(e)};}
}
async function processMetrics(pid:number){
 let processState:object={status:'unverified'};
 try{
  const {stdout}=await exec('ps',['-p',String(pid),'-o','state=,etime=,time=,pcpu='],{timeout:5000,maxBuffer:4096,env:{...process.env,LC_ALL:'C'}});
  const parts=stdout.trim().split(/\s+/);
  processState={status:'ok',state:/^[A-Z+<NsWTsl-]{1,12}$/.test(parts[0]||'')?parts[0]:'other',elapsed:/^[\d:-]+$/.test(parts[1]||'')?parts[1]:null,cpuTime:/^[\d:.+-]+$/.test(parts[2]||'')?parts[2]:null,cpuPercent:Number.isFinite(Number(parts[3]))?Number(parts[3]):null};
 }catch(e){processState={status:'unverified',reason:safeError(e)};}
 return processState;
}
async function inspectOwner(report:Awaited<ReturnType<typeof diagnoseCutover>>){
 const lock=report.locks.find(l=>l.kind==='worker');const pid=lock&&'ownerPid' in lock?lock.ownerPid:undefined;
 if(!pid)return {status:'no_verified_owner_pid'};
 const info=await processIdentity(pid);if(!info)return {status:'owner_not_running',pid};
 const processState=await processMetrics(pid);
 let cwd:string;try{cwd=await processCwd(pid);}catch(e){return {status:'cwd_unverified',pid,processState,reason:safeError(e)};}
 const belongs=workerIdentity(info,await realpath(root),cwd,process.getuid!());
 if(!belongs)return {status:'identity_not_verified',pid,processState};
 const [tcp,fds]=await Promise.all([localRead(['-nP','-a','-p',String(pid),'-iTCP','-FfnT']),localRead(['-nP','-a','-p',String(pid),'-d','1,2','-Fftn'])]);
 const rechecked=await processIdentity(pid);
 if(!rechecked||!sameIdentity(info,rechecked))return {status:'owner_changed_during_inspection',pid};
 const descriptors=descriptorSummary(fds.text);const logEvidence=[];
 for(const descriptor of descriptors)if(descriptor.kind==='regular_file'&&descriptor.path)logEvidence.push({fd:descriptor.fd,...await logs(descriptor.path)});
 return {status:'verified',pid,parentPid:info.parentPid,processState,
  tcp:{status:tcp.ok?'ok':'unverified',reason:tcp.reason,sockets:socketSummary(tcp.text)},
  descriptors:{status:fds.ok?'ok':'unverified',reason:fds.reason,items:descriptors.map(d=>({fd:d.fd,kind:d.kind}))},logEvidence};
}
async function main(){
 const refreshMs=Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000);
 const before=await diagnoseCutover({state,refreshMs});
 let owner:object;try{owner=await inspectOwner(before);}catch(e){owner={status:'inspection_unverified',reason:safeError(e)};}
 const first=await fileStat();let hashes:string|undefined;try{hashes=await journalHashes(state);}catch{}
 await delay(5000);
 const second=await fileStat();let stable:boolean|null=null;try{stable=hashes===undefined?null:hashes===await journalHashes(state);}catch{}
 const after=await diagnoseCutover({state,refreshMs});
 const ready=after.status==='ok'&&stable===true;
 console.log(JSON.stringify({operation:'shutdown.diagnose',status:ready?'ready_for_export':'blocked',readOnly:true,providerRequests:0,workerStarted:false,awsChanged:false,
  owner,checkpointObservation:{before:first,after:second,changed:JSON.stringify(first)!==JSON.stringify(second)},journalsStable:stable,
  currentEvidence:after,observationWindowSeconds:5,pendingStage:'not_proven_in_existing_process',loadedCodeVersion:'unknown',
  note:'No signals or lock removal. Socket state and persisted phase do not identify a specific pending Promise. Logs may predate this signal; no raw commands, endpoints, log paths or payloads printed.'}));
 process.exitCode=ready?0:2;
}
main().catch(e=>{console.log(JSON.stringify({operation:'shutdown.diagnose',status:'blocked',readOnly:true,reason:safeError(e),workerStarted:false,note:'Inspection incomplete; no signal, deletion, AWS action or raw error.'}));process.exitCode=2;});
