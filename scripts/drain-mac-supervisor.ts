import {verifiedSupervisorPolicy} from './supervisor-runtime-policy.js';
import {root,statePath} from '@lsports/feed-store';
import {shutdownAttemptEvidence} from './shutdown-attempt-evidence.js';
import {supervisorPolicy,drainSupervisor} from './drain-supervisor.js';
import {processIdentity,processCwd,processStateCode,readOwner,pathAbsent,journalHashes,normalPause} from './stop-owned-worker.js';
import {diagnoseCutover,safeError} from './cutover-diagnostics.js';
import {readFile,lstat,realpath,open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const exec=promisify(execFile);let stage='arguments',parentResumed=false;
const emit=(value:object)=>console.log(JSON.stringify({operation:'cutover.drain',workerStarted:false,awsChanged:false,...value}));
async function children(pid:number){const {stdout}=await exec('ps',['-axo','pid=,ppid=,state='],{timeout:5000,maxBuffer:1024*1024});return stdout.trim().split('\n').flatMap(row=>{const fields=row.trim().split(/\s+/);return Number(fields[1])===pid&&!/^Z/.test(fields[2]||'')?[Number(fields[0])]:[];});}
try{
 if(process.argv.length!==6||process.argv[2]!=='--pid'||process.argv[4]!=='--parent'||!/^\d+$/.test(process.argv[3])||!/^\d+$/.test(process.argv[5]))throw Error('EXPECTED_EXPLICIT_OWNER_AND_PARENT');
 const pid=Number(process.argv[3]),parentPid=Number(process.argv[5]);if(!Number.isSafeInteger(pid)||!Number.isSafeInteger(parentPid)||pid<=1||parentPid<=1||pid===parentPid)throw Error('INVALID_OWNER_PARENT_PIDS');const directory=await realpath(root);const state=statePath();
 stage='existing_attempt';
 const evidence=await shutdownAttemptEvidence(pid,state,directory,true);
 if(!evidence.ownerAlive||!('attempt' in evidence)||evidence.attempt?.status!=='verified'||evidence.attempt?.backupFilesVerified!==true||evidence.identityStable!==true)throw Error('PRIOR_SHUTDOWN_BACKUP_OR_IDENTITY_UNVERIFIED');
 const owner=await processIdentity(pid),parent=await processIdentity(parentPid);
 if(!owner||!parent||owner.parentPid!==parentPid||parent.uid!==process.getuid!())throw Error('OWNER_PARENT_RELATION_UNVERIFIED');
 stage='supervisor_policy';
 const policy=await verifiedSupervisorPolicy(parent,directory);
 emit({stage,status:'verified',pid,parentPid,policy,terminalSettingsChanged:false,priorBackupReused:true,loadedCodeIdentity:'installed_files_predate_parent_start'});
 const hash=createHash('sha256').update(JSON.stringify({owner,parent})).digest('hex');
 const recovery=join(homedir(),'Library','Application Support','ADL','Recovery');const folder=await lstat(recovery);
 if(!folder.isDirectory()||folder.isSymbolicLink()||folder.uid!==process.getuid!()||(folder.mode&0o077))throw Error('RECOVERY_DIRECTORY_UNVERIFIED');
 const intent=join(recovery,'supervisor-drain-'+parentPid+'-'+hash.slice(0,24)+'.json');
 stage='supervisor_drain';
 const result=await drainSupervisor({identity:processIdentity,cwd:processCwd,state:processStateCode,lock:()=>readOwner(state+'.lock'),children,now:Date.now,pause:normalPause,
  absent:async()=>await pathAbsent(state+'.lock')&&await pathAbsent(state+'.lock.reclaim'),
  claim:async()=>{let handle;try{handle=await open(intent,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('SUPERVISOR_DRAIN_ALREADY_REQUESTED_PRESERVED');throw error;}try{await handle.writeFile(JSON.stringify({at:new Date().toISOString(),ownerPid:pid,parentPid,identityHash:hash,policy,priorBackupReused:true,signal:'SIGCONT',target:'parent_only'}));await handle.sync();}finally{await handle.close();}},
  resumeParent:target=>{parentResumed=true;process.kill(target,'SIGCONT');emit({stage,status:'requested',pid:target,signal:'SIGCONT',signalsToWorker:0});}},pid,parentPid,directory,process.getuid!());
 stage='final_audit';const report=await diagnoseCutover({state,refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});
 if(report.status!=='ok'){emit({stage,status:'blocked',evidence:report});process.exitCode=2;}
 else{const before=await journalHashes(state);await delay(1000);if(before!==await journalHashes(state))throw Error('JOURNALS_NOT_STABLE_AFTER_DRAIN');emit({stage:'complete',status:'ok',...result,journalsStable:true,priorBackupReused:true,notBeforeUTC:report.notBeforeUTC});}
}catch(error){
 let evidence:object={};try{evidence=await diagnoseCutover({state:statePath(),refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});}catch{}
 const message=(error as Error).message;emit({stage,status:'blocked',reason:/^[A-Z_]+$/.test(message)?message:safeError(error),parentResumed,signalsToWorker:0,evidence,note:'No TERM/KILL/group signals, lock deletion or repeated CONT. Existing backup/intents preserved; AWS not started.'});process.exitCode=2;
}
