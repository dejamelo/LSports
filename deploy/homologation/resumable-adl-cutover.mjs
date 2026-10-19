// Authorized protected recovery + resumable migration. No credentials are copied or printed.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const emit=value=>console.log(JSON.stringify({operation:'cutover.resumable',...value}));
export async function step(ledger,name,save,action){
 if(ledger.steps[name]?.status==='ok'){emit({stage:name,status:'reused'});return ledger.steps[name].result;}
 ledger.currentStage=name;ledger.steps[name]={status:'started',at:new Date().toISOString()};await save();emit({stage:name,status:'running'});
 const result=await action();ledger.steps[name]={status:'ok',at:new Date().toISOString(),result};await save();return result;
}
async function command(bin,args,input,timeout=180000,raw=false){
 return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd:root,stdio:['pipe','pipe','pipe']});let buffer='',all='',bytes=0,stderr='';const rows=[];
  const parse=line=>{try{const row=JSON.parse(line);if(typeof row.operation==='string'&&/^(cutover\.|shutdown\.)/.test(row.operation)){rows.push(row);console.log(JSON.stringify(row));}}catch{}};
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
  if(args.length!==5||args[0]!=='--pid'||args[2]!=='--parent'||args[4]!=='--recover-and-cutover'||!/^\d+$/.test(args[1])||!/^\d+$/.test(args[3]))throw Error('EXPECTED_OWNER_PARENT_RECOVERY_MODE');
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
  const source=common+'\n'+inspect+'\n'+await fs.readFile(path.join(here,'patch-adl-worker-image.py'),'utf8')+'\n'+await fs.readFile(path.join(here,'execute-adl-cutover-aws.py'),'utf8');
  const remote=async(action,extra={})=>{
   const rows=await command('ssh',['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',path.join(os.homedir(),'Downloads',keys[0].name),'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -c '+quote(source)],JSON.stringify({action,...extra}),360000);
   const result=rows.find(r=>['cutover.aws','cutover.image','cutover.complete_preflight.aws'].includes(r.operation));if(!result||result.status==='blocked'||result.status==='unverified')throw Error('REMOTE_OPERATION_FAILED_SEE_STAGE');return result;
  };
  // Current consumer safety is deliberately not cached. No DNS/TLS/POSNET maintenance repeated.
  stage='remote_consumer_gate';const pre=await remote('preflight');
  if(pre.status!=='collected'||pre.errors?.length||pre.controlHttpStatus!==200||!pre.providerCredentials?.primaryPresent||pre.providerCredentials?.fileMode!=='0o600'||pre.providerCredentials?.directoryMode!=='0o700'||String(pre.workerModel?.memoryLimitBytes)!=='4294967296'||String(pre.workerModel?.prematchCapMB)!=='256'||String(pre.workerModel?.inplayCapMB)!=='128')throw Error('REMOTE_API_OR_CREDENTIALS_UNVERIFIED');
  if(ledger.steps.local_exit?.status!=='ok'&&pre.awsWorkerContainers?.some(c=>c.running))throw Error('AWS_CONSUMER_PRESENT_BEFORE_MAC_EXIT');
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
   await remote('status',{handoff});throw Error('AWS_WORKER_STOPPED_AFTER_COMPLETED_START');
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
  stage='feed_validation';const until=Date.now()+15*60000;let status;
  while(Date.now()<until){
   status=await remote('status',{handoff});
   if(status.status==='snapshots_ready')break;
   if(status.workers?.some(w=>w.state==='exited'||w.oomKilled))throw Error('AWS_WORKER_EXITED_INSPECT_STATUS');
   if(status.lanes&&Object.values(status.lanes).some(l=>l.phase==='error'&&l.diagnostic?.reason==='unsupported_message_type'))throw Error('AWS_UNSUPPORTED_MESSAGE_RETAINED');
   await delay(30000);
  }
  ledger.lastValidation=status;ledger.currentStage=status?.status==='snapshots_ready'?'complete':'feed_validation_pending';await save();
  const ready=status?.status==='snapshots_ready';emit({stage:ledger.currentStage,status:ready?'snapshots_verified':'pending',progressFile:progress,macWorkerStopped:true,awsWorkerStartConfirmed:true,realFeedSnapshotsVerified:ready,projectionOddsAvailable:ready&&status.selectableSelections>0,iframeAuthenticated:false,authenticatedApiVerified:false,posnetChanged:false,note:'Never restart Mac consumer. Fresh AWS administrator/operation/embed session remains separate. Real validation is this server report, not local tests.'});
  if(!ready)process.exitCode=2;
 }catch(error){
  if(ledger&&save){ledger.lastFailure={stage,at:new Date().toISOString(),reason:/^[A-Z_]+$/.test(error.message)?error.message:'PRIVATE_OPERATION_FAILED'};try{await save();}catch{}}
  emit({stage,status:'blocked',reason:/^[A-Z_]+$/.test(error.message)?error.message:'PRIVATE_OPERATION_FAILED',progressFile:progress,localExitConfirmed:ledger?.steps?.local_exit?.status==='ok',awsStartConfirmed:ledger?.steps?.aws_start?.status==='ok',note:'See concrete sanitized child stage. Completed results and backups preserved. No blind signal replay, Mac restart or provider cooldown reset.'});process.exitCode=2;
 }
finally{if(lease)await new Promise(resolve=>lease.close(resolve));}
}
