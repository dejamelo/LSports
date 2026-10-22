import json,tempfile,unittest,importlib.util
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('proof',Path(__file__).with_name('test-pre-exit-recovery.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class OfflineDisk(unittest.TestCase):
 def exercise(self,verified=False,receipt=False):
  ns=m.load();events=[];ns.update(emit=lambda **r:events.append(r),oom_restore_log_summary=lambda _: {'signals':['disk_full']},run=lambda cmd:b'' if cmd[:2]==['docker','ps'] else b'{"filesystems":[]}' if cmd[0]=='findmnt' else b'{"blockdevices":[]}')
  with tempfile.TemporaryDirectory() as tmp:
   backup=Path(tmp);digest='a'*64;output=backup/('projection-rehearsal-'+digest[:24]);output.mkdir();partial=output/'projection.json';partial.write_bytes(b'partial output');source=backup/'checkpoint';source.write_bytes(b'unchanged');before=source.read_bytes()
   if receipt:(output/'receipt.json').write_text('{}')
   usage=type('Usage',(),{'free':0,'total':20*1024**3})()
   with patch.object(ns['shutil'],'disk_usage',return_value=usage):
    with self.assertRaisesRegex(RuntimeError,'OFFLINE_REHEARSAL_DISK_EXPANSION_REQUIRED_NO_START'):ns['offline_rehearsal_disk_plan'](backup,[(source,backup/'copy',None)],{'projectionSerializationVerified':verified},digest)
   self.assertEqual(partial.exists(),verified or receipt);self.assertEqual(source.read_bytes(),before)
   report=json.loads((backup/'offline-rehearsal-disk-plan.json').read_text());self.assertGreater(report['requiredFreeBytes'],4*1024**3);self.assertEqual(report['additionalGiB'],5);self.assertEqual(report['failedOutputBytes'],14);self.assertTrue(report['failedOutputIsLowerBound']);self.assertEqual(report['gp3AdditionalStorageUSDPerMonthEstimate'],0.4)
 def test_partial_removed_only_with_failure_evidence(self):self.exercise()
 def test_verified_serialization_preserved(self):self.exercise(verified=True)
 def test_receipt_protected(self):self.exercise(receipt=True)
 def test_40_gib_device_not_38_gib_ext4_drives_target(self):
  ns=m.load();ns.update(emit=lambda **r:None,oom_restore_log_summary=lambda _: {'signals':[]})
  def run(cmd):
   if cmd[0]=='findmnt':return b'{"filesystems":[{"source":"/dev/nvme0n1p1"}]}'
   return json.dumps({'blockdevices':[{'name':'nvme0n1','type':'disk','size':40*1024**3,'children':[{'name':'nvme0n1p1','type':'part'}]}]}).encode()
  ns['run']=run
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);usage=type('Usage',(),{'free':784728064,'total':38*1024**3})()
   source=root/'source';source.touch()
   # Reserve 24,211,793,008 bytes from observed case through a sparse input.
   with source.open('r+b') as file:file.truncate((24211793008-4*1024**3)//8)
   with patch.object(ns['shutil'],'disk_usage',return_value=usage):
    with self.assertRaisesRegex(RuntimeError,'DISK_EXPANSION_REQUIRED'):ns['offline_rehearsal_disk_plan'](root,[(source,source,None)],{},'a'*64)
   report=json.loads((root/'offline-rehearsal-disk-plan.json').read_text());self.assertEqual(report['additionalGiB'],22);self.assertEqual(report['minimumEbsGiB'],62);self.assertEqual(report['suggestedEbsGiB'],64);self.assertEqual(report['ebsGrowthGiB'],24);self.assertEqual(report['estimatedEbsGrowthUSDPerMonth'],1.92)
 def test_existing_disk_report_can_be_replaced_without_touching_data(self):
  ns=m.load()
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);path=root/'offline-rehearsal-disk-plan.json';original=root/'checkpoint';original.write_bytes(b'original')
   ns['replace_recovery_report'](path,b'{"attempt":1}')
   with self.assertRaises(FileExistsError):ns['private'](path,b'old behavior')
   ns['replace_recovery_report'](path,b'{"attempt":2}')
   self.assertEqual(json.loads(path.read_text())['attempt'],2);self.assertEqual(original.read_bytes(),b'original');self.assertEqual(path.stat().st_mode&0o777,0o600)
 def test_report_symlink_rejected(self):
  ns=m.load()
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);original=root/'checkpoint';original.write_bytes(b'original');path=root/'offline-rehearsal-disk-plan.json';path.symlink_to(original)
   with self.assertRaisesRegex(RuntimeError,'RECOVERY_REPORT_IDENTITY'):ns['replace_recovery_report'](path,b'bad')
   self.assertEqual(original.read_bytes(),b'original')
if __name__=='__main__':unittest.main()
