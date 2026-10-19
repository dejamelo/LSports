// Only after normal Mac worker shutdown: local audit and protected scheduler export. No SSH/start.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseEnv,promisify} from 'node:util';
import {execFile} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
async function main(){
 if(process.argv.length!==2)throw Error();
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/audit-aws-cutover.ts'],{cwd:root,maxBuffer:1024*1024,timeout:30000});
 const audit=JSON.parse(stdout.trim());if(audit.status!=='ok'||audit.workerLockAbsent!==true||audit.matchingWorkerProcesses!==0)throw Error();
 const vars=parseEnv(await fs.readFile(path.join(root,'.env'),'utf8'));
 const state=path.resolve(root,process.env.LSPORTS_STATE_FILE||vars.LSPORTS_STATE_FILE||'.runtime/trade-feed.json');
 const folder=path.dirname(state);const prefix=path.basename(state)+'.snapshot-';
 const names=(await fs.readdir(folder)).filter(n=>n.startsWith(prefix)&&/^[a-zA-Z0-9_.-]+\.json$/.test(n));
 if(names.length!==audit.journals)throw Error();
 const schedules=[];
 for(const name of names){
  const file=path.join(folder,name);const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024||stat.mtimeMs>Date.parse(audit.capturedAt))throw Error();
  schedules.push({name: name.slice(path.basename(state).length),schedule:JSON.parse(await fs.readFile(file,'utf8'))});
 }
 const parent=path.join(os.homedir(),'Library','Application Support','ADL','Cutover');await fs.mkdir(parent,{recursive:true,mode:0o700});
 const destination=await fs.mkdtemp(path.join(parent,'mac-to-aws-'));await fs.chmod(destination,0o700);
 await fs.writeFile(path.join(destination,'handoff.json'),JSON.stringify({audit,schedules}),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({operation:'cutover.prepare',status:'ok',destination,notBeforeUTC:audit.notBeforeUTC,journals:schedules.length,workerStarted:false,providerRequests:0,note:'Keep Mac worker stopped. AWS import and startup remain gated; no checkpoint/tickets/credentials exported.'}));
}
main().catch(()=>{console.error(JSON.stringify({operation:'cutover.prepare',status:'blocked',workerStarted:false,note:'Shutdown/audit/journal evidence incomplete. Preserve locks; no raw exceptions, provider requests or AWS changes.'}));process.exitCode=2;});
