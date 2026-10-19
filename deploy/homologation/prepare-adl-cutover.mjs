// Only after normal Mac worker shutdown: local audit and protected scheduler export. No SSH/start.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseEnv,promisify} from 'node:util';
import {execFile} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
let stage='arguments';
let auditEvidence;
let reason;
let item;
async function main(){
 if(process.argv.length!==2)throw Error();
 stage='audit';
 let stdout;
 try{({stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/audit-aws-cutover.ts'],{cwd:root,maxBuffer:1024*1024,timeout:30000}));}
 catch(error){
  try{const evidence=JSON.parse(String(error.stdout||'').trim());if(evidence.operation==='cutover.audit'&&evidence.readOnly===true)auditEvidence=evidence;}catch{}
  throw Error();
 }
 const audit=JSON.parse(stdout.trim());if(audit.status!=='ok'||audit.workerLockAbsent!==true||audit.matchingWorkerProcesses!==0)throw Error();
 stage='local_env_read';
 const vars=parseEnv(await fs.readFile(path.join(root,'.env'),'utf8'));
 const state=path.resolve(root,process.env.LSPORTS_STATE_FILE||vars.LSPORTS_STATE_FILE||'.runtime/trade-feed.json');
 stage='journal_export_read';
 const folder=path.dirname(state);const prefix=path.basename(state)+'.snapshot-';
 const names=(await fs.readdir(folder)).filter(n=>n.startsWith(prefix)&&/^[a-zA-Z0-9_.-]+\.json$/.test(n));
 if(names.length!==audit.journals){reason='JOURNAL_COUNT_CHANGED_AFTER_AUDIT';throw Error();}
 const schedules=[];
 for(const [index,name] of names.entries()){
  item='journal-'+(index+1);
  const file=path.join(folder,name);const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()){reason='NOT_REGULAR_FILE';throw Error();}
  if(stat.size>1024*1024){reason='JOURNAL_SIZE_LIMIT';throw Error();}
  if(stat.mtimeMs>Date.parse(audit.capturedAt)){reason='JOURNAL_CHANGED_AFTER_AUDIT';throw Error();}
  let schedule;
  try{schedule=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error instanceof SyntaxError)reason='INVALID_JOURNAL_JSON';throw error;}
  schedules.push({name: name.slice(path.basename(state).length),schedule});
 }
 item=undefined;
 stage='protected_export_write';
 const parent=path.join(os.homedir(),'Library','Application Support','ADL','Cutover');await fs.mkdir(parent,{recursive:true,mode:0o700});
 const destination=await fs.mkdtemp(path.join(parent,'mac-to-aws-'));await fs.chmod(destination,0o700);
 await fs.writeFile(path.join(destination,'handoff.json'),JSON.stringify({audit,schedules}),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({operation:'cutover.prepare',status:'ok',destination,notBeforeUTC:audit.notBeforeUTC,journals:schedules.length,workerStarted:false,providerRequests:0,note:'Keep Mac worker stopped. AWS import and startup remain gated; no checkpoint/tickets/credentials exported.'}));
}
main().catch(error=>{const code=['ENOENT','EACCES','EPERM','EISDIR'].includes(error?.code)?error.code:undefined;console.error(JSON.stringify({operation:'cutover.prepare',status:'blocked',stage,reason,item,code,auditEvidence,workerStarted:false,note:'Shutdown/audit/journal evidence incomplete. Preserve locks; no raw exceptions, provider requests or AWS changes.'}));process.exitCode=2;});
