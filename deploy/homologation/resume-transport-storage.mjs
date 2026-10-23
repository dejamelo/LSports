import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),report=join(here,'transport-storage-resume-'+Date.now()+'.jsonl');
writeFileSync(report,'',{mode:0o600,flag:'wx'});
const emit=r=>{console.log(JSON.stringify(r));appendFileSync(report,JSON.stringify(r)+'\n');};
try{
 const ledger=JSON.parse(readFileSync(join(homedir(),'Library/Application Support/ADL/Cutover/execution-12811-12809.json'),'utf8'));
 const prepared=ledger.steps?.throughput_image?.result;
 if(!prepared||!/^\/var\/backups\/adl-partitioned-upgrade-[A-Za-z0-9_-]+$/.test(prepared.backup)||!/^adl-worker-partitioned:[0-9a-f]{24}$/.test(prepared.image))throw Error('PROTECTED_LOCAL_PREPARATION_REFERENCE_MISSING');
 const keys=readdirSync(join(homedir(),'Downloads')).filter(n=>/Lottery.*Key\.pem$/.test(n));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
 emit({stage:'storage_resume_preflight',status:'checking',report,backup:prepared.backup,image:prepared.image,workerMutationRequested:false});
 const reference=JSON.stringify({backup:prepared.backup,image:prepared.image});
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 const result=spawnSync('ssh',['-i',join(homedir(),'Downloads',keys[0]),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 - '+quote(reference)],{input:readFileSync(join(here,'resume-transport-storage.py')),encoding:'utf8',timeout:120000,maxBuffer:2*1024**2});
 let current;
 for(const line of (result.stdout||'').split('\n'))try{const row=JSON.parse(line);emit(row);if(row.stage==='storage_resume_preflight')current=row;}catch{}
 if(result.status!==0||current?.status!=='verified'){
  emit({stage:'resume_complete',status:'blocked',reason:current?.reason||'READ_ONLY_SSH_PREFLIGHT_FAILED',sshExitCode:result.status,errorCode:result.error?.code,sshFailureKind:/permission denied/i.test(result.stderr||'')?'ssh_authentication':/timed out/i.test(result.stderr||'')?'ssh_timeout':/sudo/i.test(result.stderr||'')?'sudo_or_remote_execution':current?'remote_preflight':'ssh_or_remote_no_structured_record',report,integrationVerified:false,workerStarted:false});process.exitCode=2;
 }else{
  const env={...process.env,ADL_RESUME_BACKUP:current.backup,ADL_FINALIZE_VERIFIED_SHUTDOWN:'1',ADL_LIVE_PERSISTENCE_REPAIR:'1',ADL_PIPELINE_REPAIR:'1',ADL_TRANSPORT_LIFECYCLE_REPAIR:'1'};
  for(const key of ['ADL_CHECKPOINT_REPAIR_BACKUP','ADL_PUBLICATION_RESERVE_REPAIR','ADL_STOPPED_RETENTION_REPAIR','ADL_LIVE_OOM_REPAIR','ADL_EXPECTED_OOM_PREFIX','ADL_EXPECTED_LIVE_IMAGE','ADL_SNAPSHOT_PRESSURE_REPAIR'])delete env[key];
  emit({stage:'resume_prepared_worker',status:'starting',backup:current.backup,image:current.image,note:'Reuse validated original receipt; no migration, expansion, cache cleanup or repeat stop requested.'});
  const child=spawn(process.execPath,[join(here,'complete-adl-cutover.mjs'),'--pid','12811','--parent','12809','--snapshot-memory-repair'],{env,stdio:'inherit'});
  const timer=setInterval(()=>emit({stage:'resume_prepared_worker',status:'running',report}),20000);
  const code=await new Promise(resolve=>{child.once('error',()=>resolve(2));child.once('close',c=>resolve(c??2));});clearInterval(timer);
  emit({stage:'resume_complete',workflowExitCode:code,report,integrationVerified:false,note:'Full validation output determines installed image, checkpoint retirement and feed recovery; no success inferred from process start.'});process.exitCode=code;
 }
}catch(e){emit({stage:'resume_complete',status:'blocked',reason:e.message,exceptionType:e.name,report,integrationVerified:false});process.exitCode=2;}
