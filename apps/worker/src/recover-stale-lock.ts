import {readFile,writeFile,open,mkdir,copyFile,rename,stat,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {RecoveryAbort,emptyWrites,sanitizedCause} from './recovery-diagnostics.js';
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const fingerprint=(db:DatabaseSync)=>hash(JSON.stringify(db.prepare('SELECT id,body FROM tickets ORDER BY id').all()));
function requireDead(pid:number){try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return;throw e;}throw new Error('Owner is running');}
export async function recoverStaleLock(path:string,database:string,expectedPid:number){
 const writes=emptyWrites();let stage='lock.expected_pid',reason='Expected PID must match inspection';let guard:Awaited<ReturnType<typeof open>>|undefined,identity:Awaited<ReturnType<typeof stat>>|undefined,backup:string|undefined,auditId:string|undefined,aborted:RecoveryAbort|undefined,result:Record<string,unknown>|undefined;
 try{
  if(!Number.isSafeInteger(expectedPid)||expectedPid<=0)throw new Error(reason);
  stage='lock.reclaim_guard';reason='Cannot acquire exclusive recovery guard; existing guard preserved';guard=await open(`${path}.lock.reclaim`,'wx',0o600);writes.reclaimGuardCreated=true;identity=await guard.stat();await guard.writeFile(String(process.pid));
  stage='lock.verify_owner';reason='Lock changed, owner running, invalid or not verifiably dead';
  const original=await readFile(`${path}.lock`);const originalStat=await stat(`${path}.lock`);const pid=Number(original.toString());if(pid!==expectedPid)throw new Error(reason);requireDead(pid);
  stage='backup.directory';reason='Cannot create backup directory';auditId=randomUUID();backup=join(dirname(path),`timestamp-recovery-${auditId}`);await mkdir(backup,{mode:0o700});writes.backupDirectoryCreated=true;
  stage='backup.checkpoint';reason='Cannot back up checkpoint; stale lock preserved';writes.checkpointBackupStarted=true;const checkpoint=await readFile(path);await copyFile(path,join(backup,'feed.before.json'),constants.COPYFILE_EXCL);if(hash(await readFile(join(backup,'feed.before.json')))!==hash(checkpoint))throw new Error(reason);writes.checkpointBackupComplete=true;
  stage='sqlite.open_readonly';reason='Cannot open existing tickets read-only; stale lock preserved';const db=new DatabaseSync(database,{readOnly:true});let ticketsHash:string,ticketCount:number;
  try{stage='sqlite.fingerprint';reason='Cannot read tickets; stale lock preserved';ticketsHash=fingerprint(db);ticketCount=(db.prepare('SELECT count(*) AS n FROM tickets').get() as {n:number}).n;
   stage='sqlite.backup';reason='Cannot create consistent SQLite backup; stale lock preserved';writes.sqliteBackupStarted=true;db.exec(`VACUUM INTO '${join(backup,'tickets.before.sqlite').replaceAll("'","''")}'`);
   stage='sqlite.backup_verify';reason='Cannot verify ticket backup; stale lock preserved';const copied=new DatabaseSync(join(backup,'tickets.before.sqlite'),{readOnly:true});try{if(fingerprint(copied)!==ticketsHash)throw new Error(reason);}finally{copied.close();}writes.sqliteBackupComplete=true;
  }finally{db.close();}
  stage='backup.lock';reason='Cannot back up stale lock';await copyFile(`${path}.lock`,join(backup,'worker.lock.before'),constants.COPYFILE_EXCL);
  const manifest={auditId,operation:'archive_verified_dead_worker_lock',expectedPid,createdAt:new Date().toISOString(),beforeSha256:hash(checkpoint),afterSha256:hash(checkpoint),lockSha256:hash(original),ticketFingerprint:ticketsHash!,ticketCount:ticketCount!,backup};
  stage='audit.write';reason='Cannot persist audit; stale lock preserved';writes.auditWriteStarted=true;await writeFile(join(backup,'audit.json'),JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});writes.auditWritten=true;
  stage='lock.final_verification';reason='Lock, checkpoint or tickets changed; stale lock preserved';requireDead(expectedPid);const current=await stat(`${path}.lock`);if(current.ino!==originalStat.ino||current.dev!==originalStat.dev||hash(await readFile(`${path}.lock`))!==hash(original)||hash(await readFile(path))!==hash(checkpoint))throw new Error(reason);
  const verify=new DatabaseSync(database,{readOnly:true});try{if(fingerprint(verify)!==ticketsHash!)throw new Error(reason);}finally{verify.close();}
  stage='lock.archive';reason='Cannot archive stale lock';await rename(`${path}.lock`,join(backup,'worker.lock.archived'));writes.staleLockArchived=true;
  result={status:'stale_lock_archived',...manifest,checkpointModified:false,ticketsModified:false,writes};
 }catch(e){aborted=new RecoveryAbort({status:'aborted',stage,reason,writes,cause:sanitizedCause(e),backup,auditId});}
 finally{if(guard){try{await guard.close();const current=await stat(`${path}.lock.reclaim`);if(current.ino!==identity?.ino||current.dev!==identity?.dev)throw new Error('Guard owner changed');await rm(`${path}.lock.reclaim`);writes.reclaimGuardReleased=true;}catch(e){if(aborted)aborted.diagnostic.cleanupIssue='Own reclaim guard cleanup failed; inspect before retrying';else aborted=new RecoveryAbort({status:'aborted',stage:'lock.reclaim_cleanup',reason:'Lock archived but own guard cleanup failed; inspect before retrying',writes,backup,auditId,cause:sanitizedCause(e)});}}}
 if(aborted)throw aborted;return result!;
}
