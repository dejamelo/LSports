// Read-only evidence for an ALREADY attempted shutdown. No signals or provider imports.
import {constants} from 'node:fs';
import {lstat,readFile,open} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {processIdentity,processStateCode,processCwd,workerIdentity,sameIdentity,readOwner} from './stop-owned-worker.js';
import {safeError} from './cutover-diagnostics.js';
const exec=promisify(execFile);
export function classifyShutdownEvidence(v:{ownerAlive:boolean;osState?:string;termIntentVerified:boolean;group?:number;foregroundGroup?:number;parentStopped?:boolean;outputSocketOrPipe?:boolean}){
 if(!v.ownerAlive)return {finding:'owner_exited',causeProven:false,next:'require_lock_release_and_stable_journals_before_export'};
 if(/^T/.test(v.osState||''))return {finding:v.termIntentVerified?'os_stopped_after_directed_term':'os_stopped',causeProven:false,
  backgroundGroup:v.group!==undefined&&v.foregroundGroup!==undefined&&v.group!==v.foregroundGroup,
  next:'inspect_terminal_and_supervisor_before_any_resume',possibilities:['terminal_job_control','external_stop_signal']};
 return {finding:'owner_alive_after_term',causeProven:false,next:'inspect_wait_and_persistence_evidence_no_repeat_term',
  supervisorBackpressurePossible:v.parentStopped===true&&v.outputSocketOrPipe===true};
}
async function protectedJson(file:string){
 const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid!()||(stat.mode&0o077)||stat.size>1024*1024)throw Error('EVIDENCE_FILE_UNVERIFIED');
 return JSON.parse(await readFile(file,'utf8'));
}
async function hash(file:string){
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const digest=createHash('sha256');try{const stat=await handle.stat();if(!stat.isFile()||stat.uid!==process.getuid!()||(stat.mode&0o077)||stat.size>256*1024*1024)throw Error('BACKUP_SIZE_LIMIT');for await(const chunk of handle.createReadStream({autoClose:false}))digest.update(chunk);return digest.digest('hex');}finally{await handle.close();}
}
async function groups(pid:number){
 const {stdout}=await exec('ps',['-p',String(pid),'-o','pgid=,tpgid='],{timeout:5000,maxBuffer:4096});
 const fields=stdout.trim().split(/\s+/).map(Number);if(fields.length!==2||!fields.every(Number.isSafeInteger))throw Error('JOB_CONTROL_UNVERIFIED');return {group:fields[0],foregroundGroup:fields[1]};
}
export async function shutdownAttemptEvidence(pid:number,state:string,root:string,outputSocketOrPipe:boolean){
 const owner=await processIdentity(pid);if(!owner)return {ownerAlive:false,finding:classifyShutdownEvidence({ownerAlive:false,termIntentVerified:false})};
 if(!workerIdentity(owner,root,await processCwd(pid),process.getuid!()))throw Error('ATTEMPT_OWNER_IDENTITY_UNVERIFIED');
 const identityHash=createHash('sha256').update(JSON.stringify({pid:owner.pid,uid:owner.uid,startedAt:owner.startedAt,args:owner.args})).digest('hex');
 const folder=join(homedir(),'Library','Application Support','ADL','Recovery');
 const intentPath=join(folder,'resume-'+pid+'-'+identityHash.slice(0,24)+'.intent.json');
 let attempt:Record<string,unknown>={status:'unverified'};let termIntentVerified=false;
 try{
  const intent=await protectedJson(intentPath);const term=await protectedJson(intentPath+'.term.json');
  if(intent.pid!==pid||term.pid!==pid||intent.identityHash!==identityHash||term.identityHash!==identityHash||term.signal!=='SIGTERM'||term.backup!==intent.backup)throw Error('ATTEMPT_IDENTITY_MISMATCH');
  const backup=resolve(intent.backup);if(dirname(backup)!==folder||!basename(backup).startsWith('stopped-worker-'))throw Error('BACKUP_LOCATION_UNVERIFIED');
  const dir=await lstat(backup);if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid!()||(dir.mode&0o077))throw Error('BACKUP_DIRECTORY_UNVERIFIED');
  const manifest=await protectedJson(join(backup,'manifest.private.json'));if(manifest.identityHash!==identityHash||manifest.pid!==pid||!Array.isArray(manifest.manifest))throw Error('MANIFEST_UNVERIFIED');
  let backupVerified=true;let checkpointMatchesBackup:boolean|null=null;
  for(const entry of manifest.manifest){
   if(!/^(checkpoint\.json|lock\.before|journal-\d+\.json)$/.test(entry.backupFile)||!/^[0-9a-f]{64}$/.test(entry.sha256))throw Error('MANIFEST_ENTRY_UNVERIFIED');
   const file=join(backup,entry.backupFile);const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile())throw Error('BACKUP_FILE_UNVERIFIED');
   backupVerified=backupVerified&&await hash(file)===entry.sha256;
   if(entry.backupFile==='checkpoint.json')checkpointMatchesBackup=await hash(state)===entry.sha256;
  }
  termIntentVerified=true;
  attempt={status:'verified',resumeIntentAt:intent.at,termIntentAt:term.at,intentsProve:'durable_intent_not_signal_delivery',identityMatches:true,backupPreserved:true,backupFilesVerified:backupVerified,checkpointMatchesBackup,backupFiles:manifest.manifest.length};
 }catch(e){attempt={status:'unverified',reason:/^[A-Z_]+$/.test((e as Error).message)?(e as Error).message:safeError(e)};}
 const chain=[];let current:number=pid;let parentStopped=false;let ownerGroups:{group:number;foregroundGroup:number}|undefined;let osState:string|undefined;
 for(let depth=0;depth<3&&current>1;depth++){
  const info=await processIdentity(current);if(!info)break;
  let job:object={status:'unverified'},s:string|undefined;
  try{const g=await groups(current);job={status:'ok',...g};if(depth===0)ownerGroups=g;}catch{}
  try{s=await processStateCode(current);}catch{}
  if(depth===0)osState=s;if(depth===1)parentStopped=/^T/.test(s||'');
  let waitClass='unverified';
  try{const raw=(await exec('ps',['-p',String(current),'-o','wchan='],{timeout:5000,maxBuffer:4096})).stdout.trim().toLowerCase();waitClass=/tty|ttin|ttou/.test(raw)?'terminal_wait':/pipe|sock|soread|sowrite/.test(raw)?'pipe_or_socket_wait':/poll|kevent|kqueue|select|epoll/.test(raw)?'event_loop_wait':/^[-0?]+$/.test(raw)?'not_reported':'other_wait';}catch{}
  chain.push({role:depth===0?'owner':depth===1?'parent':'ancestor',pid:current,parentPid:info.parentPid,state:s??'unverified',jobControl:job,waitClass});current=info.parentPid;
 }
 let terminal:object={status:'not_identified'};
 try{
  const raw=(await exec('lsof',['-nP','-a','-p',String(pid),'-d','0','-Ftn'],{timeout:5000,maxBuffer:65536})).stdout;
  const device=raw.split('\n').find(line=>/^n\/dev\/(?:ttys?\d+|pts\/\d+)$/.test(line))?.slice(1);
  if(device){const text=(await exec('stty',[process.platform==='darwin'?'-f':'-F',device,'-a'],{timeout:5000,maxBuffer:16384})).stdout;terminal={status:'ok',stdinTerminal:true,tostop:/(?:^|[\s;])tostop(?:[\s;]|$)/.test(text),settingsChanged:false};}
  else terminal={status:'ok',stdinTerminal:false,settingsChanged:false};
 }catch(e){terminal={status:'unverified',reason:safeError(e),settingsChanged:false};}
 const fresh=await processIdentity(pid);const identityStable=!!fresh&&sameIdentity(owner,fresh);
 return {ownerAlive:true,identityStable,attempt,chain,terminal,pendingSignalMaskAuthority:process.platform==='darwin'?'not_authoritative_not_used':'not_collected',finding:classifyShutdownEvidence({ownerAlive:true,osState,termIntentVerified,...ownerGroups,parentStopped,outputSocketOrPipe}),signalsSent:0};
}
