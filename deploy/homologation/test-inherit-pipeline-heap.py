import json,runpy,tempfile,unittest
from pathlib import Path
NS=runpy.run_path(str(Path(__file__).with_name('test-resume-prepared-worker.py')))['namespace']()
class InheritedHeap(unittest.TestCase):
 def test_existing_default_unchanged(self):self.assertIsNone(NS['existing_pipeline_heap_plan']({'environment':{'NODE_OPTIONS':'--max-old-space-size=2560'}}))
 def test_plan_copied_only_from_protected_verified_image_receipt(self):
  oldSecure,oldRun=NS['SECURE'],NS['run']
  try:
   with tempfile.TemporaryDirectory() as tmp:
    NS['SECURE']=Path(tmp);digest='a'*64;image='adl-worker-partitioned:'+digest[:24]
    worker={'image':image,'environment':{'NODE_OPTIONS':'--max-old-space-size=3584'},'mem_limit':6442450944}
    plan={'evidenceVerified':True,'oldSpaceMiB':3584,'previousOldSpaceMiB':2560,'containerLimitUnchanged':True}
    r={'image':image,'digest':digest,'memoryLimitBytes':6442450944,'pipelineRepair':True,'oomRestoreVerified':True,'heapBudgetPlan':plan}
    path=Path(tmp)/('partitioned-upgrade-'+digest[:24]+'.json');path.write_text(json.dumps(r));path.chmod(0o600)
    NS['run']=lambda args:json.dumps([{'Config':{'Labels':{'eu.adl.partitioned.patch':digest}}}]).encode()
    found=NS['existing_pipeline_heap_plan'](worker);self.assertEqual(found,plan);self.assertIsNot(found,plan)
    for change in ({'oomRestoreVerified':False},{'heapBudgetPlan':{}},{'image':'adl-worker-partitioned:'+'b'*24}):
     path.write_text(json.dumps({**r,**change}));path.chmod(0o600)
     with self.assertRaises(RuntimeError):NS['existing_pipeline_heap_plan'](worker)
  finally:NS['SECURE']=oldSecure;NS['run']=oldRun
 def test_no_unrecorded_arbitrary_heap(self):
  with self.assertRaises(RuntimeError):NS['existing_pipeline_heap_plan']({'environment':{'NODE_OPTIONS':'--max-old-space-size=4096'},'mem_limit':6442450944})
if __name__=='__main__':unittest.main()
