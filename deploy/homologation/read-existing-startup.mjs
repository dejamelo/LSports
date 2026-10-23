import {spawnSync} from 'node:child_process';import {readFileSync,readdirSync,writeFileSync} from 'node:fs';import {homedir} from 'node:os';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),report=join(here,'existing-startup-evidence-'+Date.now()+'.json');
const keys=readdirSync(join(homedir(),'Downloads')).filter(n=>/Lottery.*Key\.pem$/.test(n));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
console.log(JSON.stringify({stage:'existing_startup_evidence',status:'reading_saved_container_logs',workerMutationRequested:false}));
const r=spawnSync('ssh',['-i',join(homedir(),'Downloads',keys[0]),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -'],{input:readFileSync(join(here,'read-existing-startup.py')),encoding:'utf8',timeout:75000,maxBuffer:2*1024**2});
const rows=(r.stdout||'').split('\n').flatMap(l=>{try{return[JSON.parse(l)];}catch{return[];}});
writeFileSync(report,JSON.stringify({rows,exitCode:r.status,errorCode:r.error?.code,readOnly:true},null,2),{mode:0o600,flag:'wx'});
for(const row of rows)console.log(JSON.stringify(row));console.log(JSON.stringify({stage:'existing_startup_complete',exitCode:r.status,report,workerRestarted:false,providerRequests:0}));process.exitCode=r.status??2;
