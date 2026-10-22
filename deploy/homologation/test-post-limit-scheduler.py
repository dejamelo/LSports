import unittest,datetime
from pathlib import Path
ns={'datetime':datetime}
exec(Path(__file__).with_name('watch-post-limit-recovery.py').read_text().split('def post_limit_main():')[0],ns)
class Attempt(unittest.TestCase):
 def decide(self,c):return ns['post_limit_decision'](c,ns['scheduler_time'](ns['LIMIT_APPLIED_AT']))
 def test_old_error_not_current_failure(self):
  self.assertEqual(self.decide({'fullSnapshot':{'startedAt':'2026-10-22T17:46:17.576Z','lastProgressAt':'2026-10-22T17:49:42.218Z'},'lastSnapshotErrorAt':'2026-10-22T17:49:42.219Z'}),'waiting_for_post_limit_attempt_or_fresh_progress')
 def test_new_failure_has_precedence_over_new_attempt(self):
  self.assertEqual(self.decide({'fullSnapshot':{'startedAt':'2026-10-22T18:00:00Z'},'lastSnapshotErrorAt':'2026-10-22T18:01:00Z'}),'failure_after_limit')
 def test_old_spool_can_advance_after_limit(self):
  self.assertEqual(self.decide({'fullSnapshot':{'startedAt':'2026-10-22T17:46:17Z','lastProgressAt':'2026-10-22T18:00:00Z'}}),'existing_spool_progress_after_limit')
 def test_complete_requires_baseline(self):
  self.assertNotEqual(self.decide({'lastSnapshotAt':'2026-10-22T18:00:00Z'}),'snapshot_completed_after_limit')
  self.assertEqual(self.decide({'lastSnapshotAt':'2026-10-22T18:00:00Z','recoveryProgress':{'regularSnapshotReady':True}}),'snapshot_completed_after_limit')
 def test_new_attempt_not_associated_with_old_failure(self):
  self.assertEqual(self.decide({'fullSnapshot':{'startedAt':'2026-10-22T18:00:00Z'},'lastSnapshotErrorAt':'2026-10-22T17:49:42Z'}),'post_limit_attempt_in_progress')
if __name__=='__main__':unittest.main()
