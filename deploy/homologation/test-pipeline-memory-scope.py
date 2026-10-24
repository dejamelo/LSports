import unittest,hashlib,json,runpy,tempfile,fcntl,re,ast
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
  self.assertEqual(args[args.index('--memory')+1],'6g');self.assertEqual(args[args.index('--memory-swap')+1],'6g');self.assertIn('eu.adl.recovery.cache-policy=six-gib-verified',args)
 def test_unrelated_source_changes_and_wrong_digest_are_rejected(self):
  old={p:'old' for p in ns['PARTITION_FILES']};digest=hashlib.sha256(json.dumps(old,sort_keys=True,separators=(',',':')).encode()).hexdigest()
  candidate={**old,'apps/worker/src/connected.ts':'batch-fairness','apps/worker/src/durable-ingress.mjs':'covering-index','apps/worker/src/full-snapshot.ts':'bounded-batch','apps/worker/src/provider.ts':'batch-plumbing','apps/worker/src/diagnostics.ts':'heap-and-container-admission','apps/worker/src/snapshot-capacity.ts':'two-source-memory-budget'}
  ns['verify_pipeline_sources'](old,candidate,digest)
  for changed,sha in ((old,digest),({**candidate,'apps/worker/src/persistence.ts':'unrelated'},digest),({**candidate,'apps/worker/src/messages.ts':'unrelated'},digest),(candidate,'f'*64)):
   with self.assertRaises(RuntimeError):ns['verify_pipeline_sources'](old,changed,sha)
class RetentionOrigin(unittest.TestCase):
 def test_only_completed_six_gib_preparation_can_be_derived(self):
  old={'phase':'stopped','pipelineRepair':True,'memoryLimitBytes':6442450944,'oldContainer':'a'*64,'verifiedExitContainerId':'a'*64,'preExitProof':{'verified':True}}
  ns['verify_stopped_retention_origin'](old)
  for changed in ({'phase':'stop_requested'},{'pipelineRepair':False},{'memoryLimitBytes':4294967296},{'preExitProof':{'verified':False}},{'verifiedExitContainerId':'b'*64}):
   with self.assertRaises(RuntimeError):ns['verify_stopped_retention_origin']({**old,**changed})
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
