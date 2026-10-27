import runpy,unittest
from pathlib import Path
NS=runpy.run_path(str(Path(__file__).with_name('test-upgrade-partitioned-worker.py')))['NS']
class RehearsalDiskBudget(unittest.TestCase):
 def test_measured_pipeline_uses_phased_checkpoint_baseline_and_keeps_margins(self):
  progress={'pipelineRepair':True,'pipelineLoadVerified':True,'snapshotMemoryRepair':True,'livePersistenceRepair':True}
  output,margin,basis=NS['offline_rehearsal_disk_reserve'](6_448_971_978,0,2_890_197_659,2_693_728_974,progress)
  self.assertEqual(output,2*(2_890_197_659+2_693_728_974))
  self.assertEqual(margin,2*1024**3)
  self.assertIn('inputs are unlinked',basis)
  self.assertEqual(NS['offline_rehearsal_disk_reserve'](6_448_971_978,7_000_000_000,2_890_197_659,2_693_728_974,progress)[0],14_000_000_000)
 def test_unproven_pipeline_keeps_conservative_input_reserve(self):
  progress={'pipelineRepair':True,'pipelineLoadVerified':False,'snapshotMemoryRepair':True,'livePersistenceRepair':True}
  output,margin,basis=NS['offline_rehearsal_disk_reserve'](100,0,2_000,1_000,progress)
  self.assertEqual(output,800)
  self.assertEqual(margin,0)
  self.assertIn('not measured',basis)
 def test_v8_heap_repair_keeps_measured_budget_gate(self):
  progress={'v8HeapOomRepair':True}
  output,margin,_=NS['offline_rehearsal_disk_reserve'](9_000,0,2_000,1_000,progress)
  self.assertEqual((output,margin),(6_000,2*1024**3))
if __name__=='__main__':unittest.main()
