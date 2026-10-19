import io,os,tarfile,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent
scope={'__name__':'fixture'}
exec((HERE/'resume-adl-api.py').read_text().split("if __name__=='__main__':")[0],scope)
exec((HERE/'repair-adl-runtime.py').read_text().split("if __name__=='__main__':")[0],scope)
class RuntimeAccess(unittest.TestCase):
 def test_private_extraction_reproduces_root_only_directories(self):
  with tempfile.TemporaryDirectory() as d:
   b=io.BytesIO()
   with tarfile.open(fileobj=b,mode='w') as t:
    x=tarfile.TarInfo('apps/api/src');x.type=tarfile.DIRTYPE;x.mode=0o755;t.addfile(x)
   b.seek(0);old=os.umask(0o077)
   try:
    with tarfile.open(fileobj=b) as t:t.extractall(d,filter='data')
   finally:os.umask(old)
   self.assertEqual((Path(d)/'apps/api/src').stat().st_mode&0o777,0o700)
 def test_log_sanitization(self):
  self.assertEqual(scope['classify'](b'Error [ERR_MODULE_NOT_FOUND]: secret://user:password@host'),['module_not_found'])
 def test_permission_gate_not_missing_source(self):
  root={'uid':0,'paths':[{'readable':True}]}
  self.assertTrue(scope['access_defect']({'uid':1000,'paths':[{'readable':False,'code':'EACCES'}]},root))
  self.assertFalse(scope['access_defect']({'uid':1000,'paths':[{'readable':False,'code':'ENOENT'}]},root))
 def test_repair_scope(self):
  source=(HERE/'repair-adl-runtime.py').read_text()
  self.assertIn("'--no-deps','--pull','never','api'",source)
  self.assertNotIn('chown',scope['FIX'])
  self.assertNotIn('/app/.runtime',scope['FIX'])
  self.assertIn("if after!=expected:raise ValueError()",source)
 def test_build_log_sanitization(self):
  signals=scope['build_signals'](b'load metadata for docker.io/library/sha256:abcd pull access denied secret-token')
  self.assertEqual(signals,['image_id_interpreted_as_registry_reference','registry_access_rejected'])
  self.assertNotIn('secret',str(signals))
 def test_conflicting_parent_tag_blocks(self):
  original_run=scope['subprocess'].run
  class Result:
   returncode=0
   stdout=b'[{"Id":"sha256:wrong"}]'
  scope['subprocess'].run=lambda *a,**kw:Result()
  try:
   with self.assertRaisesRegex(ValueError,'parent_tag_conflict'):scope['pin_local_parent']('sha256:'+'a'*64)
  finally:scope['subprocess'].run=original_run
if __name__=='__main__':unittest.main()
