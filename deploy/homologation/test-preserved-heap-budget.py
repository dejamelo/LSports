import json,runpy,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
NS=runpy.run_path(str(Path(__file__).with_name('test-resume-prepared-worker.py')))['namespace']()
class Ref:
 def __init__(self,root):self.root=root
 def __str__(self):return '/var/backups/adl-partitioned-upgrade-o4uv0zl9'
 def __truediv__(self,name):return self.root/name
class HeapBudget(unittest.TestCase):
 def exercise(self,change=None,workerChange=None):
  ns=dict(NS)
  # Function globals are the namespace built by the real concatenated executor.
  oldRead=NS['read_tail'];NS['read_tail']=lambda p:p.read_bytes()
  try:
   with tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp);ref=Ref(root)
    row={'operation':'offline.memory_budget','allowed':False,'budgetBytes':335544320,'headroomBytes':332097824,'memory':{'limitingFactor':'heap','heapLimitBytes':2885681152,'heapUsedBytes':2553583328,'availableMemoryBytes':2208849920}}
    if change:change(row)
    p=root/'oom-restore-attempt-c84e458361c7bf49.private.log';p.write_text(json.dumps(row)+'\n');p.chmod(0o600);before=p.read_bytes()
    progress={'backup':str(ref),'image':'adl-worker-partitioned:78f1104c6e9246c233a7f26b','phase':'stopped','pipelineRepair':True,'memoryLimitBytes':6442450944,'oldContainer':'a'*64}
    w={'id':'a'*64,'running':False,'oomKilled':False,'exitCode':0}
    if workerChange:w.update(workerChange)
    plan=NS['preserved_heap_budget_plan'](progress,ref,[w]);self.assertEqual(p.read_bytes(),before)
    self.assertEqual(NS['partition_heap_mib'](progress),2560)
    self.assertEqual(NS['partition_heap_mib']({**progress,'heapBudgetPlan':plan}),3584)
    self.assertEqual(NS['partition_memory']({**progress,'heapBudgetPlan':plan}),6442450944)
    self.assertGreaterEqual(plan['outsideOldSpaceBytes'],2*1024**3)
    self.assertTrue(plan['realDataAcceptanceRequired'])
    return plan
  finally:NS['read_tail']=oldRead
 def test_exact_measured_budget_and_unchanged_cgroup(self):self.exercise()
 def test_other_pressure_or_running_worker_cannot_enable_adjustment(self):
  for change in (lambda r:r['memory'].update(limitingFactor='available_memory'),lambda r:r.update(headroomBytes=1),lambda r:r.update(allowed=True)):
   with self.assertRaises(RuntimeError):self.exercise(change)
  with self.assertRaises(RuntimeError):self.exercise(workerChange={'running':True})
 def test_no_unverified_saved_heap_plan(self):
  with self.assertRaises(RuntimeError):NS['partition_heap_mib']({'memoryLimitBytes':6442450944,'pipelineRepair':True,'heapBudgetPlan':{'oldSpaceMiB':3584}})
 def test_all_new_rehearsals_and_runtime_use_same_budget(self):
  src=Path(__file__).with_name('upgrade-partitioned-worker.py').read_text()
  self.assertIn("rehearsal_command+['--max-old-space-size='+str(partition_heap_mib(progress))",src)
  self.assertIn("readback_command+['--max-old-space-size='+str(partition_heap_mib(progress))",src)
  self.assertIn("expected['services']['worker']['environment']['NODE_OPTIONS']='--max-old-space-size='+str(partition_heap_mib(progress))",src)
  self.assertIn("env.get('NODE_OPTIONS')=='--max-old-space-size='+str(partition_heap_mib(progress))",src)
if __name__=='__main__':unittest.main()
