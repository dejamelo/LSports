// Worker-only prepared update. Existing guarded executor owns backup, one graceful
// shutdown, real-copy rehearsal, activation and feed validation. No cache cleanup.
import {spawn,spawnSync} from 'node:child_process';
import {readdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
const here=dirname(fileURLToPath(import.meta.url));
const report=join(here,'publication-reserve-repair-'+Date.now()+'.jsonl');writeFileSync(report,'',{mode:0o600,flag:'wx'});
const emit=row=>{console.log(JSON.stringify(row));appendFileSync(report,JSON.stringify(row)+'\n');};
const keys=readdirSync(join(homedir(),'Downloads')).filter(n=>/Lottery.*Key\.pem$/.test(n));
if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
const resumeBackup=process.env.ADL_PUBLICATION_RESUME_BACKUP;
if(resumeBackup!==undefined&&!/^\/var\/backups\/adl-partitioned-upgrade-[A-Za-z0-9_-]+$/.test(resumeBackup))throw Error('RESUME_BACKUP_UNVERIFIED');
emit({stage:'api_healthy_gate',status:'checking',report,workerMutationRequested:false});
const source=`import json,subprocess,time,urllib.request
for attempt in range(10):
 p=subprocess.run(['docker','inspect','adl-homologation-api-1'],capture_output=True,timeout=10,check=True)
 c=json.loads(p.stdout)[0];labels=c['Config'].get('Labels') or {};state=c['State'];health=state.get('Health',{}).get('Status')
 if labels.get('com.docker.compose.project')!='adl-homologation' or labels.get('com.docker.compose.service')!='api':raise SystemExit(2)
 status=None
 try:
  with urllib.request.urlopen('http://127.0.0.1:13001/control',timeout=3) as response:status=response.status
 except Exception:pass
 print(json.dumps({'stage':'api_healthy_gate','status':'verified' if state['Running'] and health=='healthy' and status==200 else 'not_ready','id':c['Id'],'health':health,'httpStatus':status,'restartCount':c['RestartCount'],'startedAtUTC':state['StartedAt'],'workerMutationRequested':False}),flush=True)
 if state['Running'] and health=='healthy' and status==200:raise SystemExit(0)
 if health!='starting':raise SystemExit(2)
 time.sleep(2)
raise SystemExit(2)
`;
const check=spawnSync('ssh',['-i',join(homedir(),'Downloads',keys[0]),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -'],{input:source,encoding:'utf8',timeout:65000,maxBuffer:65536});
let healthy=false;
for(const line of (check.stdout||'').split('\n'))try{const row=JSON.parse(line);emit(row);healthy ||= row.stage==='api_healthy_gate'&&row.status==='verified';}catch{}
if(check.status!==0||!healthy){emit({stage:'api_healthy_gate',status:'blocked',reason:'API_HEALTHY_NOT_VERIFIED_NO_WORKER_CHANGE',exitCode:check.status,errorCode:check.error?.code});process.exit(2);}
const env={...process.env,ADL_LIVE_PERSISTENCE_REPAIR:'1',ADL_PIPELINE_REPAIR:'1',ADL_PUBLICATION_RESERVE_REPAIR:'1'};
for(const key of ['ADL_STOPPED_RETENTION_REPAIR','ADL_RESUME_BACKUP','ADL_CHECKPOINT_REPAIR_BACKUP','ADL_EXPECTED_LIVE_IMAGE','ADL_FINALIZE_VERIFIED_SHUTDOWN','ADL_LIVE_OOM_REPAIR','ADL_EXPECTED_OOM_PREFIX','ADL_SNAPSHOT_PRESSURE_REPAIR'])delete env[key];
if(resumeBackup)env.ADL_RESUME_BACKUP=resumeBackup;
emit({stage:'worker_update',status:'starting_guarded_executor',note:'Reuse existing backup/restore/validation gates; no API, Caddy or POSNET deployment.'});
const child=spawn(process.execPath,[join(here,'complete-adl-cutover.mjs'),'--pid','12811','--parent','12809','--snapshot-memory-repair'],{env,stdio:['inherit','pipe','inherit']});
createInterface({input:child.stdout}).on('line',line=>{console.log(line);try{appendFileSync(report,JSON.stringify(JSON.parse(line))+'\n');}catch{}});
const timer=setInterval(()=>emit({stage:'worker_update',status:'running',report}),20000);
let deploymentCode;
try{deploymentCode=await new Promise(resolve=>{child.once('error',()=>resolve(2));child.once('close',code=>resolve(code??2));});}finally{clearInterval(timer);}
// Read-only follow-up aborts immediately if the worker is stopped; never wait on
// a stopped worker. It distinguishes old-row retirement from new raw receipts.
emit({stage:'post_update_retirement',status:'checking',deploymentExitCode:deploymentCode});
const observe=spawn(process.execPath,[join(here,'collect-session-recovery.mjs'),'--api-health','--drain'],{stdio:['inherit','pipe','inherit']});
createInterface({input:observe.stdout}).on('line',line=>{console.log(line);try{appendFileSync(report,JSON.stringify(JSON.parse(line))+'\n');}catch{}});
const observed=await new Promise(resolve=>{observe.once('error',()=>resolve(2));observe.once('close',code=>resolve(code??2));});
process.exitCode=deploymentCode||observed;
emit({stage:'executor_complete',deploymentExitCode:deploymentCode,observationExitCode:observed,report,integrationVerified:false,note:'Consult full_feed_validation evidence; this wrapper does not infer integration success from API health or retirement alone.'});
