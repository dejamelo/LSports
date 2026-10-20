// Single entry point. No provider HTTP probes; saved Compose overlays and POSNET are preserved.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
let stage='arguments',started=false,handoffPath;
const emit=v=>console.log(JSON.stringify({operation:'cutover.complete',...v}));
async function command(bin,args,input,timeout=180000){
 return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd:root,stdio:['pipe','pipe','pipe']});let stdout='',size=0;const rows=[];
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('HELPER_TIMEOUT'));},timeout);
  child.stderr.on('data',()=>{}); // Never print raw stderr, ssh errors, Compose configs or tokens.
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){child.kill('SIGTERM');return;}stdout+=chunk;});
  child.on('error',()=>{clearTimeout(timer);reject(Error('HELPER_START_FAILED'));});
  child.on('close',code=>{clearTimeout(timer);
   for(const line of stdout.trim().split('\n'))try{const row=JSON.parse(line);if(typeof row.operation==='string'&&(row.operation.startsWith('cutover.')||row.operation==='launcher.diagnose')){rows.push(row);console.log(JSON.stringify(row));}}catch{}
   if(code!==0||size>2*1024*1024)reject(Error('HELPER_FAILED_SEE_SANITIZED_STAGE'));else resolve(rows);
  });
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
async function audit(){const rows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/audit-aws-cutover.ts'],undefined,45000);const a=rows.find(r=>r.operation==='cutover.audit');if(a?.status!=='ok'||a.matchingWorkerProcesses!==0||a.workerLockAbsent!==true)throw Error('MAC_AUDIT_NOT_CLEAR');return a;}
async function main(){
 if(process.argv.length!==4||process.argv[2]!=='--pid'||!/^\d+$/.test(process.argv[3]))throw Error('EXPECTED_EXPLICIT_OWNER_PID');
 const pid=process.argv[3];
 // All remote readiness is checked BEFORE touching the Mac owner.
 stage='complete_preflight';emit({stage,status:'checking',workerStarted:false});
 const reports=await command(process.execPath,['deploy/homologation/inspect-complete-cutover.mjs','--pid',pid],undefined,150000);
 const pre=reports.find(r=>r.operation==='cutover.complete_preflight');
 if(pre?.status!=='collected'||pre.aws?.errors?.length||pre.aws?.awsWorkerContainers?.some(c=>c.running)||pre.aws?.providerCredentials?.primaryPresent!==true||pre.aws?.controlHttpStatus!==200||pre.aws?.feedVolume?.workerLockExists||pre.aws?.feedVolume?.schedulerLockCount||String(pre.aws?.workerModel?.memoryLimitBytes)!=='4294967296'||String(pre.aws?.workerModel?.prematchCapMB)!=='256'||String(pre.aws?.workerModel?.inplayCapMB)!=='128')throw Error('PREFLIGHT_NOT_READY');
 const keys=(await fs.readdir(path.join(os.homedir(),'Downloads'),{withFileTypes:true})).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
 const common=(await fs.readFile(path.join(here,'resume-adl-api.py'),'utf8')).split("if __name__=='__main__':")[0];
 const source=common+'\n'+await fs.readFile(path.join(here,'execute-adl-cutover-aws.py'),'utf8');
 const remote=async(action,handoff,extra={})=>{
  const rows=await command('ssh',['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',path.join(os.homedir(),'Downloads',keys[0].name),'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -c '+quote(source)],JSON.stringify({action,handoff,...extra}),120000);
  const result=rows.find(r=>r.operation==='cutover.aws');if(!result||result.status==='blocked')throw Error('REMOTE_STAGE_FAILED');return result;
 };
 stage='graceful_stop_and_export';emit({stage,status:'running',workerStarted:false});
 let exports;
 if(pre.mac?.localEvidence?.status==='ok')exports=await command(process.execPath,['deploy/homologation/prepare-adl-cutover.mjs']);
 else exports=await command(process.execPath,['deploy/homologation/recover-stopped-mac-worker.mjs','--pid',pid,'--resume-and-stop'],undefined,240000);
 const exported=exports.find(r=>r.operation==='cutover.prepare'&&r.status==='ok');if(!exported)throw Error('EXPORT_NOT_CONFIRMED');
 handoffPath=path.join(exported.destination,'handoff.json');const stat=await fs.lstat(handoffPath);
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.size>1024*1024)throw Error('HANDOFF_NOT_PROTECTED');
 const handoff=JSON.parse(await fs.readFile(handoffPath,'utf8'));
 stage='import';emit({stage,status:'running',workerStarted:false});const imported=await remote('import',handoff);
 const deadline=Date.parse(imported.notBeforeUTC);if(!Number.isFinite(deadline))throw Error('COOLDOWN_UNPROVEN');
 stage='cooldown';emit({stage,status:'waiting',notBeforeUTC:imported.notBeforeUTC,workerStarted:false});
 while(Date.now()<deadline){await delay(Math.min(30000,Math.max(1,deadline-Date.now())));emit({stage,status:'waiting',remainingSeconds:Math.max(0,Math.ceil((deadline-Date.now())/1000)),workerStarted:false});}
 stage='final_mac_audit';const fresh=await audit();
 stage='start';emit({stage,status:'running',workerStarted:false});await remote('start',handoff,{freshAuditAt:fresh.capturedAt});started=true;
 stage='validate';
 const until=Date.now()+15*60000;let result;
 while(Date.now()<until){
  result=await remote('status',handoff);
  if(result.status==='snapshots_ready')break;
  if(result.workers?.some(c=>c.state==='exited'||c.oomKilled))throw Error('AWS_WORKER_EXITED');
  await delay(30000);
 }
 const ready=result?.status==='snapshots_ready';
 emit({stage:'complete',status:ready?'snapshots_verified':'validation_pending',workerStarted:true,macMustRemainStopped:true,notBeforeUTC:imported.notBeforeUTC,handoffPath,posnetChanged:false,
  projectionOddsAvailable:ready&&result.selectableSelections>0,authenticatedApiVerified:false,iframeAuthenticated:false,
  nextStep:'AWS platform needs its own administrator, client/operation and temporary iframe session. Keep Mac worker stopped. No provider query retries outside scheduler.'});
 if(!ready)process.exitCode=2;
}
if((process.argv.includes('--durable-ingress-repair')||process.argv.includes('--durable-ingress-rollback')||process.argv.includes('--api-validation-resume')||process.argv.includes('--recover-and-cutover')||process.argv.includes('--validate-only')||process.argv.includes('--repair-snapshot')||process.argv.includes('--snapshot-throughput-repair')||process.argv.includes('--spool-memory-repair')||process.argv.includes('--recovery-throughput-repair')||process.argv.includes('--recovery-throughput-rollback')||process.argv.includes('--helper-preflight-report')||process.argv.includes('--nullable-markets-repair')||process.argv.includes('--nullable-markets-rollback')||process.argv.includes('--supplier-order-repair')||process.argv.includes('--supplier-order-rollback')||process.argv.includes('--full-recovery')||process.argv.includes('--startup-report')||process.argv.includes('--snapshot-validation-report')||process.argv.includes('--snapshot-report')||process.argv.includes('--partitioned-recovery')||process.argv.includes('--inventory-repair')||process.argv.includes('--distribution-repair'))){
 import('./resumable-adl-cutover.mjs').then(module=>module.run(process.argv.slice(2))).catch(()=>{emit({stage:'executor_start',status:'blocked',reason:'RESUMABLE_EXECUTOR_START_FAILED'});process.exitCode=2;});
}else main().catch(error=>{emit({stage,status:'blocked',reason:/^[A-Z_]+$/.test(error.message)?error.message:'PRIVATE_OPERATION_FAILED',workerStartConfirmed:started,handoffPath,macMustRemainStopped:true,posnetChanged:false,note:'Preserve locks, journals and backups. No repeated signals, automatic Mac restart, AWS worker duplication or raw stderr.'});process.exitCode=2;});
