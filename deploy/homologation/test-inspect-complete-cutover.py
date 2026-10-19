import contextlib,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).parent
class CompletePreflight(unittest.TestCase):
 def fixture(self,known_release):
  scope={'__name__':'test'}
  for name in ('resume-adl-api.py','inspect-cutover-aws.py'):exec((HERE/name).read_text().split("if __name__=='__main__':")[0],scope)
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);secure=root/'secure';secure.mkdir(mode=0o700);releases=root/'releases';release=releases/('a'*40);release.mkdir(parents=True)
   (secure/'worker.env').write_text(''.join(f'LSPORTS_{lane}_{key}=PRIVATE_VALUE_NEVER_PRINT\n' for lane in ('PREMATCH','INPLAY') for key in ('USERNAME','PASSWORD')));(secure/'worker.env').chmod(0o600)
   if known_release:(secure/'deployment.json').write_text(json.dumps({'release':str(release),'composeOverrides':[]}))
   scope.update(SECURE=secure,RELEASES=releases,states=lambda service:[],control_status=lambda:200,
    model=lambda base:{'services':{'worker':{'image':'local-fixed','mem_limit':4294967296,'environment':{'PASSWORD':'PRIVATE_MODEL_SECRET','ADL_MAC_WORKER_STOPPED':'no'}}}},
    run=lambda args:json.dumps([{'Config':{'User':'node'}}]).encode())
   class Response:
    status=200
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self,*args):return b'{"initialized":false,"financialMode":"simulation"}'
   before={p.name:p.read_bytes() for p in secure.iterdir()}
   out=io.StringIO()
   with patch('os.geteuid',return_value=0),patch('urllib.request.urlopen',return_value=Response()),contextlib.redirect_stdout(out):scope['inspect_aws']()
   result=json.loads(out.getvalue());self.assertEqual(before,{p.name:p.read_bytes() for p in secure.iterdir()})
   self.assertNotIn('PRIVATE_VALUE',out.getvalue());self.assertNotIn('PRIVATE_MODEL_SECRET',out.getvalue());return result
 def test_failed_metadata_does_not_hide_independent_sections(self):
  r=self.fixture(False);self.assertEqual(r['status'],'unverified');self.assertTrue(r['providerCredentials']['primaryPresent']);self.assertEqual(r['platform']['initialized'],False);self.assertIn('capacity',r);self.assertEqual(r['awsWorkerContainers'],[])
 def test_resolved_secret_model_is_filtered_and_start_gates_remain_closed(self):
  r=self.fixture(True);self.assertEqual(r['workerModel']['user'],'node');self.assertEqual(r['workerModel']['gates']['macStopped'],False);self.assertFalse(r['workerStarted']);self.assertTrue(r['readOnly']);self.assertFalse(r['posnetChanged'])
if __name__=='__main__':unittest.main()
