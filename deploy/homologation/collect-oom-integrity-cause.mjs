import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const keys=readdirSync(join(homedir(),'Downloads'),{withFileTypes:true}).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));
if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE_OR_AVAILABLE');
const r=spawnSync('ssh',['-i',join(homedir(),'Downloads',keys[0].name),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=15','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -'],{input:readFileSync(join(here,'collect-oom-integrity-cause.py')),encoding:'utf8',timeout:90000,maxBuffer:2*1024*1024});
if(r.status!==0){console.error('READ_ONLY_COLLECTION_FAILED exit='+r.status+' '+(r.error?.code||'')+'; no worker action requested');process.exitCode=2;}
else{const report=JSON.parse(r.stdout),path=join(here,'oom-integrity-cause.json');writeFileSync(path,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({reportFile:path,preExitRecoveryVerified:report.preExitRecoveryVerified,oomRestoreVerified:report.oomRestoreVerified,historicalExceptionRecovered:report.historicalExceptionRecovered,existingReportEvidence:report.reports.map(r=>({file:r.file,operation:r.oldCodeOperation,predictedOldCodeFailure:r.predictedOldCodeFailure})),limitation:report.limitation}));}
