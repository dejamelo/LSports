import unittest,datetime,tempfile,re
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
class ProcessEvidence(unittest.TestCase):
 def test_tree_has_cpu_and_identity_without_process_arguments(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);p=root/'123';p.mkdir();fields=['S']+['0']*25;fields[11]='21';fields[12]='7';fields[19]='999'
   (p/'stat').write_text('123 (node) '+' '.join(fields));(p/'wchan').write_text('ep_poll')
   def mapped(value):return root/str(value).removeprefix('/proc/')
   def require(ok,reason):
    if not ok:raise RuntimeError(reason)
   local=dict(ns,Path=mapped,re=re,require=require,run=lambda args:b'PID PPID STAT COMMAND\n123 1 Sl node\n')
   exec(Path(__file__).with_name('watch-post-limit-recovery.py').read_text().split('def post_limit_main():')[0],local)
   rows=local['apply_pending_processes']('verified-container')
   self.assertEqual(rows[0]['cpuUserTicks'],21);self.assertEqual(rows[0]['cpuSystemTicks'],7);self.assertEqual(rows[0]['startTicks'],999);self.assertEqual(rows[0]['waitChannel'],'ep_poll');self.assertNotIn('arguments',rows[0])

if __name__=='__main__':unittest.main()
