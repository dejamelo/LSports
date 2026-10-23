import datetime,runpy,unittest
from pathlib import Path
ns=runpy.run_path(str(Path(__file__).with_name('trace-retirement-publication.py')))
class Trace(unittest.TestCase):
 def test_completed_publication_and_actor_freshness_kept_separate(self):
  import json
  t=datetime.datetime(2026,10,23,12,tzinfo=datetime.timezone.utc)
  lines=['2026-10-23T11:59:00Z '+json.dumps({'operation':'inbox.checkpoint','lane':'prematch','status':'persisted','rows':999}), '2026-10-23T12:00:01Z '+json.dumps({'operation':'file.persist','status':'ok','writes':8,'lastDurationMs':60000}), '2026-10-23T12:00:02Z '+json.dumps({'operation':'inbox.processing_progress','lane':'prematch','sessionId':'s','ingressActorId':'a','ingress':{'processed':12288,'checkpointed':12288,'metricWindowEndUTC':'2026-10-23T12:00:02Z'}})]
  result=ns['correlate'](lines,t,t+datetime.timedelta(seconds=100))
  self.assertEqual(result['historicalRowsExcluded'],1);self.assertNotIn('prematch',result['lastCompletedPublications']);self.assertEqual(result['lastCompletedPublications']['shared']['writes'],8);self.assertEqual(result['currentActorSamples'][0]['metricAgeSeconds'],98)
if __name__=='__main__':unittest.main()
