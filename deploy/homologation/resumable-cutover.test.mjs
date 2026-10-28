import {test} from 'node:test';
import assert from 'node:assert/strict';
import {step,validateFeeds,persistenceExpectedImage,resolveAuditEntrypoint,reusablePreparedImage,canonicalSourceDigest,pinnedResumePreparation,macAuditProvesStopped,stoppedEightGiBWorkerFailure,verifiedSnapshotMemorySourceBackup,verifiedInstalledSnapshotMemoryProfile,verifiedExistingSnapshotMemoryProfileOption,remoteActionTimeout} from './resumable-adl-cutover.mjs';
import path from 'node:path';
test('8 GiB stopped-worker recovery distinguishes kernel and V8 OOM by exact worker identity',()=>{
 const base={name:'/adl-homologation-worker-1',state:'exited',id:'a'.repeat(64)};
 assert.deepEqual(stoppedEightGiBWorkerFailure([{...base,exitCode:137,oomKilled:true}]),{kind:'kernel_oom',id:base.id});
 assert.deepEqual(stoppedEightGiBWorkerFailure([{...base,exitCode:134,oomKilled:false}]),{kind:'v8_heap_oom',id:base.id});
 for(const worker of [{...base,exitCode:134,oomKilled:true},{...base,exitCode:137,oomKilled:false},{...base,exitCode:1,oomKilled:false},{...base,name:'/other-worker',exitCode:134,oomKilled:false},{...base,id:'short',exitCode:134,oomKilled:false}])assert.equal(stoppedEightGiBWorkerFailure([worker]),undefined);
 assert.equal(stoppedEightGiBWorkerFailure([{...base,exitCode:134,oomKilled:false},{...base,id:'b'.repeat(64),exitCode:137,oomKilled:true}]),undefined);
});
test('snapshot memory recovery selects only a backup with verified restore and projection readback',()=>{
 const verified='/var/backups/adl-partitioned-upgrade-w7r5wvwr';
 const unverified='/var/backups/adl-partitioned-upgrade-8n9ymoks';
 const ledger={steps:{
  throughput_image:{status:'ok',result:{backup:unverified,offlineRestoreVerified:false,projectionReadbackVerified:false}},
  snapshot_memory_data:{status:'ok',result:{backup:verified,offlineRestoreVerified:true,projectionReadbackVerified:true}},
 }};
 assert.equal(verifiedSnapshotMemorySourceBackup(ledger),verified);
 assert.equal(verifiedSnapshotMemorySourceBackup({steps:{snapshot_memory_data:{status:'ok',result:{backup:verified,offlineRestoreVerified:true,projectionReadbackVerified:false}}}}),undefined);
 assert.equal(verifiedSnapshotMemorySourceBackup({steps:{snapshot_memory_data:{status:'ok',result:{backup:'/tmp/untrusted',offlineRestoreVerified:true,projectionReadbackVerified:true}}}}),undefined);
});
test('an installed 8 GiB profile is reusable only with its complete measured recovery proof',()=>{
 const model={memoryLimitBytes:'8589934592',gates:{capacityApproved:true,macStopped:true,notBeforeConfigured:true}};
 const result={status:'ok',offlineRestoreVerified:true,projectionReadbackVerified:true,rehearsalCopyVerified:true,preservedSpoolRehearsed:true,
  rehearsalMemory:{effectiveHeapLimitBytes:5033164800,maxSampledHeapBytes:4374513640,maxObservedRSSBytes:4951400448},
  projectionReadbackMemory:{effectiveHeapLimitBytes:5033164800},projectionReadbackBudget:{budgetBytes:335544320}};
 const ledger={steps:{snapshot_memory_data:{status:'ok',result}}};
 assert.equal(verifiedInstalledSnapshotMemoryProfile(ledger,model),true);
 assert.equal(verifiedInstalledSnapshotMemoryProfile(ledger,{...model,memoryLimitBytes:'6442450944'}),false);
 for(const change of [{projectionReadbackVerified:false},{rehearsalCopyVerified:false},{preservedSpoolRehearsed:false},{rehearsalMemory:{...result.rehearsalMemory,maxSampledHeapBytes:4800000000}},{rehearsalMemory:{...result.rehearsalMemory,maxObservedRSSBytes:9000000000}}]){
  assert.equal(verifiedInstalledSnapshotMemoryProfile({steps:{snapshot_memory_data:{status:'ok',result:{...result,...change}}}},model),false);
 }
 assert.equal(verifiedInstalledSnapshotMemoryProfile({steps:{snapshot_memory_data:{status:'pending',result}}},model),false);
});
test('repair modes forward verified installed snapshot memory profile to the remote gate',()=>{
 const proof={status:'ok',offlineRestoreVerified:true};
 assert.deepEqual(verifiedExistingSnapshotMemoryProfileOption(proof),{verifiedExistingSnapshotMemoryProfile:proof});
 assert.deepEqual(verifiedExistingSnapshotMemoryProfileOption(undefined),{});
});
test('local audit follows the selected repository root when the executor script runs from an isolated worktree',()=>{
 assert.equal(resolveAuditEntrypoint('/Users/example/LSports'),path.resolve('/Users/example/LSports/scripts/audit-aws-cutover.ts'));
});
test('protected full recovery timeout covers the measured checkpoint and publication cycle',()=>{
 assert.equal(remoteActionTimeout('upgrade_partitioned',{fullRecovery:true}),4500000);
 assert.equal(remoteActionTimeout('upgrade_partitioned',{finalizeAfterRecovery:true}),4500000);
 assert.equal(remoteActionTimeout('upgrade_partitioned',{snapshotMemoryRepair:true}),1800000);
 assert.equal(remoteActionTimeout('status',{fullRecovery:true}),360000);
});
test('missing local checkpoint only counts as stopped for recovery when every process and lock is absent',()=>{
 const report={status:'blocked',matchingWorkerProcesses:0,workerLockAbsent:true,processes:{status:'ok',matching:0},locks:[],blockers:[{stage:'checkpoint',reason:'ENOENT'}],journalCount:1};
 assert.equal(macAuditProvesStopped(report),false);assert.equal(macAuditProvesStopped(report,{allowMissingCheckpoint:true}),true);
 for(const changed of [{matchingWorkerProcesses:1},{workerLockAbsent:false},{locks:[{}]},{journalCount:0},{blockers:[{stage:'checkpoint',reason:'INVALID'}]}])assert.equal(macAuditProvesStopped({...report,...changed},{allowMissingCheckpoint:true}),false);
});
test('completed stages are reused; failure stays pending and does not erase previous results',async()=>{
 const ledger={steps:{}};let saves=0,actions=0;
 const save=async()=>{saves++;};
 assert.equal(await step(ledger,'backup',save,async()=>{actions++;return 'verified';}),'verified');
 assert.equal(await step(ledger,'backup',save,async()=>{throw Error('must not rerun');}),'verified');
 await assert.rejects(step(ledger,'image',save,async()=>{throw Error('docker failure');}));
 assert.equal(ledger.steps.backup.status,'ok');assert.equal(ledger.steps.image.status,'started');
 assert.equal(await step(ledger,'image',save,async()=>{actions++;return 'patched';}),'patched');
 assert.equal(actions,2);assert.ok(saves>=5);
});
test('prepared snapshot repair image is reused only with matching backup and passed offline gates',()=>{
 const sourceDigest='a'.repeat(64),result={image:'adl-worker-partitioned:'+sourceDigest.slice(0,24),backup:'/var/backups/adl-partitioned-upgrade-safe',progressPhase:'stopped',workerRestarted:false,offlineSnapshotMemoryVerified:true,offlinePipelineLoadVerified:true,offlineDurableIngressVerified:true};
 const ledger={steps:{throughput_image:{status:'ok',result}}};
 assert.equal(reusablePreparedImage(ledger,{backup:result.backup,pipelineRepair:true,durableIngress:true,sourceDigest}),result);
 assert.equal(reusablePreparedImage(ledger,{backup:result.backup,pipelineRepair:true,durableIngress:true,sourceDigest:'b'.repeat(64)}),undefined);
 assert.equal(reusablePreparedImage(ledger,{backup:'/var/backups/other',pipelineRepair:true,sourceDigest}),undefined);
 for(const change of [{progressPhase:'start_requested'},{workerRestarted:true},{offlineSnapshotMemoryVerified:false},{offlinePipelineLoadVerified:false},{offlineDurableIngressVerified:false}]){
  assert.equal(reusablePreparedImage({steps:{throughput_image:{status:'ok',result:{...result,...change}}}},{backup:result.backup,pipelineRepair:true,durableIngress:true,sourceDigest}),undefined);
 }
 assert.equal(reusablePreparedImage({steps:{throughput_image:{status:'pending',result}}},{backup:result.backup,pipelineRepair:true,durableIngress:true,sourceDigest}),undefined);
});
test('prepared pressure-repair image is not reused until its matching pressure proof is recorded',()=>{
 const sourceDigest='c'.repeat(64),result={image:'adl-worker-partitioned:'+sourceDigest.slice(0,24),backup:'/var/backups/adl-partitioned-upgrade-safe',progressPhase:'stopped',workerRestarted:false,offlineSnapshotMemoryVerified:true,offlinePipelineLoadVerified:true,offlineDurableIngressVerified:true,offlineSnapshotPressureVerified:false};
 const ledger={steps:{throughput_image:{status:'ok',result}}},options={backup:result.backup,pipelineRepair:true,durableIngress:true,snapshotPressureRepair:true,sourceDigest};
 assert.equal(reusablePreparedImage(ledger,options),undefined);
 result.offlineSnapshotPressureVerified=true;
 assert.equal(reusablePreparedImage(ledger,options),result);
});

test('prepared source digest matches Python canonical JSON ordering and Unicode escaping',()=>{
 assert.equal(canonicalSourceDigest({b:'á',a:'x'}),'76404747ae9230492614230d19b592d3322e2b20c31c9a4eafbbcf46199a169e');
});
test('pinned resume backup is resolved before measured snapshot retry gates',()=>{
 const backup='/var/backups/adl-partitioned-upgrade-9sab5fc5',image='adl-worker-partitioned:06b33c115981974814a08b7f';
 const ledger={steps:{throughput_image:{status:'ok',result:{backup,image}}}};
 assert.deepEqual(pinnedResumePreparation(true,ledger,{ADL_RESUME_BACKUP:backup}),{resumeBackup:backup,resumePreparedImage:image});
 assert.deepEqual(pinnedResumePreparation(false,ledger,{ADL_RESUME_BACKUP:backup}),{});
 assert.throws(()=>pinnedResumePreparation(true,ledger,{ADL_RESUME_BACKUP:'/tmp/other'}),/RESUME_BACKUP_UNVERIFIED/);
});

test('validation resumes with status only, preserves completed migration and saves current evidence',async()=>{
 const ledger={steps:{local_exit:{status:'ok'},aws_start:{status:'ok'},journal_import:{status:'ok'}}};const before=JSON.stringify(ledger.steps);const calls=[];let saved=0;
 await validateFeeds(async(action)=>{calls.push(action);return {status:'snapshots_ready',selectableSelections:3,workers:[{state:'running'}]};},{},ledger,async()=>{saved++;},'/protected/progress');
 assert.deepEqual(calls,['status']);assert.equal(JSON.stringify(ledger.steps),before);assert.equal(ledger.currentStage,'complete');assert.ok(saved>=1);
});
test('validation preserves failure evidence without restarting an exited worker',async()=>{
 const ledger={steps:{aws_start:{status:'ok'}}};const calls=[];
 await assert.rejects(validateFeeds(async(action)=>{calls.push(action);return {status:'recovering',workers:[{state:'exited'}],evidence:{readOnly:true}};},{},ledger,async()=>{},'/protected/progress'),/AWS_WORKER_EXITED/);
 assert.deepEqual(calls,['status']);assert.equal(ledger.lastValidation.evidence.readOnly,true);assert.equal(ledger.steps.aws_start.status,'ok');
});

test('inventory repair saves exact fresh rejection and returns without another polling wait or provider request',async()=>{
 const code=process.exitCode;const ledger={steps:{local_exit:{status:'ok'},journal_import:{status:'ok'},aws_start:{status:'ok'}}};const before=JSON.stringify(ledger.steps);const calls=[];
 const diagnostic={reason:'invalid_snapshot',snapshotValidation:{phase:'inventory',code:'inventory_invalid_ids',attribution:'provider_contract',rawCount:3,invalidCount:1,itemTypes:{number:2,string:1}}};
 try{await validateFeeds(async action=>{calls.push(action);return{status:'recovering',workers:[{state:'running'}],lanes:{prematch:{phase:'recovering',session:{startedAt:'2026-10-19T12:00:00Z'},lastSnapshotErrorAt:'2026-10-19T12:00:01Z',lastSnapshotDiagnostic:diagnostic}}};},{},ledger,async()=>{},'/protected/progress',1000,true);
 assert.deepEqual(calls,['status']);assert.equal(ledger.currentStage,'feed_validation_blocked');assert.deepEqual(ledger.inventoryRejection,diagnostic);assert.equal(JSON.stringify(ledger.steps),before);
 }finally{process.exitCode=code;}
});

test('inventory repair separates repeated current-container distribution errors without restarting worker',async()=>{
 const code=process.exitCode;const calls=[],ledger={steps:{}};
 try{await validateFeeds(async action=>{calls.push(action);return{status:'recovering',workers:[{state:'running'}],lanes:{prematch:{phase:'error'}},evidence:{recentErrors:[{lane:'prematch',reason:'distribution_still_off',loggedAt:'2026-10-19T12:00:01Z'},{lane:'prematch',reason:'distribution_still_off',loggedAt:'2026-10-19T12:01:01Z'}]}};},{},ledger,async()=>{},'/protected/progress',1000,true);
 assert.deepEqual(calls,['status']);assert.equal(ledger.inventoryTransportBlock.reason,'SUPPLIER_DISTRIBUTION_REMAINS_OFF');
 }finally{process.exitCode=code;}
});


test('OOM repair and rollback remain distinct durable modes; no migration mode is selected',async()=>{
 const {recoveryMode,partitionedRepairMode,indexedApiDeploymentReceipt,alignApiDeploymentReceipt}=await import('./resumable-adl-cutover.mjs');
 assert.deepEqual(recoveryMode('--snapshot-memory-repair'),{snapshotMemoryRepair:true,durableMode:true,durableRollback:false});
 assert.deepEqual(recoveryMode('--indexed-publication-repair'),{snapshotMemoryRepair:true,durableMode:true,durableRollback:false});
 assert.deepEqual(recoveryMode('--snapshot-memory-rollback'),{snapshotMemoryRepair:true,durableMode:true,durableRollback:true});
 assert.deepEqual(recoveryMode('--durable-ingress-repair'),{snapshotMemoryRepair:false,durableMode:true,durableRollback:false});
 assert.equal(partitionedRepairMode('--indexed-publication-repair'),true);
 assert.equal(partitionedRepairMode('--snapshot-memory-repair'),true);
 assert.equal(partitionedRepairMode('--feed-validation-resume'),false);
 const commit='a'.repeat(40),complete={stage:'complete',status:'ok',installedCommit:commit,installedImageId:'sha256:'+('b'.repeat(64)),installedSourceVerified:true,workersUnchanged:true,posnetChanged:false};
 const receipt=indexedApiDeploymentReceipt([{stage:'api_replace',status:'running'},complete],commit);
 assert.deepEqual(receipt,{commit,installedCommit:commit,imageId:complete.installedImageId,sourceFilesVerified:true,workersUnchanged:true,posnetChanged:false});
 assert.equal(indexedApiDeploymentReceipt([complete],'c'.repeat(40)),undefined);
 assert.equal(indexedApiDeploymentReceipt([{...complete,workersUnchanged:false}],commit),undefined);
 const next='c'.repeat(40);
 assert.equal(alignApiDeploymentReceipt(receipt,next,['apps/api/src/app.ts']),undefined);
 assert.deepEqual(alignApiDeploymentReceipt(receipt,next,[]),{...receipt,commit:next,sourceCompatibilityVerified:true});
 assert.equal(alignApiDeploymentReceipt({...receipt,sourceFilesVerified:false},next,[]),undefined);
});

test('persistence repair obtains exact image from successful protected progress and never guesses',()=>{
 const image='adl-worker-partitioned:'+'a'.repeat(24),ledger={steps:{throughput_upgrade:{status:'ok',result:{image}}}};
 assert.equal(persistenceExpectedImage(ledger,{}),image);assert.throws(()=>persistenceExpectedImage({steps:{}},{}),/EXPECTED_CURRENT/);assert.throws(()=>persistenceExpectedImage(ledger,{ADL_EXPECTED_LIVE_IMAGE:'invalid'}),/EXPECTED_CURRENT/);assert.throws(()=>persistenceExpectedImage(ledger,{ADL_LIVE_OOM_REPAIR:'1'}),/EXPECTED_CURRENT/);
 ledger.steps.throughput_upgrade.status='pending';assert.throws(()=>persistenceExpectedImage(ledger,{}),/EXPECTED_CURRENT/);
});

test('persistence repair reuses the exact prepared image when successful activation progress recorded only reuse',()=>{
 const image='adl-worker-partitioned:'+'b'.repeat(24),ledger={steps:{throughput_image:{status:'ok',result:{image}},throughput_upgrade:{status:'ok',result:{reused:true,workerStarted:true}}}};
 assert.equal(persistenceExpectedImage(ledger,{}),image);ledger.steps.throughput_upgrade.status='pending';assert.throws(()=>persistenceExpectedImage(ledger,{}),/EXPECTED_CURRENT/);
});

 test('startup keeps numeric port reason and safe system error without raw message or path',async()=>{const {startupFailure}=await import('./resumable-adl-cutover.mjs');assert.equal(startupFailure(Error('EXECUTOR_ALREADY_RUNNING_OR_PORT_43761_IN_USE')).reason,'EXECUTOR_ALREADY_RUNNING_OR_PORT_43761_IN_USE');const e=Object.assign(Error('EACCES private password path'),{code:'EACCES',syscall:'open'});assert.deepEqual(startupFailure(e),{reason:'PRIVATE_OPERATION_FAILED',exceptionType:'Error',errorCode:'EACCES',syscall:'open'});});
