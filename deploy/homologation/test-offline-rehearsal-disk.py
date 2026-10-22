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
if __name__=='__main__':unittest.main()
