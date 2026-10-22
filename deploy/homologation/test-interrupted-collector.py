import unittest
from pathlib import Path
HERE=Path(__file__).parent
class InterruptedAudit(unittest.TestCase):
 def test_diagnostic_processes_distinguished_from_real_worker_and_git(self):
  ns={'__name__':'test'};exec(compile((HERE/'audit-interrupted-collector.py').read_text().split('try:main()',1)[0],'audit-interrupted-collector.py','exec'),ns)
  classify=ns['classify']
  self.assertEqual(classify(['/usr/local/bin/node','-e','pendingCheckpointRows baselineHighId']),'recovery_pressure_sql_probe')
  self.assertEqual(classify(['docker','exec','cid','node','-e','pendingCheckpointRows baselineHighId']),'recovery_pressure_exec_wrapper')
  self.assertEqual(classify(['python3','-c','REMOTE_HELPER_ENVELOPE_REJECTED']),'adl_helper_bootstrap_scope_unverified')
  self.assertIsNone(classify(['node','--import','tsx','/app/apps/worker/src/index.ts']))
  self.assertIsNone(classify(['git','show','apps/worker/src/index.ts']))
  self.assertIsNone(classify(['python3','unrelated.py']))
  self.assertIsNone(classify([]))
if __name__=='__main__':unittest.main()
