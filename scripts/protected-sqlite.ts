// Read-only source; online backup includes WAL. No migrations or ticket writes.
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {lstat,chmod,open} from 'node:fs/promises';
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
function inspect(db:DatabaseSync){
 if((db.prepare('PRAGMA integrity_check').get() as Record<string,string>).integrity_check!=='ok')throw Error('SQLITE_INTEGRITY_FAILED');
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[];
 const hash=createHash('sha256');let rows=0;
 for(const {name} of tables){
  hash.update(JSON.stringify(name));const columns=db.prepare('PRAGMA table_info('+quote(name)+')').all() as {name:string;pk:number}[];
  const keys=columns.filter(c=>c.pk>0).sort((a,b)=>a.pk-b.pk);const order=keys.length?keys.map(c=>quote(c.name)).join(','):'rowid';
  const statement=db.prepare('SELECT * FROM '+quote(name)+' ORDER BY '+order);statement.setReadBigInts(true);
  for(const row of statement.iterate()){hash.update(JSON.stringify(row,(_,v)=>typeof v==='bigint'?{$bigint:String(v)}:v));rows++;}
 }
 return {fingerprint:hash.digest('hex'),rows,tables:tables.length,integrity:'ok'};
}
async function main(){
 const args=process.argv.slice(2);if(args.length!==2&&args.length!==4||args[0]!=='--source'||args.length===4&&args[2]!=='--destination')throw Error('SQLITE_BACKUP_ARGUMENTS');
 const source=args[1],destination=args[3];const info=await lstat(source);if(!info.isFile()||info.isSymbolicLink()||info.size>128*1024*1024)throw Error('SQLITE_SOURCE_UNVERIFIED');
 const db=new DatabaseSync(source,{readOnly:true});try{
  const before=inspect(db);
  if(destination){
   try{await lstat(destination);throw Error('SQLITE_BACKUP_EXISTS');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   await backup(db,destination);await chmod(destination,0o600);const file=await open(destination,'r+');try{await file.sync();}finally{await file.close();}
   const copy=new DatabaseSync(destination,{readOnly:true});try{if(inspect(copy).fingerprint!==before.fingerprint)throw Error('SQLITE_BACKUP_MISMATCH');}finally{copy.close();}
   if(inspect(db).fingerprint!==before.fingerprint)throw Error('SQLITE_CHANGED_DURING_BACKUP');
  }
  console.log(JSON.stringify({operation:'cutover.sqlite',status:'ok',...before,backupVerified:!!destination}));
 }finally{db.close();}
}
main().catch(e=>{console.log(JSON.stringify({operation:'cutover.sqlite',status:'blocked',reason:/^[A-Z_]+$/.test(e.message)?e.message:'SQLITE_OPERATION_FAILED'}));process.exitCode=2;});
