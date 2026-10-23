import json,runpy,tempfile,unittest
from pathlib import Path
ns=runpy.run_path(str(Path(__file__).with_name('observe-durable-cycles.py')))
class Cycles(unittest.TestCase):
 def test_eta_withheld_for_single_short_retirement_window(self):
  p=[dict(pendingOldRows=779171,pendingRows=779171,insertId=100,elapsedSeconds=0),dict(pendingOldRows=750499,pendingRows=757961,insertId=7562,elapsedSeconds=90.26)]
  r=ns['drain_summary'](p,90.26,p[1:]);self.assertEqual(r['oldCohortDurablyRetiredRows'],28672);self.assertEqual(r['netPendingDecrease'],21210);self.assertFalse(r['sustainedNetDrainVerified']);self.assertIsNone(r['etaSeconds'])
 def test_three_complete_positive_checkpoint_intervals_allow_conditional_eta(self):
  points=[dict(pendingOldRows=10000-i*1000,pendingRows=10000-i*800,insertId=100+i*200,elapsedSeconds=i*100) for i in range(5)]
  r=ns['drain_summary'](points,400,points[1:]);self.assertTrue(r['sustainedNetDrainVerified']);self.assertEqual(r['netDrainPerSecond'],8);self.assertEqual(r['etaSeconds'],850)
 def test_growth_in_one_checkpoint_interval_withholds_eta(self):
  points=[dict(pendingOldRows=10000-i*1000,pendingRows=v,insertId=100+i*200,elapsedSeconds=i*100) for i,v in enumerate([10000,9200,9400,8000])]
  r=ns['drain_summary'](points,300,points);self.assertFalse(r['sustainedNetDrainVerified']);self.assertIsNone(r['etaSeconds'])
 def test_retirement_gap_requires_new_completed_publications_not_old_cycles(self):
  self.assertFalse(ns['retirement_gap'](800,0,10,8));self.assertTrue(ns['retirement_gap'](800,0,11,8));self.assertFalse(ns['retirement_gap'](800,700,20,17))
 def test_prefix_reads_connections_without_parsing_events(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'feed';p.write_text('{"mode":"connected","connections":{"prematch":{"phase":"recovering"}},"events":INVALID_NOT_PARSED')
   self.assertEqual(ns['metadata'](p)['prematch']['phase'],'recovering')
 def test_market_activity_comes_from_coverage_not_connection_prefix(self):
  c={'session':{'startedAt':'2026-10-23T18:39:11Z'}};activity={'lastMarketDecodedAt':'2026-10-23T17:42:31Z','lastMarketReceivedAt':'2026-10-22T18:17:10Z'}
  result=ns['safe_connection'](c,activity);self.assertEqual(result['updates']['lastMarketReceivedAt'],activity['lastMarketReceivedAt']);self.assertFalse(result['marketReceiveAndDecodeCurrentSession']);self.assertEqual(result['updateEvidenceSource'],'feed.coverage')
 def test_snapshot_of_prior_session_does_not_verify_current_snapshot(self):
  c={'phase':'recovering','session':{'id':'current','startedAt':'2026-10-23T17:00:00Z'},'lastSnapshotAt':'2026-10-23T16:00:00Z','recoveryProgress':{'regularSnapshotReady':True}}
  self.assertFalse(ns['safe_connection'](c)['snapshotCurrentSession'])
if __name__=='__main__':unittest.main()
