import unittest,hashlib,json,runpy,tempfile,fcntl
from pathlib import Path
ns=runpy.run_path(str(Path(__file__).with_name('test-upgrade-partitioned-worker.py')))['NS']
class Scope(unittest.TestCase):
 def test_existing_four_gib_scope_is_unchanged(self):
  self.assertEqual(ns['partition_memory']({}),4294967296)
  command=['docker','run','--rm','--memory','4g','image'];self.assertEqual(ns['partition_rehearsal_args'](command[:],{}),command)
 def test_six_gib_requires_explicit_protected_scope(self):
  with self.assertRaises(RuntimeError):ns['partition_memory']({'memoryLimitBytes':6442450944})
  p={'memoryLimitBytes':6442450944,'pipelineRepair':True};self.assertEqual(ns['partition_memory'](p),6442450944)
  args=ns['partition_rehearsal_args'](['docker','run','--rm','--memory','4g','--entrypoint','node','image'],p)
  self.assertEqual(args[args.index('--memory')+1],'6g');self.assertEqual(args[args.index('--memory-swap')+1],'6g');self.assertIn('eu.adl.recovery.cache-policy=six-gib-verified',args)
 def test_unrelated_source_changes_and_wrong_digest_are_rejected(self):
  old={p:'old' for p in ns['PARTITION_FILES']};digest=hashlib.sha256(json.dumps(old,sort_keys=True,separators=(',',':')).encode()).hexdigest()
  candidate={**old,'apps/worker/src/connected.ts':'batch-fairness','apps/worker/src/durable-ingress.mjs':'covering-index','apps/worker/src/full-snapshot.ts':'bounded-batch','apps/worker/src/provider.ts':'batch-plumbing'}
  ns['verify_pipeline_sources'](old,candidate,digest)
  for changed,sha in ((old,digest),({**candidate,'apps/worker/src/messages.ts':'unrelated'},digest),(candidate,'f'*64)):
   with self.assertRaises(RuntimeError):ns['verify_pipeline_sources'](old,changed,sha)
class StopResumeBudget(unittest.TestCase):
 def test_only_actual_previous_progress_gets_bounded_completion_window(self):
  self.assertEqual(ns['resumed_stop_budget']({}),180)
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
