import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const p=spawnSync('ps',['-ax','-o','pid=,comm=,args='],{encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024});
if(p.status!==0)throw Error('LOCAL_PROCESS_AUDIT_FAILED_NO_COLLECTION_STARTED');
const localCollectors=p.stdout.split('\n').flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);return m&&m[3].includes('collect-recovery-inbox-identity.mjs')&&['node','nodejs','caffeinate','ssh'].includes(m[2].split('/').at(-1))?[{pid:Number(m[1]),executable:m[2].split('/').at(-1)}]:[];});
const artifacts=[];
for(const name of readdirSync(tmpdir()).filter(n=>n.startsWith('adl-inbox-identity.')).slice(-30))for(const file of ['recovery-inbox-identity.json','recovery-inbox-identity-partial.json','recovery-inbox-identity-progress.jsonl']){
 const path=join(tmpdir(),name,'deploy/homologation',file);try{const st=statSync(path);if(st.isFile()){let lastStage;if(st.size<=1024*1024){try{const text=readFileSync(path,'utf8');const record=file.endsWith('.jsonl')?JSON.parse(text.trim().split('\n').at(-1)):JSON.parse(text);const value=record.stage||record.summary?.lastStage;if(typeof value==='string'&&/^[a-z_]{1,80}$/.test(value))lastStage=value;}catch{}}artifacts.push({path,bytes:st.size,modifiedAtUTC:st.mtime.toISOString(),lastStage});}}catch(error){if(error.code!=='ENOENT')throw error;}
}
console.log(JSON.stringify({stage:'local_interruption_audit',localCollectors,existingArtifacts:artifacts,startingOnly:'remote_readonly_status_audit',noCollectionResumed:true}));
const keys=readdirSync(join(homedir(),'Downloads'),{withFileTypes:true}).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE_OR_AVAILABLE');
const r=spawnSync('ssh',['-i',join(homedir(),'Downloads',keys[0].name),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -'],{input:readFileSync(join(here,'audit-interrupted-collector.py')),encoding:'utf8',timeout:35000,maxBuffer:1024*1024});
const records=(r.stdout||'').trim().split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
const report={localCollectors,existingArtifacts:artifacts,remote:records.at(-1),exitCode:r.status,spawnCode:r.error?.code,noCollectionResumed:true};
const path=join(here,'interrupted-collector-audit.json');writeFileSync(path,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({reportFile:path,...report}));if(r.status!==0)process.exitCode=2;
