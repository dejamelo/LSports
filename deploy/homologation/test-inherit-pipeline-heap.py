import json,runpy,tempfile,unittest
from pathlib import Path
NS=runpy.run_path(str(Path(__file__).with_name('test-resume-prepared-worker.py')))['namespace']()
class InheritedHeap(unittest.TestCase):
 def test_existing_default_unchanged(self):self.assertIsNone(NS['existing_pipeline_heap_plan']({'environment':{'NODE_OPTIONS':'--max-old-space-size=2560'}}))
 def test_measured_3840_heap_is_preserved_exactly_without_expanding_cgroup_or_heap(self):
  oldSecure,oldRun=NS['SECURE'],NS['run']
  try:
   with tempfile.TemporaryDirectory() as tmp:
    NS['SECURE']=Path(tmp);digest='c'*64;image='adl-worker-partitioned:'+digest[:24]
    worker={'image':image,'environment':{'NODE_OPTIONS':'--max-old-space-size=3840'},'mem_limit':6442450944}
    receipt={'image':image,'digest':digest,'memoryLimitBytes':6442450944,'oomRestoreVerified':True}
    path=Path(tmp)/('partitioned-upgrade-'+digest[:24]+'.json');path.write_text(json.dumps(receipt));path.chmod(0o600)
    def run(args):
     if args[:3]==['docker','image','inspect']:return json.dumps([{'Config':{'Labels':{'eu.adl.partitioned.patch':digest}}}]).encode()
     if args[:3]==['docker','run','--rm']:
      self.assertIn('--memory',args);self.assertIn('6g',args);self.assertIn('NODE_OPTIONS=--max-old-space-size=3840',args)
      return json.dumps({'heapLimitBytes':4227858432}).encode()
     raise AssertionError(args)
    NS['run']=run;plan=NS['existing_pipeline_heap_plan'](worker)
    self.assertEqual(plan['oldSpaceMiB'],3840);self.assertEqual(plan['previousOldSpaceMiB'],3840);self.assertTrue(plan['preserveExisting']);self.assertTrue(plan['containerLimitUnchanged']);self.assertEqual(NS['partition_heap_mib']({'memoryLimitBytes':6442450944,'pipelineRepair':True,'heapBudgetPlan':plan}),3840)
    for changed in ({**plan,'oldSpaceMiB':3584},{**plan,'effectiveHeapLimitBytes':6442450944},{**plan,'containerLimitUnchanged':False}):
     with self.assertRaises(RuntimeError):NS['partition_heap_mib']({'memoryLimitBytes':6442450944,'pipelineRepair':True,'heapBudgetPlan':changed})
  finally:NS['SECURE']=oldSecure;NS['run']=oldRun
 def test_verified_existing_eight_gib_profile_preserves_4608_heap(self):
  oldSecure,oldRun=NS['SECURE'],NS['run']
  try:
   with tempfile.TemporaryDirectory() as tmp:
    NS['SECURE']=Path(tmp);digest='d'*64;image='adl-worker-partitioned:'+digest[:24]
    worker={'image':image,'environment':{'NODE_OPTIONS':'--max-old-space-size=4608'},'mem_limit':8589934592}
    receipt={'image':image,'digest':digest,'memoryLimitBytes':8589934592,'oomRestoreVerified':True}
    path=Path(tmp)/('partitioned-upgrade-'+digest[:24]+'.json');path.write_text(json.dumps(receipt));path.chmod(0o600)
    def run(args):
     if args[:3]==['docker','image','inspect']:return json.dumps([{'Config':{'Labels':{'eu.adl.partitioned.patch':digest}}}]).encode()
     if args[:3]==['docker','run','--rm']:
      self.assertIn('--memory',args);self.assertIn('8g',args);self.assertIn('NODE_OPTIONS=--max-old-space-size=4608',args)
      return json.dumps({'heapLimitBytes':5*1024**3}).encode()
     raise AssertionError(args)
    NS['run']=run;plan=NS['existing_pipeline_heap_plan'](worker)
    progress={'memoryLimitBytes':8589934592,'pipelineRepair':True,'pipelineMemoryEightGiB':True,'snapshotMemoryRepair':True,'livePersistenceRepair':True,'heapBudgetPlan':plan}
    self.assertTrue(plan['preserveExisting']);self.assertEqual(plan['previousOldSpaceMiB'],4608);self.assertEqual(NS['partition_memory'](progress),8589934592);self.assertEqual(NS['partition_heap_mib'](progress),4608)
    for changed in ({**plan,'oldSpaceMiB':4096},{**plan,'effectiveHeapLimitBytes':8589934592},{**plan,'containerLimitUnchanged':False}):
     with self.assertRaises(RuntimeError):NS['partition_heap_mib']({**progress,'heapBudgetPlan':changed})
  finally:NS['SECURE']=oldSecure;NS['run']=oldRun
 def test_runtime_verification_uses_receipted_heap_and_confirms_both_snapshot_flags(self):
  plan={'evidenceVerified':True,'oldSpaceMiB':3840,'previousOldSpaceMiB':3840,'containerLimitUnchanged':True,'preserveExisting':True,'effectiveHeapLimitBytes':4227858432}
  progress={'memoryLimitBytes':6442450944,'pipelineRepair':True,'heapBudgetPlan':plan}
  image_id='sha256:'+'a'*64;worker_id='b'*64
  env=['NODE_OPTIONS=--max-old-space-size=3840','LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT=true','LSPORTS_INPLAY_STREAMED_SNAPSHOT=true']
  inspected={'Image':image_id,'HostConfig':{'Memory':6442450944},'Config':{'Env':env}}
  old=NS['run'];calls=[]
  try:
   def run(args,**kwargs):calls.append(args);return json.dumps({'cgroupLimitBytes':6442450944,'effectiveHeapLimitProbeBytes':4227858432}).encode()
   NS['run']=run
   result=NS['verify_budgeted_worker_runtime'](progress,worker_id,inspected,image_id)
   self.assertEqual(result['nodeOptions'],'--max-old-space-size=3840');self.assertEqual(result['dockerMemoryLimitBytes'],6442450944);self.assertEqual(len(calls),1);self.assertEqual(calls[0][:4],['docker','exec',worker_id,'node'])
   for key,value in (('NODE_OPTIONS','--max-old-space-size=3584'),('LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT','false'),('LSPORTS_INPLAY_STREAMED_SNAPSHOT','false')):
    wrong={**inspected,'Config':{'Env':[item for item in env if not item.startswith(key+'=')]+[key+'='+value]}}
    with self.assertRaises(RuntimeError):NS['verify_budgeted_worker_runtime'](progress,worker_id,wrong,image_id)
   src=Path(__file__).with_name('upgrade-partitioned-worker.py').read_text()
   self.assertIn('verify_budgeted_worker_runtime(progress,workers[0][\'id\'],current_container,image_id)',src)
   self.assertIn('verify_budgeted_worker_runtime(progress,active[0][\'id\'],inspected,image_id)',src)
  finally:NS['run']=old
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
