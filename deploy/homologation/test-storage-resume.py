import importlib.util,io,json,runpy,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('proof',Path(__file__).with_name('test-pre-exit-recovery.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class StorageResume(unittest.TestCase):
 def test_insufficient_pre_stop_space_blocks_without_signals_or_deletion(self):
  ns=m.load();events=[];ns['emit']=lambda **r:events.append(r)
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);(root/'trade-feed.json').write_bytes(b'original')
   info={'Mounts':[{'Destination':'/app/.runtime/feed','Source':str(root)}]}
   with patch.object(ns['shutil'],'disk_usage',return_value=type('Usage',(),{'free':0})()):
    with self.assertRaisesRegex(RuntimeError,'PRE_STOP_DISK_HEADROOM_INSUFFICIENT_NO_STOP'):ns['storage_before_stop'](root,info)
   self.assertEqual((root/'trade-feed.json').read_bytes(),b'original');self.assertEqual(events[-1]['signalsSent'],0);self.assertGreater(events[-1]['missingBytes'],0)
 def test_sufficient_space_permits_pre_stop_gate(self):
  ns=m.load();ns['emit']=lambda **r:None
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);(root/'trade-feed.json').write_bytes(b'original')
   with patch.object(ns['shutil'],'disk_usage',return_value=type('Usage',(),{'free':100*1024**3})()):ns['storage_before_stop'](root,{'Mounts':[{'Destination':'/app/.runtime/feed','Source':str(root)}]})
 def test_stopped_worker_is_explicit_skipped_retirement_not_ssh_failure(self):
  ns=runpy.run_path(str(Path(__file__).with_name('inbox-retirement-diagnostic.py')))
  events=[];fn=ns['main'];fn.__globals__['worker']=lambda:{'Id':'a'*64,'State':{'Running':False}};fn.__globals__['emit']=lambda **r:events.append(r)
  fn();self.assertEqual(events[0]['stage'],'inbox_retirement_skipped');self.assertFalse(events[0]['integrationVerified'])
 def test_stop_disk_gate_precedes_provider_stop_and_signal(self):
  source=Path(__file__).with_name('upgrade-partitioned-worker.py').read_text();start=source.index("if progress['phase']=='prepared':",source.index('def upgrade_partitioned'))
  section=source[start:source.index("if progress['phase']=='stop_requested':",start)]
  self.assertLess(section.index('storage_before_stop(backup,old_container)'),section.index("stage='partitioned_upgrade.distribution_stop'"));self.assertLess(section.index('storage_before_stop(backup,old_container)'),section.index('request_graceful_signal_once'))
if __name__=='__main__':unittest.main()
