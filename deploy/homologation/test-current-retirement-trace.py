import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('trace',Path(__file__).with_name('trace-current-retirement.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Trace(unittest.TestCase):
 def test_shared_publication_does_not_complete_lane_checkpoint(self):
  rows=[{'operation':'inbox.checkpoint','lane':'prematch','sessionId':'s','ingressActorId':'a','status':'waiting_persistence','rows':4096,'loggedAtUTC':'2026-10-23T22:00:00Z'},{'operation':'file.persist','lastCompletedAt':'2026-10-23T22:01:00Z','loggedAtUTC':'2026-10-23T22:01:00Z'}]
  result=m.correlate(rows);self.assertEqual(len(result['waitingCheckpoints']),1);self.assertEqual(result['completedCheckpoints'],[])
 def test_other_actor_or_count_cannot_confirm_batch(self):
  rows=[{'operation':'inbox.checkpoint','lane':'prematch','sessionId':'s','ingressActorId':'a','status':'waiting_persistence','rows':4096,'loggedAtUTC':'a'},{'operation':'inbox.checkpoint','lane':'prematch','sessionId':'s2','ingressActorId':'b','status':'persisted','rows':4096,'loggedAtUTC':'b'}]
  self.assertEqual(len(m.correlate(rows)['waitingCheckpoints']),1)
  rows[-1].update(sessionId='s',ingressActorId='a',rows=1)
  self.assertEqual(m.correlate(rows)['completedCheckpoints'],[])
 def test_only_serial_matched_prefix_completes(self):
  rows=[{'operation':'inbox.checkpoint','lane':'prematch','sessionId':'s','status':'waiting_persistence','rows':4096,'loggedAtUTC':'a'},{'operation':'inbox.checkpoint','lane':'prematch','sessionId':'s','ingressActorId':'a','status':'persisted','rows':4096,'loggedAtUTC':'b','waitedMs':75000}]
  result=m.correlate(rows);self.assertEqual(result['waitingCheckpoints'],[]);self.assertEqual(result['completedCheckpoints'][0]['waitedMs'],75000)
 def test_redacts_payloads_and_keeps_exact_wait_stage(self):
  raw='2026-10-23T22:10:00Z '+json.dumps({'operation':'file.persist','status':'waiting','publicationStage':'regular_checkpoint.fsync','publicationElapsedMs':10000,'password':'SECRET','message':'SECRET','content':{'private':1}})
  rows=m.extract(raw);self.assertEqual(rows[0]['publicationStage'],'regular_checkpoint.fsync');self.assertNotIn('SECRET',json.dumps(rows));self.assertNotIn('content',rows[0])
 def test_reserved_prefix_links_expanded_batch_to_publication(self):
  common={'operation':'inbox.checkpoint','lane':'prematch','sessionId':'s','ingressActorId':'a','batchId':'batch'}
  rows=[{**common,'status':'waiting_persistence','rows':100,'loggedAtUTC':'a'},{**common,'status':'reserved_before_capture','rows':8192,'publicationId':24,'loggedAtUTC':'b'},{**common,'status':'persisted','rows':8192,'publicationId':24,'loggedAtUTC':'c'}]
  result=m.correlate(rows);self.assertEqual(result['waitingCheckpoints'],[]);self.assertEqual(result['completedCheckpoints'][0]['publicationId'],24);self.assertEqual(result['completedCheckpoints'][0]['rows'],8192)
 def test_another_batch_cannot_complete_same_actor_slot(self):
  common={'operation':'inbox.checkpoint','lane':'prematch','sessionId':'s','ingressActorId':'a','rows':8192}
  result=m.correlate([{**common,'status':'waiting_persistence','batchId':'first','loggedAtUTC':'a'},{**common,'status':'persisted','batchId':'different','loggedAtUTC':'b'}]);self.assertEqual(result['completedCheckpoints'],[])
if __name__=='__main__':unittest.main()
