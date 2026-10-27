import unittest,hashlib,json,runpy,tempfile,fcntl,re,ast,subprocess
from pathlib import Path
test_dir=Path(__file__).parent
ns=runpy.run_path(str(test_dir/'test-upgrade-partitioned-worker.py'))['NS']
class Scope(unittest.TestCase):
 def test_rollout_manifest_matches_verified_image_dependencies(self):
  source=(test_dir/'resumable-adl-cutover.mjs').read_text()
  worker=re.search(r"partitionWorkerSourceNames=Object\.freeze\((\[[^\]]+\])\)",source)
  packages=re.search(r"partitionPackageSourceNames=Object\.freeze\((\[[^\]]+\])\)",source)
  self.assertIsNotNone(worker);self.assertIsNotNone(packages)
  worker_names=ast.literal_eval(worker.group(1));package_names=ast.literal_eval(packages.group(1))
  rollout={f'apps/worker/src/{name}' for name in worker_names}|set(package_names)
  self.assertEqual(rollout,ns['PARTITION_FILES'])
  self.assertEqual(source.count('partitionWorkerSourceNames.map('),2)
  self.assertEqual(source.count('names.push(...partitionPackageSourceNames)'),2)
 def test_added_dependency_pin_matches_reviewed_installed_source_commit(self):
  name='apps/worker/src/snapshot-capacity.ts'
  source=subprocess.check_output(['git','show','e83f16b:'+name],cwd=test_dir.parents[1])
  self.assertEqual(hashlib.sha256(source).hexdigest(),ns['PIPELINE_ADDED_DEPENDENCY_SHA256'][name])
 def test_existing_four_gib_scope_is_unchanged(self):
  self.assertEqual(ns['partition_memory']({}),4294967296)
  command=['docker','run','--rm','--memory','4g','image'];self.assertEqual(ns['partition_rehearsal_args'](command[:],{}),command)
 def test_six_gib_requires_explicit_protected_scope(self):
  with self.assertRaises(RuntimeError):ns['partition_memory']({'memoryLimitBytes':6442450944})
  p={'memoryLimitBytes':6442450944,'pipelineRepair':True};self.assertEqual(ns['partition_memory'](p),6442450944)
  pressure={'memoryLimitBytes':6442450944,'snapshotMemoryRepair':True,'snapshotPressureRepair':True,'livePersistenceRepair':True}
  self.assertEqual(ns['partition_memory'](pressure),6442450944)
  for missing in ({'livePersistenceRepair':False},{'snapshotPressureRepair':False},{'snapshotMemoryRepair':False}):
   with self.assertRaises(RuntimeError):ns['partition_memory']({**pressure,**missing})
  args=ns['partition_rehearsal_args'](['docker','run','--rm','--memory','4g','--entrypoint','node','image'],p)
  self.assertEqual(args[args.index('--memory')+1],'6g');self.assertEqual(args[args.index('--memory-swap')+1],'6g');self.assertIn('eu.adl.recovery.cache-policy=bounded-reclaim-verified',args)
 def test_unrelated_source_changes_and_wrong_digest_are_rejected(self):
  old={p:'old' for p in ns['PIPELINE_BASE_FILES']}
  dep='apps/worker/src/snapshot-capacity.ts';added={dep:'installed-dependency'};base_hash=hashlib.sha256(added[dep].encode()).hexdigest();pinned=ns['PIPELINE_ADDED_DEPENDENCY_SHA256'][dep];ns['PIPELINE_ADDED_DEPENDENCY_SHA256'][dep]=base_hash
  try:
   digest=hashlib.sha256(json.dumps({**old,**added},sort_keys=True,separators=(',',':')).encode()).hexdigest()
   candidate={**old,**added,'apps/worker/src/connected.ts':'batch-fairness','apps/worker/src/durable-ingress.mjs':'covering-index','apps/worker/src/full-snapshot.ts':'bounded-batch','apps/worker/src/provider.ts':'batch-plumbing','apps/worker/src/diagnostics.ts':'heap-and-container-admission',dep:'two-source-memory-budget'}
   self.assertEqual(set(candidate),ns['PARTITION_FILES']);ns['verify_pipeline_sources'](old,candidate,digest,added)
   for changed,sha,source in ((old,digest,added),({**candidate,'apps/worker/src/persistence.ts':'unrelated'},digest,added),({**candidate,'apps/worker/src/messages.ts':'unrelated'},digest,added),(candidate,'f'*64,added),(candidate,digest,{dep:'unverified-dependency'})):
    with self.assertRaises(RuntimeError):ns['verify_pipeline_sources'](old,changed,sha,source)
  finally:ns['PIPELINE_ADDED_DEPENDENCY_SHA256'][dep]=pinned
class RetentionOrigin(unittest.TestCase):
 def test_only_completed_six_gib_preparation_can_be_derived(self):
  old={'phase':'stopped','pipelineRepair':True,'memoryLimitBytes':6442450944,'oldContainer':'a'*64,'verifiedExitContainerId':'a'*64,'preExitProof':{'verified':True}}
  ns['verify_stopped_retention_origin'](old)
  for changed in ({'phase':'stop_requested'},{'pipelineRepair':False},{'memoryLimitBytes':4294967296},{'preExitProof':{'verified':False}},{'verifiedExitContainerId':'b'*64}):
   with self.assertRaises(RuntimeError):ns['verify_stopped_retention_origin']({**old,**changed})
 def test_clean_graceful_exit_requires_final_persist_and_preserved_data_integrity(self):
  old={'phase':'stopped','pipelineRepair':True,'memoryLimitBytes':6442450944,'oldContainer':'a'*64,'supplierStoppedBeforeConsumer':True,'shutdownObservation':{'samples':[{'running':False,'exitCode':0,'oomKilled':False,'signalsSent':0,'lastCompletedPersistence':{'operation':'file.persist'}}]},'dataBackupHashes':{str(i):'b'*64 for i in range(6)},'inboxIntegrity':[{'lane':'prematch','integrity':'ok'},{'lane':'inplay','integrity':'ok'}]}
  ns['verify_stopped_retention_origin'](old)
  for change in ({'supplierStoppedBeforeConsumer':False},{'shutdownObservation':{'samples':[{'running':False,'exitCode':137,'oomKilled':True,'signalsSent':1,'lastCompletedPersistence':{'operation':'file.persist'}}]}},{'dataBackupHashes':{}},{'inboxIntegrity':[{'lane':'prematch','integrity':'ok'}]}):
   with self.assertRaises(RuntimeError):ns['verify_stopped_retention_origin']({**old,**change})
class StopResumeBudget(unittest.TestCase):
 def test_only_actual_previous_progress_gets_bounded_completion_window(self):
  self.assertEqual(ns['resumed_stop_budget']({}),180)
  self.assertEqual(ns['resumed_stop_budget']({'pipelineRepair':True,'memoryLimitBytes':6442450944}),600)
  self.assertEqual(ns['resumed_stop_budget']({'shutdownObservation':{'samples':[{'progressSincePreviousSample':False}]}}),180)
  self.assertEqual(ns['resumed_stop_budget']({'shutdownObservation':{'samples':[{'progressSincePreviousSample':True}]}}),600)
class OperationLock(unittest.TestCase):
 def test_remote_interrupted_client_cannot_duplicate_operation(self):
  with tempfile.TemporaryDirectory() as tmp:
   isolated={**ns,'SECURE':Path(tmp)};calls=[];records=[]
   exec((Path(__file__).with_name('upgrade-partitioned-worker.py')).read_text().split('def upgrade_partitioned(request):',1)[1].join(['def upgrade_partitioned(request):','']),isolated)
   isolated['upgrade_partitioned_unlocked']=lambda request:calls.append(request) or 0
   isolated['emit']=lambda **row:records.append(row)
   path=Path(tmp)/'partitioned-upgrade.operation.lock'
   with path.open('w') as held:
    fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
    self.assertEqual(isolated['upgrade_partitioned']({}),2);self.assertEqual(calls,[])
    self.assertEqual(records[-1]['reason'],'REMOTE_UPGRADE_ALREADY_RUNNING_NO_DUPLICATE')
   self.assertEqual(isolated['upgrade_partitioned']({'resume':True}),0);self.assertEqual(len(calls),1)
if __name__=='__main__':unittest.main()
