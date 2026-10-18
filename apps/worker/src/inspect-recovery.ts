import {readFile,readdir,stat} from 'node:fs/promises';
import {dirname,join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {sanitizedCause} from './recovery-diagnostics.js';
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
async function file(path:string){try{const data=await readFile(path);return {exists:true,bytes:data.length,sha256:hash(data)};}catch(e){return {exists:(e as NodeJS.ErrnoException).code!=='ENOENT',cause:sanitizedCause(e)};}}
function database(path:string){let db:DatabaseSync|undefined;try{
 db=new DatabaseSync(path,{readOnly:true});const rows=db.prepare('SELECT id,body FROM tickets ORDER BY id').all();
 return {readable:true,tickets:rows.length,ticketFingerprint:hash(JSON.stringify(rows)),sqliteVersion:(db.prepare('SELECT sqlite_version() AS version').get() as {version:string}).version};
}catch(e){return {readable:false,cause:sanitizedCause(e)};}finally{db?.close();}}
export async function inspectRecovery(path:string,dbPath:string){
 const checkpoint=await file(path);let lock:Record<string,unknown>;
 try{const content=await readFile(`${path}.lock`,'utf8');const pid=Number(content);let owner='invalid';if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);owner='running';}catch(e){owner=(e as NodeJS.ErrnoException).code==='ESRCH'?'not_running':'unverifiable';}}
 lock={exists:true,owner,...(Number.isSafeInteger(pid)&&pid>0?{pid}:{}),action:'preserved'};
 }catch(e){lock={exists:(e as NodeJS.ErrnoException).code!=='ENOENT',cause:sanitizedCause(e),action:'preserved'};}
 const live=database(dbPath);const directory=dirname(path);let names:string[]=[];let scanError:unknown;
 try{names=(await readdir(directory)).filter(n=>/^timestamp-recovery-[a-f0-9-]{36}$/.test(n));}catch(e){scanError=sanitizedCause(e);}
 const dated=await Promise.all(names.map(async n=>({name:n,mtime:(await stat(join(directory,n))).mtimeMs})));dated.sort((a,b)=>b.mtime-a.mtime);
 const backups=[];
 for(const {name}of dated.slice(0,20)){
  const location=join(directory,name);const before=await file(join(location,'feed.before.json'));const sqlite=await file(join(location,'tickets.before.sqlite'));const auditFile=await file(join(location,'audit.json'));let audit:Record<string,unknown>|undefined;
  if(auditFile.exists){try{const raw=JSON.parse(await readFile(join(location,'audit.json'),'utf8'));audit={operation:raw.operation==='archive_verified_dead_worker_lock'?'archive_verified_dead_worker_lock':'timestamp_migration',expectedPid:Number.isSafeInteger(raw.expectedPid)?raw.expectedPid:undefined,readable:true,mode:['quotes','settlements'].includes(raw.mode)?raw.mode:'unknown',fixtureId:Number.isSafeInteger(raw.fixtureId)?raw.fixtureId:null,marketId:Number.isSafeInteger(raw.marketId)?raw.marketId:null,candidates:Array.isArray(raw.candidates)?raw.candidates.length:null,
    checkpointMatchesBefore:checkpoint.sha256===raw.beforeSha256,checkpointMatchesPrepared:raw.operation!=='archive_verified_dead_worker_lock'&&checkpoint.sha256===raw.afterSha256,ticketsMatchRecordedFingerprint:live.ticketFingerprint===raw.ticketFingerprint};}catch(e){audit={readable:false,cause:sanitizedCause(e)};}}
  const backed=sqlite.exists&&sqlite.bytes?database(join(location,'tickets.before.sqlite')):undefined;
  backups.push({directory:name,checkpointBackup:before,sqliteBackup:sqlite,sqliteInspection:backed,auditFile,audit,
   ticketsMatchBackup:!!live.ticketFingerprint&&live.ticketFingerprint===backed?.ticketFingerprint,checkpointMatchesBackup:!!checkpoint.sha256&&checkpoint.sha256===before.sha256});
 }
 let temporaryFiles:Record<string,unknown>[]=[];try{const names=await readdir(directory);temporaryFiles=await Promise.all(names.filter(n=>n.startsWith(`${basename(path)}.`)&&n.endsWith('.recovery.tmp')).map(async n=>({name:n,...await file(join(directory,n))})));}catch{}
 return {reclaimGuard:await file(`${path}.lock.reclaim`),readOnly:true,nodeVersion:process.versions.node,checkpoint,lock,tickets:live,backups,backupCount:dated.length,backupsTruncated:dated.length>20,temporaryFiles,...(scanError?{scanError}:{}),
  note:'No migration, VACUUM, lock removal, checkpoint write or ticket update was performed. Historical stages without audit cannot be reconstructed with certainty.'};
}
