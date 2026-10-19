import {root,statePath} from '@lsports/feed-store';
import {readOwner,processIdentity,processCwd,pathAbsent,normalPause,journalHashes} from './stop-owned-worker.js';
import {resumeStoppedWorker} from './resume-stopped-worker.js';
import {diagnoseCutover,safeError} from './cutover-diagnostics.js';
import {realpath,lstat,readdir,mkdir,mkdtemp,copyFile,chmod,open,statfs} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname,basename,join} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
let stage='arguments';let backup:string|undefined;let resumed=false;
const emit=(v:object)=>console.log(JSON.stringify({operation:'cutover.resume',workerStarted:false,awsChanged:false,...v}));
const exec=promisify(execFile);
async function psState(pid:number){const {stdout}=await exec('ps',['-p',String(pid),'-o','state='],{timeout:5000,maxBuffer:4096});const text=stdout.trim();if(!/^[A-Za-z+<NsWTsl-]{1,12}$/.test(text))throw Error('PROCESS_STATE_UNVERIFIED');return text;}
async function pendingTerm(pid:number){
 for(const field of ['pending','sig'])try{
  const {stdout}=await exec('ps',['-p',String(pid),'-o',field+'='],{timeout:5000,maxBuffer:4096});
  const raw=stdout.trim().replace(/^0x/i,'');if(/^[0-9a-f]{1,32}$/i.test(raw))return (BigInt('0x'+raw)&(1n<<14n))!==0n;
 }catch{}
 return null; // Some macOS ps versions do not expose a pending mask; prior TERM is an explicit operator assertion.
}
async function digest(file:string){const hash=createHash('sha256');const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);return hash.digest('hex');}finally{await handle.close();}}
async function privateWrite(file:string,value:object){const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}}
try{
 if(process.argv.length!==5||process.argv[2]!=='--pid'||!/^\d+$/.test(process.argv[3])||process.argv[4]!=='--prior-term-confirmed')throw Error('EXPECTED_PID_AND_PRIOR_TERM_CONFIRMATION_REQUIRED');
 const pid=Number(process.argv[3]);if(!Number.isSafeInteger(pid)||pid<=0)throw Error('INVALID_PID');
 stage='identity';
 const state=statePath();const lock=state+'.lock';const directory=await realpath(root);
 const owner=await processIdentity(pid);if(!owner)throw Error('OWNER_ALREADY_EXITED_USE_DIAGNOSIS');
 const identityHash=createHash('sha256').update(JSON.stringify({pid:owner.pid,uid:owner.uid,startedAt:owner.startedAt,args:owner.args})).digest('hex');
 const destination=join(homedir(),'Library','Application Support','ADL','Recovery');await mkdir(destination,{recursive:true,mode:0o700});
 const folderInfo=await lstat(destination);if(folderInfo.isSymbolicLink()||!folderInfo.isDirectory()||folderInfo.uid!==process.getuid!()||(folderInfo.mode&0o077)!==0)throw Error('RECOVERY_DIRECTORY_NOT_PROTECTED');
 const intent=join(destination,'resume-'+pid+'-'+identityHash.slice(0,24)+'.intent.json');
 if(!await pathAbsent(intent))throw Error('RECOVERY_ALREADY_REQUESTED_NO_REPEAT');
 stage='stopped_owner_gate';
 const result=await resumeStoppedWorker({lock:()=>readOwner(lock),identity:processIdentity,cwd:processCwd,state:psState,pendingTerm,now:Date.now,pause:normalPause,
  absent:async()=>await pathAbsent(lock)&&await pathAbsent(lock+'.reclaim'),
  signal:target=>{resumed=true;process.kill(target,'SIGCONT');emit({stage:'continue',status:'requested',pid:target,signal:'SIGCONT'});},
  claim:()=>privateWrite(intent,{at:new Date().toISOString(),pid,identityHash,backup,signal:'SIGCONT',priorTermConfirmed:true}),
  backup:async()=>{
   stage='backup';const report=await diagnoseCutover({state,refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});
   if(report.blockers.some(b=>!['processes','locks'].includes(b.stage)))throw Error('PERSISTED_EVIDENCE_INVALID');
   const names=(await readdir(dirname(state))).filter(n=>n.startsWith(basename(state)+'.snapshot-')&&/^[a-zA-Z0-9_.-]+\.json$/.test(n)).sort();
   if(!names.length)throw Error('JOURNALS_MISSING');const files=[state,lock,...names.map(n=>join(dirname(state),n))];
   let bytes=0;for(const file of files){const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('BACKUP_SOURCE_UNVERIFIED');bytes+=stat.size;}
   const disk=await statfs(destination);if(disk.bavail*disk.bsize<bytes*2+64*1024*1024)throw Error('BACKUP_SPACE_INSUFFICIENT');
   backup=await mkdtemp(join(destination,'stopped-worker-'));await chmod(backup,0o700);
   const manifest=[];
   for(const [index,source] of files.entries()){
    if(!/^T/.test(await psState(pid)))throw Error('OWNER_RESUMED_DURING_BACKUP');
    const before=await digest(source);const target=join(backup,index===0?'checkpoint.json':index===1?'lock.before':'journal-'+(index-1)+'.json');
    await copyFile(source,target,constants.COPYFILE_EXCL);await chmod(target,0o600);
    const handle=await open(target,'r+');try{await handle.sync();}finally{await handle.close();}
    if(before!==await digest(target)||before!==await digest(source))throw Error('BACKUP_SOURCE_CHANGED');
    manifest.push({source,backupFile:basename(target),sha256:before});
   }
   await privateWrite(join(backup,'manifest.private.json'),{at:new Date().toISOString(),pid,identityHash,manifest});
   emit({stage,status:'ok',backup,files:files.length,sha256Verified:true,loadedCodeVersion:'unknown',observedOSState:'T'});stage='resume_and_wait';
  }},pid,directory,process.getuid!());
 emit({stage:'shutdown',status:'ok',...result});
 stage='post_resume_audit';const report=await diagnoseCutover({state,refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});
 if(report.status!=='ok'){emit({stage,status:'blocked',backup,evidence:report,note:'No lock removal or further signals; preserve backed-up state.'});process.exitCode=2;}
 else{
  const hashes=await journalHashes(state);await delay(1000);if(hashes!==await journalHashes(state))throw Error('JOURNALS_CHANGED_AFTER_SHUTDOWN');
  emit({stage:'complete',status:'ok',backup,ownerStopped:true,journalsStable:true,note:'Only SIGCONT issued after backup. Launcher may now run fresh cutover export. AWS worker untouched.'});
 }
}catch(e){const message=(e as Error).message;const fixed=/^[A-Z][A-Z_]+$/.test(message)?message:safeError(e);emit({stage,status:'blocked',reason:fixed,backup,resumed,note:'No repeated signal, SIGTERM, force kill or lock deletion. Preserve backups and live state; no AWS start.'});process.exitCode=2;}
