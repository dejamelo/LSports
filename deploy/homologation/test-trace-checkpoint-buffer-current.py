import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('trace',Path(__file__).with_name('trace-checkpoint-buffer-current.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Evidence(unittest.TestCase):
 def test_exact_io_and_capacity_preserved_no_payload(self):
  at='2026-10-24T12:00:00Z'
  rows=m.extract(at+' '+json.dumps({'operation':'file.persist','publicationId':4,'checkpointIo':{'writeCalls':10,'writeAwaitMs':30,'payload':'secret'},'payload':'secret'})+'\n'+at+' '+json.dumps({'operation':'inbox.intake_capacity','lane':'prematch','stage':'paused','bytes':2147480883}))
  self.assertEqual(rows[0]['checkpointIo'],{'writeCalls':10,'writeAwaitMs':30});self.assertNotIn('payload',str(rows));self.assertEqual(rows[1]['stage'],'paused')
 def test_shared_completion_does_not_confirm_lane(self):
  rows=[{'operation':'inbox.checkpoint','lane':'prematch','status':'waiting_persistence','sessionId':'s','ingressActorId':'a','batchId':'b','rows':4096,'loggedAtUTC':'t'},{'operation':'file.persist','status':'ok','publicationId':4}]
  result=m.correlate(rows);self.assertEqual(len(result['waitingCheckpoints']),1);self.assertEqual(result['completedCheckpoints'],[])
if __name__=='__main__':unittest.main()
