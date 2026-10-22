import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleRemoteHelper,helperInvocation} from './remote-helper-transport.mjs';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const keys=readdirSync(join(homedir(),'Downloads'),{withFileTypes:true}).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));
if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE_OR_AVAILABLE');
const definitions=(await assembleRemoteHelper(here)).replace("if __name__=='__main__':raise SystemExit(cutover_main())",'');
const source=definitions+'\nPRESSURE_INBOX_PROBE = '+JSON.stringify(readFileSync(join(here,'recovery-pressure-inbox.mjs'),'utf8'))+'\n'+readFileSync(join(here,'recovery-pressure-report.py'),'utf8').split('try:pressure_main()')[0]+'\n'+readFileSync(join(here,'recovery-inbox-identity.py'),'utf8');
const invocation=await helperInvocation(here,source,{});
const r=spawnSync('ssh',['-i',join(homedir(),'Downloads',keys[0].name),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=15','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com',invocation.command],{input:invocation.input,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
if(r.status!==0){const rows=(r.stdout||'').trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});const path=join(here,'recovery-inbox-identity-partial.json');writeFileSync(path,JSON.stringify(rows,null,2),{mode:0o600});console.error(JSON.stringify({reason:'READ_ONLY_COLLECTION_FAILED',exitCode:r.status,spawnCode:r.error?.code,diagnostic:rows.findLast(r=>r.status==='blocked'),reportFile:path,workerRestarted:false}));process.exitCode=2;}
else{const rows=r.stdout.trim().split('\n').map(line=>JSON.parse(line));const report=rows.findLast(r=>r.operation==='recovery_inbox_identity');if(!report)throw Error('PRESSURE_REPORT_INCOMPLETE');const path=join(here,'recovery-inbox-identity.json');writeFileSync(path,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({reportFile:path,workerId:report.workerId,processes:report.processes,lanes:report.lanes,inbox:report.inbox,readOnly:true,workerRestarted:false}));}
