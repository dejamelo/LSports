import contextlib,importlib.util,io,json,unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('probe',Path(__file__).with_name('check-distribution-path.py'))
probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)

class DistributionPathTest(unittest.TestCase):
 def test_sanitized_existing_timeout_and_no_http_probe(self):
  c={'Id':'a'*64,'Image':'sha256:test','State':{'Running':True,'StartedAt':'2026-10-23T17:00:00Z'}}
  calls=[]
  def run(args,**kwargs):
   calls.append(args)
   if args[1]=='inspect':return SimpleNamespace(returncode=0,stdout=json.dumps([c]),stderr='')
   if args[1]=='logs':return SimpleNamespace(returncode=0,stdout='2026-10-23T20:00:00Z '+json.dumps({'lane':'prematch','operation':'distribution.status','timeoutMs':20000,'networkCode':'ECONNABORTED','message':'PRIVATE_PASSWORD','config':{'password':'PRIVATE_PASSWORD'}}),stderr='')
   self.assertEqual(args[:3],['docker','exec','-i'])
   source=kwargs['input'];self.assertNotIn('https.request',source);self.assertNotIn('fetch(',source);self.assertIn('rejectUnauthorized:true',source)
   return SimpleNamespace(returncode=0,stdout=json.dumps({'stage':'bounded_dns_tls','tlsResult':'VERIFIED'}),stderr='')
  out=io.StringIO()
  with patch.object(probe.subprocess,'run',side_effect=run),contextlib.redirect_stdout(out):probe.main()
  self.assertNotIn('PRIVATE_PASSWORD',out.getvalue())
  rows=[json.loads(x) for x in out.getvalue().splitlines()]
  self.assertEqual(rows[1]['events'][0]['timeoutMs'],20000)
  self.assertFalse(rows[-1]['integrationVerified'])
  self.assertEqual(sum(x[1]=='exec' for x in calls),1)
 def test_stopped_worker_not_probed(self):
  c={'Id':'a'*64,'Image':'sha256:test','State':{'Running':False,'StartedAt':'x'}}
  with patch.object(probe.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps([c]),stderr='')) as mock,contextlib.redirect_stdout(io.StringIO()):
   with self.assertRaisesRegex(RuntimeError,'WORKER_NOT_RUNNING'):probe.main()
   self.assertEqual(mock.call_count,1)
if __name__=='__main__':unittest.main()
