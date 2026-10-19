import {root,statePath} from '@lsports/feed-store';
import {ticketDatabasePath} from '@lsports/feed-store/tickets';
import {platformDirectory} from '@lsports/feed-store/platform';
import {protect,terminateProtected,type ProtectedRecord} from './protected-stop.js';
import {shutdownAttemptEvidence} from './shutdown-attempt-evidence.js';
import {verifiedSupervisorPolicy} from './supervisor-runtime-policy.js';
import {readOwner,processIdentity,processObservation,processCwd,processStateCode,pathAbsent,sameIdentity} from './stop-owned-worker.js';
import {diagnoseCutover,safeError} from './cutover-diagnostics.js';
import {lstat,readFile,readdir,mkdir,mkdtemp,open,rename,copyFile,chmod,unlink,statfs,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const exec=promisify(execFile);let stage='arguments';let record:ProtectedRecord&{backup?:string;archive?:string}|undefined;let recordPath='';
const emit=(v:object)=>console.log(JSON.stringify({operation:'cutover.protected',workerStarted:false,awsChanged:false,...v}));
async function digest(path:string){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const hash=createHash('sha256');try{for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk);return hash.digest('hex');}finally{await file.close();}}
async function writePrivate(file:string,value:unknown){const fd=await open(file,'wx',0o600);try{await fd.writeFile(JSON.stringify(value));await fd.sync();}finally{await fd.close();}}
async function atomic(file:string,value:unknown){const tmp=file+'.'+process.pid+'.tmp';await writePrivate(tmp,value);await rename(tmp,file);}
async function checkedJson(file:string){const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid!()||(stat.mode&0o077)||stat.size>1024*1024)throw Error('PRIVATE_RECORD_UNVERIFIED');return JSON.parse(await readFile(file,'utf8'));}
async function sqlite(source:string,destination?:string){
 const {stdout}=await exec(process.execPath,['--import','tsx','scripts/protected-sqlite.ts','--source',source,...(destination?['--destination',destination]:[])],{cwd:root,timeout:30000,maxBuffer:65536});
 const result=JSON.parse(stdout);if(result.operation!=='cutover.sqlite'||result.status!=='ok')throw Error('SQLITE_BACKUP_OR_INTEGRITY_FAILED');return result;
}
async function noTcp(pid:number){try{const {stdout}=await exec('lsof',['-nP','-a','-p',String(pid),'-iTCP','-FfnT'],{timeout:5000,maxBuffer:65536});return !stdout.trim();}catch(e){const error=e as {code?:number;stdout?:string;stderr?:string};if(error.code===1&&!error.stdout?.trim()&&!error.stderr?.trim())return true;throw Error('TCP_ABSENCE_UNVERIFIED');}}
function gone(pid:number){try{process.kill(pid,0);return false;}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}}
async function main(){
 const args=process.argv.slice(2);if(args.length!==5||args[0]!=='--pid'||args[2]!=='--parent'||!/^\d+$/.test(args[1])||!/^\d+$/.test(args[3])||!['--protect','--approve-abrupt-stop'].includes(args[4]))throw Error('PROTECTED_ARGUMENTS_REQUIRED');
 const pid=Number(args[1]),parentPid=Number(args[3]);if(!Number.isSafeInteger(pid)||!Number.isSafeInteger(parentPid)||pid<=1||parentPid<=1||pid===parentPid)throw Error('INVALID_PIDS');
 const directory=await realpath(root),state=statePath(),lockPath=state+'.lock';
 const recovery=join(homedir(),'Library','Application Support','ADL','Recovery');const folder=await lstat(recovery);
 if(!folder.isDirectory()||folder.isSymbolicLink()||folder.uid!==process.getuid!()||(folder.mode&0o077))throw Error('RECOVERY_DIRECTORY_UNVERIFIED');
 recordPath=join(recovery,'protected-'+pid+'-'+parentPid+'.json');
 stage='prior_evidence';
 if(await pathAbsent(recordPath)){
  if(args[4]!=='--protect')throw Error('PREPARE_PROTECTION_FIRST');
  const evidence=await shutdownAttemptEvidence(pid,state,directory,true);
  if(!evidence.ownerAlive||evidence.attempt?.status!=='verified'||evidence.attempt.backupFilesVerified!==true||!evidence.identityStable)throw Error('EXISTING_BACKUP_OR_OWNER_UNVERIFIED');
  const owner=await processIdentity(pid),parent=await processIdentity(parentPid);if(!owner||!parent||owner.parentPid!==parentPid)throw Error('PARENT_RELATION_UNVERIFIED');
  const drainHash=createHash('sha256').update(JSON.stringify({owner,parent})).digest('hex');
  const drain=await checkedJson(join(recovery,'supervisor-drain-'+parentPid+'-'+drainHash.slice(0,24)+'.json'));
  if(drain.ownerPid!==pid||drain.parentPid!==parentPid||drain.identityHash!==drainHash)throw Error('PRIOR_DRAIN_UNVERIFIED');
  record={owner,parent,lock:await readOwner(lockPath),frozenOwner:false,frozenParent:false,backupVerified:false,terminationRequested:false};await writePrivate(recordPath,record);
 }else record=await checkedJson(recordPath);
 if(!record||record.owner.pid!==pid||record.parent.pid!==parentPid)throw Error('PROTECTED_RECORD_IDENTITY_MISMATCH');
 const r=record;
 const databases=[{label:'legacy-tickets',source:ticketDatabasePath()},{label:'platform',source:join(platformDirectory(),'control.sqlite')}];
 const existing:{label:string;source:string}[]=[];for(const db of databases)if(!await pathAbsent(db.source)){const stat=await lstat(db.source);if(!stat.isFile()||stat.isSymbolicLink())throw Error('DATABASE_SOURCE_UNVERIFIED');existing.push(db);}
 if(!existing.some(db=>db.label==='legacy-tickets'))throw Error('EXISTING_TICKETS_DATABASE_REQUIRED');
 const save=async()=>atomic(recordPath,r);
 const backup=async()=>{
  stage='current_state_backup';
  const persisted=await diagnoseCutover({state,refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});
  if(persisted.blockers.some(blocker=>!['processes','locks'].includes(blocker.stage)))throw Error('PERSISTED_JSON_OR_COOLDOWN_INVALID');
  if(r.backup)throw Error('PARTIAL_BACKUP_PRESERVED_REVIEW_MANIFEST');
  const all=await readdir(dirname(state));const journals=all.filter(name=>name.startsWith(basename(state)+'.snapshot-')&&/\.json$/.test(name));if(!journals.length)throw Error('JOURNALS_MISSING');
  const sources=[state,lockPath,...journals.map(name=>join(dirname(state),name))];
  if(all.some(name=>(name===basename(state)+'.lock.reclaim'||name.startsWith(basename(state)+'.snapshot-')&&/\.(lock|reclaim)$/.test(name))))throw Error('OTHER_GUARD_PRESENT_PRESERVED');
  let bytes=0;for(const file of [...sources,...existing.map(db=>db.source)]){const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('BACKUP_SOURCE_UNVERIFIED');bytes+=stat.size;}
  const disk=await statfs(recovery);if(disk.bavail*disk.bsize<bytes*4+128*1024*1024)throw Error('PROTECTED_BACKUP_SPACE_INSUFFICIENT');
  r.backup=await mkdtemp(join(recovery,'protected-current-'));await chmod(r.backup,0o700);await save();
  const files=[];for(const [i,source] of sources.entries()){
   const target=join(r.backup,'source-'+i+'.json');const before=await digest(source);await copyFile(source,target,constants.COPYFILE_EXCL);await chmod(target,0o600);
   const handle=await open(target,'r+');try{await handle.sync();}finally{await handle.close();}
   if(before!==await digest(target)||before!==await digest(source))throw Error('FROZEN_SOURCE_CHANGED');files.push({source,target,sha256:before});
  }
  const dbs=[];for(const db of existing){emit({stage:'sqlite_backup',status:'running',database:db.label});const target=join(r.backup,db.label+'.sqlite');const result=await sqlite(db.source,target);dbs.push({...db,target,fingerprint:result.fingerprint,rows:result.rows});}
  await writePrivate(join(r.backup,'manifest.json'),{at:new Date().toISOString(),files,databases:dbs,priorBackupsPreserved:true});
  emit({stage,status:'ok',backup:r.backup,files:files.length,databases:dbs.map(d=>({label:d.label,rows:d.rows})),sha256Verified:true});
 };
 const verifyBackup=async()=>{
  if(!r.backup)throw Error('PROTECTED_BACKUP_MISSING');const manifest=await checkedJson(join(r.backup,'manifest.json'));
  for(const file of manifest.files){
   if(dirname(file.target)!==r.backup||await digest(file.target)!==file.sha256)throw Error('PROTECTED_BACKUP_HASH_MISMATCH');
   const source=file.source===lockPath&&await pathAbsent(lockPath)&&r.archive?r.archive:file.source;
   if(await digest(source)!==file.sha256)throw Error('PROTECTED_SOURCE_CHANGED');
  }
  for(const db of manifest.databases){if((await sqlite(db.source)).fingerprint!==db.fingerprint||(await sqlite(db.target)).fingerprint!==db.fingerprint)throw Error('COMMITTED_DATABASE_CONTENT_CHANGED');}
 };
 const archive=async()=>{
  stage='archive_verified_dead_lock';if(!gone(pid))throw Error('OWNER_NOT_DEAD_LOCK_PRESERVED');
  let audit=await diagnoseCutover({state,refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});
  // Give the reaping supervisor time to exit; never hide it from the consumer audit.
  const auditDeadline=Date.now()+5000;
  while(audit.blockers.some(b=>b.stage==='processes')&&Date.now()<auditDeadline){await delay(500);audit=await diagnoseCutover({state,refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});}
  if(audit.blockers.some(b=>b.stage!=='locks')||audit.locks.some(l=>l.kind!=='worker'))throw Error('LOCAL_CONSUMER_OR_JOURNAL_AUDIT_BLOCKED_LOCK_PRESERVED');
  if(!gone(pid))throw Error('OWNER_NOT_DEAD_LOCK_PRESERVED');
  const guardPath=lockPath+'.reclaim';const guard=await open(guardPath,'wx',0o600);const guardInfo=await guard.stat();
  try{
   await guard.writeFile(String(process.pid));await guard.sync();
   if(await pathAbsent(lockPath)){if(!r.archive||!gone(pid))throw Error('LOCK_ARCHIVE_UNVERIFIED');const archived=await readOwner(r.archive);if(archived.pid!==pid||archived.ino!==r.lock.ino||archived.dev!==r.lock.dev)throw Error('LOCK_ARCHIVE_IDENTITY_CHANGED');return;}
   const current=await readOwner(lockPath);if(!gone(pid)||current.pid!==r.lock.pid||current.ino!==r.lock.ino||current.dev!==r.lock.dev||current.uid!==r.lock.uid)throw Error('DEAD_LOCK_IDENTITY_CHANGED');
   r.archive=lockPath+'.archived-protected-'+createHash('sha256').update(recordPath).digest('hex').slice(0,16);await save();
   if(!await pathAbsent(r.archive))throw Error('LOCK_ARCHIVE_DESTINATION_EXISTS');
   await rename(lockPath,r.archive);await save();emit({stage,status:'ok',ownerExited:true,checkpointModified:false,ticketsModified:false});
  }finally{
   await guard.close();const now=await lstat(guardPath);if(now.ino===guardInfo.ino&&now.dev===guardInfo.dev&&await readFile(guardPath,'utf8')===String(process.pid))await unlink(guardPath);
  }
 };
 const io={observe:processObservation,report:emit,identity:processIdentity,cwd:processCwd,state:processStateCode,lock:()=>readOwner(lockPath),noTcp:()=>noTcp(pid),
  children:async()=>{const {stdout}=await exec('ps',['-axo','pid=,ppid=,state='],{timeout:5000,maxBuffer:1024*1024});return stdout.split('\n').flatMap(line=>{const f=line.trim().split(/\s+/);return Number(f[1])===parentPid&&!/^Z/.test(f[2]||'')?[Number(f[0])]:[];});},
  signal:(target:number,signal:'SIGSTOP'|'SIGCONT'|'SIGHUP')=>{process.kill(target,signal);emit({stage,status:'signal_sent',pid:target,signal});},save,backup,verifyBackup,gone,archive,pause:()=>delay(100),now:Date.now};
 if(args[4]==='--protect'){
  stage='supervisor_policy';await verifiedSupervisorPolicy(r.parent,directory);
  stage='protect_current_state';await protect(io,r,directory,process.getuid!());
  emit({stage:'protected_ready',status:'protected',record:recordPath,backup:r.backup,workerFrozen:true,supervisorFrozen:true,lockPreserved:true,priorBackupsPreserved:true,proposedSignal:'SIGHUP',nonCooperative:true,impact:'Pending in-memory work may be lost; finally will not be awaited. Persisted committed state verified; no SIGKILL, no automatic restoration or migration.'});return;
 }
 stage='approved_abrupt_termination';await terminateProtected(io,r,directory,process.getuid!(),true);
 stage='export_gate';const evidence=await diagnoseCutover({state,refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});if(evidence.status!=='ok')throw Error('EXPORT_AUDIT_NOT_CLEAR');
 emit({stage:'complete',status:'ok',ownerExited:true,lockArchived:true,backup:r.backup,notBeforeUTC:evidence.notBeforeUTC});
}
main().catch(async error=>{const message=(error as Error).message;emit({stage,status:'blocked',reason:/^[A-Z_]+$/.test(message)?message:safeError(error),record:recordPath||undefined,backup:record?.backup,workerFrozen:record?.frozenOwner,supervisorFrozen:record?.frozenParent,terminationRequested:record?.terminationRequested,note:'Preserve protected state and prior backups. No repeated termination or lock removal from live owner. AWS untouched.'});process.exitCode=2;});
