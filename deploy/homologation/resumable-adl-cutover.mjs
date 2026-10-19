import {validateFullRecovery} from './full-recovery-validation.mjs';
// Authorized protected recovery + resumable migration. No credentials are copied or printed.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {snapshotValidationReport} from './snapshot-validation-report.mjs';
import {validateDistribution} from './distribution-validation.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const emit=value=>console.log(JSON.stringify({operation:'cutover.resumable',...value}));
export async function step(ledger,name,save,action){
 if(ledger.steps[name]?.status==='ok'){emit({stage:name,status:'reused'});return ledger.steps[name].result;}
 ledger.currentStage=name;ledger.steps[name]={status:'started',at:new Date().toISOString()};await save();emit({stage:name,status:'running'});
 const result=await action();ledger.steps[name]={status:'ok',at:new Date().toISOString(),result};await save();return result;
}
async function command(bin,args,input,timeout=180000,raw=false,quiet=false){
 return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd:root,stdio:['pipe','pipe','pipe']});let buffer='',all='',bytes=0,stderr='';const rows=[];
  const parse=line=>{try{const row=JSON.parse(line);if(typeof row.operation==='string'&&/^(cutover\.|shutdown\.)/.test(row.operation)){rows.push(row);if(!quiet||row.status==='blocked')console.log(JSON.stringify(row));}}catch{}};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('HELPER_TIMEOUT_PRESERVED'));},timeout);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024){child.kill('SIGTERM');return;}if(raw){all+=chunk;return;}buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();lines.forEach(parse);});
  child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk;});child.stdin.on('error',()=>{});child.stdin.end(input);
  child.on('error',()=>{clearTimeout(timer);reject(Error('HELPER_START_FAILED'));});
  child.on('close',code=>{clearTimeout(timer);if(!raw)parse(buffer);if(code!==0||bytes>4*1024*1024){
   const concrete=rows.findLast(row=>row.status==='blocked'&&/^[A-Z_]+$/.test(row.reason||''))?.reason;
   const reason=concrete||(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)?'SSH_HOST_KEY_VERIFICATION_FAILED':/Permission denied.*publickey|Permission denied.*password/i.test(stderr)?'SSH_AUTHENTICATION_FAILED':/Could not resolve hostname/i.test(stderr)?'SSH_DNS_FAILED':/Connection refused/i.test(stderr)?'SSH_CONNECTION_REFUSED':/timed out/i.test(stderr)?'SSH_TIMEOUT':/ERR_MODULE_NOT_FOUND/.test(stderr)?'LOCAL_DEPENDENCY_MISSING':/bad option|unknown option/i.test(stderr)?'NODE_OPTION_UNSUPPORTED':'HELPER_EXIT_NONZERO_SEE_STAGE');
   reject(Error(reason));
  }else resolve(raw?all:rows);});
 });
}
async function protectedJson(file){const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077)||info.size>2*1024*1024)throw Error('PROGRESS_FILE_UNVERIFIED');return JSON.parse(await fs.readFile(file,'utf8'));}
export async function run(args){
 let ledger,progress,save,lease,stage='arguments';
 try{
  if(args.length!==5||args[0]!=='--pid'||args[2]!=='--parent'||!['--recover-and-cutover','--validate-only','--repair-snapshot','--snapshot-report','--snapshot-validation-report','--full-recovery','--partitioned-recovery','--inventory-repair','--distribution-repair'].includes(args[4])||!/^\d+$/.test(args[1])||!/^\d+$/.test(args[3]))throw Error('EXPECTED_OWNER_PARENT_RECOVERY_MODE');
  lease=createServer(socket=>socket.destroy());await new Promise((resolve,reject)=>{lease.once('error',()=>reject(Error('EXECUTOR_ALREADY_RUNNING_OR_PORT_43761_IN_USE')));lease.listen({host:'127.0.0.1',port:43761,exclusive:true},resolve);});
  const pid=args[1],parent=args[3];if(Number(pid)<=1||Number(parent)<=1||pid===parent)throw Error('INVALID_PIDS');
  const folder=path.join(os.homedir(),'Library','Application Support','ADL','Cutover');await fs.mkdir(folder,{recursive:true,mode:0o700});const directory=await fs.lstat(folder);
  if(directory.isSymbolicLink()||!directory.isDirectory()||directory.uid!==process.getuid()||(directory.mode&0o077))throw Error('PROGRESS_DIRECTORY_NOT_PROTECTED');
  progress=path.join(folder,`execution-${pid}-${parent}.json`);
  try{ledger=await protectedJson(progress);}catch(error){if(error.code!=='ENOENT')throw error;ledger={version:1,ownerPid:Number(pid),parentPid:Number(parent),steps:{},authorization:'Explicit user approval: non-cooperative termination of verified worker after protected persisted-state backup; no SIGKILL; migrate to AWS within existing budget.'};}
  if(ledger.version!==1||ledger.ownerPid!==Number(pid)||ledger.parentPid!==Number(parent))throw Error('PROGRESS_IDENTITY_MISMATCH');
  save=async()=>{const tmp=progress+'.'+process.pid+'.tmp';const file=await fs.open(tmp,'wx',0o600);try{await file.writeFile(JSON.stringify(ledger));await file.sync();}finally{await file.close();}await fs.rename(tmp,progress);};
  ledger.lastExecutorCommit=(await command('git',['rev-parse','HEAD'],undefined,10000,true)).trim();if(!ledger.initialExecutorCommit)ledger.initialExecutorCommit=ledger.lastExecutorCommit;
  await save();
  const keys=(await fs.readdir(path.join(os.homedir(),'Downloads'),{withFileTypes:true})).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE_OR_AVAILABLE');
  const common=(await fs.readFile(path.join(here,'resume-adl-api.py'),'utf8')).split("if __name__=='__main__':")[0];
  const inspect=(await fs.readFile(path.join(here,'inspect-cutover-aws.py'),'utf8')).split("if __name__=='__main__':")[0];
  const source=common+'\n'+inspect+'\n'+await fs.readFile(path.join(here,'patch-adl-worker-image.py'),'utf8')+'\n'+await fs.readFile(path.join(here,'repair-adl-snapshot.py'),'utf8')+'\n'+await fs.readFile(path.join(here,'upgrade-partitioned-worker.py'),'utf8')+'\n'+await fs.readFile(path.join(here,'execute-adl-cutover-aws.py'),'utf8');
  const remote=async(action,extra={},quiet=false)=>{
   const rows=await command('ssh',['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',path.join(os.homedir(),'Downloads',keys[0].name),'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -c '+quote(source)],JSON.stringify({action,...extra}),360000,false,quiet);
   const result=rows.findLast(r=>['cutover.aws','cutover.image','cutover.complete_preflight.aws'].includes(r.operation));if(!result||result.status==='blocked'||result.status==='unverified')throw Error('REMOTE_OPERATION_FAILED_SEE_STAGE');return result;
  };
  // Current consumer safety is deliberately not cached. No DNS/TLS/POSNET maintenance repeated.
  stage='remote_consumer_gate';const pre=await remote('preflight');
  if(pre.status!=='collected'||pre.errors?.length||pre.controlHttpStatus!==200||!pre.providerCredentials?.primaryPresent||pre.providerCredentials?.fileMode!=='0o600'||pre.providerCredentials?.directoryMode!=='0o700'||!(args[4]==='--repair-snapshot'?['2147483648','4294967296']:['4294967296']).includes(String(pre.workerModel?.memoryLimitBytes))||!(args[4]==='--repair-snapshot'?['128','256']:['256']).includes(String(pre.workerModel?.prematchCapMB))||!['128','256'].includes(String(pre.workerModel?.inplayCapMB)))throw Error('REMOTE_API_OR_CREDENTIALS_UNVERIFIED');
  if(ledger.steps.local_exit?.status!=='ok'&&pre.awsWorkerContainers?.some(c=>c.running))throw Error('AWS_CONSUMER_PRESENT_BEFORE_MAC_EXIT');
  if(['--validate-only','--repair-snapshot','--snapshot-report','--snapshot-validation-report','--full-recovery','--partitioned-recovery','--inventory-repair','--distribution-repair'].includes(args[4])){
   stage='validation_resume_gate';
   if(!['local_exit','journal_export','journal_import','aws_start'].every(k=>ledger.steps[k]?.status==='ok'))throw Error('VALIDATION_REQUIRES_COMPLETED_CUTOVER');
   if(!['--partitioned-recovery','--inventory-repair','--distribution-repair','--full-recovery'].includes(args[4])&&(pre.awsWorkerContainers?.length!==1||!pre.awsWorkerContainers[0].running))throw Error('VALIDATION_WORKER_NOT_RUNNING_NO_RESTART');
   const rows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/audit-aws-cutover.ts'],undefined,45000);
   const mac=rows.find(r=>r.operation==='cutover.audit');if(mac?.status!=='ok'||mac.matchingWorkerProcesses!==0||mac.workerLockAbsent!==true)throw Error('FRESH_MAC_ABSENCE_AUDIT_FAILED');
   const handoff=await protectedJson(path.join(ledger.steps.journal_export.result.destination,'handoff.json'));
   if(args[4]==='--snapshot-validation-report'){
    stage='snapshot_validation_report';
    const current=await remote('status',{handoff,freshAuditAt:mac.capturedAt},true);
    const report=snapshotValidationReport(current,ledger);
    const {writeProtectedReport}=await import('./distribution-validation.mjs');
    const reportFile=path.join(folder,`snapshot-validation-${pid}-${parent}.json`);
    await writeProtectedReport(reportFile,JSON.stringify(report,null,2));
    emit({stage,status:'collected',...report,reportFile});return;
   }
   if(['--repair-snapshot','--snapshot-report'].includes(args[4])){
    stage='snapshot_capacity_repair';
    const {createHash}=await import('node:crypto');const sourceHashes={};
    for(const name of ['provider.ts','diagnostics.ts','snapshot-capacity.ts'])sourceHashes[name]=createHash('sha256').update(await command('git',['show','HEAD:apps/worker/src/'+name],undefined,10000,true)).digest('hex');
    const result=await remote('repair_snapshot',{handoff,freshAuditAt:mac.capturedAt,sourceHashes,inspectOnly:args[4]==='--snapshot-report',historicalValidation:ledger.lastValidation});
    if(args[4]==='--snapshot-report'){
     const reportFile=path.join(folder,`snapshot-volume-${pid}-${parent}.json`),temporary=reportFile+'.'+process.pid+'.tmp';
     const file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(result,null,2));await file.sync();}finally{await file.close();}await fs.rename(temporary,reportFile);
     ledger.lastSnapshotVolumeReport={at:new Date().toISOString(),reportFile};await save();
     emit({stage:'snapshot_volume_report',status:'ok',reportFile,readOnlyRemote:true,workerRestarted:false,posnetChanged:false});return;
    }
    ledger.steps.snapshot_capacity_repair={status:'ok',at:new Date().toISOString(),result};await save();
   }
   if(['--partitioned-recovery','--inventory-repair','--distribution-repair','--full-recovery'].includes(args[4])){
    stage='partitioned_upgrade';
    const distributionMode=args[4]==='--distribution-repair',fullMode=args[4]==='--full-recovery';
    if(fullMode){
     if(ledger.steps.distribution_upgrade?.status!=='ok')throw Error('FULL_RECOVERY_REQUIRES_COMPLETED_DISTRIBUTION_UPGRADE');
    }else if(!distributionMode){
     const report=await protectedJson(path.join(folder,`snapshot-volume-${pid}-${parent}.json`));
     if(report.report?.decisions?.prematch!=='bounded_partitioned_recovery_required_no_cap_increase'||!report.report.rows?.some(row=>row.lane==='prematch'&&row.classification==='current_limit_exceeded'&&row.httpStatus===200&&row.attemptLimitBytes===268435456))throw Error('SAVED_VOLUME_DIAGNOSIS_NOT_CONFIRMED');
    }else{
     if(ledger.steps.partitioned_upgrade?.status!=='ok')throw Error('DISTRIBUTION_REPAIR_REQUIRES_EXISTING_UPGRADE');
     await command('git',['merge-base','--is-ancestor','2aa06f7','HEAD'],undefined,10000,true);
     const changed=(await command('git',['diff','--name-only','2aa06f7','HEAD','--','apps/worker/src','packages/contracts/src'],undefined,10000,true)).trim().split('\n').filter(n=>n&&!n.endsWith('.test.ts'));
     if(changed.some(n=>!['apps/worker/src/connected.ts','apps/worker/src/provider.ts','packages/contracts/src/index.ts'].includes(n)))throw Error('UNRELATED_RUNTIME_CHANGES_IN_DISTRIBUTION_PATCH');
     const current=await remote('status',{handoff});ledger.distributionPreFixEvidence??={at:new Date().toISOString(),previous:ledger.lastValidation,current};await save();
    }
    if(args[4]==='--inventory-repair'){
     if(ledger.steps.partitioned_upgrade?.status!=='ok')throw Error('INVENTORY_REPAIR_REQUIRES_COMPLETED_PARTITIONED_UPGRADE');
     const previous=ledger.lastValidation,current=await remote('status',{handoff});
     const evidence={capturedAt:new Date().toISOString(),previous,current,readOnly:true,providerRequests:0};ledger.inventoryRepairEvidence??=evidence;ledger.inventoryRepairLatestEvidence=evidence;await save();
     emit({stage:'inventory_evidence',status:'saved',providerRequests:0,progressFile:progress,workerRestarted:false});
    }
    const names=['connected.ts','connection-closer.ts','diagnostics.ts','provider.ts','snapshot-scheduler.ts','state.ts','messages.ts','league-fixtures.ts','partitioned-snapshot.ts','full-snapshot.ts','persistence.ts'].map(name=>'apps/worker/src/'+name);names.push('packages/contracts/src/index.ts','packages/feed-store/src/index.ts');
    const {createHash}=await import('node:crypto'),files={},baseHashes={};
    const baseRef=fullMode?'89f2882':distributionMode?'941b7c8':args[4]==='--inventory-repair'?'5069beb':'a590b7b';const existing=(await command('git',['ls-tree','-r','--name-only',baseRef],undefined,10000,true)).split('\n');
    for(const name of names){files[name]=await command('git',['show','HEAD:'+name],undefined,10000,true);baseHashes[name]=existing.includes(name)?createHash('sha256').update(await command('git',['show',baseRef+':'+name],undefined,10000,true)).digest('hex'):null;}
    const repairOptions=fullMode?{fullRecovery:true}:distributionMode?{fixCommit:'2aa06f7'}:{};
    const prepared=await remote('upgrade_partitioned',{phase:'prepare',files,baseHashes,...repairOptions});
    if(fullMode&&prepared.offlineFullRecoveryVerified!==true)throw Error('FULL_RECOVERY_OFFLINE_UNVERIFIED');
    if(distributionMode&&prepared.offlinePropagationVerified!==true)throw Error('DISTRIBUTION_PROPAGATION_TEST_UNVERIFIED');
    ledger.steps[fullMode?'full_image':distributionMode?'distribution_image':'partitioned_image']={status:'ok',at:new Date().toISOString(),result:prepared};await save();
    const freshRows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/audit-aws-cutover.ts'],undefined,45000);const fresh=freshRows.find(r=>r.operation==='cutover.audit');
    if(fresh?.status!=='ok'||fresh.matchingWorkerProcesses!==0||fresh.workerLockAbsent!==true)throw Error('FRESH_MAC_ABSENCE_AUDIT_FAILED');
    const activated=await remote('upgrade_partitioned',{phase:'activate',files,baseHashes,handoff,freshAuditAt:fresh.capturedAt,...repairOptions});
    ledger.steps[fullMode?'full_upgrade':distributionMode?'distribution_upgrade':'partitioned_upgrade']={status:'ok',at:new Date().toISOString(),result:activated};await save();
    if(fullMode){stage='full_feed_validation';await validateFullRecovery((action,extra)=>remote(action,extra,true),handoff,ledger,save,progress);return;}
    if(distributionMode){stage='distribution_validation';await validateDistribution((action,extra)=>remote(action,extra,true),handoff,ledger,save,progress,path.join(folder,`support-217525-post-2aa06f7-${pid}-${parent}.md`));return;}
    stage='feed_validation';await validateFeeds(remote,handoff,ledger,save,progress,45*60000,args[4]==='--inventory-repair');return;
   }
   stage='feed_validation';await validateFeeds(remote,handoff,ledger,save,progress);return;
  }
  stage='local_protection';
  if(ledger.steps.local_exit?.status!=='ok')await step(ledger,stage,save,async()=>{
   const rows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/protected-mac-cutover.ts','--pid',pid,'--parent',parent,'--protect'],undefined,300000);
   const result=rows.find(r=>r.operation==='cutover.protected'&&r.status==='protected');if(!result)throw Error('CURRENT_STATE_PROTECTION_NOT_CONFIRMED');return result;
  });
  stage='worker_image';
  await step(ledger,stage,save,async()=>{
   const old=await command('git',['show',pre.deployment.releaseCommit+':apps/worker/src/connected.ts'],undefined,10000,true);
   const connected=await command('git',['show','HEAD:apps/worker/src/connected.ts'],undefined,10000,true);
   const closer=await command('git',['show','HEAD:apps/worker/src/connection-closer.ts'],undefined,10000,true);
   const {createHash}=await import('node:crypto');return remote('patch_worker',{patch:{baseConnectedSha256:createHash('sha256').update(old).digest('hex'),files:{'connected.ts':connected,'connection-closer.ts':closer}}});
  });
  stage='local_exit';await step(ledger,stage,save,async()=>{
   const rows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/protected-mac-cutover.ts','--pid',pid,'--parent',parent,'--approve-abrupt-stop'],undefined,300000);
   const result=rows.find(r=>r.operation==='cutover.protected'&&r.stage==='complete'&&r.status==='ok');if(!result)throw Error('MAC_EXIT_NOT_CONFIRMED');return result;
  });
  const audit=async()=>{
   const rows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/audit-aws-cutover.ts'],undefined,45000);const result=rows.find(r=>r.operation==='cutover.audit');
   if(result?.status!=='ok'||result.matchingWorkerProcesses!==0||result.workerLockAbsent!==true)throw Error('FRESH_MAC_ABSENCE_AUDIT_FAILED');return result;
  };
  await audit();
  stage='journal_export';const exported=await step(ledger,stage,save,async()=>{
   const rows=await command(process.execPath,['deploy/homologation/prepare-adl-cutover.mjs']);const result=rows.find(r=>r.operation==='cutover.prepare'&&r.status==='ok');if(!result)throw Error('JOURNAL_EXPORT_NOT_CONFIRMED');return result;
  });
  const handoff=await protectedJson(path.join(exported.destination,'handoff.json'));
  const alreadyRunning=pre.awsWorkerContainers?.some(c=>c.running);
  if(alreadyRunning){
   const fresh=await audit();const adopted=await remote('start',{handoff,freshAuditAt:fresh.capturedAt,expectedWorkerImage:ledger.steps.worker_image.result.image});
   ledger.steps.aws_start={status:'ok',at:new Date().toISOString(),result:adopted};await save();
  }else if(ledger.steps.aws_start?.status==='ok'){
   stage='aws_start_recovery';
   await remote('status',{handoff});
   const fresh=await audit();
   // The server permits retry only for a proven, pre-provider admission rejection.
   const recovered=await remote('recover_start',{handoff,freshAuditAt:fresh.capturedAt,expectedWorkerImage:ledger.steps.worker_image.result.image});
   ledger.steps.aws_start_recovery={status:'ok',at:new Date().toISOString(),result:recovered};await save();
  }else{
   await audit();
   stage='journal_import';let imported=await step(ledger,stage,save,()=>remote('import',{handoff}));
   imported=await remote('import',{handoff});ledger.steps.journal_import.result=imported;await save();
   stage='cooldown';const deadline=Date.parse(imported.notBeforeUTC);if(!Number.isFinite(deadline))throw Error('COOLDOWN_INVALID');
   emit({stage,status:'waiting',notBeforeUTC:imported.notBeforeUTC,workerStarted:false});
   while(Date.now()<deadline){await delay(Math.min(30000,Math.max(1,deadline-Date.now())));emit({stage,status:'waiting',remainingSeconds:Math.max(0,Math.ceil((deadline-Date.now())/1000)),workerStarted:false});}
   stage='fresh_mac_gate';const fresh=await audit();
   stage='aws_start';await step(ledger,stage,save,()=>remote('start',{handoff,freshAuditAt:fresh.capturedAt,expectedWorkerImage:ledger.steps.worker_image.result.image}));
  }
  stage='feed_validation';await validateFeeds(remote,handoff,ledger,save,progress);
 }catch(error){
  if(ledger&&save){ledger.lastFailure={stage,at:new Date().toISOString(),reason:/^[A-Z_]+$/.test(error.message)?error.message:'PRIVATE_OPERATION_FAILED'};try{await save();}catch{}}
  emit({stage,status:'blocked',reason:/^[A-Z_]+$/.test(error.message)?error.message:'PRIVATE_OPERATION_FAILED',progressFile:progress,localExitConfirmed:ledger?.steps?.local_exit?.status==='ok',awsStartConfirmed:ledger?.steps?.aws_start?.status==='ok',note:'See concrete sanitized child stage. Completed results and backups preserved. No blind signal replay, Mac restart or provider cooldown reset.'});process.exitCode=2;
 }
finally{if(lease)await new Promise(resolve=>lease.close(resolve));}
}

export async function validateFeeds(remote,handoff,ledger,save,progress,durationMs=15*60000,stopOnInvalidBaseline=false){
 const until=Date.now()+durationMs;let status;
  while(Date.now()<until){
   status=await remote('status',{handoff});
   ledger.lastValidation=status;ledger.currentStage='feed_validation';await save();
   if(status.status==='snapshots_ready')break;
   if(status.workers?.some(w=>w.state==='exited'||w.oomKilled))throw Error('AWS_WORKER_EXITED_INSPECT_STATUS');
   const rejected=status.lanes?.prematch?.lastSnapshotDiagnostic;
   if(stopOnInvalidBaseline&&(rejected?.snapshotValidation||(['subscriptions.list','snapshot.events'].includes(rejected?.operation)&&['invalid_response','sdk_error','response_limit'].includes(rejected?.category)&&rejected?.reason!=='memory_budget_exceeded'))&&Date.parse(status.lanes.prematch.lastSnapshotErrorAt)>=Date.parse(status.lanes.prematch.session?.startedAt)){
    ledger.currentStage='feed_validation_blocked';ledger.inventoryRejection=rejected;await save();
    emit({stage:'feed_validation_blocked',status:'blocked',reason:'INVENTORY_OR_BATCH_CONTRACT_REJECTED',diagnostic:rejected,progressFile:progress,macWorkerStopped:true,awsWorkerRunning:status.workers?.length===1&&status.workers[0].running===true,posnetChanged:false,note:'No blind wait: fixed code, phase and counts identify the rejected contract; provider_contract requires checking the actual supplier schema, sdk_or_adapter requires parser review. No IDs converted, omitted or released.'});process.exitCode=2;return;
   }
   if(stopOnInvalidBaseline){
    const errors=(status.evidence?.recentErrors||[]).filter(e=>e.lane==='prematch');
    const off=new Set(errors.filter(e=>e.reason==='distribution_still_off').map(e=>e.loggedAt)).size;
    const forced=new Set(errors.filter(e=>e.amqpCode===320).map(e=>e.loggedAt)).size;
    if(status.lanes?.prematch?.phase==='error'&&(off>=2||forced>=2)){
     const reason=off>=2?'SUPPLIER_DISTRIBUTION_REMAINS_OFF':'AMQP_FORCED_CLOSURES_PREVENT_BASELINE';
     ledger.currentStage='feed_validation_blocked';ledger.inventoryTransportBlock={reason,errors};await save();
     emit({stage:'feed_validation_blocked',status:'blocked',reason,progressFile:progress,macWorkerStopped:true,awsWorkerRunning:status.workers?.length===1&&status.workers[0].running===true,posnetChanged:false,note:'Repeated current-container provider/transport errors; no baseline confirmed. No forced requests, no local consumer or distribution reset.'});process.exitCode=2;return;
    }
   }
   if(status.lanes&&Object.values(status.lanes).some(l=>l.phase==='error'&&l.diagnostic?.reason==='unsupported_message_type'))throw Error('AWS_UNSUPPORTED_MESSAGE_RETAINED');
   if(status.lanes&&Object.values(status.lanes).some(l=>l.phase==='error'&&l.diagnostic?.retryPolicy==='restart_required'))throw Error('AWS_MESSAGE_REQUEUED_REQUIRES_HANDLER_REVIEW');
   await delay(30000);
  }
  ledger.lastValidation=status;ledger.currentStage=status?.status==='snapshots_ready'?'complete':'feed_validation_pending';await save();
  const ready=status?.status==='snapshots_ready';emit({stage:ledger.currentStage,status:ready?'snapshots_verified':'pending',progressFile:progress,macWorkerStopped:true,awsWorkerStartConfirmed:true,realFeedSnapshotsVerified:ready,projectionOddsAvailable:ready&&status.selectableSelections>0,iframeAuthenticated:false,authenticatedApiVerified:false,posnetChanged:false,note:'Never restart Mac consumer. Fresh AWS administrator/operation/embed session remains separate. Real validation is this server report, not local tests.'});
  if(!ready)process.exitCode=2;
}
