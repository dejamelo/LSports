import {spawn} from 'node:child_process';
import {readFileSync,readdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
const here=dirname(fileURLToPath(import.meta.url)),report=join(here,'expand-prepared-transport-'+Date.now()+'.jsonl');writeFileSync(report,'',{mode:0o600,flag:'wx'});
const emit=row=>{console.log(JSON.stringify(row));appendFileSync(report,JSON.stringify(row)+'\n');};
let integrationVerified=false;const checks={workerActivated:false,sourceVerified:false,durableRetirementObserved:false,pendingReductionObserved:false,feedValidation:null};
async function execute(command,args,stdin){
 const child=spawn(command,args,{stdio:[stdin?'pipe':'inherit','pipe','pipe']});let errorKind;
 if(stdin){child.stdin.on('error',()=>{});child.stdin.end(stdin);}
 child.stderr.on('data',part=>{const s=part.toString();if(/permission denied/i.test(s))errorKind='SSH_AUTHENTICATION_FAILED';else if(/timed out/i.test(s))errorKind='SSH_TIMEOUT';});
 createInterface({input:child.stdout}).on('line',line=>{
  console.log(line);
  try{const row=JSON.parse(line);appendFileSync(report,JSON.stringify(row)+'\n');
   if(row.stage==='prepared_source_verified'&&row.status==='verified')checks.sourceVerified=true;
   if(['partitioned_upgrade.started','partitioned_upgrade.running'].includes(row.stage)&&row.status==='ok'&&row.workerStarted===true)checks.workerActivated=true;
   if(row.stage==='inbox_retirement_result'&&row.lane==='prematch'){checks.durableRetirementObserved=row.oldCohortDurablyRetiredRows>0;checks.pendingReductionObserved=row.pendingRowsEnd<row.pendingRowsStart;}
   if(row.stage==='full_recovery_verified'){checks.feedValidation=row;integrationVerified=row.status==='verified';}
   if(row.stage==='full_recovery_pending')checks.feedValidation=row;
  }catch{}
 });
 const timer=setInterval(()=>emit({stage:'prepared_recovery_execution',status:'running',report}),20000);
 const code=await new Promise(resolve=>{child.once('error',e=>{errorKind=e.code;resolve(2);});child.once('close',c=>resolve(c??2));});clearInterval(timer);
 if(code&&errorKind)emit({stage:'child_failure',reason:errorKind,exitCode:code,rawStderrPrinted:false});return code;
}
try{
 const keys=readdirSync(join(homedir(),'Downloads')).filter(n=>/Lottery.*Key\.pem$/.test(n));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
 const ledger=JSON.parse(readFileSync(join(homedir(),'Library/Application Support/ADL/Cutover/execution-12811-12809.json'),'utf8'));
 const p=ledger.steps?.throughput_image?.result;
 if(p?.backup!=='/var/backups/adl-partitioned-upgrade-p1znn7u6'||p?.image!=='adl-worker-partitioned:f8be504232d690d3045c77cc')throw Error('LOCAL_PREPARATION_CHANGED_NO_RESIZE');
 emit({stage:'growth_and_prepared_resume',status:'starting',report,ebsModificationRequested:false,targetEbsGiB:184});
 const grown=await execute('ssh',['-i',join(homedir(),'Downloads',keys[0]),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -'],readFileSync(join(here,'grow-prepared-transport.py')));
 if(grown){process.exitCode=grown;emit({stage:'recovery_result',status:'blocked',growthExitCode:grown,report,checks,integrationVerified:false});}
 else{
  const workflow=await execute(process.execPath,[join(here,'resume-transport-storage.mjs')]);
  const observation=await execute(process.execPath,[join(here,'collect-session-recovery.mjs'),'--api-health','--drain']);
  emit({stage:'recovery_result',workflowExitCode:workflow,observationExitCode:observation,report,checks,integrationVerified:integrationVerified&&checks.durableRetirementObserved&&checks.pendingReductionObserved,note:'Source identity, activation, old-cohort retirement, net pending decrease and complete feed recovery are separate checks. InPlay market delivery is never inferred from ACKs.'});process.exitCode=workflow||observation||(!(integrationVerified&&checks.durableRetirementObserved&&checks.pendingReductionObserved)?2:0);
 }
}catch(e){emit({stage:'recovery_result',status:'blocked',reason:e.message,report,checks,integrationVerified:false});process.exitCode=2;}
