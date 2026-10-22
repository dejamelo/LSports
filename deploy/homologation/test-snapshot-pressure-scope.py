import datetime,hashlib,json,unittest
from pathlib import Path
HERE=Path(__file__).parent
class PressureScope(unittest.TestCase):
 def test_exact_single_file_diff_and_original_receipt_digest_required(self):
  ns={'__name__':'test'}
  for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):exec((HERE/name).read_text().split("if __name__=='__main__':")[0],ns)
  old={n:'original' for n in ns['PARTITION_FILES']};digest=hashlib.sha256(json.dumps(old,sort_keys=True,separators=(',',':')).encode()).hexdigest();new={**old,'apps/worker/src/full-snapshot.ts':'pressure fix'}
  ns['verify_live_snapshot_pressure_sources'](old,new,digest)
  with self.assertRaisesRegex(RuntimeError,'CURRENT_PRESSURE_PATCH_SCOPE'):ns['verify_live_snapshot_pressure_sources'](old,{**new,'apps/worker/src/durable-ingress.mjs':'changed'},digest)
  with self.assertRaisesRegex(RuntimeError,'CURRENT_PRESSURE_SOURCE_DIGEST'):ns['verify_live_snapshot_pressure_sources'](old,new,'a'*64)
class PressureDecision(unittest.TestCase):
 def test_only_current_completed_download_failure_allows_patch(self):
  ns={'datetime':datetime};exec((HERE/'snapshot-pressure-preflight.py').read_text().split('def pressure_preflight_main():')[0],ns)
  decide=ns['pressure_patch_decision'];old='9d1eeedc680a92ee1ee1a95e95e9a9727c19848e2b8aa648fd68805227ff4a91'
  c={'lastSnapshotErrorAt':'2026-10-22T12:10:33Z','fullSnapshot':{'startedAt':'2026-10-22T12:10:00Z','lastProgressAt':'2026-10-22T12:10:30Z','stage':'validate','bytes':663797723},'lastSnapshotDiagnostic':{'reason':'memory_budget_exceeded','memoryBudgetBytes':335544320}}
  self.assertEqual(decide(c,old,'candidate'),'apply_verified_spool_pressure_patch')
  self.assertEqual(decide(c,'candidate','candidate'),'validate_existing_candidate')
  self.assertEqual(decide(c,'unknown','candidate'),'unknown_installed_source_no_patch')
  c['fullSnapshot']['startedAt']='2026-10-22T12:11:00Z'
  self.assertEqual(decide(c,old,'candidate'),'snapshot_progress_or_unproven_current_failure_no_patch')
  c.update(phase='connected',lastSnapshotAt='2026-10-22T12:12:00Z',recoveryProgress={'regularSnapshotReady':True})
  self.assertEqual(decide(c,old,'candidate'),'validate_existing_recovery')
if __name__=='__main__':unittest.main()
