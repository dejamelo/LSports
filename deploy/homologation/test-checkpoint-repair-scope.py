import runpy,unittest
from pathlib import Path
NS=runpy.run_path(str(Path(__file__).with_name('test-upgrade-partitioned-worker.py')))['NS']
class CheckpointRepairScope(unittest.TestCase):
 def test_lazy_risk_consumer_is_an_explicit_dependency_of_checkpoint_repair(self):
  old={name:'old' for name in NS['PARTITION_FILES']}
  changed={**old,'packages/feed-store/src/operation-risk.ts':'skip empty risk feed','packages/feed-store/src/tenant-tickets.ts':'share bounded settlement indexes'}
  self.assertEqual(NS['verify_checkpoint_repair_sources'](old,changed),{'packages/feed-store/src/operation-risk.ts','packages/feed-store/src/tenant-tickets.ts'})
  self.assertEqual(NS['verify_checkpoint_repair_sources'](old,{**changed,'apps/worker/src/connected.ts':'checkpoint deferral'}),{'packages/feed-store/src/operation-risk.ts','packages/feed-store/src/tenant-tickets.ts','apps/worker/src/connected.ts'})
 def test_unrelated_source_changes_remain_rejected(self):
  old={name:'old' for name in NS['PARTITION_FILES']}
  with self.assertRaises(RuntimeError):NS['verify_checkpoint_repair_sources'](old,{**old,'packages/feed-store/src/index.ts':'format change','packages/contracts/src/index.ts':'contract change'})
if __name__=='__main__':unittest.main()
