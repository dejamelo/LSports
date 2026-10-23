import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const report=join(here,'distribution-path-'+Date.now()+'.json');
let exitCode=2;
try {
 console.log(JSON.stringify({stage:'bounded_distribution_check',status:'started',maxSeconds:85,providerHttpRequests:0}));
 const keys=readdirSync(join(homedir(),'Downloads')).filter(n=>/Lottery.*Key\.pem$/.test(n));
 if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
 const r=spawnSync('ssh',['-i',join(homedir(),'Downloads',keys[0]),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -'],{input:readFileSync(join(here,'check-distribution-path.py')),encoding:'utf8',timeout:85000,maxBuffer:2*1024**2});
 const rows=(r.stdout||'').split('\n').flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}});
 exitCode=r.status??2;
 writeFileSync(report,JSON.stringify({rows,exitCode,transportErrorCode:r.error?.code,stderrPresent:!!r.stderr,readOnly:true},null,2),{mode:0o600,flag:'wx'});
 for(const row of rows)console.log(JSON.stringify(row));
 console.log(JSON.stringify({stage:'saved',report,exitCode,stderrPresent:!!r.stderr,transportErrorCode:r.error?.code}));
} catch(e){console.log(JSON.stringify({stage:'bounded_distribution_check',status:'blocked',reason:['SSH_KEY_NOT_UNIQUE'].includes(e.message)?e.message:'LOCAL_EXECUTION_FAILED',errorCode:e.code}));}
process.exitCode=exitCode;
