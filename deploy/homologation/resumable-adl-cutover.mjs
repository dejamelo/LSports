import {writeRecoverySupport} from './recovery-support.mjs';
import {assembleRemoteHelper,helperInvocation,sanitizedHelperExit} from './remote-helper-transport.mjs';
import {validateFullRecovery} from './full-recovery-validation.mjs';
export function persistenceExpectedImage(ledger,env=process.env){
 const image=env.ADL_EXPECTED_LIVE_IMAGE??(ledger.steps.throughput_upgrade?.status==='ok'?ledger.steps.throughput_upgrade.result?.image:undefined);
 if(!/^adl-worker-partitioned:[0-9a-f]{24}$/.test(image||'')||env.ADL_LIVE_OOM_REPAIR==='1')throw Error('EXPECTED_CURRENT_PERSISTENCE_IMAGE_REQUIRED');
 return image;
}
export function acceptedWorkerMemoryLimits({mode,snapshotMemoryRepair,pipelineRepair,livePersistenceRepair}){
 if(mode==='--repair-snapshot')return ['2147483648','4294967296'];
 if(pipelineRepair)return ['6442450944'];
 if(snapshotMemoryRepair&&livePersistenceRepair)return ['4294967296','6442450944'];
 return ['4294967296'];
}
// Authorized protected recovery + resumable migration. No credentials are copied or printed.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {snapshotValidationReport,briefRecoveryTimeline} from './snapshot-validation-report.mjs';
import {validateDistribution} from './distribution-validation.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(process.env.ADL_REPO_ROOT||path.resolve(here,'../..')),runtimeRef=process.env.ADL_RUNTIME_REF||'HEAD';
export const resolveAuditEntrypoint=(repoRoot=root)=>path.resolve(repoRoot,'scripts/audit-aws-cutover.ts');
const auditEntrypoint=resolveAuditEntrypoint();
const partitionWorkerSourceNames=Object.freeze(['connected.ts','connection-closer.ts','diagnostics.ts','snapshot-capacity.ts','provider.ts','snapshot-scheduler.ts','state.ts','messages.ts','league-fixtures.ts','partitioned-snapshot.ts','full-snapshot.ts','persistence.ts','durable-ingress.mjs','durable-ingress.d.mts']);
const partitionPackageSourceNames=Object.freeze(['packages/contracts/src/index.ts','packages/feed-store/src/index.ts']);
const emit=value=>console.log(JSON.stringify({operation:'cutover.resumable',...value}));
export async function step(ledger,name,save,action){
 if(ledger.steps[name]?.status==='ok'){emit({stage:name,status:'reused'});return ledger.steps[name].result;}
 ledger.currentStage=name;ledger.steps[name]={status:'started',at:new Date().toISOString()};await save();emit({stage:name,status:'running'});
 const result=await action();ledger.steps[name]={status:'ok',at:new Date().toISOString(),result};await save();return result;
}
export async function command(bin,args,input,timeout=180000,raw=false,quiet=false,context={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd:root,stdio:['pipe','pipe','pipe']});let buffer='',all='',bytes=0,stderr='',failed=false;const rows=[];
  const parse=line=>{try{const row=JSON.parse(line);if(typeof row.operation==='string'&&/^(cutover\.|shutdown\.)/.test(row.operation)){rows.push(row);if(!quiet||row.status==='blocked')console.log(JSON.stringify(row));}}catch{}};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  const timer=setTimeout(()=>{failed=true;child.kill('SIGTERM');const detail={...sanitizedHelperExit({...context,code:null,signal:'SIGTERM',stderr,rows}),reason:'HELPER_TIMEOUT_PRESERVED'};console.log(JSON.stringify(detail));reject(Object.assign(Error(detail.reason),{helperExit:detail}));},timeout);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024){child.kill('SIGTERM');return;}if(raw){all+=chunk;return;}buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();lines.forEach(parse);});
  child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk;});child.stdin.on('error',()=>{});child.stdin.end(input);
  child.on('error',error=>{failed=true;clearTimeout(timer);const detail=sanitizedHelperExit({...context,spawnCode:error.code,rows,stderr});console.log(JSON.stringify(detail));reject(Object.assign(Error(detail.reason),{helperExit:detail}));});
  child.on('close',(code,signal)=>{clearTimeout(timer);if(failed)return;if(!raw)parse(buffer);if(code!==0||bytes>4*1024*1024){
   const detail=sanitizedHelperExit({...context,code,signal,stderr,rows});console.log(JSON.stringify(detail));reject(Object.assign(Error(detail.reason),{helperExit:detail}));
  }else resolve(raw?all:rows);});
 });
}
async function helperPreflightReport(stage){
 const keys=(await fs.readdir(path.join(os.homedir(),'Downloads'),{withFileTypes:true})).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE_OR_AVAILABLE');
 const source=await assembleRemoteHelper(here),invocation=await helperInvocation(here,source,{action:'preflight'});
 emit({stage,status:'running',readOnly:true,providerRequests:0,workerRestarted:false,ledgerChanged:false,sourceBytes:Buffer.byteLength(source),remoteCommandBytes:Buffer.byteLength(invocation.command)});
 const rows=await command('ssh',['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',path.join(os.homedir(),'Downloads',keys[0].name),'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com',invocation.command],invocation.input,90000,false,false,{stage,action:'preflight'});
 const result=rows.findLast(r=>r.operation==='cutover.complete_preflight.aws');if(result?.status!=='collected')throw Error('READ_ONLY_PREFLIGHT_NOT_COLLECTED');
 emit({stage:'helper_preflight_report',status:'collected',readOnly:true,providerRequests:0,workerRestarted:false,ledgerChanged:false,posnetChanged:false});
}
async function protectedJson(file){const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077)||info.size>2*1024*1024)throw Error('PROGRESS_FILE_UNVERIFIED');return JSON.parse(await fs.readFile(file,'utf8'));}
export function startupFailure(error){
 const reason=/^[A-Z][A-Z0-9_]{2,120}$/.test(error.message||'')?error.message:'PRIVATE_OPERATION_FAILED';
 return {reason,exceptionType:['Error','TypeError','SyntaxError','RangeError'].includes(error.name)?error.name:'Error',...( /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code||'')?{errorCode:error.code}:{}),...( ['mkdir','lstat','open','read','write','rename','listen'].includes(error.syscall)?{syscall:error.syscall}:{})};
}
export function recoveryMode(mode){
 const snapshotMemoryRepair=['--snapshot-memory-repair','--snapshot-memory-rollback'].includes(mode);
 return {snapshotMemoryRepair,durableMode:mode==='--durable-ingress-repair'||mode==='--durable-ingress-rollback'||snapshotMemoryRepair,durableRollback:mode==='--durable-ingress-rollback'||mode==='--snapshot-memory-rollback'};
}
export function reusablePreparedImage(ledger,{backup,pipelineRepair=false,durableIngress=false}={}){
 const result=ledger?.steps?.throughput_image?.status==='ok'?ledger.steps.throughput_image.result:undefined;
 if(!result||!/^adl-worker-partitioned:[0-9a-f]{24}$/.test(result.image||'')||result.backup!==backup||result.progressPhase!=='stopped'||result.workerRestarted!==false||result.offlineSnapshotMemoryVerified!==true)return;
 if(pipelineRepair&&result.offlinePipelineLoadVerified!==true)return;
 if(durableIngress&&result.offlineDurableIngressVerified!==true)return;
 return result;
}
export async function run(args){
 const {snapshotMemoryRepair,durableMode,durableRollback}=recoveryMode(args[4]);
 if(durableMode)args=[...args.slice(0,4),durableRollback?'--recovery-throughput-rollback':'--snapshot-throughput-repair'];
 let ledger,progress,save,lease,stage='arguments';
 try{
  if(args.length!==5||args[0]!=='--pid'||args[2]!=='--parent'||!['--recover-and-cutover','--validate-only','--repair-snapshot','--snapshot-report','--worker-exit-report','--startup-report','--snapshot-validation-report','--supplier-order-repair','--supplier-order-rollback','--nullable-markets-repair','--nullable-markets-rollback','--snapshot-throughput-repair','--spool-memory-repair','--recovery-throughput-repair','--recovery-throughput-rollback','--api-validation-resume','--feed-validation-resume','--recovery-progress','--pipeline-report','--helper-preflight-report','--full-recovery','--partitioned-recovery','--inventory-repair','--distribution-repair'].includes(args[4])||!/^\d+$/.test(args[1])||!/^\d+$/.test(args[3]))throw Error('EXPECTED_OWNER_PARENT_RECOVERY_MODE');
  const pid=args[1],parent=args[3];if(Number(pid)<=1||Number(parent)<=1||pid===parent)throw Error('INVALID_PIDS');
  if(args[4]==='--helper-preflight-report'){stage='remote_consumer_gate';await helperPreflightReport(stage);return;}
  stage='executor_lease';lease=createServer(socket=>socket.destroy());await new Promise((resolve,reject)=>{lease.once('error',()=>reject(Error('EXECUTOR_ALREADY_RUNNING_OR_PORT_43761_IN_USE')));lease.listen({host:'127.0.0.1',port:43761,exclusive:true},resolve);});
  stage='progress_directory';const folder=path.join(os.homedir(),'Library','Application Support','ADL','Cutover');await fs.mkdir(folder,{recursive:true,mode:0o700});const directory=await fs.lstat(folder);
  if(directory.isSymbolicLink()||!directory.isDirectory()||directory.uid!==process.getuid()||(directory.mode&0o077))throw Error('PROGRESS_DIRECTORY_NOT_PROTECTED');
  progress=path.join(folder,`execution-${pid}-${parent}.json`);
  stage='progress_load';try{ledger=await protectedJson(progress);}catch(error){if(error.code!=='ENOENT')throw error;ledger={version:1,ownerPid:Number(pid),parentPid:Number(parent),steps:{},authorization:'Explicit user approval: non-cooperative termination of verified worker after protected persisted-state backup; no SIGKILL; migrate to AWS within existing budget.'};}
  if(ledger.version!==1||ledger.ownerPid!==Number(pid)||ledger.parentPid!==Number(parent))throw Error('PROGRESS_IDENTITY_MISMATCH');
  save=async()=>{const tmp=progress+'.'+process.pid+'.tmp';const file=await fs.open(tmp,'wx',0o600);try{await file.writeFile(JSON.stringify(ledger));await file.sync();}finally{await file.close();}await fs.rename(tmp,progress);};
  stage='executor_revision';if(args[4]!=='--worker-exit-report'){
  ledger.lastExecutorCommit=(await command('git',['rev-parse',runtimeRef],undefined,10000,true)).trim();if(!ledger.initialExecutorCommit)ledger.initialExecutorCommit=ledger.lastExecutorCommit;
  await save();
  }
  const keys=(await fs.readdir(path.join(os.homedir(),'Downloads'),{withFileTypes:true})).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE_OR_AVAILABLE');
  const source=await assembleRemoteHelper(here);
  const remote=async(action,extra={},quiet=false)=>{
   const invocation=await helperInvocation(here,source,{action,...extra});
   const rows=await command('ssh',['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',path.join(os.homedir(),'Downloads',keys[0].name),'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com',invocation.command],invocation.input,action==='upgrade_partitioned'&&extra.finalizeAfterRecovery?4500000:action==='upgrade_partitioned'&&extra.snapshotMemoryRepair?1800000:360000,false,quiet,{stage,action});
   const result=rows.findLast(r=>['cutover.aws','cutover.image','cutover.complete_preflight.aws'].includes(r.operation));if(!result||result.status==='blocked'||result.status==='unverified')throw Error('REMOTE_OPERATION_FAILED_SEE_STAGE');return result;
  };
   if(args[4]==='--pipeline-report'){
    stage='pipeline_report';
    if(!['local_exit','journal_export','journal_import','aws_start','throughput_upgrade'].every(k=>ledger.steps[k]?.status==='ok'))throw Error('PIPELINE_REPORT_REQUIRES_COMPLETED_UPGRADE');
    const macRows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env',auditEntrypoint],undefined,45000);const mac=macRows.find(r=>r.operation==='cutover.audit');
    if(mac?.status!=='ok'||mac.matchingWorkerProcesses!==0||mac.workerLockAbsent!==true)throw Error('FRESH_MAC_ABSENCE_AUDIT_FAILED');
    const handoff=await protectedJson(path.join(ledger.steps.journal_export.result.destination,'handoff.json'));
    const names=partitionWorkerSourceNames.map(n=>'apps/worker/src/'+n);names.push(...partitionPackageSourceNames);
    const {createHash}=await import('node:crypto');const sourceSets={};
    for(const ref of ['6f6b8928aee8dadab7b9be1f9dd2755f7c8fa46f',runtimeRef]){const full=(await command('git',['rev-parse',ref],undefined,10000,true)).trim();sourceSets[full]={};for(const name of names)sourceSets[full][name]=createHash('sha256').update(await command('git',['show',full+':'+name],undefined,10000,true)).digest('hex');}
    const {writeProtectedReport}=await import('./distribution-validation.mjs');const {observeRecovery}=await import('./recovery-progress.mjs');
    await observeRecovery((action,extra)=>remote(action,extra,true),handoff,ledger,save,path.join(folder,`pipeline-${pid}-${parent}.json`),writeProtectedReport,{identityRequest:{expectedImage:persistenceExpectedImage(ledger,{}),sourceSets}});return;
   }
   if(args[4]==='--worker-exit-report'){
    stage='worker_exit_report';
    if(!['local_exit','journal_export','journal_import','aws_start'].every(k=>ledger.steps[k]?.status==='ok'))throw Error('REPORT_REQUIRES_COMPLETED_CUTOVER');
    const rows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env',auditEntrypoint],undefined,45000);
    const mac=rows.find(r=>r.operation==='cutover.audit');
    if(mac?.status!=='ok'||mac.matchingWorkerProcesses!==0||mac.workerLockAbsent!==true)throw Error('FRESH_MAC_ABSENCE_AUDIT_FAILED');
    const handoff=await protectedJson(path.join(ledger.steps.journal_export.result.destination,'handoff.json'));
    const rehearsalLog=process.env.ADL_REHEARSAL_LOG;
    if(rehearsalLog!==undefined&&!/^oom-restore-attempt-[0-9a-f]{16,32}\.private\.log$/.test(rehearsalLog))throw Error('INVALID_REHEARSAL_LOG_NAME');
    const expectedWorkerId=process.env.ADL_EXPECTED_WORKER_ID;if(expectedWorkerId&&!/^[0-9a-f]{64}$/.test(expectedWorkerId))throw Error('INVALID_EXPECTED_WORKER_ID');
    const expectedWorkerPrefix=process.env.ADL_EXPECTED_WORKER_PREFIX;if(expectedWorkerPrefix&&!/^[0-9a-f]{12,63}$/.test(expectedWorkerPrefix))throw Error('INVALID_EXPECTED_WORKER_PREFIX');if(expectedWorkerId&&expectedWorkerPrefix)throw Error('CONFLICTING_EXPECTED_WORKER_IDENTITY');
    const currentOnly=process.env.ADL_CURRENT_EXIT_ONLY==='1';
    const report=await remote('worker_exit_report',{handoff,...(!currentOnly?{rehearsalBackup:ledger.steps.throughput_image?.result?.backup}:{}),...(expectedWorkerId?{expectedWorkerId}:{}),...(expectedWorkerPrefix?{expectedWorkerPrefix}:{}),...(!currentOnly&&rehearsalLog?{rehearsalLog}:{})},true);
    const {writeProtectedReport}=await import('./distribution-validation.mjs');
    const reportFile=path.join(folder,`worker-exit-${pid}-${parent}${expectedWorkerId||expectedWorkerPrefix?'-'+(expectedWorkerId||expectedWorkerPrefix).slice(0,12):''}.json`);
    await writeProtectedReport(reportFile,JSON.stringify(report,null,2));
    emit({stage,status:'collected',readOnly:true,providerRequests:0,workerRestarted:false,offlineRehearsal:report.offlineRehearsal,workers:report.workers?.map(({id,state,running,exitCode,oomKilled,startedAtUTC,finishedAtUTC,memoryLimitBytes,nodeOptions,frozenCheckpoint,checkpointDiagnosticError,kernelOOM,timeline,finalLogSignals,oomConclusion})=>({id,state,running,exitCode,oomKilled,startedAtUTC,finishedAtUTC,memoryLimitBytes,nodeOptions,checkpointDiagnosticError,kernelOOM,recentStages:timeline?.records?.filter(r=>['snapshot.events','file.persist'].includes(r.operation)).slice(-4),lastSnapshotStage:frozenCheckpoint?.lanes?.prematch?.fullSnapshot,sharedPersistence:frozenCheckpoint?.sharedPersistence,finalLogSignals,oomConclusion})),reportFile,posnetChanged:false});return;
   }
  if(['--api-validation-resume','--feed-validation-resume','--recovery-progress'].includes(args[4])){
   stage='api_health';
   if(!['local_exit','journal_export','journal_import','aws_start','throughput_upgrade'].every(k=>ledger.steps[k]?.status==='ok'))throw Error('VALIDATION_REQUIRES_COMPLETED_THROUGHPUT_UPGRADE');
   const {writeProtectedReport}=await import('./distribution-validation.mjs');
   const reportFile=path.join(folder,`api-health-${pid}-${parent}.json`);
   let health;
   for(let attempt=0;attempt<4;attempt++){
    health=await remote('api_health');
    ledger.apiHealth={at:new Date().toISOString(),reportFile,result:health};await save();
    await writeProtectedReport(reportFile,JSON.stringify(health,null,2));
    if(health.ready)break;
    // Observe only a possible Docker health transition; never restart either service.
    if(health.apis?.length!==1||!health.apis[0].running||health.apis[0].oomKilled||health.apis[0].probes?.validator?.status!==200||health.apis[0].probes?.container?.status!==200)break;
    if(attempt<3)await delay(30000);
   }
   if(!health.ready)throw Error('API_HEALTH_UNRESOLVED_SEE_PROTECTED_REPORT_NO_RESTART');
   if(!health.workerInstallation?.verified)throw Error('INSTALLED_WORKER_CORRECTIONS_UNVERIFIED_NO_RESTART');
   stage='validation_resume_gate';
   const rows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env',auditEntrypoint],undefined,45000);
   const mac=rows.find(r=>r.operation==='cutover.audit');
   if(mac?.status!=='ok'||mac.matchingWorkerProcesses!==0||mac.workerLockAbsent!==true)throw Error('FRESH_MAC_ABSENCE_AUDIT_FAILED');
   const handoff=await protectedJson(path.join(ledger.steps.journal_export.result.destination,'handoff.json'));
   if(args[4]==='--recovery-progress'){
    stage='recovery_progress';const {observeRecovery}=await import('./recovery-progress.mjs');
    await observeRecovery((action,extra)=>remote(action,extra,true),handoff,ledger,save,path.join(folder,`recovery-progress-${pid}-${parent}.json`),writeProtectedReport);return;
   }
   stage='full_feed_validation';
   await validateFullRecovery((action,extra)=>remote(action,extra,true),handoff,ledger,save,progress,{requireSupplierOrder:true,allowTransientReconnect:true,stableForMs:args[4]==='--feed-validation-resume'?1800000:120000,requireIngress:args[4]==='--feed-validation-resume',compact:args[4]==='--feed-validation-resume'});
   return;
  }
  // Current consumer safety is deliberately not cached. No DNS/TLS/POSNET maintenance repeated.
  stage='remote_consumer_gate';const pre=await remote('preflight');
  const acceptedMemory=acceptedWorkerMemoryLimits({mode:args[4],snapshotMemoryRepair,pipelineRepair:process.env.ADL_PIPELINE_REPAIR==='1',livePersistenceRepair:process.env.ADL_LIVE_PERSISTENCE_REPAIR==='1'});
  if(pre.status!=='collected'||pre.errors?.length||pre.controlHttpStatus!==200||!pre.providerCredentials?.primaryPresent||pre.providerCredentials?.fileMode!=='0o600'||pre.providerCredentials?.directoryMode!=='0o700'||!acceptedMemory.includes(String(pre.workerModel?.memoryLimitBytes))||!(args[4]==='--repair-snapshot'?['128','256']:['256']).includes(String(pre.workerModel?.prematchCapMB))||!['128','256'].includes(String(pre.workerModel?.inplayCapMB)))throw Error('REMOTE_API_OR_CREDENTIALS_UNVERIFIED');
  if(ledger.steps.local_exit?.status!=='ok'&&pre.awsWorkerContainers?.some(c=>c.running))throw Error('AWS_CONSUMER_PRESENT_BEFORE_MAC_EXIT');
  if(['--validate-only','--repair-snapshot','--snapshot-report','--startup-report','--snapshot-validation-report','--supplier-order-repair','--supplier-order-rollback','--nullable-markets-repair','--nullable-markets-rollback','--snapshot-throughput-repair','--spool-memory-repair','--recovery-throughput-repair','--recovery-throughput-rollback','--full-recovery','--partitioned-recovery','--inventory-repair','--distribution-repair'].includes(args[4])){
   stage='validation_resume_gate';
   if(!['local_exit','journal_export','journal_import','aws_start'].every(k=>ledger.steps[k]?.status==='ok'))throw Error('VALIDATION_REQUIRES_COMPLETED_CUTOVER');
   if(!['--partitioned-recovery','--inventory-repair','--distribution-repair','--supplier-order-repair','--supplier-order-rollback','--nullable-markets-repair','--nullable-markets-rollback','--snapshot-throughput-repair','--spool-memory-repair','--recovery-throughput-repair','--recovery-throughput-rollback','--full-recovery'].includes(args[4])&&(pre.awsWorkerContainers?.length!==1||!pre.awsWorkerContainers[0].running))throw Error('VALIDATION_WORKER_NOT_RUNNING_NO_RESTART');
   const rows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env',auditEntrypoint],undefined,45000);
   const mac=rows.find(r=>r.operation==='cutover.audit');if(mac?.status!=='ok'||mac.matchingWorkerProcesses!==0||mac.workerLockAbsent!==true)throw Error('FRESH_MAC_ABSENCE_AUDIT_FAILED');
   const handoff=await protectedJson(path.join(ledger.steps.journal_export.result.destination,'handoff.json'));
   if(args[4]==='--startup-report'){
    stage='startup_report';
    const {createHash}=await import('node:crypto');
    const expectedSources=Object.fromEntries(await Promise.all(['apps/worker/src/config.ts','apps/worker/src/mq.ts','apps/worker/src/connected.ts'].map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex')])));
    const current=await remote('startup_report',{handoff,expectedSources},true);
    const {writeProtectedReport}=await import('./distribution-validation.mjs');
    const reportFile=path.join(folder,`startup-${pid}-${parent}.json`);
    const report={readOnly:true,providerRequests:0,workerRestarted:false,posnetChanged:false,macWorkerStopped:true,
     capturedAtUTC:new Date().toISOString(),validationSinceUTC:current.validationSinceUTC,
     workers:current.workers,lanes:current.lanes,amqpComparison:current.amqpComparison,startupLogs:current.startupLogs,evidence:current.evidence,
     evidenceLimit:'No ACK does not prove consumer registration failed. Installed image has no registration telemetry. Startup log window is bounded; absence is not proof of no error.'};
    await writeProtectedReport(reportFile,JSON.stringify(report,null,2));
    ledger.lastStartupReport={at:report.capturedAtUTC,reportFile};await save();
    emit({stage,status:'collected',...report,reportFile});return;
   }
   if(args[4]==='--snapshot-validation-report'){
    stage='snapshot_validation_report';
    const fromUTC=process.env.ADL_LOG_FROM_UTC,toUTC=process.env.ADL_LOG_TO_UTC;
    if(!!fromUTC!==!!toUTC)throw Error('TIMELINE_BOTH_BOUNDARIES_REQUIRED');
    const current=await remote('status',{handoff,freshAuditAt:mac.capturedAt,...(fromUTC?{timelineWindow:{fromUTC,toUTC}}:{})},true);
    const report=snapshotValidationReport(current,ledger);
    const {writeProtectedReport}=await import('./distribution-validation.mjs');
    const reportFile=path.join(folder,`snapshot-validation-${pid}-${parent}.json`);
    await writeProtectedReport(reportFile,JSON.stringify(report,null,2));
    emit({stage,status:'collected',...(process.env.ADL_REPORT_BRIEF==='1'?briefRecoveryTimeline(report):report),reportFile});return;
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
   if(['--partitioned-recovery','--inventory-repair','--distribution-repair','--supplier-order-repair','--supplier-order-rollback','--nullable-markets-repair','--nullable-markets-rollback','--snapshot-throughput-repair','--spool-memory-repair','--recovery-throughput-repair','--recovery-throughput-rollback','--full-recovery'].includes(args[4])){
    stage='partitioned_upgrade';
    const throughputMode=['--snapshot-throughput-repair','--spool-memory-repair','--recovery-throughput-repair','--recovery-throughput-rollback'].includes(args[4]);
    const nullableMode=['--nullable-markets-repair','--nullable-markets-rollback','--snapshot-throughput-repair','--spool-memory-repair','--recovery-throughput-repair','--recovery-throughput-rollback'].includes(args[4]);
    const supplierMode=['--supplier-order-repair','--supplier-order-rollback','--nullable-markets-repair','--nullable-markets-rollback','--snapshot-throughput-repair','--spool-memory-repair','--recovery-throughput-repair','--recovery-throughput-rollback'].includes(args[4]),distributionMode=args[4]==='--distribution-repair',fullMode=['--supplier-order-repair','--supplier-order-rollback','--nullable-markets-repair','--nullable-markets-rollback','--snapshot-throughput-repair','--spool-memory-repair','--recovery-throughput-repair','--recovery-throughput-rollback','--full-recovery'].includes(args[4]);
    if(throughputMode&&ledger.steps.nullable_markets_upgrade?.status!=='ok')throw Error('THROUGHPUT_FIX_REQUIRES_APPLIED_NULLABLE_MARKETS');
    if(nullableMode&&ledger.steps.supplier_order_upgrade?.status!=='ok')throw Error('NULLABLE_FIX_REQUIRES_COMPLETED_STARTUP_ORDER_UPGRADE');
    if(supplierMode){if(ledger.steps.full_upgrade?.status!=='ok')throw Error('SUPPLIER_ORDER_FIX_REQUIRES_COMPLETED_FULL_RECOVERY_UPGRADE');}
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
    const names=partitionWorkerSourceNames.map(name=>'apps/worker/src/'+name);names.push(...partitionPackageSourceNames);
    const {createHash}=await import('node:crypto'),files={},baseHashes={};
    const baseRef=snapshotMemoryRepair?'7248e39':durableMode?'789707f':args[4]==='--snapshot-throughput-repair'?'043af2e':['--snapshot-throughput-repair','--spool-memory-repair'].includes(args[4])?'dcd644b':throughputMode?'b63e735':nullableMode?'db4c193':supplierMode?'3425f72':fullMode?'89f2882':distributionMode?'941b7c8':args[4]==='--inventory-repair'?'5069beb':'a590b7b';const existing=(await command('git',['ls-tree','-r','--name-only',baseRef],undefined,10000,true)).split('\n');
    for(const name of names){files[name]=await command('git',['show',runtimeRef+':'+name],undefined,10000,true);baseHashes[name]=existing.includes(name)?createHash('sha256').update(await command('git',['show',baseRef+':'+name],undefined,10000,true)).digest('hex'):null;}
    if(!snapshotMemoryRepair&&args[4]==='--recovery-throughput-rollback'&&ledger.steps.throughput_rollback?.status==='ok'){emit({stage:'throughput_rollback',status:'reused',workerStarted:false,posnetChanged:false});return;}
    if(args[4]==='--recovery-throughput-rollback'&&ledger.steps.throughput_image?.status!=='ok')throw Error('THROUGHPUT_ROLLBACK_NOT_PREPARED');
    if(throughputMode&&!snapshotMemoryRepair&&args[4]!=='--recovery-throughput-rollback'){
     stage='recovery_runtime_evidence';
     const proofNames=['apps/worker/src/connected.ts','apps/worker/src/provider.ts','apps/worker/src/full-snapshot.ts'];
     const expectedRuntime={before:Object.fromEntries(proofNames.map(n=>[n,baseHashes[n]])),candidate:Object.fromEntries(proofNames.map(n=>[n,createHash('sha256').update(files[n]).digest('hex')]))};
     const sourceDigest=createHash('sha256').update(JSON.stringify(expectedRuntime)).digest('hex');
     let evidence=ledger.recoveryThroughputLatestEvidence;
     const prior=evidence?.recoveryEvidence;
     if(ledger.recoveryThroughputEvidenceSourceDigest!==sourceDigest||!prior?.nullableCollectionsInstalled||!prior.capturedRowPreviouslyVerified||(!prior.matchesBefore&&!(prior.matchesCandidate&&prior.candidateOfflineVerified))){
      evidence=await remote('recovery_evidence',{handoff,expectedRuntime});
      ledger.recoveryThroughputPreviousValidation??=ledger.lastValidation;ledger.recoveryThroughputPreFix??=evidence;ledger.recoveryThroughputLatestEvidence=evidence;ledger.recoveryThroughputEvidenceSourceDigest=sourceDigest;await save();
     }else emit({stage:'recovery_runtime_evidence',status:'reused',reason:'SAME_IMMUTABLE_SOURCES_PREVIOUSLY_VERIFIED',providerRequests:0,workerRestarted:false});
     const proof=evidence.recoveryEvidence;
     if(['--snapshot-throughput-repair','--spool-memory-repair'].includes(args[4])&&proof?.matchesBefore){const m=proof.cgroupMemory||{},used=m['memory.current']??m['memory.usage_in_bytes'],limit=m['memory.max']??m['memory.limit_in_bytes'];if(limit!==4294967296||!Number.isSafeInteger(used)||limit-used<320*1024*1024||proof.hostAvailableMemoryBytes<512*1024*1024)throw Error('MEASURED_MEMORY_HEADROOM_INSUFFICIENT_NO_PATCH');}
     if(!proof?.nullableCollectionsInstalled||!proof.capturedRowPreviouslyVerified||(!proof.matchesBefore&&!(proof.matchesCandidate&&proof.candidateOfflineVerified)))throw Error('RECOVERY_RUNTIME_NOT_KNOWN_NO_BLIND_PATCH');
     emit({stage:'recovery_runtime_evidence',status:'verified',nullableCollectionsInstalled:true,capturedRowPreviouslyVerified:true,appliedCandidateAlready:proof.matchesCandidate,providerRequests:0,workerRestarted:false,brokerCloseCauseProven:false});
     stage='throughput_upgrade';
    }
    if(['--snapshot-throughput-repair','--spool-memory-repair'].includes(args[4])){ledger.spoolMemoryBefore??={validation:ledger.lastValidation,upgrade:ledger.steps.throughput_upgrade,evidence:ledger.recoveryThroughputLatestEvidence};await save();}
    const repairOptions=supplierMode?{fullRecovery:true,supplierOrder:true,fixCommit:'2aa06f7',...(throughputMode?{throughputFix:true,...(['--snapshot-throughput-repair','--spool-memory-repair'].includes(args[4])?{spoolMemoryFix:true,...(args[4]==='--snapshot-throughput-repair'?{snapshotThroughputFix:true}:{})}:{})}:{}),...(nullableMode?{nullableEvidence:'/var/backups/adl-snapshot-shape-2thwo24l'}:{})}:fullMode?{fullRecovery:true}:distributionMode?{fixCommit:'2aa06f7'}:{};
    if(durableMode)repairOptions.durableIngress=true;
    if(snapshotMemoryRepair){repairOptions.snapshotMemoryRepair=true;repairOptions.checkpointRepairBackup=ledger.steps.throughput_image?.result?.backup;}
    if(snapshotMemoryRepair&&process.env.ADL_CHECKPOINT_REPAIR_BACKUP){const b=process.env.ADL_CHECKPOINT_REPAIR_BACKUP;if(!/^\/var\/backups\/adl-partitioned-upgrade-[A-Za-z0-9_-]+$/.test(b)||process.env.ADL_RESUME_BACKUP)throw Error('DERIVED_REPAIR_BACKUP_UNVERIFIED');repairOptions.checkpointRepairBackup=b;}
    if(snapshotMemoryRepair&&process.env.ADL_LIVE_OOM_REPAIR==='1'){const prefix=process.env.ADL_EXPECTED_OOM_PREFIX;if(!/^[0-9a-f]{12,63}$/.test(prefix||''))throw Error('EXPECTED_CURRENT_OOM_PREFIX_REQUIRED');repairOptions.liveOomRepair=true;repairOptions.expectedOomPrefix=prefix;}
    if(snapshotMemoryRepair&&process.env.ADL_LIVE_PERSISTENCE_REPAIR==='1'){const image=persistenceExpectedImage(ledger);repairOptions.livePersistenceRepair=true;repairOptions.expectedLiveImage=image;}
    if(process.env.ADL_STOPPED_RETENTION_REPAIR==='1'){if(!snapshotMemoryRepair||!repairOptions.checkpointRepairBackup||repairOptions.livePersistenceRepair||repairOptions.liveOomRepair||process.env.ADL_RESUME_BACKUP)throw Error('RETENTION_REPAIR_REQUIRES_STOPPED_PREPARATION');repairOptions.stoppedRetentionRepair=true;}
    if(process.env.ADL_PIPELINE_REPAIR==='1'){if((!repairOptions.livePersistenceRepair&&!repairOptions.stoppedRetentionRepair)||!snapshotMemoryRepair)throw Error('PIPELINE_REPAIR_REQUIRES_VERIFIED_IDENTITY');repairOptions.pipelineRepair=true;repairOptions.finalizeAfterRecovery=true;}
    if(process.env.ADL_PUBLICATION_RESERVE_REPAIR==='1'){if(!repairOptions.pipelineRepair||!repairOptions.livePersistenceRepair)throw Error('PUBLICATION_RESERVE_REQUIRES_VERIFIED_LIVE_PIPELINE');repairOptions.publicationReserveRepair=true;}
    if(process.env.ADL_TRANSPORT_LIFECYCLE_REPAIR==='1'){if(!repairOptions.pipelineRepair||!repairOptions.livePersistenceRepair||repairOptions.publicationReserveRepair)throw Error('TRANSPORT_LIFECYCLE_REQUIRES_VERIFIED_LIVE_PIPELINE');repairOptions.transportLifecycleRepair=true;}
    if(process.env.ADL_CHECKPOINT_BUFFER_REPAIR==='1'){if(!repairOptions.transportLifecycleRepair)throw Error('CHECKPOINT_BUFFER_REQUIRES_TRANSPORT_IDENTITY');repairOptions.checkpointWriteBufferRepair=true;}
    if(process.env.ADL_PARTIAL_PREFIX_REPAIR==='1'&&!repairOptions.transportLifecycleRepair)throw Error('PARTIAL_PREFIX_CHECK_REQUIRES_GUARDED_TRANSPORT_PATCH');
    if(process.env.ADL_SNAPSHOT_PRESSURE_REPAIR==='1'){if(!repairOptions.livePersistenceRepair)throw Error('PRESSURE_REPAIR_REQUIRES_LIVE_IDENTITY');repairOptions.snapshotPressureRepair=true;}
    if(snapshotMemoryRepair&&process.env.ADL_RESUME_BACKUP){if(!/^\/var\/backups\/adl-partitioned-upgrade-[A-Za-z0-9_-]+$/.test(process.env.ADL_RESUME_BACKUP))throw Error('RESUME_BACKUP_UNVERIFIED');repairOptions.resumeBackup=process.env.ADL_RESUME_BACKUP;const prepared=ledger.steps.throughput_image;if(prepared?.status==='ok'&&prepared.result?.backup===repairOptions.resumeBackup&&/^adl-worker-partitioned:[0-9a-f]{24}$/.test(prepared.result?.image||''))repairOptions.resumePreparedImage=prepared.result.image;emit({stage:'resume_preparation_reference',status:'resolved',backup:repairOptions.resumeBackup,preparedImage:repairOptions.resumePreparedImage??null,source:repairOptions.resumePreparedImage?'protected_local_progress':'unique_protected_remote_receipt_required',workerStarted:false});}
    if(process.env.ADL_PRESERVED_HEAP_BUDGET_REPAIR==='1'){if(!snapshotMemoryRepair||!repairOptions.snapshotPressureRepair||!repairOptions.livePersistenceRepair||repairOptions.pipelineRepair||!repairOptions.resumeBackup)throw Error('HEAP_REPAIR_REQUIRES_PINNED_PRESSURE_RESUME');repairOptions.preservedHeapBudgetRepair=true;}
    if(snapshotMemoryRepair&&process.env.ADL_FINALIZE_VERIFIED_SHUTDOWN==='1'){if(!repairOptions.resumeBackup)throw Error('FINALIZATION_REQUIRES_PINNED_PREPARATION');repairOptions.finalizeAfterRecovery=true;}
    if(snapshotMemoryRepair){ledger.beforeSnapshotMemoryRepair??={image:ledger.steps.throughput_image,upgrade:ledger.steps.throughput_upgrade};await save();}
    const reusedPrepared=snapshotMemoryRepair?reusablePreparedImage(ledger,{...repairOptions,backup:repairOptions.checkpointRepairBackup}):undefined;
    const prepared=reusedPrepared?(emit({stage:'prepared_image_reuse',status:'reused',image:reusedPrepared.image,backup:reusedPrepared.backup,workerStarted:false,workerRestarted:false}),reusedPrepared):await remote('upgrade_partitioned',{phase:'prepare',files,baseHashes,...repairOptions});
    if(repairOptions.pipelineRepair&&prepared.offlinePipelineLoadVerified!==true)throw Error('PIPELINE_LOAD_OFFLINE_UNVERIFIED_NO_STOP');
    if(snapshotMemoryRepair&&prepared.offlineSnapshotMemoryVerified!==true)throw Error('SNAPSHOT_MEMORY_OFFLINE_UNVERIFIED');
    if(repairOptions.snapshotPressureRepair&&prepared.offlineSnapshotPressureVerified!==true)throw Error('SNAPSHOT_PRESSURE_OFFLINE_UNVERIFIED_NO_STOP');
    if(durableMode&&prepared.offlineDurableIngressVerified!==true)throw Error('DURABLE_INGRESS_OFFLINE_UNVERIFIED');
    if(args[4]==='--snapshot-throughput-repair'&&prepared.offlineSnapshotThroughputVerified!==true)throw Error('SNAPSHOT_THROUGHPUT_OFFLINE_REQUIRED');
    if(['--snapshot-throughput-repair','--spool-memory-repair'].includes(args[4])&&prepared.offlineSpoolMemoryVerified!==true)throw Error('SPOOL_MEMORY_OFFLINE_TEST_REQUIRED');
    if(throughputMode&&prepared.offlineThroughputVerified!==true)throw Error('THROUGHPUT_FIX_OFFLINE_UNVERIFIED');
    if(nullableMode&&prepared.offlineNullableMarketsVerified!==true)throw Error('CAPTURED_NULLABLE_ROW_OFFLINE_UNVERIFIED');
    if(supplierMode&&prepared.offlineSupplierOrderVerified!==true)throw Error('SUPPLIER_STARTUP_ORDER_OFFLINE_UNVERIFIED');
    if(fullMode&&prepared.offlineFullRecoveryVerified!==true)throw Error('FULL_RECOVERY_OFFLINE_UNVERIFIED');
    if(distributionMode&&prepared.offlinePropagationVerified!==true)throw Error('DISTRIBUTION_PROPAGATION_TEST_UNVERIFIED');
    ledger.steps[throughputMode?'throughput_image':nullableMode?'nullable_markets_image':supplierMode?'supplier_order_image':fullMode?'full_image':distributionMode?'distribution_image':'partitioned_image']={status:'ok',at:new Date().toISOString(),result:prepared};await save();
    const freshRows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env',auditEntrypoint],undefined,45000);const fresh=freshRows.find(r=>r.operation==='cutover.audit');
    if(fresh?.status!=='ok'||fresh.matchingWorkerProcesses!==0||fresh.workerLockAbsent!==true)throw Error('FRESH_MAC_ABSENCE_AUDIT_FAILED');
    if(['--supplier-order-rollback','--nullable-markets-rollback','--recovery-throughput-rollback'].includes(args[4])){const result=await remote('upgrade_partitioned',{phase:'rollback',files,baseHashes,handoff,freshAuditAt:fresh.capturedAt,...repairOptions});ledger.steps[throughputMode?'throughput_rollback':nullableMode?'nullable_markets_rollback':'supplier_order_rollback']={status:'ok',result};await save();return;}
    let activationAudit=fresh;
    if(snapshotMemoryRepair){
     const verified=await remote('upgrade_partitioned',{phase:'activate',verifyOnly:true,files,baseHashes,handoff,freshAuditAt:fresh.capturedAt,...repairOptions});
     if(verified.offlineRestoreVerified!==true)throw Error('OOM_PERSISTED_DATA_NOT_VERIFIED_NO_START');
     ledger.steps.snapshot_memory_data={status:'ok',result:verified};await save();
     const rows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env',auditEntrypoint],undefined,45000);activationAudit=rows.find(r=>r.operation==='cutover.audit');
     if(activationAudit?.status!=='ok'||activationAudit.matchingWorkerProcesses!==0||activationAudit.workerLockAbsent!==true)throw Error('FRESH_MAC_ABSENCE_AUDIT_FAILED');
    }
    const activated=await remote('upgrade_partitioned',{phase:'activate',files,baseHashes,handoff,freshAuditAt:activationAudit.capturedAt,...repairOptions});
    ledger.steps[throughputMode?'throughput_upgrade':nullableMode?'nullable_markets_upgrade':supplierMode?'supplier_order_upgrade':fullMode?'full_upgrade':distributionMode?'distribution_upgrade':'partitioned_upgrade']={status:'ok',at:new Date().toISOString(),result:activated};await save();
    if(fullMode){stage='full_feed_validation';try{await validateFullRecovery((action,extra)=>remote(action,extra,true),handoff,ledger,save,progress,{requireSupplierOrder:supplierMode,allowTransientReconnect:throughputMode,stableForMs:durableMode?1800000:throughputMode?120000:0,requireIngress:durableMode,...(repairOptions.transportLifecycleRepair?{retirementDeadlineMs:300000}:{}),...(process.env.ADL_PARTIAL_PREFIX_REPAIR==='1'?{durationMs:600000}:{})});}finally{if(throughputMode)await writeRecoverySupport(ledger,path.join(folder,`support-217525-recovery-${pid}-${parent}.md`));}return;}
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
   const rows=await command(process.execPath,['--import','tsx','--env-file-if-exists=.env',auditEntrypoint],undefined,45000);const result=rows.find(r=>r.operation==='cutover.audit');
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
  if(ledger&&save){ledger.lastFailure={stage,at:new Date().toISOString(),...startupFailure(error),...(error.helperExit?{helperExit:error.helperExit}:{})};try{await save();}catch{}}
  emit({stage,status:'blocked',...startupFailure(error),...(error.helperExit?{helperExit:error.helperExit}:{}),progressFile:progress,localExitConfirmed:ledger?.steps?.local_exit?.status==='ok',awsStartConfirmed:ledger?.steps?.aws_start?.status==='ok',note:'See concrete sanitized child stage. Completed results and backups preserved. No blind signal replay, Mac restart or provider cooldown reset.'});process.exitCode=2;
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
