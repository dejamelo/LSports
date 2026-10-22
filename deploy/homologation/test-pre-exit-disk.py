import hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import importlib.util
spec=importlib.util.spec_from_file_location('recovery',Path(__file__).with_name('test-pre-exit-recovery.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class DiskPlan(unittest.TestCase):
 def test_only_identical_unmounted_unreferenced_work_copy_removed(self):
  ns=module.load();events=[];ns.update(run=lambda _:b'[]' if _[:2]==['docker','inspect'] else b'',emit=lambda **r:events.append(r))
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);payload=b'committed WAL';sha=hashlib.sha256(payload).hexdigest();hashes={'trade-feed.json':sha}
   duplicate=root/('rehearsal-'+'a'*24);modified=root/('rehearsal-'+'b'*24);active=root/('rehearsal-'+'c'*24);original=root/('pre-exit-original-'+'d'*16)
   for folder in (duplicate,modified,active,original):folder.mkdir();(folder/'trade-feed.json').write_bytes(payload)
   (modified/'trade-feed.json').write_bytes(b'changed database')
   with patch.object(ns['shutil'],'disk_usage',return_value=type('Usage',(),{'free':0})()):
    with self.assertRaisesRegex(RuntimeError,'PRE_EXIT_COPY_DISK_HEADROOM_INSUFFICIENT'):ns['pre_exit_disk_plan'](root,100,hashes,{'workingCopy':str(active)},original)
   self.assertFalse(duplicate.exists());self.assertTrue(modified.exists());self.assertTrue(active.exists());self.assertTrue(original.exists())
   report=json.loads(next(root.glob('pre-exit-disk-plan-attempt-*.json')).read_text());self.assertEqual(report['requiredFreeBytes'],400+512*1024**2);self.assertEqual(report['missingBytes'],report['requiredFreeBytes']);self.assertEqual(report['minimumExpansionGiB'],1)
 def test_sufficient_space_has_no_cleanup_or_docker_calls(self):
  ns=module.load();ns.update(run=lambda _:self.fail('unnecessary docker query'),emit=lambda **r:None)
  with tempfile.TemporaryDirectory() as tmp:
   with patch.object(ns['shutil'],'disk_usage',return_value=type('Usage',(),{'free':10**10})()):ns['pre_exit_disk_plan'](Path(tmp),100,{}, {},None)
   r=json.loads(next(Path(tmp).glob('pre-exit-disk-plan-attempt-*.json')).read_text());self.assertEqual(r['missingBytes'],0);self.assertEqual(r['requiredFreeBytes'],500+512*1024**2)
if __name__=='__main__':unittest.main()
