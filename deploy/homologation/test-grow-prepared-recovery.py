import json,os,subprocess,tempfile,unittest
from pathlib import Path
class GrowGuard(unittest.TestCase):
 def run_identity(self,size,instance='i-04690a17692088df9'):
  script=Path(__file__).with_name('grow-prepared-recovery-ext4.sh').read_text();code=script.split("python3 - <<'PY'",1)[1].split('\nPY',1)[0]
  with tempfile.TemporaryDirectory() as tmp:
   code=code.replace("Path('/etc/adl-homologation/recovery-root-ebs-identity.json')",'Path('+repr(tmp+'/identity.json')+')')
   env={**os.environ,'ADL_IDENTITY':json.dumps(dict(instanceId=instance,region='us-east-2',privateIp='172.31.41.208')),'ADL_SERIAL':'vol03fa30ff2fc37a28e','ADL_DEVICE_BYTES':str(size*1024**3),'ADL_MODE':'grow'}
   return subprocess.run(['python3','-'],input=code,text=True,capture_output=True,env=env)
 def test_expected_volume_at_80_passes_identity(self):self.assertEqual(self.run_identity(80).returncode,0)
 def test_64_cannot_reach_growth(self):
  r=self.run_identity(64);self.assertNotEqual(r.returncode,0);self.assertIn('TO_80_GIB_REQUIRED',r.stderr)
 def test_different_instance_cannot_reach_growth(self):
  r=self.run_identity(80,'i-00000000000000000');self.assertNotEqual(r.returncode,0);self.assertIn('MISMATCH_NO_RESIZE',r.stderr)
if __name__=='__main__':unittest.main()
