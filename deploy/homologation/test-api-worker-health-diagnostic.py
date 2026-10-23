import unittest,json
from pathlib import Path
ns={};exec(Path(__file__).with_name('api-worker-health-diagnostic.py').read_text().rsplit('\ninspect_api_worker_health()',1)[0],ns)
class Health(unittest.TestCase):
 def test_docker_health_not_same_as_http_availability(self):
  self.assertEqual(ns['api_classify'](True,'unhealthy',200,False),'api_responding_docker_health_not_healthy')
  self.assertEqual(ns['api_classify'](True,'healthy',200,False),'api_currently_responding_and_healthy')
 def test_oom_and_shell_failure_distinguished(self):
  self.assertEqual(ns['api_classify'](False,'unhealthy',None,True),'api_exited_oom_confirmed')
  self.assertEqual(ns['api_classify'](False,'unhealthy',None,False),'api_exited_not_oom_proven')
  self.assertEqual(ns['api_classify'](True,'unhealthy',503,False),'control_shell_unavailable_not_feed_health_endpoint')
 def test_logs_keep_source_frame_and_codes_without_raw_message(self):
  out=ns['api_log_signals'](b'2026-10-23T01:09:00Z FATAL ERROR: JavaScript heap out of memory password=SECRET\n at readFeed (/app/packages/feed-store/src/index.ts:33:18) token=SECRET\n')
  self.assertIn('node_heap_exhausted',out[0]['signals']);self.assertEqual(out[1]['stackFrames'][0],{'file':'packages/feed-store/src/index.ts','line':33,'column':18});self.assertNotIn('SECRET',json.dumps(out))
if __name__=='__main__':unittest.main()
