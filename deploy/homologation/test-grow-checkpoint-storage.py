import contextlib,importlib.util,io,json,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('grow',Path(__file__).with_name('grow-checkpoint-storage.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Growth(unittest.TestCase):
 def sample(self,size=240):
  return {'filesystems':[{'source':'/dev/nvme0n1p1','fstype':'ext4','target':'/'}]},{'blockdevices':[{'name':'nvme0n1','type':'disk','serial':'vol03fa30ff2fc37a28e','size':size*1024**3,'children':[{'name':'nvme0n1p1','size':(size-1)*1024**3,'mountpoints':['/']}]}]}
 def test_correct_target(self):
  fs,devices=self.sample();self.assertEqual(m.target(fs,devices)[0],240*1024**3)
 def test_wrong_volume_or_filesystem_refused(self):
  fs,devices=self.sample();devices['blockdevices'][0]['serial']='other'
  with self.assertRaises(RuntimeError):m.target(fs,devices)
  fs,devices=self.sample();fs['filesystems'][0]['fstype']='xfs'
  with self.assertRaises(RuntimeError):m.target(fs,devices)
 def test_400_is_not_exact_size_blocked(self):
  fs,devices=self.sample(400);self.assertEqual(m.target(fs,devices)[0],400*1024**3)
 def test_budget_no_double_count(self):
  with patch.object(m,'allocated',side_effect=[10,20,50,3,2]):
   b=m.disk_budget('/feed',1,100*m.GIB,200*m.GIB)
  self.assertEqual(b['dockerOtherAllocatedBytes'],40)
  self.assertEqual(sum(b[k] for k in ['activeFeedAllocatedBytes','backupsAllocatedBytes','dockerOtherAllocatedBytes','systemTemporaryAllocatedBytes','otherAndFilesystemReservedBytes']),100*m.GIB)
  self.assertEqual(b['requiredWithMarginBytes'],12*m.GIB+10)
if __name__=='__main__':unittest.main()
