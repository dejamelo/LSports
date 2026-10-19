import copy,io,json,tempfile,unittest,contextlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
HERE=Path(__file__).parent

def load(name):
 scope={'__name__':'test'}
 exec((HERE/'resume-adl-api.py').read_text().split("if __name__=='__main__':")[0],scope)
 exec((HERE/name).read_text().split("if __name__=='__main__':")[0],scope)
 return scope

class Publication(unittest.TestCase):
 def test_preserves_routes_and_rejects_other_changes(self):
  s=load('publish-adl-https.py');before={'apps':{'http':{'servers':{'srv0':{'routes':[{'match':[{'host':['www.loteriaargentina.lat']}],'handle':[{'handler':'static_response','body':'posnet'}]}]}}}}}
  after=copy.deepcopy(before);routes=after['apps']['http']['servers']['srv0']['routes'];routes.insert(0,{'match':[{'host':[s['DOMAIN']]}],'handle':[]})
  self.assertTrue(s['unchanged_except_adl'](before,after))
  routes[1]['handle'][0]['body']='changed'
  self.assertFalse(s['unchanged_except_adl'](before,after))
 def test_no_shared_host_match_allowed(self):
  s=load('publish-adl-https.py');before={'apps':{'http':{'servers':{'srv0':{'routes':[]}}}}}
  after=copy.deepcopy(before);after['apps']['http']['servers']['srv0']['routes']=[{'match':[{'host':[s['DOMAIN'],'www.loteriaargentina.lat']}]}]
  self.assertFalse(s['unchanged_except_adl'](before,after))
 def test_admin_allowlist_and_no_development_routes(self):
  s=load('publish-adl-https.py');site=s['site']('192.0.2.1/32').decode()
  self.assertIn('not remote_ip 192.0.2.1/32',site)
  self.assertIn('respond @developmentOnly 404',site)
  self.assertIn('adl-homologation-api:3001',site)
  with self.assertRaises(ValueError):s['site']('0.0.0.0/0')
 def credential_case(self,payload):
  s=load('stage-adl-credentials.py')
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);secure=root/'secure';secure.mkdir();releases=root/'releases';release=releases/('a'*40);(release/'deploy/homologation').mkdir(parents=True)
   (release/'deploy/homologation/worker.env.example').write_text((HERE/'worker.env.example').read_text())
   (secure/'worker.env').write_text('old-settings')
   metadata={'release':str(release),'composeOverrides':['saved-override']};(secure/'deployment.json').write_text(json.dumps(metadata))
   s.update(SECURE=secure,RELEASES=releases,BACKUPS=root,states=lambda service:[],sys=SimpleNamespace(stdin=SimpleNamespace(buffer=io.BytesIO(json.dumps(payload).encode()))))
   output=io.StringIO()
   with contextlib.redirect_stdout(output), patch('os.geteuid',return_value=0):code=s['credential_main']()
   report=output.getvalue();stored=(secure/'worker.env').read_text()
   self.assertEqual(json.loads((secure/'deployment.json').read_text()),metadata)
   return code,report,stored,list(root.glob('adl-credentials-*'))
 def test_secret_staging_exact_and_not_in_output(self):
  payload={f'LSPORTS_{lane}_{key}':('private-$#"value' if key=='PASSWORD' else 'name') for lane in ('PREMATCH','INPLAY') for key in ('USERNAME','PASSWORD')}
  code,report,stored,backups=self.credential_case(payload)
  self.assertEqual(code,0);self.assertNotIn('private-',report);self.assertIn('PASSWORD=private-$#"value',stored);self.assertEqual(len(backups),1)
 def test_rejects_extra_keys_without_writing(self):
  code,report,stored,backups=self.credential_case({'PLATFORM_BOOTSTRAP_PASSWORD':'must-not-transfer'})
  self.assertEqual(code,2);self.assertEqual(stored,'old-settings');self.assertFalse(backups);self.assertNotIn('must-not-transfer',report)
 def test_missing_credentials_no_mutation(self):
  code,_,stored,backups=self.credential_case({})
  self.assertEqual(code,2);self.assertEqual(stored,'old-settings');self.assertFalse(backups)
 def test_rejects_env_injection(self):
  code,report,stored,backups=self.credential_case({'LSPORTS_PREMATCH_PASSWORD':'secret\nINJECT=yes'})
  self.assertEqual(code,2);self.assertEqual(stored,'old-settings');self.assertNotIn('INJECT',report);self.assertFalse(backups)
if __name__=='__main__':unittest.main()
