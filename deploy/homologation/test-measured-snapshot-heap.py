import json,runpy,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent
NS=runpy.run_path(str(HERE/'test-resume-prepared-worker.py'))['namespace']()

class MeasuredSnapshotHeap(unittest.TestCase):
 def exercise(self,mutate=None):
   tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
   backup=Path(tmp.name)/'adl-partitioned-upgrade-w52a6rhf';backup.mkdir(mode=0o700)
   old_plan={'evidenceVerified':True,'preserveExisting':True,'oldSpaceMiB':3840,'previousOldSpaceMiB':3840,'effectiveHeapLimitBytes':4227858432,'containerLimitUnchanged':True}
   progress={'phase':'stopped','backup':str(backup),'memoryLimitBytes':6442450944,'pipelineRepair':True,'snapshotMemoryRepair':True,'livePersistenceRepair':True,'oldContainer':'a'*64,'heapBudgetPlan':old_plan}
   failure={'operation':'offline.memory_budget','stage':'snapshot.apply','allowed':False,'budgetBytes':335544320,'headroomBytes':333903952,'memory':{'limitingFactor':'heap','heapLimitBytes':4227858432,'heapUsedBytes':3893954480,'availableMemoryBytes':2005966848}}
   sample={'operation':'offline.memory','stage':'snapshot.apply','rows':12000,'heapUsedBytes':3783261008,'indexCounts':{'stateRows':42735,'markets':849488,'bets':5760237}}
   if mutate:mutate(failure,sample)
   log=backup/'oom-restore-attempt-1fa719d6f08dd27f.private.log';log.write_text('\n'.join(json.dumps(x) for x in (sample,failure))+'\n');log.chmod(0o600)
   pointer=backup/'oom-restore.latest.json';pointer.write_text(json.dumps({'name':log.name}));pointer.chmod(0o600)
   workers=[{'id':'a'*64,'running':False,'oomKilled':False,'exitCode':0}]
   return backup,progress,workers

 def test_only_the_measured_heap_limited_failure_can_raise_the_node_heap(self):
  backup,progress,workers=self.exercise();plan=NS['measured_snapshot_apply_heap_plan'](progress,backup,workers)
  self.assertEqual(plan['previousOldSpaceMiB'],3840);self.assertEqual(plan['oldSpaceMiB'],4096)
  self.assertEqual(plan['containerLimitBytes'],6442450944);self.assertEqual(plan['outsideOldSpaceBytes'],2147483648)
  self.assertEqual(plan['guardBudgetBytes'],335544320);self.assertEqual(plan['applyRowsAtFailure'],12000)
  self.assertEqual(NS['partition_heap_mib']({**progress,'heapBudgetPlan':plan}),4096)
  for bad in ({**plan,'oldSpaceMiB':4352},{**plan,'outsideOldSpaceBytes':0},{**plan,'guardBudgetBytes':0},{**plan,'sourceTailSha256':'invalid'}):
   with self.assertRaises(RuntimeError):NS['partition_heap_mib']({**progress,'heapBudgetPlan':bad})

 def test_does_not_accept_physical_memory_or_non_snapshot_failure_as_evidence(self):
  for mutate in (lambda f,s:f.update(headroomBytes=335544320),lambda f,s:f['memory'].update(limitingFactor='available_memory'),lambda f,s:f.update(stage='projection.serialize'),lambda f,s:s['indexCounts'].update(bets=100)):
   backup,progress,workers=self.exercise(mutate)
   with self.assertRaises(RuntimeError):NS['measured_snapshot_apply_heap_plan'](progress,backup,workers)

 def test_rejects_running_or_unclean_worker_and_modified_guard(self):
  backup,progress,workers=self.exercise();
  with self.assertRaises(RuntimeError):NS['measured_snapshot_apply_heap_plan'](progress,backup,[{**workers[0],'running':True}])
  with self.assertRaises(RuntimeError):NS['measured_snapshot_apply_heap_plan']({**progress,'memoryLimitBytes':4294967296},backup,workers)

if __name__=='__main__':unittest.main()
