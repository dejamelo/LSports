import contextlib,io,json,runpy,unittest
from pathlib import Path
from unittest.mock import patch
class CurrentStartup(unittest.TestCase):
 def test_explicit_identity_and_original_failure_survive_later_processing_metrics(self):
  ns=runpy.run_path(str(Path(__file__).with_name('read-existing-startup.py')));fn=ns['main'];expected='a'*64;calls=[]
  failure={'operation':'inbox.actor_failure','lane':'prematch','sessionId':'new','ingressStage':'amqp.connect','errorCode':403,'signals':['ACCESS_REFUSED'],'message':'SECRET'}
  raw='2026-10-23T18:31:30Z '+json.dumps(failure)+'\n'+'\n'.join('2026-10-23T18:39:00Z '+json.dumps({'operation':'inbox.processing_progress','lane':'prematch','ingress':{'processed':i}}) for i in range(200))
  def run(args):
   calls.append(args)
   if args[1]=='inspect':return json.dumps([{'Id':expected,'Image':'sha256:test','State':{'Running':True,'StartedAt':'2026-10-23T17:00:00Z'}}]).encode()
   return raw.encode()
  fn.__globals__['run']=run;output=io.StringIO()
  with patch('sys.argv',['script',expected]),contextlib.redirect_stdout(output):fn()
  result=json.loads(output.getvalue());self.assertEqual(result['workerId'],expected);self.assertEqual(result['startupFailure']['errorCode'],403);self.assertTrue(any(r['operation']=='inbox.actor_failure' for r in result['rows']));self.assertNotIn('SECRET',output.getvalue());self.assertEqual(calls[-1][-1],expected)
if __name__=='__main__':unittest.main()
