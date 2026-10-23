import unittest
from pathlib import Path
HERE=Path(__file__).parent
ns={'__name__':'tested'}
exec((HERE/'grow-prepared-transport.py').read_text().split('\ntry:main()')[0],ns)
class GrowthIdentity(unittest.TestCase):
 def test_exact_attachment_and_visible_184_gib(self):
  self.assertEqual(ns['verify_target']({'instanceId':ns['INSTANCE'],'region':ns['REGION']},'vol03fa30ff2fc37a28e\n',184*1024**3),ns['VOLUME'])
 def test_old_160_gib_blocks_before_filesystem_changes(self):
  with self.assertRaisesRegex(RuntimeError,'EBS_184_GIB_NOT_VISIBLE_NO_FILESYSTEM_GROWTH'):ns['verify_target']({'instanceId':ns['INSTANCE'],'region':ns['REGION']},'vol03fa30ff2fc37a28e',160*1024**3)
 def test_other_instance_volume_region_rejected(self):
  for identity,serial in [({'instanceId':'i-other','region':ns['REGION']},ns['VOLUME']),({'instanceId':ns['INSTANCE'],'region':'us-east-1'},ns['VOLUME']),({'instanceId':ns['INSTANCE'],'region':ns['REGION']},'vol-other')]:
   with self.assertRaisesRegex(RuntimeError,'INSTANCE_VOLUME_ASSOCIATION_MISMATCH'):ns['verify_target'](identity,serial,184*1024**3)
 def test_exact_prepared_sources_match_git_revision(self):
  import hashlib,subprocess
  for name,sha in ns['EXPECTED'].items():
   self.assertEqual(hashlib.sha256(subprocess.check_output(['git','show','7b8bf4b:apps/worker/src/'+name],cwd=HERE)).hexdigest(),sha)
 def test_source_and_attachment_checks_precede_growth(self):
  s=(HERE/'grow-prepared-transport.py').read_text();start=s.index('def main():');s=s[start:]
  for verification in ('actual==EXPECTED','verify_target(identity,serial,device_bytes)',"fs['fstype']=='ext4'"):
   self.assertLess(s.index(verification),s.index("subprocess.run(['growpart'"))
  self.assertNotIn('docker\',\'kill',s);self.assertNotIn('unlink(',s)
if __name__=='__main__':unittest.main()
