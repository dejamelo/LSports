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
 def test_no_growth_before_ebs_expansion(self):
  fs,devices=self.sample();calls=[]
  def run(args,**kw):calls.append(args);return json.dumps(fs if args[0]=='findmnt' else devices)
  def path(x):return SimpleNamespace(is_file=lambda:False) if str(x)=='/sys/devices/virtual/dmi/id/board_asset_tag' else Path(x)
  with patch.object(m,'run',side_effect=run),patch.object(m,'Path',side_effect=path),contextlib.redirect_stdout(io.StringIO()):self.assertEqual(m.main(),2)
  self.assertEqual([v[0] for v in calls],['findmnt','lsblk'])
if __name__=='__main__':unittest.main()
